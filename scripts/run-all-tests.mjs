// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Runs BOTH test suites and fails if either fails.
 *
 * `test:all` used to be `npm run test:node && npm run test`, which meant a
 * single flaky node test skipped the entire browser suite — 8400 assertions
 * silently not run, reported as one failure. Both suites now always run; the
 * exit code is non-zero if either did, and the summary says which.
 *
 * They run sequentially on purpose: the browser suite wants the machine to itself.
 *
 * Machine-wide test lock (plan-606): `npm run test:all` runs this script under
 * `scripts/with-test-lock.mjs`, so the lock is held ONCE around the whole sequence
 * and no foreign run slips in between the node and the browser suite. The inner
 * `npm run test:node` / `npm run test` inherit `RV_TEST_LOCK_HELD` (the environment
 * is passed on as is) and their wrappers re-enter instead of waiting on it. Started
 * directly (`node scripts/run-all-tests.mjs`), the script puts itself under the
 * wrapper first.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (!process.env.RV_TEST_LOCK_HELD && String(process.env.RV_TEST_LOCK ?? '').toLowerCase() !== 'off') {
  const wrapper = fileURLToPath(new URL('./with-test-lock.mjs', import.meta.url));
  const self = fileURLToPath(import.meta.url);
  const wrapped = spawnSync(process.execPath, [wrapper, self, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(wrapped.status ?? 1);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const suites = [
  { name: 'node', script: 'test:node' },
  { name: 'browser', script: 'test' },
];

const results = [];

for (const suite of suites) {
  console.log(`\n=== running ${suite.name} suite (npm run ${suite.script}) ===\n`);
  const run = spawnSync(npm, ['run', suite.script], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env, // carries RV_TEST_LOCK_HELD / RV_TEST_LOCK_PARENT_PID / the watchdog in NODE_OPTIONS
  });
  results.push({ ...suite, code: run.status ?? 1 });
}

console.log('\n=== test:all summary ===');
for (const result of results) {
  console.log(`  ${result.code === 0 ? 'PASS' : 'FAIL'}  ${result.name} suite (exit ${result.code})`);
}

const failed = results.filter((result) => result.code !== 0);
if (failed.length > 0) {
  console.log(`\n${failed.length} of ${results.length} suites failed.`);
  process.exit(1);
}
console.log('\nAll suites passed.');
