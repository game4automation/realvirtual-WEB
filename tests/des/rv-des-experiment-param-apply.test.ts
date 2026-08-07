// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * test-des-experiment-param-apply (plan-265 §9.2) — the KERN-BLOCKER guard.
 *
 * Proves that the re-config path (DESComponent.reconfigureFromExtras, §2.4
 * Option A) actually makes a parameter override take effect at the REAL kernel:
 *   1. mutating node.userData.realvirtual[type][field] + reconfigureFromExtras()
 *      re-reads the field into the live instance (applySchema round-trip);
 *   2. two runs with a DIFFERENT InterArrivalTime override produce DIFFERENT
 *      throughput (not identical KPIs) — the silent-failure this test exists to
 *      catch. No SimDesControl mock: a mock would not prove the value reaches the
 *      model.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Scene } from 'three';
import { DESManager } from '@rv-private/plugins/des/rv-des-manager';
import { DES } from '@rv-private/plugins/des/rv-des-api';
import { DESSource } from '@rv-private/plugins/des/rv-des-source';
import { DESSink } from '@rv-private/plugins/des/rv-des-sink';
import { DESStation } from '@rv-private/plugins/des/rv-des-station';
import type { DESComponent } from '@rv-private/plugins/des/rv-des-component';
import { resetDESMUCounter } from '@rv-private/plugins/des/rv-des-mu';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { SignalStore } from '../../src/core/engine/rv-signal-store';

function createNode(name: string, x: number, extras?: Record<string, unknown>): Object3D {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, 0, 0);
  if (extras) node.userData.realvirtual = extras;
  return node;
}

/** Build a source→station→sink kernel and run it `time` sim-seconds. Returns
 *  the station throughput (processed count) as the observable KPI. */
function runScenario(interArrival: number, time: number): number {
  const scene = new Scene();
  const ctx = {
    registry: new NodeRegistry(),
    signalStore: new SignalStore(),
    scene,
    transportManager: {} as never,
    root: scene,
  };
  const manager = new DESManager();
  DES.setManager(manager);
  resetDESMUCounter();
  manager.setMasterSeed(42);

  // Source carries its config in rv_extras, like a GLB-loaded node.
  const sourceNode = createNode('Source', 0, { DESSource: { InterArrivalTime: 999 } });
  const stationNode = createNode('Station', 1);
  const sinkNode = createNode('Sink', 2);
  scene.add(sourceNode, stationNode, sinkNode);

  const source = new DESSource(sourceNode);
  const station = new DESStation(stationNode);
  station.ProcessingTime = 1;
  const sink = new DESSink(sinkNode);

  source.nextComponents = [station];
  station.nextComponents = [sink];
  station.previousComponents = [source];
  sink.previousComponents = [station];

  const components: DESComponent[] = [source, station, sink];
  for (const c of components) manager.registerComponent(c);
  for (const c of components) c.init(ctx);

  // Apply the parameter override into the raw rv_extras bag, then re-read it via
  // the plan-265 re-config path — BEFORE start() (the §2.2 ordering).
  (sourceNode.userData.realvirtual as { DESSource: { InterArrivalTime: number } }).DESSource.InterArrivalTime = interArrival;
  source.reconfigureFromExtras();
  expect(source.InterArrivalTime).toBe(interArrival); // (1) field re-read

  source.start();
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
    const node = createNode('Source', 0, { DESSource: { InterArrivalTime: 10 } });
    scene.add(node);
    const manager = new DESManager();
    DES.setManager(manager);
    const source = new DESSource(node);
    manager.registerComponent(source);
    source.init({ registry: new NodeRegistry(), signalStore: new SignalStore(), scene, transportManager: {} as never, root: scene });

    source.reconfigureFromExtras();
    expect(source.InterArrivalTime).toBe(10);

    (node.userData.realvirtual as { DESSource: { InterArrivalTime: number } }).DESSource.InterArrivalTime = 2.5;
    source.reconfigureFromExtras();
    expect(source.InterArrivalTime).toBe(2.5);
  });

  it('different InterArrivalTime overrides yield DIFFERENT throughput (not identical KPIs)', () => {
    const slow = runScenario(20, 400); // ~20 arrivals
    const fast = runScenario(4, 400);  // ~100 arrivals
    expect(fast).toBeGreaterThan(slow);
    expect(slow).toBeGreaterThan(0);
  });
});
