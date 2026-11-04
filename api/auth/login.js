import { STATE_COOKIE, config as authConfig, page, randomState, setCookie } from '../../lib/session.js';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  const cfg = authConfig();
  if (!cfg.ready) return page(503, 'Sign-in is not set up yet', 'Ask the admin to add the Google sign-in settings on Vercel.');
  const url = new URL(request.url);
  const next = url.searchParams.get('next') || '/';
  const state = randomState();
  const google = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  google.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: new URL('/api/auth/callback', url).toString(),
    response_type: 'code',
    scope: 'openid email',
    state,
    prompt: 'select_account',
    ...(cfg.domain && { hd: cfg.domain }),
  }).toString();
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';
  return new Response(null, {
    status: 302,
    headers: { location: google.toString(), 'set-cookie': setCookie(STATE_COOKIE, `${state}|${safeNext}`, 600), 'cache-control': 'no-store' },
  });
}
