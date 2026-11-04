// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, expect, it } from 'vitest';
import { Object3D } from 'three';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultMovementAuthority } from '../../src/core/engine/rv-movement-authority';
import {
  vehicleStateKeys, vehicleServices, vehicleScratch,
  mbPlanStateKeys, mbPlanServices, mbPlanScratch,
  authorityStateKeys, authorityServices, authorityScratch, authorityEventHandleFields,
} from '../../src/core/engine/rv-movement-authority-state';
import {
  agvStateKeys, agvServices, agvScratch, agvTaskStateKeys, agvTaskServices,
  agvTaskScratch, agvEventHandleFields,
} from '../../src/behaviors/_shared/agv-state';
import { bindDes, clearShared, makeAgvRoot, makeHost, TICK } from '../helpers/agv-harness';

type Groups = readonly (readonly string[])[];
const groups = {
  Vehicle: [vehicleStateKeys, vehicleServices, vehicleScratch],
  MbPlan: [mbPlanStateKeys, mbPlanServices, mbPlanScratch],
  Authority: [authorityStateKeys, authorityServices, authorityScratch],
  AgvLocal: [agvStateKeys, agvServices, agvScratch],
  AgvTask: [agvTaskStateKeys, agvTaskServices, agvTaskScratch],
} satisfies Record<string, Groups>;

// Compare both directions and retain symbols: Object.keys would miss hidden state.
function check(keys: (string | symbol)[], declared: Groups): void {
  const all = declared.flat();
  expect(keys.filter(key => typeof key !== 'string' || !all.includes(key))).toEqual([]);
  expect(all.filter(key => !keys.includes(key))).toEqual([]);
}

it.each(Object.entries(groups))('%s: literal classes are disjoint, including within lists', (_name, declared) => {
  const all = declared.flat();
  expect(all.length).toBe(new Set(all).size);
});

it('handle specifications refer to classified state fields', () => {
  for (const key of Object.keys(authorityEventHandleFields)) expect(vehicleStateKeys).toContain(key);
  for (const key of Object.keys(agvEventHandleFields)) expect(agvStateKeys).toContain(key);
});

let runner: DESRunner | undefined;
afterEach(() => { runner?.dispose(); runner = undefined; clearShared(); });

it('real planned Vehicle, MbPlan, Authority and bound AgvLocal have exactly the declared own keys', () => {
  clearShared();
  const network = getDefaultPathNetwork();
  network.register(parsePathExtras({
    type: 'Path', version: 1, id: 'GuardPath', closed: false, align: [0, 1, 0],
    segments: [{ kind: 'line', from: [0, 0, 0], to: [100, 0, 0] }],
  }, 'GuardPath')!);
  network.resolveGraph();
  runner = new DESRunner({ subMode: 'animated' });
  const self = bindDes(runner, makeAgvRoot('GuardVehicle', {
    PathId: 'GuardPath', StartPosition: 1000, VehicleLength: 1000, VehicleWidth: 600,
    ScannerFields: false,
  }), makeHost());
  runner.start([], { root: new Object3D() });
  runner.tick(TICK);
  runner.lateTick(TICK);
  const authority = getDefaultMovementAuthority('des');
  // Registration installs only a stationary placeholder. Require an applied plan
  // so optional own fields such as MbPlan.stopLeaderId are exercised as well.
  expect(authority.versionOf('GuardVehicle')).toBeGreaterThan(0);
  const plan = authority.planOf('GuardVehicle');
  expect(plan).not.toBeNull();
  check(authority.__vehicleKeysForTest('GuardVehicle'), groups.Vehicle);
  check(Reflect.ownKeys(plan!), groups.MbPlan);
  check(Reflect.ownKeys(authority), groups.Authority);
  check(Reflect.ownKeys(self.local), groups.AgvLocal);
});
