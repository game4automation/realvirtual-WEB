// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * useChangeGatedTick — poll a value, commit only when it actually changed.
 *
 * Some inspector read-outs cannot be driven by a subscription: a Drive's
 * `currentPosition` and a node's `position`/`rotation` are mutated in place by
 * the physics/transform code every frame, with no notification of any kind. The
 * only way to display them is to poll.
 *
 * The trap (plan-344 Phase 3.1) is that polling and *committing* got conflated:
 * the previous call sites did `setInterval(() => setTick(t => t + 1), 200)`, so a
 * completely static scene still re-rendered those sections 5×/s, forever, for
 * nothing. This hook keeps the poll and gates the commit on a real change.
 *
 * Correctness rules baked in, because getting them wrong silently FREEZES a live
 * read-out — a far worse failure than the re-renders being fixed:
 *  - `read` is held in a ref, so an inline arrow at the call site does not
 *    restart the interval on every parent render.
 *  - `equal` defaults to `Object.is`; pass a comparator for structural values
 *    (e.g. an epsilon compare for a transform tuple).
 *  - `resetKey` re-baselines AND restarts the timer. Selection changes must go
 *    through it, otherwise the first poll after a switch compares the new node
 *    against the old node's value.
 *  - `enabled: false` tears the interval down; nothing keeps polling a section
 *    that is not on screen.
 */

import { useState, useEffect, useRef } from 'react';

export interface ChangeGatedTickOptions<T> {
  /** Reads the current value. Called on every poll; must be cheap and pure. */
  read: () => T;
  /** Equality for the polled value. Defaults to `Object.is`. */
  equal?: (a: T, b: T) => boolean;
  /** When false, no interval runs at all. Defaults to true. */
  enabled?: boolean;
  /** Poll period in milliseconds. Defaults to 200 (5 Hz). */
  intervalMs?: number;
  /** Changing this re-baselines the comparison and restarts the interval. */
  resetKey?: string;
}

/**
 * @returns A counter that increments ONLY when the polled value changed. Use it
 *          as a `useMemo` dependency to recompute derived display values.
 */
export function useChangeGatedTick<T>({
  read,
  equal,
  enabled = true,
  intervalMs = 200,
  resetKey = '',
}: ChangeGatedTickOptions<T>): number {
  const [tick, setTick] = useState(0);
  const readRef = useRef(read);
  readRef.current = read;
  const equalRef = useRef(equal);
  equalRef.current = equal;

  useEffect(() => {
    if (!enabled) return;
    // Baseline against the CURRENT value, so the first poll after a reset does
    // not report a spurious change (which would defeat the whole point).
    let committed = readRef.current();
    const id = setInterval(() => {
      const next = readRef.current();
      const same = equalRef.current ? equalRef.current(committed, next) : Object.is(committed, next);
      if (same) return;
      committed = next;
      setTick((t) => t + 1);
    }, intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs, resetKey]);

  return tick;
}
