// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * 9.9 signal-binding-type-and-direction — type-mismatch=conflict, PLC direction
 * protection, enabled flag.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { clearLiveControl } from '../src/core/engine/rv-live-control';
import { scopeSignalName } from '../src/core/engine/rv-instance-scope';
import type { SignalMapping } from '../src/plugins/layout-planner/rv-layout-store';

function makeConveyor(store: SignalStore, registry: NodeRegistry, scope: string): Object3D {
  const root = new Object3D();
  root.name = scope;
  root.userData.realvirtual = { LayoutObject: { Label: scope }, Conveyor: {} };
  registry.registerNode(scope, root);
  for (const key of ['Run', 'PartCount']) {
    store.register(scopeSignalName(scope, `Flow.${key}`), `${scope}/Flow.${key}`, key === 'PartCount' ? 0 : false,
      key === 'Run' ? 'PLCInputBool' : 'PLCOutputInt');
  }
  return root;
}

describe('signal-binding type and direction', () => {
  beforeEach(() => clearLiveControl());

  it('flags a float source bound to a bool slot as a conflict', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    const mgr = new SignalBindingManager(store, registry);
    const root = makeConveyor(store, registry, 'C1');

    store.register('Speed', '__iface__/Speed', 3.5, 'PLCOutputFloat');
    mgr.bind('id', root, { slot: 'Flow.Run', signal: 'Speed', direction: 'plcInput', enabled: true });
    mgr.tick(1 / 60);

    expect(mgr.getElementState('id')).toBe('conflict');
    // A conflicting source does not put the element under live control.
    expect(mgr.isLive('id')).toBe(false);
  });

  it('plcOutput slots are read-only for viewer→PLC writes; plcInput writable', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    const mgr = new SignalBindingManager(store, registry);
    const root = makeConveyor(store, registry, 'C2');

    store.register('Run.Src', '__iface__/Run.Src', false, 'PLCInputBool');
    store.register('Occ.Src', '__iface__/Occ.Src', false, 'PLCOutputBool');
    mgr.bind('id', root, { slot: 'Flow.Run', signal: 'Run.Src', direction: 'plcInput', enabled: true });
    mgr.bind('id', root, { slot: 'Flow.Occupied', signal: 'Occ.Src', direction: 'plcOutput', enabled: true });

    // plcInput slot: viewer write reaches the source.
    expect(mgr.writeToSource('id', 'Flow.Run', true)).toBe(true);
    expect(store.getBool('Run.Src')).toBe(true);

    // plcOutput slot: viewer write is ignored (read-only).
    expect(mgr.writeToSource('id', 'Flow.Occupied', true)).toBe(false);
    expect(store.getBool('Occ.Src')).toBe(false);
  });

  it('enabled=false disables a binding without deleting it', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    const mgr = new SignalBindingManager(store, registry);
    const root = makeConveyor(store, registry, 'C3');
    const flowRun = scopeSignalName('C3', 'Flow.Run');

    store.register('Src', '__iface__/Src', true, 'PLCOutputBool');
    const m: SignalMapping = { slot: 'Flow.Run', signal: 'Src', direction: 'plcInput', enabled: false };
    mgr.bind('id', root, m);
    mgr.tick(1 / 60);

    // Disabled → not live, slot not driven.
    expect(mgr.isLive('id')).toBe(false);
    expect(store.getBool(flowRun)).toBe(false);

    // Flip enabled in place (no re-bind) → relay applies on next source change.
    m.enabled = true;
    store.set('Src', false);
    store.set('Src', true);
    mgr.tick(1 / 60);
    expect(mgr.isLive('id')).toBe(true);
    expect(store.getBool(flowRun)).toBe(true);
  });

  it('the enabled flag survives serialize/deserialize', () => {
    const mapping: SignalMapping = { slot: 'Flow.Run', signal: 'Src', direction: 'plcInput', enabled: false };
    const restored = JSON.parse(JSON.stringify(mapping)) as SignalMapping;
    expect(restored.enabled).toBe(false);
  });
});
