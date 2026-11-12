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
      if (!body.service_id || body.project_id) throw new Error('tasks must be listed by service');
      if (body.page === 0) return ok({ has_more: true, tasks: [{ id: 't1', project_id: 'p1', name: 'Static 1', status: 10, deadline: NOW - 2 * DAY, finished_at: NOW - 3 * DAY, assignee_id: 6535, item_type_id: 'it1' }] });
      return ok({ tasks: [{ id: 't2', project_id: 'p1', name: 'Video', status: 1, deadline: NOW - DAY, assignee_id: 6534, stage_id: 'st9', in_final_stage: true }] });
    }
    if (path === '/v1/service/get.itemtypes') return ok({ itemtypes: [{ id: 'it1', name: 'Static' }] });
    if (path === '/v1/worksession/list') {
      if (body.scope !== 'all') throw new Error('sessions must use scope all');
      return ok({ total: 2, per_page: 200, sessions: [
        { id: 'w1', user_id: 6535, name: 'Static 1 revision', status: 10, running: false, started_at: NOW - 2 * DAY, seconds: 5400, task_id: 't1', project_id: 'p1', service_id: 's1' },
        { id: 'w2', user_id: 6535, name: '', status: 10, running: false, started_at: NOW - DAY, seconds: 14 * 3600, task_id: '', project_id: 'p1', service_id: 's1' }] });
    }
    throw new Error('unexpected ' + path);
  };
  return { calls, fetchImpl };
}

test('pulls projects in one call, tasks per service, sessions in one list', async () => {
  const { calls, fetchImpl } = fakeRework();
  const cfg = settings({ REWORK_API_KEY: 'k', REWORK_API_PASSWORD: 'p' });
  const out = await pull(cfg, { now: NOW, fetchImpl });
  assert.equal(calls.filter((c) => c.path === '/v1/project/list').length, 1);
  assert.ok(!calls.some((c) => c.path === '/v1/project/list' && c.body.service_id));
  assert.deepEqual(calls.filter((c) => c.path === '/v1/task/list').map((c) => c.body.service_id), ['s1', 's1']);  // one service, two pages; p3's service inactive
  assert.equal(calls[0].headers['x-api-token'], 'k');
  assert.equal(calls[0].headers['x-api-password'], 'p');
  assert.equal(calls[0].body.user_id, 6144);
  assert.deepEqual(out.tasks.map((t) => [t.id, t.state, t.item_type, t.final_stage]), [['t1', 'done', 'Static', false], ['t2', 'overdue', '', true]]);
  assert.ok(!calls.some((c) => c.path === '/v1/service/get.stages'), 'stage names are not fetched any more');
  const ws = calls.filter((c) => c.path === '/v1/worksession/list');
  assert.equal(ws.length, 1);
  assert.ok(ws[0].body.started_from && ws[0].body.scope === 'all');
  assert.deepEqual(out.sessions.map((r) => [r.person, r.task, r.hours, r.revision, r.runaway, r.service_group, r.linked]),
    [['Syafiqah', 'Static 1', 1.5, true, false, '(no client)', true], ['Syafiqah', '', 14, false, true, '(no client)', false]]);
  assert.equal(out.sync.hours_source, 'rework');
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

test('a rate limit stops the pull at once with the wait time', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ status: 0, error: 'rate_limited', retry_after: 277 }), { status: 429 });
  const cfg = settings({ REWORK_API_KEY: 'k', REWORK_API_PASSWORD: 'p' });
  const t0 = Date.now();
  await assert.rejects(pull(cfg, { now: NOW, fetchImpl }), (e) => e.rateLimited && e.retryAfter === 277);
  assert.ok(Date.now() - t0 < 1000);
});

test('a dropped connection is retried', async () => {
  let n = 0;
  const fetchImpl = async () => (++n === 1 ? new Response('upstream connect error', { status: 503 }) : new Response(JSON.stringify({ status: 1, message: 'PONG' })));
  const api = (await import('../lib/rework.js')).client(settings({ REWORK_API_KEY: 'k', REWORK_API_PASSWORD: 'p' }), fetchImpl);
  assert.equal((await api.post('/v1/ping')).message, 'PONG');
  assert.equal(n, 2);
});
