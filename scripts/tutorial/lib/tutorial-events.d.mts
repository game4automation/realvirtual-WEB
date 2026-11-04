// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Type declarations for `tutorial-events.mjs` (plan-2004).
 *
 * Required because the node tests import the module statically from TypeScript; without it
 * `npx tsc -p tsconfig.full.json --noEmit` fails with TS7016. Keep in step with the .mjs — there
 * is no compiler check tying the two together.
 */

export type SegmentKind = 'action' | 'command' | 'wait' | 'hold' | 'marker';
export type Verdict = 'ok' | 'fail';

export interface Box { x: number; y: number; w: number; h: number }

export interface Segment {
  kind: SegmentKind;
  id?: string;
  start: number;
  end: number;
  stepId: string | null;
  actionIndex?: number;
  target?: Box;
  approach?: Box;
}

export interface PointerSample { frame: number; t: number; x: number; y: number }

export interface StepRecord {
  id: string;
  start: number;
  end: number;
  holdSec?: number;
  outcome?: 'ok' | 'error';
  error?: string;
}

export interface MarkerRecord {
  which?: 'start' | 'end';
  onsetFrame: number;
  expectedFrame: number;
  offsetFrames: number;
}

export const DEFAULT_FPS: 30;
export const MIN_WAIT_FOR_FRAMES: 1;
export const MARKER_SEC: number;
export const MARKER_LEAD_SEC: number;
export const MARKER_TAIL_SEC: number;
export const MAX_REACTION_FRAMES: number;
export const STILL_THRESHOLD: number;
export const MIN_MOVED_FRACTION: number;
export const DEFAULT_MOTION_REGION: Readonly<Box>;
export const MOTION_METRIC: 'mad8x8gray';
export const MOTION_SCALE: '8bit-gray-0-255';
export const MOTION_DOWNSCALE: 'scale=8:8:flags=area';
export const TRACE_DIAGNOSIS: 'trace-not-contiguous';
export const SEGMENT_KINDS: readonly SegmentKind[];
export const POINTER_ACTIONS: readonly string[];

export function frameToSec(frame: number, fps: number): number;
export function framesOf(sec: number, fps: number): number;
export function frameAtStart(sec: number, fps: number): number;
export function frameAtEnd(sec: number, fps: number): number;
export function framesAtMost(sec: number, fps: number): number;

export function markerVerdict(onsetFrame: number, expectedFrame: number):
  { onsetFrame: number; expectedFrame: number; offsetFrames: number; verdict: Verdict; diagnosis?: string };

export function syncVerdict(
  startMarker: { onsetFrame: number; expectedFrame: number },
  endMarker: { onsetFrame: number; expectedFrame: number },
): { markers: MarkerRecord[]; driftFrames: number; verdict: Verdict; diagnosis?: string };

export function mad8x8(prev: ArrayLike<number>, cur: ArrayLike<number>): number;

export function motionVerdict(
  diffs: number[],
  stillThreshold?: number,
  minMovedFraction?: number,
): { diffs: number; movedFrames: number; movedFraction: number; longestStillFrames: number; verdict: Verdict; diagnosis?: string };

export function controlFrameVerdict(
  controlThumbnail: ArrayLike<number>,
  stillThreshold?: number,
): { controlMad: number; verdict: Verdict; diagnosis?: string };

export function motionShapeVerdict(motion: unknown): { verdict: Verdict; problems: string[] };

export function frameCountVerdict(
  traceFrames: number,
  probedFrames: number,
  stampsContiguous: boolean,
  traceContiguous: boolean,
): { verdict: Verdict; diagnosis?: string; compared: boolean };

export function traceCoverageVerdict(
  segments: Segment[],
  pointer: PointerSample[],
  frames: number,
  steps: StepRecord[],
): {
  verdict: Verdict;
  diagnosis?: string;
  stepBoundsOk: boolean;
  firstStart: number | null;
  lastEnd: number | null;
  problems: string[];
};

export function moveFrameBounds(fps: number): { min: number; max: number };
export function segmentKindOf(actionType: string): SegmentKind;
export function frameBudget(script: unknown, fps: number): { min: number; max: number };
