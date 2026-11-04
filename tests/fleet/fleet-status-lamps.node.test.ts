// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import { Object3D } from 'three';
import { AgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { OrderPool } from '../../src/core/fleet/core/orders';
import { ContinuousSimClock } from '../../src/core/fleet/core/sim-clock';
import { readFleetStatus, FAULT_CODE_REASONS } from '../../src/core/fleet/fleet-status';
import { deriveVehicleStatus, type VehicleStatusInput } from '../../src/core/fleet/exec/vehicle-status';
import { DEFAULT_LAMP_MAP, lampStatesOf, resolveLampMap, type LampLike } from '../../src/core/fleet/exec/lamp-map';
import { FleetStatusOutput } from '../../src/core/fleet/exec/status-output';
import { WaitWatch } from '../../src/core/fleet/exec/wait-watch';

const status = (input: Partial<VehicleStatusInput> = {}) => deriveVehicleStatus({ leg: 'idle', ...input });
const on = { on: true, flashing: false }, off = { on: false, flashing: false }, blink = { on: true, flashing: true };

describe('fleet status and lamps (plan-559 9.9)', () => {
  it.each([
    [{}, 'free', on, off, off],
    [{ jobKind: 'pick' }, 'order', blink, off, off],
    [{ jobKind: 'retrieve', leg: 'atTo' }, 'handling', off, on, off],
    [{ jobKind: 'charge', leg: 'charging' }, 'charging', off, blink, off],
    [{ jobKind: 'charge', leg: 'charging', reportedKind: 'fork' }, 'fault', off, off, on],
  ] as const)('derives rank and the default lamp table for %j', (input, state, green, amber, red) => {
    const s = status(input), signals = new Map<string, boolean | number>();
    const fleet = new AgvFleet();
    fleet.register({ id: 'V', phase: 'idle', task: null, assign() {}, clear() {} });
    new FleetStatusOutput(signals).apply('V', s, 0);
    expect(readFleetStatus(fleet, signals)[0].state).toBe(state);
    expect(s.free).toBe(!s.busy && !s.fault);
    expect(s.orderActive).toBe(s.busy);
    expect(lampStatesOf(s)).toEqual({ StackGreen: green, StackAmber: amber, StackRed: red,
      Beacon: off, EyeL: s.fault ? off : on, EyeR: s.fault ? off : on });
  });

  it.each([['fork', 1], ['exit', 2], ['target', 3], ['charge', 4], ['standstill', 5]] as const)(
    '%s fault lasts exactly while its wait is reported', (kind, code) => {
      const clock = new ContinuousSimClock();
      const waits = new WaitWatch({ clock, defaultLimitSec: 2, problems: { report() {}, clear() {} } });
      const read = () => status({ overLimit: waits.isOverLimit('V'),
        reportedKind: waits.firstReportedKind('V') });
      waits.begin('V', kind);
      expect(read().fault).toBe(false);
      clock.advanceTo(2);
      expect(read()).toMatchObject({ fault: true, free: false, faultCode: code });
      expect(FAULT_CODE_REASONS[code]).toContain('timeout');
      waits.end('V', kind);
      expect(read()).toMatchObject({ fault: false, free: true, faultCode: 0 });
    });

  it('keeps fork/exit priority, unknown wait faults, motion threshold and phase fallback', () => {
    expect(status({ reportedKind: 'fork' }).faultCode).toBe(1);
    expect(status({ reportedKind: 'exit' }).faultCode).toBe(2);
    expect(status({ overLimit: true })).toMatchObject({ fault: true, free: false });
    expect(status({ phase: 'driving' }).moving).toBe(true);
    expect(status({ phase: 'driving', speed: 0.001 }).moving).toBe(false);
    expect(status({ speed: 0.002 }).moving).toBe(true);
    expect(lampStatesOf(status({ reportedKind: 'fork', speed: 1 })).Beacon).toEqual(blink);
    expect(lampStatesOf({ ...status({ leg: 'charging' }), handling: true }).StackAmber).toEqual(blink);
  });

  it('overrides only the given color', () => {
    const map = resolveLampMap({ green: () => 'off' });
    expect(map.yellow).toBe(DEFAULT_LAMP_MAP.yellow);
    expect(map.red).toBe(DEFAULT_LAMP_MAP.red);
    expect(map.beacon).toBe(DEFAULT_LAMP_MAP.beacon);
    expect(map.eyes).toBe(DEFAULT_LAMP_MAP.eyes);
    expect(lampStatesOf(status(), map)).toEqual({ ...lampStatesOf(status()), StackGreen: off });
  });

  it('finds default/configured names, all eyes and duplicate suffixes; blinks only in sim time', () => {
    const root = new Object3D();
    const add = (name: string) => {
      const node = new Object3D(); node.name = name;
      const lamp: LampLike = { Period: 2, LampOn: false, Flashing: true, setDisplayedLit: vi.fn(() => true) };
      node.userData._rvLamp = lamp; root.add(node); return lamp;
    };
    const green = add('CustomGreen_2'), ignored = add('Lamp_StackGreen');
    const yellow = add('Lamp_Yellow'), red = add('Lamp_StackRed_3'), beacon = add('Lamp_Beacon');
    const eyes = [add('Lamp_EyeL'), add('Lamp_EyeR_2'), add('Lamp_EyeExtra')];
    const output = new FleetStatusOutput(null, { lampNames: { green: 'CustomGreen' } });
    expect(output.scan([{ id: 'V', root }, { id: 'missing', root: null }])).toBe(7);
    expect(output.lampCount('V')).toBe(7);
    expect(ignored.Flashing).toBe(true);
    for (const lamp of [green, yellow, red, beacon, ...eyes]) expect(lamp.Flashing).toBe(false);
    output.apply('V', status({ jobKind: 'pick', speed: 1 }), 0.5);
    expect(green.LampOn).toBe(true);
    expect(green.setDisplayedLit).toHaveBeenLastCalledWith(true);
    output.apply('V', status({ jobKind: 'pick', speed: 1 }), 1.5);
    expect(green.setDisplayedLit).toHaveBeenLastCalledWith(false);
    output.apply('V', status({ reportedKind: 'fork', speed: 1 }), 0);
    for (const eye of eyes) expect(eye.setDisplayedLit).toHaveBeenLastCalledWith(false);
    expect(beacon.setDisplayedLit).toHaveBeenLastCalledWith(true);
    const customEye = add('Worklight');
    const configured = new FleetStatusOutput(null, { lampNames: { eye: 'Worklight' } });
    expect(configured.scan([{ id: 'V', root }])).toBe(5);
    configured.apply('V', status(), 0);
    expect(customEye.LampOn).toBe(true);
  });

  it('writes the unchanged signal names, rounded SOC and integer code only on changes', () => {
    const set = vi.fn(), output = new FleetStatusOutput({ set });
    const s = status({ soc: 55.55 });
    output.apply('V', s, 0);
    expect(Object.fromEntries(set.mock.calls)).toEqual({
      'V.Status.Free': true, 'V.Status.Busy': false, 'V.Status.Handling': false,
      'V.Status.Charging': false, 'V.Status.Fault': false, 'V.Status.Moving': false,
      'V.Status.FaultCode': 0, 'V.Status.Soc': 55.6,
    });
    set.mockClear(); output.apply('V', { ...s, soc: 55.56 }, 5);
    expect(set).not.toHaveBeenCalled();
    output.apply('V', { ...s, faultCode: 2.9, soc: Infinity }, 5);
    expect(set.mock.calls).toEqual([['V.Status.FaultCode', 2]]);
    output.scan([]); set.mockClear(); output.apply('V', s, 0);
    expect(set).toHaveBeenCalledTimes(8);
  });

  it('counts pending/completed orders, deduplicates fleet signals and resets counts', () => {
    const orders = new OrderPool(), set = vi.fn(), output = new FleetStatusOutput({ set });
    const first = orders.add({ source: 'A' }, 0), future = orders.add({ source: 'B', earliest: 100 }, 0);
    expect(orders.pendingCount).toBe(2);
    orders.assign(first, 'V', 0);
    expect(orders.pendingCount).toBe(1);
    orders.complete(first, 1); orders.complete(first, 1);
    expect(orders.doneCount).toBe(1);
    output.fleetCounts(undefined, orders.pendingCount, orders.doneCount);
    output.fleetCounts(undefined, orders.pendingCount, orders.doneCount);
    expect(set.mock.calls).toEqual([['Fleet.OrdersPending', 1], ['Fleet.OrdersDone', 1]]);
    orders.cancel(future);
    const failed = orders.add({ source: 'C' }, 1); orders.fail(failed, 2);
    expect(orders.doneCount).toBe(1);
    orders.reset(); set.mockClear();
    output.fleetCounts('Yard', orders.pendingCount, orders.doneCount);
    expect(set.mock.calls).toEqual([['Yard.OrdersPending', 0], ['Yard.OrdersDone', 0]]);
  });
});
