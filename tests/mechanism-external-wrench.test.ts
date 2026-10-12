// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * mechanism-external-wrench.test.ts — plan-467 test 9.7 (Phase 5).
 *
 * The ABI-v4 `link_wrench` parameter, end to end through the TypeScript host:
 * the browser hands the solver a contact load and the actuator has to carry it.
 *
 *  - a 9.81 N payload 0.5 m out on a MASSLESS lever costs exactly 4.905 N·m,
 *  - `null` is the v3 call: the same massless lever costs nothing,
 *  - the same load ADDS to a lever that already carries its own weight,
 *  - the ABI gate accepts 4 and refuses 3 — a v3 artifact next to a v4 host
 *    (or the other way round) must fail loud, never solve a machine whose
 *    payload silently disappeared.
 *
 * Guarded like every wasm suite: without the artifact the file skips loudly.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { Vector3 } from 'three';
import {
  KinematicSolverProvider,
  KINEMATIC_ABI_VERSION,
} from '@rv-private/kinematic-solver/rv-kinematic-solver-provider';
import { KINEMATIC_WASM_URL } from '@rv-private/kinematic-solver/rv-kinematic-wasm-url';
import type { MechanismLinkInput } from '@rv-private/kinematic-mechanism/rv-kinematic-topology';
import { createSolverFor, makeJoint, makeLink, seedRoot, type Rig } from './_mechanism-rigs';

let provider: KinematicSolverProvider;
let loaded = false;

beforeAll(async () => {
  provider = new KinematicSolverProvider();
  loaded = await provider.load();
});

afterEach(() => {
  provider?.destroyAll();
});

function requireSolver(ctx: { skip: (note?: string) => void }): boolean {
  if (!loaded) {
    ctx.skip(
      `rv_kinematic_solver.wasm unavailable (url=${KINEMATIC_WASM_URL ?? 'none'}, `
      + `failure=${provider.failure}: ${provider.failureDetail})`,
    );
    return false;
  }
  return true;
}

/** A link with an authored point mass (a null mass would disable the dynamics). */
function withMass(link: MechanismLinkInput, massKg: number): MechanismLinkInput {
  return {
    ...link,
    mass: { massKg, comLocalMm: new Vector3(0, 0, 0), inertiaLocalKgMm2: [0, 0, 0, 0, 0, 0] },
  };
}

/**
 * The plan-412 single-joint lever: hinge about +Z at the world origin, arm
 * origin 0.5 m out along +X. `armMassKg = 0` makes the idle machine weightless,
 * so whatever the drive reports IS the external payload.
 */
function leverRig(armMassKg: number): Rig {
  return {
    links: [withMass(makeLink('Base', 0, 0, 0), 0), withMass(makeLink('Arm', 0.5, 0, 0), armMassKg)],
    joints: [makeJoint({
      name: 'Hinge',
      bodyA: 0,
      bodyB: 1,
      anchorAMm: new Vector3(0, 0, 0),
      anchorBMm: new Vector3(-500, 0, 0),
      axisA: new Vector3(0, 0, 1),
      isDriven: true,
    })],
    worldNodeUsed: false,
  };
}

/** `link_wrench` row for one link: F at world point `p`, moment about the ORIGIN. */
function wrenchAt(linkCount: number, link: number, p: Vector3, f: Vector3): Float32Array {
  const w = new Float32Array(linkCount * 6);
  const m = new Vector3().copy(p).cross(f);
  const o = link * 6;
  w[o] = f.x; w[o + 1] = f.y; w[o + 2] = f.z;
  w[o + 3] = m.x; w[o + 4] = m.y; w[o + 5] = m.z;
  return w;
}

/** Holding torque of the lever's drive, with or without an external load. */
function holdingTorque(armMassKg: number, wrench: Float32Array | null): number {
  const rig = leverRig(armMassKg);
  const { topology, solver } = createSolverFor(provider, rig);
  try {
    seedRoot(solver, topology, rig);
    solver.jointValues[0] = 0;
    solver.solve(8, 0.001, 1e-6);
    solver.setDynamicsEnabled(true);
    const result = solver.solveStatics([0, -9.81, 0], wrench);
    expect(result.status).toBe(0);
    return solver.driveForce[0];
  } finally {
    solver.destroy();
  }
}

// ── A synthetic v3 artifact, for the gate ───────────────────────────────────
//
// Hand-built rather than kept around as a binary: the point is a module that
// passes the export-presence check and then reports the WRONG version, which is
// exactly the artifact-drift case (a worktree with yesterday's wasm) that must
// fail loud instead of solving a machine with no payload.

const V3_EXPORTS = [
  'rvk_abi_version', 'rvk_alloc', 'rvk_free', 'rvk_create', 'rvk_destroy',
  'rvk_solve', 'rvk_solve_inverse', 'rvk_set_dynamics_enabled',
  'rvk_solve_dynamics', 'rvk_solve_statics', 'rvk_dynamics_reset',
  'rvk_dynamics_status', 'rvk_dynamics_redundant', 'rvk_dynamics_output_ptr',
];

function uleb(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    out.push(b);
  } while (n !== 0);
  return out;
}

function section(id: number, payload: number[]): number[] {
  return [id, ...uleb(payload.length), ...payload];
}

/** A module whose every export is `() => version`, plus a memory. */
function fakeArtifact(version: number): Uint8Array {
  const n = V3_EXPORTS.length;
  const types = section(1, [1, 0x60, 0x00, 0x01, 0x7f]);              // () -> i32
  const funcs = section(3, [...uleb(n), ...new Array<number>(n).fill(0)]);
  const mems = section(5, [1, 0x00, 0x01]);                            // 1 page, no max
  const exportBody: number[] = [...uleb(n + 1)];
  exportBody.push(...uleb(6), ...[...'memory'].map((c) => c.charCodeAt(0)), 0x02, 0x00);
  V3_EXPORTS.forEach((name, i) => {
    exportBody.push(...uleb(name.length), ...[...name].map((c) => c.charCodeAt(0)), 0x00, ...uleb(i));
  });
  const exports = section(7, exportBody);
  const bodies: number[] = [...uleb(n)];
  for (let i = 0; i < n; i++) bodies.push(...uleb(4), 0x00, 0x41, ...uleb(version), 0x0b);
  const code = section(10, bodies);
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...types, ...funcs, ...mems, ...exports, ...code,
  ]);
}

describe('plan-467 9.7 — external link wrench (ABI v4)', () => {
  it('the host writes wire format 4 and the artifact reports 4', (ctx) => {
    if (!requireSolver(ctx)) return;
    expect(KINEMATIC_ABI_VERSION).toBe(4);
    expect(provider.version).toBe(4);
    expect(provider.failure).toBe('none');
  });

  it('rejects an artifact that reports ABI 3 as abi-mismatch', async () => {
    const url = URL.createObjectURL(
      new Blob([fakeArtifact(3) as unknown as BlobPart], { type: 'application/wasm' }),
    );
    try {
      const stale = new KinematicSolverProvider(url);
      await expect(stale.load()).resolves.toBe(false);
      expect(stale.failure).toBe('abi-mismatch');
      expect(stale.failureDetail).toMatch(/ABI version 3/);
      expect(stale.available).toBe(false);
    } finally {
      URL.revokeObjectURL(url);
    }
  });

  it('a 9.81 N payload 0.5 m out costs the drive exactly 4.905 N·m', (ctx) => {
    if (!requireSolver(ctx)) return;
    const w = wrenchAt(2, 1, new Vector3(0.5, 0, 0), new Vector3(0, -9.81, 0));
    const loaded4 = holdingTorque(0, w);
    expect(loaded4).toBeGreaterThan(4.905 - 1e-3);
    expect(loaded4).toBeLessThan(4.905 + 1e-3);
  });

  it('a null wrench is the v3 call — the massless lever costs nothing', (ctx) => {
    if (!requireSolver(ctx)) return;
    expect(Math.abs(holdingTorque(0, null))).toBeLessThan(1e-3);
  });

  it('the payload ADDS to the arm the machine already carries', (ctx) => {
    if (!requireSolver(ctx)) return;
    // 2 kg with its centre of mass at the arm origin, 0.5 m out: 9.81 N·m idle.
    const idle = holdingTorque(2, null);
    const w = wrenchAt(2, 1, new Vector3(0.5, 0, 0), new Vector3(0, -9.81, 0));
    const withPayload = holdingTorque(2, w);
    expect(idle).toBeGreaterThan(9.81 - 1e-2);
    expect(withPayload - idle).toBeGreaterThan(4.905 - 1e-3);
    expect(withPayload - idle).toBeLessThan(4.905 + 1e-3);
  });
});
