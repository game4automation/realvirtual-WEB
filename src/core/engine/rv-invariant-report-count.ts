// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * The report counter of the DEV-only invariant layer (plan-615 F5: the dev
 * toolbar's status line), split out of the layer itself.
 *
 * Why a module of its own: the layer must be referenced ONLY by the viewer,
 * and only behind `import.meta.env.DEV`, so the bundler can drop it from a
 * production build (plan-600 test 9.10). The dev toolbar renders outside that
 * guard, so it reads this counter instead of importing the layer. In a
 * production build nothing ever calls {@link noteInvariantReport}, the count
 * stays 0 and this module is a few bytes.
 */

let reportCount = 0;
const reportListeners = new Set<() => void>();

/** How many invariant violations this page has reported so far. */
export function getInvariantReportCount(): number {
  return reportCount;
}

/** Subscribe to new reports (useSyncExternalStore compatible). */
export function subscribeInvariantReports(listener: () => void): () => void {
  reportListeners.add(listener);
  return () => { reportListeners.delete(listener); };
}

/** Counts one reported violation and notifies the subscribers. Called by the layer only. */
export function noteInvariantReport(): void {
  reportCount++;
  for (const listener of reportListeners) {
    try { listener(); } catch { /* a status line must never break a checkpoint */ }
  }
}
