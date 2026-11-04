// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-robot-rig.ts — derive a `RobotIK` rig from a robot's scene graph (plan-773
 * Phase 2, decision E5).
 *
 * ## The problem this exists for
 *
 * Rigging a robot by hand means setting seven fields on a component that cannot
 * be added through the generic component route at all (`RobotIK` is not
 * `authorable`), four of which — `a1`, `a2`, `b`, `c1`, `c2`, `c3`, `c4` — are
 * kinematic constants nobody has in their head. Measured on the ONE robot the
 * public library ships, `public/library/Robots/FanucCRX-10iA-L.glb`: it carries
 * nine `Drive`s and **no** `RobotIK`, no `WristType`, no `ToolOffset`, no OPW
 * parameter whatsoever. So for the robot every user meets first, there is no
 * library definition to read the parameters from, and derivation is not the
 * fallback — it is the only path.
 *
 * ## E5 lifted for the library CRX (Thomas, 2026-10-25)
 *
 * That paragraph describes the asset as it was when this module was written.
 * Thomas decided the library robot ships with a logical robot definition
 * instead of a random axis sweep, so `scripts/author-robot-ik.mjs` now WRITES a
 * `RobotIK` (plus a demo `IKPath`, switched off) into the asset — and it writes
 * it with THIS module: it bundles this file and runs `deriveSerialAxisChain` →
 * `chainFromDerivation` → `measureWristType` / `estimateOpwFromChain` →
 * `buildRobotIkRigFields` on the authored tree, exactly what `ik.robot.rig`
 * runs in the browser. There is still one home for the numbers (this
 * derivation); the asset carries its result. Every other robot — a CAD import,
 * a customer model — still gets rigged by derivation at runtime.
 *
 * ## What is MEASURED and what is INFERRED
 *
 * That distinction is the whole point of this module, and {@link OpwEstimate}
 * carries it per field, because an estimate that presents itself as a
 * measurement is worse than no estimate (E5).
 *
 * MEASURED — read straight off the home-pose scene graph, exact:
 *   `c1` axis1→axis2 along the base axis · `a1` the same offset, perpendicular ·
 *   `c2` |axis2→axis3| · `c3`/`a2` the axis3→wrist vector decomposed along and
 *   across the forearm axis · `c4` wrist→flange along the tool axis ·
 *   `b` the lateral offset of the arm plane · `ToolOffset` flange→TCP, in the
 *   flange frame · `WristType`, from the measured distance between the wrist
 *   point and the axis-6 line.
 *
 * INFERRED — one value, by a stated rule, with the measurement it rests on
 * reported next to it: `ElbowInUnityX`, from whether the upper arm at the home
 * pose runs along the base axis or across it.
 *
 * ## Why an approximate OPW is the RIGHT answer for a cobot
 *
 * The OPW model describes a spherical wrist: axes 4, 5 and 6 meeting in one
 * point. A cobot's do not — on the CRX, axis 6 passes 150 mm beside the wrist
 * point — and no choice of `a1..c4` can express that. This is not a weakness of
 * the derivation, it is the model, and it costs nothing where it matters:
 *
 * - `WristType: 'NonSpherical'` routes the solve to `solveCobot`, which works
 *   from the derived {@link JointChainParams} — the exact scene graph — and uses
 *   the OPW parameters only as the analytic cold-start seed
 *   (`CobotSolveOpts.opw`). An approximate seed converges; it does not lie.
 * - `WristType: 'Spherical'` routes to `solvePieper`, which does depend on the
 *   parameters — and for such a robot the measured wrist offset is ~0, so the
 *   decomposition above is exact.
 *
 * The estimate therefore reports `unrepresentableOffsetMm`, and a caller that
 * sees a non-zero value together with `'NonSpherical'` is looking at the
 * expected case, not a defect. {@link OpwEstimate.confidence} says which.
 */

import type { Object3D } from 'three';
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { RVDrive } from './rv-drive';
import type { NodeRegistry } from './rv-node-registry';
import type { JointChainParams, OpwParams } from './rv-ik-solver';
import { DriveDirection, directionToGltfAxis, isRotation } from './rv-coordinate-utils';
import {
  angleBetweenDeg, type Vec3, vecCross, vecDot, vecLength, vecNormalize,
  vecRejectFrom, vecSub,
} from './rv-robot-fk';

/** Below this, two directions count as the same axis / two points as one point. */
const PARALLEL_TOLERANCE_DEG = 1;
/** Below this (meters) a measured offset counts as zero — 1 mm, the export's own precision. */
const ZERO_OFFSET_M = 1e-3;

// ─── Serial chain discovery ──────────────────────────────────────────────

/** What {@link deriveSerialAxisChain} found, or why it found nothing usable. */
export interface SerialChainDerivation {
  /** The ordered rotary axis drives, base first. Six on success, fewer on failure. */
  axes: RVDrive[];
  /** The TCP node, when the rig has one (a robot without is the flange case). */
  tcp: Object3D | null;
  /** How the TCP was identified — so a caller can see it was not guessed blindly. */
  tcpReason: 'named-tcp' | 'name-contains-tcp' | 'none';
  /** Null on success; otherwise the reason, in the wording the Problems panel uses. */
  failure: string | null;
  /** Every rotary drive seen, even when the chain was rejected — for the report. */
  rotaryCandidates: Object3D[];
  /** Drives skipped because they are linear or virtual (gripper fingers, etc.). */
  nonRotaryCandidates: Object3D[];
}

/** `node` is `ancestor` itself or below it. */
function isDescendantOf(node: Object3D, ancestor: Object3D): boolean {
  let a: Object3D | null = node;
  while (a) {
    if (a === ancestor) return true;
    a = a.parent;
  }
  return false;
}

/** Depth of `node` below `root` (root = 0), or -1 when it is not below it. */
function depthBelow(node: Object3D, root: Object3D): number {
  let d = 0;
  let a: Object3D | null = node;
  while (a) {
    if (a === root) return d;
    a = a.parent;
    d++;
  }
  return -1;
}

/**
 * Find the robot's six rotary axis drives, base first, and its TCP node.
 *
 * The rule is the one `RVRobotIK.computeJointChain()` already enforces when it
 * accepts a chain, applied in the other direction: a rotary drive per joint,
 * each one a DESCENDANT of the previous. Sorting the rotary drives by depth and
 * then verifying the descendant relation pairwise is enough, because a serial
 * chain is exactly a total order under "is below" — and the verification is
 * what turns the sort into a measurement rather than a hope.
 *
 * Linear and virtual drives are skipped and reported, not counted: the CRX
 * carries three of them (the Schunk gripper's cylinder and its two fingers),
 * and a derivation that counted drives would see nine axes on a six-axis robot.
 */
export function deriveSerialAxisChain(root: Object3D, drives: readonly RVDrive[]): SerialChainDerivation {
  const rotary: RVDrive[] = [];
  const nonRotaryCandidates: Object3D[] = [];
  for (const d of drives) {
    if (!isDescendantOf(d.node, root)) continue;
    if (isRotation(d.Direction)) rotary.push(d);
    else nonRotaryCandidates.push(d.node);
  }
  rotary.sort((a, b) => depthBelow(a.node, root) - depthBelow(b.node, root));
  const rotaryCandidates = rotary.map((d) => d.node);

  const base = {
    tcp: null as Object3D | null,
    tcpReason: 'none' as SerialChainDerivation['tcpReason'],
    rotaryCandidates,
    nonRotaryCandidates,
  };

  if (rotary.length < 6) {
    return {
      ...base,
      axes: rotary,
      failure: `Found ${rotary.length} rotary drive(s) under "${root.name || '(unnamed)'}"; `
        + 'a RobotIK rig models exactly 6 revolute axes. '
        + (nonRotaryCandidates.length > 0
          ? `${nonRotaryCandidates.length} further drive(s) are linear or virtual and were not counted.`
          : 'Add the missing axis Drives, or rig this robot by hand.'),
    };
  }

  // More than six rotary drives is not an error by itself — a robot may carry a
  // rotary gripper or a turntable below the flange. Take the six that form the
  // chain from the base down, and let the descendant check below reject a set
  // that does not.
  const axes = rotary.slice(0, 6);
  for (let i = 1; i < 6; i++) {
    if (!isDescendantOf(axes[i].node, axes[i - 1].node)) {
      return {
        ...base,
        axes,
        failure: `"${axes[i].node.name || '(unnamed)'}" is not below "${axes[i - 1].node.name || '(unnamed)'}", `
          + 'so the rotary drives are siblings rather than a serial chain. A RobotIK rig needs each axis '
          + 'nested inside the previous one; nest them in the asset editor (editor.reparent) first.',
      };
    }
  }

  const tcp = findTcpNode(axes[5].node);
  return { ...base, axes, tcp: tcp?.node ?? null, tcpReason: tcp?.reason ?? 'none', failure: null };
}

/**
 * The TCP node below the axis-6 node.
 *
 * Exact name `TCP` first, a name CONTAINING "tcp" second, nothing third — and
 * the caller is told which, because "I picked the only node whose name mentions
 * TCP" and "the file names its TCP" are different claims. A robot without one
 * is the documented flange-plus-`ToolOffset` rig, not a defect.
 */
function findTcpNode(axis6: Object3D): { node: Object3D; reason: 'named-tcp' | 'name-contains-tcp' } | null {
  let exact: Object3D | null = null;
  let fuzzy: Object3D | null = null;
  axis6.traverse((n) => {
    if (n === axis6) return;
    const name = n.name ?? '';
    if (!exact && name.toUpperCase() === 'TCP') exact = n;
    else if (!fuzzy && name.toUpperCase().includes('TCP')) fuzzy = n;
  });
  if (exact) return { node: exact, reason: 'named-tcp' };
  if (fuzzy) return { node: fuzzy, reason: 'name-contains-tcp' };
  return null;
}

// ─── Geometry measured off the derived chain ─────────────────────────────

/** One measured geometric quantity, with the name the report shows. */
export interface ChainMeasurement {
  /** What was measured, e.g. `axis2-axis3-length`. */
  name: string;
  /** The value, in the unit `unit` names. */
  value: number;
  unit: 'm' | 'mm' | 'deg';
  /** What it means, in one sentence — the report is read by people, not only by agents. */
  note: string;
}

/** Axis origins and directions of the chain at its HOME pose, robot-local. */
export interface ChainGeometry {
  /** Axis origin per joint, robot-local meters. */
  origins: Vec3[];
  /** Unit rotation direction per joint, robot-local. */
  directions: Vec3[];
  /** The flange (axis-6) origin — `origins[5]`, named for readability. */
  flange: Vec3;
  /** TCP position relative to the flange, in the FLANGE frame — `RobotIK.ToolOffset`. */
  toolOffset: Vec3;
  /** The wrist point: where the axis-4 and axis-5 lines come closest. */
  wrist: Vec3;
  /** How far apart those two lines are there — 0 for a textbook wrist. */
  wristLineGapM: number;
  /** Distance from the wrist point to the axis-6 LINE: 0 = spherical wrist. */
  wristToAxis6M: number;
}

/**
 * Axis origins and directions at the home pose, from the chain the robot
 * already derives. Reusing {@link JointChainParams} rather than walking the
 * scene again is deliberate: the chain IS the rig's own view of its geometry,
 * so a derivation built on it cannot disagree with the solver about where an
 * axis is.
 */
export function chainGeometry(chain: JointChainParams): ChainGeometry {
  const { quatMul, quatRotate } = geomHelpers();
  const origins: Vec3[] = [];
  const directions: Vec3[] = [];

  let pos: Vec3 = [chain.axisHomePos[0], chain.axisHomePos[1], chain.axisHomePos[2]];
  let rot: [number, number, number, number] = [
    chain.axisHomeRot[0], chain.axisHomeRot[1], chain.axisHomeRot[2], chain.axisHomeRot[3],
  ];
  origins.push(pos);
  directions.push(vecNormalize(quatRotate(rot, [chain.axisDir[0], chain.axisDir[1], chain.axisDir[2]])));
  for (let i = 1; i < 6; i++) {
    const off = quatRotate(rot, [chain.axisHomePos[i * 3], chain.axisHomePos[i * 3 + 1], chain.axisHomePos[i * 3 + 2]]);
    pos = [pos[0] + off[0], pos[1] + off[1], pos[2] + off[2]];
    rot = quatMul(rot, [
      chain.axisHomeRot[i * 4], chain.axisHomeRot[i * 4 + 1],
      chain.axisHomeRot[i * 4 + 2], chain.axisHomeRot[i * 4 + 3],
    ]);
    origins.push(pos);
    directions.push(vecNormalize(quatRotate(rot, [
      chain.axisDir[i * 3], chain.axisDir[i * 3 + 1], chain.axisDir[i * 3 + 2],
    ])));
  }

  const flange = origins[5];
  const { point: wrist, gap: wristLineGapM } = closestPointBetweenLines(
    origins[3], directions[3], origins[4], directions[4],
  );
  const wristToAxis6M = distancePointToLine(wrist, origins[5], directions[5]);

  return {
    origins,
    directions,
    flange,
    // `tcpLocalOffset` is already expressed in the axis-6 (flange) frame, which
    // is exactly what `RobotIK.ToolOffset` is — no re-derivation needed.
    toolOffset: [...chain.tcpLocalOffset] as Vec3,
    wrist,
    wristLineGapM,
    wristToAxis6M,
  };
}

/** Local copies so this module needs no three.js and no import cycle. */
function geomHelpers() {
  return {
    quatMul(a: [number, number, number, number], b: [number, number, number, number]): [number, number, number, number] {
      return [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
      ];
    },
    quatRotate(q: [number, number, number, number], v: Vec3): Vec3 {
      const [x, y, z, w] = q;
      const tx = 2 * (y * v[2] - z * v[1]);
      const ty = 2 * (z * v[0] - x * v[2]);
      const tz = 2 * (x * v[1] - y * v[0]);
      return [
        v[0] + w * tx + (y * tz - z * ty),
        v[1] + w * ty + (z * tx - x * tz),
        v[2] + w * tz + (x * ty - y * tx),
      ];
    },
  };
}

/** Perpendicular distance from a point to the line `(origin, dir)`. */
export function distancePointToLine(point: Vec3, origin: Vec3, dir: Vec3): number {
  return vecLength(vecRejectFrom(vecSub(point, origin), vecNormalize(dir)));
}

/**
 * The midpoint of the shortest segment between two lines, plus that segment's
 * length. For intersecting lines it IS the intersection and the gap is 0; for
 * parallel lines it falls back to the projection of `o2` onto line 1, which is
 * the only defensible answer and comes with a non-zero gap so a caller can see
 * the degeneracy.
 */
export function closestPointBetweenLines(
  o1: Vec3, d1: Vec3, o2: Vec3, d2: Vec3,
): { point: Vec3; gap: number } {
  const u = vecNormalize(d1);
  const v = vecNormalize(d2);
  const w = vecSub(o2, o1);
  const uv = vecDot(u, v);
  const den = 1 - uv * uv;
  if (Math.abs(den) < 1e-9) {
    // Parallel: every point of line 1 is equidistant. Project `o2` onto it.
    const t = vecDot(w, u);
    const p: Vec3 = [o1[0] + t * u[0], o1[1] + t * u[1], o1[2] + t * u[2]];
    return { point: p, gap: vecLength(vecSub(o2, p)) };
  }
  const s = (vecDot(w, u) - uv * vecDot(w, v)) / den;
  const t = (uv * vecDot(w, u) - vecDot(w, v)) / den;
  const p1: Vec3 = [o1[0] + s * u[0], o1[1] + s * u[1], o1[2] + s * u[2]];
  const p2: Vec3 = [o2[0] + t * v[0], o2[1] + t * v[1], o2[2] + t * v[2]];
  return {
    point: [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2, (p1[2] + p2[2]) / 2],
    gap: vecLength(vecSub(p1, p2)),
  };
}

// ─── Wrist type ──────────────────────────────────────────────────────────

/** The measured verdict on the wrist, with the number it rests on. */
export interface WristVerdict {
  wristType: 'Spherical' | 'NonSpherical';
  /** Distance from the wrist point to the axis-6 line, in mm. 0 ⇒ spherical. */
  offsetMm: number;
  /** The one-sentence justification, for the MCP answer and the report. */
  evidence: string;
}

/**
 * Decide `WristType` by MEASUREMENT, not by the schema default.
 *
 * A spherical wrist is defined by axes 4, 5 and 6 meeting in one point. Axes 4
 * and 5 are taken as given (their closest approach is the wrist point, and its
 * `wristLineGapM` is reported when they miss each other); the question is
 * whether axis 6 passes through it. On the library CRX it passes 150 mm beside
 * it, which is why that robot MUST be rigged `'NonSpherical'`: the schema
 * default is `'Spherical'`, and a cobot solved analytically with a spherical
 * model is the silent wrong answer `robot-ik-wrist-type-missing` warns about.
 */
export function measureWristType(geom: ChainGeometry): WristVerdict {
  const offsetMm = geom.wristToAxis6M * 1000;
  const spherical = geom.wristToAxis6M <= ZERO_OFFSET_M;
  return {
    wristType: spherical ? 'Spherical' : 'NonSpherical',
    offsetMm,
    evidence: spherical
      ? `Axes 4, 5 and 6 meet within ${offsetMm.toFixed(2)} mm, so the wrist is spherical `
        + 'and the analytic Pieper solver models it exactly.'
      : `Axis 6 passes ${offsetMm.toFixed(1)} mm beside the point where axes 4 and 5 meet, so the wrist `
        + 'is NOT spherical. The rig is set to NonSpherical, which routes the solve to the numerical '
        + 'cobot solver over the derived joint chain (Pro tier) instead of the analytic OPW model.',
  };
}

// ─── OPW estimation ──────────────────────────────────────────────────────

/** Where one OPW field's value came from. */
export type OpwFieldSource = 'measured' | 'measured-zero' | 'inferred';

/** The confidence verdict of a whole estimate. */
export type OpwConfidence = 'exact' | 'seed-only';

/** OPW parameters with their provenance — never a bare number set (E5). */
export interface OpwEstimate {
  /** The parameters, ready for `RobotIK` extras and `solvePieper`. */
  params: OpwParams;
  /** `RobotIK.ToolOffset` — flange→TCP in the flange frame, meters. */
  toolOffset: Vec3;
  /** Per field: measured off the chain, measured as zero, or inferred by a rule. */
  sources: Record<'a1' | 'a2' | 'b' | 'c1' | 'c2' | 'c3' | 'c4' | 'ElbowInUnityX', OpwFieldSource>;
  /**
   * `'exact'` — the OPW model describes this robot and these values reproduce
   * its geometry. `'seed-only'` — the robot has geometry OPW cannot express
   * (see {@link unrepresentableOffsetMm}); the values are a valid cold-start
   * seed for the cobot solver and nothing more.
   */
  confidence: OpwConfidence;
  /** Geometry the OPW model cannot carry, in mm. 0 for a spherical wrist. */
  unrepresentableOffsetMm: number;
  /** Everything that was measured, named — the audit trail of the numbers above. */
  measurements: ChainMeasurement[];
  /** The assumptions of the OPW model and how far this robot deviates from each. */
  assumptions: ChainMeasurement[];
  /** One paragraph a human can read instead of the tables. */
  summary: string;
}

/**
 * Derive OPW parameters from the measured chain geometry.
 *
 * Every length below is a projection of a measured inter-axis vector onto a
 * measured axis direction, so each is a number taken off the robot rather than
 * a fit. The `sources` map records which; `confidence` records whether the
 * model can carry the result at all.
 */
export function estimateOpwFromChain(chain: JointChainParams, elbowHint?: boolean): OpwEstimate {
  const geom = chainGeometry(chain);
  const [p1, p2, p3] = geom.origins;
  const d1 = geom.directions[0];
  const d2 = geom.directions[1];
  const d3 = geom.directions[2];
  const d4 = geom.directions[3];
  const d6 = geom.directions[5];

  // ── Why every length below is a MAGNITUDE ───────────────────────────────
  //
  // A projection onto an axis direction is signed, and the sign is useless
  // here: `axisDir` carries the drive's ROTATION SENSE (`directionToGltfAxis`
  // plus `ReverseDirection`), not the direction the arm extends in. On the
  // library CRX the forearm's axis-4 drive is `RotationX` with
  // `ReverseDirection: true`, so its direction points AGAINST the forearm and a
  // signed `c3` came out as -0.54 m for a 540 mm forearm.
  //
  // So each length is taken as the distance along the axis LINE, oriented by the
  // arm itself. The cost is real and is reported in `assumptions`: a robot whose
  // OPW `a2` or `b` is genuinely negative cannot be told from one where it is
  // positive by geometry alone, and needs that sign set by hand.

  // c1 / a1 — axis 1 to axis 2, split along and across the base axis.
  const v12 = vecSub(p2, p1);
  const c1 = Math.abs(vecDot(v12, d1));
  const a1Vec = vecRejectFrom(v12, d1);
  const a1 = vecLength(a1Vec);

  // c2 — the upper arm. Measured as the plain distance axis2→axis3, which is
  // what OPW's c2 is for a robot whose axes 2 and 3 are parallel (checked below).
  const v23 = vecSub(p3, p2);
  const c2 = vecLength(v23);

  // c3 / a2 — axis 3 to the wrist point, split along and across the forearm
  // axis (axis 4). This is exactly OPW's split: c3 runs along the forearm, a2
  // is the elbow's perpendicular offset.
  const v3w = vecSub(geom.wrist, p3);
  const c3 = Math.abs(vecDot(v3w, d4));
  const a2Vec = vecRejectFrom(v3w, d4);
  const a2 = vecLength(a2Vec);

  // c4 — the wrist point to the flange, along the tool axis. Whatever is left
  // perpendicular is the offset OPW cannot carry (the cobot case).
  const vwf = vecSub(geom.flange, geom.wrist);
  const c4 = Math.abs(vecDot(vwf, d6));
  const unrepresentable = vecLength(vecRejectFrom(vwf, d6));

  // b — the lateral offset of the arm from the base axis.
  //
  // The arm plane's normal IS the axis-2 direction: axes 2 and 3 are parallel
  // and both perpendicular to the plane the arm swings in. Taking it from
  // `d2` rather than from `cross(baseAxis, upperArm)` matters, because that
  // cross product DEGENERATES for the common robot whose upper arm points
  // straight up at the home pose (the two are parallel, the cross product is
  // zero, and `b` would come out 0 by accident rather than by measurement).
  const planeNormal = vecNormalize(d2);
  const b = vecLength(planeNormal) > 0 ? Math.abs(vecDot(vecSub(geom.wrist, p1), planeNormal)) : 0;

  // ElbowInUnityX — the ONE inferred value. It flips the 90° offset the Pieper
  // core applies to joint 3, which corresponds to whether the upper arm at the
  // home pose runs ALONG the base axis (arm up) or ACROSS it (arm forward).
  const upperArmToBaseDeg = vecLength(v23) > ZERO_OFFSET_M ? angleBetweenDeg(v23, d1) : 0;
  const elbowInUnityX = elbowHint ?? (Math.abs(upperArmToBaseDeg - 90) < 45);

  const src = (value: number): OpwFieldSource => (Math.abs(value) <= ZERO_OFFSET_M ? 'measured-zero' : 'measured');

  const measurements: ChainMeasurement[] = [
    { name: 'c1', value: c1, unit: 'm', note: 'Axis 1 to axis 2, measured along the base axis.' },
    { name: 'a1', value: a1, unit: 'm', note: 'Axis 1 to axis 2, measured across the base axis.' },
    { name: 'c2', value: c2, unit: 'm', note: 'Distance from axis 2 to axis 3 (the upper arm).' },
    { name: 'c3', value: c3, unit: 'm', note: 'Axis 3 to the wrist point, along the forearm axis.' },
    { name: 'a2', value: a2, unit: 'm', note: "Axis 3 to the wrist point, across the forearm axis (the elbow's offset)." },
    { name: 'c4', value: c4, unit: 'm', note: 'Wrist point to the flange, along the tool axis.' },
    { name: 'b', value: b, unit: 'm', note: 'Lateral offset of the arm plane from the base axis.' },
    {
      name: 'toolOffsetLength', value: vecLength(geom.toolOffset), unit: 'm',
      note: 'Flange to TCP, in the flange frame — written to RobotIK.ToolOffset.',
    },
    {
      name: 'upperArmToBaseAngle', value: upperArmToBaseDeg, unit: 'deg',
      note: 'Angle between the upper arm and the base axis at the home pose — what ElbowInUnityX is inferred from.',
    },
  ];

  const assumptions: ChainMeasurement[] = [
    {
      name: 'axis2-axis3-parallel', value: Math.min(angleBetweenDeg(d2, d3), 180 - angleBetweenDeg(d2, d3)),
      unit: 'deg', note: 'OPW assumes axes 2 and 3 are parallel. This is how far this robot is from that.',
    },
    {
      name: 'axis1-axis2-perpendicular', value: Math.abs(angleBetweenDeg(d1, d2) - 90),
      unit: 'deg', note: 'OPW assumes axis 1 is perpendicular to axis 2. Deviation.',
    },
    {
      name: 'wrist-axis4-axis5-gap', value: geom.wristLineGapM * 1000,
      unit: 'mm', note: 'How far the axis-4 and axis-5 lines miss each other. OPW assumes they meet.',
    },
    {
      name: 'wrist-axis6-offset', value: geom.wristToAxis6M * 1000,
      unit: 'mm', note: 'How far axis 6 passes beside the wrist point. OPW assumes 0 (spherical wrist).',
    },
    {
      name: 'parameter-signs-not-derivable', value: Math.max(a2, Math.abs(b)) * 1000,
      unit: 'mm',
      note: 'Every length is reported as a MAGNITUDE: a drive direction encodes a rotation sense, not the '
        + 'direction the arm extends in, so no sign can be read off the scene graph. This is the largest '
        + 'offset whose sign is therefore unknown (a2 and b) — 0 means nothing is affected. A robot whose '
        + 'OPW a2 or b is genuinely negative needs that sign set by hand.',
    },
  ];

  const exact = unrepresentable <= ZERO_OFFSET_M
    && geom.wristLineGapM <= ZERO_OFFSET_M
    && assumptions[0].value <= PARALLEL_TOLERANCE_DEG;

  return {
    params: { a1, a2, b, c1, c2, c3, c4, elbowInUnityX, toolOffset: [...geom.toolOffset] as Vec3 },
    toolOffset: [...geom.toolOffset] as Vec3,
    sources: {
      a1: src(a1), a2: src(a2), b: src(b), c1: src(c1), c2: src(c2), c3: src(c3), c4: src(c4),
      ElbowInUnityX: elbowHint === undefined ? 'inferred' : 'measured',
    },
    confidence: exact ? 'exact' : 'seed-only',
    unrepresentableOffsetMm: unrepresentable * 1000,
    measurements,
    assumptions,
    summary: exact
      ? 'Every OPW parameter was measured off this robot\'s own joint chain and the OPW model '
        + 'describes it within 1 mm and 1 deg, so the analytic solve is exact. ElbowInUnityX is the one '
        + 'INFERRED value (from the home-pose arm direction) — verify it with web_query("ik.robot.verifyFk", {path}).'
      : `Every OPW parameter was measured off this robot's own joint chain, but the OPW model cannot `
        + `carry all of its geometry: ${(unrepresentable * 1000).toFixed(1)} mm of the wrist offset has no `
        + 'OPW equivalent. These values are therefore a valid cold-start SEED for the numerical cobot '
        + 'solver (which works from the exact joint chain, not from these numbers) and must not be read as '
        + 'a kinematic datasheet. ElbowInUnityX is inferred, not measured.',
  };
}

// ─── The rig payload ─────────────────────────────────────────────────────

/** A stored rv-ODT reference in the form the inspector writes (path form). */
export interface StoredComponentRef {
  type: 'ComponentReference';
  path: string;
  componentType: string;
}

/** The `RobotIK` extras block a rig consists of, ready to be written. */
export interface RobotIkRigFields {
  Axis: StoredComponentRef[];
  TCP?: string;
  WristType: 'Spherical' | 'NonSpherical';
  ElbowInUnityX: boolean;
  DrawGizmos: boolean;
  a1: number; a2: number; b: number;
  c1: number; c2: number; c3: number; c4: number;
  ToolOffset: { x: number; y: number; z: number };
}

/**
 * Build the `RobotIK` extras block.
 *
 * `Axis` entries are path-form `ComponentReference`s — the same form
 * `makeComponentReference()` writes when a reference is picked in the
 * inspector; the save turns them into plan-769 addresses. `TCP` is a plain
 * node-path STRING, because that is what Unity's exporter writes for a
 * GameObject reference and what `RVRobotIK.resolveTcpNode()` reads (it accepts
 * both forms, and the string is the one the bake survival table keys on through
 * `pathStringEntries('RobotIK', 'merge')`).
 */
export function buildRobotIkRigFields(
  registry: NodeRegistry,
  derivation: SerialChainDerivation,
  estimate: OpwEstimate,
  wrist: WristVerdict,
): RobotIkRigFields | { error: string } {
  const axisPaths: string[] = [];
  for (const d of derivation.axes) {
    const path = registry.getPathForNode(d.node);
    if (!path) {
      return {
        error: `The axis node "${d.node.name || '(unnamed)'}" has no registry path, so no reference can name it. `
          + 'In a baked model only claimed nodes are addressable — rig this robot in the asset editor.',
      };
    }
    axisPaths.push(path);
  }
  const fields: RobotIkRigFields = {
    Axis: axisPaths.map((path) => ({ type: 'ComponentReference', path, componentType: 'Drive' })),
    WristType: wrist.wristType,
    ElbowInUnityX: estimate.params.elbowInUnityX,
    DrawGizmos: true,
    a1: estimate.params.a1,
    a2: estimate.params.a2,
    b: estimate.params.b,
    c1: estimate.params.c1,
    c2: estimate.params.c2,
    c3: estimate.params.c3,
    c4: estimate.params.c4,
    ToolOffset: { x: estimate.toolOffset[0], y: estimate.toolOffset[1], z: estimate.toolOffset[2] },
  };
  if (derivation.tcp) {
    const tcpPath = registry.getPathForNode(derivation.tcp);
    // A TCP that cannot be named is left OUT rather than written unresolvable:
    // `RobotIK.TCP` naming nothing is its own Problems entry
    // (`robot-ik-tcp-unresolved`), and a rig tool must not create one.
    if (tcpPath) fields.TCP = tcpPath;
  }
  return fields;
}

/** Only rotary drives are axes; this names the rest for a report. */
export function driveKindOf(dir: DriveDirection): 'rotary' | 'linear' | 'virtual' {
  if (isRotation(dir)) return 'rotary';
  return dir === DriveDirection.Virtual ? 'virtual' : 'linear';
}

// ─── The joint chain of a not-yet-rigged robot ───────────────────────────

/**
 * A {@link JointChainParams} for a node tree that is not rigged yet.
 *
 * This is the one place where a SECOND copy of `RVRobotIK.computeJointChain()`
 * would be tempting and must not happen by accident, so the relationship is
 * written down: the composition below is that method's, line for line, and it
 * exists because that method is private AND reads `RobotIK.Axis` off the node's
 * own extras — which a bare robot has none of. The rig would have nothing to
 * measure before it is written, and the diagnosis nothing to measure at all.
 *
 * Two properties are load-bearing and are the reason this is not "roughly the
 * same": the relative translation is taken AS IT IS (no division by the
 * decomposed scale — that division read the IRB's 0.4029 m tool as 0.8058 m,
 * mirrored, plan-772 B1), and the axis direction is
 * `directionToGltfAxis(Direction)` with `ReverseDirection` applied, the same
 * mapping the drive itself uses. `tests/robot-rig-derive.node.test.ts` asserts
 * that a rig written from this derivation and then read back through
 * `RVRobotIK.getJointChain()` produces the identical chain, which is what keeps
 * the two from drifting.
 *
 * It lives here (moved from the MCP robot tools, 2026-10-25) because a second
 * caller needs it outside the browser: `scripts/author-robot-ik.mjs` rigs the
 * library robot with it. It reads only `node`, `Direction`, `ReverseDirection`,
 * the limits and the two home getters of each drive.
 */
export function chainFromDerivation(root: Object3D, derivation: SerialChainDerivation): JointChainParams | null {
  const { axes, tcp } = derivation;
  if (derivation.failure || axes.length !== 6) return null;

  const axisHomePos = new Float64Array(18);
  const axisHomeRot = new Float64Array(24);
  const axisDir = new Float64Array(18);

  const rel = new Matrix4();
  const home = new Matrix4();
  const pos = new Vector3();
  const quat = new Quaternion();
  const scl = new Vector3();
  const hp = new Vector3();
  const hq = new Quaternion();
  let anyLimits = false;

  root.updateWorldMatrix(true, true);

  for (let i = 0; i < 6; i++) {
    const drive = axes[i];
    const axisNode = drive.node;
    const prevNode = i === 0 ? root : axes[i - 1].node;
    const parent = axisNode.parent;
    if (!parent) return null;
    home.compose(drive.getHomeLocalPosition(hp), drive.getHomeLocalQuaternion(hq), axisNode.scale);
    rel.copy(prevNode.matrixWorld).invert().multiply(parent.matrixWorld).multiply(home);
    rel.decompose(pos, quat, scl);
    axisHomePos[i * 3] = pos.x; axisHomePos[i * 3 + 1] = pos.y; axisHomePos[i * 3 + 2] = pos.z;
    axisHomeRot[i * 4] = quat.x; axisHomeRot[i * 4 + 1] = quat.y;
    axisHomeRot[i * 4 + 2] = quat.z; axisHomeRot[i * 4 + 3] = quat.w;
    const dir = directionToGltfAxis(drive.Direction);
    if (drive.ReverseDirection) dir.negate();
    axisDir[i * 3] = dir.x; axisDir[i * 3 + 1] = dir.y; axisDir[i * 3 + 2] = dir.z;
    if (drive.UseLimits) anyLimits = true;
  }

  let tcpLocalOffset: [number, number, number] = [0, 0, 0];
  let tcpLocalRot: [number, number, number, number] = [0, 0, 0, 1];
  if (tcp) {
    rel.copy(axes[5].node.matrixWorld).invert().multiply(tcp.matrixWorld);
    rel.decompose(pos, quat, scl);
    tcpLocalOffset = [pos.x, pos.y, pos.z];
    tcpLocalRot = [quat.x, quat.y, quat.z, quat.w];
  }

  const chain: JointChainParams = { axisHomePos, axisHomeRot, axisDir, tcpLocalOffset, tcpLocalRot };
  if (anyLimits) {
    const lower = new Float64Array(6);
    const upper = new Float64Array(6);
    for (let i = 0; i < 6; i++) {
      lower[i] = axes[i].UseLimits ? axes[i].LowerLimit : -360;
      upper[i] = axes[i].UseLimits ? axes[i].UpperLimit : 360;
    }
    chain.jointLimits = { lower, upper };
  }
  return chain;
}
