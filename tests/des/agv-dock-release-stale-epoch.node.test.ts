// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it } from 'vitest';
import { Object3D } from 'three';
import type { RVViewer } from '../../src/core/rv-viewer';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultPathDockRegistry } from '../../src/core/engine/rv-path-dock';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { agvSelfForSnapshot } from '../../src/behaviors/Agv';
import { DESRunner } from '../../src/plugins/des/des-runner';
import { registerModelPlugins, unregisterModelPlugins } from '../../src/plugins/models/AGVDemo';
import { bindDes, clearShared, makeAgvRoot, makeHost } from '../helpers/agv-harness';

let active: DESRunner | undefined;
afterEach(() => { unregisterModelPlugins(); active?.dispose(); active = undefined; clearShared(); });

function world() {
  clearShared();
  const net = getDefaultPathNetwork();
  for (const [id, from, to, successors] of [
    ['PathEast', 0, 3, ['HeldDock']], ['HeldDock', 3, 3.1, []],
  ] as const) {
    net.register(parsePathExtras({ type: 'Path', id,
      segments: [{ kind: 'line', from: [0, 0, from], to: [0, 0, to] }],
      successors: [...successors],
    }, id)!);
  }
  net.resolveGraph();
  const runner = new DESRunner({ subMode: 'animated' }); active = runner;
  const root = makeAgvRoot('V', { PathId: 'PathEast', StartPosition: 0,
    VehicleLength: 100, VehicleWidth: 60, ScannerFields: false,
    Acceleration: 10000, Deceleration: 10000, TargetSpeed: 5000, DockingSpeed: 5000, DockingDistance: 10 });
  const bound = bindDes(runner, root, makeHost());
  runner.start([], { root: new Object3D() });
  const self = agvSelfForSnapshot(bound);
  const viewer = {
    get simTime() { return runner.simTime; },
    simulationKernel: { desControl: () => runner },
    use() {}, removePlugin() {}, on: () => () => {},
  } as unknown as RVViewer;
  registerModelPlugins(viewer);
  const handle = getDefaultAgvFleet().get('V')!;
  const tick = () => { runner.tick(0.01); runner.lateTick(0.01); };
  return { runner, self, handle,
    until(predicate: () => boolean) {
      for (let i = 0; i < 10000 && !predicate(); i++) tick();
      expect(predicate()).toBe(true);
    },
    dispose() { unregisterModelPlugins(); runner.dispose(); active = undefined; },
  };
}

// The PathEast dock services every vehicle that stands at its segment end: a re-assigned
// vehicle there abandons its stay (epoch e1) and is caught again at once (new stay e2,
// own release 1.5 s later). The release still queued for e1 is due first and must be void.
for (const restore of [false, true]) {
  it(`ignores an abandoned dock stay's release during a new stay${restore ? ' after mode B restore' : ''}`, () => {
    let w = world();
    try {
      w.handle.assign({ destination: 'PathEast' });
      w.until(() => w.handle.phase === 'servicing');
      const e1 = w.handle.stayEpoch!();
      const releases = () => w.runner.fullSnapshot().eventQueue.filter(e => e.action === 'AGVDemo.DockRelease');
      const old = releases()[0];
      expect(old.data).toEqual({ agvId: 'V', epoch: e1 });
      // Re-assign inside a DES event 0.5 s into the stay (outside events the manager clock lags).
      let abandoned = -1;
      w.runner.scheduleCallback(old.time - 1, () => {
        w.handle.assign({ destination: 'HeldDock' }); abandoned = w.handle.stayEpoch!();
      }, { origin: { owner: 'test.ui', kind: 'ui' } });
      w.until(() => abandoned > e1 && w.handle.phase === 'servicing');
      expect(w.runner.simTime).toBeLessThan(old.time);
      expect(w.self.local.traveler?.path?.id).toBe('PathEast');
      const e2 = w.handle.stayEpoch!();
      expect(e2).toBeGreaterThan(e1);
      const queued = releases();
      expect(queued.map(e => e.data)).toEqual([{ agvId: 'V', epoch: e1 }, { agvId: 'V', epoch: e2 }]);
      const fresh = queued[1];
      expect(fresh.time).toBeGreaterThan(old.time);
      if (restore) {
        const json = JSON.stringify(w.runner.fullSnapshot());
        w.dispose();
        w = world();
        w.runner.restoreFull(JSON.parse(json));
        expect(w.handle.stayEpoch!()).toBe(e2);
      }
      // Past the stale release: the new stay is untouched.
      w.until(() => w.runner.simTime >= old.time);
      expect(releases().map(e => e.data)).toEqual([{ agvId: 'V', epoch: e2 }]);
      expect(w.handle.phase).toBe('servicing');
      expect(w.handle.stayEpoch!()).toBe(e2);
      expect(w.self.local.desServiceEvent).toBe(-1);
      // Its own release ends it and the vehicle drives on to the next segment.
      w.until(() => w.self.local.traveler?.path?.id === 'HeldDock');
      expect(w.runner.simTime).toBeGreaterThanOrEqual(fresh.time);
    } finally { w.dispose(); }
  });
}
