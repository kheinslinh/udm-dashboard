// Local copy of the dashboard, the same way the EPIC dashboard runs locally:
//   cp .env.example .env    # fill in the Rework key and password
//   npm run dev             # http://localhost:4100
// Serves site/ and the same /api/data the Vercel deployment uses (live pull from Rework).
// No dependencies; needs Node 20 or newer. There is no password page locally.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const SITE = join(ROOT, 'site');

// Minimal .env loader (KEY=value lines; # comments).
if (existsSync(join(ROOT, '.env'))) {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { GET: data } = await import('./api/data.js');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const PORT = Number(process.env.PORT || 4100);

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/api/data') {
      const t0 = Date.now();
      const r = await data(new Request(url));
      const body = Buffer.from(await r.arrayBuffer());
      console.log(`/api/data ${r.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      res.writeHead(r.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(body);
    }
    if (url.pathname === '/api/auth/logout') { res.writeHead(303, { location: '/' }); return res.end(); }
    const rel = normalize(decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = join(SITE, rel);
    if (!file.startsWith(SITE)) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch (e) {
    res.writeHead(e.code === 'ENOENT' ? 404 : 500, { 'content-type': 'text/plain' });
    res.end(e.code === 'ENOENT' ? 'Not found' : String(e.message || e));
  }
}).listen(PORT, () => {
  const ready = process.env.REWORK_API_KEY && process.env.REWORK_API_PASSWORD;
  console.log(`UDM dashboard on http://localhost:${PORT}` + (ready ? ' (live Rework data)' : ' — no .env: showing the saved snapshot only'));
});
