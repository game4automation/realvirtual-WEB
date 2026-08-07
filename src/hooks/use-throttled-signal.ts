// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * useThrottledSignalValue — live signal value for HMI badges, coalesced.
 *
 * A live `SignalBadge` that self-tracks a signal subscribes to the SignalStore.
 * Subscribing directly and calling `setState` per notification re-renders the
 * component at the signal rate — up to 60 Hz. With many live badges (e.g. a
 * signal list with dozens of rows) that floods React reconciliation on the
 * main thread and stalls the fixed-update sim loop (both share one thread).
 *
 * This hook keeps the per-signal subscription (so only badges whose signal
 * actually changed re-render) but routes every update through ONE shared,
 * throttled flush pass: notifications only mark the row dirty; the real
 * `setState` happens on a single interval tick and only when the committed
 * value actually differs. N live badges therefore cause at most N *batched*
 * re-renders per interval instead of N × up-to-60 Hz.
 *
 * The display value can lag by up to one interval — irrelevant for a human
 * reading a status chip, and forcing (which is authoritative for display) runs
 * on a separate path (`useSignalForce`), so it is unaffected.
 */

import { useState, useEffect } from 'react';
import type { SignalStore } from '../core/engine/rv-signal-store';
import { clearDirty, markDirty } from './shared-ui-ticker';

/**
 * Track a signal's live value, throttled to a shared ~200 ms flush.
 * Pass `store = null` / `name = undefined` to disable (returns `undefined`);
 * the hook is always called (Rules of Hooks) but wires nothing when disabled.
 */
export function useThrottledSignalValue(
  store: SignalStore | null,
  name: string | undefined,
): boolean | number | undefined {
  const [value, setValue] = useState<boolean | number | undefined>(
    () => (store && name ? store.get(name) : undefined),
  );

  useEffect(() => {
    if (!store || !name) {
      setValue(undefined);
      return;
    }

    // Sync immediately on (re)subscribe — the store may have changed since mount.
    let committed = store.get(name);
    setValue(committed);
    let latest = committed;

    const flush = () => {
      if (latest !== committed) {
        committed = latest;
        setValue(committed);
      }
    };
    const onChange = (v: boolean | number) => {
      latest = v;
      markDirty(flush); // real setState is deferred to the shared tick
    };

    const unsubscribe = store.subscribe(name, onChange);
    return () => {
      unsubscribe();
      clearDirty(flush);
    };
  }, [store, name]);

  return value;
}
