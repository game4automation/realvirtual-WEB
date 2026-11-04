// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Candidate collection for the ray basis (plan-664 Phase 1).
 *
 * `rv-ray-scan.ts` is pure and knows nothing about the scene; this module is
 * the other half: once per scan it fills a {@link BoxBuffer} with the WORLD
 * axis-aligned boxes a fan could possibly hit, and nothing else.
 *
 * ## What a ray sensor sees (first implementation stage)
 *
 * - **MUs** — through the transport manager's XZ broad-phase, so 200 pallets in
 *   a yard cost a grid query and not 200 box tests per ray.
 * - **Other vehicles** — their body envelope from `AgvHandle.body()` plus a
 *   height, mapped through the root's world matrix.
 * - **Explicitly marked nodes** — anything a caller hands in (Phase 2 fills this
 *   from the `RayTarget` component).
 *
 * Static scene geometry is NOT in here: mesh-exact static hits are Phase 8,
 * which needs its own allocation-free path through the pick structure. A sensor
 * therefore sees what MOVES, which is what the AGV use case is about.
 *
 * ## Self-exclusion
 *
 * A sensor never sees its own vehicle, and never its own load. Both follow from
 * ONE rule: every candidate whose node sits in the subtree of the sensor's
 * vehicle root is skipped. A carried MU is parented into that subtree, so the
 * parent-chain test covers it — `heldBy` would NOT (it carries a category such
 * as `'grip'`, not the carrier, `rv-mu.ts`). MuJoCo excludes the site's body
 * for the same reason.
 *
 * ## Allocation
 *
 * The buffer grows geometrically and is then reused; a steady-state scan
 * allocates nothing.
 */

import type { Box3, Object3D } from 'three';
import { BOX_STRIDE, HIT_AGV, HIT_MU, HIT_TARGET, type BoxBuffer } from './rv-ray-scan';
import type { AgvBodyInfo, AgvHandle } from './rv-agv-fleet';
import { AGV_NO_BODY_KEY } from './rv-agv-fleet';

/** A node made visible to ray sensors on purpose (Phase 2: the `RayTarget` component). */
export interface RayTargetBox {
  /** The node, for the self-exclusion test. */
  node: Object3D;
  /** Its world AABB; `dynamic` entries are expected to be refreshed by their owner. */
  box: Box3;
}

/** What the query may look at. Every field is optional — a stage can be absent. */
export interface RaySceneSources {
  /** MU broad-phase: fills `out` with the MUs whose AABB overlaps the query box. */
  queryMUs?(min: ArrayLike<number>, max: ArrayLike<number>, out: MuLike[]): number;
  /** Other vehicles (the sensor's own is excluded by the subtree rule). */
  vehicles?: readonly AgvHandle[];
  /** Explicitly marked nodes. */
  targets?: readonly RayTargetBox[];
}

/** The part of an MU this module touches. */
export interface MuLike {
  readonly aabb: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
  readonly node?: Object3D;
}

/** Create an empty buffer with room for `capacity` boxes. */
export function makeBoxBuffer(capacity = 64): BoxBuffer {
  return { bounds: new Float32Array(capacity * BOX_STRIDE), kinds: new Uint8Array(capacity), count: 0 };
}

/** Grow `buf` in place (geometric) so it can hold at least `need` boxes. */
function ensure(buf: BoxBuffer, need: number): void {
  if (buf.kinds.length >= need) return;
  let cap = buf.kinds.length || 16;
  while (cap < need) cap *= 2;
  const bounds = new Float32Array(cap * BOX_STRIDE);
  bounds.set(buf.bounds);
  const kinds = new Uint8Array(cap);
  kinds.set(buf.kinds);
  buf.bounds = bounds;
  buf.kinds = kinds;
}

function push(
  buf: BoxBuffer,
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
  kind: number,
): void {
  ensure(buf, buf.count + 1);
  const o = buf.count * BOX_STRIDE;
  const b = buf.bounds;
  b[o] = minX; b[o + 1] = minY; b[o + 2] = minZ;
  b[o + 3] = maxX; b[o + 4] = maxY; b[o + 5] = maxZ;
  buf.kinds[buf.count] = kind;
  buf.count++;
}

/** Is `node` inside the subtree of `root` (or the root itself)? */
export function isInSubtree(node: Object3D | null | undefined, root: Object3D | null): boolean {
  if (!root || !node) return false;
  for (let n: Object3D | null = node; n; n = n.parent) if (n === root) return true;
  return false;
}

/** Scratch of {@link collectCandidates} — module-level, so a scan allocates nothing. */
const _mus: MuLike[] = [];
const _body: AgvBodyInfo = { front: 0, rear: 0, width: 0 };
const _corners = new Float64Array(24);

/**
 * World AABB of the sensor's reach: a box around `origin` of `reach` in XZ and
 * `height` in Y. One broad-phase box per scan, deliberately NOT a per-ray one —
 * the fan's own bound is what makes the grid query cheap.
 */
export function fanBounds(
  origin: ArrayLike<number>, reach: number, height: number, outMin: Float64Array, outMax: Float64Array,
): void {
  outMin[0] = origin[0] - reach; outMax[0] = origin[0] + reach;
  outMin[1] = origin[1] - height; outMax[1] = origin[1] + height;
  outMin[2] = origin[2] - reach; outMax[2] = origin[2] + reach;
}

/**
 * Collect every candidate box of one scan into `buf` (world axis-aligned).
 *
 * `selfRoot` is the sensor's vehicle root — its whole subtree is skipped (see
 * the module doc). `min`/`max` bound the fan; everything outside is not even
 * looked at.
 */
export function collectCandidates(
  buf: BoxBuffer,
  sources: RaySceneSources,
  selfRoot: Object3D | null,
  min: Float64Array,
  max: Float64Array,
): BoxBuffer {
  buf.count = 0;

  if (sources.queryMUs) {
    const n = sources.queryMUs(min, max, _mus);
    for (let i = 0; i < n; i++) {
      const mu = _mus[i];
      if (isInSubtree(mu.node, selfRoot)) continue;    // own load, carried in the subtree
      const a = mu.aabb;
      push(buf, a.min.x, a.min.y, a.min.z, a.max.x, a.max.y, a.max.z, HIT_MU);
    }
    _mus.length = 0;
  }

  const vehicles = sources.vehicles;
  if (vehicles) {
    for (let i = 0; i < vehicles.length; i++) {
      const h = vehicles[i];
      const node = h.node;
      if (!node || !h.body || isInSubtree(node, selfRoot)) continue;
      h.body(_body);
      pushVehicleHull(buf, node, _body, min, max);
    }
  }

  const targets = sources.targets;
  if (targets) {
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (isInSubtree(t.node, selfRoot)) continue;
      const b = t.box;
      if (b.max.x < min[0] || b.min.x > max[0] || b.max.z < min[2] || b.min.z > max[2]) continue;
      push(buf, b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z, HIT_TARGET);
    }
  }
  return buf;
}

/**
 * World AABB of one vehicle hull.
 *
 * `body()` is in METRES relative to the root and along its LOCAL axes, so the
 * eight corners go through `matrixWorld` — that keeps a rotated, mirrored or
 * scaled root correct, which `motion()` alone would not (and `motion()` is also
 * absent on a legacy vehicle). The height comes from the root's own mesh bounds
 * when it has any, so a scan plane at 0.2 m meets a real forklift and not a
 * zero-height sheet.
 */
function pushVehicleHull(
  buf: BoxBuffer, node: Object3D, body: AgvBodyInfo, min: Float64Array, max: Float64Array,
): void {
  const halfW = body.width / 2;
  const top = hullHeight(node);
  // Local corners: +Z is forward (front), -Z behind (rear).
  const xs = [-halfW, halfW];
  const zs = [-body.rear, body.front];
  const ys = [0, top];
  let k = 0;
  for (const x of xs) for (const y of ys) for (const z of zs) { _corners[k++] = x; _corners[k++] = y; _corners[k++] = z; }
  node.updateWorldMatrix(true, false);
  const m = node.matrixWorld.elements;
  let nx = Infinity, ny = Infinity, nz = Infinity, xx = -Infinity, xy = -Infinity, xz = -Infinity;
  for (let i = 0; i < 24; i += 3) {
    const x = _corners[i], y = _corners[i + 1], z = _corners[i + 2];
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    const iw = w === 0 ? 1 : 1 / w;
    const wx = (m[0] * x + m[4] * y + m[8] * z + m[12]) * iw;
    const wy = (m[1] * x + m[5] * y + m[9] * z + m[13]) * iw;
    const wz = (m[2] * x + m[6] * y + m[10] * z + m[14]) * iw;
    if (wx < nx) nx = wx; if (wx > xx) xx = wx;
    if (wy < ny) ny = wy; if (wy > xy) xy = wy;
    if (wz < nz) nz = wz; if (wz > xz) xz = wz;
  }
  if (xx < min[0] || nx > max[0] || xz < min[2] || nz > max[2]) return;
  push(buf, nx, ny, nz, xx, xy, xz, HIT_AGV);
}

/** Local height (m) of a vehicle root from its own meshes; 1 m when it has none. */
function hullHeight(node: Object3D): number {
  let top = 0;
  node.traverse((c) => {
    if (c.userData?.[AGV_NO_BODY_KEY] === true) return;         // scanner-field overlays, not body
    const g = (c as Object3D & { geometry?: { boundingBox?: Box3 | null; computeBoundingBox?(): void } }).geometry;
    if (!g) return;
    if (!g.boundingBox) g.computeBoundingBox?.();
    const bb = g.boundingBox;
    if (bb && bb.max.y > top) top = bb.max.y;
  });
  return top > 1e-6 ? top : 1;
}
