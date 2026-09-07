// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-465 §9.5 — lost simulation time, in BOTH tick paths.
 *
 * The viewer runs the renderer-driven path (`setAnimationLoop`), the legacy
 * rAF path still exists, and the two used to carry duplicated accumulator code.
 * Every assertion below is therefore run against both, driven through the same
 * table: a counter that is only right in one path is worthless.
 *
 * `tick` and `tickFromRenderer` are private, so the test drives them the way the
 * runtime does — through `requestAnimationFrame` and `renderer.setAnimationLoop`
 * fakes that hand back a controlled clock.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SimulationLoop } from '../../src/core/engine/rv-simulation-loop';

const STEP = 1 / 60;

/** Drives the loop through whichever entry point the path under test uses. */
interface Harness {
  loop: SimulationLoop;
  /** Advance wall-clock by `seconds` and deliver exactly one frame. */
  frame(seconds: number): void;
  steps: number;
  stop(): void;
}

let realNow: () => number;
let realRaf: typeof requestAnimationFrame;

beforeEach(() => {
  realNow = performance.now.bind(performance);
  realRaf = globalThis.requestAnimationFrame;
});
afterEach(() => {
  performance.now = realNow;
  globalThis.requestAnimationFrame = realRaf;
});

/** rAF path: the loop reads `performance.now()` and re-schedules itself. */
function rafHarness(): Harness {
  let clockMs = 0;
  let pending: FrameRequestCallback | null = null;
  performance.now = () => clockMs;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    pending = cb;
    return 1;
  }) as typeof requestAnimationFrame;

  const loop = new SimulationLoop();
  const h: Harness = {
    loop,
    steps: 0,
    frame(seconds: number) {
      clockMs += seconds * 1000;
      const cb = pending;
      pending = null;
      cb?.(clockMs);
    },
    stop() { loop.stop(); },
  };
  loop.onFixedUpdate = () => { h.steps++; };
  loop.start();          // start() runs one tick immediately (baseline frame)
  return h;
}

/** Renderer path: the renderer hands the loop a timestamp. */
function rendererHarness(): Harness {
  let cb: ((time: number) => void) | null = null;
  const renderer = { setAnimationLoop: (fn: ((time: number) => void) | null) => { cb = fn; } };
  const loop = new SimulationLoop(renderer);
  let clockMs = 0;
  const h: Harness = {
    loop,
    steps: 0,
    frame(seconds: number) {
      clockMs += seconds * 1000;
      cb?.(clockMs);
    },
    stop() { loop.stop(); },
  };
  loop.onFixedUpdate = () => { h.steps++; };
  loop.start();
  h.frame(0);            // first renderer tick only establishes the baseline
  return h;
}

const paths: [string, () => Harness][] = [
  ['rAF path (tick)', rafHarness],
  ['renderer path (tickFromRenderer)', rendererHarness],
];

describe.each(paths)('lost simulation time — %s', (_name, makeHarness) => {
  it('charges a 2 s frame as 1.9 s clamped and runs at most maxSubSteps', () => {
    const h = makeHarness();
    h.frame(2);

    // The clamp keeps 0.1 s, which is exactly 6 steps of 1/60 — the sub-step
    // ceiling is reached but nothing is left over, so no backlog is dropped.
    expect(h.loop.clampedSeconds).toBeCloseTo(1.9, 6);
    expect(h.steps).toBeLessThanOrEqual(h.loop.maxSubSteps);
    expect(h.steps).toBe(6);
    expect(h.loop.droppedBacklogSeconds).toBeLessThan(STEP);
    expect(h.loop.lostSimSeconds).toBeCloseTo(1.9 + h.loop.droppedBacklogSeconds, 6);
    h.stop();
  });

  it('leaves every counter at zero for a normal 16 ms frame', () => {
    const h = makeHarness();
    h.frame(0.016);
    expect(h.loop.clampedSeconds).toBe(0);
    expect(h.loop.droppedBacklogSeconds).toBe(0);
    expect(h.loop.pausedSeconds).toBe(0);
    expect(h.loop.lostSimSeconds).toBe(0);
    h.stop();
  });

  it('drops backlog only when the sub-step ceiling is actually exceeded', () => {
    const h = makeHarness();
    h.loop.maxSubSteps = 2;                 // 2 steps = 0.0333 s of the 0.1 s clamp
    h.frame(2);

    expect(h.steps).toBe(2);
    expect(h.loop.clampedSeconds).toBeCloseTo(1.9, 6);
    // 0.1 s arrived, 2 steps consumed 2/60 s, the rest is dropped.
    expect(h.loop.droppedBacklogSeconds).toBeCloseTo(0.1 - 2 * STEP, 6);
    h.stop();
  });

  it('counts a paused frame as paused time, never as clamp or backlog', () => {
    const h = makeHarness();
    h.loop.setPaused('test', true);
    h.frame(0.05);
    h.frame(0.05);

    expect(h.loop.pausedSeconds).toBeCloseTo(0.1, 6);
    expect(h.loop.clampedSeconds).toBe(0);
    expect(h.loop.droppedBacklogSeconds).toBe(0);
    expect(h.loop.lostSimSeconds).toBe(0);   // a deliberate pause is not drift
    expect(h.steps).toBe(0);
    h.stop();
  });

  it('counts disabled integration the same way as a pause', () => {
    const h = makeHarness();
    h.loop.setIntegrationEnabled(false);
    h.frame(0.05);

    expect(h.loop.pausedSeconds).toBeCloseTo(0.05, 6);
    expect(h.loop.clampedSeconds).toBe(0);
    expect(h.steps).toBe(0);
    h.stop();
  });

  it('still clamps a long paused frame, and books the clamped remainder as paused', () => {
    const h = makeHarness();
    h.loop.setPaused('test', true);
    h.frame(2);
    // The clamp is applied before the pause branch, so the 1.9 s is lost time in
    // the sense of "the simulation never saw it" — but the simulation was not
    // supposed to see it, so `lostSimSeconds` must not grow… except that the
    // clamp itself is unconditional. Pin the actual contract:
    expect(h.loop.clampedSeconds).toBeCloseTo(1.9, 6);
    expect(h.loop.pausedSeconds).toBeCloseTo(0.1, 6);
    expect(h.loop.droppedBacklogSeconds).toBe(0);
    h.stop();
  });

  it('resets every counter on request', () => {
    const h = makeHarness();
    h.frame(2);
    expect(h.loop.lostSimSeconds).toBeGreaterThan(0);
    h.loop.resetLostTimeCounters();
    expect(h.loop.clampedSeconds).toBe(0);
    expect(h.loop.droppedBacklogSeconds).toBe(0);
    expect(h.loop.pausedSeconds).toBe(0);
    h.stop();
  });
});

describe('both tick paths agree', () => {
  it('produces identical counters for the same frame sequence', () => {
    const sequence = [0.016, 0.016, 2, 0.05, 0.5, 0.016];
    const results = paths.map(([, make]) => {
      const h = make();
      for (const s of sequence) h.frame(s);
      const snapshot = {
        clamped: +h.loop.clampedSeconds.toFixed(9),
        dropped: +h.loop.droppedBacklogSeconds.toFixed(9),
        paused: h.loop.pausedSeconds,
        steps: h.steps,
      };
      h.stop();
      return snapshot;
    });
    expect(results[0]).toEqual(results[1]);
  });
});
