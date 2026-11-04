// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-612 §9.9 — `AgvTask.serviceState`: the statistics category a vehicle
 * books while it stands at the task destination (dwell timer or dock).
 *
 * - `serviceState: 'Charging'` + 600 s dwell → `chargingPercent` equals the
 *   measured stay, also across a DES freeze/resume inside the stay (the
 *   re-booking after the resume event must not fall back to `Working`);
 * - the same through a DOCK holding the vehicle until `release()`;
 * - without the field the stay books `Working`, exactly as before;
 * - plan-595: a dock approached in REVERSE (stub manoeuvre) books the task's
 *   state for the whole stay as well.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultAgvFleet, type AgvTask } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultPathDockRegistry } from '../../src/core/engine/rv-path-dock';
import { DESComponent } from '@rv/plugins/des/rv-des-component';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { makeHost, makeAgvRoot, bindDes, clearShared } from '../helpers/agv-harness';
import { setReverseGateOpen } from '../../src/core/engine/rv-movement-authority';
import { stubLayout, makeStubWorld, forkCfg, FORK, FORK_MESH, delay } from '../helpers/agv-stub-world';

beforeEach(() => clearShared());

const STEP = 0.25; // s per runner tick — the DES clock only jumps to events anyway

function course(): void {
  const net = getDefaultPathNetwork();
  const add = (raw: Record<string, unknown>): void => {
    net.register(parsePathExtras({ type: 'Path', version: 1, closed: false, align: [0, 1, 0], ...raw }, raw.id as string)!);
  };
  add({ id: 'A', segments: [{ kind: 'line', from: [0, 0, 0], to: [3, 0, 0] }] });
  add({ id: 'Park', segments: [{ kind: 'line', from: [0, 0, 5], to: [4, 0, 5] }] });
  net.resolveGraph();
}

interface Run { runner: DESRunner; v: Object3D; now(): number; stats(): ReturnType<DESComponent['getStatistics']>; adapter(): DESComponent }

function start(): Run {
  course();
  const runner = new DESRunner({ subMode: 'animated' });
  const host = makeHost();
  const v = makeAgvRoot('V', { PathId: 'A', StartPosition: 0, VehicleLength: 1000, VehicleWidth: 600, ScannerFields: false });
  const clock = makeAgvRoot('Clock', { PathId: 'Park', StartPosition: 4000, VehicleLength: 1000, VehicleWidth: 600, ScannerFields: false });
  [v, clock].forEach((r) => bindDes(runner, r, host));
  runner.start([], { root: new Object3D() });
  const adapter = (): DESComponent => runner.liveInstances.find((i) => i.self.root === v)!.adapter as unknown as DESComponent;
  return { runner, v, now: () => runner.getManager().currentTime, stats: () => adapter().getStatistics(), adapter };
}

function runUntil(run: Run, done: () => boolean, maxSimSec = 2000): void {
  for (let i = 0; i < maxSimSec / STEP && !done(); i++) { run.runner.tick(STEP); run.runner.lateTick(STEP); }
}

describe('AgvTask.serviceState (plan-612 §9.9)', () => {
  it('a 600 s Charging dwell books Charging for the whole stay — also across a freeze/resume', () => {
    const run = start();
    const fleet = getDefaultAgvFleet();
    let arrived = -1, ended = -1, tFail = -1, tRepair = -1, stateAfterResume = '';
    const task: AgvTask = {
      destination: 'A', serviceSec: 600, serviceState: 'Charging',
      onArrive: () => {
        arrived = run.now();
        // Fail V 100 s into its stay, repair 50 s later — both from the parked Clock's events.
        fleet.get('Clock')!.assign({
          destination: 'Park', serviceSec: 100,
          onServiceEnd: () => {
            tFail = run.now();
            (run.adapter() as unknown as { setFailure(f: boolean): void }).setFailure(true);
            fleet.get('Clock')!.assign({
              destination: 'Park', serviceSec: 50,
              onServiceEnd: () => {
                tRepair = run.now();
                (run.adapter() as unknown as { setFailure(f: boolean): void }).setFailure(false);
                stateAfterResume = run.stats().currentState;
              },
            });
          },
        });
      },
      onServiceEnd: () => { ended = run.now(); },
    };
    fleet.get('V')!.assign(task);
    runUntil(run, () => ended >= 0);
    const s = run.stats();
    const total = run.now(); // the stats window starts at registration (t = 0)
    run.runner.dispose();

    expect(arrived).toBeGreaterThan(0);
    expect(tRepair - tFail).toBeCloseTo(50, 0);   // the Clock's own transit adds a few ms
    expect(stateAfterResume).toBe('Charging');                 // the resume re-booking keeps the task state
    const charging = s.states.Charging?.duration ?? 0;
    const failure = s.states.Failure?.duration ?? 0;
    // the stay is frozen during the downtime: 600 s of service + 50 s Failure
    expect(ended - arrived).toBeCloseTo(650, 0);
    expect(charging).toBeCloseTo(600, 0);
    expect(failure).toBeCloseTo(50, 0);
    expect(s.states.Working?.duration ?? 0).toBeLessThan(1e-6);
    expect(s.chargingPercent ?? 0).toBeCloseTo((charging / total) * 100, 6);
  });

  it('a dock stay with serviceState books it until the dock releases', () => {
    const run = start();
    const fleet = getDefaultAgvFleet();
    let arrived = -1, released = -1, ended = -1;
    getDefaultPathDockRegistry().register('A', {
      onVehicleArrive: (_id, release) => {
        arrived = run.now();
        fleet.get('Clock')!.assign({
          destination: 'Park', serviceSec: 600,
          onServiceEnd: () => { released = run.now(); release(); },
        });
      },
    });
    fleet.get('V')!.assign({ destination: 'A', serviceState: 'Charging', onServiceEnd: () => { ended = run.now(); } });
    runUntil(run, () => ended >= 0);
    const s = run.stats();
    run.runner.dispose();
    expect(released - arrived).toBeCloseTo(600, 0);
    expect(s.states.Charging?.duration ?? 0).toBeGreaterThan(599);
    expect(s.states.Charging?.duration ?? 0).toBeLessThan(ended - arrived + 1e-6);
    expect(s.states.Working?.duration ?? 0).toBeLessThan(1e-6);
  });

  it('without the field the stay books Working (unchanged behaviour)', () => {
    const run = start();
    const fleet = getDefaultAgvFleet();
    let ended = -1, during = '';
    fleet.get('V')!.assign({
      destination: 'A', serviceSec: 60,
      onArrive: () => {
        fleet.get('Clock')!.assign({ destination: 'Park', serviceSec: 30, onServiceEnd: () => { during = run.stats().currentState; } });
      },
      onServiceEnd: () => { ended = run.now(); },
    });
    runUntil(run, () => ended >= 0);
    const s = run.stats();
    run.runner.dispose();
    expect(during).toBe('Working');
    expect(s.states.Working?.duration ?? 0).toBeCloseTo(60, 0);
    expect(s.states.Charging).toBeUndefined();
    expect(s.chargingPercent ?? 0).toBe(0);
  });

  it('plan-595: a dock approached in reverse books the serviceState for the whole stay', () => {
    setReverseGateOpen(true);
    try {
      stubLayout();
      const w = makeStubWorld('animated', [{ name: 'F', cfg: forkCfg('L0', 3500), mesh: FORK_MESH, body: FORK }], 900);
      const fleet = getDefaultAgvFleet();
      let arrived = -1, released = -1, ended = -1, during = '', dir = 0;
      getDefaultPathDockRegistry().register('S2', {
        onVehicleArrive: (_id, release) => {
          arrived = w.now();
          dir = w.mb.planDirOf('F');
          delay(300, () => { during = w.desState!('F'); });
          delay(600, () => { released = w.now(); release(); });
        },
      });
      fleet.get('F')!.assign({ destination: 'S2', approach: 'reverse', serviceState: 'Handling', onServiceEnd: () => { ended = w.now(); } });
      while (!w.done() && ended < 0) w.step();
      w.dispose();
      expect(dir).toBe(-1);                       // the dock was reached on the reverse plan
      expect(released - arrived).toBeCloseTo(600, 0);
      expect(during).toBe('Handling');            // booked in the middle of the stay
      expect(ended).toBeGreaterThanOrEqual(released);
    } finally {
      setReverseGateOpen(true); // restore the default
    }
  });
});
