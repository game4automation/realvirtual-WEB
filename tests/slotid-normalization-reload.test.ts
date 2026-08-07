// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * 9.7 slotid-normalization-reload — legacy mappings dock onto the CANONICAL
 * SlotId through the bind() backfill path (same path as
 * tests/legacy-mapping-migration.test.ts — that suite must stay green).
 *
 *  - A legacy mapping without kind/componentPath resolves to the SAME SlotId
 *    as a fully specified mapping; componentType is folded in from the active
 *    registry instance (plan-317 §2.4: one active instance per node).
 *  - Fallback: a mapping whose component is gone (no registry instance /
 *    no such slot) binds nothing — defined, non-throwing.
 *  - Persistence format is unchanged: the mapping object still carries only
 *    componentPath + slot (+ kind backfill), never a componentType field.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { RVDrive } from '../src/core/engine/rv-drive';
import { RVDriveSimple } from '../src/core/engine/rv-drive-simple';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import {
  SLOT_ID_SEPARATOR,
  resetSlotAuthority,
} from '../src/core/engine/rv-slot-authority';
import type { SignalMapping } from '../src/plugins/layout-planner/rv-layout-store';

afterEach(() => resetSlotAuthority());

function driveFixture() {
  const store = new SignalStore();
  const registry = new NodeRegistry();
  const scene = new Scene();
  const node = new Object3D();
  node.name = 'DriveNode';
  node.userData.realvirtual = { Drive: {}, Drive_Simple: {} };
  scene.add(node);
  const path = NodeRegistry.computeNodePath(node);
  registry.registerNode(path, node);
  const drive = new RVDrive(node);
  drive.initDrive();
  registry.register('Drive', path, drive);
  store.register('Drive.Forward', `${path}/Signals/Forward`, false, 'PLCOutputBool');
  store.buildIndex();
  const adapter = new RVDriveSimple(node);
  adapter.Forward = `${path}/Signals/Forward`;
  registry.register('Drive_Simple', path, adapter);
  adapter.init({
    registry, signalStore: store, scene, root: scene,
    transportManager: new RVTransportManager(),
  });
  store.register('Source.Forward', '__iface__/Source.Forward', true, 'PLCOutputBool');
  return { store, registry, node };
}

describe('SlotId normalization on reload (9.7)', () => {
  it('legacy mapping without kind/componentPath docks onto the canonical SlotId', () => {
    const { store, registry, node } = driveFixture();
    const manager = new SignalBindingManager(store, registry);

    const full: SignalMapping = {
      kind: 'mapped-signal', componentPath: '.',
      slot: 'Forward', signal: 'Source.Forward', direction: 'plcOutput', enabled: true,
    };
    manager.bind('drive', node, full);
    const canonical = manager.getSlotId('drive', 'Forward', '.');
    expect(canonical).toBeDefined();

    // Reload with the LEGACY persistence shape (no kind, no componentPath).
    manager.unbindAll('drive');
    const legacy: SignalMapping = {
      slot: 'Forward', signal: 'Source.Forward', direction: 'plcOutput', enabled: true,
    };
    manager.bind('drive', node, legacy);
    const normalized = manager.getSlotId('drive', 'Forward', '.');
    expect(normalized).toBe(canonical);

    // componentType folded in from the active registry instance…
    expect(String(normalized).split(SLOT_ID_SEPARATOR))
      .toEqual(['drive', '.', 'Drive_Simple', 'Forward']);
    // …while the mapping was only backfilled with kind + componentPath —
    // the persistence format never grows a componentType field.
    expect(legacy.kind).toBe('mapped-signal');
    expect(legacy.componentPath).toBe('.');
    expect('componentType' in legacy).toBe(false);
  });

  it('a mapping whose component no longer resolves binds nothing and never throws', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    const node = new Object3D();
    node.name = 'Ghost';
    // rv_extras announce a component but NO registry instance exists
    // (component removed) → the resolver yields no slot for it.
    node.userData.realvirtual = { Drive_Simple: {} };
    registry.registerNode('Ghost', node);
    const manager = new SignalBindingManager(store, registry);

    expect(() => manager.bind('ghost', node, {
      slot: 'Forward', signal: 'Missing.Source', direction: 'plcOutput', enabled: true,
    })).not.toThrow();
    expect(manager.getSlotId('ghost', 'Forward')).toBeUndefined();
    expect(manager.getElementState('ghost')).toBe('unbound');
  });

  it('very old conveyor mappings without componentPath normalize tolerantly', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    const root = new Object3D();
    root.name = 'Conveyor';
    root.userData.realvirtual = { Conveyor: {} };
    registry.registerNode('Conveyor', root);
    store.register('Flow.Run', 'Conveyor/Flow.Run', false);
    store.register('Run', '__iface__/Run', true, 'PLCOutputBool');
    const manager = new SignalBindingManager(store, registry);

    const mapping: SignalMapping = {
      slot: 'Flow.Run', signal: 'Run', direction: 'plcInput', enabled: true,
    };
    manager.bind('Conveyor', root, mapping);
    manager.tick(0.02);
    const slotId = manager.getSlotId('Conveyor', 'Flow.Run');
    expect(slotId).toBeDefined();
    // Synthetic behavior slot: componentType is the behavior key itself.
    expect(String(slotId).split(SLOT_ID_SEPARATOR))
      .toEqual(['Conveyor', '.', 'Conveyor', 'Flow.Run']);
    expect(manager.getBindingLiveness('Conveyor', 'Flow.Run')).toBe('live');
  });
});
