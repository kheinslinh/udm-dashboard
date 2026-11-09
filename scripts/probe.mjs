// Third probe: can we read everyone's work sessions, per acting user or per project?
import { settings, client } from '../lib/rework.js';
import teams from '../udm_report/teams.json' with { type: 'json' };
const cfg = settings(process.env);
const api = client(cfg);
const now = Math.floor(Date.now() / 1000);
const from = now - 92 * 86400 + 60;
const safe = (p) => p.catch((e) => ({ error: e.message.slice(0, 160) }));
// 1) acting as other staff
const ids = Object.keys(teams.users).slice(0, 6);
for (const uid of ids) {
  const o = await safe(api.post('/v1/worksession/list', { user_id: Number(uid), started_from: from, limit: 200, page: 0 }));
  const users = o.sessions ? [...new Set(o.sessions.map((s) => s.user_id))] : [];
  console.log(`acting as ${uid} (${teams.users[uid].name}): ${o.error || `total ${o.total}, owners ${JSON.stringify(users)}`}`);
}
// 2) per project, for the projects with most tasks
const projects = (await api.post('/v1/project/list', { limit: 200, page: 0 })).projects || [];
for (const p of projects.filter((x) => x.status >= 0).slice(0, 4)) {
  const o = await safe(api.post('/v1/worksession/list', { project_id: p.id, started_from: from, limit: 200, page: 0 }));
  const users = o.sessions ? [...new Set(o.sessions.map((s) => s.user_id))] : [];
  console.log(`project ${p.name.slice(0, 30)}: ${o.error || `total ${o.total}, owners ${JSON.stringify(users)}`}`);
}
// 3) project updated_at vs its newest task
let follows = 0, checked = 0;
for (const p of projects.filter((x) => x.status >= 0).sort((a, b) => b.updated_at - a.updated_at).slice(0, 6)) {
  const t = (await api.post('/v1/task/list', { project_id: p.id, limit: 200, page: 0 })).tasks || [];
  const maxT = Math.max(0, ...t.map((x) => x.updated_at || 0)); checked++; if (p.updated_at >= maxT) follows++;
  console.log(`  ${p.name.slice(0, 28)} project.updated ${p.updated_at} newest task ${maxT}`);
}
console.log(`project.updated_at >= newest task in ${follows}/${checked}`);
const pu = await safe(api.post('/v1/project/list', { updated_from: now - 3 * 86400, limit: 200, page: 0 }));
console.log(`project/list updated_from: ${pu.error || `${pu.projects.length} of ${projects.length}`}`);
console.log(`calls used ${api.calls()}`);
