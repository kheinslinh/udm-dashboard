import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../api/sync.js';

const env = { GITHUB_TOKEN: 't' };
const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

function mockGitHub(run) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET' });
    if (url.includes('/dispatches')) return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ workflow_runs: run ? [run] : [] }), { status: 200 });
  };
  return calls;
}
const post = (body) => new Request('https://x/api/sync', { method: 'POST', body: JSON.stringify(body) });
const done = (m) => ({ status: 'completed', conclusion: 'success', run_started_at: minutesAgo(m + 5), updated_at: minutesAgo(m), html_url: 'u' });

test('without a GitHub token the button is hidden', async () => {
  const r = await (await handle(new Request('https://x/api/sync'), {})).json();
  assert.equal(r.configured, false);
});

test('auto sync skips when the last run is recent', async () => {
  const calls = mockGitHub(done(10));
  const r = await (await handle(post({ auto: true }), env)).json();
  assert.equal(r.started, false);
  assert.ok(!calls.some((c) => c.url.includes('/dispatches')));
});

test('auto sync starts when the data is old', async () => {
  const calls = mockGitHub(done(45));
  const r = await (await handle(post({ auto: true }), env)).json();
  assert.equal(r.started, true);
  assert.ok(calls.some((c) => c.url.includes('/dispatches') && c.method === 'POST'));
});

test('manual sync starts even when recent, but never doubles a running one', async () => {
  mockGitHub(done(2));
  assert.equal((await (await handle(post({}), env)).json()).started, true);
  const calls = mockGitHub({ ...done(0), status: 'in_progress', conclusion: null });
  assert.equal((await (await handle(post({}), env)).json()).started, false);
  assert.ok(!calls.some((c) => c.url.includes('/dispatches')));
});
