// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared signal polling hook — consolidates duplicate setInterval(500ms)
 * patterns used by HierarchyBrowser and PropertyInspector for live
 * signal value display in badges and headers.
 *
 * Returns an incrementing tick number that triggers re-renders on the
 * specified interval. Cleans up the interval on unmount.
 *
 * Skips setState when the store's version hasn't changed (no signal
 * values were updated), eliminating unnecessary React re-renders.
 *
 * Usage:
 *   const tick = useSignalTick(viewer.signalStore);
 *   // tick increments only when signals actually change
 */

import { useState, useEffect, useRef } from 'react';
import type { SignalStore } from '../core/engine/rv-signal-store';

/**
 * Poll signal store at a fixed interval to trigger re-renders for
 * live signal value display. Returns an incrementing tick counter.
 * Only triggers a re-render when signal values have actually changed.
 *
 * @param store  The signal store to monitor (null = no polling).
 * @param intervalMs  Polling interval in milliseconds (default 200).
 * @returns  Incrementing tick number (for triggering re-renders).
 */
export function useSignalTick(store: SignalStore | null, intervalMs = 200): number {
  const [tick, setTick] = useState(0);
  const lastVersionRef = useRef(-1);

  useEffect(() => {
    if (!store) return;
    const id = setInterval(() => {
      const v = store.version;
      if (v !== lastVersionRef.current) {
        lastVersionRef.current = v;
        setTick(t => t + 1);
      }
    }, intervalMs);
    return () => clearInterval(id);
  }, [store, intervalMs]);

  return tick;
}
