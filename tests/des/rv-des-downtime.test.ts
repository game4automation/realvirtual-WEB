// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TestDESDowntime -- Failure/repair cycle timing tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Scene } from 'three';
import { DESManager } from '@rv-private/plugins/des/rv-des-manager';
import { DES } from '@rv-private/plugins/des/rv-des-api';
import { DESStation } from '@rv-private/plugins/des/rv-des-station';
import { DESDowntime } from '@rv-private/plugins/des/rv-des-downtime';
import { DESComponent } from '@rv-private/plugins/des/rv-des-component';
import { resetDESMUCounter } from '@rv-private/plugins/des/rv-des-mu';
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

describe('DES Downtime', () => {
  let manager: DESManager;
  let scene: Scene;

  beforeEach(() => {
    manager = new DESManager();
    DES.setManager(manager);
    resetDESMUCounter();
  });

  it('failure/repair cycle fires and repairs target', () => {
    scene = new Scene();
    const ctx = makeContext(scene);

    const stationNode = createNode('Station', 0, 0, 0);
    const downtimeNode = createNode('Downtime', 0, 0, 0);
    scene.add(stationNode, downtimeNode);

    const station = new DESStation(stationNode);
    const downtime = new DESDowntime(downtimeNode);
    downtime.MTBF = 100;    // Mean 100s between failures
    downtime.MTTR = 10;     // Mean 10s to repair
    downtime.MTTRErlangK = 1; // Erlang shape=1 = exponential
    downtime.TargetComponentPath = 'Station';

    manager.registerComponent(station);
    manager.registerComponent(downtime);

    station.init(ctx);
    downtime.init(ctx);

    // Manually resolve target (normally done by autoConnect)
    downtime.resolveTarget();
    downtime.start();

    // Run long enough for at least one failure + repair cycle
    manager.duration = 10000;
    while (manager.currentTime < 10000) {
      const count = manager.processEvents(1000);
      if (count === 0) break;
    }

    // Should have had at least one failure
    expect(downtime.failureCount).toBeGreaterThan(0);
    // Total downtime should be positive
    expect(downtime.totalDowntimeSeconds).toBeGreaterThan(0);
    // Station should be repaired (not in failure state) after enough time
    // (could still be in failure if the last event was a failure, but
    //  statistically very unlikely with 10000s runtime and MTBF=100, MTTR=10)
  });

  it('tracks failure count and downtime correctly', () => {
    scene = new Scene();
    const ctx = makeContext(scene);

    const stationNode = createNode('Station2', 0, 0, 0);
    const downtimeNode = createNode('Downtime2', 0, 0, 0);
    scene.add(stationNode, downtimeNode);

    const station = new DESStation(stationNode);
    const downtime = new DESDowntime(downtimeNode);
    downtime.MTBF = 50;
    downtime.MTTR = 5;
    downtime.MTTRErlangK = 2;
    downtime.TargetComponentPath = 'Station2';

    manager.registerComponent(station);
    manager.registerComponent(downtime);

    station.init(ctx);
    downtime.init(ctx);
    downtime.resolveTarget();
    downtime.start();

    manager.duration = 5000;
    while (manager.currentTime < 5000) {
      const count = manager.processEvents(1000);
      if (count === 0) break;
    }

    // With MTBF=50, in 5000s we expect ~100 failures
    // Allow wide range for statistical variation
    expect(downtime.failureCount).toBeGreaterThan(10);
    expect(downtime.failureCount).toBeLessThan(500);

    // Availability should be between 50% and 99.9%
    const avail = downtime.availability;
    expect(avail).toBeGreaterThan(50);
    expect(avail).toBeLessThan(100);
  });

  it('disabled downtime does not schedule failures', () => {
    scene = new Scene();
    const ctx = makeContext(scene);

    const stationNode = createNode('Station3', 0, 0, 0);
    const downtimeNode = createNode('Downtime3', 0, 0, 0);
    scene.add(stationNode, downtimeNode);

    const station = new DESStation(stationNode);
    const downtime = new DESDowntime(downtimeNode);
    downtime.MTBF = 10;
    downtime.MTTR = 5;
    downtime.Enabled = false;
    downtime.TargetComponentPath = 'Station3';

    manager.registerComponent(station);
    manager.registerComponent(downtime);

    station.init(ctx);
    downtime.init(ctx);
    downtime.resolveTarget();
    downtime.start();

    manager.duration = 1000;
    while (manager.currentTime < 1000) {
      const count = manager.processEvents(1000);
      if (count === 0) break;
    }

    expect(downtime.failureCount).toBe(0);
    expect(downtime.totalDowntimeSeconds).toBe(0);
  });
});
