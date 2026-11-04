// plan-673 Phase 1 / 1b gate config — DELIBERATELY OUTSIDE `tests/`.
//
// The two standard vitest configs glob `tests/**` recursively, so a spike test
// placed there would join every normal run and drag the out-of-band
// `@mujoco/mujoco` package into it. This config has its own include glob and is
// invoked explicitly, always through the machine-wide test lock (plan-606):
//
//   node scripts/with-test-lock.mjs npx vitest run -c spikes/673/vitest.config.ts
//
// `ensure-deps.mjs` is REUSED from the 659 spike — it is the one place that
// knows the exact out-of-band package set and restores it after any
// `npm install --no-save` pruned it.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const ROOT = resolve(__dirname, '../..');
const PRIVATE_DIR = resolve(ROOT, '../realvirtual-WebViewer-Private~/src');
const HAS_PRIVATE = existsSync(PRIVATE_DIR);

export default defineConfig({
  define: {
    __RV_HAS_PRIVATE__: JSON.stringify(HAS_PRIVATE),
    __RV_EMBED__: 'false',
    __RV_INTERNAL__: 'true',
  },
  resolve: {
    alias: {
      '@rv': resolve(ROOT, 'src'),
      '@rv-private': HAS_PRIVATE ? PRIVATE_DIR : resolve(ROOT, 'src/private-stubs'),
    },
  },
  test: {
    name: 'spike-673',
    environment: 'node',
    root: ROOT,
    include: ['spikes/673/*.test.ts'],
    // One fork, one file at a time: this is a TIMING measurement, and two
    // workers on one machine is exactly the documented way to produce wrong
    // sub-millisecond numbers.
    pool: 'forks',
    // Vitest 4 moved the former `poolOptions.forks.*` to the top level.
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 1_800_000,
    hookTimeout: 300_000,
    globalSetup: [
      resolve(ROOT, 'spikes/659/ensure-deps.mjs'),
      resolve(ROOT, 'tests/global-lock-guard.ts'),
    ],
  },
});
