// Field shapes and options of newer Rework endpoints. Run with REWORK_API_KEY / REWORK_API_PASSWORD set.
import { settings, client } from '../lib/rework.js';
const cfg = settings(process.env);
const api = client(cfg);
const shape = (o, d = 0) => (o && typeof o === 'object' && !Array.isArray(o) && d < 2 ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, shape(v, d + 1)])) : Array.isArray(o) ? (o.length ? [shape(o[0], d + 1)] : []) : o === null ? 'null' : typeof o);
async function tryCall(label, path, body) {
  try {
    const out = await api.post(path, body);
    const list = Object.entries(out).find(([, v]) => Array.isArray(v));
    console.log(`${label}: ok keys=${Object.keys(out).join(',')} n=${list ? list[1].length : '-'} has_more=${out.has_more} total=${out.total ?? out.total_items ?? '-'}`);
    if (list && list[1][0]) console.log(`  item shape: ${JSON.stringify(shape(list[1][0]))}`);
    return out;
  } catch (e) { console.log(`${label}: ERROR ${e.message}`); return null; }
}
const now = Math.floor(Date.now() / 1000);
const projects = (await api.post('/v1/project/list', { limit: 200, page: 0 })).projects || [];
const p = projects.find((x) => x.status >= 0) || projects[0];
await tryCall('task/list updated_from, no project', '/v1/task/list', { updated_from: now - 7 * 86400, limit: 200, page: 0 });
await tryCall('task/list updated_from + project', '/v1/task/list', { project_id: p.id, updated_from: now - 30 * 86400, limit: 200, page: 0 });
const ws = await tryCall('worksession/list last 7 days', '/v1/worksession/list', { started_from: now - 7 * 86400, limit: 200, page: 0 });
await tryCall('worksession/list 92 days', '/v1/worksession/list', { started_from: now - 92 * 86400 + 60, limit: 200, page: 0 });
await tryCall('worksession/list updated_from', '/v1/worksession/list', { started_from: now - 92 * 86400 + 60, updated_from: now - 86400, limit: 200, page: 0 });
await tryCall('worksession/list status 1 (running)', '/v1/worksession/list', { started_from: now - 30 * 86400, status: [1, 2], limit: 200, page: 0 });
// how many pages for the dashboard window (first day of last month to now)
const d = new Date(); const from = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1) / 1000) - 8 * 3600;
let n = 0, pages = 0;
for (let page = 0; page < 30; page++) { const o = await api.post('/v1/worksession/list', { started_from: from, limit: 200, page }); n += (o.worksessions || o.sessions || o.items || Object.values(o).find(Array.isArray) || []).length; pages++; if (!o.has_more) break; }
console.log(`window since ${new Date(from * 1000).toISOString()}: ${n} sessions in ${pages} pages; calls used ${api.calls()}`);
