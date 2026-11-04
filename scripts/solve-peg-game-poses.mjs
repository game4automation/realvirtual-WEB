// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * solve-peg-game-poses.mjs — the joint angles of the Setzkasten demo, solved on
 * the DELIVERED library robot (plan-673 Phase 5).
 *
 *   node scripts/solve-peg-game-poses.mjs            # writes the pose file
 *   node scripts/solve-peg-game-poses.mjs --check    # solve and print, write nothing
 *
 * ## Why this is a script and not an `IKPath` in the document
 *
 * `IKPath` resolves its axes through a `RobotIK` ANCESTOR, and
 * `public/library/Robots/FanucCRX-10iA-L.glb` deliberately carries no `RobotIK`
 * (plan-773 E5: the rig is DERIVED, by `web_robot_rig_from_library`, in the
 * browser). Authoring a rig in the document that PLACES the robot would mean a
 * second home for the same seven numbers, and the OPW parameters would be wrong
 * in that frame anyway (`author-robot-physics.mjs` has the measurement).
 *
 * (Since 2026-10-25 the library robot DOES ship a `RobotIK` and a demo `IKPath`,
 * switched off — Thomas lifted E5 for it, and `author-robot-ik.mjs` reuses the
 * solver below for that path's targets. The peg game keeps its joint-space
 * sequence: its poses are grip frames measured for this demo.)
 *
 * So the demo's automatic mode is a joint-space `LogicStep` sequence, and the
 * angles come from here. On a DYNAMIC axis that is not a shortcut past the
 * physics: `RVDrive.stepDynamicSetpoint()` routes a `LogicStep_DriveTo` through
 * `commandPosition()` onto the MuJoCo actuator, so the axis still moves by
 * ASKING the actuator and the following error is still real.
 *
 * ## The kinematics, and why it is replicated here rather than imported
 *
 * Forward kinematics is `writeDriveLocalTransform()` (`rv-drive.ts`), i.e.
 * `localQuat = baseQuat · Euler(axis · angleDeg)` with `axis =
 * directionToGltfAxis(Direction)`, negated when `ReverseDirection`. That is ten
 * lines and it is reproduced below against the AUTHORED extras of the asset —
 * which is the point: a pose file built from the library part's own `Drive`
 * declarations cannot drift from what the viewer does with them. The six axes of
 * the shipped part, read out of the file:
 *
 *   A1 RotationY rev  A2 RotationZ rev  A3 RotationZ rev
 *   A4 RotationX rev  A5 RotationZ rev  A6 RotationX rev
 *
 * Note A4 and A6: the plan-673 Phase-1 spike transcribed them as NOT reversed
 * (`CRX_REVERSE` in `spikes/673/peg-game-scene.ts`), so joint angles from the
 * spike's hand-written model do NOT carry over to the delivered part on those
 * two axes. Solving here against the delivered declarations is what avoids that
 * trap.
 *
 * The solver is damped least squares on a numerical Jacobian, six unknowns and a
 * six-component pose error (position in metres, rotation as the log of the
 * orientation error). No analytic model, no OPW parameters, no wrist
 * assumption — the CRX's wrist is not spherical (axis 6 passes 150 mm beside the
 * wrist point), which is exactly why the analytic route needs a seed and this one
 * does not.
 *
 * ## The GRIP frame, measured rather than chosen
 *
 * Every target below is the pose of the `SchunkEGH80Gripper` NODE, and the
 * relation between that node and the part is measured from the jaw pads'
 * authored `CollisionShapeSet` (`PAD_*` below). Three facts out of that
 * measurement drive the whole scene layout, and each one was a dead end first:
 *
 *  1. The jaw hull of the delivered part is the WHOLE FINGER BLOCK —
 *     52 x 94 x 33 mm, not a slim pad. It cannot enter a 21 mm slot, so the
 *     insertion depth is bounded by the pad TIP reaching the board's top
 *     surface, and the part must therefore hang BELOW the block: gripped on its
 *     top 10 mm, 25 mm of it free. That is the plan's own rule ("usable
 *     insertion travel is thickness - pad height") arriving at the delivered
 *     geometry: 35 mm thick, 10 mm gripped, 25 mm free, against a 12 mm board.
 *  2. The part is gripped near ONE ARM'S TIP, not at its hub. With the hub under
 *     the gripper axis, arm 1's outer corner lands at z = -16.3 mm in the jaw
 *     frame and the finger block spans +-16.55 mm — a 0.2 mm interpenetration
 *     that compiles, loads and then holds the part through its own jaw. Moving
 *     the hub 42 mm back along the jaw frame's -Z puts both free arms clear.
 *  3. The pick station cannot be a plate under the part. The jaws come down
 *     OUTSIDE the arm, so anything wider than the 17 mm jaw gap is hit by a pad
 *     before the part is reached. The pedestal is therefore under the HUB only,
 *     and the gripped arm overhangs it.
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { loadGlbAsThree } from './lib/rv-glb-three.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const ASSET = resolve(ROOT, 'public/library/Robots/FanucCRX-10iA-L.glb');
const OUT = resolve(ROOT, 'spikes/673/peg-game-demo-poses.json');

const ROBOT_PATH = 'FanucCRX-10iA-L';
const AXIS_PATHS = [
  'FanucCRX-10iA-L/A1',
  'FanucCRX-10iA-L/A1/A2',
  'FanucCRX-10iA-L/A1/A2/A3',
  'FanucCRX-10iA-L/A1/A2/A3/A4',
  'FanucCRX-10iA-L/A1/A2/A3/A4/A5',
  'FanucCRX-10iA-L/A1/A2/A3/A4/A5/A6',
];
const TCP_PATH = 'FanucCRX-10iA-L/A1/A2/A3/A4/A5/A6/TCP';
const GRIPPER_PATH = 'FanucCRX-10iA-L/A1/A2/A3/A4/A5/A6/TCP/SchunkEGH80Gripper';
const LEFT_FINGER_PATH = `${GRIPPER_PATH}/LeftFinger`;

// ── The measured part / board records, transcribed from the Phase-1 gate ─────
// `spikes/673/peg-game-model.ts`: DEFAULT_PART, DEFAULT_BOARD, BOARD_ORIGIN,
// BOARD_FOOT_HEIGHT_M, ROUND_CENTRE. Transcribed rather than imported because
// that file is TypeScript behind the spike's vitest aliases; the demo builder
// and this solver are plain Node. `scripts/peg-game-demo-geometry.mjs` is the
// ONE place the demo's own copies live — this file imports them from there.
export const PART = Object.freeze({ armLenM: 0.050, armWidthM: 0.020, thicknessM: 0.035, massKg: 0.3 });
export const BOARD = Object.freeze({
  halfThickM: 0.006, wallM: 0.015, clearanceM: 0.0005, roundHoleRadiusM: 0.030, massKg: 1.5,
});
export const BOARD_FOOT_HEIGHT_M = 0.015;
/** Board origin in the world, m — in front of the robot, on its feet. */
export const BOARD_ORIGIN_XZ = Object.freeze([0.750, 0.0]);
/** Board-local centre of the round hole (the wrong-shape target), m. */
export const ROUND_CENTRE_X = 0.220;

// ── The grip frame, from the delivered jaw pads ──────────────────────────────
/** Left pad centre in the finger frame, m (authored `CollisionShapeSet.Center`, mm). */
const PAD_CENTRE = Object.freeze([0.034549, 0.156, 0.000001]);
/** Left pad HALF extents, m (authored `Size`, mm, half extents). */
const PAD_HALF = Object.freeze([0.026049, 0.0468, 0.016551]);
/** Pad tip along the approach axis (finger local +Y), m. */
export const PAD_TIP_Y = PAD_CENTRE[1] + PAD_HALF[1];          // 0.2028
/**
 * How much of the part's thickness the pads cover, m — finding 1 above, and the
 * value is MEASURED rather than chosen.
 *
 * 10 mm was the first choice, because the rule is "free protrusion = thickness −
 * pad depth" and 35 − 10 = 25 mm maximises what can go through the board. It
 * carries the part, and only just: the pads grip ONE ARM near its tip, so the
 * part's centre of mass hangs 42 mm out and the pad patch has to carry that
 * moment on a 10 mm tall footprint — about 25 N of friction couple against the
 * 29 N the measured 42 N clamp and the pad's µ 0.7 provide. Measured
 * consequence: the part was carried for 1.5 s, sagged, and fell.
 *
 * 20 mm doubles the moment arm and halves the demand, and 35 − 20 = 15 mm of
 * free protrusion still clears the 12 mm board. MEASURED, and it does NOT work:
 * at 20 mm the jaws closed to 0 with no resistance at all and the part was never
 * held. So the moment is taken out the other way instead, by moving the GRIP
 * POINT towards the hub ({@link PART_HUB_BACK_M}), and this stays at 10 mm,
 * which is the depth that measurably grips.
 */
export const PAD_GRIP_DEPTH_M = 0.010;
/**
 * Hub offset along the jaw frame's -Z, m — finding 2 above, and the value is the
 * balance between two measured limits.
 *
 * It may not be 0: with the hub under the jaw axis, arm 1's outer corner lands at
 * z = −16.3 mm in the jaw frame while the finger block spans ±16.55 mm, a 0.2 mm
 * interpenetration that loads, compiles and then holds the part through its own
 * jaw. 42 mm was the first value and it clears that by a wide margin — but it
 * also hangs the part's centre of mass 42 mm outside the pads, and the friction
 * couple that has to carry the resulting moment on a 10 mm tall contact patch
 * (≈25 N) is then barely under what the measured 42 N clamp at µ 0.7 provides
 * (≈29 N). Measured consequence: the part was carried 180 mm and then dropped
 * when the motion settled.
 *
 * 20 mm halves the moment and still puts arm 1's corner 36 mm clear of the block.
 */
export const PART_HUB_BACK_M = 0.020;
/** Part centre in the gripper frame: 10 mm gripped, the rest hanging below. */
export const PART_CENTRE_IN_GRIPPER = Object.freeze([
  0, PAD_TIP_Y - PAD_GRIP_DEPTH_M + PART.thicknessM / 2, -PART_HUB_BACK_M,
]);

/** Board top surface in the world, m. */
export const BOARD_TOP_Y = BOARD_FOOT_HEIGHT_M + 2 * BOARD.halfThickM;
/** Pick pedestal top surface, m — chosen, see the header. */
export const PICK_TOP_Y = 0.200;
/** Pick station in the world (x, z), m — chosen, left of the board. */
export const PICK_XZ = Object.freeze([0.450, -0.450]);

/**
 * Gripper-node Y for a pad tip at `padTipY`.
 *
 * The approach axis is the gripper's local +Y and it points DOWN in every pose
 * of this demo, so the pad tip sits `PAD_TIP_Y` BELOW the node.
 */
export function gripperYForPadTip(padTipY) {
  return padTipY + PAD_TIP_Y;
}

/**
 * The tool orientation of the demo, as a quaternion.
 *
 * Approach (gripper local +Y) onto world -Y, the gripped arm (local +Z) onto
 * world +X, so the pads press along world +-Z. `yawDeg` turns the tool about the
 * approach axis, which is the one number that separates "right rotation" from
 * "wrong rotation" — 60 deg for a three-fold shape is the maximally wrong yaw.
 */
export function toolQuat(yawDeg) {
  const m = new Matrix4().makeBasis(
    new Vector3(0, 0, 1),   // local X -> world +Z
    new Vector3(0, -1, 0),  // local Y -> world -Y (approach down)
    new Vector3(1, 0, 0),   // local Z -> world +X (the gripped arm)
  );
  const q = new Quaternion().setFromRotationMatrix(m);
  if (yawDeg) {
    // Yaw about the APPROACH axis, i.e. about world Y.
    q.premultiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (yawDeg * Math.PI) / 180));
  }
  return q;
}

// ── Forward kinematics of the delivered declarations ────────────────────────

const GLTF_AXIS = {
  LinearX: [-1, 0, 0], LinearY: [0, 1, 0], LinearZ: [0, 0, 1],
  RotationX: [1, 0, 0], RotationY: [0, -1, 0], RotationZ: [0, 0, -1],
};

/** Read the six axes' base poses and signed rotation axes out of the asset. */
export async function readChain() {
  const tree = await loadGlbAsThree(ASSET);
  const get = (p) => {
    const n = tree.byPath.get(p);
    if (!n) throw new Error(`node not found in ${ASSET}: ${p}`);
    return n;
  };
  const axes = AXIS_PATHS.map((p) => {
    const node = get(p);
    const drive = node.userData?.realvirtual?.Drive;
    if (!drive) throw new Error(`no Drive on ${p}`);
    const raw = GLTF_AXIS[drive.Direction];
    if (!raw) throw new Error(`unsupported Drive.Direction on ${p}: ${drive.Direction}`);
    const s = drive.ReverseDirection ? -1 : 1;
    return {
      path: p,
      name: p.split('/').pop(),
      direction: drive.Direction,
      reverse: !!drive.ReverseDirection,
      axis: new Vector3(raw[0] * s, raw[1] * s, raw[2] * s),
      basePos: node.position.clone(),
      baseQuat: node.quaternion.clone(),
      lower: drive.UseLimits ? drive.LowerLimit : -360,
      upper: drive.UseLimits ? drive.UpperLimit : 360,
    };
  });
  const tcp = get(TCP_PATH);
  const gripper = get(GRIPPER_PATH);
  const robot = get(ROBOT_PATH);
  return {
    tree,
    axes,
    // Everything below A6 is rigid: one matrix from A6's frame to the gripper node.
    a6ToGripper: new Matrix4()
      .compose(tcp.position, tcp.quaternion, new Vector3(1, 1, 1))
      .multiply(new Matrix4().compose(gripper.position, gripper.quaternion, new Vector3(1, 1, 1))),
    robotBase: new Matrix4().compose(robot.position, robot.quaternion, new Vector3(1, 1, 1)),
    leftFinger: get(LEFT_FINGER_PATH),
  };
}

const _euler = new Euler();
const _dq = new Quaternion();
const _scaled = new Vector3();
const _one = new Vector3(1, 1, 1);

/** World matrix of the gripper node for a joint vector in DEGREES. */
export function fk(chain, q, out = new Matrix4()) {
  out.copy(chain.robotBase);
  const m = new Matrix4();
  for (let i = 0; i < chain.axes.length; i++) {
    const ax = chain.axes[i];
    _scaled.copy(ax.axis).multiplyScalar((q[i] * Math.PI) / 180);
    _euler.set(_scaled.x, _scaled.y, _scaled.z, 'XYZ');
    _dq.setFromEuler(_euler);
    m.compose(ax.basePos, new Quaternion().copy(ax.baseQuat).multiply(_dq), _one);
    out.multiply(m);
  }
  return out.multiply(chain.a6ToGripper);
}

/** `[dx,dy,dz, rx,ry,rz]` from the current pose to the target. */
export function poseError(chain, q, targetPos, targetQuat, scratch = new Matrix4()) {
  const m = fk(chain, q, scratch);
  const p = new Vector3();
  const r = new Quaternion();
  const s = new Vector3();
  m.decompose(p, r, s);
  const dp = targetPos.clone().sub(p);
  // Orientation error as a rotation vector (the log of q_target * q_cur^-1).
  const dq = targetQuat.clone().multiply(r.clone().invert());
  if (dq.w < 0) { dq.x = -dq.x; dq.y = -dq.y; dq.z = -dq.z; dq.w = -dq.w; }
  const sinHalf = Math.hypot(dq.x, dq.y, dq.z);
  let rv = [0, 0, 0];
  if (sinHalf > 1e-12) {
    const angle = 2 * Math.atan2(sinHalf, dq.w);
    const k = angle / sinHalf;
    rv = [dq.x * k, dq.y * k, dq.z * k];
  }
  return [dp.x, dp.y, dp.z, rv[0], rv[1], rv[2]];
}

/** Solve 6x6 `A x = b` by Gaussian elimination with partial pivoting. */
function solve6(A, b) {
  const n = 6;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-14) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * Damped least squares, numerical Jacobian, with position and rotation weighted
 * so one metre and one radian cost the same (0.25 m per radian — the robot's own
 * forearm scale, so neither term drowns the other).
 */
export function solveIk(chain, targetPos, targetQuat, seed) {
  const ROT_WEIGHT = 0.25;
  const q = [...seed];
  const scratch = new Matrix4();
  let err = poseError(chain, q, targetPos, targetQuat, scratch);
  for (let iter = 0; iter < 400; iter++) {
    const w = [err[0], err[1], err[2], err[3] * ROT_WEIGHT, err[4] * ROT_WEIGHT, err[5] * ROT_WEIGHT];
    const norm = Math.hypot(...w);
    if (norm < 1e-7) break;
    // Numerical Jacobian, central differences, 1e-4 deg.
    const h = 1e-4;
    const J = [[], [], [], [], [], []];
    for (let j = 0; j < 6; j++) {
      const qp = [...q]; qp[j] += h;
      const qm = [...q]; qm[j] -= h;
      const ep = poseError(chain, qp, targetPos, targetQuat, scratch);
      const em = poseError(chain, qm, targetPos, targetQuat, scratch);
      for (let i = 0; i < 6; i++) {
        const wi = i < 3 ? 1 : ROT_WEIGHT;
        // d(error)/dq; the error decreases as the pose approaches, hence the sign.
        J[i][j] = ((ep[i] - em[i]) * wi) / (2 * h);
      }
    }
    // (JᵀJ + λI) dq = Jᵀ w
    const lambda = Math.max(1e-6, Math.min(1e-2, norm * 1e-3));
    const JtJ = Array.from({ length: 6 }, (_, r) => Array.from({ length: 6 }, (_, c) => {
      let s = 0;
      for (let i = 0; i < 6; i++) s += J[i][r] * J[i][c];
      return s + (r === c ? lambda : 0);
    }));
    const Jtw = Array.from({ length: 6 }, (_, r) => {
      let s = 0;
      for (let i = 0; i < 6; i++) s += J[i][r] * w[i];
      return s;
    });
    const dq = solve6(JtJ, Jtw);
    if (!dq) break;
    // Step limit: 5 deg per joint per iteration keeps it on the branch it started on.
    let scale = 1;
    for (const d of dq) if (Math.abs(d) * scale > 5) scale = 5 / Math.abs(d);
    for (let j = 0; j < 6; j++) q[j] -= dq[j] * scale;
    err = poseError(chain, q, targetPos, targetQuat, scratch);
  }
  const posErrMm = Math.hypot(err[0], err[1], err[2]) * 1000;
  const rotErrDeg = (Math.hypot(err[3], err[4], err[5]) * 180) / Math.PI;
  const inLimits = q.every((v, i) => v >= chain.axes[i].lower - 1e-6 && v <= chain.axes[i].upper + 1e-6);
  return { q: q.map((v) => +v.toFixed(4)), posErrMm, rotErrDeg, inLimits };
}

/**
 * Try several seeds and keep the first solution that converges inside the limits.
 *
 * `from` — the previously solved pose — is tried FIRST and that is not a
 * convenience: a 6R arm has up to eight solutions per pose, and picking them
 * independently per waypoint produced an elbow flip between `approach` and
 * `insert` (A4 180 deg -> 0 deg, A6 10.9 deg -> 169.1 deg) that no operator
 * would program. Seeding from the previous pose keeps the whole cycle on ONE
 * branch, which is what `closestSolutionIndex()` does in the viewer's own IK.
 */
export function solveRobust(chain, pos, quat, label, from = null) {
  const seeds = [
    ...(from ? [from] : []),
    [0, -45, 45, 0, 45, 0],
    [0, -60, 60, 0, 60, 0],
    [0, -30, 90, 0, 30, 0],
    [0, -90, 90, 0, 0, 0],
    [0, 0, 0, 0, 0, 0],
    [0, -45, 45, 180, 45, 0],
  ];
  let best = null;
  for (const seed of seeds) {
    const r = solveIk(chain, pos, quat, seed);
    if (r.posErrMm < 0.05 && r.rotErrDeg < 0.05 && r.inLimits) return r;
    if (!best || r.posErrMm + r.rotErrDeg * 10 < best.posErrMm + best.rotErrDeg * 10) best = r;
  }
  throw new Error(
    `IK did not converge for "${label}": best ${best.posErrMm.toFixed(3)} mm / `
    + `${best.rotErrDeg.toFixed(3)} deg, inLimits=${best.inLimits}, q=${JSON.stringify(best.q)}`,
  );
}

// ── The waypoints ───────────────────────────────────────────────────────────

/**
 * The demo cycle, as gripper-node poses.
 *
 * Every Y comes out of {@link gripperYForPadTip}, i.e. out of the measured pad
 * geometry, so no height in this list is a guess:
 *
 *   pick     pad tip 10 mm into the part lying on the pedestal
 *   lift     200 mm above that
 *   approach 120 mm above the board's top surface
 *   insert   pad tip ON the board's top surface — the deepest the finger block
 *            can go, and 25 mm of part below it, which clears a 12 mm board
 *   retract  back to `lift`
 */
function waypoints() {
  const [bx, bz] = BOARD_ORIGIN_XZ;
  const hub = PART_HUB_BACK_M;
  // The gripper node sits `hub` along its own +Z from the part's hub, i.e.
  // `hub` along world +X in this orientation.
  const overSlot = [bx + hub, 0, bz];
  const overRound = [bx + ROUND_CENTRE_X + hub, 0, bz];
  const pickX = PICK_XZ[0];
  const pickZ = PICK_XZ[1];
  const pickPadTip = PICK_TOP_Y + PART.thicknessM - PAD_GRIP_DEPTH_M;
  return [
    { id: 'pick', yawDeg: 0, pos: [pickX, gripperYForPadTip(pickPadTip), pickZ] },
    { id: 'lift', yawDeg: 0, pos: [pickX, gripperYForPadTip(pickPadTip) + 0.200, pickZ], seedFrom: 'pick' },
    { id: 'approach', yawDeg: 0, pos: [overSlot[0], gripperYForPadTip(BOARD_TOP_Y + 0.120), overSlot[2]], seedFrom: 'lift' },
    { id: 'insert', yawDeg: 0, pos: [overSlot[0], gripperYForPadTip(BOARD_TOP_Y), overSlot[2]], seedFrom: 'approach' },
    // The two failure cases, solved so the measurement and the inspector hint
    // name real numbers instead of "turn it a bit".
    { id: 'approach-wrong-rotation', yawDeg: 60, pos: [overSlot[0], gripperYForPadTip(BOARD_TOP_Y + 0.120), overSlot[2]], seedFrom: 'approach' },
    { id: 'insert-wrong-rotation', yawDeg: 60, pos: [overSlot[0], gripperYForPadTip(BOARD_TOP_Y), overSlot[2]], seedFrom: 'approach-wrong-rotation' },
    { id: 'approach-wrong-shape', yawDeg: 0, pos: [overRound[0], gripperYForPadTip(BOARD_TOP_Y + 0.120), overRound[2]], seedFrom: 'approach' },
    { id: 'insert-wrong-shape', yawDeg: 0, pos: [overRound[0], gripperYForPadTip(BOARD_TOP_Y), overRound[2]], seedFrom: 'approach-wrong-shape' },
  ];
}

export async function solvePegGamePoses() {
  const chain = await readChain();
  const out = {
    _generator: 'scripts/solve-peg-game-poses.mjs (plan-673 Phase 5)',
    _asset: 'public/library/Robots/FanucCRX-10iA-L.glb',
    axes: chain.axes.map((a) => ({
      name: a.name, direction: a.direction, reverse: a.reverse,
      axis: a.axis.toArray(), lower: a.lower, upper: a.upper,
    })),
    grip: {
      padTipYM: PAD_TIP_Y,
      padGripDepthM: PAD_GRIP_DEPTH_M,
      partCentreInGripperM: [...PART_CENTRE_IN_GRIPPER],
      hubBackM: PART_HUB_BACK_M,
    },
    layout: {
      boardOriginXZ: [...BOARD_ORIGIN_XZ],
      boardTopYM: BOARD_TOP_Y,
      pickXZ: [...PICK_XZ],
      pickTopYM: PICK_TOP_Y,
      roundCentreXM: ROUND_CENTRE_X,
    },
    poses: {},
  };
  for (const wp of waypoints()) {
    const pos = new Vector3(...wp.pos);
    const quat = toolQuat(wp.yawDeg);
    // `seedFrom` names which already-solved pose this one continues from, so the
    // whole cycle stays on one IK branch (see `solveRobust`).
    const from = wp.seedFrom ? out.poses[wp.seedFrom]?.q ?? null : null;
    const r = solveRobust(chain, pos, quat, wp.id, from);
    out.poses[wp.id] = {
      q: r.q,
      gripperPos: wp.pos.map((v) => +v.toFixed(5)),
      yawDeg: wp.yawDeg,
      posErrMm: +r.posErrMm.toFixed(4),
      rotErrDeg: +r.rotErrDeg.toFixed(4),
    };
  }
  return out;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const result = await solvePegGamePoses();
  for (const [id, p] of Object.entries(result.poses)) {
    console.log(
      `${id.padEnd(26)} q=[${p.q.map((v) => v.toFixed(2).padStart(8)).join(', ')}]`
      + `  err ${p.posErrMm.toFixed(3)} mm / ${p.rotErrDeg.toFixed(3)} deg`,
    );
  }
  if (!process.argv.includes('--check')) {
    writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`\nwritten: ${OUT}`);
  }
}
