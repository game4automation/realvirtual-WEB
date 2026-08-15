// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * T12 — Fail-loud paths of the mechanism solver (plan-404 F7 / R2, §9).
 *
 * A missing, unreachable, corrupt or version-mismatched artifact must disable
 * mechanisms with a clear reason — never degrade to "sort of running" and never
 * throw out of `load()`, because every caller's correct reaction is identical.
 * There is deliberately NO TypeScript fallback solver.
 *
 * These cases need no artifact of their own: they drive the provider's URL
 * override with deliberately broken inputs, so the whole file runs
 * unconditionally.
 */

import { describe, it, expect } from 'vitest';
import { KinematicSolverProvider } from '@rv-private/kinematic-solver/rv-kinematic-solver-provider';
import { singleRevoluteRig, topologyOf } from './_mechanism-rigs';
import { exportMechanismStateBlob } from '@rv-private/kinematic-mechanism/rv-kinematic-state-export';

describe('T12 — provider failure paths', () => {
  it('a build WITHOUT the artifact reports artifact-missing, never throws', async () => {
    const provider = new KinematicSolverProvider(null);
    await expect(provider.load()).resolves.toBe(false);
    expect(provider.available).toBe(false);
    expect(provider.failure).toBe('artifact-missing');
    expect(provider.failureDetail).toContain('rv_kinematic_solver.wasm');
  });

  it('an unreachable artifact URL fails loudly, whatever the server answers', async () => {
    // Note the two shapes this can take, both of which must disable the feature:
    // a real 404 gives `fetch-failed`, but a dev/SPA server that rewrites unknown
    // paths to index.html answers 200 with HTML, which then fails to compile as
    // `instantiate-failed`. The contract is "loud and unavailable", not a
    // specific error code — asserting only one of them would make this test pass
    // or fail on the server's routing rather than on the provider.
    const provider = new KinematicSolverProvider('/definitely-not-here/rv_kinematic_solver.wasm');
    await expect(provider.load()).resolves.toBe(false);
    expect(provider.available).toBe(false);
    expect(['fetch-failed', 'instantiate-failed']).toContain(provider.failure);
    expect(provider.failureDetail.length).toBeGreaterThan(0);
  });

  it('corrupt bytes report instantiate-failed instead of crashing the viewer', async () => {
    // A URL that resolves to something that is definitely not a wasm module.
    const notWasm = URL.createObjectURL(new Blob(['this is not webassembly'], { type: 'application/wasm' }));
    try {
      const provider = new KinematicSolverProvider(notWasm);
      await expect(provider.load()).resolves.toBe(false);
      expect(provider.failure).toBe('instantiate-failed');
      expect(provider.available).toBe(false);
    } finally {
      URL.revokeObjectURL(notWasm);
    }
  });

  it('a module without the expected exports reports abi-mismatch by name', async () => {
    // Minimal valid wasm module (magic + version, no exports at all). It
    // INSTANTIATES fine, which is exactly why the export presence check has to
    // exist: the next call would otherwise be "undefined is not a function".
    const empty = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const url = URL.createObjectURL(new Blob([empty], { type: 'application/wasm' }));
    try {
      const provider = new KinematicSolverProvider(url);
      await expect(provider.load()).resolves.toBe(false);
      expect(provider.failure).toBe('abi-mismatch');
      expect(provider.failureDetail).toMatch(/missing/);
    } finally {
      URL.revokeObjectURL(url);
    }
  });

  it('an unavailable provider refuses to create mechanisms, quietly and safely', async () => {
    const provider = new KinematicSolverProvider(null);
    await provider.load();
    const rig = singleRevoluteRig();
    const blob = exportMechanismStateBlob(topologyOf(rig), rig.joints);
    // No throw, no handle — the caller disables the mechanism with the reason.
    expect(provider.createMechanism(blob.ints, blob.floats, blob.sizes)).toBeNull();
    expect(provider.createCount).toBe(0);
  });

  it('destroyAll on an unavailable provider is a safe no-op', async () => {
    const provider = new KinematicSolverProvider(null);
    await provider.load();
    expect(() => provider.destroyAll()).not.toThrow();
    expect(provider.liveInstanceCount).toBe(0);
  });

  it('a failed load leaves the counters at zero (nothing half-allocated)', async () => {
    const provider = new KinematicSolverProvider('/definitely-not-here.wasm');
    await provider.load();
    expect(provider.available).toBe(false);
    expect(provider.createCount).toBe(0);
    expect(provider.destroyCount).toBe(0);
    expect(provider.allocCount).toBe(0);
    expect(provider.freeCount).toBe(0);
  });
});
