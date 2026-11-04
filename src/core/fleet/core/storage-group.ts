// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { exportNumber, importNumber, validNumber, type StateNumber } from './source-state';

/**
 * storage-group.ts — a group of single-deep storage places (plan-559 §2.1,
 * generalised from the plan-612 floor buffer). Pure bookkeeping: occupancy,
 * FIFO by storage time, per-place reservation. No Three/DOM.
 *
 * Any set of stations can form a group (`TransferStation.Group`, e.g.
 * `Buffer`); the places are the station ids in configuration order.
 *
 * Choice rules (deterministic, identical to plan-612):
 *  - store into the free, unreserved place that has been free the LONGEST
 *    (tie → configuration order; places start free at −Infinity);
 *  - retrieve the unit stored EARLIEST (FIFO; tie → configuration order) that
 *    is not already reserved.
 */

/** State of one storage place. */
export interface StoragePlace {
  readonly id: string;
  /** Unit (MU id) on the place, or null. */
  unit: string | null;
  /** When the current unit was stored (sim-s). */
  storedAt: number;
  /** When the place became free (sim-s); places start free at −Infinity. */
  freedAt: number;
  /** Vehicle that will store into / retrieve from this place, or null. */
  reservedBy: string | null;
}

/** A storage group over a fixed list of places. */
export class StorageGroup {
  places: readonly StoragePlace[];
  private byId = new Map<string, StoragePlace>();

  constructor(readonly id: string, placeIds: readonly string[]) {
    const places: StoragePlace[] = [];
    for (const pid of placeIds) {
      if (this.byId.has(pid)) throw new Error(`StorageGroup ${id}: duplicate place ${pid}`);
      const p: StoragePlace = { id: pid, unit: null, storedAt: 0, freedAt: -Infinity, reservedBy: null };
      places.push(p);
      this.byId.set(pid, p);
    }
    this.places = places;
  }

  exportState(): StoragePlaceState[] {
    return this.places.map(p => ({ ...p, freedAt: exportNumber(p.freedAt), storedAt: exportNumber(p.storedAt) }));
  }

  validateState(state: unknown): string[] {
    if (!Array.isArray(state) || state.length !== this.places.length) return ['storage: place count mismatch'];
    return state.flatMap((p, i) => !p || typeof p !== 'object'
      || Object.keys(p).sort().join(',') !== 'freedAt,id,reservedBy,storedAt,unit'
      || p.id !== this.places[i].id || !(p.unit === null || typeof p.unit === 'string')
      || !(p.reservedBy === null || typeof p.reservedBy === 'string')
      || !validNumber(p.freedAt) || !validNumber(p.storedAt) ? ['storage: invalid or unknown place'] : []);
  }

  prepareState(state: unknown): { places: StoragePlace[]; byId: Map<string, StoragePlace> } {
    const errors = this.validateState(state);
    if (errors.length) throw new Error(errors.join('; '));
    const places = (state as StoragePlaceState[]).map(p => ({ ...p,
      freedAt: importNumber(p.freedAt), storedAt: importNumber(p.storedAt) }));
    return { places, byId: new Map(places.map(p => [p.id, p])) };
  }

  swapState(state: ReturnType<StorageGroup['prepareState']>): void {
    this.places = state.places; this.byId = state.byId;
  }

  /** Back to empty (reset / new run). */
  reset(): void {
    for (const p of this.places) { p.unit = null; p.storedAt = 0; p.freedAt = -Infinity; p.reservedBy = null; }
  }

  /** True when `placeId` belongs to this group. */
  has(placeId: string): boolean {
    return this.byId.has(placeId);
  }

  place(placeId: string): StoragePlace {
    const p = this.byId.get(placeId);
    if (!p) throw new Error(`StorageGroup ${this.id}: unknown place ${placeId}`);
    return p;
  }

  /** Units in the group. */
  occupancy(): number {
    let n = 0;
    for (const p of this.places) if (p.unit !== null) n++;
    return n;
  }

  /** No free, unreserved place left. */
  isFull(): boolean {
    return this.peekStore() === null;
  }

  /** The place a store would go to (no reservation made). */
  peekStore(): StoragePlace | null {
    let best: StoragePlace | null = null;
    for (const p of this.places) {
      if (p.unit !== null || p.reservedBy !== null) continue;
      if (!best || p.freedAt < best.freedAt) best = p;
    }
    return best;
  }

  /** Reserve the {@link peekStore} place for `vehicleId`; null when full. */
  reserveStore(vehicleId: string): string | null {
    const p = this.peekStore();
    if (!p) return null;
    p.reservedBy = vehicleId;
    return p.id;
  }

  /** The place a retrieval would take from (FIFO, no reservation made). */
  peekRetrieve(): StoragePlace | null {
    let best: StoragePlace | null = null;
    for (const p of this.places) {
      if (p.unit === null || p.reservedBy !== null) continue;
      if (!best || p.storedAt < best.storedAt) best = p;
    }
    return best;
  }

  /** Reserve the oldest unit for retrieval by `vehicleId`; null when none. */
  reserveRetrieve(vehicleId: string): string | null {
    const p = this.peekRetrieve();
    if (!p) return null;
    p.reservedBy = vehicleId;
    return p.id;
  }

  /** The unit has been put down on `placeId` at sim time `t`. */
  commitStore(placeId: string, unit: string, t: number): void {
    const p = this.place(placeId);
    if (p.unit !== null) throw new Error(`StorageGroup ${this.id}: place ${placeId} is occupied`);
    p.unit = unit;
    p.storedAt = t;
    p.reservedBy = null;
  }

  /** The unit has been taken from `placeId` at sim time `t`; returns it. */
  commitRetrieve(placeId: string, t: number): string {
    const p = this.place(placeId);
    if (p.unit === null) throw new Error(`StorageGroup ${this.id}: place ${placeId} is empty`);
    const u = p.unit;
    p.unit = null;
    p.freedAt = t;
    p.reservedBy = null;
    return u;
  }

  /** Drop a reservation that will not be carried out. */
  cancel(placeId: string): void {
    this.place(placeId).reservedBy = null;
  }

  /** Drop every reservation held by `vehicleId` (order aborted / reset of one vehicle). */
  cancelAllOf(vehicleId: string): void {
    for (const p of this.places) if (p.reservedBy === vehicleId) p.reservedBy = null;
  }
}

export type StoragePlaceState = Omit<StoragePlace, 'freedAt' | 'storedAt'> & { freedAt: StateNumber; storedAt: StateNumber };
