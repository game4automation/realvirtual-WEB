// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Journey watcher (plan-601 F1) — makes an invariant violation fail the spec
 * it happened in, with **zero production lines**.
 *
 * A journey is an ordinary Playwright spec. Everything this needs already
 * exists: every message of the DEV-only invariant layer runs through
 * `report()` (`src/core/engine/rv-invariants.ts:121`) and is prefixed
 * `[rv-invariants] `, `collectErrors` (`e2e/_viewer-ready.ts`) already
 * collects `pageerror` **and** `console.error`, and `waitForRenderedFrames`
 * (`e2e/_clock.ts`) already waits for frames the viewer actually rendered.
 *
 * **A filter is not a wait — this is the whole point of the helper.** I3 and
 * I5 are deferred by contract: a checkpoint files ONE reservation which is
 * executed at the next actually rendered frame (`rv-invariants.ts:280`,
 * `:294`, `:342`), and a further mode switch DISCARDS an open reservation.
 * Filtering the collected errors without waiting therefore inspects a list
 * that cannot contain the finding yet — the assertion would be reliably green
 * and check nothing. So:
 *
 * - call {@link JourneyWatcher.settle} after **every** mode switch, which is
 *   both what makes the reservation fall due and what keeps the next switch
 *   from invalidating it;
 * - {@link JourneyWatcher.assertClean} waits for rendered frames itself before
 *   it looks, so a journey that forgets a `settle()` at the very end is still
 *   judged on a complete list.
 *
 * `collectErrors` collects NO `console.log` (`_viewer-ready.ts` filters
 * `msg.type() === 'error'`), so never phrase an assertion on a log line.
 */

import { expect, type Page } from 'playwright/test';
import { waitForRenderedFrames } from './_clock';
import { collectErrors, criticalErrors } from './_viewer-ready';

/** The prefix `report()` puts on every invariant message, deferred ones included. */
export const INVARIANT_PREFIX = '[rv-invariants]';

/**
 * Frames awaited per settle point. TWO, not one: the drain runs at the END of
 * `render()` (`rv-viewer.ts:8123`) while the `requestAnimationFrame` callback
 * of the wait is only ordered against the viewer's own loop by registration
 * order. The second frame removes that dependency — the same two frames
 * `e2e/invariants-layout-reference.spec.ts` uses after a mode switch.
 */
const SETTLE_FRAMES = 2;

/**
 * Milliseconds given to the CDP console events after the frames. The viewer
 * has reported by then; this is only the transport of the message into the
 * array `collectErrors` fills.
 */
const CONSOLE_FLUSH_MS = 150;

/** Upper bound for a mode teardown that reloads the scene (leaving the editor). */
const TRANSITION_TIMEOUT_MS = 60_000;

/** The scene-transition overlay the always-mounted HMI shell shows (`SceneTransitionOverlay.tsx`). */
const TRANSITION_OVERLAY = '[data-testid="scene-transition-overlay"]';

/**
 * The real mode barrier: a rendered frame is NOT one.
 *
 * Leaving the editor mode returns before it is done — `_restorePreviousScene`
 * (asset-editor plugin) is fire-and-forget, shows "Leaving editor…" and reloads
 * the previous scene, and the mode that was requested next does not hold until
 * that has finished (measured 2026-10-15: requestMode('editor') true,
 * activeMode still on the predecessor, overlay on screen). So the barrier waits
 * for the overlay to be gone and then for TWO more frames with the overlay
 * still gone, which also covers a teardown that only starts painting one
 * frame after `mode-changed`.
 */
async function waitForTransitionBarrier(page: Page): Promise<void> {
  const overlay = page.locator(TRANSITION_OVERLAY);
  await expect(overlay, 'a scene transition (mode teardown) must finish').toHaveCount(0, { timeout: TRANSITION_TIMEOUT_MS });
  await waitForRenderedFrames(page, SETTLE_FRAMES);
  await expect(overlay, 'a scene transition must not start right after the last one ended').toHaveCount(0, { timeout: TRANSITION_TIMEOUT_MS });
}

export interface JourneyWatcher {
  /** Everything `collectErrors` has seen since `watchJourney` was called. */
  readonly errors: string[];
  /**
   * Lets deferred findings fall due: waits for frames the viewer actually
   * rendered, then for the console transport. Call after every mode switch.
   */
  settle(frames?: number): Promise<void>;
  /** The `[rv-invariants]` lines collected so far — no waiting (see {@link settle}). */
  invariantViolations(): string[];
  /**
   * Settles, then asserts: no invariant violation and no critical console
   * error. Throws the Playwright assertion error — which is what a negative
   * test catches on purpose.
   */
  assertClean(): Promise<void>;
  /**
   * Forgets everything collected so far.
   *
   * ONLY for a negative test that has already asserted its expected finding
   * and now has to leave the regular run green (plan-601 tests 9.1 / 9.2).
   * Never use it to silence an unexpected error.
   */
  reset(): void;
}

/** Starts watching `page`. Call BEFORE `page.goto` — boot errors count too. */
export function watchJourney(page: Page): JourneyWatcher {
  const errors = collectErrors(page);

  async function settle(frames: number = SETTLE_FRAMES): Promise<void> {
    await waitForRenderedFrames(page, frames);
    await waitForTransitionBarrier(page);
    await page.waitForTimeout(CONSOLE_FLUSH_MS);
  }

  function invariantViolations(): string[] {
    return errors.filter((e) => e.includes(INVARIANT_PREFIX));
  }

  return {
    errors,
    settle,
    invariantViolations,
    async assertClean(): Promise<void> {
      await settle();
      expect(invariantViolations(), 'invariant violation during the journey').toEqual([]);
      expect(criticalErrors(errors.filter((e) => !e.includes(INVARIANT_PREFIX))), 'console errors').toEqual([]);
    },
    reset(): void {
      errors.length = 0;
    },
  };
}

/**
 * Runs `assertClean()` and returns the assertion error instead of throwing it —
 * the result contract of the negative tests (plan-601 test 9.1 / 9.2): the
 * expected failure is caught DELIBERATELY and inspected, rather than a spec
 * being "red on purpose".
 */
export async function captureAssertion(watcher: JourneyWatcher): Promise<Error | null> {
  try {
    await watcher.assertClean();
    return null;
  } catch (e) {
    return e as Error;
  }
}
