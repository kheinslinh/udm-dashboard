import test from 'node:test';
import assert from 'node:assert/strict';
import { pull, pool, settings } from '../lib/rework.js';

const NOW = Date.UTC(2026, 10, 5) / 1000;
const DAY = 86400;

function fakeRework() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname.replace('/project', '');
    const body = JSON.parse(init.body);
    calls.push({ path, body, headers: init.headers });
    const ok = (o) => new Response(JSON.stringify({ status: 1, has_more: false, ...o }));
    if (path === '/v1/service/all') return ok({ services: [
      { id: 's1', name: 'Social', status: 1, group_id: 'g1', model: 'project.project' },
      { id: 's2', name: 'Old', status: 0, group_id: 'g1', model: 'project.project' }] });
    if (path === '/v1/project/list') return ok({ projects: [
      { id: 'p1', service_id: 's1', name: 'Nov posts', status: 1, owners: [6535], deadline: NOW + 5 * DAY, updated_at: NOW, financials: { effort: 40, effort_recorded: 12.5, income: 9999 } },
      { id: 'p2', service_id: 's1', name: 'Done long ago', status: 10, updated_at: NOW - 200 * DAY },
      { id: 'p3', service_id: 's2', name: 'Inactive service', status: 1 }] });
    if (path === '/v1/task/list') {
      if (body.page === 0) return ok({ has_more: true, tasks: [{ id: 't1', name: 'Static 1', status: 10, deadline: NOW - 2 * DAY, finished_at: NOW - 3 * DAY, assignee_id: 6535, item_type_id: 'it1' }] });
      return ok({ tasks: [{ id: 't2', name: 'Video', status: 1, deadline: NOW - DAY, assignee_id: 6534, stage_id: 'st9' }] });
    }
    if (path === '/v1/service/get.itemtypes') return ok({ itemtypes: [{ id: 'it1', name: 'Static' }] });
    if (path === '/v1/service/get.stages') return ok({ stages: [{ id: 'st9', name: 'Approved' }] });
    throw new Error('unexpected ' + path);
  };
  return { calls, fetchImpl };
}

test('pulls every project in one list call and tasks per project', async () => {
  const { calls, fetchImpl } = fakeRework();
  const cfg = settings({ REWORK_API_KEY: 'k', REWORK_API_PASSWORD: 'p' });
  const out = await pull(cfg, { now: NOW, fetchImpl });
  assert.equal(calls.filter((c) => c.path === '/v1/project/list').length, 1);
  assert.ok(!calls.some((c) => c.path === '/v1/project/list' && c.body.service_id));
  assert.deepEqual(calls.filter((c) => c.path === '/v1/task/list').map((c) => c.body.project_id), ['p1', 'p1']);  // p2 stale, p3 inactive
  assert.equal(calls[0].headers['x-api-token'], 'k');
  assert.equal(calls[0].headers['x-api-password'], 'p');
  assert.equal(calls[0].body.user_id, 6144);
  assert.deepEqual(out.tasks.map((t) => [t.id, t.state, t.item_type, t.stage]), [['t1', 'done', 'Static', ''], ['t2', 'overdue', '', 'Approved']]);
  const p = out.projects[0];
  assert.deepEqual([p.done, p.total, p.overdue, p.est_hours, p.logged_hours, p.owners[0]], [1, 2, 1, 40, 12.5, 'Syafiqah']);
  assert.ok(!JSON.stringify(out).includes('9999'), 'money must not leak');
  assert.equal(out.sync.source, 'live');
});

test('pool keeps order and limits concurrency', async () => {
  let live = 0, peak = 0;
  const out = await pool([1, 2, 3, 4, 5], 2, async (x) => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--; return x * 2; });
  assert.deepEqual(out, [2, 4, 6, 8, 10]);
  assert.equal(peak, 2);
});
