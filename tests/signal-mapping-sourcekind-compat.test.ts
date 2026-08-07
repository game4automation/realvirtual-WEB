// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-325 §9.4 — sourceKind backward compatibility:
 *  - a legacy mapping WITHOUT sourceKind reads as 'connect' (the single helper
 *    every read site funnels through).
 *  - persist/read roundtrips keep sourceKind intact (applyMappings copy,
 *    node-path SignalLinks.Mappings seed).
 */
import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { mappingSourceKind, type SignalMapping } from '../src/plugins/layout-planner/rv-layout-store';
import { createSignalBindingPersistence } from '../src/plugins/signal-bind/signal-binding-persistence';
import type { RVViewer } from '../src/core/rv-viewer';
import { scopeSignalName } from '../src/core/engine/rv-instance-scope';

function makeConveyor(store: SignalStore, registry: NodeRegistry, scope: string): Object3D {
  const root = new Object3D();
  root.name = scope;
  root.userData.realvirtual = { LayoutObject: { Label: scope }, Conveyor: {} };
  registry.registerNode(scope, root);
  store.register(scopeSignalName(scope, 'Flow.Run'), `${scope}/Flow.Run`, false, 'PLCOutputBool');
  return root;
}

describe('SignalMapping sourceKind compatibility (plan-325 9.4)', () => {
  it('mappingSourceKind defaults missing sourceKind to connect', () => {
    expect(mappingSourceKind({})).toBe('connect');
    expect(mappingSourceKind({ sourceKind: 'connect' })).toBe('connect');
    expect(mappingSourceKind({ sourceKind: 'internal' })).toBe('internal');
  });

  it('binds a legacy mapping (no sourceKind) through the CONNECT provider path', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    store.register('Run', '__iface__/Run', true, 'PLCOutputBool');
    store.registerSignalProvider({ interfaceId: 'mqtt', signal: 'Run' }, true);
    const mgr = new SignalBindingManager(store, registry);
    const root = makeConveyor(store, registry, 'Conv');

    const legacy: SignalMapping = { slot: 'Flow.Run', signal: 'Run', direction: 'plcOutput', enabled: true };
    mgr.bind('conv', root, legacy);
    mgr.tick(0.02);
    // Provider identity auto-adopted — the connect default was applied.
    expect(legacy.interfaceId).toBe('mqtt');
    expect(mgr.getBindingLiveness('conv', 'Flow.Run')).toBe('live');
  });

  it('applyMappings preserves sourceKind through its defensive copies', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    store.register('ModelToggle', 'Cell/ModelToggle', false, 'PLCOutputBool');
    const mgr = new SignalBindingManager(store, registry);
    const root = makeConveyor(store, registry, 'ConvB');

    const applied = mgr.applyMappings('convB', root, [{
      slot: 'Flow.Run', sourceKind: 'internal', signal: 'ModelToggle', direction: 'plcOutput', enabled: true,
    }]);
    expect(applied).toHaveLength(1);
    expect(applied[0].sourceKind).toBe('internal');
    expect(mappingSourceKind(applied[0])).toBe('internal');
  });

  it('node-path persistence seeds SignalLinks.Mappings verbatim, sourceKind included', () => {
    const node = new Object3D();
    node.name = 'Axis';
    node.userData.realvirtual = {
      SignalLinks: {
        Mappings: [
          { slot: 'Forward', sourceKind: 'internal', signal: 'ModelToggle', direction: 'plcOutput', enabled: true },
          { slot: 'Backward', signal: 'Plc.Bwd', interfaceId: 'plc', direction: 'plcOutput', enabled: true },
        ],
      },
    };
    const persistence = createSignalBindingPersistence(
      {} as RVViewer,
      { kind: 'node', nodePath: 'Axis', node },
    );
    const read = persistence.read();
    expect(read).toHaveLength(2);
    expect(mappingSourceKind(read[0])).toBe('internal');
    expect(mappingSourceKind(read[1])).toBe('connect');
  });
});
