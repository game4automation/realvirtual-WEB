// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Corrupt vertex data never reaches the bake or the camera (2026-09-24).
 *
 * A CAD conversion left a primitive of pure NaN vertices in the Festo cell
 * (`E06780344_AF0_1`, 5220 vertices). The destructive bake merged it into the
 * root's static chunk, ONE `expandByPoint(NaN)` made the chunk bounds NaN and
 * `frameSceneContent()` put the camera at NaN: an empty grey viewport.
 * `dropNonFiniteGeometry` runs right after the parser on every load path.
 */
import { describe, it, expect } from 'vitest';
import { BufferAttribute, BufferGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { dropNonFiniteGeometry } from '../src/core/engine/rv-scene-loader';

function tri(nan: boolean): BufferGeometry {
  const g = new BufferGeometry();
  const p = nan
    ? new Float32Array([NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN])
    : new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  g.setAttribute('position', new BufferAttribute(p, 3));
  g.setIndex([0, 1, 2]);
  return g;
}

describe('dropNonFiniteGeometry', () => {
  it('removes a bare CAD part whose vertices are NaN and leaves finite meshes alone', () => {
    const root = new Group();
    const good = new Mesh(tri(false), new MeshStandardMaterial()); good.name = 'Good';
    const bad = new Mesh(tri(true), new MeshStandardMaterial()); bad.name = 'E06780344_AF0_1';
    root.add(good, bad);

    const report = dropNonFiniteGeometry(root);

    expect(report.dropped).toEqual(['E06780344_AF0_1']);
    expect(bad.parent).toBeNull();
    expect(good.parent).toBe(root);
    expect(good.geometry.getAttribute('position').count).toBe(3);
  });

  it('keeps a node that carries children or extras and only empties its geometry', () => {
    const root = new Group();
    const carrier = new Mesh(tri(true), new MeshStandardMaterial()); carrier.name = 'Carrier';
    carrier.userData.realvirtual = { Sensor: {} };
    const child = new Mesh(tri(false), new MeshStandardMaterial()); child.name = 'Child';
    carrier.add(child);
    root.add(carrier);

    const report = dropNonFiniteGeometry(root);

    expect(report.dropped).toEqual(['Carrier']);
    expect(carrier.parent).toBe(root);
    expect(child.parent).toBe(carrier);
    expect(carrier.geometry.getAttribute('position').count).toBe(0);
    expect(carrier.geometry.index?.count ?? 0).toBe(0);
  });

  it('reports nothing on a clean tree', () => {
    const root = new Group();
    root.add(new Mesh(tri(false), new MeshStandardMaterial()));
    expect(dropNonFiniteGeometry(root).dropped).toEqual([]);
  });
});
