// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * test-bundle-guard.mjs — `npm run test:bundle-guard` (plan-652 §9.12).
 *
 * Builds the GENERATED demo entry (the staging of `bunny-deploy --demo`, via
 * `analyze-demo-entry.mjs`, never into `dist/`) and reports what the entry chunk
 * still carries of the on-demand features. Not part of `test:all` — a build takes minutes.
 *
 * ## A SIZE BUDGET, since plan-779 (25.10.2026)
 *
 * This script used to print the entry chunk's size and exit `[bundle-guard] OK` — `entryBytes`
 * occurred exactly once in the file, inside a `console.log`. On 25.10.2026 it printed
 * `entry: assets/index-Cydx2APj.js 5045 KB`, 300 kB over what the dist entry was allowed, and
 * went green; it would have been green at 10 MB. A printed violation under a green tick is worse
 * than no guard at all, because it looks like a check. The number is now compared against the
 * `demo-entry-chunk` pin in `tests/bundle-budgets.json` — in BOTH modes, see below.
 *
 * Note which artifact this is: the GENERATED DEMO entry, not `dist/`. It is a different, larger
 * number than the `entry-chunk` pin that `tests/bundle-splitting.test.ts` defends (filtered demo
 * tree, demo env, different flags). The two pins must never be copied into each other.
 *
 * Modes:
 *   --mode enforce (default since Phase 4) — fails on any Editor / DES body in the entry.
 *   --mode report  (Phase 1–3)            — prints the Editor / DES bytes in the entry and the
 *                  feature chunk table; fails only when the build or its table is missing.
 * The mode gates the MARKER buckets only. The size budget is NOT phase-gated and fails in both
 * modes: a mode in which a size violation can still exit 0 is the defect this paragraph exists
 * to prevent.
 *
 * The boot-set rules (no editor body, no DES, no feature body loaded at startup) hold in
 * BOTH modes. Tolerated at boot: `asset-editor/shared/**` - the leaf stores public startup
 * code imports on purpose (plan-652 section 2.4.5) - up to BOOT_TOLERANCE_BYTES, and the two
 * editor modules startup adapters import, up to BOOT_EDITOR_ADAPTER_BYTES.
 *
 * A missing build is an error, never a skip.
 *
 * `--public-only` (plan-680): analyses the COMMUNITY build (core staged alone, no private
 * sibling) instead of the demo build. DES is core code since plan-680, so BOTH builds must
 * carry a `des` feature chunk and neither may carry the DES body in the entry or boot set;
 * the DES workspace shell (`plugins/des/des-workspace-plugin.tsx`, imported by main.ts) is
 * allowed. The size budget is the demo build's pin — the community entry has no pin of its
 * own, its size is printed only.
 *
 * Phase 1 scope (2026-10-21): the generated demo build. The checked-in build and the profile
 * matrix (restricted profile, projectless/CONNECT smoke) are follow-ups of this script.
 */

import { createRequire } from 'node:module';
import { analyzeDemoEntry } from './analyze-demo-entry.mjs';

const require = createRequire(import.meta.url);
/** The pin records every absolute bundle budget in this repo is named in (plan-779). */
const BUDGETS = require('../tests/bundle-budgets.json');
const DEMO_ENTRY_PIN = BUDGETS.pins['demo-entry-chunk'];

const ENFORCED_BUCKETS = [
  'asset-editor (private plugins/asset-editor/**)',
  'roller-textures (editor material presets, inline PNG)',
  'des body (plugins/des/** without the workspace shell)',
  'features/*.body (on-demand feature bodies)',
];

/**
 * Markers that must be absent from the BOOT SET (entry + startup adapter chunks + their
 * static imports) once a feature is on demand - enforced per phase, in every mode:
 * Phase 2 made the Editor lazy, Phase 3 adds DES.
 */
const BOOT_ENFORCED = [
  'asset-editor (private plugins/asset-editor/**)',
  'roller-textures (editor material presets, inline PNG)',
  'features/*.body (on-demand feature bodies)',
  'des body (plugins/des/** without the workspace shell)',
  'asset-editor/shared (editor leaf stores, startup)',
];
/** Editor leaf modules startup code imports on purpose (plan-652 section 2.4.5) - tolerated in the boot set. */
const BOOT_TOLERANCE_BYTES = 64 * 1024;
/**
 * Editor modules OUTSIDE shared/ that two startup adapters import on purpose (plan-652 section
 * 2.4.5, checked by feature-manifest-consistency): step-import -> editor-dialog-store,
 * kinematic-mechanism -> mechanism/mechanism-force-gizmo (FORCE_RAMP). Measured 7 KB in the
 * Phase 4 demo build (2026-10-22); anything beyond 16 KB means the editor body is leaking.
 */
const BOOT_EDITOR_ADAPTER_BYTES = 16 * 1024;

function parseMode(argv) {
  const i = argv.indexOf('--mode');
  const mode = i >= 0 ? argv[i + 1] : 'enforce';
  if (mode !== 'report' && mode !== 'enforce') throw new Error(`--mode must be report or enforce, got ${mode}`);
  return mode;
}

function main() {
  const mode = parseMode(process.argv.slice(2));
  const publicOnly = process.argv.includes('--public-only');
  const report = analyzeDemoEntry({ keep: false, top: 15, json: null, out: null, publicOnly });
  const failures = [];
  if (!report || !report.entry) failures.push('no entry chunk was built');
  if (!report.featureChunks) failures.push('dist/feature-chunks.json is missing (rvFeatureChunksPlugin not active?)');
  if (report.generatedEntry.staticAdapterImports > 0) {
    failures.push(`generated private-plugins.ts still has ${report.generatedEntry.staticAdapterImports} static adapter imports`);
  }

  console.log('\n=== bundle guard (plan-652) ===');
  console.log(`mode: ${mode}${publicOnly ? ' (public-only community build)' : ''}`);
  // NOTE the unit: this is the attribution total (UTF-16 code units), kept because the whole
  // composition table below is computed from it. The number the BUDGET is named in is printed
  // right underneath, in bytes. Two numbers for one chunk, each labelled — never one unlabelled
  // number that looks like the budgeted one.
  console.log(`entry: ${report.entry} ${(report.entryBytes / 1024).toFixed(0)} KB (attribution total, UTF-16 code units)`);

  // --- the size budget (plan-779) ---------------------------------------------------
  // Two independently measured byte counts of the same chunk: the filesystem's, and the
  // one from re-encoding the text the analysis read. They must agree; if they do not, the
  // measurement path is broken and NO verdict about the size may be issued (the oracle
  // must not compute the way the subject does — that is how a UTF-16 count passed for
  // bytes until 2026-08-08).
  const onDisk = report.entryFileBytes;
  const reEncoded = report.entryEncodedBytes;
  if (typeof onDisk !== 'number' || typeof reEncoded !== 'number') {
    failures.push('the analysis reported no entry byte size (analyze-demo-entry too old?)');
  } else if (onDisk !== reEncoded) {
    failures.push(`entry size measured two ways and they disagree: ${onDisk} on disk vs ${reEncoded} re-encoded`
      + ' — measurement broken, no size verdict');
  } else if (publicOnly) {
    console.log(`entry size: ${onDisk} B (community build — no pin of its own, printed only)`);
  } else {
    const over = onDisk - DEMO_ENTRY_PIN.budgetBytes;
    console.log(`entry size: ${onDisk} B against budget ${DEMO_ENTRY_PIN.budgetBytes} B `
      + `(${over >= 0 ? '+' : ''}${over} B, pinned ${DEMO_ENTRY_PIN.measuredBytes} B at ${DEMO_ENTRY_PIN.measuredAt.commit})`);
    if (over >= 0) {
      failures.push(`the demo entry chunk is ${over} B OVER its budget (${onDisk} >= ${DEMO_ENTRY_PIN.budgetBytes}).`
        + ' Either move the growth behind import(), or re-pin `demo-entry-chunk` in'
        + ' tests/bundle-budgets.json from a build of the MERGE TARGET, naming the commit.');
    }
  }
  console.log(`*.register chunks: ${report.registerChunks.length}`);
  console.log(`generated entry: ${report.generatedEntry.dynamicAdapterImports} dynamic / ${report.generatedEntry.staticAdapterImports} static adapter imports`);
  for (const bucket of ENFORCED_BUCKETS) {
    const bytes = report.buckets[bucket] ?? 0;
    console.log(`entry marker ${bucket}: ${(bytes / 1024).toFixed(0)} KB`);
    if (mode === 'enforce' && bytes > 0) failures.push(`${bucket} is still in the entry (${bytes} bytes)`);
  }
  if (report.boot) {
    console.log(`boot set: ${report.boot.chunks} chunks, ${(report.boot.bytes / 1024).toFixed(0)} KB`);
    for (const bucket of BOOT_ENFORCED) {
      const bytes = report.boot.buckets[bucket] ?? 0;
      console.log(`boot marker ${bucket}: ${(bytes / 1024).toFixed(0)} KB`);
      const limit = bucket.startsWith('asset-editor/shared')
        ? BOOT_TOLERANCE_BYTES
        : bucket.startsWith('asset-editor') ? BOOT_EDITOR_ADAPTER_BYTES : 0;
      if (BOOT_ENFORCED.includes(bucket) && bytes > limit) failures.push(`${bucket} is loaded at boot (${bytes} bytes > ${limit})`);
    }
  } else {
    failures.push('the analysis returned no boot set');
  }
  if (report.featureChunks) {
    for (const id of ['asset-editor', 'des']) {
      const row = report.featureChunks[id];
      console.log(`feature-chunks ${id}: ${row ? `${row.files.length} files, ${(row.bytes / 1024).toFixed(0)} KB` : 'absent'}`);
    }
    // plan-680: DES is core — every build must ship its lazy body chunk.
    if (!report.featureChunks.des) failures.push('no des feature chunk — DES is core since plan-680 and must ship lazily in every build');
  }
  if (failures.length) {
    for (const f of failures) console.error(`[bundle-guard] FAIL: ${f}`);
    process.exit(1);
  }
  console.log('[bundle-guard] OK');
}

try {
  main();
} catch (error) {
  console.error(`[bundle-guard] ${error?.message ?? error}`);
  process.exit(1);
}
