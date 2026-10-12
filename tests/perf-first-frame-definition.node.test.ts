// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-598 Phase 0 — the measurement definition of `npm run perf:first-frame`
 * is binding, so it is pinned: content check, long-task window, per-run
 * acceptance, and "an invalid run fails the series (exit ≠ 0), never filtered".
 */

import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const lib = require('../scripts/perf/first-frame/lib.cjs') as {
  judgeRun: (r: Record<string, unknown>, maxLt?: number) => Record<string, unknown> & { valid: boolean; maxLongTask: number; invalidReason: string | null };
  seriesVerdict: (runs: Array<Record<string, unknown>>, o?: { targetMs?: number; maxLongTaskMs?: number }) => { ok: boolean; exitCode: number; reasons: string[]; median: number | null };
  REPO_ROOT: string;
};

const raw = (over: Record<string, unknown> = {}) => ({
  endpoint: { at: 2500, kind: 'fade-out', renderCalls: 120, hasModel: true },
  longtasks: [[100, 300], [2400, 450], [2600, 900]], // the last one starts AFTER the endpoint
  ...over,
});

describe('judgeRun — one definition for cold and repeat runs', () => {
  it('long tasks count from navigation to the endpoint only', () => {
    const r = lib.judgeRun(raw());
    expect(r.valid).toBe(true);
    expect(r.maxLongTask).toBe(450);
    expect(r.longTaskSum).toBe(750);
    expect(r.endpointAt).toBe(2500);
    expect(r.overlayHiddenAt).toBe(2500);
  });

  it('no draw calls at the endpoint → invalid', () => {
    const r = lib.judgeRun(raw({ endpoint: { at: 2500, kind: 'hidden', renderCalls: 0, hasModel: true } }));
    expect(r.valid).toBe(false);
    expect(r.invalidReason).toMatch(/draw calls/);
  });

  it('no model at the endpoint (overlay hid on an error) → invalid', () => {
    const r = lib.judgeRun(raw({ endpoint: { at: 900, kind: 'hidden', renderCalls: 3, hasModel: false } }));
    expect(r.valid).toBe(false);
    expect(r.invalidReason).toMatch(/currentModel/);
  });

  it('no endpoint at all → invalid', () => {
    expect(lib.judgeRun(raw({ endpoint: null })).valid).toBe(false);
  });
});

describe('seriesVerdict — exit code ≠ 0 on every violation', () => {
  const ok = (run: number, endpointAt: number, maxLongTask = 200) => ({ run, valid: true, endpointAt, maxLongTask });
  it('passes when every run is valid, under the long-task limit and the median meets the target', () => {
    const v = lib.seriesVerdict([ok(1, 2500), ok(2, 2900), ok(3, 2700)]);
    expect(v).toMatchObject({ ok: true, exitCode: 0, median: 2700 });
  });

  it('one long task > 500 ms in ANY valid run fails (exit 1) — the median does not save it', () => {
    const v = lib.seriesVerdict([ok(1, 2000), ok(2, 2000, 760), ok(3, 2000)]);
    expect(v.exitCode).toBe(1);
    expect(v.reasons.join()).toMatch(/run 2: long task 760/);
  });

  it('a median over the target fails (exit 1)', () => {
    expect(lib.seriesVerdict([ok(1, 4400), ok(2, 4300), ok(3, 4500)]).exitCode).toBe(1);
  });

  it('an invalid or aborted run fails the series (exit 2) and is not filtered out', () => {
    const v = lib.seriesVerdict([ok(1, 2000), { run: 2, valid: false, invalidReason: 'ABORTED' }, ok(3, 2000)]);
    expect(v.exitCode).toBe(2);
    expect(v.reasons.join()).toMatch(/run 2: INVALID/);
  });
});

describe('the scripts carry no checkout path and use the localStorage perf switch', () => {
  it('no absolute drive paths, no ?debug= URL switch', () => {
    for (const f of ['lib.cjs', 'measure.cjs', 'repeat.cjs', 'series.cjs', 'keydiff.cjs', 'programs.cjs', 'composition.cjs']) {
      const src = readFileSync(resolve('scripts/perf/first-frame', f), 'utf8');
      expect(src, f).not.toMatch(/[A-Z]:[\\/]/);
      // Code only — the comments explain WHY `?debug=` must not be used.
      const code = src.split('\n').filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join('\n');
      expect(code, f).not.toMatch(/[?&]debug=/);
      expect(src.startsWith('#!'), f).toBe(false);
    }
    // Real paths: under %TEMP% (the community precheck) one side can be the 8.3 short
    // form (C:\Users\THOMAS~1) and the other the long form of the same directory.
    expect(realpathSync.native(lib.REPO_ROOT)).toBe(realpathSync.native(resolve('.')));
  });

  it('package.json exposes npm run perf:first-frame and the runs folder is ignored', () => {
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['perf:first-frame']).toBe('node scripts/perf/first-frame/series.cjs');
    expect(readFileSync(resolve('scripts/perf/first-frame/.gitignore'), 'utf8')).toMatch(/^runs\/$/m);
  });
});
