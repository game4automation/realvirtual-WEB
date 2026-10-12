// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Where a mesh lands under `bake()` (plan-753 Phase 4b — replaces the old
 * `isBatchSafe()` probe of the deleted arena batcher):
 *
 *   - `'static'` — staged into the root's static chunk (the old "batch-safe"),
 *   - `'mover'`  — staged into a mover chunk (`bake:'chunk'` owner, or a
 *                  forced split at a planner placement root — the loader's
 *                  own `forceSplit` rule is mirrored here),
 *   - `'keep'`   — a keep mesh (role `keep`, mesh-level keep, hidden, skinned),
 *   - `'absent'` — not in the bake at all (no position attribute).
 *
 * Runs a real bake over `root` and disposes it. Where a mesh landed is read
 * from the bake's `onStaged` diagnostic sink (plan-756 step 1d replaced the
 * retained `chunk.sources[]` window table with it).
 */
import type { Mesh, Object3D } from 'three';
import { bake } from '../../src/core/engine/rv-bake-pipeline';
import { getPlacementMeta } from '../../src/core/engine/rv-asset-reference';

export type BakeFate = 'static' | 'mover' | 'keep' | 'absent';

export async function bakeFateOf(mesh: Mesh, root: Object3D): Promise<BakeFate> {
  root.updateMatrixWorld(true);
  const stagedInto = new Map<Mesh, string>();
  const baked = await bake(root, {
    assetId: 'fate-probe',
    uberMaterial: null,
    forceSplit: (node) => !!getPlacementMeta(node),
    onStaged: (m, key) => { if (!stagedInto.has(m)) stagedInto.set(m, key); },
  });
  try {
    const key = stagedInto.get(mesh);
    if (key !== undefined) return key.startsWith('mover:') ? 'mover' : 'static';
    if (baked.keep.some((k) => k.mesh === mesh)) return 'keep';
    return 'absent';
  } finally {
    baked.retired = true;
    baked.dispose();
  }
}
