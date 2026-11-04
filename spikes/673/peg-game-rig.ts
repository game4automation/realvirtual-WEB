// plan-673 Phase 1 — the rig around the MJCF: IK, trajectory, instrumentation.
//
// The division of labour matters for what the measurement MEANS:
//
//   The joint trajectory is solved ONCE, OFF-LINE, on a contact-free copy of
//   the model. The measured run then replays it as the actuators' setpoint and
//   never looks at the result. That is exactly the plan's semantics (3.1):
//   "the IK computes a target pose and pushes; the physics does not allow it;
//   THE IK NOTICES NOTHING — it only knows geometry. The following error lives
//   in the gap between the commanded and the actual angle."
//
//   It also keeps the cost measurement clean: no solver work runs inside the
//   measured loop, so `ms/step` is physics and nothing else.

import {
  BOARD_FOOT_HEIGHT_M,
  BOARD_ORIGIN,
  PART_IN_SITE_QUAT,
  ROUND_CENTRE,
  SLOT_CENTRE,
  buildPegGameMjcf,
  type SceneOptions,
} from './peg-game-model';
import { RVMuJoCoWorld } from '@rv-private/mujoco/rv-mujoco-world';

const AXIS_NAMES = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'] as const;

export interface Rig {
  world: RVMuJoCoWorld;
  /** qpos address of each of the six robot axes, in actuator order. */
  axisQpos: number[];
  /** qvel/dof address of each of the six robot axes. */
  axisDof: number[];
  gripSite: number;
  partBody: number;
  boardBody: number;
  partQposAdr: number;
  boardQposAdr: number;
  partDofAdr: number;
  boardDofAdr: number;
  /** Actuator index of the gripper (the last one). */
  gripActuator: number;
}

export async function createRig(opts: SceneOptions = {}): Promise<Rig> {
  const { xml } = buildPegGameMjcf(opts);
  const world = await RVMuJoCoWorld.load(xml);
  const axisQpos = AXIS_NAMES.map((n) => world.jointQposAdr(world.mustFind('joint', n)));
  const axisDof = AXIS_NAMES.map((n) => world.jointDofAdr(world.mustFind('joint', n)));
  return {
    world,
    axisQpos,
    axisDof,
    gripSite: world.mustFind('site', 'grip_site'),
    partBody: world.mustFind('body', 'part'),
    boardBody: world.mustFind('body', 'board'),
    partQposAdr: world.jointQposAdr(world.mustFind('joint', 'part_free')),
    boardQposAdr: world.jointQposAdr(world.mustFind('joint', 'board_free')),
    partDofAdr: world.jointDofAdr(world.mustFind('joint', 'part_free')),
    boardDofAdr: world.jointDofAdr(world.mustFind('joint', 'board_free')),
    gripActuator: world.mustFind('actuator', 'act_grip'),
  };
}

// ─── small linear algebra, row-major 3x3 ─────────────────────────────────────

export type Mat3 = Float64Array | number[];

/** Rotation about Z by `a`, row-major. */
export function rotZ(a: number): number[] {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/** Rotation about X by `a`, row-major. */
export function rotX(a: number): number[] {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}

export function matMul(a: Mat3, b: Mat3): number[] {
  const o = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[r * 3 + k] * b[k * 3 + c];
      o[r * 3 + c] = s;
    }
  }
  return o;
}

export function matT(a: Mat3): number[] {
  return [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
}

/** Axis-angle vector of a rotation matrix (the log map), small-angle form. */
export function rotLog(r: Mat3): [number, number, number] {
  const trace = r[0] + r[4] + r[8];
  const cos = Math.min(1, Math.max(-1, (trace - 1) / 2));
  const angle = Math.acos(cos);
  const sin = Math.sin(angle);
  const vx = r[7] - r[5];
  const vy = r[2] - r[6];
  const vz = r[3] - r[1];
  if (Math.abs(sin) < 1e-9) return [vx / 2, vy / 2, vz / 2];
  const k = angle / (2 * sin);
  return [vx * k, vy * k, vz * k];
}

/** MuJoCo quaternion [w,x,y,z] → row-major 3x3. */
export function quatToMat(q: readonly number[]): number[] {
  const [w, x, y, z] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

/** Row-major 3x3 → MuJoCo quaternion [w,x,y,z]. */
export function matToQuat(m: Mat3): [number, number, number, number] {
  const t = m[0] + m[4] + m[8];
  if (t > 0) {
    const s = Math.sqrt(t + 1) * 2;
    return [s / 4, (m[7] - m[5]) / s, (m[2] - m[6]) / s, (m[3] - m[1]) / s];
  }
  if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
    return [(m[7] - m[5]) / s, s / 4, (m[1] + m[3]) / s, (m[2] + m[6]) / s];
  }
  if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
    return [(m[2] - m[6]) / s, (m[1] + m[3]) / s, s / 4, (m[5] + m[7]) / s];
  }
  const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
  return [(m[3] - m[1]) / s, (m[2] + m[6]) / s, (m[5] + m[7]) / s, s / 4];
}

export function quatMul(a: readonly number[], b: readonly number[]): [number, number, number, number] {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

// ─── Inverse kinematics ──────────────────────────────────────────────────────

export interface IkResult {
  q: number[];
  posErrM: number;
  rotErrRad: number;
  iterations: number;
}

/**
 * Damped-least-squares IK for the six axes onto a full `grip_site` pose.
 *
 * Finite-difference Jacobian (6x6) via `mj_forward`, which is forward
 * KINEMATICS only — contacts play no part, which is why solving on the live
 * world is harmless as long as the caller restores the state afterwards.
 */
export function solveIk(
  rig: Rig,
  targetPos: readonly number[],
  targetMat: Mat3,
  seed: readonly number[],
  { maxIter = 200, tolPos = 1e-5, tolRot = 1e-4, lambda = 0.02, step = 0.6 } = {},
): IkResult {
  const { world, axisQpos, gripSite } = rig;
  const q = [...seed];
  const h = 1e-6;
  let posErr = Infinity;
  let rotErr = Infinity;
  let it = 0;

  const evalPose = (qq: readonly number[]): { p: Float64Array; r: Float64Array } => {
    for (let i = 0; i < 6; i++) world.writeQpos(axisQpos[i], [qq[i]]);
    world.forward();
    return { p: world.readSitePos(gripSite, new Float64Array(3)), r: world.readSiteMat(gripSite, new Float64Array(9)) };
  };

  for (; it < maxIter; it++) {
    const cur = evalPose(q);
    const ep = [targetPos[0] - cur.p[0], targetPos[1] - cur.p[1], targetPos[2] - cur.p[2]];
    const er = rotLog(matMul(targetMat, matT(cur.r)));
    posErr = Math.hypot(ep[0], ep[1], ep[2]);
    rotErr = Math.hypot(er[0], er[1], er[2]);
    if (posErr < tolPos && rotErr < tolRot) break;

    // J (6x6): columns = d(pose)/d(q_i)
    const J: number[][] = [];
    for (let i = 0; i < 6; i++) {
      const qp = [...q];
      qp[i] += h;
      const pert = evalPose(qp);
      const dp = [(pert.p[0] - cur.p[0]) / h, (pert.p[1] - cur.p[1]) / h, (pert.p[2] - cur.p[2]) / h];
      const dr = rotLog(matMul(pert.r, matT(cur.r))).map((v) => v / h);
      J.push([...dp, ...dr]);
    }
    // Solve (J^T J + lambda^2 I) dq = J^T e  — 6x6 Gauss with partial pivoting.
    const e = [...ep, ...er];
    const A: number[][] = [];
    for (let i = 0; i < 6; i++) {
      const row: number[] = [];
      for (let j = 0; j < 6; j++) {
        let s = 0;
        for (let k = 0; k < 6; k++) s += J[i][k] * J[j][k];
        row.push(s + (i === j ? lambda * lambda : 0));
      }
      let b = 0;
      for (let k = 0; k < 6; k++) b += J[i][k] * e[k];
      row.push(b);
      A.push(row);
    }
    for (let c = 0; c < 6; c++) {
      let piv = c;
      for (let r = c + 1; r < 6; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      if (Math.abs(A[piv][c]) < 1e-14) continue;
      [A[c], A[piv]] = [A[piv], A[c]];
      for (let r = 0; r < 6; r++) {
        if (r === c) continue;
        const fct = A[r][c] / A[c][c];
        for (let k = c; k <= 6; k++) A[r][k] -= fct * A[c][k];
      }
    }
    for (let i = 0; i < 6; i++) {
      const dq = Math.abs(A[i][i]) < 1e-14 ? 0 : A[i][6] / A[i][i];
      q[i] += step * Math.max(-0.2, Math.min(0.2, dq));
    }
  }
  evalPose(q);
  return { q, posErrM: posErr, rotErrRad: rotErr, iterations: it };
}

/**
 * Candidate seeds for {@link solveIkRobust}.
 *
 * Measured, not precautionary: a single seed left the yawed `wrong-rotation`
 * start pose stuck in a local minimum at 0.605 m of residual while the SAME
 * seed solved the press pose to 5.6 µm. A damped-least-squares solver on a 6R
 * arm needs a seed set, and the one below spans elbow-up/elbow-down and the
 * four tool-roll quadrants.
 */
const IK_SEEDS: readonly number[][] = (() => {
  const base = [
    [0, -0.4, 0.8, 0, 0.6, 0],
    [0, -0.8, 1.4, 0, 0.4, 0],
    [0, -0.2, 0.4, 0, 1.0, 0],
    [0, -1.2, 1.8, 0, 0.2, 0],
  ];
  const out: number[][] = [];
  for (const b of base) {
    for (const roll of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) out.push([...b.slice(0, 5), roll]);
  }
  return out;
})();

/** IK with a seed set: the first seed that converges wins, otherwise the best
 *  residual is returned so the caller can decide (and say so). */
export function solveIkRobust(
  rig: Rig,
  targetPos: readonly number[],
  targetMat: Mat3,
  preferredSeed?: readonly number[],
  tolPos = 1e-5,
): IkResult {
  const seeds = preferredSeed ? [preferredSeed, ...IK_SEEDS] : IK_SEEDS;
  let best: IkResult | null = null;
  for (const s of seeds) {
    const r = solveIk(rig, targetPos, targetMat, s, { tolPos });
    if (!best || r.posErrM + r.rotErrRad < best.posErrM + best.rotErrRad) best = r;
    if (r.posErrM < tolPos * 20 && r.rotErrRad < 1e-3) break;
  }
  // Leave the world at the returned solution, not at the last seed tried.
  for (let i = 0; i < 6; i++) rig.world.writeQpos(rig.axisQpos[i], [best!.q[i]]);
  rig.world.forward();
  return best!;
}

// ─── Scenario definition ─────────────────────────────────────────────────────

export type ScenarioId = 'free' | 'fits' | 'wrong-rotation' | 'wrong-shape' | 'skew-push';

export interface Scenario {
  id: ScenarioId;
  /** Yaw of the part about the approach axis, degrees. 0 / 120 / 240 fit. */
  yawDeg: number;
  /** Tilt of the approach about the tool X axis, degrees — the skew case. */
  skewDeg: number;
  /** Which opening the trajectory aims at. */
  target: 'slot' | 'round' | 'air';
  /**
   * Where the hub SETPOINT ends up, as an offset from the board's top surface,
   * m. The IK never learns whether the physics allowed it — that is the whole
   * point of the gate.
   *
   * +0.001 is computed from this geometry, not picked: the part has fully
   * passed the 12 mm board at hub = top + 0.0055 m, and the jaw pads first
   * touch the board at hub = top − 0.0025 m. +0.001 therefore lies 4.5 mm PAST
   * a successful pass-through and 3.5 mm BEFORE a pad/board jam, so the `fits`
   * reference ends clean while a blocked part gets 16.5 mm of refused travel to
   * show a following error with.
   */
  pressHubOffsetM: number;
  note: string;
}

/**
 * The five scenarios of the gate.
 *
 * O11 (Thomas, 2026-10-23) decided "three-star only" — the CYLINDER control
 * group is NOT built, against the plan's own recommendation and against the
 * `open:` line in the frontmatter, which still lists it. O11 is the later and
 * more specific decision, so it wins. The consequence the plan has to carry is
 * recorded there: without a control shape, a failed insertion does not by
 * itself distinguish "the shape" from "the robot" — Phase 5's parameter study
 * has to do that separation instead (same part, varied clearance and varied
 * start orientation).
 */
export const SCENARIOS: readonly Scenario[] = [
  { id: 'free', yawDeg: 0, skewDeg: 0, target: 'air', pressHubOffsetM: 0.100, note: 'moves in free space above the board — the cost floor' },
  { id: 'fits', yawDeg: 0, skewDeg: 0, target: 'slot', pressHubOffsetM: 0.001, note: 'right shape, right rotation — slides in' },
  { id: 'wrong-rotation', yawDeg: 60, skewDeg: 0, target: 'slot', pressHubOffsetM: 0.001, note: '60 deg off: all three arms rest on the surface' },
  { id: 'wrong-shape', yawDeg: 0, skewDeg: 0, target: 'round', pressHubOffsetM: 0.001, note: 'three-star into the round hole — the physics says no' },
  { id: 'skew-push', yawDeg: 0, skewDeg: 10, target: 'slot', pressHubOffsetM: 0.001, note: 'skewed press on the FREE board — the environment reacts' },
];

/** World position of a scenario's aim point, at the board's top surface. */
export function aimPoint(scenario: Scenario, boardHalfThick: number): [number, number, number] {
  const local = scenario.target === 'round' ? ROUND_CENTRE : SLOT_CENTRE;
  // board origin z = ht + foot, top surface = origin + ht
  const topZ = boardHalfThick * 2 + BOARD_FOOT_HEIGHT_M;
  return [BOARD_ORIGIN[0] + local[0], BOARD_ORIGIN[1] + local[1], topZ];
}

/** Tool orientation for a scenario: approach straight down (site +Z = world
 *  −Z), yawed about the approach axis, then tilted by `skewDeg` about tool X. */
export function toolMat(scenario: Scenario): number[] {
  // Base: site Y = world +X, site X = world +Y, site Z = world −Z (approach
  // straight down).
  //
  // The base is DERIVED, not chosen, and getting it wrong is invisible: the
  // part's arm 0 runs along the site's +Y (that is what PART_IN_SITE_QUAT is
  // for), the board's slot arm 0 runs along world +X, so site Y must map to
  // world +X for `yawDeg = 0` to MEAN "aligned". The first version of this
  // function used site X = world +X, which put the part's three arms at 30 deg
  // to the slot's three — the maximally wrong yaw for a 3-fold shape. The run
  // looked like a legitimate jam (small following error, no saturation, part
  // resting on the board) and would have been reported as one.
  const base = [0, 1, 0, 1, 0, 0, 0, 0, -1];
  const yawed = matMul(base, rotZ((scenario.yawDeg * Math.PI) / 180));
  return matMul(yawed, rotX((scenario.skewDeg * Math.PI) / 180));
}
