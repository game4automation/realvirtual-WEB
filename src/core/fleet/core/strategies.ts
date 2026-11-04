// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { Consumption } from './battery';
import type { FleetStation, StationId, TransportOrder } from './orders';

export interface VehicleView { id: string; soc: number; at: string }
export type Destination = { kind: 'drop'; station: StationId } | { kind: 'buffer'; station: StationId };
export type Job =
  | { kind: 'pick'; vehicle: string; from: string; to: Destination; pallet: string; loaded: boolean; order?: TransportOrder }
  | { kind: 'retrieve'; vehicle: string; from: string; to: string; pallet: string | null; loaded: boolean }
  | { kind: 'charge'; vehicle: string; charger: string; untilSoc: number; durationSec: number }
  | { kind: 'queue'; vehicle: string }
  | { kind: 'park'; vehicle: string };

export interface DispatchEnv {
  t: number;
  distanceM(from: string, to: string): number;
  /** The station can physically receive now (free head, not paused). */
  canReceive(station: StationId, t: number): boolean;
}

export interface ConsumptionModel {
  order(travelM: number, from: FleetStation, to: FleetStation, includeIdleReserve: boolean): Consumption;
  toCharger(travelM: number, charger: FleetStation): Consumption;
}

export interface ForkliftConsumptionParams {
  travelSpeedMmS: number;
  reverseSpeedMmS: number;
  liftSpeedLoadedMmS: number;
  liftSpeedEmptyMmS: number;
  travelHeightMm: number;
  handlingDeltaMm: number;
  travelSlack: number;
  idleReserveSec: number;
}

/** Reads live planning parameters for each consumption calculation. */
export function forkliftConsumption(p: () => ForkliftConsumptionParams): ConsumptionModel {
  return {
    order(travelM, from, to, includeIdleReserve) {
      const v = p();
      let driveSec = (travelM * v.travelSlack) / (v.travelSpeedMmS / 1000);
      let emptyMm = 0, loadedMm = 0;
      for (let i = 0; i < 2; i++) {
        const station = i === 0 ? from : to;
        driveSec += (2 * station.approachM) / (v.reverseSpeedMmS / 1000);
        const h = station.handlingHeightMm, d = v.handlingDeltaMm, T = v.travelHeightMm;
        if (i === 0) {
          const approach = Math.max(0, h - d), up = h + d;
          emptyMm += Math.abs(T - approach) + Math.abs(h - approach);
          loadedMm += Math.abs(up - h) + Math.abs(up - T);
        } else {
          const approach = h + d, down = Math.max(0, h - d);
          loadedMm += Math.abs(T - approach) + Math.abs(approach - h);
          emptyMm += Math.abs(h - down) + Math.abs(down - T);
        }
      }
      const liftSec = emptyMm / v.liftSpeedEmptyMmS + loadedMm / v.liftSpeedLoadedMmS;
      return {
        driveSec,
        liftM: (emptyMm + loadedMm) / 1000,
        idleSec: liftSec + (includeIdleReserve ? v.idleReserveSec : 0),
      };
    },
    toCharger(travelM, charger) {
      const v = p();
      return {
        driveSec: (travelM * v.travelSlack) / (v.travelSpeedMmS / 1000) + charger.approachM / (v.reverseSpeedMmS / 1000),
        liftM: 0,
        idleSec: 0,
      };
    },
  };
}

export const OPPORTUNITY_MIN_SEC = 60;

export interface RetrievalContext {
  readonly t: number;
  /** Pick stations with a pending order no vehicle has yet. */
  waitingSources(): readonly StationId[];
}
export type RetrievalRule = (ctx: RetrievalContext) => boolean;

/** Built-in retrieval gates; destination availability is checked by the dispatcher. */
export const RETRIEVAL_RULES = {
  'legacy-fifo': (ctx) => ctx.waitingSources().length === 0,
  'when-inbound-free': () => true,
} satisfies Record<string, RetrievalRule>;

export function resolveBuiltinStrategy(
  kind: 'vehicleSelection' | 'charging', name: string | null | undefined,
  report?: (code: string, detail: string) => void,
): string {
  const fallback = kind === 'vehicleSelection' ? 'nearest-feasible' : 'threshold-opportunity';
  if (!name || name === fallback) return fallback;
  report?.('fleet-strategy-unknown', `${kind}: unknown strategy "${name}"; using "${fallback}"`);
  return fallback;
}
