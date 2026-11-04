// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-522 Phase 7a — the pure trigger rules (`maintenance-trigger-eval.ts`):
 * edges incl. pulses, baselines, debounce, hysteresis, latch, WarnAt /
 * OverdueAfter, accumulation per kind, Any / All with the deciding trigger.
 */

import { describe, expect, test } from 'vitest';
import {
  DEFAULT_TRIGGER_RULES,
  accumulate,
  applySignalValue,
  completeTrigger,
  createTriggerState,
  decidingIndex,
  edgeMatches,
  levelOf,
  rebaseTrigger,
  remainingFractionOf,
  remainingOf,
  tickDebounce,
  type MaintenanceLevel,
  type TriggerRules,
} from '../src/core/maintenance-trigger-eval';

const rules = (over: Partial<TriggerRules>): TriggerRules => ({ ...DEFAULT_TRIGGER_RULES, ...over });

describe('edges', () => {
  test('Rising / Falling / Both', () => {
    expect(edgeMatches('Rising', false, true)).toBe(true);
    expect(edgeMatches('Rising', true, false)).toBe(false);
    expect(edgeMatches('Falling', true, false)).toBe(true);
    expect(edgeMatches('Both', true, false)).toBe(true);
    expect(edgeMatches('Both', false, true)).toBe(true);
    expect(edgeMatches('Both', true, true)).toBe(false);
  });

  test('Count: a high initial level is a baseline, not an edge (G2); every pulse counts', () => {
    const r = rules({ kind: 'Count', edge: 'Rising', interval: 3, warnAt: 0.6 });
    const s = createTriggerState();
    applySignalValue(r, s, true, 0); // already high at subscription
    expect(s.value).toBe(0);
    applySignalValue(r, s, false, 0);
    // two pulses within one fixed step still arrive as four transitions
    applySignalValue(r, s, true, 0); applySignalValue(r, s, false, 0);
    applySignalValue(r, s, true, 0); applySignalValue(r, s, false, 0);
    expect(s.value).toBe(2);
    expect(levelOf(r, s, 0)).toBe(1); // 2 >= 0.6 * 3
    applySignalValue(r, s, true, 0);
    expect(levelOf(r, s, 0)).toBe(2);
  });

  test('Count: Falling and Both', () => {
    const f = rules({ kind: 'Count', edge: 'Falling', interval: 10 });
    const s = createTriggerState();
    applySignalValue(f, s, false, 0);
    applySignalValue(f, s, true, 0); applySignalValue(f, s, false, 0);
    expect(s.value).toBe(1);
    const b = rules({ kind: 'Count', edge: 'Both', interval: 10 });
    const t = createTriggerState();
    applySignalValue(b, t, false, 0);
    applySignalValue(b, t, true, 0); applySignalValue(b, t, false, 0);
    expect(t.value).toBe(2);
  });

  test('Count on an Int signal adds the positive difference only', () => {
    const r = rules({ kind: 'Count', interval: 100 });
    const s = createTriggerState();
    applySignalValue(r, s, 40, 0); // baseline
    applySignalValue(r, s, 45, 0);
    applySignalValue(r, s, 0, 0); // PLC counter reset: not negative
    applySignalValue(r, s, 3, 0);
    expect(s.value).toBe(8);
  });
});

describe('Signal kind', () => {
  test('a matching edge fires at once; latch holds until done', () => {
    const r = rules({ kind: 'Signal', edge: 'Rising' });
    const s = createTriggerState();
    applySignalValue(r, s, false, 0);
    applySignalValue(r, s, true, 1);
    expect(levelOf(r, s, 1)).toBe(2);
    applySignalValue(r, s, false, 2);
    expect(levelOf(r, s, 2)).toBe(2); // latched
    completeTrigger(r, s);
    expect(levelOf(r, s, 2)).toBe(0);
  });

  test('without latch: due only while the firing level holds', () => {
    const r = rules({ kind: 'Signal', edge: 'Rising', latch: false });
    const s = createTriggerState();
    applySignalValue(r, s, false, 0);
    applySignalValue(r, s, true, 0);
    expect(levelOf(r, s, 0)).toBe(2);
    applySignalValue(r, s, false, 0);
    expect(levelOf(r, s, 0)).toBe(0);
  });

  test('debounce: the level must hold DebounceSeconds; a short pulse does not fire', () => {
    const r = rules({ kind: 'Signal', edge: 'Rising', debounceSeconds: 2 });
    const s = createTriggerState();
    applySignalValue(r, s, false, 0);
    applySignalValue(r, s, true, 1);
    expect(tickDebounce(r, s, 2)).toBe(false);
    applySignalValue(r, s, false, 2.5); // dropped before 2 s
    expect(tickDebounce(r, s, 4)).toBe(false);
    expect(levelOf(r, s, 4)).toBe(0);
    applySignalValue(r, s, true, 5);
    expect(tickDebounce(r, s, 7)).toBe(true);
    expect(levelOf(r, s, 7)).toBe(2);
  });

  test('OverdueAfter in seconds of being due', () => {
    const r = rules({ kind: 'Signal', overdueAfter: 10 });
    const s = createTriggerState();
    applySignalValue(r, s, false, 0);
    applySignalValue(r, s, true, 5);
    expect(levelOf(r, s, 14)).toBe(2);
    expect(levelOf(r, s, 15)).toBe(3);
    expect(remainingOf(r, s, 3)).toBe(0);
  });
});

describe('Threshold kind', () => {
  test('fires at the threshold, re-arms only below the hysteresis band', () => {
    const r = rules({ kind: 'Threshold', compare: 'GreaterOrEqual', threshold: 80, hysteresis: 5, latch: false, warnAt: 0.9 });
    const s = createTriggerState();
    applySignalValue(r, s, 70, 0);
    expect(levelOf(r, s, 0)).toBe(0);
    applySignalValue(r, s, 75, 0);
    expect(levelOf(r, s, 0)).toBe(1); // >= 0.9 * 80 = 72
    applySignalValue(r, s, 81, 0);
    expect(levelOf(r, s, 0)).toBe(2);
    applySignalValue(r, s, 78, 0); // inside the band: still due (no flicker)
    expect(levelOf(r, s, 0)).toBe(2);
    applySignalValue(r, s, 74, 0); // left the band: re-armed, not latched
    expect(levelOf(r, s, 0)).toBe(1);
    applySignalValue(r, s, 80, 0);
    expect(levelOf(r, s, 0)).toBe(2);
  });

  test('latched threshold stays due; done re-arms only once the value is back below the band', () => {
    const r = rules({ kind: 'Threshold', compare: 'GreaterThan', threshold: 10, hysteresis: 2 });
    const s = createTriggerState();
    applySignalValue(r, s, 11, 0);
    expect(levelOf(r, s, 0)).toBe(2);
    applySignalValue(r, s, 5, 0);
    expect(levelOf(r, s, 0)).toBe(2);
    applySignalValue(r, s, 12, 0);
    completeTrigger(r, s); // still above: must not fire again at once
    applySignalValue(r, s, 13, 0);
    expect(levelOf(r, s, 0)).toBe(0);
    applySignalValue(r, s, 7, 0);
    applySignalValue(r, s, 11, 0);
    expect(levelOf(r, s, 0)).toBe(2);
  });

  test('LessThan with debounce', () => {
    const r = rules({ kind: 'Threshold', compare: 'LessThan', threshold: 2, debounceSeconds: 1 });
    const s = createTriggerState();
    applySignalValue(r, s, 3, 0);
    applySignalValue(r, s, 1.5, 10);
    expect(levelOf(r, s, 10)).toBe(0);
    tickDebounce(r, s, 11);
    expect(levelOf(r, s, 11)).toBe(2);
  });
});

describe('counting kinds', () => {
  test('Travel mm → km × acceleration; RunTime only while active; Interval always', () => {
    const travel = rules({ kind: 'Travel', interval: 1 });
    const s = createTriggerState();
    accumulate(travel, s, 0.02, 500_000, false, 1);
    expect(s.value).toBeCloseTo(0.5, 9);
    accumulate(travel, s, 0.02, 500, false, 1000);
    expect(s.value).toBeCloseTo(1, 9);
    const run = rules({ kind: 'RunTime', interval: 1 });
    const r = createTriggerState();
    expect(accumulate(run, r, 1800, 0, false, 1)).toBe(false);
    accumulate(run, r, 1800, 0, true, 1);
    expect(r.value).toBeCloseTo(0.5, 9);
    const iv = rules({ kind: 'Interval', interval: 1 });
    const i = createTriggerState();
    accumulate(iv, i, 36, 0, false, 10);
    expect(i.value).toBeCloseTo(0.1, 9);
    expect(accumulate(iv, i, -5, 0, false, 1)).toBe(false); // negative Δ never counts
  });

  test('WarnAt / due / OverdueAfter, latch on and off', () => {
    const r = rules({ kind: 'Interval', interval: 10, warnAt: 0.8, overdueAfter: 5 });
    const s = createTriggerState();
    const at = (v: number): MaintenanceLevel => { s.value = v; return levelOf(r, s, 0); };
    expect(at(7.9)).toBe(0);
    expect(at(8)).toBe(1);
    expect(at(10)).toBe(2);
    expect(at(15)).toBe(3);
    expect(at(3)).toBe(2); // latched (an external lowering would not clear it)
    completeTrigger(r, s);
    expect(s.value).toBe(0);
    expect(levelOf(r, s, 0)).toBe(0);
    const nl = rules({ kind: 'Interval', interval: 10, latch: false });
    const t = createTriggerState();
    t.value = 12; expect(levelOf(nl, t, 0)).toBe(2);
    t.value = 3; expect(levelOf(nl, t, 0)).toBe(0);
  });

  test('Interval 0 is inactive; remaining value and fraction', () => {
    const r = rules({ kind: 'Count', interval: 0 });
    const s = createTriggerState();
    s.value = 99;
    expect(levelOf(r, s, 0)).toBe(0);
    const c = rules({ kind: 'Count', interval: 40 });
    s.value = 30;
    expect(remainingOf(c, s, 0)).toBe(10);
    expect(remainingFractionOf(c, s, 0)).toBeCloseTo(0.25, 9);
  });
});

describe('rebase (G3)', () => {
  test('counter stays, next sample is a baseline, a running debounce restarts', () => {
    const r = rules({ kind: 'Count', interval: 10 });
    const s = createTriggerState();
    applySignalValue(r, s, false, 0);
    applySignalValue(r, s, true, 0);
    expect(s.value).toBe(1);
    rebaseTrigger(s);
    applySignalValue(r, s, true, 0); // still high after the reset: no edge
    expect(s.value).toBe(1);
  });
});

describe('Any / All (G5 / G6)', () => {
  test('Any: highest level, tie → smallest remaining fraction, then order', () => {
    expect(decidingIndex('Any', [])).toBe(-1);
    expect(decidingIndex('Any', [
      { level: 1, remainingFraction: 0.05 },
      { level: 2, remainingFraction: 0 },
      { level: 2, remainingFraction: -0.1 },
    ])).toBe(2);
    expect(decidingIndex('Any', [
      { level: 0, remainingFraction: 0.5 },
      { level: 0, remainingFraction: 0.5 },
    ])).toBe(0);
  });

  test('All: lowest level, tie → hierarchy order (G6)', () => {
    expect(decidingIndex('All', [
      { level: 2, remainingFraction: 0 },
      { level: 1, remainingFraction: 0.05 },
      { level: 1, remainingFraction: 0.08 },
    ])).toBe(1);
  });
});
