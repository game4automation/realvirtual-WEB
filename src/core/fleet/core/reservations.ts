// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { WaitEdge, WaitEdgeSource } from '../../diagnostics/rv-wait-registry';
/**
 * reservations.ts — reservations of stations, chargers and wait-point places
 * (plan-559 §2.3, F4). Pure bookkeeping, no Three/DOM.
 *
 * A reservation is set when an order is assigned and freed on completion,
 * abort or reset. One id has at most one owner; ids of all kinds share one
 * namespace (an id is an instance-unique node path, plan-559 `StationId`).
 *
 * Rules (deterministic):
 *  - `tryReserve` by a different owner while the id is held: rejected (`false`).
 *  - `tryReserve` by the SAME owner again: accepted, the reservation is kept
 *    unchanged (`since` is not moved) — idempotent re-dispatch.
 *  - `release(id, owner)` frees only when `owner` holds it.
 */

/** Kind of reserved resource. */
export type ReservationKind = 'station' | 'charger' | 'wait';

/** One held reservation (plan-559 §2.3). */
export interface Reservation { kind: ReservationKind; id: string; owner: string; since: number }

/** Reservation API of the fleet core (plan-559 §2.3). */
export interface Reservations {
  tryReserve(kind: Reservation['kind'], id: string, owner: string, now: number): boolean;
  release(id: string, owner: string): void;
  ownerOf(id: string): string | null;
  releaseAllOf(owner: string): void;
  reset(): void;
}

/** Map-backed {@link Reservations}. */
export class ReservationTable implements Reservations, WaitEdgeSource {
  readonly id = 'reservations';
  /** No pending reserver list exists. Empty waiterId denotes holder-only information;
   * analysed:false prevents these records from inventing wait cycles. */
  edges(_now: number): readonly WaitEdge[] {
    return [...this.byId.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      .map(r => ({ waiterId: '', resourceId: r.id, ownerIds: [r.owner], kind: 'reservation',
        sinceSimSec: r.since, analysed: false, nodePath: r.id }));
  }

  private byId = new Map<string, Reservation>();

  exportState(): Reservation[] { return [...this.byId.values()].map(r => ({ ...r })); }

  validateState(state: unknown): string[] {
    if (!Array.isArray(state)) return ['reservations: expected array'];
    const ids = new Set<string>();
    return state.flatMap(r => {
      if (!r || typeof r !== 'object' || Object.keys(r).sort().join(',') !== 'id,kind,owner,since'
        || !['station', 'charger', 'wait'].includes(r.kind) || typeof r.id !== 'string' || !r.id
        || typeof r.owner !== 'string' || !r.owner || !Number.isFinite(r.since) || ids.has(r.id))
        return ['reservations: invalid or duplicate reservation'];
      ids.add(r.id); return [];
    });
  }

  prepareState(state: unknown): Map<string, Reservation> {
    const errors = this.validateState(state);
    if (errors.length) throw new Error(errors.join('; '));
    return new Map((state as Reservation[]).map(r => [r.id, { ...r }]));
  }

  swapState(state: Map<string, Reservation>): void { this.byId = state; }

  /** Number of held reservations. */
  get size(): number {
    return this.byId.size;
  }

  tryReserve(kind: ReservationKind, id: string, owner: string, now: number): boolean {
    const held = this.byId.get(id);
    if (held) return held.owner === owner;
    this.byId.set(id, { kind, id, owner, since: now });
    return true;
  }

  release(id: string, owner: string): void {
    const held = this.byId.get(id);
    if (held && held.owner === owner) this.byId.delete(id);
  }

  ownerOf(id: string): string | null {
    return this.byId.get(id)?.owner ?? null;
  }

  /** The held reservation of `id` (read-only view), or null. */
  get(id: string): Readonly<Reservation> | null {
    return this.byId.get(id) ?? null;
  }

  releaseAllOf(owner: string): void {
    for (const [id, r] of this.byId) {
      if (r.owner === owner) this.byId.delete(id);
    }
  }

  /** Reservations held by `owner`, sorted by id (deterministic). */
  heldBy(owner: string): Reservation[] {
    const out: Reservation[] = [];
    for (const r of this.byId.values()) if (r.owner === owner) out.push({ ...r });
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }

  reset(): void {
    this.byId.clear();
  }
}
