// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * planner-adopt-placement.test.ts — plan-397 phase 6.
 *
 * A scene saved since phase 6 carries its placements as `AssetReference` nodes
 * in its own file. By the time the planner sees them, composition has grafted
 * their subtrees in and `loadGLB` has run the whole loader over the result —
 * so the planner has to ADOPT them, not rebuild them.
 *
 * What these cases pin is the difference between the two, because it is not a
 * performance detail: the placement path would `pivotToFloorCenter` /
 * `alignToFloor` the node (moving a placement away from its authored
 * transform) and `modelRoot.add()` it (re-parenting a subtree of the loaded
 * model under itself). Adoption must do neither.
 */

import { describe, it, expect } from 'vitest';
import { Group, Object3D } from 'three';
import { adoptPlacedNode } from '../src/plugins/layout-planner/scene-mutations';
import { SnapPointRegistry } from '../src/core/engine/rv-snap-point-registry';
import { scanAndRegisterSnaps } from '../src/plugins/snap-point/snap-scanner';

function deps(registry?: SnapPointRegistry): {
  objectMap: Map<string, Object3D>;
  idByObject: WeakMap<Object3D, string>;
  getViewer: () => unknown;
} {
  const viewer = registry
    ? { getPlugin: () => ({ getRegistry: () => registry }) }
    : null;
  return { objectMap: new Map(), idByObject: new WeakMap(), getViewer: () => viewer };
}

/** A composed placement: a reference node with a grafted subtree under it. */
function composedPlacement(): { root: Group; node: Object3D; child: Object3D } {
  const root = new Group();
  root.name = 'Plant';
  const node = new Object3D();
  node.name = 'Presse_02';
  node.position.set(1000, 0, -250);
  const child = new Object3D();
  child.name = 'Ram';
  node.add(child);
  root.add(node);
  return { root, node, child };
}

describe('adoptPlacedNode', () => {
  it('does not move the node — an authored transform is already final', () => {
    const { node } = composedPlacement();
    const before = node.position.toArray();

    adoptPlacedNode(deps() as never, node, 'plc_1', 'Presse_02', 'press');

    expect(node.position.toArray()).toEqual(before);
    expect(node.scale.toArray()).toEqual([1, 1, 1]);
  });

  it('does not re-parent the node', () => {
    const { root, node } = composedPlacement();
    adoptPlacedNode(deps() as never, node, 'plc_1', 'Presse_02', 'press');
    expect(node.parent).toBe(root);
    expect(root.children).toHaveLength(1);
  });

  it('marks the node and its whole subtree as one layout unit', () => {
    const { node, child } = composedPlacement();
    adoptPlacedNode(deps() as never, node, 'plc_1', 'Presse_02', 'press');

    expect(node.userData._layoutObject).toBe(true);
    expect(node.userData._layoutId).toBe('plc_1');
    // The subtree flag is what makes selection and box-select treat a
    // placement as one object rather than as its parts.
    expect(child.userData._layoutObject).toBe(true);
  });

  it('registers both id lookups', () => {
    const { node } = composedPlacement();
    const d = deps();
    adoptPlacedNode(d as never, node, 'plc_1', 'Presse_02', 'press');

    expect(d.objectMap.get('plc_1')).toBe(node);
    expect(d.idByObject.get(node)).toBe('plc_1');
  });

  it('adds LayoutObject without discarding the rv-extras already on the node', () => {
    const { node } = composedPlacement();
    node.userData.realvirtual = { AssetReference: { assetId: 'press' } };

    adoptPlacedNode(deps() as never, node, 'plc_1', 'Presse_02', 'press');

    const rv = node.userData.realvirtual as Record<string, unknown>;
    // The reference is what makes the node resolvable at all — losing it here
    // would strand the placement on the next load.
    expect(rv.AssetReference).toEqual({ assetId: 'press' });
    expect(rv.LayoutObject).toEqual({ Label: 'Presse_02', CatalogId: 'press', Locked: false });
  });

  it('keeps the current name as the original — an adopted node is never renamed', () => {
    const { node } = composedPlacement();
    adoptPlacedNode(deps() as never, node, 'plc_1', 'Presse_02', 'press');
    expect(node.userData._originalName).toBe('Presse_02');
  });

  it('re-owns snaps the model-root scan registered with the wrong owner', () => {
    // The snap plugin's onModelLoaded scans the WHOLE loaded root with
    // ownerRoot = model root, so every baked placement's snaps share one
    // owner — and same-owner snaps can never pair in the geometry rebuild.
    // Adoption must drop those entries and re-register per placement.
    const { root, node } = composedPlacement();
    const snap = new Object3D();
    snap.name = 'Snap-XP-conv';
    node.add(snap);

    const registry = new SnapPointRegistry();
    scanAndRegisterSnaps(root, registry, root); // what onModelLoaded does

    expect(registry.getById(snap.uuid)?.ownerRoot).toBe(root);

    adoptPlacedNode(deps(registry) as never, node, 'plc_1', 'Presse_02', 'press');

    expect(registry.getById(snap.uuid)?.ownerRoot).toBe(node);
  });
});
