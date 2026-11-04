// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgvFleet, getDefaultAgvFleet, type AgvHandle } from '../../src/core/engine/rv-agv-fleet';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { readFleetStatus } from '../../src/core/fleet/fleet-status';
import { filterFleetStatus } from '../../src/core/diagnostics/diagnose-commands';
import { ensureDiagnoseCommandsRegistered } from '../../src/core/diagnostics/diagnose-command-descriptors';
import { CommandRegistry, type CommandContext } from '../../src/core/hmi/rv-command-registry';
import { FleetStatusOutput } from '../../src/core/fleet/exec/status-output';

const handle = (id: string, phase: AgvHandle['phase'] = 'idle'): AgvHandle => ({
  id, phase, task: null, assign() {}, clear() {},
});
afterEach(() => getDefaultAgvFleet().resetHandles());

describe('fleet status', () => {
  it.each([[1, 'fork-wait-timeout'], [2, 'exit-timeout'], [99, 'fault']] as const)('reads fault code %s and SOC', (code, reason) => {
    const fleet = new AgvFleet(), signals = new SignalStore();
    fleet.register(handle('Stapler_2'));
    signals.set('Stapler_2.Status.Fault', true);
    signals.set('Stapler_2.Status.FaultCode', code);
    const vehicles = readFleetStatus(fleet, signals);
    expect(vehicles[0]).toMatchObject({ state: 'fault', faultReason: reason, battery: null, fromSignals: true });
    expect(filterFleetStatus(vehicles, {}).counts.fault).toBe(1);
    signals.set('Stapler_2.Status.Soc', 42);
    expect(readFleetStatus(fleet, signals)[0].battery).toEqual({ soc: 42 });
  });

  it('uses only handles, sorts ids and resets the blocked scratch between vehicles', () => {
    const fleet = new AgvFleet(), signals = new SignalStore();
    fleet.register(handle('B', 'servicing'));
    fleet.register({ ...handle('A', 'driving'), task: { destination: 'Dock' }, startPathId: 'Lane',
      signalStatus(out) { out.blocked = true; } });
    signals.set('X.Status.Fault', true);
    expect(readFleetStatus(fleet, signals)).toMatchObject([
      { id: 'A', state: 'order', moving: true, waitingOn: 'blocked', job: 'Dock', position: { node: null, leg: 'Lane' }, fromSignals: false, battery: null },
      { id: 'B', state: 'handling', moving: false, waitingOn: null, faultReason: null, fromSignals: false },
    ]);
  });

  it('uses signal precedence, including false Fault and zero SOC', () => {
    const fleet = new AgvFleet(), signals = new SignalStore();
    fleet.register(handle('A', 'driving'));
    for (const name of ['Fault', 'Charging', 'Handling', 'Busy', 'Free']) signals.set(`A.Status.${name}`, true);
    const flags = ['Fault', 'Charging', 'Handling', 'Busy', 'Free'];
    for (const [i, state] of ['fault', 'charging', 'handling', 'order', 'free', 'idle'].entries()) {
      expect(readFleetStatus(fleet, signals)[0].state).toBe(state);
      if (i < flags.length) signals.set(`A.Status.${flags[i]}`, false);
    }
    signals.set('A.Status.Soc', 0);
    expect(readFleetStatus(fleet, signals)[0]).toMatchObject({ fromSignals: true, battery: { soc: 0 }, moving: false });
  });

  it.each([1, 2])('matches FleetStatusOutput for fault code %s and deduplicates numeric writes', code => {
    const fleet = new AgvFleet(), signals = new SignalStore();
    fleet.register(handle('Stapler_2'));
    const lamps = new FleetStatusOutput(signals);
    const status = { free: false, orderActive: true, busy: true, handling: false, charging: false, fault: true, moving: false, faultCode: code, soc: 55.55 };
    lamps.apply('Stapler_2', status, 0);
    expect(readFleetStatus(fleet, signals)[0]).toMatchObject({ state: 'fault',
      faultReason: code === 1 ? 'fork-wait-timeout' : 'exit-timeout', battery: { soc: 55.6 } });
    const set = vi.spyOn(signals, 'set');
    lamps.apply('Stapler_2', status, 1);
    expect(set).not.toHaveBeenCalled();
    lamps.apply('Other', { ...status, faultCode: undefined, soc: Infinity }, 0);
    expect(signals.get('Other.Status.FaultCode')).toBe(0);
    expect(signals.get('Other.Status.Soc')).toBeUndefined();
  });

  it('filters through the registry with counts before filtering, null args, and state validation', async () => {
    const fleet = getDefaultAgvFleet(), signals = new SignalStore();
    fleet.resetHandles();
    fleet.register(handle('Stapler_2'));
    fleet.register(handle('Other'));
    signals.set('Stapler_2.Status.Fault', true);
    const registry = new CommandRegistry();
    ensureDiagnoseCommandsRegistered(registry);
    const ctx = { origin: 'mcp' as const, viewer: { signalStore: signals } as CommandContext['viewer'] };
    expect(await registry.execute('fleet.status', { vehicle: 'STAP', state: 'FAULT' }, ctx)).toMatchObject({
      ok: true, value: { vehicles: [{ id: 'Stapler_2' }], counts: { fault: 1, idle: 1 } },
    });
    expect(await registry.execute('fleet.status', { vehicle: null, state: null }, ctx)).toMatchObject({
      ok: true, value: { vehicles: [{ id: 'Other' }, { id: 'Stapler_2' }] },
    });
    expect(await registry.execute('fleet.status', { state: 'unknown' }, ctx)).toMatchObject({
      ok: false, kind: 'threw', reason: expect.stringContaining('free|order|handling|charging|fault|idle'),
    });
  });

  it('has no fleet provider registry in src', () => {
    const forbidden = /FleetStatusProvider|registerFleetStatusProvider/;
    const scan = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = resolve(dir, entry.name);
        if (entry.isDirectory()) scan(path);
        else if (/\.(?:ts|tsx|js|jsx)$/.test(entry.name)) expect(readFileSync(path, 'utf8'), path).not.toMatch(forbidden);
      }
    };
    scan(fileURLToPath(new URL('../../src', import.meta.url)));
  });
});
