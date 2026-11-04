// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { moveFrames, planMove } from '../scripts/tutorial/lib/cursor-path.mjs';
import {
  DEFAULT_FPS,
  MARKER_SEC,
  MIN_MOVED_FRACTION,
  MIN_WAIT_FOR_FRAMES,
  STILL_THRESHOLD,
  controlFrameVerdict,
  frameAtEnd,
  frameAtStart,
  frameBudget,
  frameCountVerdict,
  frameToSec,
  framesAtMost,
  framesOf,
  mad8x8,
  markerVerdict,
  motionShapeVerdict,
  motionVerdict,
  segmentKindOf,
  syncVerdict,
  traceCoverageVerdict,
} from '../scripts/tutorial/lib/tutorial-events.mjs';
import type { Segment, StepRecord } from '../scripts/tutorial/lib/tutorial-events.mjs';
import { stampsContiguous } from '../scripts/tutorial/lib/tutorial-capture.mjs';

const FPS = DEFAULT_FPS;

function completeTrace(): { segments: Segment[]; steps: StepRecord[] } {
  return {
    segments: [
      { kind: 'marker', start: 0, end: 3, stepId: null },
      { kind: 'action', start: 3, end: 10, stepId: 'step-a', actionIndex: 0 },
      { kind: 'wait', start: 10, end: 15, stepId: 'step-a', actionIndex: 1 },
      { kind: 'hold', start: 15, end: 20, stepId: 'step-a' },
      { kind: 'action', start: 20, end: 27, stepId: 'step-b', actionIndex: 0 },
      { kind: 'marker', start: 27, end: 30, stepId: null },
    ],
    steps: [
      { id: 'step-a', start: 3, end: 20 },
      { id: 'step-b', start: 20, end: 27 },
    ],
  };
}

function measuredMarkerTrace(): { segments: Segment[]; steps: StepRecord[] } {
  return {
    segments: [
      { kind: 'marker', start: 0, end: 9, stepId: null },
      { kind: 'action', start: 9, end: 2691, stepId: 'content', actionIndex: 0 },
      { kind: 'marker', start: 2691, end: 2700, stepId: null },
    ],
    steps: [{ id: 'content', start: 9, end: 2691 }],
  };
}

const declaredMotion = {
  region: { x: 760, y: 500, w: 400, h: 400 },
  metric: 'mad8x8gray',
  scale: '8bit-gray-0-255',
  downscale: 'scale=8:8:flags=area',
  stillThreshold: 0.5,
  minMovedFraction: 0.1,
} as const;

describe('tutorial-events', () => {
  it('Test_FrameToSec_IsExactlyFrameOverFps', () => {
    expect(frameToSec(2691, FPS)).toBe(89.7);
    expect(frameToSec(3, FPS)).toBe(0.1);
  });

  it('Test_MarkerVerdict_OnsetEqualsExpected_Ok', () => {
    expect(markerVerdict(3, 3)).toEqual({ onsetFrame: 3, expectedFrame: 3, offsetFrames: 0, verdict: 'ok' });
  });

  it('Test_MarkerVerdict_OnsetOffByOne_Error', () => {
    expect(markerVerdict(4, 3)).toMatchObject({ offsetFrames: 1, verdict: 'fail', diagnosis: 'marker-mismatch' });
  });

  it('Test_Segments_Contiguous_Monotonic_KindsFromActionTypes', () => {
    const trace = completeTrace();
    expect(segmentKindOf('click')).toBe('action');
    expect(segmentKindOf('waitFor')).toBe('wait');
    expect(traceCoverageVerdict(trace.segments, [], 30, trace.steps)).toMatchObject({ verdict: 'ok' });

    const nonMonotonic = completeTrace();
    nonMonotonic.segments[2] = { ...nonMonotonic.segments[2], end: 10 };
    expect(traceCoverageVerdict(nonMonotonic.segments, [], 30, nonMonotonic.steps)).toMatchObject({
      verdict: 'fail', diagnosis: 'trace-not-contiguous',
    });
  });

  it('Test_Segments_OwnerIsUnique_MarkerIffStepIdNull', () => {
    const markerOwned = completeTrace();
    markerOwned.segments[0] = { ...markerOwned.segments[0], stepId: 'step-a' };
    const actionOwnerless = completeTrace();
    actionOwnerless.segments[1] = { ...actionOwnerless.segments[1], stepId: null };
    const unknownOwner = completeTrace();
    unknownOwner.segments[1] = { ...unknownOwner.segments[1], stepId: 'missing-step' };
    const markerWithoutOwnerEntry = completeTrace();
    delete (markerWithoutOwnerEntry.segments[0] as Partial<Segment>).stepId;

    for (const trace of [markerOwned, actionOwnerless, unknownOwner, markerWithoutOwnerEntry]) {
      expect(traceCoverageVerdict(trace.segments, [], 30, trace.steps)).toMatchObject({
        verdict: 'fail', diagnosis: 'trace-not-contiguous',
      });
    }
  });

  it('Test_TraceCoverage_StepBoundsAreTheUnionOfTheirSegments', () => {
    const valid = completeTrace();
    expect(traceCoverageVerdict(valid.segments, [], 30, valid.steps)).toMatchObject({ verdict: 'ok', stepBoundsOk: true });

    const earlyStart = completeTrace();
    earlyStart.steps[0] = { ...earlyStart.steps[0], start: 2 };
    const lateEnd = completeTrace();
    lateEnd.steps[0] = { ...lateEnd.steps[0], end: 21 };
    const split: { segments: Segment[]; steps: StepRecord[] } = {
      segments: [
        { kind: 'marker', start: 0, end: 3, stepId: null },
        { kind: 'action', start: 3, end: 6, stepId: 'step-a' },
        { kind: 'action', start: 6, end: 9, stepId: 'step-b' },
        { kind: 'hold', start: 9, end: 12, stepId: 'step-a' },
        { kind: 'marker', start: 12, end: 15, stepId: null },
      ],
      steps: [{ id: 'step-a', start: 3, end: 12 }, { id: 'step-b', start: 6, end: 9 }],
    };

    for (const [trace, frames] of [[earlyStart, 30], [lateEnd, 30], [split, 15]] as const) {
      expect(traceCoverageVerdict(trace.segments, [], frames, trace.steps)).toMatchObject({
        verdict: 'fail', diagnosis: 'trace-not-contiguous', stepBoundsOk: false,
      });
    }
  });

  it('Test_TraceCoverage_NoMaterializedSegmentIndexInArtifact', () => {
    const trace = completeTrace();
    const steps = trace.steps.map((step, index) => index === 0 ? { ...step, segmentIndex: [1, 2, 3] } : step);
    expect(traceCoverageVerdict(trace.segments, [], 30, steps)).toMatchObject({
      verdict: 'fail', diagnosis: 'trace-not-contiguous', stepBoundsOk: true,
    });
  });

  it('Test_Sync_TwoMarkers_DriftIsTheDifferenceOfOffsets', () => {
    expect(syncVerdict(
      { onsetFrame: 3, expectedFrame: 3 },
      { onsetFrame: 2691, expectedFrame: 2691 },
    )).toEqual({
      markers: [
        { which: 'start', onsetFrame: 3, expectedFrame: 3, offsetFrames: 0 },
        { which: 'end', onsetFrame: 2691, expectedFrame: 2691, offsetFrames: 0 },
      ],
      driftFrames: 0,
      verdict: 'ok',
    });

    // The end-marker offset is synthetic and isolates a one-frame drift failure.
    expect(syncVerdict(
      { onsetFrame: 3, expectedFrame: 3 },
      { onsetFrame: 2692, expectedFrame: 2691 },
    )).toMatchObject({
      markers: [
        { which: 'start', offsetFrames: 0 },
        { which: 'end', offsetFrames: 1 },
      ],
      driftFrames: 1,
      verdict: 'fail',
      diagnosis: 'marker-mismatch',
    });
  });

  it('Test_Pointer_AtMostOneSamplePerFrame', () => {
    const trace = completeTrace();
    const distinct = [{ frame: 3, t: 0.1, x: 1, y: 1 }, { frame: 4, t: 4 / FPS, x: 2, y: 2 }];
    const duplicate = [...distinct, { frame: 4, t: 4 / FPS, x: 3, y: 3 }];
    expect(traceCoverageVerdict(trace.segments, distinct, 30, trace.steps)).toMatchObject({ verdict: 'ok' });
    expect(traceCoverageVerdict(trace.segments, duplicate, 30, trace.steps)).toMatchObject({
      verdict: 'fail', diagnosis: 'trace-not-contiguous',
    });
  });

  it('Test_HoldUntil_UsesFramesOfPerField_NotOfTheSum', () => {
    const budget = frameBudget({
      minStepSec: 0.01,
      steps: [{ holdSec: 0.01, tailSec: 0.01, actions: [{ type: 'press', key: 'Escape' }] }],
    }, FPS);
    // The two one-frame fields remain two frames; converting their 0.02 s sum would produce one.
    // Step = max(press 1, hold 1 + 1, floor 1) = 2; marker windows 3 + 6 + 6 + 3 = 18.
    expect(budget).toEqual({ min: 20, max: 20 });
  });

  it('Test_FrameCountVerdict_TraceVsProbe_ExactOnly', () => {
    expect(frameCountVerdict(2700, 2700, true, true)).toMatchObject({ verdict: 'ok', compared: true });
    expect(frameCountVerdict(2700, 2699, true, true)).toMatchObject({ verdict: 'fail', diagnosis: 'frame-count-mismatch' });
    expect(frameCountVerdict(2700, 2701, true, true)).toMatchObject({ verdict: 'fail', diagnosis: 'frame-count-mismatch' });
    expect(frameCountVerdict(2700, 2700, false, true)).toMatchObject({ verdict: 'fail', diagnosis: 'frame-count-mismatch' });
  });

  it('Test_FrameCountVerdict_IncompleteTrace_IsRejected_BeforeAnyComparison', () => {
    expect(frameCountVerdict(2700, 2700, true, false)).toEqual({
      verdict: 'fail', diagnosis: 'trace-not-contiguous', compared: false,
    });
  });

  it('Test_TraceCoverage_RequiresFullRun_NotJustNeighbours', () => {
    const prefixGap: Segment[] = [
      { kind: 'action', start: 12, end: 20, stepId: 'step-a' },
      { kind: 'action', start: 20, end: 30, stepId: 'step-a' },
    ];
    const suffixGap: Segment[] = [
      { kind: 'action', start: 0, end: 10, stepId: 'step-a' },
      { kind: 'action', start: 10, end: 23, stepId: 'step-a' },
    ];
    const complete: Segment[] = [
      { kind: 'action', start: 0, end: 10, stepId: 'step-a' },
      { kind: 'action', start: 10, end: 30, stepId: 'step-a' },
    ];
    expect(traceCoverageVerdict(prefixGap, [], 30, [{ id: 'step-a', start: 12, end: 30 }])).toMatchObject({ verdict: 'fail' });
    expect(traceCoverageVerdict(suffixGap, [], 30, [{ id: 'step-a', start: 0, end: 23 }])).toMatchObject({ verdict: 'fail' });
    expect(traceCoverageVerdict(complete, [], 30, [{ id: 'step-a', start: 0, end: 30 }])).toMatchObject({ verdict: 'ok' });
  });

  it('Test_TraceCoverage_MarkerFramesHaveTheirOwnKind', () => {
    const trace = completeTrace();
    expect(traceCoverageVerdict(trace.segments, [], 30, trace.steps)).toMatchObject({ verdict: 'ok' });

    const withoutMarkerWindows = trace.segments.slice(1, -1);
    expect(traceCoverageVerdict(withoutMarkerWindows, [], 30, trace.steps)).toMatchObject({
      verdict: 'fail', diagnosis: 'trace-not-contiguous',
    });
  });

  it('Test_TraceCoverage_MarkerSegmentsIncludeLeadInAndTail', () => {
    expect(framesOf(MARKER_SEC, FPS)).toBe(6);
    const valid = measuredMarkerTrace();
    expect(traceCoverageVerdict(valid.segments, [], 2700, valid.steps)).toMatchObject({ verdict: 'ok' });

    const naiveStart = measuredMarkerTrace();
    naiveStart.segments[0] = { ...naiveStart.segments[0], start: 3 };
    const naiveEnd = measuredMarkerTrace();
    naiveEnd.segments[2] = { ...naiveEnd.segments[2], end: 2697 };
    expect(traceCoverageVerdict(naiveStart.segments, [], 2700, naiveStart.steps)).toMatchObject({ verdict: 'fail' });
    expect(traceCoverageVerdict(naiveEnd.segments, [], 2700, naiveEnd.steps)).toMatchObject({ verdict: 'fail' });
  });

  it('Test_FrameBudget_IsAnInterval_FromTheThreeRunDependentParts', () => {
    expect(MIN_WAIT_FOR_FRAMES).toBe(1);
    const budget = frameBudget({
      minStepSec: 0.01,
      steps: [{
        holdSec: 0.01,
        tailSec: 0.01,
        actions: [
          { type: 'click', target: { selector: '#go' } },
          { type: 'type', target: { selector: '#name' }, text: 'ab', delayMs: 100 },
          { type: 'waitFor', selector: '#done', timeoutMs: 100 },
          { type: 'press', key: 'Enter' },
        ],
      }],
    }, FPS);
    // Actions: click 11+1 | 108+1, type 11+6 | 108+6, waitFor 1 | 3, press 1 -> 31 | 227; the hold
    // window (2) lies inside them; marker windows 18.
    expect(budget).toEqual({ min: 49, max: 245 });

    const actualFrames = 246;
    const report = { ...budget, withinBudget: actualFrames >= budget.min && actualFrames <= budget.max };
    expect(report).toEqual({ min: 49, max: 245, withinBudget: false });
    expect(budget).not.toHaveProperty('verdict');

    const budgetFor = (action: Record<string, unknown>) => frameBudget({
      minStepSec: 0.01,
      steps: [{ holdSec: 0.01, tailSec: 0.01, actions: [action] }],
    }, FPS);
    const pointerActions = [
      { type: 'click', target: { selector: '#target' } },
      { type: 'hover', target: { selector: '#target' } },
      { type: 'drag', from: { selector: '#from' }, to: { selector: '#to' }, durationMs: 1 },
      { type: 'wheel', at: { selector: '#target' }, deltaY: 1, steps: 1 },
      { type: 'type', target: { selector: '#target' }, text: 'x', delayMs: 1 },
    ];
    const nonPointerActions = [
      { type: 'press', key: 'Enter' },
      { type: 'wait', ms: 1 },
      { type: 'waitFor', selector: '#done', timeoutMs: 1 },
      { type: 'camera', position: [1, 2, 3], target: [0, 0, 0], durationSec: 0.001 },
    ];
    for (const action of pointerActions) expect(budgetFor(action)).toEqual({ min: 30, max: 127 });
    // A double click is two presses in two frames.
    expect(budgetFor({ type: 'doubleClick', target: { selector: '#target' } })).toEqual({ min: 31, max: 128 });
    for (const action of nonPointerActions) expect(budgetFor(action)).toEqual({ min: 20, max: 20 });
    // A wait of 0 ms still records one frame.
    expect(budgetFor({ type: 'wait', ms: 0 })).toEqual({ min: 20, max: 20 });
  });

  it('Test_FramesOf_RoundsUp_NeverShortensDeclaredDuration', () => {
    expect(framesOf(0.0334, FPS)).toBe(2);
    expect(framesOf(1 / FPS, FPS)).toBe(1);
    expect(framesOf(0.35, FPS)).toBe(11);
    expect(framesOf(1.2, FPS)).toBe(36);
    expect(framesOf(2, FPS)).toBe(60);
  });

  it('Test_FrameAtStart_RoundsDown_FrameAtEnd_RoundsUp_IntervalCovers', () => {
    const intervals = [
      { start: 0.034, end: 0.066, fps: 30, expectedStart: 1, expectedEnd: 2 },
      { start: 0.041, end: 0.079, fps: 25, expectedStart: 1, expectedEnd: 2 },
    ];
    for (const interval of intervals) {
      const startFrame = frameAtStart(interval.start, interval.fps);
      const endFrame = frameAtEnd(interval.end, interval.fps);
      expect(startFrame).toBe(interval.expectedStart);
      expect(endFrame).toBe(interval.expectedEnd);
      expect(startFrame).toBeLessThanOrEqual(interval.start * interval.fps);
      expect(endFrame).toBeGreaterThanOrEqual(interval.end * interval.fps);
    }
  });

  it('Test_MoveFrames_ClampBoundaries_AreDerivedFromFps_NotLiteral', () => {
    expect(moveFrames(0, 400, 30)).toBe(11);
    expect(moveFrames(5000, 2, 30)).toBe(36);
    expect(moveFrames(0, 400, 25)).toBe(9);
    expect(moveFrames(5000, 2, 25)).toBe(30);

    const target = { x: 1900, y: 1040 };
    const atThirty = planMove({ x: 0, y: 0 }, target, 2, 'clamp:30', 30);
    const atTwentyFive = planMove({ x: 0, y: 0 }, target, 2, 'clamp:25', 25);
    expect(atThirty).toHaveLength(36);
    expect(atTwentyFive).toHaveLength(30);
    expect(atThirty.at(-1)).toMatchObject(target);
    expect(atTwentyFive.at(-1)).toMatchObject(target);
  });

  it('Test_AllDurationFields_UseFramesOf', () => {
    const durations = [
      { field: 'durationMs', seconds: 0.334, expected: 11 },
      { field: 'delayMs', seconds: 0.001, expected: 1 },
      { field: 'wait.ms', seconds: 1.201, expected: 37 },
      { field: 'holdSec', seconds: 0.334, expected: 11 },
      { field: 'tailSec', seconds: 0.001, expected: 1 },
      { field: 'minStepSec', seconds: 2, expected: 60 },
      { field: 'camera.durationSec', seconds: 0.6, expected: 18 },
      { field: 'waitFor.timeoutMs', seconds: 60, expected: 1800 },
    ];
    for (const duration of durations) {
      expect(framesOf(duration.seconds, FPS), duration.field).toBe(duration.expected);
    }

    const oneStepBudget = (
      action: Record<string, unknown>,
      step: Record<string, unknown> = { holdSec: 0.01, tailSec: 0.01 },
      minStepSec = 0.01,
    ) => frameBudget({ minStepSec, steps: [{ ...step, actions: [action] }] }, FPS);
    // Budget = step window (actions contain the hold) + marker windows 3+6+6+3 = 18 (17205a0d).
    expect(oneStepBudget({ type: 'drag', from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, durationMs: 334 }))
      .toEqual({ min: 40, max: 137 });
    expect(oneStepBudget({ type: 'type', target: { x: 0, y: 0 }, text: 'x', delayMs: 1 }))
      .toEqual({ min: 30, max: 127 });
    expect(oneStepBudget({ type: 'wait', ms: 1201 })).toEqual({ min: 55, max: 55 });
    expect(oneStepBudget({ type: 'press', key: 'Enter' }, { holdSec: 0.334, tailSec: 0.001 }))
      .toEqual({ min: 30, max: 30 });
    expect(oneStepBudget({ type: 'press', key: 'Enter' }, { holdSec: 0.01, tailSec: 0.001 }))
      .toEqual({ min: 20, max: 20 });
    expect(oneStepBudget({ type: 'press', key: 'Enter' }, { tailSec: 0.001 }, 2))
      .toEqual({ min: 79, max: 79 });
    expect(oneStepBudget({ type: 'camera', position: [1, 2, 3], target: [0, 0, 0], durationSec: 0.6 }))
      .toEqual({ min: 36, max: 36 });
    expect(oneStepBudget({ type: 'waitFor', selector: '#done', timeoutMs: 60000 }))
      .toEqual({ min: 20, max: 1818 });
  });

  it('Test_FramesAtMost_RoundsDown_NeverExceedsDeclaredMaximum', () => {
    expect(framesAtMost(1.2, 30)).toBe(36);
    expect(framesAtMost(1.2, 25)).toBe(30);
    expect(framesAtMost(0.99, 30)).toBe(29);
  });

  it('Test_MotionVerdict_FailsAtTwoPercent_PassesAtTwentyFourPercent', () => {
    // The 0.02 case is synthetic; 0.242 is the measured valid-run motion fraction.
    const syntheticFailure = motionVerdict([...Array(20).fill(0.5), ...Array(980).fill(0)], STILL_THRESHOLD, MIN_MOVED_FRACTION);
    const measuredPass = motionVerdict([...Array(242).fill(0.5), ...Array(758).fill(0)], STILL_THRESHOLD, MIN_MOVED_FRACTION);
    expect(syntheticFailure).toMatchObject({ movedFraction: 0.02, verdict: 'fail', diagnosis: 'motion-below-threshold' });
    expect(measuredPass).toMatchObject({ movedFraction: 0.242, verdict: 'ok' });
  });

  it('Test_Mad8x8_ComputesTheValue_OnEightBitScale', () => {
    type MadVector = { name: string; prev: number[]; cur: number[]; expectedMad: number };
    const vectors = JSON.parse(readFileSync(
      new URL('../scripts/tutorial/fixture/mad8x8-vectors.json', import.meta.url),
      'utf8',
    )) as MadVector[];
    expect(vectors.map((vector) => vector.expectedMad)).toEqual([0.5, 0.484375]);
    for (const vector of vectors) {
      expect(vector.prev, vector.name).toHaveLength(64);
      expect(vector.cur, vector.name).toHaveLength(64);
      expect(vector.prev.every((value) => Number.isInteger(value) && value >= 0 && value <= 255), vector.name).toBe(true);
      expect(vector.cur.every((value) => Number.isInteger(value) && value >= 0 && value <= 255), vector.name).toBe(true);
      expect(vector.prev.filter((value, index) => value !== vector.cur[index]), vector.name).toHaveLength(1);
      expect(mad8x8(vector.prev, vector.cur), vector.name).toBe(vector.expectedMad);
    }
  });

  it('Test_MotionVerdict_Denominator_IsFramesMinusOne', () => {
    const result = motionVerdict([...Array(652).fill(0.5), ...Array(2047).fill(0)], STILL_THRESHOLD, MIN_MOVED_FRACTION);
    expect(result).toMatchObject({ diffs: 2699, movedFrames: 652, verdict: 'ok' });
    expect(result.movedFraction).toBeCloseTo(0.242, 3);
    expect(1 - result.movedFraction).toBeCloseTo(0.758, 3);
  });

  it('Test_MotionVerdict_ControlFrameAllBlack_Fails', () => {
    expect(controlFrameVerdict(new Uint8Array(64), STILL_THRESHOLD)).toEqual({
      controlMad: 0,
      verdict: 'fail',
      diagnosis: 'decoder-blank',
    });
  });

  it('Test_MotionVerdict_SkippedNoViewer_IsNotOk', () => {
    const skipped = {
      ...declaredMotion,
      verdict: 'skipped-no-viewer',
      reason: 'motion-check-off-no-canvas',
    } as const;
    expect(skipped.verdict).not.toBe('ok');
    expect(motionShapeVerdict(skipped)).toMatchObject({ verdict: 'ok', problems: [] });
  });

  it('Test_MotionShape_IsADiscriminatedUnion_PerVerdict', () => {
    const measured = {
      ...declaredMotion,
      verdict: 'ok',
      frames: 2700,
      movedFrames: 652,
      movedFraction: 0.242,
      longestStillFrames: 2047,
      controlFrame: 'control-1350.pgm',
      controlMad: 24,
    } as const;
    const skipped = {
      ...declaredMotion,
      verdict: 'skipped-no-viewer',
      reason: 'motion-check-off-no-canvas',
    } as const;
    expect(motionShapeVerdict(measured)).toMatchObject({ verdict: 'ok' });
    expect(motionShapeVerdict({ ...measured, verdict: 'fail' })).toMatchObject({ verdict: 'ok' });
    expect(motionShapeVerdict(skipped)).toMatchObject({ verdict: 'ok' });

    const missingMovedFraction: Record<string, unknown> = { ...measured };
    delete missingMovedFraction.movedFraction;
    const nullableSkip: Record<string, unknown> = { ...skipped, movedFrames: null };
    expect(motionShapeVerdict(missingMovedFraction)).toMatchObject({ verdict: 'fail' });
    expect(motionShapeVerdict(nullableSkip)).toMatchObject({ verdict: 'fail' });

    const measuredWithoutRegion: Record<string, unknown> = { ...measured };
    delete measuredWithoutRegion.region;
    const skippedWithoutThreshold: Record<string, unknown> = { ...skipped };
    delete skippedWithoutThreshold.minMovedFraction;
    expect(motionShapeVerdict(measuredWithoutRegion)).toMatchObject({ verdict: 'fail' });
    expect(motionShapeVerdict(skippedWithoutThreshold)).toMatchObject({ verdict: 'fail' });

    const wrongMeasuredTypes = { ...measured, frames: '2700', controlFrame: 42 };
    expect(motionShapeVerdict(wrongMeasuredTypes)).toMatchObject({ verdict: 'fail' });
  });
});

describe('tutorial-events command/pick (plan-2031 P2)', () => {
  function commandTrace(): { segments: Segment[]; steps: StepRecord[] } {
    return {
      segments: [
        { kind: 'marker', start: 0, end: 9, stepId: null },
        { kind: 'command', id: 'sim.reset', start: 9, end: 11, stepId: 'reset' },
        { kind: 'hold', start: 11, end: 12, stepId: 'reset' },
        { kind: 'marker', start: 12, end: 21, stepId: null },
      ],
      steps: [{ id: 'reset', start: 9, end: 12 }],
    };
  }

  const budgetFor = (actions: Record<string, unknown>[], fps = FPS) => frameBudget({
    minStepSec: 0.01,
    steps: [{ holdSec: 0.01, tailSec: 0, actions }],
  }, fps);

  it('Test_TraceCoverage_CommandWithId_Accepted', () => {
    const trace = commandTrace();
    expect(traceCoverageVerdict(trace.segments, [], 21, trace.steps)).toMatchObject({
      verdict: 'ok', stepBoundsOk: true, problems: [],
    });
  });

  it('Test_TraceCoverage_CommandWithoutId_ConditionVFails', () => {
    const trace = commandTrace();
    delete trace.segments[1].id;
    const result = traceCoverageVerdict(trace.segments, [], 21, trace.steps);
    expect(result).toMatchObject({ verdict: 'fail', diagnosis: 'trace-not-contiguous', stepBoundsOk: true });
    expect(result.problems).toContainEqual(expect.stringMatching(/\(v\).*command.*id/));
  });

  it('Test_TraceCoverage_UnknownKind_StillRejected', () => {
    const trace = commandTrace();
    trace.segments[1].kind = 'unknown' as Segment['kind'];
    const result = traceCoverageVerdict(trace.segments, [], 21, trace.steps);
    expect(result.verdict).toBe('fail');
    expect(result.problems).toContainEqual(expect.stringMatching(/\(v\).*unknown kind/));
  });

  it('Test_SegmentKindOf_CommandAndPick_Classified', () => {
    expect(segmentKindOf('command')).toBe('command');
    expect(segmentKindOf('pick')).toBe('action');
  });

  it('Test_FrameBudget_ClickCommand_IncludesApproach', () => {
    const command = { type: 'command', id: 'sim.reset', waitSec: 0, maxWaitSec: 1 };
    const direct = budgetFor([{ ...command, via: 'direct' }]);
    const click = budgetFor([{ ...command, via: 'click' }]);
    const markers = frameBudget({ steps: [] }, FPS);
    expect(click.max).toBeGreaterThan(direct.max);
    expect(direct.min - markers.min).toBeGreaterThanOrEqual(2);
    for (const budget of [direct, click]) {
      expect(Number.isFinite(budget.min)).toBe(true);
      expect(Number.isFinite(budget.max)).toBe(true);
      expect(budget.min).toBeLessThanOrEqual(budget.max);
    }
  });

  it('Test_FrameBudget_AsyncCommand_UpperBoundIncludesMaxWait', () => {
    const command = { type: 'command', id: 'sim.reset', via: 'direct', waitSec: 0 };
    const short = budgetFor([{ ...command, maxWaitSec: 1 }]);
    const long = budgetFor([{ ...command, maxWaitSec: 30 }]);
    // Increasing the timeout from 1 s to 30 s adds 29 s, not another 30 s.
    expect(long.max - short.max).toBe(framesOf(30, FPS) - framesOf(1, FPS));
    expect(long.max - frameBudget({ steps: [] }, FPS).max).toBeGreaterThanOrEqual(framesOf(30, FPS));
    expect(long.min).toBe(short.min);
  });

  it('Test_FrameBudget_Pick_UsesSampleFramesExactly', () => {
    for (const sampleSec of [0.3, 0.334, 1.2]) {
      const budget = budgetFor([{ type: 'pick', rule: 'moving-vehicle', among: '/Vehicles/*', as: 'agv', sampleSec }]);
      const markers = frameBudget({ steps: [] }, FPS);
      expect(budget).toEqual({
        min: markers.min + framesOf(sampleSec, FPS),
        max: markers.max + framesOf(sampleSec, FPS),
      });
      expect(Number.isFinite(budget.min)).toBe(true);
      expect(Number.isFinite(budget.max)).toBe(true);
      expect(budget.min).toBeLessThanOrEqual(budget.max);
    }
  });

  it('Test_FrameBudget_AsyncCommandOverBudget_ReportedOutsideBudget', () => {
    const budget = budgetFor([{ type: 'command', id: 'sim.reset', via: 'direct', waitSec: 0.3, maxWaitSec: 1 }]);
    const frames = framesOf(30, FPS);
    expect(budget.max).toBeLessThan(frames);
    // Same predicate as run.mjs events.frameCheck.budget; this is not a Gate A verdict.
    const report = { ...budget, withinBudget: frames >= budget.min && frames <= budget.max };
    expect(report.withinBudget).toBe(false);
  });
});

// Defekt D (2026-10-27): `stampsContiguous` had no direct coverage — its only live assertion sat
// inside the red viewer suite. These are the seven isolated reader cases measured on the Razer.
describe('stampsContiguous — the Gate A stamp reader', () => {
  it('Test_StampsContiguous_OffsetStart_Accepted_OnlyPlusOneIsChecked', () => {
    expect(stampsContiguous([40, 41, 42, 43, 44, 45])).toEqual({ contiguous: true, firstBreak: null, reason: null });
  });

  it('Test_StampsContiguous_SpikeShape_BreaksAtTheFirstHiddenStamp', () => {
    expect(stampsContiguous([0, 1, 2, 65535, 65535, 9])).toMatchObject({ contiguous: false, firstBreak: 3 });
  });

  it('Test_StampsContiguous_RepeatedFrame_Breaks', () => {
    expect(stampsContiguous([5, 6, 6, 7])).toMatchObject({ contiguous: false, firstBreak: 2 });
  });

  it('Test_StampsContiguous_JumpByTwo_Breaks', () => {
    expect(stampsContiguous([5, 6, 8, 9])).toMatchObject({ contiguous: false, firstBreak: 2 });
  });

  it('Test_StampsContiguous_WrapAt16Bits_Accepted', () => {
    expect(stampsContiguous([65534, 65535, 0, 1])).toMatchObject({ contiguous: true });
  });

  it('Test_StampsContiguous_FewerThanTwo_Refused', () => {
    expect(stampsContiguous([40])).toMatchObject({ contiguous: false, reason: 'fewer than two stamps read' });
    expect(stampsContiguous([])).toMatchObject({ contiguous: false, reason: 'fewer than two stamps read' });
  });

  it('Test_StampsContiguous_MarkerOverStamp_TwelveZeros_BreaksWithReason', () => {
    const stamps = [...Array.from({ length: 9 }, (_, i) => 30 + i), ...Array(12).fill(0), 51, 52];
    expect(stampsContiguous(stamps)).toEqual({
      contiguous: false, firstBreak: 9, reason: 'stamp 38 at frame 8 is followed by 0 at frame 9, expected 39',
    });
  });
});
