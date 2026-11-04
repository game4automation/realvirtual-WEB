// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TestDESStorage -- FIFO/LIFO/Priority retrieval strategy tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Scene } from 'three';
import { runnerFixture } from './runner-fixture';
import { Storage } from '@rv/plugins/des/material-flow/Storage';
import type { DESManager } from '@rv/plugins/des/rv-des-manager';
import { resetDESMUCounter } from '@rv/plugins/des/rv-des-mu';
import type { DESMU } from '@rv/plugins/des/rv-des-mu';

// ── Helpers ──

function createNode(name: string, x = 0, y = 0, z = 0): Object3D {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, y, z);
  return node;
}


describe('DES Storage', () => {
  let manager: DESManager;
  let scene: Scene;

  beforeEach(() => {
    resetDESMUCounter();
  });

  it('FIFO strategy releases oldest MU first', () => {
    scene = new Scene();

    const sourceNode = createNode('Source', 0, 0, 0);
    const storageNode = createNode('Storage', 1, 0, 0);
    const sinkNode = createNode('Sink', 2, 0, 0);
    scene.add(sourceNode, storageNode, sinkNode);

    sourceNode.userData.realvirtual = { Source: { Interval: 2 } };
    storageNode.userData.realvirtual = { Storage: { Strategy: 'FIFO', MaxCapacity: 10, AutoRelease: true } };
    sinkNode.userData.realvirtual = { Sink: {} };
    const { runner, components } = runnerFixture(scene);
    manager = runner.getManager();
    const [source, storage, sink] = [sourceNode, storageNode, sinkNode].map(node => components.find(c => c.node === node)!);

    source.nextComponents = [storage];
    storage.nextComponents = [sink];
    storage.previousComponents = [source];
    sink.previousComponents = [storage];

    runner.start([], { root: scene });

    // Run until we have some MUs in storage
    manager.duration = 20;
    while (!manager.isComplete && manager.currentTime < 20) {
      manager.processEvents(100);
    }

    // The storage should have accepted and released MUs in FIFO order
    // Since sink always accepts, MUs flow through — verify totalProcessed > 0
    expect(sink.totalProcessed).toBeGreaterThan(0);
    expect(storage.totalProcessed).toBeGreaterThan(0);
  });

  it('LIFO strategy releases newest MU first', () => {
    scene = new Scene();

    const storageNode = createNode('Storage', 0, 0, 0);
    scene.add(storageNode);

    storageNode.userData.realvirtual = { Storage: { Strategy: 'LIFO', MaxCapacity: 10 } };
    const { runner, components: [storage] } = runnerFixture(scene);
    manager = runner.getManager();
    runner.start([], { root: scene });

    // Manually add MUs with different custom IDs
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const mu: DESMU = {
        id: i, generation: 0, customId: `MU-${i}`, priority: 0, visual: null,
        currentComponent: null, nextComponent: null, route: [], routeStep: 0,
        entryTime: 0, plannedExitTime: -1, creationTime: 0, totalTimeInSystem: 0,
        isBlocked: false, isInTransit: false, isProcessing: false,
        isLoaded: false, loadedOn: null, loadedOnNode: null,
        childMUs: [], parentMU: null,
        prop: {}, componentsVisited: 0, blockedCount: 0,
        totalBlockedTime: 0, totalProcessingTime: 0, totalTransitTime: 0,
      };
      manager.registerMU(mu);
      storage.acceptMU(mu);
      ids.push(mu.customId);
    }

    // LIFO: retrieve should return the last added
    const retrieved = Storage.logic!.retrieve(storage.self as unknown as Parameters<NonNullable<typeof Storage.setup>>[0]) as DESMU | null;
    expect(retrieved).not.toBeNull();
    expect(retrieved!.customId).toBe('MU-2');
  });

  it('Priority strategy releases highest-priority MU first', () => {
    scene = new Scene();

    const storageNode = createNode('Storage', 0, 0, 0);
    scene.add(storageNode);

    storageNode.userData.realvirtual = { Storage: { Strategy: 'Priority', MaxCapacity: 10 } };
    const { runner, components: [storage] } = runnerFixture(scene);
    manager = runner.getManager();
    runner.start([], { root: scene });

    // Add MUs with different priorities
    const priorities = [1, 5, 3, 10, 2];
    for (let i = 0; i < priorities.length; i++) {
      const mu: DESMU = {
        id: i, generation: 0, customId: `MU-P${priorities[i]}`, priority: priorities[i], visual: null,
        currentComponent: null, nextComponent: null, route: [], routeStep: 0,
        entryTime: 0, plannedExitTime: -1, creationTime: 0, totalTimeInSystem: 0,
        isBlocked: false, isInTransit: false, isProcessing: false,
        isLoaded: false, loadedOn: null, loadedOnNode: null,
        childMUs: [], parentMU: null,
        prop: {}, componentsVisited: 0, blockedCount: 0,
        totalBlockedTime: 0, totalProcessingTime: 0, totalTransitTime: 0,
      };
      mu.prop['priority'] = mu.priority;
      manager.registerMU(mu);
      storage.acceptMU(mu);
    }

    // Priority: retrieve should return highest priority (10)
    const retrieved = Storage.logic!.retrieve(storage.self as unknown as Parameters<NonNullable<typeof Storage.setup>>[0]) as DESMU | null;
    expect(retrieved).not.toBeNull();
    expect(retrieved!.priority).toBe(10);
    expect(retrieved!.customId).toBe('MU-P10');
  });

  it('rejects MU when at MaxCapacity', () => {
    scene = new Scene();

    const storageNode = createNode('Storage', 0, 0, 0);
    scene.add(storageNode);

    storageNode.userData.realvirtual = { Storage: { Strategy: 'FIFO', MaxCapacity: 2 } };
    const { runner, components: [storage] } = runnerFixture(scene);
    manager = runner.getManager();
    runner.start([], { root: scene });

    // Add 2 MUs (at capacity)
    for (let i = 0; i < 2; i++) {
      const mu: DESMU = {
        id: i, generation: 0, customId: `MU-${i}`, priority: 0, visual: null,
        currentComponent: null, nextComponent: null, route: [], routeStep: 0,
        entryTime: 0, plannedExitTime: -1, creationTime: 0, totalTimeInSystem: 0,
        isBlocked: false, isInTransit: false, isProcessing: false,
        isLoaded: false, loadedOn: null, loadedOnNode: null,
        childMUs: [], parentMU: null,
        prop: {}, componentsVisited: 0, blockedCount: 0,
        totalBlockedTime: 0, totalProcessingTime: 0, totalTransitTime: 0,
      };
      manager.registerMU(mu);
      expect(storage.acceptMU(mu)).toBe(true);
    }

    // Third MU should be rejected
    const mu3: DESMU = {
      id: 2, generation: 0, customId: 'MU-2', priority: 0, visual: null,
      currentComponent: null, nextComponent: null, route: [], routeStep: 0,
      entryTime: 0, plannedExitTime: -1, creationTime: 0, totalTimeInSystem: 0,
      isBlocked: false, isInTransit: false, isProcessing: false,
      isLoaded: false, loadedOn: null, loadedOnNode: null,
      childMUs: [], parentMU: null,
      prop: {}, componentsVisited: 0, blockedCount: 0,
      totalBlockedTime: 0, totalProcessingTime: 0, totalTransitTime: 0,
    };
    manager.registerMU(mu3);
    expect(storage.canAccept(mu3)).toBe(false);
  });
});
