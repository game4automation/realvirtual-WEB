// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2004 — the in-page virtual clock, run in a node `vm` context with a hand-driven NATIVE
 * timer queue, so the test controls both clocks: wall time (`advanceReal`) and page time
 * (`__vt.step`).
 *
 * The case that matters (Codex review 2026-10-27): a `setTimeout` started BEFORE `__vt.enable()`
 * used to stay on the wall clock and fired whenever wall time passed — in the middle of a take,
 * at a frame that depended on the capture speed. `enable()` now moves it onto the virtual clock
 * with its remaining delay.
 */

import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

import { virtualClockInitScript } from '../scripts/tutorial/lib/virtual-clock.mjs';

interface NativeTimer { id: number; due: number; fn: (...args: unknown[]) => void; args: unknown[] }
interface VirtualClockApi {
  enable(): { epoch: number; migratedTimers: number; migratedRafs: number };
  step(ms: number): { frame: number };
}

function page(realStart = 5000) {
  let real = realStart;
  let nextNative = 1;
  const queue: NativeTimer[] = [];
  const sandbox: Record<string, unknown> = {
    performance: { now: () => real },
    setTimeout: (fn: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
      const id = nextNative++;
      queue.push({ id, due: real + Number(delay), fn, args });
      return id;
    },
    clearTimeout: (id: number) => {
      const at = queue.findIndex((timer) => timer.id === id);
      if (at >= 0) queue.splice(at, 1);
    },
    Event: class {},
    console,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  const context = createContext(sandbox);
  runInContext(`(${virtualClockInitScript.toString()})(${JSON.stringify({})})`, context);
  const g = sandbox as unknown as {
    setTimeout: (fn: () => void, delay?: number) => number;
    clearTimeout: (id: number) => void;
    requestAnimationFrame: (fn: () => void) => number;
    __vt: VirtualClockApi;
  };
  return {
    g,
    /** Lets wall time pass and fires every NATIVE timer that falls due. */
    advanceReal(ms: number) {
      real += ms;
      for (;;) {
        const due = queue.filter((timer) => timer.due <= real).sort((a, b) => a.due - b.due)[0];
        if (!due) break;
        queue.splice(queue.indexOf(due), 1);
        due.fn(...due.args);
      }
    },
    nativePending: () => queue.length,
  };
}

describe('virtual clock — timers started before enable()', () => {
  it('Test_VirtualClock_PreEnableTimeout_MigratesWithRemainingDelay', () => {
    const p = page();
    const fired: string[] = [];
    p.g.setTimeout(() => fired.push('t100'), 100);
    p.advanceReal(30);
    const enabled = p.g.__vt.enable();
    expect(enabled.migratedTimers).toBe(1);
    expect(p.nativePending()).toBe(0);
    // Wall time no longer matters for it.
    p.advanceReal(10_000);
    expect(fired).toEqual([]);
    // 70 ms remain: two 33.3 ms frames are not enough, the third is.
    p.g.__vt.step(1000 / 30);
    p.g.__vt.step(1000 / 30);
    expect(fired).toEqual([]);
    p.g.__vt.step(1000 / 30);
    expect(fired).toEqual(['t100']);
  });

  it('Test_VirtualClock_PreEnableTimeout_ClearedAfterMigration_NeverFires', () => {
    const p = page();
    const fired: string[] = [];
    const id = p.g.setTimeout(() => fired.push('cleared'), 50);
    p.g.__vt.enable();
    p.g.clearTimeout(id);
    for (let i = 0; i < 10; i++) p.g.__vt.step(1000 / 30);
    expect(fired).toEqual([]);
  });

  it('Test_VirtualClock_PreEnableTimeout_FiredBeforeEnable_IsNotMigrated', () => {
    const p = page();
    const fired: string[] = [];
    p.g.setTimeout(() => fired.push('early'), 10);
    p.advanceReal(20);
    expect(fired).toEqual(['early']);
    expect(p.g.__vt.enable().migratedTimers).toBe(0);
    for (let i = 0; i < 5; i++) p.g.__vt.step(1000 / 30);
    expect(fired).toEqual(['early']);
  });

  it('Test_VirtualClock_PreEnableAnimationFrame_FiresWithTheNextStepNotOnWallTime', () => {
    const p = page();
    const fired: string[] = [];
    p.g.requestAnimationFrame(() => fired.push('raf'));
    expect(p.g.__vt.enable().migratedRafs).toBe(1);
    p.advanceReal(1000);
    expect(fired).toEqual([]);
    p.g.__vt.step(1000 / 30);
    expect(fired).toEqual(['raf']);
  });

  it('Test_VirtualClock_VirtualIds_NeverCollideWithNativeIds', () => {
    const p = page();
    const nativeId = p.g.setTimeout(() => {}, 1);
    p.advanceReal(5);
    p.g.__vt.enable();
    const fired: string[] = [];
    const virtualId = p.g.setTimeout(() => fired.push('virtual'), 10);
    expect(virtualId).not.toBe(nativeId);
    p.g.clearTimeout(nativeId); // a stale native id must not cancel the virtual timer
    p.g.__vt.step(1000 / 30);
    expect(fired).toEqual(['virtual']);
  });
});

interface WallClockApi extends VirtualClockApi {
  now(): number;
  stats(): { vt: number; epoch: number; creep: number; steps: number; wall: boolean };
  frame: number;
  beginCapture(): { frame: number };
  wallBegin(opts?: { pumpMs?: number }): { vt: number; frame: number };
  wallHold(on: boolean): { held: boolean };
  markFrame(flush?: boolean): { frame: number; vt: number };
  wallEnd(): { vt: number; already?: boolean; frame: number };
}

describe('virtual clock — creep carry (plan-2237 F1)', () => {
  const DT = 1000 / 30;

  it('Test_VirtualClock_CreepCarry_150CallsPerFrame_PageTimeEqualsVt', () => {
    const p = page();
    const vt = p.g.__vt as unknown as WallClockApi;
    const { epoch } = vt.enable();
    let worst = 0;
    for (let frame = 0; frame < 1000; frame++) {
      vt.step(DT);
      // The first reading of the frame: the carried creep was absorbed by this frame's dt.
      const first = vt.now() - epoch - vt.stats().vt;
      worst = Math.max(worst, Math.abs(first));
      for (let call = 1; call < 150; call++) vt.now();
    }
    // One creep quantum (0.5 us = 0.0005 ms) plus float noise; without the carry this would be
    // 1000 * 150 * 0.5 us = 75 ms, i.e. 4.5 fixed steps of lead (the old ~16 s limit).
    expect(worst).toBeLessThanOrEqual(0.0005 + 1e-6);
  });

  it('Test_VirtualClock_CreepCarry_LongFastForward_NeverBackwards', () => {
    const p = page();
    const vt = p.g.__vt as unknown as WallClockApi;
    vt.enable();
    let backwards = 0;
    let last = vt.now();
    for (let frame = 0; frame < 30; frame++) {
      // A fast-forward loop polling performance.now() against a deadline: 120000 calls = 60 ms creep.
      for (let call = 0; call < 120_000; call++) {
        const now = vt.now();
        if (now < last) backwards++;
        last = now;
      }
      vt.step(DT);
      const now = vt.now();
      if (now < last) backwards++;
      last = now;
    }
    expect(backwards).toBe(0);
    expect(vt.stats().creep).toBeGreaterThan(0); // carried, not reset
  });
});

describe('virtual clock — wall mode (plan-2237 Phase 2)', () => {
  const DT = 1000 / 30;

  it('Test_VirtualClock_Wall_MonotoneReturn_FrameCounterGapless', () => {
    const p = page();
    const vt = p.g.__vt as unknown as WallClockApi;
    vt.enable();
    vt.beginCapture();
    const frames: number[] = [];
    for (let i = 0; i < 5; i++) frames.push(vt.step(DT).frame);
    const before = vt.stats().vt;
    vt.wallBegin({ pumpMs: 16 });
    for (let i = 0; i < 4; i++) {
      p.advanceReal(250);
      frames.push(vt.markFrame(true).frame);
    }
    const inWall = vt.stats().vt;
    expect(inWall).toBeGreaterThanOrEqual(before + 1000 - 1e-9);
    const ended = vt.wallEnd();
    expect(ended.vt).toBeGreaterThanOrEqual(inWall);
    for (let i = 0; i < 3; i++) frames.push(vt.step(DT).frame);
    expect(frames).toEqual(Array.from({ length: frames.length }, (_, i) => i));
    expect(vt.stats().vt).toBeCloseTo(ended.vt + 3 * DT, 9);
  });

  it('Test_VirtualClock_Wall_CreepDuringWall_NoStallAfterWallEnd', () => {
    // plan-2237 acceptance probe (frames 845..848, I1 "0 fixed steps"): a batch polling
    // performance.now() during the time-lapse piles up creep that no `step` absorbs; after wallEnd
    // the carry ate whole frame dts, page time stood still for ~4 frames and the viewer ran no
    // fixed step. Every stepped frame after wallEnd must advance page time by its full dt.
    const p = page();
    const vt = p.g.__vt as unknown as WallClockApi;
    vt.enable();
    vt.beginCapture();
    vt.step(DT);
    vt.wallBegin({ pumpMs: 16 });
    for (let i = 0; i < 4; i++) {
      p.advanceReal(250);
      for (let call = 0; call < 60_000; call++) vt.now(); // 4 x 30 ms = 120 ms of creep
      vt.markFrame(true);
    }
    vt.wallEnd();
    let last = vt.now();
    for (let frame = 0; frame < 6; frame++) {
      vt.step(DT);
      const now = vt.now();
      expect(now - last).toBeGreaterThanOrEqual(DT - 0.001);
      expect(now - last).toBeLessThanOrEqual(DT + 0.001);
      last = now;
    }
  });

  it('Test_VirtualClock_Wall_StepThrows_MarkFrameOutsideWallThrows', () => {
    const p = page();
    const vt = p.g.__vt as unknown as WallClockApi;
    vt.enable();
    expect(() => vt.markFrame(true)).toThrow(/outside wall mode/);
    vt.wallBegin();
    expect(() => vt.step(DT)).toThrow(/wall mode/);
    expect(() => vt.wallBegin()).toThrow(/already/);
    vt.wallEnd();
    expect(vt.wallEnd().already).toBe(true);
    expect(() => vt.step(DT)).not.toThrow();
  });

  it('Test_VirtualClock_Wall_HoldStopsPump_FlushFiresDue', () => {
    const p = page();
    const vt = p.g.__vt as unknown as WallClockApi;
    vt.enable();
    vt.wallBegin({ pumpMs: 16 });
    const fired: string[] = [];
    p.g.setTimeout(() => fired.push('t'), 10);
    vt.wallHold(true);
    p.advanceReal(200);
    expect(fired).toEqual([]); // the pump is held: nothing fires during a grab sequence
    vt.markFrame(true);         // the flush brings page time to the wall and runs what is due
    expect(fired).toEqual(['t']);
    vt.wallHold(false);
    vt.wallEnd();
  });

  it('Test_VirtualClock_Wall_EndAfterAbort_RestoresStepping', () => {
    const p = page();
    const vt = p.g.__vt as unknown as WallClockApi;
    vt.enable();
    try {
      vt.wallBegin({ pumpMs: 16 });
      p.advanceReal(100);
      vt.markFrame(true);
      throw new Error('grab failed');
    } catch { /* the runner's finally */ } finally {
      vt.wallEnd();
    }
    expect(vt.stats().wall).toBe(false);
    // The pump is gone: wall time no longer moves page time.
    const vtAfter = vt.stats().vt;
    p.advanceReal(1000);
    expect(vt.stats().vt).toBe(vtAfter);
    expect(p.nativePending()).toBe(0);
    vt.step(DT);
    expect(vt.stats().vt).toBeCloseTo(vtAfter + DT, 9);
  });
});
