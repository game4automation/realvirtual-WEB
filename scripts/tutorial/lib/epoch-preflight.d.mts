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
}): PreflightReport;
