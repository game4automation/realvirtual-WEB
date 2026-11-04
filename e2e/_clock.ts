// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * THE deterministic test clock for the e2e suite (plan-600, F2/F4).
 *
 * There is exactly ONE time mechanic, and this is its only façade. It drives
 * the viewer's existing video-capture path ("variant C", in use since plan-537
 * by the video recorder, the MCP frame capture and the embed):
 *
 * ```
 * armTestClock(page)        // beginCapture + resetSimulation() — EXACTLY ONCE
 *   advanceSim(page, n)     // per frame: captureStep + captureRenderFrame
 * releaseTestClock(page)    // endCapture(), in a finally
 * ```
 *
 * Measured contracts this helper ENFORCES rather than documents (spike
 * 2026-10-13, recorded in the plan):
 *
 * - **`captureStep` alone does not move material.** 300 s of pure step advance
 *   leaves the sink at `consumed = 0`; interleaved with `captureRenderFrame` —
 *   exactly what the recorder does (`src/core/engine/rv-video-capture.ts:1378`)
 *   — the first consumption lands at `simTime = 88.6 s`. So every step block is
 *   followed by a rendered frame, always.
 * - **`beginCapture` alone has no reproducible start state.** The live phase
 *   before it is wall-clock bound (9.90 s / 747 ticks vs. 9.85 s / 734 ticks on
 *   two runs), so `resetSimulation()` is mandatory — and EXACTLY ONCE: two
 *   resets in a row leave `consumed` at 0 over 120 s (plan 5.6, unexplained).
 * - **`captureAbortReason` brakes nothing by itself.** After a model change the
 *   reason is set (`src/core/rv-viewer.ts:5151`) but `captureStep(60)` still
 *   counts 60 ticks and `captureRenderFrame` still returns `true`. The check
 *   between frames in {@link advanceSim} is the ONLY brake.
 *
 * Known limits of this clock — a test that needs one of these cannot use it
 * (plan 2.2): exclusive lock (one capture at a time), no WebGPU, no running XR,
 * a model must be loaded with `logicRunState === 'active'`, camera / projection
 * / follow / damping animations are SUSPENDED, the selection is cleared and the
 * DPR is forced to 1 (all restored by `endCapture`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Page } from 'playwright/test';

/** Production fixed-update rate the viewer simulates at. */
export const FIXED_STEP_HZ = 60;

/** The fixed timestep, passed EXPLICITLY to `captureStep` — never defaulted. */
export const FIXED_DT = 1 / FIXED_STEP_HZ;

/**
 * Simulation ticks per rendered frame: 2, i.e. 30 render frames per simulation
 * second. Enough that material keeps moving, and an integral divisor of 60 — so
 * a whole number of simulation seconds leaves no remainder block.
 */
export const STEPS_PER_FRAME = 2;

/** Default capture size — small on purpose; nothing here looks at pixels. */
const CAPTURE_WIDTH = 320;
const CAPTURE_HEIGHT = 200;

/** Window key holding the in-page clock state across `advanceSim` calls. */
const STATE_KEY = '__rvTestClock';

export interface TestClockOptions {
  /** Capture width in px (default 320). */
  width?: number;
  /** Capture height in px (default 200). */
  height?: number;
}

/** What one {@link advanceSim} call did, read back from the page. */
export interface AdvanceResult {
  /** Fixed-update steps executed by THIS call. */
  steps: number;
  /** Rendered frames produced by THIS call. */
  frames: number;
  /** Fixed-update steps since {@link armTestClock}. */
  totalSteps: number;
  /** Rendered frames since {@link armTestClock}. */
  totalFrames: number;
  /** Virtual render time of the NEXT frame, in seconds. Monotone, starts at 0. */
  nextTimeSec: number;
  /** `viewer.simTime` after the call. */
  simTime: number;
  /**
   * Fixed-update ticks since {@link armTestClock} — i.e. the DELTA of
   * `viewer.simTickCount`, not its absolute value. `resetSimulation()` zeroes
   * `simTime` but NOT `simTickCount`, so the absolute counter still carries the
   * wall-clock-bound live phase before `beginCapture` (measured 819 vs. 1007
   * ticks on two runs) and is useless for a determinism comparison.
   */
  ticks: number;
}

/** Transport counters, read straight off `viewer.transportManager`. */
export interface TransportCounters {
  spawned: number;
  consumed: number;
  activeMUs: number;
}

/** Simulation state for determinism comparisons — UNROUNDED (F3). */
export interface SimState {
  simTime: number;
  /** Ticks since {@link armTestClock}; absolute `simTickCount` when unarmed. */
  ticks: number;
  transport: TransportCounters;
  /** Drive name -> `currentPosition`, unrounded. */
  drives: Record<string, number>;
}

/**
 * Takes the viewer over for a deterministic run: `beginCapture` plus
 * `resetSimulation()` EXACTLY once. Throws when the capture preflight refuses
 * (and names the reason) or when a clock is already armed on this page.
 */
export async function armTestClock(page: Page, opts: TestClockOptions = {}): Promise<void> {
  const width = opts.width ?? CAPTURE_WIDTH;
  const height = opts.height ?? CAPTURE_HEIGHT;
  await page.evaluate(
    ({ width: w, height: h, stateKey, stepsPerFrame, hz }) => {
      const win = window as any;
      const v = win.viewer;
      if (!v) throw new Error('armTestClock: window.viewer does not exist — wait for the viewer first');
      if (win[stateKey]) throw new Error('armTestClock: a test clock is already armed on this page (releaseTestClock first)');
      const reason = v.capturePreflight();
      if (reason) throw new Error(`armTestClock: capturePreflight refused the capture: ${reason}`);
      v.beginCapture({ width: w, height: h, frameDt: stepsPerFrame / hz });
      try {
        // PFLICHT and EXACTLY ONCE — see the module header.
        v.resetSimulation();
      } catch (err) {
        v.endCapture();
        throw err;
      }
      // `resetSimulation()` zeroes simTime but not simTickCount — remember the
      // base so every tick number this helper reports is a reproducible delta.
      win[stateKey] = { nextTimeSec: 0, totalFrames: 0, totalSteps: 0, baseTicks: v.simTickCount };
    },
    { width, height, stateKey: STATE_KEY, stepsPerFrame: STEPS_PER_FRAME, hz: FIXED_STEP_HZ },
  );
}

/**
 * Advances the simulation by exactly `steps` fixed updates, rendering a frame
 * after every block of {@link STEPS_PER_FRAME} steps — and after a smaller
 * trailing block too, so two consecutive calls compose.
 *
 * The whole loop runs inside ONE `page.evaluate`: round-tripping per frame
 * would make a 120 s fast-forward (3600 frames) unusable, and the capture has
 * stopped the live loop, so nothing else drives the viewer meanwhile.
 *
 * Fails (rejects) when `captureRenderFrame` returns `false` or when
 * `captureAbortReason` is set between frames — a test must break there, not
 * fast-forward into the void.
 *
 * `steps === 0` is a no-op: no tick, and no frame either (a zero-length block
 * would render at an unchanged virtual time and break monotonicity).
 */
export async function advanceSim(page: Page, steps: number): Promise<AdvanceResult> {
  if (!Number.isInteger(steps) || steps < 0) {
    throw new Error(`advanceSim: steps must be a non-negative integer, got ${steps}`);
  }
  return page.evaluate(
    ({ steps: want, stateKey, stepsPerFrame, fixedDt, hz }) => {
      const win = window as any;
      const v = win.viewer;
      const st = win[stateKey];
      if (!st) throw new Error('advanceSim: test clock not armed (call armTestClock first)');
      if (!v.isCapturing) throw new Error('advanceSim: the viewer is not capturing any more — the clock was released or aborted');

      let remaining = want;
      let frames = 0;
      let stepped = 0;
      while (remaining > 0) {
        const block = Math.min(stepsPerFrame, remaining);
        v.captureStep(block, fixedDt);
        const ok = v.captureRenderFrame(st.nextTimeSec, block / hz);
        if (ok === false) {
          throw new Error(`advanceSim: captureRenderFrame failed at frame ${st.totalFrames} (t=${st.nextTimeSec}s)`);
        }
        // The virtual render clock tracks the simulation time this block
        // covered: `stepsPerFrame / hz` for a full block, less for the
        // trailing one. Monotone, and composable across calls.
        st.nextTimeSec += block / hz;
        st.totalFrames += 1;
        st.totalSteps += block;
        frames += 1;
        stepped += block;
        remaining -= block;
        const abort = v.captureAbortReason;
        if (abort) {
          throw new Error(`advanceSim: the capture was aborted after frame ${st.totalFrames}: ${abort}`);
        }
      }
      return {
        steps: stepped,
        frames,
        totalSteps: st.totalSteps,
        totalFrames: st.totalFrames,
        nextTimeSec: st.nextTimeSec,
        simTime: v.simTime,
        ticks: v.simTickCount - st.baseTicks,
      };
    },
    { steps, stateKey: STATE_KEY, stepsPerFrame: STEPS_PER_FRAME, fixedDt: FIXED_DT, hz: FIXED_STEP_HZ },
  );
}

/** {@link advanceSim} in simulation seconds — `seconds * 60` steps. */
export async function advanceSimSeconds(page: Page, seconds: number): Promise<AdvanceResult> {
  return advanceSim(page, Math.round(seconds * FIXED_STEP_HZ));
}

/**
 * Gives the viewer back: `endCapture()` plus the in-page clock state. Safe to
 * call when nothing is armed (`endCapture` is idempotent), so it belongs in a
 * `finally` — see {@link withTestClock}.
 */
export async function releaseTestClock(page: Page): Promise<void> {
  await page.evaluate((stateKey) => {
    const win = window as any;
    const v = win.viewer;
    win[stateKey] = undefined;
    v?.endCapture?.();
  }, STATE_KEY);
}

/**
 * {@link armTestClock} / {@link releaseTestClock} around `body`, with the
 * release in a `finally` on EVERY path (F4). Prefer this over the raw pair.
 */
export async function withTestClock<T>(
  page: Page,
  body: () => Promise<T>,
  opts: TestClockOptions = {},
): Promise<T> {
  await armTestClock(page, opts);
  try {
    return await body();
  } finally {
    await releaseTestClock(page);
  }
}

/** Reads the simulation state UNROUNDED — the comparison base for F3. */
export async function readSimState(page: Page): Promise<SimState> {
  return page.evaluate((stateKey) => {
    const win = window as any;
    const v = win.viewer;
    const tm = v.transportManager;
    const drives: Record<string, number> = {};
    for (const d of v.drives ?? []) drives[d.name] = d.currentPosition;
    return {
      simTime: v.simTime,
      ticks: v.simTickCount - (win[stateKey]?.baseTicks ?? 0),
      transport: {
        spawned: tm?.totalSpawned ?? -1,
        consumed: tm?.totalConsumed ?? -1,
        activeMUs: tm?.mus?.length ?? -1,
      },
      drives,
    };
  }, STATE_KEY);
}

/** Reads the transport counters on their own. */
export async function readTransport(page: Page): Promise<TransportCounters> {
  return page.evaluate(() => {
    const tm = (window as any).viewer.transportManager;
    return {
      spawned: tm?.totalSpawned ?? -1,
      consumed: tm?.totalConsumed ?? -1,
      activeMUs: tm?.mus?.length ?? -1,
    };
  });
}

/** The capture's abort reason, or null. */
export async function readAbortReason(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as any).viewer.captureAbortReason ?? null);
}

/**
 * Waits for `count` frames that the viewer ACTUALLY rendered — the join point
 * the deferred invariants (I3, I5) are executed at (plan 2.6). Not usable
 * inside a test clock: the capture has stopped the rAF loop, and a frame is
 * produced by {@link advanceSim} instead.
 */
export async function waitForRenderedFrames(page: Page, count = 1, timeoutMs = 10_000): Promise<void> {
  await page.evaluate(
    async ({ count: n, timeoutMs: limit }) => {
      const deadline = Date.now() + limit;
      for (let i = 0; i < n; i++) {
        await new Promise<void>((resolve, reject) => {
          if (Date.now() > deadline) { reject(new Error('waitForRenderedFrames: timed out')); return; }
          requestAnimationFrame(() => resolve());
        });
      }
    },
    { count, timeoutMs },
  );
}
