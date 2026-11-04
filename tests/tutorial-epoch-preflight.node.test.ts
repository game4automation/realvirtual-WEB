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

import { describe, expect, it } from 'vitest';

import {
  clockOnlyVerdict,
  PREFLIGHT_SIM_TOLERANCE_SEC,
  PREFLIGHT_WINDOW_FRAMES,
  preflightVerdict,
  simProgressVerdict,
  warmupEndIndex,
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
