// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * des-restore-guard.ts — the "a DES snapshot restore is in progress" bracket
 * (plan-645 L7).
 *
 * A restore writes signal values (and swaps the event queue) in several steps.
 * A behaviour that reacts to a signal edge synchronously — the Conveyor's
 * `Flow.Run` wake — must not act in the middle of it: it would hand over MU
 * objects of the run being replaced, and the events it schedules would be wiped
 * by the queue swap. The private DES runner brackets its whole restore with
 * {@link beginDesRestore} / {@link endDesRestore}; a reaction that arrives in
 * between is deferred with {@link deferUntilDesRestored} and runs ONCE after
 * the restore (in registration order, deduplicated per key). Outside a restore
 * the deferred function runs at once.
 *
 * Process-wide on purpose: a restore is synchronous and at most one runs at a
 * time; the bracket is re-entrant (a nested begin/end only counts).
 */

let depth = 0;
const deferred = new Map<unknown, () => void>();

/** True while a DES snapshot restore is running. */
export function isDesRestoring(): boolean {
  return depth > 0;
}

/** Open the restore bracket (private DES runner only). */
export function beginDesRestore(): void {
  depth++;
}

/**
 * Close the restore bracket; on the outermost close every deferred reaction
 * runs once (errors are logged, the others still run).
 */
export function endDesRestore(): void {
  if (depth === 0) return;
  depth--;
  if (depth > 0 || deferred.size === 0) return;
  const run = [...deferred.values()];
  deferred.clear();
  for (const fn of run) {
    try { fn(); } catch (e) { console.error('[des-restore-guard] deferred reaction threw:', e); }
  }
}

/**
 * Run `fn` now, or — during a restore — once after it. `key` deduplicates: a
 * second deferral with the same key replaces the first (one catch-up per key).
 */
export function deferUntilDesRestored(key: unknown, fn: () => void): void {
  if (depth === 0) { fn(); return; }
  deferred.set(key, fn);
}

/** Transaction bridge: take reactions without running or swallowing failures. */
export function finishDesRestore(success: boolean): Array<() => void> {
  if (depth > 0) depth--;
  if (depth > 0) return [];
  const pending = success ? [...deferred.values()] : [];
  deferred.clear();
  return pending;
}
