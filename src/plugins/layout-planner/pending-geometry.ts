// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * pending-geometry.ts — runtime bookkeeping for *pending placements*.
 *
 * A **pending placement** (plan-371) is a fully committed placement whose root
 * still carries placeholder geometry while its GLB decodes. It is a pure
 * RUNTIME state: `PlacedComponent` already carries `glbUrl` from the first
 * frame, so the store entry of a pending placement is byte-identical to that of
 * a finished one. Nothing here is ever serialized.
 *
 * The registry exists for exactly one reason — to stop a late-arriving load
 * from resurrecting a placement that was meanwhile deleted, undone, cancelled
 * or retried (the "zombie swap"). Every load carries a monotonically increasing
 * generation token; `isCurrent()` validates BOTH the token AND that the
 * placement still exists in the planner's object map.
 *
 * ⚠ The `AbortController` handed out by {@link PendingGeometryRegistry.signalFor}
 * is CONSUMER-SIDE ONLY. It must never reach the shared blob fetch in
 * `RVAssetBlobCache` (which de-duplicates in-flight requests URL-wide) — the
 * abort of one deleted placement would otherwise kill the download of an
 * unrelated second placement of the same asset.
 */

import type { LibraryCatalogEntry } from './rv-layout-store';

export type PendingStatus = 'loading' | 'error';

export interface PendingLoad {
  /** Placement id — identical to the store entry's id. */
  readonly id: string;
  readonly entry: LibraryCatalogEntry;
  /** Monotonically increasing per id. A swap only applies while the token matches. */
  generation: number;
  status: PendingStatus;
  error?: string;
  /** Aborts only THIS consumer, never the shared fetch/decode. */
  abort?: AbortController;
}

/** Wiring the registry needs from its host (the layout planner). */
export interface PendingGeometryDeps {
  /** True while the placement still exists in the planner's object map. */
  hasPlacement(id: string): boolean;
  /** Restart a load after {@link PendingGeometryRegistry.retry}. Optional —
   *  without it, `retry()` only bumps the generation. */
  onRetry?(load: PendingLoad): void;
  /** Notified whenever the pending set or a status changes (HMI status line). */
  onChange?(): void;
}

/**
 * Registry of all in-flight placeholder → geometry swaps.
 *
 * There is at most one entry per placement id. Entries are removed on success
 * ({@link cancel}), on any deletion path, and on teardown ({@link cancelAll});
 * a failed load deliberately STAYS (status `'error'`) so the placeholder can be
 * retried or removed by the user.
 */
export class PendingGeometryRegistry {
  private _loads = new Map<string, PendingLoad>();
  private _ids = new Set<string>();
  private _deps: PendingGeometryDeps;

  constructor(deps: PendingGeometryDeps) {
    this._deps = deps;
  }

  /**
   * Start (or restart) tracking a load for `id` and return its generation
   * token. Restarting an already-tracked id bumps the generation, which
   * invalidates any earlier in-flight result for the same placement.
   */
  begin(id: string, entry: LibraryCatalogEntry): number {
    const existing = this._loads.get(id);
    const generation = (existing?.generation ?? 0) + 1;
    // The previous consumer must stop caring about its result.
    existing?.abort?.abort();
    this._loads.set(id, {
      id,
      entry,
      generation,
      status: 'loading',
      abort: new AbortController(),
    });
    this._ids.add(id);
    this._deps.onChange?.();
    return generation;
  }

  /** The abort signal of the currently tracked load for `id` (or undefined). */
  signalFor(id: string): AbortSignal | undefined {
    return this._loads.get(id)?.abort?.signal;
  }

  /**
   * Whether a result produced under `generation` may still be applied.
   * Checks the token AND the placement's continued existence — deletion paths
   * that never learned about this registry are covered by the second half.
   */
  isCurrent(id: string, generation: number): boolean {
    const load = this._loads.get(id);
    if (!load || load.generation !== generation) return false;
    return this._deps.hasPlacement(id);
  }

  /** Mark a load failed. The entry STAYS so the user can retry or remove it. */
  fail(id: string, message: string): void {
    const load = this._loads.get(id);
    if (!load) return;
    load.status = 'error';
    load.error = message;
    this._deps.onChange?.();
  }

  /**
   * Retry a failed load: a new generation (so a late result of the failed
   * attempt is discarded) and NO new undo entry — the placement itself was
   * never rolled back.
   */
  retry(id: string): void {
    const previous = this._loads.get(id);
    if (!previous) return;
    this.begin(id, previous.entry);
    const restarted = this._loads.get(id);
    if (restarted) this._deps.onRetry?.(restarted);
  }

  /** Status of a single entry; `undefined` when not pending (i.e. done). */
  statusOf(id: string): PendingStatus | undefined {
    return this._loads.get(id)?.status;
  }

  /** The tracked entry for `id`, or undefined. */
  get(id: string): PendingLoad | undefined {
    return this._loads.get(id);
  }

  /**
   * Every tracked load, in insertion order. Feeds the HMI status line, which
   * needs the entry NAME and the status per placement, not just the id set.
   */
  list(): PendingLoad[] {
    return [...this._loads.values()];
  }

  /** Stop tracking one placement (success, deletion, undo, drag cancel). */
  cancel(id: string): void {
    const load = this._loads.get(id);
    if (!load) return;
    load.abort?.abort();
    this._loads.delete(id);
    this._ids.delete(id);
    this._deps.onChange?.();
  }

  /** Stop tracking everything — plugin teardown, model change, scene reload. */
  cancelAll(): void {
    if (this._loads.size === 0) return;
    for (const load of this._loads.values()) load.abort?.abort();
    this._loads.clear();
    this._ids.clear();
    this._deps.onChange?.();
  }

  /** Ids with an in-flight or failed load. Live view — do not mutate. */
  get pendingIds(): ReadonlySet<string> {
    return this._ids;
  }

  get size(): number {
    return this._loads.size;
  }
}
