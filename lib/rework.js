// Live pull from the Rework Projects Public API v1, shaped like the export's tasks.json / projects.json.
// Used by api/data.js. Calls run in parallel (the API answered 31 back-to-back calls without throttling).
//
//   1 call   /v1/service/all          service names and client (group) ids
//   1 call   /v1/project/list         every project the acting user can see, no service filter needed
//   N calls  /v1/task/list            one per project (the API requires project_id); finished projects
//                                     not touched in STALE_DAYS are skipped
//   a few    /v1/service/get.itemtypes, get.stages   only for services whose tasks use them
import teams from '../udm_report/teams.json' with { type: 'json' };

const DONE = 10;
const CANCELLED = new Set([-1, -10]);
const STALE_DAYS = 60;
const MYT_OFFSET = 8 * 3600;

export function settings(env) {
  let base = (env.REWORK_API_BASE || 'https://api-v3.rework.com/project').trim().replace(/\/+$/, '');
  if (base.endsWith('/v1')) base = base.slice(0, -3);
  if (!base.endsWith('/project')) base += '/project';
  return {
    base,
    key: (env.REWORK_API_KEY || env.REWORK_API_TOKEN || '').trim(),
    password: (env.REWORK_API_PASSWORD || '').trim(),
    userId: Number(env.REWORK_USER_ID || teams.api_user_id),
    concurrency: Number(env.REWORK_CONCURRENCY || 8),
  };
}

export function client(cfg, fetchImpl = fetch) {
  let calls = 0;
  async function post(path, body = {}, attempt = 0) {
    calls++;
    const r = await fetchImpl(cfg.base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-api-token': cfg.key, ...(cfg.password ? { 'x-api-password': cfg.password } : {}) },
      body: JSON.stringify({ user_id: cfg.userId, ...body }),
    });
    if (r.status === 429 && attempt < 2) {
      await new Promise((ok) => setTimeout(ok, 1000 * Number(r.headers.get('retry-after') || 5)));
      return post(path, body, attempt + 1);
    }
    if (!r.ok) throw new Error(`Rework API ${r.status} on ${path}: ${(await r.text()).slice(0, 200)}`);
    const out = await r.json();
    if (out.status !== 1) throw new Error(`Rework API error on ${path}: ${JSON.stringify(out).slice(0, 200)}`);
    return out;
  }
  async function pages(path, key, body = {}) {
    const all = [];
    for (let page = 0; ; page++) {
      const out = await post(path, { ...body, limit: 200, page });
      all.push(...(out[key] || []));
      if (!out.has_more) return all;
    }
  }
  return { post, pages, calls: () => calls };
}

// Run fn over items with at most n in flight.
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

const day = (ts) => (ts > 0 ? new Date((ts + MYT_OFFSET) * 1000).toISOString().slice(0, 10) : '');

export async function pull(cfg, { now = Date.now() / 1000, fetchImpl } = {}) {
  const t0 = Date.now();
  const api = client(cfg, fetchImpl);
  const users = teams.users || {};
  const groups = teams.group_names || {};
  const name = (id) => (id ? users[String(id)]?.name || `user ${id}` : '');
  const team = (id) => (id ? users[String(id)]?.team || 'Other' : '');

  const [services, projectsRaw] = await Promise.all([
    api.pages('/v1/service/all', 'services'),
    api.pages('/v1/project/list', 'projects'),
  ]);
  const svcById = new Map(services.filter((s) => (s.model || 'project.project') === 'project.project' && s.status === 1).map((s) => [s.id, s]));
  const projects = projectsRaw.filter((p) => svcById.has(p.service_id))
    .filter((p) => !(p.status === DONE && now - (p.updated_at || 0) > STALE_DAYS * 86400));

  const taskLists = await pool(projects, cfg.concurrency, (p) => api.pages('/v1/task/list', 'tasks', { project_id: p.id, include_archived: 0 }));

  // Names for stages / work item types, only where tasks need them.
  const needTypes = new Set(), needStages = new Set();
  projects.forEach((p, i) => {
    for (const t of taskLists[i]) {
      if (t.item_type_id) needTypes.add(p.service_id);
      if (t.stage_id && t.status !== DONE && t.deadline && t.deadline < now) needStages.add(p.service_id);
    }
  });
  const lookup = async (path, ids, key) => {
    const map = new Map();
    await pool([...ids], cfg.concurrency, async (id) => {
      try {
        const out = await api.post(path, { id });
        const list = out[key] || Object.values(out).find(Array.isArray) || [];
        for (const x of list) map.set(x.id, x.name || '');
      } catch { /* names are optional */ }
    });
    return map;
  };
  const [typeNames, stageNames] = await Promise.all([
    lookup('/v1/service/get.itemtypes', needTypes, 'itemtypes'),
    lookup('/v1/service/get.stages', needStages, 'stages'),
  ]);

  const tasks = [], projectRows = [];
  const today = day(now);
  projects.forEach((p, i) => {
    const svc = svcById.get(p.service_id);
    const clientName = groups[svc.group_id] || '(no client)';
    let done = 0, total = 0, overdue = 0;
    for (const t of taskLists[i]) {
      const status = t.status ?? 0;
      const state = status === DONE ? 'done' : CANCELLED.has(status) ? 'cancelled' : t.deadline && t.deadline < now ? 'overdue' : 'open';
      if (state !== 'cancelled') { total++; if (state === 'done') done++; if (state === 'overdue') overdue++; }
      tasks.push({
        id: t.id, name: t.name || '', project_id: p.id, project: p.name || '', client: clientName, service: svc.name,
        status, state, stage: stageNames.get(t.stage_id) || '', item_type: typeNames.get(t.item_type_id) || '',
        assignee: name(t.assignee_id), team: team(t.assignee_id),
        start: day(t.start_date), deadline: day(t.deadline), finished: day(t.finished_at), created: day(t.created_at),
        workload: t.workload || 0, priority: t.priority || 0, parent: Boolean(t.parent_id), url: t.url || '',
      });
    }
    const fin = p.financials || {};  // money fields deliberately not copied
    projectRows.push({
      project_id: p.id, project: p.name || '', service_group: clientName, service: svc.name,
      status_code: p.status, priority: p.priority || 0,
      owners: (p.owners || []).filter(Number.isInteger).map(name),
      start: day(p.start_date), deadline: day(p.deadline),
      est_hours: Math.round((fin.effort || 0) * 100) / 100, logged_hours: Math.round((fin.effort_recorded || 0) * 100) / 100,
      done, total, overdue, status: total && done >= total ? 'Completed' : 'Active', updated: today, url: p.url || '',
    });
  });

  return {
    tasks, projects: projectRows,
    sync: { updated_at: new Date(now * 1000).toISOString(), source: 'live', hours_source: 'snapshot', tasks: tasks.length, projects: projectRows.length, calls: api.calls(), seconds: Math.round((Date.now() - t0) / 100) / 10 },
  };
}
