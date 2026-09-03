// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * model-load-progress-store — the model load's progress as subscribable state.
 *
 * The loading splash in `main.ts` owns the DOM overlay and always has; this
 * store is the same facts published a second way, so React surfaces that stay
 * OPEN during a load — the projects dashboard's hero band since plan-716's
 * open-in-place flow — can show the progress the splash is showing behind
 * them (the splash sits at z-index 1000, the dashboard at 10500).
 *
 * Written exclusively by the splash functions in `main.ts`; everything else
 * only reads. One writer is what keeps the two presentations from disagreeing.
 */

export interface ModelLoadProgressSnapshot {
  /** A load is running (splash visible or covered). */
  active: boolean;
  /** Display name of what is loading. */
  label: string;
  /** Downloaded bytes; 0 until the first progress event. */
  loaded: number;
  /** Total bytes, or 0 when the server reports none (indeterminate). */
  total: number;
  /** Bytes are in — GLB parse + scene construction, no byte progress. */
  preparing: boolean;
}

const IDLE: ModelLoadProgressSnapshot = {
  active: false, label: '', loaded: 0, total: 0, preparing: false,
};

let _snapshot: ModelLoadProgressSnapshot = IDLE;
const _listeners = new Set<() => void>();

function publish(next: Partial<ModelLoadProgressSnapshot>): void {
  _snapshot = { ..._snapshot, ...next };
  for (const l of _listeners) {
    try { l(); } catch { /* a subscriber must never break the load */ }
  }
}

export function subscribeModelLoadProgress(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

/** Stable snapshot for `useSyncExternalStore` — same object until a change. */
export function getModelLoadProgressSnapshot(): ModelLoadProgressSnapshot {
  return _snapshot;
}

export function reportModelLoadStart(label: string): void {
  publish({ active: true, label, loaded: 0, total: 0, preparing: false });
}

export function reportModelLoadProgress(loaded: number, total: number): void {
  publish({ loaded, total, preparing: false });
}

export function reportModelLoadPreparing(): void {
  publish({ preparing: true });
}

export function reportModelLoadEnd(): void {
  publish({ ...IDLE });
}
