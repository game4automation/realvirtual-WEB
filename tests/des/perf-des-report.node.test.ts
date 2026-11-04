// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error Node tooling intentionally remains dependency-free JavaScript.
import { buildReport, summarise, METRICS, machineMetadata, parseOptions, yardVariants, compareScriptScenarios } from '../../scripts/perf-des.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const git = (cwd: string, ...args: string[]) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
const gitAvailable = !spawnSync('git', ['--version'], { windowsHide: true }).error;

const machine = { hostname: 'fixture', os: 'TestOS', cpuModel: 'Test CPU', cpuCount: 8,
  totalMemoryBytes: 16 * 1024 ** 3, nodeVersion: 'v22.18.0', webViewerCommit: 'abc123', privateCommit: null };
const fakeRun = (wallMs = 100) => ({
  scenario: 'yard:1', kind: 'fastforward', size: 1, requestedSimSeconds: 600,
  metrics: { ...Object.fromEntries(METRICS.map((key: string) => [key, 1])), wallMs },
  sources: { heapPeakBytes: 'fixture heap', vehicles: 'fixture scene', stations: 'fixture scene' },
});

describe('DES performance report (no real measurements)', () => {
  it('computes median and extrema without mutating the inputs', () => {
    const values = [9, 1, 5];
    expect(summarise(values)).toEqual({ median: 5, min: 1, max: 9 });
    expect(values).toEqual([9, 1, 5]);
    expect(summarise([8, 2])).toEqual({ median: 5, min: 2, max: 8 });
    expect(summarise([4])).toEqual({ median: 4, min: 4, max: 4 });
    for (const bad of [[], [NaN], [Infinity]]) expect(() => summarise(bad)).toThrow();
  });
  it('retains raw runs, metadata, provenance and finite per-metric aggregates', () => {
    const runs = [fakeRun(300), fakeRun(100), fakeRun(200)];
    const report = buildReport(machine, runs, { createdAt: '2026-10-31T12:00:00.000Z', smoke: true });
    expect(report).toMatchObject({ schemaVersion: 1, status: 'ok', smoke: true, machine, failures: [] });
    expect(report.scenarios).toHaveLength(1);
    expect(report.scenarios[0]).toMatchObject({ scenario: 'yard:1', repeats: 3, requestedSimSeconds: 600, runs });
    expect(report.scenarios[0].metrics.wallMs).toEqual({ median: 200, min: 100, max: 300, samples: 3 });
    const walk = (value: unknown): void => {
      if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
      else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(report);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
  it('separates scenarios, reports unavailable GC by sample count, and preserves failures', () => {
    const yard = fakeRun();
    const withGc = { ...fakeRun(), metrics: { ...fakeRun().metrics, heapAfterGcBytes: 1234 } };
    const warehouse = { ...fakeRun(), scenario: 'warehouse-synthetic', kind: 'snapshot-only', size: 0, requestedSimSeconds: 0 };
    const report = buildReport(machine, [yard, withGc, warehouse], { failures: [{ error: 'child failed' }] });
    expect(report.status).toBe('failed');
    expect(report.scenarios).toHaveLength(2);
    expect(report.scenarios[0].metrics.heapAfterGcBytes.samples).toBe(1);
    expect(report.scenarios[1].metrics.heapAfterGcBytes).toBeUndefined();
  });
  it('preserves unsupported AGV restore while aggregating finite snapshot measurements', () => {
    const metrics: Record<string, number> = { ...fakeRun().metrics };
    delete metrics.restoreMs;
    const restore = { supported: false, reason: 'agv-snapshot-restore-unsupported (plan-558)' };
    const yard = { ...fakeRun(), metrics, restore };
    const warehouse = { ...fakeRun(), scenario: 'warehouse-synthetic', kind: 'snapshot-only', size: 0, requestedSimSeconds: 0 };
    const report = buildReport(machine, [yard, yard, warehouse]);
    expect(report.status).toBe('ok');
    expect(report.scenarios[0].restore).toEqual(restore);
    expect(report.scenarios[0].runs[0].restore).toEqual(restore);
    expect(report.scenarios[0].metrics.restoreMs).toBeUndefined();
    for (const key of ['snapshotMs', 'snapshotBytes']) {
      expect(report.scenarios[0].metrics[key]).toEqual({ median: 1, min: 1, max: 1, samples: 2 });
    }
    expect(report.scenarios[1].metrics.restoreMs).toEqual({ median: 1, min: 1, max: 1, samples: 1 });
    const walk = (value: unknown): void => {
      if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
      else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(report);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expect(() => buildReport(machine, [{ ...yard, restore: undefined }])).toThrow('restoreMs');
    expect(() => buildReport(machine, [{ ...yard, restore: { supported: false, reason: 'unexpected' } }])).toThrow('Invalid restore status');
    expect(() => buildReport(machine, [{ ...fakeRun(), restore }])).toThrow('must not have a duration');
    expect(() => buildReport(machine, [yard, fakeRun()])).toThrow('Inconsistent restore support');
  });
  it('rejects invalid or inconsistent inputs', () => {
    expect(() => buildReport({ ...machine, cpuCount: NaN }, [fakeRun()])).toThrow();
    expect(() => buildReport({ ...machine, hostname: '' }, [fakeRun()])).toThrow();
    expect(() => buildReport(machine, [{ ...fakeRun(), metrics: {} }])).toThrow();
    expect(() => buildReport(machine, [{ ...fakeRun(), metrics: { ...fakeRun().metrics, wallMs: Infinity } }])).toThrow();
    expect(() => buildReport(machine, [fakeRun(), { ...fakeRun(), requestedSimSeconds: 700 }])).toThrow();
  });
  it('collects actual machine metadata without running a measurement', () => {
    const actual = machineMetadata();
    expect(actual.hostname).toBeTruthy(); expect(actual.os).toBeTruthy(); expect(actual.cpuModel).toBeTruthy();
    expect(actual.cpuCount).toBeGreaterThan(0); expect(actual.totalMemoryBytes).toBeGreaterThan(0);
    expect(actual.nodeVersion).toBe(process.version);
    const workTree = git(ROOT, 'rev-parse', '--is-inside-work-tree');
    if (!workTree.error && workTree.status === 0 && workTree.stdout.trim() === 'true') {
      expect(actual.webViewerCommit).toMatch(/^[a-f0-9]{40}$/);
    } else {
      expect(actual.webViewerCommit).toBeNull();
    }
    expect(actual.privateCommit === null || /^[a-f0-9]{40}$/.test(actual.privateCommit)).toBe(true);
  });
  it('collects metadata and builds a report outside a git repository', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'perf-des-no-git-'));
    try {
      // Verify the temp directory does not inherit a repository from its ancestors.
      expect(git(dir, 'rev-parse', '--is-inside-work-tree').status).not.toBe(0);
      const subdir = path.join(dir, 'nested');
      mkdirSync(subdir);
      for (const root of [dir, subdir]) {
        const actual = machineMetadata(root);
        expect(actual.webViewerCommit).toBeNull();
        expect(buildReport(actual, [fakeRun()])).toMatchObject({ status: 'ok', machine: actual });
      }
      vi.stubEnv('PATH', '');
      try {
        expect(git(dir, '--version').error).toMatchObject({ code: 'ENOENT' });
        expect(machineMetadata(dir).webViewerCommit).toBeNull();
      } finally {
        vi.unstubAllEnvs();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it.skipIf(!gitAvailable)('collects the commit from a real git repository', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'perf-des-git-'));
    try {
      expect(git(dir, 'rev-parse', '--is-inside-work-tree').status).not.toBe(0);
      expect(git(dir, 'init').status).toBe(0);
      expect(git(dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
        '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Fixture').status).toBe(0);
      expect(machineMetadata(dir).webViewerCommit).toMatch(/^[a-f0-9]{40}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('parses defaults and smoke overrides, rejects invalid CLI values', () => {
    expect(parseOptions([])).toMatchObject({ sizes: [1, 2, 4, 8], repeats: 3, simSec: 28800, smoke: false, script: 'off' });
    // plan-2212 Phase 4: the with-script variant.
    expect(parseOptions(['--script', 'both'])).toMatchObject({ script: 'both' });
    expect(parseOptions(['--smoke', '--script', 'on'])).toMatchObject({ sizes: [1], script: 'on' });
    expect(() => parseOptions(['--script', 'yes'])).toThrow('--script');
    // plan-2212 Phase 4b: the realistic density, alone (with its plain baseline) or with all variants.
    expect(parseOptions(['--script', 'realistic'])).toMatchObject({ script: 'realistic' });
    expect(parseOptions(['--script', 'all'])).toMatchObject({ script: 'all' });
    expect(yardVariants('off')).toEqual(['']);
    expect(yardVariants('on')).toEqual(['dense']);
    expect(yardVariants('both')).toEqual(['', 'dense']);
    expect(yardVariants('realistic')).toEqual(['', 'realistic']);
    expect(yardVariants('all')).toEqual(['', 'dense', 'realistic']);
    expect(parseOptions(['--smoke', '--sizes', '4', '--repeats', '5'])).toMatchObject({ sizes: [1], repeats: 1, simSec: 600 });
    for (const args of [['--sizes', '0'], ['--sizes', '17'], ['--sizes', 'abc'], ['--repeats', '1.5'], ['--sim-sec', '0'], ['--out-dir'], ['--unknown']]) expect(() => parseOptions(args)).toThrow();
  });
  it('accepts AGV runs whose snapshot AND restore are unsupported (plan-558)', () => {
    const metrics: Record<string, number> = { ...fakeRun().metrics };
    for (const key of ['snapshotMs', 'snapshotBytes', 'restoreMs']) delete metrics[key];
    const run = { ...fakeRun(), metrics, snapshot: { supported: false, reason: 'agv-snapshot-unsupported (plan-558)' },
      restore: { supported: false, reason: 'agv-snapshot-restore-unsupported (plan-558)' } };
    const report = buildReport(machine, [run]);
    expect(report.scenarios[0].snapshot).toEqual(run.snapshot);
    expect(report.scenarios[0].metrics.snapshotMs).toBeUndefined();
  });});

describe('plan-2212 Phase 4b — script budget comparisons', () => {
  const timed = (scenario: string, runMs: number, startupMs: number, extra: Record<string, number> = {}) => ({
    ...fakeRun(), scenario,
    metrics: { ...fakeRun().metrics, totalEventsProcessed: 20000, runMs, startupMs, wallMs: runMs - startupMs, ...extra },
  });
  it('puts every script scenario next to the plain yard: ratio, startup delta, us per invocation', () => {
    const report = buildReport(machine, [
      timed('yard:1', 1000, 40), timed('yard:1', 1010, 41), timed('yard:1', 990, 39),
      timed('yard+script:1', 1150, 48, { scriptInvocations: 742 }),
      timed('yard+script-realistic:1', 1030, 44, { scriptInvocations: 200 }),
    ]);
    const byVariant = Object.fromEntries(report.comparisons.map((c: { variant: string }) => [c.variant, c]));
    expect(byVariant.dense).toMatchObject({ size: 1, scenario: 'yard+script:1', plain: 'yard:1', invocations: 742 });
    expect(byVariant.dense.runMsRatio).toBeCloseTo(1.15);
    expect(byVariant.dense.startupDeltaMs).toBeCloseTo(8);
    expect(byVariant.dense.usPerInvocation).toBeCloseTo(150_000 / 742);
    expect(byVariant.realistic.runMsRatio).toBeCloseTo(1.03);
    expect(byVariant.realistic.usPerInvocation).toBeCloseTo(150);
    expect(byVariant.realistic.eventsPerInvocation).toBeCloseTo(100);
  });
  it('omits comparisons without a timed plain baseline (default --script off output unchanged)', () => {
    expect(buildReport(machine, [fakeRun()]).comparisons).toBeUndefined();
    expect(compareScriptScenarios(buildReport(machine, [timed('yard+script:1', 1100, 40, { scriptInvocations: 10 })]).scenarios)).toEqual([]);
  });
});
