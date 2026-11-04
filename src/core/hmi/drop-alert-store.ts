// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * drop-alert-store — external store behind the unsupported-part cards in the
 * right-side messages panel (plan-2022).
 *
 * Deliberately NOT sharing `CollisionPairView`: an unsupported part is not a
 * pair, and the card says something else (where it stood, which source made
 * it, whether it was deleted afterwards).
 *
 * The manager publishes the CURRENT report list on every change — grow AND
 * shrink. Reports LATCH: a card lives until its OK, until its source is
 * ignored, until a rising `ResetDrops` edge or until the model changes. The
 * store publishes an **immutable snapshot with a version counter** —
 * `useSyncExternalStore` compares snapshots by identity, so every change must
 * arrive as a new object.
 */

import { useSyncExternalStore } from 'react';
import { createStore } from './create-store';

/** One reported unsupported part, already reduced to display data. */
export interface DropAlertView {
  /** Display name of the part. */
  readonly muName: string;
  /** `mu:<id>` — identity for acknowledge and dedup. */
  readonly muKey: string;
  /** Scene path of the part's node, for camera framing and the flash. `null`
   *  for an INSTANCED part (it has no node of its own — its slot lives in a
   *  pooled `InstancedMesh`) and for a deleted one; the card then has no click
   *  target, the same known limit the collision cards have. */
  readonly nodePath: string | null;
  /** Node name of the source that spawned it (`''` for a pre-placed part).
   *  This is the unit the card's Ignore mutes. */
  readonly sourceName: string;
  /** World position at the moment of the report, in mm (x, bottom y, z) — stays
   *  readable even after the part was deleted. */
  readonly atMm: readonly [number, number, number];
  /** Was the part deleted after the report (`DeleteUnsupported`)? */
  readonly deleted: boolean;
  /** `performance.now()` of the first detection, for the card clock. */
  readonly since: number;
}

export interface DropAlertSnapshot {
  /** Bumped on every publish — forces a re-render on grow AND shrink. */
  readonly version: number;
  readonly drops: readonly DropAlertView[];
}

const EMPTY_DROPS: readonly DropAlertView[] = Object.freeze([]);

const EMPTY: DropAlertSnapshot = Object.freeze({ version: 0, drops: EMPTY_DROPS });

const _store = createStore<DropAlertSnapshot>(EMPTY);

/**
 * Publish the current report list (empty allowed). Always installs a NEW frozen
 * snapshot object, so identity-comparing subscribers re-render even when only
 * the list content changed.
 */
export function publishDropAlert(drops: readonly DropAlertView[]): void {
  _store.set((prev) => (
    prev.drops.length === 0 && drops.length === 0
      ? prev
      : Object.freeze({ version: prev.version + 1, drops: Object.freeze([...drops]) })
  ));
}

export function getDropAlertSnapshot(): DropAlertSnapshot {
  return _store.getSnapshot();
}

/** React hook — live snapshot for the unsupported-part cards panel. */
export function useDropAlert(): DropAlertSnapshot {
  return useSyncExternalStore(_store.subscribe, _store.getSnapshot, _store.getSnapshot);
}

/** Test-only: full reset of module state. */
export function __resetDropAlertStore(): void {
  _store.set(() => EMPTY);
}
