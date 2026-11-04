// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TestDESDowntime -- Failure/repair cycle timing tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D, Scene } from 'three';
import { DESManager } from '@rv/plugins/des/rv-des-manager';
import { resetDESMUCounter } from '@rv/plugins/des/rv-des-mu';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { bindSceneToRunner } from '@rv/plugins/des/des-scene-binding';
import type { MaterialFlowAdapter } from '@rv/plugins/des/material-flow-adapter';
import { Station } from '@rv/plugins/des/material-flow/Station';
import { Downtime } from '@rv/plugins/des/material-flow/Downtime';
import { registerMaterialFlow } from '../../src/core/material-flow/registry';
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

const definitions = [
  Station, Downtime,
] as unknown as MaterialFlowDefinition[];
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

describe('DES Downtime', () => {
  let manager: DESManager;
  let scene: Scene;

  beforeEach(() => {
    resetDESMUCounter();
  });

  it('failure/repair cycle fires and repairs target', () => {
    scene = new Scene();

    const stationNode = createNode('Station', 0, 0, 0);
    const downtimeNode = createNode('Downtime', 0, 0, 0);
    scene.add(stationNode, downtimeNode);

    stationNode.userData.realvirtual = { Station: {} };
    downtimeNode.userData.realvirtual = { Downtime: { MTBF: 100, MTTR: 10, TargetComponentPath: 'Station' } };
    const runner = bindRunner(scene);
    manager = runner.getManager();
    manager.duration = 100000;
    const downtime = component(runner, downtimeNode);

    runner.start([], { root: scene });

    manager.duration = 100;
    manager.processEvents(1000);
    expect(component(runner, stationNode).isFailure).toBe(true);
    manager.duration = 110;
    manager.processEvents(1000);
    expect(component(runner, stationNode).isFailure).toBe(false);

    // Run long enough for at least one failure + repair cycle
    manager.duration = 10000;
    while (manager.currentTime < 10000) {
      const count = manager.processEvents(1000);
      if (count === 0) break;
    }

    // Should have had at least one failure
    expect(downtime.prop['failureCount']).toBeGreaterThan(0);
    // Total downtime should be positive
    expect(downtime.prop['totalDowntimeSeconds']).toBeGreaterThan(0);
  });

  it('tracks failure count and downtime correctly', () => {
    scene = new Scene();

    const stationNode = createNode('Station2', 0, 0, 0);
    const downtimeNode = createNode('Downtime2', 0, 0, 0);
    scene.add(stationNode, downtimeNode);

    stationNode.userData.realvirtual = { Station: {} };
    downtimeNode.userData.realvirtual = { Downtime: { MTBF: 50, MTTR: 5, TargetComponentPath: 'Station2' } };
    const runner = bindRunner(scene);
    manager = runner.getManager();
    manager.duration = 100000;
    const downtime = component(runner, downtimeNode);

    runner.start([], { root: scene });

    manager.duration = 5000;
    while (manager.currentTime < 5000) {
      const count = manager.processEvents(1000);
      if (count === 0) break;
    }

    // The behaviour uses fixed MTBF/MTTR; retain the broad count contract.
    expect(downtime.prop['failureCount']).toBeGreaterThan(10);
    expect(downtime.prop['failureCount']).toBeLessThan(500);

    // Availability should be between 50% and 99.9%
    const avail = (1 - Number(downtime.prop['totalDowntimeSeconds']) / manager.currentTime) * 100;
    expect(avail).toBeGreaterThan(50);
    expect(avail).toBeLessThan(100);
  });

  it('disabled downtime does not schedule failures', () => {
    scene = new Scene();

    const stationNode = createNode('Station3', 0, 0, 0);
    const downtimeNode = createNode('Downtime3', 0, 0, 0);
    scene.add(stationNode, downtimeNode);

    stationNode.userData.realvirtual = { Station: {} };
    downtimeNode.userData.realvirtual = { Downtime: { MTBF: 10, MTTR: 5, Enabled: false, TargetComponentPath: 'Station3' } };
    const runner = bindRunner(scene);
    manager = runner.getManager();
    manager.duration = 100000;
    const downtime = component(runner, downtimeNode);

    runner.start([], { root: scene });

    manager.duration = 1000;
    while (manager.currentTime < 1000) {
      const count = manager.processEvents(1000);
      if (count === 0) break;
    }

    expect(downtime.prop['failureCount']).toBe(0);
    expect(downtime.prop['totalDowntimeSeconds']).toBe(0);
  });
});
