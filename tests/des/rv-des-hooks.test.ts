// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TestDESHooks -- DES callback hook tests.
 *
 * Tests onGetProcessingTime override, -1 fallthrough, Infinity hold,
 * onSelectNext routing, onCanAccept filter, onMUCreated property flow,
 * and onProcessingComplete modification.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Scene } from 'three';
import { DESManager, DESMode } from '@rv-private/plugins/des/rv-des-manager';
import { DES } from '@rv-private/plugins/des/rv-des-api';
import { DESSource } from '@rv-private/plugins/des/rv-des-source';
import { DESSink } from '@rv-private/plugins/des/rv-des-sink';
import { DESStation } from '@rv-private/plugins/des/rv-des-station';
import { DESConveyor } from '@rv-private/plugins/des/rv-des-conveyor';
import { resetDESMUCounter } from '@rv-private/plugins/des/rv-des-mu';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { SignalStore } from '../../src/core/engine/rv-signal-store';

function createNode(name: string): Object3D {
  const n = new Object3D();
  n.name = name;
  return n;
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

function runSimulation(manager: DESManager, seconds: number): void {
  const steps = Math.ceil(seconds / 0.1);
  for (let i = 0; i < steps; i++) {
    manager.processAnimated(0.1);
  }
}

describe('DES Hooks', () => {
  let manager: DESManager;
  let scene: Scene;

  beforeEach(() => {
    manager = new DESManager();
    manager.mode = DESMode.Animated;
    DES.setManager(manager);
    resetDESMUCounter();
    scene = new Scene();
  });

  it('onGetProcessingTime overrides fixed time', () => {
    const ctx = makeContext(scene);
    const sourceNode = createNode('Source');
    const stationNode = createNode('Station');
    const sinkNode = createNode('Sink');
    scene.add(sourceNode, stationNode, sinkNode);

    const source = new DESSource(sourceNode);
    source.InterArrivalTime = 5;
    const station = new DESStation(stationNode);
    station.ProcessingTime = 10; // default 10s
    const sink = new DESSink(sinkNode);

    // Override: use 1s instead of 10s
    station.onGetProcessingTime = (_mu) => 1.0;

    source.nextComponents = [station];
    station.nextComponents = [sink];
    station.previousComponents = [source];
    sink.previousComponents = [station];

    manager.registerComponent(source);
    manager.registerComponent(station);
    manager.registerComponent(sink);
    source.init(ctx); station.init(ctx); sink.init(ctx);
    source.start();

    runSimulation(manager, 15);

    // With 1s processing, multiple MUs should pass through quickly
    expect(sink.totalConsumed).toBeGreaterThanOrEqual(1);
  });

  it('onGetProcessingTime returns -1 for fallthrough to default', () => {
    const ctx = makeContext(scene);
    const sourceNode = createNode('Source');
    const stationNode = createNode('Station');
    const sinkNode = createNode('Sink');
    scene.add(sourceNode, stationNode, sinkNode);

    const source = new DESSource(sourceNode);
    source.InterArrivalTime = 3;
    const station = new DESStation(stationNode);
    station.ProcessingTime = 2;
    const sink = new DESSink(sinkNode);

    // Return -1: fall through to fixed ProcessingTime (2s)
    station.onGetProcessingTime = (_mu) => -1;

    source.nextComponents = [station];
    station.nextComponents = [sink];
    station.previousComponents = [source];
    sink.previousComponents = [station];

    manager.registerComponent(source);
    manager.registerComponent(station);
    manager.registerComponent(sink);
    source.init(ctx); station.init(ctx); sink.init(ctx);
    source.start();

    runSimulation(manager, 12);

    // Default 2s processing, source at 3s intervals => MUs flow through
    expect(sink.totalConsumed).toBeGreaterThanOrEqual(1);
  });

  it('Infinity hold keeps MU until releaseProcessing', () => {
    const ctx = makeContext(scene);
    const sourceNode = createNode('Source');
    const stationNode = createNode('Station');
    const sinkNode = createNode('Sink');
    scene.add(sourceNode, stationNode, sinkNode);

    const source = new DESSource(sourceNode);
    source.InterArrivalTime = 2;
    const station = new DESStation(stationNode);
    station.ProcessingTime = 1;
    const sink = new DESSink(sinkNode);

    // Hold indefinitely
    station.onGetProcessingTime = (_mu) => Infinity;

    source.nextComponents = [station];
    station.nextComponents = [sink];
    station.previousComponents = [source];
    sink.previousComponents = [station];

    manager.registerComponent(source);
    manager.registerComponent(station);
    manager.registerComponent(sink);
    source.init(ctx); station.init(ctx); sink.init(ctx);
    source.start();

    runSimulation(manager, 5);

    // MU should be held — nothing in sink
    expect(sink.totalConsumed).toBe(0);

    // Now release
    station.releaseProcessing();
    runSimulation(manager, 1);

    // After release, MU should reach sink
    expect(sink.totalConsumed).toBe(1);
  });

  it('onSelectNext routes MUs to different outputs', () => {
    const ctx = makeContext(scene);
    const sourceNode = createNode('Source');
    const stationNode = createNode('Station');
    const sink1Node = createNode('SinkGood');
    const sink2Node = createNode('SinkReject');
    scene.add(sourceNode, stationNode, sink1Node, sink2Node);

    const source = new DESSource(sourceNode);
    source.InterArrivalTime = 2;
    const station = new DESStation(stationNode);
    station.ProcessingTime = 1;
    const sinkGood = new DESSink(sink1Node);
    const sinkReject = new DESSink(sink2Node);

    let muIdx = 0;
    station.onSelectNext = (candidates, _mu) => {
      // Alternate: even -> first (Good), odd -> second (Reject)
      return candidates[muIdx++ % 2];
    };

    source.nextComponents = [station];
    station.nextComponents = [sinkGood, sinkReject];
    station.previousComponents = [source];
    sinkGood.previousComponents = [station];
    sinkReject.previousComponents = [station];

    manager.registerComponent(source);
    manager.registerComponent(station);
    manager.registerComponent(sinkGood);
    manager.registerComponent(sinkReject);
    source.init(ctx); station.init(ctx); sinkGood.init(ctx); sinkReject.init(ctx);
    source.start();

    runSimulation(manager, 15);

    expect(sinkGood.totalConsumed).toBeGreaterThanOrEqual(1);
    expect(sinkReject.totalConsumed).toBeGreaterThanOrEqual(1);
  });

  it('onCanAccept filters MUs', () => {
    const ctx = makeContext(scene);
    const sourceNode = createNode('Source');
    const stationNode = createNode('Station');
    const sinkNode = createNode('Sink');
    scene.add(sourceNode, stationNode, sinkNode);

    const source = new DESSource(sourceNode);
    source.InterArrivalTime = 2;
    const station = new DESStation(stationNode);
    station.ProcessingTime = 1;
    const sink = new DESSink(sinkNode);

    let muCount = 0;
    source.onMUCreated = (mu) => {
      mu.prop['idx'] = muCount++;
    };

    // Only accept even-indexed MUs
    station.onCanAccept = (mu) => {
      return (mu.prop['idx'] as number) % 2 === 0;
    };

    source.nextComponents = [station];
    station.nextComponents = [sink];
    station.previousComponents = [source];
    sink.previousComponents = [station];

    manager.registerComponent(source);
    manager.registerComponent(station);
    manager.registerComponent(sink);
    source.init(ctx); station.init(ctx); sink.init(ctx);
    source.start();

    runSimulation(manager, 12);

    // Only even MUs get through — sink should have received some
    // Odd MUs are rejected (station.canAccept returns false)
    expect(sink.totalConsumed).toBeGreaterThanOrEqual(1);
  });

  it('onMUCreated sets properties that flow through pipeline', () => {
    const ctx = makeContext(scene);
    const sourceNode = createNode('Source');
    const stationNode = createNode('Station');
    const sinkNode = createNode('Sink');
    scene.add(sourceNode, stationNode, sinkNode);

    const source = new DESSource(sourceNode);
    source.InterArrivalTime = 3;
    const station = new DESStation(stationNode);
    station.ProcessingTime = 1;
    const sink = new DESSink(sinkNode);

    // Set property at source
    source.onMUCreated = (mu) => {
      mu.prop['productType'] = 'WidgetA';
      mu.prop['weight'] = 4.2;
    };

    // Verify property at station
    const receivedProps: Record<string, unknown>[] = [];
    station.onMUEnter = (mu) => {
      receivedProps.push({ ...mu.prop });
    };

    source.nextComponents = [station];
    station.nextComponents = [sink];
    station.previousComponents = [source];
    sink.previousComponents = [station];

    manager.registerComponent(source);
    manager.registerComponent(station);
    manager.registerComponent(sink);
    source.init(ctx); station.init(ctx); sink.init(ctx);
    source.start();

    runSimulation(manager, 8);

    expect(receivedProps.length).toBeGreaterThanOrEqual(1);
    expect(receivedProps[0]['productType']).toBe('WidgetA');
    expect(receivedProps[0]['weight']).toBe(4.2);
  });

  it('onProcessingComplete modifies MU before transfer', () => {
    const ctx = makeContext(scene);
    const sourceNode = createNode('Source');
    const stationNode = createNode('Station');
    const sinkNode = createNode('Sink');
    scene.add(sourceNode, stationNode, sinkNode);

    const source = new DESSource(sourceNode);
    source.InterArrivalTime = 3;
    const station = new DESStation(stationNode);
    station.ProcessingTime = 1;
    const sink = new DESSink(sinkNode);

    station.onProcessingComplete = (mu) => {
      mu.prop['inspected'] = true;
      mu.prop['qualityScore'] = 95;
    };

    const destroyedProps: Record<string, unknown>[] = [];
    sink.onMUDestroyed = (mu) => {
      destroyedProps.push({ ...mu.prop });
    };

    source.nextComponents = [station];
    station.nextComponents = [sink];
    station.previousComponents = [source];
    sink.previousComponents = [station];

    manager.registerComponent(source);
    manager.registerComponent(station);
    manager.registerComponent(sink);
    source.init(ctx); station.init(ctx); sink.init(ctx);
    source.start();

    runSimulation(manager, 8);

    expect(destroyedProps.length).toBeGreaterThanOrEqual(1);
    expect(destroyedProps[0]['inspected']).toBe(true);
    expect(destroyedProps[0]['qualityScore']).toBe(95);
  });
});
