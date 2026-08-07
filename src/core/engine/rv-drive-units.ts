// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-drive-units — millimetres of drive position → node-LOCAL offset.
 *
 * A linear drive position is a PHYSICAL length in millimetres (the unit the
 * Property Inspector labels and the PLC talks in). The node it moves is
 * addressed in its parent's LOCAL units. Those two coincide only while every
 * ancestor is unscaled — then one local unit is one scene metre and the
 * conversion is the plain `mm / 1000` this codebase has always done.
 *
 * They do NOT coincide inside a CAD subtree. The STEP and JT importers keep the
 * assembly in its native millimetres and put the unit conversion on the CAD
 * ROOT as a node scale (`CADLink.ImportScaleFactor`, 0.001 for both) rather
 * than baking it into the vertices — plan-337 deliberately stopped baking, so
 * the placement matrices stay readable. Inside such a root one local unit is
 * one MILLIMETRE, and `mm / 1000` under-travels by exactly that factor: a
 * 740 mm stroke came out as 0.74 mm, which on a four-metre machine reads as
 * "the axis does not move at all".
 *
 * Dividing by the parent's world scale along the motion direction removes the
 * discrepancy at its source, and it is a strict NO-OP wherever that scale is 1
 * — i.e. for every Unity-exported model (Unity bakes its import scale into the
 * mesh, so a drive there is never in a scaled frame) and every existing test.
 *
 * Rotations are unaffected: an angle has no length, so a scaled frame changes
 * nothing about a revolute drive. Only the linear path calls in here.
 *
 * The consumers on the gizmo side already multiply a local offset BACK by the
 * same parent scale to reach world space (`drive-axis-gizmo-plugin.ts`, limit
 * washers and the drag mapping), so they need no change — with a correct local
 * offset they become correct too.
 */

import { Vector3 } from 'three';
import type { Object3D, Quaternion } from 'three';
import { MM_TO_METERS } from './rv-constants';

/** Below this the direction is degenerate and no scale can be read off it. */
const DIR_EPS = 1e-9;

const _dir = new Vector3();

/**
 * Scene units per node-LOCAL unit along `dirParent` — the length the parent's
 * world matrix gives a unit vector pointing that way.
 *
 * `dirParent` is the motion direction in the node's PARENT frame (i.e. the
 * drive axis already rotated by the node's home orientation), because that is
 * the frame `node.position` lives in.
 *
 * Reads `parent.matrixWorld` as it stands — callers that mutate ancestors in
 * the same tick must refresh it first. Returns 1 for a root node, a degenerate
 * direction, or a collapsed (zero-scale) frame, so the conversion degrades to
 * the historical `mm / 1000` instead of dividing by zero.
 */
export function parentScaleAlong(node: Object3D, dirParent: Vector3): number {
  const parent = node.parent;
  if (!parent) return 1;
  const len = dirParent.length();
  if (len < DIR_EPS) return 1;
  const e = parent.matrixWorld.elements;
  const x = dirParent.x / len;
  const y = dirParent.y / len;
  const z = dirParent.z / len;
  // Upper 3×3 of the parent's world matrix applied to the unit direction.
  const sx = e[0] * x + e[4] * y + e[8] * z;
  const sy = e[1] * x + e[5] * y + e[9] * z;
  const sz = e[2] * x + e[6] * y + e[10] * z;
  const s = Math.hypot(sx, sy, sz);
  return s > DIR_EPS ? s : 1;
}

/**
 * A LINEAR drive position (mm) as the offset to add to `node.position` along
 * `dirParent`.
 *
 * `dirParent` must be the drive axis in the node's PARENT frame; pass the raw
 * local axis only when the node's home orientation is identity.
 */
export function linearPositionToLocalOffset(
  node: Object3D,
  mm: number,
  dirParent: Vector3,
): number {
  return mm / MM_TO_METERS / parentScaleAlong(node, dirParent);
}

/**
 * Same conversion from a LOCAL axis plus the node's home orientation — the form
 * every caller actually has (`getAxis()` + `getHomeLocalQuaternion()`).
 */
export function linearPositionToLocalOffsetFromAxis(
  node: Object3D,
  mm: number,
  localAxis: Vector3,
  homeQuat: Quaternion,
): number {
  _dir.copy(localAxis).applyQuaternion(homeQuat);
  return linearPositionToLocalOffset(node, mm, _dir);
}
