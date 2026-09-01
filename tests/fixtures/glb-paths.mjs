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
 * The internal assets live in the private Development project and are served
 * by the dev server's `/private-assets/<project>/<path...>` route (§2.5) — the
 * EXISTING recursive route, hardened rather than duplicated.
 *
 * Introducing this module and switching this value were deliberately two
 * steps: phase 1 pointed it at `/models` and changed ~27 files while nothing
 * moved, so the switch here could be the one line it is.
 *
 * A checkout without the private sibling serves none of these. That is
 * expected, and it is why every consumer pairs `DEV_GLB` with the probe in
 * `dev-asset-available.ts` (browser) or `HAS_DEV_ASSETS` (Playwright).
 */
const DEV = '/private-assets/Development';

/** Absolute URL paths (not file names) of the internal GLB assets. */
export const DEV_GLB = {
  tests: `${DEV}/fixtures/tests.glb`,
  physicsZone: `${DEV}/fixtures/physics-zone-test.glb`,
  mechanismDelta: `${DEV}/fixtures/mechanism-delta.glb`,
  mechanismFourbar: `${DEV}/fixtures/mechanism-fourbar.glb`,
  mechanismScissor: `${DEV}/fixtures/mechanism-scissor.glb`,
  robotIK: `${DEV}/models/DemoRobotIK.glb`,
  europalletEmpty: `${DEV}/models/EuropalletEmpty.glb`,
  // Added 2026-08-30: DemoCSGMachining is internal too (it replaced plan-430's
  // demo). It used to be reached as `?scene=builtin:DemoCSGMachining.glb`,
  // which stopped resolving when it left `public/project.json`'s documents[].
  csgMachining: `${DEV}/models/DemoCSGMachining.glb`,
};
