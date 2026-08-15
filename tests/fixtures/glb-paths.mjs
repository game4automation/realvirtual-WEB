// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Single source of truth for the URLs of the internal GLB assets — the test
 * fixtures and the two real reference models that only ever exist on a
 * development machine (plan-395 §2.3, F2).
 *
 * **The contract is the URL, not the file name.** Every consumer — vitest
 * browser tests, Playwright specs, the `webtest.mjs` CLI, the physics-fixture
 * generator — takes the finished path from here and never composes one of its
 * own. That is what makes the move in plan-395 phase 3 a one-line change to
 * `DEV` below instead of an edit in ~25 files.
 *
 * It is a `.mjs` on purpose: `scripts/webtest.mjs` is executed directly by Node
 * and cannot import a `.ts`. A parallel `.ts` copy "kept in sync" would be a
 * second source of truth and defeat the whole point (plan-395 §2.3,
 * SOL-Finding 5). Types for the TypeScript side live in `glb-paths.d.mts`.
 *
 * Deliberately NOT routed through here (plan-395 §2.1):
 *   - `tests/bunny-deploy.node.test.ts` and `tests/stage-public-demo.node.test.ts`
 *     write these names as *disallowed* files to prove the deploy prune removes
 *     them; a constant would stop them testing what they test.
 *   - `tests/rv-layout-bundled.test.ts` uses `EuropalletEmpty.glb` as a plain
 *     string to test wrapper-name stripping and never loads the file.
 */

/**
 * Phase 1: the root still points at `/models` — plan-395 phase 3 switches it to
 * `/private-assets/Development` (§2.3). Introducing the module and switching the
 * value are deliberately two steps: phase 1 stays behaviour-neutral.
 */
const DEV = '/models';

/** Absolute URL paths (not file names) of the internal GLB assets. */
export const DEV_GLB = {
  tests: `${DEV}/tests.glb`,
  physicsZone: `${DEV}/physics-zone-test.glb`,
  mechanismDelta: `${DEV}/mechanism-delta.glb`,
  mechanismFourbar: `${DEV}/mechanism-fourbar.glb`,
  mechanismScissor: `${DEV}/mechanism-scissor.glb`,
  robotIK: `${DEV}/DemoRobotIK.glb`,
  europalletEmpty: `${DEV}/EuropalletEmpty.glb`,
};
