// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

export type StationId = string;
export type StationRole = 'pick' | 'drop' | 'storage' | 'charger';

export interface FleetStation {
  readonly id: StationId;
  readonly role: StationRole;
  readonly pathId: string;
  /** Storage group; for picks, the fallback group when no drop is free. */
  readonly storageGroup?: string;
  /** Reverse run length of the stub (m). */
  readonly approachM: number;
  /** Fork height at which the fork touches the load (mm). */
  readonly handlingHeightMm: number;
}

export type OrderState = 'pending' | 'assigned' | 'picking' | 'carrying' | 'dropping'
  | 'done' | 'failed' | 'cancelled';

export interface TransportOrder {
  readonly id: number;
  readonly source: StationId;
  destination: StationId | null;
  readonly priority: number;
  readonly earliest: number | null;
  readonly latest: number | null;
  readonly mu: string | null;
  readonly payload?: unknown;
  state: OrderState;
  vehicle: string | null;
  readonly times: { created: number; assigned?: number; picked?: number; done?: number };
}

/** Detached order data; payload JSON validation belongs to the snapshot contract. */
export interface TransportOrderData extends TransportOrder {}
export interface OrderPoolState {
  nextId: number;
  completed: number;
  open: TransportOrderData[];
  bySource: Array<{ source: string; orderIds: number[] }>;
}
declare const preparedOrderPoolBrand: unique symbol;
export interface PreparedOrderPool {
  readonly [preparedOrderPoolBrand]: true;
}
interface OrderPoolContainers {
  nextId: number; completed: number;
  open: Map<number, TransportOrder>;
  bySource: Map<string, TransportOrder[]>;
}
const preparedOrderPools = new WeakMap<PreparedOrderPool, OrderPoolContainers>();

export class OrderPool {
  private nextId = 1;
  private completed = 0;
  get doneCount(): number { return this.completed; }
  get pendingCount(): number {
    let count = 0;
    for (const order of this.open.values()) if (order.state === 'pending') count++;
    return count;
  }
  private open = new Map<number, TransportOrder>();
  private bySource = new Map<StationId, TransportOrder[]>();
  private readonly completionListeners = new Set<(order: TransportOrder, now: number) => void>();

  exportState(): OrderPoolState {
    return { nextId: this.nextId, completed: this.completed,
      open: [...this.open.values()].map(order => {
        if (Object.hasOwn(order, 'payload') && order.payload === undefined) {
          throw new Error('orders: payload must not be undefined');
        }
        // Own copy of the record. A payload stays the LIVE reference on purpose: the snapshot contract inspects
        // prototypes, getters and shared identities on the original, then copies it (cloning here would hide them).
        return { ...order, times: { ...order.times } };
      }),
      bySource: [...this.bySource].map(([source, orders]) => ({ source, orderIds: orders.map(o => o.id) })) };
  }

  static validateState(state: unknown, opts?: { stationKnown?(id: string): boolean }): string[] {
    const errors: string[] = [];
    const record = (v: unknown, required: string[], optional: string[], path: string): v is Record<string, unknown> => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push(`${path}: expected object`); return false; }
      for (const k of required) if (!Object.hasOwn(v, k)) errors.push(`${path}.${k}: required`);
      for (const k of Object.keys(v)) if (!required.includes(k) && !optional.includes(k)) errors.push(`${path}.${k}: unknown field`);
      return true;
    };
    const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    const id = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
    const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
    if (!record(state, ['nextId', 'completed', 'open', 'bySource'], [], 'orders')) return errors;
    if (!id(state.nextId)) errors.push('nextId: expected positive safe integer');
    if (!Number.isSafeInteger(state.completed) || (state.completed as number) < 0) errors.push('completed: expected non-negative safe integer');
    const orders = new Map<number, TransportOrderData>();
    if (!Array.isArray(state.open)) errors.push('open: expected array');
    else for (const [i, o] of state.open.entries()) {
      const path = `open[${i}]`;
      if (!record(o, ['id', 'source', 'destination', 'priority', 'earliest', 'latest', 'mu', 'state', 'vehicle', 'times'], ['payload'], path)) continue;
      if (!id(o.id) || orders.has(o.id)) errors.push(`${path}.id: invalid or duplicate ID`);
      else orders.set(o.id, o as unknown as TransportOrderData);
      if (!text(o.source)) errors.push(`${path}.source: expected ID`);
      for (const k of ['destination', 'mu', 'vehicle']) if (o[k] !== null && !text(o[k])) errors.push(`${path}.${k}: expected ID or null`);
      for (const k of ['priority', 'earliest', 'latest']) if (!(k !== 'priority' && o[k] === null) && !finite(o[k])) errors.push(`${path}.${k}: expected finite number`);
      if (!['pending', 'assigned', 'picking', 'carrying', 'dropping', 'done', 'failed', 'cancelled'].includes(o.state as string)) errors.push(`${path}.state: invalid state`);
      if (record(o.times, ['created'], ['assigned', 'picked', 'done'], `${path}.times`)) {
        for (const k of Object.keys(o.times)) if (!finite(o.times[k])) errors.push(`${path}.times.${k}: expected finite number`);
      }
      if (opts?.stationKnown) for (const k of ['source', 'destination']) {
        if (typeof o[k] === 'string' && !opts.stationKnown(o[k])) errors.push(`${path}.${k}: unknown station`);
      }
    }
    for (const n of orders.keys()) if ((state.nextId as number) <= n) errors.push('nextId: must exceed every order ID');
    const sources = new Set<string>(), refs = new Set<number>();
    if (!Array.isArray(state.bySource)) errors.push('bySource: expected array');
    else for (const [i, entry] of state.bySource.entries()) {
      const path = `bySource[${i}]`;
      if (!record(entry, ['source', 'orderIds'], [], path)) continue;
      if (!text(entry.source) || sources.has(entry.source)) errors.push(`${path}.source: invalid or duplicate source`);
      else sources.add(entry.source);
      if (!Array.isArray(entry.orderIds) || !entry.orderIds.length) { errors.push(`${path}.orderIds: expected non-empty array`); continue; }
      for (const n of entry.orderIds) {
        const o = orders.get(n);
        if (!id(n) || refs.has(n) || !o || o.source !== entry.source || !['pending', 'assigned'].includes(o.state)) errors.push(`${path}.orderIds: invalid order reference`);
        refs.add(n);
      }
    }
    for (const o of orders.values()) if (['pending', 'assigned'].includes(o.state) && !refs.has(o.id)) errors.push(`order ${o.id}: missing bySource link`);
    return errors;
  }

  prepareState(state: unknown, opts?: { stationKnown?(id: string): boolean }): PreparedOrderPool {
    const errors = OrderPool.validateState(state, opts);
    if (errors.length) throw new Error(errors.join('; '));
    const data = state as OrderPoolState;
    const open = new Map(data.open.map(o => [o.id, structuredClone(o)]));
    const prepared = Object.freeze({}) as PreparedOrderPool;
    preparedOrderPools.set(prepared, { nextId: data.nextId, completed: data.completed, open,
      bySource: new Map(data.bySource.map(s => [s.source, s.orderIds.map(id => open.get(id)!)])) });
    return prepared;
  }

  swapState(prepared: PreparedOrderPool): void {
    const state = preparedOrderPools.get(prepared)!;
    this.open = state.open;
    this.bySource = state.bySource;
    this.nextId = state.nextId;
    this.completed = state.completed;
  }

  /** Additive hook for observers (KPIs), never for behaviour. Owners unsubscribe; reset keeps listeners. */
  onComplete(listener: (order: TransportOrder, now: number) => void): () => void {
    this.completionListeners.add(listener);
    return () => { this.completionListeners.delete(listener); };
  }

  add(input: {
    source: StationId; mu?: string | null; destination?: StationId | null;
    priority?: number; earliest?: number | null; latest?: number | null;
  }, now: number): TransportOrder {
    const order: TransportOrder = {
      id: this.nextId++, source: input.source, mu: input.mu ?? null,
      destination: input.destination ?? null, priority: input.priority ?? 0,
      earliest: input.earliest ?? null, latest: input.latest ?? null,
      state: 'pending', vehicle: null, times: { created: now },
    };
    this.open.set(order.id, order);
    const sourceOrders = this.bySource.get(order.source);
    if (sourceOrders) sourceOrders.push(order);
    else this.bySource.set(order.source, [order]);
    return order;
  }

  offer(source: StationId, mu: string | null, now: number): TransportOrder | null {
    return this.openOf(source) ? null : this.add({ source, mu }, now);
  }

  orderById(id: number): TransportOrder | undefined { return this.open.get(id); }

  openOf(source: StationId): TransportOrder | null {
    const orders = this.bySource.get(source);
    if (!orders) return null;
    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      if (order.state === 'pending' || order.state === 'assigned') return order;
    }
    return null;
  }

  pending(now: number, tieBreak?: (a: TransportOrder, b: TransportOrder) => number): TransportOrder[] {
    const out: TransportOrder[] = [];
    for (const order of this.open.values()) {
      if (order.state === 'pending' && (order.earliest === null || order.earliest <= now)) out.push(order);
    }
    return out.sort((a, b) => b.priority - a.priority || a.times.created - b.times.created
      || (tieBreak ? tieBreak(a, b) : a.id - b.id));
  }

  overdue(now: number): TransportOrder[] {
    const out: TransportOrder[] = [];
    for (const order of this.open.values()) {
      if (order.latest !== null && order.latest < now) out.push(order);
    }
    return out;
  }

  assign(order: TransportOrder, vehicle: string, now: number): void {
    order.state = 'assigned'; order.vehicle = vehicle; order.times.assigned = now;
  }

  markPicked(order: TransportOrder, now: number): void {
    order.state = 'carrying'; order.times.picked = now;
    this.removeFromSource(order);
  }

  complete(order: TransportOrder, now: number): void {
    if (this.open.has(order.id)) this.completed++;
    order.state = 'done'; order.times.done = now; this.open.delete(order.id);
    this.removeFromSource(order);
    for (const listener of this.completionListeners) {
      try { listener(order, now); }
      catch (err) { console.warn('[OrderPool] completion listener failed', err); }
    }
  }

  cancel(order: TransportOrder): void {
    order.state = 'cancelled'; this.open.delete(order.id);
    this.removeFromSource(order);
  }

  /** An assigned order whose vehicle was taken by a foreign task (plan-559 SOL #8): pending again, destination open. */
  requeue(order: TransportOrder): void {
    order.state = 'pending'; order.vehicle = null; order.destination = null;
  }

  /** An order that cannot complete (its vehicle was taken while carrying, SOL #8). */
  fail(order: TransportOrder, now: number): void {
    order.state = 'failed'; order.times.done = now; this.open.delete(order.id);
    this.removeFromSource(order);
  }

  reset(): void { this.open.clear(); this.bySource.clear(); this.nextId = 1; this.completed = 0; }

  private removeFromSource(order: TransportOrder): void {
    const orders = this.bySource.get(order.source);
    if (!orders) return;
    const index = orders.indexOf(order);
    if (index < 0) return;
    // Preserve creation order without allocating a splice result on pickup.
    for (let i = index; i < orders.length - 1; i++) orders[i] = orders[i + 1];
    orders.pop();
    if (orders.length === 0) this.bySource.delete(order.source);
  }
}
