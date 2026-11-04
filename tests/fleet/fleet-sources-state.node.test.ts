// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { ContinuousSimClock, type ClockHandle } from '../../src/core/fleet/core/sim-clock';
import { TaktSource, PauseSource } from '../../src/core/fleet/core/order-sources';
import { WaitWatch } from '../../src/core/fleet/exec/wait-watch';
import { SFC32 } from '../../src/core/rv-rng-distribution';

function fixture() {
  const clock = new ContinuousSimClock(), calls: string[] = [];
  const handles = new Map<string, ClockHandle>();
  const schedule = clock.scheduleAction.bind(clock);
  clock.scheduleAction = (at, kind, data, opts) => {
    const h = schedule(at, kind, data, opts); handles.set(kind, h); return h;
  };
  const takt = new TaktSource(clock, { intervalSec: 10, phaseSec: [5], stochastic: true }, 1,
    { headFree: () => true, release: () => calls.push(`takt:${clock.now()}`), blocked: () => calls.push('blocked') }, new SFC32(42));
  const pause = new PauseSource(clock, { everySec: 20, durationSec: 2, offsetSec: [5] }, 1,
    { setRun: () => calls.push(`pause:${clock.now()}`), wake: () => calls.push('wake'), resumed: () => calls.push('resumed') });
  const wait = new WaitWatch({ clock, defaultLimitSec: 5, problems: { report: () => calls.push(`wait:${clock.now()}`), clear: () => calls.push('clear') } });
  takt.start(); pause.start(); wait.begin('V', 'fork'); calls.length = 0;
  return { clock, calls, takt, pause, wait, handles };
}

describe('fleet source state', () => {
  it('prepares detached containers and swaps silently; queued actions resolve restored records', () => {
    const { clock, calls, takt, pause, wait } = fixture();
    const t = takt.exportState(), p = pause.exportState(), w = wait.exportState();
    const pt = takt.prepareState(t), pp = pause.prepareState(p), pw = wait.prepareState(w);
    t.states[0].released = 999; t.handles[0] = null; t.rng[0] = null;
    p.generation = 999; w.entries[0].token = 999; w.stats[0].count = 999;
    takt.stop(); pause.stop();
    takt.swapState(pt); pause.swapState(pp); wait.swapState(pw);
    expect(calls).toEqual([]);
    expect(takt.exportState().states[0].released).toBe(0);
    expect(wait.exportState().stats[0].count).toBe(1);
    expect(pause.exportState().generation).toBe(1);
    clock.advanceTo(5);
    expect(calls).toEqual(['takt:5', 'pause:5', 'wait:5']);
    clock.advanceTo(5);
    expect(calls).toHaveLength(3);
    expect(takt.exportState().states[0].released).toBe(1);
    expect(wait.exportState().entries[0].reported).toBe(true);
    expect(wait.validateState(wait.exportState())).toEqual([]);
  });

  for (const kind of ['fleet.takt.arm', 'fleet.pause.arm', 'fleet.wait.limit']) {
    it(`a pre-capture ${kind} handle cancels after restore`, () => {
      const { clock, calls, takt, pause, wait, handles } = fixture();
      const handle = handles.get(kind)!;
      const pt = takt.prepareState(takt.exportState()), pp = pause.prepareState(pause.exportState()), pw = wait.prepareState(wait.exportState());
      takt.swapState(pt); pause.swapState(pp); wait.swapState(pw);
      clock.cancel(handle);
      clock.advanceTo(5);
      expect(calls).not.toContain(kind === 'fleet.takt.arm' ? 'takt:5' : kind === 'fleet.pause.arm' ? 'pause:5' : 'wait:5');
      expect(calls).toHaveLength(2);
    });
  }

  it('round-trips passive waits, ended counters, reported problems and disabled limits through JSON', () => {
    const { clock, wait } = fixture();
    wait.begin('P', 'target', Infinity, undefined, { passive: true });
    clock.advanceTo(5);
    wait.end('P', 'target');
    wait.setDefaultLimit(NaN);
    const saved = wait.exportState();
    expect(wait.validateState(saved)).toEqual([]);
    const prepared = wait.prepareState(JSON.parse(JSON.stringify(saved)));
    wait.reset(); wait.swapState(prepared);
    expect(wait.exportState()).toEqual(saved);
  });

  it('does not let an uncancelled pre-reset event time out a new record', () => {
    const clock = new ContinuousSimClock(), reports: string[] = [];
    const watch = new WaitWatch({ clock, defaultLimitSec: 5, cancelOnEnd: false,
      problems: { report: p => reports.push(p.id), clear: () => {} } });
    watch.begin('V', 'fork'); clock.advanceTo(1); watch.reset(); watch.begin('V', 'fork');
    clock.advanceTo(5); expect(reports).toEqual([]);
    clock.advanceTo(6); expect(reports).toHaveLength(1);
  });

  it('rejects malformed state without changing live state', () => {
    const { takt, pause, wait } = fixture();
    for (const source of [takt, pause, wait]) {
      const before = source.exportState();
      expect(() => source.prepareState({})).toThrow();
      expect(() => source.prepareState({ ...before, extra: true })).toThrow();
      expect(source.exportState()).toEqual(before);
    }
    const t = takt.exportState(); t.rng[0] = [-1, 0, 0, 0];
    expect(takt.validateState(t).length).toBeGreaterThan(0);
    const w = wait.exportState(); w.entries[0].token = -1;
    expect(wait.validateState(w).length).toBeGreaterThan(0);
    expect(pause.validateState({ generation: -1 }).length).toBeGreaterThan(0);
  });
});
