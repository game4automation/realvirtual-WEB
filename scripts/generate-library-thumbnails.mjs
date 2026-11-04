// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * generate-library-thumbnails.mjs — render the saved previews of the bundled
 * library (plan-776 §9.6).
 *
 * The planner renders nothing for a catalog entry: the library panel shows
 * `<category>/.thumbnails/<encodedId>.<hash8>.webp` when the catalog's
 * `thumbnail` names one, else a placeholder. This script makes those files with
 * the SAME render path a document save uses (`renderThumbnailImage`: 512×512,
 * transparent, webp, hashed name). Every document of `public/library/project.json` (catalog.json before plan-778)
 * is opened in a running dev viewer, rendered, and written next to its GLB; the
 * previous sidecar of the same id is deleted. Rebuild the catalog afterwards
 * (`npm run build:library`) so the `thumbnail` pointers follow. A dev server
 * that was running while the files appeared does not serve them (its public-file
 * index is built at start and the watcher ignores `public/library/**`) — restart
 * it before looking at the library panel.
 *
 * Needs a running Vite dev server of THIS checkout and Playwright's Chromium:
 *   npx vite --port 5394 --strictPort
 *   node scripts/generate-library-thumbnails.mjs [--base http://127.0.0.1:5394] [--only <id>[,<id>]]
 */

import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, LIBRARY_DIR, encodeThumbnailId } from './build-local-library-catalog.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const BASE = opt('--base', 'http://127.0.0.1:5394');
const only = new Set((opt('--only', '') ?? '').split(',').filter(Boolean));

const require = createRequire(join(ROOT, 'package.json'));
const { chromium } = require('playwright');

// plan-778: the library is a project — read its documents (id, name, path). The bundled
// catalog.json is gone (Phase 4); `npm run prebuild` writes project.json.
function readLibraryEntries() {
  const project = JSON.parse(readFileSync(join(LIBRARY_DIR, 'project.json'), 'utf8'));
  return (Array.isArray(project.documents) ? project.documents : [])
    .map((d) => ({ id: d.id, name: d.name, glbUrl: d.path }));
}
const entries = readLibraryEntries().filter((e) => only.size === 0 || only.has(e.id));

// Headed + no throttling: a headless shell has no WebGPU device and an
// occluded window renders at a crawl.
const browser = await chromium.launch({
  headless: false,
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log(`[page:error] ${m.text().slice(0, 300)}`); });
await page.goto(`${BASE}/?consent=decline&hmi=0`);
await page.waitForFunction(() => !!window.viewer, null, { timeout: 180000 });
await page.waitForFunction(async () => {
  const m = await import('/src/core/hmi/scene/scene-store-ref.ts');
  return !!m.getSceneStore();
}, null, { timeout: 180000, polling: 1000 });
await page.waitForTimeout(3000);

const failed = [];
let bytesTotal = 0;
for (const entry of entries) {
  const t0 = Date.now();
  const res = await page.evaluate(async ({ url, label }) => {
    const { getSceneStore } = await import('/src/core/hmi/scene/scene-store-ref.ts');
    const { renderThumbnailImage } = await import('/src/core/thumbnails/rv-thumbnail-write.ts');
    const viewer = window.viewer;
    try {
      let store = getSceneStore();
      for (let i = 0; i < 120 && !store; i++) { await new Promise((r) => setTimeout(r, 1000)); store = getSceneStore(); }
      if (!store) return { error: 'scene store not available' };
      await store.openBuiltin(url, label, { updateUrl: false });
      await Promise.race([viewer.whenSceneReady?.(), new Promise((r) => setTimeout(r, 120000))]);
      await new Promise((r) => setTimeout(r, 500));
      const image = await renderThumbnailImage(viewer);
      if (!image) return { error: 'nothing renderable (empty scene, lost context or blank image)' };
      let s = '';
      for (let i = 0; i < image.bytes.length; i += 0x8000) s += String.fromCharCode(...image.bytes.subarray(i, i + 0x8000));
      return { b64: btoa(s), hash8: image.hash8, ext: image.ext };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, { url: `/library/${entry.glbUrl}`, label: entry.name });

  if (res.error) {
    failed.push({ id: entry.id, reason: res.error });
    console.log(`FAIL ${entry.id}: ${res.error}`);
    continue;
  }
  const folder = entry.glbUrl.includes('/') ? entry.glbUrl.slice(0, entry.glbUrl.indexOf('/')) : '';
  const dir = join(LIBRARY_DIR, ...(folder ? [folder] : []), '.thumbnails');
  mkdirSync(dir, { recursive: true });
  const prefix = `${encodeThumbnailId(entry.id)}.`;
  const name = `${prefix}${res.hash8}.${res.ext}`;
  // One picture per id: drop the predecessors (only exact hashed names of this id).
  for (const old of readdirSync(dir)) {
    if (old !== name && old.startsWith(prefix) && /^[0-9a-f]{8}\.(webp|png)$/.test(old.slice(prefix.length))) rmSync(join(dir, old));
  }
  const buf = Buffer.from(res.b64, 'base64');
  writeFileSync(join(dir, name), buf);
  bytesTotal += buf.length;
  console.log(`ok   ${entry.id} -> ${folder ? `${folder}/` : ''}.thumbnails/${name} (${buf.length} B, ${Date.now() - t0} ms)`);
}

await browser.close();
console.log(`\n${entries.length - failed.length}/${entries.length} written, ${bytesTotal} bytes total.`);
if (failed.length) {
  console.log('Not rendered:');
  for (const f of failed) console.log(`  ${f.id}: ${f.reason}`);
  process.exitCode = 1;
}
