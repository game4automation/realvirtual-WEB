// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * quarantine.node.test.ts — plan-602 F9 / § 9.5: the WebGPU quarantine helper
 * (`tests/helpers/quarantine.ts`) in REAL vitest child runs on fixtures
 * (`tests/fixtures/quarantine/`, own config, excluded from every suite).
 *
 * Only the BODY of a quarantined test may fail for its recorded cause:
 *  - known cause in the body → passed, `[quarantine] known failure` in the output, exit 0
 *  - body passes → failed ("now passes"); unknown body error → failed
 *  - runner timeout (even with a cause matching the timeout message) → failed
 *  - failing cleanup (`onTestFinished`), with an unknown OR the known body error → failed
 *  - `beforeEach` / `afterEach` throwing around a known-cause body → failed
 *  - import error in a quarantined fixture file → exit 1
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { splitQuarantineId } from './helpers/quarantine';

const ROOT = resolve(__dirname, '..');
const FIXTURE_CONFIG = resolve(ROOT, 'tests/fixtures/quarantine/vitest.fixture.config.ts');
const VITEST_CLI = join(dirname(createRequire(join(ROOT, 'package.json')).resolve('vitest/package.json')), 'vitest.mjs');
const OUT = mkdtempSync(join(tmpdir(), 'rv-quarantine-fixture-'));

interface ChildRun { code: number | null; output: string; report?: JsonReport }
interface JsonReport {
  testResults: { name: string; status: string; message?: string; assertionResults: { fullName: string; title: string; status: string; failureMessages: string[] }[] }[];
}

/** One vitest child run on the fixture config; environment cleaned of the parent's vitest state. */
function runFixture(args: string[], extraEnv: Record<string, string> = {}, json = false): Promise<ChildRun> {
  const env: Record<string, string | undefined> = { ...process.env, RV_TEST_LOCK: 'off', ...extraEnv };
  for (const key of Object.keys(env)) if (key.startsWith('VITEST')) delete env[key];
  const outFile = join(OUT, `report-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const reporters = json ? ['--reporter=default', '--reporter=json', `--outputFile.json=${outFile}`] : [];
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [VITEST_CLI, 'run', '--config', FIXTURE_CONFIG, ...reporters, ...args], {
      cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.on('error', fail);
    child.on('close', (code) => {
      const report = json && existsSync(outFile) ? (JSON.parse(readFileSync(outFile, 'utf8')) as JsonReport) : undefined;
      done({ code, output, report });
    });
  });
}

function statuses(report: JsonReport | undefined): Map<string, { status: string; failure: string }> {
  const out = new Map<string, { status: string; failure: string }>();
  for (const file of report?.testResults ?? []) {
    for (const t of file.assertionResults) out.set(t.fullName, { status: t.status, failure: t.failureMessages.join('\n') });
  }
  return out;
}

afterAll(() => rmSync(OUT, { recursive: true, force: true }));

describe('quarantinedIt in real vitest child runs (plan-602 § 9.5)', () => {
  it('only the body is quarantined: known cause passes, everything else stays red', async () => {
    const run = await runFixture([], {}, true);
    expect(run.code, run.output).toBe(1);
    const s = statuses(run.report);
    const expectStatus = (name: string, status: string, failure?: RegExp): void => {
      const got = s.get(name);
      expect(got?.status, `${name}\n${run.output}`).toBe(status);
      if (failure) expect(got!.failure, name).toMatch(failure);
    };
    expectStatus('quarantine fixture known cause in the body', 'passed');
    expectStatus('quarantine fixture body passes', 'failed', /quarantined test now passes/);
    expectStatus('quarantine fixture unknown error in the body', 'failed', /something else broke/);
    // The JSON failure of a timeout carries the runner's stack only; the message is in the output.
    expectStatus('quarantine fixture runner timeout', 'failed');
    expect(run.output).toMatch(/Test timed out in 200ms/);
    expectStatus('quarantine fixture unknown body error plus failing cleanup', 'failed');
    expectStatus('quarantine fixture known cause plus failing cleanup', 'failed', /cleanup failed/);
    expectStatus('beforeEach throws known cause in the body', 'failed', /beforeEach failed/);
    expectStatus('afterEach throws known cause in the body', 'failed', /afterEach failed/);
    expect(s.size, 'every fixture test reported').toBe(8);
    expect(run.output).toMatch(/\[quarantine\] known failure tests\/fixtures\/quarantine\/known-cause\.test\.ts :: quarantine fixture > known cause in the body/);
  }, 120_000);

  it('a run with only the known-cause test exits 0', async () => {
    const run = await runFixture(['known-cause', '-t', 'known cause in the body$']);
    expect(run.code, run.output).toBe(0);
    expect(run.output).toContain('[quarantine] known failure');
  }, 120_000);

  it('an import error in a quarantined fixture file exits 1', async () => {
    const run = await runFixture(['known-cause', '-t', 'known cause in the body$'], { RV_QFIX_IMPORT_ERROR: '1' });
    expect(run.code, run.output).toBe(1);
    expect(run.output).toMatch(/does-not-exist/);
  }, 120_000);
});

describe('splitQuarantineId', () => {
  it('splits file, test name and title', () => {
    expect(splitQuarantineId('tests/a.test.ts :: outer > inner > does x')).toEqual({
      file: 'tests/a.test.ts', name: 'outer > inner > does x', title: 'does x',
    });
  });
  it('refuses an id without a file part', () => {
    expect(() => splitQuarantineId('outer > does x')).toThrow(/malformed id/);
  });
});
