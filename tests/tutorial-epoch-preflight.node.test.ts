// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2004 — the null-epoch preflight as decided for B2 on 2026-10-27.
 *
 * The sequences below are the MEASURED shapes from the real-viewer runs of 2026-10-27, not
 * invented ones: at 30 fps the simulation stands still for ~20 frames, catches up in one burst
 * frame (Δ = 7..8) and then steps Δ = 2 per frame (fixedDt 1/60); at 60 fps one frame in 40
 * jittered to Δ = 2. The three failure shapes the decision names explicitly — frozen clock, half
 * speed, double speed — each have their own case.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  clockOnlyVerdict,
  PREFLIGHT_SIM_TOLERANCE_SEC,
  PREFLIGHT_WINDOW_FRAMES,
  preflightVerdict,
  segmentGate,
  simProgressVerdict,
  TIME_COMMANDS,
  timeCommandWindows,
  warmupEndIndex,
  type GateSample,
  type GateWindow,
  type PreflightSample,
} from '../scripts/tutorial/lib/epoch-preflight.mjs';

const FIXED_DT = 1 / 60;
const FPS_30 = 30;
const FPS_60 = 60;
/** framesOf(PREFLIGHT_WARMUP_SEC = 2, fps) — hand-computed so the test does not reuse the rule. */
const WARMUP_MAX_30 = 60;
const WARMUP_MAX_60 = 120;

/** Builds readings from per-frame step deltas; simTime advances by `simPerStep` per fixed step. */
function samplesFrom(stepDeltas: number[], simPerStep = FIXED_DT): PreflightSample[] {
  const samples: PreflightSample[] = [{ simTime: 0, fixedStepCount: 1000 }];
  for (const d of stepDeltas) {
    const prev = samples[samples.length - 1];
    samples.push({ simTime: prev.simTime + d * simPerStep, fixedStepCount: prev.fixedStepCount + d });
  }
  return samples;
}

const repeat = (value: number, count: number): number[] => Array.from({ length: count }, () => value);

describe('paused-start preflight (plan-2031 F5a)', () => {
  it('Test_ClockOnly_PositiveEpochAndForwardClock_Passes', () => {
    const report = clockOnlyVerdict({
      samples: [12, 13, 13, 14].map((now) => ({ now })),
      epoch: 12,
    });
    expect(report).toMatchObject({ verdict: 'ok', diagnosis: null, reason: null, epoch: 12, checkedFrames: 4 });
  });

  it('Test_ClockOnly_EpochZero_Fails', () => {
    const report = clockOnlyVerdict({ samples: [{ now: 12 }], epoch: 0 });
    expect(report).toMatchObject({ verdict: 'fail', diagnosis: 'virtual-clock-epoch' });
    expect(report.reason).toMatch(/epoch/);
  });

  it('Test_ClockOnly_OneClockBelowEpoch_Fails', () => {
    const report = clockOnlyVerdict({
      samples: [12, 11, 13].map((now) => ({ now })),
      epoch: 12,
    });
    expect(report).toMatchObject({ verdict: 'fail', diagnosis: 'virtual-clock-epoch' });
    expect(report.reason).toMatch(/below the epoch/);
  });

  it('Test_ClockOnly_EmptySamples_Fails', () => {
    const report = clockOnlyVerdict({ samples: [], epoch: 12 });
    expect(report).toMatchObject({ verdict: 'fail', diagnosis: 'virtual-clock-epoch' });
    expect(report.reason).toMatch(/no clock samples/);
  });

  it('Test_ClockOnly_BackwardsAboveEpoch_Fails', () => {
    const report = clockOnlyVerdict({ samples: [110, 109, 108].map((now) => ({ now })), epoch: 100 });
    expect(report).toMatchObject({ verdict: 'fail', diagnosis: 'virtual-clock-epoch' });
    expect(report.reason).toMatch(/monotonic/);
  });

  it.each([NaN, Infinity, -Infinity])('Test_ClockOnly_NonFinite%s_Fails', (now) => {
    const report = clockOnlyVerdict({ samples: [{ now: 100 }, { now }], epoch: 100 });
    expect(report.verdict).toBe('fail');
    expect(report.reason).toMatch(/finite/);
  });

  it('Test_ClockOnly_PausedSimulation_PassesWhileRunningPreflightFails', () => {
    const samples = repeat(0, WARMUP_MAX_30 + PREFLIGHT_WINDOW_FRAMES + 1)
      .map((_, i) => ({ simTime: 0, fixedStepCount: 0, now: 12 + i, nowAtLeastEpoch: true }));
    expect(clockOnlyVerdict({ samples, epoch: 12 })).toMatchObject({ verdict: 'ok', reason: null });
    const runningReport = preflightVerdict({ samples, epoch: 12, fps: FPS_30, warmupMaxFrames: WARMUP_MAX_30 });
    expect(runningReport.verdict).toBe('fail');
    expect(runningReport.reason).toMatch(/never advanced/);
  });

  it('Test_SimProgress_FiveTimesSpeed_PassesWithMatchingFactor', () => {
    const samples = samplesFrom(repeat(2, 10), 5 / 60);
    expect(samples).toHaveLength(11);
    const report = simProgressVerdict({ samples, fps: FPS_30, factor: 5, windowFrames: 10 });
    expect(report).toMatchObject({ verdict: 'ok', diagnosis: null, reason: null });
    expect(report.sumSimTime).toBeCloseTo(5 * 10 / 30, 12);
    expect(report.expectedSimTime).toBeCloseTo(5 * 10 / 30, 12);
  });

  it('Test_SimProgress_FiveTimesSpeedWithFactorOne_Fails', () => {
    const report = simProgressVerdict({
      samples: samplesFrom(repeat(2, 10), 5 / 60), fps: FPS_30, factor: 1, windowFrames: 10,
    });
    expect(report).toMatchObject({ verdict: 'fail', diagnosis: 'sim-progress' });
    expect(report.reason).toMatch(/simulation advanced/);
  });

  it.each([10, 50])('Test_SimProgress_WrongSpeedAt%sTimes_Fails', (factor) => {
    for (const actualFactor of [factor / 2, factor * 2]) {
      const report = simProgressVerdict({
        samples: samplesFrom(repeat(2, 10), actualFactor / 60), fps: FPS_30, factor,
      });
      expect(report).toMatchObject({ verdict: 'fail', diagnosis: 'sim-progress' });
      expect(report.tolerance).toBeCloseTo(factor / 60 + PREFLIGHT_SIM_TOLERANCE_SEC, 12);
    }
    expect(simProgressVerdict({
      samples: samplesFrom(repeat(2, 10), factor / 60), fps: FPS_30, factor,
    }).verdict).toBe('ok');
  });

  it('Test_SimProgress_NormalSpeedWithFactorOne_Passes', () => {
    const report = simProgressVerdict({
      samples: samplesFrom(repeat(2, 10)), fps: FPS_30, factor: 1, windowFrames: 10,
    });
    expect(report).toMatchObject({ verdict: 'ok', diagnosis: null, reason: null });
    expect(report.sumSimTime).toBeCloseTo(10 / 30, 12);
  });

  it('Test_SimProgress_FrozenSimulation_Fails', () => {
    const report = simProgressVerdict({
      samples: samplesFrom(repeat(0, 10)), fps: FPS_30, factor: 5, windowFrames: 10,
    });
    expect(report).toMatchObject({ verdict: 'fail', diagnosis: 'sim-progress', sumSimTime: 0 });
    expect(report.reason).toMatch(/simulation advanced/);
  });

  it.each([0, 1, 2])('Test_SimProgress_WindowOf%sFrames_FailsWithReason', (windowFrames) => {
    const report = simProgressVerdict({
      samples: samplesFrom(repeat(2, windowFrames)), fps: FPS_30, factor: 1, windowFrames,
    });
    expect(report).toMatchObject({ verdict: 'fail', diagnosis: 'sim-progress' });
    expect(report.reason).toMatch(/window too short/);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'Test_SimProgress_NonFiniteInput%s_ReturnsFailureReports', (value) => {
      const samples = samplesFrom(repeat(2, 10));
      for (const field of ['factor', 'fps', 'simTime', 'fixedStepCount'] as const) {
        const readings = samples.map((sample, i) => i === 5 && (field === 'simTime' || field === 'fixedStepCount')
          ? { ...sample, [field]: value } : sample);
        const input = {
          samples: readings, fps: field === 'fps' ? value : FPS_30,
          factor: field === 'factor' ? value : 1, windowFrames: 10,
        };
        expect(() => simProgressVerdict(input)).not.toThrow();
        const report = simProgressVerdict(input);
        expect(report).toMatchObject({ verdict: 'fail', diagnosis: 'sim-progress' });
        expect(report.reason).toMatch(/finite/);
      }
    },
  );

  it.each([9, 11])('Test_SimProgress_MismatchingWindow%s_Fails', (windowFrames) => {
    const report = simProgressVerdict({
      samples: samplesFrom(repeat(2, 10)), fps: FPS_30, factor: 1, windowFrames,
    });
    expect(report).toMatchObject({ verdict: 'fail', diagnosis: 'sim-progress' });
    expect(report.reason).toMatch(/windowFrames must equal/);
  });

  it.each([
    { extraSteps: 5, verdict: 'ok' },
    { extraSteps: 15, verdict: 'fail' },
  ])('Test_SimProgress_ToleranceWith$extraStepsExtraSteps_Returns$verdict', ({ extraSteps, verdict }) => {
    // Keep the observed fixed step at 1/60 s: 100 nominal steps, plus one or three
    // factor-scaled steps of jitter. Two steps/frame at 5x would observe 5/60 instead.
    const deltas = repeat(10, 10);
    deltas[9] += extraSteps;
    const report = simProgressVerdict({
      samples: samplesFrom(deltas), fps: FPS_30, factor: 5, windowFrames: 10,
    });
    expect(report.verdict).toBe(verdict);
    expect(report.diagnosis).toBe(verdict === 'ok' ? null : 'sim-progress');
    expect(report.deviation).toBeCloseTo(extraSteps * FIXED_DT, 12);
    expect(report.tolerance).toBeCloseTo(5 * FIXED_DT + PREFLIGHT_SIM_TOLERANCE_SEC, 12);
  });
});

describe('simProgressVerdict on the DES clocks', () => {
  // simTime advances in event jumps (gap ~0.3 s), the render clock continuously at factor/fps.
  const eventSeries = (frames: number, factor: number) => {
    const out: { simTime: number; fixedStepCount: number; renderClock: number | null; des: boolean }[] = [];
    for (let i = 0; i <= frames; i++) {
      const clock = 7200 + (factor * i) / FPS_30;
      out.push({ simTime: 7200 + Math.floor((clock - 7200) / 0.3) * 0.3, fixedStepCount: i * 2, renderClock: clock, des: true });
    }
    return out;
  };

  it('Test_SimProgress_EventQuantisedSeriesAtRightSpeed_PassesOnRenderClock', () => {
    const report = simProgressVerdict({ samples: eventSeries(10, 5), fps: FPS_30, factor: 5 });
    expect(report).toMatchObject({ verdict: 'ok', clock: 'renderClock' });
  });

  it('Test_SimProgress_EventQuantisedSeriesAtWrongSpeed_Fails', () => {
    const report = simProgressVerdict({ samples: eventSeries(10, 2.5), fps: FPS_30, factor: 5 });
    expect(report).toMatchObject({ verdict: 'fail', diagnosis: 'sim-progress', clock: 'renderClock' });
  });

  it('Test_SimProgress_DesWithoutRenderClock_UsesLongWindowAndEventGapTolerance', () => {
    const strip = (factor: number, n: number) => eventSeries(n, factor).map((s) => ({ ...s, renderClock: null }));
    expect(simProgressVerdict({ samples: strip(5, 35), fps: FPS_30, factor: 5 })).toMatchObject({ verdict: 'ok', clock: 'simTime' });
    expect(simProgressVerdict({ samples: strip(2.5, 35), fps: FPS_30, factor: 5 }).verdict).toBe('fail');
    expect(simProgressVerdict({ samples: strip(5, 10), fps: FPS_30, factor: 5 }).reason).toMatch(/>= 30 frames/);
  });

  it('Test_SimProgress_DesFallbackSingleLargeJump_IsNeverOk', () => {
    // 30 frames at 30 fps, factor 5 -> expected 5 s; observed 2.5 s / 10 s as ONE event jump.
    for (const observed of [2.5, 10]) {
      const samples = [
        { simTime: 7200, fixedStepCount: 0, renderClock: null, des: true },
        ...Array.from({ length: 30 }, (_, i) => ({ simTime: 7200 + (i === 29 ? observed : 0), fixedStepCount: i, renderClock: null, des: true })),
      ];
      const report = simProgressVerdict({ samples, fps: FPS_30, factor: 5 });
      expect(report.verdict).not.toBe('ok');
      expect(report.reason).toMatch(/indeterminate: event gap/);
    }
  });

  it('Test_SimProgress_DesFallbackLongSeriesSmallGaps_RightSpeedOkWrongSpeedFails', () => {
    const strip = (factor: number, n: number) => eventSeries(n, factor).map((s) => ({ ...s, renderClock: null }));
    expect(simProgressVerdict({ samples: strip(5, 120), fps: FPS_30, factor: 5 }).verdict).toBe('ok');
    expect(simProgressVerdict({ samples: strip(2.5, 120), fps: FPS_30, factor: 5 }).verdict).toBe('fail');
  });

  it('Test_SimProgress_ContinuousSeriesWithoutDes_Unchanged', () => {
    const report = simProgressVerdict({ samples: samplesFrom(repeat(2, 10), 5 / 60), fps: FPS_30, factor: 5 });
    expect(report).toMatchObject({ verdict: 'ok', clock: 'simTime' });
  });
});

describe('warmupEndIndex', () => {
  it('Test_WarmupEndIndex_FirstAdvancingFrame_IsTheBurstFrame', () => {
    const samples = samplesFrom([...repeat(0, 20), 8, 2, 2]);
    expect(warmupEndIndex(samples, WARMUP_MAX_30)).toBe(21);
  });

  it('Test_WarmupEndIndex_BudgetNotSpent_ReturnsNullSoTheRunnerKeepsStepping', () => {
    expect(warmupEndIndex(samplesFrom(repeat(0, 10)), WARMUP_MAX_30)).toBeNull();
  });

  it('Test_WarmupEndIndex_BudgetSpentWithoutStep_ReturnsMinusOne', () => {
    expect(warmupEndIndex(samplesFrom(repeat(0, WARMUP_MAX_30)), WARMUP_MAX_30)).toBe(-1);
  });

  it('Test_WarmupEndIndex_StepAfterTheBudget_DoesNotCount', () => {
    expect(warmupEndIndex(samplesFrom([...repeat(0, WARMUP_MAX_30), 8]), WARMUP_MAX_30)).toBe(-1);
  });
});

describe('preflightVerdict — the measured good runs pass', () => {
  it('Test_Preflight_MeasuredThirtyFpsStartup_Passes', () => {
    const report = preflightVerdict({
      samples: samplesFrom([...repeat(0, 20), 8, ...repeat(2, PREFLIGHT_WINDOW_FRAMES)]),
      fps: FPS_30,
      warmupMaxFrames: WARMUP_MAX_30,
    });
    expect(report.verdict).toBe('ok');
    expect(report.reason).toBeNull();
    expect(report.warmupFrames).toBe(21);
    expect(report.sumSteps).toBe(80);
    expect(report.fixedDtObs).toBeCloseTo(FIXED_DT, 12);
    expect(report.deviation).toBeLessThan(1e-9);
  });

  it('Test_Preflight_BurstFrame_StaysInWarmupNotInWindow', () => {
    const report = preflightVerdict({
      samples: samplesFrom([...repeat(0, 20), 8, ...repeat(2, PREFLIGHT_WINDOW_FRAMES)]),
      fps: FPS_30,
      warmupMaxFrames: WARMUP_MAX_30,
    });
    expect(report.window).toHaveLength(PREFLIGHT_WINDOW_FRAMES);
    expect(report.window.every((d) => d.dSteps === 2)).toBe(true);
  });

  it('Test_Preflight_OldPerFrameRule_WouldRejectTheMeasuredRun_NewRuleAccepts', () => {
    // The replaced criterion demanded Δ fixedStepCount == 1 per frame: at 30 fps every window
    // frame carries 2 — the structural contradiction B2 was about.
    const report = preflightVerdict({
      samples: samplesFrom([8, ...repeat(2, PREFLIGHT_WINDOW_FRAMES)]),
      fps: FPS_30,
      warmupMaxFrames: WARMUP_MAX_30,
    });
    expect(report.window.some((d) => d.dSteps !== 1)).toBe(true);
    expect(report.verdict).toBe('ok');
  });

  it('Test_Preflight_SixtyFpsOneStepJitter_PassesAtExactlyOneFixedStep', () => {
    const window = repeat(1, PREFLIGHT_WINDOW_FRAMES);
    window[30] = 2;
    const report = preflightVerdict({
      samples: samplesFrom([0, 0, 1, ...window]),
      fps: FPS_60,
      warmupMaxFrames: WARMUP_MAX_60,
    });
    expect(report.verdict).toBe('ok');
    expect(report.sumSteps).toBe(41);
    expect(report.deviation).toBeCloseTo(FIXED_DT, 12);
    expect(report.tolerance).toBeCloseTo(FIXED_DT + PREFLIGHT_SIM_TOLERANCE_SEC, 12);
  });
});

describe('preflightVerdict — the three named failure shapes', () => {
  it('Test_Preflight_FrozenClock_FailsInWarmup', () => {
    const report = preflightVerdict({
      samples: samplesFrom(repeat(0, WARMUP_MAX_30 + PREFLIGHT_WINDOW_FRAMES)),
      fps: FPS_30,
      warmupMaxFrames: WARMUP_MAX_30,
    });
    expect(report.verdict).toBe('fail');
    expect(report.reason).toMatch(/never advanced/);
    expect(report.warmupFrames).toBeNull();
    expect(report.window).toHaveLength(0);
  });

  it('Test_Preflight_HalfSpeed_FailsOnTheWindowSum', () => {
    // One fixed step per 30-fps frame: every frame advances, but only half the recorded time.
    const report = preflightVerdict({
      samples: samplesFrom([...repeat(0, 20), 8, ...repeat(1, PREFLIGHT_WINDOW_FRAMES)]),
      fps: FPS_30,
      warmupMaxFrames: WARMUP_MAX_30,
    });
    expect(report.verdict).toBe('fail');
    expect(report.firstViolationFrame).toBeNull();
    expect(report.deviation).toBeCloseTo(40 / 30 - 40 / 60, 9);
    expect(report.reason).toMatch(/one fixed step/);
  });

  it('Test_Preflight_DoubleSpeed_FailsOnTheWindowSum', () => {
    const report = preflightVerdict({
      samples: samplesFrom([...repeat(0, 20), 8, ...repeat(4, PREFLIGHT_WINDOW_FRAMES)]),
      fps: FPS_30,
      warmupMaxFrames: WARMUP_MAX_30,
    });
    expect(report.verdict).toBe('fail');
    expect(report.deviation).toBeCloseTo(160 / 60 - 40 / 30, 9);
  });

  it('Test_Preflight_TwoStepsPerFrameButSimTimeFrozen_Fails', () => {
    // Steps counted, simulation time not advanced: the second, independent trace of the defect.
    const report = preflightVerdict({
      samples: samplesFrom([8, ...repeat(2, PREFLIGHT_WINDOW_FRAMES)], 0),
      fps: FPS_30,
      warmupMaxFrames: WARMUP_MAX_30,
    });
    expect(report.verdict).toBe('fail');
    expect(report.fixedDtObs).toBe(0);
  });
});

describe('preflightVerdict — the epoch checks (i) and (ii) decide first', () => {
  it('Test_Preflight_EpochZero_FailsBeforeAnyReading', () => {
    const report = preflightVerdict({
      samples: samplesFrom([8, ...repeat(2, PREFLIGHT_WINDOW_FRAMES)]),
      fps: FPS_30,
      warmupMaxFrames: WARMUP_MAX_30,
      epoch: 0,
    });
    expect(report.verdict).toBe('fail');
    expect(report.diagnosis).toBe('virtual-clock-epoch');
    expect(report.reason).toMatch(/^\(i\) epoch must be > 0/);
    expect(report.warmupFrames).toBeNull();
  });

  it('Test_Preflight_ClockBelowEpoch_FailsAtThatFrame', () => {
    const samples = samplesFrom([8, ...repeat(2, PREFLIGHT_WINDOW_FRAMES)])
      .map((sample, i) => (i === 0 ? sample : { ...sample, nowAtLeastEpoch: i !== 3 }));
    const report = preflightVerdict({ samples, fps: FPS_30, warmupMaxFrames: WARMUP_MAX_30, epoch: 13457.88 });
    expect(report.verdict).toBe('fail');
    expect(report.reason).toMatch(/^\(ii\)/);
    expect(report.firstViolationFrame).toBe(3);
  });

  it('Test_Preflight_PositiveEpochAndForwardClock_PassesAndCarriesTheEpoch', () => {
    const samples = samplesFrom([8, ...repeat(2, PREFLIGHT_WINDOW_FRAMES)])
      .map((sample, i) => (i === 0 ? sample : { ...sample, nowAtLeastEpoch: true }));
    const report = preflightVerdict({ samples, fps: FPS_30, warmupMaxFrames: WARMUP_MAX_30, epoch: 13457.88 });
    expect(report).toMatchObject({ verdict: 'ok', diagnosis: null, epoch: 13457.88 });
  });
});

describe('preflightVerdict — order and completeness', () => {
  it('Test_Preflight_StallInsideWindow_FailsBeforeTheDivision', () => {
    // A 0 followed by a 4 keeps Σ at exactly 80 steps — only the per-frame rule can see it, and it
    // must decide before fixedDtObs is computed.
    const window = repeat(2, PREFLIGHT_WINDOW_FRAMES);
    window[12] = 0;
    window[13] = 4;
    const report = preflightVerdict({
      samples: samplesFrom([8, ...window]),
      fps: FPS_30,
      warmupMaxFrames: WARMUP_MAX_30,
    });
    expect(report.verdict).toBe('fail');
    expect(report.firstViolationFrame).toBe(12);
    expect(report.fixedDtObs).toBeNull();
    expect(report.sumSteps).toBeNull();
  });

  it('Test_Preflight_WindowIncomplete_Fails', () => {
    const report = preflightVerdict({
      samples: samplesFrom([8, ...repeat(2, PREFLIGHT_WINDOW_FRAMES - 1)]),
      fps: FPS_30,
      warmupMaxFrames: WARMUP_MAX_30,
    });
    expect(report.verdict).toBe('fail');
    expect(report.reason).toMatch(/window incomplete: 39 of 40/);
  });

  it('Test_Preflight_MissingReading_Fails', () => {
    const samples = samplesFrom([8, ...repeat(2, PREFLIGHT_WINDOW_FRAMES)]);
    samples[5] = { simTime: Number.NaN, fixedStepCount: samples[5].fixedStepCount };
    const report = preflightVerdict({ samples, fps: FPS_30, warmupMaxFrames: WARMUP_MAX_30 });
    expect(report.verdict).toBe('fail');
    expect(report.reason).toMatch(/reading missing/);
  });

  it('Test_Preflight_InvalidArguments_Throw', () => {
    const samples = samplesFrom([8, ...repeat(2, PREFLIGHT_WINDOW_FRAMES)]);
    expect(() => preflightVerdict({ samples, fps: 0, warmupMaxFrames: WARMUP_MAX_30 })).toThrow(/fps/);
    expect(() => preflightVerdict({ samples, fps: FPS_30, warmupMaxFrames: 0 })).toThrow(/warmupMaxFrames/);
  });
});

// ─── plan-2237: the segment gate ─────────────────────────────────────────────────────────────────

const TRACES = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tutorial-clock-traces.json'), 'utf8'));
type TraceRow = [number, number, number, number | null, string | null, number | null, number | null];
const desFactor = (sub: string, m: number): number | null => (sub === 'animated' ? 1 : sub === 'hybrid' ? Math.max(1, m) : sub === 'step' ? 0 : null);

/** A measured spike trace as gate input; the windows are the recorder's time-command dispatches. */
function traceInput(key: string): { samples: GateSample[]; windows: GateWindow[] } {
  const trace = TRACES[key] as { rows: TraceRow[]; ops: { frame: number; cmd: string; completion: number }[] };
  const samples = trace.rows.map(([paused, simTime, steps, renderClock, subMode, multiplier, speed]): GateSample => (subMode
    ? { mode: 'des', paused: paused === 1, simTime, fixedStepCount: steps, factor: desFactor(subMode, multiplier ?? 1), subMode,
      renderClock, endTime: null, clampBudget: 0, clampEnd: 0 }
    : { mode: 'continuous', paused: paused === 1, simTime, fixedStepCount: steps, factor: speed, subMode: null,
      renderClock: null, endTime: null, clampBudget: 0, clampEnd: 0 }));
  const windows = trace.ops.filter((op) => TIME_COMMANDS.includes(op.cmd))
    .map((op) => ({ start: op.frame, end: op.completion + 1, cmd: op.cmd, kind: 'transition' as const }));
  return { samples, windows };
}

interface TakeOptions {
  factor?: number | null;
  stepsAt?: (k: number) => number;
  clockPerStep?: (k: number) => number;
  des?: string;
  paused?: boolean;
  start?: Partial<GateSample>;
}

/**
 * Synthetic take: `n` frames of `stepsAt(k)` fixed steps each (default 2 = 30 fps at 60 Hz); the
 * tempo clock advances by `clockPerStep(k)` per step (default factor/60). Continuous unless `des`.
 */
function take(n: number, opts: TakeOptions = {}): GateSample[] {
  const factor = opts.factor === undefined ? 1 : opts.factor;
  const first: GateSample = {
    mode: opts.des ? 'des' : 'continuous', paused: opts.paused ?? false, simTime: 0, fixedStepCount: 1000, factor,
    subMode: opts.des ?? null, renderClock: opts.des ? 0 : null, endTime: null, clampBudget: 0, clampEnd: 0, ...opts.start,
  };
  const samples = [first];
  for (let k = 1; k <= n; k++) {
    const prev = samples[k - 1];
    const steps = opts.paused ? 0 : (opts.stepsAt ? opts.stepsAt(k) : 2);
    const per = opts.clockPerStep ? opts.clockPerStep(k) : (factor ?? 0) / 60;
    const advance = steps * per;
    samples.push({ ...prev, fixedStepCount: prev.fixedStepCount + steps,
      simTime: prev.simTime + (opts.des ? 0 : advance),
      renderClock: opts.des ? (prev.renderClock as number) + advance : null });
  }
  return samples;
}

/** Continues `samples` with a new state; the builder's first sample is the last one given. */
function then(samples: GateSample[], n: number, opts: TakeOptions = {}): GateSample[] {
  const last = samples.at(-1) as GateSample;
  const tail = take(n, { ...opts, start: { simTime: last.simTime, fixedStepCount: last.fixedStepCount,
    renderClock: last.renderClock, ...(opts.start ?? {}) } });
  return [...samples, ...tail.slice(1)];
}

describe('segment gate (plan-2237 F3-F5) — measured spike traces', () => {
  it('Test_SegmentGate_SpikeContinuousCarry_Green', () => {
    const report = segmentGate({ ...traceInput('continuousCarry'), fps: 30 });
    expect(report.verdict).toBe('ok');
    expect(report.segments.filter((s) => s.verdict === 'pass').map((s) => s.factor)).toEqual([1, 5, 0.5, 0.5, 0.5, 0, 100, 100, 1, 1]);
    expect(report.simJumps.map((j) => j.cmd)).toEqual(['sim.reset']);
  });

  it('Test_SegmentGate_SpikeOriginalClockWithoutCarry_RedAroundFrame400', () => {
    // The old ~16 s limit: the recorder creep lets the page run 2 fixed steps ahead after ~400 frames.
    const report = segmentGate({ ...traceInput('continuousOriginal'), fps: 30 });
    expect(report.verdict).toBe('fail');
    expect(report.reason).toMatch(/I1: 538 fixed steps over 268 frames.*at frame 419/);
  });

  it('Test_SegmentGate_SpikeDes_FastForwardCheckpointStepReset_GreenWithJumps', () => {
    const report = segmentGate({ ...traceInput('desCarryLike'), fps: 30 });
    expect(report.verdict).toBe('ok');
    expect(report.segments.every((s) => s.clock === 'renderClock')).toBe(true);
    expect(report.simJumps.map((j) => j.cmd)).toEqual(['des.fastForward', 'des.checkpoint.load', 'des.step', 'des.step', 'sim.reset']);
    expect(report.simJumps.find((j) => j.cmd === 'des.checkpoint.load')).toMatchObject({ fromSim: 10800, toSim: 3600 });
    expect(report.segments.some((s) => s.kind === 'hold' && s.factor === 0 && s.verdict === 'pass')).toBe(true);
  });
});

describe('segment gate (plan-2237 F4) — counter-cases stay red', () => {
  it('Test_SegmentGate_SteadyLoss_OneStepPer130Frames_Red', () => {
    const report = segmentGate({ samples: take(1000, { stepsAt: (k) => (k % 130 === 0 ? 1 : 2) }), fps: 30 });
    expect(report.verdict).toBe('fail');
    expect(report.reason).toMatch(/I1.*at frame 260$/);
  });

  it('Test_SegmentGate_WrongTempo_097x_RedInFirstFrame', () => {
    const report = segmentGate({ samples: take(100, { clockPerStep: () => 0.97 / 60 }), fps: 30 });
    expect(report.verdict).toBe('fail');
    expect(report.reason).toMatch(/I2.*at frame 1$/);
  });

  it('Test_SegmentGate_WrongTempo_OneStepPer20Frames_Red', () => {
    const report = segmentGate({ samples: take(200, { stepsAt: (k) => (k % 20 === 0 ? 1 : 2) }), fps: 30 });
    expect(report.verdict).toBe('fail');
    expect(report.reason).toMatch(/I1.*at frame 40$/);
  });

  it('Test_SegmentGate_OneStepGainPer260_RedWithoutCarry_GreenWithCarry', () => {
    // Without the creep carry the page gains one fixed step per ~260 frames (measured 175..265).
    const noCarry = take(1000, { stepsAt: (k) => (k % 260 === 0 ? 3 : 2) });
    expect(segmentGate({ samples: noCarry, fps: 30 }).verdict).toBe('fail');
    const carry = take(1000, { stepsAt: (k) => (k % 2 ? 1 : 3) }); // accumulator jitter, no gain
    expect(segmentGate({ samples: carry, fps: 30 }).verdict).toBe('ok');
  });

  it('Test_SegmentGate_ToleranceIsConstant_DoesNotGrowWithLength', () => {
    expect(segmentGate({ samples: take(10_000, { stepsAt: (k) => (k % 2 ? 3 : 1) }), fps: 30 }).verdict).toBe('ok');
    expect(segmentGate({ samples: take(10_000, { stepsAt: (k) => (k === 9000 ? 3 : k === 9001 ? 2 : k % 2 ? 3 : 1) }), fps: 30 }).verdict).toBe('fail');
  });
});

describe('segment gate (plan-2237 F4) — holds, factors, short', () => {
  it('Test_SegmentGate_Hold_GreenWhenClockStands_RedWhenItMoves', () => {
    expect(segmentGate({ samples: take(60, { paused: true }), fps: 30 }).segments[0]).toMatchObject({ kind: 'hold', verdict: 'pass' });
    expect(segmentGate({ samples: take(60, { factor: 0 }), fps: 30 }).segments[0]).toMatchObject({ kind: 'hold', verdict: 'pass', factor: 0 });
    expect(segmentGate({ samples: take(60, { des: 'step', factor: 0 }), fps: 30 }).segments[0])
      .toMatchObject({ kind: 'hold', verdict: 'pass', clock: 'renderClock' });
    const moving = segmentGate({ samples: take(60, { factor: 0, clockPerStep: () => 1 / 60 }), fps: 30 });
    expect(moving.verdict).toBe('fail');
    expect(moving.reason).toMatch(/hold segment: clock moved/);
  });

  it('Test_SegmentGate_Factors_0_05_2_100_Green_ClampedFactorIsTheReading', () => {
    for (const factor of [0, 0.5, 2, 100]) {
      expect(segmentGate({ samples: take(120, { factor }), fps: 30 }).verdict, `factor ${factor}`).toBe('ok');
    }
    // `sim.clock.get` reports the CLAMPED factor (150 -> 100); a clock running at 150 against it is red.
    expect(segmentGate({ samples: take(120, { factor: 100, clockPerStep: () => 150 / 60 }), fps: 30 }).verdict).toBe('fail');
  });

  it('Test_SegmentGate_Short_UnderThreeFrames_ReportedNotRed', () => {
    const report = segmentGate({ samples: then(take(2), 30, { factor: 3 }), fps: 30 });
    expect(report.verdict).toBe('ok');
    expect(report.segments[0]).toMatchObject({ kind: 'short', verdict: 'short', startFrame: 1, endFrame: 2 });
  });

  it('Test_SegmentGate_StateChangeWithoutCommand_EndsSegment_Rebases', () => {
    // A UI click on the speed menu: no recorder command, but the factor read from the state changes.
    const report = segmentGate({ samples: then(take(60), 60, { factor: 5 }), fps: 30 });
    expect(report.verdict).toBe('ok');
    expect(report.segments.map((s) => [s.kind, s.factor, s.verdict])).toEqual([['run', 1, 'pass'], ['run', 5, 'pass']]);
    expect(report.segments[1].startFrame).toBe(62); // frame 61 is the transition frame
  });

  it('Test_SegmentGate_RepeatedRearm_ManyTransitions_Green', () => {
    let samples = take(10);
    const windows: GateWindow[] = [];
    for (let i = 0; i < 20; i++) {
      const at = samples.length;
      samples = then(samples, 10, { factor: (i % 4) + 1 });
      windows.push({ start: at, end: at + 1, cmd: 'sim.speedOverride' });
    }
    const report = segmentGate({ samples, fps: 30, windows });
    expect(report.verdict).toBe('ok');
    expect(report.segments.filter((s) => s.verdict === 'pass')).toHaveLength(21);
  });
});

describe('segment gate (plan-2237 F4/F5) — DES clamps and jumps', () => {
  const hybrid = (n: number, start?: Partial<GateSample>): GateSample[] => take(n, { des: 'hybrid', factor: 50, start });

  it('Test_SegmentGate_OneBudgetClampWithProof_ThenRuns_Green_NoDeficit', () => {
    const before = hybrid(100);
    const last = before.at(-1) as GateSample;
    // The clamped frame: render clock pulled back to the event clock, the clamp counter grew.
    const clamped: GateSample = { ...last, fixedStepCount: last.fixedStepCount + 2, renderClock: (last.renderClock as number) + 0.4, clampBudget: 1 };
    const report = segmentGate({ samples: [...before, clamped, ...hybrid(100, clamped).slice(1)], fps: 30 });
    expect(report.verdict).toBe('ok');
    expect(report.segments.map((s) => s.verdict)).toEqual(['pass', 'clamped', 'pass']);
    expect(report.segments[1]).toMatchObject({ clampedAt: 'budget', startFrame: 101, endFrame: 101 });
  });

  it('Test_SegmentGate_EqualClocksWithoutClampProof_NotClamped_Red', () => {
    const before = hybrid(100);
    const last = before.at(-1) as GateSample;
    const pulled = (last.renderClock as number) + 0.4;
    const frozen: GateSample = { ...last, fixedStepCount: last.fixedStepCount + 2, renderClock: pulled, simTime: pulled };
    const report = segmentGate({ samples: [...before, frozen, ...hybrid(100, frozen).slice(1)], fps: 30 });
    expect(report.verdict).toBe('fail');
    expect(report.segments.some((s) => s.verdict === 'clamped')).toBe(false);
  });

  it('Test_SegmentGate_FrozenDesClockWhileStepsRun_NoClampedAt_Red', () => {
    const report = segmentGate({ samples: take(60, { des: 'hybrid', factor: 50, clockPerStep: () => 0 }), fps: 30 });
    expect(report.verdict).toBe('fail');
    expect(report.reason).toMatch(/I2/);
  });

  it('Test_SegmentGate_WrongDesTempo_Red', () => {
    expect(segmentGate({ samples: take(60, { des: 'hybrid', factor: 50, clockPerStep: () => 40 / 60 }), fps: 30 }).verdict).toBe('fail');
  });

  it('Test_SegmentGate_EndClamp_StopsJudgingUntilStateChange', () => {
    const before = hybrid(60);
    const last = before.at(-1) as GateSample;
    const atEnd: GateSample = { ...last, fixedStepCount: last.fixedStepCount + 2, renderClock: (last.renderClock as number) + 0.5, clampEnd: 1 };
    // After the end the render clock stands while steps run — no further clamp is counted.
    const stand = take(40, { des: 'hybrid', factor: 50, clockPerStep: () => 0, start: atEnd }).slice(1);
    const pausedStart = { ...(stand.at(-1) as GateSample), paused: true };
    const paused = take(30, { des: 'hybrid', factor: 50, paused: true, start: pausedStart });
    const report = segmentGate({ samples: [...before, atEnd, ...stand, ...paused], fps: 30 });
    expect(report.verdict).toBe('ok');
    expect(report.segments.map((s) => [s.kind, s.verdict])).toEqual([['run', 'pass'], ['run', 'clamped'], ['hold', 'pass']]);
    expect(report.segments[1]).toMatchObject({ clampedAt: 'end', startFrame: 61, endFrame: 101 });
  });

  it('Test_SegmentGate_BackwardsJumpInTransition_LoggedAsSimJump', () => {
    const before = hybrid(60, { renderClock: 10800, simTime: 10800 });
    const last = before.at(-1) as GateSample;
    const loaded: GateSample = { ...last, fixedStepCount: last.fixedStepCount + 2, renderClock: 3600, simTime: 3600, subMode: 'step', factor: 0, paused: true };
    const after = take(30, { des: 'step', factor: 0, paused: true, start: loaded }).slice(1);
    const report = segmentGate({ samples: [...before, loaded, ...after], fps: 30,
      windows: [{ start: 58, end: 62, cmd: 'des.checkpoint.load' }] });
    expect(report.verdict).toBe('ok');
    expect(report.simJumps).toEqual([{ frame: 61, cmd: 'des.checkpoint.load', fromSim: before[57].renderClock, toSim: 3600 }]);
  });

  it('Test_SegmentGate_TimelapseWindow_SkippedSegment', () => {
    const samples = then(take(30), 40, { start: { simTime: 500 } });
    const report = segmentGate({ samples, fps: 30, windows: [{ start: 31, end: 50, cmd: 'experiment.run', kind: 'timelapse' }] });
    expect(report.verdict).toBe('ok');
    expect(report.segments.map((s) => [s.kind, s.verdict])).toEqual([['run', 'pass'], ['timelapse', 'skipped'], ['run', 'pass']]);
  });

  it('Test_SegmentGate_UnreadableSample_Red', () => {
    const samples: (GateSample | null)[] = take(10);
    samples[5] = null;
    expect(segmentGate({ samples, fps: 30 }).reason).toMatch(/frame 5/);
  });
});

describe('DES preflight on the render clock (plan-2237 F6)', () => {
  it('Test_Preflight_Des_RenderClockRuns_SimTimeStaysZero_Ok', () => {
    // Measured: after Play the DES event time stays 0 while the render clock runs.
    const samples: (PreflightSample & { des: boolean; renderClock: number })[] = [{ simTime: 0, fixedStepCount: 1000, des: true, renderClock: 0 }];
    for (let k = 1; k <= 1 + PREFLIGHT_WINDOW_FRAMES; k++) {
      const prev = samples[k - 1];
      samples.push({ simTime: 0, fixedStepCount: prev.fixedStepCount + 2, des: true, renderClock: prev.renderClock + 2 / 60 });
    }
    expect(preflightVerdict({ samples, fps: FPS_30, warmupMaxFrames: WARMUP_MAX_30 }).verdict).toBe('ok');
    // The same take read on simTime is the measured 0-s failure.
    const old = samples.map(({ simTime, fixedStepCount }) => ({ simTime, fixedStepCount }));
    expect(preflightVerdict({ samples: old, fps: FPS_30, warmupMaxFrames: WARMUP_MAX_30 }).verdict).toBe('fail');
  });

  it('Test_Preflight_FactorFromClock_HybridFiftyStart_Ok', () => {
    const samples = samplesFrom([2, ...Array(PREFLIGHT_WINDOW_FRAMES).fill(2)], 50 * FIXED_DT);
    expect(preflightVerdict({ samples, fps: FPS_30, warmupMaxFrames: WARMUP_MAX_30, factor: 50 }).verdict).toBe('ok');
    expect(preflightVerdict({ samples, fps: FPS_30, warmupMaxFrames: WARMUP_MAX_30 }).verdict).toBe('fail');
  });
});

describe('time-command windows from the take-wide watch (plan-2237 review 3)', () => {
  it('Test_TimeCommandWindows_SyncAsyncAndOpen', () => {
    const at: { id: string; phase: 'dispatch' | 'done'; ok?: boolean }[][] = Array.from({ length: 20 }, () => []);
    at[3].push({ id: 'sim.reset', phase: 'dispatch' }, { id: 'sim.reset', phase: 'done', ok: true });
    at[8].push({ id: 'des.checkpoint.load', phase: 'dispatch' });
    at[11].push({ id: 'des.checkpoint.load', phase: 'done', ok: true });
    at[15].push({ id: 'des.step', phase: 'done', ok: true }); // completion without a seen dispatch
    at[17].push({ id: 'sim.playPause', phase: 'dispatch' }); // never completed
    expect(timeCommandWindows(at, 19)).toEqual([
      { start: 3, end: 4, cmd: 'sim.reset', kind: 'transition' },
      { start: 8, end: 12, cmd: 'des.checkpoint.load', kind: 'transition' },
      { start: 15, end: 16, cmd: 'des.step', kind: 'transition' },
      { start: 17, end: 19, cmd: 'sim.playPause', kind: 'transition' },
    ]);
  });

  it('Test_SegmentGate_UiResetWithoutWindow_Red_WithWatchWindow_GreenAndJump', () => {
    // A reset by a UI click changes neither mode, factor nor pause: only the watch makes it a transition.
    const before = take(60, { start: { simTime: 30 } });
    const samples = then(before, 60, { start: { simTime: 0 } });
    expect(segmentGate({ samples, fps: 30 }).verdict).toBe('fail');
    const at = samples.map(() => [] as { id: string; phase: 'dispatch' | 'done' }[]);
    at[61].push({ id: 'sim.reset', phase: 'dispatch' }, { id: 'sim.reset', phase: 'done' });
    const report = segmentGate({ samples, fps: 30, windows: timeCommandWindows(at, samples.length - 1) });
    expect(report.verdict).toBe('ok');
    expect(report.simJumps.map((jump) => jump.cmd)).toEqual(['sim.reset']);
  });
});

describe('simProgress compatibility fields (plan-2237 review 5)', () => {
  it('Test_SegmentGate_PrePlanFields_FromFirstJudgedRunSegment', () => {
    const report = segmentGate({ samples: then(take(2), 90, { factor: 5 }), fps: 30 });
    const first = report.segments.find((s) => s.kind === 'run' && s.verdict === 'pass');
    expect(first).toBeDefined();
    expect(report.factor).toBe(5);
    expect(report.expectedSimTime).toBeCloseTo(5 * (first?.frames ?? 0) / 30, 12);
    expect(report.sumSimTime).toBeCloseTo(first?.sumClock ?? NaN, 12);
    expect(report.deviation).toBeLessThanOrEqual(report.tolerance as number);
    // No judged run segment: the fields are null, not invented.
    const held = segmentGate({ samples: take(30, { paused: true }), fps: 30 });
    expect([held.sumSimTime, held.expectedSimTime, held.deviation, held.tolerance]).toEqual([null, null, null, null]);
  });
});
