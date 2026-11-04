// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { validateShape, integer } from './source-state';

import type { BatteryModel, Consumption } from './battery';
import { OrderPool, type FleetStation, type StationId, type TransportOrder } from './orders';
import { ReservationTable } from './reservations';
import { StorageGroup } from './storage-group';
import {
  OPPORTUNITY_MIN_SEC,
  type ConsumptionModel, type Destination, type DispatchEnv, type Job,
  type RetrievalContext, type RetrievalRule, type VehicleView,
} from './strategies';

export interface FleetDispatcherOptions {
  stations: readonly FleetStation[];
  battery: BatteryModel;
  consumption: ConsumptionModel;
  retrieval?: RetrievalRule | null;
  /** Project tie rule for orders with equal priority and creation time. Default: order id. */
  orderTieBreak?(a: TransportOrder, b: TransportOrder): number;
  /** Called once per order that passes latest, during a dispatch round. */
  onLate?(order: TransportOrder): void;
}

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export class FleetDispatcher {
  readonly orders = new OrderPool();
  readonly reservations = new ReservationTable();
  readonly chargerQueue: string[] = [];
  private readonly picks: FleetStation[];
  private readonly drops: FleetStation[];
  private readonly chargers: FleetStation[];
  private readonly stations = new Map<StationId, FleetStation>();
  private readonly groups = new Map<string, StorageGroup>();
  private readonly groupOfPlace = new Map<StationId, StorageGroup>();
  private readonly firstGroup: StorageGroup | undefined;
  private jobs = new Map<string, Job>();
  private late = new Set<number>();
  private readonly retrieval: RetrievalRule | null;
  private readonly retrievalContext: RetrievalContext & { t: number };

  constructor(private readonly options: FleetDispatcherOptions) {
    const groupIds = new Map<string, string[]>();
    for (const s of options.stations) {
      this.stations.set(s.id, s);
      if (s.role === 'storage') {
        if (s.storageGroup === undefined) throw new Error(`Fleet: storage station ${s.id} has no group`);
        let ids = groupIds.get(s.storageGroup);
        if (!ids) { ids = []; groupIds.set(s.storageGroup, ids); }
        ids.push(s.id);
      }
    }
    for (const [name, ids] of groupIds) {
      const group = new StorageGroup(name, ids);
      this.groups.set(name, group);
      for (const id of ids) this.groupOfPlace.set(id, group);
    }
    this.firstGroup = this.groups.values().next().value;
    this.picks = options.stations.filter((s) => s.role === 'pick');
    this.drops = options.stations.filter((s) => s.role === 'drop');
    this.chargers = options.stations.filter((s) => s.role === 'charger');
    this.retrieval = options.retrieval ?? null;
    this.retrievalContext = { t: 0, waitingSources: () => this.waitingSources() };
  }

  exportState(): DispatcherState {
    return { reservations: this.reservations.exportState(), chargerQueue: [...this.chargerQueue],
      storage: [...this.groups].map(([id, g]) => ({ id, places: g.exportState() })),
      jobs: [...this.jobs.values()].map(j => j.kind === 'pick'
        ? { ...structuredClone(j), order: j.order?.id ?? null } : structuredClone(j)), late: [...this.late] };
  }

  validateState(value: unknown, resolveOrders = true): string[] {
    const errors = validateShape(value, { reservations: [], chargerQueue: [], storage: [], jobs: [], late: [] });
    if (errors.length) return errors;
    const s = value as DispatcherState;
    errors.push(...this.reservations.validateState(s.reservations));
    for (const r of s.reservations) if (r && r.kind !== 'wait' && !this.stations.has(r.id)) errors.push('unknown station');
    const unique = (a: unknown[], valid: (v: unknown) => boolean): void => {
      if (a.some(v => !valid(v)) || new Set(a).size !== a.length) errors.push('invalid or duplicate entry');
    };
    unique(s.chargerQueue, v => typeof v === 'string' && !!v);
    unique(s.late, v => integer(v) && v > 0);
    unique(s.storage.map(g => g?.id), v => typeof v === 'string' && this.groups.has(v));
    if (s.storage.length !== this.groups.size) errors.push('storage group count mismatch');
    for (const g of s.storage) {
      if (!g || Object.keys(g).sort().join(',') !== 'id,places') { errors.push('invalid storage'); continue; }
      const group = this.groups.get(g.id);
      if (group) errors.push(...group.validateState(g.places));
    }
    unique(s.jobs.map(j => j?.vehicle), v => typeof v === 'string' && !!v);
    for (const j of s.jobs) {
      if (!j || typeof j !== 'object') { errors.push('invalid job'); continue; }
      const templates = {
        pick: { kind: '', vehicle: '', from: '', to: { kind: '', station: '' }, pallet: '', loaded: false, order: null },
        retrieve: { kind: '', vehicle: '', from: '', to: '', pallet: null, loaded: false },
        charge: { kind: '', vehicle: '', charger: '', untilSoc: 0, durationSec: 0 },
        queue: { kind: '', vehicle: '' }, park: { kind: '', vehicle: '' },
      };
      if (!Object.hasOwn(templates, j.kind)) { errors.push('unknown job kind'); continue; }
      const shape = validateShape(j.kind === 'retrieve' ? { ...j, pallet: null } : j, templates[j.kind]); errors.push(...shape);
      if (shape.length) continue;
      const station = (id: string, role: string): void => {
        if (this.stations.get(id)?.role !== role) errors.push('unknown station or wrong role');
      };
      if (j.kind === 'pick') {
        station(j.from, 'pick'); station(j.to.station, j.to.kind === 'buffer' ? 'storage' : 'drop');
        if (!['drop', 'buffer'].includes(j.to.kind)) errors.push('invalid destination');
        if (j.order !== null && (!integer(j.order) || j.order === 0 || resolveOrders && !this.orders.orderById(j.order))) errors.push('unknown order id');
      } else if (j.kind === 'retrieve') {
        station(j.from, 'storage'); station(j.to, 'drop');
        if (j.pallet !== null && typeof j.pallet !== 'string') errors.push('invalid pallet');
      } else if (j.kind === 'charge') station(j.charger, 'charger');
    }
    return errors;
  }

  prepareState(value: unknown, resolveOrders = true): PreparedFleetDispatcher {
    const errors = this.validateState(value, resolveOrders);
    if (errors.length) throw new Error(errors.join('; '));
    const s = structuredClone(value) as DispatcherState;
    return { reservations: this.reservations.prepareState(s.reservations), chargerQueue: s.chargerQueue,
      storage: s.storage.map(g => ({ group: this.storage(g.id), state: this.storage(g.id).prepareState(g.places) })),
      jobs: s.jobs, late: new Set(s.late) };
  }

  swapState(s: PreparedFleetDispatcher): void {
    // Resolve after fleet.orders has committed its new objects.
    const jobs = new Map<string, Job>();
    for (const j of s.jobs) {
      if (j.kind !== 'pick') jobs.set(j.vehicle, j);
      else {
        const order = j.order === null ? undefined : this.orders.orderById(j.order);
        if (j.order !== null && !order) throw new Error('fleet.dispatcher: unknown order id');
        jobs.set(j.vehicle, { ...j, order });
      }
    }
    this.reservations.swapState(s.reservations);
    this.chargerQueue.splice(0, this.chargerQueue.length, ...s.chargerQueue);
    for (const g of s.storage) g.group.swapState(g.state);
    this.jobs = jobs; this.late = s.late;
  }

  reset(): void {
    for (const group of this.groups.values()) group.reset();
    this.chargerQueue.length = 0;
    this.orders.reset(); this.reservations.reset(); this.jobs.clear(); this.late.clear();
  }

  station(id: StationId): FleetStation {
    const s = this.stations.get(id);
    if (!s) throw new Error(`Fleet: unknown station ${id}`);
    return s;
  }

  storage(group: string): StorageGroup {
    const s = this.groups.get(group);
    if (!s) throw new Error(`Fleet: unknown storage group ${group}`);
    return s;
  }

  jobOf(vehicle: string): Job | null { return this.jobs.get(vehicle) ?? null; }

  reservedBy(station: StationId): string | null {
    return this.reservations.ownerOf(station) ?? this.groupOfPlace.get(station)?.place(station).reservedBy ?? null;
  }

  waitingSources(): StationId[] {
    return this.picks.filter((p) => this.orders.openOf(p.id)?.state === 'pending'
      && this.reservations.ownerOf(p.id) === null).map((p) => p.id);
  }

  orderReady(source: StationId, t: number, mu: string | null): void {
    this.orders.offer(source, mu, t);
  }

  picked(vehicle: string, t: number): void {
    const j = this.jobs.get(vehicle);
    if (!j || (j.kind !== 'pick' && j.kind !== 'retrieve') || j.loaded) return;
    j.loaded = true;
    if (j.kind === 'pick') {
      if (j.order) this.orders.markPicked(j.order, t);
      this.reservations.release(j.from, vehicle);
    } else j.pallet = this.groupOfPlace.get(j.from)!.commitRetrieve(j.from, t);
  }

  delivered(vehicle: string, t: number): void {
    const j = this.jobs.get(vehicle);
    if (!j || (j.kind !== 'pick' && j.kind !== 'retrieve') || !j.loaded) return;
    if (j.kind === 'pick' && j.to.kind === 'buffer') this.groupOfPlace.get(j.to.station)!.commitStore(j.to.station, j.pallet, t);
    else this.reservations.release(j.kind === 'pick' ? j.to.station : j.to, vehicle);
    if (j.kind === 'pick' && j.order) this.orders.complete(j.order, t);
    this.jobs.delete(vehicle);
  }

  chargeDone(vehicle: string): void {
    const j = this.jobs.get(vehicle);
    if (!j || j.kind !== 'charge') return;
    this.reservations.release(j.charger, vehicle);
    this.jobs.delete(vehicle);
  }

  /**
   * A foreign task took `vehicle` (plan-559 SOL #8): its job ends without
   * completion. A pick not yet loaded goes back to the pool (pending, destination
   * open) — 'requeued'; a loaded pick / retrieve fails (the MU stays on the
   * vehicle) — 'failed'; anything else only frees its reservations — 'released'.
   * Null when the vehicle had no job.
   */
  abandon(vehicle: string, t: number): 'requeued' | 'failed' | 'released' | null {
    const j = this.jobs.get(vehicle);
    if (!j) return null;
    this.jobs.delete(vehicle);
    const q = this.chargerQueue.indexOf(vehicle);
    if (q >= 0) this.chargerQueue.splice(q, 1);
    if (j.kind === 'pick') {
      this.reservations.release(j.from, vehicle);
      if (j.to.kind === 'drop') this.reservations.release(j.to.station, vehicle);
      else this.groupOfPlace.get(j.to.station)?.cancelAllOf(vehicle);
      if (j.loaded) { if (j.order) this.orders.fail(j.order, t); return 'failed'; }
      if (j.order) { this.orders.requeue(j.order); return 'requeued'; }
      return 'released';
    }
    if (j.kind === 'retrieve') {
      this.reservations.release(j.to, vehicle);
      if (!j.loaded) this.groupOfPlace.get(j.from)?.cancelAllOf(vehicle);
      return j.loaded ? 'failed' : 'released';
    }
    if (j.kind === 'charge') this.reservations.release(j.charger, vehicle);
    return 'released';
  }

  /** Returns only newly assigned jobs. All time comes from env.t. */
  dispatch(vehicles: readonly VehicleView[], env: DispatchEnv): Job[] {
    const battery = this.options.battery;
    const out: Job[] = [];
    const view = new Map(vehicles.map((v) => [v.id, v]));
    const assign = (j: Job): void => { this.jobs.set(j.vehicle, j); out.push(j); };

    // 1. The charger queue has precedence for every free charger (FIFO).
    for (const c of this.chargers) {
      if (this.reservations.ownerOf(c.id) !== null || this.chargerQueue.length === 0) continue;
      const vid = this.chargerQueue.shift()!;
      const v = view.get(vid);
      this.reservations.tryReserve('charger', c.id, vid, env.t);
      assign({ kind: 'charge', vehicle: vid, charger: c.id, untilSoc: battery.config.target, durationSec: v ? battery.chargeTimeSec(v.soc) : 0 });
    }

    const free = vehicles.filter((v) => { const j = this.jobs.get(v.id); return !j || j.kind === 'park'; }).slice().sort(byId);
    const available = new Set(free.map((v) => v.id));
    const rejected = new Set<string>();
    let openOrders = 0;

    const pick = (startPath: string, jobEnergy: (v: VehicleView) => { order: Consumption; toCharger: Consumption }): VehicleView | null => {
      let best: VehicleView | null = null;
      let bestD = Infinity;
      for (const v of free) {
        if (!available.has(v.id)) continue;
        const e = jobEnergy(v);
        if (!battery.canAccept(v.soc, e.order, e.toCharger)) { rejected.add(v.id); available.delete(v.id); continue; }
        const d = env.distanceM(v.at, startPath);
        if (d < bestD - 1e-9) { best = v; bestD = d; } // Id-sorted: ties keep the smallest id.
      }
      return best;
    };

    // 2a. Priority, creation time, then the configured tie rule (default: order id).
    for (const order of this.orders.pending(env.t, this.options.orderTieBreak)) {
      const o = this.station(order.source);
      if (o.role !== 'pick' || this.reservations.ownerOf(o.id) !== null) continue;
      const dest = this.chooseDestination(o, env);
      if (!dest) { openOrders++; continue; }
      const d = this.station(dest.station);
      const v = pick(o.pathId, (veh) => this.energyOf(veh.at, [o, d], dest.kind === 'drop', env));
      if (!v) { openOrders++; continue; }
      available.delete(v.id);
      this.reservations.tryReserve('station', o.id, v.id, env.t);
      if (dest.kind === 'drop') this.reservations.tryReserve('station', dest.station, v.id, env.t);
      else this.groupOfPlace.get(dest.station)!.reserveStore(v.id);
      order.destination = dest.station;
      this.orders.assign(order, v.id, env.t);
      // Event sources provide the MU; externally added orders may not know it yet.
      assign({ kind: 'pick', vehicle: v.id, from: o.id, to: dest, pallet: order.mu ?? '', loaded: false, order });
    }

    if (this.options.onLate) {
      for (const order of this.orders.overdue(env.t)) {
        if (this.late.has(order.id)) continue;
        this.late.add(order.id);
        this.options.onLate(order);
      }
    }

    // 2b. The project decides whether this round may retrieve stored units.
    this.retrievalContext.t = env.t;
    if (this.retrieval && this.retrieval(this.retrievalContext)) {
      for (const d of this.drops) {
        if (!this.inputAdmissible(d, env)) continue;
        // Use the drop's named group, otherwise the first group in config order.
        const group = d.storageGroup === undefined ? this.firstGroup : this.storage(d.storageGroup);
        const slot = group?.peekRetrieve();
        if (!slot) break;
        const s = this.station(slot.id);
        const v = pick(s.pathId, (veh) => this.energyOf(veh.at, [s, d], true, env));
        if (!v) { openOrders++; break; }
        available.delete(v.id);
        group!.reserveRetrieve(v.id);
        this.reservations.tryReserve('station', d.id, v.id, env.t);
        assign({ kind: 'retrieve', vehicle: v.id, from: s.id, to: d.id, pallet: null, loaded: false });
      }
    }

    // 3. Everyone still idle: charge, queue or park.
    for (const v of free) {
      if (!available.has(v.id) && !rejected.has(v.id)) continue;
      const mustCharge = rejected.has(v.id) || battery.needsCharge(v.soc);
      const opportunity = !mustCharge && openOrders === 0 && battery.wantsCharge(v.soc)
        && battery.chargeTimeSec(v.soc) >= OPPORTUNITY_MIN_SEC;
      if (mustCharge || opportunity) {
        const c = this.nearestFreeCharger(v.at, env);
        if (c) {
          this.reservations.tryReserve('charger', c.id, v.id, env.t);
          assign({ kind: 'charge', vehicle: v.id, charger: c.id, untilSoc: battery.config.target, durationSec: battery.chargeTimeSec(v.soc) });
          continue;
        }
        if (mustCharge) {
          if (!this.chargerQueue.includes(v.id)) this.chargerQueue.push(v.id);
          assign({ kind: 'queue', vehicle: v.id });
          continue;
        }
      }
      if (this.jobs.get(v.id)?.kind !== 'park') assign({ kind: 'park', vehicle: v.id });
    }
    return out;
  }

  private inputAdmissible(d: FleetStation, env: DispatchEnv): boolean {
    return this.reservations.ownerOf(d.id) === null && env.canReceive(d.id, env.t);
  }

  private chooseDestination(o: FleetStation, env: DispatchEnv): Destination | null {
    let best: FleetStation | null = null;
    let bestD = Infinity;
    for (const d of this.drops) {
      if (!this.inputAdmissible(d, env)) continue;
      const dist = env.distanceM(o.pathId, d.pathId);
      if (dist < bestD - 1e-9) { best = d; bestD = dist; }
    }
    if (best) return { kind: 'drop', station: best.id };
    const slot = o.storageGroup === undefined ? null : this.storage(o.storageGroup).peekStore();
    return slot ? { kind: 'buffer', station: slot.id } : null;
  }

  private nearestCharger(fromPath: string, env: DispatchEnv): { c: FleetStation; d: number } {
    let best = this.chargers[0];
    let bestD = Infinity;
    for (const c of this.chargers) {
      const d = env.distanceM(fromPath, c.pathId);
      if (d < bestD - 1e-9) { best = c; bestD = d; }
    }
    return { c: best, d: bestD };
  }

  private nearestFreeCharger(fromPath: string, env: DispatchEnv): FleetStation | null {
    let best: FleetStation | null = null;
    let bestD = Infinity;
    for (const c of this.chargers) {
      if (this.reservations.ownerOf(c.id) !== null) continue;
      const d = env.distanceM(fromPath, c.pathId);
      if (d < bestD - 1e-9) { best = c; bestD = d; }
    }
    return best;
  }

  private energyOf(at: string, path: readonly [FleetStation, FleetStation], includePause: boolean, env: DispatchEnv): {
    order: Consumption; toCharger: Consumption;
  } {
    const [a, b] = path;
    const travelM = env.distanceM(at, a.pathId) + env.distanceM(a.pathId, b.pathId);
    const order = this.options.consumption.order(travelM, a, b, includePause);
    const { c, d } = this.nearestCharger(b.pathId, env);
    return { order, toCharger: this.options.consumption.toCharger(d, c) };
  }
}

type JobState = Exclude<Job, { kind: 'pick' }> | (Omit<Extract<Job, { kind: 'pick' }>, 'order'> & { order: number | null });
export interface DispatcherState {
  reservations: ReturnType<ReservationTable['exportState']>;
  chargerQueue: string[];
  storage: { id: string; places: ReturnType<StorageGroup['exportState']> }[];
  jobs: JobState[];
  late: number[];
}
export interface PreparedFleetDispatcher {
  reservations: ReturnType<ReservationTable['prepareState']>;
  chargerQueue: string[];
  storage: { group: StorageGroup; state: ReturnType<StorageGroup['prepareState']> }[];
  jobs: JobState[];
  late: Set<number>;
}
