// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-900 § 2.2 — `scripts/test-shard-plan.mjs` rebuilds vitest's shard assignment.
 *
 * The oracle is vitest ITSELF: a real sharded run of a fixture config reports which files each
 * shard took, and the prediction must match it file for file. A test that only checked the
 * partition's shape (disjoint, sizes within one) would pass for any stable sort — it would prove
 * the sorting, not the assignment.
 *
 * Discriminator, demanded by the plan: a deliberately wrong window (the remainder on the LAST
 * shards instead of the first) must make the comparison fail. Without it, a test with an evenly
 * divisible file count says nothing about the one rule that is easy to get wrong.
 *
 * Runner: `npm run test:node`.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'test-shard-plan.mjs');
const FIX = path.join(ROOT, 'tests', 'fixtures', 'test-lock');
const PERFILE_CONFIG = path.join(FIX, 'vitest.perfile.config.mjs');
const VITEST_CLI = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');

const plan = (await import(pathToFileURL(SCRIPT).href)) as {
  DEFAULT_EXCLUDE_FILE: string;
  specKey(moduleId: string, root?: string): string;
  specHash(moduleId: string, root?: string): string;
  shardRange(filesCount: number, index: number, count: number): [number, number];
  shardPlan(moduleIds: string[], count: number, root?: string): string[][];
  excludeGlobToRegExp(glob: string): RegExp;
  readExclusions(file: string): string[];
  applyExclusions(moduleIds: string[], globs: string[], root?: string): { kept: string[]; dropped: string[] };
  asKey(id: string, known: Set<string>, root?: string): string;
  missingFrom(predicted: string[], done: string[], root?: string): string[];
  readList(file: string): string[];
  parseArgv(argv: string[]): { count: number; index: number; json: boolean; excludeFile: string; root: string; done?: string; filesFrom?: string; config?: string };
};

/** The WRONG window: remainder on the last shards. Must disagree with vitest. */
function wrongRange(filesCount: number, index: number, count: number): [number, number] {
  const base = Math.floor(filesCount / count);
  const remainder = filesCount % count;
  const biggerFrom = count - remainder + 1;
  let start = 0;
  for (let i = 1; i < index; i++) start += base + (i >= biggerFrom ? 1 : 0);
  return [start, start + base + (index >= biggerFrom ? 1 : 0)];
}

function wrongPlan(moduleIds: string[], count: number, root: string): string[][] {
  const sorted = [...new Set(moduleIds.map((id) => plan.specKey(id, root)))]
    .map((key) => ({ key, hash: createHash('sha1').update(key).digest('hex') }))
    .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  return Array.from({ length: count }, (_, i) => {
    const [start, end] = wrongRange(sorted.length, i + 1, count);
    return sorted.slice(start, end).map((entry) => entry.key);
  });
}

describe('test-shard-plan: vitest’s shard assignment, rebuilt', { timeout: 180_000 }, () => {
  // Three files, two shards: 3 % 2 = 1, so the remainder rule is actually exercised.
  const SPECS = ['first-file.fixture.test.mjs', 'slow-file.fixture.test.mjs', 'slow-file-b.fixture.test.mjs'];

  /** Runs the fixture config for one shard and returns the spec keys vitest actually ran. */
  function runShard(index: number, count: number): string[] {
    const run = spawnSync(process.execPath, [
      VITEST_CLI, 'run', '--config', PERFILE_CONFIG, `--shard=${index}/${count}`, '--reporter=json',
    ], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        RV_TL_PERFILE_INCLUDE: SPECS.join('|'),
        RV_TL_SLOW_FILE_MS: '1',
        RV_TEST_LOCK: process.env.RV_TEST_LOCK, // inherited: this run is a child of the locked one
      },
    });
    const json = String(run.stdout).slice(String(run.stdout).indexOf('{'));
    const parsed = JSON.parse(json) as { testResults: { name: string }[] };
    return [...new Set(parsed.testResults.map((result) => plan.specKey(result.name, FIX)))].sort();
  }

  it('predicts exactly the files a real sharded vitest run takes (both shards, remainder included)', () => {
    const predicted = plan.shardPlan(SPECS, 2, FIX);
    expect(predicted.flat().length, 'every file is planned exactly once').toBe(3);
    expect(predicted[0].length).toBe(2); // 3 % 2 = 1 → the first shard is the bigger one
    expect(predicted[1].length).toBe(1);
    const observed = [runShard(1, 2), runShard(2, 2)];
    expect(observed[0]).toEqual([...predicted[0]].sort());
    expect(observed[1]).toEqual([...predicted[1]].sort());
    // DISCRIMINATOR: the wrong window (remainder on the LAST shards) must NOT match this run.
    const wrong = wrongPlan(SPECS, 2, FIX);
    expect([...wrong[0]].sort()).not.toEqual(observed[0]);
  });

  it('the window rule matches vitest’s calculateShardRange, and the wrong variant differs', () => {
    // vitest: remainder on the FIRST shards (coverage.AVPTjMgw.js:2408).
    expect(plan.shardRange(10, 1, 4)).toEqual([0, 3]);
    expect(plan.shardRange(10, 2, 4)).toEqual([3, 6]);
    expect(plan.shardRange(10, 3, 4)).toEqual([6, 8]);
    expect(plan.shardRange(10, 4, 4)).toEqual([8, 10]);
    expect(plan.shardRange(8, 2, 4)).toEqual([2, 4]); // no remainder: equal windows
    // the whole set is covered exactly once, for every count
    for (const count of [1, 2, 3, 4, 7]) {
      const windows = Array.from({ length: count }, (_, i) => plan.shardRange(1999, i + 1, count));
      expect(windows[0][0]).toBe(0);
      expect(windows.at(-1)![1]).toBe(1999);
      for (let i = 1; i < count; i++) expect(windows[i][0]).toBe(windows[i - 1][1]);
    }
    expect(wrongRange(10, 1, 4)).not.toEqual(plan.shardRange(10, 1, 4));
  });

  it('the spec key and the hash are vitest’s: relative to the root, `/`-normalised, leading slash kept', () => {
    expect(plan.specKey(path.join(ROOT, 'tests', 'a.test.ts'), ROOT)).toBe('/tests/a.test.ts');
    expect(plan.specKey('tests/a.test.ts', ROOT)).toBe('/tests/a.test.ts');
    expect(plan.specKey('tests\\a.test.ts', ROOT)).toBe('/tests/a.test.ts');
    expect(plan.specHash('tests/a.test.ts', ROOT))
      .toBe(createHash('sha1').update('/tests/a.test.ts').digest('hex'));
    // The assignment depends on the ROOT: the same file in another root is another key.
    expect(plan.specKey(path.join(FIX, 'first-file.fixture.test.mjs'), FIX)).toBe('/first-file.fixture.test.mjs');
  });

  it('the assignment is stable and does not depend on the input order', () => {
    const files = Array.from({ length: 50 }, (_, i) => `tests/file-${i}.test.ts`);
    const forward = plan.shardPlan(files, 4, ROOT);
    const backward = plan.shardPlan([...files].reverse(), 4, ROOT);
    expect(backward).toEqual(forward);
    expect(new Set(forward.flat()).size).toBe(50); // disjoint and complete
    expect(forward.map((s) => s.length)).toEqual([13, 13, 12, 12]);
  });

  it('the exclusion list is data in the repo, visible and EMPTY today', () => {
    expect(plan.readExclusions(plan.DEFAULT_EXCLUDE_FILE)).toEqual([]); // plan-900 phase 4 emptied it
    const globs = ['tests/_spike-*/', 'tests/load-model-race.test.ts', 'tests/**/draft-*.test.ts'];
    const { kept, dropped } = plan.applyExclusions([
      'tests/_spike-756/spike.test.ts', 'tests/load-model-race.test.ts',
      'tests/sub/draft-one.test.ts', 'tests/keep-me.test.ts',
    ], globs, ROOT);
    expect(dropped).toEqual(['tests/_spike-756/spike.test.ts', 'tests/load-model-race.test.ts', 'tests/sub/draft-one.test.ts']);
    expect(kept).toEqual(['tests/keep-me.test.ts']);
    expect(plan.excludeGlobToRegExp('tests/*.test.ts').test('/tests/sub/a.test.ts')).toBe(false);
  });

  it('F5: `?` is a literal in an exclusion glob, and `/**/` spans zero segments', () => {
    // `?` unescaped became the regex quantifier, so `tests/a?.test.ts` also dropped
    // `tests/.test.ts` — a file the list never named, silently missing from the plan.
    expect(plan.excludeGlobToRegExp('tests/a?.test.ts').test('/tests/.test.ts')).toBe(false);
    expect(plan.excludeGlobToRegExp('tests/a?.test.ts').test('/tests/a?.test.ts')).toBe(true);
    const { kept, dropped } = plan.applyExclusions(['tests/.test.ts', 'tests/a.test.ts'], ['tests/a?.test.ts'], ROOT);
    expect(dropped).toEqual([]);
    expect(kept).toEqual(['tests/.test.ts', 'tests/a.test.ts']);
    // zero segments, as standard glob does
    expect(plan.excludeGlobToRegExp('tests/**/a.test.ts').test('/tests/a.test.ts')).toBe(true);
    expect(plan.excludeGlobToRegExp('tests/**/a.test.ts').test('/tests/sub/deep/a.test.ts')).toBe(true);
    expect(plan.excludeGlobToRegExp('tests/**/a.test.ts').test('/tests/sub/b.test.ts')).toBe(false);
    // unchanged: a trailing `/` is still a prefix
    expect(plan.excludeGlobToRegExp('tests/_spike-*/').test('/tests/_spike-756/a/b.test.ts')).toBe(true);
  });

  it('reconciles an aborted run: what the shard still owed, and whether anything finished outside it', () => {
    const files = Array.from({ length: 20 }, (_, i) => `tests/file-${i}.test.ts`);
    const shard = plan.shardPlan(files, 4, ROOT)[1];
    const done = shard.slice(0, shard.length - 2);
    expect(plan.missingFrom(shard, done, ROOT)).toEqual(shard.slice(-2));
    expect(plan.missingFrom(shard, shard, ROOT)).toEqual([]);
    // absolute paths (what a log usually holds) resolve to the same keys
    expect(plan.missingFrom(shard, shard.map((key) => path.join(ROOT, key)), ROOT)).toEqual([]);
    // the plan-687 measurement in one sentence: everything finished lay inside the prediction
    expect(done.filter((key) => !shard.includes(key))).toEqual([]);
  });

  it('the CLI refuses a missing --count and always reports the number of files scanned', () => {
    expect(() => plan.parseArgv([])).toThrow(/--count/);
    expect(() => plan.parseArgv(['--count', '4', '--index', '9'])).toThrow(/--index/);
    expect(() => plan.parseArgv(['--count', '4', '--nonsense'])).toThrow(/unknown option/);
    expect(plan.parseArgv(['--count=4', '--index=2']).index).toBe(2);
    const listFile = path.join(FIX, 'test-shard-plan-files.txt');
    const run = spawnSync(process.execPath, [SCRIPT, '--count', '2', '--files-from', listFile, '--root', ROOT], { cwd: ROOT, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    // A9's rule, here too: a run that does not say how many files it saw can report "0 files" as
    // a result. The count is part of every output.
    expect(run.stdout).toMatch(/^scanned 3 files, excluded 0, planned 3$/m);
    expect(run.stdout).toContain('shard 1/2 — 2 files');
    expect(run.stdout).toContain('shard 2/2 — 1 files');
  });
});
