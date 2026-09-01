// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Regenerates `tests/dev-asset-dependent-tests.json` — the checked-in set of
 * test ids that load an asset from the internal Development project
 * (plan-395 §2.11).
 *
 * ## Why a set of ids and not a count
 *
 * The dangerous failure of plan-395 is not a red suite, it is a GREEN one: the
 * `/private-assets/` route stops working, every probe answers "unavailable",
 * ~90 tests skip, and the run reports success having checked nothing.
 *
 * The obvious guard against that — "the test count must not change" — is blind
 * in exactly that case, and the plan's own spike data proved it:
 *
 * ```
 * {"numTotalTests":13,"numPassedTests":7,"numFailedTests":0,"numPendingTests":6}
 * ```
 *
 * Vitest counts a skipped test in `numTotalTests`. Skip everything and the
 * total is unchanged; the guard passes while the damage happens. So the guard
 * has to be per-test STATUS against a known set, which is what this file
 * generates and `tests/dev-asset-dependent-tests.node.test.ts` checks:
 *
 *  - with the private sibling, every id in the set is `passed`;
 *  - with `RV_NO_PRIVATE=1`, EXACTLY that set is `skipped` — not more (something
 *    unexpected is skipping) and not fewer (something is failing hard).
 *
 * ## Why its own file, and not a field in `private-dependent-tests.json`
 *
 * §2.12 left this open, to be decided against the code. The code answers it:
 * the two lists classify on different axes and are consumed by different
 * machinery. `private-dependent-tests.json` lists files that IMPORT private
 * modules and is consumed by `tsconfig`/`vitest` EXCLUDES — those files cannot
 * compile without the sibling. This set lists tests that LOAD a private asset
 * at runtime; they compile fine and must RUN and report `skipped`. Merging them
 * would mean one list whose entries mean two different things to two different
 * consumers, which is how both stop being trustworthy.
 *
 * ## Usage
 *
 *   node scripts/gen-dev-asset-dependent-tests.mjs <vitest-json-report>
 *
 * where the report comes from a GREEN run WITH the sibling present:
 *
 *   npx vitest run --reporter=json --outputFile=report.json
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../tests/dev-asset-dependent-tests.json');

const args = process.argv.slice(2);
const verify = args.includes('--verify');
const withoutSibling = args.includes('--without-sibling');
// Several reports are accepted and merged. Not a convenience: the full browser
// suite takes ~35 minutes here and gets killed by anything with a timeout, so
// it is routinely run in halves — and a generator that only took one report
// would quietly produce half an expectation set, which is the one failure mode
// this whole mechanism exists to prevent.
const reportPaths = [];
const withoutReports = [];
let bucket = reportPaths;
for (const arg of args) {
  if (arg === '--without') { bucket = withoutReports; continue; }
  if (arg.startsWith('--')) continue;
  bucket.push(arg);
}
const reportPath = reportPaths[0];

if (!reportPath || [...reportPaths, ...withoutReports].some(p => !existsSync(p))) {
  console.error('usage:');
  console.error('  node scripts/gen-dev-asset-dependent-tests.mjs <with.json...> --without <no.json...>');
  console.error('      regenerate: the set is the tests that PASS with the sibling and');
  console.error('      SKIP without it, measured in both worlds');
  console.error('  node scripts/gen-dev-asset-dependent-tests.mjs --verify <with.json...>');
  console.error('      suite_ExpectedIdsPassWithSibling: every id passed');
  console.error('  node scripts/gen-dev-asset-dependent-tests.mjs --verify --without-sibling <no.json...>');
  console.error('      suite_ExactlyExpectedIdsSkipWithoutSibling: exactly the set skipped');
  console.error('');
  console.error('  reports come from: npx vitest run --reporter=json --outputFile=report.json');
  console.error('  (prefix RV_NO_PRIVATE=1 for the without-sibling reports)');
  console.error('  Several reports per world are merged: the full suite is routinely run in halves.');
  process.exit(2);
}

const report = {
  testResults: reportPaths.flatMap(p => JSON.parse(readFileSync(p, 'utf8')).testResults ?? []),
};

/**
 * The files that carry the skip mechanic — read from the source, not listed
 * here. A hand-kept list is the thing plan-395 spent its §2.1 demonstrating
 * goes stale.
 */
function usesDevAssets(file) {
  // `dev-asset-probe.test.ts` imports the helper but is the TEST OF the helper:
  // it must run in both worlds and reports a mix of passed and skipped in each.
  // Listing it here would make the "exactly this set skips" gate demand that the
  // guard switch itself off, which is the one thing it must never do.
  if (file.replace(/\\/g, '/').endsWith('tests/dev-asset-probe.test.ts')) return false;
  try {
    return readFileSync(file, 'utf8').includes('dev-asset-available');
  } catch {
    return false;
  }
}

/** Every test of every dev-asset-dependent file, as `id -> status`. */
const observed = new Map();
for (const suite of report.testResults ?? []) {
  if (!usesDevAssets(suite.name)) continue;
  const file = suite.name.replace(/\\/g, '/').split('/realvirtual-WebViewer~/').pop();
  for (const test of suite.assertionResults ?? []) {
    // `fullName` is `<suite chain> <title>`; keeping the file makes an id unique
    // across the tree and readable in a failure message.
    observed.set(`${file} :: ${test.fullName}`, test.status);
  }
}
/**
 * The set, when regenerating: the tests that PASS with the sibling and SKIP
 * without it — measured in both worlds, never inferred from the file.
 *
 * Deriving it per FILE was the obvious first attempt and it was wrong, in a way
 * worth recording: `rv-physics-zone.test.ts` carries the skip mechanic for its
 * fixture suite but its other nine tests are pure unit tests that need no asset
 * at all. A file-level set demanded those nine skip too, and the gate failed on
 * behaviour that was entirely correct. The property the gate is about is a
 * property of a TEST, so that is what is measured.
 */
function regenerateIds() {
  if (!withoutReports.length) {
    console.error('--regenerate needs both worlds: pass the with-sibling reports, then');
    console.error('--without followed by the RV_NO_PRIVATE=1 reports.');
    process.exit(2);
  }
  const skippedWithout = new Set();
  for (const p of withoutReports) {
    for (const suite of JSON.parse(readFileSync(p, 'utf8')).testResults ?? []) {
      if (!usesDevAssets(suite.name)) continue;
      const file = suite.name.replace(/\\/g, '/').split('/realvirtual-WebViewer~/').pop();
      for (const test of suite.assertionResults ?? []) {
        if (['skipped', 'pending', 'todo'].includes(test.status)) {
          skippedWithout.add(`${file} :: ${test.fullName}`);
        }
      }
    }
  }
  const both = [...skippedWithout].filter(id => observed.get(id) === 'passed').sort();
  const skippedButNotPassing = [...skippedWithout].filter(id => observed.get(id) !== 'passed');
  if (skippedButNotPassing.length) {
    // Not fatal, but never silent: a test that skips without the sibling and does
    // not pass WITH it is not asset-dependent, it is broken, and it must not be
    // frozen into an expectation that says it is fine.
    console.warn(`[gen] ${skippedButNotPassing.length} test(s) skip without the sibling but do not `
      + 'pass with it — excluded from the set, and worth a look:');
    for (const id of skippedButNotPassing.slice(0, 10)) {
      console.warn(`  ${id} -> ${observed.get(id) ?? 'not run'}`);
    }
  }
  return both;
}

const ids = verify ? [...observed.keys()].sort() : regenerateIds();

if (verify) {
  const expected = JSON.parse(readFileSync(OUT, 'utf8')).devAssetDependent;
  const problems = [];

  if (withoutSibling) {
    // suite_ExactlyExpectedIdsSkipWithoutSibling — the guard against the silent
    // mass skip. BOTH directions are checked, and the second is the point:
    // "more skipped than expected" means something unexpected went dark, and a
    // guard that only looked for "fewer" would miss exactly that.
    const skipped = new Set(ids.filter(id => ['skipped', 'pending', 'todo'].includes(observed.get(id))));
    const notSkipped = expected.filter(id => !skipped.has(id));
    const unexpected = [...skipped].filter(id => !expected.includes(id));
    if (notSkipped.length) {
      problems.push(`expected to be SKIPPED without the sibling but were not (${notSkipped.length}):`);
      problems.push(...notSkipped.slice(0, 20).map(id => `  ${id}`));
    }
    if (unexpected.length) {
      problems.push(`skipped WITHOUT being in the expectation set (${unexpected.length}) — something`);
      problems.push('went dark that nobody signed off on:');
      problems.push(...unexpected.slice(0, 20).map(id => `  ${id}`));
    }
  } else {
    // suite_ExpectedIdsPassWithSibling
    const failed = expected.filter(id => observed.get(id) !== 'passed');
    if (failed.length) {
      problems.push(`expected to PASS with the sibling but did not (${failed.length}):`);
      problems.push(...failed.slice(0, 20).map(id => `  ${id} -> ${observed.get(id) ?? 'not run'}`));
    }
  }

  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(`OK: ${expected.length} dev-asset-dependent tests behaved as expected `
    + `(${withoutSibling ? 'RV_NO_PRIVATE=1' : 'with sibling'}).`);
  process.exit(0);
}

const payload = {
  $comment: [
    'GENERATED by scripts/gen-dev-asset-dependent-tests.mjs from a green vitest run.',
    'Do not hand-edit: regenerate and review the diff, which is the point (plan-395 §2.11).',
    'devAssetDependent: with the private sibling every id is `passed`; with RV_NO_PRIVATE=1',
    'EXACTLY this set is `skipped`. A set cannot grow unnoticed the way a count can.',
  ],
  generatedAt: new Date().toISOString().slice(0, 10),
  devAssetDependent: ids,
  knownFailing: {
    $comment: [
      'Pre-existing failures, EXCLUDED from the guard but not ignored: if this set grows,',
      'that is a regression. Kept per FILE rather than per test on purpose - these suites',
      'are flaky here (the plan-395 phase-1 baseline saw 7 and 8 failures on two runs of',
      'the same tree), and a per-test list would need editing after every run and would',
      'therefore be switched off within a week.',
    ],
    measured: '2026-08-30',
    files: [
      'tests/connect-embed-connection.node.test.ts',
      'tests/private-test-excludes.node.test.ts',
      'tests/embed-spike.node.test.ts',
      'tests/rv-customers-registry.node.test.ts',
      'tests/behavior-extras-inventory.node.test.ts',
      'tests/des/rv-des-checkpoint.test.ts',
    ],
  },
};

writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`wrote ${ids.length} dev-asset-dependent test ids -> ${OUT}`);
