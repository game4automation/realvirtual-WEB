// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
/** Internal adapter: three objects never escape this boundary. Query results are
 * scratch storage, valid until the next query. Faces address the COPIED index. */
import { BufferAttribute, BufferGeometry, Triangle, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
export function surface(positions: Float32Array, index: Uint32Array) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  const reordered = index.slice();
  geometry.setIndex(new BufferAttribute(reordered, 1));
  const bvh = index.length ? new MeshBVH(geometry, { targetLeafSize: 8 }) : null;
  const point = new Vector3(), closest = new Vector3(), triangle = new Triangle();
  const target = { point: new Vector3(), distance: 0, faceIndex: 0 };
  const result = { distance: Infinity, face: -1 };
  let loadedFace = -1;
  const query = (x: number, y: number, z: number, minThreshold = 0, maxThreshold = Infinity) => {
    const hit = bvh?.closestPointToPoint(point.set(x, y, z), target, minThreshold, maxThreshold);
    result.distance = hit?.distance ?? Infinity;
    result.face = hit?.faceIndex ?? -1;
    return result;
  };
  return Object.assign(query, {
    index: reordered,
    /** A previous hit triangle provides a cheap upper bound, never a lower bound. */
    withinLast(x: number, y: number, z: number, threshold: number): boolean {
      const face = result.face;
      if (face < 0) return false;
      if (face !== loadedFace) {
        triangle.a.fromArray(positions, 3 * reordered[3 * face]);
        triangle.b.fromArray(positions, 3 * reordered[3 * face + 1]);
        triangle.c.fromArray(positions, 3 * reordered[3 * face + 2]);
        loadedFace = face;
      }
      point.set(x, y, z);
      triangle.closestPointToPoint(point, closest);
      return closest.distanceToSquared(point) <= threshold * threshold;
    },
  });
}
