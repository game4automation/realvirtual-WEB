// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { ConveyorFlow } from '../../src/behaviors/Conveyor';
import { TurntableFlow } from '../../src/behaviors/Turntable';

it('preserves Turntable angle, routing cursors and lazy calibration', () => {
  const local = TurntableFlow.state();
  Object.assign(local, { lastCommandedAngle: 137, lastOutputPort: 1, lastInputPort: 1, beltCalibrated: true, beltNeutralAngle: 17 });
  const hooks = TurntableFlow.des as typeof TurntableFlow.des & { onSnapshot(s: unknown): unknown; onRestore(s: unknown, v: unknown): void };
  const saved = hooks.onSnapshot({ local });
  const restored = TurntableFlow.state();
  hooks.onRestore({ local: restored }, JSON.parse(JSON.stringify(saved)));
  for (const key of ['lastCommandedAngle', 'lastOutputPort', 'lastInputPort', 'beltCalibrated', 'beltNeutralAngle'] as const) expect(restored[key]).toEqual(local[key]);
});

it('keeps Working after the first of two in-flight MUs arrives and is released', () => {
  const a = { id: 1, generation: 0 }, b = { id: 2, generation: 0 };
  const local = ConveyorFlow.state();
  local.transitMUs.set(1, 101); local.transitMUs.set(2, 102);
  let category = '';
  const self = { local, mus: [a, b], sig: { Run: { get: () => true }, PartCount: { set: () => {} } },
    outputs: () => [], downstreamCanAccept: () => true, transfer: () => {}, statState: (s: string) => { category = s; } } as unknown as Parameters<typeof ConveyorFlow.des.onArrival>[0];
  const saved = ConveyorFlow.des.onSnapshot(self);
  local.transitMUs.clear();
  ConveyorFlow.des.onRestore(self, JSON.parse(JSON.stringify(saved)));
  ConveyorFlow.des.onArrival(self, a as Parameters<typeof ConveyorFlow.des.onArrival>[1]);
  expect(category).toBe('Working');
  expect([...local.transitMUs]).toEqual([[2, -1]]);
});

import { buildWorld } from './continuation-turntable-conveyor-world';
import { assertContinuation } from '../helpers/des-continuation-harness';

for (const type of ['Turntable', 'Conveyor', 'OverheadConveyor'] as const) {
  for (const mode of ['A', 'B', 'B-immediate'] as const) {
    it(`${type} ${mode}: exact full-snapshot, trace and KPI continuation`, async () => {
      await assertContinuation({ buildWorld: () => buildWorld(type), mode, T: 2.25, TPrime: 20, T2: 30 });
    });
  }
}
it('OverheadConveyor stays at startPhase with zero speed in animated DES', () => {
  const world = buildWorld('OverheadConveyor');
  const local = world.local as unknown as { sChainM: number; v: number };
  expect(local.sChainM).toBe(1.25);
  const phase = local.sChainM, speed = local.v;
  world.step(20);
  expect(local.sChainM).toBe(phase); expect(local.v).toBe(speed);
  expect(() => world.runner.fullSnapshot()).not.toThrow();
});

it('Turntable fixture actually rotates and visits both outputs', () => {
  const world = buildWorld('Turntable');
  const local = world.local as unknown as ReturnType<typeof TurntableFlow.state>;
  const outputs = new Set<number>();
  const angles = new Set<number>();
  for (let t = 0.25; t <= 30; t += 0.25) {
    world.step(t);
    if (local.lastOutputPort != null) outputs.add(local.lastOutputPort);
    angles.add(local.lastCommandedAngle);
  }
  expect(outputs.size).toBe(2);
  expect(angles.size).toBeGreaterThan(1);
});

it.each([-1, 0.5, 2, NaN])('refuses invalid saved port index %s before restore', index => {
  const saved = TurntableFlow.des.onSnapshot({ local: TurntableFlow.state() } as Parameters<typeof TurntableFlow.des.onSnapshot>[0]);
  expect(() => TurntableFlow.des.validateSnapshot({ ...(saved as object), lastOutputPort: index }, {
    componentId: 'table', events: [], frozen: [], hasMU: () => false, ownsMU: () => false,
    portCounts: { inputs: 1, outputs: 2 }, prop: {},
  })).toThrow(/Turntable port/);
});

it.each(['alignedPort', 'selectedOutput'])('refuses an out-of-range saved %s', key => {
  const saved = TurntableFlow.des.onSnapshot({ local: TurntableFlow.state() } as Parameters<typeof TurntableFlow.des.onSnapshot>[0]);
  expect(() => TurntableFlow.des.validateSnapshot(saved, {
    componentId: 'table', events: [], frozen: [], hasMU: () => false, ownsMU: () => false,
    portCounts: { inputs: 1, outputs: 2 }, prop: { [key]: 2 },
  })).toThrow(/Turntable prop port/);
});
