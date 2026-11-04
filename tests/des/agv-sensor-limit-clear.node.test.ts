// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, expect, it } from 'vitest';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultMovementAuthority } from '../../src/core/engine/rv-movement-authority';
import { bindContinuous, clearShared, makeAgvRoot, makeHost, stepFleet } from '../helpers/agv-harness';

beforeEach(clearShared);
afterEach(clearShared);

it('9.17 removing the scanner source clears its protective stop and restarts travel', () => {
  const net = getDefaultPathNetwork();
  net.register(parsePathExtras({ type: 'Path', version: 1, id: 'L',
    segments: [{ kind: 'line', from: [0, 0, 0], to: [100, 0, 0] }],
  }, 'L')!);
  net.resolveGraph();
  const host = makeHost();
  const root = makeAgvRoot('A', { PathId: 'L', TargetSpeed: 1000, Acceleration: 500,
    Deceleration: 500, UseAcceleration: true, VehicleLength: 1000, VehicleWidth: 600,
    ScannerFields: false });
  const handle = bindContinuous(root, host);
  const mb = getDefaultMovementAuthority('continuous');
  const step = (n: number) => { for (let i = 0; i < n; i++) stepFleet(host, [handle]); };
  step(180);
  expect(mb.speedOf('A', mb.clock.now)).toBeGreaterThan(0.9);
  const obstacle = (mb.planOf('A')?.odo0 ?? 0) + mb.locate('A', mb.clock.now)!.x + 3;
  getDefaultAgvFleet().setSensorLimitSource('A', now => ({
    state: 'protective', odoObs: obstacle, dir: 1, margin: 0.2, measuredAt: now,
  }));
  step(600);
  expect(mb.sensorLimitOf('A')?.state).toBe('protective');
  expect(mb.speedOf('A', mb.clock.now)).toBeCloseTo(0, 6);
  const stopped = root.position.clone();
  getDefaultAgvFleet().setSensorLimitSource('A', null);
  step(180);
  expect.soft(mb.sensorLimitOf('A')).toBeNull();
  expect.soft(mb.speedOf('A', mb.clock.now)).toBeGreaterThan(0.9);
  expect(root.position.distanceTo(stopped)).toBeGreaterThan(1);
});
