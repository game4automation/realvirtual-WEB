// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { Object3D } from 'three';
import '../../src/behaviors/Agv';
import { getDefaultMovementAuthority } from '../../src/core/engine/rv-movement-authority';
import { decodeAuthorityData, record } from '../../src/core/engine/rv-movement-authority-snapshot';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { clearShared, makeAgvRoot } from './agv-harness';
import { runnerFixture } from '../des/runner-fixture';
import { continuationWorld } from '../des/continuation-world-fixture';

export interface AgvContinuationOptions {
  zones?: boolean;
  twins?: boolean;
  inactiveTwin?: boolean;
  long?: boolean;
  freezeAt?: number;
  resumeAt?: number;
}

/** Separate owners per build; no task callbacks or wall-clock timers. */
export function agvContinuationWorld(options: AgvContinuationOptions = {}) {
  clearShared();

  const net = getDefaultPathNetwork(), scene = new Object3D();
  const path = (id: string, from: number[], to: number[], successors: string[], zone?: string) => {
    net.register(parsePathExtras({ type: 'Path', id, successors,
      segments: [{ kind: 'line', from, to }], ...(zone ? { zone, zoneCapacity: 1 } : {}) }, id)!);
  };
  if (options.zones) {
    // Two incoming arms and a capacity-one merge, as in agv-zone-scenario.
    path('Entry', [-3, 0, 0], [0, 0, 0], ['Merge']);
    path('Side', [0, 0, -3], [0, 0, 0], ['Merge']);
    path('Merge', [0, 0, 0], [20, 0, 0], ['Exit'], 'crossing');
    path('Exit', [20, 0, 0], [24, 0, 0], []);
  } else {
    const length = options.long ? 200 : 4;
    path('Entry', [0, 0, 0], [length, 0, 0], ['Exit']);
    path('Exit', [length, 0, 0], [length + 2, 0, 0], []);
    if (options.twins || options.inactiveTwin) {
      path('TwinEntry', [0, 0, 10], [length, 0, 10], ['TwinExit']);
      path('TwinExit', [length, 0, 10], [length + 2, 0, 10], []);
    }
  }
  net.resolveGraph();
  const roots = [makeAgvRoot('A', { PathId: options.zones ? 'Merge' : 'Entry', StartPosition: 1000,
    TargetSpeed: 1000, Destination: 'Exit', ServiceTime: 20,
    VehicleLength: 1000, VehicleWidth: 600, ScannerFields: false })];
  if (options.zones || options.twins || options.inactiveTwin) roots.push(makeAgvRoot('B', {
    Active: !options.inactiveTwin,
    PathId: options.zones ? 'Side' : 'TwinEntry', StartPosition: 1000,
    TargetSpeed: 1000, Destination: options.zones ? 'Exit' : 'TwinExit', ServiceTime: 20,
    VehicleLength: 1000, VehicleWidth: 600, ScannerFields: false }));
  scene.add(...roots);
  const { runner, manager, host } = runnerFixture(scene);
  runner.start([], { root: scene, host });
  runner.tick(0); runner.lateTick(0);
  const authority = getDefaultMovementAuthority('des'), zones = getDefaultZoneRegistry();
  const base = continuationWorld(runner);
  const restore = runner.restoreFull.bind(runner);
  // Mode A must exercise the JSON wire format too.
  runner.restoreFull = raw => restore(JSON.parse(JSON.stringify(raw)));
  const world = {
    ...base, runner, manager, authority, zones,
    authorityState: () => record(decodeAuthorityData(authority.exportState())),
    agvState: (name = 'A') => record(runner.fullSnapshot().parts.find(p =>
      p.key === `fleet.agv:${runner.liveInstances.find(i => i.self.root.name === name)!.desId}`)!.state),
    assign: (destination: string) => getDefaultAgvFleet().get('A')!.assign({ destination }),
    step(toT: number) {
      // Inputs use absolute simulation times, so restoring does not depend on
      // an undeclared test-driver flag. Failure/repair uses the plan-2053 API.
      while (manager.currentTime < toT) {
        const before = manager.currentTime;
        const boundary = [options.freezeAt, options.resumeAt].filter((t): t is number =>
          t !== undefined && t > before && t <= toT).sort((a, b) => a - b)[0];
        const next = Math.min(before + 0.25, toT, boundary ?? Infinity);
        base.step(next);
        if (next === options.freezeAt) runner.liveInstances.find(i => i.self.root.name === 'A')!.adapter.setFailure(true);
        if (next === options.resumeAt) runner.liveInstances.find(i => i.self.root.name === 'A')!.adapter.setFailure(false);
        runner.tick(0); runner.lateTick(0);
      }
    },
    kpis: () => ({ ...base.kpis(), 'fleet.authority': authority.exportState(),
      poses: roots.map(r => ({ name: r.name, position: r.position.toArray(), quaternion: r.quaternion.toArray() })),
      tweens: runner.getTweenRegistry().activeCount }),
    dispose() { runner.dispose(); clearShared(); },
  };
  return world;
}

export type AgvContinuationWorld = ReturnType<typeof agvContinuationWorld>;

/** Find a real queue/state boundary without assuming a kinematic duration. */
export function findAgvCut(options: AgvContinuationOptions,
  predicate: (world: AgvContinuationWorld) => boolean, limit = 120): number {
  const world = agvContinuationWorld(options);
  try {
    while (world.manager.currentTime < limit) {
      world.step(world.manager.currentTime + 0.25);
      if (predicate(world)) return world.manager.currentTime;
    }
    throw new Error('AGV acceptance precondition was never reached');
  } finally { world.dispose(); }
}

