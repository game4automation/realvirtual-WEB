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
 */

import type { Object3D } from 'three';
import type { LoadResult } from '../../core/engine/rv-scene-loader';
import { getMuSource, type RVSource } from '../../core/engine/rv-source';
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
} from './runtime-stage-export';
import { RateGate, SyncTracker, collectTrackedIndices, type TrackedMu } from './sync-tracker';
import { LIVE_LINK_NOT_REACHABLE_RETRYING, LIVE_LINK_TOKEN_MISSING, type LiveLinkStore } from './live-link-store';
import { checkExtension } from './livesync-extension';

/** What the session reads from a loaded model. */
export type LiveLinkModel = Pick<LoadResult, 'root' | 'drives' | 'transportManager'>;

/** Seams for tests. */
export interface UsdLiveLinkSessionOptions {
  exportStage?: (input: RuntimeStageInput) => Promise<RuntimeStageSnapshot>;
  compress?: (bytes: Uint8Array) => Promise<{ bytes: Uint8Array; encoding: 'gzip' | 'identity' }>;
  createClient?: (opts: KitLinkClientOptions) => KitLinkClient;
  /** Clock in ms for the measured rate. */
  now?: () => number;
}

/**
 * Template table of a model: one entry per distinct MU template node, and the
 * index of every source. Keyed by the source OBJECT — two sources with the
 * same node name stay apart.
 */
export function buildTemplateTable(sources: readonly RVSource[]): {
  templates: Object3D[]; bySource: Map<RVSource, number>;
} {
  const templates: Object3D[] = [];
  const byNode = new Map<Object3D, number>();
  const bySource = new Map<RVSource, number>();
  for (const s of sources) {
    const t = s.muTemplate;
    if (!t) continue;
    let i = byNode.get(t);
    if (i === undefined) { i = templates.length; templates.push(t); byNode.set(t, i); }
    bySource.set(s, i);
  }
  return { templates, bySource };
}

/** Template index of a spawned MU (-1: unknown source or template not in the snapshot). */
export function templateIndexOfMu(mu: object, bySource: ReadonlyMap<RVSource, number>, templatePaths: readonly string[]): number {
  const src = getMuSource(mu);
  const i = src ? bySource.get(src) : undefined;
  return i === undefined || !templatePaths[i] ? -1 : i;
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
    if (this.enabled) this.store.set({ status: 'mounting', message: 'Waiting for a model' });
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
        texturesSkipped: undefined, extensionNotice: undefined,
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

  /** Drop the current mount / tracker; a running export becomes stale. */
  private invalidate(): void {
    this.generation++;
    this.tracker = null;
    this.resetPending = false;
  }

  private collectInput(model: LiveLinkModel): {
    input: RuntimeStageInput; templateIndexBySource: Map<RVSource, number>;
  } {
    const tm = model.transportManager;
    const table = buildTemplateTable(tm.sources);
    const exclude = new Set<Object3D>();
    for (const mu of tm.mus) {
      if (mu.isInstanced) continue; // pools are InstancedMesh → never exported
      if ((mu as { preplaced?: boolean }).preplaced) continue;
      exclude.add(mu.node);
    }
    const preplaced = tm.preplacedMUs.map((mu) => ({ muId: mu.id, node: mu.node }));
    return {
      input: { root: model.root, templates: table.templates, exclude, preplaced },
      templateIndexBySource: table.bySource,
    };
  }

  private async mount(): Promise<void> {
    const model = this.model;
    const client = this.client;
    if (!model || !client) return;
    this.invalidate();
    const gen = this.generation;
    this.store.set({ status: 'mounting', session: gen, message: 'Exporting the scene…', texturesSkipped: undefined });
    const current = (): boolean => gen === this.generation && this.enabled && this.model === model && client === this.client;

    let snapshot: RuntimeStageSnapshot;
    let templateIndexBySource: Map<RVSource, number>;
    try {
      const collected = this.collectInput(model);
      templateIndexBySource = collected.templateIndexBySource;
      snapshot = await (this.opts.exportStage ?? exportRuntimeStage)(collected.input);
      if (!current()) return;
      this.store.set({ message: 'Uploading the scene…', texturesSkipped: snapshot.texturesSkipped || undefined });
      const packed = await (this.opts.compress ?? compressForMount)(snapshot.usdz);
      if (!current()) return;
      if (packed.bytes.byteLength > LIVESYNC_LIMITS.maxCompressedBytes || snapshot.usdz.byteLength > LIVESYNC_LIMITS.maxRawBytes) {
        this.invalidate();
        this.store.set({ status: 'error', message: `The scene is too large for the live link (${Math.round(snapshot.usdz.byteLength / 1e6)} MB).` });
        return;
      }
      const chunkCount = Math.max(1, Math.ceil(packed.bytes.byteLength / MOUNT_CHUNK_BYTES));
      const preplacedIds = new Map<number, number>();
      for (const p of snapshot.preplaced) preplacedIds.set(p.muId, p.nodeIndex);
      const driveNodes = model.drives.map((d) => d.node);
      // A pre-placed MU is posed in world space (resetXformStack) — never also
      // as a local node matrix, even when it sits under a drive.
      const preplacedNodes = new Set(snapshot.preplaced.map((p) => p.nodeIndex));
      const tracked = collectTrackedIndices(driveNodes, snapshot.indexOf).filter((i) => !preplacedNodes.has(i));
      // The tracker exists from here on so a `mounted` ack can find it.
      this.tracker = new SyncTracker({
        nodes: snapshot.nodes,
        trackedIndices: tracked,
        mus: () => model.transportManager.mus as unknown as readonly TrackedMu[],
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
      if (current()) this.store.set({ message: 'Waiting for Isaac Sim…' });
    } catch (e) {
      if (!current()) return;
      this.invalidate();
      this.store.set({ status: 'error', message: `Export failed: ${e instanceof Error ? e.message : String(e)}` });
    }
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
