// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * contract-node-identity R4/R10 — an internal signal source stored by ADDRESS is
 * bound by that address only. The signal NAME stored next to it is a display
 * cache, never a fallback:
 *
 *  - load: a `sourceAddress` that names no signal leaves the slot EMPTY and puts a
 *    `signal-binding-unresolved` entry in Problems — even when a signal with the
 *    stored name exists elsewhere;
 *  - runtime: deleting the bound signal and creating a same-named one at another
 *    node does not hand the slot to the impostor; undoing the delete binds again;
 *  - save: a mapping that already carries an address keeps it — the stale name is
 *    never re-derived into a new address;
 *  - a mapping without an address (a fresh pick in the UI) is still bound by the
 *    name the person picked, and a `sourceAddress` that resolves follows a rename.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Group, Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { traverseAndRegister } from '../src/core/engine/rv-scene-loader';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { fromStoredMapping, toStoredMapping } from '../src/core/engine/rv-signal-mapping-address';
import { syncSignalSubtree } from '../src/core/engine/rv-signal-editor-sync';
import { RV_SEEDED_NODE_ID_KEY } from '../src/core/engine/rv-authored-keys';
import { ROOT_OCCURRENCE, childOccurrence } from '../src/core/engine/rv-node-id';
import { getProblems, clearProblemsOfCode } from '../src/core/hmi/problems-store';
import type { SignalMapping } from '../src/plugins/layout-planner/rv-layout-store';

const CODE = 'signal-binding-unresolved';
const LAMP_ID = 'a0000000-0000-5000-8000-00000000000a';
const OTHER_ID = 'a0000000-0000-5000-8000-00000000000b';
const GONE_ID = 'a0000000-0000-5000-8000-0000000000ff';

function node(name: string, parent: Object3D, id: string, rv?: Record<string, unknown>): Object3D {
  const n = new Object3D();
  n.name = name;
  n.userData[RV_SEEDED_NODE_ID_KEY] = id;
  if (rv) n.userData.realvirtual = rv;
  parent.add(n);
  return n;
}

const lampSignal = (): Record<string, unknown> => ({ PLCOutputBool: { Name: 'Lamp.On', Status: { Value: false } } });

function plant() {
  const scene = new Scene();
  const root = new Group();
  root.name = 'Plant';
  root.userData[RV_SEEDED_NODE_ID_KEY] = 'a0000000-0000-5000-8000-000000000001';
  scene.add(root);
  const carrier = node('Valve', root, 'a0000000-0000-5000-8000-000000000002', { PLCInputBool: { Name: 'Valve.Cmd', Status: { Value: false } } });
  const lamp = node('Lamp', root, LAMP_ID, lampSignal());
  const other = node('Other', root, OTHER_ID);
  const registry = new NodeRegistry();
  const store = new SignalStore();
  root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  registry.registerDocument(root, ROOT_OCCURRENCE);
  traverseAndRegister(root, registry, store, new Map());
  store.buildIndex();
  const manager = new SignalBindingManager(store, registry);
  return { root, carrier, lamp, other, registry, store, manager };
}

const internal = (extra: Partial<SignalMapping>): SignalMapping => ({
  slot: 'Value', sourceKind: 'internal', signal: 'Lamp.On', direction: 'plcOutput', enabled: true, ...extra,
});

const problems = () => getProblems().filter((p) => p.code === CODE);

/** Drive the source and let the relay flush; returns the slot value. */
function relay(p: ReturnType<typeof plant>, value: boolean): unknown {
  p.store.set('Lamp.On', value);
  p.manager.tick(0.02);
  p.manager.tick(0.02);
  return p.store.get('Valve.Cmd');
}

describe('internal signal source by address — no fallback to the stored name', () => {
  beforeEach(() => clearProblemsOfCode(CODE));

  it('load: an address that names nothing leaves the slot empty although "Lamp.On" exists elsewhere', () => {
    const p = plant();
    const applied = p.manager.applyMappings('Valve', p.carrier, [internal({ sourceAddress: `#${GONE_ID}` })]);
    expect(applied).toEqual([]);
    expect(p.manager.getUnresolvedMappings('Valve')).toHaveLength(1);
    expect(relay(p, true)).not.toBe(true);
    expect(problems()).toHaveLength(1);
    expect(problems()[0].nodePath ?? '').toContain('Valve');
  });

  it('load: an address on a node without a signal is unresolved too', () => {
    const p = plant();
    const applied = p.manager.applyMappings('Valve', p.carrier, [internal({ sourceAddress: `#${OTHER_ID}` })]);
    expect(applied).toEqual([]);
    expect(problems()).toHaveLength(1);
  });

  it('fromStoredMapping marks the unresolved source instead of keeping the stored name as truth', () => {
    const p = plant();
    const live = fromStoredMapping(internal({ sourceAddress: `#${GONE_ID}` }), p.carrier, p.registry, p.store);
    expect(live.sourceUnresolved).toBe('missing');
    const ok = fromStoredMapping(internal({ sourceAddress: `#${LAMP_ID}`, signal: 'Old.Name' }), p.carrier, p.registry, p.store);
    expect(ok.signal).toBe('Lamp.On');
    expect(ok.sourceUnresolved).toBeUndefined();
  });

  it('a resolving address binds and follows the node, not the stored name', () => {
    const p = plant();
    const applied = p.manager.applyMappings('Valve', p.carrier, [internal({ sourceAddress: `#${LAMP_ID}`, signal: 'Old.Name' })]);
    expect(applied).toHaveLength(1);
    expect(applied[0].signal).toBe('Lamp.On');
    expect(problems()).toHaveLength(0);
    expect(relay(p, true)).toBe(true);
  });

  it('a fresh mapping without address is bound by the picked name (UI pick)', () => {
    const p = plant();
    const applied = p.manager.applyMappings('Valve', p.carrier, [internal({})]);
    expect(applied).toHaveLength(1);
    expect(relay(p, true)).toBe(true);
  });

  it('runtime: delete the bound signal, create a same-named one elsewhere — the slot stays empty; undo binds again', () => {
    const p = plant();
    p.manager.applyMappings('Valve', p.carrier, [internal({ sourceAddress: `#${LAMP_ID}` })]);
    expect(relay(p, true)).toBe(true);
    expect(relay(p, false)).toBe(false);

    // Delete the lamp node (editor delete: detach, index, signal sync).
    p.lamp.removeFromParent();
    p.registry.unregisterSubtree(p.lamp);
    syncSignalSubtree({ signalStore: p.store, registry: p.registry }, p.lamp);
    // A NEW signal with the same name on another node.
    p.other.userData.realvirtual = lampSignal();
    syncSignalSubtree({ signalStore: p.store, registry: p.registry }, p.other);
    expect(p.store.getPath('Lamp.On')).toBe('Plant/Other');

    expect(relay(p, true)).not.toBe(true);
    expect(p.manager.getUnresolvedMappings('Valve')).toHaveLength(1);
    expect(problems()).toHaveLength(1);

    // The impostor goes, the lamp comes back (undo): bound again, problem retired.
    delete p.other.userData.realvirtual;
    syncSignalSubtree({ signalStore: p.store, registry: p.registry }, p.other);
    p.root.add(p.lamp);
    p.registry.registerNode('Plant/Lamp', p.lamp);
    p.registry.registerSubtreeIds(p.lamp);
    syncSignalSubtree({ signalStore: p.store, registry: p.registry }, p.lamp);
    expect(p.manager.getUnresolvedMappings('Valve')).toHaveLength(0);
    expect(problems()).toHaveLength(0);
    expect(relay(p, true)).toBe(true);
  });

  it('a control slot whose source is deleted goes neutral, not latched (Codex r4 P2)', () => {
    const p = plant();
    p.manager.applyMappings('Valve', p.carrier, [internal({ sourceAddress: `#${LAMP_ID}` })]);
    expect(relay(p, true)).toBe(true);
    p.lamp.removeFromParent();
    p.registry.unregisterSubtree(p.lamp);
    syncSignalSubtree({ signalStore: p.store, registry: p.registry }, p.lamp);
    p.manager.tick(0.02);
    expect(p.store.get('Valve.Cmd')).toBe(false);
  });

  it('a disabled mapping never neutralises the slot when its source goes (Codex r5 P2)', () => {
    const p = plant();
    p.manager.applyMappings('Valve', p.carrier, [internal({ sourceAddress: `#${LAMP_ID}`, enabled: false })]);
    p.manager.tick(0.02);
    p.store.set('Valve.Cmd', true);
    p.lamp.removeFromParent();
    p.registry.unregisterSubtree(p.lamp);
    syncSignalSubtree({ signalStore: p.store, registry: p.registry }, p.lamp);
    p.manager.tick(0.02);
    expect(p.store.get('Valve.Cmd')).toBe(true);
  });

  it('a source restored without a catalog event (placement undo) binds again (Codex r5 P2)', async () => {
    const p = plant();
    p.manager.applyMappings('Valve', p.carrier, [internal({ sourceAddress: `#${LAMP_ID}` })]);
    p.lamp.removeFromParent();
    p.registry.unregisterSubtree(p.lamp);
    syncSignalSubtree({ signalStore: p.store, registry: p.registry }, p.lamp);
    expect(p.manager.getUnresolvedMappings('Valve')).toHaveLength(1);
    // Restored the way placement content is: registry + plain register(), no catalog event.
    p.root.add(p.lamp);
    p.registry.registerNode('Plant/Lamp', p.lamp);
    p.registry.registerSubtreeIds(p.lamp);
    traverseAndRegister(p.lamp, p.registry, p.store, new Map());
    await Promise.resolve();
    expect(p.manager.getUnresolvedMappings('Valve')).toHaveLength(0);
    expect(problems()).toHaveLength(0);
    expect(relay(p, true)).toBe(true);
  });

  it('recheckSources binds a restored source whose name never left the store (Codex r6 P2)', () => {
    const p = plant();
    p.manager.applyMappings('Valve', p.carrier, [internal({ sourceAddress: `#${LAMP_ID}` })]);
    // The node goes, the NAME stays (CONNECT still owns it): no new-name event on restore.
    p.registry.unregisterSubtree(p.lamp);
    p.store.notifyCatalogChanged({ registered: [], released: ['Lamp.On'], removed: [], metaChanged: [], renamed: [] });
    expect(p.manager.getUnresolvedMappings('Valve')).toHaveLength(1);
    p.registry.registerNode('Plant/Lamp', p.lamp);
    p.registry.registerSubtreeIds(p.lamp);
    p.manager.recheckSources();
    expect(p.manager.getUnresolvedMappings('Valve')).toHaveLength(0);
    expect(problems()).toHaveLength(0);
  });

  it('save: an address the mapping carries is kept — the stale name is not re-derived', () => {
    const p = plant();
    // "Lamp.On" is now a signal on Other; the mapping still names the lamp by address.
    const stored = toStoredMapping(
      { ...internal({ sourceAddress: `#${GONE_ID}` }), sourceUnresolved: 'missing' as const },
      p.carrier, p.registry, p.store);
    expect(stored.sourceAddress).toBe(`#${GONE_ID}`);
    expect('sourceUnresolved' in stored).toBe(false);
    // A fresh pick (no address yet) gets the address of the picked signal's node.
    const fresh = toStoredMapping(internal({}), p.carrier, p.registry, p.store);
    expect(fresh.sourceAddress).toBe(`#${LAMP_ID}`);
  });

  describe('a source addressed into a placement still loading (R8)', () => {
    const PL_ID = 'a0000000-0000-5000-8000-0000000000c1';
    const SIG_ID = 'a0000000-0000-5000-8000-0000000000c2';
    function withPendingPlacement() {
      const p = plant();
      const machine = new Object3D();
      machine.name = 'Machine';
      machine.userData._layoutId = 'pl-1';
      machine.userData[RV_SEEDED_NODE_ID_KEY] = PL_ID;
      p.root.add(machine);
      p.registry.registerNode('Plant/Machine', machine);
      p.registry.registerNodeIdInParentDocument(machine);
      const mapping = internal({ signal: 'Machine.Out', sourceAddress: `${PL_ID}#${SIG_ID}` });
      p.manager.applyMappings('Valve', p.carrier, [mapping]);
      return { ...p, machine };
    }

    it('waits without a problem, binds when the placement content arrives', () => {
      const p = withPendingPlacement();
      expect(p.manager.getUnresolvedMappings('Valve')).toHaveLength(1);
      expect(problems()).toHaveLength(0);
      expect(p.registry.pendingRefCount()).toBe(1);
      const sig = new Object3D();
      sig.name = 'Out';
      sig.userData[RV_SEEDED_NODE_ID_KEY] = SIG_ID;
      sig.userData.realvirtual = { PLCOutputBool: { Name: 'Machine.Out', Status: { Value: false } } };
      p.machine.add(sig);
      p.registry.registerNode('Plant/Machine/Out', sig);
      p.registry.registerOccurrence(p.machine, childOccurrence(ROOT_OCCURRENCE, PL_ID));
      syncSignalSubtree({ signalStore: p.store, registry: p.registry }, sig);
      p.registry.flushPendingRefs();
      expect(p.manager.getUnresolvedMappings('Valve')).toHaveLength(0);
      p.store.set('Machine.Out', true);
      p.manager.tick(0.02);
      p.manager.tick(0.02);
      expect(p.store.get('Valve.Cmd')).toBe(true);
    });

    it('a dropped wait is final: reported missing, never queued again', () => {
      const p = withPendingPlacement();
      p.registry.dropPendingRefs('placement-missing');
      expect(problems()).toHaveLength(1);
      expect(p.registry.pendingRefCount()).toBe(0);
      p.registry.settlePendingRefs();
      expect(p.registry.pendingRefCount()).toBe(0);
      expect(problems()).toHaveLength(1);
    });

    it('two pending sources dropped together both get their verdict (Codex r3 P2)', () => {
      const p = plant();
      const machine = new Object3D();
      machine.name = 'Machine';
      machine.userData._layoutId = 'pl-1';
      machine.userData[RV_SEEDED_NODE_ID_KEY] = PL_ID;
      p.root.add(machine);
      p.registry.registerNode('Plant/Machine', machine);
      p.registry.registerNodeIdInParentDocument(machine);
      const cell = new Group();
      cell.name = 'Cell';
      p.root.add(cell);
      const a = node('A', cell, 'a0000000-0000-5000-8000-0000000000e1', { PLCInputBool: { Name: 'A.Cmd', Status: { Value: false } } });
      const b = node('B', cell, 'a0000000-0000-5000-8000-0000000000e2', { PLCInputBool: { Name: 'B.Cmd', Status: { Value: false } } });
      for (const n of [cell, a, b]) p.registry.registerNode(NodeRegistry.computeNodePath(n), n);
      p.registry.registerSubtreeIds(cell);
      traverseAndRegister(cell, p.registry, p.store, new Map());
      p.manager.applyMappings('Cell', cell, [
        internal({ componentPath: 'A', signal: 'M.One', sourceAddress: `${PL_ID}#${SIG_ID}` }),
        internal({ componentPath: 'B', signal: 'M.Two', sourceAddress: `${PL_ID}#a0000000-0000-5000-8000-0000000000c3` }),
      ]);
      expect(p.registry.pendingRefCount()).toBe(2);
      p.registry.settlePendingRefs();
      expect(p.registry.pendingRefCount()).toBe(0);
      expect(problems()).toHaveLength(2);
    });
  });

  it('a re-check touches only the changed source: the unrelated CONNECT slot keeps its binding and provider (Codex r2 P2, r3 P2)', () => {
    const p = plant();
    const cell = new Group();
    cell.name = 'Cell';
    p.root.add(cell);
    const a = node('A', cell, 'a0000000-0000-5000-8000-0000000000d1', { PLCInputBool: { Name: 'A.Cmd', Status: { Value: false } } });
    const b = node('B', cell, 'a0000000-0000-5000-8000-0000000000d2', { PLCInputBool: { Name: 'B.Cmd', Status: { Value: false } } });
    for (const n of [cell, a, b]) p.registry.registerNode(NodeRegistry.computeNodePath(n), n);
    p.registry.registerSubtreeIds(cell);
    traverseAndRegister(cell, p.registry, p.store, new Map());
    p.store.register('Ext.Run', '__iface__/Ext.Run', true, 'PLCOutputBool');
    p.store.registerSignalProvider({ interfaceId: 'if-a', signal: 'Ext.Run' }, true);
    p.manager.applyMappings('Cell', cell, [
      internal({ componentPath: 'A', sourceAddress: `#${LAMP_ID}` }),
      { slot: 'Value', componentPath: 'B', signal: 'Ext.Run', direction: 'plcOutput', enabled: true },
    ]);
    type Internals = { _elements: Map<string, { bindings: Map<string, { mapping: SignalMapping; resolved: { componentPath: string } }> }> };
    const bindingOfB = () => [...(p.manager as unknown as Internals)._elements.get('Cell')!.bindings.values()]
      .find((x) => x.resolved.componentPath === 'B');
    const before = bindingOfB();
    expect(before).toBeDefined();
    // Provider A goes, B advertises the same name; then the internal source is deleted.
    p.store.unregisterSignalProvider({ interfaceId: 'if-a' });
    p.store.registerSignalProvider({ interfaceId: 'if-b', signal: 'Ext.Run' }, true);
    p.lamp.removeFromParent();
    p.registry.unregisterSubtree(p.lamp);
    syncSignalSubtree({ signalStore: p.store, registry: p.registry }, p.lamp);
    expect(p.manager.getUnresolvedMappings('Cell')).toHaveLength(1);
    expect(p.manager.getUnresolvedMappings('Cell')[0].mapping.componentPath).not.toBe('B');
    // White-box: the CONNECT slot is the SAME binding (no re-bind, no handover), still on if-a.
    expect(bindingOfB()).toBe(before);
    expect(bindingOfB()?.mapping.interfaceId).toBe('if-a');
  });

  it('dispose retires the problems of the manager', () => {
    const p = plant();
    p.manager.applyMappings('Valve', p.carrier, [internal({ sourceAddress: `#${GONE_ID}` })]);
    expect(problems()).toHaveLength(1);
    p.manager.dispose();
    expect(problems()).toHaveLength(0);
  });
});
