// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Shard prediction for vitest runs (plan-900 § 2.2) — rebuilds vitest's own shard assignment, so
 * an ABORTED suite run still yields a statement per FILE: which files a shard was going to run,
 * and which of them never finished.
 *
 *   node scripts/test-shard-plan.mjs --count 4 [--index 2] [--config vitest.node.config.ts]
 *   node scripts/test-shard-plan.mjs --count 4 --index 2 --done 687-s2-done.txt   # reconcile
 *   node scripts/test-shard-plan.mjs --count 4 --files-from files.txt --json
 *
 * Options:
 *   --count <n>        number of shards (required)
 *   --index <i>        1-based shard to print; omitted → every shard
 *   --config <file>    vitest config passed to `vitest list` (default: vitest's own default)
 *   --files-from <f>   read the file list from `f` (one path per line) instead of asking vitest
 *   --exclude-file <f> globs to drop, one per line, `#` comments (default: scripts/test-exclusions.txt)
 *   --root <dir>       the vitest ROOT the hash is computed against (default: the repo root)
 *   --done <f>         a list of files that FINISHED; prints what is missing from the prediction
 *   --json             machine-readable output
 *
 * The assignment, read off vitest's `BaseSequencer.shard`
 * (`node_modules/vitest/dist/chunks/coverage.AVPTjMgw.js:2364` and `:2408`):
 *
 *   specPath = resolve(slash(root), slash(moduleId)).slice(root.length)   // keeps a leading '/'
 *   hash     = sha1(specPath), hex
 *   order    = stable, by hash ascending
 *   window   = calculateShardRange(n, index, count)                      // remainder on the FIRST shards
 *
 * Validated against a real sharded vitest run in `tests/test-shard-plan.node.test.ts`, and in
 * plan-900 against the measured truth of the plan-687 abort: all 497 finished shard-2 files lay
 * inside the prediction of 498, none outside.
 *
 * Two deliberate differences from the throwaway version this grew out of (`687-shards.mjs`): the
 * root comes from `import.meta.url` instead of a hardcoded path, and the exclusion list is an
 * argument (a data file in the repo), not a regex baked into the code — what does not run has to
 * be VISIBLE.
 *
 * Every output states HOW MANY files were scanned. A prediction over an empty file list is not a
 * result, it is a broken file selection, and it has already been mistaken for one (plan-900 A9).
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
export const DEFAULT_EXCLUDE_FILE = path.join(here, 'test-exclusions.txt');

const slash = (value) => String(value).replace(/\\/g, '/');

/** vitest's spec key: the module path relative to the root, `/`-normalised, WITH its leading `/`. */
export function specKey(moduleId, root = repoRoot) {
  const rooted = slash(path.resolve(root));
  return slash(path.resolve(rooted, slash(moduleId))).slice(rooted.length);
}

/** vitest's spec hash: sha1 of the spec key, hex. */
export function specHash(moduleId, root = repoRoot) {
  return createHash('sha1').update(specKey(moduleId, root)).digest('hex');
}

/**
 * vitest's `calculateShardRange` — `[start, end)` of shard `index` (1-based) of `count`. The
 * remainder goes to the FIRST shards; a variant that gives it to the last ones produces a
 * different partition and is the discriminator in the test.
 */
export function shardRange(filesCount, index, count) {
  const base = Math.floor(filesCount / count);
  const remainder = filesCount % count;
  if (remainder >= index) return [(base + 1) * (index - 1), (base + 1) * index];
  const start = remainder * (base + 1) + (index - remainder - 1) * base;
  return [start, start + base];
}

/** `moduleIds` → one array of spec keys per shard, in vitest's order. */
export function shardPlan(moduleIds, count, root = repoRoot) {
  const sorted = [...new Set(moduleIds.map((id) => specKey(id, root)))]
    .map((key) => ({ key, hash: createHash('sha1').update(key).digest('hex') }))
    .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  const shards = [];
  for (let index = 1; index <= count; index++) {
    const [start, end] = shardRange(sorted.length, index, count);
    shards.push(sorted.slice(start, end).map((entry) => entry.key));
  }
  return shards;
}

/**
 * `glob` → RegExp over a spec key: `**` any depth, `*` inside one segment, trailing `/` = prefix.
 *
 * Two details, the same as `specGlobToRegExp` in `scripts/with-test-lock.mjs` (plan-900 F5):
 *   - `?` is ESCAPED rather than treated as a single-character wildcard. Unescaped it became the
 *     regex quantifier, so `tests/a?.test.ts` also excluded `tests/.test.ts` — a file the list
 *     never named, silently dropped from the plan. A new wildcard is the wrong fix here: what does
 *     not run has to be VISIBLE, and escaping keeps a glob to the files it spells out.
 *   - a `**` between two slashes spans ZERO or more segments, as standard glob does, so
 *     `tests/[**]/a.test.ts` also matches `tests/a.test.ts`. The exclusion list is empty today, so
 *     this cannot change any existing selection.
 */
const GLOB_ANY_DEPTH = '\u0000'; // a `**` that is not between two slashes
const GLOB_ANY_SEGMENTS = '\u0001'; // a whole `/` + `**` + `/`
const globSegment = (part) => part.replace(/[.+^${}()|[\]\\?]/g, '\\$&').split('*').join('[^/]*');
export function excludeGlobToRegExp(glob) {
  let pattern = slash(glob).replace(/^\.?\//, '');
  if (pattern.endsWith('/')) pattern += '**';
  const body = pattern
    .split('/**/').join(GLOB_ANY_SEGMENTS)
    .split('**').join(GLOB_ANY_DEPTH)
    .split(GLOB_ANY_SEGMENTS)
    .map((chunk) => chunk.split(GLOB_ANY_DEPTH).map(globSegment).join('.*'))
    .join('/(?:.*/)?');
  return new RegExp(`^/?${body}$`);
}

/** The globs in an exclusion file (one per line, `#` comments, blank lines ignored). */
export function readExclusions(file) {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

/** `moduleIds` minus everything an exclusion glob matches → { kept, dropped }. */
export function applyExclusions(moduleIds, globs, root = repoRoot) {
  const res = globs.map(excludeGlobToRegExp);
  const kept = [];
  const dropped = [];
  for (const id of moduleIds) (res.some((re) => re.test(specKey(id, root))) ? dropped : kept).push(id);
  return { kept, dropped };
}

/**
 * One `done` entry → a spec key. A log of finished files holds either absolute paths or the spec
 * keys this script prints, and on POSIX the two are indistinguishable by shape (both start with
 * `/`), so a key that is already in `known` is taken as it is instead of being resolved — on
 * Windows `path.resolve(root, '/tests/a.test.ts')` would otherwise land on the drive root.
 */
export function asKey(id, known, root = repoRoot) {
  const raw = slash(id);
  return known.has(raw) ? raw : specKey(id, root);
}

/** Predicted spec keys that are NOT in `done` — what an aborted shard still owed. */
export function missingFrom(predicted, done, root = repoRoot) {
  const known = new Set(predicted);
  const finished = new Set(done.map((id) => asKey(id, known, root)));
  return predicted.filter((key) => !finished.has(key));
}

/** `vitest list --filesOnly` → absolute module ids. `--shard` is ignored by `list`, so this is all of them. */
export function listFiles({ config, cwd = repoRoot } = {}) {
  const args = [path.join(cwd, 'node_modules', 'vitest', 'vitest.mjs'), 'list', '--filesOnly'];
  if (config) args.push('--config', config);
  const run = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`vitest list failed (${run.status}): ${String(run.stderr).trim().split('\n').slice(-5).join('\n')}`);
  // `list` prefixes every line with its project (`[chromium] tests/a.test.ts`); left in, the path
  // is unusable and the hash is computed over nonsense.
  return String(run.stdout).split(/\r?\n/)
    .map((line) => line.trim().replace(/^\[[^\]]+\]\s+/, ''))
    .filter((line) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(line));
}

/** One line per path in a file (blank lines and `#` comments dropped). */
export function readList(file) {
  return readFileSync(file, 'utf8').split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim()).filter(Boolean);
}

export function parseArgv(argv) {
  const options = { count: 0, index: 0, json: false, excludeFile: DEFAULT_EXCLUDE_FILE, root: repoRoot };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=');
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === '--count') options.count = Number(value());
    else if (flag === '--index') options.index = Number(value());
    else if (flag === '--config') options.config = value();
    else if (flag === '--files-from') options.filesFrom = value();
    else if (flag === '--exclude-file') options.excludeFile = value();
    else if (flag === '--root') options.root = path.resolve(value());
    else if (flag === '--done') options.done = value();
    else if (flag === '--json') options.json = true;
    else throw new Error(`unknown option ${argv[i]}`);
  }
  if (!(options.count >= 1)) throw new Error('--count <n> is required (n >= 1)');
  if (options.index && (options.index < 1 || options.index > options.count)) throw new Error('--index must be between 1 and --count');
  return options;
}

function main(argv) {
  const options = parseArgv(argv);
  const all = options.filesFrom ? readList(options.filesFrom) : listFiles({ config: options.config, cwd: options.root });
  const globs = readExclusions(options.excludeFile);
  const { kept, dropped } = applyExclusions(all, globs, options.root);
  const shards = shardPlan(kept, options.count, options.root);
  const indices = options.index ? [options.index] : shards.map((_, i) => i + 1);
  const report = {
    scanned: all.length, excluded: dropped.length, planned: kept.length,
    excludeFile: globs.length ? options.excludeFile : null, globs,
    shards: Object.fromEntries(indices.map((i) => [`${i}/${options.count}`, shards[i - 1]])),
  };
  if (options.done) {
    const done = readList(options.done);
    report.done = done.length;
    report.missing = Object.fromEntries(indices.map((i) => [`${i}/${options.count}`, missingFrom(shards[i - 1], done, options.root)]));
    const planned = new Set(indices.flatMap((i) => shards[i - 1]));
    report.outsideThePrediction = done.map((id) => asKey(id, planned, options.root)).filter((key) => !planned.has(key));
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  // The scan count is MANDATORY output: 0 scanned files is a broken selection, not a result.
  process.stdout.write(`scanned ${report.scanned} files, excluded ${report.excluded}, planned ${report.planned}\n`);
  if (globs.length) process.stdout.write(`exclusions from ${options.excludeFile}: ${globs.join(', ')}\n`);
  for (const i of indices) {
    process.stdout.write(`\nshard ${i}/${options.count} — ${shards[i - 1].length} files\n`);
    for (const key of shards[i - 1]) process.stdout.write(`  ${key}\n`);
    if (report.missing) {
      const missing = report.missing[`${i}/${options.count}`];
      process.stdout.write(`  MISSING after the abort: ${missing.length}\n`);
      for (const key of missing) process.stdout.write(`    ${key}\n`);
    }
  }
  if (report.outsideThePrediction?.length) {
    process.stdout.write(`\nWARNING: ${report.outsideThePrediction.length} finished files lie OUTSIDE the prediction — the assignment does not match this run\n`);
    for (const key of report.outsideThePrediction) process.stdout.write(`  ${key}\n`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`[test-shard-plan] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
