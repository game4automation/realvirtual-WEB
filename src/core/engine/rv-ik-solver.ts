// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-ik-solver.ts — Public interface + registry for the interactive IK solver.
 *
 * The actual analytical solver is a PROTECTED, closed-source artifact (Rust →
 * WASM, plan-212) that ships only in licensed builds. The private side registers
 * a provider here; when absent (open-source / unlicensed build) the tier is
 * `'none'` (and `available` is false) and the viewer falls back to AxisPos replay
 * (no interactive re-solving).
 *
 * Capability tier (plan-233 §2.4): `'none'` (replay-only) → `'free'` (Pieper, ONE
 * live-solving robot) → `'pro'` (+ non-spherical Cobot solver, unlimited robots,
 * blending). The legacy boolean `available` getter survives as `tier !== 'none'`.
 *
 * Frame contract: pos/quat describe the desired TCP pose in the robot's LOCAL
 * frame, in meters, with any scene scale removed — the same frame the serialized
 * OPW parameters live in. (Validated: identity conversion, exact parity with the
 * Unity Burst solver on clean targets.)
 */

import { Matrix4, Vector3, Quaternion } from 'three';

/** Ortho-parallel-wrist kinematic parameters (serialized in rv_extras as RobotIK). */
export interface OpwParams {
  a1: number; a2: number; b: number;
  c1: number; c2: number; c3: number; c4: number;
  elbowInUnityX: boolean;
  /** Tool offset in robot-local meters. */
  toolOffset: [number, number, number];
}

/** One IK configuration: 6 joint angles (degrees) + reachability flag. */
export interface IKSolution {
  angles: number[];
  reachable: boolean;
}

/**
 * Solver capability tier (plan-233 §2.4, plan-231 Phase 0):
 * - `'none'` — no solver loaded (open-source / unlicensed): replay-only, no live re-solve.
 * - `'free'` — Pieper analytical solver loaded; ONE live-solvable robot, no Cobot, no blending.
 * - `'pro'`  — Pieper + non-spherical Cobot solver loaded; unlimited robots, blending allowed.
 *
 * (Phase 0/1 ship `'none'`/`'free'` only; `'pro'` arrives with the Cobot WASM in plan-233 Phase 2.)
 */
export type IKTier = 'none' | 'free' | 'pro';

/**
 * Per-axis kinematic chain for the numerical Cobot solver (plan-233 §3.1).
 * Derived from the loaded robot's axis node tree. Phase 0/1 only declares the
 * type so `solveCobot`'s signature is stable; no chain extraction happens yet.
 */
export interface JointChainParams {
  axisHomePos: Float64Array;   // 6×3 — home local position per axis [m]
  axisHomeRot: Float64Array;   // 6×4 — home local rotation (quat x,y,z,w) per axis
  axisDir: Float64Array;       // 6×3 — rotation-axis direction (unit) per axis
  tcpLocalOffset: [number, number, number];        // TCP rel. axis 5 [m]
  tcpLocalRot: [number, number, number, number];   // quat x,y,z,w
  jointLimits?: { lower: Float64Array; upper: Float64Array }; // 6× [deg]
}

/** Optional tuning for the Cobot NR/DLS solve (plan-233 §3.1). Defaults = Burst defaults. */
export interface CobotSolveOpts {
  nrMaxIterations?: number;
  nrTolerance?: number;
  nrAngularWeight?: number;
  nrOrientationTolerance?: number;
  numMirrorSeeds?: number;
  numHaltonSeeds?: number;
  warmStart?: Float64Array;
  /** OPW parameters feeding the analytic Pieper cold-start inside the Cobot
   *  solve (plan-233 §3.2, IN offsets 99..109). Strongly recommended: without
   *  them the solver only explores mirrored/Halton seeds (weaker convergence). */
  opw?: OpwParams;
}

/** Implemented by the protected WASM provider (private). */
export interface IKSolverProvider {
  /** Capability tier of this provider (drives `available`, Cobot routing, limits). */
  readonly tier: IKTier;
  /** Max number of robots that may live-solve concurrently (free=1, pro=∞). */
  readonly maxRobots: number;
  /** True when continuous blending between targets may run (pro-only; plan-231 Phase 3). */
  readonly canBlend: boolean;
  /** Returns up to 8 analytical solutions for the given robot-local TCP pose. */
  solvePieper(
    params: OpwParams,
    pos: [number, number, number],
    quat: [number, number, number, number],
  ): IKSolution[];
  /**
   * Returns numerical solutions for a non-spherical (Cobot) wrist — pro tier only.
   * Optional: absent on free providers; the registry guards with `?.`.
   * (Phase 2 implements the real solve; in Phase 0/1 the provider stub returns [].)
   */
  solveCobot?(
    chain: JointChainParams,
    pos: [number, number, number],
    quat: [number, number, number, number],
    opts?: CobotSolveOpts,
  ): IKSolution[];
}

class IKSolverRegistry {
  private provider: IKSolverProvider | null = null;
  /**
   * Per-robot live-solve claims (plan-233 §11-A3). The registry is a module
   * singleton with no robot identity, so a global flag would also block robot #1
   * once a second robot loads. Instead each robot "claims" a live-solve slot by a
   * stable key (its node uuid); the first `maxRobots` keys win and keep solving,
   * any further robot is denied and falls back to AxisPos replay. The set is reset
   * on model clear (resetLiveSolveClaims) so a 1→2→1 scene change re-frees solving.
   */
  private readonly liveSolveClaims = new Set<string>();

  /** Register the protected solver provider (called from the private side).
   *  Pass `null` to unregister (back to the open-source `tier='none'` state). */
  register(provider: IKSolverProvider | null): void {
    this.provider = provider;
  }

  /** Capability tier — `'none'` when no provider is registered (open-source/replay). */
  get tier(): IKTier {
    return this.provider?.tier ?? 'none';
  }

  /** Max concurrently live-solvable robots; 0 when no solver is loaded. */
  get maxRobots(): number {
    return this.provider?.maxRobots ?? 0;
  }

  /** Whether continuous blending may run (pro-only; false without a solver). */
  get canBlend(): boolean {
    return this.provider?.canBlend ?? false;
  }

  /**
   * Backward-compatible alias (plan-233 §11-A1). Existing callsites in
   * ik-target-edit-plugin / ik-path-visualizer-plugin read `available` to decide
   * whether to live-solve at all; keep it as `tier !== 'none'`.
   */
  get available(): boolean {
    return this.tier !== 'none';
  }

  /** True when a Cobot (non-spherical) solver is present (pro tier). */
  get canSolveCobot(): boolean {
    return this.tier === 'pro' && typeof this.provider?.solveCobot === 'function';
  }

  /**
   * Per-robot live-solve gate (plan-233 §11-A3). Returns true if `robotKey` may
   * live-solve under the current `maxRobots` limit. Idempotent: a key that already
   * holds a claim always returns true (so the same robot keeps solving across
   * frames). A new key is admitted only while fewer than `maxRobots` claims exist.
   * `tier==='none'` → always false (no solver). Reset via resetLiveSolveClaims().
   */
  claimLiveSolve(robotKey: string): boolean {
    if (this.tier === 'none') return false;
    if (this.liveSolveClaims.has(robotKey)) return true;
    if (this.liveSolveClaims.size >= this.maxRobots) {
      // Minimal, non-blocking "Pro" hint (no UI rebuild in Phase 1, §11/Free-limit).
      // TODO(plan-231 Phase 4): surface a dismissible "Pro" badge in the IK edit UI.
      console.info(
        `[ik-solver] Free tier allows ${this.maxRobots} live-solving robot(s); ` +
        `additional robot falls back to AxisPos replay (Pro lifts this limit).`,
      );
      return false;
    }
    this.liveSolveClaims.add(robotKey);
    return true;
  }

  /** Release a single robot's live-solve claim (e.g. robot removed from scene). */
  releaseLiveSolve(robotKey: string): void {
    this.liveSolveClaims.delete(robotKey);
  }

  /** Drop all live-solve claims — called on model clear / scene switch (§11-A3-Reset). */
  resetLiveSolveClaims(): void {
    this.liveSolveClaims.clear();
  }

  /** Solve, or null when no solver is available (→ replay-only fallback). */
  solvePieper(
    params: OpwParams,
    pos: [number, number, number],
    quat: [number, number, number, number],
  ): IKSolution[] | null {
    return this.tier !== 'none' ? (this.provider?.solvePieper(params, pos, quat) ?? null) : null;
  }

  /**
   * Solve a non-spherical wrist via the Cobot solver — pro tier only.
   * Returns null when no Cobot solver is present (free/none) → caller routes to
   * Pieper or replay. (Phase 0/1: always null, since no pro WASM exists yet.)
   */
  solveCobot(
    chain: JointChainParams,
    pos: [number, number, number],
    quat: [number, number, number, number],
    opts?: CobotSolveOpts,
  ): IKSolution[] | null {
    if (!this.canSolveCobot || !this.provider?.solveCobot) return null;
    return this.provider.solveCobot(chain, pos, quat, opts);
  }

  /**
   * Pick the solution closest to the reference joint angles (L2, with 360°
   * unwrap per axis) — mirrors RobotIK's default selection. Returns null if
   * none reachable.
   */
  selectClosest(solutions: IKSolution[], reference: number[]): number[] | null {
    let best: number[] | null = null;
    let bestErr = Infinity;
    for (const s of solutions) {
      if (!s.reachable) continue;
      let err = 0;
      for (let a = 0; a < 6; a++) {
        let d = Math.abs((s.angles[a] ?? 0) - (reference[a] ?? 0)) % 360;
        if (d > 180) d = 360 - d;
        err += d * d;
      }
      if (err < bestErr) { bestErr = err; best = s.angles; }
    }
    return best;
  }
}

/** Singleton IK solver registry. */
export const ikSolverRegistry = new IKSolverRegistry();

// Reusable temps for targetPoseInBase (single-threaded; not reentrant).
const _poseMat = new Matrix4();
const _posePos = new Vector3();
const _poseQuat = new Quaternion();
const _poseScl = new Vector3();

/**
 * Express a target's world pose in a base (robot) local frame and write the
 * scene-scale-removed position + quaternion into the caller's reusable tuples —
 * ready for solvePieper(). No per-call allocation. Shared by the interactive
 * edit plugin (re-solve) and the path visualizer (reachability check).
 */
export function targetPoseInBase(
  baseMatrixWorld: Matrix4,
  targetMatrixWorld: Matrix4,
  outPos: [number, number, number],
  outQuat: [number, number, number, number],
): void {
  _poseMat.copy(baseMatrixWorld).invert().multiply(targetMatrixWorld);
  _poseMat.decompose(_posePos, _poseQuat, _poseScl);
  outPos[0] = _posePos.x / (_poseScl.x || 1);
  outPos[1] = _posePos.y / (_poseScl.y || 1);
  outPos[2] = _posePos.z / (_poseScl.z || 1);
  outQuat[0] = _poseQuat.x; outQuat[1] = _poseQuat.y; outQuat[2] = _poseQuat.z; outQuat[3] = _poseQuat.w;
}
