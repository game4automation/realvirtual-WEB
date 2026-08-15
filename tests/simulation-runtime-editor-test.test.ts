// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SimulationRuntime — the editor test-run attach API (plan-410 F5/§2.6).
 *
 * The attachment invariant says workspace modes are the only driver. The test
 * run is the ONE sanctioned exception, and these tests pin what "sanctioned"
 * means: it attaches inside a `runtime: 'detached'` mode, it restores the
 * DESCRIPTOR-derived state rather than blindly attaching or detaching, there is
 * at most one owner, and a mode change can never leave an attached test behind.
 */
import { describe, test, expect, vi } from 'vitest';
import { SimulationLoop } from '../src/core/engine/rv-simulation-loop';
import { SimulationRuntime } from '../src/core/engine/rv-simulation-runtime';

function makeRuntime() {
  const mockRenderer = { setAnimationLoop: vi.fn() };
  const loop = new SimulationLoop(mockRenderer);
  const emitted: Array<{ event: string; data: unknown }> = [];
  const runtime = new SimulationRuntime({
    getLoop: () => loop,
    getKernel: () => null,
    emit: (event, data) => emitted.push({ event, data }),
  });
  loop.start();
  const frame = mockRenderer.setAnimationLoop.mock.calls[0][0] as (time: number) => void;
  return { loop, runtime, emitted, frame };
}

/** Enter a `runtime: 'detached'` workspace the way RVViewer's listener does. */
function enterEditorMode(runtime: SimulationRuntime): void {
  runtime._setAttached(false);
}

describe('SimulationRuntime — editor test run', () => {
  test('defaults to inactive', () => {
    const { runtime } = makeRuntime();
    expect(runtime.isEditorTestActive).toBe(false);
  });

  test('beginEditorTest attaches inside a detached workspace and integrates time', () => {
    const { runtime, loop, frame } = makeRuntime();
    enterEditorMode(runtime);
    expect(runtime.state).toBe('detached');

    let fixedCount = 0;
    loop.onFixedUpdate = () => fixedCount++;
    frame(0);
    frame(100);
    expect(fixedCount).toBe(0);  // detached: nothing integrates

    runtime.beginEditorTest();
    expect(runtime.isEditorTestActive).toBe(true);
    expect(runtime.isAttached).toBe(true);
    expect(runtime.state).toBe('running');
    expect(loop.integrationEnabled).toBe(true);

    frame(200);
    frame(300);
    expect(fixedCount).toBeGreaterThan(0);  // the test run actually runs
  });

  test('endEditorTest restores the detached state the mode implied', () => {
    const { runtime, loop } = makeRuntime();
    enterEditorMode(runtime);

    runtime.beginEditorTest();
    runtime.endEditorTest();

    expect(runtime.isEditorTestActive).toBe(false);
    expect(runtime.isAttached).toBe(false);
    expect(runtime.state).toBe('detached');
    expect(loop.integrationEnabled).toBe(false);
  });

  test('in an ATTACHED workspace the round trip is a no-op, not a forced detach', () => {
    const { runtime, loop } = makeRuntime();  // starts attached (e.g. planner)
    runtime.beginEditorTest();
    expect(runtime.isAttached).toBe(true);
    runtime.endEditorTest();
    // Restores what was there before — attached — instead of detaching.
    expect(runtime.isAttached).toBe(true);
    expect(loop.integrationEnabled).toBe(true);
  });

  test('a second begin is idempotent and warns', () => {
    const { runtime, emitted } = makeRuntime();
    enterEditorMode(runtime);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    runtime.beginEditorTest();
    const emittedAfterFirst = emitted.length;
    runtime.beginEditorTest();

    expect(warn).toHaveBeenCalledOnce();
    expect(emitted.length).toBe(emittedAfterFirst);  // no second attach event

    // The single end that follows still restores correctly.
    runtime.endEditorTest();
    expect(runtime.isAttached).toBe(false);
    warn.mockRestore();
  });

  test('endEditorTest without a begin does nothing', () => {
    const { runtime, emitted } = makeRuntime();
    enterEditorMode(runtime);
    const before = emitted.length;
    runtime.endEditorTest();
    expect(runtime.isAttached).toBe(false);
    expect(emitted.length).toBe(before);
  });

  test('pause reasons survive a test round trip untouched', () => {
    const { runtime } = makeRuntime();
    runtime.setPaused('user', true);
    enterEditorMode(runtime);

    runtime.beginEditorTest();
    expect(runtime.pauseReasons).toEqual(['user']);
    expect(runtime.state).toBe('paused');  // attached, but the user pause holds

    runtime.endEditorTest();
    expect(runtime.pauseReasons).toEqual(['user']);
  });

  test('attach events are emitted for both edges of the test run', () => {
    const { runtime, emitted } = makeRuntime();
    enterEditorMode(runtime);
    emitted.length = 0;

    runtime.beginEditorTest();
    runtime.endEditorTest();

    expect(emitted).toEqual([
      { event: 'runtime-attach-changed', data: { attached: true } },
      { event: 'runtime-attach-changed', data: { attached: false } },
    ]);
  });

  /**
   * The safety net in RVViewer's `mode-changed` listener (rv-viewer.ts).
   * Constructing a full RVViewer needs a renderer and a canvas, so this
   * replicates the listener body verbatim against a real runtime — what is
   * asserted is the CONTRACT the listener depends on: without the
   * `endEditorTest()` call the descriptor derivation cannot take effect.
   */
  describe('mode-changed safety net (listener body)', () => {
    const modeChanged = (runtime: SimulationRuntime, descriptorRuntime: 'simulation' | 'detached') => {
      if (runtime.isEditorTestActive) runtime.endEditorTest();
      runtime._setAttached(descriptorRuntime !== 'detached');
    };

    test('a still-active test run is ended before the descriptor is applied', () => {
      const { runtime } = makeRuntime();
      enterEditorMode(runtime);
      runtime.beginEditorTest();

      // Guard-free exit to an attached workspace.
      modeChanged(runtime, 'simulation');

      expect(runtime.isEditorTestActive).toBe(false);
      expect(runtime.isAttached).toBe(true);
    });

    test('without the net a STALE OWNER survives the switch and blocks the next run', () => {
      const { runtime } = makeRuntime();
      enterEditorMode(runtime);
      runtime.beginEditorTest();

      // What the listener did BEFORE plan-410: descriptor derivation only.
      runtime._setAttached(true);   // e.g. switching to the planner

      // Attachment happens to be right, but ownership is not: nobody ever
      // ended the run, so the runtime still believes a test owns it. The next
      // editor session's beginEditorTest is then refused as a double-begin.
      expect(runtime.isEditorTestActive).toBe(true);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      enterEditorMode(runtime);
      runtime.beginEditorTest();
      expect(warn).toHaveBeenCalled();          // refused
      expect(runtime.isAttached).toBe(false);   // the new test run never attached
      warn.mockRestore();

      // With the net the same sequence leaves no owner behind.
      const fresh = makeRuntime();
      enterEditorMode(fresh.runtime);
      fresh.runtime.beginEditorTest();
      modeChanged(fresh.runtime, 'simulation');
      expect(fresh.runtime.isEditorTestActive).toBe(false);

      // …and the next editor test run works normally.
      enterEditorMode(fresh.runtime);
      fresh.runtime.beginEditorTest();
      expect(fresh.runtime.isAttached).toBe(true);
    });
  });
});
