// Second probe: whose work sessions does worksession/list return, and does a project's updated_at follow its tasks?
import { settings, client, pool } from '../lib/rework.js';
const cfg = settings(process.env);
const api = client(cfg);
const now = Math.floor(Date.now() / 1000);
const from = now - 92 * 86400 + 60;
const all = [];
for (let page = 0; page < 20; page++) { const o = await api.post('/v1/worksession/list', { started_from: from, limit: 200, page }); all.push(...(o.sessions || [])); if (!o.has_more) break; }
const by = (k) => Object.entries(all.reduce((m, s) => ((m[s[k]] = (m[s[k]] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
console.log(`acting user ${cfg.userId}: ${all.length} sessions; by user_id ${JSON.stringify(by('user_id'))}`);
console.log(`hours ${Math.round(all.reduce((a, s) => a + (s.seconds || 0), 0) / 36) / 100}; by status ${JSON.stringify(by('status'))}; logged ${JSON.stringify(by('logged'))}`);
console.log(`months ${JSON.stringify(Object.entries(all.reduce((m, s) => { const k = new Date(s.started_at * 1000).toISOString().slice(0, 7); m[k] = (m[k] || 0) + 1; return m; }, {})))}`);
// a busy project from the session list vs the same project via project_id
const pid = by('project_id')[0]?.[0];
if (pid) { const o = await api.post('/v1/worksession/list', { started_from: from, project_id: pid, limit: 200, page: 0 }); console.log(`project ${pid}: all-list ${all.filter((s) => s.project_id === pid).length} vs project_id filter ${o.total}`); }
// other acting user: the first non-6144 user seen in the sessions, if any
for (const uid of [6413, 6535]) { const o = await api.post('/v1/worksession/list', { user_id: uid, started_from: from, limit: 1, page: 0 }).catch((e) => ({ total: 'ERR ' + e.message.slice(0, 80) })); console.log(`acting as ${uid}: total ${o.total}`); }
// project updated_at vs newest task updated_at, on 12 recently updated projects
const projects = (await api.post('/v1/project/list', { limit: 200, page: 0 })).projects || [];
const recent = projects.filter((p) => p.status >= 0).sort((a, b) => b.updated_at - a.updated_at).slice(0, 12);
const rows = await pool(recent, 6, async (p) => { const t = (await api.post('/v1/task/list', { project_id: p.id, limit: 200, page: 0 })).tasks || []; const maxT = Math.max(0, ...t.map((x) => x.updated_at || 0)); return [p.name.slice(0, 24), p.updated_at, maxT, p.updated_at >= maxT]; });
console.log('project.updated_at >= newest task.updated_at ?', JSON.stringify(rows));
console.log(`project/list accepts updated_from? ${await api.post('/v1/project/list', { updated_from: now - 3 * 86400, limit: 200, page: 0 }).then((o) => `yes, ${o.projects.length} of ${projects.length}`).catch((e) => 'no: ' + e.message.slice(0, 80))}`);
console.log(`calls used ${api.calls()}`);
