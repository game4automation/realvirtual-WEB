// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-render-backend-pause.test.ts — plan-256 test 9-WEB (a).
 *
 * Proves the CRITICAL render-pause ≠ sim-pause contract: pausing the Three
 * renderer (or switching to a non-Three backend) skips ONLY the render calls,
 * while the fixed-update / signal-flush keeps running. Wires a real
 * SimulationLoop exactly like RVViewer does (onFixedUpdate → flush,
 * onRender → controller-gated render) and drives its animation callback — the
 * same approach as rv-simulation-loop-pause.test.ts.
 */

import { describe, test, expect, vi } from 'vitest';
import { SimulationLoop } from '../src/core/engine/rv-simulation-loop';
import { RenderBackendController } from '../src/core/render-backend/rv-render-backend';

describe('RenderBackendController — pause gating', () => {
  test('defaults to three, rendering enabled', () => {
    const c = new RenderBackendController();
    expect(c.backend).toBe('three');
    expect(c.renderPaused).toBe(false);
    expect(c.shouldRenderThree()).toBe(true);
    expect(c.shouldRunThreePlugins()).toBe(true);
  });

  test('pauseRendering() disables three render, keeps backend three', () => {
    const c = new RenderBackendController();
    c.pauseRendering();
    expect(c.renderPaused).toBe(true);
    expect(c.shouldRenderThree()).toBe(false);
    // Plugins still consider three the backend (pause is not a backend switch).
    expect(c.shouldRunThreePlugins()).toBe(true);
    c.resumeRendering();
    expect(c.shouldRenderThree()).toBe(true);
  });
});

describe('render-pause ≠ sim-pause (SimulationLoop wiring)', () => {
  test('pausing rendering skips render() but fixedUpdate/signal-flush keeps running', () => {
    const controller = new RenderBackendController();
    const mockRenderer = { setAnimationLoop: vi.fn() };
    const loop = new SimulationLoop(mockRenderer);
    loop.fixedTimeStep = 1 / 60;

    const flush = vi.fn();       // stands in for onFixedUpdatePre → SignalStore flush
    const gpuRender = vi.fn();   // stands in for renderer.render(...)

    // Exact RVViewer wiring: fixedUpdate runs the signal flush; onRender is
    // gated by the controller (this is what render() does at its top).
    loop.onFixedUpdate = () => { flush(); };
    loop.onRender = () => { if (controller.shouldRenderThree()) gpuRender(); };
    loop.start();

    const cb = mockRenderer.setAnimationLoop.mock.calls[0][0] as (t: number) => void;
    cb(0);      // baseline
    cb(100);
    cb(200);
    expect(flush.mock.calls.length).toBeGreaterThan(0);
    expect(gpuRender.mock.calls.length).toBeGreaterThan(0);

    // Pause rendering ONLY — render calls must stop, flush must continue.
    controller.pauseRendering();
    const flushBefore = flush.mock.calls.length;
    const renderBefore = gpuRender.mock.calls.length;
    cb(300);
    cb(400);
    cb(500);
    expect(gpuRender.mock.calls.length).toBe(renderBefore);        // rendering frozen
    expect(flush.mock.calls.length).toBeGreaterThan(flushBefore);  // signal flush alive

    // Resume — rendering comes back.
    controller.resumeRendering();
    cb(600);
    expect(gpuRender.mock.calls.length).toBeGreaterThan(renderBefore);

    loop.stop();
  });

  test('non-Three backend also skips render while sim keeps ticking', async () => {
    const controller = new RenderBackendController();
    controller.registerFactory('omniverse', () => ({
      id: 'omniverse' as const,
      mount: () => {},
      dispose: () => {},
    }));
    const container = document.createElement('div');

    const mockRenderer = { setAnimationLoop: vi.fn() };
    const loop = new SimulationLoop(mockRenderer);
    const flush = vi.fn();
    const gpuRender = vi.fn();
    loop.onFixedUpdate = () => { flush(); };
    loop.onRender = () => { if (controller.shouldRenderThree()) gpuRender(); };
    loop.start();
    const cb = mockRenderer.setAnimationLoop.mock.calls[0][0] as (t: number) => void;

    await controller.setBackend('omniverse', container);
    expect(controller.shouldRenderThree()).toBe(false);
    expect(controller.shouldRunThreePlugins()).toBe(false);

    const flushBefore = flush.mock.calls.length;
    const renderBefore = gpuRender.mock.calls.length;
    cb(0); cb(100); cb(200);
    expect(gpuRender.mock.calls.length).toBe(renderBefore);       // no three render
    expect(flush.mock.calls.length).toBeGreaterThan(flushBefore); // sim still ticking

    loop.stop();
  });
});
