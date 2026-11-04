// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** One source for des.status, web_des_status and the toolbar run-state chip. */
import type { SimDesControl } from './simulation-kernel';

export type DesRunState = 'not-des' | 'idle' | 'running' | 'paused' | 'finished' | 'stalled';
export type DesRunReason = 'duration-reached' | 'queue-drained' | 'queue-empty-before-end'
  | 'paused' | 'running' | 'not-started' | 'no-des';
export interface DesRunStatus {
  runState: DesRunState;
  reason: DesRunReason;
  simTime: number;
  endTime: number;
  progress: number | null;
  finishedAt: number | null;
  processed: number;
  pending: number;
  nextEventTime: number;
  pauseReasons: string[];
}
export interface DesRunEnv { simulationPaused: boolean; pauseReasons: readonly string[] }

export function computeDesRunState(c: SimDesControl | null, env: DesRunEnv): DesRunStatus {
  if (c == null) return {
    runState: 'not-des', reason: 'no-des', simTime: 0, endTime: Infinity,
    progress: null, finishedAt: null, processed: 0, pending: 0, nextEventTime: 0, pauseReasons: [],
  };
  const stats = c.eventStats?.();
  const simTime = stats?.currentTime ?? c.simTime;
  const endTime = c.endTime ?? Infinity;
  const processed = stats?.processed ?? 0;
  const pending = stats?.pending ?? 0;
  const nextEventTime = stats?.nextEventTime ?? c.nextEventTime ?? Infinity;
  const s: DesRunStatus = {
    runState: 'running', reason: 'running', simTime, endTime,
    progress: Number.isFinite(endTime) && endTime > 0 ? Math.min(1, simTime / endTime) : null,
    finishedAt: null, processed, pending, nextEventTime, pauseReasons: [],
  };
  const complete = c.runComplete;
  if (complete) {
    s.runState = complete.reason === 'queue-empty-before-end' ? 'stalled' : 'finished';
    s.reason = complete.reason;
    s.finishedAt = complete.simTime;
  } else if (c.ffProgress !== undefined) {
    return s;
  } else if (env.simulationPaused || c.paused) {
    s.runState = 'paused';
    s.reason = 'paused';
    s.pauseReasons = [...env.pauseReasons];
    if (!env.simulationPaused && c.paused && s.pauseReasons.length === 0) s.pauseReasons.push('des');
  } else if (!('runComplete' in c) && pending > 0 && nextEventTime > endTime) {
    s.runState = 'finished';
    s.reason = 'duration-reached';
    s.finishedAt = simTime;
  } else if (!('runComplete' in c) && nextEventTime === Infinity && simTime < endTime && processed > 0) {
    s.runState = 'stalled';
    s.reason = 'queue-empty-before-end';
    s.finishedAt = simTime;
  } else if (processed === 0) {
    s.runState = 'idle';
    s.reason = 'not-started';
  }
  return s;
}

/** Preserve non-finite numbers as strings instead of JSON's lossy null. */
export function serializeDesRunStatus(s: DesRunStatus) {
  const number = (n: number): number | string => Number.isFinite(n) ? n : String(n);
  return {
    ...s, simTime: number(s.simTime), endTime: number(s.endTime),
    progress: s.progress === null ? null : number(s.progress),
    finishedAt: s.finishedAt === null ? null : number(s.finishedAt),
    processed: number(s.processed), pending: number(s.pending), nextEventTime: number(s.nextEventTime),
    pauseReasons: [...s.pauseReasons],
  };
}
