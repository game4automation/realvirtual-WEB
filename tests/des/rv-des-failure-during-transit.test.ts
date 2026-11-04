// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TestDESFailureDuringTransit -- a failure (downtime / stop) must HALT work that
 * is already in progress, not just block new intake, and resume it with the
 * REMAINING time on repair (so MTTR extends the effective cycle/transport time).
 *
 * Covers the three components that schedule time-consuming self-events:
 *   - Conveyor : an in-transit MU must not arrive while the belt is down.
 *   - Station  : an in-process MU must not complete while the machine is down.
 *   - Source   : generation must pause on failure and resume on repair
 *                   (regression: a failed source used to go permanently dormant).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D, Scene, Mesh, BoxGeometry } from 'three';
import { DESManager } from '@rv/plugins/des/rv-des-manager';
import { createDESMU, resetDESMUCounter } from '@rv/plugins/des/rv-des-mu';
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

// ── Helpers ──

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
  const host: BindContextHost = {
    signalStore: new SignalStore(), registry: null, drives,
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

/** Advance sim time to (at least) `target` seconds in fixed 0.1 s ticks. */
function advanceTo(manager: DESManager, target: number): void {
  let guard = 0;
  while (manager.currentTime < target && guard++ < 100000) {
    manager.processAnimated(0.1);
  }
}

describe('DES failure during transit/processing', () => {
  let manager: DESManager;
  let scene: Scene;

  beforeEach(() => {
    resetDESMUCounter();
  });

  it('Conveyor: an in-transit MU does NOT arrive while failed, resumes with remaining time on repair', () => {
    scene = new Scene();

    const convNode = createNode('Conv', 1, 0, 0);
    const sinkNode = createNode('Sink', 2, 0, 0);
    scene.add(convNode, sinkNode);

    convNode.userData.realvirtual = { Conveyor: {} };
    sinkNode.userData.realvirtual = { Sink: {} };
    const runner = bindRunner(scene);
    manager = runner.getManager();
    manager.duration = 100000;
    const conv = component(runner, convNode);
    const sink = component(runner, sinkNode);

    conv.nextComponents = [sink];
    sink.previousComponents = [conv];

    // Put one MU on the belt at t=0 — arrival is due at t=5.
    runner.start([], { root: scene });

    const mu = createDESMU(manager.currentTime, null, manager);
    manager.registerMU(mu);
    expect(conv.acceptMU(mu)).toBe(true);

    // Advance to t=2 — MU is mid-belt, not yet at the sink.
    advanceTo(manager, 2);
    expect(sink.totalProcessed).toBe(0);

    // Belt goes down mid-transit. The arrival event must be cancelled.
    conv.setFailure(true);
    expect(conv.isFailure).toBe(true);

    // Advance well past the original arrival time (t=5). With the fix the MU
    // must STILL be on the belt — it must not teleport through a stopped belt.
    advanceTo(manager, 10);
    expect(sink.totalProcessed).toBe(0);

    // Repair at ~t=10. Remaining transport was 5 - 2 = 3 s, so arrival is now ~t=13.
    conv.setFailure(false);
    expect(conv.isFailure).toBe(false);

    // Still not arrived right after repair...
    advanceTo(manager, 12);
    expect(sink.totalProcessed).toBe(0);

    // ...arrives after the remaining 3 s have elapsed.
    advanceTo(manager, 14);
    expect(sink.totalProcessed).toBe(1);

    // The part arrived at ~t=13 (5 s transport + ~8 s downtime), proving the
    // downtime extended the effective transport time rather than being ignored.
    expect(manager.currentTime).toBeGreaterThan(12.9);
  });

  it('Station: an in-process MU does NOT complete while failed, resumes with remaining time on repair', () => {
    scene = new Scene();

    const stationNode = createNode('Station', 1, 0, 0);
    const sinkNode = createNode('Sink', 2, 0, 0);
    scene.add(stationNode, sinkNode);

    stationNode.userData.realvirtual = { Station: { ProcessingTime: 5, MaxCapacity: 1 } };
    sinkNode.userData.realvirtual = { Sink: {} };
    const runner = bindRunner(scene);
    manager = runner.getManager();
    manager.duration = 100000;
    const station = component(runner, stationNode);
    const sink = component(runner, sinkNode);

    station.nextComponents = [sink];
    sink.previousComponents = [station];

    runner.start([], { root: scene });

    const mu = createDESMU(manager.currentTime, null, manager);
    manager.registerMU(mu);
    expect(station.acceptMU(mu)).toBe(true);

    advanceTo(manager, 2);
    expect(sink.totalProcessed).toBe(0);

    station.setFailure(true);
    advanceTo(manager, 10);
    // ProcessComplete (originally t=5) must NOT have fired while down.
    expect(sink.totalProcessed).toBe(0);
    expect(station.currentLoad).toBe(1);

    station.setFailure(false);
    advanceTo(manager, 12);
    expect(sink.totalProcessed).toBe(0); // remaining 3 s not yet elapsed
    advanceTo(manager, 14);
    expect(sink.totalProcessed).toBe(1); // completes ~t=13
  });

  it('Source: generation pauses while failed and resumes on repair (no permanent dormancy)', () => {
    scene = new Scene();

    const sourceNode = createNode('Source', 0, 0, 0);
    const sinkNode = createNode('Sink', 1, 0, 0);
    scene.add(sourceNode, sinkNode);

    sourceNode.userData.realvirtual = { Source: { Interval: 2 } };
    sinkNode.userData.realvirtual = { Sink: {} };
    const runner = bindRunner(scene);
    manager = runner.getManager();
    manager.duration = 100000;
    const source = component(runner, sourceNode);
    const sink = component(runner, sinkNode);

    source.nextComponents = [sink];
    sink.previousComponents = [source];

    runner.start([], { root: scene });

    // The source emits immediately, then on its 2 s heartbeat into the sink.
    advanceTo(manager, 5);
    const generatedBeforeFailure = source.totalProcessed;
    expect(generatedBeforeFailure).toBeGreaterThanOrEqual(1);

    // Source goes down. No new MUs while failed.
    source.setFailure(true);
    advanceTo(manager, 20);
    expect(source.totalProcessed).toBe(generatedBeforeFailure);

    // Repair — generation must resume (the regression was a forever-dormant source).
    source.setFailure(false);
    advanceTo(manager, 30);
    expect(source.totalProcessed).toBeGreaterThan(generatedBeforeFailure);
  });
});
