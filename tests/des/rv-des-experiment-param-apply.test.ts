// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * test-des-experiment-param-apply (plan-265 §9.2) — the KERN-BLOCKER guard.
 *
 * Proves that the re-config path (DESRunner.reconfigureFromExtras, §2.4
 * Option A) actually makes a parameter override take effect at the REAL kernel:
 *   1. mutating node.userData.realvirtual[type][field] + reconfigureFromExtras()
 *      re-reads the field into the live instance (applySchema round-trip);
 *   2. two runs with a DIFFERENT ProcessingTime override produce DIFFERENT
 *      throughput (not identical KPIs) — the silent-failure this test exists to
 *      catch. No SimDesControl mock: a mock would not prove the value reaches the
 *      model.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D, Scene } from 'three';
import { resetDESMUCounter } from '@rv/plugins/des/rv-des-mu';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { bindSceneToRunner } from '@rv/plugins/des/des-scene-binding';
import type { MaterialFlowAdapter } from '@rv/plugins/des/material-flow-adapter';
import { Station } from '@rv/plugins/des/material-flow/Station';
import Source from '../../src/behaviors/Source';
import Sink from '../../src/behaviors/Sink';
import { getMaterialFlow, registerMaterialFlow } from '../../src/core/material-flow/registry';
import type { MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import type { BindContextHost } from '../../src/core/behavior-runtime';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';

function createNode(name: string, x: number, extras?: Record<string, unknown>): Object3D {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, 0, 0);
  if (extras) node.userData.realvirtual = extras;
  return node;
}

void Source; void Sink;
const definitions = [
  getMaterialFlow('Source')!, getMaterialFlow('Sink')!, Station,
] as MaterialFlowDefinition[];
const runners: DESRunner[] = [];
afterEach(() => { for (const runner of runners.splice(0)) runner.dispose(); });

/** Bind real behaviour payloads, then let each case wire its explicit test graph. */
function bindRunner(scene: Scene): DESRunner {
  for (const def of definitions) registerMaterialFlow(def);
  scene.updateMatrixWorld(true);
  const host: BindContextHost = {
    signalStore: new SignalStore(), registry: null, drives: [],
    on: () => () => {}, contextMenu: new ContextMenuStore(),
    getPlugin: () => undefined,
  };
  const runner = new DESRunner({ subMode: 'animated' });
  runners.push(runner);
  bindSceneToRunner(runner, scene, host);
  // These cases explicitly wire the graph below (including deliberate fan-out).
  for (const { adapter } of runner.liveInstances) {
    adapter.nextComponents = [];
    adapter.previousComponents = [];
  }
  return runner;
}

function component(runner: DESRunner, node: Object3D): MaterialFlowAdapter {
  return runner.liveInstances.find(i => i.adapter.node === node)!.adapter;
}

/** Build a source→station→sink kernel and run it `time` sim-seconds. Returns
 *  the station throughput (processed count) as the observable KPI. */
function runScenario(processingTime: number, time: number): number {
  const scene = new Scene();
  const sourceNode = createNode('Source', 0, { Source: { Interval: 1 } });
  const stationNode = createNode('Station', 1, { Station: { ProcessingTime: 999 } });
  const sinkNode = createNode('Sink', 2, { Sink: {} });
  scene.add(sourceNode, stationNode, sinkNode);
  const runner = bindRunner(scene);
  const manager = runner.getManager();
  manager.setMasterSeed(42);
  const source = component(runner, sourceNode);
  const station = component(runner, stationNode);
  const sink = component(runner, sinkNode);
  source.nextComponents = [station];
  station.nextComponents = [sink];
  station.previousComponents = [source];
  sink.previousComponents = [station];

  stationNode.userData.realvirtual.Station.ProcessingTime = processingTime;
  runner.reconfigureFromExtras();
  expect(station.self.prop.ProcessingTime).toBe(processingTime);

  runner.start([], { root: scene });
  manager.duration = time;
  let guard = 0;
  while (manager.currentTime < time && guard++ < 1_000_000) manager.processAnimated(0.5);
  return station.totalProcessed;
}

describe('DES experiment parameter apply (kernel re-config)', () => {
  beforeEach(() => {
    resetDESMUCounter();
  });

  it('reconfigureFromExtras re-reads the overridden field into the instance', () => {
    const scene = new Scene();
    const node = createNode('Source', 0, { Source: { Interval: 10 } });
    scene.add(node);
    const runner = bindRunner(scene);
    const source = component(runner, node);

    runner.reconfigureFromExtras();
    expect(source.self.prop.Interval).toBe(10);

    node.userData.realvirtual.Source.Interval = 2.5;
    runner.reconfigureFromExtras();
    expect(source.self.prop.Interval).toBe(2.5);
  });

  // Source.Interval is now a demand-pull heartbeat, not a production cadence.
  // Use the station timing parameter to retain the end-to-end KPI apply contract.
  it('different ProcessingTime overrides yield DIFFERENT throughput (not identical KPIs)', () => {
    const slow = runScenario(20, 400); // ~20 completions
    const fast = runScenario(4, 400);  // ~100 completions
    expect(fast).toBeGreaterThan(slow);
    expect(slow).toBeGreaterThan(0);
  });
});
