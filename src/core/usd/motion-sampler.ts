// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Shared pose/inventory diff. No protocol, viewer or plugin dependency (plan-2229). */
import { Matrix4, Vector3, type Object3D, type Quaternion } from 'three';
import { readLocalMatrix } from './runtime-stage-export';

const MATRIX_FLOATS = 16;

/** The part of an MU the tracker reads. */
export interface TrackedMu {
  readonly id: number;
  readonly isInstanced: boolean;
  readonly node: Object3D;
  /** Instanced MUs: pool-backed accessors (world space inside the pool mesh). */
  getPosition(): Vector3;
  getQuaternion(): Quaternion;
}

export interface MotionSamplerConfig {
  /** Snapshot node table (index = node index). */
  nodes: readonly Object3D[];
  /** Node indices to diff each sample. */
  trackedIndices: readonly number[];
  /** Live MU list (read every sample). */
  mus(): readonly TrackedMu[];
  /** Template index of a spawned MU, -1 when unknown. */
  templateIndexOf(mu: TrackedMu): number;
  /** Pre-placed MUs of the snapshot: muId → node index. */
  preplaced: ReadonlyMap<number, Object3D>;
  /** Absolute epsilon for matrix elements. Default 1e-6. */
  epsilon?: number;
  /** Timeline uses the snapshot root in world coordinates. Live-Link leaves this off. */
  rootWorld?: boolean;
  /** Timeline includes preplaced MUs as MU spawn records, even without a source. */
  timeline?: boolean;
  sink: MotionSink;
}

/** Callbacks consume borrowed matrices synchronously; never retain the buffers. */
export interface MotionSink {
  onNodes(index: number, matrix: ArrayLike<number>): void;
  onMuSpawn(muId: number, templateIndex: number, matrix: ArrayLike<number>): void;
  onMuDelete(muId: number): void;
  onMuPoses(muId: number, matrix: ArrayLike<number>): void;
}

interface MuEntry {
  stamp: number;
  last: Float32Array | Float64Array;
  preplaced: boolean;
}

const _m = new Matrix4();
const _one = new Vector3(1, 1, 1);
const _pos = new Vector3();

export class MotionSampler {
  private readonly timelineMus: TrackedMu[] = [];
  private readonly liveIds = new Set<number>();
  private readonly passive: TrackedMu[] = [];
  private readonly last: Float32Array | Float64Array;
  private readonly known = new Map<number, MuEntry>();
  private readonly spare: MuEntry[] = [];
  private readonly scratch: Float32Array | Float64Array;
  private readonly epsilon: number;
  private full = true;
  private stamp = 0;
  private readonly warnedUnknown = new Set<number>();

  constructor(private readonly cfg: MotionSamplerConfig) {
    // Timeline retains original world translations; wire protocol stays Float32.
    this.scratch = cfg.timeline ? new Float64Array(MATRIX_FLOATS) : new Float32Array(MATRIX_FLOATS);
    if (cfg.timeline) for (const [id, node] of cfg.preplaced) {
      this.passive.push({ id, node, isInstanced: false, getPosition: () => node.position, getQuaternion: () => node.quaternion });
    }
    this.last = cfg.timeline ? new Float64Array(cfg.nodes.length * MATRIX_FLOATS) : new Float32Array(cfg.nodes.length * MATRIX_FLOATS);
    this.epsilon = cfg.epsilon ?? 1e-6;
  }

  /** Next sample sends everything (after mount / reconnect / reset). */
  requestFull(): void { this.full = true; }

  /** Diff the current tick and synchronously notify the sink. */
  sample(): void {
    const full = this.full;
    this.full = false;
    const stamp = ++this.stamp;

    // ── MUs: inventory diff ──
    if (full) {
      for (const e of this.known.values()) this.spare.push(e);
      this.known.clear();
    }
    let mus = this.cfg.mus();
    if (this.cfg.timeline) {
      this.timelineMus.length = 0;
      this.liveIds.clear();
      for (const mu of mus) { this.timelineMus.push(mu); this.liveIds.add(mu.id); }
      for (const mu of this.passive) {
        if (!this.liveIds.has(mu.id) && !this.preplacedDetached(mu.id)) this.timelineMus.push(mu);
      }
      mus = this.timelineMus;
    }
    for (let i = 0; i < mus.length; i++) {
      const mu = mus[i];
      const entry = this.known.get(mu.id);
      if (entry) { entry.stamp = stamp; continue; }
      const preplaced = this.cfg.preplaced.has(mu.id);
      if (!preplaced || this.cfg.timeline) {
        const t = this.cfg.templateIndexOf(mu);
        if (t < 0 && !preplaced) {
          if (!this.warnedUnknown.has(mu.id)) {
            this.warnedUnknown.add(mu.id);
            console.warn(`[usd-live-link] MU ${mu.id} has no known template — not synced`);
          }
          continue;
        }
        this.worldMatrixOf(mu, this.scratch);
        this.cfg.sink.onMuSpawn(mu.id, t, this.scratch);
      }
      const e = this.spare.pop() ?? { stamp: 0, last: this.cfg.timeline ? new Float64Array(MATRIX_FLOATS) : new Float32Array(MATRIX_FLOATS), preplaced: false };
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
      this.cfg.sink.onMuDelete(id);
    }
    if (full) {
      for (const [muId] of this.cfg.preplaced) {
        if (this.known.has(muId) || !this.preplacedDetached(muId)) continue;
        this.cfg.sink.onMuDelete(muId);
      }
    }

    // ── frame ──
    const nodes = this.cfg.nodes;
    const idx = this.cfg.trackedIndices;
    const last = this.last;
    const eps = this.epsilon;
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      const node = nodes[i];
      if (this.cfg.rootWorld && i === 0) {
        node.updateWorldMatrix(true, false);
        _m.copy(node.matrixWorld);
      } else readLocalMatrix(node, _m);
      const el = _m.elements;
      const o = i * MATRIX_FLOATS;
      if (!full && !changed(el, last, o, eps)) continue;
      for (let j = 0; j < MATRIX_FLOATS; j++) last[o + j] = el[j];
      this.cfg.sink.onNodes(i, el);
    }
    for (let i = 0; i < mus.length; i++) {
      const mu = mus[i];
      const e = this.known.get(mu.id);
      if (!e) continue;
      this.worldMatrixOf(mu, this.scratch);
      if (!full && !changed(this.scratch, e.last, 0, eps)) continue;
      e.last.set(this.scratch);
      this.cfg.sink.onMuPoses(mu.id, this.scratch);
    }

  }

  /** True when the pre-placed MU's node is no longer in the scene graph. */
  private preplacedDetached(muId: number): boolean {
    const node = this.cfg.preplaced.get(muId);
    if (!node) return true;
    let o: Object3D | null = node;
    while (o.parent) o = o.parent;
    return o === node || !(o as { isScene?: boolean }).isScene;
  }

  /** World matrix of an MU in the stage frame (= three world space). */
  private worldMatrixOf(mu: TrackedMu, out: Float32Array | Float64Array): void {
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

function changed(el: ArrayLike<number>, last: Float32Array | Float64Array, o: number, eps: number): boolean {
  for (let j = 0; j < MATRIX_FLOATS; j++) {
    const prev = last[o + j];
    // NaN (never sent) always differs.
    if (!(Math.abs(el[j] - prev) <= eps)) return true;
  }
  return false;
}


/** Every snapshot node, including late starters; MU subtrees use only world tracks. */
export function collectTimelineIndices(nodes: readonly Object3D[], preplaced: ReadonlySet<Object3D>): number[] {
  const indices: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    let node: Object3D | null = nodes[i];
    while (node && !preplaced.has(node)) node = node.parent;
    if (!node) indices.push(i);
  }
  return indices;
}

/** Configure the timeline without inheriting the Live-Link drive-only set. */
export function createTimelineSampler(cfg: Omit<MotionSamplerConfig, 'trackedIndices' | 'rootWorld' | 'timeline'>): MotionSampler {
  return new MotionSampler({
    ...cfg, epsilon: cfg.epsilon ?? 0, timeline: true, rootWorld: true,
    trackedIndices: collectTimelineIndices(cfg.nodes, new Set(cfg.preplaced.values())),
  });
}
