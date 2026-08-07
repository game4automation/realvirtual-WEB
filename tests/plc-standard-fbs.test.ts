// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plc-standard-fbs.test.ts — plan-242 Phase 2 (IEC 61131-3 standard FBs).
 *
 * Contract of the host-side FB library (`rv-plc-fbs.ts`):
 *  - all 10 standard FBs: TON, TOF, TP, CTU, CTD, CTUD, R_TRIG, F_TRIG, RS, SR
 *  - time base is SIM time via PlcClock (never wallclock): a sim-time jump
 *    elapses a timer in a single call
 *  - IEC semantics: TON needs IN continuously high for PT; TOF drops delayed;
 *    TP emits a fixed-length, non-retriggerable pulse; R_TRIG/F_TRIG pulse
 *    for exactly one call; RS is reset-dominant, SR is set-dominant
 *  - TIME values are milliseconds; counters cap at PV / floor at 0
 *  - instances are isolated; reset() restores the initial state
 *
 * Runs only in the private build (imports `@rv-private/plc/rv-plc-fbs`).
 */

import { describe, it, expect } from 'vitest';
import {
  PlcClock,
  createFbInstance,
  TON,
  TOF,
  TP,
  CTU,
  CTD,
  CTUD,
  R_TRIG,
  F_TRIG,
  RS,
  SR,
} from '@rv-private/plc/rv-plc-fbs';

const DT = 1 / 60;

// ─── TON (on-delay) ─────────────────────────────────────────────────────────

describe('TON', () => {
  it('Q rises only after PT elapsed in sim time (plan-242 §9.2)', () => {
    const clock = new PlcClock();
    const ton = new TON(clock);
    for (let t = 0; t < 1.99; t += DT) {
      clock.setScanTime(t);
      ton.call({ IN: true, PT: 2000 });
    }
    expect(ton.Q).toBe(false);
    clock.setScanTime(2.01);
    ton.call({ IN: true, PT: 2000 });
    expect(ton.Q).toBe(true);
    expect(ton.ET).toBe(2000); // ET clamps at PT
  });

  it('uses sim time, not wallclock: repeated calls at the same sim time never elapse', () => {
    const clock = new PlcClock();
    const ton = new TON(clock);
    clock.setScanTime(5);
    for (let i = 0; i < 100; i++) ton.call({ IN: true, PT: 10 });
    expect(ton.Q).toBe(false);
    expect(ton.ET).toBe(0);
  });

  it('a single sim-time jump elapses the timer in one call', () => {
    const clock = new PlcClock();
    const ton = new TON(clock);
    clock.setScanTime(0);
    ton.call({ IN: true, PT: 2000 }); // rising edge at t=0
    clock.setScanTime(2.5); // FastForward jump
    ton.call({ IN: true, PT: 2000 });
    expect(ton.Q).toBe(true);
  });

  it('IN must be CONTINUOUSLY high: a dip resets the accumulation', () => {
    const clock = new PlcClock();
    const ton = new TON(clock);
    clock.setScanTime(0);
    ton.call({ IN: true, PT: 1000 });
    clock.setScanTime(0.9);
    ton.call({ IN: false, PT: 1000 }); // dip → full reset
    expect(ton.ET).toBe(0);
    clock.setScanTime(1.0);
    ton.call({ IN: true, PT: 1000 }); // restart at t=1.0
    clock.setScanTime(1.9);
    ton.call({ IN: true, PT: 1000 });
    expect(ton.Q).toBe(false); // only 0.9 s since the new rising edge
    clock.setScanTime(2.05);
    ton.call({ IN: true, PT: 1000 });
    expect(ton.Q).toBe(true);
  });

  it('call() returns the output record', () => {
    const clock = new PlcClock();
    const ton = new TON(clock);
    expect(ton.call({ IN: false, PT: 1000 })).toEqual({ Q: false, ET: 0 });
  });
});

// ─── TOF (off-delay) ────────────────────────────────────────────────────────

describe('TOF', () => {
  it('Q follows IN immediately and falls delayed by PT after IN drops', () => {
    const clock = new PlcClock();
    const tof = new TOF(clock);
    clock.setScanTime(0);
    tof.call({ IN: true, PT: 1000 });
    expect(tof.Q).toBe(true);
    tof.call({ IN: false, PT: 1000 }); // falling edge at t=0
    expect(tof.Q).toBe(true);
    clock.setScanTime(0.5);
    tof.call({ IN: false, PT: 1000 });
    expect(tof.Q).toBe(true);
    expect(tof.ET).toBe(500);
    clock.setScanTime(1.0);
    tof.call({ IN: false, PT: 1000 });
    expect(tof.Q).toBe(false);
    expect(tof.ET).toBe(1000); // ET holds PT after expiry
  });

  it('re-rise of IN during the off-delay cancels the timer', () => {
    const clock = new PlcClock();
    const tof = new TOF(clock);
    clock.setScanTime(0);
    tof.call({ IN: true, PT: 1000 });
    tof.call({ IN: false, PT: 1000 });
    clock.setScanTime(0.6);
    tof.call({ IN: true, PT: 1000 }); // cancel
    expect(tof.Q).toBe(true);
    expect(tof.ET).toBe(0);
    // fresh falling edge needs the full PT again
    tof.call({ IN: false, PT: 1000 });
    clock.setScanTime(1.5);
    tof.call({ IN: false, PT: 1000 });
    expect(tof.Q).toBe(true); // only 0.9 s since the new falling edge
    clock.setScanTime(1.65);
    tof.call({ IN: false, PT: 1000 });
    expect(tof.Q).toBe(false);
  });

  it('is initially FALSE (IN never was high)', () => {
    const clock = new PlcClock();
    const tof = new TOF(clock);
    clock.setScanTime(1);
    tof.call({ IN: false, PT: 1000 });
    expect(tof.Q).toBe(false);
    expect(tof.ET).toBe(0);
  });
});

// ─── TP (pulse) ─────────────────────────────────────────────────────────────

describe('TP', () => {
  it('emits a pulse of fixed length PT from the rising edge, independent of IN', () => {
    const clock = new PlcClock();
    const tp = new TP(clock);
    clock.setScanTime(0);
    tp.call({ IN: true, PT: 500 });
    expect(tp.Q).toBe(true);
    expect(tp.ET).toBe(0);
    clock.setScanTime(0.3);
    tp.call({ IN: false, PT: 500 }); // IN drops mid-pulse — pulse continues
    expect(tp.Q).toBe(true);
    expect(tp.ET).toBe(300);
    clock.setScanTime(0.6);
    tp.call({ IN: false, PT: 500 }); // pulse over
    expect(tp.Q).toBe(false);
  });

  it('is not retriggerable while the pulse is active and re-arms only after IN drops', () => {
    const clock = new PlcClock();
    const tp = new TP(clock);
    clock.setScanTime(0);
    tp.call({ IN: true, PT: 500 });
    clock.setScanTime(0.6);
    tp.call({ IN: true, PT: 500 }); // IN still high after pulse end
    expect(tp.Q).toBe(false);
    expect(tp.ET).toBe(500); // ET holds PT while IN stays high
    clock.setScanTime(0.7);
    tp.call({ IN: true, PT: 500 }); // still no new pulse (no new rising edge)
    expect(tp.Q).toBe(false);
    clock.setScanTime(0.8);
    tp.call({ IN: false, PT: 500 }); // re-arm
    expect(tp.ET).toBe(0);
    clock.setScanTime(0.9);
    tp.call({ IN: true, PT: 500 }); // new rising edge → new pulse
    expect(tp.Q).toBe(true);
  });
});

// ─── CTU / CTD / CTUD (counters) ────────────────────────────────────────────

describe('CTU', () => {
  it('counts rising edges of CU, Q at CV >= PV, caps at PV', () => {
    const ctu = new CTU();
    for (let i = 1; i <= 3; i++) {
      ctu.call({ CU: true, R: false, PV: 3 });
      ctu.call({ CU: false, R: false, PV: 3 });
      expect(ctu.CV).toBe(i);
    }
    expect(ctu.Q).toBe(true);
    // 4th edge: capped at PV
    ctu.call({ CU: true, R: false, PV: 3 });
    expect(ctu.CV).toBe(3);
  });

  it('a held-high CU counts only once (edge, not level)', () => {
    const ctu = new CTU();
    ctu.call({ CU: true, R: false, PV: 10 });
    ctu.call({ CU: true, R: false, PV: 10 });
    ctu.call({ CU: true, R: false, PV: 10 });
    expect(ctu.CV).toBe(1);
  });

  it('R resets CV to 0 and is dominant over counting', () => {
    const ctu = new CTU();
    ctu.call({ CU: true, R: false, PV: 3 });
    ctu.call({ CU: false, R: false, PV: 3 });
    ctu.call({ CU: true, R: true, PV: 3 }); // edge + reset → reset wins
    expect(ctu.CV).toBe(0);
    expect(ctu.Q).toBe(false);
  });
});

describe('CTD', () => {
  it('LD loads PV, counts down on CD edges, Q at 0, floors at 0', () => {
    const ctd = new CTD();
    ctd.call({ CD: false, LD: true, PV: 2 });
    expect(ctd.CV).toBe(2);
    expect(ctd.Q).toBe(false);
    ctd.call({ CD: false, LD: false, PV: 2 });
    ctd.call({ CD: true, LD: false, PV: 2 });
    expect(ctd.CV).toBe(1);
    ctd.call({ CD: false, LD: false, PV: 2 });
    ctd.call({ CD: true, LD: false, PV: 2 });
    expect(ctd.CV).toBe(0);
    expect(ctd.Q).toBe(true);
    // further edges floor at 0
    ctd.call({ CD: false, LD: false, PV: 2 });
    ctd.call({ CD: true, LD: false, PV: 2 });
    expect(ctd.CV).toBe(0);
  });
});

describe('CTUD', () => {
  it('counts up and down, QU at PV, QD at 0', () => {
    const c = new CTUD();
    const idle = { CU: false, CD: false, R: false, LD: false, PV: 2 };
    expect(c.QD).toBe(true); // CV starts at 0
    c.call({ ...idle, CU: true });
    c.call(idle);
    c.call({ ...idle, CU: true });
    expect(c.CV).toBe(2);
    expect(c.QU).toBe(true);
    expect(c.QD).toBe(false);
    c.call(idle);
    c.call({ ...idle, CD: true });
    expect(c.CV).toBe(1);
    expect(c.QU).toBe(false);
  });

  it('R is dominant over LD and counting', () => {
    const c = new CTUD();
    c.call({ CU: false, CD: false, R: false, LD: true, PV: 5 });
    expect(c.CV).toBe(5);
    c.call({ CU: true, CD: false, R: true, LD: true, PV: 5 });
    expect(c.CV).toBe(0);
    expect(c.QD).toBe(true);
  });

  it('simultaneous CU and CD edges leave CV unchanged', () => {
    const c = new CTUD();
    const idle = { CU: false, CD: false, R: false, LD: false, PV: 5 };
    c.call({ ...idle, CU: true });
    c.call(idle);
    expect(c.CV).toBe(1);
    c.call({ ...idle, CU: true, CD: true });
    expect(c.CV).toBe(1);
  });
});

// ─── R_TRIG / F_TRIG (edge detectors) ───────────────────────────────────────

describe('R_TRIG', () => {
  it('Q is TRUE for exactly one call on a rising edge', () => {
    const trig = new R_TRIG();
    expect(trig.call({ CLK: true }).Q).toBe(true); // first rising edge
    expect(trig.call({ CLK: true }).Q).toBe(false); // held high — no pulse
    expect(trig.call({ CLK: false }).Q).toBe(false);
    expect(trig.call({ CLK: true }).Q).toBe(true); // next rising edge
  });
});

describe('F_TRIG', () => {
  it('Q is TRUE for exactly one call on a falling edge (no pulse on initial FALSE)', () => {
    const trig = new F_TRIG();
    expect(trig.call({ CLK: false }).Q).toBe(false); // no spurious first-call pulse
    expect(trig.call({ CLK: true }).Q).toBe(false);
    expect(trig.call({ CLK: false }).Q).toBe(true); // falling edge
    expect(trig.call({ CLK: false }).Q).toBe(false); // held low — no pulse
  });
});

// ─── RS / SR (bistables) ────────────────────────────────────────────────────

describe('RS (reset-dominant)', () => {
  it('latches on S, R1 wins when both are TRUE', () => {
    const rs = new RS();
    rs.call({ S: true, R1: false });
    expect(rs.Q1).toBe(true);
    rs.call({ S: false, R1: false });
    expect(rs.Q1).toBe(true); // latched
    rs.call({ S: true, R1: true }); // both → reset dominant
    expect(rs.Q1).toBe(false);
    expect(rs.Q).toBe(false);
  });
});

describe('SR (set-dominant)', () => {
  it('latches on S1, S1 wins when both are TRUE', () => {
    const sr = new SR();
    sr.call({ S1: true, R: true }); // both → set dominant
    expect(sr.Q1).toBe(true);
    sr.call({ S1: false, R: true }); // reset alone clears
    expect(sr.Q1).toBe(false);
    sr.call({ S1: true, R: false });
    sr.call({ S1: false, R: false });
    expect(sr.Q1).toBe(true); // latched
    expect(sr.Q).toBe(true);
  });
});

// ─── Cross-cutting: isolation, reset, factory ───────────────────────────────

describe('FB instances — isolation and reset', () => {
  it('two TON instances on the same clock do not influence each other', () => {
    const clock = new PlcClock();
    const a = new TON(clock);
    const b = new TON(clock);
    clock.setScanTime(0);
    a.call({ IN: true, PT: 1000 });
    b.call({ IN: false, PT: 1000 });
    clock.setScanTime(1.5);
    a.call({ IN: true, PT: 1000 });
    b.call({ IN: true, PT: 1000 }); // b's rising edge is only NOW
    expect(a.Q).toBe(true);
    expect(b.Q).toBe(false);
    expect(b.ET).toBe(0);
  });

  it('reset() restores the initial state including edge memories', () => {
    const clock = new PlcClock();
    const ton = new TON(clock);
    clock.setScanTime(0);
    ton.call({ IN: true, PT: 100 });
    clock.setScanTime(1);
    ton.call({ IN: true, PT: 100 });
    expect(ton.Q).toBe(true);
    ton.reset();
    expect(ton.Q).toBe(false);
    expect(ton.ET).toBe(0);

    const ctu = new CTU();
    ctu.call({ CU: true, R: false, PV: 5 });
    expect(ctu.CV).toBe(1);
    ctu.reset();
    expect(ctu.CV).toBe(0);
    // edge memory cleared → a held-high CU counts again as a fresh edge
    ctu.call({ CU: true, R: false, PV: 5 });
    expect(ctu.CV).toBe(1);
  });

  it('inputs are instance variables: omitted parameters keep their previous value', () => {
    const clock = new PlcClock();
    const ton = new TON(clock);
    clock.setScanTime(0);
    ton.call({ IN: true, PT: 1000 });
    clock.setScanTime(1.5);
    ton.call({ IN: true }); // PT omitted — keeps 1000
    expect(ton.Q).toBe(true);
  });
});

describe('createFbInstance factory', () => {
  it('creates all 10 standard FB types', () => {
    const clock = new PlcClock();
    const expected: Record<string, unknown> = {
      TON,
      TOF,
      TP,
      CTU,
      CTD,
      CTUD,
      R_TRIG,
      F_TRIG,
      RS,
      SR,
    };
    for (const [type, ctor] of Object.entries(expected)) {
      const fb = createFbInstance(type, clock);
      expect(fb).toBeInstanceOf(ctor as new (...args: never[]) => unknown);
      expect(fb.fbType).toBe(type);
    }
  });

  it('throws on unknown FB types (load-time error)', () => {
    expect(() => createFbInstance('FOO', new PlcClock())).toThrow(/unknown function block/i);
  });
});
