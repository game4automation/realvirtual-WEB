// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';

describe('binding manager hot-path structure', () => {
  it('reports zero instrumented allocations while ticking 50 bindings', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    const scene = new Scene();
    const manager = new SignalBindingManager(store, registry);
    for (let i = 0; i < 50; i++) {
      const node = new Object3D(); node.name = `C${i}`; node.userData.realvirtual = { LayoutObject: {}, Conveyor: {} }; scene.add(node);
      registry.registerNode(`C${i}`, node);
      store.register(`C${i}/Flow.Run`, `C${i}/Flow.Run`, false);
      store.register(`Source.${i}`, `__iface__/Source.${i}`, true, 'PLCOutputBool');
      store.registerSignalProvider({ interfaceId: `if-${i}`, signal: `Source.${i}` }, true);
      manager.bind(`C${i}`, node, { slot: 'Flow.Run', signal: `Source.${i}`, interfaceId: `if-${i}`, direction: 'plcOutput', enabled: true });
    }
    manager.tick(0.02);
    manager.tick(0.02);
    expect(manager.hotPathAllocationCount).toBe(0);
  });
});
