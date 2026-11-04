import { SESSION_MAX_AGE, loginPage, passwordOk, safeNext, setCookie, settings, sign } from '../../lib/session.js';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  if (request.method !== 'POST') return loginPage(new URL(request.url).searchParams.get('next') || '/');
  const form = await request.formData();
  const next = safeNext(form.get('next'));
  const cfg = await settings();
  if (!(await passwordOk(cfg, form.get('password')))) return loginPage(next, 'Wrong password. Please try again.', 401);
  return new Response(null, {
    status: 303,
    headers: { location: next, 'set-cookie': setCookie(await sign(cfg.secret), SESSION_MAX_AGE), 'cache-control': 'no-store' },
  });
}
