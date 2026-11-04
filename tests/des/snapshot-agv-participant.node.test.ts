import { travelerIdOf } from '../../src/behaviors/Agv';
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { afterEach, expect, it } from 'vitest';
import { Object3D } from 'three';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { agvSelfForSnapshot } from '../../src/behaviors/Agv';
import { exportAgvState, validateAgvState, prepareAgvState, swapAgvState } from '../../src/behaviors/_shared/agv-snapshot';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { decodeAuthorityData, encodeAuthorityData, record } from '../../src/core/engine/rv-movement-authority-snapshot';
import { movementSnapshotProvider } from '../../src/plugins/des/fleet/des-movement-participants';
import { SnapshotRegistry } from '../../src/plugins/des/rv-snapshot-registry';
import { createCaptureSession, toSnapshotData, type SnapshotJson } from '../../src/plugins/des/rv-snapshot-contract';
import type { DESSnapshotV4 } from '../../src/plugins/des/rv-des-snapshot-v4';
import { bindDes, clearShared, makeAgvRoot, makeHost, TICK } from '../helpers/agv-harness';

let runner: DESRunner | undefined;
afterEach(() => { runner?.dispose(); runner = undefined; clearShared(); });

function setup() {
  clearShared();
  const net = getDefaultPathNetwork();
  net.register(parsePathExtras({ type: 'Path', id: 'Stay', closed: false,
    segments: [{ kind: 'line', from: [0, 0, 0], to: [3, 0, 0] }] }, 'Stay')!);
  net.resolveGraph();
  runner = new DESRunner({ subMode: 'animated' });
  const signalHost = makeHost();
  const bound = (bindDes(runner, makeAgvRoot('SnapshotAgv', { PathId: 'Stay', StartPosition: 500,
    Destination: 'Stay', ServiceTime: 100, VehicleLength: 1000, VehicleWidth: 600,
    ScannerFields: false }), signalHost));
  runner.start([], { root: new Object3D() });
  const self = agvSelfForSnapshot(bound);
  for (let i = 0; i < 1800 && self.local.phase !== 'servicing'; i++) { runner.tick(TICK); runner.lateTick(TICK); }
  expect(self.local.phase).toBe('servicing');
  expect(self.local.desServiceEvent).toBeGreaterThanOrEqual(0);
  const world = { agvs: () => [{ desId: 'SnapshotAgv@Agv', vehicleId: 'SnapshotAgv', self }] };
  const provider = movementSnapshotProvider(world);
  const participants = provider({ restoring: false });
  const participant = participants.find(p => p.key === 'fleet.agv:SnapshotAgv@Agv')!;
  const eventQueue = runner.getManager().exportQueue(() => 'SnapshotAgv@Agv',
    data => toSnapshotData(data, { participant: 'test.queue' }));
  const raw: DESSnapshotV4 = { version: 4,
    fingerprint: { schemaVersion: 4, rngVersion: 2, modelHash: 'test', runConfigHash: 'run', components: [{ id: 'SnapshotAgv@Agv', type: 'Agv' }] },
    simTime: runner.getManager().currentTime, nextEventId: Math.max(...eventQueue.map(e => e.id)) + 1, muIds: [],
    parts: participants.map(p => ({ key: p.key, version: p.version, state: roundtrip(p.capture()) })), eventQueue };
  return { self, participant, participants, provider, raw, signalHost };
}
const roundtrip = (value: unknown): SnapshotJson => JSON.parse(JSON.stringify(value));

it('roundtrips a declarative task during its DES service stay without touching live services or signals', () => {
  const { self, participant, participants, provider, raw, signalHost } = setup();
  const local = self.local, traveler = local.traveler, host = local.mbHost, startTask = local.startTask;
  const registry = new SnapshotRegistry(); participants.forEach(p => registry.register(p));
  expect(registry.order().map(p => p.key).sort()).toEqual(['fleet.agv:SnapshotAgv@Agv', 'fleet.authority', 'fleet.zones']);
  const json = roundtrip(registry.captureAll(createCaptureSession()).find(p => p.key === 'fleet.agv:SnapshotAgv@Agv')!.state);
  expect(provider({ restoring: true, raw }).find(p => p.key === 'fleet.agv:SnapshotAgv@Agv')!.validate(json)).toEqual([]);
  expect(validateAgvState(json, travelerIdOf(self))).toEqual([]);
  const prepared = participant.prepare(json);
  const signals = new Map(signalHost.values), queue = runner!.getManager().snapshot().events;
  expect(exportAgvState(self)).toEqual(json);
  local.phase = 'idle'; local.task = null; local.desServiceEvent = -1;
  participant.commit(prepared);
  expect(exportAgvState(self)).toEqual(json);
  expect(self.local).toBe(local);
  expect(local.traveler).toBe(traveler); expect(local.mbHost).toBe(host); expect(local.startTask).toBe(startTask);
  expect(signalHost.values).toEqual(signals);
  expect(runner!.getManager().snapshot().events).toEqual(queue);
});

it.each(['task', 'startTask', 'pending'] as const)('refuses capture with callbacks in %s using the D1 error code', where => {
  const { self, participant } = setup();
  const task = { destination: 'Stay', onArrive: () => {} };
  if (where === 'pending') {
    const p = getDefaultPathNetwork().get('Stay')!;
    self.local.maneuver = { stub: p, turn: p, route: [p], mergeZone: 'unused', companions: [],
      stage: 'dock', epoch: 1, goAround: false, retryLogged: false, pending: { task } };
  } else self.local[where] = task;
  expect(() => participant.capture()).toThrowError(expect.objectContaining({ code: 'des-snapshot-agv-task-callbacks' }));
});

it('roundtrips frozen state and remaining service time', () => {
  const { self } = setup();
  self.local.frozen = true; self.local.frozenServiceSec = 27.125;
  const json = roundtrip(exportAgvState(self));
  const prepared = prepareAgvState(self, json, travelerIdOf(self));
  self.local.frozen = false; self.local.frozenServiceSec = -1;
  swapAgvState(self, prepared);
  expect(exportAgvState(self)).toEqual(json);
  expect(self.local.frozenServiceSec).toBe(27.125);
});

it.each(['authority', 'agv', 'extraVehicle'] as const)('rejects a missing Authority/Agv partner: %s', missing => {
  const { provider, raw } = setup();
  const json = raw.parts.find(p => p.key === 'fleet.agv:SnapshotAgv@Agv')!.state;
  if (missing === 'agv') raw.parts = raw.parts.filter(p => !p.key.startsWith('fleet.agv:'));
  else {
    const data = record(decodeAuthorityData(raw.parts.find(p => p.key === 'fleet.authority')!.state));
    if (missing === 'authority') data.vehicles = [];
    else data.vehicles.push({ ...structuredClone(data.vehicles[0]), id: 'UnpairedVehicle' });
    raw.parts.find(p => p.key === 'fleet.authority')!.state = encodeAuthorityData(data);
  }
  const errors = provider({ restoring: true, raw }).find(p => p.key === 'fleet.agv:SnapshotAgv@Agv')!.validate(json);
  expect(errors.join(';')).toMatch(/fleet\.authority/);
  expect(errors.join(';')).toContain('SnapshotAgv@Agv');
  expect(errors.join(';')).toContain(missing === 'extraVehicle' ? 'UnpairedVehicle' : 'SnapshotAgv');
});

it('rejects a ServiceEnd handle without a matching queue event', () => {
  const { provider, raw } = setup();
  raw.eventQueue = [];
  expect(provider({ restoring: true, raw }).find(p => p.key === 'fleet.agv:SnapshotAgv@Agv')!.validate(raw.parts.find(p => p.key === 'fleet.agv:SnapshotAgv@Agv')!.state).join(';')).toContain('desServiceEvent');
});

it('allows production fullSnapshot without a test seam', () => {
  setup();

  expect(() => runner!.fullSnapshot()).not.toThrow();
});

it('rejects hook captures and recursively non-JSON task data', () => {
  const { self } = setup();
  self.local.inHook = true;
  expect(() => exportAgvState(self)).toThrowError(expect.objectContaining({ code: 'des-snapshot-agv-busy' }));
  self.local.inHook = false;
  self.local.task!.data = { nested: [() => {}] };
  expect(() => exportAgvState(self)).toThrow(/forbidden function/);
});

it('captures codec-owned callbacks and attaches a fresh continuation during prepare', () => {
  const { self } = setup();
  let completed = 0;
  const off = getDefaultAgvFleet().registerTaskCodec({
    owns: t => (t.data as { codec?: string } | undefined)?.codec === 'test',
    attach: t => { t.onServiceEnd = () => { completed++; }; },
  });
  try {
    self.local.task = { destination: 'Stay', data: { codec: 'test' }, onServiceEnd: () => {} };
    const json = roundtrip(exportAgvState(self));
    const prepared = prepareAgvState(self, json, travelerIdOf(self));
    expect(completed).toBe(0);
    swapAgvState(self, prepared);
    const task = self.local.task!;
    task.onServiceEnd!('SnapshotAgv', task);
    expect(completed).toBe(1);
  } finally { off(); }
});
