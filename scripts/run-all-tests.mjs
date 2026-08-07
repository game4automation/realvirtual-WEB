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
 * They run sequentially on purpose: `pretest`/`pretest:node` take the same
 * test lock, and the browser suite wants the machine to itself.
 */

import { spawnSync } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const suites = [
  { name: 'node', script: 'test:node' },
  { name: 'browser', script: 'test' },
];

const results = [];

for (const suite of suites) {
  console.log(`\n=== running ${suite.name} suite (npm run ${suite.script}) ===\n`);
  const run = spawnSync(npm, ['run', suite.script], { stdio: 'inherit', shell: process.platform === 'win32' });
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
