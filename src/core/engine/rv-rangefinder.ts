// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Rangefinder — a single-ray distance sensor, and the shared machinery of every
 * ray sensor (plan-664 Phase 2).
 *
 * ## One computation, two components
 *
 * A rangefinder is a fan of one. `RayScanSensor` below therefore holds
 * everything both components do — mounting, candidate collection, the cast, the
 * error model, the rate accumulator, the latency ring, the data channel and the
 * signal writer — and the two concrete classes only decide their fan and their
 * signals. `rv-laser-scanner.ts` imports the base from here rather than the
 * other way round, because the degenerate case is the simpler one to read
 * first.
 *
 * ## Where a measurement happens
 *
 * In the transport manager's sensor stage: AFTER this tick's MU movement and
 * BEFORE `behaviors.tick` (runner order drives → transport → behaviors). That
 * placement is deliberate and has one consequence worth knowing: the AGV poses a
 * scan sees are the ones the behaviours wrote in the PREVIOUS tick, so a
 * vehicle hull is one fixed tick old. Fixed, deterministic, and documented —
 * which is what a replay needs. Everything else in the path (rate, latency,
 * noise) is in SIM time, never the wall clock.
 *
 * ## Units
 *
 * The schema speaks mm and degrees, in parity with `RVSensor.RayCastLength`.
 * Everything inside this file and below it is metres and radians, converted once
 * in `init()`. The derived signals speak mm again.
 *
 * WEB-only components: no Unity counterpart, therefore no rv-ODT `$def`; the
 * schemas live inline, like `WebLabel` and `NodeKnowledge`.
 */

import type { Object3D } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import { registerComponent } from './rv-component-registry';
import { createSignalWriter } from './rv-signal-store';
import type { SignalWriter } from './rv-signal-store';
import { NodeRegistry } from './rv-node-registry';
import { slotDeclare, slotUndeclare, slotWrite } from './rv-slot-io';
import type { RVTransportManager } from './rv-transport-manager';
import type { RVMovingUnit, InstancedMovingUnit } from './rv-mu';
import { getDefaultAgvFleet, type AgvHandle } from './rv-agv-fleet';
import { makeStream, type RandomStream } from './rv-prng';
import {
  HIT_NONE, NO_HIT, applyNoise, buildFan, castFan, minRange, type BoxBuffer, type NoiseParams,
} from './rv-ray-scan';
import {
  collectCandidates, fanBounds, isInSubtree, makeBoxBuffer,
  type MuLike, type RaySceneSources,
} from './rv-ray-scene-query';
import { rayTargetBoxes } from './rv-ray-target';
import { findDesManager } from '../material-flow/des-manager-settings';
import {
  getSensorDataStore, type RayScanSensorLike, type ScanFrame, type SensorInfo,
} from './rv-sensor-data-store';

/** The sentence F12 asks for — a read-only row in the inspector of every ray sensor. */
export const SENSOR_SAFETY_NOTE = 'Simulation — not a safety function.';

/**
 * Fields every ray sensor has. `LaserScanner` extends this set with its fan and
 * its own signals; the mm / deg units are the authoring contract, the conversion
 * to m / rad happens in `init()`.
 */
export const RAY_SENSOR_SCHEMA_BASE: ComponentSchema = {
  RangeMin: { type: 'number', default: 20, unit: 'mm' },
  RangeMax: { type: 'number', default: 5000, unit: 'mm' },
  NoiseSigma: { type: 'number', default: 0, unit: 'mm' },
  NoiseSigmaPerM: { type: 'number', default: 0, unit: 'mm' },
  DropoutProb: { type: 'number', default: 0 },
  DropoutProbPerM: { type: 'number', default: 0 },
  Resolution: { type: 'number', default: 0, unit: 'mm' },
  RateHz: { type: 'number', default: 0, unit: 'Hz' },
  LatencyMs: { type: 'number', default: 0, unit: 'ms' },
  Seed: { type: 'number', default: 0 },
  ShowRays: { type: 'boolean', default: true },
  MountOffset: { type: 'vector3', default: { x: 0, y: 0, z: 0 }, unit: 'mm' },
  MountYaw: { type: 'number', default: 0, unit: 'deg' },
  SafetyNote: { type: 'string', default: SENSOR_SAFETY_NOTE, readonly: true },
};

/** Inline schema of `Rangefinder` — the base plus its one distance signal. */
export const RANGEFINDER_SCHEMA: ComponentSchema = {
  ...RAY_SENSOR_SCHEMA_BASE,
  SignalDistance: { type: 'componentRef', signal: 'PLCInputFloat', signalUnit: 'mm' },
};

/** Component type names — the rv_extras keys and the registry keys. */
export const RANGEFINDER_TYPE = 'Rangefinder';

const DEG = Math.PI / 180;

/** Upper bound of the latency ring — beyond this the configuration, not the ring, is wrong. */
const MAX_RING_FRAMES = 1024;

/** Scratch of the measurement frame — module level, so a scan allocates nothing. */
const _min = new Float64Array(3);
const _max = new Float64Array(3);
const _origin = new Float64Array(3);
const _forward = new Float64Array(3);
const _right = new Float64Array(3);

/**
 * One frame of a sensor's latency ring. The arrays belong to the ring and are
 * REUSED, which is what keeps the hot path allocation-free; `deliverAt` is the
 * sim time the frame becomes visible at.
 */
interface RingFrame extends ScanFrame {
  deliverAt: number;
  /** False while the slot has never carried a measurement. */
  filled: boolean;
}

/**
 * The shared body of `Rangefinder` and `LaserScanner`.
 *
 * Abstract in exactly one place — `fanAngles()`, which a rangefinder answers
 * with a single forward ray and a scanner with its fan — plus the two hooks for
 * the derived signals.
 */
export abstract class RayScanSensor implements RVComponent, RayScanSensorLike {
  readonly node: Object3D;
  isOwner = true;

  // ── Schema fields (mm / deg / Hz) ──────────────────────────────────────
  RangeMin = 20;
  RangeMax = 5000;
  NoiseSigma = 0;
  NoiseSigmaPerM = 0;
  DropoutProb = 0;
  DropoutProbPerM = 0;
  Resolution = 0;
  RateHz = 0;
  LatencyMs = 0;
  Seed = 0;
  ShowRays = true;
  MountOffset: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  MountYaw = 0;
  SafetyNote = SENSOR_SAFETY_NOTE;

  // ── Runtime ────────────────────────────────────────────────────────────
  /** Node path — the key in the data channel and in the noise seed. */
  protected path = '';
  /** Ray angles (rad), built once from the fan configuration. */
  protected angles: Float32Array = new Float32Array(1);
  /** This sensor's own random stream (never shared — see `rv-prng.ts`). */
  protected stream: RandomStream | null = null;

  private _tm: RVTransportManager | null = null;
  private _writer: SignalWriter | null = null;
  private _sources: RaySceneSources | null = null;
  private _boxes: BoxBuffer = makeBoxBuffer();
  private _noise: NoiseParams = {
    sigma: 0, sigmaPerM: 0, dropout: 0, dropoutPerM: 0, resolution: 0, rangeMin: 0, rangeMax: Infinity,
  };

  /** The scene's master seed, kept so {@link resetScan} rebuilds the IDENTICAL stream. */
  private _master = 0;
  private _rangeMinM = 0.02;
  private _rangeMaxM = 5;
  private _yawRad = 0;
  private _offsetM = { x: 0, y: 0, z: 0 };

  /** Rate accumulator and period in SIM seconds; `period = 0` = every tick. */
  private _acc = 0;
  private _period = 0;
  private _latencyS = 0;
  private _seq = 0;

  private _ring: RingFrame[] = [];
  private _head = 0;
  private _tail = 0;
  private _warnedRing = false;

  /** Self-exclusion: the vehicle root this sensor is mounted on, if any. */
  private _selfRoot: Object3D | null = null;
  private _selfRootFrom: readonly AgvHandle[] | null = null;

  /** Last delivered frame — what the data channel currently holds. */
  protected delivered: ScanFrame | null = null;

  /**
   * The frame the latency last released, or `null` before the first delivery.
   *
   * The same object the data channel holds, and the direct route for a consumer
   * that already has the component — the Phase-3 coupling reads it inside the
   * fleet input stage, where going through the channel by path would be a map
   * lookup for a reference it is holding.
   */
  get lastFrame(): ScanFrame | null { return this.delivered; }

  constructor(node: Object3D) {
    this.node = node;
  }

  /** Ray angles (rad) of this sensor's fan, built once in `init()`. */
  protected abstract fanAngles(): Float32Array;
  /** Static properties of this sensor for the data channel. */
  protected abstract sensorInfo(): SensorInfo;
  /** Write the derived signals of a freshly delivered frame. */
  protected abstract writeSignals(frame: ScanFrame, writer: SignalWriter): void;
  /** Declare the derived signal slots in SlotIO, so unwired ones stay bindable in the viewer. */
  protected abstract declareSlots(): void;

  init(ctx: ComponentContext): void {
    // A second init (a live config edit, a re-bind) must REPLACE the first, not
    // add a second scanner on the same node: the derived values, the fan, the
    // period and the ring are all computed here, so the whole registration is
    // torn down and rebuilt.
    if (this._tm) this._teardown();
    this.path = NodeRegistry.computeNodePath(this.node);
    this.node.userData._rvType = this.typeName;

    this._rangeMinM = Math.max(0, this.RangeMin) / 1000;
    this._rangeMaxM = Math.max(this._rangeMinM, this.RangeMax / 1000);
    this._yawRad = this.MountYaw * DEG;
    this._offsetM = {
      x: (this.MountOffset?.x ?? 0) / 1000,
      y: (this.MountOffset?.y ?? 0) / 1000,
      z: (this.MountOffset?.z ?? 0) / 1000,
    };

    this._noise = {
      sigma: Math.max(0, this.NoiseSigma) / 1000,
      sigmaPerM: Math.max(0, this.NoiseSigmaPerM) / 1000,
      dropout: clamp01(this.DropoutProb),
      dropoutPerM: Math.max(0, this.DropoutProbPerM),
      resolution: Math.max(0, this.Resolution) / 1000,
      rangeMin: this._rangeMinM,
      rangeMax: this._rangeMaxM,
    };

    this.angles = this.fanAngles();
    this._master = masterSeedOf(ctx);
    this.stream = makeStream(this._master, this.path, this.Seed);

    this._period = this.RateHz > 0 ? 1 / this.RateHz : 0;
    this._latencyS = Math.max(0, this.LatencyMs) / 1000;
    // Independent phase per sensor (plan-664 F1): scanners that fire in the SAME
    // tick cost what all of them cost, and phase-locking them is how a scene
    // with three scanners pays for three scans every tick instead of 1.25.
    // Measured for three 271-ray scanners over four runs (2026-10-24): p95
    // 0.18-0.33 ms/tick phased against 0.39-0.68 ms/tick locked, i.e. locked is
    // over the 0.5 ms budget in half the runs and phased never is.
    //
    // The phase comes from the sensor's own seed — which is derived from its node
    // path — so it is independent of registration order AND identical on every
    // reload, which is what a replay needs. Two sensors sharing a phase would
    // need a seed collision.
    this._acc = this._period > 0 && this.stream
      ? (this.stream.seed / 4294967296) * this._period
      : 0;

    this._buildRing();

    this._tm = ctx.transportManager;
    const fleet = getDefaultAgvFleet();
    this._sources = {
      queryMUs: (min, max, out) =>
        this._tm?.queryMUsXZ(min, max, out as (RVMovingUnit | InstancedMovingUnit)[]) ?? 0,
      vehicles: fleet.handleList,
      targets: [],
    };

    this._writer = createSignalWriter(
      ctx.signalStore,
      `component:${this.typeName}:${this.path}`,
      'component',
      { slotContext: this.path },
    );

    getSensorDataStore().register(this.path, this.sensorInfo());
    ctx.transportManager.raySensors.push(this);
    // A re-init re-declares in place: bindings holding a slot keep their listeners.
    this.declareSlots();
  }

  /** The registry type of the concrete component (`'Rangefinder'` / `'LaserScanner'`). */
  abstract get typeName(): string;

  /**
   * This component's signal writer — `null` before `init()` and after
   * `dispose()`. Protected rather than private because a subclass may write a
   * signal that is NOT derived from a scan (the field state of the AGV
   * coupling), and it must do so through the same writer identity so the signal
   * UI keeps attributing the value to this component.
   */
  protected get writer(): SignalWriter | null { return this._writer; }

  /**
   * One fixed tick: advance the rate accumulator, measure when due, deliver what
   * the latency releases. IMPLEMENTS RayScanSensorLike::scanStep
   */
  scanStep(dt: number, now: number): void {
    if (this._period > 0) {
      this._acc += dt;
      if (this._acc < this._period) { this._deliver(now); return; }
      // Modulo rather than one subtraction: a catch-up tick longer than the
      // period must still produce ONE measurement, not a burst, and must not
      // leave the accumulator growing without bound.
      this._acc %= this._period;
    }
    this._measure(now);
    this._deliver(now);
  }

  /**
   * Put the pipeline back to its start. IMPLEMENTS RayScanSensorLike::resetScan
   *
   * The random stream is REBUILT rather than continued: a restarted run must
   * draw the same noise as the first one, and a stream that carried on would
   * make the second run differ by however many samples the first consumed.
   */
  resetScan(): void {
    this._seq = 0;
    this.delivered = null;
    this._head = 0;
    this._tail = 0;
    for (let i = 0; i < this._ring.length; i++) {
      const f = this._ring[i];
      f.filled = false;
      f.seq = 0;
      f.simTime = 0;
      f.deliverAt = 0;
      f.ranges.fill(NO_HIT);
      f.hitKind.fill(HIT_NONE);
    }
    this.stream = makeStream(this._master, this.path, this.Seed);
    this._acc = this._period > 0 ? (this.stream.seed / 4294967296) * this._period : 0;
  }

  /** Cast one scan into the next ring slot. */
  private _measure(now: number): void {
    // Grow BEFORE writing: the number of measurements in flight is
    // `latency / measurement interval`, and with `RateHz = 0` the interval is
    // the host's fixed `dt`, which a component cannot know. Guessing it — the
    // first version assumed 60 Hz — drops the oldest undelivered frame on a
    // faster host, i.e. the latency silently stops working. Growing once during
    // warm-up costs one allocation and nothing afterwards.
    if ((this._head + 1) % this._ring.length === this._tail) this._grow();
    const frame = this._ring[this._head];
    this._computeFrame(frame);

    // Reach in Y is the full range too, not the fan's thickness: a tilted sensor
    // sweeps a plane that spans Y, and the MU broad-phase is an XZ grid that
    // ignores the Y window anyway. Narrowing it would buy nothing and could
    // exclude a candidate the exact test would have hit.
    fanBounds(_origin, this._rangeMaxM, this._rangeMaxM, _min, _max);
    const sources = this._sources!;
    sources.vehicles = getDefaultAgvFleet().handleList;
    sources.targets = rayTargetBoxes(now);
    collectCandidates(this._boxes, sources, this._selfRootOf(), _min, _max);

    castFan(
      _origin, _forward, _right, this.angles,
      this._rangeMinM, this._rangeMaxM,
      this._boxes, frame.ranges, frame.hitKind,
    );
    if (this.stream) applyNoise(frame.ranges, this._noise, this.stream.normal, this.stream.uniform);
    // Noise can drop a ray that the cast hit; the kind has to follow, or a
    // consumer would colour a hit point that carries no distance.
    for (let i = 0; i < frame.ranges.length; i++) if (frame.ranges[i] < 0) frame.hitKind[i] = HIT_NONE;

    frame.seq = ++this._seq;
    frame.simTime = now;
    frame.deliverAt = now + this._latencyS;
    frame.filled = true;
    this._head = (this._head + 1) % this._ring.length;
    // A full ring overwrites its oldest slot — the tail follows, so a frame is
    // never delivered twice and an over-latency configuration degrades by
    // dropping the oldest measurement instead of growing without bound.
    if (this._head === this._tail) this._tail = (this._tail + 1) % this._ring.length;
  }

  /** Publish every frame whose dead time has elapsed; the newest one wins. */
  private _deliver(now: number): void {
    let out: RingFrame | null = null;
    while (this._tail !== this._head) {
      const f = this._ring[this._tail];
      if (!f.filled || f.deliverAt > now) break;
      out = f;
      this._tail = (this._tail + 1) % this._ring.length;
    }
    if (!out) return;
    this.delivered = out;
    getSensorDataStore().publish(this.path, out);
    if (this._writer) this.writeSignals(out, this._writer);
  }

  /**
   * World measurement frame of this tick, into the module scratch.
   *
   * The mount yaw turns the fan around the node's local +Y, so the sensor can sit
   * on the vehicle root itself (where the Pallet Yard generator writes the Agv
   * extras) and still look sideways. The axes are re-orthonormalised because a
   * mirrored or non-uniformly scaled root — a legacy vehicle, a flipped
   * placement — would otherwise hand the cast a skewed basis and with it ray
   * directions that are not unit vectors.
   */
  private _computeFrame(frame: RingFrame): void {
    this.node.updateWorldMatrix(true, false);
    const m = this.node.matrixWorld.elements;
    const sy = Math.sin(this._yawRad);
    const cy = Math.cos(this._yawRad);
    const o = this._offsetM;

    _origin[0] = m[0] * o.x + m[4] * o.y + m[8] * o.z + m[12];
    _origin[1] = m[1] * o.x + m[5] * o.y + m[9] * o.z + m[13];
    _origin[2] = m[2] * o.x + m[6] * o.y + m[10] * o.z + m[14];

    // Local forward = R_y(yaw) * +Z, local right = R_y(yaw) * +X.
    dirToWorld(m, sy, 0, cy, _forward);
    dirToWorld(m, cy, 0, -sy, _right);
    normalize(_forward);
    // Gram-Schmidt: strip the forward component out of right, then normalise.
    const d = _right[0] * _forward[0] + _right[1] * _forward[1] + _right[2] * _forward[2];
    _right[0] -= d * _forward[0];
    _right[1] -= d * _forward[1];
    _right[2] -= d * _forward[2];
    normalize(_right);

    // up = forward x right (right-handed with x=right, y=up, z=forward).
    const ux = _forward[1] * _right[2] - _forward[2] * _right[1];
    const uy = _forward[2] * _right[0] - _forward[0] * _right[2];
    const uz = _forward[0] * _right[1] - _forward[1] * _right[0];

    const w = frame.sensorWorld;
    w[0] = _right[0]; w[1] = _right[1]; w[2] = _right[2]; w[3] = 0;
    w[4] = ux; w[5] = uy; w[6] = uz; w[7] = 0;
    w[8] = _forward[0]; w[9] = _forward[1]; w[10] = _forward[2]; w[11] = 0;
    w[12] = _origin[0]; w[13] = _origin[1]; w[14] = _origin[2]; w[15] = 1;
  }

  /**
   * The vehicle root this sensor is mounted on — its whole subtree, own load
   * included, is invisible to the rays.
   *
   * Resolved against the fleet's stable handle array and re-resolved only when
   * that array is rebuilt, which the fleet does on every register / unregister.
   * `null` = a stationary sensor; nothing is excluded then, and nothing needs to
   * be: static geometry is not a candidate before Phase 8.
   */
  private _selfRootOf(): Object3D | null {
    const list = getDefaultAgvFleet().handleList;
    if (list === this._selfRootFrom) return this._selfRoot;
    this._selfRootFrom = list;
    this._selfRoot = null;
    for (let i = 0; i < list.length; i++) {
      const n = list[i].node;
      if (n && isInSubtree(this.node, n)) { this._selfRoot = n; break; }
    }
    return this._selfRoot;
  }

  /**
   * Pre-allocate the latency ring for the expected number of frames in flight
   * (`latency * rate`, plus the one being written and one free slot so a full
   * ring is distinguishable from an empty one).
   *
   * With `RateHz = 0` the rate is the host's tick rate, which is unknown here;
   * 60 Hz is the estimate, and {@link _grow} covers a faster host.
   */
  private _buildRing(): void {
    const rate = this._period > 0 ? 1 / this._period : 60;
    const n = Math.max(2, Math.ceil(this._latencyS * rate) + 2);
    this._ring = new Array(n);
    for (let i = 0; i < n; i++) this._ring[i] = this._makeFrame();
    this._head = 0;
    this._tail = 0;
  }

  /** One empty ring slot. */
  private _makeFrame(): RingFrame {
    const rays = this.angles.length;
    return {
      seq: 0, simTime: 0, deliverAt: 0, filled: false,
      ranges: new Float32Array(rays).fill(NO_HIT),
      hitKind: new Uint8Array(rays),
      // One shared angles array for every frame of this sensor: the fan is
      // constant, and copying it per frame would be the only allocation left.
      angles: this.angles,
      sensorWorld: new Float32Array(16),
    };
  }

  /**
   * Double the ring, keeping the undelivered frames in order.
   *
   * Capped: a latency that would need more than {@link MAX_RING_FRAMES} frames
   * in flight is a configuration error (a scanner delayed by whole seconds), and
   * the honest answer is to say so once and then drop the oldest measurement
   * rather than grow until the tab runs out of memory.
   */
  private _grow(): void {
    const n = this._ring.length;
    if (n >= MAX_RING_FRAMES) {
      if (!this._warnedRing) {
        this._warnedRing = true;
        console.warn(
          `[${this.typeName}] ${this.path}: LatencyMs ${this.LatencyMs} needs more than `
          + `${MAX_RING_FRAMES} measurements in flight at this tick rate — the oldest scan is `
          + 'dropped. Lower LatencyMs or raise RateHz.',
        );
      }
      return;
    }
    const next = new Array<RingFrame>(n * 2);
    let k = 0;
    for (let i = this._tail; i !== this._head; i = (i + 1) % n) next[k++] = this._ring[i];
    next[k] = this._ring[this._head];                 // the slot about to be written
    for (let j = k + 1; j < n * 2; j++) next[j] = this._makeFrame();
    this._ring = next;
    this._tail = 0;
    this._head = k;
  }

  /** The smallest real distance (mm) of the last delivered frame; `-1` = nothing seen. */
  minDistanceMm(): number {
    if (!this.delivered) return NO_HIT;
    const d = minRange(this.delivered.ranges);
    return d < 0 ? NO_HIT : d * 1000;
  }

  dispose(): void {
    this._teardown();
    slotUndeclare(this);
  }

  /** Everything `init()` registered, except the SlotIO declarations. */
  private _teardown(): void {
    const tm = this._tm;
    if (tm) {
      const i = tm.raySensors.indexOf(this);
      if (i >= 0) tm.raySensors.splice(i, 1);
    }
    getSensorDataStore().unregister(this.path);
    this._tm = null;
    this._writer = null;
    this._sources = null;
    this.delivered = null;
  }
}

/** A single-ray time-of-flight / light-barrier distance sensor. */
export class RVRangefinder extends RayScanSensor {
  static readonly schema = RANGEFINDER_SCHEMA;

  /** Float signal (mm) carrying the measured distance; no hit reports `RangeMax`. */
  SignalDistance: string | null = null;

  get typeName(): string { return RANGEFINDER_TYPE; }

  /** One ray along the node's local +Z, turned by `MountYaw` — MuJoCo's site-z convention. */
  protected fanAngles(): Float32Array {
    return buildFan(0, 0);
  }

  protected sensorInfo(): SensorInfo {
    return {
      type: RANGEFINDER_TYPE,
      rayCount: 1,
      rangeMinMm: this.RangeMin,
      rangeMaxMm: this.RangeMax,
      rateHz: this.RateHz,
      latencyMs: this.LatencyMs,
      fieldOfViewDeg: 0,
      angularResolutionDeg: 0,
      seed: this.stream?.seed ?? 0,
    };
  }

  /**
   * No hit reports `RangeMax` rather than the internal `-1`: a PLC reads a
   * distance word, and a negative distance there is a value nobody can scale.
   * The raw `-1` stays available in the frame on the data channel.
   */
  protected writeSignals(frame: ScanFrame, writer: SignalWriter): void {
    const d = frame.ranges[0];
    slotWrite(this, 'SignalDistance', this.SignalDistance, d < 0 ? this.RangeMax : d * 1000, writer);
  }

  protected declareSlots(): void {
    slotDeclare(this, 'SignalDistance', 'feedback');
  }
}

registerComponent({
  type: RANGEFINDER_TYPE,
  displayName: 'Rangefinder',
  schema: RVRangefinder.schema,
  capabilities: {
    authorable: true,
    pick: 'select',
    // No tooltip key: there is no ray-sensor tooltip content yet, and declaring one
    // that no resolver answers is a promise the hover silently drops (Phase 4).
    ui: { filter: 'Sensors', category: 'sensors', badge: '#66bb6a' },
  },
  create: (node) => new RVRangefinder(node),
  afterCreate: (_inst, node) => { node.userData._rvType = RANGEFINDER_TYPE; },
});

// ─── Helpers ────────────────────────────────────────────────────────────

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Rotate a local DIRECTION by a world matrix (translation ignored). */
function dirToWorld(m: ArrayLike<number>, x: number, y: number, z: number, out: Float64Array): void {
  out[0] = m[0] * x + m[4] * y + m[8] * z;
  out[1] = m[1] * x + m[5] * y + m[9] * z;
  out[2] = m[2] * x + m[6] * y + m[10] * z;
}

function normalize(v: Float64Array): void {
  const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (l < 1e-12) { v[0] = 0; v[1] = 0; v[2] = 1; return; }
  v[0] /= l; v[1] /= l; v[2] /= l;
}

/** One resolved master seed per loaded root — see {@link masterSeedOf}. */
const _masterSeeds = new WeakMap<Object3D, number>();

/**
 * The scene's master seed.
 *
 * The DESManager owns it, and it may sit on ANY node of the scene (it is a
 * singleton, not a root component), so the one existing resolver is used rather
 * than a second guess at where it lives. A continuous scene without a
 * DESManager reports 0, and every sensor still gets a stable stream from its
 * node path alone — which is what such a scene needs.
 *
 * Memoised per root: the resolver traverses the whole scene, and a yard with
 * three scanners must not traverse 12 000 nodes three times at load.
 */
function masterSeedOf(ctx: ComponentContext): number {
  const root = ctx.root;
  if (!root) return 0;
  const cached = _masterSeeds.get(root);
  if (cached !== undefined) return cached;
  const seed = findDesManager(root)?.masterSeed ?? 0;
  _masterSeeds.set(root, seed >>> 0);
  return seed >>> 0;
}
