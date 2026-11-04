// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-feature-load-state.ts — what the FeatureLoader knows about each feature,
 * as a subscribable store (plan-652).
 *
 * Same shape as `rv-plugin-binding-state.ts`: React-free, a stable snapshot
 * identity between changes (so `useSyncExternalStore` does not loop), and the
 * hook lives in the UI layer, not here. One store per loader instance, because
 * tests and the embed viewer build their own viewers.
 */

/** When a feature's code is loaded. `startup` = registered eagerly at boot. */
export type FeatureTrigger =
  | `mode:${string}`
  | `component:${string}`
  | `command:${string}`
  | 'startup'
  | 'intent'
  | 'idle';

/** Lifecycle of one feature: declared (known, not loaded) → loading → active | failed. */
export type FeatureState = 'declared' | 'loading' | 'active' | 'failed';

/** What the loader publishes about one feature. */
export interface FeatureStatus {
  readonly id: string;
  readonly label: string;
  readonly state: FeatureState;
  /** The activation triggers of the manifest (`['startup']` for an eager feature). */
  readonly activation: readonly FeatureTrigger[];
  /** The trigger that started the last load. */
  readonly trigger?: FeatureTrigger;
  /** `performance.now()` when the last load started. */
  readonly startedAt?: number;
  /** Duration of the last load in ms (set once it settled). */
  readonly ms?: number;
  /** Chunk bytes from `feature-chunks.json`, null when unknown. */
  readonly bytes?: number | null;
  /** Message of the last failure. */
  readonly error?: string;
  /** Plugin origin of an on-demand feature (from its stub) — the feature matrix shows it before activation. */
  readonly origin?: string;
}

//! A tiny keyed store with stable snapshots — one row per feature, in definition order.
export class FeatureLoadState {
  private readonly _rows = new Map<string, FeatureStatus>();
  private readonly _listeners = new Set<() => void>();
  private _snapshot: readonly FeatureStatus[] = [];

  //! Returns the row of one feature, or undefined.
  get(id: string): FeatureStatus | undefined {
    return this._rows.get(id);
  }

  //! Merges fields into a row (creating it) and notifies subscribers.
  patch(id: string, fields: Partial<FeatureStatus> & { label?: string }): FeatureStatus {
    const prev = this._rows.get(id);
    const next: FeatureStatus = {
      id,
      label: prev?.label ?? id,
      state: prev?.state ?? 'declared',
      activation: prev?.activation ?? ['startup'],
      ...prev,
      ...fields,
    };
    this._rows.set(id, next);
    this._snapshot = [...this._rows.values()];
    for (const l of this._listeners) {
      try { l(); } catch { /* a subscriber must never break the loader */ }
    }
    return next;
  }

  //! Returns all rows; the array identity is stable until the next change.
  snapshot(): readonly FeatureStatus[] {
    return this._snapshot;
  }

  //! Subscribes to changes; returns the unsubscribe function.
  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  }
}
