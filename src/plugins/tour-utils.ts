// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * tour-utils — Shared utilities for plugins that chain camera animations
 * with dwell periods (currently: MaintenancePlugin, KioskPlugin).
 *
 * Extracted from MaintenancePlugin's former private `_waitForCameraAndDwell()`
 * method and generalised to use the standard AbortSignal Web API for
 * cancellation (replaces earlier CancelToken-object pattern).
 *
 * Design goals:
 * - Zero listener leaks: all event listeners and timers explicitly removed on
 *   every resolution path (event fire, timeout, abort).
 * - Cancellation via AbortSignal: composable with fetch(), addEventListener(),
 *   and any other standard Web API.
 * - Watchdog timeout: guarantees the Promise always resolves, even if the
 *   'camera-animation-done' event never fires (e.g. broken model, NaN position).
 */

import type { RVViewer } from '../core/rv-viewer';

/**
 * Wait for the current camera animation to finish, then dwell for `dwellMs`.
 *
 * Resolution paths (any of these guarantees clean resolution):
 *   1. Camera not animating + dwellMs=0 → resolves immediately.
 *   2. `camera-animation-done` event fires → dwells, then resolves.
 *   3. `cameraTimeoutMs` elapses without event → warns, dwells, then resolves.
 *   4. `signal.aborted === true` at any point → resolves immediately.
 *
 * All listeners (event + abort) and timers are removed on every path.
 *
 * @param viewer             RVViewer instance (for isCameraAnimating + .on())
 * @param dwellMs            Extra wait time in ms after camera animation settles
 * @param cameraTimeoutMs    Max time in ms to wait for 'camera-animation-done' (default 5000)
 * @param signal             AbortSignal from an AbortController; resolves early if aborted
 */
export async function waitForCameraAndDwell(
  viewer: RVViewer,
  dwellMs: number,
  cameraTimeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;

  // Step 1: wait for camera animation (with watchdog + abort listener)
  if (viewer.isCameraAnimating) {
    await new Promise<void>((resolve) => {
      let done = false;
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      let unsubEvent: (() => void) | null = null;

      const finish = (): void => {
        if (done) return;
        done = true;
        if (watchdog !== null) { clearTimeout(watchdog); watchdog = null; }
        if (unsubEvent) { unsubEvent(); unsubEvent = null; }
        signal.removeEventListener('abort', onAbort);
        resolve();
      };

      const onAbort = (): void => finish();
      signal.addEventListener('abort', onAbort, { once: true });

      // Explicit unsubscribe — viewer.once() returns an unsub fn (see rv-events.ts)
      unsubEvent = viewer.once('camera-animation-done', () => finish());

      watchdog = setTimeout(() => {
        console.warn('[tour-utils] camera-animation-done timeout — forcing continue');
        finish();
      }, cameraTimeoutMs);
    });
  }

  if (signal.aborted) return;

  // Step 2: dwell (abortable via signal)
  if (dwellMs > 0) {
    await new Promise<void>((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const finish = (): void => {
        if (done) return;
        done = true;
        if (timer !== null) { clearTimeout(timer); timer = null; }
        signal.removeEventListener('abort', onAbort);
        resolve();
      };

      const onAbort = (): void => finish();
      signal.addEventListener('abort', onAbort, { once: true });

      timer = setTimeout(finish, dwellMs);
    });
  }
}
