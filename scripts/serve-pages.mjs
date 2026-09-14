#!/usr/bin/env node
/**
 * Serve dist/ the way GitHub Pages serves a PROJECT page: under a repository
 * sub-path, with nothing at the domain root.
 *
 *     BASE_PATH=/icarus-cubesat-simulation-engineering-day/ npm run build
 *     node scripts/serve-pages.mjs
 *     http://127.0.0.1:4173/icarus-cubesat-simulation-engineering-day/
 *
 * Why this exists: `npm run preview` serves at the root by default, which
 * hides exactly the class of bug this is meant to catch - an asset referenced
 * as /assets/x.js instead of /<repo>/assets/x.js works at the root and 404s on
 * Pages. Testing the real sub-path locally is the only way to be sure before
 * pushing.
 *
 * Env: BASE_PATH (default /icarus-cubesat-simulation-engineering-day/), PORT (default 4173).
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = resolve(fileURLToPath(new URL('../dist', import.meta.url)));
const BASE = (process.env.BASE_PATH ?? '/icarus-cubesat-simulation-engineering-day/').replace(/\/*$/, '/');
const PORT = Number(process.env.PORT ?? 4173);
const HOST = '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? HOST}`);
  let pathname = decodeURIComponent(url.pathname);

  // Anything outside the repository sub-path does not exist on a project page.
  if (!pathname.startsWith(BASE)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(
      `404 ${pathname}\n\n`
      + `A GitHub Pages project site only serves ${BASE}\n`
      + `Try http://${HOST}:${PORT}${BASE}\n`,
    );
    return;
  }

  let relative = pathname.slice(BASE.length);
  if (relative === '' || relative.endsWith('/')) relative += 'index.html';

  const candidate = resolve(join(DIST, normalize(relative)));
  if (candidate !== DIST && !candidate.startsWith(DIST + sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  const info = await stat(candidate).catch(() => null);
  if (!info?.isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`404 ${pathname}\n`);
    return;
  }

  res.writeHead(200, {
    'content-type': TYPES[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-cache',
  });
  createReadStream(candidate).pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Serving dist/ as a GitHub Pages project site`);
  console.log(`  http://${HOST}:${PORT}${BASE}\n`);
  console.log(`  Anything outside ${BASE} returns 404, exactly as Pages would.\n`);
});
