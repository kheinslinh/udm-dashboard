// Signed session cookie and Google sign-in helpers, shared by middleware.js and api/auth/*.
// Web Crypto only, so it runs in Vercel's edge runtime and in Node 20+.
//
// Environment (Vercel → Project → Settings → Environment Variables):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET  Google Cloud OAuth client (type: Web application)
//   SESSION_SECRET                          any long random string; changing it signs everyone out
//   ALLOWED_DOMAIN                          e.g. unravel.com.my (Google Workspace domain allowed in)
//   ALLOWED_EMAILS                          optional, comma-separated extra addresses allowed in

export const COOKIE = 'udm_session';
export const STATE_COOKIE = 'udm_oauth_state';
const SESSION_DAYS = 7;
const enc = new TextEncoder();

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

export function config(env = process.env) {
  const c = {
    clientId: env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || '',
    secret: env.SESSION_SECRET || '',
    domain: (env.ALLOWED_DOMAIN || '').toLowerCase().trim(),
    emails: (env.ALLOWED_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean),
  };
  c.ready = Boolean(c.clientId && c.clientSecret && c.secret.length >= 16 && (c.domain || c.emails.length));
  return c;
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function sign(secret, payload) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(secret, body)}`;
}

export async function verify(secret, token, now = Date.now()) {
  if (!token || !secret) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig || !safeEqual(sig, await hmac(secret, body))) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    return p.exp && p.exp * 1000 > now ? p : null;
  } catch {
    return null;
  }
}

export function allowed(cfg, email, hd) {
  const e = (email || '').toLowerCase();
  if (cfg.emails.includes(e)) return true;
  return Boolean(cfg.domain) && e.endsWith('@' + cfg.domain) && (hd || '').toLowerCase() === cfg.domain;
}

export function newSession(email, now = Date.now()) {
  return { email, exp: Math.floor(now / 1000) + SESSION_DAYS * 86400 };
}

export function readCookie(req, name) {
  const raw = req.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function setCookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function randomState() {
  return b64url(crypto.getRandomValues(new Uint8Array(24)));
}

export function decodeIdToken(idToken) {
  const part = (idToken || '').split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(new TextDecoder().decode(fromB64url(part)));
  } catch {
    return null;
  }
}

export function page(status, title, message) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
      `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#1f1e1b">` +
      `<h1 style="font-size:20px">${esc(title)}</h1><p>${esc(message)}</p><p><a href="/api/auth/login">Sign in with Google</a></p></body>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  );
}
