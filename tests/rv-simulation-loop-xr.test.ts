// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, test, expect, vi } from 'vitest';
import { SimulationLoop } from '../src/core/engine/rv-simulation-loop';

describe('SimulationLoop XR compatibility', () => {
  test('uses setAnimationLoop when renderer provided', () => {
    const mockRenderer = { setAnimationLoop: vi.fn() };
    const loop = new SimulationLoop(mockRenderer);
    loop.start();
    expect(mockRenderer.setAnimationLoop).toHaveBeenCalledWith(expect.any(Function));
  });

  test('uses requestAnimationFrame when no renderer (legacy)', () => {
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 0);
    const loop = new SimulationLoop();
    loop.start();
    expect(rafSpy).toHaveBeenCalled();
    loop.stop();
    rafSpy.mockRestore();
  });

  test('stop calls setAnimationLoop(null)', () => {
    const mockRenderer = { setAnimationLoop: vi.fn() };
    const loop = new SimulationLoop(mockRenderer);
    loop.start();
    loop.stop();
    expect(mockRenderer.setAnimationLoop).toHaveBeenCalledWith(null);
  });

  test('tick continues with setAnimationLoop callback', () => {
    const mockRenderer = { setAnimationLoop: vi.fn() };
    const loop = new SimulationLoop(mockRenderer);
    let fixedCount = 0;
    loop.onFixedUpdate = () => fixedCount++;
    loop.start();

    const callback = mockRenderer.setAnimationLoop.mock.calls[0][0] as (time: number) => void;
    // Simulate frames
    callback(0);
    callback(16.67);
    callback(33.34);
    expect(fixedCount).toBeGreaterThan(0);
  });

  test('onRender receives clamped frame time', () => {
    const mockRenderer = { setAnimationLoop: vi.fn() };
    const loop = new SimulationLoop(mockRenderer);
    let lastFrameTime = -1;
    loop.onRender = (ft: number) => { lastFrameTime = ft; };
    loop.start();

    const callback = mockRenderer.setAnimationLoop.mock.calls[0][0] as (time: number) => void;
    callback(0);
    callback(16.67);
    expect(lastFrameTime).toBeGreaterThan(0);
    expect(lastFrameTime).toBeLessThanOrEqual(0.1);
  });
});
