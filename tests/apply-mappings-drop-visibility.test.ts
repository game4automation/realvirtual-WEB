// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * apply-mappings-drop-visibility — a mapping that cannot bind is REPORTED, not
 * swallowed (plan-425 F4, test 9.4).
 *
 * `applyMappings()` used to drop unresolvable mappings with a bare `.filter()`.
 * That is how a whole broken restore could happen with nothing on screen and
 * nothing in the console, leaving the user's "my links are gone" report with no
 * corroboration anywhere in the product. The dropping itself is unavoidable — a
 * binding to a slot that is not there cannot be honoured — but the silence was
 * a choice, and this file pins the new one.
 *
 * The fixture is an AGGREGATE target (a Planner-style placement) rather than the
 * shared single-node one, because that is the shape in which the case-B failure
 * actually occurs: a placement whose inner component was re-parented keeps
 * resolving as a target while the slot underneath it moves. On a bare node the
 * component path is just `.` and there is nothing to move.
 */

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import '../src/core/engine/rv-signal-construction';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import type { SignalMapping } from '../src/plugins/layout-planner/rv-layout-store';

const ID = 'placement-1';

/** A placement whose `Gripper` child carries the Drive_Simple slots. */
function makeAggregateFixture() {
  const store = new SignalStore();
  const registry = new NodeRegistry();
  const root = new Object3D();
  root.name = 'Machine';
  const gripper = new Object3D();
  gripper.name = 'Gripper';
  root.add(gripper);

  store.register('Gripper.Forward', 'Machine/Gripper/Forward', false, 'PLCOutputBool');
  store.register('ModelSig', 'Cell/ModelSig', false, 'PLCOutputBool');
  gripper.userData.realvirtual = {
    Drive_Simple: {
      Forward: {
        type: 'ComponentReference',
        path: 'Machine/Gripper/Forward',
        componentType: 'PLCOutputBool',
      },
    },
  };
  registry.registerNode('Machine', root);
  registry.registerNode('Machine/Gripper', gripper);
  registry.register('Drive_Simple', 'Machine/Gripper', {
    Forward: 'Gripper.Forward',
    Backward: null,
    commandBackward: () => { /* command sink */ },
    neutralizeBackward: () => { /* neutral */ },
  });

  const mgr = new SignalBindingManager(store, registry);
  mgr.getElementSlots(ID, root, 'aggregate');
  return { mgr, root };
}

/** Binds: the slot really is at `Gripper`. */
const GOOD: SignalMapping = {
  kind: 'mapped-signal', componentPath: 'Gripper', componentType: 'Drive_Simple',
  slot: 'Forward', signal: 'ModelSig', sourceKind: 'internal',
  direction: 'plcInput', enabled: true,
};

/** Saved before the component was re-parented — same leaf, different parent. */
const MOVED: SignalMapping = { ...GOOD, componentPath: 'OldArm/Gripper' };

/** Saved against a component this placement never had. */
const GONE: SignalMapping = { ...GOOD, componentPath: 'OldArm/Welder' };

describe('applyMappings drop visibility', () => {
  it('says nothing when everything binds', () => {
    const { mgr, root } = makeAggregateFixture();
    const applied = mgr.applyMappings(ID, root, [GOOD]);
    expect(applied).toHaveLength(1);
    expect(mgr.getUnresolvedMappings(ID)).toEqual([]);
  });

  it('records the mapping it could not bind', () => {
    const { mgr, root } = makeAggregateFixture();
    mgr.applyMappings(ID, root, [GONE]);
    const unresolved = mgr.getUnresolvedMappings(ID);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].mapping.componentPath).toBe('OldArm/Welder');
  });

  it('still binds the valid mappings alongside the broken one', () => {
    // A single lost link must not cost the user the rest of the machine.
    const { mgr, root } = makeAggregateFixture();
    const applied = mgr.applyMappings(ID, root, [GONE, GOOD]);
    expect(applied.map((m) => m.componentPath)).toEqual(['Gripper']);
    expect(mgr.getUnresolvedMappings(ID)).toHaveLength(1);
  });

  it('offers the repair candidate when the component simply moved', () => {
    const { mgr, root } = makeAggregateFixture();
    mgr.applyMappings(ID, root, [MOVED]);
    expect(mgr.getUnresolvedMappings(ID)[0].candidateComponentPath).toBe('Gripper');
  });

  it('offers NO candidate when nothing of that name and type is left', () => {
    const { mgr, root } = makeAggregateFixture();
    mgr.applyMappings(ID, root, [GONE]);
    const [only] = mgr.getUnresolvedMappings(ID);
    expect(only.candidateComponentPath).toBeUndefined();
    expect(only.reason).toBe('no-candidate');
  });

  it('gives a reason instead of a candidate for a legacy mapping', () => {
    // Same move as MOVED, but saved before `componentType` was persisted. Two
    // thirds of a key is not enough to act on, so it stays a plain orphan.
    const legacy: SignalMapping = { ...MOVED };
    delete legacy.componentType;
    const { mgr, root } = makeAggregateFixture();
    mgr.applyMappings(ID, root, [legacy]);
    const [only] = mgr.getUnresolvedMappings(ID);
    expect(only.candidateComponentPath).toBeUndefined();
    expect(only.reason).toBe('no-component-type');
  });

  it('never binds the candidate by itself', () => {
    // The offer is an offer. Nothing is wired until a human says so.
    const { mgr, root } = makeAggregateFixture();
    const applied = mgr.applyMappings(ID, root, [MOVED]);
    expect(applied).toEqual([]);
    expect(mgr.getBindingLiveness(ID, 'Forward', 'Gripper')).toBeUndefined();
  });

  it('CLEARS a stale finding once the mapping resolves again', () => {
    // Otherwise a repaired binding would go on being reported forever.
    const { mgr, root } = makeAggregateFixture();
    mgr.applyMappings(ID, root, [MOVED]);
    expect(mgr.getUnresolvedMappings(ID)).toHaveLength(1);
    mgr.applyMappings(ID, root, [GOOD]);
    expect(mgr.getUnresolvedMappings(ID)).toEqual([]);
  });

  it('forgets the finding when the element itself goes away', () => {
    const { mgr, root } = makeAggregateFixture();
    mgr.applyMappings(ID, root, [MOVED]);
    mgr.unbindAll(ID);
    expect(mgr.getUnresolvedMappings(ID)).toEqual([]);
  });

  it('surfaces the findings of every element for whole-scene reporting', () => {
    const { mgr, root } = makeAggregateFixture();
    mgr.applyMappings(ID, root, [MOVED]);
    expect([...mgr.getAllUnresolvedMappings().keys()]).toEqual([ID]);
  });
});
