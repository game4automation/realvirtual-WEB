// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * collision-alert-store — external store behind the collision cards in the
 * right-side messages panel (plan-394; card form replaced the original modal
 * on user decision 2026-08-07).
 *
 * The manager publishes the CURRENT pair list on every change — grow AND
 * shrink. There is no `open` flag and no acknowledgement round-trip anymore:
 * a collision card lives exactly as long as the geometry actually intersects,
 * the same lifecycle as the `ErrorStore` entries next to it. The store
 * publishes an **immutable snapshot with a version counter** —
 * `useSyncExternalStore` compares snapshots by identity, so every change must
 * arrive as a new object.
 */

import { useSyncExternalStore } from 'react';
import { createStore } from './create-store';

/** One reported collision pair, already reduced to display data. */
export interface CollisionPairView {
  /** Display labels (node names). */
  readonly aPath: string;
  readonly aRole: string;
  readonly bPath: string;
  readonly bRole: string;
  /** Full node paths (`mu:<id>` for spawned MUs) — for focus/pulse on click. */
  readonly aKey: string;
  readonly bKey: string;
  /** First-detection timestamp (performance-time) for the card clock. */
  readonly since: number;
}

export interface CollisionAlertSnapshot {
  /** Bumped on every publish — forces a re-render on grow AND shrink. */
  readonly version: number;
  readonly pairs: readonly CollisionPairView[];
}

const EMPTY_PAIRS: readonly CollisionPairView[] = Object.freeze([]);

const EMPTY: CollisionAlertSnapshot = Object.freeze({
  version: 0,
  pairs: EMPTY_PAIRS,
});

const _store = createStore<CollisionAlertSnapshot>(EMPTY);

/**
 * Publish the current pair list (empty allowed). Always installs a NEW frozen
 * snapshot object, so identity-comparing subscribers re-render even when only
 * the list content changed.
 */
export function publishCollisionAlert(pairs: readonly CollisionPairView[]): void {
  _store.set((prev) => (
    prev.pairs.length === 0 && pairs.length === 0
      ? prev
      : Object.freeze({ version: prev.version + 1, pairs: Object.freeze([...pairs]) })
  ));
}

export function getCollisionAlertSnapshot(): CollisionAlertSnapshot {
  return _store.getSnapshot();
}

/** React hook — live snapshot for the collision cards panel. */
export function useCollisionAlert(): CollisionAlertSnapshot {
  return useSyncExternalStore(_store.subscribe, _store.getSnapshot, _store.getSnapshot);
}

/** Test-only: full reset of module state. */
export function __resetCollisionAlertStore(): void {
  _store.set(() => EMPTY);
}
