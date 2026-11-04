// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { testAddressRegistry } from '../helpers/test-address-registry';
import { Object3D, Scene } from 'three';
import { resetDESMUCounter } from '../../src/plugins/des/rv-des-mu';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { DESRunner } from '../../src/plugins/des/des-runner';
import { bindSceneToRunner } from '../../src/plugins/des/des-scene-binding';
import type { MaterialFlowAdapter } from '../../src/plugins/des/material-flow-adapter';
import { Station } from '../../src/plugins/des/material-flow/Station';
import { Downtime } from '../../src/plugins/des/material-flow/Downtime';
import { registerMaterialFlow } from '../../src/core/material-flow/registry';
import type { MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import type { BindContextHost } from '../../src/core/behavior-runtime';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';

interface Cycle { fail: number; repair: number }
interface RunResult { cycles: Cycle[]; rngTouched: boolean }

/**
 * One run of a Station + Downtime pair: the failure/repair instants of the
 * target station up to `until` (s), and whether the downtime's RNG was drawn from.
 */
export function runDowntime(downtime: Record<string, unknown>, seed: number, until = 20_000): RunResult {
  resetDESMUCounter();
  for (const def of [Station, Downtime] as unknown as MaterialFlowDefinition[]) registerMaterialFlow(def);
  const scene = new Scene();
  const stationNode = new Object3D(); stationNode.name = 'Station';
  const downtimeNode = new Object3D(); downtimeNode.name = 'Downtime';
  scene.add(stationNode, downtimeNode);
  stationNode.userData.realvirtual = { Station: {} };
  downtimeNode.userData.realvirtual = { Downtime: { MTBF: 100, MTTR: 10, TargetComponentPath: 'Station', ...downtime } };
  scene.updateMatrixWorld(true);
  const host: BindContextHost = {
    signalStore: new SignalStore(), registry: null, desAddresses: testAddressRegistry(), drives: [],
    on: () => () => {}, contextMenu: new ContextMenuStore(),
    getPlugin: () => undefined,
  };
  const runner = new DESRunner({ subMode: 'animated', masterSeed: seed });

  bindSceneToRunner(runner, scene, host);
  for (const { adapter } of runner.liveInstances) { adapter.nextComponents = []; adapter.previousComponents = []; }
  const adapterOf = (node: Object3D): MaterialFlowAdapter => runner.liveInstances.find(i => i.adapter.node === node)!.adapter;
  const manager = runner.getManager();
  manager.duration = 100_000;
  runner.start([], { root: scene });

  const station = adapterOf(stationNode);
  const dt = adapterOf(downtimeNode);
  const cycles: Cycle[] = [];
  const setFailure = station.setFailure.bind(station);
  station.setFailure = (on: boolean) => {
    if (on) cycles.push({ fail: manager.currentTime, repair: NaN });
    else if (cycles.length) cycles[cycles.length - 1].repair = manager.currentTime;
    setFailure(on);
  };
  // The adapter's RNG as attached (masterSeed + entity id) — compared after the run.
  const fresh = manager.createComponentRng(dt.entityId >= 0 ? dt.entityId : 0).getState();

  manager.duration = until;
  while (manager.currentTime < until) if (manager.processEvents(1000) === 0) break;
  const rngTouched = JSON.stringify(dt.rng!.getState()) !== JSON.stringify(fresh);
  runner.dispose();
  return { cycles: cycles.filter(c => Number.isFinite(c.repair)), rngTouched };
}


import { SFC32 } from '../../src/core/rv-rng-distribution';
import { TaktSource } from '../../src/core/fleet/core/order-sources';
import { deriveFleetRng } from '../../src/plugins/fleet-plugin';
import { ContinuousSimClock } from '../../src/core/fleet/core/sim-clock';

export function legacySequences() {
  const raw = [0, 42, 12345].map(seed => {
    const rng = new SFC32(seed);
    return { seed, outputs: Array.from({ length: 64 }, () => rng.next()) };
  });
  const cycles = runDowntime({ Stochastic: true }, 7, 2000).cycles;
  const delays = cycles.flatMap((c, i) => [c.fail - (i ? cycles[i - 1].repair : 0), c.repair - c.fail]);
  return { raw, downtime: { seed: 7, mtbf: 100, mttr: 10, until: 2000, cycles, delays },
    takt: legacyTaktSequence() };
}

export function legacyTaktSequence() {
  const plantId = 'PlantA';
  const masterSeed = 7;
  // The runner branch reads only masterSeed; the root is unused in this branch.
  const runnerStub = { masterSeed } as DESRunner;
  const rootStub = {} as Object3D;
  const clock = new ContinuousSimClock();
  const releases: number[][] = [[], [], []];
  const source = new TaktSource(clock, { intervalSec: 60, phaseSec: [0, 20, 40], stochastic: true }, 3, {
    headFree: () => true,
    release: i => { releases[i].push(clock.now()); },
    blocked: () => { throw new Error('unexpected blocked takt'); },
  }, deriveFleetRng(plantId, runnerStub, rootStub));
  source.start();
  clock.advanceTo(600);
  source.stop();
  return { plantId, masterSeed, intervalSec: 60, phaseSec: [0, 20, 40], until: 600, releases,
      delays: releases.map(xs => xs.slice(1).map((t, i) => t - xs[i])) };
}
