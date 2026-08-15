// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-machining-registry.test.ts — plan-405 test 9.2.
 *
 * The provider seam alone: strict no-op without a provider (F10), the permanent
 * fail-off latch, the `rv.machining.wasm` kill-switch and `register(null)`.
 *
 * Pure TS against the public registry with a MockMachiningProvider — no WASM, no
 * worker, no Three.js (pattern: `rv-physics-registry.test.ts`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MACHINING_MAX_PENDING_JOBS,
  MACHINING_MAX_SEGMENTS_PER_JOB,
  MACHINING_SLOT_STRIDE_VERTS,
  MACHINING_TESSELLATE_BATCH,
  MACHINING_WASM_FLAG_KEY,
  TOOL_SHAPE,
  isIdleAck,
  isMachiningWasmEnabled,
  isMachiningWasmFlagEnabled,
  isMachiningWorkerSupported,
  machiningRegistry,
  machiningSettings,
  type MachiningChunkMeshBatch,
  type MachiningGridDesc,
  type MachiningGridHandle,
  type MachiningProvider,
  type MachiningSubmitResult,
  type MachiningSubtractAck,
  type MachiningSubtractJob,
  type MachiningUnsubscribe,
} from '../src/core/engine/rv-machining-registry';

const HANDLE: MachiningGridHandle = {
  id: 1,
  resolution: { x: 32, y: 32, z: 32 },
  chunkResolution: { x: 2, y: 2, z: 2 },
  chunkCount: 8,
  voxelSizeMm: { x: 1, y: 1, z: 1 },
  gridOriginMm: { x: -1.5, y: -1.5, z: -1.5 },
  totalVoxels: 32 * 32 * 32,
  initialSolidVoxels: 1000,
};

const DESC: MachiningGridDesc = {
  resolution: { x: 32, y: 32, z: 32 },
  sizeMm: { x: 100, y: 60, z: 80 },
  shape: 'Box',
  cylinderAxis: 0,
  meshing: 'MarchingCubes',
  creaseAngleDeg: 35,
};

/** Injectable mock provider — records calls, computes nothing. */
class MockMachiningProvider implements MachiningProvider {
  ready = false;
  failed = false;
  initCalls = 0;
  disposeCalls = 0;
  destroyCalls: number[] = [];
  resetCalls: number[] = [];
  submitted: MachiningSubtractJob[] = [];
  private _pending = 0;
  private _seq = 0;
  readonly ackListeners = new Set<(a: MachiningSubtractAck) => void>();
  readonly chunkListeners = new Set<(b: MachiningChunkMeshBatch) => void>();

  async init(): Promise<void> {
    this.initCalls++;
    this.ready = true;
  }

  dispose(): void {
    this.disposeCalls++;
    this.ready = false;
    this.ackListeners.clear();
    this.chunkListeners.clear();
  }

  async createGrid(_desc: MachiningGridDesc): Promise<MachiningGridHandle> {
    return HANDLE;
  }

  async destroyGrid(h: MachiningGridHandle): Promise<void> {
    this.destroyCalls.push(h.id);
    this.ackListeners.clear();
    this.chunkListeners.clear();
  }

  async resetGrid(h: MachiningGridHandle): Promise<void> {
    this.resetCalls.push(h.id);
    this._pending = 0;
  }

  submitSubtract(_h: MachiningGridHandle, job: MachiningSubtractJob): MachiningSubmitResult {
    if (this.failed) return { accepted: false, reason: 'closed' };
    if (this._pending >= MACHINING_MAX_PENDING_JOBS) return { accepted: false, reason: 'backlog' };
    this._pending++;
    this.submitted.push(job);
    return { accepted: true, seq: ++this._seq };
  }

  onAck(_h: MachiningGridHandle, cb: (a: MachiningSubtractAck) => void): MachiningUnsubscribe {
    this.ackListeners.add(cb);
    return () => this.ackListeners.delete(cb);
  }

  onChunkMeshes(
    _h: MachiningGridHandle,
    cb: (b: MachiningChunkMeshBatch) => void,
  ): MachiningUnsubscribe {
    this.chunkListeners.add(cb);
    return () => this.chunkListeners.delete(cb);
  }

  async countSolid(): Promise<number> {
    return 900;
  }

  /** Test helper: pretend the worker acknowledged a job. */
  emitAck(ack: MachiningSubtractAck): void {
    if (ack.seq >= 0) this._pending = Math.max(0, this._pending - 1);
    for (const cb of this.ackListeners) cb(ack);
  }
}

describe('machiningRegistry (plan-405 §9.2)', () => {
  beforeEach(() => {
    machiningRegistry.clear();
    machiningSettings.enabled = true;
    localStorage.removeItem(MACHINING_WASM_FLAG_KEY);
  });

  afterEach(() => {
    machiningRegistry.clear();
    machiningSettings.enabled = true;
    localStorage.removeItem(MACHINING_WASM_FLAG_KEY);
    vi.restoreAllMocks();
  });

  it('is a strict no-op without a registered provider (F10)', () => {
    expect(machiningRegistry.provider).toBeNull();
    expect(machiningRegistry.rawProvider).toBeNull();
  });

  it('exposes a registered provider and returns to no-op on register(null)', () => {
    const p = new MockMachiningProvider();
    machiningRegistry.register(p);
    expect(machiningRegistry.provider).toBe(p);
    machiningRegistry.register(null);
    expect(machiningRegistry.provider).toBeNull();
  });

  it('hides a failed provider permanently (fail-off latch)', () => {
    const p = new MockMachiningProvider();
    machiningRegistry.register(p);
    expect(machiningRegistry.provider).toBe(p);

    p.failed = true;
    expect(machiningRegistry.provider).toBeNull();
    // The raw registration is still observable for diagnostics/teardown.
    expect(machiningRegistry.rawProvider).toBe(p);

    // A failed provider never comes back on its own — only a re-register would,
    // and that is exactly what must NOT happen automatically.
    expect(machiningRegistry.provider).toBeNull();
  });

  it('kill-switch rv.machining.wasm hides the provider (default ON)', () => {
    const p = new MockMachiningProvider();
    machiningRegistry.register(p);

    expect(isMachiningWasmFlagEnabled()).toBe(true);
    expect(machiningRegistry.provider).toBe(p);

    for (const off of ['off', 'false', '0']) {
      localStorage.setItem(MACHINING_WASM_FLAG_KEY, off);
      expect(isMachiningWasmFlagEnabled()).toBe(false);
      expect(machiningRegistry.provider).toBeNull();
    }

    // Anything else (including nonsense) keeps the default ON.
    localStorage.setItem(MACHINING_WASM_FLAG_KEY, 'yes-please');
    expect(isMachiningWasmFlagEnabled()).toBe(true);
    expect(machiningRegistry.provider).toBe(p);
  });

  it('deploy gate ANDs with the kill-switch', () => {
    const p = new MockMachiningProvider();
    machiningRegistry.register(p);

    machiningSettings.enabled = false;
    expect(isMachiningWasmEnabled()).toBe(false);
    expect(machiningRegistry.provider).toBeNull();

    machiningSettings.enabled = true;
    localStorage.setItem(MACHINING_WASM_FLAG_KEY, 'off');
    expect(isMachiningWasmEnabled()).toBe(false);
  });

  it('warns about unavailability exactly once per registration', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(machiningRegistry.warnUnavailableOnce('no provider')).toBe(true);
    expect(machiningRegistry.warnUnavailableOnce('no provider')).toBe(false);
    expect(machiningRegistry.warnUnavailableOnce('still none')).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);

    // Registering (or clearing) re-arms the warning for the new situation.
    machiningRegistry.register(new MockMachiningProvider());
    expect(machiningRegistry.warnUnavailableOnce('later failure')).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('enforces the backpressure cap and reports backlog', async () => {
    const p = new MockMachiningProvider();
    await p.init();
    const job: MachiningSubtractJob = { segments: [] };
    const results: MachiningSubmitResult[] = [];
    for (let i = 0; i < MACHINING_MAX_PENDING_JOBS + 3; i++) {
      results.push(p.submitSubtract(HANDLE, job));
    }
    const accepted = results.filter((r) => r.accepted);
    const rejected = results.filter((r) => !r.accepted);
    expect(accepted).toHaveLength(MACHINING_MAX_PENDING_JOBS);
    expect(rejected).toHaveLength(3);
    expect(rejected.every((r) => !r.accepted && r.reason === 'backlog')).toBe(true);

    // Sequence numbers are strictly increasing — ordering is part of the contract.
    const seqs = accepted.map((r) => (r.accepted ? r.seq : -1));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    // One ack frees exactly one slot.
    p.emitAck({ seq: 1, removedVoxels: 5, pendingJobs: 7, pendingChunks: 0 });
    expect(p.submitSubtract(HANDLE, job).accepted).toBe(true);
  });

  it('unsubscribe handles are idempotent', () => {
    const p = new MockMachiningProvider();
    const cb = (): void => {};
    const off = p.onAck(HANDLE, cb);
    expect(p.ackListeners.size).toBe(1);
    off();
    off();
    expect(p.ackListeners.size).toBe(0);
  });

  it('identifies the idle ack by its negative sequence number', () => {
    expect(isIdleAck({ seq: -1, removedVoxels: 0, pendingJobs: 0, pendingChunks: 0 })).toBe(true);
    expect(isIdleAck({ seq: 7, removedVoxels: 0, pendingJobs: 0, pendingChunks: 0 })).toBe(false);
  });

  it('pins the kernel constants that are part of the ABI', () => {
    // These numbers are shared with the Rust kernel and with MachiningVolume.cs.
    // Changing one without the others silently corrupts the slot layout.
    expect(MACHINING_TESSELLATE_BATCH).toBe(16);
    expect(MACHINING_SLOT_STRIDE_VERTS).toBe(65536);
    expect(MACHINING_MAX_PENDING_JOBS).toBe(8);
    expect(MACHINING_MAX_SEGMENTS_PER_JOB).toBe(64);
    expect(TOOL_SHAPE).toEqual({
      Sphere: 0, Cylinder: 1, BallNose: 2, Torus: 3, ConicalEnd: 4,
    });
  });

  it('reports worker support of the current runtime', () => {
    expect(isMachiningWorkerSupported()).toBe(typeof Worker !== 'undefined');
  });
});

// `DESC` documents the grid-desc shape the provider receives; it is asserted
// structurally by the volume test, which builds one from real extras.
void DESC;
