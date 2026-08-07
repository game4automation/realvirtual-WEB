// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import { applyForward, applyInverse } from '../src/core/hmi/scene/rv-scene-executors';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import type { SetFieldOp } from '../src/core/hmi/scene/rv-scene-edits';
import type { RVViewer } from '../src/core/rv-viewer';

describe('SignalLinks scene executor runtime sync', () => {
  it('applies and unbinds on forward/inverse without replacing signal references', async () => {
    const root = new Scene();
    const node = new Object3D();
    node.name = 'Machine';
    node.userData.realvirtual = { Conveyor: {}, SignalLinks: { Mappings: [] } };
    root.add(node);
    const registry = new NodeRegistry();
    registry.registerNode('Machine', node);
    const applyMappings = vi.fn();
    const unbindAll = vi.fn();
    const viewer = {
      registry,
      signalBindingManager: { applyMappings, unbindAll },
      markRenderDirty: vi.fn(),
    } as unknown as RVViewer;
    const mappings = [{ slot: 'Flow.Run', signal: 'Run', interfaceId: 'mqtt', direction: 'plcOutput', enabled: true }];
    const op: SetFieldOp = {
      id: 'bind-op', ts: 1, schemaV: 1, kind: 'setField', nodePath: 'Machine',
      componentType: 'SignalLinks', fieldName: 'Mappings', value: mappings, prev: [],
    };

    await applyForward(op, { viewer });
    expect(applyMappings).toHaveBeenCalledWith('Machine', node, mappings);
    expect(node.userData.realvirtual.SignalLinks.Mappings).toEqual(mappings);

    await applyInverse(op, { viewer });
    expect(unbindAll).toHaveBeenCalledWith('Machine');
    expect(node.userData.realvirtual.SignalLinks.Mappings).toEqual([]);
  });
});
