// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * mesh-fixtures — analytic tessellated meshes for the snap / circle suites.
 *
 * These builders were private to `mechanism-snap-cylinder.test.ts` until plan-722
 * needed the same mantles and plates elsewhere, and plan-724 needs them again for
 * the vertex-circle suite. A second copy would have been the usual trap: those
 * suites test the same fitting mathematics, so a fixture that drifted in one file
 * would make one of them pass for the wrong reason.
 *
 * Everything here is EXACT by construction — a bore of radius 5 really is at
 * radius 5, to the tessellation's own accuracy — because these fixtures are the
 * ground truth the fits are measured against.
 */

import { BufferAttribute, BufferGeometry, Matrix4, Vector3 } from 'three';

export interface MeshData {
  positions: number[];
  indices: number[];
}

export function toGeometry(data: MeshData): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(data.positions), 3));
  geometry.setIndex(data.indices);
  return geometry;
}

/**
 * A mantle (tube) around +Z: `segments` around, `rings` along, radius r(t)
 * interpolating from `radiusBottom` to `radiusTop` (equal ⇒ cylinder, different
 * ⇒ cone). `inward` flips the winding so the normals point AT the axis, which is
 * what a bore's wall looks like on a closed CAD solid.
 *
 * `sweepDeg` < 360 leaves the mantle open — the partial-arc case; `gapDeg`
 * removes one contiguous wedge, which is the "large gap" case.
 */
export function mantle(opts: {
  radiusBottom: number; radiusTop?: number; height: number;
  segments?: number; rings?: number; inward?: boolean;
  sweepDeg?: number; gapDeg?: number;
  transform?: Matrix4;
}): BufferGeometry {
  return toGeometry(mantleData(opts));
}

/** {@link mantle}, as raw arrays — the form the pure geometry entry points take. */
export function mantleData(opts: {
  radiusBottom: number; radiusTop?: number; height: number;
  segments?: number; rings?: number; inward?: boolean;
  sweepDeg?: number; gapDeg?: number;
  transform?: Matrix4;
}): MeshData {
  const segments = opts.segments ?? 64;
  const rings = opts.rings ?? 4;
  const radiusTop = opts.radiusTop ?? opts.radiusBottom;
  const sweep = ((opts.sweepDeg ?? 360) * Math.PI) / 180;
  const gap = ((opts.gapDeg ?? 0) * Math.PI) / 180;

  const positions: number[] = [];
  const indices: number[] = [];
  const point = new Vector3();
  const index = (ring: number, seg: number): number => ring * (segments + 1) + seg;

  for (let ring = 0; ring <= rings; ring++) {
    const t = ring / rings;
    const z = (t - 0.5) * opts.height;
    const radius = opts.radiusBottom + (radiusTop - opts.radiusBottom) * t;
    for (let seg = 0; seg <= segments; seg++) {
      const angle = (seg / segments) * sweep;
      point.set(Math.cos(angle) * radius, Math.sin(angle) * radius, z);
      if (opts.transform) point.applyMatrix4(opts.transform);
      positions.push(point.x, point.y, point.z);
    }
  }

  for (let ring = 0; ring < rings; ring++) {
    for (let seg = 0; seg < segments; seg++) {
      const angle = (seg / segments) * sweep;
      // A contiguous wedge of missing quads, starting at 0°.
      if (gap > 0 && angle < gap) continue;
      const a = index(ring, seg), b = index(ring, seg + 1);
      const c = index(ring + 1, seg + 1), d = index(ring + 1, seg);
      if (opts.inward) indices.push(a, c, b, a, d, c);
      else indices.push(a, b, c, a, c, d);
    }
  }
  return { positions, indices };
}

/** A UV sphere — curved in BOTH directions, so no cylinder axis exists. */
export function sphere(radius: number, segments = 32, rings = 16): BufferGeometry {
  return toGeometry(sphereData(radius, segments, rings));
}

/** {@link sphere}, as raw arrays. */
export function sphereData(radius: number, segments = 32, rings = 16): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    for (let s = 0; s <= segments; s++) {
      const theta = (s / segments) * Math.PI * 2;
      positions.push(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.sin(phi) * Math.sin(theta),
        radius * Math.cos(phi),
      );
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * (segments + 1) + s, b = a + 1;
      const c = (r + 1) * (segments + 1) + s + 1, d = c - 1;
      indices.push(a, b, c, a, c, d);
    }
  }
  return { positions, indices };
}

/** Append `data` into `into`, renumbering its indices. */
export function appendMesh(into: MeshData, data: MeshData): void {
  const base = into.positions.length / 3;
  into.positions.push(...data.positions);
  for (const i of data.indices) into.indices.push(i + base);
}

/**
 * A rectangular plate of thickness `thickness` in Z, centred on the origin,
 * pierced by through-bores at the given (x, y) positions.
 *
 * Both faces are triangulated as an annulus fan around EACH bore plus a coarse
 * outer ring, so every bore is a genuine circular BOUNDARY LOOP of a coplanar
 * face — which is exactly the topology a real CAD tessellation produces and the
 * one the rim branch is written for. The walls are inward mantles, so the bore
 * classifies as a bore and not as a shaft.
 */
export function plateWithBores(opts: {
  halfSize?: number;
  thickness?: number;
  bores: { x: number; y: number; radius: number }[];
  segments?: number;
}): MeshData {
  const half = opts.halfSize ?? 40;
  const thickness = opts.thickness ?? 6;
  const segments = opts.segments ?? 64;
  const zTop = thickness / 2, zBottom = -thickness / 2;
  const out: MeshData = { positions: [], indices: [] };

  for (const face of [zTop, zBottom] as const) {
    // Ring 0 = the plate outline sampled on a circle well outside every bore,
    // rings 1..n = each bore's rim. A fan between consecutive rings keeps the
    // whole face ONE coplanar region with n+1 boundary loops.
    const outerRadius = half * Math.SQRT2;
    const rings: { cx: number; cy: number; r: number }[] = [
      { cx: 0, cy: 0, r: outerRadius },
      ...opts.bores.map((b) => ({ cx: b.x, cy: b.y, r: b.radius })),
    ];
    for (const ring of rings) {
      for (let s = 0; s < segments; s++) {
        const angle = (s / segments) * Math.PI * 2;
        out.positions.push(
          ring.cx + Math.cos(angle) * ring.r,
          ring.cy + Math.sin(angle) * ring.r,
          face,
        );
      }
    }
    const ringBase = (i: number): number =>
      out.positions.length / 3 - rings.length * segments + i * segments;
    for (let i = 1; i < rings.length; i++) {
      const outer = ringBase(0), inner = ringBase(i);
      for (let s = 0; s < segments; s++) {
        const s2 = (s + 1) % segments;
        // Winding flipped on the bottom face so both normals point outwards.
        if (face === zTop) {
          out.indices.push(outer + s, outer + s2, inner + s2, outer + s, inner + s2, inner + s);
        } else {
          out.indices.push(outer + s, inner + s2, outer + s2, outer + s, inner + s, inner + s2);
        }
      }
    }
  }

  for (const bore of opts.bores) {
    const wall = mantleData({
      radiusBottom: bore.radius, height: thickness, segments, rings: 3, inward: true,
      transform: new Matrix4().setPosition(bore.x, bore.y, 0),
    });
    appendMesh(out, wall);
  }
  return out;
}

/**
 * Two coplanar triangle rings sharing exactly ONE vertex — the FIGURE-EIGHT
 * boundary case.
 *
 * At the shared vertex the boundary adjacency has four entries instead of two,
 * which is precisely where a naive loop walk either fuses the two loops into one
 * bogus circle or drops both. `mechanism-snap.ts` discards a non-manifold chain
 * rather than inventing a circle, and this fixture is what proves it (plan-722
 * §9.1, review finding T9).
 */
export function figureEightPlate(radius: number, segments = 48): MeshData {
  const out: MeshData = { positions: [], indices: [] };
  // One outer square face with two circular holes that TOUCH at the origin.
  const centers = [-radius, radius];
  const outerRadius = radius * 6;
  const ringStart: number[] = [];

  ringStart.push(out.positions.length / 3);
  for (let s = 0; s < segments; s++) {
    const a = (s / segments) * Math.PI * 2;
    out.positions.push(Math.cos(a) * outerRadius, Math.sin(a) * outerRadius, 0);
  }
  for (const cx of centers) {
    ringStart.push(out.positions.length / 3);
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      // The vertex at angle 180° of the right hole and 0° of the left hole both
      // land exactly on the origin, so the weld fuses them into one.
      out.positions.push(cx + Math.cos(a) * radius, Math.sin(a) * radius, 0);
    }
  }
  for (let i = 1; i < ringStart.length; i++) {
    const outer = ringStart[0], inner = ringStart[i];
    for (let s = 0; s < segments; s++) {
      const s2 = (s + 1) % segments;
      out.indices.push(outer + s, outer + s2, inner + s2, outer + s, inner + s2, inner + s);
    }
  }
  return out;
}

/**
 * Two coplanar triangles that SHARE an edge geometrically but not in the index
 * buffer — the seam-split corner (plan-724 T5).
 *
 * Every one of the six attribute vertices is its own index, so the two shared
 * corners exist TWICE at bit-identical positions. That is what a CAD exporter
 * emits whenever two faces disagree about a normal or a UV, and it is the case
 * where a marker driven by raw indices flickers between two entries of the same
 * physical corner. The welded topology must resolve each shared corner to ONE
 * id, which is what `nearestVertexCandidates` is asserted against.
 *
 * Layout (all at z = 0, both wound CCW towards +Z):
 *
 *     (0,1) ── (0,0)══(1,0)          `══` is the shared edge; (0,0) and (1,0)
 *                 ╲    │             each appear once per triangle in the
 *                      (1,-1)        positions array.
 */
export function seamSplitCorner(): MeshData {
  return {
    positions: [
      // triangle A — its own copies of the two shared corners
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      // triangle B — a second, bit-identical copy of the same two corners
      1, 0, 0, 0, 0, 0, 1, -1, 0,
    ],
    indices: [0, 1, 2, 3, 4, 5],
  };
}

/** Flat positions of a {@link MeshData} as raw fixture input. */
export function positionsOf(data: MeshData): Float32Array {
  return new Float32Array(data.positions);
}

/** Flat indices of a {@link MeshData} as raw fixture input. */
export function indicesOf(data: MeshData): Uint32Array {
  return new Uint32Array(data.indices);
}
