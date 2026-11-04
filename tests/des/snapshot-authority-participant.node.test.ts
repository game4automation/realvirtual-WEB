// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, expect, it } from 'vitest';
import { Object3D } from 'three';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { getDefaultMovementAuthority, MovementAuthority, type MbHost, type MbParams } from '../../src/core/engine/rv-movement-authority';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { PathTraveler } from '../../src/core/engine/rv-path-traveler';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { positionAt } from '../../src/core/engine/rv-motion-profile';
import { encodeAuthorityData, decodeAuthorityData, encodeLimitPieces, decodeLimitPieces, record } from '../../src/core/engine/rv-movement-authority-snapshot';
import { movementSnapshotProvider } from '../../src/plugins/des/fleet/des-movement-participants';
import { SnapshotRegistry } from '../../src/plugins/des/rv-snapshot-registry';
import { createCaptureSession, type SnapshotJson } from '../../src/plugins/des/rv-snapshot-contract';
import type { DESSnapshotV4 } from '../../src/plugins/des/rv-des-snapshot-v4';
import { agvSelfForSnapshot } from '../../src/behaviors/Agv';
import { bindDes, clearShared, makeAgvRoot, makeHost, TICK } from '../helpers/agv-harness';

let runner: DESRunner | undefined;
afterEach(() => { runner?.dispose(); runner = undefined; clearShared(); });

function setup() {
  clearShared();
  const network = getDefaultPathNetwork();
  const path = parsePathExtras({ type: 'Path', version: 1, id: 'SnapshotPath', closed: false,
    align: [0, 1, 0], segments: [{ kind: 'line', from: [0, 0, 0], to: [100, 0, 0] }] }, 'SnapshotPath')!;
  network.register(path); network.resolveGraph();
  runner = new DESRunner({ subMode: 'animated' });
  const self = bindDes(runner, makeAgvRoot('SnapshotVehicle', { PathId: path.id, StartPosition: 1000,
    VehicleLength: 1000, VehicleWidth: 600, ScannerFields: false }), makeHost());
  runner.start([], { root: new Object3D() }); runner.tick(TICK); runner.lateTick(TICK);
  const authority = getDefaultMovementAuthority('des');
  const world = { agvs: () => [{ desId: 'SnapshotVehicle@Agv', vehicleId: 'SnapshotVehicle', self: agvSelfForSnapshot(self) }] };
  const participant = movementSnapshotProvider(world)({ restoring: false }).find(p => p.key === 'fleet.authority')!;
  return { authority, participant, path, world };
}

it('roundtrips detached authority data, retaining the original plan and services', () => {
  const { authority, participant } = setup();
  expect(authority.versionOf('SnapshotVehicle')).toBeGreaterThan(0);
  const original = authority.planOf('SnapshotVehicle')!;
  expect(original.profile.phases.length).toBeGreaterThan(0);
  const profileBefore = structuredClone(original.profile);
  const before = authority.exportState();
  const json = JSON.parse(JSON.stringify(participant.capture())) as SnapshotJson;
  expect(participant.validate(json)).toEqual([]);
  const prepared = participant.prepare(json);
  expect(authority.exportState()).toEqual(before);
  expect(decodeAuthorityData(authority.exportState())).toEqual(decodeAuthorityData(before));
  participant.commit(prepared);
  expect(authority.exportState()).toEqual(before);
  expect(authority.planOf('SnapshotVehicle')).not.toBe(original);
  expect(original.profile).toEqual(profileBefore);
  expect(positionAt(original.profile, original.profile.tEnd)).toBe(original.profile.xStop);
  const decoded = record(decodeAuthorityData(json));
  expect(decoded.vehicles[0].fieldCap).toBe(Infinity);
  expect(Number.isNaN(decoded.flushEventTime)).toBe(true);
  const registry = new SnapshotRegistry(); registry.register(participant);
  expect(registry.captureAll(createCaptureSession())[0].state).toEqual(before);
});

it('uses the shared number tags for all exceptional limit values', () => {
  const limits = [{ x0: 0, x1: Infinity, c0: NaN, c1: -Infinity }];
  const wire = JSON.parse(JSON.stringify(encodeLimitPieces(limits)));
  expect(decodeLimitPieces(wire)).toEqual(limits);
  expect(JSON.stringify(wire)).not.toContain('null');
});

it.each(['profile', 'path', 'vehicle', 'handle'] as const)('rejects corrupt %s without changing state', kind => {
  const { authority, participant, world } = setup();
  const before = authority.exportState();
  const d = record(decodeAuthorityData(before));
  const v = d.vehicles[0];
  if (kind === 'profile') v.plan.profile.phases = [{ t0: 0 }];
  if (kind === 'path') v.plan.route[0].pathId = 'unknown-path';
  if (kind === 'vehicle') v.id = 'unknown-vehicle';
  if (kind === 'handle') v.extendEvent = 123456789;
  const json = encodeAuthorityData(d);
  const validating = kind === 'handle'
    ? movementSnapshotProvider(world)({ restoring: true, raw: { parts: [], eventQueue: [] } as unknown as DESSnapshotV4 }).find(p => p.key === 'fleet.authority')!
    : participant;
  expect(validating.validate(json).length).toBeGreaterThan(0);
  expect(authority.exportState()).toEqual(before);
});

it('refuses capture during a flush with an explicit code', () => {
  const { path } = setup();
  const authority = new MovementAuthority('des');
  let captured = false;
  const host: MbHost = { now: () => 0, nextEventTime: () => Infinity, schedule: () => 1,
    cancel: () => {}, legTween: () => null, canMove: () => true, serviceStopAt: () => false,
    onPlanApplied: () => {
      captured = true;
      expect(() => authority.exportState()).toThrowError(expect.objectContaining({ code: 'des-snapshot-authority-busy' }));
    } };
  const params: MbParams = { vmax: 2, a: 1, b: 1, aLat: 1, front: 0.5, rear: 0.5,
    width: 0.6, gap: 0.1, dockSpeed: 0.2, dockDist: 1, scanner: null };
  authority.register('flush-vehicle', new PathTraveler('flush-vehicle', path), host, params);
  authority.flush(0);
  expect(captured).toBe(true);
});
