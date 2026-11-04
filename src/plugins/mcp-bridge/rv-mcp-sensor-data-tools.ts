// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-sensor-data-tools — the ray sensors over MCP (plan-664 Phase 2).
 *
 * Query implementation for `sensor.read` (plan-2007 Phase 4C). It reads the
 * current frame in the sensor data channel and serialises it. The descriptor
 * lives in query-commands.ts; this module contributes no MCP tools.
 *
 * ## Why the frame is reported in mm
 *
 * The channel speaks metres (the engine's unit), the schema and the signals
 * speak mm (parity with `RVSensor.RayCastLength`). An agent reading a scan is
 * reading the AUTHORING side of the sensor — it wants the number it would type
 * into `RangeMax` — so the tool converts, and says so in every field name.
 *
 * ## Why the angles are not a 271-element array
 *
 * A fan is `from + i * step`; sending it out per ray would triple the payload to
 * say the same thing three times. The three numbers are in the answer, and the
 * ranges array is index-aligned with them.
 */

import type { RVViewer } from '../../core/rv-viewer';
import { getSensorDataStore, type ScanFrame } from '../../core/engine/rv-sensor-data-store';
import { HIT_AGV, HIT_MU, HIT_NONE, HIT_TARGET, minRange } from '../../core/engine/rv-ray-scan';

/** `hitKind` as a word, so an answer is readable without the kernel's constants. */
const KIND_NAME: Record<number, string> = {
  [HIT_NONE]: 'none',
  [HIT_MU]: 'mu',
  [HIT_AGV]: 'agv',
  [HIT_TARGET]: 'target',
};

/** Distances are reported to 0.1 mm — below that the payload carries float noise, not data. */
function mm(metres: number): number {
  return Math.round(metres * 10000) / 10;
}

export class SensorDataQueries {
  constructor(private readonly getViewer: () => RVViewer | undefined) {}

  /** Read-only command body; preserves the original JSON value contract. */
  async querySensorRead(
    path: string,
  ): Promise<string> {
    const store = getSensorDataStore();
    if (!path) {
      return JSON.stringify({
        sensors: store.paths().map((p) => {
          const info = store.infoOf(p)!;
          const frame = store.get(p);
          return { path: p, type: info.type, rays: info.rayCount, scans: frame?.seq ?? 0 };
        }),
      });
    }

    const info = store.infoOf(path);
    if (!info) {
      return JSON.stringify({
        error: `No ray sensor at "${path}"`,
        hint: 'Call web_query("sensor.read", {}) without a path for the registered ray sensors, or add a '
          + 'Rangefinder / LaserScanner component to the node.',
      });
    }

    const frame = store.get(path);
    const config = {
      type: info.type,
      rays: info.rayCount,
      rangeMinMm: info.rangeMinMm,
      rangeMaxMm: info.rangeMaxMm,
      rateHz: info.rateHz,
      latencyMs: info.latencyMs,
      fieldOfViewDeg: info.fieldOfViewDeg,
      angularResolutionDeg: info.angularResolutionDeg,
      seed: info.seed,
    };
    if (!frame) {
      return JSON.stringify({
        path, ...config,
        scan: null,
        note: this.getViewer()?.transportManager
          ? 'No scan yet — the sensor measures in the fixed loop; start the simulation.'
          : 'No model loaded.',
      });
    }
    return JSON.stringify({ path, ...config, scan: serializeFrame(frame) });
  }
}

/** One frame as the tool reports it — mm, degrees, and the fan as three numbers. */
function serializeFrame(f: ScanFrame): Record<string, unknown> {
  const n = f.ranges.length;
  const ranges = new Array<number>(n);
  const kinds = new Array<string>(n);
  let hits = 0;
  for (let i = 0; i < n; i++) {
    const d = f.ranges[i];
    ranges[i] = d < 0 ? -1 : mm(d);
    kinds[i] = KIND_NAME[f.hitKind[i]] ?? 'none';
    if (d >= 0) hits++;
  }
  const best = minRange(f.ranges);
  const toDeg = 180 / Math.PI;
  return {
    seq: f.seq,
    simTime: f.simTime,
    hits,
    minDistanceMm: best < 0 ? -1 : mm(best),
    angleFromDeg: n > 0 ? f.angles[0] * toDeg : 0,
    angleToDeg: n > 0 ? f.angles[n - 1] * toDeg : 0,
    angleStepDeg: n > 1 ? (f.angles[1] - f.angles[0]) * toDeg : 0,
    rangesMm: ranges,
    hitKinds: kinds,
    // The measurement frame: where the rays started and where +Z pointed.
    originMm: [mm(f.sensorWorld[12]), mm(f.sensorWorld[13]), mm(f.sensorWorld[14])],
    forward: [f.sensorWorld[8], f.sensorWorld[9], f.sensorWorld[10]],
  };
}
