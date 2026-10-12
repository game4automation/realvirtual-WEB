// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { BufferAttribute, BufferGeometry, Mesh, MeshBasicMaterial, PerspectiveCamera, Raycaster, Vector2 } from 'three';
import type { Intersection, Object3D } from 'three';
import { rankHitsByWireProximity } from '../src/core/engine/rv-wire-pick';

const W = 1000, H = 1000;

/** One triangle in the plane z = `z`, given as three [x, y] corners. */
function tri(name: string, z: number, pts: [number, number][]): Mesh {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pts.flatMap(([x, y]) => [x, y, z])), 3));
  g.setIndex([0, 1, 2]);
  const m = new Mesh(g, new MeshBasicMaterial({ side: 2 }));
  m.name = name;
  m.updateMatrixWorld(true);
  return m;
}

function pick(meshes: Mesh[], ndcX: number, ndcY: number): string[] {
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const rc = new Raycaster();
  rc.setFromCamera(new Vector2(ndcX, ndcY), camera);
  const hits: Intersection<Object3D>[] = rc.intersectObjects(meshes, false);
  rankHitsByWireProximity(hits, rc.ray, camera, W, H);
  return hits.map((h) => h.object.name);
}

describe('rankHitsByWireProximity', () => {
  // A cover: one huge triangle in front. An inner part: a small triangle behind
  // it whose edge runs close to the cursor at the screen centre.
  const cover = tri('cover', 2, [[-8, -8], [8, -8], [0, 12]]);
  const inner = tri('inner', 0, [[-0.02, -1], [1, -1], [-0.02, 1]]);

  it('a part seen through a cover wins when the cursor is on its wire', () => {
    // Depth order would be cover first; the cursor sits deep inside the cover's
    // triangle and right next to the inner part's left edge.
    expect(pick([cover, inner], 0, 0)).toEqual(['inner', 'cover']);
  });

  it('the front wire wins when the cursor is on wires of both', () => {
    const frontEdge = tri('front', 2, [[-0.02, -3], [3, -3], [-0.02, 3]]);
    expect(pick([frontEdge, inner], 0, 0)).toEqual(['front', 'inner']);
  });

  it('leaves a single hit and an empty list alone', () => {
    expect(pick([cover], 0, 0)).toEqual(['cover']);
    expect(pick([cover], 0.99, 0.99)).toEqual([]);
  });
});
