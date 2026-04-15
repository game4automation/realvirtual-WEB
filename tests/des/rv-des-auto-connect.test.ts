// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TestDESAutoConnect -- Auto-connect algorithm tests.
 *
 * Tests distance-based connection, maxDistance filtering,
 * and PreviousComponents auto-computation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Scene } from 'three';
import { DESManager } from '@rv-private/plugins/des/rv-des-manager';
import { DES } from '@rv-private/plugins/des/rv-des-api';
import { DESComponent } from '@rv-private/plugins/des/rv-des-component';
import { DESSource } from '@rv-private/plugins/des/rv-des-source';
import { DESSink } from '@rv-private/plugins/des/rv-des-sink';
import { DESConveyor } from '@rv-private/plugins/des/rv-des-conveyor';
import { autoConnect, computePreviousComponents } from '@rv-private/plugins/des/rv-des-connection';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { SignalStore } from '../../src/core/engine/rv-signal-store';

function createNode(name: string, x = 0, y = 0, z = 0): Object3D {
  const n = new Object3D();
  n.name = name;
  n.position.set(x, y, z);
  // Update world matrix so getWorldPosition works
  n.updateMatrixWorld(true);
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

describe('DES Auto-Connect', () => {
  let manager: DESManager;
  let scene: Scene;

  beforeEach(() => {
    manager = new DESManager();
    DES.setManager(manager);
    scene = new Scene();
  });

  it('connects nearest downstream component', () => {
    // Position components in a line: Source -> Conv1 -> Conv2 -> Sink
    // Default entry/exit: entry = pos - 0.5, exit = pos + 0.5
    // So source output at (0.5,0,0), conv1 input at (0.5,0,0) = distance 0
    // We use larger spacing to make distances clear
    const sourceNode = createNode('Source', 0, 0, 0);
    const conv1Node = createNode('Conv1', 2, 0, 0);    // input at 1.5
    const conv2Node = createNode('Conv2', 10, 0, 0);   // input at 9.5
    scene.add(sourceNode, conv1Node, conv2Node);
    scene.updateMatrixWorld(true);

    const source = new DESSource(sourceNode);
    source.autoConnect = { enabled: true, maxDistance: 20 };
    const conv1 = new DESConveyor(conv1Node);
    conv1.autoConnect = { enabled: true, maxDistance: 20 };
    const conv2 = new DESConveyor(conv2Node);
    conv2.autoConnect = { enabled: true, maxDistance: 20 };

    const components: DESComponent[] = [source, conv1, conv2];

    for (const c of components) {
      manager.registerComponent(c);
    }

    const ctx = makeContext(scene);
    for (const c of components) {
      c.init(ctx);
    }

    autoConnect(components);

    // Source output at 0.5 -> conv1 input at 1.5 = distance 1
    // Source output at 0.5 -> conv2 input at 9.5 = distance 9
    // Source should connect to conv1 (nearest)
    expect(source.nextComponents.length).toBe(1);
    expect(source.nextComponents[0]).toBe(conv1);
  });

  it('respects maxDistance filter', () => {
    const sourceNode = createNode('Source', 0, 0, 0);
    const sinkNode = createNode('Sink', 5, 0, 0);
    scene.add(sourceNode, sinkNode);
    scene.updateMatrixWorld(true);

    const source = new DESSource(sourceNode);
    source.autoConnect = { enabled: true, maxDistance: 2 }; // 2m max
    const sink = new DESSink(sinkNode);
    sink.autoConnect = { enabled: true, maxDistance: 2 };

    const components: DESComponent[] = [source, sink];

    for (const c of components) {
      manager.registerComponent(c);
    }
    const ctx = makeContext(scene);
    for (const c of components) {
      c.init(ctx);
    }

    autoConnect(components);

    // Sink is 5m away, maxDistance is 2m — should NOT connect
    expect(source.nextComponents.length).toBe(0);
  });

  it('computes PreviousComponents from NextComponents', () => {
    const node1 = createNode('A', 0, 0, 0);
    const node2 = createNode('B', 1, 0, 0);
    const node3 = createNode('C', 2, 0, 0);
    scene.add(node1, node2, node3);

    const a = new DESConveyor(node1);
    const b = new DESConveyor(node2);
    const c = new DESConveyor(node3);

    a.nextComponents = [b];
    b.nextComponents = [c];

    computePreviousComponents([a, b, c]);

    expect(a.previousComponents.length).toBe(0);
    expect(b.previousComponents.length).toBe(1);
    expect(b.previousComponents[0]).toBe(a);
    expect(c.previousComponents.length).toBe(1);
    expect(c.previousComponents[0]).toBe(b);
  });

  it('skips components with autoConnect disabled', () => {
    const sourceNode = createNode('Source', 0, 0, 0);
    const sinkNode = createNode('Sink', 2, 0, 0);
    scene.add(sourceNode, sinkNode);
    scene.updateMatrixWorld(true);

    const source = new DESSource(sourceNode);
    const sink = new DESSink(sinkNode);

    const components: DESComponent[] = [source, sink];
    for (const c of components) {
      manager.registerComponent(c);
    }
    const ctx = makeContext(scene);
    for (const c of components) {
      c.init(ctx);
    }

    // Set autoConnect.enabled AFTER init so schema defaults don't interfere
    source.autoConnect.enabled = false;

    autoConnect(components);

    // Source has autoConnect disabled — should NOT connect
    expect(source.nextComponents.length).toBe(0);
  });

  it('does not overwrite existing connections', () => {
    const sourceNode = createNode('Source', 0, 0, 0);
    const sink1Node = createNode('Sink1', 3, 0, 0);
    const sink2Node = createNode('Sink2', 2, 0, 0);
    scene.add(sourceNode, sink1Node, sink2Node);
    scene.updateMatrixWorld(true);

    const source = new DESSource(sourceNode);
    source.autoConnect = { enabled: true, maxDistance: 5 };
    const sink1 = new DESSink(sink1Node);
    const sink2 = new DESSink(sink2Node);

    // Pre-wire to sink1
    source.nextComponents = [sink1];

    const components: DESComponent[] = [source, sink1, sink2];
    for (const c of components) {
      manager.registerComponent(c);
    }
    const ctx = makeContext(scene);
    for (const c of components) {
      c.init(ctx);
    }

    autoConnect(components);

    // Should still be sink1 (pre-wired), not sink2 (closer)
    expect(source.nextComponents.length).toBe(1);
    expect(source.nextComponents[0]).toBe(sink1);
  });
});
