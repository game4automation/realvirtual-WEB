// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * test-inventory-diff.node.test.ts — the self-test of the safety net (plan-375
 * phase 0a).
 *
 * `scripts/test-inventory-diff.mjs` is what proves that plan-375's test-body
 * rewrites did not remove or mute a single test. An unverified safety net is
 * worse than none, because it is trusted. This test therefore drives the script
 * as a real child process over synthetic vitest reports and checks the exit code
 * — the thing CI and the plan gate actually read.
 *
 * Three cases, one per failure class plus the negative:
 *   a) a removed test           -> LOST,     exit 1
 *   b) `passed` -> `skipped`    -> SILENCED, exit 1   (the it -> it.skip slip)
 *   c) an unchanged report      -> silent,   exit 0
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(here, '../scripts/test-inventory-diff.mjs');

type Assertion = { title: string; fullName: string; status: string };

/** Minimal but structurally faithful vitest `--reporter=json` report. */
function makeReport(files: Record<string, Assertion[]>) {
  return {
    numTotalTestSuites: Object.keys(files).length,
    startTime: 1_700_000_000_000,
    success: true,
    testResults: Object.entries(files).map(([name, assertionResults]) => ({
      name: `C:/ws/Assets/realvirtual-WebViewer~/${name}`,
      status: 'passed',
      startTime: 1_700_000_000_000,
      endTime: 1_700_000_001_000,
      assertionResults,
    })),
  };
}

function assertion(fullName: string, status: string): Assertion {
  const title = fullName.split(' > ').pop() ?? fullName;
  return { title, fullName, status };
}

const BASE = () =>
  makeReport({
    'tests/embed-rehydrate.test.ts': [
      assertion('embed rehydrate > restores the context', 'passed'),
      assertion('embed rehydrate > keeps the first frame fast', 'passed'),
      assertion('embed rehydrate > AP3 vignette stays stable', 'passed'),
    ],
    'tests/model-switch-cleanup.test.ts': [
      assertion('model switch > releases the previous scene', 'passed'),
      assertion('model switch > needs a re-exported tests.glb', 'skipped'),
    ],
  });

let dir: string;

function reportPath(name: string, report: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(report), 'utf8');
  return path;
}

function runDiff(beforePath: string, afterPath: string) {
  return spawnSync(process.execPath, [SCRIPT, beforePath, afterPath], { encoding: 'utf8' });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'rv-inventory-diff-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('test-inventory-diff safety net', () => {
  it('reports a removed test as LOST and exits 1', () => {
    const before = reportPath('lost-before.json', BASE());

    const shrunk = BASE();
    shrunk.testResults[0].assertionResults.splice(2, 1); // drop the AP3 vignette test
    const after = reportPath('lost-after.json', shrunk);

    const result = runDiff(before, after);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('LOST:');
    expect(result.stderr).toContain('AP3 vignette stays stable');
    expect(result.stdout).toContain('lost=1');
  });

  it('reports a passed -> skipped test as SILENCED and exits 1', () => {
    const before = reportPath('silenced-before.json', BASE());

    const muted = BASE();
    // The exact slip the plan is afraid of: `it(...)` becomes `it.skip(...)`.
    // The entry survives with an identical title, only the status changes — a
    // pure membership diff would see nothing at all here.
    muted.testResults[0].assertionResults[1].status = 'skipped';
    const after = reportPath('silenced-after.json', muted);

    const result = runDiff(before, after);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('SILENCED:');
    expect(result.stderr).toContain('keeps the first frame fast');
    expect(result.stderr).toContain('passed -> skipped');
    expect(result.stdout).toContain('silenced=1');
  });

  it('stays silent and exits 0 for an unchanged report', () => {
    const before = reportPath('same-before.json', BASE());
    const after = reportPath('same-after.json', BASE());

    const result = runDiff(before, after);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('LOST:');
    expect(result.stderr).not.toContain('SILENCED:');
    expect(result.stdout).toContain('lost=0 silenced=0');
  });

  it('does not fail on an added test, and does not fail on an already-skipped one', () => {
    const before = reportPath('added-before.json', BASE());

    const grown = BASE();
    grown.testResults[1].assertionResults.push(
      assertion('model switch > brand new coverage', 'passed'),
    );
    const after = reportPath('added-after.json', grown);

    const result = runDiff(before, after);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('added=1');
  });

  it('exits 2 on a report that is not a vitest json report', () => {
    const before = reportPath('bad-before.json', BASE());
    const after = join(dir, 'bad-after.json');
    writeFileSync(after, JSON.stringify({ nope: true }), 'utf8');

    const result = runDiff(before, after);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('testResults');
  });
});
