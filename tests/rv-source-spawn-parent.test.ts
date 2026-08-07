// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Spawn-parent resolution for RVSource.
 *
 * Regression cover for the planner "MUs get shot off the belt" bug: the layout
 * planner wraps a placed asset whose root carries an intrinsic transform in an
 * identity Group (`ensureNeutralPlacementRoot`) and stamps the placement pose
 * onto that wrapper. The source then resolved its spawn parent to the wrapper,
 * so MUs lived in a rotated/translated frame while RVTransportSurface kept
 * advancing them with WORLD deltas and easing them toward a WORLD centre line —
 * dragging them off the conveyor.
 */

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import { isLayoutPlacementRoot, isTransformNeutral, resolveSpawnParent } from '../src/core/engine/rv-source';

/** layoutRoot → [wrapper] → source, mirroring a placed library asset. */
function placedAsset(opts: { wrapped: boolean; placementPose: boolean }) {
  const layoutRoot = new Object3D();
  layoutRoot.name = 'LayoutRoot';
  const source = new Object3D();
  source.name = 'Europallet';

  let placementRoot: Object3D;
  if (opts.wrapped) {
    const wrapper = new Object3D();
    wrapper.name = 'Europallet';
    wrapper.add(source);
    layoutRoot.add(wrapper);
    placementRoot = wrapper;
  } else {
    layoutRoot.add(source);
    placementRoot = source;
  }
  placementRoot.userData['_layoutObject'] = true;
  placementRoot.userData['_layoutId'] = 'placement-1';
  if (opts.placementPose) {
    placementRoot.position.set(4.2, 0, -1.7);
    placementRoot.rotation.set(0, Math.PI / 2, 0);
  }
  return { layoutRoot, source, placementRoot };
}

describe('isTransformNeutral', () => {
  it('accepts an untouched node and rejects any local transform', () => {
    const n = new Object3D();
    expect(isTransformNeutral(n)).toBe(true);
    n.position.x = 0.001;
    expect(isTransformNeutral(n)).toBe(false);
    n.position.x = 0;
    n.rotation.y = 0.001;
    n.updateMatrix();
    expect(isTransformNeutral(n)).toBe(false);
    n.rotation.y = 0;
    n.scale.setScalar(0.001);
    expect(isTransformNeutral(n)).toBe(false);
  });
});

describe('resolveSpawnParent', () => {
  it('spawns into the source parent when contextRoot IS the source (unwrapped placement)', () => {
    const { layoutRoot, source } = placedAsset({ wrapped: false, placementPose: true });
    // contextRoot === source: the walk matches immediately.
    expect(resolveSpawnParent(source, source)).toBe(layoutRoot);
  });

  it('never parents MUs to a transformed placement wrapper', () => {
    const { layoutRoot, source, placementRoot } = placedAsset({ wrapped: true, placementPose: true });
    const parent = resolveSpawnParent(placementRoot, source);
    expect(parent).not.toBe(placementRoot);
    expect(parent).toBe(layoutRoot);
    expect(isTransformNeutral(parent)).toBe(true);
  });

  it('does not lift past a plain neutral group that is not a placement root', () => {
    // Only placement roots and transformed nodes are escaped — an ordinary
    // world-aligned container is a valid spawn parent and must be kept.
    const layoutRoot = new Object3D();
    const container = new Object3D();
    const source = new Object3D();
    layoutRoot.add(container);
    container.add(source);
    expect(isLayoutPlacementRoot(container)).toBe(false);
    expect(resolveSpawnParent(container, source)).toBe(container);
  });

  it('leaves the main loadGLB path untouched (model root is contextRoot)', () => {
    const modelRoot = new Object3D();
    const cell = new Object3D();
    const source = new Object3D();
    modelRoot.add(cell);
    cell.add(source);
    // Source is a DESCENDANT of contextRoot → falls through to contextRoot.
    expect(resolveSpawnParent(modelRoot, source)).toBe(modelRoot);
  });

  it('never returns a node inside the source subtree', () => {
    const { source, placementRoot } = placedAsset({ wrapped: true, placementPose: true });
    const child = new Object3D();
    source.add(child);
    const parent = resolveSpawnParent(placementRoot, source);
    let cur: Object3D | null = parent;
    while (cur) {
      expect(cur).not.toBe(source);
      cur = cur.parent;
    }
  });
});

describe('placement-root rejection is timing-independent', () => {
  it('rejects a placement root that is still identity at resolve time', () => {
    // The planner stamps _layoutId BEFORE processExtras but applies the
    // placement pose AFTER it — the exact ordering that made an earlier
    // transform-only check pass and leave MUs inside the moving wrapper.
    const { layoutRoot, source, placementRoot } = placedAsset({ wrapped: true, placementPose: false });
    expect(isTransformNeutral(placementRoot)).toBe(true);   // looks innocent right now
    expect(isLayoutPlacementRoot(placementRoot)).toBe(true); // but is structurally a placement

    const parent = resolveSpawnParent(placementRoot, source);
    expect(parent).toBe(layoutRoot);

    // Pose applied afterwards, as the planner does — MU must not ride along.
    placementRoot.position.set(0.644, 0.5, -1.164);
    expect(parent).not.toBe(placementRoot);
    expect(isTransformNeutral(parent)).toBe(true);
  });

  it('_layoutObject alone (set on every descendant) does not mark a root', () => {
    const n = new Object3D();
    n.userData['_layoutObject'] = true;
    expect(isLayoutPlacementRoot(n)).toBe(false);
  });
});
