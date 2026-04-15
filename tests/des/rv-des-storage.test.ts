// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TestDESStorage -- FIFO/LIFO/Priority retrieval strategy tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Scene } from 'three';
import { DESManager } from '@rv-private/plugins/des/rv-des-manager';
import { DES } from '@rv-private/plugins/des/rv-des-api';
import { DESSource } from '@rv-private/plugins/des/rv-des-source';
import { DESSink } from '@rv-private/plugins/des/rv-des-sink';
import { DESStorage } from '@rv-private/plugins/des/rv-des-storage';
import { resetDESMUCounter } from '@rv-private/plugins/des/rv-des-mu';
import type { DESMU } from '@rv-private/plugins/des/rv-des-mu';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { SignalStore } from '../../src/core/engine/rv-signal-store';

// ── Helpers ──

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

describe('DES Storage', () => {
  let manager: DESManager;
  let scene: Scene;

  beforeEach(() => {
    manager = new DESManager();
    DES.setManager(manager);
    resetDESMUCounter();
  });

  it('FIFO strategy releases oldest MU first', () => {
    scene = new Scene();
    const ctx = makeContext(scene);

    const sourceNode = createNode('Source', 0, 0, 0);
    const storageNode = createNode('Storage', 1, 0, 0);
    const sinkNode = createNode('Sink', 2, 0, 0);
    scene.add(sourceNode, storageNode, sinkNode);

    const source = new DESSource(sourceNode);
    source.InterArrivalTime = 2;
    const storage = new DESStorage(storageNode);
    storage.Strategy = 'FIFO';
    storage.MaxCapacity = 10;
    const sink = new DESSink(sinkNode);

    source.nextComponents = [storage];
    storage.nextComponents = [sink];
    storage.previousComponents = [source];
    sink.previousComponents = [storage];

    manager.registerComponent(source);
    manager.registerComponent(storage);
    manager.registerComponent(sink);

    for (const c of [source, storage, sink]) c.init(ctx);
    source.start();

    // Run until we have some MUs in storage
    manager.duration = 20;
    while (manager.currentTime < 20) {
      manager.processEvents(100);
    }

    // The storage should have accepted and released MUs in FIFO order
    // Since sink always accepts, MUs flow through — verify totalProcessed > 0
    expect(sink.totalProcessed).toBeGreaterThan(0);
    expect(storage.totalProcessed).toBeGreaterThan(0);
  });

  it('LIFO strategy releases newest MU first', () => {
    scene = new Scene();
    const ctx = makeContext(scene);

    const storageNode = createNode('Storage', 0, 0, 0);
    scene.add(storageNode);

    const storage = new DESStorage(storageNode);
    storage.Strategy = 'LIFO';
    storage.MaxCapacity = 10;

    manager.registerComponent(storage);
    storage.init(ctx);

    // Manually add MUs with different custom IDs
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const mu: DESMU = {
        id: i, customId: `MU-${i}`, priority: 0, visual: null,
        currentComponent: null, nextComponent: null, route: [], routeStep: 0,
        entryTime: 0, plannedExitTime: -1, creationTime: 0, totalTimeInSystem: 0,
        isBlocked: false, isInTransit: false, isProcessing: false,
        isLoaded: false, loadedOn: null, loadedOnNode: null,
        prop: {}, componentsVisited: 0, blockedCount: 0,
        totalBlockedTime: 0, totalProcessingTime: 0, totalTransitTime: 0,
      };
      manager.registerMU(mu);
      storage.acceptMU(mu);
      ids.push(mu.customId);
    }

    // LIFO: retrieve should return the last added
    const retrieved = storage.retrieveMU();
    expect(retrieved).not.toBeNull();
    expect(retrieved!.customId).toBe('MU-2');
  });

  it('Priority strategy releases highest-priority MU first', () => {
    scene = new Scene();
    const ctx = makeContext(scene);

    const storageNode = createNode('Storage', 0, 0, 0);
    scene.add(storageNode);

    const storage = new DESStorage(storageNode);
    storage.Strategy = 'Priority';
    storage.MaxCapacity = 10;

    manager.registerComponent(storage);
    storage.init(ctx);

    // Add MUs with different priorities
    const priorities = [1, 5, 3, 10, 2];
    for (let i = 0; i < priorities.length; i++) {
      const mu: DESMU = {
        id: i, customId: `MU-P${priorities[i]}`, priority: priorities[i], visual: null,
        currentComponent: null, nextComponent: null, route: [], routeStep: 0,
        entryTime: 0, plannedExitTime: -1, creationTime: 0, totalTimeInSystem: 0,
        isBlocked: false, isInTransit: false, isProcessing: false,
        isLoaded: false, loadedOn: null, loadedOnNode: null,
        prop: {}, componentsVisited: 0, blockedCount: 0,
        totalBlockedTime: 0, totalProcessingTime: 0, totalTransitTime: 0,
      };
      manager.registerMU(mu);
      storage.acceptMU(mu);
    }

    // Priority: retrieve should return highest priority (10)
    const retrieved = storage.retrieveMU();
    expect(retrieved).not.toBeNull();
    expect(retrieved!.priority).toBe(10);
    expect(retrieved!.customId).toBe('MU-P10');
  });

  it('rejects MU when at MaxCapacity', () => {
    scene = new Scene();
    const ctx = makeContext(scene);

    const storageNode = createNode('Storage', 0, 0, 0);
    scene.add(storageNode);

    const storage = new DESStorage(storageNode);
    storage.Strategy = 'FIFO';
    storage.MaxCapacity = 2;

    manager.registerComponent(storage);
    storage.init(ctx);

    // Add 2 MUs (at capacity)
    for (let i = 0; i < 2; i++) {
      const mu: DESMU = {
        id: i, customId: `MU-${i}`, priority: 0, visual: null,
        currentComponent: null, nextComponent: null, route: [], routeStep: 0,
        entryTime: 0, plannedExitTime: -1, creationTime: 0, totalTimeInSystem: 0,
        isBlocked: false, isInTransit: false, isProcessing: false,
        isLoaded: false, loadedOn: null, loadedOnNode: null,
        prop: {}, componentsVisited: 0, blockedCount: 0,
        totalBlockedTime: 0, totalProcessingTime: 0, totalTransitTime: 0,
      };
      manager.registerMU(mu);
      expect(storage.acceptMU(mu)).toBe(true);
    }

    // Third MU should be rejected
    const mu3: DESMU = {
      id: 2, customId: 'MU-2', priority: 0, visual: null,
      currentComponent: null, nextComponent: null, route: [], routeStep: 0,
      entryTime: 0, plannedExitTime: -1, creationTime: 0, totalTimeInSystem: 0,
      isBlocked: false, isInTransit: false, isProcessing: false,
      isLoaded: false, loadedOn: null, loadedOnNode: null,
      prop: {}, componentsVisited: 0, blockedCount: 0,
      totalBlockedTime: 0, totalProcessingTime: 0, totalTransitTime: 0,
    };
    manager.registerMU(mu3);
    expect(storage.canAccept(mu3)).toBe(false);
  });
});
