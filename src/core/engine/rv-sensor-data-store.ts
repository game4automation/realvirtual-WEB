// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * The sensor data channel (plan-664 Phase 2).
 *
 * ## Why a channel and not a signal
 *
 * A scan is a few hundred numbers per measurement. The `SignalStore` is the
 * right place for the handful of DERIVED values a PLC reads (`MinDistance`,
 * `ObstacleInField`) and the wrong place for the raw frame: a signal is a scalar
 * with a name, a change list and a write inventory, and pushing 271 floats
 * through it every 40 ms would cost more than the scan.
 *
 * So the raw frame goes through this channel instead — one current frame per
 * sensor plus a subscription — and only the derived scalars go to the store.
 * Consumers: `web_sensor_read` (MCP), the ray visualisation (Phase 4), the AGV
 * coupling (Phase 3) and the image-based sensors of plan-672, which reuse the
 * SAME channel rather than inventing a second one.
 *
 * ## What a published frame is
 *
 * It is a VIEW into the publishing sensor's pre-allocated latency ring, not a
 * copy: the arrays are reused once the ring wraps. A consumer reads it inside
 * the tick it was published in, or copies what it needs. That is the price of a
 * hot path that allocates nothing, and it is why `get()` is a cheap look at the
 * CURRENT frame rather than a history — the history that matters is the latency
 * ring inside the sensor, and it is the sensor's business.
 *
 * ## Ownership
 *
 * A module singleton, like `getDefaultAgvFleet()`. The channel outlives a model
 * load (the MCP bridge and the viz plugin hold their subscriptions across one),
 * and every sensor removes its own entry in `dispose()`, so an unloaded model
 * leaves nothing behind without a global reset hook.
 */

/**
 * One measurement of a ray sensor.
 *
 * `simTime` is the time of the MEASUREMENT, not of the delivery: a frame with
 * `LatencyMs > 0` becomes visible later, and everything that evaluates it — the
 * corridor of the AGV coupling above all — has to work in the frame the
 * measurement was taken in, not in the pose the vehicle has now.
 */
export interface ScanFrame {
  /** Measurement counter of this sensor, starting at 1. */
  seq: number;
  /** Sim time (s) of the measurement, BEFORE the latency. */
  simTime: number;
  /** Distances (m) per ray; `-1` = no hit (see `rv-ray-scan.ts`). */
  ranges: Float32Array;
  /** What each ray hit — `HIT_NONE` / `HIT_MU` / `HIT_AGV` / `HIT_TARGET`. */
  hitKind: Uint8Array;
  /** Ray angles (rad) in the sensor's local XZ plane; constant, shared by every frame of one sensor. */
  angles: Float32Array;
  /**
   * The measurement frame as a 4x4 column-major matrix: right (+X), up (+Y),
   * forward (+Z) and the ray origin in world coordinates, mount offset and
   * mount yaw already applied. NOT `node.matrixWorld` — a consumer that wants
   * to rebuild a ray needs the frame the rays were actually cast in.
   */
  sensorWorld: Float32Array;
}

/** What a sensor IS — published once at init, so a reader needs no component instance. */
export interface SensorInfo {
  /** Component type, `'Rangefinder'` or `'LaserScanner'`. */
  type: string;
  /** Rays per scan (a rangefinder is a fan of one). */
  rayCount: number;
  /** Dead zone (mm) — a nearer hit is no reading. */
  rangeMinMm: number;
  /** Reach (mm). */
  rangeMaxMm: number;
  /** Measurement rate (Hz); `0` = every fixed tick. */
  rateHz: number;
  /** Dead time (ms) between measurement and delivery. */
  latencyMs: number;
  /** Fan opening (deg); `0` for a rangefinder. */
  fieldOfViewDeg: number;
  /** Angular step (deg); `0` for a rangefinder. */
  angularResolutionDeg: number;
  /** The seed the sensor's noise stream was built from (reproducibility). */
  seed: number;
}

/** A sensor the transport manager steps once per fixed tick. */
export interface RayScanSensorLike {
  /**
   * One fixed tick of this sensor: advance the rate accumulator, measure when it
   * is due, deliver what the latency releases.
   *
   * `now` is the sim time at the END of the tick, counted by the transport
   * manager from the same `dt` the viewer's own clock uses, so the two agree
   * without the sensor having to reach for the viewer.
   */
  scanStep(dt: number, now: number): void;

  /**
   * Put the measurement pipeline back to its start: rate phase, latency ring,
   * sequence counter and the random stream. Called from the transport manager's
   * `reset()` together with the ray-sensor clock, because "same scene + seed +
   * tick sequence gives bit-identical scans" is a claim about a RESTARTED run
   * too, and a surviving accumulator would quietly break it.
   */
  resetScan(): void;
}

/** Subscriber of one sensor's frames. */
export type ScanFrameListener = (frame: ScanFrame) => void;

interface Entry {
  info: SensorInfo;
  frame: ScanFrame | null;
  listeners: Set<ScanFrameListener>;
}

/** The current scan frames of every registered ray sensor, keyed by node path. */
export class SensorDataStore {
  private readonly entries = new Map<string, Entry>();

  /**
   * Announce a sensor and its static properties. Called from `init()`, so a
   * reader sees the sensor before its first measurement arrives — which is the
   * difference between "no such sensor" and "has not measured yet", and the
   * only way `web_sensor_read` can answer the second honestly.
   */
  register(path: string, info: SensorInfo): void {
    const prev = this.entries.get(path);
    if (prev) { prev.info = info; prev.frame = null; return; }
    this.entries.set(path, { info, frame: null, listeners: new Set() });
  }

  /** Remove a sensor and its frame; its subscribers are dropped with it. */
  unregister(path: string): void {
    this.entries.delete(path);
  }

  /** Make `frame` the current frame of `path` and notify its subscribers. */
  publish(path: string, frame: ScanFrame): void {
    const e = this.entries.get(path);
    if (!e) return;
    e.frame = frame;
    for (const fn of e.listeners) {
      try { fn(frame); } catch (err) { console.error('[sensor-data] subscriber failed:', err); }
    }
  }

  /** The current frame of `path`, or `null` while the sensor has not measured. */
  get(path: string): ScanFrame | null {
    return this.entries.get(path)?.frame ?? null;
  }

  /** The static properties of `path`, or `null` when no such sensor is registered. */
  infoOf(path: string): SensorInfo | null {
    return this.entries.get(path)?.info ?? null;
  }

  /** Every registered sensor path, in registration order. */
  paths(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * Listen to the frames of ONE sensor. Returns the unsubscribe function.
   * Subscribing to a path that is not registered yet is allowed and does
   * nothing — the component order of a load is not a contract.
   */
  subscribe(path: string, fn: ScanFrameListener): () => void {
    const e = this.entries.get(path);
    if (!e) return () => { /* nothing to unsubscribe */ };
    e.listeners.add(fn);
    return () => { e.listeners.delete(fn); };
  }

  /** Drop everything (tests, and a hard reset of the channel). */
  clear(): void {
    this.entries.clear();
  }
}

let _store: SensorDataStore | null = null;

/** The one channel of this tab. */
export function getSensorDataStore(): SensorDataStore {
  return (_store ??= new SensorDataStore());
}
