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
