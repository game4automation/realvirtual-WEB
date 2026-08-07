// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * debounce.ts — Leading-edge debounce + generation guard for the AI error
 * diagnosis trigger (plan-253, F10).
 *
 * Leading-edge (NOT trailing!): the FIRST edge fires immediately; further
 * edges inside the window are suppressed. A trailing debounce would produce
 * ZERO calls on continuous signal flutter — the review-identified failure mode.
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
