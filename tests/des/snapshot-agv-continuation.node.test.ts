// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, expect, it } from 'vitest';
import { clearShared } from '../helpers/agv-harness';
import { assertContinuation, compareFullSnapshots } from '../helpers/des-continuation-harness';
import { agvContinuationWorld, findAgvCut, type AgvContinuationOptions } from '../helpers/agv-continuation-world';

afterEach(() => { clearShared(); });

function serviceCut() {
  return findAgvCut({}, w => w.agvState().phase === 'servicing' && w.agvState().desServiceEvent >= 0) + 1;
}

for (const mode of ['A', 'B', 'B-immediate'] as const) {
  it(`${mode}: service stay retains the Agv participant and ServiceEnd handle`, async () => {
    const T = serviceCut();
    await assertContinuation({ mode, T, TPrime: T + 4, T2: T + 30,
      buildWorld: () => {
        const w = agvContinuationWorld(), step = w.step.bind(w);
        w.step = t => {
          step(t);
          if (t === T) {
            const state = w.agvState();
            expect(state.phase).toBe('servicing');
            expect(state.desServiceEvent).toBeGreaterThanOrEqual(0);
            expect(w.runner.fullSnapshot().eventQueue.find(e => e.id === state.desServiceEvent)?.action)
              .toBe('MF.Agv.ServiceEnd');
          }
        };
        return w;
      } });
  });

  for (const stay of [false, true]) {
    it(`${mode}: freeze during ${stay ? 'service stay' : 'travel'} resumes after restore`, async () => {
      const freezeAt = stay ? serviceCut() : 2;
      const options: AgvContinuationOptions = { long: !stay, freezeAt, resumeAt: freezeAt + 5 };
      const T = freezeAt + 2;
      await assertContinuation({ mode, T, TPrime: freezeAt + 8, T2: stay ? freezeAt + 35 : 240,
        buildWorld: () => {
          const w = agvContinuationWorld(options), step = w.step.bind(w);
          w.step = t => {
            step(t);
            const state = w.agvState();
            if (t === T) {
              expect(state.frozen).toBe(true);
              expect(w.authority.isFrozen('A')).toBe(true);
              expect(state.desServiceEvent).toBe(-1);
              if (stay) {
                expect(state.phase).toBe('servicing');
                expect(state.frozenServiceSec).toBeGreaterThan(0);
              } else expect(state.frozenServiceSec).toBe(-1);
            }
            if (t > options.resumeAt!) {
              expect(state.frozen).toBe(false);
              expect(state.frozenServiceSec).toBe(-1);
              expect(w.authority.isFrozen('A')).toBe(false);
            }
          };
          return w;
        } });
    });
  }

  it(`${mode}: cut immediately before the next queued extend/flush Replan`, async () => {
    const pilot = agvContinuationWorld({ long: true });
    let T: number;
    try {
      const event = pilot.runner.fullSnapshot().eventQueue.find(e => e.action === 'MF.Agv.Replan'
        && ['extend', 'flush'].includes((e.data as { data: { kind: string } }).data.kind)
        && e.time > pilot.manager.currentTime);
      expect(event).toBeDefined();
      T = event!.time - 1e-6;
    } finally { pilot.dispose(); }
    await assertContinuation({ mode, T, TPrime: T + 1, T2: T + 35,
      buildWorld: () => {
        const w = agvContinuationWorld({ long: true }), step = w.step.bind(w);
        w.step = t => {
          step(t);
          if (t === T) {
            const next = w.runner.fullSnapshot().eventQueue.find(e => e.action === 'MF.Agv.Replan'
              && ['extend', 'flush'].includes((e.data as { data: { kind: string } }).data.kind));
            expect(next).toBeDefined();
            expect(next!.time - T).toBeCloseTo(1e-6, 9);
          }
        };
        return w;
      } });
  });

  it(`${mode}: equal-time events for two AGVs retain event-ID tie order`, async () => {
    const T = serviceCut();
    await assertContinuation({ mode, T, TPrime: T + 4, T2: T + 30,
      buildWorld: () => {
        const w = agvContinuationWorld({ twins: true }), step = w.step.bind(w);
        let tied: { time: number; owners: (string | null)[] } | undefined;
        w.step = t => {
          step(t);
          if (t === T) {
            const events = w.runner.fullSnapshot().eventQueue.filter(e => e.action === 'MF.Agv.ServiceEnd')
              .sort((a, b) => a.id - b.id);
            expect(events).toHaveLength(2);
            expect(events[0].time).toBe(events[1].time);
            expect(events[0].id).toBeLessThan(events[1].id);
            tied = { time: events[0].time, owners: events.map(e => e.componentId) };
          }
          // On a newly built B world the harness restores directly at T;
          // the full dispatch trace is still compared by the harness there.
          if (t > T + 20 && tied) expect(w.trace().filter(e => e.action === 'MF.Agv.ServiceEnd'
            && e.time === tied!.time).slice(-2).map(e => e.componentId)).toEqual(tied.owners);
        };
        return w;
      } });
  });
}

for (const mode of ['A', 'B', 'B-immediate'] as const) {
it(`${mode}: task switch immediately after restore cancels the original ServiceEnd event`, () => {
  const T = serviceCut();
  let w = agvContinuationWorld();
  try {
    // Independent reference owner: apply the same input at the cut.
    w.step(T);
    const end = w.runner.fullSnapshot().eventQueue.find(e => e.id === w.agvState().desServiceEvent)!.time + 5;
    w.assign('Entry');
    if (mode !== 'B-immediate') w.step(end);
    const reference = w.runner.fullSnapshot();
    w.dispose();
    w = agvContinuationWorld();
    w.step(T);
    const saved = w.runner.fullSnapshot(), eventId = w.agvState().desServiceEvent;
    const original = saved.eventQueue.find(e => e.id === eventId)!;
    expect(original.action).toBe('MF.Agv.ServiceEnd');
    if (mode === 'A') w.step(T + 30);
    else { w.dispose(); w = agvContinuationWorld(); }
    w.runner.restoreFull(saved);
    compareFullSnapshots(saved, w.runner.fullSnapshot());
    expect(w.agvState().desServiceEvent).toBe(eventId);
    const start = w.trace().length;
    // The fleet API enters Agv's cancelServiceEnd path; do not cancel self directly.
    w.assign('Entry');
    expect(w.runner.fullSnapshot().eventQueue.some(e => e.id === eventId)).toBe(false);
    if (mode !== 'B-immediate') w.step(end);
    expect(w.trace().slice(start).filter(e => e.action === 'MF.Agv.ServiceEnd')).toEqual([]);
    compareFullSnapshots(reference, w.runner.fullSnapshot());
  } finally { w.dispose(); }
});
}
