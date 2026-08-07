// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, test, expect, vi } from 'vitest';
import { SimulationLoop } from '../src/core/engine/rv-simulation-loop';
import { SimulationRuntime } from '../src/core/engine/rv-simulation-runtime';
import type { SimulationKernel } from '../src/core/material-flow/simulation-kernel';

function makeRuntime(kernel: SimulationKernel | null = null) {
  const mockRenderer = { setAnimationLoop: vi.fn() };
  const loop = new SimulationLoop(mockRenderer);
  const emitted: Array<{ event: string; data: unknown }> = [];
  const runtime = new SimulationRuntime({
    getLoop: () => loop,
    getKernel: () => kernel,
    emit: (event, data) => emitted.push({ event, data }),
  });
  loop.start();
  const frame = mockRenderer.setAnimationLoop.mock.calls[0][0] as (time: number) => void;
  return { loop, runtime, emitted, frame };
}

describe('SimulationRuntime attachment', () => {
  test('starts attached and running', () => {
    const { runtime } = makeRuntime();
    expect(runtime.isAttached).toBe(true);
    expect(runtime.state).toBe('running');
  });

  test('detach disables integration and emits runtime-attach-changed once', () => {
    const { loop, runtime, emitted } = makeRuntime();
    runtime._setAttached(false);
    expect(runtime.isAttached).toBe(false);
    expect(runtime.state).toBe('detached');
    expect(loop.integrationEnabled).toBe(false);
    expect(emitted).toEqual([{ event: 'runtime-attach-changed', data: { attached: false } }]);

    // Idempotent — same state again emits nothing
    runtime._setAttached(false);
    expect(emitted.length).toBe(1);

    runtime._setAttached(true);
    expect(loop.integrationEnabled).toBe(true);
    expect(runtime.state).toBe('running');
    expect(emitted.length).toBe(2);
  });

  test('detached loop never invokes onFixedUpdate but keeps rendering, no catch-up on re-attach', () => {
    const { loop, runtime, frame } = makeRuntime();
    let fixedCount = 0;
    let renderCount = 0;
    loop.onFixedUpdate = () => fixedCount++;
    loop.onRender = () => renderCount++;

    frame(0);    // baseline
    frame(100);  // integrating
    expect(fixedCount).toBeGreaterThan(0);

    runtime._setAttached(false);
    const fixedBefore = fixedCount;
    const renderBefore = renderCount;
    // Simulate 5 seconds of detached frames — accumulator must stay drained
    for (let t = 200; t <= 5000; t += 50) frame(t);
    expect(fixedCount).toBe(fixedBefore);              // zero integration
    expect(renderCount).toBeGreaterThan(renderBefore); // rendering untouched

    // Re-attach: no catch-up burst
    runtime._setAttached(true);
    frame(5000 + 16.67);
    expect(fixedCount).toBeLessThanOrEqual(fixedBefore + 2);
  });

  test('detach is NOT a pause reason — force-clearing reasons cannot resume integration', () => {
    const { loop, runtime, frame } = makeRuntime();
    let fixedCount = 0;
    loop.onFixedUpdate = () => fixedCount++;
    frame(0);

    runtime._setAttached(false);
    expect(runtime.pauseReasons).toEqual([]); // no reason involved

    // Simulate RVViewer.clearPauseReasons(): release every active reason
    for (const r of [...runtime.pauseReasons]) runtime.setPaused(r, false);
    frame(100);
    frame(200);
    expect(fixedCount).toBe(0); // still fully detached
  });

  test('pause reasons survive a detach/attach round-trip', () => {
    const { runtime } = makeRuntime();
    runtime.setPaused('user', true);
    expect(runtime.state).toBe('paused');

    runtime._setAttached(false);
    expect(runtime.state).toBe('detached');          // detached wins in derived state
    expect(runtime.pauseReasons).toEqual(['user']);  // but the reason is untouched

    runtime._setAttached(true);
    expect(runtime.state).toBe('paused');            // user pause still holding
    expect(runtime.isPaused).toBe(true);
  });
});

describe('SimulationRuntime execution mode', () => {
  test('continuous with no kernel; setMode warns and no-ops', () => {
    const { runtime } = makeRuntime(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(runtime.mode).toBe('continuous');
    expect(runtime.hasDiscreteRunner()).toBe(false);
    expect(runtime.desControl).toBeNull();
    runtime.setMode('discrete');
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  test('maps discrete ⇄ des onto the kernel', () => {
    const kernel = {
      mode: 'continuous',
      setMode: vi.fn(function (this: { mode: string }, m: string) { this.mode = m; }),
      hasDesRunner: () => true,
      desControl: () => null,
    } as unknown as SimulationKernel;
    const { runtime } = makeRuntime(kernel);

    expect(runtime.mode).toBe('continuous');
    runtime.setMode('discrete');
    expect(kernel.setMode).toHaveBeenCalledWith('des');
    expect(runtime.mode).toBe('discrete');
    runtime.setMode('continuous');
    expect(kernel.setMode).toHaveBeenCalledWith('continuous');
    expect(runtime.hasDiscreteRunner()).toBe(true);
  });
});

describe('SimulationRuntime connection state', () => {
  test('defaults to Connected; _setConnectionState reports actual changes', () => {
    const { runtime } = makeRuntime();
    expect(runtime.connectionState).toBe('Connected');
    expect(runtime._setConnectionState('Connected')).toBe(false); // no change
    expect(runtime._setConnectionState('Disconnected')).toBe(true);
    expect(runtime.connectionState).toBe('Disconnected');
    expect(runtime._setConnectionState('Disconnected')).toBe(false);
  });
});

describe('SimulationLoop integration gate', () => {
  test('integration gate is orthogonal to pause reasons', () => {
    const loop = new SimulationLoop();
    expect(loop.integrationEnabled).toBe(true);
    loop.setIntegrationEnabled(false);
    expect(loop.integrationEnabled).toBe(false);
    expect(loop.isPaused).toBe(false); // gate does not touch pause set
    loop.setPaused('user', true);
    loop.setIntegrationEnabled(true);
    expect(loop.isPaused).toBe(true);  // gate does not release reasons either
  });
});
