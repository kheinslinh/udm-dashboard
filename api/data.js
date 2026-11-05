// Live dashboard data: pulls Rework on request (about 10–20 s) and lets Vercel's CDN keep the answer.
//   GET /api/data          cached up to 5 minutes, then served stale while a fresh copy is pulled
//   GET /api/data?fresh=1  always pulls now (the Sync button)
// The middleware's password gate runs before the cache, so only signed-in viewers get the data.
// Vercel environment variables: REWORK_API_KEY, REWORK_API_PASSWORD (same values as the GitHub secrets).
import { pull, settings } from '../lib/rework.js';

export const config = { maxDuration: 60 };

export async function GET(request) {
  const cfg = settings(process.env);
  if (!cfg.key || !cfg.password) {
    // Names only (never values), so a misnamed or wrongly scoped variable is easy to spot.
    const seen = Object.keys(process.env).filter((k) => /REWORK|API_KEY|PASSWORD/i.test(k)).sort();
    return Response.json({
      error: 'REWORK_API_KEY / REWORK_API_PASSWORD are not set (Vercel env vars, or .env locally)',
      has_key: Boolean(cfg.key), has_password: Boolean(cfg.password), variables_seen: seen,
      environment: process.env.VERCEL_ENV || 'local', commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7),
    }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
  const fresh = new URL(request.url).searchParams.has('fresh');
  try {
    const data = await pull(cfg);
    return Response.json(data, {
      headers: { 'cache-control': fresh ? 'no-store' : 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400' },
    });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 502, headers: { 'cache-control': 'no-store' } });
  }
}
