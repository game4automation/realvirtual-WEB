// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Truth table for the shared pickable-mesh predicate — the ONE filter deciding
 * which meshes participate in pick geometry. Consumed by both merged-group
 * builders (static + kinematic) AND the editor instance pick index; a wrong
 * entry silently makes objects unpickable (or makes overlays pickable) in
 * every mode at once.
 */
import { describe, it, expect } from 'vitest';
import { BoxGeometry, BufferGeometry, Mesh, MeshBasicMaterial, Skeleton, SkinnedMesh } from 'three';
import { isPickableMesh } from '../src/core/engine/rv-raycast-geometry';

function mesh(): Mesh {
  return new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
}

describe('isPickableMesh', () => {
  it('accepts a plain mesh with geometry', () => {
    expect(isPickableMesh(mesh())).toBe(true);
  });

  it('rejects batch outputs and BVH artifacts', () => {
    const a = mesh(); a.userData._rvBatchedRender = true;
    const b = mesh(); b.userData._rvRaycastBVH = true;
    expect(isPickableMesh(a)).toBe(false);
    expect(isPickableMesh(b)).toBe(false);
  });

  it('rejects overlay / visualization meshes', () => {
    const a = mesh(); a.userData._highlightOverlay = true;
    const b = mesh(); b.userData._driveHoverOverlay = true;
    const c = mesh(); c.name = 'Light_sensorViz';
    const d = mesh(); d.name = '_tankFillViz';
    expect(isPickableMesh(a)).toBe(false);
    expect(isPickableMesh(b)).toBe(false);
    expect(isPickableMesh(c)).toBe(false);
    expect(isPickableMesh(d)).toBe(false);
  });

  it('rejects meshes without position data', () => {
    const empty = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
    expect(isPickableMesh(empty)).toBe(false);
  });

  it('rejects skinned and morphed meshes', () => {
    // The predicate keys on `.skeleton` (set by bind()) — an unbound
    // SkinnedMesh has none and passes, exactly like the original builders.
    const skinned = new SkinnedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    skinned.bind(new Skeleton([]));
    expect(isPickableMesh(skinned)).toBe(false);

    const morphed = mesh();
    (morphed as Mesh & { morphTargetInfluences: number[] }).morphTargetInfluences = [0.5];
    expect(isPickableMesh(morphed)).toBe(false);
    // Empty influence list is NOT a morph target.
    const noMorph = mesh();
    (noMorph as Mesh & { morphTargetInfluences: number[] }).morphTargetInfluences = [];
    expect(isPickableMesh(noMorph)).toBe(true);
  });
});
