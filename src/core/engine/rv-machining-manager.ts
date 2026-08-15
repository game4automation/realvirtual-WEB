// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-machining-manager.ts — viewer-owned per-tick driver for CSG material
 * removal (plan-405).
 *
 * Modelled on {@link EnergyChainManager}: the viewer owns the instance, threads
 * it through `ComponentContext`, the components register THEMSELVES, and
 * `update(dt)` returns `true` when something visible changed — the caller then
 * marks BOTH render- and shadow-dirty, because a machined chunk changes the
 * silhouette and nothing else in the tick pipeline would raise the shadow flag
 * for it.
 *
 * It is ticked from `CoreSubsystems.visuals(dt)` AFTER the drive stage, so tool
 * poses are read from the freshly applied axis positions of the SAME tick. It
 * is NOT a new tick stage.
 *
 * Per tick and volume:
 *   1. `SignalReset` rising edge → `resetGrid()` **barrier** (queued jobs are
 *      discarded; the promise resolves only after the worker re-initialized).
 *   2. `SignalSpindleOn` false → no subtraction, and every tool's sweep
 *      continuity is dropped so switching the spindle back on does not cut the
 *      path travelled while it was off (parity with `MachiningVolume.cs`).
 *   3. Otherwise: build one swept segment per tool (grid space) and submit ONE
 *      job. A `backlog` rejection does not drop the motion — the segments are
 *      pushed to the FRONT of the next job, so a curved path A→B→C stays two
 *      segments and never collapses into the chord A→C.
 *   4. Apply chunk batches that arrived since the last tick.
 *   5. `SignalMachiningActive` = `pendingJobs + pendingChunks > 0` from the
 *      LAST ack (momentary, never latched — the worker's idle ack pulls it low).
 *
 * Everything in the hot path is pre-allocated: the sweep state lives in a Map
 * keyed by the tool component, the segment array is reused, and the scratch
 * vectors/quaternions are module-level singletons.
 */

import { Quaternion, Vector3 } from 'three';
import { MM_TO_METERS } from './rv-constants';
import {
  MACHINING_MAX_SEGMENTS_PER_JOB,
  isMachiningWorkerSupported,
  machiningRegistry,
  type MachiningChunkMeshBatch,
  type MachiningGridHandle,
  type MachiningProvider,
  type MachiningSubtractAck,
  type MachiningToolSegment,
  type MachiningUnsubscribe,
} from './rv-machining-registry';
import type { RVMachiningVolume } from './rv-machining-volume';
import type { RVMachiningTool } from './rv-machining-tool';
import type { CollisionMachiningBridge } from './rv-collision-manager';

/**
 * Slice of `SignalStore` the manager needs. Structural — no import cycle.
 *
 * PATH-based, not name-based: the scene loader resolves `SignalSpindleOn` &co. to the
 * signal node's full hierarchy path (`Model/Station/Signals/MachiningActive`), which is
 * what `getBoolByPath`/`setByPath` take. `get`/`set` are the flat-NAME API and answer a
 * path with a default plus a console warning — the same trap `RVSensor` avoids by using
 * `setByPath`.
 */
export interface MachiningSignalHost {
  getBoolByPath(path: string): boolean;
  setByPath(path: string, value: boolean | number, now?: number): void;
}

/**
 * Hard safety cap on the coalescing buffer. This is NOT the documented
 * degradation point (that is {@link MACHINING_MAX_SEGMENTS_PER_JOB}, applied by
 * the worker as substep reduction) — it is the last line of defence against an
 * unbounded buffer if the worker were to stop acknowledging entirely.
 */
const COALESCE_HARD_CAP = 16 * MACHINING_MAX_SEGMENTS_PER_JOB;

/**
 * Seconds a volume may stay chunk-less after its grid was reported before the
 * feature degrades for that volume.
 *
 * `attachGrid()` HIDES the authored workpiece — from that moment the chunk meshes
 * are the only thing representing it. If they never arrive (a worker that answers
 * requests but whose pump is dead, the exact plan-405 live-test failure), the
 * workpiece is simply gone, which is worse than no machining at all. This watchdog
 * makes the F10 promise hold in that case too: the authored mesh comes back.
 *
 * Generous on purpose — the first full tessellation of a 128-chunk grid is several
 * pump turns, and a cold WASM start on a slow machine takes seconds.
 */
export const MACHINING_FIRST_MESH_TIMEOUT_S = 10;

/** Sweep continuity per tool, in the grid space of ONE volume. */
interface ToolSweepState {
  lastPos: Vector3;
  lastRot: Quaternion;
  hasLastPose: boolean;
}

type GridState = 'none' | 'creating' | 'ready' | 'failed';

/** Everything the manager tracks for one registered volume. */
interface VolumeEntry {
  volume: RVMachiningVolume;
  state: GridState;
  grid: MachiningGridHandle | null;
  /** Sweep continuity, one slot per tool component. */
  sweep: Map<RVMachiningTool, ToolSweepState>;
  /** Segments of ticks the provider rejected with `backlog`. */
  coalesced: MachiningToolSegment[];
  /** Chunk batches received since the last tick (applied in `update`). */
  inbox: MachiningChunkMeshBatch[];
  unsubscribes: MachiningUnsubscribe[];
  lastResetSignal: boolean;
  lastAck: MachiningSubtractAck | null;
  removedAccum: number;
  statsTimer: number;
  statsInFlight: boolean;
  /** Bumped on reset/teardown; batches from an older epoch are discarded. */
  epoch: number;
  /** True while a reset barrier is in flight (no jobs are submitted). */
  resetting: boolean;
  warnedCoalesceCap: boolean;
  /** Seconds since `attachGrid()` while not a single chunk mesh has arrived. */
  starvedFor: number;
  /** True once any chunk mesh was applied — disarms the starvation watchdog. */
  everRendered: boolean;
  /**
   * Collision suppression bookkeeping per tool (plan-409 F5). `reported` is the
   * spindle state last handed to the collision manager, `null` = never reported,
   * which is what makes the INITIAL state a report rather than a missed edge.
   */
  assoc: Map<RVMachiningTool, { readonly key: string; reported: boolean | null }>;
}

// Hot-path scratch (module-level: the manager is a viewer singleton).
const _worldPos = new Vector3();
const _localPos = new Vector3();
const _worldQuat = new Quaternion();
const _volQuat = new Quaternion();
const _volQuatInv = new Quaternion();
const _toolQuat = new Quaternion();

/** Viewer-owned registry + fixed-update driver for MachiningVolume components. */
export class MachiningManager {
  private readonly _entries = new Map<RVMachiningVolume, VolumeEntry>();
  private _signals: MachiningSignalHost | null = null;
  private _providerInit: Promise<void> | null = null;
  /** Collision suppression seam (plan-409); null when no collision manager. */
  private _collision: CollisionMachiningBridge | null = null;
  /**
   * Master gate. Turned off for DES fast-forward (machining is a continuous,
   * per-tick visual effect and has no meaning inside an event-jump), mirroring
   * how the physics plugin is disabled there.
   */
  enabled = true;

  get size(): number {
    return this._entries.size;
  }

  /** Wire the signal store once per model load. */
  setSignalHost(host: MachiningSignalHost | null): void {
    this._signals = host;
  }

  /** The active provider, or null when machining is unavailable. */
  private get provider(): MachiningProvider | null {
    return machiningRegistry.provider;
  }

  // ── Registration ─────────────────────────────────────────────────────

  register(volume: RVMachiningVolume): void {
    if (this._entries.has(volume)) return;
    this._entries.set(volume, {
      volume,
      state: 'none',
      grid: null,
      sweep: new Map(),
      coalesced: [],
      inbox: [],
      unsubscribes: [],
      lastResetSignal: false,
      lastAck: null,
      removedAccum: 0,
      statsTimer: 0,
      statsInFlight: false,
      epoch: 0,
      resetting: false,
      warnedCoalesceCap: false,
      starvedFor: 0,
      everRendered: false,
      assoc: new Map(),
    });
    // Report the INITIAL suppression state right away — `resolveTools()` has
    // already run at this point (onSceneReady), and the collision manager holds
    // the association until bodies exist for it, so nothing is lost by being
    // early. Without this a scene whose spindle is on from tick one (or has no
    // SignalSpindleOn at all) would alarm before the first state change.
    this.syncAssociations(this._entries.get(volume)!);
  }

  unregister(volume: RVMachiningVolume): void {
    const entry = this._entries.get(volume);
    if (!entry) return;
    this._entries.delete(volume);
    void this.teardownEntry(entry);
  }

  // ── Collision bridge (plan-409) ──────────────────────────────────────

  /**
   * Wire the collision manager. Machining is the only side that knows which
   * tool is legitimately inside which workpiece, so it is the side that reports.
   * `null` detaches (viewer teardown).
   */
  setCollisionBridge(bridge: CollisionMachiningBridge | null): void {
    if (this._collision === bridge) return;
    if (this._collision) {
      for (const entry of this._entries.values()) this.dropAssociations(entry);
    }
    this._collision = bridge;
    if (!bridge) return;
    for (const entry of this._entries.values()) this.syncAssociations(entry);
  }

  /**
   * Push the current spindle state of every (volume, tool) association.
   *
   * STATE-based and idempotent: a call reports only what actually changed, so
   * running it every tick costs one signal read plus a comparison per tool and
   * never allocates. Edge detection is deliberately NOT used — an edge missed
   * while the collision manager was still detaching would stay missed forever.
   *
   * Tool discovery itself is static after scene-ready (`resolveTools()` runs
   * once in `onSceneReady`), which is a documented limit: a tool added to the
   * list at runtime is not picked up.
   */
  private syncAssociations(entry: VolumeEntry): void {
    const bridge = this._collision;
    if (!bridge) return;
    const volume = entry.volume;
    const tools = volume.tools;
    const spindleOn = this.readBool(volume.SignalSpindleOn, true);

    // Tools are static after scene-ready, so the (O(n²)) stale scan only runs
    // when the counts actually disagree.
    if (entry.assoc.size !== tools.length) {
      for (const [tool, rec] of entry.assoc) {
        if (tools.includes(tool)) continue;
        bridge.removeMachiningAssociation(rec.key);
        entry.assoc.delete(tool);
      }
    }

    for (const tool of tools) {
      let rec = entry.assoc.get(tool);
      if (!rec) {
        rec = { key: `${volume.node.uuid}|${tool.node.uuid}`, reported: null };
        entry.assoc.set(tool, rec);
      }
      if (rec.reported === spindleOn) continue;
      rec.reported = spindleOn;
      bridge.setMachiningAssociation(rec.key, tool.node, volume.node, spindleOn);
    }
  }

  /** Withdraw every association of an entry (dispose / bridge detach). */
  private dropAssociations(entry: VolumeEntry): void {
    const bridge = this._collision;
    for (const rec of entry.assoc.values()) bridge?.removeMachiningAssociation(rec.key);
    entry.assoc.clear();
  }

  // ── Per-tick driver ──────────────────────────────────────────────────

  /**
   * Advance every registered volume. Returns `true` when at least one chunk
   * mesh changed — the caller must then mark render AND shadow dirty.
   */
  update(dt: number): boolean {
    if (!this.enabled || this._entries.size === 0) return false;

    // plan-409 F5 — BEFORE the provider check on purpose. The suppression
    // describes the authored machining intent, not the state of the worker: a
    // provider that is still booting (or absent in a public build) must not
    // make a legitimately engaged cutter alarm.
    if (this._collision) {
      for (const entry of this._entries.values()) this.syncAssociations(entry);
    }

    const provider = this.provider;
    if (!provider) {
      // No provider (public build / kill-switch / failed off) or no Worker
      // support: the authored workpiece stays visible, warn exactly once (F10).
      if (this._entries.size > 0) {
        machiningRegistry.warnUnavailableOnce(
          isMachiningWorkerSupported() ? 'no machining provider registered' : 'Web Workers unavailable',
        );
      }
      // The provider may have failed off AFTER grids existed — in that case the
      // authored meshes are hidden behind chunk meshes that will never update
      // again. Put the workpiece back; that is what F10 promises.
      //
      // Only volumes that GOT that far are degraded. A volume still in `none` is
      // simply waiting and must stay that way: the kill-switch is re-read every
      // tick and a provider can register late, so failing it here would make an
      // absent provider permanent rather than merely current.
      let restored = false;
      for (const entry of this._entries.values()) {
        if (entry.state === 'none') continue;
        if (this.degradeEntry(entry, 'provider failed off')) restored = true;
      }
      return restored;
    }

    let changed = false;
    for (const entry of this._entries.values()) {
      if (this.updateEntry(entry, provider, dt)) changed = true;
    }
    return changed;
  }

  private updateEntry(entry: VolumeEntry, provider: MachiningProvider, dt: number): boolean {
    const volume = entry.volume;

    // Multiuser follower: the authoritative peer owns the machining state.
    if (volume.isOwner === false) return false;

    if (entry.state === 'none') {
      this.beginGrid(entry, provider);
      return false;
    }
    if (entry.state !== 'ready' || !entry.grid) return false;

    let changed = false;

    // 1 ── Reset barrier on the rising edge only.
    const resetNow = this.readBool(volume.SignalReset, false);
    const resetEdge = resetNow && !entry.lastResetSignal;
    entry.lastResetSignal = resetNow;
    if (resetEdge && !entry.resetting) {
      this.beginReset(entry, provider);
      return true; // chunks were hidden — the frame must be redrawn
    }

    // 2 ── Spindle gate.
    const spindleOn = this.readBool(volume.SignalSpindleOn, true);
    if (!spindleOn) {
      // Tools may keep moving; do NOT sweep over that motion later.
      for (const s of entry.sweep.values()) s.hasLastPose = false;
    } else if (!entry.resetting) {
      this.submitTick(entry, provider);
    }

    // 3 ── Apply chunk batches that arrived since the last tick.
    if (entry.inbox.length > 0) {
      for (const batch of entry.inbox) {
        if (batch.epoch !== entry.epoch) continue; // stale (reset/teardown)
        for (const chunk of batch.chunks) {
          if (volume.applyChunk(chunk)) changed = true;
        }
      }
      entry.inbox.length = 0;
      entry.everRendered = true;
      entry.starvedFor = 0;
    } else if (!entry.everRendered) {
      // The authored mesh is already hidden but nothing has replaced it yet.
      entry.starvedFor += dt;
      if (entry.starvedFor > MACHINING_FIRST_MESH_TIMEOUT_S) {
        return this.degradeEntry(
          entry,
          `no chunk mesh within ${MACHINING_FIRST_MESH_TIMEOUT_S}s — the worker is not producing geometry`,
        );
      }
    }

    // 4 ── Momentary machining state from the LAST ack (never latched).
    const ack = entry.lastAck;
    const pendingJobs = ack ? ack.pendingJobs : 0;
    const pendingChunks = ack ? ack.pendingChunks : 0;
    volume.PendingJobCount = pendingJobs;
    volume.PendingChunkCount = pendingChunks;
    if (volume.SignalMachiningActive && this._signals) {
      this._signals.setByPath(volume.SignalMachiningActive, pendingJobs + pendingChunks > 0);
    }

    // 5 ── Throttled statistics (F8).
    entry.statsTimer += dt;
    const interval = Math.max(0.05, volume.StatisticsInterval || 0.25);
    if (entry.statsTimer >= interval && !entry.statsInFlight) {
      entry.statsTimer = 0;
      this.refreshStatistics(entry, provider);
    }

    return changed;
  }

  // ── Grid lifecycle ───────────────────────────────────────────────────

  private beginGrid(entry: VolumeEntry, provider: MachiningProvider): void {
    entry.state = 'creating';
    const volume = entry.volume;
    const epochAtStart = entry.epoch;

    const run = async (): Promise<void> => {
      if (!this._providerInit) this._providerInit = provider.init();
      await this._providerInit;
      const grid = await provider.createGrid(volume.buildGridDesc());
      // The volume may have been unregistered / reset while we awaited.
      if (!this._entries.has(volume) || entry.epoch !== epochAtStart) {
        await provider.destroyGrid(grid);
        return;
      }
      entry.grid = grid;
      entry.state = 'ready';
      entry.removedAccum = 0;
      volume.attachGrid(grid);
      entry.unsubscribes.push(
        provider.onAck(grid, (ack) => this.onAck(entry, ack)),
        provider.onChunkMeshes(grid, (batch) => { entry.inbox.push(batch); }),
      );
    };

    run().catch((err) => {
      this.degradeEntry(entry, `grid creation failed: ${String(err)}`);
    });
  }

  /**
   * Turn machining OFF for one volume and give the authored workpiece back.
   *
   * The single place that reacts to "machining cannot continue here", whatever the
   * cause (provider failed off, grid creation rejected, reset rejected, no geometry
   * produced). Idempotent — an entry already degraded returns `false` so the caller
   * does not keep marking the frame dirty.
   *
   * Returns `true` when something visible changed (the authored mesh reappeared).
   */
  private degradeEntry(entry: VolumeEntry, reason: string): boolean {
    if (entry.state === 'failed') return false;
    const hadRender = entry.volume.IsInitialized;
    entry.state = 'failed';
    entry.epoch++;
    entry.coalesced.length = 0;
    entry.inbox.length = 0;
    entry.sweep.clear();
    entry.lastAck = null;
    for (const off of entry.unsubscribes) off();
    entry.unsubscribes.length = 0;
    // Restores visibility of the authored meshes and disposes the chunk slots.
    entry.volume.teardownRender();
    const grid = entry.grid;
    entry.grid = null;
    if (grid) {
      void machiningRegistry.rawProvider?.destroyGrid(grid).catch(() => { /* best effort */ });
    }
    // plan-409 F4: the authored mesh is back, so the collision body must stop
    // using the stock box. `teardownRender()` above already answers `null` from
    // `getStockBoundsLocal()`; this rebuilds the body so the restored meshes
    // (and their BVHs) are checked with full triangle precision again.
    this._collision?.invalidate();
    machiningRegistry.warnUnavailableOnce(`"${entry.volume.node.name}": ${reason}`);
    return hadRender;
  }

  private beginReset(entry: VolumeEntry, provider: MachiningProvider): void {
    const grid = entry.grid;
    if (!grid) return;
    entry.resetting = true;
    entry.epoch++;
    entry.coalesced.length = 0;
    entry.inbox.length = 0;
    entry.lastAck = null;
    entry.removedAccum = 0;
    entry.sweep.clear();
    entry.volume.hideAllChunks();
    entry.volume.MaterialRemainingPercent = 100;
    entry.volume.VoxelsModified = 0;

    provider.resetGrid(grid)
      .then(() => { entry.resetting = false; })
      .catch((err) => {
        entry.resetting = false;
        this.degradeEntry(entry, `reset failed: ${String(err)}`);
      });
  }

  private onAck(entry: VolumeEntry, ack: MachiningSubtractAck): void {
    entry.lastAck = ack;
    if (ack.removedVoxels > 0) {
      entry.removedAccum += ack.removedVoxels;
      entry.volume.VoxelsModified = entry.removedAccum;
    }
  }

  private refreshStatistics(entry: VolumeEntry, provider: MachiningProvider): void {
    const grid = entry.grid;
    if (!grid || grid.initialSolidVoxels <= 0) return;
    entry.statsInFlight = true;
    const epochAtStart = entry.epoch;
    provider.countSolid(grid)
      .then((solid) => {
        entry.statsInFlight = false;
        if (entry.epoch !== epochAtStart) return;
        const pct = (100 * solid) / grid.initialSolidVoxels;
        entry.volume.MaterialRemainingPercent = Math.max(0, Math.min(100, pct));
      })
      .catch(() => { entry.statsInFlight = false; });
  }

  // ── Subtraction ──────────────────────────────────────────────────────

  private submitTick(entry: VolumeEntry, provider: MachiningProvider): void {
    const grid = entry.grid;
    if (!grid) return;

    const fresh = this.buildSegments(entry, grid);
    // Coalesced segments from rejected ticks go IN FRONT: chronological order
    // is what keeps the swept volume equivalent to the un-coalesced sequence.
    const segments = entry.coalesced.length > 0
      ? entry.coalesced.concat(fresh)
      : fresh;
    if (segments.length === 0) return;

    const result = provider.submitSubtract(grid, { segments });
    if (result.accepted) {
      entry.coalesced.length = 0;
      return;
    }
    if (result.reason === 'closed') {
      entry.coalesced.length = 0;
      return;
    }
    // backlog → keep everything for the next tick.
    entry.coalesced = segments;
    if (entry.coalesced.length > COALESCE_HARD_CAP) {
      if (!entry.warnedCoalesceCap) {
        entry.warnedCoalesceCap = true;
        console.warn(
          `[machining] "${entry.volume.node.name}": coalescing buffer hit the hard cap `
          + `(${COALESCE_HARD_CAP} segments) — the worker is not draining. Dropping the oldest segments.`,
        );
      }
      entry.coalesced.splice(0, entry.coalesced.length - COALESCE_HARD_CAP);
    }
  }

  /**
   * One swept segment per tool, in the volume's GRID space. Mirrors
   * `MachiningVolume.RunSubtraction()` including the substep heuristic:
   * sample the motion (translation + rotation arc at the bounding radius) at
   * half-voxel density, capped by `MaxSweepSubsteps`.
   */
  private buildSegments(entry: VolumeEntry, grid: MachiningGridHandle): MachiningToolSegment[] {
    const volume = entry.volume;
    const out: MachiningToolSegment[] = [];
    const tools = volume.tools;
    if (tools.length === 0) return out;

    volume.node.updateWorldMatrix(true, false);
    volume.node.getWorldQuaternion(_volQuat);
    _volQuatInv.copy(_volQuat).invert();

    const minVoxel = Math.min(grid.voxelSizeMm.x, grid.voxelSizeMm.y, grid.voxelSizeMm.z);
    const sampleDist = Math.max(0.001, minVoxel * 0.5);
    const maxSubsteps = Math.max(1, Math.floor(volume.MaxSweepSubsteps) || 1);

    for (const tool of tools) {
      const radius = tool.toolRadius;
      if (!(radius > 0)) continue;

      tool.node.updateWorldMatrix(true, false);
      tool.node.getWorldPosition(_worldPos);
      _localPos.copy(_worldPos);
      volume.node.worldToLocal(_localPos);
      // local meters → volume-local mm → grid space mm
      const endX = _localPos.x * MM_TO_METERS - grid.gridOriginMm.x;
      const endY = _localPos.y * MM_TO_METERS - grid.gridOriginMm.y;
      const endZ = _localPos.z * MM_TO_METERS - grid.gridOriginMm.z;

      tool.node.getWorldQuaternion(_worldQuat);
      _toolQuat.copy(_volQuatInv).multiply(_worldQuat);

      let state = entry.sweep.get(tool);
      if (!state) {
        state = { lastPos: new Vector3(), lastRot: new Quaternion(), hasLastPose: false };
        entry.sweep.set(tool, state);
      }

      const doSweep = volume.SweepToolMotion && state.hasLastPose;
      const startX = doSweep ? state.lastPos.x : endX;
      const startY = doSweep ? state.lastPos.y : endY;
      const startZ = doSweep ? state.lastPos.z : endZ;
      const startRot = doSweep
        ? { x: state.lastRot.x, y: state.lastRot.y, z: state.lastRot.z, w: state.lastRot.w }
        : { x: _toolQuat.x, y: _toolQuat.y, z: _toolQuat.z, w: _toolQuat.w };

      const boundingRadius = tool.boundingRadius;
      let substeps = 1;
      if (doSweep) {
        const dot = Math.min(1, Math.abs(
          startRot.x * _toolQuat.x + startRot.y * _toolQuat.y
          + startRot.z * _toolQuat.z + startRot.w * _toolQuat.w,
        ));
        const angleRad = 2 * Math.acos(dot);
        const dx = endX - startX, dy = endY - startY, dz = endZ - startZ;
        const moveDist = Math.sqrt(dx * dx + dy * dy + dz * dz) + angleRad * boundingRadius;
        substeps = Math.min(maxSubsteps, Math.max(1, 1 + Math.ceil(moveDist / sampleDist)));
      }

      // Remember the CURRENT pose even when the tool is outside the grid — the
      // sweep has to follow the real tool path, not just the cutting part.
      state.lastPos.set(endX, endY, endZ);
      state.lastRot.copy(_toolQuat);
      state.hasLastPose = true;

      out.push({
        posStart: { x: startX, y: startY, z: startZ },
        posEnd: { x: endX, y: endY, z: endZ },
        rotStart: startRot,
        rotEnd: { x: _toolQuat.x, y: _toolQuat.y, z: _toolQuat.z, w: _toolQuat.w },
        substeps,
        radius,
        height: tool.ToolLength,
        cornerRadius: tool.CornerRadius,
        coneRadiusTop: tool.coneRadiusTop,
        shape: tool.shapeValue,
        boundingRadius,
      });
    }
    return out;
  }

  // ── Teardown ─────────────────────────────────────────────────────────

  /**
   * Drops every volume BEFORE the model's geometry is destroyed: unsubscribes,
   * destroys the worker-side grid (frees its linear memory) and disposes every
   * chunk geometry exactly once.
   */
  clear(): void {
    const entries = [...this._entries.values()];
    this._entries.clear();
    for (const entry of entries) void this.teardownEntry(entry);
    this._signals = null;
  }

  /** Terminate the worker + WASM. Called from the viewer's `dispose()`. */
  dispose(): void {
    this.clear();
    this._providerInit = null;
    this._collision = null;
    machiningRegistry.rawProvider?.dispose();
  }

  private async teardownEntry(entry: VolumeEntry): Promise<void> {
    entry.epoch++; // invalidate in-flight createGrid / batches
    for (const off of entry.unsubscribes) off();
    entry.unsubscribes.length = 0;
    entry.inbox.length = 0;
    entry.coalesced.length = 0;
    entry.sweep.clear();
    // plan-409: withdraw the suppression BEFORE the geometry teardown — a body
    // pair must never stay muted by an association whose volume is gone.
    this.dropAssociations(entry);
    entry.volume.teardownRender();
    this._collision?.invalidate();

    const grid = entry.grid;
    entry.grid = null;
    entry.state = 'none';
    if (!grid) return;
    try {
      await machiningRegistry.rawProvider?.destroyGrid(grid);
    } catch {
      /* teardown is best-effort — a failed provider is already latched off */
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private readBool(signal: string | null | undefined, fallback: boolean): boolean {
    if (!signal || !this._signals) return fallback;
    return this._signals.getBoolByPath(signal);
  }
}
