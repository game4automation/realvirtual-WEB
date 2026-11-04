// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * LaserScanner — a 2D laser scanner (safety scanner / 2D LiDAR), plan-664 Phase 2.
 *
 * The same computation as `Rangefinder` with more than one ray: a symmetric fan
 * in the node's local XZ plane around +Z, `floor(FOV / resolution) + 1` rays, so
 * both edges of a 270° / 1° fan are real rays — the convention a nanoScan3 or
 * microScan3 datasheet uses. Everything else — mounting, candidates, cast,
 * noise, rate, latency, data channel — comes from `RayScanSensor`.
 *
 * ## Rate
 *
 * `RateHz` defaults to 25, not to 0 ("every fixed tick"). A real safety scanner
 * scans at about that rate and the plan's own acceptance configuration asks for
 * it, but the reason it is the DEFAULT is cost: three scanners firing in EVERY
 * 60 Hz tick is the phase-locked configuration Phase 1 found over budget, and it
 * still is. Measured 2026-10-24 over four clean runs (three scanners, 271 rays,
 * 39 of 200 crates in the fan, Chromium): at 25 Hz p95 0.18-0.33 ms against the
 * 0.5 ms budget, at `RateHz = 0` p95 0.39-0.68 ms — i.e. over the budget in half
 * the runs. `0` still means every tick; it is an explicit choice now rather than
 * something a scene falls into by accepting the defaults.
 *
 * ## What it does NOT do
 *
 * It does not brake a vehicle. The geometric field machine and the sensor limit
 * in the movement authority are Phase 3; this component measures, publishes and
 * writes its two signals. `ObstacleInField` is wired here and stays false until
 * that coupling sets it — one signal, one owner.
 *
 * The simulation is not a certified safety function; `SafetyNote` says so in the
 * inspector of every instance.
 *
 * WEB-only: no Unity counterpart, therefore no rv-ODT `$def`.
 */

import type { Object3D } from 'three';
import type { ComponentSchema } from './rv-component-registry';
import { registerComponent } from './rv-component-registry';
import type { SignalWriter } from './rv-signal-store';
import { buildFan, minRange } from './rv-ray-scan';
import { RAY_SENSOR_SCHEMA_BASE, RayScanSensor } from './rv-rangefinder';
import type { ScanFrame, SensorInfo } from './rv-sensor-data-store';
import { slotBound, slotDeclare, slotWrite } from './rv-slot-io';

/** Component type name — the rv_extras key and the registry key. */
export const LASER_SCANNER_TYPE = 'LaserScanner';

/** Inline schema — the shared ray-sensor fields plus the fan and its two signals. */
export const LASER_SCANNER_SCHEMA: ComponentSchema = {
  ...RAY_SENSOR_SCHEMA_BASE,
  // A scanner's reach and rate differ from a rangefinder's by an order of
  // magnitude, so the two defaults are overridden rather than inherited.
  RangeMax: { type: 'number', default: 8000, unit: 'mm' },
  RateHz: { type: 'number', default: 25, unit: 'Hz' },
  FieldOfView: { type: 'number', default: 270, unit: 'deg' },
  AngularResolution: { type: 'number', default: 1, unit: 'deg' },
  SignalMinDistance: { type: 'componentRef', signal: 'PLCInputFloat', signalUnit: 'mm' },
  SignalObstacleInField: { type: 'componentRef', signal: 'PLCInputBool' },
};

export class RVLaserScanner extends RayScanSensor {
  static readonly schema = LASER_SCANNER_SCHEMA;

  /** Fan opening in degrees, symmetric around the local +Z axis. */
  FieldOfView = 270;
  /** Angular step in degrees; rays = `floor(FieldOfView / AngularResolution) + 1`. */
  AngularResolution = 1;
  /** Float signal (mm) carrying the nearest reading of a scan; no hit reports `RangeMax`. */
  SignalMinDistance: string | null = null;
  /** Bool signal set by the Phase-3 AGV coupling while an obstacle stands in the field. */
  SignalObstacleInField: string | null = null;

  private _inField = false;

  get typeName(): string { return LASER_SCANNER_TYPE; }

  protected fanAngles(): Float32Array {
    return buildFan(this.FieldOfView, this.AngularResolution);
  }

  /** Rays of this scanner's fan — available before the first measurement. */
  get rayCount(): number { return this.angles.length; }

  protected sensorInfo(): SensorInfo {
    return {
      type: LASER_SCANNER_TYPE,
      rayCount: this.angles.length,
      rangeMinMm: this.RangeMin,
      rangeMaxMm: this.RangeMax,
      rateHz: this.RateHz,
      latencyMs: this.LatencyMs,
      fieldOfViewDeg: this.FieldOfView,
      angularResolutionDeg: this.AngularResolution,
      seed: this.stream?.seed ?? 0,
    };
  }

  /**
   * The field state of the Phase-3 geometric field machine.
   *
   * Separate from the scan on purpose: the measurement says how far the nearest
   * object is, the FIELD says whether that object stands in the corridor the
   * vehicle is about to drive through, and only the coupling knows the corridor.
   * Writes the signal on a change only, so a quiet field costs nothing.
   */
  setObstacleInField(v: boolean): void {
    if (v === this._inField) return;
    this._inField = v;
    slotWrite(this, 'SignalObstacleInField', this.SignalObstacleInField, v, this.writer);
  }

  /** Current field state as the coupling last set it. */
  get obstacleInField(): boolean { return this._inField; }

  protected writeSignals(frame: ScanFrame, writer: SignalWriter): void {
    // The minimum is only computed when someone reads it (wired or bound directly).
    if (slotBound(this, 'SignalMinDistance', this.SignalMinDistance)) {
      const d = minRange(frame.ranges);
      slotWrite(this, 'SignalMinDistance', this.SignalMinDistance, d < 0 ? this.RangeMax : d * 1000, writer);
    }
    // ObstacleInField is NOT derived from the frame — see setObstacleInField.
    // It is initialised once so a bound signal has a defined level from the
    // first delivered scan on rather than staying undefined until Phase 3.
    if (frame.seq === 1) {
      slotWrite(this, 'SignalObstacleInField', this.SignalObstacleInField, this._inField, writer);
    }
  }

  protected declareSlots(): void {
    slotDeclare(this, 'SignalMinDistance', 'feedback');
    slotDeclare(this, 'SignalObstacleInField', 'feedback', { initial: this._inField });
  }
}

registerComponent({
  type: LASER_SCANNER_TYPE,
  displayName: 'Laser Scanner',
  schema: RVLaserScanner.schema,
  capabilities: {
    authorable: true,
    pick: 'select',
    ui: { filter: 'Sensors', category: 'sensors', badge: '#66bb6a' },
  },
  create: (node: Object3D) => new RVLaserScanner(node),
  afterCreate: (_inst, node) => { node.userData._rvType = LASER_SCANNER_TYPE; },
});
