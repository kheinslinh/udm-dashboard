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
    concurrency: Number(env.REWORK_CONCURRENCY || 12),
    callTimeoutMs: Number(env.REWORK_CALL_TIMEOUT_MS || 20000),
  };
}

export function client(cfg, fetchImpl = fetch) {
  let calls = 0;
  async function post(path, body = {}, attempt = 0) {
    calls++;
    // Rework sometimes drops a single connection (503 "upstream connect error"); retry those twice.
    const retry = async () => { await new Promise((ok) => setTimeout(ok, 400 * (attempt + 1))); return post(path, body, attempt + 1); };
    let r;
    try {
      r = await fetchImpl(cfg.base + path, {
      method: 'POST', signal: AbortSignal.timeout(cfg.callTimeoutMs || 20000),
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-api-token': cfg.key, ...(cfg.password ? { 'x-api-password': cfg.password } : {}) },
      body: JSON.stringify({ user_id: cfg.userId, ...body }),
      });
    } catch (e) {
      if (attempt < 2 && e.name !== 'TimeoutError') return retry();
      throw e;
    }
    if ([502, 503, 504].includes(r.status) && attempt < 2) return retry();
    if (r.status === 429) {
      // Rework's limit is per key (about 200 calls / 10 min). Waiting it out would blow the function's
      // time limit, so stop and tell the caller when to come back.
      const info = await r.json().catch(() => ({}));
      const wait = Number(info.retry_after || r.headers.get('retry-after') || 60);
      if (attempt < 1 && wait <= 3) { await new Promise((ok) => setTimeout(ok, wait * 1000)); return post(path, body, attempt + 1); }
      const e = new Error(`Rework rate limit reached; try again in ${Math.ceil(wait / 60)} min`);
      e.rateLimited = true; e.retryAfter = wait;
      throw e;
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

const REVISION_RE = /\b(revis\w*|rev\s?\d+|amend\w*|re-?edit\w*|changes?)\b/i;
const CLOCKIN_RE = /clock\s?-?in|clockify/i;
const RUNAWAY_HOURS = 12;

// First day of last month, Malaysia time (the dashboard's default range; well inside the API's 92-day cap).
export function sessionWindowStart(now) {
  const d = new Date((now + MYT_OFFSET) * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1) / 1000 - MYT_OFFSET;
}

function isoWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const thu = new Date(d); thu.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const y = thu.getUTCFullYear();
  const w = 1 + Math.round(((thu - Date.UTC(y, 0, 4)) / 86400000 - 3 + ((new Date(Date.UTC(y, 0, 4)).getUTCDay() + 6) % 7)) / 7);
  const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
  const m = (x) => x.toLocaleString('en', { month: 'short', timeZone: 'UTC' });
  const range = mon.getUTCMonth() === sun.getUTCMonth() ? `${mon.getUTCDate()}–${sun.getUTCDate()} ${m(sun)}` : `${mon.getUTCDate()} ${m(mon)}–${sun.getUTCDate()} ${m(sun)}`;
  return [`${y}-W${String(w).padStart(2, '0')}`, `W${w} · ${range}`];
}

function sessionRow(s, { users, groups, svcById, projById, taskName, now }) {
  const user = users[String(s.user_id)] || {};
  const proj = projById.get(s.project_id) || {};
  const svc = svcById.get(s.service_id || proj.service_id) || {};
  const date = day(s.started_at);
  const [week, weekLabel] = isoWeek(date);
  const secs = s.running ? Math.max(s.seconds || 0, now - s.started_at - (s.break_seconds || 0)) : s.seconds || 0;
  const hours = Math.round((secs / 3600) * 100) / 100;
  const task = taskName.get(s.task_id) || '';
  const title = s.name || '';
  const rev = (REVISION_RE.exec(title) || REVISION_RE.exec(task) || [])[1];
  const clock = /clockify/i.test(task) ? 'Clockify catch-all' : CLOCKIN_RE.test(task) ? 'Clock-in task' : '';
  const d = new Date(date + 'T00:00:00Z');
  return {
    session: s.id, project_id: s.project_id || '', item_id: s.task_id || '', started: s.started_at,
    date, week, week_label: weekLabel, month: date.slice(0, 7), month_label: d.toLocaleString('en', { month: 'short', year: 'numeric', timeZone: 'UTC' }),
    person: user.name || `user ${s.user_id}`, team: user.team || 'Other',
    service_group: groups[svc.group_id] || '(no client)', service: svc.name || '', project: proj.name || '', task,
    log_name: title, hours, runaway: hours > RUNAWAY_HOURS, running: Boolean(s.running), linked: Boolean(s.task_id),
    revision: Boolean(rev), revision_type: rev ? rev[0].toUpperCase() + rev.slice(1).toLowerCase() : '',
    clockin: Boolean(clock), clockin_type: clock,
  };
}

const day = (ts) => (ts > 0 ? new Date((ts + MYT_OFFSET) * 1000).toISOString().slice(0, 10) : '');

// Everyone's sessions in one paged list; pages after the first are fetched in parallel.
async function fetchSessions(api, cfg, from) {
  const body = { scope: 'all', started_from: from, status: [1, 2, 10], limit: 200 };
  const first = await api.post('/v1/worksession/list', { ...body, page: 0 });
  const per = first.per_page || 200;
  const pages = first.has_more ? Math.ceil((first.total || 0) / per) : 1;
  const rest = await pool(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => i + 1), cfg.concurrency,
    (page) => api.post('/v1/worksession/list', { ...body, page }).then((o) => o.sessions || []));
  const seen = new Set();
  return [first.sessions || [], ...rest].flat().filter((s) => !seen.has(s.id) && seen.add(s.id));
}

export async function pull(cfg, { now = Date.now() / 1000, fetchImpl, withSessions = true } = {}) {
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

  // Tasks: one call per service (task/list takes service_id), only for services that have projects we keep.
  // Timer sessions: one paged list for everyone (worksession/list with scope "all").
  const windowFrom = sessionWindowStart(now);
  const keep = new Set(projects.map((p) => p.id));
  const serviceIds = [...new Set(projects.map((p) => p.service_id))];
  const [byService, allSessions] = await Promise.all([
    pool(serviceIds, cfg.concurrency, (sid) => api.pages('/v1/task/list', 'tasks', { service_id: sid, include_archived: 0 })),
    withSessions ? fetchSessions(api, cfg, windowFrom).catch((e) => (e.rateLimited ? Promise.reject(e)
      // Fallback: per person (the list without scope only returns the acting user's own sessions).
      : pool(Object.keys(users), cfg.concurrency, (uid) => api.pages('/v1/worksession/list', 'sessions', { user_id: Number(uid), started_from: windowFrom, status: [1, 2, 10] }).catch(() => [])).then((l) => l.flat()))) : [],
  ]);
  const tasksByProject = new Map();
  for (const t of byService.flat()) {
    if (!keep.has(t.project_id)) continue;
    if (!tasksByProject.has(t.project_id)) tasksByProject.set(t.project_id, []);
    tasksByProject.get(t.project_id).push(t);
  }
  const taskLists = projects.map((p) => tasksByProject.get(p.id) || []);

  // Work item type names, only for services whose tasks use them. (Stages need no lookup: tasks carry in_final_stage.)
  const needTypes = new Set();
  projects.forEach((p, i) => { for (const t of taskLists[i]) if (t.item_type_id) needTypes.add(p.service_id); });
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
  const typeNames = await lookup('/v1/service/get.itemtypes', needTypes, 'itemtypes');

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
        status, state, final_stage: Boolean(t.in_final_stage), item_type: typeNames.get(t.item_type_id) || '',
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

  // Sessions -> the rows the dashboard's hour widgets read (same shape as the old sessions.json).
  const projById = new Map(projectsRaw.map((p) => [p.id, p]));
  const taskName = new Map(tasks.map((t) => [t.id, t.name]));
  const sessions = (allSessions || []).map((s) => sessionRow(s, { users, groups, svcById, projById, taskName, now }));
  const failedUsers = [];
  sessions.sort((a, b) => (a.started < b.started ? -1 : 1));

  return {
    tasks, projects: projectRows, ...(withSessions ? { sessions } : {}),
    meta: withSessions ? { window_start: day(windowFrom), window_end: day(now) } : undefined,
    sync: {
      updated_at: new Date(now * 1000).toISOString(), source: 'live', hours_source: withSessions ? 'rework' : 'snapshot',
      tasks: tasks.length, projects: projectRows.length, sessions: sessions.length, sessions_failed_for: failedUsers,
      calls: api.calls(), seconds: Math.round((Date.now() - t0) / 100) / 10,
    },
  };
}

// Step-by-step timing for diagnosing slow or stuck pulls (GET /api/data?debug=1).
export async function diagnose(cfg, fetchImpl = fetch) {
  const api = client({ ...cfg, callTimeoutMs: 15000 }, fetchImpl);
  const steps = [];
  const time = async (label, fn) => {
    const t0 = Date.now();
    try { const n = await fn(); steps.push({ step: label, ms: Date.now() - t0, ok: true, n }); return true; }
    catch (e) { steps.push({ step: label, ms: Date.now() - t0, ok: false, error: String(e.name === 'TimeoutError' ? 'timed out after 15s' : e.message || e).slice(0, 200) }); return false; }
  };
  let projects = [];
  await time('ping', async () => (await api.post('/v1/ping')).status);
  await time('service/all', async () => (await api.pages('/v1/service/all', 'services')).length);
  await time('project/list', async () => (projects = await api.pages('/v1/project/list', 'projects')).length);
  if (projects[0]) {
    await time('task/list x1', async () => (await api.pages('/v1/task/list', 'tasks', { project_id: projects[0].id })).length);
    await time('task/list x8 parallel', async () => (await Promise.all(projects.slice(1, 9).map((p) => api.pages('/v1/task/list', 'tasks', { project_id: p.id })))).flat().length);
  }
  return { steps, projects: projects.length, region: process.env.VERCEL_REGION || 'local' };
}
