// node --test tests/auth.test.mjs — password gate.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import middleware from '../middleware.js';
import login from '../api/auth/login.js';
import { COOKIE, settings, sign } from '../lib/session.js';

const form = (fields) => new Request('https://x.app/api/auth/login', { method: 'POST', body: new URLSearchParams(fields) });
const cookieOf = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith(COOKIE + '='));

beforeEach(() => { delete process.env.SITE_PASSWORD; delete process.env.SESSION_SECRET; });

test('pages show the password form, data answers 401', async () => {
  const res = await middleware(new Request('https://x.app/#team'));
  assert.equal(res.status, 401);
  assert.match(await res.text(), /name="password"/);
  assert.equal((await middleware(new Request('https://x.app/data/sessions.json'))).status, 401);
});

test('right password sets a cookie that opens the site', async () => {
  const res = await login(form({ password: 'udm2026', next: '/index.html' }));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/index.html');
  const ok = await middleware(new Request('https://x.app/data/sessions.json', { headers: { cookie: cookieOf(res) } }));
  assert.equal(ok.headers.get('x-middleware-next'), '1');
});

test('wrong password, forged cookie and off-site redirect are refused', async () => {
  assert.equal((await login(form({ password: 'nope' }))).status, 401);
  const forged = await sign('someone-else');
  assert.equal((await middleware(new Request('https://x.app/', { headers: { cookie: `${COOKIE}=${forged}` } }))).status, 401);
  const res = await login(form({ password: 'udm2026', next: '//evil.com' }));
  assert.equal(res.headers.get('location'), '/');
});

test('SITE_PASSWORD replaces the default and signs old sessions out', async () => {
  const old = cookieOf(await login(form({ password: 'udm2026' })));
  process.env.SITE_PASSWORD = 'new-pass';
  assert.equal((await login(form({ password: 'udm2026' }))).status, 401);
  assert.equal((await login(form({ password: 'new-pass' }))).status, 303);
  assert.equal((await middleware(new Request('https://x.app/', { headers: { cookie: old } }))).status, 401);
  assert.ok((await settings()).secret);
});
