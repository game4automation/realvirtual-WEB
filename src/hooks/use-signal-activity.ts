// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * useSignalActivityValue — per-signal activity state for a single list row.
 *
 * `SignalStore.getActivity()` is derived, not stored: it combines the signal's
 * source metadata with the *live connection state* of the supplying interface.
 * A signal can therefore change from `live` to `stale` (interface lost) or from
 * `supplied` to `live` (first write) WITHOUT its value changing — so a display
 * that only refreshes on value notifications freezes.
 *
 * Before plan-344 the ConnectPanel kept this fresh as a side effect of a
 * parent-level 60-Hz value tick that re-rendered the whole list body. This hook
 * replaces that with a per-row pull consumer on the shared 200-ms UI ticker
 * (`shared-ui-ticker.ts`): at most 5 evaluations per second per mounted row,
 * and `setState` is skipped whenever the derived enum is unchanged, so a row
 * commits only on a real state transition.
 *
 * The returned value is a plain enum string (never a timestamp), so a
 * `React.memo`'d consumer downstream keeps comparing on the state, not on time.
 */

import { useState, useEffect } from 'react';
import type { SignalStore } from '../core/engine/rv-signal-store';
import type { SignalActivity } from '../core/engine/rv-signal-activity';
import { subscribeTick } from './shared-ui-ticker';

/**
 * Track one signal's derived {@link SignalActivity}, refreshed on the shared UI
 * tick. Returns `undefined` when disabled (indicator off / no store / no name) —
 * which the row renders exactly as it did before the indicator existed.
 *
 * @param store    Signal store, or null to disable.
 * @param name     Signal name, or undefined to disable.
 * @param enabled  Feature gate (the activity-indicator toggle).
 * @param getMode  Reads the current viewer mode; called per evaluation.
 */
export function useSignalActivityValue(
  store: SignalStore | null,
  name: string | undefined,
  enabled: boolean,
  getMode: () => 'standalone' | 'live' | 'direct',
): SignalActivity | undefined {
  const [activity, setActivity] = useState<SignalActivity | undefined>(() =>
    enabled && store && name ? store.getActivity(name, Date.now(), getMode()) : undefined,
  );

  useEffect(() => {
    if (!enabled || !store || !name) {
      // Indicator off → undefined, i.e. the pre-indicator rendering.
      setActivity((prev) => (prev === undefined ? prev : undefined));
      return;
    }

    // `getMode` is intentionally NOT a dependency: it is a module-level reader
    // in every production call site. Keeping it out of the dep list avoids
    // re-subscribing on every parent render for inline arrow callers.
    const read = () => store.getActivity(name, Date.now(), getMode());

    // Re-sync immediately: the store may have moved since the last mount.
    setActivity((prev) => {
      const next = read();
      return prev === next ? prev : next;
    });

    return subscribeTick(() => {
      setActivity((prev) => {
        const next = read();
        return prev === next ? prev : next; // identical enum → React bails out
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, name, enabled]);

  return activity;
}
