// realvirtual.io (R) - plan-659 spike
//
// Renders spikes/659/duck/rv-duck.glb to PNG: a static http server over the package root
// (so /node_modules/three/... resolves), headless Chromium via Playwright, two views.
//
// Usage: node spikes/659/duck/render-duck.mjs

import http from 'node:http';
import { createReadStream, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..', '..', '..'); // realvirtual-WebViewer~
const OUT_DIR = HERE;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
  const file = path.resolve(PKG_ROOT, rel);
  if (!file.startsWith(PKG_ROOT)) { res.writeHead(403).end(); return; }
  try {
    if (!statSync(file).isFile()) throw new Error('not a file');
  } catch {
    res.writeHead(404).end('not found: ' + rel);
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = 'http://127.0.0.1:' + port;

const VIEWPORT = { width: 1400, height: 1050 };
const SCALE = 2; // -> 2800 x 2100 PNG

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(base + '/spikes/659/duck/preview.html', { waitUntil: 'load' });
try {
  await page.waitForFunction('window.__rvReady === true || window.__rvError', null, { timeout: 45000 });
} catch (e) {
  console.log('--- browser errors ---');
  for (const err of errors) console.log('  ' + err);
  await browser.close();
  server.close();
  throw e;
}

const loadError = await page.evaluate('window.__rvError || null');
if (loadError) throw new Error('GLB load failed: ' + loadError);

const bounds = await page.evaluate('window.__rvBounds');
console.log('model bounds (three/Y-up, metres):');
console.log('  min  ' + bounds.min.map((v) => v.toFixed(4)).join(', '));
console.log('  max  ' + bounds.max.map((v) => v.toFixed(4)).join(', '));
console.log('  size ' + bounds.size.map((v) => v.toFixed(4)).join(', '));

const SHOTS = [
  { view: 'threequarter', out: 'duck-preview.png' },
  { view: 'side', out: 'duck-side.png' },
  { view: 'head', out: 'duck-head.png' },
];
for (const s of SHOTS) {
  await page.evaluate('window.__rvSetView(' + JSON.stringify(s.view) + ')');
  await page.waitForTimeout(150);
  const png = await page.screenshot({ type: 'png' });
  const target = path.join(OUT_DIR, s.out);
  writeFileSync(target, png);
  console.log('wrote ' + target + '  (' + VIEWPORT.width * SCALE + 'x' + VIEWPORT.height * SCALE + ')');
}

await browser.close();
server.close();
if (errors.length) {
  console.log('--- browser errors ---');
  for (const e of errors) console.log('  ' + e);
}
