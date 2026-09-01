// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The two plan-395 §2.11 gates, as one command each.
 *
 *   node scripts/gate-dev-assets.mjs              # with the private sibling
 *   node scripts/gate-dev-assets.mjs --absent     # simulating no sibling
 *   node scripts/gate-dev-assets.mjs --regenerate # rewrite the expectation set
 *
 * Each runs the browser suite with the JSON reporter and hands the report to
 * `gen-dev-asset-dependent-tests.mjs`. The `--absent` run sets `RV_NO_PRIVATE=1`,
 * which makes `privateModelsPlugin` return `null` — the same effect as a missing
 * sibling, WITHOUT renaming the real folder. A gate that moves a developer's
 * models out of the way to prove a point eventually forgets to move them back.
 *
 * A Node wrapper rather than an npm script because the env var has to be set
 * cross-platform and this repo has no `cross-env`: `RV_NO_PRIVATE=1 vitest` is
 * a syntax error in PowerShell, and half the team is on Windows.
 *
 * The run takes ~20 minutes. That is why this is a command you invoke and not a
 * vitest test that shells out to two more vitest runs.
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

const absent = process.argv.includes('--absent');
const regenerate = process.argv.includes('--regenerate');
const report = absent ? '.rv-395-nopriv.json' : '.rv-395-browser.json';

if (absent && regenerate) {
  console.error('--regenerate measures BOTH worlds itself; --absent contradicts it.');
  process.exit(2);
}

const run = (cmd, args, env) => spawnSync(cmd, args, {
  cwd: REPO,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, ...env },
});

/** One browser suite run, into `out`, optionally simulating no sibling. */
function suiteRun(out, noPrivate) {
  console.log(`[gate-dev-assets] running the browser suite${noPrivate ? ' with RV_NO_PRIVATE=1' : ''}…`);
  return run('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${out}`],
    noPrivate ? { RV_NO_PRIVATE: '1' } : {});
}

if (regenerate) {
  // Both worlds, because the set is DEFINED by the difference between them: a
  // test belongs in it when it passes with the sibling and skips without one.
  // Deriving it from the with-sibling run alone would list every test of every
  // file that carries the mechanic — including the pure unit tests that share a
  // file with a guarded suite and correctly keep running.
  suiteRun('.rv-395-browser.json', false);
  suiteRun('.rv-395-nopriv.json', true);
  const gen = run('node', ['scripts/gen-dev-asset-dependent-tests.mjs',
    '.rv-395-browser.json', '--without', '.rv-395-nopriv.json']);
  process.exit(gen.status ?? 1);
}

const suite = suiteRun(report, absent);

// The suite's own exit code is deliberately NOT fatal here. It is red in this
// tree for reasons older than plan-395 (§2.11 measured them), so gating on it
// would gate on somebody else's flake. What this command judges is the STATUS
// of the dev-asset-dependent tests, which is what the report carries either way.
if (suite.status !== 0) {
  console.warn(`[gate-dev-assets] the suite exited ${suite.status} — pre-existing failures are `
    + 'expected; the per-test check below is the actual gate.');
}

const verify = run('node', ['scripts/gen-dev-asset-dependent-tests.mjs', '--verify',
  ...(absent ? ['--without-sibling'] : []), report]);

process.exit(verify.status ?? 1);
