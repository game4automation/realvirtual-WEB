// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-394 Phase 0 — MEASURE the BVH coverage instead of guessing it.
 *
 * Two analysis agents contradicted each other in the planning phase ("BVHs
 * exist for practically every mesh" vs. "only for the merged pick geometry").
 * The answer decides whether the narrowphase needs its own BVH build path.
 *
 * Reference model: `public/models/DemoRobotIK.glb` — a robot inside a machine
 * environment, i.e. exactly the geometry class this feature targets. A real
 * customer model is not available in the worktree; this is the documented
 * substitute (the largest demo GLB, DemoRealvirtualWeb.glb at 34 MB, is not
 * used here because loading it dominates the test run without changing the
 * answer: coverage is a property of the build path, not of model size).
 *
 * The measurement runs the PRODUCTION path (`computeBVHAsync` with the inline
 * port), so a future change to the skip rules shows up here.
 */

import { describe, it, expect } from 'vitest';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Mesh } from 'three';
import type { BufferGeometry } from 'three';
import { computeBVHAsync } from '../src/core/engine/rv-scene-loader';
import { createInlineBVHPort } from '../src/core/engine/rv-bvh-build-port';

const MODEL = '/models/DemoRobotIK.glb';

describe('BVH coverage on the reference model (plan-394 Phase 0)', () => {
  it('builds a boundsTree for every non-skipped mesh geometry', async () => {
    const head = await fetch(MODEL, { method: 'HEAD' });
    expect(head.ok, `${MODEL} must be served by the test server`).toBe(true);

    const gltf = await new GLTFLoader().loadAsync(MODEL);
    const root = gltf.scene;

    let meshes = 0;
    let triangles = 0;
    const geometries = new Set<BufferGeometry>();
    root.traverse((n) => {
      const m = n as Mesh;
      if (!m.isMesh || !m.geometry) return;
      meshes++;
      geometries.add(m.geometry as BufferGeometry);
      const geo = m.geometry as BufferGeometry;
      const count = geo.index ? geo.index.count : (geo.getAttribute('position')?.count ?? 0);
      triangles += Math.floor(count / 3);
    });

    const ok = await computeBVHAsync(root, createInlineBVHPort());
    expect(ok).toBe(true);

    let withTree = 0;
    root.traverse((n) => {
      const m = n as Mesh;
      if (!m.isMesh || !m.geometry) return;
      if ((m.geometry as BufferGeometry).boundsTree) withTree++;
    });

    // eslint-disable-next-line no-console
    console.log(
      `[plan-394 Phase 0] ${MODEL}: meshes=${meshes}, uniqueGeometries=${geometries.size}, `
      + `triangles=${triangles}, meshesWithBoundsTree=${withTree} `
      + `(${((withTree / Math.max(meshes, 1)) * 100).toFixed(1)}%)`,
    );

    expect(meshes).toBeGreaterThan(0);
    // Coverage is complete: the loader builds a tree for EVERY mesh geometry
    // that is not explicitly excluded (`_rvSkipBVH`, set only on the batched
    // render sources). `aabbOnly` is therefore the documented edge case, not
    // the normal case — no separate BVH build path is needed in Phase 2.
    expect(withTree).toBe(meshes);
  }, 120_000);
});
