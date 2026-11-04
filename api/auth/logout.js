import { setCookie } from '../../lib/session.js';

export const config = { runtime: 'edge' };

export default function handler() {
  return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': setCookie('', 0), 'cache-control': 'no-store' } });
}
