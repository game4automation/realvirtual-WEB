// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import type { SimDesControl } from '../../src/core/material-flow/simulation-kernel';
import { computeDesRunState, serializeDesRunStatus } from '../../src/core/material-flow/rv-des-run-state';

const env = { simulationPaused: false, pauseReasons: [] };

function fakeCtl(overrides: Partial<SimDesControl> & { processed?: number; pending?: number } = {}): SimDesControl {
  const { processed = 10, pending = 1, ...control } = overrides;
  const c = { simTime: 10, endTime: 100, nextEventTime: 20, runComplete: null, ...control };
  return {
    eventStats: () => ({ currentTime: c.simTime, processed, pending, nextEventTime: c.nextEventTime }),
    ...c,
  } as SimDesControl;
}

describe('computeDesRunState', () => {
  it('finishes at the completion edge even with 37 pending events and an active pause/FF', () => {
    const s = computeDesRunState(fakeCtl({
      simTime: 86_399.2, endTime: 86_400, pending: 37, nextEventTime: 86_412, processed: 9_000,
      runComplete: { reason: 'duration-reached', simTime: 86_399.2 }, ffProgress: 0.4,
    }), { simulationPaused: true, pauseReasons: ['user'] });
    expect(s).toMatchObject({ runState: 'finished', reason: 'duration-reached', pending: 37,
      finishedAt: 86_399.2, pauseReasons: [] });
    expect(s.progress).toBe(86_399.2 / 86_400);
  });

  it('reports an empty model queue before a finite end as stalled', () => {
    expect(computeDesRunState(fakeCtl({ pending: 0, nextEventTime: Infinity,
      runComplete: { reason: 'queue-empty-before-end', simTime: 10 } }), env))
      .toMatchObject({ runState: 'stalled', reason: 'queue-empty-before-end', finishedAt: 10 });
  });

  it('finishes a drained infinite run with no progress fraction', () => {
    expect(computeDesRunState(fakeCtl({ endTime: Infinity, pending: 0, nextEventTime: Infinity,
      runComplete: { reason: 'queue-drained', simTime: 10 } }), env))
      .toMatchObject({ runState: 'finished', reason: 'queue-drained', finishedAt: 10, progress: null });
  });

  it('uses the effective viewer pause even when the manager is not paused', () => {
    const pauseReasons = ['user'];
    const s = computeDesRunState(fakeCtl({ paused: false }), { simulationPaused: true, pauseReasons });
    expect(s).toMatchObject({ runState: 'paused', reason: 'paused', pauseReasons: ['user'] });
    expect(s.pauseReasons).not.toBe(pauseReasons);
  });

  it('labels a manager-only pause as des', () => {
    expect(computeDesRunState(fakeCtl({ paused: true }), env))
      .toMatchObject({ runState: 'paused', reason: 'paused', pauseReasons: ['des'] });
  });

  it('keeps FF running despite viewer and manager pauses', () => {
    expect(computeDesRunState(fakeCtl({ ffProgress: 0.4, paused: true }),
      { simulationPaused: true, pauseReasons: ['user'] }))
      .toMatchObject({ runState: 'running', reason: 'running', pauseReasons: [] });
  });

  it('distinguishes idle from running without inferring completion for a modern runner', () => {
    expect(computeDesRunState(fakeCtl({ processed: 0 }), env))
      .toMatchObject({ runState: 'idle', reason: 'not-started' });
    expect(computeDesRunState(fakeCtl({ pending: 0, nextEventTime: Infinity }), env))
      .toMatchObject({ runState: 'running', reason: 'running', finishedAt: null });
  });

  it('returns the not-DES defaults', () => {
    expect(computeDesRunState(null, env)).toEqual({
      runState: 'not-des', reason: 'no-des', simTime: 0, endTime: Infinity, progress: null,
      finishedAt: null, processed: 0, pending: 0, nextEventTime: 0, pauseReasons: [],
    });
  });

  it('supports both legacy completion branches only after pause and FF', () => {
    const c = fakeCtl({ nextEventTime: 101 });
    delete (c as { runComplete?: unknown }).runComplete;
    expect(computeDesRunState(c, env))
      .toMatchObject({ runState: 'finished', reason: 'duration-reached', finishedAt: 10 });
    expect(computeDesRunState(c, { simulationPaused: true, pauseReasons: ['user'] }).runState).toBe('paused');
    const empty = fakeCtl({ pending: 0, nextEventTime: Infinity });
    delete (empty as { runComplete?: unknown }).runComplete;
    expect(computeDesRunState(empty, env))
      .toMatchObject({ runState: 'stalled', reason: 'queue-empty-before-end', finishedAt: 10 });
    expect(computeDesRunState({ ...empty, ffProgress: 0.4 }, env).runState).toBe('running');
    const idle = fakeCtl({ pending: 0, processed: 0, nextEventTime: Infinity });
    delete (idle as { runComplete?: unknown }).runComplete;
    expect(computeDesRunState(idle, env).runState).toBe('idle');
  });

  it('prefers eventStats and falls back to control clocks and zero counters', () => {
    expect(computeDesRunState(fakeCtl({ eventStats: () => ({
      currentTime: 200, processed: 50, pending: 3, nextEventTime: 210,
    }) }), env)).toMatchObject({ simTime: 200, processed: 50, pending: 3, nextEventTime: 210, progress: 1 });
    expect(computeDesRunState(fakeCtl({ eventStats: undefined }), env))
      .toMatchObject({ simTime: 10, processed: 0, pending: 0, nextEventTime: 20 });
    expect(computeDesRunState(fakeCtl({ eventStats: undefined, endTime: undefined, nextEventTime: undefined }), env))
      .toMatchObject({ endTime: Infinity, nextEventTime: Infinity, progress: null });
  });
});

describe('serializeDesRunStatus', () => {
  it('preserves infinite times as strings through JSON', () => {
    const s = computeDesRunState(fakeCtl({ endTime: Infinity, nextEventTime: Infinity }), env);
    expect(JSON.parse(JSON.stringify(serializeDesRunStatus(s))))
      .toMatchObject({ endTime: 'Infinity', nextEventTime: 'Infinity', progress: null, finishedAt: null });
  });

  it('serializes every numeric field including negative infinity and NaN', () => {
    const s = computeDesRunState(null, env);
    expect(serializeDesRunStatus({ ...s, simTime: -Infinity, endTime: Infinity,
      nextEventTime: Infinity, progress: NaN, finishedAt: -Infinity, processed: NaN, pending: Infinity }))
      .toMatchObject({ simTime: '-Infinity', endTime: 'Infinity', nextEventTime: 'Infinity',
        progress: 'NaN', finishedAt: '-Infinity', processed: 'NaN', pending: 'Infinity' });
  });
});
