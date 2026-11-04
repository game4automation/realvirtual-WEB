// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { ContinuousSimClock } from '../../src/core/fleet/core/sim-clock';
import { DesLift } from '../../src/plugins/des/fleet/des-lift';
import { Object3D } from 'three';
import { DesHandoverBackend, PluginOwnerRegistry, CarrierOwner } from '../../src/plugins/des/fleet/des-handover';
import { robotDemoWorld } from '../des/continuation-world-fixture';
import type { DESRunner } from '../../src/plugins/des/des-runner';
import type { DESMU } from '../../src/plugins/des/rv-des-mu';
import { validatePickState } from '../../src/core/fleet/exec/backend-state';

const done = { e: 1, hj: 0, cont: { k: 'none' as const } };
describe('fleet lift and handover state', () => {
  it('prepares detached state, swaps silently and ends once at the original time', () => {
    const clock = new ContinuousSimClock(0);
    const drive = { currentPosition: 0, positionOverwrite: false, applyToNode(): void {} };
    const lift = new DesLift(() => null, clock, new Map([['V', drive]]));
    const calls: number[] = [];
    lift.setDoneHandler(() => calls.push(clock.now()));
    lift.move('V', 100, 50, done);
    const saved = lift.exportState(), prepared = lift.prepareState(saved);
    expect(saved.strokes[0][1]).toEqual({ handle: saved.strokes[0][1].handle,
      toMm: 100, done, from: 0, startAt: 0, dt: 2 });
    expect(lift.validateState(saved)).toEqual([]);
    expect(lift.validateState({ ...saved, positions: [['unknown', 0]] })).toContain('fleet.lift: invalid positions');
    expect(lift.validateState({ ...saved, strokes: [['V', { ...saved.strokes[0][1], tween: 0 }]] }).length).toBeGreaterThan(0);
    expect(lift.validateState({ ...saved, strokes: [['V', { ...saved.strokes[0][1], dt: -1 }]] }).length).toBeGreaterThan(0);
    saved.strokes[0][1].toMm = 999;
    lift.swapState(prepared);
    expect(lift.exportState().strokes[0][1].toMm).toBe(100);
    expect(calls).toEqual([]);
    clock.advanceTo(3);
    expect(calls).toEqual([2]);
    expect(drive.currentPosition).toBe(100);
    clock.advanceTo(4);
    expect(calls).toEqual([2]);
  });
  it('a pre-capture handle still cancels a restored stroke', () => {
    const clock = new ContinuousSimClock(0), lift = new DesLift(() => null, clock, new Map());
    let calls = 0;
    lift.setDoneHandler(() => calls++);
    lift.move('V', 0, 50, done);
    const saved = lift.exportState(), handle = saved.strokes[0][1].handle;
    lift.swapState(lift.prepareState(saved));
    clock.cancel(handle);
    clock.advanceTo(1);
    expect(calls).toBe(0);
  });
  it('round trips a pick waiter silently and resolves through the registered handler', () => {
    const runner = robotDemoWorld().runner as DESRunner;
    const root = new Object3D(), anchor = new Object3D(); root.add(anchor);
    const conveyor = runner.liveInstances[0].adapter;
    const owners = new PluginOwnerRegistry();
    const backend = new DesHandoverBackend(runner, root,
      new Map([['S', { conveyor, source: conveyor }]]), new Map(),
      new Map([['V', { root, anchor, lift: null }]]), new Map([['P', new Object3D()]]), owners);
    const calls: unknown[] = [];
    backend.setPickHandler((...args) => calls.push(args));
    backend.awaitPick('S', 'V', { v: 'V', h: 530, hj: 2 });
    const saved = backend.exportState(), prepared = backend.prepareState(saved);
    expect(saved.outputs).toEqual([['S', { waiting: [], dockedVehicle: 'V' }]]);
    for (const waiting of [[-1], [1.5], [1, 1]]) {
      expect(backend.validateState({ ...saved, outputs: [['S', { waiting, dockedVehicle: null }]] }).length).toBeGreaterThan(0);
    }
    expect(backend.validateState({ ...saved, outputs: [['unknown', { waiting: [], dockedVehicle: 'V' }]] }).length).toBeGreaterThan(0);
    expect(backend.validateState({ ...saved, outputs: [['S', { waiting: [], dockedVehicle: 'unknown' }]] }).length).toBeGreaterThan(0);
    saved.pickWaiters[0][1].h = 999;
    backend.carrierOf('V')!.restoreMURefs([{ id: 17 } as DESMU]);
    expect(() => backend.exportState()).not.toThrow();
    backend.slotOwner('P')!.restoreMURefs([{ id: 18 } as DESMU]);
    expect(() => backend.exportState()).not.toThrow();
    backend.cancelPick('S', 'V');
    backend.swapState(prepared);
    expect(conveyor.nextComponents).toEqual([backend.carrierOf('V')]);
    // The handover participant owns wiring; generic components own the loads.
    expect(backend.carried('V')).toBe('17');
    expect(backend.onSlot('P')).toBe('18');
    expect(calls).toEqual([]);
    expect(backend.exportState().pickWaiters[0][1].h).toBe(530);
    const carrier = backend.ownersInUse.find(o => o instanceof CarrierOwner)!;
    carrier.onMUEnter?.({ id: 17 } as DESMU);
    expect(calls).toEqual([['S', { v: 'V', h: 530, hj: 2 }, '17']]);
    expect(backend.exportState()).toEqual({ pickWaiters: [], outputs: [['S', { waiting: [], dockedVehicle: null }]], templateSizes: [] });
    backend.dispose(); runner.dispose();
  });
  it('validates pick data and refuses closures or malformed entries', () => {
    expect(validatePickState({ pickWaiters: [['S', { v: 'V', h: 100, hj: 0 }]] })).toEqual([]);
    expect(validatePickState({ pickWaiters: [['S', () => {}]] }).length).toBeGreaterThan(0);
  });
});
