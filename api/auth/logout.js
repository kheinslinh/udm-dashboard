import { COOKIE, setCookie } from '../../lib/session.js';

export const config = { runtime: 'edge' };

export default function handler() {
  return new Response('<!doctype html><meta charset="utf-8"><p style="font-family:system-ui;margin:20vh auto;max-width:28rem">Signed out. <a href="/api/auth/login">Sign in again</a></p>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'set-cookie': setCookie(COOKIE, '', 0), 'cache-control': 'no-store' },
  });
}
