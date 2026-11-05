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

/** plan-2237 F6: the preflight clock — the DES render clock when the sample carries one, else simTime. */
function preflightClockOf(sample) {
  return sample.des === true && Number.isFinite(sample.renderClock) ? sample.renderClock : sample.simTime;
}

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
export function preflightVerdict({ samples, fps, warmupMaxFrames, epoch = undefined, windowFrames = PREFLIGHT_WINDOW_FRAMES, factor = 1 }) {
  if (!Number.isFinite(fps) || fps <= 0) throw new Error(`preflightVerdict: fps must be > 0, got ${fps}`);
  if (!Number.isInteger(warmupMaxFrames) || warmupMaxFrames < 1) {
    throw new Error(`preflightVerdict: warmupMaxFrames must be a positive integer, got ${warmupMaxFrames}`);
  }
  // plan-2237 F6: the expected progress follows the factor read from `sim.clock.get` (default 1).
  const speed = Number.isFinite(factor) ? factor : 1;
  const expectedSimTime = speed * windowFrames / fps;
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
    // plan-2237 F6: in DES the tempo clock is the render clock — `simTime` is the EVENT time and
    // stays at 0 for the first frames after Play (measured), so a running DES start measured 0 s.
    const dSimTime = preflightClockOf(cur) - preflightClockOf(prev);
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

// ─── plan-2237: the segment gate ─────────────────────────────────────────────────────────────────

/** The viewer's fixed-step rate in Hz (`fixedDt = 1/60`). */
export const FIXED_STEP_HZ = 60;
/** I1 (takt): the cumulative step count may deviate from `(60/fps)·N` by at most ONE fixed step. */
export const I1_TOLERANCE_STEPS = 1;
/** I2 (integrator): `|Σ Δclock − Σ ΔfixedStepCount·f/60| ≤ 1e-6 s · N` — exact up to float noise. */
export const I2_TOLERANCE_PER_FRAME_SEC = 1e-6;
/** A segment with fewer evaluable frames is `short` (reported, never red). */
export const MIN_SEGMENT_FRAMES = 3;
/** Float noise allowed for "the clock stood still" (hold) and for the jump test. */
const CLOCK_EPS = 1e-9;

/**
 * plan-2237 F3 — the commands that change tempo or time. A segment ends BEFORE each of them; the
 * dispatch frame up to the command's completion plus one frame is a transition (F5).
 */
export const TIME_COMMANDS = Object.freeze([
  'des.setMode', 'des.fastForward', 'des.checkpoint.load', 'des.step', 'snapshot.load',
  'experiment.snapshot.load', 'sim.reset', 'sim.speedOverride', 'sim.playPause',
]);

/**
 * Normalises one `sim.clock.get` value (plan-2237 F2) into a gate sample. Returns null for an
 * unreadable value.
 */
export function clockSampleOf(value) {
  if (!value || typeof value !== 'object' || !Number.isFinite(value.fixedStepCount) || !Number.isFinite(value.simTime)) return null;
  const des = value.mode === 'des' && value.des ? value.des : null;
  return {
    mode: des ? 'des' : 'continuous',
    paused: value.paused === true,
    simTime: value.simTime,
    fixedStepCount: value.fixedStepCount,
    factor: value.factor === null || value.factor === undefined ? null : Number(value.factor),
    subMode: des ? String(des.subMode) : null,
    renderClock: des && Number.isFinite(des.renderClock) ? des.renderClock : null,
    endTime: des && Number.isFinite(des.endTime) ? des.endTime : null,
    clampBudget: des ? Number(des.clampCounts?.budget ?? 0) : 0,
    clampEnd: des ? Number(des.clampCounts?.end ?? 0) : 0,
  };
}

/** The tempo clock of a sample: DES -> render clock, continuous -> simTime. */
export function gateClockOf(sample) {
  return sample.mode === 'des' && Number.isFinite(sample.renderClock) ? sample.renderClock : sample.simTime;
}

/** The state that defines a segment; a change ends the segment even without a recorder command. */
export function gateStateKey(sample) {
  return `${sample.mode}|${sample.paused}|${sample.factor}|${sample.subMode ?? ''}`;
}

function isHoldState(sample) {
  return sample.paused === true || sample.factor === 0 || (sample.mode === 'des' && sample.subMode === 'step');
}

function isSample(sample) {
  return sample != null && Number.isFinite(sample.fixedStepCount) && Number.isFinite(gateClockOf(sample));
}

/**
 * plan-2237 F3-F5 — the simulation-time gate of a whole take, as ONE pure decision.
 *
 * `samples[k]` is the `clockSampleOf` reading after output frame k. `windows` are the frames the
 * runner excludes: `{ start, end, cmd, kind: 'transition' | 'timelapse' }`, both bounds inclusive
 * (a time command: dispatch frame .. completion frame + 1; a time-lapse: its wall-clock frames
 * plus the first frame after `wallEnd`).
 *
 * Per frame k ≥ 1 (Δ = sample k − sample k−1):
 *  - inside a window, or the state (`mode | paused | factor | subMode`) changed -> transition: not
 *    evaluated; `Δclock < 0` or `|Δclock| > max(1,f)·(ΔfixedStepCount+1)/60` (f = the larger factor
 *    before/after the frame; null = any change) records ONE `simJumps` entry for the window;
 *  - a DES clamp proven by the viewer (`clampCounts` grew — `_advanceTimed` set `clampedAt`) ->
 *    the frame is `clamped`, unevaluated; `'end'` keeps every later frame clamped until the next
 *    state change. Equal clocks alone are NEVER taken as a clamp;
 *  - else the frame is evaluated in the open segment, which bases on the sample BEFORE its first
 *    frame (rebase after every transition and clamp, so no deficit stays in the sum).
 *
 * A segment is judged cumulatively over its prefix, never reset per block: run -> I1
 * `|ΣΔsteps − (60/fps)·k| ≤ 1` and I2 `|ΣΔclock − ΣΔsteps·f/60| ≤ 1e-6·k` at every prefix k; hold
 * (paused, DES step, factor 0) -> Δclock = 0 at every prefix; jump (DES fastforward, factor null)
 * -> skipped; fewer than 3 frames -> short.
 */
export function segmentGate({ samples, fps, windows = [] }) {
  if (!Number.isFinite(fps) || fps <= 0) throw new Error(`segmentGate: fps must be > 0, got ${fps}`);
  const stepsPerFrame = FIXED_STEP_HZ / fps;
  // `sumSimTime` / `expectedSimTime` / `deviation` / `tolerance` keep the meaning of the report
  // before plan-2237, now taken over the FIRST judged run segment (null without one):
  // clock advance, `factor · frames / fps`, their distance, and one fixed step at the factor plus
  // the I2 allowance. A passing segment always has `deviation ≤ tolerance`.
  const report = { verdict: 'ok', diagnosis: null, reason: null, segments: [], simJumps: [], factor: null, clock: null,
    sumSimTime: null, expectedSimTime: null, deviation: null, tolerance: null };
  const unreadable = samples.findIndex((sample) => !isSample(sample));
  if (unreadable >= 0) {
    return { ...report, verdict: 'fail', diagnosis: 'sim-progress', reason: `sim.clock.get reading missing or not finite at frame ${unreadable}` };
  }
  const windowAt = new Map();
  for (const w of windows) for (let f = w.start; f <= w.end; f++) if (!windowAt.has(f)) windowAt.set(f, w);

  let open = null;     // evaluated segment in progress
  let clamped = null;  // run of clamped frames in progress
  let group = null;    // transition group in progress (one window or one state change)
  let ended = false;   // 'end' clamp latched until the next state change

  const closeOpen = () => {
    if (!open) return;
    const seg = open;
    open = null;
    const factor = seg.factor;
    const entry = { index: report.segments.length, startFrame: seg.startFrame, endFrame: seg.endFrame,
      kind: 'run', factor, clock: seg.clock, i1: seg.maxI1, i2: seg.maxI2, verdict: 'pass',
      frames: seg.frames, sumClock: seg.sumClock, sumSteps: seg.sumSteps };
    if (seg.hold) entry.kind = 'hold';
    else if (factor === null) entry.kind = 'jump';
    if (seg.frames < MIN_SEGMENT_FRAMES) { entry.kind = 'short'; entry.verdict = 'short'; }
    else if (entry.kind === 'jump') entry.verdict = 'skipped';
    else if (seg.failFrame !== null) {
      entry.verdict = 'fail';
      if (report.verdict !== 'fail') {
        report.verdict = 'fail';
        report.diagnosis = 'sim-progress';
        report.reason = `segment ${entry.index} (${entry.kind}, frames ${seg.startFrame}..${seg.endFrame}, factor ${factor}, ${seg.clock}): ${seg.failReason} at frame ${seg.failFrame}`;
      }
    }
    if (entry.kind === 'run' && entry.verdict !== 'short' && report.factor === null) {
      report.factor = factor;
      report.clock = seg.clock;
      report.sumSimTime = seg.sumClock;
      report.expectedSimTime = factor * seg.frames / fps;
      report.deviation = Math.abs(report.sumSimTime - report.expectedSimTime);
      report.tolerance = I1_TOLERANCE_STEPS * factor / FIXED_STEP_HZ + I2_TOLERANCE_PER_FRAME_SEC * seg.frames;
    }
    report.segments.push(entry);
  };
  const closeClamped = () => {
    if (!clamped) return;
    report.segments.push({ index: report.segments.length, startFrame: clamped.startFrame, endFrame: clamped.endFrame,
      kind: 'run', factor: clamped.factor, clock: 'renderClock', i1: 0, i2: 0, verdict: 'clamped', clampedAt: clamped.kind });
    clamped = null;
  };
  const closeGroup = () => {
    if (!group) return;
    if (group.kind === 'timelapse') {
      report.segments.push({ index: report.segments.length, startFrame: group.startFrame, endFrame: group.endFrame,
        kind: 'timelapse', factor: null, clock: group.clock, i1: 0, i2: 0, verdict: 'skipped', cmd: group.cmd });
    }
    if (group.jumpFrame !== null) {
      report.simJumps.push({ frame: group.jumpFrame, cmd: group.cmd, fromSim: group.fromSim, toSim: group.toSim });
    }
    group = null;
  };

  for (let k = 1; k < samples.length; k++) {
    const prev = samples[k - 1];
    const cur = samples[k];
    const sameMode = prev.mode === cur.mode;
    const dClock = sameMode ? gateClockOf(cur) - gateClockOf(prev) : cur.simTime - prev.simTime;
    const dSteps = cur.fixedStepCount - prev.fixedStepCount;
    const w = windowAt.get(k) ?? null;
    const stateChanged = gateStateKey(cur) !== gateStateKey(prev);

    if (w || stateChanged) {
      closeOpen();
      closeClamped();
      ended = false;
      // One group per window; a state change outside a window is a one-frame group of its own.
      if (!group || !w || group.window !== w) {
        closeGroup();
        group = { window: w, cmd: w ? w.cmd : 'state-change', kind: w?.kind ?? 'transition', startFrame: k, endFrame: k,
          fromSim: sameMode ? gateClockOf(prev) : prev.simTime, toSim: null, jumpFrame: null,
          clock: cur.mode === 'des' ? 'renderClock' : 'simTime' };
      }
      group.endFrame = k;
      group.toSim = sameMode ? gateClockOf(cur) : cur.simTime;
      // The larger of the two factors: a tempo change applies within its own dispatch frame.
      const f = prev.factor === null || cur.factor === null ? null : Math.max(prev.factor, cur.factor);
      const limit = f === null ? 0 : Math.max(1, f) * (dSteps + 1) / FIXED_STEP_HZ;
      if (group.jumpFrame === null && (dClock < -CLOCK_EPS || Math.abs(dClock) > limit + CLOCK_EPS)) group.jumpFrame = k;
      continue;
    }
    closeGroup();

    const clampedNow = cur.mode === 'des' && (cur.clampBudget > prev.clampBudget || cur.clampEnd > prev.clampEnd);
    if (ended || clampedNow) {
      closeOpen();
      const kind = ended || cur.clampEnd > prev.clampEnd ? 'end' : 'budget';
      if (kind === 'end') ended = true;
      if (!clamped) clamped = { startFrame: k, endFrame: k, kind, factor: cur.factor };
      clamped.endFrame = k;
      if (kind === 'end') clamped.kind = 'end';
      continue;
    }
    closeClamped();

    if (!open) {
      open = { base: prev, startFrame: k, endFrame: k, frames: 0, factor: cur.factor, hold: isHoldState(cur),
        clock: cur.mode === 'des' ? 'renderClock' : 'simTime', maxI1: 0, maxI2: 0, failFrame: null, failReason: null,
        sumClock: 0, sumSteps: 0 };
    }
    open.frames++;
    open.endFrame = k;
    open.sumClock = gateClockOf(cur) - gateClockOf(open.base);
    open.sumSteps = cur.fixedStepCount - open.base.fixedStepCount;
    if (open.factor === null && !open.hold) continue; // jump segment: not evaluated
    const n = open.frames;
    const sumSteps = cur.fixedStepCount - open.base.fixedStepCount;
    const sumClock = gateClockOf(cur) - gateClockOf(open.base);
    if (open.hold) {
      const i2 = Math.abs(sumClock);
      open.maxI2 = Math.max(open.maxI2, i2);
      if (open.failFrame === null && i2 > CLOCK_EPS) {
        open.failFrame = k;
        open.failReason = `hold segment: clock moved ${sumClock} s`;
      }
      continue;
    }
    const i1 = Math.abs(sumSteps - stepsPerFrame * n);
    const i2 = Math.abs(sumClock - sumSteps * open.factor / FIXED_STEP_HZ);
    open.maxI1 = Math.max(open.maxI1, i1);
    open.maxI2 = Math.max(open.maxI2, i2);
    if (open.failFrame === null) {
      if (i1 > I1_TOLERANCE_STEPS + CLOCK_EPS) {
        open.failFrame = k;
        open.failReason = `I1: ${sumSteps} fixed steps over ${n} frames, expected ${stepsPerFrame * n} ± ${I1_TOLERANCE_STEPS}`;
      } else if (i2 > I2_TOLERANCE_PER_FRAME_SEC * n) {
        open.failFrame = k;
        open.failReason = `I2: clock advanced ${sumClock} s, ${sumSteps} steps at factor ${open.factor} give ${sumSteps * open.factor / FIXED_STEP_HZ} s`;
      }
    }
  }
  closeOpen();
  closeClamped();
  closeGroup();
  return report;
}

/**
 * plan-2237 F3 (review 2026-11-04) — the transition windows of time commands, from the take-wide
 * watch (`__rvRecording.armTimeWatch`), whoever dispatched them: recorder action, UI click or
 * shortcut. `eventsAt[k]` are the watch events drained after frame k. Per id, a `dispatch` opens a
 * window at its frame, the next `done` closes it one frame after its own (F5). A dispatch never
 * completed stays open to the last frame; a completion without a seen dispatch is a window of its
 * own frame plus one.
 */
export function timeCommandWindows(eventsAt, lastFrame) {
  const open = new Map();
  const windows = [];
  for (let k = 0; k < eventsAt.length; k++) {
    for (const event of eventsAt[k] ?? []) {
      if (!event || typeof event.id !== 'string') continue;
      if (event.phase === 'dispatch') {
        if (!open.has(event.id)) open.set(event.id, []);
        open.get(event.id).push(k);
      } else if (event.phase === 'done') {
        const starts = open.get(event.id);
        const start = starts && starts.length > 0 ? starts.shift() : k;
        windows.push({ start, end: k + 1, cmd: event.id, kind: 'transition' });
      }
    }
  }
  for (const [id, starts] of open) for (const start of starts) windows.push({ start, end: lastFrame, cmd: id, kind: 'transition' });
  return windows.sort((a, b) => a.start - b.start);
}
