// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { constructDrive } from '../src/core/engine/rv-signal-construction';
import { enumerateCompatibleTargets } from '../src/plugins/signal-bind/compatible-targets';
import type {
  DirectPropertySlot,
  ResolvedSlot,
} from '../src/core/engine/rv-binding-slot-resolver';
import type { RVViewer } from '../src/core/rv-viewer';

const BOOL_CONTROL: ResolvedSlot = {
  slot: 'Run', targetName: 'Run', type: 'bool', direction: 'plcOutput', aliases: [], instance: null,
};
const FLOAT_CONTROL: ResolvedSlot = {
  slot: 'Speed', targetName: 'Speed', type: 'float', direction: 'plcOutput', aliases: [], instance: null,
};
const BOOL_FEEDBACK: ResolvedSlot = {
  slot: 'Occupied', targetName: 'Occupied', type: 'bool', direction: 'plcInput', aliases: [], instance: null,
};
const DIRECT_BOOL_CONTROL: DirectPropertySlot = {
  kind: 'direct-property',
  componentPath: '.',
  slot: 'Forward',
  type: 'bool',
  direction: 'plcOutput',
  aliases: [],
  instance: null,
  command: () => {},
  neutralize: () => {},
};

interface HarnessOptions {
  slots?: Map<string, ResolvedSlot[]>;
  placed?: Array<{ id: string; root: Object3D }>;
  manager?: boolean;
}

function makeHarness(nodes: Array<{ path: string; node: Object3D }>, options: HarnessOptions = {}) {
  const registry = new NodeRegistry();
  for (const { path, node } of nodes) registry.registerNode(path, node);
  const store = new SignalStore();
  const realManager = new SignalBindingManager(store, registry);
  const slots = options.slots ?? new Map(nodes.map(({ path }) => [path, [BOOL_CONTROL]]));
  const manager = Object.assign(realManager, {
    getElementSlots: (id: string) => slots.get(id) ?? [],
  });
  const placed = options.placed ?? [];
  const planner = placed.length > 0 ? {
    store: { getSnapshot: () => ({ placed: placed.map(({ id }) => ({ id })) }) },
    getPlacedRootById: (id: string) => placed.find((p) => p.id === id)?.root ?? null,
    findPlacedAncestor: (node: Object3D) => {
      const hit = placed.find((p) => p.root === node || isDescendantOf(node, p.root));
      return hit ? { id: hit.id, root: hit.root } : null;
    },
  } : undefined;
  const viewer = {
    registry,
    signalBindingManager: options.manager === false ? null : manager,
    behaviors: { getActiveBinds: () => [] },
    getPlugin: (id: string) => id === 'layout-planner' ? planner : undefined,
  } as unknown as RVViewer;
  return { viewer, registry, slots };
}

function isDescendantOf(node: Object3D, root: Object3D): boolean {
  for (let current: Object3D | null = node; current; current = current.parent) {
    if (current === root) return true;
  }
  return false;
}

function stamped(name: string, key: string): Object3D {
  const node = new Object3D();
  node.name = name;
  node.userData.realvirtual = { [key]: {} };
  return node;
}

describe('enumerateCompatibleTargets', () => {
  it('finds a GLB drive built through constructDrive while the behavior stays pending', () => {
    const root = new Scene();
    const node = stamped('Axis', 'Drive_Simple');
    root.add(node);
    const registry = new NodeRegistry();
    registry.registerNode('Axis', node);
    const rv = { Drive: { Direction: 'LinearX' }, Drive_Simple: {} };
    const built = constructDrive(node, rv, rv.Drive, 'Axis', registry);
    expect(built?.pendingBehaviors.map((p) => p.type)).toEqual(['Drive_Simple']);
    // plan-317 §2.4: constructDrive registers the WINNER behavior both as a
    // pending entry AND in the component registry — exactly one registry
    // instance per node, discoverable by the resolver while still pending.
    const registeredBehaviors = registry.getAll('Drive_Simple');
    expect(registeredBehaviors).toHaveLength(1);
    expect(registeredBehaviors[0].instance).toBe(built?.pendingBehaviors[0]?.component);

    const h = makeHarness([{ path: 'Axis', node }], { slots: new Map([['Axis', [BOOL_CONTROL]]]) });
    expect(enumerateCompatibleTargets(h.viewer, {
      name: 'Start', direction: 'output', plcType: 'PLCOutputBool',
      origin: 'connect', interfaceId: 'iface-1',
    }).map((target) => target.id)).toEqual(['Axis']);
  });

  it.each(['ConveyorBehavior', 'Conveyor'])('finds a node stamped only with %s', (key) => {
    const node = stamped('Conveyor', key);
    const h = makeHarness([{ path: 'Conveyor', node }]);
    expect(enumerateCompatibleTargets(h.viewer, {
      name: 'Run', direction: 'output', plcType: 'PLCOutputBool',
      origin: 'connect', interfaceId: 'iface-1',
    })).toHaveLength(1);
  });

  it('returns only targets with a slot accepting kind and direction', () => {
    const boolOut = stamped('BoolOut', 'Sensor');
    const floatOut = stamped('FloatOut', 'Drive_Simple');
    const boolIn = stamped('BoolIn', 'Conveyor');
    const slots = new Map<string, ResolvedSlot[]>([
      ['BoolOut', [BOOL_CONTROL]], ['FloatOut', [FLOAT_CONTROL]], ['BoolIn', [BOOL_FEEDBACK]],
    ]);
    const h = makeHarness([
      { path: 'BoolOut', node: boolOut }, { path: 'FloatOut', node: floatOut }, { path: 'BoolIn', node: boolIn },
    ], { slots });
    expect(enumerateCompatibleTargets(h.viewer, {
      name: 'Run', direction: 'output', plcType: 'PLCOutputBool',
      origin: 'connect', interfaceId: 'iface-1',
    }).map((target) => target.id)).toEqual(['BoolOut']);
  });

  it('returns empty for unknown plcType or direction', () => {
    const node = stamped('Axis', 'Drive_Simple');
    const h = makeHarness([{ path: 'Axis', node }]);
    expect(enumerateCompatibleTargets(h.viewer, {
      name: 'Mystery', direction: 'output', plcType: 'string',
      origin: 'connect', interfaceId: 'iface-1',
    })).toEqual([]);
    expect(enumerateCompatibleTargets(h.viewer, {
      name: 'Mystery', direction: 'unknown', plcType: 'PLCOutputBool',
      origin: 'connect', interfaceId: 'iface-1',
    })).toEqual([]);
  });

  it('includes direct-only targets only for matching payload type and direction', () => {
    const node = stamped('DirectAxis', 'Drive_Simple');
    const slots = new Map([
      ['DirectAxis', [DIRECT_BOOL_CONTROL]],
    ]) as unknown as Map<string, ResolvedSlot[]>;
    const h = makeHarness([{ path: 'DirectAxis', node }], { slots });
    expect(enumerateCompatibleTargets(h.viewer, {
      name: 'Forward', direction: 'output', plcType: 'PLCOutputBool',
      origin: 'connect', interfaceId: 'iface-1',
    }).map(target => target.id)).toEqual(['DirectAxis']);
    expect(enumerateCompatibleTargets(h.viewer, {
      name: 'Speed', direction: 'output', plcType: 'PLCOutputFloat',
      origin: 'connect', interfaceId: 'iface-1',
    })).toEqual([]);
    expect(enumerateCompatibleTargets(h.viewer, {
      name: 'Feedback', direction: 'input', plcType: 'PLCInputBool',
      origin: 'connect', interfaceId: 'iface-1',
    })).toEqual([]);
  });

  it('dedupes a node found by registry discovery and planner placed[]', () => {
    const node = stamped('Conveyor', 'Conveyor');
    const h = makeHarness([{ path: 'Conveyor', node }], {
      placed: [{ id: 'placed-1', root: node }],
      slots: new Map([['placed-1', [BOOL_CONTROL]]]),
    });
    const result = enumerateCompatibleTargets(h.viewer, {
      name: 'Run', direction: 'output', plcType: 'PLCOutputBool',
      origin: 'connect', interfaceId: 'iface-1',
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'placed-1', kind: 'placed' });
  });

  it('returns empty when signalBindingManager is null', () => {
    const node = stamped('Axis', 'Drive_Simple');
    const h = makeHarness([{ path: 'Axis', node }], { manager: false });
    expect(enumerateCompatibleTargets(h.viewer, {
      name: 'Start', direction: 'output', plcType: 'PLCOutputBool',
      origin: 'connect', interfaceId: 'iface-1',
    })).toEqual([]);
  });
});
