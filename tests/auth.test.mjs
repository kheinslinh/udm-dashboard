// node --test tests/  — sign-in flow with Google mocked.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import middleware from '../middleware.js';
import login from '../api/auth/login.js';
import callback from '../api/auth/callback.js';
import { COOKIE, sign, verify, allowed, config, newSession } from '../lib/session.js';

const ENV = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret', SESSION_SECRET: 'x'.repeat(32), ALLOWED_DOMAIN: 'unravel.com.my', ALLOWED_EMAILS: 'boss@rework.com' };
const idToken = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const cookieOf = (res, name) => res.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith(name + '='));

beforeEach(() => { for (const k of Object.keys(ENV)) process.env[k] = ENV[k]; });

test('fails closed when sign-in is not configured', async () => {
  delete process.env.SESSION_SECRET;
  const res = await middleware(new Request('https://x.app/'));
  assert.equal(res.status, 503);
});

test('unauthenticated page redirects to login, data answers 401', async () => {
  const res = await middleware(new Request('https://x.app/index.html?a=1'));
  assert.equal(res.status, 302);
  assert.equal(new URL(res.headers.get('location')).searchParams.get('next'), '/index.html?a=1');
  assert.equal((await middleware(new Request('https://x.app/data/sessions.json'))).status, 401);
});

test('valid session passes, forged or expired one does not', async () => {
  const good = await sign(ENV.SESSION_SECRET, newSession('a@unravel.com.my'));
  const ok = await middleware(new Request('https://x.app/', { headers: { cookie: `${COOKIE}=${good}` } }));
  assert.equal(ok.headers.get('x-middleware-next'), '1');
  const forged = await sign('y'.repeat(32), newSession('a@unravel.com.my'));
  assert.equal((await middleware(new Request('https://x.app/', { headers: { cookie: `${COOKIE}=${forged}` } }))).status, 302);
  const old = await sign(ENV.SESSION_SECRET, { email: 'a@unravel.com.my', exp: 1 });
  assert.equal(await verify(ENV.SESSION_SECRET, old), null);
});

test('domain and allow-list rules', () => {
  const cfg = config();
  assert.ok(allowed(cfg, 'Fiona.Seow@unravel.com.my', 'unravel.com.my'));
  assert.ok(!allowed(cfg, 'x@unravel.com.my', undefined), 'personal account with a look-alike address');
  assert.ok(!allowed(cfg, 'x@gmail.com', undefined));
  assert.ok(allowed(cfg, 'boss@rework.com', undefined));
});

async function signIn(claims) {
  const start = await login(new Request('https://x.app/api/auth/login?next=/%23team'));
  const google = new URL(start.headers.get('location'));
  assert.equal(google.searchParams.get('hd'), 'unravel.com.my');
  const state = google.searchParams.get('state');
  const stateCookie = cookieOf(start, 'udm_oauth_state');
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    assert.equal(new URLSearchParams(init.body).get('code'), 'abc');
    return new Response(JSON.stringify({ id_token: idToken(claims) }), { status: 200 });
  };
  return callback(new Request(`https://x.app/api/auth/callback?code=abc&state=${state}`, { headers: { cookie: stateCookie } }));
}

test('company account signs in and gets a session cookie', async () => {
  const res = await signIn({ aud: 'cid', email: 'fiona.seow@unravel.com.my', email_verified: true, hd: 'unravel.com.my' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/#team');
  const c = cookieOf(res, COOKIE);
  const session = await verify(ENV.SESSION_SECRET, decodeURIComponent(c.split('=').slice(1).join('=')));
  assert.equal(session.email, 'fiona.seow@unravel.com.my');
});

test('outside account and wrong audience are refused', async () => {
  assert.equal((await signIn({ aud: 'cid', email: 'someone@gmail.com', email_verified: true })).status, 403);
  assert.equal((await signIn({ aud: 'other', email: 'fiona.seow@unravel.com.my', email_verified: true, hd: 'unravel.com.my' })).status, 401);
});

test('callback with a mismatched state is refused', async () => {
  const res = await callback(new Request('https://x.app/api/auth/callback?code=abc&state=nope', { headers: { cookie: 'udm_oauth_state=real|/' } }));
  assert.equal(res.status, 400);
});
