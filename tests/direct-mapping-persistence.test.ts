// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { constructDrive } from '../src/core/engine/rv-signal-construction';
import {
  resolveComponentRefs,
  type ComponentContext,
} from '../src/core/engine/rv-component-registry';
import type { SignalMapping } from '../src/plugins/layout-planner/rv-layout-store';

describe('direct mapping restore', () => {
  it('re-docks direct-property and direct-feedback mappings on the same slots', () => {
    const scene = new Scene();
    const node = new Object3D();
    node.name = 'Axis';
    scene.add(node);
    const registry = new NodeRegistry();
    const store = new SignalStore();
    registry.registerNode('Axis', node);
    const rv = { Drive: { Direction: 'LinearX' }, Drive_Simple: {} };
    node.userData.realvirtual = rv;
    const result = constructDrive(node, rv, rv.Drive, 'Axis', registry, store)!;
    const pending = result.pendingBehaviors[0];
    resolveComponentRefs(pending.component as unknown as Record<string, unknown>, registry);
    pending.component.init({ registry, signalStore: store, scene, root: node } as ComponentContext);

    store.register('PLC.Forward', '__iface__/PLC.Forward', true, 'PLCOutputBool');
    store.register('PLC.Running', '__iface__/PLC.Running', true, 'PLCInputBool');
    store.registerSignalProvider({ interfaceId: 'plc', signal: 'PLC.Forward' }, true);
    store.registerSignalProvider({ interfaceId: 'plc', signal: 'PLC.Running' }, true);
    const persisted: SignalMapping[] = [
      {
        kind: 'direct-property',
        componentPath: '.',
        slot: 'Forward',
        signal: 'PLC.Forward',
        interfaceId: 'plc',
        direction: 'plcOutput',
        enabled: true,
      },
      {
        kind: 'direct-feedback',
        componentPath: '.',
        slot: 'IsDriving',
        signal: 'PLC.Running',
        interfaceId: 'plc',
        direction: 'plcInput',
        enabled: true,
      },
    ];

    const first = new SignalBindingManager(store, registry);
    expect(first.applyMappings('axis', node, persisted)).toEqual(persisted);
    first.tick(1 / 60);
    expect(result.drive.jogForward).toBe(true);
    expect(store.getBool('PLC.Running')).toBe(false);
    first.dispose();
    expect(result.drive.jogForward).toBe(false);

    const restored = JSON.parse(JSON.stringify(persisted)) as SignalMapping[];
    const second = new SignalBindingManager(store, registry);
    expect(second.applyMappings('axis', node, restored)).toEqual(restored);
    second.tick(1 / 60);
    expect(second.getBindingLiveness('axis', 'Forward', '.')).toBe('live');
    expect(second.getBindingLiveness('axis', 'IsDriving', '.')).toBe('live');
    expect(result.drive.jogForward).toBe(true);
  });
});
