// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ik-cobot.test.ts — Cobot (non-spherical wrist) WASM solver integration
 * (plan-233 Phase 2, step 2g). Loads the REAL rv_ik_solver.wasm through the
 * private provider and validates the TS ↔ WASM ABI end to end:
 *
 * - version gate: rv_ik_version() === 3 (§11-A4)
 * - cobot roundtrip on the synthetic non-spherical 6-axis robot from the Rust
 *   test suite (rv-ik-solver/src/tests.rs::test_robot), verified with a
 *   test-local mini-FK (TS port of fk.rs — TEST ONLY)
 * - warm-start echo: a known solution as warm start returns exactly that
 *   solution as the sole result
 * - Pieper regression (§11-T1): the analytic export still returns 8 solutions
 * - registry tier: 'pro' / maxRobots=∞ / canBlend once the WASM is loaded
 *
 * Runs only in the private build (imports `@rv-private/ik-solver/*`).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WasmIKSolver } from '@rv-private/ik-solver/rv-ik-solver-provider';
import {
  ikSolverRegistry,
  type JointChainParams,
  type CobotSolveOpts,
  type OpwParams,
  type IKSolution,
} from '../src/core/engine/rv-ik-solver';

// ── Test-local mini-FK (port of rv-ik-solver/src/fk.rs — TEST ONLY) ──────────

type Q = [number, number, number, number]; // quat x,y,z,w
type V3 = [number, number, number];

function qMul(a: Q, b: Q): Q {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function qAxisAngle(axis: V3, rad: number): Q {
  const h = rad * 0.5;
  const s = Math.sin(h);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
}

function qRotate(q: Q, v: V3): V3 {
  // t = 2 * cross(q.xyz, v); v' = v + q.w*t + cross(q.xyz, t)
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

const DEG2RAD = Math.PI / 180;

/** compute_fk(joints°, chain) → TCP (pos, rot) in the chain's base frame. */
function fk(joints: number[], chain: JointChainParams): { pos: V3; rot: Q } {
  const homePos = (i: number): V3 => [
    chain.axisHomePos[i * 3], chain.axisHomePos[i * 3 + 1], chain.axisHomePos[i * 3 + 2],
  ];
  const homeRot = (i: number): Q => [
    chain.axisHomeRot[i * 4], chain.axisHomeRot[i * 4 + 1],
    chain.axisHomeRot[i * 4 + 2], chain.axisHomeRot[i * 4 + 3],
  ];
  const dir = (i: number): V3 => [
    chain.axisDir[i * 3], chain.axisDir[i * 3 + 1], chain.axisDir[i * 3 + 2],
  ];

  let gPos = homePos(0);
  let gRot = qMul(homeRot(0), qAxisAngle(dir(0), joints[0] * DEG2RAD));
  for (let i = 1; i < 6; i++) {
    const off = qRotate(gRot, homePos(i));
    gPos = [gPos[0] + off[0], gPos[1] + off[1], gPos[2] + off[2]];
    gRot = qMul(gRot, qMul(homeRot(i), qAxisAngle(dir(i), joints[i] * DEG2RAD)));
  }
  const toff = qRotate(gRot, chain.tcpLocalOffset as V3);
  return {
    pos: [gPos[0] + toff[0], gPos[1] + toff[1], gPos[2] + toff[2]],
    rot: qMul(gRot, chain.tcpLocalRot as Q),
  };
}

function posDist(a: V3, b: V3): number {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Wrap-tolerant angle difference in degrees (|d| ≤ 180). */
function angDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

// ── Synthetic non-spherical test robot (exact copy of tests.rs::test_robot) ──

function testRobotChain(): JointChainParams {
  return {
    axisHomePos: new Float64Array([
      0.0, 0.0, 0.0,   // axis 0 (base)
      0.0, 0.0, 0.30,  // axis 1 (shoulder)
      0.0, 0.0, 0.50,  // axis 2 (elbow)
      0.0, 0.0, 0.40,  // axis 3 (wrist roll)
      0.05, 0.0, 0.10, // axis 4 (wrist pitch) — X offset ⇒ non-spherical
      0.0, 0.0, 0.08,  // axis 5 (wrist roll)
    ]),
    axisHomeRot: new Float64Array([
      0, 0, 0, 1,  0, 0, 0, 1,  0, 0, 0, 1,
      0, 0, 0, 1,  0, 0, 0, 1,  0, 0, 0, 1,
    ]),
    axisDir: new Float64Array([
      0, 0, 1, // 0: yaw about Z
      0, 1, 0, // 1: pitch about Y
      0, 1, 0, // 2: pitch about Y
      0, 0, 1, // 3: roll about Z
      0, 1, 0, // 4: pitch about Y
      0, 0, 1, // 5: roll about Z
    ]),
    tcpLocalOffset: [0.0, 0.0, 0.10],
    tcpLocalRot: [0, 0, 0, 1],
    // ±180° limits → same Halton bounds as the Rust cobot_abi_roundtrip test.
    jointLimits: { lower: new Float64Array(6).fill(-180), upper: new Float64Array(6).fill(180) },
  };
}

/** Approximate OPW cold-start params for the synthetic arm (tests.rs::test_robot_opw). */
const TEST_OPW: OpwParams = {
  a1: 0.05, a2: 0.0, b: 0.0,
  c1: 0.30, c2: 0.50, c3: 0.50, c4: 0.18,
  elbowInUnityX: false,
  toolOffset: [0, 0, 0],
};

/** Generous NR budget (matches the Rust ABI roundtrip test — correctness, not frame cap). */
function roundtripOpts(): CobotSolveOpts {
  return {
    nrMaxIterations: 300,
    nrTolerance: 1e-5,
    nrAngularWeight: 1.0,
    nrOrientationTolerance: 0.01,
    numMirrorSeeds: 12,
    numHaltonSeeds: 8,
    opw: TEST_OPW,
  };
}

function reachable(sols: IKSolution[]): IKSolution[] {
  return sols.filter((s) => s.reachable);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Cobot WASM solver (plan-233 Phase 2, step 2g)', () => {
  const solver = new WasmIKSolver();

  beforeAll(async () => {
    await solver.load();
  });

  afterAll(() => {
    ikSolverRegistry.register(null);
    ikSolverRegistry.resetLiveSolveClaims();
  });

  it('version is 3 (Cobot ABI gate, §11-A4)', () => {
    expect(solver.version).toBe(3);
  });

  it('cobot roundtrip on synthetic non-spherical robot (FK-verified)', () => {
    const chain = testRobotChain();
    // Same well-conditioned joint config as tests.rs::cobot_abi_roundtrip.
    const theta = [25, 35, -30, 40, 45, -20];
    const { pos, rot } = fk(theta, chain);

    const sols = solver.solveCobot(chain, pos, rot, roundtripOpts());
    expect(sols.length).toBe(24);
    const ok = reachable(sols);
    expect(ok.length).toBeGreaterThanOrEqual(1);

    // Every reachable solution must be finite; the best one must reproduce the
    // target position via FK to < 1e-3 m (same bound as the Rust ABI test).
    let best = Number.POSITIVE_INFINITY;
    for (const s of ok) {
      for (const v of s.angles) expect(Number.isFinite(v)).toBe(true);
      const p = fk(s.angles, chain).pos;
      best = Math.min(best, posDist(p, pos));
    }
    expect(best).toBeLessThan(1e-3);
  });

  it('warm start echo: known solution returns as the sole result (±0.5°)', () => {
    const chain = testRobotChain();
    const theta = [25, 35, -30, 40, 45, -20];
    const { pos, rot } = fk(theta, chain);

    // First find a valid solution cold…
    const cold = solver.solveCobot(chain, pos, rot, roundtripOpts());
    const seed = ikSolverRegistry.selectClosest(cold, theta);
    expect(seed).not.toBeNull();

    // …then re-solve the SAME pose with it as warm start.
    const opts = roundtripOpts();
    opts.warmStart = new Float64Array(seed!);
    const warm = solver.solveCobot(chain, pos, rot, opts);
    const ok = reachable(warm);
    expect(ok.length).toBe(1); // warm-start converged ⇒ sole slot-0 solution
    for (let a = 0; a < 6; a++) {
      expect(angDiff(ok[0].angles[a], seed![a])).toBeLessThan(0.5);
    }
  });

  it('golden CRX case (Unity-Burst validated): solve contains the expected axes', () => {
    // Real-robot chain (FANUC CRX), validated against the Unity Burst solver.
    // Frame note: chain + target are BOTH in the Unity robot-local frame — the
    // solver is frame-agnostic, it only needs chain/target in ONE consistent
    // frame (in the viewer that shared frame is the glTF scene graph instead).
    // axisDir carries the ReverseDirection signs (A1/A4/A6 reversed on the CRX).
    const chain: JointChainParams = {
      axisHomePos: new Float64Array([
        0, 0, 0,
        0, 0, 0.245,
        0, 0, 0.71,
        0.15, 0, 0,
        0.39, 0, 0,
        0.1, 0.15, 0,
      ]),
      axisHomeRot: new Float64Array([
        0, 0, 0, 1,  0, 0, 0, 1,  0, 0, 0, 1,
        0, 0, 0, 1,  0, 0, 0, 1,  0, 0, 0, 1,
      ]),
      axisDir: new Float64Array([
        0, 0, -1, // A1 (reversed)
        0, 1, 0,  // A2
        0, 1, 0,  // A3
        -1, 0, 0, // A4 (reversed)
        0, 1, 0,  // A5
        -1, 0, 0, // A6 (reversed)
      ]),
      tcpLocalOffset: [0.23986, -0.000035, -0.0000371],
      tcpLocalRot: [-0.70711, 0, -0.70711, 0],
    };
    const opw: OpwParams = {
      a1: 0, a2: 0, b: 0,
      c1: 0.245, c2: 0.71, c3: 0.54, c4: 0.1,
      elbowInUnityX: true,
      toolOffset: [0, 0, 0.2399],
    };
    const pos: V3 = [0.60616, 0.57447, 0.49166];
    const quat: Q = [-0.99974, 0.02269, 0, 0];
    const expected = [-33.11, 23.69, -16.93, 0, 83.24, -35.72];

    // Sanity: the test-local FK reproduces the golden pose from the golden
    // angles (guards this test's own chain/frame conventions; golden values
    // are rounded to 0.01° / 1e-5 m → allow a few mm).
    expect(posDist(fk(expected, chain).pos, pos)).toBeLessThan(5e-3);

    const opts = roundtripOpts();
    opts.opw = opw;
    const sols = solver.solveCobot(chain, pos, quat, opts);
    const ok = reachable(sols);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const match = ok.find((s) => s.angles.every((a, i) => angDiff(a, expected[i]) < 0.5));
    expect(
      match,
      `no solution matched golden axes; got ${JSON.stringify(ok.map((s) => s.angles.map((a) => +a.toFixed(2))))}`,
    ).toBeTruthy();
  });

  it('pieper regression: 8 solutions for a known OPW input (§11-T1)', () => {
    // Exact values from tests.rs::pieper_export_unchanged.
    const opw: OpwParams = {
      a1: 0.025, a2: -0.035, b: 0.0,
      c1: 0.400, c2: 0.560, c3: 0.515, c4: 0.080,
      elbowInUnityX: false,
      toolOffset: [0, 0, 0.100],
    };
    const pos: [number, number, number] = [0.60, 0.10, 0.90];
    const quat: [number, number, number, number] = [0.1276, 0.1914, 0.2552, 0.9400];

    const sols = solver.solvePieper(opw, pos, quat);
    expect(sols.length).toBe(8);
    expect(sols.some((s) => s.reachable)).toBe(true);
    for (const s of sols) {
      if (!s.reachable) continue;
      for (const v of s.angles) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('tier is pro once loaded (maxRobots=∞, canBlend, canSolveCobot)', () => {
    ikSolverRegistry.register(solver);
    expect(ikSolverRegistry.tier).toBe('pro');
    expect(ikSolverRegistry.maxRobots).toBe(Number.POSITIVE_INFINITY);
    expect(ikSolverRegistry.canBlend).toBe(true);
    expect(ikSolverRegistry.canSolveCobot).toBe(true);
    // And the registry path delivers cobot solutions end to end.
    const chain = testRobotChain();
    const { pos, rot } = fk([10, 30, -20, 15, 40, -10], chain);
    const sols = ikSolverRegistry.solveCobot(chain, pos, rot, roundtripOpts());
    expect(sols).not.toBeNull();
    expect(reachable(sols!).length).toBeGreaterThanOrEqual(1);
  });
});
