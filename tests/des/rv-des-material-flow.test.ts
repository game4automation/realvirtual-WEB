// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TestDESMaterialFlow -- Material flow integration tests.
 *
 * Tests the complete Source → Conveyor → Station → Sink pipeline,
 * station blocking/release, onDownstreamReady, and multiple NextComponents.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D, Scene, Mesh, BoxGeometry } from 'three';
import { DESManager, DESMode } from '@rv/plugins/des/rv-des-manager';
import { resetDESMUCounter } from '@rv/plugins/des/rv-des-mu';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { bindSceneToRunner } from '@rv/plugins/des/des-scene-binding';
import type { MaterialFlowAdapter } from '@rv/plugins/des/material-flow-adapter';
import { Station } from '@rv/plugins/des/material-flow/Station';
import Source from '../../src/behaviors/Source';
import Sink from '../../src/behaviors/Sink';
import { ConveyorFlow } from '../../src/behaviors/Conveyor';
import { getMaterialFlow, registerMaterialFlow } from '../../src/core/material-flow/registry';
import type { MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import type { BindContextHost } from '../../src/core/behavior-runtime';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';
import { ProgressLedger } from '../../src/core/diagnostics/rv-progress-ledger';
import { WaitRegistry } from '../../src/core/diagnostics/rv-wait-registry';
import { BudgetResolver } from '../../src/core/diagnostics/rv-blockage-budget';
import { expectNoBlockage, type BlockageViewer } from '../helpers/expect-no-blockage';

// ── Helpers ──

function createScene(): Scene {
  return new Scene();
}

function createNode(name: string, x = 0, y = 0, z = 0): Object3D {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, y, z);
  return node;
}

void Source; void Sink;
const definitions = [
  getMaterialFlow('Source')!, getMaterialFlow('Sink')!, ConveyorFlow, Station,
] as MaterialFlowDefinition[];
const runners: DESRunner[] = [];
const diagnosticHosts = new WeakMap<DESRunner, BindContextHost & BlockageViewer>();
afterEach(() => { for (const runner of runners.splice(0)) runner.dispose(); });

/** Bind real behaviour payloads, then let each case wire its explicit test graph. */
function bindRunner(scene: Scene): DESRunner {
  for (const def of definitions) registerMaterialFlow(def);
  const drives: BindContextHost['drives'] = [];
  scene.traverse(node => {
    if (!node.userData.realvirtual?.Conveyor) return;
    const belt = new Mesh(new BoxGeometry(1, 0.1, 0.2));
    belt.name = 'Transport-X';
    const sensor = new Object3D(); sensor.name = 'Sensor';
    node.add(belt, sensor);
    drives.push({ name: belt.name, node: belt, TargetSpeed: 200 } as never);
  });
  scene.updateMatrixWorld(true);
  const runner = new DESRunner({ subMode: 'animated' });
  const host: BindContextHost & BlockageViewer = {
    progressLedger: new ProgressLedger({ clock: { now: () => runner.getManager().currentTime } }),
    waitRegistry: new WaitRegistry(),
    // The longest healthy processing step below is 8 s; all three runs exceed this budget.
    blockageBudgets: new BudgetResolver({ defaults: { MaxWaitSec: 10, MaxIdleSec: 12, WarmupSec: 0 } }),
    get simTime() { return runner.getManager().currentTime; },
    signalStore: new SignalStore(), registry: null, drives,
    on: () => () => {}, contextMenu: new ContextMenuStore(),
    getPlugin: () => undefined,
  };
  diagnosticHosts.set(runner, host);
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

describe('DES Material Flow', () => {
  let manager: DESManager;
  let scene: Scene;

  beforeEach(() => {
    resetDESMUCounter();
  });

  it('Source → Conveyor → Sink timing', () => {
    scene = createScene();

    // Create components
    const sourceNode = createNode('Source', 0, 0, 0);
    const convNode = createNode('Conv', 1, 0, 0);
    const sinkNode = createNode('Sink', 2, 0, 0);
    scene.add(sourceNode, convNode, sinkNode);

    sourceNode.userData.realvirtual = { Source: { Interval: 10 } };
    convNode.userData.realvirtual = { Conveyor: {} };
    sinkNode.userData.realvirtual = { Sink: {} };
    const runner = bindRunner(scene);
    manager = runner.getManager();
    manager.duration = 100000;
    const source = component(runner, sourceNode);
    const conv = component(runner, convNode);
    const sink = component(runner, sinkNode);

    // Wire connections manually
    source.nextComponents = [conv];
    conv.nextComponents = [sink];
    conv.previousComponents = [source];
    sink.previousComponents = [conv];

    // Start source
    runner.start([], { root: scene, host: diagnosticHosts.get(runner)! });

    // Run simulation for 20 seconds
    manager.mode = DESMode.Animated;
    // Process in small steps to handle all events
    for (let t = 0; t < 200; t++) {
      manager.processAnimated(0.1);
      diagnosticHosts.get(runner)!.progressLedger!.sample(0);
    }

    // The demand-driven source fills the belt; each MU takes 5 s to transit.
    expect(sink.totalProcessed).toBeGreaterThanOrEqual(1);
    expect(source.totalProcessed).toBeGreaterThanOrEqual(1);
    expect(diagnosticHosts.get(runner)!.progressLedger!.sample(0).coverage.expected).toBe(3);
    expectNoBlockage(diagnosticHosts.get(runner)!, { requireCoverage: true });
  });

  it('Station blocks when full, releases on downstream ready', () => {
    scene = createScene();

    const sourceNode = createNode('Source', 0, 0, 0);
    const stationNode = createNode('Station', 1, 0, 0);
    const sinkNode = createNode('Sink', 2, 0, 0);
    scene.add(sourceNode, stationNode, sinkNode);

    sourceNode.userData.realvirtual = { Source: { Interval: 1 } };
    stationNode.userData.realvirtual = { Station: { ProcessingTime: 5, MaxCapacity: 1 } };
    sinkNode.userData.realvirtual = { Sink: {} };
    const runner = bindRunner(scene);
    manager = runner.getManager();
    manager.duration = 100000;
    const source = component(runner, sourceNode);
    const station = component(runner, stationNode);
    const sink = component(runner, sinkNode);

    source.nextComponents = [station];
    station.nextComponents = [sink];
    station.previousComponents = [source];
    sink.previousComponents = [station];

    runner.start([], { root: scene, host: diagnosticHosts.get(runner)! });

    // Run 15 seconds — station processes 5s each, capacity 1
    for (let t = 0; t < 150; t++) {
      manager.processAnimated(0.1);
      diagnosticHosts.get(runner)!.progressLedger!.sample(0);
    }

    // Station should have processed at least 2 MUs
    expect(station.totalProcessed).toBeGreaterThanOrEqual(2);
    expect(sink.totalProcessed).toBeGreaterThanOrEqual(2);
    expect(diagnosticHosts.get(runner)!.progressLedger!.sample(0).coverage.expected).toBe(3);
    expectNoBlockage(diagnosticHosts.get(runner)!, { requireCoverage: true });
  });

  it('onDownstreamReady unblocks upstream', () => {
    scene = createScene();

    const sourceNode = createNode('Source', 0, 0, 0);
    const station1Node = createNode('Station1', 1, 0, 0);
    const station2Node = createNode('Station2', 2, 0, 0);
    const sinkNode = createNode('Sink', 3, 0, 0);
    scene.add(sourceNode, station1Node, station2Node, sinkNode);

    sourceNode.userData.realvirtual = { Source: { Interval: 2 } };
    station1Node.userData.realvirtual = { Station: { ProcessingTime: 1, MaxCapacity: 1 } };
    station2Node.userData.realvirtual = { Station: { ProcessingTime: 8, MaxCapacity: 1 } };
    sinkNode.userData.realvirtual = { Sink: {} };
    const runner = bindRunner(scene);
    manager = runner.getManager();
    manager.duration = 100000;
    const source = component(runner, sourceNode);
    const station1 = component(runner, station1Node);
    const station2 = component(runner, station2Node);
    const sink = component(runner, sinkNode);

    source.nextComponents = [station1];
    station1.nextComponents = [station2];
    station1.previousComponents = [source];
    station2.nextComponents = [sink];
    station2.previousComponents = [station1];
    sink.previousComponents = [station2];

    runner.start([], { root: scene, host: diagnosticHosts.get(runner)! });

    // Run 25 seconds
    for (let t = 0; t < 250; t++) {
      manager.processAnimated(0.1);
      diagnosticHosts.get(runner)!.progressLedger!.sample(0);
    }

    // Station2 is slow (8s), so station1 should have been blocked at some point
    // But eventually MUs flow through
    expect(sink.totalProcessed).toBeGreaterThanOrEqual(2);
    expect(diagnosticHosts.get(runner)!.progressLedger!.sample(0).coverage.expected).toBe(4);
    expectNoBlockage(diagnosticHosts.get(runner)!, { requireCoverage: true });
  });

  it('multiple NextComponents with routing hook', () => {
    scene = createScene();

    const sourceNode = createNode('Source', 0, 0, 0);
    const stationNode = createNode('Station', 1, 0, 0);
    const sink1Node = createNode('SinkA', 2, 0, 0);
    const sink2Node = createNode('SinkB', 2, 0, 1);
    scene.add(sourceNode, stationNode, sink1Node, sink2Node);

    sourceNode.userData.realvirtual = { Source: { Interval: 2 } };
    stationNode.userData.realvirtual = { Station: { ProcessingTime: 1 } };
    sink1Node.userData.realvirtual = { Sink: {} };
    sink2Node.userData.realvirtual = { Sink: {} };
    const runner = bindRunner(scene);
    manager = runner.getManager();
    manager.duration = 100000;
    const source = component(runner, sourceNode);
    const station = component(runner, stationNode);
    const sinkA = component(runner, sink1Node);
    const sinkB = component(runner, sink2Node);

    source.nextComponents = [station];
    station.nextComponents = [sinkA, sinkB];
    station.previousComponents = [source];
    sinkA.previousComponents = [station];
    sinkB.previousComponents = [station];

    // Route: odd MUs to sinkB, even to sinkA
    let muCount = 0;
    station.onSelectNext = (candidates, _mu) => {
      muCount++;
      return muCount % 2 === 0 ? candidates[0] : candidates[1];
    };

    runner.start([], { root: scene });

    // Run 20 seconds
    for (let t = 0; t < 200; t++) {
      manager.processAnimated(0.1);
    }

    // Both sinks should have received MUs
    expect(sinkA.totalProcessed).toBeGreaterThanOrEqual(1);
    expect(sinkB.totalProcessed).toBeGreaterThanOrEqual(1);
  });
});
