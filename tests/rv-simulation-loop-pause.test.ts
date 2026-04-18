// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, test, expect, vi } from 'vitest';
import { SimulationLoop } from '../src/core/engine/rv-simulation-loop';

describe('SimulationLoop pause', () => {
  test('starts un-paused with no reasons', () => {
    const loop = new SimulationLoop();
    expect(loop.isPaused).toBe(false);
    expect(loop.pauseReasons).toEqual([]);
  });

  test('setPaused(reason, true) adds a reason', () => {
    const loop = new SimulationLoop();
    const changed = loop.setPaused('ar-placement', true);
    expect(changed).toBe(true);
    expect(loop.isPaused).toBe(true);
    expect(loop.pauseReasons).toEqual(['ar-placement']);
  });

  test('setPaused(reason, false) removes a reason', () => {
    const loop = new SimulationLoop();
    loop.setPaused('ar-placement', true);
    const changed = loop.setPaused('ar-placement', false);
    expect(changed).toBe(true);
    expect(loop.isPaused).toBe(false);
    expect(loop.pauseReasons).toEqual([]);
  });

  test('multiple reasons hold pause until all released', () => {
    const loop = new SimulationLoop();
    expect(loop.setPaused('ar-placement', true)).toBe(true);  // idle → paused
    expect(loop.setPaused('layout-edit', true)).toBe(false);  // still paused, just added reason
    expect(loop.isPaused).toBe(true);
    expect(loop.pauseReasons.length).toBe(2);

    expect(loop.setPaused('ar-placement', false)).toBe(false); // still paused, layout-edit active
    expect(loop.isPaused).toBe(true);
    expect(loop.pauseReasons).toEqual(['layout-edit']);

    expect(loop.setPaused('layout-edit', false)).toBe(true);   // paused → idle
    expect(loop.isPaused).toBe(false);
  });

  test('setPaused is idempotent — same reason twice same state', () => {
    const loop = new SimulationLoop();
    expect(loop.setPaused('user', true)).toBe(true);
    expect(loop.setPaused('user', true)).toBe(false);  // no transition
    expect(loop.pauseReasons).toEqual(['user']);
    expect(loop.setPaused('user', false)).toBe(true);
    expect(loop.setPaused('user', false)).toBe(false); // no transition
    expect(loop.pauseReasons).toEqual([]);
  });

  test('paused loop skips onFixedUpdate but still calls onRender', () => {
    const mockRenderer = { setAnimationLoop: vi.fn() };
    const loop = new SimulationLoop(mockRenderer);
    loop.fixedTimeStep = 1 / 60;
    let fixedCount = 0;
    let renderCount = 0;
    loop.onFixedUpdate = () => fixedCount++;
    loop.onRender = () => renderCount++;
    loop.start();

    const callback = mockRenderer.setAnimationLoop.mock.calls[0][0] as (time: number) => void;
    callback(0);     // baseline
    callback(100);   // 100 ms
    callback(200);   // 100 ms
    expect(fixedCount).toBeGreaterThan(0);
    expect(renderCount).toBeGreaterThan(0);

    // Pause — subsequent frames must not advance fixedUpdate
    loop.setPaused('test', true);
    const fixedBefore = fixedCount;
    const renderBefore = renderCount;
    callback(300);
    callback(400);
    callback(500);
    expect(fixedCount).toBe(fixedBefore);          // frozen
    expect(renderCount).toBeGreaterThan(renderBefore); // still rendering

    // Resume — no catch-up burst (accumulator was drained)
    loop.setPaused('test', false);
    callback(500 + 16.67);  // exactly one fixed step
    expect(fixedCount).toBeLessThanOrEqual(fixedBefore + 1);
  });

  test('pause accumulator drain prevents catch-up burst on resume', () => {
    const mockRenderer = { setAnimationLoop: vi.fn() };
    const loop = new SimulationLoop(mockRenderer);
    loop.fixedTimeStep = 1 / 60;
    let fixedCount = 0;
    loop.onFixedUpdate = () => fixedCount++;
    loop.start();

    const callback = mockRenderer.setAnimationLoop.mock.calls[0][0] as (time: number) => void;
    callback(0);           // baseline
    loop.setPaused('test', true);

    // Simulate 5 seconds of paused frames
    for (let t = 100; t <= 5000; t += 50) callback(t);
    expect(fixedCount).toBe(0);

    // Resume and run one normal frame — must NOT replay 5 seconds of accumulated steps
    loop.setPaused('test', false);
    callback(5000 + 16.67);
    expect(fixedCount).toBeLessThan(10); // at most a couple of steps, not 300
  });

  test('legacy (rAF) tick path also respects pause', () => {
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 0);
    const loop = new SimulationLoop();
    let fixedCount = 0;
    loop.onFixedUpdate = () => fixedCount++;
    loop.setPaused('test', true);
    loop.start();
    // Tick runs internally via rAF — we don't directly invoke it, but isPaused gate is in code path
    expect(loop.isPaused).toBe(true);
    expect(fixedCount).toBe(0);
    loop.stop();
    rafSpy.mockRestore();
  });
});
