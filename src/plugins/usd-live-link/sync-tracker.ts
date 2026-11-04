// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SyncTracker — what changed since the last frame (plan-637 F4/F5).
 *
 * Nodes: every tracked node index (drive nodes and their subtree, as far as
 * they are in the snapshot) is diffed per sample: its LOCAL matrix — read
 * with `readLocalMatrix`, never the possibly stale `node.matrix` — against the
 * last value sent, with an absolute epsilon. Only changed indices go into the
 * frame.
 *
 * MUs: an id diff over the transport manager's live list. A new id is either
 * a pre-placed MU of the snapshot (moved, never spawned — R2 #1) or a spawned
 * one, whose template index comes from the source that spawned it
 * (`getMuSource`, set by `rv-source.ts`). Gone ids become `muDelete`. Poses go
 * in WORLD space (the stage frame of the snapshot) — grip and release
 * re-parent the runtime node but never the USD prim. Instanced MUs are
 * composed from the pool's position / quaternion accessors, never
 * `getMatrixAt()` (stale on the GPU compute path).
 *
 * Order per sample: deletes, spawns, then one frame. `requestFull()` makes the
 * next sample send every node and treat every MU as new (after a mount, a
 * reconnect and a simulation reset).
 *
 * Hot path: no allocation once warm — matrices go into pre-allocated
 * Float32Arrays, the frame into the reused {@link FrameWriter} buffer, MU
 * bookkeeping into a Map whose entries are reused.
 */

import { Matrix4, Vector3, type Object3D, type Quaternion } from 'three';
import {
  FrameWriter,
  MATRIX_FLOATS,
  encodeMuDelete,
  encodeMuSpawn,
} from './livesync-protocol';
import { readLocalMatrix } from './runtime-stage-export';

/** The part of an MU the tracker reads. */
export interface TrackedMu {
  readonly id: number;
  readonly isInstanced: boolean;
  readonly node: Object3D;
  /** Instanced MUs: pool-backed accessors (world space inside the pool mesh). */
  getPosition(): Vector3;
  getQuaternion(): Quaternion;
}

export interface SyncTrackerConfig {
  /** Snapshot node table (index = node index). */
  nodes: readonly Object3D[];
  /** Node indices to diff each sample. */
  trackedIndices: readonly number[];
  /** Live MU list (read every sample). */
  mus(): readonly TrackedMu[];
  /** Template index of a spawned MU, -1 when unknown. */
  templateIndexOf(mu: TrackedMu): number;
  /** Pre-placed MUs of the snapshot: muId → node index. */
  preplaced: ReadonlyMap<number, number>;
  /** Absolute epsilon for matrix elements. Default 1e-6. */
  epsilon?: number;
  /** Send hook (one call per message). */
  send(bytes: Uint8Array): void;
}

interface MuEntry {
  stamp: number;
  last: Float32Array;
  preplaced: boolean;
}

const _m = new Matrix4();
const _one = new Vector3(1, 1, 1);
const _pos = new Vector3();

/** Sample-rate gate: 60 Hz fixed ticks → `rateHz` samples. */
export class RateGate {
  private acc = 0;
  constructor(public rateHz: number) {}

  /** Advance by `dt`; true when a sample is due. */
  advance(dt: number): boolean {
    const period = 1 / Math.max(1, this.rateHz);
    this.acc += dt;
    if (this.acc + 1e-6 < period) return false;
    this.acc -= period;
    if (this.acc > period) this.acc = 0; // never burst after a stall
    return true;
  }

  reset(): void { this.acc = 0; }
}

export class SyncTracker {
  private readonly last: Float32Array;
  private readonly writer: FrameWriter;
  private readonly known = new Map<number, MuEntry>();
  private readonly spare: MuEntry[] = [];
  private readonly scratch = new Float32Array(MATRIX_FLOATS);
  private readonly epsilon: number;
  private full = true;
  private stamp = 0;
  private seq = 0;
  private readonly warnedUnknown = new Set<number>();

  constructor(private readonly cfg: SyncTrackerConfig) {
    this.last = new Float32Array(cfg.nodes.length * MATRIX_FLOATS);
    this.writer = new FrameWriter(Math.max(16, cfg.trackedIndices.length + 16));
    this.epsilon = cfg.epsilon ?? 1e-6;
  }

  /** The frame writer (exposed for the allocation test). */
  get frameWriter(): FrameWriter { return this.writer; }

  /** Next sample sends everything (after mount / reconnect / reset). */
  requestFull(): void { this.full = true; }

  /**
   * Diff and send. Returns the number of messages sent (0 = nothing moved).
   * `session` is stamped into every message.
   */
  sample(session: number): number {
    const full = this.full;
    this.full = false;
    const stamp = ++this.stamp;
    let sent = 0;

    // ── MUs: inventory diff ──
    if (full) {
      for (const e of this.known.values()) this.spare.push(e);
      this.known.clear();
    }
    const mus = this.cfg.mus();
    const writer = this.writer;
    for (let i = 0; i < mus.length; i++) {
      const mu = mus[i];
      const entry = this.known.get(mu.id);
      if (entry) { entry.stamp = stamp; continue; }
      const preplaced = this.cfg.preplaced.has(mu.id);
      if (!preplaced) {
        const t = this.cfg.templateIndexOf(mu);
        if (t < 0) {
          if (!this.warnedUnknown.has(mu.id)) {
            this.warnedUnknown.add(mu.id);
            console.warn(`[usd-live-link] MU ${mu.id} has no known template — not synced`);
          }
          continue;
        }
        this.worldMatrixOf(mu, this.scratch);
        this.cfg.send(encodeMuSpawn(session, mu.id, t, this.scratch));
        sent++;
      }
      const e = this.spare.pop() ?? { stamp: 0, last: new Float32Array(MATRIX_FLOATS), preplaced: false };
      e.stamp = stamp;
      e.preplaced = preplaced;
      // A fresh spawn starts at its spawn pose (already sent); a pre-placed MU
      // gets its pose in this frame.
      if (preplaced) e.last.fill(Number.NaN);
      else e.last.set(this.scratch);
      this.known.set(mu.id, e);
    }
    // Gone MUs. A pre-placed MU only counts as gone when its node left the
    // scene (sink / delete detach it) — an inactive one (before the first
    // start, a passive load) still stands where the snapshot has it.
    for (const [id, e] of this.known) {
      if (e.stamp === stamp) continue;
      this.known.delete(id);
      this.spare.push(e);
      if (e.preplaced && !this.preplacedDetached(id)) continue;
      this.cfg.send(encodeMuDelete(session, id));
      sent++;
    }
    if (full) {
      for (const [muId] of this.cfg.preplaced) {
        if (this.known.has(muId) || !this.preplacedDetached(muId)) continue;
        this.cfg.send(encodeMuDelete(session, muId));
        sent++;
      }
    }

    // ── frame ──
    writer.begin(session, this.seq);
    const nodes = this.cfg.nodes;
    const idx = this.cfg.trackedIndices;
    const last = this.last;
    const eps = this.epsilon;
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      const el = readLocalMatrix(nodes[i], _m).elements;
      const o = i * MATRIX_FLOATS;
      if (!full && !changed(el, last, o, eps)) continue;
      for (let j = 0; j < MATRIX_FLOATS; j++) last[o + j] = el[j];
      writer.writeNode(i, el);
    }
    for (let i = 0; i < mus.length; i++) {
      const mu = mus[i];
      const e = this.known.get(mu.id);
      if (!e) continue;
      this.worldMatrixOf(mu, this.scratch);
      if (!full && !changed(this.scratch, e.last, 0, eps)) continue;
      e.last.set(this.scratch);
      writer.writeMu(mu.id, this.scratch);
    }
    if (writer.nodeCount > 0 || writer.muCount > 0) {
      this.cfg.send(writer.finish());
      this.seq++;
      sent++;
    }
    return sent;
  }

  /** True when the pre-placed MU's node is no longer in the scene graph. */
  private preplacedDetached(muId: number): boolean {
    const idx = this.cfg.preplaced.get(muId);
    if (idx === undefined) return true;
    const node = this.cfg.nodes[idx];
    let o: Object3D | null = node;
    while (o.parent) o = o.parent;
    return o === node || !(o as { isScene?: boolean }).isScene;
  }

  /** World matrix of an MU in the stage frame (= three world space). */
  private worldMatrixOf(mu: TrackedMu, out: Float32Array): void {
    if (mu.isInstanced) {
      _pos.copy(mu.getPosition());
      _m.compose(_pos, mu.getQuaternion(), _one);
      const mesh = mu.node;
      mesh.updateWorldMatrix(true, false);
      _m.premultiply(mesh.matrixWorld);
    } else {
      // R2 residual: refresh the whole parent chain (a gripped MU hangs under
      // a moving gripper whose world matrix is only updated at render time).
      mu.node.updateWorldMatrix(true, false);
      _m.copy(mu.node.matrixWorld);
    }
    const el = _m.elements;
    for (let j = 0; j < MATRIX_FLOATS; j++) out[j] = el[j];
  }
}

function changed(el: ArrayLike<number>, last: Float32Array, o: number, eps: number): boolean {
  for (let j = 0; j < MATRIX_FLOATS; j++) {
    const prev = last[o + j];
    // NaN (never sent) always differs.
    if (!(Math.abs(el[j] - prev) <= eps)) return true;
  }
  return false;
}

/**
 * Node indices to track: every drive node and its subtree that is in the
 * snapshot (index 0 = the root, whose matrix carries its world transform, is
 * never tracked).
 */
export function collectTrackedIndices(driveNodes: readonly Object3D[], indexOf: ReadonlyMap<Object3D, number>): number[] {
  const out = new Set<number>();
  for (const n of driveNodes) {
    n.traverse((c) => {
      const i = indexOf.get(c);
      if (i !== undefined && i !== 0) out.add(i);
    });
  }
  return [...out].sort((a, b) => a - b);
}
