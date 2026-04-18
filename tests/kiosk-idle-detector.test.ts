// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for IdleDetector — the throttled activity watcher behind Kiosk Mode's
 * auto-activation. Verifies that start/stop correctly install AND remove ALL
 * 10 event listeners (9 activity + visibilitychange) which is critical for
 * 8-hour trade-show memory stability.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { IdleDetector } from '../src/plugins/kiosk-idle-detector';

const ACTIVITY_EVENTS = [
  'pointerdown', 'pointermove', 'mousedown', 'mousemove',
  'keydown', 'wheel', 'touchstart', 'touchmove', 'scroll',
] as const;

describe('IdleDetector — listener management', () => {
  afterEach(() => vi.restoreAllMocks());

  it('start() installs all 9 activity listeners + visibilitychange', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const addDocSpy = vi.spyOn(document, 'addEventListener');
    const d = new IdleDetector(1000, vi.fn());
    d.start();
    for (const ev of ACTIVITY_EVENTS) {
      expect(addSpy).toHaveBeenCalledWith(ev, expect.any(Function), { passive: true, capture: true });
    }
    expect(addDocSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    d.stop();
  });

  it('stop() removes all 9 activity listeners + visibilitychange with EXACT flags', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const removeDocSpy = vi.spyOn(document, 'removeEventListener');
    const d = new IdleDetector(1000, vi.fn());
    d.start();
    d.stop();
    for (const ev of ACTIVITY_EVENTS) {
      expect(removeSpy).toHaveBeenCalledWith(ev, expect.any(Function), { passive: true, capture: true });
    }
    expect(removeDocSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });

  it('double stop() is safe (idempotent)', () => {
    const d = new IdleDetector(1000, vi.fn());
    d.start();
    d.stop();
    expect(() => d.stop()).not.toThrow();
  });

  it('double start() is safe (idempotent — does not double-install)', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const d = new IdleDetector(1000, vi.fn());
    d.start();
    const firstCount = addSpy.mock.calls.length;
    d.start();
    expect(addSpy.mock.calls.length).toBe(firstCount);
    d.stop();
  });
});

describe('IdleDetector — timing', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fires onIdle after timeoutMs with no activity', async () => {
    const onIdle = vi.fn();
    const d = new IdleDetector(60, onIdle);
    d.start();
    await new Promise(r => setTimeout(r, 100));
    expect(onIdle).toHaveBeenCalledTimes(1);
    d.stop();
  });

  it('activity event resets the timer', async () => {
    const onIdle = vi.fn();
    // throttleMs=0 so every event counts (default 500ms throttle would swallow the reset)
    const d = new IdleDetector(80, onIdle, 0);
    d.start();
    // After 50ms (before 80ms trigger), fire an event → timer resets
    await new Promise(r => setTimeout(r, 50));
    window.dispatchEvent(new Event('keydown'));
    await new Promise(r => setTimeout(r, 50));
    expect(onIdle).not.toHaveBeenCalled();
    // Another 50ms with no event → should fire now (100ms after reset)
    await new Promise(r => setTimeout(r, 50));
    expect(onIdle).toHaveBeenCalledTimes(1);
    d.stop();
  });

  it('throttles rapid activity events to ≥ throttleMs apart', async () => {
    const onIdle = vi.fn();
    const d = new IdleDetector(200, onIdle, 100);   // throttleMs=100
    d.start();
    const addSpy = vi.spyOn(d, 'reset');
    // Fire 50 events in rapid succession within the throttle window
    for (let i = 0; i < 50; i++) window.dispatchEvent(new Event('mousemove'));
    // Throttle allows at most 1 reset in 100ms window; start() did 1 reset already
    // After 50 rapid events, reset count should be much less than 50
    expect(addSpy.mock.calls.length).toBeLessThan(3);
    d.stop();
  });

  it('visibility hidden pauses timer; visible resumes fresh', async () => {
    const onIdle = vi.fn();
    const d = new IdleDetector(60, onIdle);
    d.start();
    // Hide before timer fires
    await new Promise(r => setTimeout(r, 20));
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    // Wait much longer than original timer
    await new Promise(r => setTimeout(r, 100));
    expect(onIdle).not.toHaveBeenCalled();   // hidden → no fire
    // Become visible — fresh timer starts
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise(r => setTimeout(r, 100));
    expect(onIdle).toHaveBeenCalledTimes(1);
    d.stop();
  });

  it('updateTimeout() restarts timer with new value when already started', async () => {
    const onIdle = vi.fn();
    const d = new IdleDetector(1000, onIdle);
    d.start();
    d.updateTimeout(50);   // change to 50ms while running
    await new Promise(r => setTimeout(r, 100));
    expect(onIdle).toHaveBeenCalled();
    d.stop();
  });

  it('reset() bypasses throttle + restarts fresh', async () => {
    const onIdle = vi.fn();
    const d = new IdleDetector(60, onIdle);
    d.start();
    await new Promise(r => setTimeout(r, 40));
    d.reset();                              // 40ms in, explicit reset
    await new Promise(r => setTimeout(r, 40));
    expect(onIdle).not.toHaveBeenCalled();  // timer was reset
    await new Promise(r => setTimeout(r, 40));
    expect(onIdle).toHaveBeenCalledTimes(1);
    d.stop();
  });
});
