// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { JsonValue } from '../../src/core/material-flow/material-flow-self';
import { describe, expect, it } from 'vitest';
import {
  createTakt, intervalOf, isPaused, nextChange, nextChangeOf, nextRelease,
  PauseSource, resetTakt, retimeTakt, taktDue, taktHeadFree, TaktSource,
  type PausePlan, type TaktPlan,
} from '../../src/core/fleet/core/order-sources';
import type { ClockHandle, SimClock } from '../../src/core/fleet/core/sim-clock';

const P: PausePlan = { everySec: 1200, durationSec: 300, offsetSec: [300, 900] };
const PROD: TaktPlan = { intervalSec: 90, phaseSec: [0, 45] };

describe('shipping pauses', () => {
  it('pause starts inclusive and ends exclusive', () => {
    expect(isPaused(P, 0, 299.999)).toBe(false);
    expect(isPaused(P, 0, 300)).toBe(true);
    expect(isPaused(P, 0, 599.999)).toBe(true);
    expect(isPaused(P, 0, 600)).toBe(false);
    expect(isPaused(P, 0, 1500)).toBe(true);
    expect(isPaused(P, 0, 1800)).toBe(false);
  });

  it('nothing pauses before its offset; inputs are offset against each other', () => {
    expect(isPaused(P, 1, 0)).toBe(false);
    expect(isPaused(P, 1, 899.9)).toBe(false);
    expect(isPaused(P, 1, 900)).toBe(true);
    expect(isPaused(P, 0, 900)).toBe(false);
    for (let t = 0; t < 7200; t += 15) expect(isPaused(P, 0, t) && isPaused(P, 1, t)).toBe(false);
  });

  it('nextChange per input and over all inputs', () => {
    expect(nextChangeOf(P, 0, 0)).toBe(300);
    expect(nextChangeOf(P, 0, 300)).toBe(600);
    expect(nextChangeOf(P, 0, 450)).toBe(600);
    expect(nextChangeOf(P, 0, 600)).toBe(1500);
    expect(nextChangeOf(P, 1, 100)).toBe(900);
    expect(nextChange(P, 0)).toEqual({ at: 300, inputs: [0] });
    expect(nextChange(P, 600)).toEqual({ at: 900, inputs: [1] });
    expect(nextChange(P, 1200)).toEqual({ at: 1500, inputs: [0] });
  });
});

describe('production takt', () => {
  it('first release at the phase, then every interval', () => {
    expect(nextRelease(PROD, 0, null)).toBe(0);
    expect(nextRelease(PROD, 1, null)).toBe(45);
    expect(nextRelease(PROD, 1, 45)).toBe(135);
  });

  it('releases one pallet per due instant with a free head', () => {
    const s = createTakt(PROD, 0);
    const released: number[] = [];
    for (let t = 0; t <= 900; t += 1) if (s.nextAt !== null && t >= s.nextAt && taktDue(s, PROD, t, true)) released.push(t);
    expect(released).toEqual([0, 90, 180, 270, 360, 450, 540, 630, 720, 810, 900]);
    expect(s.blockedCount).toBe(0);
  });

  it('blocks on an occupied head, releases at once when it frees, takt re-based from there', () => {
    const s = createTakt(PROD, 0);
    expect(taktDue(s, PROD, 0, true)).toBe(true);
    expect(taktDue(s, PROD, 90, false)).toBe(false);   // head occupied: blocked, no pallet
    expect(s.blocked).toBe(true);
    expect(s.blockedCount).toBe(1);
    expect(taktDue(s, PROD, 180, true)).toBe(false);   // a blocked output has no due instant
    expect(taktHeadFree(s, PROD, 390)).toBe(true);     // 300 s jam over → exactly one pallet now
    expect(s.released).toBe(2);
    expect(s.nextAt).toBe(480);                        // takt from there
    expect(taktHeadFree(s, PROD, 400)).toBe(false);    // not blocked → no extra pallet
    resetTakt(s, PROD);
    expect(s).toMatchObject({ nextAt: 0, blocked: false, blockedCount: 0, released: 0, lastReleaseAt: null });
  });
});


describe('takt — live load change (plan-630 §2.13, Gate R1 #6)', () => {
  const prod = () => ({ intervalSec: 90, phaseSec: [0, 45], intervalPerOutput: [90, 90] });

  it('re-bases on the last release: nextAt = max(now, last + new interval)', () => {
    const p = prod();
    const s = createTakt(p, 0);
    expect(taktDue(s, p, 0, true)).toBe(true);           // released at 0, next at 90
    p.intervalPerOutput[0] = 60;
    retimeTakt(s, p, 30);
    expect(s.nextAt).toBe(60);
    p.intervalPerOutput[0] = 20;
    retimeTakt(s, p, 30);
    expect(s.nextAt).toBe(30);                          // last + 20 already passed → now
  });

  it('0 Pal/h shuts both release paths and drops a blocked takt; 0 → x plans exactly one instant', () => {
    const p = prod();
    const s = createTakt(p, 1);
    expect(taktDue(s, p, 45, false)).toBe(false);        // blocked at its first instant
    expect(s.blocked).toBe(true);
    p.intervalPerOutput[1] = Infinity;
    retimeTakt(s, p, 50);
    expect(s).toMatchObject({ disabled: true, blocked: false, nextAt: null });
    expect(taktHeadFree(s, p, 51)).toBe(false);         // the freed head releases nothing
    expect(taktDue(s, p, 1000, true)).toBe(false);
    p.intervalPerOutput[1] = 90;
    retimeTakt(s, p, 200);
    expect(s).toMatchObject({ disabled: false, nextAt: 200 });
    expect(intervalOf(p, 1)).toBe(90);
  });

  it('an output configured at 0 Pal/h starts disabled', () => {
    const p = { ...prod(), intervalPerOutput: [Infinity, 90] };
    expect(createTakt(p, 0)).toMatchObject({ disabled: true, nextAt: null });
  });
});


interface Event extends ClockHandle {
  at: number;
  seq: number;
  fn: () => void;
}

/** Records every clock call, including null cancellations and stale events. */
class FakeClock implements SimClock {
  private readonly actions = new Map<string, (data: JsonValue | undefined) => void>();
  registerAction(kind: string, handler: (data: JsonValue | undefined) => void): () => void {
    if (!this.actions.has(kind)) this.actions.set(kind, handler);
    return () => { this.actions.delete(kind); };
  }
  scheduleAction(at: number, kind: string, data?: JsonValue): ClockHandle {
    return this.schedule(at, () => this.actions.get(kind)?.(data));
  }

  private t = 0;
  private generation = 0;
  private seq = 0;
  private events: Event[] = [];
  readonly calls: string[] = [];
  fired = 0;

  now(): number { return this.t; }

  schedule(at: number, fn: () => void): ClockHandle {
    const seq = this.seq++;
    const event = { at, seq, fn, g: this.generation, id: seq };
    this.events.push(event);
    this.events.sort((a, b) => a.at - b.at || a.seq - b.seq);
    this.calls.push(`schedule:${at}`);
    return event;
  }

  cancel(h: ClockHandle | null | undefined): void {
    this.calls.push(`cancel:${h == null ? 'null' : h.id}`);
    if (h) this.events = this.events.filter((e) => e.g !== h.g || e.id !== h.id);
  }

  reset(): void {
    this.generation++;
    this.events.length = 0;
    this.t = 0;
    this.fired = 0;
  }

  dispose(): void { this.reset(); }

  run(until: number): void {
    while (this.events.length && this.events[0].at <= until) {
      const event = this.events.shift()!;
      this.t = Math.max(this.t, event.at);
      this.fired++;
      event.fn();
    }
    this.t = Math.max(this.t, until);
  }
}

describe('TaktSource', () => {
  it('releases at each phase and interval, preserving output order for ties', () => {
    const clock = new FakeClock();
    const log: string[] = [];
    const source = new TaktSource(clock, { intervalSec: 10, phaseSec: [2, 2] }, 2, {
      headFree: () => true,
      release: (i) => { log.push(`${i}@${clock.now()}`); },
      blocked: () => { throw new Error('unexpected blocked takt'); },
    });
    source.start();
    expect(clock.calls).toEqual(['cancel:null', 'schedule:2', 'cancel:null', 'schedule:2']);
    clock.run(22);
    expect(log).toEqual(['0@2', '1@2', '0@12', '1@12', '0@22', '1@22']);
    expect(clock.fired).toBe(6);
    expect(clock.calls.slice(4)).toEqual([
      'cancel:null', 'schedule:12', 'cancel:null', 'schedule:12',
      'cancel:null', 'schedule:22', 'cancel:null', 'schedule:22',
      'cancel:null', 'schedule:32', 'cancel:null', 'schedule:32',
    ]);
    expect(source.states.map((s) => s.released)).toEqual([3, 3]);
  });

  it('counts an occupied head once and releases on headFreed, rebasing the takt', () => {
    const clock = new FakeClock();
    const log: string[] = [];
    let free = false;
    const source = new TaktSource(clock, { intervalSec: 10, phaseSec: [0] }, 1, {
      headFree: () => free,
      release: () => { log.push(`release@${clock.now()}`); },
      blocked: () => { log.push(`blocked@${clock.now()}`); },
    });
    source.start();
    clock.run(25);
    expect(log).toEqual(['blocked@0']);
    expect(clock.calls).toEqual(['cancel:null', 'schedule:0', 'cancel:null']);
    free = true;
    source.headFreed(0);
    source.headFreed(0);
    clock.run(35);
    expect(log).toEqual(['blocked@0', 'release@25', 'release@35']);
    expect(source.states[0]).toMatchObject({ blockedCount: 1, released: 2, nextAt: 45 });
  });

  it('retimes the live plan, cancels the old event, disables and re-enables', () => {
    const clock = new FakeClock();
    const p = { intervalSec: 90, phaseSec: [0], intervalPerOutput: [90] };
    const log: number[] = [];
    const source = new TaktSource(clock, p, 1, {
      headFree: () => true,
      release: () => { log.push(clock.now()); },
      blocked: () => {},
    });
    source.start();
    clock.run(30);
    p.intervalPerOutput[0] = 60;
    source.retime(0);
    expect(clock.calls.slice(-2)).toEqual(['cancel:1', 'schedule:60']);
    clock.run(60);
    p.intervalPerOutput[0] = Infinity;
    source.retime(0);
    expect(clock.calls.at(-1)).toBe('cancel:3');
    clock.run(200);
    source.headFreed(0);
    expect(log).toEqual([0, 60]);
    expect(source.states[0]).toMatchObject({ disabled: true, nextAt: null });
    p.intervalPerOutput[0] = 90;
    source.retime(0);
    clock.run(200);
    expect(log).toEqual([0, 60, 200]);
    expect(clock.fired).toBe(3);
  });

  it('resets states after a clock reset without cancelling old handles', () => {
    const clock = new FakeClock();
    const source = new TaktSource(clock, { intervalSec: 10, phaseSec: [0] }, 1, {
      headFree: () => true, release: () => {}, blocked: () => {},
    });
    source.start();
    clock.run(10);
    const state = source.states[0];
    clock.reset();
    clock.calls.length = 0;
    source.start();
    expect(source.states[0]).toBe(state);
    expect(state).toMatchObject({ released: 0, blockedCount: 0, lastReleaseAt: null, nextAt: 0 });
    expect(clock.calls).toEqual(['cancel:null', 'schedule:0']);
    clock.run(0);
    expect(state.released).toBe(1);
  });
});

function pauseFixture(plan: PausePlan) {
  const clock = new FakeClock();
  const log: string[] = [];
  const source = new PauseSource(clock, plan, plan.offsetSec.length, {
    setRun: (i, run) => { log.push(`set:${i}:${run}@${clock.now()}`); },
    wake: (i) => { log.push(`wake:${i}@${clock.now()}`); },
    resumed: (i) => { log.push(`resumed:${i}@${clock.now()}`); },
  });
  return { clock, log, source };
}

describe('PauseSource', () => {
  it('switches in input order and calls wake then resumed only on timer resumes', () => {
    const { clock, log, source } = pauseFixture({ everySec: 10, durationSec: 3, offsetSec: [2, 2] });
    source.start();
    expect(log).toEqual(['set:0:true@0', 'set:1:true@0']);
    expect(clock.calls).toEqual(['schedule:2', 'schedule:2']);
    clock.run(12);
    expect(log).toEqual([
      'set:0:true@0', 'set:1:true@0',
      'set:0:false@2', 'set:1:false@2',
      'set:0:true@5', 'wake:0@5', 'resumed:0@5',
      'set:1:true@5', 'wake:1@5', 'resumed:1@5',
      'set:0:false@12', 'set:1:false@12',
    ]);
    expect(clock.calls).toEqual([
      'schedule:2', 'schedule:2', 'schedule:5', 'schedule:5',
      'schedule:12', 'schedule:12', 'schedule:15', 'schedule:15',
    ]);
    expect(clock.fired).toBe(6);
    expect(source.paused(0, 2)).toBe(true);
    expect(source.paused(0, 5)).toBe(false);
  });

  it('replans the live object without cancelling old events or calling resumed', () => {
    const plan = { everySec: 10, durationSec: 3, offsetSec: [2, 2] };
    const { clock, log, source } = pauseFixture(plan);
    source.start();
    clock.run(3);
    plan.everySec = 20;
    plan.durationSec = 1;
    log.length = 0;
    clock.calls.length = 0;
    source.replan();
    expect(log).toEqual(['set:0:true@3', 'wake:0@3', 'set:1:true@3', 'wake:1@3']);
    expect(clock.calls).toEqual(['schedule:22', 'schedule:22']);
    clock.run(21);
    expect(log).toHaveLength(4);
    expect(clock.fired).toBe(4); // Two stale events at 5 still execute their guards.
    clock.run(23);
    expect(log.slice(4)).toEqual([
      'set:0:false@22', 'set:1:false@22',
      'set:0:true@23', 'wake:0@23', 'resumed:0@23',
      'set:1:true@23', 'wake:1@23', 'resumed:1@23',
    ]);
    expect(clock.fired).toBe(8);
    expect(clock.calls).toEqual([
      'schedule:22', 'schedule:22', 'schedule:23', 'schedule:23', 'schedule:42', 'schedule:42',
    ]);
  });

  it('initializes paused inputs without wake and handles a disabled pause plan', () => {
    const plan = { everySec: 10, durationSec: 3, offsetSec: [0] };
    const { clock, log, source } = pauseFixture(plan);
    source.start();
    expect(log).toEqual(['set:0:false@0']);
    plan.durationSec = 0;
    source.replan();
    expect(log).toEqual(['set:0:false@0', 'set:0:true@0', 'wake:0@0']);
    expect(clock.calls).toEqual(['schedule:3']);
    clock.run(100);
    expect(log).toHaveLength(3);
    expect(source.paused(0, 10)).toBe(false);
  });
});

it('stop silences both timer chains without cancelling their pending events', () => {
  const { clock, log, source: pauses } = pauseFixture({ everySec: 10, durationSec: 3, offsetSec: [2] });
  const takts = new TaktSource(clock, { intervalSec: 10, phaseSec: [2] }, 1, {
    headFree: () => { log.push('headFree'); return true; },
    release: () => { log.push('release'); },
    blocked: () => { log.push('blocked'); },
  });
  takts.start();
  pauses.start();
  const calls = clock.calls.slice();
  takts.stop();
  pauses.stop();
  clock.run(100);
  expect(log).toEqual(['set:0:true@0']);
  expect(clock.calls).toEqual(calls);
  expect(clock.fired).toBe(2);
});
