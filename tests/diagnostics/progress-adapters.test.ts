// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { expect, it, vi } from 'vitest';
import { Object3D } from 'three';
import { getDefaultAgvFleet, type AgvHandle } from '../../src/core/engine/rv-agv-fleet';
import { RVTransportManager } from '../../src/core/engine/rv-transport-manager';
import { ProgressWiring } from '../../src/core/diagnostics/rv-progress-wiring';
import { clearShared } from '../helpers/agv-harness';
import { stubLayout, makeStubWorld, carCfg, CAR } from '../helpers/agv-stub-world';

it('observes a real AGV assigned directly without a FleetJobRunner', () => {
  clearShared();
  stubLayout();
  const world = makeStubWorld('continuous', [{ name: 'A', cfg: carCfg('L0', 0), body: CAR }], 120);
  const fleet = getDefaultAgvFleet();
  const wiring = new ProgressWiring({ fleet, transport: new RVTransportManager(),
    clock: { now: () => world.now() }, running: () => true });
  try {
    expect(wiring.ledger.entry('A')?.state).toBe('inactive');
    const vehicle = fleet.get('A')!;
    vehicle.assign({ destination: 'R1' });
    wiring.sample();
    expect(wiring.ledger.entry('A')?.state).toBe('armed');
    for (let i = 0; i < 120; i++) { world.step(); wiring.fixedStep(); }
    expect(wiring.ledger.entry('A')?.count).toBeGreaterThan(0);
    expect(wiring.sample(5).coverage.missing).toEqual([]);
    // clear() cancels the task (back to cruising): not a completion, so no progress is expected.
    vehicle.clear();
    wiring.sample();
    expect(wiring.ledger.entry('A')?.state).toBe('inactive');
  } finally { wiring.dispose(); world.dispose(); clearShared(); }
});

it('does not arm a parked vehicle whose completed task stays set', () => {
  const vehicle = {
    id: 'A', node: new Object3D(), task: { destination: 'target' },
    phase: 'idle' as AgvHandle['phase'], assign() {}, clear() {},
  };
  const wiring = new ProgressWiring({ fleet: { all: () => [vehicle] }, transport: new RVTransportManager(),
    clock: { now: () => 0 }, running: () => true });
  try {
    expect(wiring.ledger.entry('A')?.state).toBe('inactive');
    vehicle.phase = 'driving';
    wiring.sample();
    expect(wiring.ledger.entry('A')?.state).toBe('armed');
    vehicle.phase = 'idle';
    wiring.sample();
    expect(vehicle.task).not.toBeNull();
    expect(wiring.ledger.entry('A')?.state).toBe('complete');
    wiring.sample();
    expect(wiring.ledger.entry('A')?.state).toBe('inactive');
  } finally { wiring.dispose(); }
});

it('keeps missing vehicles visible when their adapter is off', () => {
  const handles = ['B', 'A'].map(id => ({ id } as AgvHandle));
  const wiring = new ProgressWiring({ fleet: { all: () => handles }, transport: new RVTransportManager(),
    clock: { now: () => 0 }, running: () => true, adapters: { vehicle: false } });
  try { expect(wiring.sample().coverage).toMatchObject({ missing: ['A', 'B'], coverageComplete: false }); }
  finally { wiring.dispose(); }
});

it('does no model reads between samples and reads 1000 vehicle poses once per sample', () => {
  const handles: AgvHandle[] = Array.from({ length: 1000 }, (_, i) => ({
    id: `A${i}`, node: new Object3D(), task: { destination: 'target' }, phase: 'idle',
    assign() {}, clear() {},
  }));
  const reads = handles.map(h => vi.spyOn(h.node!, 'getWorldPosition'));
  const all = vi.fn(() => handles);
  const wiring = new ProgressWiring({ fleet: { all }, transport: new RVTransportManager(),
    clock: { now: () => 0 }, running: () => true });
  try {
    all.mockClear(); for (const read of reads) read.mockClear();
    for (let i = 0; i < 59; i++) wiring.fixedStep();
    expect(all).not.toHaveBeenCalled();
    expect(reads.every(read => read.mock.calls.length === 0)).toBe(true);
    wiring.fixedStep();
    expect(all).toHaveBeenCalledTimes(2); // Independent population + adapter.
    expect(reads.every(read => read.mock.calls.length === 1)).toBe(true);
  } finally { wiring.dispose(); }
});
