// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * debounce.ts — both debounce flanks + a generation guard. Born for the AI
 * error diagnosis trigger (plan-253, F10); the trailing flank was added for the
 * CONNECT active-document notify (plan-725 §2.7).
 *
 * Leading-edge: the FIRST edge fires immediately; further edges inside the
 * window are suppressed. A trailing debounce would produce ZERO calls on
 * continuous signal flutter — the review-identified failure mode there.
 *
 * Trailing-edge: after a burst comes to rest, fire ONCE with the LAST payload.
 * The right flank when the point is "re-read what these writes produced", where
 * a leading call would describe a state that no longer exists.
 *
 * Both helpers are allocation-free after construction and expose an explicit
 * `dispose()` (clearTimeout) so component `dispose()` can clean up.
 */

export interface LeadingEdgeDebounce {
  /** True when the caller may fire now (leading edge); false while suppressed. */
  shouldFire(): boolean;
  /** Clear the suppression window + pending timer (component dispose). */
  dispose(): void;
}

/**
 * Create a leading-edge debounce with the given suppression window.
 * The first `shouldFire()` returns true and opens the window; every call
 * inside the window returns false. After `windowMs` the next call fires again.
 */
export function createLeadingEdgeDebounce(windowMs: number): LeadingEdgeDebounce {
  let blocked = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    shouldFire(): boolean {
      if (blocked) return false;
      blocked = true;
      timer = setTimeout(() => {
        blocked = false;
        timer = null;
      }, windowMs);
      return true;
    },
    dispose(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      blocked = false;
    },
  };
}

export interface TrailingEdgeDebounce<T> {
  /** Record `payload` as the newest one and (re)start the window. */
  schedule(payload: T): void;
  /** Fire NOW if something is pending (tab close, explicit flush). No-op otherwise. */
  flush(): void;
  /** The payload that would fire, or null when nothing is pending. */
  peek(): T | null;
  /** True while a payload is waiting for the window to elapse. */
  hasPending(): boolean;
  /** Drop the pending payload and the timer WITHOUT firing (dispose). */
  cancel(): void;
}

/**
 * Create a trailing-edge debounce: after a burst of `schedule()` calls, `fire`
 * runs exactly ONCE, with the LAST payload (plan-725 §2.7).
 *
 * The opposite flank of {@link createLeadingEdgeDebounce}, and deliberately so.
 * Leading-edge answers "something started happening"; this answers "a series of
 * changes has come to rest", which is the only useful moment to tell another
 * process to re-read the files those changes wrote. A leading-edge notify would
 * fire before the last write landed and would therefore describe a state that
 * no longer exists by the time the receiver reads it.
 *
 * **The window restarts on every `schedule()`** — the classic trailing
 * semantics. That is right for user-driven bursts (a drag, a rename, an adopt
 * run) and wrong for a continuously fluttering signal, which would postpone the
 * call forever; the flutter case is exactly what the leading-edge helper above
 * exists for, so pick by the shape of the source, not by taste.
 *
 * `flush()` is the escape hatch the tab-close path needs: a pending payload has
 * to leave the page before it is unloaded (F10).
 */
export function createTrailingEdgeDebounce<T>(
  windowMs: number,
  fire: (payload: T) => void,
): TrailingEdgeDebounce<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { payload: T } | null = null;

  const clear = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const fireNow = (): void => {
    const held = pending;
    clear();
    pending = null;
    if (held) fire(held.payload);
  };

  return {
    schedule(payload: T): void {
      pending = { payload };
      clear();
      timer = setTimeout(fireNow, windowMs);
    },
    flush(): void {
      if (pending) fireNow();
    },
    peek(): T | null {
      return pending ? pending.payload : null;
    },
    hasPending(): boolean {
      return pending !== null;
    },
    cancel(): void {
      clear();
      pending = null;
    },
  };
}

export interface GenerationGuard {
  /** Start a new generation (invalidates all older ones) and return its id. */
  next(): number;
  /** True when `generation` is still the newest one (response not overtaken). */
  isCurrent(generation: number): boolean;
  /** Invalidate ALL generations (model cleared / falling edge). */
  invalidate(): void;
}

/**
 * In-flight guard: a monotonically increasing generation counter. A fetch
 * captures `next()` before starting and checks `isCurrent()` before applying
 * its response — a newer request (or `invalidate()`) discards older answers.
 */
export function createGenerationGuard(): GenerationGuard {
  let current = 0;
  return {
    next(): number {
      current += 1;
      return current;
    },
    isCurrent(generation: number): boolean {
      return generation === current;
    },
    invalidate(): void {
      current += 1;
    },
  };
}
