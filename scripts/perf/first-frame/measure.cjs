// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * ONE cold run: fresh browser, cache disabled, real GPU (`--use-angle=d3d11`).
 * Writes `<label>.json` (+ `<label>.cpuprofile`) into the runs folder.
 *
 *   node scripts/perf/first-frame/measure.cjs <url> <label> [net: none|4g] [cpuRate]
 *
 * Measurement definition: lib.cjs. Exit code 0 = valid run, 2 = invalid/aborted.
 */

const fs = require('fs');
const path = require('path');
const {
  CHROMIUM_ARGS, VIEWPORT, playwright, ensureOutDir, endpointInitScript, waitForEndpoint, readRun,
} = require('./lib.cjs');

const [url, label, net = 'none', cpu = '1'] = process.argv.slice(2);
if (!url || !label) {
  console.error('usage: node measure.cjs <url> <label> [none|4g] [cpuRate]');
  process.exit(64);
}
const TIMEOUT_MS = Number(process.env.RV_PERF_TIMEOUT_MS || 180000);

(async () => {
  const outDir = ensureOutDir();
  const { chromium } = playwright();
  const browser = await chromium.launch({ args: CHROMIUM_ARGS });
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  if (net === '4g') {
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 60, downloadThroughput: 20e6 / 8, uploadThroughput: 5e6 / 8 });
  }
  if (cpu !== '1') await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(cpu) });
  await page.addInitScript(endpointInitScript);

  // `?debug=perf` phase tables arrive as console tables (switched on via localStorage).
  const tables = [];
  page.on('console', async (msg) => {
    try {
      if (msg.type() === 'table' || /perf|loadModel|loadGLB|bake|phase/i.test(msg.text())) {
        const a = [];
        for (const h of msg.args()) a.push(await h.jsonValue().catch(() => null));
        tables.push({ type: msg.type(), text: msg.text().slice(0, 300), args: a });
      }
    } catch { /* page gone */ }
  });

  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await cdp.send('Profiler.start');
  const t0 = Date.now();
  let navError = null;
  try {
    await page.goto(url, { waitUntil: 'commit' });
  } catch (e) {
    navError = String(e && e.message ? e.message : e);
  }
  const reached = navError ? false : await waitForEndpoint(page, TIMEOUT_MS);
  // A short tail for the CPU profile (categorize.cjs looks just past the endpoint).
  if (reached) await page.waitForTimeout(1500);
  const { profile } = await cdp.send('Profiler.stop');

  let run;
  try {
    run = await readRun(page);
  } catch (e) {
    run = { valid: false, invalidReason: `page unreadable: ${e.message}` };
  }
  if (!reached && run.valid !== false) {
    run = { ...run, valid: false, invalidReason: navError ? `navigation failed: ${navError}` : `ABORTED — no endpoint within ${TIMEOUT_MS} ms` };
  }

  fs.writeFileSync(path.join(outDir, `${label}.cpuprofile`), JSON.stringify(profile));
  // CPU self time by script and by function — the coarse "where did the time go".
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const dt = profile.timeDeltas; let i = 0;
  for (const id of profile.samples) self.set(id, (self.get(id) || 0) + (dt[i++] || 0));
  const byUrl = {}; const byFn = {};
  for (const [id, us] of self) {
    const cf = byId.get(id).callFrame;
    const u = (cf.url || '(' + cf.functionName + ')').replace(/^.*\//, '');
    byUrl[u] = (byUrl[u] || 0) + us / 1000;
    const f = (cf.functionName || '(anon)') + ' @' + u + ':' + cf.lineNumber;
    byFn[f] = (byFn[f] || 0) + us / 1000;
  }
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${v.toFixed(0).padStart(6)} ms  ${k}`);
  const out = { tables, label, url, net, cpu, wallMs: Date.now() - t0, ...run, cpuByUrl: top(byUrl, 15), cpuByFn: top(byFn, 30) };
  fs.writeFileSync(path.join(outDir, `${label}.json`), JSON.stringify(out, null, 1));
  console.log(label, run.valid ? 'VALID' : `INVALID (${run.invalidReason})`,
    'endpoint', run.endpointAt, run.endpointKind, 'model-loaded', run.modelLoadedAt,
    'glbStart', run.glbStart, 'maxLongTask', run.maxLongTask, 'gpu', run.gpu, 'build', run.buildHash);
  await browser.close();
  process.exit(run.valid ? 0 : 2);
})().catch((e) => {
  console.error('[perf:first-frame] run crashed:', e);
  process.exit(2);
});
