// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// Strict-deps fixture ([test-deps], 2026-10-16) — a minimal node vitest config with the REAL
// progress plugin plus a fixture reporter that plays Vite's deps optimizer: it wraps a FAKE
// environment through the real `watchDepsOptimizer` and drives it the way vite does
// (`registerMissingImport` for a new id, then `hot.send({ type: 'full-reload' })`).
// - at run start (before the first test): discovery + reload of `fixture-dep-before` — legitimate;
// - at the test named `second` (after the first test): discovery + reload of
//   `fixture-dep-reloaded`, then a discovery without a reload of `fixture-dep-quiet`.
// Both tests pass; only RV_TEST_STRICT_DEPS decides the exit code.
import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testLockProgressPlugin, watchDepsOptimizer } from '../../../scripts/test-progress-reporter.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function fakeEnvironment() {
  const env = {
    depsOptimizer: {
      options: {},
      metadata: { optimized: {}, chunks: {}, discovered: {} },
      registerMissingImport(id) {
        env.depsOptimizer.metadata.discovered[id] = { id };
        return env.depsOptimizer.metadata.discovered[id];
      },
    },
    hot: { send() {} },
  };
  return env;
}

const env = fakeEnvironment();
const discoverAndReload = (dep) => {
  env.depsOptimizer.registerMissingImport(dep, `/node_modules/${dep}/index.js`);
  env.hot.send({ type: 'full-reload', path: '*' });
};

const fakeOptimizer = {
  name: 'rv-fixture-fake-optimizer',
  configureVitest({ vitest }) {
    watchDepsOptimizer({ environments: { client: env } });
    // Pushed AFTER the progress plugin's reporter (plugin order): its onTestCaseReady has
    // already marked the first test when this one runs.
    vitest.config.reporters.push({
      onTestRunStart() { discoverAndReload('fixture-dep-before'); },
      onTestCaseReady(testCase) {
        if (testCase.name !== 'second') return;
        discoverAndReload('fixture-dep-reloaded');
        env.depsOptimizer.registerMissingImport('fixture-dep-quiet', '/node_modules/fixture-dep-quiet/index.js');
        env.depsOptimizer.registerMissingImport('fixture-dep-quiet', '/node_modules/fixture-dep-quiet/index.js'); // known now: no second hit
      },
    });
  },
};

export default defineConfig({
  root: here,
  plugins: [testLockProgressPlugin(), fakeOptimizer],
  test: {
    include: ['deps.fixture.test.mjs'],
    environment: 'node',
    pool: 'forks',
    watch: false,
  },
});
