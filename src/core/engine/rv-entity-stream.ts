// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { Quaternion, Vector3 } from 'three';

/** A path used by {@link EntityStream}. */
export interface EntityStreamPath {
  readonly length: number;
  getAbsPose(meters: number, outPos: Vector3, outDir: Vector3): void;
}

/** Resolves paths by their external identifier. */
export interface EntityStreamPaths {
  get(id: string): EntityStreamPath | null;
}

/** Live tuning values read by the stream without retaining stale configuration. */
export interface EntityStreamConfig {
  maxExtrapolationMs: number;
  correctionBlendMs: number;
  headingBlendMs: number;
  entityTimeoutMs: number;
  snapDistanceM: number;
}

/** One entity update in the current batch. */
export interface EntityStreamUpdate<K = unknown> {
  id: string;
  pathId: string;
  s: number;
  v: number;
  a: number;
  kind?: K;
}

/** One externally simulated entity retained by the stream. */
export interface EntityStreamRecord<K = unknown> {
  readonly id: string;
  kind?: K;
  pathId: string;
  path: EntityStreamPath | null;
  s0: number;
  v0: number;
  a: number;
  anchorMs: number;
  lastSeenMs: number;
  off1D: number;
  offX: number;
  offY: number;
  offZ: number;
  offYaw: number;
  correctionMs: number;
  holdAtMs: number;
}

/** Reusable output for {@link EntityStream.poseOf}. */
export interface EntityStreamPose {
  position: Vector3;
  quaternion?: Quaternion;
  yaw?: number;
}

/** Fixed-size correction metric ring. */
export class EntityStreamRing {
  readonly data: Float64Array;
  count = 0;
  private index = 0;

  constructor(readonly capacity = 600) {
    this.data = new Float64Array(capacity);
  }

  push(value: number): void {
    if (!Number.isFinite(value)) return;
    this.data[this.index] = value;
    this.index = (this.index + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  clear(): void { this.count = 0; this.index = 0; }

  values(): number[] {
    const result: number[] = [];
    const start = this.count < this.capacity ? 0 : this.index;
    for (let i = 0; i < this.count; i++) result.push(this.data[(start + i) % this.capacity]);
    return result;
  }

  /** Returns percentile statistics for the retained samples. */
  stats(): { n: number; p50: number; p95: number; max: number } {
    const values = this.values().sort((a, b) => a - b);
    if (values.length === 0) return { n: 0, p50: NaN, p95: NaN, max: NaN };
    const at = (percentile: number) => values[Math.min(values.length - 1, Math.ceil(percentile * values.length / 100) - 1)];
    return { n: values.length, p50: at(50), p95: at(95), max: values[values.length - 1] };
  }
}

const RATE_RING = 64;
export const SIM_RATE_MAX = 20;
export const SIM_RATE_ALPHA = 0.3;
export const SIM_RATE_MIN_WALL_MS = 5;
export const SIM_RATE_WINDOW_MS = 250;
export const SIM_RATE_RESUME_WINDOW_MS = 100;
export const SIM_RATE_PAUSE_FRAMES = 2;
const RATE_MAX = SIM_RATE_MAX;

/** Kinematic input accepted by the pure extrapolation helper. */
export interface Kin {
  pathId: string;
  s0: number;
  v0: number;
  a: number;
  tRecvMs: number;
  length: number;
}

/** Extrapolates a one-dimensional path position with braking and path clamps. */
export function extrapolate(kin: Kin, nowMs: number, maxMs: number, simRate = 1): number {
  const wall = clamp(nowMs - kin.tRecvMs, 0, Math.max(0, maxMs));
  const dt = Math.max(0, simRate) * wall / 1000;
  const velocity = Math.max(0, kin.v0);
  let position: number;
  if (kin.a < 0 && velocity === 0) {
    position = kin.s0;
  } else if (kin.a < 0 && dt >= velocity / -kin.a) {
    position = kin.s0 + velocity * velocity / (-2 * kin.a);
  } else {
    position = kin.s0 + velocity * dt + 0.5 * kin.a * dt * dt;
  }
  return clamp(position, 0, kin.length);
}

/** Estimates simulation rate from two samples using an exponential moving average. */
export function estimateSimRate(
  previous: { simTime: number; tRecvMs: number },
  current: { simTime: number; tRecvMs: number },
  last: number,
): number {
  const wall = current.tRecvMs - previous.tRecvMs;
  const simulation = current.simTime - previous.simTime;
  if (!Number.isFinite(wall) || !Number.isFinite(simulation)) return Number.isFinite(last) ? last : 1;
  if (simulation === 0) return 0;
  if (wall < SIM_RATE_MIN_WALL_MS) return Number.isFinite(last) ? last : 1;
  const raw = clamp(simulation / (wall / 1000), 0, SIM_RATE_MAX);
  return !Number.isFinite(last) || last <= 0 ? raw : clamp(last + SIM_RATE_ALPHA * (raw - last), 0, SIM_RATE_MAX);
}

/** Returns the remaining correction fraction after an elapsed duration. */
export function blendFactor(elapsedMs: number, blendMs: number): number {
  if (!(blendMs > 0)) return 0;
  if (!(elapsedMs > 0)) return 1;
  const value = Math.exp(-3 * elapsedMs / blendMs);
  return value < 1e-4 ? 0 : value;
}

/** Applies the correction blend to a scalar offset. */
export function blendOffset(offset: number, elapsedMs: number, blendMs: number): number {
  return offset * blendFactor(elapsedMs, blendMs);
}

/** Wraps an angle to the range (-pi, pi]. */
export function wrapAngle(value: number): number {
  let angle = value % (Math.PI * 2);
  if (angle <= -Math.PI) angle += Math.PI * 2;
  else if (angle > Math.PI) angle -= Math.PI * 2;
  return angle;
}

/** Computes an extrapolation cap from periods and expected update rate. */
export function extrapolationCapMs(maxPeriods: number, expectedRateHz: number): number {
  return maxPeriods > 0 && expectedRateHz > 0 ? maxPeriods * 1000 / expectedRateHz : 0;
}

/** Estimates simulation-time rate over a reception-time window. */
export class SimRateEstimator {
  rate = 1;
  private readonly sim = new Float64Array(RATE_RING);
  private readonly recv = new Float64Array(RATE_RING);
  private head = 0;
  private count = 0;
  private standing = 0;
  private shortWindow = false;

  reset(): void {
    this.rate = 1; this.head = 0; this.count = 0; this.standing = 0; this.shortWindow = false;
  }

  push(simTimeS: number, recvMs: number): number {
    if (!Number.isFinite(simTimeS) || !Number.isFinite(recvMs)) return this.rate;
    if (this.count > 0) {
      const last = (this.head - 1 + RATE_RING) % RATE_RING;
      if (simTimeS === this.sim[last]) {
        if (++this.standing >= 2) {
          this.rate = 0;
          this.sim[0] = simTimeS; this.recv[0] = recvMs;
          this.head = 1; this.count = 1; this.shortWindow = true;
        }
        return this.rate;
      }
      if (simTimeS < this.sim[last] || recvMs <= this.recv[last]) {
        this.head = 0; this.count = 0; this.shortWindow = true;
      }
    }
    this.standing = 0;
    this.sim[this.head] = simTimeS; this.recv[this.head] = recvMs;
    this.head = (this.head + 1) % RATE_RING;
    if (this.count < RATE_RING) this.count++;
    const windowMs = this.shortWindow ? 100 : 250;
    for (let k = 2; k <= this.count; k++) {
      const i = (this.head - k + RATE_RING) % RATE_RING;
      const wall = recvMs - this.recv[i];
      if (wall < windowMs) continue;
      this.rate = Math.min(RATE_MAX, Math.max(0, (simTimeS - this.sim[i]) / (wall / 1000)));
      this.shortWindow = false;
      break;
    }
    return this.rate;
  }
}

export interface EntityStreamOptions<K = unknown> {
  paths: EntityStreamPaths;
  config: () => EntityStreamConfig;
  onAdded?: (record: EntityStreamRecord<K>) => void;
  onRemoved?: (record: EntityStreamRecord<K>) => void;
}

/** Stores, smooths and evaluates externally simulated path-bound entities. */
export class EntityStream<K = unknown> {
  readonly entities = new Map<string, EntityStreamRecord<K>>();
  readonly correction = new EntityStreamRing();
  readonly rateEstimator = new SimRateEstimator();
  simRate = 1;
  onAdded: ((record: EntityStreamRecord<K>) => void) | null;
  onRemoved: ((record: EntityStreamRecord<K>) => void) | null;

  private clockOffsetMs = NaN;
  private clockRate = NaN;
  private batchAnchorMs = 0;
  private batchRecvMs = 0;
  private paused = false;
  private heldBatch: { simTimeS: number; recvMs: number; updates: EntityStreamUpdate<K>[]; removals: string[] } | null = null;
  private currentUpdates: EntityStreamUpdate<K>[] | null = null;
  private poseSamples = 0;
  private extrapolatedSamples = 0;
  private readonly oldPos = new Vector3();
  private readonly newPos = new Vector3();
  private readonly dir = new Vector3();

  constructor(private readonly options: EntityStreamOptions<K>) {
    this.onAdded = options.onAdded ?? null;
    this.onRemoved = options.onRemoved ?? null;
  }

  /** Starts an atomic update batch at a host simulation timestamp. */
  beginBatch(hostSimTimeS: number, recvMs: number): void {
    this.batchRecvMs = recvMs;
    if (this.paused) {
      this.currentUpdates = [];
      this.batchAnchorMs = recvMs;
      this.heldBatch = { simTimeS: hostSimTimeS, recvMs, updates: this.currentUpdates, removals: [] };
      return;
    }
    this.simRate = this.rateEstimator.push(hostSimTimeS, recvMs);
    this.batchAnchorMs = this.anchor(hostSimTimeS, recvMs);
    this.currentUpdates = null;
  }

  /** Adds or updates an entity in the current batch. */
  upsert(update: EntityStreamUpdate<K>): EntityStreamRecord<K> | null {
    if (this.paused) {
      this.currentUpdates?.push({ ...update });
      return this.entities.get(update.id) ?? null;
    }
    return this.apply(update, this.batchAnchorMs, this.batchRecvMs);
  }

  /** Completes the current batch. */
  endBatch(): void { this.currentUpdates = null; }

  /** Removes an entity by id. */
  remove(id: string): boolean {
    if (this.paused && this.heldBatch) {
      this.heldBatch.removals.push(id);
      return this.entities.has(id);
    }
    const record = this.entities.get(id);
    if (!record) return false;
    this.entities.delete(id);
    this.onRemoved?.(record);
    return true;
  }

  /** Removes every entity and emits removal callbacks. */
  clear(): void {
    for (const record of [...this.entities.values()]) this.remove(record.id);
  }

  /** Freezes or resumes the stream for viewer pause. */
  setPaused(paused: boolean, nowMs: number): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) { this.freeze(nowMs); return; }
    this.clockOffsetMs = NaN;
    this.rateEstimator.reset();
    const held = this.heldBatch;
    this.heldBatch = null;
    if (!held) return;
    this.beginBatch(held.simTimeS, nowMs);
    for (const id of held.removals) this.remove(id);
    for (const update of held.updates) this.upsert(update);
    this.endBatch();
  }

  /** Whether viewer pause currently holds incoming updates. */
  get isPaused(): boolean { return this.paused; }

  /** Freezes every entity at its currently displayed pose. */
  freeze(nowMs: number): void {
    for (const record of this.entities.values()) {
      const yaw = this.evalPose(record, nowMs, this.oldPos);
      if (!Number.isFinite(yaw) || !record.path) continue;
      record.s0 = this.projectDisplayed(record, nowMs);
      record.path.getAbsPose(record.s0, this.newPos, this.dir);
      record.v0 = 0; record.a = 0; record.anchorMs = nowMs;
      record.off1D = 0;
      record.offX = this.oldPos.x - this.newPos.x;
      record.offY = this.oldPos.y - this.newPos.y;
      record.offZ = this.oldPos.z - this.newPos.z;
      record.offYaw = wrapAngle(yaw - Math.atan2(this.dir.x, this.dir.z));
      record.correctionMs = nowMs;
      record.holdAtMs = nowMs;
    }
  }

  /** Removes timed-out entities unless the viewer is paused. */
  housekeeping(nowMs: number): void {
    if (this.paused) return;
    const timeout = this.options.config().entityTimeoutMs;
    for (const record of this.entities.values()) if (nowMs - record.lastSeenMs > timeout) this.remove(record.id);
  }

  /** Visits every retained entity without allocating an array. */
  forEach(callback: (record: EntityStreamRecord<K>) => void): void { this.entities.forEach(callback); }

  /** Writes a world pose and returns false when no path is available. */
  poseOf(idOrRecord: string | EntityStreamRecord<K>, nowMs: number, out: EntityStreamPose): boolean {
    const record = typeof idOrRecord === 'string' ? this.entities.get(idOrRecord) : idOrRecord;
    if (!record?.path) return false;
    const yaw = this.evalPose(record, record.holdAtMs === record.holdAtMs ? record.holdAtMs : nowMs, out.position);
    if (out.quaternion) out.quaternion.setFromAxisAngle(UP, yaw);
    out.yaw = yaw;
    this.poseSamples++;
    if (nowMs > record.anchorMs) this.extrapolatedSamples++;
    return true;
  }

  /** Writes position and either quaternion or yaw for one record. */
  evalPose(record: EntityStreamRecord<K>, nowMs: number, outPos: Vector3, outRotation?: Quaternion | { yaw: number }): number {
    if (!record.path) return NaN;
    const config = this.options.config();
    const elapsed = nowMs - record.correctionMs;
    const factor = blendFactor(elapsed, config.correctionBlendMs);
    let s = extrapolateRecord(record, nowMs, config.maxExtrapolationMs, this.simRate);
    if (factor > 0) s = clamp(s + record.off1D * factor, 0, record.path.length);
    record.path.getAbsPose(s, outPos, this.dir);
    outPos.x += record.offX * factor; outPos.y += record.offY * factor; outPos.z += record.offZ * factor;
    let yaw = Math.atan2(this.dir.x, this.dir.z);
    yaw += record.offYaw * blendFactor(elapsed, config.headingBlendMs);
    if (outRotation instanceof Quaternion) outRotation.setFromAxisAngle(UP, yaw);
    else if (outRotation) outRotation.yaw = yaw;
    return yaw;
  }

  /** Share of evaluated poses that advance beyond their latest anchor. */
  get extrapolatedShare(): number { return this.poseSamples ? this.extrapolatedSamples / this.poseSamples : NaN; }

  /** Resets quality counters while retaining entities. */
  resetQuality(): void { this.correction.clear(); this.poseSamples = 0; this.extrapolatedSamples = 0; }

  private anchor(simTimeS: number, recvMs: number): number {
    const rate = this.simRate;
    if (!(rate > 0) || !Number.isFinite(simTimeS)) { this.clockOffsetMs = NaN; return recvMs; }
    if (this.clockRate !== rate) {
      if (Math.abs(this.clockRate - rate) > 1e-3 * rate) this.clockOffsetMs = NaN;
      this.clockRate = rate;
    }
    const hostMs = simTimeS * 1000 / rate;
    const raw = recvMs - hostMs;
    const old = this.clockOffsetMs;
    this.clockOffsetMs = old !== old || raw < old ? raw : old + 0.02 * (raw - old);
    return hostMs + this.clockOffsetMs;
  }

  private apply(update: EntityStreamUpdate<K>, anchorMs: number, recvMs: number): EntityStreamRecord<K> | null {
    const path = this.options.paths.get(update.pathId);
    let record = this.entities.get(update.id);
    if (!record) {
      record = {
        id: update.id, kind: update.kind, pathId: update.pathId, path,
        s0: clamp(update.s, 0, path?.length ?? Math.max(0, update.s)), v0: update.v, a: update.a,
        anchorMs, lastSeenMs: recvMs, off1D: 0, offX: 0, offY: 0, offZ: 0,
        offYaw: 0, correctionMs: anchorMs, holdAtMs: NaN,
      };
      this.entities.set(update.id, record);
      this.onAdded?.(record);
      return record;
    }
    if (!path) {
      record.kind = update.kind; record.pathId = update.pathId; record.path = null;
      record.s0 = Math.max(0, update.s); record.v0 = update.v; record.a = update.a;
      record.anchorMs = anchorMs; record.lastSeenMs = recvMs; record.holdAtMs = NaN;
      record.off1D = 0; record.offX = 0; record.offY = 0; record.offZ = 0; record.offYaw = 0;
      record.correctionMs = anchorMs;
      return record;
    }
    const oldPath = record.path;
    const oldYaw = oldPath ? this.evalPose(record, anchorMs, this.oldPos) : NaN;
    const oldS = oldPath ? this.projectDisplayed(record, anchorMs) : record.s0;
    record.kind = update.kind; record.pathId = update.pathId; record.path = path;
    record.s0 = clamp(update.s, 0, path.length); record.v0 = update.v; record.a = update.a;
    record.anchorMs = anchorMs; record.lastSeenMs = recvMs; record.holdAtMs = NaN;
    if (oldPath === path) {
      record.off1D = oldS - record.s0;
      const f = blendFactor(anchorMs - record.correctionMs, this.options.config().correctionBlendMs);
      record.offX *= f; record.offY *= f; record.offZ *= f;
    } else if (oldPath) {
      path.getAbsPose(record.s0, this.newPos, this.dir);
      record.off1D = 0;
      record.offX = this.oldPos.x - this.newPos.x;
      record.offY = this.oldPos.y - this.newPos.y;
      record.offZ = this.oldPos.z - this.newPos.z;
    }
    path.getAbsPose(record.s0, this.newPos, this.dir);
    record.offYaw = Number.isFinite(oldYaw) ? wrapAngle(oldYaw - Math.atan2(this.dir.x, this.dir.z)) : 0;
    const jump = oldPath === path ? Math.abs(record.off1D) : Math.hypot(record.offX, record.offY, record.offZ);
    this.correction.push(jump);
    if (jump > this.options.config().snapDistanceM) {
      record.off1D = 0; record.offX = 0; record.offY = 0; record.offZ = 0; record.offYaw = 0;
    }
    record.correctionMs = anchorMs;
    return record;
  }

  private projectDisplayed(record: EntityStreamRecord<K>, nowMs: number): number {
    const config = this.options.config();
    return clamp(extrapolateRecord(record, nowMs, config.maxExtrapolationMs, this.simRate)
      + record.off1D * blendFactor(nowMs - record.correctionMs, config.correctionBlendMs), 0, record.path?.length ?? 0);
  }
}

function extrapolateRecord(record: EntityStreamRecord, nowMs: number, maxMs: number, rate: number): number {
  const wall = clamp(nowMs - record.anchorMs, 0, Math.max(0, maxMs));
  const dt = Math.max(0, rate) * wall / 1000;
  const v = Math.max(0, record.v0);
  let s: number;
  if (record.a < 0 && v === 0) s = record.s0;
  else if (record.a < 0 && dt >= v / -record.a) s = record.s0 + v * v / (-2 * record.a);
  else s = record.s0 + v * dt + 0.5 * record.a * dt * dt;
  return clamp(s, 0, record.path?.length ?? 0);
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

const UP = new Vector3(0, 1, 0);
