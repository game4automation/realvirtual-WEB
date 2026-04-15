// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TestDESMaterialFlow -- Material flow integration tests.
 *
 * Tests the complete Source → Conveyor → Station → Sink pipeline,
 * station blocking/release, onDownstreamReady, and multiple NextComponents.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Scene } from 'three';
import { DESManager, DESMode } from '@rv-private/plugins/des/rv-des-manager';
import { DES } from '@rv-private/plugins/des/rv-des-api';
import { DESSource } from '@rv-private/plugins/des/rv-des-source';
import { DESSink } from '@rv-private/plugins/des/rv-des-sink';
import { DESConveyor } from '@rv-private/plugins/des/rv-des-conveyor';
import { DESStation } from '@rv-private/plugins/des/rv-des-station';
import { autoConnect } from '@rv-private/plugins/des/rv-des-connection';
import { resetDESMUCounter } from '@rv-private/plugins/des/rv-des-mu';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { SignalStore } from '../../src/core/engine/rv-signal-store';

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

function makeContext(scene: Scene) {
  return {
    registry: new NodeRegistry(),
    signalStore: new SignalStore(),
    scene,
    transportManager: {} as never,
    root: scene,
  };
}

describe('DES Material Flow', () => {
  let manager: DESManager;
  let scene: Scene;

  beforeEach(() => {
    manager = new DESManager();
    DES.setManager(manager);
    resetDESMUCounter();
  });

  it('Source → Conveyor → Sink timing', () => {
    scene = createScene();
    const ctx = makeContext(scene);

    // Create components
    const sourceNode = createNode('Source', 0, 0, 0);
    const convNode = createNode('Conv', 1, 0, 0);
    const sinkNode = createNode('Sink', 2, 0, 0);
    scene.add(sourceNode, convNode, sinkNode);

    const source = new DESSource(sourceNode);
    source.InterArrivalTime = 10;
    const conv = new DESConveyor(convNode);
    conv.ConveyorLength = 1000; // 1000mm
    conv.ConveyorSpeed = 200;    // 200mm/s -> transportTime = 5s
    const sink = new DESSink(sinkNode);

    // Wire connections manually
    source.nextComponents = [conv];
    conv.nextComponents = [sink];
    conv.previousComponents = [source];
    sink.previousComponents = [conv];

    // Register with manager
    manager.registerComponent(source);
    manager.registerComponent(conv);
    manager.registerComponent(sink);

    // Init
    source.init(ctx);
    conv.init(ctx);
    sink.init(ctx);

    // Start source
    source.start();

    // Run simulation for 20 seconds
    manager.mode = DESMode.Animated;
    // Process in small steps to handle all events
    for (let t = 0; t < 200; t++) {
      manager.processAnimated(0.1);
    }

    // Source generates at t=10, MU enters conveyor, exits at t=15, enters sink
    // Second MU at t=20 would need more time
    expect(sink.totalConsumed).toBeGreaterThanOrEqual(1);
    expect(source.generated).toBeGreaterThanOrEqual(1);
  });

  it('Station blocks when full, releases on downstream ready', () => {
    scene = createScene();
    const ctx = makeContext(scene);

    const sourceNode = createNode('Source', 0, 0, 0);
    const stationNode = createNode('Station', 1, 0, 0);
    const sinkNode = createNode('Sink', 2, 0, 0);
    scene.add(sourceNode, stationNode, sinkNode);

    const source = new DESSource(sourceNode);
    source.InterArrivalTime = 1;
    const station = new DESStation(stationNode);
    station.ProcessingTime = 5;
    station.MaxCapacity = 1;
    const sink = new DESSink(sinkNode);

    source.nextComponents = [station];
    station.nextComponents = [sink];
    station.previousComponents = [source];
    sink.previousComponents = [station];

    manager.registerComponent(source);
    manager.registerComponent(station);
    manager.registerComponent(sink);

    source.init(ctx);
    station.init(ctx);
    sink.init(ctx);
    source.start();

    // Run 15 seconds — station processes 5s each, capacity 1
    for (let t = 0; t < 150; t++) {
      manager.processAnimated(0.1);
    }

    // Station should have processed at least 2 MUs
    expect(station.totalProcessed).toBeGreaterThanOrEqual(2);
    expect(sink.totalConsumed).toBeGreaterThanOrEqual(2);
  });

  it('onDownstreamReady unblocks upstream', () => {
    scene = createScene();
    const ctx = makeContext(scene);

    const sourceNode = createNode('Source', 0, 0, 0);
    const station1Node = createNode('Station1', 1, 0, 0);
    const station2Node = createNode('Station2', 2, 0, 0);
    const sinkNode = createNode('Sink', 3, 0, 0);
    scene.add(sourceNode, station1Node, station2Node, sinkNode);

    const source = new DESSource(sourceNode);
    source.InterArrivalTime = 2;
    const station1 = new DESStation(station1Node);
    station1.ProcessingTime = 1;
    station1.MaxCapacity = 1;
    const station2 = new DESStation(station2Node);
    station2.ProcessingTime = 8;
    station2.MaxCapacity = 1;
    const sink = new DESSink(sinkNode);

    source.nextComponents = [station1];
    station1.nextComponents = [station2];
    station1.previousComponents = [source];
    station2.nextComponents = [sink];
    station2.previousComponents = [station1];
    sink.previousComponents = [station2];

    manager.registerComponent(source);
    manager.registerComponent(station1);
    manager.registerComponent(station2);
    manager.registerComponent(sink);

    source.init(ctx);
    station1.init(ctx);
    station2.init(ctx);
    sink.init(ctx);
    source.start();

    // Run 25 seconds
    for (let t = 0; t < 250; t++) {
      manager.processAnimated(0.1);
    }

    // Station2 is slow (8s), so station1 should have been blocked at some point
    // But eventually MUs flow through
    expect(sink.totalConsumed).toBeGreaterThanOrEqual(2);
  });

  it('multiple NextComponents with routing hook', () => {
    scene = createScene();
    const ctx = makeContext(scene);

    const sourceNode = createNode('Source', 0, 0, 0);
    const stationNode = createNode('Station', 1, 0, 0);
    const sink1Node = createNode('SinkA', 2, 0, 0);
    const sink2Node = createNode('SinkB', 2, 0, 1);
    scene.add(sourceNode, stationNode, sink1Node, sink2Node);

    const source = new DESSource(sourceNode);
    source.InterArrivalTime = 2;
    const station = new DESStation(stationNode);
    station.ProcessingTime = 1;
    const sinkA = new DESSink(sink1Node);
    const sinkB = new DESSink(sink2Node);

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

    manager.registerComponent(source);
    manager.registerComponent(station);
    manager.registerComponent(sinkA);
    manager.registerComponent(sinkB);

    source.init(ctx);
    station.init(ctx);
    sinkA.init(ctx);
    sinkB.init(ctx);
    source.start();

    // Run 20 seconds
    for (let t = 0; t < 200; t++) {
      manager.processAnimated(0.1);
    }

    // Both sinks should have received MUs
    expect(sinkA.totalConsumed).toBeGreaterThanOrEqual(1);
    expect(sinkB.totalConsumed).toBeGreaterThanOrEqual(1);
  });
});
