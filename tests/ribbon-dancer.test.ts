// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-460 §9.3 — the dancer roller in a running web.
 *
 * The two limit tests are the load-bearing ones. A symmetric "stop everything at
 * the stop" clamp deadlocks — with both sections at zero, no delta can ever free
 * the carriage again (SOL round-1 finding 1) — so each of them asserts BOTH that
 * the store cannot grow further AND that the opposite delta moves it back.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ribbonHarness, signalRef, type RollerSpec } from './ribbon-fixture';
import { MM_TO_METERS } from '../src/core/engine/rv-constants';

const DT = 1 / 60;

/** Unwinder — nip(D) — dancer — rewinder(D). */
function lineWithDancer(dancerExtras: Record<string, unknown> = {}): RollerSpec[] {
  return [
    { name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 400, winder: true },
    { name: 'Nip', xMm: 1500, yMm: 400, radiusMm: 80, driven: true },
    {
      name: 'Dancer', xMm: 2400, yMm: 200, radiusMm: 50, dancer: true,
      extras: { TravelAxis: 'Y', TravelMinMm: -150, TravelMaxMm: 150, Strands: 2, ...dancerExtras },
    },
    { name: 'Rewinder', xMm: 3600, yMm: 0, radiusMm: 100, winder: true, driven: true },
  ];
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

describe('RibbonDancer', () => {
  it('vUp > vDown moves the carriage along TravelAxis by (vUp - vDown) * dt / Strands', () => {
    const h = ribbonHarness(lineWithDancer());
    h.buildPath();
    const dancer = h.dancer('Dancer');
    const y0 = dancer.node.position.y;

    h.drive.jogRoller('Nip', 1000);
    h.drive.jogRoller('Rewinder', 800);
    h.step(DT);

    // 200 mm/s of surplus web, two strands -> 100 mm/s of carriage travel.
    expect(dancer.lAccMm).toBeCloseTo(200 * DT, 6);
    expect(dancer.positionMm).toBeCloseTo(100 * DT, 6);
    expect(dancer.node.position.y - y0).toBeCloseTo((100 * DT) / MM_TO_METERS, 9);
    expect(dancer.atMin).toBe(false);
    expect(dancer.atMax).toBe(false);
  });

  it('vDown > vUp empties the store and moves the carriage the other way', () => {
    const h = ribbonHarness(lineWithDancer());
    h.buildPath();
    const dancer = h.dancer('Dancer');
    h.drive.jogRoller('Nip', 500);
    h.drive.jogRoller('Rewinder', 900);
    h.step(DT);
    expect(dancer.positionMm).toBeCloseTo(-200 * DT, 6);
  });

  it('Strands scales the travel: four strands move the carriage half as far as two', () => {
    const two = ribbonHarness(lineWithDancer());
    two.buildPath();
    const four = ribbonHarness(lineWithDancer({ Strands: 4 }));
    four.buildPath();
    for (const h of [two, four]) {
      h.drive.jogRoller('Nip', 1000);
      h.drive.jogRoller('Rewinder', 600);
      h.step(DT);
    }
    expect(four.dancer('Dancer').positionMm).toBeCloseTo(two.dancer('Dancer').positionMm / 2, 9);
  });

  it('reaching TravelMaxMm sets AtMax and holds v_up at v_down instead of filling further', () => {
    const h = ribbonHarness(lineWithDancer());
    const path = h.buildPath();
    const dancer = h.dancer('Dancer');

    h.drive.jogRoller('Nip', 1000);
    h.drive.jogRoller('Rewinder', 200);
    for (let i = 0; i < 200; i++) h.step(DT);

    expect(dancer.atMax).toBe(true);
    expect(dancer.positionMm).toBeCloseTo(150, 6);
    // The store cannot grow past the stop (anti-windup).
    expect(dancer.lAccMm).toBeCloseTo(300, 6);
    // Both sections now run at the SLOWER side — the web keeps moving.
    expect(path.sections[0].speed).toBeCloseTo(200, 6);
    expect(path.sections[1].speed).toBeCloseTo(200, 6);
    expect(path.rollers[0].angle).not.toBe(0);
  });

  it('at AtMax a reversed delta moves the carriage back and clears AtMax (no deadlock)', () => {
    const h = ribbonHarness(lineWithDancer());
    const path = h.buildPath();
    const dancer = h.dancer('Dancer');
    h.drive.jogRoller('Nip', 1000);
    h.drive.jogRoller('Rewinder', 200);
    for (let i = 0; i < 200; i++) h.step(DT);
    expect(dancer.atMax).toBe(true);

    // The PLC reacts to AtMax by pulling faster than the nip feeds.
    h.drive.jogRoller('Rewinder', 1400);
    h.step(DT);
    expect(dancer.atMax).toBe(false);
    expect(dancer.positionMm).toBeLessThan(150);
    // ...and the two sections are free to differ again.
    expect(path.sections[0].speed).toBeCloseTo(1000, 6);
    expect(path.sections[1].speed).toBeCloseTo(1400, 6);
  });

  it('at AtMin only v_down is held to v_up; the opposite delta frees it', () => {
    const h = ribbonHarness(lineWithDancer());
    const path = h.buildPath();
    const dancer = h.dancer('Dancer');

    h.drive.jogRoller('Nip', 200);
    h.drive.jogRoller('Rewinder', 1000);
    for (let i = 0; i < 200; i++) h.step(DT);
    expect(dancer.atMin).toBe(true);
    expect(dancer.positionMm).toBeCloseTo(-150, 6);
    expect(path.sections[0].speed).toBeCloseTo(200, 6);
    expect(path.sections[1].speed).toBeCloseTo(200, 6);

    h.drive.jogRoller('Nip', 1400);
    h.step(DT);
    expect(dancer.atMin).toBe(false);
    expect(dancer.positionMm).toBeGreaterThan(-150);
  });

  it('a HomeMm offset moves the rest position and both stops with it', () => {
    const h = ribbonHarness(lineWithDancer({ HomeMm: 50 }));
    h.buildPath();
    const dancer = h.dancer('Dancer');
    expect(dancer.positionMm).toBe(50);
    h.drive.jogRoller('Nip', 1000);
    h.drive.jogRoller('Rewinder', 0);
    for (let i = 0; i < 200; i++) h.step(DT);
    expect(dancer.positionMm).toBeCloseTo(200, 6);   // 50 + 150
    expect(dancer.atMax).toBe(true);
  });

  it('a winder Empty stops EVERY section, unlike a dancer stop', () => {
    const h = ribbonHarness([
      {
        name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 100, winder: true,
        extras: { InitialWoundLengthMm: 1000 * DT },
      },
      { name: 'Nip', xMm: 1500, yMm: 400, radiusMm: 80, driven: true },
      {
        name: 'Dancer', xMm: 2400, yMm: 200, radiusMm: 50, dancer: true,
        extras: { TravelAxis: 'Y', TravelMinMm: -150, TravelMaxMm: 150 },
      },
      { name: 'Rewinder', xMm: 3600, yMm: 0, radiusMm: 100, winder: true, driven: true },
    ]);
    const path = h.buildPath();
    h.drive.jogRoller('Nip', 1000);
    h.drive.jogRoller('Rewinder', 900);
    h.step(DT);
    h.step(DT);

    expect(path.winders[0].isEmpty).toBe(true);
    expect(path.sections[0].speed).toBe(0);
    expect(path.sections[1].speed).toBe(0);
  });

  it('dt <= 0 leaves the balance untouched and negative speeds are handled sign-correctly', () => {
    const h = ribbonHarness(lineWithDancer());
    h.buildPath();
    const dancer = h.dancer('Dancer');

    dancer.advance(1000, 500, 0);
    expect(dancer.lAccMm).toBe(0);
    dancer.advance(1000, 500, -1);
    expect(dancer.lAccMm).toBe(0);

    // Running the whole web backwards: the nip feeds -1000, the rewinder takes
    // -800, so the store still GROWS by 200 mm/s (the nip delivers more).
    dancer.advance(-1000, -800, DT);
    expect(dancer.lAccMm).toBeCloseTo(-200 * DT, 9);
  });

  it('writes PositionMm only on a change > 0.1 mm, and AtMin/AtMax only on a flip', () => {
    const h = ribbonHarness(lineWithDancer({
      PositionMm: signalRef('Signals/DancerPos', 'PLCInputFloat'),
      AtMax: signalRef('Signals/DancerMax', 'PLCInputBool'),
    }));
    h.signalStore.register('DancerPos', 'Signals/DancerPos', 0, 'PLCInputFloat');
    h.signalStore.register('DancerMax', 'Signals/DancerMax', false, 'PLCInputBool');
    const writes: Array<[string, number | boolean]> = [];
    h.ribbonManager.setSignalWriter((address, value) => {
      writes.push([address, value]);
      h.signalStore.setByPath(address, value);
    });
    h.buildPath();

    // A surplus of 1 mm/s: 60 ticks move the carriage 0.5 mm in total, so the
    // first write lands and nothing after it crosses the epsilon on its own.
    h.drive.jogRoller('Nip', 1001);
    h.drive.jogRoller('Rewinder', 1000);
    h.step(DT);
    const first = writes.filter(([a]) => a === 'Signals/DancerPos').length;
    expect(first).toBe(1);
    for (let i = 0; i < 5; i++) h.step(DT);
    expect(writes.filter(([a]) => a === 'Signals/DancerPos')).toHaveLength(1);

    // AtMax: the initial false is written once (a PLC must learn the starting
    // state, same rule as the winder Empty/Full slots), then exactly one flip.
    h.drive.jogRoller('Rewinder', 0);
    for (let i = 0; i < 300; i++) h.step(DT);
    const maxWrites = writes.filter(([a]) => a === 'Signals/DancerMax');
    expect(maxWrites.map(([, v]) => v)).toEqual([false, true]);
    expect(h.signalStore.getBool('DancerMax')).toBe(true);
  });

  it('resetAll restores L_acc, the carriage position and the signal edge memory', () => {
    const h = ribbonHarness(lineWithDancer());
    h.buildPath();
    const dancer = h.dancer('Dancer');
    const y0 = dancer.node.position.y;

    h.drive.jogRoller('Nip', 1000);
    h.drive.jogRoller('Rewinder', 500);
    for (let i = 0; i < 60; i++) h.step(DT);
    expect(dancer.positionMm).toBeGreaterThan(0);

    h.drive.reset();
    h.ribbonManager.resetAll();
    expect(dancer.lAccMm).toBe(0);
    expect(dancer.positionMm).toBe(0);
    expect(dancer.node.position.y).toBeCloseTo(y0, 12);
    expect(dancer.atMax).toBe(false);
  });

  it('a dancer with an impossible travel range is inert with a warning', () => {
    const h = ribbonHarness(lineWithDancer({ TravelMinMm: 100, TravelMaxMm: 50 }));
    h.buildPath();
    const dancer = h.dancer('Dancer');
    expect(dancer.isInert).toBe(true);
    expect(warn.mock.calls.flat().join(' ')).toContain('TravelMinMm');
    h.drive.jogRoller('Nip', 1000);
    h.drive.jogRoller('Rewinder', 0);
    for (let i = 0; i < 10; i++) h.step(DT);
    expect(dancer.node.position.y).toBeCloseTo(200 / MM_TO_METERS, 9);   // authored
  });
});

describe('a dancer shared by two strips', () => {
  /** Unwinder — dancer — nip(D) — rewinder_A(D) / rewinder_B(D). */
  function slitter(dancerAfterNip: boolean): RollerSpec[] {
    return [
      { name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 400, winder: true },
      {
        name: 'Dancer', xMm: dancerAfterNip ? 2400 : 800, yMm: 300, radiusMm: 50, dancer: true,
        extras: { TravelAxis: 'Y', TravelMinMm: -150, TravelMaxMm: 150 },
      },
      { name: 'Nip', xMm: 1600, yMm: 500, radiusMm: 80, driven: true },
      { name: 'Rewinder_A', xMm: 3600, yMm: 300, radiusMm: 100, winder: true, driven: true },
      { name: 'Rewinder_B', xMm: 3600, yMm: -300, radiusMm: 100, winder: true, driven: true },
    ];
  }

  it('is integrated ONCE per tick when both strips see the same neighbouring sources', () => {
    // Dancer BEFORE the nip: for both strips its upstream section has no driven
    // roller (it inherits the nip) and its downstream section is the nip.
    const h = ribbonHarness(slitter(false));
    const a = h.addPath('Ribbon_A', ['Unwinder', 'Dancer', 'Nip', 'Rewinder_A']);
    const b = h.addPath('Ribbon_B', ['Unwinder', 'Dancer', 'Nip', 'Rewinder_B']);
    expect(h.ribbonManager.groups).toHaveLength(1);
    const dancer = h.dancer('Dancer');
    expect(h.ribbonManager.dancerOwnerOf(dancer)).toBe(a);
    expect(b.dancers[0]).toBe(dancer);

    h.drive.jogRoller('Nip', 1000);
    h.drive.jogRoller('Rewinder_A', 1000);
    h.drive.jogRoller('Rewinder_B', 1000);
    h.step(DT);
    // Upstream inherits the nip's 1000, downstream IS the nip: no surplus at all,
    // integrated once — a second integration would show as a non-zero balance.
    expect(dancer.lAccMm).toBeCloseTo(0, 9);
    expect(a.sections).toHaveLength(2);
    expect(b.sections).toHaveLength(2);
  });

  it('with DIFFERENT neighbouring sources it is inert for the whole group, warned once', () => {
    // Dancer AFTER the nip: strip A's downstream source is Rewinder_A, strip B's
    // is Rewinder_B — there is no single (v_up, v_down) pair to integrate.
    const h = ribbonHarness(slitter(true));
    h.addPath('Ribbon_A', ['Unwinder', 'Nip', 'Dancer', 'Rewinder_A']);
    h.addPath('Ribbon_B', ['Unwinder', 'Nip', 'Dancer', 'Rewinder_B']);
    const dancer = h.dancer('Dancer');

    h.drive.jogRoller('Nip', 1000);
    h.drive.jogRoller('Rewinder_A', 400);
    h.drive.jogRoller('Rewinder_B', 900);
    for (let i = 0; i < 30; i++) h.step(DT);

    expect(dancer.positionMm).toBe(0);          // held at HomeMm
    expect(dancer.lAccMm).toBe(0);
    const hits = warn.mock.calls.flat().filter((m: unknown) => String(m).includes('can only be shared before the slit'));
    expect(hits).toHaveLength(1);
  });
});
