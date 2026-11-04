// Every page and data file needs a signed-in @ALLOWED_DOMAIN Google account.
// Fails closed: until the sign-in variables are set on Vercel, the site shows a setup notice instead of data.
import { COOKIE, config as authConfig, page, readCookie, verify } from './lib/session.js';

export const config = { matcher: ['/((?!api/auth/).*)'] };

export default async function middleware(request) {
  const cfg = authConfig();
  if (!cfg.ready) {
    return page(503, 'Sign-in is not set up yet', 'Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET and ALLOWED_DOMAIN in the Vercel project settings, then redeploy.');
  }
  const session = await verify(cfg.secret, readCookie(request, COOKIE));
  if (session) return new Response(null, { headers: { 'x-middleware-next': '1' } });

  const url = new URL(request.url);
  if (url.pathname.startsWith('/data/')) return new Response('Sign in required', { status: 401 });
  const login = new URL('/api/auth/login', url);
  login.searchParams.set('next', url.pathname + url.search);
  return Response.redirect(login, 302);
}
