// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import {
  BoxGeometry, BufferGeometry, Float32BufferAttribute, Group, InstancedMesh, LineSegments,
  LineBasicMaterial, Mesh, MeshStandardMaterial, Object3D,
} from 'three';
import { computeSelectionStats } from '../../realvirtual-WebViewer-Private~/src/plugins/asset-editor/selection-stats';

// A BoxGeometry is 24 vertices, 36 indices = 12 triangles, in 6 groups of 6 indices.
const BOX_TRIS = 12;
const BOX_VERTS = 24;

describe('computeSelectionStats', () => {
  it('counts a shared geometry once in memory and once per mesh as drawn', () => {
    const root = new Group();
    const geo = new BoxGeometry();
    const mat = new MeshStandardMaterial();
    root.add(new Mesh(geo, mat), new Mesh(geo, mat), new Mesh(geo, new MeshStandardMaterial()));

    const { total, visible } = computeSelectionStats([root]);
    expect(total.objects).toBe(4);
    expect(total.meshes).toBe(3);
    expect(total.triangles).toBe(3 * BOX_TRIS);
    expect(total.vertices).toBe(3 * BOX_VERTS);
    expect(total.materials).toBe(2);
    expect(total.drawCalls).toBe(3);
    expect(total.geometries).toBe(1);
    expect(total.uniqueTriangles).toBe(BOX_TRIS);
    expect(total.uniqueVertices).toBe(BOX_VERTS);
    expect(visible).toEqual(total);
  });

  it('multiplies instances and honours the draw range', () => {
    const root = new Group();
    const instanced = new InstancedMesh(new BoxGeometry(), new MeshStandardMaterial(), 10);
    instanced.count = 7;
    const ranged = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    ranged.geometry.setDrawRange(0, 12);
    root.add(instanced, ranged);

    const { total } = computeSelectionStats([root]);
    expect(total.triangles).toBe(7 * BOX_TRIS + 4);
    expect(total.vertices).toBe(7 * BOX_VERTS + BOX_VERTS);
    expect(total.uniqueTriangles).toBe(2 * BOX_TRIS);
  });

  it('draws a material array per resolving group, and nothing without groups', () => {
    const a = new MeshStandardMaterial();
    const b = new MeshStandardMaterial();
    // Groups 0 and 1 resolve; groups 2..5 point at missing slots and are not drawn.
    const grouped = new Mesh(new BoxGeometry(), [a, b]);
    const ungrouped = new Mesh(new BoxGeometry(), [a]);
    ungrouped.geometry.clearGroups();
    const root = new Group().add(grouped, ungrouped);

    const { total } = computeSelectionStats([root]);
    expect(total.triangles).toBe(4);
    expect(total.drawCalls).toBe(2);
    expect(total.materials).toBe(2);
  });

  it('keeps hidden subtrees, hidden ancestors and invisible materials out of the visible column', () => {
    const scene = new Group();
    const shown = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    const hiddenParent = new Group();
    hiddenParent.visible = false;
    hiddenParent.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()));
    const ghost = new Mesh(new BoxGeometry(), new MeshStandardMaterial({ visible: false }));
    scene.add(shown, hiddenParent, ghost);

    const stats = computeSelectionStats([scene]);
    expect(stats.total.triangles).toBe(3 * BOX_TRIS);
    expect(stats.visible.triangles).toBe(BOX_TRIS);
    expect(stats.visible.materials).toBe(1);
    expect(stats.visible.drawCalls).toBe(1);

    // A root below a hidden ancestor is not on screen either.
    const below = computeSelectionStats([hiddenParent.children[0]]);
    expect(below.total.triangles).toBe(BOX_TRIS);
    expect(below.visible.triangles).toBe(0);
  });

  it('counts overlapping roots once', () => {
    const parent = new Group();
    const child = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    parent.add(child);
    for (const roots of [[parent, child], [child, parent]] as Object3D[][]) {
      const { total } = computeSelectionStats(roots);
      expect(total.objects).toBe(2);
      expect(total.triangles).toBe(BOX_TRIS);
    }
  });

  it('counts non-indexed geometry, keeps lines out of triangles and reports skipped helpers', () => {
    const tri = new BufferGeometry();
    tri.setAttribute('position', new Float32BufferAttribute(new Float32Array(18), 3)); // 6 verts
    const lineGeo = new BufferGeometry();
    lineGeo.setAttribute('position', new Float32BufferAttribute(new Float32Array(12), 3)); // 4 verts
    const helper = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    helper.name = '_gizmo';
    const root = new Group().add(
      new Mesh(tri, new MeshStandardMaterial()),
      new LineSegments(lineGeo, new LineBasicMaterial()),
      helper,
    );

    const stats = computeSelectionStats([root]);
    expect(stats.total.triangles).toBe(2);
    expect(stats.total.uniqueTriangles).toBe(2);
    expect(stats.total.vertices).toBe(10);
    expect(stats.total.otherDrawables).toBe(1);
    expect(stats.total.meshes).toBe(1);
    expect(stats.excludedHelpers).toBe(1);
    expect(stats.total.geometryBytes).toBe(18 * 4 + 12 * 4);
  });
});
