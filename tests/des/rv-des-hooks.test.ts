// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TestDESHooks -- DES callback hook tests.
 *
 * Tests behaviour processing time, onSelectNext routing and onCanAccept filtering.
 * Script-controlled timing and holding/downstream-ready notification are covered
 * by script-station.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D, Scene } from 'three';
import { DESManager } from '@rv/plugins/des/rv-des-manager';
import { createDESMU, resetDESMUCounter } from '@rv/plugins/des/rv-des-mu';
import { DESComponent } from '@rv/plugins/des/rv-des-component';
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

function createNode(name: string): Object3D {
  const n = new Object3D();
  n.name = name;
  return n;
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
    resetDESMUCounter();
    scene = new Scene();
  });

  it('Station behaviour waits for its configured processing time', () => {
    const sourceNode = createNode('Source');
    const stationNode = createNode('Station');
    const sinkNode = createNode('Sink');
    scene.add(sourceNode, stationNode, sinkNode);

    sourceNode.userData.realvirtual = { Source: { Interval: 5 } };
    stationNode.userData.realvirtual = { Station: { ProcessingTime: 10 } };
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

    runner.start([], { root: scene });

    runSimulation(manager, 9);
    expect(sink.totalProcessed).toBe(0);
    runSimulation(manager, 2);
    expect(sink.totalProcessed).toBeGreaterThanOrEqual(1);
  });

  it('Station behaviour uses a shorter configured processing time', () => {
    const sourceNode = createNode('Source');
    const stationNode = createNode('Station');
    const sinkNode = createNode('Sink');
    scene.add(sourceNode, stationNode, sinkNode);

    sourceNode.userData.realvirtual = { Source: { Interval: 3 } };
    stationNode.userData.realvirtual = { Station: { ProcessingTime: 2 } };
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

    runner.start([], { root: scene });

    runSimulation(manager, 1);
    expect(sink.totalProcessed).toBe(0);
    runSimulation(manager, 2);
    expect(sink.totalProcessed).toBeGreaterThanOrEqual(1);
  });

  it('onSelectNext routes MUs to different outputs', () => {
    const sourceNode = createNode('Source');
    const stationNode = createNode('Station');
    const sink1Node = createNode('SinkGood');
    const sink2Node = createNode('SinkReject');
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
    const sinkGood = component(runner, sink1Node);
    const sinkReject = component(runner, sink2Node);

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

    runner.start([], { root: scene });

    runSimulation(manager, 15);

    expect(sinkGood.totalProcessed).toBeGreaterThanOrEqual(1);
    expect(sinkReject.totalProcessed).toBeGreaterThanOrEqual(1);
  });

  it('onCanAccept filters MUs on the base component contract', () => {
    // MaterialFlowAdapter uses def.des.canAccept instead; PalletYard probes
    // still use the base DESComponent callback.
    const station = new DESComponent(createNode('Station'));
    station.onCanAccept = (mu) => (mu.prop['idx'] as number) % 2 === 0;
    const even = createDESMU(0, null, manager);
    const odd = createDESMU(0, null, manager);
    even.prop['idx'] = 0;
    odd.prop['idx'] = 1;
    expect(station.canAccept(even)).toBe(true);
    expect(station.canAccept(odd)).toBe(false);
  });
});
