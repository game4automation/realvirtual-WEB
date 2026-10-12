// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * First visit vs. repeat visits with ONE persistent browser profile (HTTP cache
 * kept between visits) — the "Wiederholungsbesuch" of plan-598.
 *
 *   node scripts/perf/first-frame/repeat.cjs <url> [repeats=2] [label=repeat]
 *
 * Same endpoint and validity rules as the cold run (lib.cjs). The verdict is on
 * the REPEAT visits: each must be valid and free of long tasks > 500 ms, and
 * their median must be ≤ 2.0 s (RV_PERF_REPEAT_TARGET_MS overrides).
 * Exit code: 0 pass, 1 acceptance violation, 2 invalid/aborted visit.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  CHROMIUM_ARGS, VIEWPORT, DEFAULT_REPEAT_TARGET_MS, DEFAULT_MAX_LONGTASK_MS,
  playwright, ensureOutDir, endpointInitScript, waitForEndpoint, readRun, seriesVerdict,
} = require('./lib.cjs');

const [url, repeatsArg = '2', label = 'repeat'] = process.argv.slice(2);
if (!url) {
  console.error('usage: node repeat.cjs <url> [repeats=2] [label]');
  process.exit(64);
}
const TIMEOUT_MS = Number(process.env.RV_PERF_TIMEOUT_MS || 180000);
const TARGET_MS = Number(process.env.RV_PERF_REPEAT_TARGET_MS || DEFAULT_REPEAT_TARGET_MS);
const MAX_LT_MS = Number(process.env.RV_PERF_MAX_LONGTASK_MS || DEFAULT_MAX_LONGTASK_MS);

(async () => {
  const outDir = ensureOutDir();
  const { chromium } = playwright();
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-perf-first-frame-'));
  const visits = ['erstbesuch', ...Array.from({ length: Number(repeatsArg) }, (_, i) => `wiederholung${i + 1}`)];
  const results = [];
  try {
    for (const [index, visit] of visits.entries()) {
      const ctx = await chromium.launchPersistentContext(userDir, { args: CHROMIUM_ARGS, viewport: VIEWPORT });
      const page = ctx.pages()[0] || await ctx.newPage();
      await page.addInitScript(endpointInitScript);
      let run;
      try {
        await page.goto(url, { waitUntil: 'commit' });
        const reached = await waitForEndpoint(page, TIMEOUT_MS);
        run = await readRun(page, { maxLongTaskMs: MAX_LT_MS });
        if (!reached) run = { ...run, valid: false, invalidReason: `ABORTED — no endpoint within ${TIMEOUT_MS} ms` };
      } catch (e) {
        run = { valid: false, invalidReason: `visit failed: ${e.message}` };
      }
      run = { run: index, visit, ...run };
      results.push(run);
      console.log(visit, run.valid ? 'VALID' : `INVALID (${run.invalidReason})`, JSON.stringify({
        endpoint: run.endpointAt, kind: run.endpointKind, modelLoaded: run.modelLoadedAt,
        glbStart: run.glbStart, glbTransferKB: run.glbTransferKB, totalTransferKB: run.totalTransferKB,
        maxLongTask: run.maxLongTask, gpu: run.gpu, build: run.buildHash,
      }));
      await ctx.close();
    }
  } finally {
    fs.rmSync(userDir, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(outDir, `${label}.json`), JSON.stringify(results, null, 1));
  const repeats = results.slice(1).map((r, i) => ({ ...r, run: i + 1 }));
  const verdict = seriesVerdict(repeats, { targetMs: TARGET_MS, maxLongTaskMs: MAX_LT_MS });
  console.log('REPEAT MEDIAN', verdict.median, 'ms (target', TARGET_MS, 'ms)');
  for (const r of verdict.reasons) console.log('  ✗', r);
  console.log(verdict.ok ? 'PASS' : `FAIL (exit ${verdict.exitCode})`);
  process.exit(verdict.exitCode);
})().catch((e) => {
  console.error('[perf:first-frame] repeat crashed:', e);
  process.exit(2);
});
