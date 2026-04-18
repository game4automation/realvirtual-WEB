// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * IdleDetector — User inactivity watcher for Kiosk Mode.
 *
 * Fires `onIdleCallback` after `timeoutMs` of no activity. Throttles activity-
 * event reset calls to ≥THROTTLE_MS apart to avoid CPU thrash under heavy
 * mousemove. Pauses when the tab becomes hidden (via Page Visibility API);
 * restarts fresh when the tab is visible again.
 *
 * Activity events (9 total) + visibilitychange = 10 total listeners that
 * MUST be removed in `stop()` for 8-hour trade-show memory stability.
 */

const ACTIVITY_EVENTS = [
  'pointerdown', 'pointermove', 'mousedown', 'mousemove',
  'keydown', 'wheel', 'touchstart', 'touchmove', 'scroll',
] as const;

const DEFAULT_THROTTLE_MS = 500;

export class IdleDetector {
  private _timerId: ReturnType<typeof setTimeout> | null = null;
  private _lastResetAt = 0;
  private _timeoutMs: number;
  private _started = false;
  private readonly _throttleMs: number;
  private readonly _onIdleCallback: () => void;
  private readonly _boundActivity: () => void;
  private readonly _boundVisibility: () => void;
  private readonly _listenerOpts: AddEventListenerOptions = { passive: true, capture: true };

  constructor(timeoutMs: number, onIdle: () => void, throttleMs: number = DEFAULT_THROTTLE_MS) {
    this._timeoutMs = Math.max(0, timeoutMs);
    this._onIdleCallback = onIdle;
    this._throttleMs = throttleMs;
    this._boundActivity = this._onActivity.bind(this);
    this._boundVisibility = this._onVisibility.bind(this);
  }

  /** Start watching. Adds 10 listeners (9 activity + visibilitychange). */
  start(): void {
    if (this._started) return;
    this._started = true;
    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, this._boundActivity, this._listenerOpts);
    }
    document.addEventListener('visibilitychange', this._boundVisibility);
    this.reset();
  }

  /**
   * Stop watching. MUST remove ALL 10 listeners + clear pending timer.
   * Safe to call multiple times (idempotent).
   */
  stop(): void {
    if (this._timerId !== null) { clearTimeout(this._timerId); this._timerId = null; }
    if (!this._started) return;
    this._started = false;
    for (const ev of ACTIVITY_EVENTS) {
      window.removeEventListener(ev, this._boundActivity, this._listenerOpts);
    }
    document.removeEventListener('visibilitychange', this._boundVisibility);
  }

  /**
   * Public reset — bypasses the activity-event throttle; restarts timer fresh.
   * Called externally when the user explicitly resumes (e.g. WelcomeModal closes)
   * to give a full fresh countdown regardless of when they last interacted.
   */
  reset(): void {
    this._lastResetAt = performance.now();
    if (this._timerId !== null) clearTimeout(this._timerId);
    if (this._timeoutMs === 0) {
      // "Instant" mode (?kiosk=now) — fire on next microtask to let caller finish setup
      this._timerId = setTimeout(this._onIdle, 0);
    } else {
      this._timerId = setTimeout(this._onIdle, this._timeoutMs);
    }
  }

  /**
   * Update the idle timeout at runtime. If currently started, the new timeout
   * takes effect immediately (timer reset).
   */
  updateTimeout(newMs: number): void {
    this._timeoutMs = Math.max(0, newMs);
    if (this._started) this.reset();
  }

  /** Is the detector currently active (started and not stopped)? */
  get isStarted(): boolean { return this._started; }

  // ─── Private handlers ────────────────────────────────────────────────

  /** Throttled reset from activity events (pointerdown, mousemove, etc.). */
  private _onActivity(): void {
    const now = performance.now();
    if (now - this._lastResetAt < this._throttleMs) return;
    this.reset();
  }

  /** Pause timer on tab hidden; reset fresh on tab visible. */
  private _onVisibility(): void {
    if (document.visibilityState === 'hidden') {
      if (this._timerId !== null) { clearTimeout(this._timerId); this._timerId = null; }
    } else {
      this.reset();
    }
  }

  /** Fires when no activity for timeoutMs. */
  private _onIdle = (): void => {
    this._timerId = null;
    try {
      this._onIdleCallback();
    } catch (e) {
      console.error('[kiosk] idle callback threw:', e);
    }
  };
}
