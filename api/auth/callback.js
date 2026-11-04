import { COOKIE, STATE_COOKIE, allowed, config as authConfig, decodeIdToken, newSession, page, readCookie, setCookie, sign } from '../../lib/session.js';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  const cfg = authConfig();
  if (!cfg.ready) return page(503, 'Sign-in is not set up yet', 'Ask the admin to add the Google sign-in settings on Vercel.');
  const url = new URL(request.url);
  const [state, next = '/'] = (readCookie(request, STATE_COOKIE) || '').split('|');
  if (!state || state !== url.searchParams.get('state') || !url.searchParams.get('code')) {
    return page(400, 'Sign-in expired', 'Please try again.');
  }

  // The code is exchanged directly with Google over TLS, so the id_token in the answer is trusted as is.
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: url.searchParams.get('code'),
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: new URL('/api/auth/callback', url).toString(),
      grant_type: 'authorization_code',
    }),
  });
  const token = res.ok ? await res.json() : null;
  const claims = decodeIdToken(token && token.id_token);
  if (!claims || claims.aud !== cfg.clientId || !claims.email_verified) {
    return page(401, 'Sign-in failed', 'Google did not confirm the account. Please try again.');
  }
  if (!allowed(cfg, claims.email, claims.hd)) {
    return page(403, 'Not allowed', `${claims.email} does not have access to this dashboard. Sign in with your company Google account.`);
  }
  const headers = new Headers({ location: next.startsWith('/') && !next.startsWith('//') ? next : '/', 'cache-control': 'no-store' });
  headers.append('set-cookie', setCookie(COOKIE, await sign(cfg.secret, newSession(claims.email)), 7 * 86400));
  headers.append('set-cookie', setCookie(STATE_COOKIE, '', 0));
  return new Response(null, { status: 302, headers });
}
