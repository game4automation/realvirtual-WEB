// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * author-robot-physics.mjs — make a library robot PHYSICS-CAPABLE (plan-673 Phase 4b).
 *
 *   node scripts/author-robot-physics.mjs [--check] [--no-catalog]
 *
 * `--check` measures and prints the parameter table without touching the file.
 *
 * ## What this script IS
 *
 * The plan asks "which parameters have to be maintained", and says the answer is
 * the work itself, not a list. This file is that answer in executable form, and
 * it is deliberately split in two:
 *
 *   - {@link ROBOT_PHYSICS_ROLE} — the GENERIC half. It holds no number that
 *     belongs to one robot: the collision primitive per body is the measured
 *     bounding box, the mass distribution is the measured envelope volume, the
 *     force limit is derived from the gravity torque, the contact roles are
 *     library presets, and the demo wiggle is removed. This half is the
 *     "physics-capable robot model" of F18 and is reusable as it stands.
 *   - {@link CRX_SPEC} — the SPECIFIC half: which nodes are the axes, what the
 *     datasheet says, the IK rig, the gripper catalogue. Count its entries and
 *     you have the real cost of the SECOND robot.
 *
 * ## The parameter table, with provenance
 *
 * | parameter | per body | where it comes from |
 * |---|---|---|
 * | `CollisionShapeSet.Shapes[0]` box centre + half extents | yes | MEASURED from the owned meshes (`measureBody`) |
 * | `MechanismBody.MassOverrideKg` | yes | DERIVED: envelope volume x the density below |
 * | `MechanismBody.DensityKgM3` | one | CALIBRATED: datasheet total mass / summed envelope volume |
 * | `ContactProfile.Profile` | yes | PRESET by role (`MachineFrame` for a link, `GripperJaw` for a jaw pad) |
 * | `DynamicAxis.ForceRange*` | yes | DERIVED: 2.5 x worst static gravity torque over the whole joint space, floor 20 N*m |
 * | `DynamicAxis.Kp`/`Kv` | yes | MEASURED in the Phase-1 servo sweep (kp x16, kv sqrt-matched) |
 * | `DynamicAxis.Armature`, `Damping` | yes | DECLARED, from the Menagerie UR models |
 * | `DynamicAxis.BaseFollowingError` | yes | MEASURED in the Phase-1 scenario runs, per axis, in DEGREES |
 * | `DynamicAxis.FollowingErrorLimit` | one | DERIVED from the same runs: above every structural share, below the one real overload |
 * | `DynamicAxis.ArrivalTolerance` | — | FREE: 0 derives it from base + window |
 * | `Drive.UseLimits/Lower/Upper` | yes | DATASHEET motion ranges (half of the span, which is what the datasheet quotes) |
 * | `GripLoad.GripForce`, jaw `ForceRange` | one | DATASHEET (Schunk EGH 80 catalogue) |
 *
 * `MassOverrideKg` rather than the density alone needs saying, because it is the
 * one place where the geometry refused to cooperate: the shipped link meshes are
 * open shells (`boundaryEdges` stays non-zero down to a 0.0001 mm weld), so
 * `computeLinkMassProperties` correctly refuses Mirtich and falls back to the
 * bounding box. The fallback over-reports every body, but by very DIFFERENT
 * factors (1.37x on A1, 4.50x on a jaw finger), so its DISTRIBUTION is distorted
 * and not merely scaled: a jaw finger would carry 2.3x its share and the lower
 * arm 52 % of the robot instead of 43 %. The override carries the envelope
 * distribution instead; the density is written beside it so that closing the
 * shells later reproduces the same masses without an override.
 *
 * ## What is NOT authored here, and why
 *
 * - `RobotIK` and the demo `IKPath`. They ARE authored on this asset since
 *   2026-10-25, but by `author-robot-ik.mjs`, run after this script — not here.
 *   History, because the old reasons are worth keeping: plan-773 E5 decided the
 *   rig is DERIVED in the browser and this part stays unrigged as the one real
 *   example of that path, and hand-typed OPW numbers would be wrong in this Y-up
 *   placement frame (`RobotIK.CalcCinematicParameters` measures Z up, X forward,
 *   verified on both rigs of `DemoRobotIK.glb`). Thomas lifted E5 for this asset
 *   ("the fanuc in the library should have a logical inverse kinematic
 *   definition and not the erratic setup"). The second reason does not bite the
 *   new rig: its fields come from the SAME derivation `web_robot_rig_from_library`
 *   runs, which measures along the base axis it finds, so nothing is typed by hand
 *   and nothing is measured in a fixed frame.
 *
 * - `WebMuJoCoRegion`. A region declares a detail-physics WORLD; that is a
 *   property of the scene the robot is placed in, not of the robot.
 * - `Grip`. The library extractor strips it on purpose, and a library robot that
 *   silently parents parts to itself is a trap. `GripLoad` is authored in
 *   `forcefit` mode, where the part owner comes from the physics runtime.
 * - `FrictionLoss`, `Gear`. Not modelled: no measurement, no datasheet value.
 *
 * ## `Drive_ErraticPosition` is gone from this asset
 *
 * It used to stay here for the plan-492 cell-matrix benchmark, which places
 * dozens of robots and needs them to MOVE without a PLC. Since 2026-10-25 the
 * benchmark places its own copy, `public/perf/Robots/FanucCRX-10iA-L-erratic.glb`
 * (`build-perf-robot-asset.mjs`), and the library robot moves only when its demo
 * path is switched on. `removeBehaviours` below stays empty: the behaviour is
 * removed by `author-robot-ik.mjs`, and it was inert under physics anyway
 * (`Drive.update()` returns in its `positionOverwrite` branch before the
 * behaviour loop runs).
 */

import { writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlb, writeGlb } from './lib/rv-glb.mjs';
import { findByPath } from './lib/rv-glb-nodes.mjs';
import { loadGlbAsThree } from './lib/rv-glb-three.mjs';
import { measureBodies, massesFromDatasheetSum } from './lib/rv-robot-link-geometry.mjs';
import { worstCaseGravityTorque, forceLimitNm } from './lib/rv-robot-statics.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// ─────────────────────────────────────────────────────────────────────────────
// The GENERIC half: the role, reusable for any serial arm (F18).
// ─────────────────────────────────────────────────────────────────────────────

export const ROBOT_PHYSICS_ROLE = Object.freeze({
  /** Contact role of a structural link. `MachineFrame` DOES collide (contype 1 /
   *  conaffinity 3): the arm can hit the board, which the Phase-1 gate avoided
   *  by giving the arm hulls contype 0 — a cost shortcut, not a model. */
  linkProfile: 'MachineFrame',
  /** Contact role of a jaw pad. `GripperJaw` carries priority 1, which is what
   *  makes a pad behave like a pad at all (friction is maximised element-wise). */
  jawProfile: 'GripperJaw',
  /** Position-servo gain of a rotary axis, Phase-1 servo sweep: the Menagerie
   *  stock 5000 left 1.07 deg of gravity sag (14.9 mm at the tool), x16 leaves
   *  0.10 deg (0.92 mm) at +80 % cost per frame and nothing became unstable. */
  mainAxisKp: 80000,
  /** Wrist axes carry an order less torque, so their stock gain is an order
   *  smaller; the same x16 applies. */
  wristAxisKp: 8000,
  /** kv is sqrt-matched to kp: a position servo's damping has to grow with the
   *  square root of its stiffness to keep its damping ratio. Phase-1 values
   *  500 / 50 x sqrt(16). */
  mainAxisKv: 2000,
  wristAxisKv: 200,
  /** Reflected rotor inertia, kg*m^2. DECLARED, blanket 0.1 on all six axes,
   *  from the Menagerie UR models. It is what keeps a stiff servo stable. */
  armature: 0.1,
  /** Viscous joint damping, N*m*s/rad. DECLARED, continued from the UR10e
   *  (10 / 5 / 2 on the main axes) downward. */
  damping: [10, 5, 2, 2, 1, 1],
  /**
   * Following-error window, in the axis unit (degrees here).
   *
   * One number for all six, chosen from the Phase-1 scenario runs so that it
   * cannot false-trip and still catches the one genuine overload that was
   * measured: the largest structural share plus its pose-to-pose variation is
   * 0.080 deg (A2), while the saturating A5 in `skew-push` reached 0.870 deg
   * net of its 0.065 base. 0.3 deg sits 2.7x below that overload and 3.7x above
   * the largest structural share.
   */
  followingErrorLimitDeg: 0.3,
  /** Phase-4 default: a window without a time fires on every acceleration edge. */
  followingErrorTimeMs: 200,
  /** Safety factor and floor of the force limit — Phase-1 values. */
  forceLimit: { safety: 2.5, floorNm: 20, roundNm: 5 },
  /**
   * Behaviours a physics-capable robot must not carry.
   *
   * EMPTY on purpose — see the file header: the demo sweep is removed by
   * `author-robot-ik.mjs`, and a drive behaviour is unreachable while a solver
   * owns the axis anyway (`Drive.update()` returns in its `positionOverwrite`
   * branch before the behaviour loop). The hook stays because a behaviour that
   * writes a position WITHOUT going through the drive loop would belong in it.
   */
  removeBehaviours: [],
});

// ─────────────────────────────────────────────────────────────────────────────
// The SPECIFIC half: this robot.
// ─────────────────────────────────────────────────────────────────────────────

const R = 'FanucCRX-10iA-L';
const GRIPPER = `${R}/A1/A2/A3/A4/A5/A6/TCP/SchunkEGH80Gripper`;

export const CRX_SPEC = Object.freeze({
  file: 'public/library/Robots/FanucCRX-10iA-L.glb',
  catalogId: 'robots-fanuccrx-10ia-l',
  root: R,

  /**
   * Datasheet (Fanuc CRX-10iA/L), the only numbers that come from outside the
   * file. `motionRangeDeg` are SPANS as the datasheet quotes them; the drive
   * limits are half of each, symmetric about the home pose.
   *
   * Axis SPEEDS in deg/s are deliberately ABSENT: they are not on the
   * manufacturer's page, and the third-party source Phase 0 found contradicts
   * the manufacturer in three places and was discarded. No number is invented
   * for them, so `Drive.TargetSpeed` keeps its authored 100.
   */
  datasheet: {
    massKg: 39,
    payloadKg: 10,
    reachMm: 1418,
    repeatabilityMm: 0.05,
    motionRangeDeg: [360, 360, 540, 380, 360, 380],
    /** Permissible LOAD moments at J4/J5/J6, N*m — NOT motor limits. Used only
     *  as a cross-check on the derived limits, never as an input. */
    permissibleWristMomentNm: [34.8, 26, 11],
  },

  /**
   * The axis chain, in order. Only three things per axis are STATED here; the
   * local transforms are read from the file by {@link deriveRobotPhysics}, which
   * is what keeps this spec from becoming a second copy of the asset.
   *
   * - `axis` is `directionToGltfAxis(Direction)` with `ReverseDirection`
   *   applied, i.e. what the drive really turns about. It is stated rather than
   *   derived because the mapping lives in TypeScript (`rv-coordinate-utils.ts`)
   *   and a second copy of it here would be the thing worth avoiding most; the
   *   Phase-4b test pins these six vectors against that function.
   * - `baseFollowingErrorDeg` is MEASURED, per axis, in the Phase-1 scenario
   *   runs (`spikes/673/phase1-report.json`, `scenarios[].followingErrorMaxDeg`,
   *   worst over the four non-saturating scenarios). It is the one item that
   *   needs a solver run for the next robot: deriving it from the worst-case
   *   gravity torque instead would over-state A2 by 1.6x (0.130 against the
   *   measured 0.080 deg) and a too-large base MASKS overload.
   * - `sweepStepDeg` coarsens the force-limit sweep on an axis whose downstream
   *   mass is small; a pure cost knob, 10 deg by default.
   */
  axes: [
    { node: `${R}/A1`, axis: [0, 1, 0], baseFollowingErrorDeg: 0.002 },
    { node: `${R}/A1/A2`, axis: [0, 0, 1], baseFollowingErrorDeg: 0.081 },
    { node: `${R}/A1/A2/A3`, axis: [0, 0, 1], baseFollowingErrorDeg: 0.02 },
    { node: `${R}/A1/A2/A3/A4`, axis: [-1, 0, 0], baseFollowingErrorDeg: 0.018, sweepStepDeg: 30 },
    { node: `${R}/A1/A2/A3/A4/A5`, axis: [0, 0, 1], baseFollowingErrorDeg: 0.065 },
    { node: `${R}/A1/A2/A3/A4/A5/A6`, axis: [-1, 0, 0], baseFollowingErrorDeg: 0.017, sweepStepDeg: 30 },
  ],

  /** The gripper. The virtual cylinder stays the kinematic master; the MJCF
   *  writer makes the FIRST geared jaw the actuated lead and couples the other
   *  to it, because a `Virtual` drive is never a body. */
  gripper: {
    node: GRIPPER,
    jaws: [`${GRIPPER}/LeftFinger`, `${GRIPPER}/RightFinger`],
    /**
     * Stroke per jaw, mm — the asset's own `Drive_Cylinder.MaxPos`.
     *
     * The catalogue says 40 mm per jaw and 0.8 s, the asset 15 mm and 0.3 s.
     * THE ASSET WINS, as in Phase 1: it is the part that ships, and a stroke
     * that does not match its own mesh travel would be worse than a stroke that
     * does not match the catalogue. The contradiction is reported, not resolved.
     */
    strokeMm: 15,
    /** Total grip force, N — catalogue upper bound. It goes on the LEAD jaw's
     *  actuator, from where the equality row transmits it to the second jaw, so
     *  each pad sees about half. That is the tendon-coefficient-0.5 arithmetic
     *  the Phase-1 model used, with one setpoint and one force limit. */
    gripForceTotalN: 100,
    /** Declared clamping force per jaw, N — half the catalogue total. */
    gripForcePerJawN: 50,
    /** Servo gain of the jaw, N/m. Deliberately stiff, and the reason is the
     *  MODE not the number: in `forcefit` the jaws are commanded to close FULLY
     *  past the part and the force limit decides what the part feels. Measured
     *  in Phase 1: kp 4000 with 2.5 mm of over-travel produced 10 N of 100 N
     *  and the part slid 24 mm out of the pads. */
    kp: 50000,
    kv: 500,
    /** Slip window, mm. Phase 1 measured 16.7-20.3 mm of slip in the three
     *  failure cases against -1.5 to 2.2 mm of axis refusal, so a few mm
     *  separates them cleanly. */
    slipLimitMm: 3,
  },

  /**
   * The IK rig — written by `author-robot-ik.mjs` from the runtime derivation,
   * see the file header. Kept here as the expected result of that derivation so
   * the Phase-4b test can state it:
   * `WristType` is a MEASUREMENT, not a default (plan-772 measured A6 sitting
   * 150 mm beside the intersection of axes 4 and 5, while the schema default
   * `Spherical` would solve this cobot with the wrong model), and the 150 mm is
   * the offset no choice of `a1..c4` can express.
   */
  expectedRig: {
    WristType: 'NonSpherical',
    unrepresentableOffsetMm: 150,
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Derivation
// ─────────────────────────────────────────────────────────────────────────────

const round = (x, d) => +x.toFixed(d);
const vec = (a) => ({ x: round(a[0], 3), y: round(a[1], 3), z: round(a[2], 3) });

/** Every body of the chain, as an asset-relative path, in MJCF body order. */
export function bodyPaths(spec) {
  return [spec.root, ...spec.axes.map((a) => a.node), ...spec.gripper.jaws];
}

const IDENTITY_QUAT_EPS = 1e-7;

/** The node's local transform, in the `StaticsAxis` shape. */
function localFrameOf(node) {
  const q = node.quaternion;
  const identity = Math.abs(q.x) < IDENTITY_QUAT_EPS && Math.abs(q.y) < IDENTITY_QUAT_EPS
    && Math.abs(q.z) < IDENTITY_QUAT_EPS && Math.abs(Math.abs(q.w) - 1) < IDENTITY_QUAT_EPS;
  return {
    t: [node.position.x, node.position.y, node.position.z],
    q: identity ? null : [q.x, q.y, q.z, q.w],
  };
}

/** The static frames between `from` (exclusive) and `to` (inclusive). */
function framesBetween(from, to) {
  const chain = [];
  for (let n = to; n && n !== from; n = n.parent) chain.unshift(n);
  return chain.map((n) => {
    const f = localFrameOf(n);
    return f.q ? { t: f.t, q: f.q } : { t: f.t };
  });
}

/**
 * Measure the asset and derive every authored number from it.
 * Pure: it reads the file and returns a table.
 */
export async function deriveRobotPhysics(spec, role = ROBOT_PHYSICS_ROLE, file = resolve(ROOT, spec.file)) {
  const { byPath } = await loadGlbAsThree(file);
  const paths = bodyPaths(spec);
  const node = (p) => {
    const n = byPath.get(p);
    if (!n) throw new Error(`${spec.file}: no node at "${p}"`);
    return n;
  };
  const bodies = paths.map(node);
  const measured = measureBodies(bodies);
  const mass = massesFromDatasheetSum(measured, spec.datasheet.massKg);

  // Statics: every body hangs on the axis whose subtree owns it. Body 0 is the
  // static base (it loads no joint), bodies 1..6 are the axes, the two jaws ride
  // on the last axis through the static frames between them. The rated payload
  // rides there too, because a force limit that cannot lift the rated load is not
  // a limit, it is a defect.
  //
  // The chain's own geometry is READ, never restated: `pos`/`quat` are the
  // asset's local transforms and the tool mount is whatever nodes sit between
  // the last axis and the gripper.
  const staticsAxes = spec.axes.map((a, i) => {
    const f = localFrameOf(node(a.node));
    return {
      name: a.node.split('/').pop(),
      pos: f.t,
      quat: f.q,
      axis: a.axis,
      limitDeg: spec.datasheet.motionRangeDeg[i] / 2,
      sweepStepDeg: a.sweepStepDeg,
    };
  });
  const last = spec.axes.length - 1;
  const lastAxisNode = node(spec.axes[last].node);
  const gripperNode = node(spec.gripper.node);
  const toolFrames = framesBetween(lastAxisNode, gripperNode);
  const jawIndex = (j) => 1 + spec.axes.length + j;
  // A gripped payload hangs where the jaws hold it: the mean of the jaw bounding
  // boxes, in the gripper's frame. The jaws are children of the gripper, so their
  // own local transform carries them there.
  const payloadComMm = [0, 1, 2].map((k) => spec.gripper.jaws.reduce((s, jaw, j) => {
    const local = node(jaw).position.toArray()[k] * 1000;
    return s + (measured[jawIndex(j)].centreMm[k] + local) / spec.gripper.jaws.length;
  }, 0));
  const staticsBodies = [
    ...spec.axes.map((_, i) => ({ axisIndex: i, massKg: mass.massKg[i + 1], comMm: measured[i + 1].centreMm })),
    ...spec.gripper.jaws.map((jaw, j) => ({
      axisIndex: last,
      massKg: mass.massKg[jawIndex(j)],
      comMm: [0, 1, 2].map((k) => measured[jawIndex(j)].centreMm[k] + node(jaw).position.toArray()[k] * 1000),
      frames: toolFrames,
    })),
    { axisIndex: last, massKg: spec.datasheet.payloadKg, comMm: payloadComMm, frames: toolFrames },
  ];
  const { worstNm, posesPerAxis } = worstCaseGravityTorque(staticsAxes, staticsBodies);
  const forceRangeNm = worstNm.map((w) => forceLimitNm(w, role.forceLimit));

  return { measured, mass, worstNm, posesPerAxis, forceRangeNm, paths, staticsAxes, toolFrames, payloadComMm };
}

// ─────────────────────────────────────────────────────────────────────────────
// Authoring
// ─────────────────────────────────────────────────────────────────────────────

function rvOf(json, path) {
  const idx = findByPath(json, path);
  if (idx === null) throw new Error(`no node at "${path}"`);
  const node = json.nodes[idx];
  node.extras ??= {};
  node.extras.realvirtual ??= {};
  return node.extras.realvirtual;
}

/** One box collider from a measured bounding box; `Size` is HALF extents in mm. */
function shapeSet(m) {
  return {
    Shapes: [{ Kind: 'box', Center: vec(m.centreMm), Size: vec(m.halfMm), Rotation: { x: 0, y: 0, z: 0 } }],
    ReplacesMesh: true,
  };
}

/** Write every authored component into the glTF JSON. Returns a change log. */
export function applyRobotPhysics(json, spec, derived, role = ROBOT_PHYSICS_ROLE) {
  const log = [];
  const { measured, mass, forceRangeNm } = derived;
  const paths = derived.paths;

  // ── 1 + 2 + 6: mass, collider and contact role on every body ──
  for (const [i, p] of paths.entries()) {
    const rv = rvOf(json, p);
    const isJaw = spec.gripper.jaws.includes(p);
    rv.MechanismBody = {
      DensityPreset: 'custom',
      DensityKgM3: round(mass.densityKgM3, 1),
      MassOverrideKg: round(mass.massKg[i], 4),
    };
    rv.CollisionShapeSet = shapeSet(measured[i]);
    rv.ContactProfile = { Profile: isJaw ? role.jawProfile : role.linkProfile, Priority: isJaw ? 1 : 0 };
    log.push(`${p}: MechanismBody ${round(mass.massKg[i], 3)} kg, CollisionShapeSet box, ContactProfile ${rv.ContactProfile.Profile}`);
  }

  // ── 3 + 4: the axes ──
  for (const [i, a] of spec.axes.entries()) {
    const rv = rvOf(json, a.node);
    const main = i < 3;
    const halfRangeDeg = spec.datasheet.motionRangeDeg[i] / 2;
    const drive = rv.Drive;
    if (!drive) throw new Error(`${a.node}: no Drive to make dynamic`);
    drive.UseLimits = true;
    drive.LowerLimit = -halfRangeDeg;
    drive.UpperLimit = halfRangeDeg;
    rv.DynamicAxis = {
      SetpointSource: 'planner',
      ActuatorKind: 'position',
      Kp: main ? role.mainAxisKp : role.wristAxisKp,
      Kv: main ? role.mainAxisKv : role.wristAxisKv,
      ForceRangeMin: -forceRangeNm[i],
      ForceRangeMax: forceRangeNm[i],
      Gear: 1,
      Armature: role.armature,
      Damping: role.damping[i],
      FrictionLoss: 0,
      BaseFollowingError: a.baseFollowingErrorDeg,
      FollowingErrorLimit: role.followingErrorLimitDeg,
      FollowingErrorTimeMs: role.followingErrorTimeMs,
      ArrivalTolerance: 0,
    };
    for (const key of role.removeBehaviours) {
      if (key in rv) { delete rv[key]; log.push(`${a.node}: removed ${key}`); }
    }
    log.push(`${a.node}: DynamicAxis forcerange +/-${forceRangeNm[i]} Nm, limits +/-${halfRangeDeg} deg`);
  }

  // ── 5: the gripper ──
  for (const [j, jaw] of spec.gripper.jaws.entries()) {
    const rv = rvOf(json, jaw);
    const drive = rv.Drive;
    if (!drive) throw new Error(`${jaw}: no Drive`);
    drive.UseLimits = true;
    drive.LowerLimit = 0;
    drive.UpperLimit = spec.gripper.strokeMm;
    rv.DynamicAxis = {
      SetpointSource: 'signal',
      ActuatorKind: 'position',
      Kp: spec.gripper.kp,
      Kv: spec.gripper.kv,
      ForceRangeMin: -spec.gripper.gripForceTotalN,
      ForceRangeMax: spec.gripper.gripForceTotalN,
      Gear: 1,
      Armature: 0.001,
      Damping: 2,
      FrictionLoss: 0,
      BaseFollowingError: 0,
      FollowingErrorLimit: 0,
      FollowingErrorTimeMs: role.followingErrorTimeMs,
      ArrivalTolerance: 0,
    };
    log.push(`${jaw}: DynamicAxis stroke 0..${spec.gripper.strokeMm} mm, forcerange +/-${spec.gripper.gripForceTotalN} N (jaw ${j})`);
  }
  const grv = rvOf(json, spec.gripper.node);
  grv.GripLoad = {
    Mode: 'forcefit',
    GripForce: spec.gripper.gripForcePerJawN,
    SlipLimit: spec.gripper.slipLimitMm,
    SlipTimeMs: role.followingErrorTimeMs,
  };
  log.push(`${spec.gripper.node}: GripLoad forcefit, ${spec.gripper.gripForcePerJawN} N/jaw, slip ${spec.gripper.slipLimitMm} mm`);
  return log;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const spec = CRX_SPEC;
  const file = resolve(ROOT, spec.file);
  const derived = await deriveRobotPhysics(spec, ROBOT_PHYSICS_ROLE, file);

  console.log(`[author-robot-physics] ${spec.file}`);
  console.log('  body                measured envelope   mass      box half extents (mm)        boundary edges @0.0001mm');
  for (const [i, m] of derived.measured.entries()) {
    console.log(`  ${m.node.padEnd(18)} ${(m.shellVolumeMm3 / 1e6).toFixed(3).padStart(8)} dm3  `
      + `${derived.mass.massKg[i].toFixed(3).padStart(7)} kg  `
      + `${m.halfMm.map((x) => x.toFixed(1).padStart(7)).join(' ')}   ${String(m.boundaryEdges['0.0001']).padStart(6)}`);
  }
  console.log(`  total envelope ${(derived.mass.totalVolumeMm3 / 1e6).toFixed(3)} dm3`
    + ` -> effective density ${derived.mass.densityKgM3.toFixed(1)} kg/m3 for the datasheet's ${spec.datasheet.massKg} kg`);
  console.log('  worst static gravity torque (whole joint space, rated payload):');
  for (const [i, a] of spec.axes.entries()) {
    console.log(`    ${a.node.split('/').pop()}  ${derived.worstNm[i].toFixed(2).padStart(8)} Nm over ${String(derived.posesPerAxis[i]).padStart(7)} poses`
      + `  -> forcerange +/-${derived.forceRangeNm[i]} Nm`);
  }
  const w = spec.datasheet.permissibleWristMomentNm;
  console.log(`  cross-check (not an input): wrist limits ${derived.forceRangeNm.slice(3).join(' / ')} Nm`
    + ` against permissible LOAD moments ${w.join(' / ')} Nm`);

  if (check) { console.log('  --check: nothing written'); return; }

  // The extras are edited in the JSON chunk only, so the Draco-compressed BIN
  // chunk is handed back verbatim and the geometry bytes do not change.
  const { json, rest } = readGlb(await readFile(file));
  const log = applyRobotPhysics(json, spec, derived, ROBOT_PHYSICS_ROLE);
  await writeFile(file, writeGlb(json, rest));
  for (const line of log) console.log(`  ~ ${line}`);
  console.log(`  wrote ${spec.file}`);

  if (!args.includes('--no-catalog')) {
    execFileSync(process.execPath, [resolve(HERE, 'build-local-library-catalog.mjs')], { stdio: 'inherit' });
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('author-robot-physics.mjs')) {
  await main();
}
