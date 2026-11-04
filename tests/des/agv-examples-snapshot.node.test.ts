// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { getProblems } from '../../src/core/hmi/problems-store';
import { Object3D } from 'three';
import '../../src/behaviors/Agv';
import type { RVViewer } from '../../src/core/rv-viewer';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import * as course from '../../src/plugins/models/AGVDemo';
import * as factory from '../../src/plugins/models/AGVFactory';
import { clearShared, makeAgvRoot } from '../helpers/agv-harness';
import { assertContinuation } from '../helpers/des-continuation-harness';
import { resetDESMUCounter } from '../../src/plugins/des/rv-des-mu';
import { runnerFixture } from './runner-fixture';
import { continuationWorld } from './continuation-world-fixture';

function buildWorld(example: 'AGVDemo' | 'AGVFactory') {
  clearShared(); resetDESMUCounter();
  const plugin = example === 'AGVDemo' ? course : factory;
  const ids = example === 'AGVDemo' ? ['PathSouth', 'PathEast', 'PathNorth'] : ['Load', 'WS1', 'WS2', 'WS3'];
  const net = getDefaultPathNetwork();
  ids.forEach((id, i) => {
    net.register(parsePathExtras({ type: 'Path', id, successors: [ids[(i + 1) % ids.length]],
      segments: [{ kind: 'line', from: [0, 0, i * 4], to: [0, 0, (i + 1) * 4] }],
    }, id)!);
  });
  net.resolveGraph();
  const root = new Object3D();
  ['A', 'B'].forEach((id, i) => root.add(makeAgvRoot(id, { PathId: ids[i],
    TargetSpeed: 1000, VehicleLength: 1000, VehicleWidth: 600, ScannerFields: false })));
  const f = runnerFixture(root);
  f.runner.start([], { root, host: f.host });
  f.runner.tick(0); f.runner.lateTick(0);
  const listeners = new Map<string, () => void>();
  const viewer = {
    get simTime() { return f.manager.currentTime; },
    simulationKernel: { desControl: () => f.runner }, use() {}, removePlugin() {},
    on(event: string, fn: () => void) { listeners.set(event, fn); return () => listeners.delete(event); },
  } as unknown as RVViewer;
  plugin.registerModelPlugins(viewer);
  listeners.get('simulation-start')!();
  const base = continuationWorld(f.runner);
  return { ...base, runner: f.runner,
    step(t: number) { base.step(t); f.runner.tick(0); f.runner.lateTick(0); },
    kpis: () => ({ ...base.kpis(), tasks: getDefaultAgvFleet().all().map(a => [a.id, a.task?.data]),
      orders: f.runner.fullSnapshot().parts.find(p => p.key === 'AGVFactory')?.state ?? null }),
    dispose() { plugin.unregisterModelPlugins(); f.runner.dispose(); clearShared(); },
  };
}

for (const example of ['AGVDemo', 'AGVFactory'] as const) {
  for (const mode of ['A', 'B', 'B-immediate'] as const) {
    it(`${example}: ${mode} preserves tasks and order state at three cuts`, async () => {
      const probe = buildWorld(example);
      let serviceCut = 0;
      try {
        for (let t = 0.25; t <= 120; t += 0.25) {
          probe.step(t);
          if (getDefaultAgvFleet().all().some(a => a.phase === 'servicing')) { serviceCut = t; break; }
        }
        expect(serviceCut).toBeGreaterThan(0);
      } finally { probe.dispose(); }
      for (const T of [0.5, serviceCut, 60]) {
        await assertContinuation({ buildWorld: () => buildWorld(example), mode, T, TPrime: T + 2, T2: T + 30 });
      }
    });
  }
}
it('foreign callback tasks still refuse capture', () => {
  const w = buildWorld('AGVDemo');
  try {
    getDefaultAgvFleet().get('A')!.assign({ destination: 'PathNorth', onServiceEnd() {} });
    expect(() => w.runner.fullSnapshot()).toThrow(/des-snapshot-agv-task-callbacks/);
  } finally { w.dispose(); }
});

for (const example of ['AGVDemo', 'AGVFactory'] as const) {
  for (const corruption of ['negative', 'foreign', 'destination', 'serviceSec'] as const) {
    it(`${example}: refuses ${corruption} task metadata before changing the world`, () => {
      const w = buildWorld(example);
      try {
        const before = w.runner.fullSnapshot();
        const changed = JSON.parse(JSON.stringify(before)) as typeof before;
        const part = changed.parts.find(p => p.key.startsWith('fleet.agv:')
          && (p.state as { task?: unknown }).task);
        expect(part).toBeDefined();
        const task = (part!.state as unknown as { task: { destination: string; serviceSec: number;
          data: { agvId: string; index?: number; step?: number } } }).task;
        if (corruption === 'negative') {
          if (example === 'AGVDemo') task.data.index = -1;
          else task.data.step = -1;
        }
        if (corruption === 'foreign') task.data.agvId = task.data.agvId === 'A' ? 'B' : 'A';
        if (corruption === 'destination') task.destination = 'WrongStop';
        if (corruption === 'serviceSec') task.serviceSec += 1;
        expect(() => w.runner.restoreFull(changed)).toThrow(/des-snapshot-agv-state/);
        expect(getProblems().some(p => p.code === 'des-snapshot-agv-state')).toBe(true);
        expect(w.runner.fullSnapshot()).toEqual(before);
      } finally { w.dispose(); }
    });
  }
}
