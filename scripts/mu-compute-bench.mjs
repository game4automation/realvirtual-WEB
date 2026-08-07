// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

// MU compute-transform benchmark (plan-271 Phase 4 SPIKE) — drives the
// dev-only `window.__rvMuComputeBench` hook against a running dev server and
// prints the CPU-vs-compute threshold table. Pattern follows
// scripts/perf-renderer-matrix.mjs. Not part of any test suite; run
// explicitly on a machine with a real GPU:
//
//   npm run dev -- --port 5199 --strictPort   (separate terminal)
//   node scripts/mu-compute-bench.mjs http://localhost:5199
//
// Headed on purpose: headless SwiftShader numbers say nothing about the real
// threshold curve, and the compute path needs a real WebGPU adapter.
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:5199';
const counts = [128, 512, 2000, 10000, 50000];
const frames = 200;

const browser = await chromium.launch({
  headless: false,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'],
});

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (msg) => {
  const text = msg.text();
  if (text.startsWith('[__rvMuComputeBench]') || text.startsWith('[MUInstancePool]')) {
    console.log(`  ${text}`);
  }
});

try {
  await page.goto(`${base}/?renderer=webgpu`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(
    () => window.viewer && window.__rvMuComputeBench,
    null,
    { timeout: 60000, polling: 500 },
  );
  const info = await page.evaluate(() => ({
    kind: window.viewer.rendererKind,
    hasCompute: window.viewer.hasCompute,
  }));
  console.log(`Viewer ready: rendererKind=${info.kind} hasCompute=${info.hasCompute}`);
  if (!info.hasCompute) {
    console.error('No real WebGPU backend — the compute column would be empty. Aborting.');
    process.exitCode = 1;
  } else {
    // Let the initial model settle before measuring.
    await page.waitForTimeout(3000);
    const rows = await page.evaluate(
      ([c, f]) => window.__rvMuComputeBench(c, f),
      [counts, frames],
    );

    console.log('\n=== MU Compute Threshold Curve (plan-271 Phase 4) ===');
    console.log(`frames per mode: ${frames}, renderer: webgpu (real backend)`);
    console.log('| count | CPU ms/frame | CPU update ms | compute ms/frame | compute update ms |');
    console.log('|---|---|---|---|---|');
    for (const r of rows) {
      console.log(`| ${r.count} | ${r.cpuMsPerFrame} | ${r.cpuUpdateMs} | ${r.computeMsPerFrame ?? '-'} | ${r.computeUpdateMs ?? '-'} |`);
    }
    if (errors.length) {
      console.log(`\nPage errors (${errors.length}):`);
      for (const e of errors) console.log(`  ${e}`);
    }
  }
} catch (e) {
  console.error(`FAILED: ${String(e.message).split('\n')[0]}`);
  for (const err of errors) console.error(`  pageerror: ${err}`);
  process.exitCode = 1;
} finally {
  await page.close();
  await browser.close();
}
