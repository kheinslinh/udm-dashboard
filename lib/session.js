// Password gate shared by middleware.js and api/auth/*. Web Crypto only (Vercel edge runtime, Node 20+).
//
// Optional environment (Vercel → Project → Settings → Environment Variables):
//   SITE_PASSWORD   replaces the default password
//   SESSION_SECRET  signs the session cookie; defaults to a value derived from the password,
//                   so changing the password signs everyone out

export const COOKIE = 'udm_session';
const SESSION_DAYS = 7;
// SHA-256 of the default password, so the password itself is not in the code.
const DEFAULT_PASSWORD_SHA256 = 'f38575d52d6309173ed33e8c1528c00a7844ffafe6005c777bb22cc8b85cd9fd';
const enc = new TextEncoder();

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

export const sha256 = async (text) => hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));

export async function settings(env = process.env) {
  const passwordHash = env.SITE_PASSWORD ? await sha256(env.SITE_PASSWORD) : DEFAULT_PASSWORD_SHA256;
  return { passwordHash, secret: env.SESSION_SECRET || `udm-session:${passwordHash}` };
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function passwordOk(cfg, password) {
  return safeEqual(await sha256(password || ''), cfg.passwordHash);
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export async function sign(secret, now = Date.now()) {
  const body = b64url(enc.encode(JSON.stringify({ exp: Math.floor(now / 1000) + SESSION_DAYS * 86400 })));
  return `${body}.${await hmac(secret, body)}`;
}

export async function verify(secret, token, now = Date.now()) {
  if (!token) return false;
  const [body, sig] = token.split('.');
  if (!body || !sig || !safeEqual(sig, await hmac(secret, body))) return false;
  try {
    return JSON.parse(new TextDecoder().decode(fromB64url(body))).exp * 1000 > now;
  } catch {
    return false;
  }
}

export function readCookie(req, name) {
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export const setCookie = (value, maxAge) => `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
export const SESSION_MAX_AGE = SESSION_DAYS * 86400;

export function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export function loginPage(next = '/', error = '', status = 200) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>UDM Time &amp; Delivery</title><link rel="icon" type="image/png" href="/assets/favicon.png"><style>
:root{--bg:#f4f4f8;--panel:#fff;--fg:#1d1d1f;--muted:#66657a;--line:#e4e2ee;--accent:#6c00ff;--bad:#ff6a1a}
@media (prefers-color-scheme:dark){:root{--bg:#121018;--panel:#1c1924;--fg:#f1eff7;--muted:#a9a5b8;--line:#2f2a3d;--accent:#9a4dff;--bad:#ff8a3d}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(135deg,#3a0a8c 0%,#6c00ff 60%,#8b3dff 100%);color:var(--fg);font-family:Inter,system-ui,sans-serif;padding:16px}
form{background:var(--panel);border-radius:4px;padding:32px 28px;width:100%;max-width:380px;box-shadow:0 20px 50px rgba(20,0,60,.35)}
h1{font-size:14px;margin:0 0 4px;text-transform:uppercase;letter-spacing:.06em}p{color:var(--muted);font-size:13px;margin:0 0 18px}
input{width:100%;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:2px;background:var(--bg);color:var(--fg)}
button{width:100%;margin-top:12px;font:inherit;font-weight:600;padding:10px;border:0;border-radius:2px;background:var(--accent);color:#fff;cursor:pointer}
.err{color:var(--bad);font-size:13px;margin:10px 0 0}@media (prefers-color-scheme:dark){form img{filter:invert(1) hue-rotate(180deg) brightness(1.1)}}</style></head><body>
<form method="post" action="/api/auth/login"><img src="/assets/unravel-wordmark.png" alt="UnRavel" style="height:30px;display:block;margin-bottom:16px"><h1>Time &amp; delivery</h1><p>Enter the team password to continue.</p>
<input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
<input type="hidden" name="next" value="${esc(safeNext(next))}">
<button type="submit">Open dashboard</button>${error ? `<div class="err">${esc(error)}</div>` : ''}</form></body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
