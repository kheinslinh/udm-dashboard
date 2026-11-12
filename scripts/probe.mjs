// Probe: task/list by service_id, and how worksession/list loads a whole team.
import { settings, client } from '../lib/rework.js';
import teams from '../udm_report/teams.json' with { type: 'json' };
const cfg = settings(process.env);
const api = client(cfg);
const now = Math.floor(Date.now() / 1000);
const from = now - 40 * 86400;
const safe = (p) => p.catch((e) => ({ error: e.message.slice(0, 180) }));
const services = (await api.post('/v1/service/all', { limit: 200, page: 0 })).services.filter((s) => (s.model || 'project.project') === 'project.project' && s.status === 1);
const svc = services[0];
const t = await safe(api.post('/v1/task/list', { service_id: svc.id, limit: 200, page: 0 }));
console.log(`task/list service_id (${svc.name}): ${t.error || `n=${t.tasks.length} total=${t.total} has_more=${t.has_more} projects=${new Set(t.tasks.map((x) => x.project_id)).size}`}`);
const tu = await safe(api.post('/v1/task/list', { service_id: svc.id, updated_from: now - 7 * 86400, limit: 200, page: 0 }));
console.log(`task/list service_id + updated_from 7d: ${tu.error || `n=${tu.tasks.length} total=${tu.total}`}`);
console.log(`services: ${services.length}`);
const ids = Object.keys(teams.users).map(Number);
const variants = {
  'no extra': {},
  user_ids: { user_ids: ids }, users: { users: ids }, member_ids: { member_ids: ids }, owner_ids: { owner_ids: ids },
  'user_id array': { user_id: ids }, team: { team: true }, scope_team: { scope: 'team' }, scope_all: { scope: 'all' },
  service_id: { service_id: svc.id },
};
for (const [label, extra] of Object.entries(variants)) {
  const body = { started_from: from, limit: 200, page: 0, ...extra };
  const o = await safe(api.post('/v1/worksession/list', body));
  const owners = o.sessions ? new Set(o.sessions.map((s) => s.user_id)).size : 0;
  console.log(`worksession ${label}: ${o.error || `total=${o.total} n=${o.sessions.length} owners=${owners} has_more=${o.has_more}`}`);
}
console.log(`calls used ${api.calls()}`);
