// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-transport-gizmo-geometry — the pure maths behind the TransportSurface
 * selection gizmo (plan-655 F7).
 *
 * The gizmo used to assume local +Y is up. A SolidCraft body is authored
 * Z-up in millimetres, so its outline stood upright and its arrow pointed into
 * the sky. Everything here works in a CANONICAL frame instead: X = `u`,
 * Y = `n` (the node's local axis that is closest to world up, signed),
 * Z = `u × n`. For a Y-up node that frame is the identity, which keeps the
 * existing gizmo bit-identical.
 *
 * A radial surface (curve, turntable) gets a ring sector instead of a box: its
 * centre is the transport rotation axis at the node origin, its radii and angle
 * range come from the mesh vertices projected into the canonical plane.
 */

import { Matrix4, Quaternion, Shape, ShapeGeometry, Vector2, Vector3 } from 'three';

/** Canonical frame of a surface node: three signed LOCAL unit axes. */
export interface GizmoBasis {
  /** Local axis that maps to canonical +X. */
  readonly u: Vector3;
  /** Local axis closest to world up (canonical +Y). */
  readonly n: Vector3;
  /** `u × n` — canonical +Z. */
  readonly w: Vector3;
  /** Rotation canonical → local (apply to a canonical-frame object parented to the node). */
  readonly quat: Quaternion;
}

const AXES = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];

/**
 * Pick the canonical frame for a node with world rotation `worldQuat`: `n` is
 * the local ±X/±Y/±Z whose world direction is closest to world +Y.
 */
export function gizmoBasis(worldQuat: Quaternion): GizmoBasis {
  // World up expressed in the node's local frame.
  const upLocal = new Vector3(0, 1, 0).applyQuaternion(worldQuat.clone().invert());
  const comps = [upLocal.x, upLocal.y, upLocal.z];
  let k = 1;
  for (let i = 0; i < 3; i++) if (Math.abs(comps[i]) > Math.abs(comps[k]) + 1e-9) k = i;
  const n = AXES[k].clone().multiplyScalar(comps[k] < 0 ? -1 : 1);
  // u = the first remaining axis, positive (X for Y-up and Z-up, Y... never needed but kept total).
  const u = AXES[k === 0 ? 1 : 0].clone();
  const w = new Vector3().crossVectors(u, n);
  const quat = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(u, n, w));
  return { u, n, w, quat };
}

/** Canonical coordinates (cu, cn, cw) of a local point. */
export function toCanonical(b: GizmoBasis, p: Vector3, out = new Vector3()): Vector3 {
  return out.set(p.dot(b.u), p.dot(b.n), p.dot(b.w));
}

/** Angle convention of three's RingGeometry after `rotateX(-π/2)`: from +X towards −Z. */
export function canonicalAngle(cu: number, cw: number): number {
  return Math.atan2(-cw, cu);
}

export interface RadialSector {
  /** True when the vertices cover the whole circle (ring / turntable). */
  readonly full: boolean;
  /** Start angle (radians, canonical convention), 0 for a full ring. */
  readonly thetaStart: number;
  /** Angular length (radians), 2π for a full ring. */
  readonly thetaLength: number;
  readonly rMin: number;
  readonly rMax: number;
}

/**
 * Angle range and radii of mesh vertices around the canonical origin.
 *
 * The range is the complement of the LARGEST angular gap between neighbouring
 * vertex angles (so a sector across 0° wraps correctly). It is a full ring when
 * that gap is smaller than twice the mean angular spacing of the distinct
 * vertex angles (SOL R2-2): a coarsely tessellated ring (32 segments, gaps of
 * 11.25°) is a ring, a real 90° sector (gap 270°) is not.
 */
export function radialSector(points: ReadonlyArray<readonly [number, number]>): RadialSector | null {
  const angles: number[] = [];
  let rMin = Infinity;
  let rMax = 0;
  for (const [cu, cw] of points) {
    const r = Math.hypot(cu, cw);
    if (r < 1e-9) continue;
    rMin = Math.min(rMin, r);
    rMax = Math.max(rMax, r);
    angles.push(canonicalAngle(cu, cw));
  }
  if (angles.length < 2 || rMax <= 0) return null;
  angles.sort((a, b) => a - b);
  const distinct: number[] = [];
  for (const a of angles) if (distinct.length === 0 || a - distinct[distinct.length - 1] > 1e-6) distinct.push(a);
  if (distinct.length < 2) return null;
  let gap = distinct[0] + 2 * Math.PI - distinct[distinct.length - 1]; // wrap gap
  let gapEnd = distinct[0];                                              // angle where the gap ends
  for (let i = 1; i < distinct.length; i++) {
    const g = distinct[i] - distinct[i - 1];
    if (g > gap) { gap = g; gapEnd = distinct[i]; }
  }
  const meanSpacing = (2 * Math.PI) / distinct.length;
  if (gap < 2 * meanSpacing) {
    return { full: true, thetaStart: 0, thetaLength: 2 * Math.PI, rMin: rMin === Infinity ? 0 : rMin, rMax };
  }
  return { full: false, thetaStart: gapEnd, thetaLength: 2 * Math.PI - gap, rMin, rMax };
}

/**
 * Flat arc-arrow (canonical XZ plane, normal +Y) along the circle of radius
 * `rMid` from `thetaFrom` to `thetaTo` (radians, canonical convention; either
 * order — the head sits at `thetaTo`, so the sign of the sweep IS the drawn
 * rotation direction).
 */
export function buildArcArrowGeometry(
  rMid: number, halfShaft: number, halfHead: number, thetaFrom: number, thetaTo: number,
): ShapeGeometry {
  const sweep = thetaTo - thetaFrom;
  const dir = Math.sign(sweep) || 1;
  const total = Math.abs(sweep);
  // Head length along the arc ≈ 2.2 × half head width, at most 40 % of the arc.
  const headAngle = Math.min(total * 0.4, (2.2 * halfHead) / Math.max(rMid, 1e-6));
  const thetaHead = thetaTo - dir * headAngle;
  const steps = Math.max(8, Math.ceil(total / (Math.PI / 48)));
  const at = (r: number, t: number): Vector2 => new Vector2(r * Math.cos(t), r * Math.sin(t));
  const shape = new Shape();
  const outer: Vector2[] = [];
  const inner: Vector2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = thetaFrom + (thetaHead - thetaFrom) * (i / steps);
    outer.push(at(rMid + halfShaft, t));
    inner.push(at(rMid - halfShaft, t));
  }
  shape.moveTo(outer[0].x, outer[0].y);
  for (let i = 1; i < outer.length; i++) shape.lineTo(outer[i].x, outer[i].y);
  const ho = at(rMid + halfHead, thetaHead);
  const tip = at(rMid, thetaTo);
  const hi = at(rMid - halfHead, thetaHead);
  shape.lineTo(ho.x, ho.y);
  shape.lineTo(tip.x, tip.y);
  shape.lineTo(hi.x, hi.y);
  for (let i = inner.length - 1; i >= 0; i--) shape.lineTo(inner[i].x, inner[i].y);
  shape.closePath();
  const geo = new ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2); // XY shape → flat in XZ; +Y angle → −Z (canonical convention)
  return geo;
}
