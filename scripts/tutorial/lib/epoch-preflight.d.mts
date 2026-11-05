// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Type declarations for epoch-preflight.mjs (plan-2004, B2 decision 2026-10-27). */

export interface PreflightSample {
  simTime: number;
  fixedStepCount: number;
  /** Numeric performance.now() reading for the paused-start monotonic clock check. */
  now?: number;
  /** (ii): `performance.now() >= epoch` right after this reading's step; absent for samples[0]. */
  nowAtLeastEpoch?: boolean;
  /** plan-2237 F6: DES sample — the preflight measures `renderClock` instead of `simTime`. */
  des?: boolean;
  renderClock?: number | null;
}

export interface PreflightReport {
  verdict: 'ok' | 'fail';
  diagnosis: 'virtual-clock-epoch' | null;
  reason: string | null;
  epoch: number | null;
  warmupFrames: number | null;
  windowFrames: number;
  window: { dSimTime: number; dSteps: number }[];
  sumSimTime: number | null;
  sumSteps: number | null;
  expectedSimTime: number;
  fixedDtObs: number | null;
  deviation: number | null;
  tolerance: number | null;
  firstViolationFrame: number | null;
}

export const PREFLIGHT_WARMUP_SEC: number;
export const PREFLIGHT_WINDOW_FRAMES: number;
export const PREFLIGHT_SIM_TOLERANCE_SEC: number;

export interface ClockOnlyReport {
  verdict: 'ok' | 'fail';
  diagnosis: 'virtual-clock-epoch' | null;
  reason: string | null;
  epoch: number | null;
  checkedFrames: number;
}

export function clockOnlyVerdict(input: {
  samples: readonly { now: number }[];
  epoch?: number;
}): ClockOnlyReport;

export interface SimProgressReport {
  verdict: 'ok' | 'fail' | 'indeterminate';
  clock: 'simTime' | 'renderClock';
  diagnosis: 'sim-progress' | null;
  reason: string | null;
  factor: number;
  windowFrames: number;
  sumSimTime: number | null;
  expectedSimTime: number | null;
  deviation: number | null;
  tolerance: number | null;
}

export const DES_FALLBACK_WINDOW_FRAMES: number;
export const DES_FALLBACK_MAX_GAP_RATIO: number;

export function simProgressVerdict(input: {
  samples: readonly ((PreflightSample & { renderClock?: number | null; des?: boolean }) | null | undefined)[];
  fps: number;
  factor: number;
  windowFrames?: number;
}): SimProgressReport;

export function warmupEndIndex(samples: readonly (PreflightSample | null | undefined)[], warmupMaxFrames: number): number | null;

export function preflightVerdict(input: {
  samples: readonly (PreflightSample | null | undefined)[];
  fps: number;
  warmupMaxFrames: number;
  epoch?: number;
  windowFrames?: number;
  /** plan-2237 F6: effective factor from `sim.clock.get` (default 1). */
  factor?: number;
}): PreflightReport;

// ─── plan-2237: segment gate ───

export const FIXED_STEP_HZ: number;
export const I1_TOLERANCE_STEPS: number;
export const I2_TOLERANCE_PER_FRAME_SEC: number;
export const MIN_SEGMENT_FRAMES: number;
export const TIME_COMMANDS: readonly string[];

/** One normalised `sim.clock.get` reading per output frame. */
export interface GateSample {
  mode: 'continuous' | 'des';
  paused: boolean;
  simTime: number;
  fixedStepCount: number;
  factor: number | null;
  subMode: string | null;
  renderClock: number | null;
  endTime: number | null;
  clampBudget: number;
  clampEnd: number;
}

export interface GateWindow { start: number; end: number; cmd: string; kind?: 'transition' | 'timelapse' }

export interface GateSegment {
  index: number;
  startFrame: number;
  endFrame: number;
  kind: 'run' | 'hold' | 'jump' | 'timelapse' | 'short';
  factor: number | null;
  clock: 'simTime' | 'renderClock';
  i1: number;
  i2: number;
  verdict: 'pass' | 'fail' | 'clamped' | 'short' | 'skipped';
  clampedAt?: 'budget' | 'end';
  cmd?: string;
  /** Judged segments: evaluated frames, clock advance (s) and fixed steps over the segment. */
  frames?: number;
  sumClock?: number;
  sumSteps?: number;
}

export interface SimJump { frame: number; cmd: string; fromSim: number; toSim: number }

export interface SegmentGateReport {
  verdict: 'ok' | 'fail';
  diagnosis: 'sim-progress' | null;
  reason: string | null;
  segments: GateSegment[];
  simJumps: SimJump[];
  /** Factor and clock of the first evaluated run segment (compatibility with the old report). */
  factor: number | null;
  clock: 'simTime' | 'renderClock' | null;
  /** The pre-plan-2237 report fields, over the first judged run segment (null without one): clock
   *  advance, `factor · frames / fps`, their distance, one fixed step at the factor + the I2 allowance. */
  sumSimTime: number | null;
  expectedSimTime: number | null;
  deviation: number | null;
  tolerance: number | null;
}

export function clockSampleOf(value: unknown): GateSample | null;
export function gateClockOf(sample: GateSample): number;
export function gateStateKey(sample: GateSample): string;
export function segmentGate(input: { samples: readonly (GateSample | null)[]; fps: number; windows?: readonly GateWindow[] }): SegmentGateReport;

/** plan-2237: a take-wide time-command watch event (`__rvRecording.takeTimeWatch()`). */
export interface TimeWatchEvent { id: string; phase: 'dispatch' | 'done'; ok?: boolean }
export function timeCommandWindows(eventsAt: readonly (readonly TimeWatchEvent[] | undefined)[], lastFrame: number): GateWindow[];
