// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-418 9.3 — the bind flow on a raw PLC signal node, in the REAL tick order.
 *
 * The binding manager runs in `TickStage.PRE` (after the interface flush,
 * before drive physics and the LogicStep engine), so every assertion here is
 * made after `manager.tick(dt)` and never by poking `setSignalLiveControlled`
 * by hand — the point of the suite is that the manager itself raises and drops
 * the gate for a signal node.
 *
 * The fixture is Werner's case (plan-417 demo): a MainCycle-style LogicStep
 * drives `EntryConveyorStart` locally until an external PLC tag is bound to
 * that very signal — from then on the step must stay silent.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { registerSignal } from '../src/core/engine/rv-signal-construction';
import { PLC_SIGNAL_SLOT } from '../src/core/engine/rv-binding-slot-resolver';
import { RVSetSignalBool, StepState } from '../src/core/engine/rv-logic-step';
import { isSignalLiveControlled, resetSlotAuthority } from '../src/core/engine/rv-slot-authority';
import type { SignalMapping } from '../src/plugins/layout-planner/rv-layout-store';

const DT = 1 / 60;
const SIGNAL_PATH = 'DemoCell/PLCInterface/EntryConveyorStart';

function fixture() {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'DemoCell';
  scene.add(root);
  const registry = new NodeRegistry();
  const store = new SignalStore();
  registry.registerNode('DemoCell', root);

  const iface = new Object3D();
  iface.name = 'PLCInterface';
  root.add(iface);
  registry.registerNode('DemoCell/PLCInterface', iface);

  const node = new Object3D();
  node.name = 'EntryConveyorStart';
  iface.add(node);
  const sigData = { Name: 'EntryConveyorStart', Status: { Value: false } };
  node.userData.realvirtual = { PLCOutputBool: sigData };
  registry.registerNode(SIGNAL_PATH, node);
  registerSignal(node, 'PLCOutputBool', sigData, SIGNAL_PATH, store, registry);

  // The external tag the integrator drags onto the node. With no interface
  // layer registered the store itself is the provider (standalone contract).
  store.register('PLC.StartConveyor', 'PLC/StartConveyor', false, 'PLCOutputBool');
  store.buildIndex();

  return { scene, root, node, registry, store };
}

const MAPPING: SignalMapping = {
  kind: 'mapped-signal',
  componentPath: '.',
  slot: PLC_SIGNAL_SLOT,
  signal: 'PLC.StartConveyor',
  interfaceId: 'plc',
  direction: 'plcOutput',
  enabled: true,
};

describe('binding a raw PLC signal node', () => {
  beforeEach(resetSlotAuthority);
  afterEach(resetSlotAuthority);

  it('raises the name-keyed live-control gate on the first tick', () => {
    const f = fixture();
    const manager = new SignalBindingManager(f.store, f.registry);
    manager.getElementSlots(SIGNAL_PATH, f.node, 'own');

    expect(isSignalLiveControlled('EntryConveyorStart')).toBe(false);

    manager.bind(SIGNAL_PATH, f.node, { ...MAPPING });
    manager.tick(DT);

    expect(manager.getBindingLiveness(SIGNAL_PATH, PLC_SIGNAL_SLOT, '.')).toBe('live');
    expect(isSignalLiveControlled('EntryConveyorStart')).toBe(true);
  });

  it('relays the external value into the signal', () => {
    const f = fixture();
    const manager = new SignalBindingManager(f.store, f.registry);
    manager.getElementSlots(SIGNAL_PATH, f.node, 'own');
    manager.bind(SIGNAL_PATH, f.node, { ...MAPPING });
    manager.tick(DT);

    f.store.set('PLC.StartConveyor', true);
    manager.tick(DT);

    expect(f.store.get('EntryConveyorStart')).toBe(true);
  });

  it('Werner scenario: the local LogicStep goes silent while the PLC owns the signal', () => {
    const f = fixture();
    const manager = new SignalBindingManager(f.store, f.registry);
    manager.getElementSlots(SIGNAL_PATH, f.node, 'own');

    // Before binding: the model drives itself.
    const before = new RVSetSignalBool(SIGNAL_PATH, true, f.store);
    manager.tick(DT);
    before.start();
    expect(before.reason).toBeUndefined();
    expect(f.store.get('EntryConveyorStart')).toBe(true);

    // Integrator binds his own tag onto the internal signal.
    manager.bind(SIGNAL_PATH, f.node, { ...MAPPING });
    manager.tick(DT); // PRE stage — gate goes up before the logic engine runs

    const during = new RVSetSignalBool(SIGNAL_PATH, true, f.store);
    during.start();
    expect(during.state).toBe(StepState.Finished);
    expect(during.reason).toBe('suppressed-live');

    // …and the model value now follows the PLC, not the step.
    f.store.set('PLC.StartConveyor', false);
    manager.tick(DT);
    expect(f.store.get('EntryConveyorStart')).toBe(false);
  });

  it('unbinding hands the signal back to the local logic', () => {
    const f = fixture();
    const manager = new SignalBindingManager(f.store, f.registry);
    manager.getElementSlots(SIGNAL_PATH, f.node, 'own');
    manager.bind(SIGNAL_PATH, f.node, { ...MAPPING });
    manager.tick(DT);
    expect(isSignalLiveControlled('EntryConveyorStart')).toBe(true);

    manager.unbindAll(SIGNAL_PATH);

    expect(isSignalLiveControlled('EntryConveyorStart')).toBe(false);
    const after = new RVSetSignalBool(SIGNAL_PATH, true, f.store);
    after.start();
    expect(after.reason).toBeUndefined();
    expect(f.store.get('EntryConveyorStart')).toBe(true);
  });

  it('applyMappings survives a reload cycle and re-raises the gate', () => {
    const f = fixture();
    const manager = new SignalBindingManager(f.store, f.registry);
    const applied = manager.applyMappings(SIGNAL_PATH, f.node, [{ ...MAPPING }]);

    expect(applied).toHaveLength(1);
    manager.tick(DT);
    expect(isSignalLiveControlled('EntryConveyorStart')).toBe(true);
  });
});
