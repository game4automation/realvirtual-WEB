// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-machining-lifecycle.test.ts — plan-405 test 9.5.
 *
 * The {@link MachiningManager} against a scripted provider: grid creation,
 * `clearModel()` teardown (destroyGrid exactly once, listeners gone, geometries
 * disposed once), repeated model switches without leaks, the reset-signal edge as a
 * barrier, the SignalMachiningActive FALLING edge via the idle ack, the spindle gate
 * and the multiuser-follower gate.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BufferAttribute, BufferGeometry, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { applySchema, type ComponentContext } from '../src/core/engine/rv-component-registry';
import {
  MACHINING_FIRST_MESH_TIMEOUT_S,
  MachiningManager,
  type MachiningSignalHost,
} from '../src/core/engine/rv-machining-manager';
import { RVMachiningVolume, chunkResolutionFor } from '../src/core/engine/rv-machining-volume';
import { RVMachiningTool } from '../src/core/engine/rv-machining-tool';
import {
  machiningRegistry,
  type MachiningChunkMeshBatch,
  type MachiningGridDesc,
  type MachiningGridHandle,
  type MachiningProvider,
  type MachiningSubmitResult,
  type MachiningSubtractAck,
  type MachiningSubtractJob,
  type MachiningToolSegment,
  type MachiningUnsubscribe,
} from '../src/core/engine/rv-machining-registry';

// ─── Scripted provider ──────────────────────────────────────────────────

class ScriptedProvider implements MachiningProvider {
  ready = false;
  failed = false;
  initCalls = 0;
  disposeCalls = 0;
  readonly created: MachiningGridDesc[] = [];
  readonly destroyed: number[] = [];
  readonly resets: number[] = [];
  readonly jobs: MachiningSubtractJob[] = [];
  /** Reject every submit with `backlog` (coalescing tests). */
  backlog = false;
  countSolidValue = 500;
  private _nextId = 1;
  private _seq = 0;
  private readonly _acks = new Map<number, Set<(a: MachiningSubtractAck) => void>>();
  private readonly _chunks = new Map<number, Set<(b: MachiningChunkMeshBatch) => void>>();
  /** Resolvers of pending resetGrid promises (barrier tests). */
  private _pendingReset: (() => void) | null = null;
  holdReset = false;

  async init(): Promise<void> {
    this.initCalls++;
    this.ready = true;
  }

  dispose(): void {
    this.disposeCalls++;
    this.ready = false;
  }

  async createGrid(desc: MachiningGridDesc): Promise<MachiningGridHandle> {
    this.created.push(desc);
    const resolution = desc.resolution;
    const chunkResolution = chunkResolutionFor(resolution);
    const id = this._nextId++;
    this._acks.set(id, new Set());
    this._chunks.set(id, new Set());
    return {
      id,
      resolution,
      chunkResolution,
      chunkCount: chunkResolution.x * chunkResolution.y * chunkResolution.z,
      voxelSizeMm: {
        x: desc.sizeMm.x / (resolution.x - 3),
        y: desc.sizeMm.y / (resolution.y - 3),
        z: desc.sizeMm.z / (resolution.z - 3),
      },
      gridOriginMm: { x: -55, y: -33, z: -44 },
      totalVoxels: resolution.x * resolution.y * resolution.z,
      initialSolidVoxels: 1000,
    };
  }

  async destroyGrid(h: MachiningGridHandle): Promise<void> {
    this.destroyed.push(h.id);
    this._acks.get(h.id)?.clear();
    this._chunks.get(h.id)?.clear();
  }

  async resetGrid(h: MachiningGridHandle): Promise<void> {
    this.resets.push(h.id);
    if (!this.holdReset) return;
    await new Promise<void>((resolve) => { this._pendingReset = resolve; });
  }

  /** Completes a held reset (barrier test). */
  completeReset(): void {
    this._pendingReset?.();
    this._pendingReset = null;
  }

  submitSubtract(_h: MachiningGridHandle, job: MachiningSubtractJob): MachiningSubmitResult {
    if (this.backlog) return { accepted: false, reason: 'backlog' };
    this.jobs.push({ segments: job.segments.map((s) => ({ ...s })) });
    return { accepted: true, seq: ++this._seq };
  }

  onAck(h: MachiningGridHandle, cb: (a: MachiningSubtractAck) => void): MachiningUnsubscribe {
    this._acks.get(h.id)?.add(cb);
    return () => { this._acks.get(h.id)?.delete(cb); };
  }

  onChunkMeshes(
    h: MachiningGridHandle,
    cb: (b: MachiningChunkMeshBatch) => void,
  ): MachiningUnsubscribe {
    this._chunks.get(h.id)?.add(cb);
    return () => { this._chunks.get(h.id)?.delete(cb); };
  }

  async countSolid(): Promise<number> {
    return this.countSolidValue;
  }

  // ── Test drivers ──────────────────────────────────────────────────
  ackListenerCount(id: number): number { return this._acks.get(id)?.size ?? 0; }
  chunkListenerCount(id: number): number { return this._chunks.get(id)?.size ?? 0; }

  emitAck(id: number, ack: MachiningSubtractAck): void {
    for (const cb of [...(this._acks.get(id) ?? [])]) cb(ack);
  }

  emitChunks(id: number, batch: MachiningChunkMeshBatch): void {
    for (const cb of [...(this._chunks.get(id) ?? [])]) cb(batch);
  }
}

// ─── Fixtures ───────────────────────────────────────────────────────────

/**
 * The manager talks to the SignalStore through its PATH-based API — signal fields
 * arrive from the loader as full hierarchy paths, and the flat-name `get`/`set` would
 * answer those with a default plus a console warning (the plan-405 live-test finding
 * F3). Deliberately implements ONLY the path methods, so a regression back to
 * `get`/`set` fails to compile.
 */
class FakeSignals implements MachiningSignalHost {
  readonly values = new Map<string, boolean | number>();
  getBoolByPath(path: string): boolean { return this.values.get(path) === true; }
  setByPath(path: string, value: boolean | number): void { this.values.set(path, value); }
}

function makeContext(registry: NodeRegistry, manager: MachiningManager): ComponentContext {
  return {
    registry,
    scene: new Scene(),
    signalStore: {} as ComponentContext['signalStore'],
    transportManager: {} as ComponentContext['transportManager'],
    root: new Object3D(),
    machiningManager: manager,
  } as ComponentContext;
}

function makeVolume(
  registry: NodeRegistry,
  manager: MachiningManager,
  extras: Record<string, unknown> = {},
): RVMachiningVolume {
  const node = new Object3D();
  node.name = 'Workpiece';
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
  node.add(new Mesh(geo, new MeshStandardMaterial()));
  const scene = new Scene();
  scene.add(node);

  const v = new RVMachiningVolume(node);
  applySchema(v as unknown as Record<string, unknown>, RVMachiningVolume.schema, {
    gridResolution: { x: 32, y: 32, z: 32 },
    workpieceSize: { x: 100, y: 60, z: 80 },
    ...extras,
  });
  const ctx = makeContext(registry, manager);
  v.init(ctx);
  v.onSceneReady(ctx);
  return v;
}

function attachTool(volume: RVMachiningVolume, registry: NodeRegistry, name = 'Tool'): RVMachiningTool {
  const node = new Object3D();
  node.name = name;
  node.position.set(0.01, 0, 0);
  volume.node.parent!.add(node);
  const tool = new RVMachiningTool(node);
  applySchema(tool as unknown as Record<string, unknown>, RVMachiningTool.schema, {
    Shape: 'Cylinder', ToolDiameter: 10, ToolLength: 40,
  });
  tool.init({} as ComponentContext);
  registry.registerNode(name, node);
  registry.register('MachiningTool', name, tool);
  volume.Tools = [node];
  volume.resolveTools();
  return tool;
}

/** Lets the manager's async grid creation settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

const CHUNK = {
  chunkIndex: 0,
  vertexCount: 3,
  indexCount: 3,
  positions: new Float32Array(9),
  normals: new Float32Array(9),
  uvs: new Float32Array(6),
  indices: new Uint32Array([0, 1, 2]),
};

function batch(epoch = 0, pendingChunks = 0): MachiningChunkMeshBatch {
  return { epoch, chunks: [{ ...CHUNK }], pendingChunks };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('MachiningManager — grid lifecycle (plan-405 §9.5)', () => {
  let provider: ScriptedProvider;
  let manager: MachiningManager;
  let registry: NodeRegistry;
  let signals: FakeSignals;

  beforeEach(() => {
    provider = new ScriptedProvider();
    machiningRegistry.register(provider);
    manager = new MachiningManager();
    signals = new FakeSignals();
    manager.setSignalHost(signals);
    registry = new NodeRegistry();
  });

  afterEach(() => {
    manager.clear();
    machiningRegistry.clear();
    vi.restoreAllMocks();
  });

  it('creates one grid per volume, lazily on the first tick', async () => {
    const v = makeVolume(registry, manager);
    expect(manager.size).toBe(1);
    expect(provider.created).toHaveLength(0); // nothing happens before the first tick

    manager.update(0.02);
    await settle();

    expect(provider.initCalls).toBe(1);
    expect(provider.created).toHaveLength(1);
    expect(v.IsInitialized).toBe(true);
    expect(provider.ackListenerCount(1)).toBe(1);
    expect(provider.chunkListenerCount(1)).toBe(1);

    // Idempotent: a second tick must not create a second grid.
    manager.update(0.02);
    await settle();
    expect(provider.created).toHaveLength(1);
  });

  it('clear() destroys every grid exactly once and drops all listeners', async () => {
    const v = makeVolume(registry, manager);
    manager.update(0.02);
    await settle();
    provider.emitChunks(1, batch());
    manager.update(0.02);
    const geometry = (v.chunkRoot!.children[0] as Mesh).geometry;
    const disposeSpy = vi.spyOn(geometry, 'dispose');

    manager.clear();
    await settle();

    expect(provider.destroyed).toEqual([1]);
    expect(provider.ackListenerCount(1)).toBe(0);
    expect(provider.chunkListenerCount(1)).toBe(0);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(v.chunkRoot).toBeNull();
    expect(manager.size).toBe(0);

    // A second clear() must not destroy anything again.
    manager.clear();
    await settle();
    expect(provider.destroyed).toEqual([1]);
  });

  it('survives repeated model switches without leaking grids or listeners', async () => {
    for (let round = 0; round < 3; round++) {
      makeVolume(registry, manager);
      manager.update(0.02);
      await settle();
      manager.clear();
      await settle();
    }
    expect(provider.created).toHaveLength(3);
    expect(provider.destroyed).toEqual([1, 2, 3]);
    for (const id of [1, 2, 3]) {
      expect(provider.ackListenerCount(id)).toBe(0);
      expect(provider.chunkListenerCount(id)).toBe(0);
    }
  });

  it('destroys a grid that finished creating after the volume was unregistered', async () => {
    const v = makeVolume(registry, manager);
    manager.update(0.02);          // starts the async createGrid
    manager.unregister(v);         // ... and it is gone before it resolves
    await settle();
    expect(provider.destroyed).toContain(1);
    expect(manager.size).toBe(0);
  });

  it('dispose() terminates the provider after clearing the grids', async () => {
    makeVolume(registry, manager);
    manager.update(0.02);
    await settle();
    manager.dispose();
    await settle();
    expect(provider.destroyed).toEqual([1]);
    expect(provider.disposeCalls).toBe(1);
  });

  it('is a no-op with one warning when no provider is registered (F10)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    machiningRegistry.clear();
    const v = makeVolume(registry, manager);

    expect(manager.update(0.02)).toBe(false);
    expect(manager.update(0.02)).toBe(false);
    await settle();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(v.IsInitialized).toBe(false);
  });

  // ── F10 degradation AFTER the workpiece was already hidden ──────────
  //
  // `attachGrid()` hides the authored mesh, so from that moment the chunk meshes
  // are the only thing representing the workpiece. The plan-405 live test found
  // both ways this can go wrong with nothing left on screen: a worker whose pump
  // died silently (grid created, chunks never arrive) and a provider that latches
  // off later. Both must put the authored mesh BACK.

  it('restores the authored mesh when no chunk mesh ever arrives (F10 watchdog)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const v = makeVolume(registry, manager);
    const authored = v.node.children.find((c) => (c as Mesh).isMesh) as Mesh;

    manager.update(0.02);
    await settle();
    expect(v.IsInitialized).toBe(true);
    expect(authored.visible).toBe(false); // hidden in favour of chunks that never come

    // Just under the timeout: still waiting, still hidden.
    manager.update(MACHINING_FIRST_MESH_TIMEOUT_S - 0.5);
    expect(authored.visible).toBe(false);

    // Past it: degrade. The frame is reported dirty because the mesh reappeared.
    expect(manager.update(1)).toBe(true);
    expect(authored.visible).toBe(true);
    expect(v.IsInitialized).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);

    // Idempotent — no repeated dirty frames, no second warning.
    expect(manager.update(1)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('restores the authored mesh when the provider fails off after the grid exists', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const v = makeVolume(registry, manager);
    const authored = v.node.children.find((c) => (c as Mesh).isMesh) as Mesh;

    manager.update(0.02);
    await settle();
    // A chunk arrives, so the starvation watchdog is disarmed — only the fail-off
    // path can restore the mesh from here.
    provider.emitChunks(1, { epoch: 0, chunks: [], pendingChunks: 0 });
    manager.update(0.02);
    expect(authored.visible).toBe(false);

    provider.failed = true;           // WASM trap → permanent fail-off latch
    expect(manager.update(0.02)).toBe(true);
    expect(authored.visible).toBe(true);
    expect(v.IsInitialized).toBe(false);
  });
});

describe('MachiningManager — signals (plan-405 §2.5, §9.5)', () => {
  let provider: ScriptedProvider;
  let manager: MachiningManager;
  let registry: NodeRegistry;
  let signals: FakeSignals;

  beforeEach(async () => {
    provider = new ScriptedProvider();
    machiningRegistry.register(provider);
    manager = new MachiningManager();
    signals = new FakeSignals();
    manager.setSignalHost(signals);
    registry = new NodeRegistry();
  });

  afterEach(() => {
    manager.clear();
    machiningRegistry.clear();
  });

  async function ready(extras: Record<string, unknown> = {}): Promise<RVMachiningVolume> {
    const v = makeVolume(registry, manager, extras);
    manager.update(0.02);
    await settle();
    return v;
  }

  it('submits a swept segment per tool while the spindle runs', async () => {
    const v = await ready();
    v.SignalSpindleOn = 'Spindle';
    signals.setByPath('Spindle', true);
    attachTool(v, registry);

    manager.update(0.02);
    expect(provider.jobs).toHaveLength(1);
    expect(provider.jobs[0].segments).toHaveLength(1);
    const seg = provider.jobs[0].segments[0];
    expect(seg.radius).toBe(5);
    expect(seg.shape).toBe(1);
    // First tick has no previous pose → no sweep, start === end, 1 substep.
    expect(seg.substeps).toBe(1);
    expect(seg.posStart).toEqual(seg.posEnd);
  });

  it('sweeps between two ticks and drops continuity when the spindle stops', async () => {
    const v = await ready();
    v.SignalSpindleOn = 'Spindle';
    signals.setByPath('Spindle', true);
    const tool = attachTool(v, registry);

    manager.update(0.02);
    tool.node.position.set(0.05, 0, 0);
    manager.update(0.02);

    const swept = provider.jobs[1].segments[0];
    expect(swept.posStart).not.toEqual(swept.posEnd);
    expect(swept.substeps).toBeGreaterThan(1);

    // Spindle off: no job, and the pose travelled while it was off must NOT be
    // swept over once it comes back on.
    signals.setByPath('Spindle', false);
    tool.node.position.set(0.09, 0, 0);
    manager.update(0.02);
    expect(provider.jobs).toHaveLength(2);

    signals.setByPath('Spindle', true);
    manager.update(0.02);
    const afterResume = provider.jobs[2].segments[0];
    expect(afterResume.posStart).toEqual(afterResume.posEnd);
  });

  it('prepends the segments of a rejected tick to the next job (coalescing)', async () => {
    const v = await ready();
    v.SignalSpindleOn = 'Spindle';
    signals.setByPath('Spindle', true);
    const tool = attachTool(v, registry);

    provider.backlog = true;
    manager.update(0.02);
    tool.node.position.set(0.05, 0, 0);
    manager.update(0.02);
    tool.node.position.set(0.09, 0, 0);
    manager.update(0.02);
    expect(provider.jobs).toHaveLength(0);

    provider.backlog = false;
    tool.node.position.set(0.12, 0, 0);
    manager.update(0.02);

    expect(provider.jobs).toHaveLength(1);
    const segments = provider.jobs[0].segments;
    // All four ticks survive as their own segment — chronological, chained.
    expect(segments).toHaveLength(4);
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i].posStart).toEqual(segments[i - 1].posEnd);
    }
    // ... and the chord shortcut is NOT what was sent.
    expect(segments[0].posEnd).not.toEqual(segments[3].posEnd);

    // The buffer is cleared once the job was accepted.
    manager.update(0.02);
    expect(provider.jobs[1].segments).toHaveLength(1);
  });

  it('MachiningActive rises with outstanding work and FALLS on the idle ack', async () => {
    const v = await ready();
    v.SignalMachiningActive = 'Active';
    v.SignalSpindleOn = 'Spindle';
    signals.setByPath('Spindle', true);
    attachTool(v, registry);

    // 1) an ack that still reports outstanding work → true
    provider.emitAck(1, { seq: 1, removedVoxels: 42, pendingJobs: 1, pendingChunks: 4 });
    manager.update(0.02);
    expect(signals.getBoolByPath('Active')).toBe(true);
    expect(v.VoxelsModified).toBe(42);

    // 2) the final batch is applied, but the ack still had work queued
    provider.emitChunks(1, batch());
    manager.update(0.02);
    expect(signals.getBoolByPath('Active')).toBe(true);

    // 3) the worker's IDLE ack pulls it low in the very next tick
    provider.emitAck(1, { seq: -1, removedVoxels: 0, pendingJobs: 0, pendingChunks: 0 });
    manager.update(0.02);
    expect(signals.getBoolByPath('Active')).toBe(false);
    expect(v.PendingChunkCount).toBe(0);
    // The accumulated removal counter is NOT reset by the idle ack.
    expect(v.VoxelsModified).toBe(42);
  });

  it('reset rises only on the EDGE and acts as a barrier', async () => {
    const v = await ready();
    v.SignalReset = 'Reset';
    provider.holdReset = true;

    signals.setByPath('Reset', true);
    expect(manager.update(0.02)).toBe(true);
    expect(provider.resets).toEqual([1]);
    v.MaterialRemainingPercent = 100;

    // Held high → no second reset (a per-tick full rebuild would be ruinous).
    manager.update(0.02);
    manager.update(0.02);
    expect(provider.resets).toEqual([1]);

    // While the barrier is open, no jobs are submitted.
    v.SignalSpindleOn = 'Spindle';
    signals.setByPath('Spindle', true);
    attachTool(v, registry);
    manager.update(0.02);
    expect(provider.jobs).toHaveLength(0);

    provider.completeReset();
    await settle();
    manager.update(0.02);
    expect(provider.jobs).toHaveLength(1);

    // Falling then rising again triggers a second reset.
    signals.setByPath('Reset', false);
    manager.update(0.02);
    signals.setByPath('Reset', true);
    manager.update(0.02);
    expect(provider.resets).toEqual([1, 1]);
  });

  it('reset hides the chunks and clears the statistics', async () => {
    const v = await ready();
    v.SignalReset = 'Reset';
    provider.emitChunks(1, batch());
    manager.update(0.02);
    const mesh = v.chunkRoot!.children[0] as Mesh;
    expect(mesh.visible).toBe(true);
    v.MaterialRemainingPercent = 42;
    v.VoxelsModified = 999;

    signals.setByPath('Reset', true);
    manager.update(0.02);
    await settle();

    expect(mesh.visible).toBe(false);
    expect(v.MaterialRemainingPercent).toBe(100);
    expect(v.VoxelsModified).toBe(0);
  });

  it('discards chunk batches from a stale epoch', async () => {
    const v = await ready();
    v.SignalReset = 'Reset';
    signals.setByPath('Reset', true);
    manager.update(0.02);          // epoch 0 → 1
    await settle();

    // A batch produced BEFORE the reset must not repaint the fresh workpiece.
    provider.emitChunks(1, batch(0));
    expect(manager.update(0.02)).toBe(false);
    expect(v.chunkMeshCount).toBe(0);

    provider.emitChunks(1, batch(1));
    expect(manager.update(0.02)).toBe(true);
    expect(v.chunkMeshCount).toBe(1);
  });

  it('refreshes MaterialRemainingPercent on the statistics interval only', async () => {
    const v = await ready({ StatisticsInterval: 0.5 });
    provider.countSolidValue = 250; // of 1000 initial → 25 %

    manager.update(0.1);
    await settle();
    expect(v.MaterialRemainingPercent).toBe(100); // interval not elapsed

    manager.update(0.5);
    await settle();
    expect(v.MaterialRemainingPercent).toBeCloseTo(25, 6);
  });
});

describe('MachiningManager — gating (plan-405 §2.4, §9.5)', () => {
  let provider: ScriptedProvider;
  let manager: MachiningManager;
  let registry: NodeRegistry;

  beforeEach(() => {
    provider = new ScriptedProvider();
    machiningRegistry.register(provider);
    manager = new MachiningManager();
    manager.setSignalHost(new FakeSignals());
    registry = new NodeRegistry();
  });

  afterEach(() => {
    manager.clear();
    machiningRegistry.clear();
  });

  it('does nothing while disabled (DES fast-forward)', async () => {
    makeVolume(registry, manager);
    manager.enabled = false;
    expect(manager.update(0.02)).toBe(false);
    await settle();
    expect(provider.created).toHaveLength(0);

    manager.enabled = true;
    manager.update(0.02);
    await settle();
    expect(provider.created).toHaveLength(1);
  });

  it('skips volumes owned by another peer (multiuser follower)', async () => {
    const v = makeVolume(registry, manager);
    v.isOwner = false;
    manager.update(0.02);
    await settle();
    expect(provider.created).toHaveLength(0);

    v.isOwner = true;
    manager.update(0.02);
    await settle();
    expect(provider.created).toHaveLength(1);
  });

  it('applies segments in the volume tool ORDER', async () => {
    const v = makeVolume(registry, manager);
    manager.update(0.02);
    await settle();

    const a = attachTool(v, registry, 'ToolA');
    const b = attachTool(v, registry, 'ToolB');
    a.ToolDiameter = 10;
    b.ToolDiameter = 20;
    v.Tools = [b.node, a.node];
    v.resolveTools();

    manager.update(0.02);
    const radii = provider.jobs[0].segments.map((s: MachiningToolSegment) => s.radius);
    expect(radii).toEqual([10, 5]); // ToolB first — exactly as listed
  });
});
