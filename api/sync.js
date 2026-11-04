// Sync button and auto-sync: starts the "Refresh dashboard data" GitHub workflow, which pulls
// Rework and commits site/data (Vercel then redeploys). The middleware already requires the
// team password for this path.
//
// Vercel environment variables:
//   GITHUB_TOKEN  fine-grained token on kheinslinh/udm-dashboard with "Actions: Read and write"
//   GITHUB_REPO   optional, default kheinslinh/udm-dashboard
//
// GET  -> { configured, run: {status, conclusion, started_at, updated_at, url} | null }
// POST -> same, after starting a run. Body {"auto": true} only starts one when the last run
//         finished more than AUTO_MIN_AGE_MIN minutes ago (each run uses part of the Rework rate limit).

export const config = { runtime: 'edge' };

const WORKFLOW = 'refresh-dashboard.yml';
const AUTO_MIN_AGE_MIN = 30;

function gh(env, path, init = {}) {
  const repo = env.GITHUB_REPO || 'kheinslinh/udm-dashboard';
  return fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'udm-dashboard',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
}

async function latestRun(env) {
  const r = await gh(env, `/actions/workflows/${WORKFLOW}/runs?per_page=1&event=workflow_dispatch`);
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  const run = (await r.json()).workflow_runs?.[0];
  return run
    ? { status: run.status, conclusion: run.conclusion, started_at: run.run_started_at, updated_at: run.updated_at, url: run.html_url }
    : null;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const active = (run) => run && run.status !== 'completed';

export async function handle(request, env) {
  if (!env.GITHUB_TOKEN) return json({ configured: false, run: null });
  try {
    let run = await latestRun(env);
    if (request.method !== 'POST') return json({ configured: true, run });

    const auto = (await request.json().catch(() => ({}))).auto === true;
    const ageMin = run ? (Date.now() - Date.parse(run.updated_at)) / 60000 : Infinity;
    if (active(run) || (auto && ageMin < AUTO_MIN_AGE_MIN)) return json({ configured: true, run, started: false });

    const d = await gh(env, `/actions/workflows/${WORKFLOW}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ ref: 'main', inputs: { ping_only: false } }),
    });
    if (!d.ok) return json({ configured: true, run, error: `GitHub ${d.status}` }, 502);
    // The new run takes a moment to appear; report it as queued until then.
    return json({ configured: true, run: { status: 'queued', conclusion: null, started_at: new Date().toISOString(), updated_at: new Date().toISOString(), url: null }, started: true });
  } catch (e) {
    return json({ configured: true, run: null, error: String(e.message || e) }, 502);
  }
}

// Vercel passes a context object as the second argument, so read the environment here.
export default (request) => handle(request, process.env);
