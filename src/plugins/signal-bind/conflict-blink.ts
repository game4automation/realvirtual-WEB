// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * conflict-blink.ts — how hard a conflicting 3D signal badge is allowed to
 * pulse (plan-341 Phase 5, "Blink-Guard").
 *
 * Two rules, and they are not the same rule at two strengths:
 *
 *  1. **Never at the seizure threshold.** WCAG 2.3.1 draws its line at 3 Hz.
 *     `SignalBadgeController` used to ask for exactly `blinkHz: 3` — sitting ON
 *     a safety limit rather than under it. The pulse is now a slow one well
 *     below it, still unmistakably alive next to seven static neighbours.
 *  2. **Under `prefers-reduced-motion: reduce`, nothing moves at all.** Reduced
 *     motion is a request for NO motion cue, not for a gentler one, so the
 *     badge stops blinking outright and the warning moves onto carriers that do
 *     not animate: a heavier ring, a different glyph (the `alert` port-marker
 *     variant) and the label the controller already writes into
 *     `userData.rvSignalBadgeLabel`.
 *
 * The media query is read through an injectable `matchMedia`, so the behaviour
 * is testable without asking a real browser to change its OS accessibility
 * settings (`tests/badge-reduced-motion.test.ts`).
 */

import type { ElementBindingState } from '../../core/engine/rv-signal-binding-manager';
import type { PortMarkerVariant } from './port-marker-texture';

/** WCAG 2.3.1 general flash threshold. Nothing here may reach it. */
export const WCAG_FLASH_THRESHOLD_HZ = 3;

/** The conflict pulse: half the threshold, a slow "look here" rather than a strobe. */
export const CONFLICT_BLINK_HZ = 1.5;

/** `window.matchMedia`, narrowed to what this module needs. */
export type MatchMediaFn = (query: string) => MediaQueryList;

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export interface ReducedMotionWatcher {
  /** Current preference. Reads the live `MediaQueryList`, so it never goes stale. */
  matches(): boolean;
  /** Detach the change listener. Idempotent. */
  dispose(): void;
}

/**
 * Watch `prefers-reduced-motion`. `onChange` fires on every runtime flip — a
 * user toggling the OS setting must not have to reload the viewer to lose the
 * blinking, which is the whole point of the preference.
 *
 * Degrades to a permanent "no preference" when `matchMedia` is unavailable
 * (headless harnesses, embed hosts), never throwing.
 */
export function createReducedMotionWatcher(
  onChange?: (reduced: boolean) => void,
  matchMedia?: MatchMediaFn,
): ReducedMotionWatcher {
  const impl = matchMedia
    ?? (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia.bind(window)
      : undefined);

  if (!impl) return { matches: () => false, dispose: () => {} };

  const query = impl(REDUCED_MOTION_QUERY);
  const handler = (): void => onChange?.(query.matches);
  // `addEventListener` is the modern form; Safari < 14 only has addListener.
  // Both are removed symmetrically in dispose() — a leaked listener here keeps
  // a disposed controller alive for the life of the document.
  let detach: () => void;
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', handler);
    detach = () => query.removeEventListener('change', handler);
  } else if (typeof query.addListener === 'function') {
    query.addListener(handler);
    detach = () => query.removeListener?.(handler);
  } else {
    detach = () => {};
  }

  let disposed = false;
  return {
    matches: () => query.matches,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      detach();
    },
  };
}

export interface ConflictBadgeAppearance {
  /** 0 = static. Never >= {@link WCAG_FLASH_THRESHOLD_HZ}. */
  blinkHz: number;
  /** Sprite texture variant the badge should carry. */
  variant: PortMarkerVariant;
}

/**
 * The motion + shape a badge in `state` should have. Only `conflict` differs
 * from the calm default; every other state was already static and stays so.
 */
export function conflictBadgeAppearance(
  state: ElementBindingState,
  reducedMotion: boolean,
): ConflictBadgeAppearance {
  if (state !== 'conflict') return { blinkHz: 0, variant: 'idle' };
  return reducedMotion
    ? { blinkHz: 0, variant: 'alert' }
    : { blinkHz: CONFLICT_BLINK_HZ, variant: 'idle' };
}
