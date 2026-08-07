// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

// F8 renderer parity matrix (plan-271) — drives the ?perf harness once per
// renderer kind against a running dev server and prints a comparison table.
// Not part of any test suite; run explicitly on a machine with a real GPU:
//
//   npm run dev -- --port 5199 --strictPort   (separate terminal)
//   node scripts/perf-renderer-matrix.mjs http://localhost:5199
//
// Headed on purpose: headless SwiftShader numbers say nothing about real
// GPU parity, and the `webgpu` row needs a real adapter.
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:5199';
const kinds = ['webgl', 'webgpu-gl', 'webgpu'];
const rows = [];

const browser = await chromium.launch({
  headless: false,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'],
});

for (const kind of kinds) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${base}/?perf&renderer=${kind}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const handle = await page.waitForFunction(() => window.__PERF_RESULTS__, null, {
      timeout: 150000, polling: 1000,
    });
    const perf = await handle.jsonValue();
    const actual = await page.evaluate(() => {
      const v = window.viewer;
      return v ? `${v.rendererKind ?? '?'}${v.hasCompute ? '+compute' : ''}` : '?';
    });
    rows.push({ kind, actual, perf, errors });
    console.log(`OK ${kind} -> actual=${actual} model=${perf.model} fpsAvg=${perf.fps.avg} uncapped=${perf.benchmark.uncappedFps}`);
  } catch (e) {
    rows.push({ kind, actual: 'FAILED', perf: null, errors: [String(e.message).split('\n')[0], ...errors] });
    console.log(`FAIL ${kind}: ${String(e.message).split('\n')[0]}`);
  } finally {
    await page.close();
  }
}
await browser.close();

console.log('\n=== F8 Renderer Parity Matrix ===');
console.log('| requested | actual | fps min/avg/max | frame avg ms | uncapped fps | draws | tris | errors |');
console.log('|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  if (r.perf) {
    const p = r.perf;
    console.log(`| ${r.kind} | ${r.actual} | ${p.fps.min}/${p.fps.avg}/${p.fps.max} | ${p.frameTime.avg} | ${p.benchmark.uncappedFps} | ${p.renderer.drawCalls} | ${p.renderer.triangles} | ${r.errors.length} |`);
  } else {
    console.log(`| ${r.kind} | FAILED | - | - | - | - | - | ${r.errors.join(' / ')} |`);
  }
}
