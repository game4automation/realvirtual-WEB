// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2051 §9.4 (SEKUNDAER) - dedicated seed-variance proof for `Downtime`
 * MTBF/MTTR, parallel to §9.3's PalletYard/TaktSource proof but on a
 * synthetic Station + Downtime scene (PalletYard has no Downtime node). Same
 * harness as tests/des/des-randomness-downtime.node.test.ts (§9.2) and
 * tests/des/rv-des-downtime.test.ts; this file's job is only the variance
 * claim itself, checked on the individual failure/repair cycles - never an
 * aggregate that two inert draws could satisfy identically (SOL round-2
 * finding 6, same standard as §9.3).
 *
 * Pure Node, synthetic scene - no browser child process, runs in well under a
 * second. No `describe.skipIf` guard: it is part of the default
 * `npm run test:node` / `npm run test:all` run, same as §9.1/§9.2.
 */
import { afterEach, describe, expect, it } from 'vitest';
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

const runners: DESRunner[] = [];
afterEach(() => { for (const runner of runners.splice(0)) runner.dispose(); });

interface Cycle { fail: number; repair: number }

/** Failure/repair instants of a Station+Downtime pair up to `until` (s), Stochastic on. */
function run(seed: number, until = 50_000): Cycle[] {
  resetDESMUCounter();
  for (const def of [Station, Downtime] as unknown as MaterialFlowDefinition[]) registerMaterialFlow(def);
  const scene = new Scene();
  const stationNode = new Object3D(); stationNode.name = 'Station';
  const downtimeNode = new Object3D(); downtimeNode.name = 'Downtime';
  scene.add(stationNode, downtimeNode);
  stationNode.userData.realvirtual = { Station: {} };
  downtimeNode.userData.realvirtual = { Downtime: { MTBF: 100, MTTR: 10, TargetComponentPath: 'Station', Stochastic: true } };
  scene.updateMatrixWorld(true);
  const host: BindContextHost = {
    signalStore: new SignalStore(), registry: null, drives: [],
    on: () => () => {}, contextMenu: new ContextMenuStore(),
    getPlugin: () => undefined,
  };
  const runner = new DESRunner({ subMode: 'animated', masterSeed: seed });
  runners.push(runner);
  bindSceneToRunner(runner, scene, host);
  for (const { adapter } of runner.liveInstances) { adapter.nextComponents = []; adapter.previousComponents = []; }
  const adapterOf = (node: Object3D): MaterialFlowAdapter => runner.liveInstances.find(i => i.adapter.node === node)!.adapter;
  const manager = runner.getManager();
  manager.duration = until + 1;
  runner.start([], { root: scene });

  const station = adapterOf(stationNode);
  const cycles: Cycle[] = [];
  const setFailure = station.setFailure.bind(station);
  station.setFailure = (on: boolean) => {
    if (on) cycles.push({ fail: manager.currentTime, repair: NaN });
    else if (cycles.length) cycles[cycles.length - 1].repair = manager.currentTime;
    setFailure(on);
  };
  manager.duration = until;
  while (manager.currentTime < until) if (manager.processEvents(1000) === 0) break;
  return cycles.filter(c => Number.isFinite(c.repair));
}

/** The three fields SOL round-2 finding 6 insists on checking individually. */
const signature = (c: Cycle[]): string => JSON.stringify(c);

describe('plan-2051 §9.4: Downtime seed variance on a synthetic Station+Downtime scene', () => {
  it('5 identical seeds are bit-identical', () => {
    const runs = [1, 2, 3, 4, 5].map(() => run(99));
    expect(runs[0].length).toBeGreaterThan(20);
    for (const r of runs.slice(1)) expect(r).toEqual(runs[0]);
  });

  it('5 different seeds all differ from each other (not just one pair)', () => {
    const sigs = [1, 2, 3, 4, 5].map(seed => signature(run(seed)));
    expect(new Set(sigs).size).toBe(5);
  });
});
