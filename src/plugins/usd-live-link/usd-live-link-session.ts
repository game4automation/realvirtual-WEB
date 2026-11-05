// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * UsdLiveLinkSession — the running USD live link into NVIDIA Isaac Sim / any
 * Kit app (plan-637). Loaded LAZILY by `UsdLiveLinkPlugin` on the first Sync
 * click, so the entry chunk carries only the plugin shell, the store and the
 * button; the Kit client, the wire protocol, the runtime stage export and the
 * tracker live in this module's chunk.
 *
 * Lifecycle of a sync session:
 *
 *   Sync on (click) → KitLinkClient.start → hello → `ready`
 *     → mount: export the runtime snapshot (export tree, never the live scene)
 *       → gzip → mountBegin + chunks → `mounted`
 *     → live: full state, then per sample (default 30 Hz) the changed local
 *       node matrices + MU spawn / delete / world poses.
 *
 * Every mount is a new SESSION (generation). Anything that makes a running
 * export stale — model cleared or switched, sync off, a reconnect, a reset
 * while mounting — bumps the generation, and the export result of an older
 * generation is dropped when it arrives (F10).
 *
 * Simulation reset (R2 #5): the `simulation-reset` event fires BEFORE the
 * drives and MUs are reset, so the event only marks the link invalid; the
 * `reset` message and the full state go out from a microtask, i.e. after
 * `resetSimulation()` returned — also while paused, when no tick follows.
 * While live the snapshot is not re-exported: the stage holds geometry only,
 * every pose comes with the full state.
 *
 * Structure changes (plan-2239 Phase 3): every mount (first or remount) waits
 * for `whenSceneReady()` and re-checks model and generation. The export
 * captures the structure of the exported nodes in its own synchronous pass; a
 * {@link StructureWatch} compares the live scene against it right before
 * `mountBegin`, right before the first full frame after `mounted`, and then on
 * its own 200 ms timer (also while paused) and on `editor-structure-changed`.
 * A re-parent, rename, added or removed exported node FREEZES the link at once
 * (new generation, no tracker: no frame, no MU spawn / delete), status
 * `remounting`; after the debounce (750 ms after the last change, setting) a
 * normal new mount follows — protocol v1 needs nothing else. A remount
 * requested while an earlier mount OF THE SAME LIFECYCLE is still exporting /
 * uploading starts once that one ended, exactly once. A lifecycle ends with
 * every invalidation (model switch / clear, sync off, reconnect, error, a new
 * mount): work it left behind is discarded and never holds a remount back. The new mount's tracker starts with an empty
 * MU inventory and a full state, so every live MU is spawned again after
 * `mounted` (Kit drops spawned MUs with the old wrapper).
 */

import type { LoadResult } from '../../core/engine/rv-scene-loader';
import type { RVSource } from '../../core/engine/rv-source';
import { LiveMuInventory, collectStageInput, templateIndexOfMu, type InventoryHost, type InventoryMu } from '../../core/usd/collect-stage-input';
import { KitLinkClient, type KitLinkClientOptions } from './kit-link-client';
import {
  MOUNT_CHUNK_BYTES,
  LIVESYNC_LIMITS,
  encodeMountBegin,
  encodeMountChunk,
  encodeReset,
  type LiveSyncAck,
} from './livesync-protocol';
import {
  compressForMount,
  exportRuntimeStage,
  type RuntimeStageInput,
  type RuntimeStageSnapshot,
} from '../../core/usd/runtime-stage-export';
import { RateGate, SyncTracker, collectTrackedIndices, type TrackedMu } from './sync-tracker';
import {
  LIVE_LINK_NOT_REACHABLE_RETRYING,
  LIVE_LINK_TOKEN_MISSING,
  type LiveLinkMountTimings,
  type LiveLinkStore,
} from './live-link-store';
import { clampRemountMs } from './remount-debounce';
import { checkExtension } from './livesync-extension';
import { StructureGuard, StructureWatch, formatStructureChange } from './structure-guard';
import type { StructureChange } from '../../core/usd/structure-baseline';

/** What the session reads from a loaded model. */
export type LiveLinkModel = Pick<LoadResult, 'root' | 'drives' | 'transportManager' | 'registry'>;

/** Seams for tests. */
export interface UsdLiveLinkSessionOptions {
  exportStage?: (input: RuntimeStageInput) => Promise<RuntimeStageSnapshot>;
  compress?: (bytes: Uint8Array) => Promise<{ bytes: Uint8Array; encoding: 'gzip' | 'identity' }>;
  createClient?: (opts: KitLinkClientOptions) => KitLinkClient;
  /** Clock in ms for the measured rate and the mount timings. */
  now?: () => number;
  /**
   * Resolves when the scene is complete (late and nested placements included;
   * `viewer.whenSceneReady`). Every mount waits for it (plugins rule 3).
   * Absent: mount at once (tests without a viewer).
   */
  whenSceneReady?: () => Promise<void>;
  /** Structure watch timing override (tests). Default: 200 ms check, debounce from the settings. */
  structureTiming?: { checkMs?: number; debounceMs?: number };
}

/** Interval of the structure watch's own check timer, ms (plan § 2.6). */
export const STRUCTURE_CHECK_MS = 200;

/** Timing marks of the mount in flight (one generation). */
interface MountMarks {
  gen: number;
  cause: LiveLinkMountTimings['cause'];
  start: number;
  sceneReadyMs: number;
  exportMs: number;
  compressMs: number;
  uploadMs: number;
  uploadEnd: number;
  prims: number;
  rawBytes: number;
  compressedBytes: number;
}

/**
 * Status text of a failed mount export. A named size refusal (plan-2246,
 * `usd-geometry-too-large` / `usd-model-layer-too-large` / `usd-package-too-large`, duck-typed so the
 * lazily loaded export code stays lazy) reads as a refusal with its prim path
 * or package bytes, never as V8's string/Blob allocation error.
 */
export function exportFailureText(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (e instanceof Error && (code === 'usd-geometry-too-large' || code === 'usd-model-layer-too-large'
    || code === 'usd-package-too-large')) return e.message;
  return `Export failed: ${e instanceof Error ? e.message : String(e)}`;
}

export class UsdLiveLinkSession {
  private model: LiveLinkModel | null = null;
  private client: KitLinkClient | null = null;
  private enabled = false;
  /** Mount generation; every stale-making event bumps it. */
  private generation = 0;
  private tracker: SyncTracker | null = null;
  private readonly gate: RateGate;
  private resetPending = false;
  private sentFrames = 0;
  private rateWindowStart = 0;
  /** Connection attempt in progress (1 = the first since Sync on or since the last `ready`). */
  private attempt = 0;
  /** Structure watch of the current snapshot (also across the freeze until the remount). */
  private watch: StructureWatch | null = null;
  /**
   * Lifecycle of the mounts: bumped by every {@link invalidate} (a structure
   * freeze keeps it). Only mounts of the current lifecycle gate a remount.
   */
  private lifecycle = 0;
  /** `mount()` calls of the current {@link lifecycle} still exporting / uploading. */
  private mountsInFlight = 0;
  /** A structure remount waits for the mounts in flight to end. */
  private remountQueued = false;
  /** Cause of the next mount (timings). */
  private nextCause: LiveLinkMountTimings['cause'] = 'initial';
  private marks: MountMarks | null = null;

  constructor(private readonly store: LiveLinkStore, private readonly opts: UsdLiveLinkSessionOptions = {}) {
    this.gate = new RateGate(this.store.settings.rateHz);
  }

  /** True while the user has sync switched on. */
  get syncEnabled(): boolean { return this.enabled; }

  /** A model was loaded (also: the model present when the session is created). */
  onModelLoaded(model: LiveLinkModel): void {
    this.model = model;
    if (this.enabled && this.client?.isReady) void this.mount();
  }

  onModelCleared(): void {
    this.model = null;
    this.invalidate();
    this.store.set({ prims: undefined });
    if (this.enabled) this.store.set({ status: 'mounting', message: 'Waiting for a model' });
  }

  /** `editor-structure-changed`: check the structure now instead of at the next timer tick. */
  onStructureHint(): void {
    this.watch?.checkNow();
  }

  onFixedUpdatePost(dt: number): void {
    if (this.resetPending) this.flushReset();
    if (!this.tracker || this.store.state.status !== 'live') return;
    if (!this.gate.advance(dt)) return;
    this.sample();
  }

  /** Switch the live link on or off. ON must come from a user gesture (F7). */
  setSyncEnabled(on: boolean): void {
    if (on === this.enabled) return;
    if (!on) {
      this.enabled = false;
      if (this.client?.isReady && this.store.state.status === 'live') {
        this.client.send(encodeReset(this.store.state.session));
      }
      this.invalidate();
      this.client?.stop();
      this.client = null;
      this.store.set({
        status: 'off', message: undefined, sentHz: 0, appliedHz: undefined, attempt: undefined,
        texturesSkipped: undefined, extensionNotice: undefined, prims: undefined, remounts: undefined,
      });
      return;
    }
    const { token, port, rateHz } = this.store.settings;
    if (!token.trim()) {
      // The plugin shell checks first; this is the session's own guard.
      this.store.set({ status: 'needs-token', message: LIVE_LINK_TOKEN_MISSING, attempt: undefined });
      return;
    }
    this.enabled = true;
    this.gate.rateHz = rateHz;
    this.attempt = 1;
    this.nextCause = 'initial';
    this.store.set({ status: 'connecting', message: `Connecting to ws://127.0.0.1:${port}`, sentHz: 0, attempt: 1 });
    const options: KitLinkClientOptions = {
      url: `ws://127.0.0.1:${port}`,
      token: token.trim(),
      rateHz,
      onReady: (ack) => this.onReady(ack),
      onAck: (ack) => this.onAck(ack),
      onDisconnected: (reason, retrying, code) => this.onDisconnected(reason, retrying, code),
    };
    this.client = this.opts.createClient ? this.opts.createClient(options) : new KitLinkClient(options);
    this.client.start();
  }

  /** Apply the (already stored) sample rate immediately. */
  applyRateHz(hz: number): void {
    this.gate.rateHz = hz;
  }

  // ── Client callbacks ──

  private onReady(ack: LiveSyncAck): void {
    if (!this.enabled) return;
    // Version handshake (Phase 6): another protocol never mounts; an old extension only gets a hint.
    const ext = checkExtension(ack);
    if (ext.kind === 'incompatible') {
      this.invalidate();
      this.enabled = false;
      this.client?.stop();
      this.client = null;
      this.store.set({ status: 'error', message: ext.message, sentHz: 0, extensionNotice: undefined });
      return;
    }
    this.attempt = 0;
    this.store.set({ extensionNotice: ext.kind === 'outdated' ? ext.notice : undefined, attempt: undefined });
    if (!this.model) {
      this.store.set({ status: 'mounting', message: 'Waiting for a model' });
      return;
    }
    void this.mount();
  }

  private onAck(ack: LiveSyncAck): void {
    if (ack.appliedHz !== undefined) this.store.set({ appliedHz: ack.appliedHz });
    if (ack.type === 'mounted') {
      if (ack.session !== this.generation || !this.tracker || this.store.state.status !== 'mounting') return;
      // Check point 2: no frame from a snapshot whose structure is already stale.
      if (this.watch?.checkNow()) return;
      this.publishTimings();
      this.store.set({ status: 'live', message: undefined });
      this.tracker.requestFull();
      this.gate.reset();
      this.sample();
      return;
    }
    if (ack.type === 'error') {
      const message = ack.message ?? 'Isaac Sim reported an error.';
      if (this.store.state.status === 'mounting' && (ack.session === undefined || ack.session === this.generation)) {
        this.invalidate();
        this.store.set({ status: 'error', message });
      } else {
        this.store.set({ message });
      }
    }
  }

  private onDisconnected(reason: string, retrying: boolean, code?: number): void {
    if (!this.enabled) return;
    this.invalidate();
    if (retrying) {
      // The next attempt is already scheduled: from attempt 2 on the status
      // line says WHY the last one failed instead of a bare "Connecting…".
      this.attempt = Math.max(1, this.attempt) + 1;
      const message = code === 1006 ? LIVE_LINK_NOT_REACHABLE_RETRYING : `${reason.replace(/\.$/, '')} — retrying…`;
      this.store.set({ status: 'connecting', message, sentHz: 0, attempt: this.attempt });
    } else {
      this.enabled = false;
      this.client = null;
      this.attempt = 0;
      this.store.set({ status: 'error', message: reason, sentHz: 0, attempt: undefined });
    }
  }

  // ── Mount ──

  /** Drop the current mount / tracker and the structure watch; a running export becomes stale. */
  private invalidate(): void {
    this.stopWatch();
    // Mounts still running belong to the old lifecycle from now on: discarded work.
    this.lifecycle++;
    this.mountsInFlight = 0;
    this.remountQueued = false;
    this.marks = null;
    this.freeze();
  }

  /** New generation without a tracker: nothing of the old one is sent any more. */
  private freeze(): void {
    this.generation++;
    this.tracker = null;
    this.resetPending = false;
  }

  private stopWatch(): void {
    this.watch?.stop();
    this.watch = null;
  }

  private nowMs(): number {
    return (this.opts.now ?? (() => performance.now()))();
  }

  /** First detected structure change of the current snapshot: freeze now, remount after the debounce. */
  private onStructureChanged(change: StructureChange): void {
    if (!this.enabled) return;
    const reason = formatStructureChange(change);
    this.freeze();
    this.marks = null;
    this.store.set({
      status: 'remounting',
      message: `Structure changed (${reason}) — remounting…`,
      remountReason: reason,
      remounts: (this.store.state.remounts ?? 0) + 1,
      sentHz: 0,
    });
  }

  /** The changes settled: one new mount (after any mount still in flight). */
  private remountAfterChange(): void {
    this.watch = null;
    if (!this.enabled || !this.model || !this.client?.isReady) return;
    if (this.mountsInFlight > 0) { this.remountQueued = true; return; }
    this.nextCause = 'structure';
    void this.mount();
  }

  private async mount(): Promise<void> {
    const model = this.model;
    const client = this.client;
    if (!model || !client) return;
    this.invalidate();
    const gen = this.generation;
    const cause = this.nextCause;
    this.nextCause = 'initial';
    const start = this.nowMs();
    this.store.set({ status: 'mounting', session: gen, message: 'Exporting the scene…', texturesSkipped: undefined });
    const current = (): boolean => gen === this.generation && this.enabled && this.model === model && client === this.client;
    const lifecycle = this.lifecycle;
    this.mountsInFlight++;
    try {
      await this.mountGeneration(gen, model, client, current, cause, start);
    } finally {
      // A mount of an ended lifecycle was already written off by invalidate().
      if (lifecycle === this.lifecycle) this.mountsInFlight--;
      // A structure remount that waited for this mount: exactly one new mount.
      if (lifecycle === this.lifecycle && this.mountsInFlight === 0 && this.remountQueued) {
        this.remountQueued = false;
        if (this.enabled && this.model && this.client?.isReady) {
          this.nextCause = 'structure';
          void this.mount();
        }
      }
    }
  }

  private async mountGeneration(
    gen: number,
    model: LiveLinkModel,
    client: KitLinkClient,
    current: () => boolean,
    cause: LiveLinkMountTimings['cause'],
    start: number,
  ): Promise<void> {
    let snapshot: RuntimeStageSnapshot;
    let templateIndexBySource: Map<RVSource, number>;
    try {
      // Plugins rule 3: never snapshot before the scene is complete (late and
      // nested placements and their registry entries are there afterwards).
      if (this.opts.whenSceneReady) {
        this.store.set({ message: 'Waiting for the scene to finish loading…' });
        await this.opts.whenSceneReady();
        if (!current()) return;
        this.store.set({ message: 'Exporting the scene…' });
      }
      const tReady = this.nowMs();
      const collected = collectStageInput(model);
      templateIndexBySource = collected.templateIndexBySource;
      snapshot = await (this.opts.exportStage ?? exportRuntimeStage)(collected.input);
      if (!current()) return;
      const tExport = this.nowMs();
      // The watch runs from the snapshot on: a change during the upload freezes at once.
      if (snapshot.structure) {
        const watch = new StructureWatch(new StructureGuard({
          baseline: snapshot.structure,
          exclude: collected.input.exclude,
          templates: new Set(collected.input.templates),
          preplacedNodes: new Set(collected.input.preplaced.map((p) => p.node)),
          muHost: () => model.transportManager,
        }), {
          checkMs: this.opts.structureTiming?.checkMs ?? STRUCTURE_CHECK_MS,
          debounceMs: this.opts.structureTiming?.debounceMs ?? clampRemountMs(this.store.settings.remountDebounceMs),
          onChange: (change) => this.onStructureChanged(change),
          onSettled: () => this.remountAfterChange(),
        });
        this.watch = watch;
        watch.start();
      }
      let withAddress = 0;
      for (const a of snapshot.addresses) if (a !== null) withAddress++;
      this.store.set({
        message: 'Uploading the scene…',
        texturesSkipped: snapshot.texturesSkipped || undefined,
        prims: { total: snapshot.nodes.length, withAddress },
      });
      const packed = await (this.opts.compress ?? compressForMount)(snapshot.usdz);
      if (!current()) return;
      const tCompress = this.nowMs();
      if (packed.bytes.byteLength > LIVESYNC_LIMITS.maxCompressedBytes || snapshot.usdz.byteLength > LIVESYNC_LIMITS.maxRawBytes) {
        this.invalidate();
        this.store.set({ status: 'error', message: `The scene is too large for the live link (${Math.round(snapshot.usdz.byteLength / 1e6)} MB).` });
        return;
      }
      // Check point 1: a snapshot whose structure is already stale is never mounted.
      if (this.watch?.checkNow()) return;
      const chunkCount = Math.max(1, Math.ceil(packed.bytes.byteLength / MOUNT_CHUNK_BYTES));
      const preplacedIds = new Map<number, number>();
      for (const p of snapshot.preplaced) preplacedIds.set(p.muId, p.nodeIndex);
      const driveNodes = model.drives.map((d) => d.node);
      // A pre-placed MU is posed in world space (resetXformStack) — never also
      // as a local node matrix, even when it sits under a drive.
      const preplacedNodes = new Set(snapshot.preplaced.map((p) => p.nodeIndex));
      const tracked = collectTrackedIndices(driveNodes, snapshot.indexOf).filter((i) => !preplacedNodes.has(i));
      // Active MUs plus spawned passive loads (in neither the snapshot nor the
      // active list) — the classification the collector excluded them by.
      type LiveMu = InventoryMu & TrackedMu;
      const inventory = new LiveMuInventory<LiveMu>(() => model.transportManager as unknown as InventoryHost<LiveMu>);
      // The tracker exists from here on so a `mounted` ack can find it.
      this.tracker = new SyncTracker({
        nodes: snapshot.nodes,
        trackedIndices: tracked,
        mus: () => inventory.list(),
        templateIndexOf: (mu) => templateIndexOfMu(mu, templateIndexBySource, snapshot.templates),
        preplaced: preplacedIds,
        send: (bytes) => { if (this.client === client) client.send(bytes); },
      });
      client.send(encodeMountBegin(gen, packed.bytes.byteLength, snapshot.usdz.byteLength, chunkCount, {
        encoding: packed.encoding,
        nodes: snapshot.primPaths,
        templates: snapshot.templates,
        preplaced: snapshot.preplaced,
      }));
      for (let i = 0; i < chunkCount; i++) {
        const part = packed.bytes.subarray(i * MOUNT_CHUNK_BYTES, Math.min(packed.bytes.byteLength, (i + 1) * MOUNT_CHUNK_BYTES));
        const ok = await client.sendWhenDrained(encodeMountChunk(gen, i, part), current);
        if (!ok) return;
      }
      if (current()) {
        const tUpload = this.nowMs();
        this.marks = {
          gen, cause, start,
          sceneReadyMs: tReady - start,
          exportMs: tExport - tReady,
          compressMs: tCompress - tExport,
          uploadMs: tUpload - tCompress,
          uploadEnd: tUpload,
          prims: snapshot.nodes.length,
          rawBytes: snapshot.usdz.byteLength,
          compressedBytes: packed.bytes.byteLength,
        };
        this.store.set({ message: 'Waiting for Isaac Sim…' });
      }
    } catch (e) {
      if (!current()) return;
      this.invalidate();
      this.store.set({ status: 'error', message: exportFailureText(e) });
    }
  }

  /** `mounted` of the current generation: publish the durations of this mount. */
  private publishTimings(): void {
    const m = this.marks;
    this.marks = null;
    if (!m || m.gen !== this.generation) return;
    const now = this.nowMs();
    const round = (v: number) => Math.round(v * 10) / 10;
    this.store.set({
      lastMountTimings: {
        cause: m.cause,
        sceneReadyMs: round(m.sceneReadyMs),
        exportMs: round(m.exportMs),
        compressMs: round(m.compressMs),
        uploadMs: round(m.uploadMs),
        ackMs: round(now - m.uploadEnd),
        totalMs: round(now - m.start),
        prims: m.prims,
        rawBytes: m.rawBytes,
        compressedBytes: m.compressedBytes,
      },
    });
  }

  // ── Reset ──

  onSimulationReset(): void {
    if (!this.enabled) return;
    const status = this.store.state.status;
    if (status === 'mounting' && this.client?.isReady && this.model) {
      // The running export may hold pre-reset state: drop it, re-mount once
      // the reset has finished.
      this.invalidate();
      queueMicrotask(() => { if (this.enabled && this.client?.isReady) void this.mount(); });
      return;
    }
    if (status !== 'live') return;
    this.resetPending = true;
    queueMicrotask(() => this.flushReset());
  }

  /** Send `reset` + the full state of the (finished) reset. */
  private flushReset(): void {
    if (!this.resetPending) return;
    this.resetPending = false;
    if (!this.tracker || !this.client?.isReady || this.store.state.status !== 'live') return;
    this.client.send(encodeReset(this.generation));
    this.tracker.requestFull();
    this.gate.reset();
    this.sample();
  }

  // ── Sampling ──

  private sample(): void {
    const tracker = this.tracker;
    const client = this.client;
    if (!tracker || !client) return;
    // Backpressure: keep the deltas for the next sample.
    if (!client.canSendFrame()) return;
    // Structure first (≤ 0.2 ms on an 18k-node model, no allocation): a node re-parented in
    // this very tick must not get its new local matrix under the old USD parent.
    if (this.watch?.checkNow()) return;
    if (tracker.sample(this.generation) > 0) this.sentFrames++;
    const now = (this.opts.now ?? (() => performance.now()))();
    if (this.rateWindowStart === 0) this.rateWindowStart = now;
    const elapsed = now - this.rateWindowStart;
    if (elapsed >= 1000) {
      this.store.set({ sentHz: Math.round((this.sentFrames * 1000) / elapsed) });
      this.sentFrames = 0;
      this.rateWindowStart = now;
    }
  }
}
