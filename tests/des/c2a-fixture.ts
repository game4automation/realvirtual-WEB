// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach } from 'vitest';
import { Object3D, Scene } from 'three';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { bindSceneToRunner } from '@rv/plugins/des/des-scene-binding';
import { Station } from '@rv/plugins/des/material-flow/Station';
import { Storage } from '@rv/plugins/des/material-flow/Storage';
import Source from '../../src/behaviors/Source';
import Sink from '../../src/behaviors/Sink';
import { getMaterialFlow, registerMaterialFlow } from '../../src/core/material-flow/registry';
import type { MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';
import { testAddressRegistry } from '../helpers/test-address-registry';

void Source; void Sink;
const definitions = [getMaterialFlow('Source')!, getMaterialFlow('Sink')!, Station, Storage] as MaterialFlowDefinition[];
const runners: DESRunner[] = [];
afterEach(() => { for (const runner of runners.splice(0)) runner.dispose(); });

export function runnerFixture(scene: Object3D, seed = 42) {
  for (const def of definitions) registerMaterialFlow(def);
  const signalStore = new SignalStore();
  const runner = new DESRunner({ subMode: 'animated' });
  runners.push(runner);
  scene.updateMatrixWorld(true);
  const host = {
    mainDocumentKey: null as string | null,
    signalStore, registry: null, desAddresses: testAddressRegistry(scene), drives: [], on: () => () => {},
    contextMenu: new ContextMenuStore(), getPlugin: () => undefined,
  };
  bindSceneToRunner(runner, scene, host);
  const components = runner.liveInstances.map(i => i.adapter);
  for (const c of components) { c.nextComponents = []; c.previousComponents = []; }
  const manager = runner.getManager();
  manager.setMasterSeed(seed);
  return { runner, manager, components, signalStore, host };
}

export function lineFixture(opts: { seed?: number; statResetTime?: number; stationProcessTime?: number; interArrivalTime?: number; reverse?: boolean } = {}) {
  const scene = new Scene();
  for (const [name, props] of [
    ['Source', { Interval: opts.interArrivalTime ?? 10 }],
    ['Station', { ProcessingTime: opts.stationProcessTime ?? 5 }],
    ['Sink', {}],
  ] as const) {
    const node = new Object3D(); node.name = name;
    node.userData.realvirtual = { [name]: props }; scene.add(node);
  }
  if (opts.reverse) scene.children.reverse();
  const fixture = runnerFixture(scene, opts.seed);
  const { runner, manager, components } = fixture;
  const [source, station, sink] = ['Source', 'Station', 'Sink'].map(name => components.find(c => c.node.name === name)!);
  source.nextComponents = [station]; station.previousComponents = [source];
  station.nextComponents = [sink]; sink.previousComponents = [station];
  manager.statResetTime = opts.statResetTime ?? 0;
  runner.start([], { root: scene, host: fixture.host });
  return {
    ...fixture, scene, source, station, sink,
    runUntil(time: number) {
      let guard = 0;
      while (manager.currentTime < time && guard++ < 1000000) manager.processAnimated(0.5);
    },
    snapshot: () => runner.fullSnapshot(),
    restore: (snap: ReturnType<DESRunner['fullSnapshot']>) => runner.restoreFull(snap),
  };
}
