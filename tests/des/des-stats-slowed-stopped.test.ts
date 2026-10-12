// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-558 §9.9 — vehicle statistics Slowed / Stopped.
 *
 * Priority (descending): Run off → Empty; Failure; servicing → Working;
 * standing at a traffic stop → Stopped; driving below the free profile
 * (leader envelope / warning field) → Slowed; driving with a task →
 * Transport; without → Empty. Slowed is booked at the analytic instant (a
 * `stat` event, ± 1 ms); the shares sum to 100 %; Stopped is free time (not
 * utilization) in DES and in the continuous StateStatistics; stations and
 * producers that never book the new states are unchanged.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultMovementAuthority } from '../../src/core/engine/rv-movement-authority';
import { StateStatistics } from '../../src/core/material-flow/rv-state-statistics';
import { DESComponent } from '@rv-private/plugins/des/rv-des-component';
import { drawStateStackBar } from '@rv-private/plugins/des/hmi/des-stats-gizmos';
import { DES_STATE_STACK } from '@rv-private/plugins/des/hmi/des-stat-colors';
import { DESRunner } from '@rv-private/plugins/des/des-runner';
import { TICK, makeHost, makeAgvRoot, bindDes, clearShared } from '../helpers/agv-harness';

beforeEach(() => clearShared());

type Stats = ReturnType<DESComponent['getStatistics']>;

function course(): void {
  const net = getDefaultPathNetwork();
  net.register(parsePathExtras({ type: 'Path', id: 'S', segments: [{ kind: 'line', from: [0, 0, 0], to: [80, 0, 0] }] }, 'S')!);
  net.register(parsePathExtras({ type: 'Path', id: 'Park', segments: [{ kind: 'line', from: [0, 0, 5], to: [4, 0, 5] }] }, 'Park')!);
  net.resolveGraph();
}

interface Run {
  runner: DESRunner;
  roots: Object3D[];
  log: Map<string, Array<[string, number]>>;
}

/** Bind + start, logging every DES state booking per vehicle with its sim time. */
function start(specs: Array<[string, Record<string, unknown>]>): Run {
  course();
  const runner = new DESRunner({ subMode: 'animated' });
  const host = makeHost();
  const roots = specs.map(([n, c]) => makeAgvRoot(n, { VehicleLength: 1000, VehicleWidth: 600, ScannerFields: false, ...c }));
  roots.forEach((r) => bindDes(runner, r, host));
  runner.start([], { root: new Object3D() });
  const log = new Map<string, Array<[string, number]>>();
  for (const inst of runner.liveInstances) {
    const adapter = inst.adapter as unknown as { setState(n: string): void };
    const name = inst.self.root.name;
    const entries: Array<[string, number]> = [];
    log.set(name, entries);
    const orig = adapter.setState.bind(adapter);
    adapter.setState = (n: string): void => { entries.push([n, runner.getManager().currentTime]); orig(n); };
  }
  return { runner, roots, log };
}

function statsOf(run: Run, name: string): Stats {
  const inst = run.runner.liveInstances.find((i) => i.self.root.name === name)!;
  return (inst.adapter as unknown as DESComponent).getStatistics();
}

function tick(run: Run, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / TICK); i++) { run.runner.tick(TICK); run.runner.lateTick(TICK); }
}

describe('AGV statistics Slowed / Stopped (plan-558 §9.9)', () => {
  it('a follower behind a STOPPED leader books Stopped (free time); the shares sum to 100 %', () => {
    const run = start([
      ['Lead', { PathId: 'S', StartPosition: 8000 }],
      ['Follow', { PathId: 'S', StartPosition: 600 }],
      ['Clock', { PathId: 'Park', StartPosition: 4000 }],
    ]);
    // The DES clock only advances at events: a parked vehicle's service ending
    // at ~60 s moves it there, so the statistics window covers the standstill.
    getDefaultAgvFleet().get('Clock')!.assign({ destination: 'Park', serviceSec: 59 });
    // The leader stands (Run off), the follower has a task far ahead.
    const leadSelf = run.runner.liveInstances.find((i) => i.self.root.name === 'Lead')!.self as unknown as {
      sig: { Run: { set(v: boolean): void } };
    };
    leadSelf.sig.Run.set(false);
    getDefaultAgvFleet().get('Lead')!.clear();
    getDefaultAgvFleet().get('Follow')!.assign({ destination: 'S' });
    tick(run, 61);
    expect(run.runner.getManager().currentTime).toBeGreaterThan(58);
    const f = statsOf(run, 'Follow');
    const l = statsOf(run, 'Lead');
    expect(f.currentState).toBe('Stopped');
    expect(f.stoppedPercent ?? 0).toBeGreaterThan(70);
    expect(f.transportPercent ?? 0).toBeGreaterThan(0);
    expect(l.currentState).toBe('Empty'); // Run off → Empty
    const sum = Object.values(f.states).reduce((a, s) => a + s.percent, 0);
    expect(sum).toBeCloseTo(100, 6);
    // Stopped is free time: utilization = 100 − Empty − Stopped.
    expect(f.utilization).toBeCloseTo(100 - f.emptyPercent - (f.stoppedPercent ?? 0), 6);
    run.runner.dispose();
  });

  it('envelope slowing behind a slower leader is booked as Slowed at the analytic instant (± 1 ms)', () => {
    const run = start([
      ['Lead', { PathId: 'S', StartPosition: 8000, TargetSpeed: 500 }],
      ['Follow', { PathId: 'S', StartPosition: 600, TargetSpeed: 1000 }],
      ['Clock', { PathId: 'Park', StartPosition: 4000 }],
    ]);
    getDefaultAgvFleet().get('Clock')!.assign({ destination: 'Park', serviceSec: 29 }); // advances the DES clock
    getDefaultAgvFleet().get('Follow')!.assign({ destination: 'S' });
    getDefaultAgvFleet().get('Lead')!.assign({ destination: 'S' });
    tick(run, 1);
    // The follower's braking start onto the leader trajectory, from its plan.
    const plan = getDefaultMovementAuthority('des').planOf('Follow')!;
    const brake = plan.profile.phases.find((ph) => ph.a < -1e-9)!;
    expect(brake).toBeDefined();
    tick(run, 30);
    const slowed = run.log.get('Follow')!.find(([n]) => n === 'Slowed');
    expect(slowed).toBeDefined();
    expect(Math.abs(slowed![1] - brake.t0)).toBeLessThanOrEqual(1e-3);
    const f = statsOf(run, 'Follow');
    expect(f.slowedPercent ?? 0).toBeGreaterThan(0);
    // Driving with a task is utilization (Transport + Slowed), not free time.
    expect(f.utilization).toBeGreaterThan(90);
    run.runner.dispose();
  });

  it('priority: Run off → Empty; Failure; servicing → Working; idle without task → Empty', () => {
    const run = start([
      ['V', { PathId: 'Park', StartPosition: 0 }],
      ['Clock', { PathId: 'S', StartPosition: 70000 }],
    ]);
    const fleet = getDefaultAgvFleet();
    fleet.get('V')!.assign({ destination: 'Park', serviceSec: 5 });
    tick(run, 7);
    expect(statsOf(run, 'V').currentState).toBe('Working');
    const adapter = run.runner.liveInstances.find((i) => i.self.root.name === 'V')!.adapter as unknown as { setFailure(f: boolean): void };
    adapter.setFailure(true);
    tick(run, 2);
    expect(statsOf(run, 'V').currentState).toBe('Failure');
    adapter.setFailure(false);
    tick(run, 10);
    expect(statsOf(run, 'V').currentState).toBe('Empty'); // service done, no follow-up task
    const v = run.log.get('V')!.map(([n]) => n);
    expect(v).toContain('Transport');
    expect(v).toContain('Working');
    expect(v).not.toContain('Blocked'); // AGVs never book Blocked any more
    run.runner.dispose();
  });

  it('continuous StateStatistics: Stopped is free time, Slowed is utilization', () => {
    let t = 0;
    const st = new StateStatistics(() => t, { initialState: 'Transport' });
    t = 10; st.setState('Slowed');
    t = 20; st.setState('Stopped');
    t = 40; st.setState('Transport');
    t = 50;
    expect(st.getStatePercentage('Stopped')).toBeCloseTo(40, 9);
    expect(st.getUtilizationPercent()).toBeCloseTo(60, 9);
  });

  it('stations / older producers without the new fields stay unchanged and render at 0 %', () => {
    const comp = new DESComponent(new Object3D());
    const s = comp.getStatistics();
    expect(s.slowedPercent ?? 0).toBe(0);
    expect(s.stoppedPercent ?? 0).toBe(0);
    expect(comp.freeStates).toEqual(['Empty', 'Stopped']);
    // A Toray-like statistics object without the new keys draws without NaN segments.
    const fills: number[] = [];
    const ctx = {
      fillRect: (_x: number, _y: number, w: number) => { fills.push(w); },
      strokeRect: () => {}, set fillStyle(_v: string) {}, set strokeStyle(_v: string) {}, set lineWidth(_v: number) {},
    } as unknown as CanvasRenderingContext2D;
    drawStateStackBar(ctx, { workingPercent: 60, emptyPercent: 40 }, 0, 0, 100, 10);
    expect(fills.every((w) => Number.isFinite(w))).toBe(true);
    expect(fills.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6);
    expect(DES_STATE_STACK.map((e) => e.label)).toEqual(
      ['Working', 'Transport', 'Slowed', 'Setup', 'Blocked', 'Stopped', 'Empty', 'Failure']);
  });
});
