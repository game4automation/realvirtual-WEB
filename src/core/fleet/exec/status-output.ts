// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import { VEHICLE_STATUS_SIGNALS } from '../fleet-status';
import type { VehicleStatusFlags } from './vehicle-status';
import { findLamps, lampStatesOf, litAt, resolveLampMap, type LampMap, type LampNames,
  type LampRole, type LampLike, type DisplayedLampState } from './lamp-map';

export interface StatusSignalSink { set(name: string, value: boolean | number): void }

/** The sole fleet status signal writer; lamps blink in simulation time. */
export class FleetStatusOutput {
  private readonly lamps = new Map<string, Map<LampRole, LampLike[]>>();
  private readonly lastSignals = new Map<string, boolean | number>();
  /** Last applied states (tests, diagnostics). */
  readonly states = new Map<string, Record<LampRole, DisplayedLampState>>();

  private readonly map: LampMap;
  constructor(private readonly signals: StatusSignalSink | null, private readonly opts: {
    lampMap?: Partial<LampMap>; lampNames?: Partial<LampNames>;
  } = {}) { this.map = resolveLampMap(opts.lampMap); }

  /** (Re)collect the lamps of every vehicle root. Returns the number of lamps found. */
  scan(vehicles: ReadonlyArray<{ id: string; root: Object3D | null }>): number {
    this.lamps.clear();
    this.states.clear();
    this.lastSignals.clear();
    let n = 0;
    for (const v of vehicles) {
      if (!v.root) continue;
      const m = findLamps(v.root, this.opts.lampNames);
      // The lamps belong to the core now: never flashing on their own (LampManager).
      for (const lamps of m.values()) for (const l of lamps) l.Flashing = false;
      this.lamps.set(v.id, m);
      n += this.lampCount(v.id);
    }
    return n;
  }

  lampCount(vehicle: string): number { return [...(this.lamps.get(vehicle)?.values() ?? [])].reduce((n, lamps) => n + lamps.length, 0); }

  /** Apply `status` of `vehicle` at sim time `t`. No allocation in the steady state but the record. */
  apply(vehicle: string, status: VehicleStatusFlags, t: number): void {
    const states = lampStatesOf(status, this.map);
    this.states.set(vehicle, states);
    const m = this.lamps.get(vehicle);
    if (m) {
      for (const [role, lamps] of m) for (const lamp of lamps) {
        const st = states[role];
        lamp.LampOn = st.on;
        lamp.setDisplayedLit(litAt(st, t, lamp.Period));
      }
    }
    if (this.signals) {
      this.signal(`${vehicle}.${VEHICLE_STATUS_SIGNALS.free}`, status.free);
      this.signal(`${vehicle}.${VEHICLE_STATUS_SIGNALS.busy}`, status.busy);
      this.signal(`${vehicle}.${VEHICLE_STATUS_SIGNALS.handling}`, status.handling);
      this.signal(`${vehicle}.${VEHICLE_STATUS_SIGNALS.charging}`, status.charging);
      this.signal(`${vehicle}.${VEHICLE_STATUS_SIGNALS.fault}`, status.fault);
      this.signal(`${vehicle}.${VEHICLE_STATUS_SIGNALS.moving}`, status.moving);
      this.signal(`${vehicle}.${VEHICLE_STATUS_SIGNALS.faultCode}`, Math.trunc(status.faultCode ?? 0));
      if (typeof status.soc === 'number' && Number.isFinite(status.soc)) {
        this.signal(`${vehicle}.${VEHICLE_STATUS_SIGNALS.soc}`, Math.round(status.soc * 10) / 10);
      }
    }
  }

  fleetCounts(name = 'Fleet', pending: number, done: number): void {
    if (!this.signals) return;
    this.signal(`${name}.OrdersPending`, pending);
    this.signal(`${name}.OrdersDone`, done);
  }

  /** Forget the write de-dupe (plan-2059 phase 8): after a snapshot restore the store holds restored values the cache never saw. */
  invalidate(): void { this.lastSignals.clear(); }

  private signal(name: string, v: boolean | number): void {
    if (this.lastSignals.get(name) === v) return;
    this.lastSignals.set(name, v);
    try { this.signals!.set(name, v); } catch { /* a missing store never stops the fleet */ }
  }
}
