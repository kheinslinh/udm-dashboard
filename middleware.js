// Every page and data file needs the team password (see lib/session.js).
import { COOKIE, loginPage, readCookie, settings, verify } from './lib/session.js';

// Logo and icons stay public so the password page can show them; nothing else does.
export const config = { matcher: ['/((?!api/auth/|assets/).*)'] };

export default async function middleware(request) {
  const cfg = await settings();
  if (await verify(cfg.secret, readCookie(request, COOKIE))) {
    return new Response(null, { headers: { 'x-middleware-next': '1' } });
  }
  const url = new URL(request.url);
  if (url.pathname.startsWith('/data/')) return new Response('Password required', { status: 401 });
  return loginPage(url.pathname + url.search, '', 401);
}
