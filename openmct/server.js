#!/usr/bin/env node
/**
 * Static file server for the Open MCT engineering view.
 *
 * Open MCT expects to be served over HTTP - opening index.html from the file
 * system breaks its ES module imports and its asset paths. This is the smallest
 * server that does the job, with no dependency beyond Node itself.
 *
 *     cd openmct && npm install && npm start
 *     http://127.0.0.1:8080
 *
 * It serves this directory (index.html, the two plugins, dictionary.json) plus
 * node_modules/openmct/dist, and binds to loopback only.
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';

    // Path traversal guard: resolve, then confirm the result is still inside
    // ROOT. Serving a static tree is no excuse for handing out ../../.ssh.
    const candidate = resolve(join(ROOT, normalize(pathname)));
    if (candidate !== ROOT && !candidate.startsWith(ROOT + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const info = await stat(candidate).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(
        `404 ${pathname}\n\n`
        + (pathname.includes('node_modules/openmct')
          ? 'Open MCT is not installed yet. Run:  cd openmct && npm install\n'
          : ''),
      );
      return;
    }

    res.writeHead(200, {
      'content-type': TYPES[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-cache',
    });
    createReadStream(candidate).pipe(res);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(String(err));
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ICARUS engineering view (Open MCT)');
  console.log(`  http://${HOST}:${PORT}`);
  console.log('');
  console.log('  Telemetry comes from the bridge at ws://127.0.0.1:8082.');
  console.log('  Start these first:   python bridge/bridge.py   and   fsw/icarus');
  console.log('  Ctrl-C to stop.');
  console.log('');
});
