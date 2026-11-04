// plan-659 spike test config — DELIBERATELY OUTSIDE `tests/`.
//
// The two standard vitest configs glob `tests/**` recursively, so a spike test
// placed there would join every normal run and drag the out-of-band
// `@mujoco/mujoco` / `onnxruntime-node` packages into it (plan review #9).
// This config has its own include glob and is invoked explicitly:
//
//   node scripts/with-test-lock.mjs npx vitest run -c spikes/659/vitest.config.ts
//
// It keeps the machine-wide test lock guard of the root configs (plan-606), so
// a direct `npx vitest run -c …` cannot overlap a normal suite.
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
  },
  resolve: {
    alias: {
      '@rv': resolve(ROOT, 'src'),
      '@rv-private': HAS_PRIVATE ? PRIVATE_DIR : resolve(ROOT, 'src/private-stubs'),
    },
  },
  test: {
    name: 'spike-659',
    environment: 'node',
    root: ROOT,
    include: ['spikes/659/*.test.ts'],
    pool: 'forks',
    // The 60 s walk run and the cost measurement are minutes of wall clock.
    testTimeout: 900_000,
    hookTimeout: 300_000,
    // `ensure-deps` FIRST: the out-of-band `@mujoco/mujoco` / `onnxruntime-*`
    // packages are extraneous, so any `npm install --no-save` in either tree
    // prunes them (plan-659). Restoring them is part of starting the suite,
    // not something the next session has to rediscover. No-op when present.
    globalSetup: [resolve(__dirname, 'ensure-deps.mjs'), resolve(ROOT, 'tests/global-lock-guard.ts')],
  },
});
