// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-418 9.1 — raw PLC signal nodes as bind slots.
 *
 * Everything here goes through `SignalBindingManager.getElementSlots()` rather
 * than the resolver in isolation: the manager is the surface the badge, the
 * popover and the inspector all consume, and it caches per element — a resolver
 * that is right on its own but wrong through the manager would still ship
 * broken.
 */

import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import {
  constructDrive,
  isDuplicateSignalName,
  registerSignal,
  SIGNAL_TYPES,
} from '../src/core/engine/rv-signal-construction';
import { resolveComponentRefs, type ComponentContext } from '../src/core/engine/rv-component-registry';
import {
  ownsBindableSlots,
  PLC_SIGNAL_SLOT,
  resolveBindableSlots,
} from '../src/core/engine/rv-binding-slot-resolver';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { findSignalBindTarget, signalBindTargetId } from '../src/plugins/signal-bind/signal-bind-target';
import type { RVViewer } from '../src/core/rv-viewer';

interface Fixture {
  scene: Scene;
  root: Object3D;
  registry: NodeRegistry;
  store: SignalStore;
}

function newFixture(): Fixture {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Cell';
  scene.add(root);
  const registry = new NodeRegistry();
  const store = new SignalStore();
  registry.registerNode('Cell', root);
  return { scene, root, registry, store };
}

/** A raw PLC signal node exactly as the loader leaves it (extras + registration). */
function addSignalNode(
  f: Fixture,
  parent: Object3D,
  parentPath: string,
  nodeName: string,
  sigType: string,
  opts: { signalName?: string; register?: boolean } = {},
): { node: Object3D; path: string; signalName: string } {
  const node = new Object3D();
  node.name = nodeName;
  parent.add(node);
  const path = `${parentPath}/${nodeName}`;
  const signalName = opts.signalName ?? nodeName;
  const sigData = { Name: signalName, Status: { Value: sigType.includes('Bool') ? false : 0 } };
  node.userData.realvirtual = { [sigType]: sigData };
  f.registry.registerNode(path, node);
  if (opts.register !== false) registerSignal(node, sigType, sigData, path, f.store, f.registry);
  return { node, path, signalName };
}

function makeViewer(f: Fixture, manager: SignalBindingManager): RVViewer {
  return {
    registry: f.registry,
    signalBindingManager: manager,
    behaviors: { getActiveBinds: () => [] },
    getPlugin: () => undefined,
  } as unknown as RVViewer;
}

/** Slots of a free node target, resolved the way the productive surfaces do. */
function nodeSlots(f: Fixture, manager: SignalBindingManager, path: string, node: Object3D) {
  return manager.getElementSlots(path, node, 'own');
}

describe('raw PLC signal node → one bindable slot', () => {
  it('offers exactly one Value slot per signal type, with the real type/direction', () => {
    for (const sigType of SIGNAL_TYPES) {
      const f = newFixture();
      const sig = addSignalNode(f, f.root, 'Cell', 'Tag', sigType);
      f.store.buildIndex();
      const manager = new SignalBindingManager(f.store, f.registry);

      const slots = nodeSlots(f, manager, sig.path, sig.node);

      expect(slots, sigType).toHaveLength(1);
      expect(slots[0]).toMatchObject({
        kind: 'mapped-signal',
        slot: PLC_SIGNAL_SLOT,
        componentPath: '.',
        componentType: sigType,
        targetName: 'Tag',
        type: sigType.includes('Bool') ? 'bool' : sigType.includes('Int') ? 'int' : 'float',
        direction: sigType.startsWith('PLCOutput') ? 'plcOutput' : 'plcInput',
      });
      // Never mislabelled as the legacy Conveyor fallback lane.
      expect((slots[0] as { descriptorRoleFallback?: boolean }).descriptorRoleFallback).toBeUndefined();
    }
  });

  it('uses the authored signal Name, not the node name, as the store target', () => {
    const f = newFixture();
    const sig = addSignalNode(f, f.root, 'Cell', 'AutomaticLight', 'PLCOutputBool', {
      signalName: 'DemoCell.AutomaticLight',
    });
    f.store.buildIndex();
    const manager = new SignalBindingManager(f.store, f.registry);

    expect(nodeSlots(f, manager, sig.path, sig.node)[0]).toMatchObject({
      kind: 'mapped-signal',
      targetName: 'DemoCell.AutomaticLight',
    });
  });

  it('fails closed with signal-not-registered when extras declare an unregistered signal', () => {
    const f = newFixture();
    const sig = addSignalNode(f, f.root, 'Cell', 'Ghost', 'PLCInputBool', { register: false });
    f.store.buildIndex();
    const manager = new SignalBindingManager(f.store, f.registry);

    expect(nodeSlots(f, manager, sig.path, sig.node)).toEqual([
      { kind: 'unavailable', slot: PLC_SIGNAL_SLOT, reason: 'signal-not-registered' },
    ]);
  });
});

describe('signal-name collision fails closed for BOTH partners', () => {
  /** Two nodes in different subtrees registering the SAME signal name. */
  function collisionFixture(order: 'a-first' | 'b-first') {
    const f = newFixture();
    const left = new Object3D();
    left.name = 'Left';
    f.root.add(left);
    f.registry.registerNode('Cell/Left', left);
    const right = new Object3D();
    right.name = 'Right';
    f.root.add(right);
    f.registry.registerNode('Cell/Right', right);

    const build = (parent: Object3D, parentPath: string) =>
      addSignalNode(f, parent, parentPath, parent.name === 'Left' ? 'StartL' : 'StartR', 'PLCOutputBool', {
        signalName: 'Start',
      });

    const a = order === 'a-first' ? build(left, 'Cell/Left') : build(right, 'Cell/Right');
    const b = order === 'a-first' ? build(right, 'Cell/Right') : build(left, 'Cell/Left');
    f.store.buildIndex();
    return { f, a, b };
  }

  for (const order of ['a-first', 'b-first'] as const) {
    it(`marks both colliding nodes unavailable (${order})`, () => {
      const { f, a, b } = collisionFixture(order);
      const manager = new SignalBindingManager(f.store, f.registry);

      expect(isDuplicateSignalName(f.store, 'Start')).toBe(true);
      for (const sig of [a, b]) {
        expect(nodeSlots(f, manager, sig.path, sig.node)).toEqual([
          { kind: 'unavailable', slot: PLC_SIGNAL_SLOT, reason: 'duplicate-signal-name' },
        ]);
      }
    });
  }

  it('does NOT treat a suffix/alias path as a collision', () => {
    const f = newFixture();
    const sig = addSignalNode(f, f.root, 'Cell', 'Start', 'PLCOutputBool');
    // The renamed-node alias path (plan-381 F11) never goes through
    // registerSignal(), so it must not look like a second registrant.
    expect(f.store.registerPathAlias('Start', 'Cell/Renamed/Start')).toBe(true);
    f.store.buildIndex();
    const manager = new SignalBindingManager(f.store, f.registry);

    expect(isDuplicateSignalName(f.store, 'Start')).toBe(false);
    expect(nodeSlots(f, manager, sig.path, sig.node)[0]).toMatchObject({ kind: 'mapped-signal' });
  });

  it('re-registering the SAME node path is not a collision', () => {
    const f = newFixture();
    const sig = addSignalNode(f, f.root, 'Cell', 'Start', 'PLCOutputBool');
    registerSignal(
      sig.node,
      'PLCOutputBool',
      { Name: 'Start', Status: { Value: false } },
      sig.path,
      f.store,
      f.registry,
    );
    f.store.buildIndex();

    expect(isDuplicateSignalName(f.store, 'Start')).toBe(false);
  });
});

describe('scope: a PLC signal node is its own bind target', () => {
  it('ownsBindableSlots() recognises a registered signal node', () => {
    const f = newFixture();
    const registered = addSignalNode(f, f.root, 'Cell', 'Tag', 'PLCOutputBool');
    const unregistered = addSignalNode(f, f.root, 'Cell', 'Ghost', 'PLCOutputBool', { register: false });
    f.store.buildIndex();

    expect(ownsBindableSlots(registered.node, f.registry)).toBe(true);
    // Extras without a registry entry produce no slot — they must not cut off
    // the 'own' walk either.
    expect(ownsBindableSlots(unregistered.node, f.registry)).toBe(false);
  });

  it('keeps a signal node under a drive subtree a separate target (no aggregation)', () => {
    const f = newFixture();
    const driveNode = new Object3D();
    driveNode.name = 'Axis';
    f.root.add(driveNode);
    const rv = { Drive: { Direction: 'LinearX' }, Drive_Simple: {} } as Record<string, unknown>;
    driveNode.userData.realvirtual = rv;
    f.registry.registerNode('Cell/Axis', driveNode);
    const result = constructDrive(driveNode, rv, rv.Drive as Record<string, unknown>, 'Cell/Axis', f.registry, f.store)!;

    const sig = addSignalNode(f, driveNode, 'Cell/Axis', 'Interlock', 'PLCOutputBool');
    f.store.buildIndex();
    const ctx = { registry: f.registry, signalStore: f.store, scene: f.scene, root: f.root } as ComponentContext;
    for (const pending of result.pendingBehaviors) {
      resolveComponentRefs(pending.component as unknown as Record<string, unknown>, f.registry);
      f.registry.register(pending.type, pending.path, pending.component);
      pending.component.init(ctx);
    }

    const manager = new SignalBindingManager(f.store, f.registry);
    const viewer = makeViewer(f, manager);

    // Clicking the signal resolves to the SIGNAL, not the drive around it.
    const target = findSignalBindTarget(viewer, sig.node);
    expect(signalBindTargetId(target!)).toBe(sig.path);

    // …and the drive's own 'own'-scope slot set never repeats it.
    const driveSlots = manager.getElementSlots('Cell/Axis', driveNode, 'own');
    expect(driveSlots.some((s) => s.kind !== 'unavailable' && s.slot === PLC_SIGNAL_SLOT)).toBe(false);
  });

  it("'aggregate' scope surfaces the signal slot on the enclosing element", () => {
    const f = newFixture();
    f.root.userData.realvirtual = { LayoutObject: { Label: 'Cell' } };
    const inner = new Object3D();
    inner.name = 'PLCInterface';
    f.root.add(inner);
    f.registry.registerNode('Cell/PLCInterface', inner);
    addSignalNode(f, inner, 'Cell/PLCInterface', 'EntryConveyorStart', 'PLCOutputBool');
    f.store.buildIndex();

    const aggregate = resolveBindableSlots(f.root, f.store, f.registry, 'aggregate');
    expect(aggregate).toHaveLength(1);
    expect(aggregate[0]).toMatchObject({
      kind: 'mapped-signal',
      slot: PLC_SIGNAL_SLOT,
      componentPath: 'PLCInterface/EntryConveyorStart',
      targetName: 'EntryConveyorStart',
    });
  });
});
