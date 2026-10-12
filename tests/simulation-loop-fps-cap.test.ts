// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-568 — render frame-rate cap in SimulationLoop.
 *
 * Binding design (Plan Review Decisions #1/#2): the simulation integrates EVERY
 * callback unchanged; only `onRender` is rate-limited against a deadline that
 * is carried forward by one interval per rendered frame. Covers both tick
 * paths, cap 30/60, runtime cap change, stop/start, the XR guard, the perf
 * suppression, dirty-flag survival and the embed regression (#6).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimulationLoop, RENDER_DEADLINE_TOLERANCE } from '../src/core/engine/rv-simulation-loop';
import { RVPerfProbe } from '../src/core/engine/perf/rv-perf-probe';
import embedViewerSource from '../src/embed/rv-embed-viewer.ts?raw';

type Tick = (timeMs: number) => void;

interface Harness {
  loop: SimulationLoop;
  tick: Tick;
  renders: number[];
  fixed: { n: number };
}

/** Renderer-driven loop (setAnimationLoop path) with counters. */
function rendererLoop(): Harness {
  let cb: Tick | null = null;
  const loop = new SimulationLoop({ setAnimationLoop: (c) => { cb = c as Tick | null; } });
  const renders: number[] = [];
  const fixed = { n: 0 };
  loop.onFixedUpdate = () => { fixed.n++; };
  loop.onRender = (ft) => { renders.push(ft); };
  loop.start();
  return { loop, tick: (t) => cb!(t), renders, fixed };
}

/** Drive `seconds` of callbacks at `hz`, optionally with deterministic jitter (ms). */
function drive(h: Harness, hz: number, seconds: number, startMs = 0, jitterMs = 0): number {
  const period = 1000 / hz;
  const n = Math.round(seconds * hz);
  let t = startMs;
  for (let i = 0; i <= n; i++) {
    // Alternating ± jitter around the ideal grid (no drift of the mean).
    const j = jitterMs === 0 ? 0 : (i % 2 === 0 ? jitterMs : -jitterMs) * ((i % 3) / 2);
    t = startMs + i * period + j;
    h.tick(t);
  }
  return startMs + n * period;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('SimulationLoop frame-rate cap — renderer path', () => {
  it('144 Hz with cap 60 renders ~60/s and runs exactly as many fixed updates as without a cap', () => {
    const capped = rendererLoop();
    capped.loop.minFrameInterval = 1 / 60;
    drive(capped, 144, 10);
    const free = rendererLoop();
    drive(free, 144, 10);

    expect(free.renders.length).toBe(1441);
    expect(capped.renders.length / 10).toBeGreaterThan(59);
    expect(capped.renders.length / 10).toBeLessThanOrEqual(61);
    expect(capped.fixed.n).toBe(free.fixed.n);
  });

  it('165 Hz with cap 60 renders ~60/s (deadline carried forward, not reset per tick)', () => {
    const h = rendererLoop();
    h.loop.minFrameInterval = 1 / 60;
    drive(h, 165, 10);
    expect(h.renders.length / 10).toBeGreaterThan(59);
    expect(h.renders.length / 10).toBeLessThanOrEqual(61);
  });

  it('60 Hz with jitter and cap 60 drops no frame', () => {
    const h = rendererLoop();
    h.loop.minFrameInterval = 1 / 60;
    drive(h, 60, 10, 0, 0.6);
    expect(h.renders.length).toBe(601);
  });

  it('a display marginally faster than the cap (60.05 Hz) does not drift into skips', () => {
    const h = rendererLoop();
    h.loop.minFrameInterval = 1 / 60;
    drive(h, 60.05, 20);
    expect(h.renders.length).toBe(Math.round(20 * 60.05) + 1);
  });

  it('cap 30 at 60 Hz renders every second frame', () => {
    const h = rendererLoop();
    h.loop.minFrameInterval = 1 / 30;
    drive(h, 60, 10);
    expect(h.renders.length).toBeGreaterThanOrEqual(300);
    expect(h.renders.length).toBeLessThanOrEqual(302);
  });

  it('a skipped render hands its frame time to the next render (no render time lost)', () => {
    const h = rendererLoop();
    h.loop.minFrameInterval = 1 / 60;
    drive(h, 144, 5);
    const total = h.renders.reduce((a, b) => a + b, 0);
    // Last rendered callback may be a few ms before the end of the drive.
    expect(total).toBeGreaterThan(5 - 1 / 60);
    expect(total).toBeLessThanOrEqual(5 + 1e-9);
  });

  it('simulated time is identical with and without cap (cap 30, 120 Hz)', () => {
    const a = rendererLoop(); a.loop.minFrameInterval = 1 / 30;
    const b = rendererLoop();
    drive(a, 120, 7.3); drive(b, 120, 7.3);
    expect(a.fixed.n).toBe(b.fixed.n);
    expect(a.loop.lostSimSeconds).toBe(b.loop.lostSimSeconds);
  });

  it('cap change at runtime applies on the next callback (60 → 30 → off)', () => {
    const h = rendererLoop();
    h.loop.minFrameInterval = 1 / 60;
    let t = drive(h, 144, 2);
    const at60 = h.renders.length;
    h.loop.minFrameInterval = 1 / 30;
    t = drive(h, 144, 2, t + 1000 / 144);
    const at30 = h.renders.length - at60;
    h.loop.minFrameInterval = 0;
    drive(h, 144, 2, t + 1000 / 144);
    const off = h.renders.length - at60 - at30;
    expect(at60).toBeGreaterThan(118);
    expect(at30).toBeGreaterThan(58);
    expect(at30).toBeLessThan(63);
    expect(off).toBe(289);
  });

  it('stop/start: the first callback after a restart renders immediately', () => {
    const h = rendererLoop();
    h.loop.minFrameInterval = 1 / 30;
    drive(h, 60, 1);
    h.loop.stop();
    const before = h.renders.length;
    h.loop.start();
    h.tick(5000);          // baseline frame after restart
    expect(h.renders.length).toBe(before + 1);
    h.tick(5000 + 1000 / 60);   // too early for 30
    expect(h.renders.length).toBe(before + 1);
    h.tick(5000 + 2000 / 60);
    expect(h.renders.length).toBe(before + 2);
  });

  it('shouldThrottle=false (XR presenting) disables the cap; the transition back restores it', () => {
    const h = rendererLoop();
    let xr = false;
    h.loop.shouldThrottle = () => !xr;
    h.loop.minFrameInterval = 1 / 60;
    let t = drive(h, 144, 1);
    const capped = h.renders.length;
    xr = true;
    t = drive(h, 144, 1, t + 1000 / 144);
    const inXR = h.renders.length - capped;
    xr = false;
    drive(h, 144, 1, t + 1000 / 144);
    const after = h.renders.length - capped - inXR;
    expect(inXR).toBe(145);          // every XR frame rendered
    expect(after).toBeGreaterThan(58);
    expect(after).toBeLessThanOrEqual(62);
  });

  it('renderCapSuppressed (perf measurement) disables the cap but keeps the configured interval', () => {
    const h = rendererLoop();
    h.loop.minFrameInterval = 1 / 60;
    h.loop.renderCapSuppressed = true;
    drive(h, 144, 1);
    expect(h.renders.length).toBe(145);
    expect(h.loop.minFrameInterval).toBeCloseTo(1 / 60, 12);
  });

  it('tolerance: a tick up to 1 ms early still renders, more than 1 ms early is skipped', () => {
    const h = rendererLoop();
    h.loop.minFrameInterval = 0.02;
    h.tick(0);                 // baseline render; next due at 20 ms
    h.tick(20 - RENDER_DEADLINE_TOLERANCE * 1000 + 0.05);
    expect(h.renders.length).toBe(2);
    h.tick(40 - 1.5 - 0.5);    // > 1 ms before the next deadline (~39.05)
    expect(h.renders.length).toBe(2);
  });

  it('a dirty flag set during a skipped callback is consumed by the next render', () => {
    const h = rendererLoop();
    let dirty = false;
    let consumed = 0;
    h.loop.onRender = () => { if (dirty) { consumed++; dirty = false; } };
    h.loop.minFrameInterval = 1 / 30;
    h.tick(0);
    dirty = true;              // e.g. a signal changed the scene
    h.tick(1000 / 60);         // skipped — onRender not called
    expect(dirty).toBe(true);
    h.tick(2000 / 60);
    expect(consumed).toBe(1);
    expect(dirty).toBe(false);
  });

  it('XR baseline: setAnimationLoop stays installed with a cap (XR keeps working)', () => {
    const set = vi.fn();
    const loop = new SimulationLoop({ setAnimationLoop: set });
    loop.minFrameInterval = 1 / 30;
    loop.start();
    expect(set).toHaveBeenCalledWith(expect.any(Function));
  });
});

describe('SimulationLoop frame-rate cap — requestAnimationFrame path', () => {
  it('cap 60 at 144 Hz renders ~60/s with unchanged fixed updates', () => {
    const run = (cap: number) => {
      let now = 0;
      const queue: FrameRequestCallback[] = [];
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => { queue.push(cb); return queue.length; });
      const loop = new SimulationLoop();
      let renders = 0; let fixed = 0;
      loop.onRender = () => { renders++; };
      loop.onFixedUpdate = () => { fixed++; };
      loop.minFrameInterval = cap;
      loop.start();            // first tick() runs synchronously at t = 0
      for (let i = 1; i <= 1440; i++) {
        now = i * (1000 / 144);
        const cb = queue.shift()!;
        cb(now);
      }
      loop.stop();
      vi.restoreAllMocks();
      return { renders, fixed };
    };
    const capped = run(1 / 60);
    const free = run(0);
    expect(free.renders).toBe(1441);
    expect(capped.renders).toBeGreaterThan(590);
    expect(capped.renders).toBeLessThanOrEqual(611);
    expect(capped.fixed).toBe(free.fixed);
  });
});

describe('embed regression (Plan Review Decision #6)', () => {
  it('without a cap every callback reaches onRender with exactly the clamped frame time', () => {
    const h = rendererLoop();
    const times = [0, 16.6, 33.4, 50, 250, 266.7, 283.3];
    for (const t of times) h.tick(t);
    const expected = [0];
    for (let i = 1; i < times.length; i++) expected.push(Math.min(times[i] / 1000 - times[i - 1] / 1000, 0.1));
    expect(h.renders).toEqual(expected);
  });

  it("the embed's own 30-FPS render accumulator sees exactly the pre-cap frame sequence", () => {
    // Mirror of RVEmbedViewer.render(): accumulate frameTime, render when ≥ 1/30.
    const embedAccumulator = () => {
      const interval = 1 / 30;
      let acc = 0;
      const drawnAt: number[] = [];
      let i = 0;
      return {
        drawnAt,
        onRender(ft: number) {
          i++;
          acc += Math.max(0, ft);
          if (acc + Number.EPSILON < interval) return;
          acc %= interval;
          drawnAt.push(i);
        },
      };
    };
    const live = embedAccumulator();
    const h = rendererLoop();
    h.loop.onRender = live.onRender;
    const period = 1000 / 60;
    const ref = embedAccumulator();
    ref.onRender(0);
    let prev = 0;
    for (let k = 0; k <= 600; k++) {
      const t = k * period;
      h.tick(t);
      if (k > 0) ref.onRender(Math.min(t / 1000 - prev / 1000, 0.1));
      prev = t;
    }
    expect(live.drawnAt).toEqual(ref.drawnAt);
    expect(live.drawnAt.length).toBeGreaterThan(290);
  });

  it('the embed viewer never configures the main-viewer cap', () => {
    expect(embedViewerSource).not.toMatch(/minFrameInterval|shouldThrottle|renderCapSuppressed/);
  });
});

describe('perf probe forces the cap off (Plan Review Decision #3)', () => {
  it('start() suppresses the cap, stop() restores the previous state and the interval is untouched', () => {
    const h = rendererLoop();
    h.loop.minFrameInterval = 1 / 30;
    const probe = new RVPerfProbe();
    let t = 0;
    probe.start({ loop: h.loop, now: () => t, isVisible: () => true, windowMs: 1e9 });
    expect(h.loop.renderCapSuppressed).toBe(true);
    const before = h.renders.length;
    for (let i = 1; i <= 144; i++) { t = i * (1000 / 144); h.tick(t); }
    // Probe wraps onRender and forwards to the original: every 144 Hz frame renders.
    expect(h.renders.length - before).toBe(144);
    probe.stop();
    const afterStop = h.renders.length;
    for (let i = 145; i <= 288; i++) h.tick(i * (1000 / 144));
    // Cap 30 is effective again after the run.
    expect(h.renders.length - afterStop).toBeGreaterThan(28);
    expect(h.renders.length - afterStop).toBeLessThanOrEqual(31);
    expect(h.loop.renderCapSuppressed).toBe(false);
    expect(h.loop.minFrameInterval).toBeCloseTo(1 / 30, 12);
  });

  it('a session that was already suppressed (?perf) stays suppressed after the probe stops', () => {
    const h = rendererLoop();
    h.loop.renderCapSuppressed = true;
    const probe = new RVPerfProbe();
    probe.start({ loop: h.loop, now: () => 0, isVisible: () => true, windowMs: 1e9 });
    probe.stop();
    expect(h.loop.renderCapSuppressed).toBe(true);
  });
});
