// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { expect, it, vi } from 'vitest';
import { Object3D } from 'three';
import type { RVViewer } from '../../src/core/rv-viewer';
import { DESRunner } from '../../src/plugins/des/des-runner';
import { registerModelPlugins, unregisterModelPlugins } from '../../src/plugins/models/AGVDemo';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultPathDockRegistry } from '../../src/core/engine/rv-path-dock';

it('roundtrips the AGVDemo dock action with its independent snapshot owner', () => {
  const runner = new DESRunner({ subMode: 'animated' });
  runner.start([], { root: new Object3D() });
  const releaseStay = vi.fn();
  const fleet = getDefaultAgvFleet();
  let stay = 7;
  fleet.register({ id: 'Demo', phase: 'servicing', task: null, assign() {}, clear() {}, releaseStay, stayEpoch: () => stay });
  const viewer = {
    simTime: 0, simulationKernel: { desControl: () => runner },
    use() {}, removePlugin() {}, on: () => () => {},
  } as unknown as RVViewer;
  try {
    registerModelPlugins(viewer);
    getDefaultPathDockRegistry().dockAt('PathEast')!.onVehicleArrive('Demo', () => { throw new Error('old release'); });
    const snapshot = JSON.parse(JSON.stringify(runner.fullSnapshot()));
    expect(snapshot.parts).toContainEqual({ key: 'AGVDemo', version: 1, state: {} });
    expect(snapshot.eventQueue).toContainEqual(expect.objectContaining({
      action: 'AGVDemo.DockRelease', time: 1.5, priority: 0, data: { agvId: 'Demo', epoch: 7 },
    }));
    runner.restoreFull(snapshot);
    runner.tick(2); runner.lateTick(2);
    expect(releaseStay).toHaveBeenCalledTimes(1);
    expect(releaseStay).toHaveBeenCalledWith(7);
    void stay;
  } finally {
    unregisterModelPlugins(); fleet.unregister('Demo'); runner.dispose();
  }
});
