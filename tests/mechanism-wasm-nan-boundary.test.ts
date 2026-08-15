// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * T6b of plan-411 — the ARTEFACT evidence for the crate's NaN fix.
 *
 * A green `cargo test` proves the SOURCE is fixed. It says nothing about the
 * binary that actually ships. And the obvious end-to-end test proves nothing
 * either: `KinematicSolverInstance.solveInverse()` runs the host guard
 * (`RVK_NON_FINITE`), which returns `converged: false` for this configuration
 * BEFORE and AFTER the fix — identical result, zero evidence.
 *
 * So this file talks to the wasm exports DIRECTLY, mirroring what the provider
 * does around `rvk_solve_inverse` but reading `out_converged` / `out_residual`
 * raw, before any host interpretation. That is the only place where the core's
 * own convergence verdict is observable:
 *
 *   before the fix:  status 0, converged = 1, residual = 0   (vacuously "converged"
 *                    on a NaN pose — `NaN > max_abs` is false, so the 0.0-seeded
 *                    max-norm scan kept its seed)
 *   after the fix:   status 0, converged = 0, residual non-finite
 *
 * Plus the provenance half: the artefact in this tree must be the one
 * BUILD-PROVENANCE.md records, or the assertion above is about some other binary.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { KinematicSolverProvider, RVK_OK } from '@rv-private/kinematic-solver/rv-kinematic-solver-provider';
import { KINEMATIC_WASM_URL } from '@rv-private/kinematic-solver/rv-kinematic-wasm-url';
import { exportMechanismStateBlob } from '@rv-private/kinematic-mechanism/rv-kinematic-state-export';
import { fourBarRig, topologyOf } from './_mechanism-rigs';

/**
 * SHA-256 and size of the wasm artefact this tree ships, copied from
 * `<releaseDLLs>/rv-kinematic-solver/BUILD-PROVENANCE.md`
 * → *2026-08-08 — plan-412 Phases 1–2* → *Artefact — wasm*.
 *
 * The manifest lives out-of-repo (the crate is not in this git tree), so the
 * pin has to travel WITH the test. When the crate is rebuilt, both values move
 * here and in the manifest together — a mismatch means the tree carries a
 * binary nobody recorded, and the NaN assertions below would be about it.
 *
 * The NaN guard this file tests is unchanged by plan-412 (`solve.rs` and
 * `solve_inverse.rs` are byte-identical to the plan-411 entry); only the
 * enclosing binary moved, because the crate gained the dynamics kernel.
 */
const PROVENANCE = {
  sha256: '2ca57895cd615ff19f54a91db83c0276048aa9d13f1d5dd94aa629f035fe72bd',
  bytes: 124336,
  builtFrom: 'solve_inverse.rs 058f0460…, solve.rs e6256081… (unchanged), dynamics.rs 14e81855…',
};

let provider: KinematicSolverProvider;
let loaded = false;

beforeAll(async () => {
  provider = new KinematicSolverProvider();
  loaded = await provider.load();
});

function requireSolver(ctx: { skip: (note?: string) => void }): boolean {
  if (!loaded) {
    ctx.skip(`rv_kinematic_solver.wasm unavailable (${provider.failure}) — plan-411 Phase 4 artefact missing`);
    return false;
  }
  return true;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

describe('plan-411 T6b — provenance of the delivered wasm', () => {
  it('is byte-for-byte the artefact BUILD-PROVENANCE.md records', async (ctx) => {
    if (!requireSolver(ctx)) return;
    expect(KINEMATIC_WASM_URL).toBeTruthy();

    const response = await fetch(KINEMATIC_WASM_URL!);
    expect(response.ok).toBe(true);
    const bytes = await response.arrayBuffer();

    expect(bytes.byteLength).toBe(PROVENANCE.bytes);
    expect(await sha256Hex(bytes)).toBe(PROVENANCE.sha256);
  });
});

describe('plan-411 T6b — raw core convergence verdict (before the host guard)', () => {
  it('reports converged = 0 and a non-finite residual on the degenerate four-bar inverse', (ctx) => {
    if (!requireSolver(ctx)) return;
    const e = provider.exports!;
    expect(e).toBeTruthy();

    // ── build the mechanism through the RAW create path ───────────────────
    const rig = fourBarRig();
    const blob = exportMechanismStateBlob(topologyOf(rig), rig.joints);
    const s = blob.sizes;

    const BYTES = 4;
    const alloc = (count: number): number => e.rvk_alloc(Math.max(1, count) * BYTES);

    const ptrInts = alloc(blob.ints.length);
    const ptrFloats = alloc(blob.floats.length);
    new Int32Array(e.memory.buffer, ptrInts, blob.ints.length).set(blob.ints);
    new Float32Array(e.memory.buffer, ptrFloats, blob.floats.length).set(blob.floats);
    const handle = e.rvk_create(ptrInts, blob.ints.length, ptrFloats, blob.floats.length);
    e.rvk_free(ptrInts, blob.ints.length * BYTES);
    e.rvk_free(ptrFloats, blob.floats.length * BYTES);
    expect(handle).not.toBe(0);

    // ── per-call buffers, zeroed (the warm-start halves are IN/OUT) ────────
    const ptrInvQ = alloc(s.invQCount);
    const ptrInvFreeBodyRot = alloc(s.freeBodyCount * 4);
    const ptrJointValuesOut = alloc(s.jointCount);
    const ptrAnchor = alloc(3);
    const ptrTarget = alloc(3);
    const ptrResidual = alloc(1);
    const ptrConverged = alloc(1);
    for (const [ptr, count] of [
      [ptrInvQ, s.invQCount], [ptrInvFreeBodyRot, s.freeBodyCount * 4],
      [ptrJointValuesOut, s.jointCount], [ptrAnchor, 3], [ptrTarget, 3],
      [ptrResidual, 1], [ptrConverged, 1],
    ] as const) {
      new Float32Array(e.memory.buffer, ptr, Math.max(1, count)).fill(0);
    }

    // The exact configuration plan-411 §2.4 names: the planar four-bar's
    // inverse Jacobian is rank-deficient out of plane, and at damping 0.01 the
    // solve poisons itself with NaN.
    new Float32Array(e.memory.buffer, ptrAnchor, 3).set([0, 0, 0]);
    new Float32Array(e.memory.buffer, ptrTarget, 3).set([0.58, 0.32, 0]);

    const status = e.rvk_solve_inverse(
      handle,
      2,                       // target link: Rocker
      ptrAnchor, ptrTarget,
      40, 0.01, 1e-4,          // iterations, damping, tolerance
      0, 0,                    // no root seeding
      ptrInvQ, s.invQCount,
      s.freeBodyCount > 0 ? ptrInvFreeBodyRot : 0, s.freeBodyCount * 4,
      ptrJointValuesOut, s.jointCount,
      ptrResidual, ptrConverged,
    );

    // Views taken AFTER the call — it may have grown memory and detached earlier ones.
    const converged = new Int32Array(e.memory.buffer, ptrConverged, 1)[0];
    const residual = new Float32Array(e.memory.buffer, ptrResidual, 1)[0];
    const jointValuesOut = Array.from(
      new Float32Array(e.memory.buffer, ptrJointValuesOut, s.jointCount),
    );

    // The ABI call itself succeeded — this is NOT a panic path.
    expect(status).toBe(RVK_OK);

    const anyNonFinite = jointValuesOut.some((v) => !Number.isFinite(v));
    if (anyNonFinite) {
      // THE assertion of this file: a poisoned solve is never reported as
      // converged, and the residual it reports is the non-finite truth rather
      // than a flattering 0. Both were wrong before the crate fix.
      expect(converged).toBe(0);
      expect(Number.isFinite(residual)).toBe(false);
    } else {
      // A future core that stays finite here keeps the ordinary contract: a
      // finite residual, and no claim of convergence it cannot back up.
      expect(Number.isFinite(residual)).toBe(true);
      if (converged !== 0) expect(residual).toBeLessThanOrEqual(1e-3);
    }

    e.rvk_destroy(handle);
    for (const [ptr, count] of [
      [ptrInvQ, s.invQCount], [ptrInvFreeBodyRot, s.freeBodyCount * 4],
      [ptrJointValuesOut, s.jointCount], [ptrAnchor, 3], [ptrTarget, 3],
      [ptrResidual, 1], [ptrConverged, 1],
    ] as const) {
      e.rvk_free(ptr, Math.max(1, count) * BYTES);
    }
  });
});
