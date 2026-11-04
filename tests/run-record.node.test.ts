// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const reporter = await import(pathToFileURL(path.join(root, 'scripts/test-progress-reporter.mjs')).href);
const temporary: string[] = [];
function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-run-record-'));
  temporary.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const moduleResult = (name: string, state: string, collectDuration: number, duration: number, errors: object[] = []) => ({
  moduleId: path.join(root, name), state: () => state, errors: () => errors,
  diagnostic: () => ({ collectDuration, duration, importDurations: { deliberatelyWrong: 900000 } }),
});
const context = {
  runId: 1, startedAt: 1000, endedAt: 4500, root,
  commitWeb: '123456789abcdef', commitPrivate: null, dirtyWeb: false, dirtyPrivate: null,
  host: 'fixture', cores: 8, maxWorkers: 2, argv: ['run'], filtered: false, complete: true,
};
function fixture(directory: string) {
  const env: Record<string, string | undefined> = { ...process.env, RV_TEST_RUN_RECORD_DIR: directory, RV_TEST_LOCK: 'off' };
  delete env.RV_TEST_LOCK_PROGRESS_FILE;
  delete env.RV_TEST_WRAPPER_SPAWN_MS;
  delete env.RV_TEST_STRICT_DEPS;
  delete env.VITEST_MAX_WORKERS;
  delete env.RV_TEST_LOCK_CLASS;
  return spawnSync(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run',
    '--config', 'tests/fixtures/test-lock/vitest.failing.config.mjs', '--reporter=json',
    'failing.fixture', 'import-error.fixture', 'before-all-error.fixture'],
  { cwd: root, encoding: 'utf8', env, timeout: 60000 });
}

describe('SuiteRunRecord', () => {
  it('projects full final results, including import/hook errors beyond the live limit', () => {
    const modules = [moduleResult('ok.ts', 'passed', 100, 200),
      moduleResult('failed.ts', 'failed', 200, 300),
      moduleResult('import.ts', 'failed', 300, 0, [{}]),
      moduleResult('hook.ts', 'failed', 400, 500, [{}]),
      ...Array.from({ length: 51 }, (_, i) => moduleResult(`red-${i}.ts`, 'failed', 0, 0))];
    const record = reporter.buildRunRecord(modules, context);
    expect(record).toEqual({
      runId: 1, commitWeb: context.commitWeb, commitPrivate: null, dirtyWeb: false, dirtyPrivate: null,
      host: 'fixture', cores: 8, maxWorkers: '2', argv: ['run'], filtered: false, complete: true,
      testFiles: 55, skippedTests: 0, durationS: 3.5, importS: 1, testsS: 1,
      redFiles: ['failed.ts', 'import.ts', 'hook.ts', ...Array.from({ length: 51 }, (_, i) => `red-${i}.ts`)],
    });
  });

  it('writes final JSON from a real reporter while stdout stays JSON', () => {
    const dir = temp();
    const result = fixture(dir);
    expect(result.status, result.stderr).toBe(1);
    JSON.parse(result.stdout);
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{8}T\d{6}Z-[a-z0-9]+-\d+-1\.json$/);
    const record = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    expect(record).toMatchObject({ runId: 1, complete: true, filtered: true, testFiles: 3, maxWorkers: '2' });
    expect(typeof record.skippedTests).toBe('number');
    expect(Array.isArray(record.redFiles)).toBe(true);
    expect(record.redFiles.sort()).toEqual(['before-all-error.fixture.test.mjs', 'failing.fixture.test.mjs', 'import-error.fixture.test.mjs']);
    for (const key of ['commitWeb', 'commitPrivate', 'dirtyWeb', 'dirtyPrivate', 'host', 'cores', 'argv', 'durationS', 'importS', 'testsS']) {
      expect(record).toHaveProperty(key);
    }
  }, 65000);

  it('keeps separate times and filenames for two runs in the same second and PID', async () => {
    const dir = temp();
    const previous = process.env.RV_TEST_RUN_RECORD_DIR;
    process.env.RV_TEST_RUN_RECORD_DIR = dir;
    try {
      let now = 1000;
      const state = {};
      const instance = new reporter.TestLockProgressReporter(state, { now: () => now, write: () => {}, log: () => {} });
      instance.onTestRunStart();
      now = 1100;
      await instance.onTestRunEnd([]);
      now = 1200;
      instance.onTestRunStart();
      now = 1500;
      await instance.onTestRunEnd([]);
      const records = fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).sort((a, b) => a.runId - b.runId);
      expect(records.map((r) => [r.runId, r.durationS, r.filtered])).toEqual([[1, 0.1, false], [2, 0.3, true]]);
      expect(state).toMatchObject({ runStartAt: 1000, runStart: true, runEnd: true });
    } finally {
      if (previous === undefined) delete process.env.RV_TEST_RUN_RECORD_DIR;
      else process.env.RV_TEST_RUN_RECORD_DIR = previous;
    }
  });

  it('swallows write errors: same exit code, JSON stdout, one stderr warning', () => {
    const file = path.join(temp(), 'not-a-directory');
    fs.writeFileSync(file, 'blocked');
    const result = fixture(file);
    expect(result.status, result.stderr).toBe(1);
    JSON.parse(result.stdout);
    expect(result.stdout).not.toContain('[test-run-record]');
    expect(result.stderr.match(/\[test-run-record\] warning:/g)).toHaveLength(1);
  }, 65000);
});
