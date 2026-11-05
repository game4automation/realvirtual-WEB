// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-parametric-assembly — the assembly core of a part family (plan-650 §2.4,
 * F3/F4/F18): turns a validated build plan into a three.js subtree
 * (`_Generated`) from the base parts under `PartsRoot`. Four operations only:
 *
 *  - **duplicate** — an instance without stretch/bend SHARES the base part's
 *    `BufferGeometry` and material (one geometry, many meshes);
 *  - **stretch** — plane-cut shift (`stretchGeometry`): every vertex beyond the
 *    plane moves by Δ along the axis; end regions stay undistorted. Contract:
 *    every triangle that crosses the plane must lie in a plane containing the
 *    axis (`|n · axis| ≤ 1e-4`), shortening must stay short of the nearest
 *    moved vertex — otherwise `stretch-plane-invalid`, never a silent fix;
 *  - **bend** — `bendGeometry` maps a straight part onto a circular arc
 *    (axis coordinate s → angle θ = s / R, transverse offset → radius), after
 *    refining the tessellation along the axis to ≤ 2° per segment; normals are
 *    transformed with the inverse-transpose Jacobian. Stretch runs before bend;
 *  - **place** — position (mm) + rotation (degrees, Euler XYZ).
 *
 * Coordinates: the build plan is expressed in the LOCAL FRAME OF `PartsRoot`
 * (plan-650 §2.3: part-local mm, axes as authored). `_Generated` copies the
 * local transform of `PartsRoot`, so the unit/axis conversion of the family
 * (e.g. a SolidCraft sync root: −90° about X, 0.001) applies to both alike.
 * `unitsPerMm` scales plan millimetres into that frame (default 1 = the frame
 * is in mm).
 *
 * Bend frame: the bend plane is spanned by `axis` and a fixed transverse axis
 * (x → y, y → x, z → x); the third axis is unchanged. `centerSide: '+'` puts
 * the arc centre at transverse +R, so the part bends towards +transverse.
 * `pivot: 'center'` shifts the result by −σR along the transverse axis, so the
 * arc centre sits at the instance origin (a Radial TransportSurface turns
 * about its node origin).
 *
 * Determinism: pure arithmetic over the inputs, no randomness, no clocks —
 * the same plan and parts give bit-identical geometry. Derived geometries are
 * cached per `(part mesh, stretch[], bend)` within one `assemble` call and are
 * OWNED by the result (`ownedGeometries`); base geometries stay with the parts.
 * Throw-free entry `assemble()`; the geometry functions throw `AssemblyError`.
 */

import { referenceForWrite } from '../library/library-reference-write';
import type { DocumentScope } from '../library/library-origin';
import { RV_ASSET_OVERRIDES_KEY, RV_ASSET_REFERENCE_KEY, overrideAddressOf } from './rv-asset-reference';
import { setNodeId } from './rv-node-id';
import type { ParametricUse } from './rv-parametric-component';
import {
  BufferAttribute,
  BufferGeometry,
  Euler,
  Group,
  MathUtils,
  Matrix4,
  Mesh,
  Object3D,
  Vector3,
} from 'three';
import type { Material } from 'three';
import type { Axis, BuildPlan, PartInfo, PlanBend, PlanMessage, PlanStretch, Vec3 } from './rv-parametric-generator';
import { canonicalJSON, sha256HexBytes, type PartHashEntry } from './rv-parametric-hash';
import { getRawOdtDef, getRegisteredSchema } from './rv-component-registry';

// ─── Errors ───────────────────────────────────────────────────────────────

export type AssemblyErrorCode =
  | 'stretch-plane-invalid'
  | 'bend-invalid'
  | 'unknown-part'
  | 'unknown-node'
  | 'unknown-parent'
  | 'parent-cycle'
  | 'parent-depth'
  | 'invalid-name'
  | 'family-no-identity'
  | 'duplicate-name'
  | 'component-invalid'
  | 'parametric-undeclared-child'
  | 'parametric-cross-reference'
  | 'limit-vertices'
  | 'invalid-parts';

export class AssemblyError extends Error {
  constructor(
    readonly code: AssemblyErrorCode,
    message: string,
    /** Machine-readable context (part, axis, offending triangle indices, …) for `web_parametric_inspect`. */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AssemblyError';
  }
}

// ─── Parts ────────────────────────────────────────────────────────────────

/** One mesh of a base part, with its matrix RELATIVE TO THE PART NODE. */
export interface PartMesh {
  name: string;
  geometry: BufferGeometry;
  material: Material | Material[];
  matrix: Matrix4;
}

/** One base part = one direct child of `PartsRoot`. */
export interface ParametricPart {
  name: string;
  node: Object3D;
  meshes: PartMesh[];
  /** What the rule part sees (bounds in the part's own frame, plan units = mm × unitsPerMm). */
  info: PartInfo;
}

const AXIS_INDEX: Record<Axis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };
/** Transverse axis of the bend plane per bend axis (documented in the module header). */
const BEND_TRANSVERSE: Record<Axis, 0 | 1 | 2> = { x: 1, y: 0, z: 0 };

/**
 * Collects the base parts: every direct child of `partsRoot` is one part, its
 * meshes (any depth) with matrices relative to the part. Duplicate part names
 * → `AssemblyError('invalid-parts')`. `unitsPerMm` converts frame units to the
 * millimetres reported in `info.boundsMm`.
 */
export function collectParts(partsRoot: Object3D, unitsPerMm = 1): ParametricPart[] {
  const out: ParametricPart[] = [];
  const seen = new Set<string>();
  for (const node of partsRoot.children) {
    if (seen.has(node.name)) {
      throw new AssemblyError('invalid-parts', `duplicate base part name "${node.name}"`, { part: node.name });
    }
    if (!node.name) throw new AssemblyError('invalid-parts', 'base part without a name', {});
    seen.add(node.name);
    const meshes: PartMesh[] = [];
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    let vertexCount = 0;
    const v = new Vector3();
    const walk = (obj: Object3D, rel: Matrix4): void => {
      for (const child of obj.children) {
        child.updateMatrix();
        const m = rel.clone().multiply(child.matrix);
        const mesh = child as Mesh;
        if (mesh.isMesh && mesh.geometry?.getAttribute('position')) {
          meshes.push({ name: child.name, geometry: mesh.geometry, material: mesh.material, matrix: m });
          const pos = mesh.geometry.getAttribute('position');
          vertexCount += pos.count;
          for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i).applyMatrix4(m);
            for (let k = 0; k < 3; k++) {
              const c = v.getComponent(k);
              if (c < min[k]) min[k] = c;
              if (c > max[k]) max[k] = c;
            }
          }
        }
        walk(child, m);
      }
    };
    walk(node, new Matrix4());
    const s = 1 / unitsPerMm;
    const bounds = meshes.length === 0
      ? { min: [0, 0, 0] as Vec3, max: [0, 0, 0] as Vec3 }
      : { min: min.map((c) => c * s) as Vec3, max: max.map((c) => c * s) as Vec3 };
    out.push({ name: node.name, node, meshes, info: { name: node.name, boundsMm: bounds, vertexCount } });
  }
  return out;
}

/**
 * The `PartsHash` rows of the parts (plan-650 §2.3): local matrix relative to
 * `PartsRoot`, a hash over every mesh's relative matrix + attributes + index,
 * and a material key (name + colour) — renaming, moving or recolouring a part
 * changes its row.
 */
export async function partHashEntries(parts: readonly ParametricPart[]): Promise<PartHashEntry[]> {
  const rows: PartHashEntry[] = [];
  for (const p of parts) {
    p.node.updateMatrix();
    const chunks: Uint8Array[] = [];
    const matKeys: string[] = [];
    for (const m of p.meshes) {
      chunks.push(new Uint8Array(new Float64Array(m.matrix.elements).buffer));
      const g = m.geometry;
      for (const name of Object.keys(g.attributes).sort()) {
        const a = g.getAttribute(name) as BufferAttribute;
        chunks.push(new TextEncoder().encode(`${name}:${a.itemSize}:${a.count}`));
        chunks.push(attributeBytes(a));
      }
      const idx = g.getIndex();
      if (idx) chunks.push(attributeBytes(idx));
      matKeys.push(materialKey(m.material));
    }
    let len = 0;
    for (const c of chunks) len += c.byteLength;
    const all = new Uint8Array(len);
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.byteLength; }
    rows.push({
      name: p.name,
      localMatrix: [...p.node.matrix.elements],
      geometryHash: await sha256HexBytes(all),
      materialKey: matKeys.join('|'),
    });
  }
  return rows;
}

function attributeBytes(a: BufferAttribute): Uint8Array {
  const arr = a.array as ArrayLike<number> & { buffer?: ArrayBufferLike; byteOffset?: number; byteLength?: number };
  if (arr.buffer && arr.byteLength !== undefined) {
    return new Uint8Array(arr.buffer as ArrayBuffer, arr.byteOffset ?? 0, arr.byteLength);
  }
  return new Uint8Array(new Float64Array(Array.from(arr)).buffer);
}

function materialKey(mat: Material | Material[]): string {
  const one = (m: Material): string => {
    const c = (m as Material & { color?: { getHexString(): string } }).color;
    return `${m.name}#${c ? c.getHexString() : ''}`;
  };
  return Array.isArray(mat) ? mat.map(one).join(',') : one(mat);
}

// ─── Stretch ──────────────────────────────────────────────────────────────

/** Unit-normal tolerance of the stretch contract (`|n · axis| ≤ STRETCH_NORMAL_TOL`). */
export const STRETCH_NORMAL_TOL = 1e-4;

/**
 * Plane-cut stretch: returns a NEW geometry in which every vertex with
 * `coord(axis) > atMm` is shifted by `byMm` (same units as the geometry).
 * Normals stay untouched (valid by the contract). Throws
 * `AssemblyError('stretch-plane-invalid')` when a crossing triangle is not
 * parallel to the axis or a shortening reaches the nearest moved vertex.
 */
export function stretchGeometry(geom: BufferGeometry, axis: Axis, atMm: number, byMm: number, label = ''): BufferGeometry {
  const out = geom.clone();
  const pos = out.getAttribute('position') as BufferAttribute;
  const k = AXIS_INDEX[axis];
  const coord = (i: number): number => pos.getComponent(i, k);
  const moving = (i: number): boolean => coord(i) > atMm;
  const index = out.getIndex();
  const triCount = index ? index.count / 3 : pos.count / 3;
  const ia = index ? (index.array as ArrayLike<number>) : null;
  const bad: number[] = [];
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  for (let t = 0; t < triCount; t++) {
    const i0 = ia ? ia[t * 3] : t * 3;
    const i1 = ia ? ia[t * 3 + 1] : t * 3 + 1;
    const i2 = ia ? ia[t * 3 + 2] : t * 3 + 2;
    const m0 = moving(i0), m1 = moving(i1), m2 = moving(i2);
    if (m0 === m1 && m1 === m2) continue;
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    const n = b.sub(a).cross(c.sub(a));
    const len = n.length();
    if (len < 1e-12) continue; // degenerate sliver — shifting keeps it degenerate
    if (Math.abs(n.getComponent(k) / len) > STRETCH_NORMAL_TOL) {
      bad.push(t);
      if (bad.length >= 16) break;
    }
  }
  if (bad.length > 0) {
    throw new AssemblyError(
      'stretch-plane-invalid',
      `stretch of "${label}" along ${axis} at ${atMm}: ${bad.length}${bad.length >= 16 ? '+' : ''} crossing triangle(s) are not parallel to the axis`,
      { part: label, axis, atMm, reason: 'crossing-triangle', triangles: bad },
    );
  }
  if (byMm < 0) {
    let nearest = Infinity;
    for (let i = 0; i < pos.count; i++) {
      const d = coord(i) - atMm;
      if (d > 0 && d < nearest) nearest = d;
    }
    if (nearest !== Infinity && -byMm >= nearest) {
      throw new AssemblyError(
        'stretch-plane-invalid',
        `shortening "${label}" by ${-byMm} along ${axis} reaches the nearest moved vertex (${nearest} beyond the plane at ${atMm})`,
        { part: label, axis, atMm, byMm, reason: 'shorten-overlap', nearest },
      );
    }
  }
  for (let i = 0; i < pos.count; i++) {
    const ci = coord(i);
    if (ci > atMm) pos.setComponent(i, k, ci + byMm);
  }
  pos.needsUpdate = true;
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

// ─── Bend ─────────────────────────────────────────────────────────────────

/** Default maximum arc angle per tessellation segment (F18). */
export const BEND_MAX_SEGMENT_DEG = 2;

/**
 * Bends a straight geometry onto a circular arc (F18). Refines the
 * tessellation along `axis` into equal slabs of ≤ `maxSegmentDeg`, then maps
 * `(s, t) → (r·sin θ, σ·(R − r·cos θ))` with `θ = s/R`, `r = R − σ·t`
 * (σ = +1 for centerSide '+'). Returns a NEW non-indexed geometry. Throws
 * `AssemblyError('bend-invalid')` when a vertex lies at or beyond the centre
 * (r ≤ 0) or the refinement would exceed `maxVertices`.
 */
export function bendGeometry(
  geom: BufferGeometry,
  bend: PlanBend,
  opts: { maxSegmentDeg?: number; maxVertices?: number; label?: string } = {},
): BufferGeometry {
  const label = opts.label ?? '';
  const R = bend.radiusMm;
  const sigma = bend.centerSide === '+' ? 1 : -1;
  const ka = AXIS_INDEX[bend.axis];
  const kt = BEND_TRANSVERSE[bend.axis];
  const maxSeg = MathUtils.degToRad(opts.maxSegmentDeg ?? BEND_MAX_SEGMENT_DEG) * R;
  const pivotShift = bend.pivot === 'center' ? sigma * R : 0;
  const src = geom.index ? geom.toNonIndexed() : geom;
  const names = Object.keys(src.attributes);
  const attrs = names.map((n) => src.getAttribute(n) as BufferAttribute);
  const sizes = attrs.map((a) => a.itemSize);
  const stride = sizes.reduce((x, y) => x + y, 0);
  const pIdx = names.indexOf('position');
  const pOff = sizes.slice(0, pIdx).reduce((x, y) => x + y, 0);
  const count = src.getAttribute('position').count;

  // Interleave all attributes into one float row per vertex (linear interpolation keeps them consistent).
  const rows = new Float64Array(count * stride);
  for (let i = 0; i < count; i++) {
    let o = i * stride;
    for (let a = 0; a < attrs.length; a++) {
      for (let c = 0; c < sizes[a]; c++) rows[o++] = attrs[a].getComponent(i, c);
    }
  }
  let smin = Infinity, smax = -Infinity;
  for (let i = 0; i < count; i++) {
    const s = rows[i * stride + pOff + ka];
    if (s < smin) smin = s;
    if (s > smax) smax = s;
    const r = R - sigma * rows[i * stride + pOff + kt];
    if (!(r > 0)) {
      throw new AssemblyError('bend-invalid', `bend of "${label}": vertex at transverse ${rows[i * stride + pOff + kt]} lies at or beyond the arc centre (R ${R})`, { part: label, reason: 'radius', radiusMm: R });
    }
  }
  const span = smax - smin;
  const slabs = span > 0 ? Math.max(1, Math.ceil(span / maxSeg - 1e-9)) : 1;
  const w = span / slabs;
  const slabOf = (s: number): number => (w > 0 ? Math.min(slabs - 1, Math.max(0, Math.floor((s - smin) / w))) : 0);

  // Upper-bound estimate before allocating (a triangle over k slabs yields ≤ 3k triangles).
  if (opts.maxVertices !== undefined) {
    let est = 0;
    for (let t = 0; t < count; t += 3) {
      const s0 = rows[t * stride + pOff + ka], s1 = rows[(t + 1) * stride + pOff + ka], s2 = rows[(t + 2) * stride + pOff + ka];
      const k = slabOf(Math.max(s0, s1, s2)) - slabOf(Math.min(s0, s1, s2)) + 1;
      est += k === 1 ? 3 : 9 * k;
    }
    if (est > opts.maxVertices) {
      throw new AssemblyError('limit-vertices', `bend of "${label}" would generate up to ${est} vertices (limit ${opts.maxVertices})`, { part: label, estimate: est });
    }
  }

  const outRows: number[] = [];
  const lerp = (p: Float64Array, q: Float64Array, f: number): Float64Array => {
    const r = new Float64Array(stride);
    for (let i = 0; i < stride; i++) r[i] = p[i] + (q[i] - p[i]) * f;
    return r;
  };
  const clip = (poly: Float64Array[], bound: number, keepAbove: boolean): Float64Array[] => {
    const res: Float64Array[] = [];
    const inside = (v: Float64Array): boolean => (keepAbove ? v[pOff + ka] >= bound : v[pOff + ka] <= bound);
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const pin = inside(p), qin = inside(q);
      if (pin) res.push(p);
      if (pin !== qin) {
        const f = (bound - p[pOff + ka]) / (q[pOff + ka] - p[pOff + ka]);
        const v = lerp(p, q, f);
        v[pOff + ka] = bound; // exact on the cut plane
        res.push(v);
      }
    }
    return res;
  };
  const emit = (v: Float64Array): void => { for (let i = 0; i < stride; i++) outRows.push(v[i]); };
  for (let t = 0; t < count; t += 3) {
    const tri = [0, 1, 2].map((j) => rows.subarray((t + j) * stride, (t + j + 1) * stride));
    const ss = tri.map((v) => v[pOff + ka]);
    const k0 = slabOf(Math.min(...ss)), k1 = slabOf(Math.max(...ss));
    if (k0 === k1) { tri.forEach(emit); continue; }
    for (let k = k0; k <= k1; k++) {
      let poly: Float64Array[] = tri.map((v) => Float64Array.from(v));
      if (k > k0) poly = clip(poly, smin + k * w, true);
      if (k < k1 && poly.length) poly = clip(poly, smin + (k + 1) * w, false);
      for (let i = 1; i + 1 < poly.length; i++) {
        if (triArea(poly[0], poly[i], poly[i + 1], pOff) < 1e-12) continue;
        emit(poly[0]); emit(poly[i]); emit(poly[i + 1]);
      }
    }
  }

  // Map onto the arc.
  const outCount = outRows.length / stride;
  const nIdx = names.indexOf('normal');
  const nOff = nIdx >= 0 ? sizes.slice(0, nIdx).reduce((x, y) => x + y, 0) : -1;
  for (let i = 0; i < outCount; i++) {
    const o = i * stride;
    const s = outRows[o + pOff + ka];
    const tv = outRows[o + pOff + kt];
    const theta = s / R;
    const r = R - sigma * tv;
    const cos = Math.cos(theta), sin = Math.sin(theta);
    outRows[o + pOff + ka] = r * sin;
    outRows[o + pOff + kt] = sigma * (R - r * cos) - pivotShift;
    if (nOff >= 0) {
      // Inverse-transpose Jacobian: Rot(θ) · diag(R/r, 1) on (a, t).
      const na = outRows[o + nOff + ka] * (R / r);
      const nt = outRows[o + nOff + kt];
      let ra = na * cos - sigma * sin * nt;
      let rt = sigma * sin * na + cos * nt;
      let rz = outRows[o + nOff + (3 - ka - kt)];
      const l = Math.hypot(ra, rt, rz) || 1;
      ra /= l; rt /= l; rz /= l;
      outRows[o + nOff + ka] = ra;
      outRows[o + nOff + kt] = rt;
      outRows[o + nOff + (3 - ka - kt)] = rz;
    }
  }

  const out = new BufferGeometry();
  let off = 0;
  for (let a = 0; a < attrs.length; a++) {
    const size = sizes[a];
    const data = new Float32Array(outCount * size);
    for (let i = 0; i < outCount; i++) {
      for (let c = 0; c < size; c++) data[i * size + c] = outRows[i * stride + off + c];
    }
    out.setAttribute(names[a], new BufferAttribute(data, size));
    off += size;
  }
  out.computeBoundingBox();
  out.computeBoundingSphere();
  if (src !== geom) src.dispose();
  return out;
}

function triArea(a: Float64Array, b: Float64Array, c: Float64Array, o: number): number {
  const ux = b[o] - a[o], uy = b[o + 1] - a[o + 1], uz = b[o + 2] - a[o + 2];
  const vx = c[o] - a[o], vy = c[o + 1] - a[o + 1], vz = c[o + 2] - a[o + 2];
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

// ─── Components ───────────────────────────────────────────────────────────

/** Returns an error text or null. */
export type ComponentValidator = (type: string, fields: Record<string, unknown>) => string | null;

const SIGNAL_TYPE_RE = /^(PLC(Input|Output)|ConnectSignal$)/;

/**
 * Default validator: the type must be known (rv-ODT `$def` or a registered
 * schema), every field must be declared, signal slots and signal types are
 * forbidden in the MVP (plan-650 §2.5), and a family cannot emit a family.
 */
export const defaultComponentValidator: ComponentValidator = (type, fields) => {
  if (type === 'ParametricComponent') return 'a build plan cannot create a ParametricComponent (nested families: phase 5b)';
  if (SIGNAL_TYPE_RE.test(type)) return `signal type "${type}" is not allowed in a build plan (plan-650 §2.5)`;
  const def = getRawOdtDef(type);
  const schema = getRegisteredSchema(type);
  if (!def && !schema) return `unknown component type "${type}"`;
  const known = new Map<string, boolean>(); // field → is signal slot
  for (const [name, p] of Object.entries(def?.properties ?? {})) known.set(name, !!p.signal);
  for (const [primary, aliases] of Object.entries(def?.aliases ?? {})) {
    for (const a of aliases) known.set(a, known.get(primary) ?? false);
  }
  for (const [name, d] of Object.entries(schema ?? {})) {
    const sig = d.type === 'componentRef' && !!d.signal;
    known.set(name, sig || (known.get(name) ?? false));
    for (const a of d.aliases ?? []) known.set(a, sig || (known.get(a) ?? false));
  }
  for (const f of Object.keys(fields)) {
    if (!known.has(f)) return `${type}.${f} is not a declared field`;
    if (known.get(f)) return `${type}.${f} is a signal slot — signals are not allowed in a build plan (plan-650 §2.5)`;
  }
  return null;
};

// ─── Assemble ─────────────────────────────────────────────────────────────

export interface AssemblyOptions {
  /** Name of the generated root. Default `_Generated`. */
  generatedName?: string;
  /** Plan millimetres → frame units of `PartsRoot`. Default 1. */
  unitsPerMm?: number;
  /** Exact vertex budget over all generated meshes. Default 2 000 000 (F5). */
  maxVertices?: number;
  /** Maximum arc angle per bend segment in degrees. Default 2 (F18). */
  bendMaxSegmentDeg?: number;
  /** Component validation; default {@link defaultComponentValidator}. */
  validateComponent?: ComponentValidator;
  /** Pre-collected parts (otherwise `collectParts(partsRoot)`). */
  parts?: readonly ParametricPart[];
  /** Declared child families (`ParametricComponent.Uses`, plan-650 Phase 5b). */
  uses?: readonly ParametricUse[];
  /** plan-780 R4: project of the family document (null = open project). */
  scope?: DocumentScope;
  /** NodeId prefix of the child reference nodes (`<prefix>:_Children:<i>`); default `'family'`. */
  childIdPrefix?: string;
  /** Undefined uses the direct-assembly default; null means no family identity. */
  familyId?: string | null;
}

/** Name of the group under `_Generated` that holds the child reference nodes. */
export const PARAMETRIC_CHILDREN_ROOT = '_Children';
export const PARAMETRIC_GENERATED_ROOT = '_Generated';

export function parametricGeneratedNodeId(fam: string, name: string): string {
  return `${fam}:${PARAMETRIC_GENERATED_ROOT}:${name}`;
}

/**
 * NodeId of the `i`-th child reference node of the family `prefix`
 * (`<familyNodeId>:_Children:<i>`). plan-769: a NodeId IS an occurrence segment
 * (`<placement>/<refNodeId>`) and the key of an address (`<occ>#<id>`), so it must
 * carry neither `/` nor `#` — the separator here is `:`.
 */
export function parametricChildNodeId(prefix: string, i: number): string {
  return `${prefix}:${PARAMETRIC_CHILDREN_ROOT}:${i}`;
}

const CHILD_PATH_RE = new RegExp(`(^|/)${PARAMETRIC_CHILDREN_ROOT}(/|$)`);

/**
 * plan-650 Phase 5b: the first string in a component's fields that addresses a
 * path through the child holder (`_Children/...`), or null. Walks nested
 * objects / arrays (a `ComponentReference` object carries its path inside).
 */
export function findChildReference(value: unknown, depth = 0): string | null {
  if (depth > 16) return null;
  if (typeof value === 'string') return CHILD_PATH_RE.test(value) ? value : null;
  if (Array.isArray(value)) {
    for (const v of value) { const hit = findChildReference(v, depth + 1); if (hit !== null) return hit; }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      const hit = findChildReference(v, depth + 1);
      if (hit !== null) return hit;
    }
  }
  return null;
}

export interface AssemblyStats {
  instances: number;
  meshes: number;
  /** Exact vertex count over all generated meshes (shared geometry counted per mesh). */
  vertices: number;
  /** Distinct geometries referenced by the result (base + derived). */
  distinctGeometries: number;
  /** Geometries created by stretch/bend (owned by the result). */
  derivedGeometries: number;
}

export type AssemblyResult =
  | {
      ok: true;
      root: Object3D;
      /** Geometries created by this assembly — dispose them with the variant, never the base parts'. */
      ownedGeometries: BufferGeometry[];
      messages: PlanMessage[];
      stats: AssemblyStats;
    }
  | { ok: false; error: { code: AssemblyErrorCode; message: string; details: Record<string, unknown> } };

export const DEFAULT_ASSEMBLY_MAX_VERTICES = 2_000_000;

/**
 * Builds the `_Generated` subtree for `plan` from the parts under `partsRoot`.
 * Throw-free; on failure nothing is returned and all derived geometry is disposed.
 */
export function assemble(partsRoot: Object3D, plan: BuildPlan, opts: AssemblyOptions = {}): AssemblyResult {
  const owned: BufferGeometry[] = [];
  try {
    const prefix = opts.familyId ?? 'family';
    const explicitNames = [...plan.instances.filter((i) => i.name !== undefined).map((i) => i.name!), ...plan.nodes.map((n) => n.name)];
    for (const name of explicitNames) {
      if (/[\/#]/.test(name) || name === PARAMETRIC_CHILDREN_ROOT) {
        throw new AssemblyError('invalid-name', `invalid generated node name "${name}"`, { name });
      }
    }
    if (opts.familyId === null && explicitNames.length > 0) {
      throw new AssemblyError('family-no-identity', 'named generated nodes require a family identity');
    }
    const unitsPerMm = opts.unitsPerMm ?? 1;
    const maxVertices = opts.maxVertices ?? DEFAULT_ASSEMBLY_MAX_VERTICES;
    const validate = opts.validateComponent ?? defaultComponentValidator;
    const parts = opts.parts ?? collectParts(partsRoot, unitsPerMm);
    const byName = new Map(parts.map((p) => [p.name, p]));

    partsRoot.updateMatrix();
    const root = new Group();
    root.name = opts.generatedName ?? PARAMETRIC_GENERATED_ROOT;
    root.position.copy(partsRoot.position);
    root.quaternion.copy(partsRoot.quaternion);
    root.scale.copy(partsRoot.scale);

    const named = new Map<string, Object3D>();
    const explicitTargets = new Map<string, Object3D>();
    const parents = new Map<Object3D, string | undefined>();
    const pendingMeshes: [Object3D, Mesh][] = [];
    const claim = (name: string, obj: Object3D): void => {
      if (named.has(name)) throw new AssemblyError('duplicate-name', `duplicate generated node name "${name}"`, { name });
      named.set(name, obj);
    };
    const place = (obj: Object3D, positionMm: Vec3, rotationDeg?: Vec3): void => {
      obj.position.set(positionMm[0] * unitsPerMm, positionMm[1] * unitsPerMm, positionMm[2] * unitsPerMm);
      if (rotationDeg) {
        obj.quaternion.setFromEuler(new Euler(
          MathUtils.degToRad(rotationDeg[0]), MathUtils.degToRad(rotationDeg[1]), MathUtils.degToRad(rotationDeg[2]), 'XYZ'));
      }
    };

    const derivedCache = new Map<string, BufferGeometry>();
    const geometries = new Set<BufferGeometry>();
    const perPartCounter = new Map<string, number>();
    let vertices = 0;
    let meshes = 0;

    plan.instances.forEach((inst, i) => {
      const part = byName.get(inst.part);
      if (!part) throw new AssemblyError('unknown-part', `instances[${i}].part "${inst.part}" is not a base part`, { part: inst.part });
      const n = perPartCounter.get(part.name) ?? 0;
      perPartCounter.set(part.name, n + 1);
      const node = new Group();
      node.name = inst.name ?? `${part.name}_${n}`;
      claim(node.name, node);
      place(node, inst.positionMm, inst.rotationDeg);
      if (inst.name !== undefined) {
        explicitTargets.set(inst.name, node);
        setNodeId(node, parametricGeneratedNodeId(prefix, inst.name));
      }
      parents.set(node, inst.parent);
      const deform = (inst.stretch && inst.stretch.length > 0) || inst.bend;
      part.meshes.forEach((pm, mi) => {
        let geometry = pm.geometry;
        let matrix: Matrix4 = pm.matrix;
        if (deform) {
          const key = `${part.name}\u0000${mi}\u0000${canonicalJSON({ s: inst.stretch ?? [], b: inst.bend ?? null })}`;
          let g = derivedCache.get(key);
          if (!g) {
            g = deformGeometry(pm, inst.stretch ?? [], inst.bend, unitsPerMm, maxVertices - vertices, opts.bendMaxSegmentDeg, `${part.name}/${pm.name}`, owned);
            derivedCache.set(key, g);
          }
          geometry = g;
          matrix = new Matrix4();
        }
        vertices += geometry.getAttribute('position').count;
        if (vertices > maxVertices) {
          throw new AssemblyError('limit-vertices', `generated vertices exceed ${maxVertices}`, { vertices });
        }
        const mesh = new Mesh(geometry, pm.material);
        mesh.name = pm.name || part.name;
        matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
        pendingMeshes.push([node, mesh]);
        geometries.add(geometry);
        meshes++;
      });
    });

    for (const pn of plan.nodes) {
      const node = new Object3D();
      node.name = pn.name;
      claim(pn.name, node);
      place(node, pn.positionMm, pn.rotationDeg);
      explicitTargets.set(pn.name, node);
      setNodeId(node, parametricGeneratedNodeId(prefix, pn.name));
      parents.set(node, pn.parent);
    }

    // Resolve and validate the whole graph before attaching anything.
    const resolved = new Map<Object3D, Object3D>();
    for (const [obj, parent] of parents) {
      if (parent === undefined) continue;
      const target = explicitTargets.get(parent);
      if (!target) throw new AssemblyError('unknown-parent', `unknown parent "${parent}"`);
      resolved.set(obj, target);
    }
    let maxParentDepth = 0;
    for (const obj of parents.keys()) {
      const seen = new Set<Object3D>();
      let current = obj;
      let depth = 0;
      while (resolved.has(current)) {
        seen.add(current);
        const target = resolved.get(current)!;
        if (seen.has(target)) throw new AssemblyError('parent-cycle', 'cycle in generated parents');
        current = target;
        depth++;
      }
      maxParentDepth = Math.max(maxParentDepth, depth);
    }
    if (maxParentDepth > 16) throw new AssemblyError('parent-depth', 'parent chain exceeds 16 hops');
    for (const [node, mesh] of pendingMeshes) node.add(mesh);
    for (const [obj, parent] of parents) {
      if (parent !== undefined) explicitTargets.get(parent)!.add(obj);
      else root.add(obj);
    }

    plan.components.forEach((c, i) => {
      const target = named.get(c.node);
      if (!target) throw new AssemblyError('unknown-node', `components[${i}].node "${c.node}" names no generated node`, { node: c.node });
      const err = validate(c.type, c.fields);
      if (err) throw new AssemblyError('component-invalid', `components[${i}]: ${err}`, { node: c.node, type: c.type });
      // plan-650 Phase 5b (#209): a child family is a separate placement - its
      // content does not exist in this subtree, so a reference into it can
      // never resolve. Refused instead of an `override-orphaned` later.
      const cross = findChildReference(c.fields);
      if (cross !== null) {
        throw new AssemblyError('parametric-cross-reference',
          `components[${i}] (${c.type} on "${c.node}") references "${cross}" inside a child family - references across the child boundary are not allowed`,
          { node: c.node, type: c.type });
      }
      const rv = (target.userData.realvirtual ??= {}) as Record<string, unknown>;
      if (rv[c.type] !== undefined) {
        throw new AssemblyError('component-invalid', `components[${i}]: node "${c.node}" already has a ${c.type}`, { node: c.node, type: c.type });
      }
      const fields = JSON.parse(JSON.stringify(c.fields)) as Record<string, unknown>;
      const refs = new Map<string, { array: boolean; componentType?: string }>();
      const def = getRawOdtDef(c.type);
      for (const [name, p] of Object.entries(def?.properties ?? {})) {
        const array = p.type === 'array' && p.items?.$ref === '#/$defs/ComponentReference';
        if (p.$ref !== '#/$defs/ComponentReference' && !array) continue;
        // items.refType is supported by the wire schema even on older registry typings.
        const itemType = (p.items as { refType?: string } | undefined)?.refType;
        const ref = { array, componentType: array ? itemType ?? p.refType : p.refType };
        refs.set(name, ref);
        for (const alias of def?.aliases?.[name] ?? []) refs.set(alias, ref);
      }
      for (const [name, d] of Object.entries(getRegisteredSchema(c.type) ?? {})) {
        if (d.type !== 'componentRef' && d.type !== 'componentRefArray') continue;
        const ref = refs.get(name) ?? { array: d.type === 'componentRefArray' };
        if (!refs.has(name)) refs.set(name, ref);
        for (const alias of d.aliases ?? []) if (!refs.has(alias)) refs.set(alias, ref);
      }
      for (const [name, ref] of refs) {
        const rewrite = (value: unknown): unknown => {
          if (typeof value !== 'string') return value;
          if (!explicitTargets.has(value) || !ref.componentType) {
            throw new AssemblyError('component-invalid', `${c.type}.${name}: invalid generated reference "${value}"`, { node: c.node, type: c.type });
          }
          return { type: 'ComponentReference', address: '#' + parametricGeneratedNodeId(prefix, value), componentType: ref.componentType };
        };
        if (Object.prototype.hasOwnProperty.call(fields, name)) {
          fields[name] = ref.array && Array.isArray(fields[name])
            ? (fields[name] as unknown[]).map(rewrite) : rewrite(fields[name]);
        }
      }
      rv[c.type] = fields;
    });

    // plan-650 Phase 5b (R2-2): each child is an EMPTY, non-embedded
    // AssetReference node with a stable NodeId and the fixed child values as
    // its AssetOverrides — no child content in this subtree. The placement
    // instancer materialises it as a nested placement after the parent.
    if (plan.children && plan.children.length > 0) {
      const uses = new Map((opts.uses ?? []).map((u) => [u.Family, u]));
      const holder = new Group();
      holder.name = PARAMETRIC_CHILDREN_ROOT;
      claim(PARAMETRIC_CHILDREN_ROOT, holder);
      const prefix = opts.childIdPrefix ?? 'family';
      plan.children.forEach((c, i) => {
        const use = uses.get(c.family);
        if (!use) {
          throw new AssemblyError('parametric-undeclared-child',
            `children[${i}].family "${c.family}" is not declared in ParametricComponent.Uses`, { family: c.family });
        }
        const node = new Group();
        node.name = String(i);
        place(node, c.positionMm, c.rotationDeg);
        // plan-780 R4: the ONE writer rule; only a non-document child keeps its path fallback.
        const ref: Record<string, unknown> = {
          ...referenceForWrite({ catalogId: use.Family, glbUrl: use.Path, providerId: use.ProviderId, sourceId: use.SourceId }, opts.scope ?? null),
        };
        node.userData.realvirtual = {
          [RV_ASSET_REFERENCE_KEY]: ref,
          // plan-769 F14: the writer form is `byAddress` (`#<id>`), never `byNodeId`.
          [RV_ASSET_OVERRIDES_KEY]: { byAddress: { [overrideAddressOf(use.FamilyNodeId)]: { ParametricComponent: { Values: { ...c.values } } } } },
        };
        setNodeId(node, parametricChildNodeId(prefix, i));
        holder.add(node);
      });
      root.add(holder);
    }

    root.updateMatrixWorld(true);
    return {
      ok: true,
      root,
      ownedGeometries: owned,
      messages: plan.messages.map((m) => ({ ...m })),
      stats: { instances: plan.instances.length, meshes, vertices, distinctGeometries: geometries.size, derivedGeometries: owned.length },
    };
  } catch (err) {
    for (const g of owned) g.dispose();
    if (err instanceof AssemblyError) return { ok: false, error: { code: err.code, message: err.message, details: err.details } };
    return { ok: false, error: { code: 'invalid-parts', message: err instanceof Error ? err.message : String(err), details: {} } };
  }
}

/** Part mesh → part frame (mm) → stretches → bend → back to frame units. */
function deformGeometry(
  pm: PartMesh,
  stretch: readonly PlanStretch[],
  bend: PlanBend | undefined,
  unitsPerMm: number,
  vertexRoom: number,
  maxSegmentDeg: number | undefined,
  label: string,
  owned: BufferGeometry[],
): BufferGeometry {
  // Work in plan millimetres so atMm/byMm/radiusMm apply directly.
  const toMm = new Matrix4().makeScale(1 / unitsPerMm, 1 / unitsPerMm, 1 / unitsPerMm).multiply(pm.matrix);
  let g = pm.geometry.clone().applyMatrix4(toMm);
  for (const s of stretch) {
    const next = stretchGeometry(g, s.axis, s.atMm, s.byMm, label);
    g.dispose();
    g = next;
  }
  if (bend) {
    const next = bendGeometry(g, bend, { maxSegmentDeg, maxVertices: Math.max(0, vertexRoom), label });
    g.dispose();
    g = next;
  }
  if (unitsPerMm !== 1) g.applyMatrix4(new Matrix4().makeScale(unitsPerMm, unitsPerMm, unitsPerMm));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  owned.push(g);
  return g;
}
