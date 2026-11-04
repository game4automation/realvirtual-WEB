// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-uv-generate — texture coordinates for geometry that arrives without them
 * (SolidCraft, STEP, JT, STL), plan-675 Phase 1.
 *
 * Pure: a BufferGeometry in, a COMPLETE new BufferGeometry out (every attribute
 * carried over, groups kept, the source geometry untouched) — the editor
 * applies it through the existing `replaceNodeGeometry` op, whose undo is the
 * previous geometry.
 *
 * Units are physical so one preset texture tiles the same on a small and a
 * large part (the material's `textureScaleU/V` turns them into tiles):
 *
 *   cylindrical  u = revolutions around the PCA functional axis (θ / 2π),
 *                v = metres along the axis
 *   planar       u, v = metres along the two largest PCA axes
 *   box          per triangle the dominant normal axis of the node frame;
 *                u, v = metres in that plane
 *
 * "Metres" include the node's world scale (`worldScale`, local → metres per
 * local axis), so a SolidCraft body authored in millimetres under a 0.001
 * scale gets the same UVs as one authored in metres.
 *
 * Start phase (cylindrical only): with `phaseSeed` (the caller passes the
 * node path) every u gets a constant offset `hashPhase01(seed)` in [0, 1), so
 * the rollers of one curve do not all start with the same texture phase — a
 * shared runtime offset then keeps each roller's own lag. The offset is added
 * AFTER the seam handling, so seam duplicates keep their u + 1 relative to the
 * shifted values and the u order of every triangle is unchanged. Without a
 * seed there is no offset; planar and box ignore it.
 *
 * Seams: a cylindrical triangle whose corners straddle the θ = ±π cut gets its
 * low-u corners re-pointed at duplicated vertices with u + 1, so no triangle
 * interpolates backwards across the whole texture. A box vertex shared by
 * faces projected onto different planes is duplicated the same way. Duplicates
 * are APPENDED — existing vertices keep their slots and only the affected index
 * entries change. This runs on the editor's unbaked geometry; the bake's
 * "index order is data" contract (contract-bake-picking.md § 1.5) applies to the
 * baked chunks only and is not touched.
 */

import { BufferAttribute, BufferGeometry, Vector3 } from 'three';
import type { InterleavedBufferAttribute } from 'three';
import { analyzeShapePoints, type ShapeClass } from './rv-shape-analysis';

export type UVMode = 'auto' | 'cylindrical' | 'planar' | 'box';
export type ResolvedUVMode = Exclude<UVMode, 'auto'>;

export interface GenerateUVsOptions {
  /** Cylinder axis in the geometry's LOCAL frame (overrides the PCA axis). */
  axis?: Vector3;
  /**
   * Seed for a deterministic per-node start phase (cylindrical only): u is
   * shifted by `hashPhase01(phaseSeed)` revolutions. Omitted → no shift.
   */
  phaseSeed?: string;
}

export interface GenerateUVsResult {
  /** New geometry with `uv` (Float32, vec2); the input is not modified. */
  geometry: BufferGeometry;
  /** The projection actually used (`auto` resolved). */
  mode: ResolvedUVMode;
  /** Shape class `auto` decided on (PCA of the metric vertices). */
  shapeClass: ShapeClass;
  /** Vertices appended for seams / box edges. */
  addedVertices: number;
  /** Cylinder axis in the local frame (cylindrical only). */
  axis?: [number, number, number];
  /** Mean distance of the vertices from the cylinder axis in millimetres (cylindrical only). */
  radiusMm?: number;
  /** The u offset in revolutions that `phaseSeed` produced (cylindrical with a seed only). */
  phase?: number;
}

/**
 * Stable start phase in [0, 1) for a seed string: FNV-1a 32 bit over the UTF-16
 * code units, divided by 2^32. Same seed → same phase on every machine.
 */
export function hashPhase01(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 4294967296;
}

/** Why a geometry cannot get generated UVs (the command reports it as `skipped`). */
export function uvSkipReason(geometry: BufferGeometry): string | null {
  const pos = geometry.getAttribute('position');
  if (!pos || pos.count < 3) return 'no-triangles';
  if (geometry.morphAttributes && Object.keys(geometry.morphAttributes).length > 0) return 'morph-targets';
  if (geometry.getAttribute('skinIndex') || geometry.getAttribute('skinWeight')) return 'skinned';
  return null;
}

/** Pick the projection for a shape class (F2). */
export function modeForShape(shapeClass: ShapeClass): ResolvedUVMode {
  if (shapeClass === 'cylinder-like' || shapeClass === 'disc-like') return 'cylindrical';
  if (shapeClass === 'plate-like') return 'planar';
  return 'box';
}

type Attr = BufferAttribute | InterleavedBufferAttribute;

/**
 * Generate UVs for `geometry` (see module doc). `worldScale` converts local
 * coordinates to metres per axis (the mesh's world scale; `(1,1,1)` for a
 * geometry authored in metres).
 */
export function generateUVs(
  geometry: BufferGeometry,
  mode: UVMode,
  worldScale: Vector3 = new Vector3(1, 1, 1),
  opts: GenerateUVsOptions = {},
): GenerateUVsResult {
  const reason = uvSkipReason(geometry);
  if (reason) throw new Error(`generateUVs: ${reason}`);
  const pos = geometry.getAttribute('position') as Attr;
  const n = pos.count;
  const sx = Math.abs(worldScale.x) || 1;
  const sy = Math.abs(worldScale.y) || 1;
  const sz = Math.abs(worldScale.z) || 1;

  // Metric vertex positions (metres in the node frame).
  const P = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    P[i * 3] = pos.getX(i) * sx;
    P[i * 3 + 1] = pos.getY(i) * sy;
    P[i * 3 + 2] = pos.getZ(i) * sz;
  }
  const shape = analyzeShapePoints(P);
  const [cx, cy, cz] = exactCentroid(P);
  const shapeClass = refineFlatClass(shape.shapeClass, shape.axes, shape.extents, P, cx, cy, cz);
  const resolved: ResolvedUVMode = mode === 'auto' ? modeForShape(shapeClass) : mode;

  // Triangle list over ORIGINAL vertex indices.
  const srcIndex = geometry.getIndex();
  const triCount = srcIndex ? srcIndex.count : n;
  const tri = new Uint32Array(triCount);
  for (let i = 0; i < triCount; i++) tri[i] = srcIndex ? srcIndex.getX(i) : i;

  // Per corner: the vertex variant and its uv. variant 0 = base slot.
  const cornerUV = new Float64Array(triCount * 2);
  const cornerVariant = new Uint8Array(triCount);

  let axisOut: [number, number, number] | undefined;
  let radiusMm: number | undefined;
  let phaseOut: number | undefined;

  if (resolved === 'cylindrical') {
    const a = new Vector3();
    if (opts.axis && opts.axis.lengthSq() > 0) {
      // Local axis → metric frame direction.
      a.set(opts.axis.x * sx, opts.axis.y * sy, opts.axis.z * sz).normalize();
    } else {
      const fa = shape.functionalAxis ?? shape.axes[0];
      a.set(fa[0], fa[1], fa[2]).normalize();
    }
    const b1 = new Vector3();
    const b2 = new Vector3();
    perpendicularBasis(a, b1, b2);
    // Axis as a LOCAL direction for the result (undo the metric scale).
    const al = new Vector3(a.x / sx, a.y / sy, a.z / sz).normalize();
    axisOut = [al.x, al.y, al.z];
    const U = new Float64Array(n);
    const V = new Float64Array(n);
    let rSum = 0;
    for (let i = 0; i < n; i++) {
      const dx = P[i * 3] - cx, dy = P[i * 3 + 1] - cy, dz = P[i * 3 + 2] - cz;
      const along = dx * a.x + dy * a.y + dz * a.z;
      const x1 = dx * b1.x + dy * b1.y + dz * b1.z;
      const x2 = dx * b2.x + dy * b2.y + dz * b2.z;
      U[i] = Math.atan2(x2, x1) / (2 * Math.PI) + 0.5; // [0, 1]
      V[i] = along;
      rSum += Math.hypot(x1, x2);
    }
    radiusMm = (rSum / n) * 1000;
    const phase = opts.phaseSeed !== undefined ? hashPhase01(opts.phaseSeed) : 0;
    if (opts.phaseSeed !== undefined) phaseOut = phase;
    for (let t = 0; t + 2 < triCount; t += 3) {
      const i0 = tri[t], i1 = tri[t + 1], i2 = tri[t + 2];
      const lo = Math.min(U[i0], U[i1], U[i2]);
      const hi = Math.max(U[i0], U[i1], U[i2]);
      const wrap = hi - lo > 0.5;
      for (let k = 0; k < 3; k++) {
        const vi = tri[t + k];
        const shift = wrap && U[vi] < 0.5;
        cornerVariant[t + k] = shift ? 1 : 0;
        cornerUV[(t + k) * 2] = (shift ? U[vi] + 1 : U[vi]) + phase;
        cornerUV[(t + k) * 2 + 1] = V[vi];
      }
    }
  } else if (resolved === 'planar') {
    const e1 = shape.axes[0];
    const e2 = shape.axes[1];
    for (let c = 0; c < triCount; c++) {
      const vi = tri[c];
      const dx = P[vi * 3] - cx, dy = P[vi * 3 + 1] - cy, dz = P[vi * 3 + 2] - cz;
      cornerUV[c * 2] = dx * e1[0] + dy * e1[1] + dz * e1[2];
      cornerUV[c * 2 + 1] = dx * e2[0] + dy * e2[1] + dz * e2[2];
    }
  } else {
    // box: dominant normal axis per triangle in the metric node frame.
    const e1 = new Vector3();
    const e2 = new Vector3();
    const nrm = new Vector3();
    for (let t = 0; t + 2 < triCount; t += 3) {
      const i0 = tri[t], i1 = tri[t + 1], i2 = tri[t + 2];
      e1.set(P[i1 * 3] - P[i0 * 3], P[i1 * 3 + 1] - P[i0 * 3 + 1], P[i1 * 3 + 2] - P[i0 * 3 + 2]);
      e2.set(P[i2 * 3] - P[i0 * 3], P[i2 * 3 + 1] - P[i0 * 3 + 1], P[i2 * 3 + 2] - P[i0 * 3 + 2]);
      nrm.crossVectors(e1, e2);
      const ax = Math.abs(nrm.x), ay = Math.abs(nrm.y), az = Math.abs(nrm.z);
      const face = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
      for (let k = 0; k < 3; k++) {
        const vi = tri[t + k];
        const x = P[vi * 3], y = P[vi * 3 + 1], z = P[vi * 3 + 2];
        cornerVariant[t + k] = face;
        // X face → (z, y), Y face → (x, z), Z face → (x, y)
        cornerUV[(t + k) * 2] = face === 0 ? z : x;
        cornerUV[(t + k) * 2 + 1] = face === 2 ? y : face === 0 ? y : z;
      }
    }
  }

  // ── Resolve corners to vertex slots: the first variant a vertex meets keeps
  // its own slot, every further variant is appended once.
  const VARIANTS = 3;
  const slotOf = new Int32Array(n * VARIANTS).fill(-1);
  const firstVariant = new Int8Array(n).fill(-1);
  const appendedFrom: number[] = [];
  const newIndex = new Uint32Array(triCount);
  let changedCorners = 0;
  for (let c = 0; c < triCount; c++) {
    const vi = tri[c];
    const k = cornerVariant[c];
    let slot = slotOf[vi * VARIANTS + k];
    if (slot < 0) {
      if (firstVariant[vi] < 0) {
        firstVariant[vi] = k;
        slot = vi;
      } else {
        slot = n + appendedFrom.length;
        appendedFrom.push(vi);
      }
      slotOf[vi * VARIANTS + k] = slot;
    }
    if (slot !== vi) changedCorners++;
    newIndex[c] = slot;
  }
  const total = n + appendedFrom.length;

  // uv per slot (all corners of one slot share the same uv by construction).
  const uv = new Float32Array(total * 2);
  for (let c = 0; c < triCount; c++) {
    const s = newIndex[c];
    uv[s * 2] = cornerUV[c * 2];
    uv[s * 2 + 1] = cornerUV[c * 2 + 1];
  }

  // ── Build the complete new geometry.
  const out = new BufferGeometry();
  out.name = geometry.name;
  for (const name of Object.keys(geometry.attributes)) {
    if (name === 'uv') continue;
    out.setAttribute(name, extendAttribute(geometry.getAttribute(name) as Attr, appendedFrom));
  }
  out.setAttribute('uv', new BufferAttribute(uv, 2));
  if (srcIndex || appendedFrom.length > 0 || changedCorners > 0) {
    const IndexArray = total > 65535 ? Uint32Array : Uint16Array;
    out.setIndex(new BufferAttribute(IndexArray.from(newIndex), 1));
  }
  for (const g of geometry.groups) out.addGroup(g.start, g.count, g.materialIndex);
  out.userData = { ...geometry.userData };
  if (geometry.boundingBox) out.computeBoundingBox();
  if (geometry.boundingSphere) out.computeBoundingSphere();

  return {
    geometry: out,
    mode: resolved,
    shapeClass,
    addedVertices: appendedFrom.length,
    ...(axisOut ? { axis: axisOut } : {}),
    ...(radiusMm !== undefined ? { radiusMm } : {}),
    ...(phaseOut !== undefined ? { phase: phaseOut } : {}),
  };
}

/** Copy `attr` and append the items of `appendedFrom` (source vertex indices). */
function extendAttribute(attr: Attr, appendedFrom: readonly number[]): BufferAttribute {
  const size = attr.itemSize;
  const n = attr.count;
  const src = attr as BufferAttribute;
  const Ctor = (src.array?.constructor ?? Float32Array) as { new (len: number): ArrayLike<number> & { [i: number]: number } };
  const arr = new Ctor((n + appendedFrom.length) * size);
  if (!(attr as InterleavedBufferAttribute).isInterleavedBufferAttribute && src.array.length === n * size) {
    (arr as unknown as Float32Array).set(src.array as Float32Array);
  } else {
    for (let i = 0; i < n; i++) for (let k = 0; k < size; k++) arr[i * size + k] = attr.getComponent(i, k);
  }
  for (let j = 0; j < appendedFrom.length; j++) {
    const s = appendedFrom[j];
    for (let k = 0; k < size; k++) arr[(n + j) * size + k] = attr.getComponent(s, k);
  }
  return new BufferAttribute(arr as unknown as Float32Array, size, attr.normalized);
}

/**
 * The PCA classifier's disc/plate split looks at the radius around the PRIMARY
 * axis, which a corner-only mesh (a CAD plate: 8 vertices) passes as "round".
 * For UVs a flat shape only counts as a disc when its two in-plane extents are
 * about equal AND its vertices sit on a circle around the plane normal at many
 * distinct angles; everything else flat is a plate.
 */
function refineFlatClass(
  cls: ShapeClass, axes: [number, number, number][], extents: [number, number, number],
  P: Float64Array, cx: number, cy: number, cz: number,
): ShapeClass {
  if (cls !== 'disc-like' && cls !== 'plate-like') return cls;
  const [e1, e2] = [extents[0], extents[1]];
  if (e2 <= 0 || e1 / e2 > 1.15) return 'plate-like';
  const nrm = axes[2];
  const u = axes[0];
  const w = axes[1];
  const n = P.length / 3;
  let rSum = 0, r2Sum = 0;
  const angles = new Set<number>();
  for (let i = 0; i < n; i++) {
    const dx = P[i * 3] - cx, dy = P[i * 3 + 1] - cy, dz = P[i * 3 + 2] - cz;
    const along = dx * nrm[0] + dy * nrm[1] + dz * nrm[2];
    const px = dx - along * nrm[0], py = dy - along * nrm[1], pz = dz - along * nrm[2];
    const r = Math.hypot(px, py, pz);
    if (r < 1e-9) continue;
    rSum += r; r2Sum += r * r;
    angles.add(Math.round(Math.atan2(px * w[0] + py * w[1] + pz * w[2], px * u[0] + py * u[1] + pz * u[2]) * 180 / Math.PI));
  }
  if (angles.size < 12) return 'plate-like';
  const m = rSum / n;
  const cv = m > 0 ? Math.sqrt(Math.max(0, r2Sum / n - m * m)) / m : 1;
  // A disc's mantle/rim vertices are on one radius; a filled face adds a centre ring — allow spread.
  return cv < 0.35 ? 'disc-like' : 'plate-like';
}

function exactCentroid(P: Float64Array): [number, number, number] {
  const n = P.length / 3;
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < n; i++) { x += P[i * 3]; y += P[i * 3 + 1]; z += P[i * 3 + 2]; }
  return [x / n, y / n, z / n];
}

function perpendicularBasis(a: Vector3, b1: Vector3, b2: Vector3): void {
  // Stable perpendicular: cross with the world axis least aligned to `a`.
  const ax = Math.abs(a.x), ay = Math.abs(a.y), az = Math.abs(a.z);
  const ref = ax <= ay && ax <= az ? new Vector3(1, 0, 0) : ay <= az ? new Vector3(0, 1, 0) : new Vector3(0, 0, 1);
  b1.crossVectors(a, ref).normalize();
  b2.crossVectors(a, b1).normalize();
}
