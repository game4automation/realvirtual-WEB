// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The import weld against the real exporter and the real loader: what
 * `objectToGlb` writes for a triangle-soup mesh must come back from
 * `parseGlbSubtree` with fewer vertices and the same triangles. The byte-level
 * cases live in `rv-glb-weld.node.test.ts`; this one pins that the welded file
 * is still a GLB three.js accepts.
 */

import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { parseGlbSubtree } from '../src/core/engine/rv-glb-parse';
import { weldGlbVertices } from '../src/core/import/rv-glb-weld';

/** A flat grid of quads where every triangle owns its three vertices. */
function soupMesh(cells: number): Mesh {
  const positions: number[] = [];
  const normals: number[] = [];
  for (let x = 0; x < cells; x++) {
    for (let y = 0; y < cells; y++) {
      const quad = [x, y, x + 1, y, x + 1, y + 1, x, y, x + 1, y + 1, x, y + 1];
      for (let i = 0; i < quad.length; i += 2) {
        positions.push(quad[i], quad[i + 1], 0);
        normals.push(0, 0, 1);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  const index = new Uint32Array(positions.length / 3);
  for (let i = 0; i < index.length; i++) index[i] = i;
  geometry.setIndex(new BufferAttribute(index, 1));
  const mesh = new Mesh(geometry, new MeshStandardMaterial());
  mesh.name = 'Soup';
  return mesh;
}

/** Every drawn corner as "x,y,z|nx,ny,nz", in draw order. */
function drawnCorners(mesh: Mesh): string[] {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const index = geometry.index!;
  const out: string[] = [];
  for (let i = 0; i < index.count; i++) {
    const v = index.getX(i);
    out.push(
      `${position.getX(v)},${position.getY(v)},${position.getZ(v)}|` +
      `${normal.getX(v)},${normal.getY(v)},${normal.getZ(v)}`,
    );
  }
  return out;
}

function firstMesh(root: { traverse(cb: (n: unknown) => void): void }): Mesh {
  let found: Mesh | null = null;
  root.traverse((n) => { if (!found && (n as Mesh).isMesh) found = n as Mesh; });
  if (!found) throw new Error('no mesh in tree');
  return found;
}

describe('rv-glb-weld — exporter/loader round trip', () => {
  it('a welded export loads with shared vertices and identical triangles', async () => {
    const cells = 8;
    const root = new Group();
    root.name = 'Root';
    root.add(soupMesh(cells));

    const exported = await objectToGlb(root);
    const result = weldGlbVertices(exported);
    expect(result.changed).toBe(true);
    expect(result.stats.verticesBefore).toBe(cells * cells * 6);
    expect(result.stats.verticesAfter).toBe((cells + 1) * (cells + 1));

    const before = firstMesh(await parseGlbSubtree(exported));
    const after = firstMesh(await parseGlbSubtree(result.glb));
    expect(after.geometry.getAttribute('position').count).toBe((cells + 1) * (cells + 1));
    expect(drawnCorners(after)).toEqual(drawnCorners(before));
    expect(after.name).toBe(before.name);
  });
});
