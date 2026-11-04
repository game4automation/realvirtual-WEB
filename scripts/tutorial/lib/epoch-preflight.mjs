// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * epoch-preflight — the null-epoch preflight of the tutorial recorder as ONE pure decision
 * (plan-2004 § 2.4 step 3a, criterion (iii)/(iv) as decided for B2 on 2026-10-27).
 *
 * ## Why this replaced the per-frame criterion
 *
 * The plan first demanded `|Δ simTime − 1/fps| ≤ 1e-4 s` AND `Δ fixedStepCount == 1` for EVERY
 * preflight frame. Measured on a real viewer that is structurally unsatisfiable at 30 fps: the
 * viewer integrates with `fixedDt = 1/60`, so one recorded frame is TWO fixed steps. On top of that
 * the simulation does not run at all for the first ~0.667 s after the virtual clock is enabled
 * (Δ = 0 for ~20 frames), then catches up in ONE burst frame (Δ = 7..8), and even with coupled
 * rates it jitters by one step now and then (measured at 60 fps: one frame Δ = 2 in 40).
 *
 * ## The rule (orchestrator for Thomas, 2026-10-27)
 *
 * 1. Bounded warm-up: step up to `warmupMaxFrames` (= `framesOf(PREFLIGHT_WARMUP_SEC, fps)`, three
 *    times the measured start-up) until the FIRST frame with Δ fixedStepCount > 0. That frame is the
 *    catch-up burst and belongs to the warm-up. It never comes -> fail: that IS the frozen-epoch
 *    defect (measured: 40 frames with Δ = 0 while `isSimulationPaused === false`).
 * 2. Measurement window of `PREFLIGHT_WINDOW_FRAMES` (= 40, the measured length of the defect)
 *    frames after the warm-up: every frame Δ fixedStepCount ≥ 1, THEN
 *    `|Σ Δ simTime − N/fps| ≤ fixedDtObs + PREFLIGHT_SIM_TOLERANCE_SEC` with
 *    `fixedDtObs = Σ Δ simTime / Σ Δ fixedStepCount`. The order is binding: the per-frame check
 *    guarantees `Σ Δ fixedStepCount > 0`, so the division never divides by zero. The tolerance is
 *    ONE fixed step — exactly the measured jitter — and catches a frozen clock, half and double
 *    speed. `fixedDtObs` is read from the page, the viewer stays unchanged.
 *
 * The two epoch checks of § 2.4 step 3a decide first, in the same function: (i) the epoch read
 * before `__vt.enable()` must be > 0, and (ii) `performance.now()` must never be below that epoch
 * after enabling (`nowAtLeastEpoch` per reading) — exactly the measured defect, where an epoch of 0
 * made `performance.now()` jump backwards and every `dt` in the page negative.
 *
 * This module replaced `preflightVerdict` / `PREFLIGHT_FRAMES` in `scene-probe.mjs`; there is ONE
 * preflight decision.
 *
 * Paused starts (plan-2031 F5a) check only the epoch before capture. Simulation progress is
 * checked after the recorded resume, over a short window using the effective DES multiplier.
 */

/** Warm-up budget in seconds; the caller converts it with `framesOf(sec, fps)`. */
export const PREFLIGHT_WARMUP_SEC = 2;
/** Measurement window in frames — the measured length of the frozen-epoch defect. */
export const PREFLIGHT_WINDOW_FRAMES = 40;
/** Resolution allowance on top of one fixed step, in seconds (the measured log resolution was 1e-5). */
export const PREFLIGHT_SIM_TOLERANCE_SEC = 1e-4;

function isReading(sample) {
  return sample != null && Number.isFinite(sample.simTime) && Number.isFinite(sample.fixedStepCount);
}

export function clockOnlyVerdict({ samples, epoch }) {
  const report = { verdict: 'fail', diagnosis: 'virtual-clock-epoch', reason: null,
    epoch: epoch ?? null, checkedFrames: samples.length };
  if (!Number.isFinite(epoch) || epoch <= 0) report.reason = 'epoch must be a finite number > 0';
  else if (samples.length === 0) report.reason = 'no clock samples read';
  else if (samples.some((sample) => !Number.isFinite(sample?.now))) report.reason = 'performance.now() must be finite';
  else if (samples.some((sample) => sample.now < epoch)) report.reason = 'performance.now() went below the epoch';
  else if (samples.some((sample, i) => i > 0 && sample.now < samples[i - 1].now)) report.reason = 'performance.now() must be monotonic';
  else { report.verdict = 'ok'; report.diagnosis = null; }
  return report;
}

/** Minimum window for the DES fallback (no render clock available): event jumps need a long window. */
export const DES_FALLBACK_WINDOW_FRAMES = 30;

/** The largest DES event gap allowed, as a share of the expected progress, for the fallback to decide. */
export const DES_FALLBACK_MAX_GAP_RATIO = 0.2;

/**
 * Simulation progress after a recorded resume. In hybrid DES `simTime` advances in EVENT jumps, so
 * its sum over a short window is quantised by the event gaps. A sample therefore may carry
 * `renderClock` (the DES runner's continuous animation clock) and `des: true`:
 *  - every sample has a finite `renderClock` -> progress is measured on it, tolerance one fixed step
 *    times the factor (as for the continuous clock);
 *  - `des: true` without a render clock -> simTime over a window of >= 30 frames, tolerance base + the
 *    largest simTime jump in the window, and `indeterminate` (not ok) when that jump exceeds 20 % of the
 *    expected progress;
 *  - otherwise (non-DES) -> unchanged simTime check.
 */
export function simProgressVerdict({ samples, fps, factor, windowFrames = samples.length - 1 }) {
  const report = { verdict: 'fail', diagnosis: 'sim-progress', reason: null, factor, windowFrames,
    sumSimTime: null, expectedSimTime: null, deviation: null, tolerance: null, clock: 'simTime' };
  if (!Number.isFinite(factor) || factor <= 0) report.reason = 'factor must be finite and > 0';
  else if (!Number.isFinite(fps) || fps <= 0) report.reason = 'fps must be finite and > 0';
  else if (samples.length - 1 < 3) report.reason = 'window too short';
  else if (windowFrames !== samples.length - 1) report.reason = 'windowFrames must equal samples.length - 1';
  else if (!samples.every(isReading)) report.reason = 'non-finite simTime/fixedStepCount reading';
  if (report.reason) return report;
  const des = samples.some((s) => s.des === true);
  const useRender = des && samples.every((s) => Number.isFinite(s.renderClock));
  const clockOf = (s) => (useRender ? s.renderClock : s.simTime);
  report.clock = useRender ? 'renderClock' : 'simTime';
  if (des && !useRender && windowFrames < DES_FALLBACK_WINDOW_FRAMES) {
    report.reason = `DES without render clock needs a window of >= ${DES_FALLBACK_WINDOW_FRAMES} frames, got ${windowFrames}`;
    return report;
  }
  const sumSimTime = clockOf(samples.at(-1)) - clockOf(samples[0]);
  const expectedSimTime = factor * windowFrames / fps;
  // The viewer uses a 1/60 s fixed step. Observed simTime per step already contains
  // the speed being checked, so it cannot independently determine this allowance.
  let tolerance = factor * (1 / 60) + PREFLIGHT_SIM_TOLERANCE_SEC;
  if (des && !useRender) {
    let maxJump = 0;
    for (let i = 1; i < samples.length; i++) maxJump = Math.max(maxJump, samples[i].simTime - samples[i - 1].simTime);
    // One event gap larger than a fifth of the expected progress makes the speed indeterminate:
    // a wrong speed could hide inside that single jump. Never report success then.
    if (maxJump > DES_FALLBACK_MAX_GAP_RATIO * expectedSimTime) {
      Object.assign(report, { sumSimTime, expectedSimTime });
      report.verdict = 'indeterminate';
      report.reason = `sim-progress indeterminate: event gap ${maxJump} s too large for window ${expectedSimTime} s`;
      return report;
    }
    tolerance += maxJump;
  }
  const deviation = Math.abs(sumSimTime - expectedSimTime);
  Object.assign(report, { sumSimTime, expectedSimTime, deviation, tolerance });
  if (![sumSimTime, expectedSimTime, deviation, tolerance].every(Number.isFinite)) {
    report.reason = 'non-finite simulation progress calculation';
  } else if (deviation > tolerance) {
    report.reason = `simulation advanced ${sumSimTime} s (${report.clock}), expected ${expectedSimTime} s +/- ${tolerance} s`;
  } else { report.verdict = 'ok'; report.diagnosis = null; }
  return report;
}

/**
 * Index (into `samples`) of the frame that ends the warm-up: the first `i ≥ 1` with
 * `fixedStepCount[i] − fixedStepCount[i−1] > 0`, looked for within the first `warmupMaxFrames`
 * frames. Returns `null` while undecided (fewer frames read than the budget) and `-1` once the
 * budget is spent without any step — the runner stops stepping on anything but `null`.
 *
 * @param {{ simTime: number, fixedStepCount: number }[]} samples readings; `samples[0]` is taken
 *   BEFORE the first preflight step, `samples[k]` after the k-th
 * @param {number} warmupMaxFrames
 * @returns {number | null}
 */
export function warmupEndIndex(samples, warmupMaxFrames) {
  const last = Math.min(samples.length - 1, warmupMaxFrames);
  for (let i = 1; i <= last; i++) {
    if (!isReading(samples[i]) || !isReading(samples[i - 1])) return -1;
    if (samples[i].fixedStepCount - samples[i - 1].fixedStepCount > 0) return i;
  }
  return samples.length - 1 >= warmupMaxFrames ? -1 : null;
}

/**
 * The preflight decision over the complete reading sequence.
 *
 * @param {{
 *   samples: { simTime: number, fixedStepCount: number, nowAtLeastEpoch?: boolean }[],
 *   fps: number,
 *   warmupMaxFrames: number,
 *   epoch?: number,
 *   windowFrames?: number,
 * }} input
 * @returns {{
 *   verdict: 'ok' | 'fail',
 *   diagnosis: 'virtual-clock-epoch' | null,
 *   reason: string | null,
 *   epoch: number | null,
 *   warmupFrames: number | null,
 *   windowFrames: number,
 *   window: { dSimTime: number, dSteps: number }[],
 *   sumSimTime: number | null,
 *   sumSteps: number | null,
 *   expectedSimTime: number,
 *   fixedDtObs: number | null,
 *   deviation: number | null,
 *   tolerance: number | null,
 *   firstViolationFrame: number | null,
 * }}
 */
export function preflightVerdict({ samples, fps, warmupMaxFrames, epoch = undefined, windowFrames = PREFLIGHT_WINDOW_FRAMES }) {
  if (!Number.isFinite(fps) || fps <= 0) throw new Error(`preflightVerdict: fps must be > 0, got ${fps}`);
  if (!Number.isInteger(warmupMaxFrames) || warmupMaxFrames < 1) {
    throw new Error(`preflightVerdict: warmupMaxFrames must be a positive integer, got ${warmupMaxFrames}`);
  }
  const expectedSimTime = windowFrames / fps;
  const report = {
    verdict: 'fail',
    diagnosis: 'virtual-clock-epoch',
    reason: null,
    epoch: epoch ?? null,
    warmupFrames: null,
    windowFrames,
    window: [],
    sumSimTime: null,
    sumSteps: null,
    expectedSimTime,
    fixedDtObs: null,
    deviation: null,
    tolerance: null,
    firstViolationFrame: null,
  };

  // (i) and (ii): the epoch defect itself. Checked before any reading is interpreted.
  if (epoch !== undefined && !(epoch > 0)) {
    report.reason = `(i) epoch must be > 0, got ${String(epoch)} — with epoch 0 performance.now() jumps backwards and every dt stays negative`;
    return report;
  }
  const backwards = samples.findIndex((s) => s?.nowAtLeastEpoch === false);
  if (backwards >= 0) {
    report.reason = `(ii) performance.now() went below the epoch at preflight frame ${backwards}`;
    report.firstViolationFrame = backwards;
    return report;
  }

  const end = warmupEndIndex(samples, warmupMaxFrames);
  if (end === null || end === -1) {
    const missing = samples.slice(0, Math.min(samples.length, warmupMaxFrames + 1)).findIndex((s) => !isReading(s));
    report.reason = missing >= 0
      ? `simTime/fixedStepCount reading missing at preflight frame ${missing}`
      : end === null
        ? `warm-up undecided: only ${Math.max(0, samples.length - 1)} of ${warmupMaxFrames} warm-up frames read`
        : `simulation never advanced: fixedStepCount unchanged over ${warmupMaxFrames} warm-up frames`;
    return report;
  }
  report.warmupFrames = end;

  if (samples.length - 1 - end < windowFrames) {
    report.reason = `window incomplete: ${samples.length - 1 - end} of ${windowFrames} frames read after the warm-up`;
    return report;
  }

  // 1) Per frame: every window frame must carry at least one fixed step. This check comes FIRST —
  //    it is what makes Σ Δ fixedStepCount > 0 and the division below safe.
  for (let k = 1; k <= windowFrames; k++) {
    const prev = samples[end + k - 1];
    const cur = samples[end + k];
    if (!isReading(cur)) {
      report.reason = `simTime/fixedStepCount reading missing at window frame ${k - 1}`;
      report.firstViolationFrame = k - 1;
      return report;
    }
    const dSteps = cur.fixedStepCount - prev.fixedStepCount;
    const dSimTime = cur.simTime - prev.simTime;
    report.window.push({ dSimTime, dSteps });
    if (!(dSteps >= 1)) {
      report.reason = `window frame ${k - 1}: Δ fixedStepCount = ${dSteps}, expected ≥ 1`;
      report.firstViolationFrame = k - 1;
      return report;
    }
  }

  // 2) Over the window: simulation time must match the recorded time within one fixed step.
  let sumSimTime = 0;
  let sumSteps = 0;
  for (const d of report.window) {
    sumSimTime += d.dSimTime;
    sumSteps += d.dSteps;
  }
  const fixedDtObs = sumSimTime / sumSteps;
  const deviation = Math.abs(sumSimTime - expectedSimTime);
  const tolerance = fixedDtObs + PREFLIGHT_SIM_TOLERANCE_SEC;
  Object.assign(report, { sumSimTime, sumSteps, fixedDtObs, deviation, tolerance });
  if (!(deviation <= tolerance)) {
    report.reason = `Σ Δ simTime = ${sumSimTime.toFixed(6)} s over ${windowFrames} frames, expected `
      + `${expectedSimTime.toFixed(6)} s ± ${tolerance.toFixed(6)} s (one fixed step)`;
    return report;
  }
  report.verdict = 'ok';
  report.diagnosis = null;
  return report;
}
