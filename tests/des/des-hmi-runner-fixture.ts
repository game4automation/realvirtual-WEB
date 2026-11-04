// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import type { DESComponent } from '@rv/plugins/des/rv-des-component';
import type { DESRunner } from '@rv/plugins/des/des-runner';
import { runnerFixture } from './runner-fixture';

const owners = new WeakMap<DESComponent, DESRunner>();

/** Real adapters and manager clock, exposed through the active kernel executor. */
export function hmiRunner(scene: Object3D, nodes: Object3D[]) {
  for (const node of nodes) node.userData.realvirtual = { Station: { ProcessingTime: 1 } };
  const { runner, manager, components } = runnerFixture(scene);
  runner.start([], { root: scene });
  for (const comp of components) owners.set(comp, runner);
  const clock = {
    get currentTime() { return manager.currentTime; },
    set currentTime(time: number) { manager.processAnimated(time - manager.currentTime); },
  };
  return { runner, clock, comps: components };
}

export function runnerOf(comp: DESComponent): DESRunner {
  const runner = owners.get(comp);
  if (!runner) throw new Error('HMI component must belong to a real runner');
  return runner;
}
