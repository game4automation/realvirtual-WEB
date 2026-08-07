// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import { createSignalBindingPersistence } from '../src/plugins/signal-bind/signal-binding-persistence';
import { setActiveEditTarget, type EditTarget } from '../src/core/hmi/rv-edit-target';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import type { RVViewer } from '../src/core/rv-viewer';

afterEach(() => setActiveEditTarget(null));

describe('signal binding persistence and pending restore', () => {
  it('emits SignalLinks/Mappings setField persistence without mutating loaded extras', () => {
    const setField = vi.fn();
    setActiveEditTarget({
      available: true, setField, unsetField: vi.fn(),
      withTransaction: async (_label, fn) => fn(),
    } satisfies EditTarget);
    const node = new Object3D();
    node.userData.realvirtual = { SignalLinks: { Mappings: [] } };
    const target = { kind: 'node' as const, nodePath: 'Machine', node };
    const adapter = createSignalBindingPersistence({ getPlugin: () => undefined } as unknown as RVViewer, target);
    const mappings = [{ slot: 'Flow.Run', signal: 'Run', interfaceId: 'mqtt', direction: 'plcOutput' as const, enabled: true }];

    adapter.write(mappings);

    expect(setField).toHaveBeenCalledWith('Machine', 'SignalLinks', 'Mappings', mappings, []);
    expect((node.userData.realvirtual.SignalLinks as { Mappings: unknown[] }).Mappings).toEqual([]);
    expect(adapter.read()).toEqual(mappings);
  });

  it('restores pending, then activates when discovery registers the provider', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    const root = new Scene();
    const node = new Object3D();
    node.name = 'Machine';
    node.userData.realvirtual = { Conveyor: {} };
    root.add(node);
    registry.registerNode('Machine', node);
    store.register('Flow.Run', 'Machine/Flow.Run', false);
    store.setSignalProviderConnected({ interfaceId: 'mqtt' }, true);
    const manager = new SignalBindingManager(store, registry);
    manager.applyMappings('Machine', node, [{ slot: 'Flow.Run', signal: 'Run', interfaceId: 'mqtt', direction: 'plcOutput', enabled: true }]);
    manager.tick(0.02);
    expect(manager.getBindingLiveness('Machine', 'Flow.Run')).toBe('pending');

    store.register('Run', '__iface__/Run', true, 'PLCOutputBool');
    store.registerSignalProvider({ interfaceId: 'mqtt', signal: 'Run' }, true);
    manager.tick(0.02);
    expect(manager.getBindingLiveness('Machine', 'Flow.Run')).toBe('live');
    expect(store.getBool('Flow.Run')).toBe(true);
  });
});
