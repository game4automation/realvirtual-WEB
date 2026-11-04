// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-robot-statics.mjs — the static gravity torque of a serial arm, and the
 * force limit that follows from it (plan-673 Phase 4b).
 *
 * ## Why this exists
 *
 * `DynamicAxis.ForceRange*` is the quantity the whole overload model hangs on,
 * and for the first three axes of an articulated arm NO datasheet value exists
 * (plan-673 Phase-0 correction 1: the CRX's 34.8 / 26 / 11 N·m are permissible
 * LOAD moments at the wrist, not motor limits). Phase 1 measured the way to the
 * number instead: MuJoCo's `qfrc_bias` in standstill IS the RNEA gravity term,
 * so the limit is `safety × worst-case static gravity torque`, with a floor.
 *
 * Phase 1 took that worst case over 3 canonical plus 10 task poses — and found
 * the hard way that three canonical poses are not enough (A5 got 3.16 N·m,
 * saturated 71 % of the time and the arm stopped short of the board). A LIBRARY
 * part has no task poses at all, so this module does what a library part can:
 * it takes the worst case over the WHOLE admissible joint space, which strictly
 * dominates any task pose set.
 *
 * ## Why no MuJoCo is needed for it
 *
 * The gravity torque about joint `i` is
 *
 *     tau_i = a_i . SUM_{j downstream} (r_j - p_i) x m_j g
 *
 * Everything downstream of joint `i` — the axis direction `a_i` and the mass
 * moment `d_i = SUM m_j (r_j - p_i)` alike — is rigidly attached to frame `i`,
 * so with `Q` the world rotation of that frame:
 *
 *     tau_i = -|g| y . Q (a_i_local x d_i_local)
 *     |tau_i| <= |g| * |a_i_local x d_i_local|
 *
 * The bound does not depend on any joint UPSTREAM of `i` and is attained when
 * the upstream chain points `a x d` along the vertical. So the sweep only has to
 * cover joints `i+1 ... n-1`, which turns a product over six joints into a
 * handful of small ones. For an axis whose own direction is world vertical
 * (joint 1 of an upright arm) `Q a = y` always and `tau == 0` exactly — which is
 * what Phase 1 measured (5e-14 N·m).
 *
 * ## Validated, not asserted
 *
 * `torquesAtPose()` reproduces the three canonical `qfrc_bias` vectors of the
 * Phase-1 gate to four decimals from the same declared masses (sign inverted,
 * because `qfrc_bias` is the torque the actuator has to SUPPLY). That check is
 * the third witness and lives in the Phase-4b test, not in a comment.
 *
 * Frames: the arm is described in the glTF frame of the asset (Y up, metres),
 * exactly as the MJCF writer emits it — one quarter-turn at the root, every node
 * translation verbatim below it — so gravity is `(0, -9.81, 0)` here.
 */

import { Matrix4, Quaternion, Vector3 } from 'three';

/** Standard gravity, m/s^2. */
export const G = 9.81;

function localMatrix(axis) {
  return new Matrix4().compose(
    new Vector3(axis.pos[0], axis.pos[1], axis.pos[2]),
    axis.quat ? new Quaternion(axis.quat[0], axis.quat[1], axis.quat[2], axis.quat[3]) : new Quaternion(),
    new Vector3(1, 1, 1),
  );
}

function framesMatrix(frames) {
  const m = new Matrix4();
  for (const f of frames ?? []) {
    const q = f.q ?? [0, 0, 0, 1];
    m.multiply(new Matrix4().compose(
      new Vector3(f.t[0], f.t[1], f.t[2]),
      new Quaternion(q[0], q[1], q[2], q[3]),
      new Vector3(1, 1, 1),
    ));
  }
  return m;
}

/**
 * Gravity torque per joint at ONE pose, N·m, in the sign MuJoCo's `qfrc_bias`
 * uses (the torque the actuator has to supply to hold the pose).
 */
export function torquesAtPose(axes, bodies, qRad) {
  const W = [];
  let acc = new Matrix4();
  for (let i = 0; i < axes.length; i++) {
    const jr = new Matrix4().makeRotationAxis(new Vector3(...axes[i].axis).normalize(), qRad[i] ?? 0);
    acc = new Matrix4().multiplyMatrices(acc, localMatrix(axes[i])).multiply(jr);
    W[i] = acc.clone();
  }
  const axisDir = axes.map((a, i) => new Vector3(...a.axis).normalize().transformDirection(W[i]).normalize());
  const axisOrigin = W.map((m) => new Vector3().setFromMatrixPosition(m));
  const masses = bodies.map((b) => {
    const m = W[b.axisIndex].clone().multiply(framesMatrix(b.frames));
    return {
      mass: b.massKg,
      p: new Vector3(b.comMm[0], b.comMm[1], b.comMm[2]).multiplyScalar(0.001).applyMatrix4(m),
      ai: b.axisIndex,
    };
  });
  const out = new Array(axes.length).fill(0);
  const g = new Vector3(0, -G, 0);
  for (let i = 0; i < axes.length; i++) {
    let t = 0;
    for (const c of masses) {
      if (c.ai < i) continue;
      const r = c.p.clone().sub(axisOrigin[i]);
      t += new Vector3().crossVectors(r, g.clone().multiplyScalar(c.mass)).dot(axisDir[i]);
    }
    out[i] = -t;
  }
  return out;
}

/**
 * `true` when this joint's axis points along world Y in EVERY pose, so its
 * gravity torque is identically zero (see the file header). Only the FIRST axis
 * of an upright base is recognised — the one case that occurs in practice and
 * the one Phase 1 measured as 5e-14 N·m.
 */
function isWorldVertical(axes, i) {
  if (i !== 0) return false;
  const q = axes[0].quat;
  const d = new Vector3(...axes[0].axis).normalize()
    .applyQuaternion(q ? new Quaternion(q[0], q[1], q[2], q[3]) : new Quaternion());
  return Math.abs(Math.abs(d.y) - 1) < 1e-6;
}

/** Worst-case |gravity torque| per joint over the whole admissible joint space. */
export function worstCaseGravityTorque(axes, bodies) {
  const n = axes.length;
  const worstNm = new Array(n).fill(0);
  const posesPerAxis = new Array(n).fill(0);
  const locals = axes.map(localMatrix);

  for (let i = 0; i < n; i++) {
    if (isWorldVertical(axes, i)) { posesPerAxis[i] = 1; continue; }
    const ax = new Vector3(...axes[i].axis).normalize();
    const grids = [];
    for (let j = i + 1; j < n; j++) {
      const step = axes[j].sweepStepDeg ?? 10;
      const lim = axes[j].limitDeg;
      const g = [];
      for (let a = -lim; a <= lim + 1e-9; a += step) g.push((a * Math.PI) / 180);
      grids.push(g);
    }
    const q = new Array(n).fill(0);
    let count = 0;
    const evaluate = () => {
      const F = [];
      let acc = new Matrix4();
      F[i] = acc.clone();
      for (let j = i + 1; j < n; j++) {
        const jr = new Matrix4().makeRotationAxis(new Vector3(...axes[j].axis).normalize(), q[j]);
        acc = new Matrix4().multiplyMatrices(acc, locals[j]).multiply(jr);
        F[j] = acc.clone();
      }
      const d = new Vector3();
      for (const b of bodies) {
        if (b.axisIndex < i) continue;
        const m = F[b.axisIndex].clone().multiply(framesMatrix(b.frames));
        d.addScaledVector(
          new Vector3(b.comMm[0], b.comMm[1], b.comMm[2]).multiplyScalar(0.001).applyMatrix4(m),
          b.massKg,
        );
      }
      const t = G * new Vector3().crossVectors(ax, d).length();
      if (t > worstNm[i]) worstNm[i] = t;
      count++;
    };
    const rec = (k) => {
      if (k === grids.length) { evaluate(); return; }
      for (const a of grids[k]) { q[i + 1 + k] = a; rec(k + 1); }
    };
    rec(0);
    posesPerAxis[i] = count;
  }
  return { worstNm, posesPerAxis };
}

/**
 * The force limit of one axis, N·m: `safety × worst case`, never below
 * `floorNm`, rounded UP to `roundNm` so the authored number stays readable.
 * Phase-1 values: safety 2.5, floor 20 N·m.
 */
export function forceLimitNm(worstNm, opts = {}) {
  const { safety = 2.5, floorNm = 20, roundNm = 5 } = opts;
  const raw = Math.max(floorNm, worstNm * safety);
  return Math.ceil(raw / roundNm) * roundNm;
}
