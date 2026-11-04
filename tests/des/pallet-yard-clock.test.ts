// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-612 §9.1d — the PalletYard DES clock is instance- and HMR-safe (SOL R2 #2),
// Animated + FastForward with the real DESRunner:
//   - an OLD clock instance plans t=10, a NEW instance plans t=20 on the unchanged
//     manager queue → only the new callback runs, at exactly t=20;
//   - module reload (a second instance of sim-clock.ts, as HMR loads it): the DES.Callback events of the
//     FIRST module's clock are dropped, only the clock of the SECOND module dispatches;
//   - a DES reset reaches the clock through the runner lifecycle (plan-645 L3: new generation, onRestart 'reset'),
//     a stale handle cancels nothing.
import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { DES_CALLBACK_ACTION } from '@rv/plugins/des/rv-des-manager';
import { ACTION_INDEX } from '@rv/plugins/des/rv-des-named-actions';
import { DesSimClock, type ClockRestart } from '@rv/plugins/des/fleet/des-sim-clock';
import type { ClockHandle } from '@rv/core/fleet/core/sim-clock';
import { DesLift } from '@rv/plugins/des/fleet/des-lift';
import type { LiftDrive } from '@rv/core/fleet/exec/backends';

type Mode = 'animated' | 'fastforward';

function makeRunner(mode: Mode): DESRunner {
  const runner = new DESRunner(mode === 'fastforward' ? { subMode: 'fastforward', durationSeconds: 1e6 } : { subMode: 'animated' });
  runner.start([], { root: new Object3D() });
  return runner;
}

function runTo(runner: DESRunner, t: number): void {
  if (runner.subMode === 'fastforward') { runner.getManager().processUpTo(t, 1e6); return; }
  while (runner.renderClock < t - 1e-9) { runner.tick(1 / 60); runner.lateTick(1 / 60); }
}

describe('PalletYard clock (9.1d)', () => {
  for (const mode of ['animated', 'fastforward'] as Mode[]) {
    it(`[${mode}] old instance plans t=10, new instance t=20 → only the new one runs, at t=20`, () => {
      const runner = makeRunner(mode);
      const fired: Array<[string, number]> = [];
      const oldClock = new DesSimClock(runner);
      oldClock.schedule(10, () => fired.push(['old', runner.getManager().currentTime]));
      const newClock = new DesSimClock(runner);
      expect(newClock.generation).toBeGreaterThan(oldClock.generation);
      newClock.schedule(20, () => fired.push(['new', runner.getManager().currentTime]));
      runTo(runner, 30);
      expect(fired).toEqual([['new', 20]]);
      newClock.dispose(); oldClock.dispose(); runner.dispose();
    });

    it(`[${mode}] module reload: the action registered by the first module dispatches to the second module's clock`, async () => {
      const runner = makeRunner(mode);                  // manager + named-action registry of the FIRST module graph
      const fired: Array<[string, number]> = [];
      const first = new DesSimClock(runner);
      first.schedule(10, () => fired.push(['first', runner.getManager().currentTime]));
      expect(ACTION_INDEX.has(DES_CALLBACK_ACTION), 'plan-645 L3: the clock plans DES.Callback events').toBe(true);
      // HMR of the plugin module ONLY: a second instance of sim-clock.ts (query = new module
      // identity) next to the unchanged DES modules — exactly what a hot reload produces.
      const url = new URL('../../src/plugins/des/fleet/des-sim-clock.ts', import.meta.url).href;
      const reloaded = await import(/* @vite-ignore */ `${url}?reload=${Date.now()}`) as typeof import('@rv/plugins/des/fleet/des-sim-clock');
      expect(reloaded.DesSimClock).not.toBe(DesSimClock);  // a fresh module instance
      const second = new reloaded.DesSimClock(runner as never);
      expect(second.generation).toBeGreaterThan(first.generation); // page-wide monotone generation
      second.schedule(20, () => fired.push(['second', runner.getManager().currentTime]));
      runTo(runner, 30);
      expect(fired).toEqual([['second', 20]]);
      second.dispose(); first.dispose(); runner.dispose();
    });

    // CP2 E1: `cancel` drops the callback from the clock's map, not only the queue event —
    // the takt re-arm (cancel + schedule) and an aborted lift stroke leave nothing behind.
    it(`[${mode}] 1000 takt re-arms + 1000 aborted strokes keep the pending callbacks bounded (E1)`, () => {
      const runner = makeRunner(mode);
      const clock = new DesSimClock(runner);
      const drive: LiftDrive = { positionOverwrite: false, currentPosition: 0, applyToNode: () => {} };
      const lift = new DesLift(() => runner, clock, new Map([['Stapler_1', drive]]));
      let takt: ClockHandle | null = null;
      let fired = 0;
      for (let i = 0; i < 1000; i++) {
        clock.cancel(takt);                                   // armTakt: cancel the old handle, arm anew
        takt = clock.schedule(100 + i, () => { fired++; });
        lift.setDoneHandler(() => { fired++; });
        lift.move('Stapler_1', 500, 300, { e: 1, hj: 0, cont: { k: 'none' } }); // a stroke ...
        lift.cancel('Stapler_1');                             // ... aborted (re-tasked / reset)
      }
      expect(clock.pending, 'one live takt callback, no leaked strokes').toBe(1);
      runTo(runner, 2000);
      expect(fired, 'only the last takt fires').toBe(1);
      expect(clock.pending).toBe(0);
      clock.dispose(); runner.dispose();
    });

    it(`[${mode}] a DES reset is detected by the clock; stale handles cancel nothing, old events never fire`, () => {
      const runner = makeRunner(mode);
      const restarts: ClockRestart[] = [];
      const clock = new DesSimClock(runner, (why) => restarts.push(why));
      const fired: string[] = [];
      for (const t of [2, 4, 5]) clock.schedule(t, () => {});   // the run has progressed (time + events)
      runTo(runner, 6);
      const stale = clock.schedule(20, () => fired.push('old'));
      const g0 = clock.generation;
      runner.reset();
      if (mode === 'fastforward') runner.setSubMode('fastforward');
      // the runner's reset → bound reached the clock synchronously
      const fresh = clock.schedule(20, () => fired.push('new'));
      expect(restarts).toEqual(['reset']);
      expect(fresh.g).toBeGreaterThan(g0);
      clock.cancel(stale);                               // must NOT hit the new event (ids restarted)
      runTo(runner, 30);
      expect(fired).toEqual(['new']);
      clock.dispose(); runner.dispose();
    });

    // Legacy fallback without fleet.clock: a restore reaches the clock as `restored` — exactly one restart, the
    // callbacks planned before it are gone, a re-plan fires; runner dispose detaches the clock.
    it(`[${mode}] restored → one 'restore-replan' restart, old callbacks dropped, re-plan fires; dispose detaches`, () => {
      const runner = makeRunner(mode);
      const restarts: ClockRestart[] = [];
      const fired: string[] = [];
      const clock = new DesSimClock(runner, (why) => restarts.push(why));
      clock.schedule(3, () => {});
      runTo(runner, 4);
      const snap = runner.fullSnapshot();
      clock.schedule(20, () => fired.push('before-restore'));
      const g0 = clock.generation;
      runner.restoreFull(snap);
      expect(restarts).toEqual(['restore-replan']);
      expect(clock.generation).toBeGreaterThan(g0);
      expect(clock.pending).toBe(0);
      clock.schedule(25, () => fired.push('re-planned'));
      runTo(runner, 30);
      expect(fired).toEqual(['re-planned']);
      runner.dispose();
      expect(restarts, 'dispose is no restart').toEqual(['restore-replan']);
      expect(() => clock.schedule(40, () => {}), 'disposed with the runner').toThrow();
    });
  }
});
