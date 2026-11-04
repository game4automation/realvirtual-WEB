import { travelerIdOf } from '../../src/behaviors/Agv';
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, expect, it } from 'vitest';
import { agvSelfForSnapshot } from '../../src/behaviors/Agv';
import { exportAgvState, prepareAgvState, swapAgvState, validateAgvState } from '../../src/behaviors/_shared/agv-snapshot';
import { decodeAuthorityData, encodeAuthorityData, record } from '../../src/core/engine/rv-movement-authority-snapshot';
import { movementSnapshotProvider } from '../../src/plugins/des/fleet/des-movement-participants';
import { clearShared } from '../helpers/agv-harness';
import { agvContinuationWorld } from '../helpers/agv-continuation-world';
import { assertContinuation, compareFullSnapshots } from '../helpers/des-continuation-harness';

afterEach(() => { clearShared(); });

it('roundtrips active and inactive AGVs in the same world without reading inactive traveler services', () => {
  const w = agvContinuationWorld({ inactiveTwin: true });
  try {
    w.step(2);
    const saved = JSON.parse(JSON.stringify(w.runner.fullSnapshot()));
    expect(w.agvState('A').active).toBe(true);
    expect(w.agvState('B').active).toBe(false);
    expect(w.authorityState().vehicles.map((v: { id: string }) => v.id)).toEqual(['A']);
    const instance = w.runner.liveInstances.find(i => i.self.root.name === 'B')!;
    const self = agvSelfForSnapshot(instance.self);
    const descriptor = Object.getOwnPropertyDescriptor(self.local, 'traveler')!;
    Object.defineProperty(self.local, 'traveler', { configurable: true,
      get() { throw new Error('inactive traveler must not be accessed'); } });
    try {
      const json = exportAgvState(self);
      expect(validateAgvState(json, travelerIdOf(self))).toEqual([]);
      const prepared = prepareAgvState(self, json);
      self.local.active = true;
      swapAgvState(self, prepared);
      expect(exportAgvState(self)).toEqual(json);
      w.runner.restoreFull(saved);
      compareFullSnapshots(saved, w.runner.fullSnapshot());
    } finally { Object.defineProperty(self.local, 'traveler', descriptor); }
  } finally { w.dispose(); }
});

it.each(['missing-active', 'inactive-vehicle', 'orphan'] as const)('rejects inconsistent saved partners: %s', kind => {
  const w = agvContinuationWorld({ inactiveTwin: true });
  try {
    const raw = JSON.parse(JSON.stringify(w.runner.fullSnapshot()));
    const part = raw.parts.find((p: { key: string }) => p.key === 'fleet.authority');
    const data = record(decodeAuthorityData(part.state));
    if (kind === 'missing-active') data.vehicles = [];
    else data.vehicles.push({ ...structuredClone(data.vehicles[0]), id: kind === 'orphan' ? 'Orphan' : 'B' });
    part.state = encodeAuthorityData(data);
    const agvs = w.runner.liveInstances.map(i => ({ desId: i.desId!,
      vehicleId: i.self.root.name, self: agvSelfForSnapshot(i.self) }));
    // Deliberately disagree with the saved flags: validation must use the DTO.
    agvs.forEach(a => { a.self.local.active = !a.self.local.active; });
    const participants = movementSnapshotProvider({ agvs: () => agvs })({ restoring: true, raw });
    const errors = participants.flatMap(p => p.validate(raw.parts.find((s: { key: string }) => s.key === p.key)!.state));
    expect(errors.join(';')).toContain(kind === 'missing-active' ? "vehicle 'A' requires exactly one"
      : kind === 'inactive-vehicle' ? "inactive vehicle 'B' requires no" : "vehicle 'Orphan' requires exactly one");
  } finally { w.dispose(); }
});

for (const mode of ['A', 'B'] as const) {
  it(`${mode}: an inactive second AGV survives restore and continuation`, async () => {
    await assertContinuation({ mode, T: 2, TPrime: 5, T2: 40,
      buildWorld: () => agvContinuationWorld({ inactiveTwin: true }) });
  });
}
