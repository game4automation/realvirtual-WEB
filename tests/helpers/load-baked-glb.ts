// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * load-baked-glb.ts — the ONE way a test loads a GLB the way production loads it
 * (plan-772 F2).
 *
 * ## The blind spot this closes
 *
 * The destructive bake runs under FOUR conditions (`rv-scene-loader.ts`,
 * `destructivePipeline`), and the second one is the one everybody missed:
 *
 * ```ts
 * const destructivePipeline = !preserveHierarchy
 *   && !!options?.bakeRegistry                 // ← this one
 *   && meshCount > 0 && triangleCount > 0
 *   && (composition?.frames.length ?? 0) === 0;
 * ```
 *
 * Measured on `DemoRobotIK.glb` (plan-772 B3):
 *
 * | call | nodes | meshes |
 * |---|---|---|
 * | `loadGLB(url, scene, { data })` | 117 | 56 |
 * | `loadGLB(url, scene, { data, preserveHierarchy: true })` | **117** (identical) | 56 |
 * | `loadGLB(url, scene, { data, bakeRegistry: new BakeRegistry() })` | **78** | 36 |
 *
 * `RVViewer` always passes a registry, so the production load ALWAYS bakes.
 * A test that calls `loadGLB` without one therefore asserts against the
 * authoring tree — a tree production never shows — and stays green while the
 * baked path is broken. That is how the robot TCP could be removed by the bake
 * for weeks with a green IK suite (plan-772 B2). Counted when this helper was
 * written: 67 test files call `loadGLB`, 49 of them without a registry.
 *
 * ## What this helper guarantees, and why it checks the RESULT
 *
 * It does not assert that an option was set — the gate above may be rewritten
 * (plan-772 R8). It asserts the OUTCOME: the load's mode bakes
 * (`placementBakeAllowed`) and a destructive `BakedAsset` with at least one
 * chunk came out of it. `preserveHierarchy` is refused outright (the asset
 * editor's authoring flag, never a runtime switch), and a `BakeFailedError`
 * is deliberately NOT caught: a bake that fails is a test failure, never a
 * fallback to an unbaked tree (plan-757 Phase 3 commit A).
 *
 * ## Using it
 *
 * ```ts
 * const result = await loadBakedGLB(url, new Scene(), { data: bytes });
 * ```
 *
 * A test that needs the `BakeRegistry` itself (release, instance counts) mints
 * one and passes it in — the helper then uses that one instead of its own.
 *
 * The counterpart is `tests/bake-test-path-enforced.node.test.ts`: it fails
 * when a NEW test file loads a GLB without a registry, so the 49 legacy files
 * are a visible, shrinking list instead of an invisible default.
 */

import type { Scene } from 'three';
import { loadGLB, type LoadGLBOptions, type LoadResult } from '../../src/core/engine/rv-scene-loader';
import { BakeRegistry } from '../../src/core/engine/rv-bake-registry';

/**
 * Options for {@link loadBakedGLB} — every `loadGLB` option except the two
 * that would switch the bake off. They are removed at the TYPE level and
 * refused again at runtime, because an options object usually arrives as
 * `{ ...opts }` and a type alone does not survive that.
 */
export type BakedLoadOptions = Omit<LoadGLBOptions, 'preserveHierarchy' | 'preserveAuthoringHierarchy'> & {
  /**
   * Set `false` for a document that draws nothing of its own (a layout whose
   * geometry is all in deferred placements): its mode still bakes, but it has
   * no chunk of its own. Everything with geometry leaves this alone.
   */
  expectChunks?: boolean;
};

/** The runtime half of the type-level ban above. */
function assertNoAuthoringFlags(options: BakedLoadOptions | undefined): void {
  const bag = options as Record<string, unknown> | undefined;
  for (const flag of ['preserveHierarchy', 'preserveAuthoringHierarchy']) {
    if (bag?.[flag]) {
      throw new Error(
        `loadBakedGLB: ${flag} switches the destructive bake OFF, so this would load the authoring `
        + 'tree under a name that promises the baked one. Call loadGLB directly and add the file to '
        + 'the allowlist in tests/helpers/baked-load-allowlist.ts, with the reason.',
      );
    }
  }
}

/**
 * Load `url` into `scene` exactly as the viewer does — destructive bake
 * included — and prove from the RESULT that it really baked.
 *
 * Rejects with `BakeFailedError` when the bake fails (not caught on purpose),
 * and with a plain `Error` when the load came back unbaked.
 */
export async function loadBakedGLB(
  url: string,
  scene: Scene,
  options?: BakedLoadOptions,
): Promise<LoadResult> {
  assertNoAuthoringFlags(options);
  const { expectChunks = true, ...loaderOptions } = options ?? {};
  const result = await loadGLB(url, scene, {
    ...loaderOptions,
    bakeRegistry: loaderOptions.bakeRegistry ?? new BakeRegistry(),
  });

  // The mode. `placementBakeAllowed` is the loader's own answer to "does this
  // load bake", without the mesh-count guard — so a geometry-free document
  // still answers true and only loses its own chunks.
  if (result.placementBakeAllowed !== true) {
    throw new Error(
      `loadBakedGLB(${url}): the load reports placementBakeAllowed=${String(result.placementBakeAllowed)} — `
      + 'it did NOT bake, so every assertion below would be about the authoring tree.',
    );
  }

  if (!expectChunks) return result;

  // The outcome. One chunk mesh is the minimum proof that the destructive
  // pipeline ran and produced the template the scene now holds.
  const baked = result.bakedAsset;
  if (!baked) {
    throw new Error(
      `loadBakedGLB(${url}): bakedAsset is ${baked === null ? 'null' : 'absent'} although the mode bakes. `
      + 'A document that legitimately draws nothing passes expectChunks: false.',
    );
  }
  if (!baked.destructive) {
    throw new Error(`loadBakedGLB(${url}): the asset was baked IN PLACE (destructive=false) — not the production path.`);
  }
  if (baked.chunks.length === 0) {
    throw new Error(
      `loadBakedGLB(${url}): the bake produced 0 chunks. Either the document draws nothing `
      + '(pass expectChunks: false) or the bake dropped everything.',
    );
  }
  return result;
}

/**
 * Nodes in `root`'s subtree, `root` included — the number the 117-vs-78
 * measurement above counts, and the cheapest proof that a load baked
 * destructively rather than kept the authoring tree.
 */
export function countNodes(root: { traverse(cb: (node: unknown) => void): void }): number {
  let n = 0;
  root.traverse(() => { n++; });
  return n;
}
