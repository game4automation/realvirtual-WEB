// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for the shared `waitForCameraAndDwell()` helper.
 *
 * Covers all 4 resolution paths:
 *  1. Resolves immediately when viewer not animating AND dwellMs=0
 *  2. Waits for 'camera-animation-done' event when animating
 *  3. Watchdog resolves after cameraTimeoutMs if event never fires
 *  4. signal.aborted mid-wait resolves without further dwell
 *
 * Also verifies zero listener leaks across all paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitForCameraAndDwell } from '../src/plugins/tour-utils';
import type { RVViewer } from '../src/core/rv-viewer';

/** Create a minimal viewer mock matching the surface used by waitForCameraAndDwell. */
function makeMockViewer(opts: { isCameraAnimating?: boolean } = {}): {
  viewer: RVViewer;
  emit: (event: string) => void;
  onSpy: ReturnType<typeof vi.fn>;
  offSpy: ReturnType<typeof vi.fn>;
  listeners: Map<string, Set<(data: unknown) => void>>;
} {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const offSpy = vi.fn();
  const onSpy = vi.fn((event: string, cb: (data: unknown) => void) => {
    let set = listeners.get(event);
    if (!set) { set = new Set(); listeners.set(event, set); }
    set.add(cb);
    const unsub = (): void => { offSpy(event, cb); set?.delete(cb); };
    return unsub;
  });
  const viewer = {
    isCameraAnimating: opts.isCameraAnimating ?? false,
    // viewer.once() returns an unsub fn; we wrap it so the callback fires once then self-removes
    once: (event: string, cb: (data: unknown) => void): (() => void) => {
      const wrapper = (data: unknown): void => { unsub(); cb(data); };
      const unsub = onSpy(event, wrapper);
      return unsub;
    },
  } as unknown as RVViewer;
  const emit = (event: string): void => {
    const set = listeners.get(event);
    if (!set) return;
    for (const cb of set) cb(undefined);
  };
  return { viewer, emit, onSpy, offSpy, listeners };
}

describe('waitForCameraAndDwell', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('resolves immediately when viewer not animating AND dwellMs=0', async () => {
    const { viewer, onSpy } = makeMockViewer({ isCameraAnimating: false });
    const controller = new AbortController();
    const t0 = performance.now();
    await waitForCameraAndDwell(viewer, 0, 5000, controller.signal);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(50);
    expect(onSpy).not.toHaveBeenCalled();
  });

  it('waits for camera-animation-done event when animating, then resolves after dwell', async () => {
    const { viewer, emit, onSpy, listeners } = makeMockViewer({ isCameraAnimating: true });
    const controller = new AbortController();
    const resolved = { done: false };
    const promise = waitForCameraAndDwell(viewer, 50, 5000, controller.signal)
      .then(() => { resolved.done = true; });
    // Give microtasks a chance to register the listener
    await Promise.resolve();
    expect(onSpy).toHaveBeenCalledWith('camera-animation-done', expect.any(Function));
    expect(resolved.done).toBe(false);
    // Fire the event → should progress to dwell
    emit('camera-animation-done');
    await new Promise(r => setTimeout(r, 80));
    expect(resolved.done).toBe(true);
    await promise;
    // Listener must be removed (once() semantics + our explicit unsub)
    expect(listeners.get('camera-animation-done')?.size ?? 0).toBe(0);
  });

  it('watchdog resolves after cameraTimeoutMs if camera-animation-done never fires', async () => {
    const { viewer, onSpy, listeners } = makeMockViewer({ isCameraAnimating: true });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = new AbortController();
    const t0 = performance.now();
    await waitForCameraAndDwell(viewer, 0, 100, controller.signal);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(90);   // watchdog fired
    expect(elapsed).toBeLessThan(500);            // not much later
    expect(onSpy).toHaveBeenCalledWith('camera-animation-done', expect.any(Function));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('timeout'));
    // Listener must be removed
    expect(listeners.get('camera-animation-done')?.size ?? 0).toBe(0);
    warnSpy.mockRestore();
  });

  it('signal.aborted mid-wait resolves immediately (camera wait phase)', async () => {
    const { viewer, listeners } = makeMockViewer({ isCameraAnimating: true });
    const controller = new AbortController();
    const t0 = performance.now();
    const promise = waitForCameraAndDwell(viewer, 10_000, 10_000, controller.signal);
    // Abort before event fires
    setTimeout(() => controller.abort(), 30);
    await promise;
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200);            // aborted quickly
    // Listener cleanup verified via emptied set
    expect(listeners.get('camera-animation-done')?.size ?? 0).toBe(0);
  });

  it('signal.aborted mid-dwell resolves without remaining dwell time', async () => {
    const { viewer } = makeMockViewer({ isCameraAnimating: false });
    const controller = new AbortController();
    const t0 = performance.now();
    const promise = waitForCameraAndDwell(viewer, 10_000, 5000, controller.signal);
    setTimeout(() => controller.abort(), 30);
    await promise;
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200);
  });

  it('zero leaked listeners after 100 timeout iterations', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { viewer, listeners, offSpy } = makeMockViewer({ isCameraAnimating: true });
    for (let i = 0; i < 100; i++) {
      const controller = new AbortController();
      await waitForCameraAndDwell(viewer, 0, 5, controller.signal);
    }
    // Each iteration registered + removed its listener; final set size must be 0
    expect(listeners.get('camera-animation-done')?.size ?? 0).toBe(0);
    // offSpy called once per iteration (via the unsub wrapper in finish())
    expect(offSpy.mock.calls.length).toBeGreaterThanOrEqual(100);
    warnSpy.mockRestore();
  });

  it('returns immediately if signal is already aborted at entry', async () => {
    const { viewer, onSpy } = makeMockViewer({ isCameraAnimating: true });
    const controller = new AbortController();
    controller.abort();
    const t0 = performance.now();
    await waitForCameraAndDwell(viewer, 10_000, 10_000, controller.signal);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(20);
    expect(onSpy).not.toHaveBeenCalled();          // no listener installed
  });
});
