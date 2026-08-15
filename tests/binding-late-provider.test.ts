// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-421 §9.2 — late provider resolution (F2/F3), the core of "the order
 * must not matter".
 *
 * A names-only CONNECT mapping (no `interfaceId`) is bound while CONNECT is
 * still down. Before plan-421 `bind()` resolved the provider identity exactly
 * once and the binding stayed `pending` forever — the reported "links are gone
 * after reload". Here it must resolve IN THE TICK, atomically (interfaceId,
 * topic and feedbackKey together, claims moved with them) and without ever
 * guessing between two providers.
 *
 * Test template: tests/provider-loss.test.ts (fixture + liveness assertions),
 * tests/bind-persistence-restore.test.ts (the pre-resolved reference case).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Object3D } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { resetSlotAuthority } from '../src/core/engine/rv-slot-authority';
import { scopeSignalName } from '../src/core/engine/rv-instance-scope';
import type { SignalMapping } from '../src/plugins/layout-planner/rv-layout-store';

afterEach(() => resetSlotAuthority());

/** One conveyor element whose `Flow.Run` slot is bindable. */
function fixture(slotType: 'PLCOutputBool' | 'PLCInputBool' = 'PLCOutputBool', id = 'Conv') {
  const store = new SignalStore();
  const registry = new NodeRegistry();
  const root = new Object3D();
  root.name = id;
  root.userData.realvirtual = { LayoutObject: { Label: id }, Conveyor: {} };
  registry.registerNode(id, root);
  const target = scopeSignalName(id, 'Flow.Run');
  store.register(target, `${id}/Flow.Run`, false, slotType);
  const manager = new SignalBindingManager(store, registry);
  manager.holdMs = 800;
  return { store, registry, manager, root, target, id };
}

/** A CONNECT provider advertising `signal`, as ConnectPlugin.syncProviders would. */
function addProvider(
  store: SignalStore,
  interfaceId: string,
  signal: string,
  connected = true,
  topic?: string,
): void {
  store.register(signal, `__iface__/${signal}`, true, 'PLCOutputBool');
  store.registerSignalProvider(
    { interfaceId, ...(topic !== undefined ? { topic } : {}), signal },
    connected,
  );
}

/** A mapping WITHOUT `interfaceId` — what an authored/legacy link looks like. */
function namesOnly(signal: string, extra: Partial<SignalMapping> = {}): SignalMapping {
  return { slot: 'Flow.Run', signal, direction: 'plcOutput', enabled: true, ...extra };
}

/**
 * The mapping the manager actually holds. `applyMappings` binds COPIES, so the
 * object handed in never sees the resolution — read it back from the binding.
 */
function boundMapping(manager: SignalBindingManager, placedId: string): SignalMapping {
  const elements = manager['_elements'] as Map<string, { bindings: Map<string, { mapping: SignalMapping }> }>;
  return elements.get(placedId)!.bindings.values().next().value!.mapping;
}

/**
 * An unrelated connected provider. Its only job is to keep
 * `store.signalProviderCount` above zero: at zero the manager falls back to the
 * pre-plan-421 STANDALONE engine contract (`rv-signal-binding-manager.ts:772`),
 * where the mere presence of a value makes a binding live. That path is not
 * under test here and would mask the states we assert.
 */
function keepProviderLayerAlive(store: SignalStore): void {
  addProvider(store, 'decoy', 'Decoy.Sig');
}

describe('late provider resolution (plan-421 §9.2)', () => {
  it('resolves a names-only mapping when the provider appears AFTER the model', () => {
    const { store, manager, root, target } = fixture();
    manager.applyMappings('Conv', root, [namesOnly('Src.Run')]);
    manager.tick(0.02);
    // Nothing advertises the name yet — pending, and still unresolved.
    expect(manager.getBindingLiveness('Conv', 'Flow.Run')).toBe('pending');

    addProvider(store, 'mqtt-1', 'Src.Run');
    manager.tick(0.02);

    expect(manager.getBindingLiveness('Conv', 'Flow.Run')).toBe('live');
    expect(store.getBool(target)).toBe(true); // the relay actually runs
  });

  it('writes interfaceId, topic and feedbackKey together (atomic identity move)', () => {
    const { store, manager, root } = fixture('PLCInputBool');
    // Feedback role: the binding OWNS a writer claim keyed by the full identity,
    // so a half-applied resolution would strand the old key in _feedbackWriters.
    manager.applyMappings('Conv', root, [namesOnly('Src.Fb', { direction: 'plcInput' })]);
    manager.tick(0.02);
    expect(boundMapping(manager, 'Conv').interfaceId).toBeUndefined();

    addProvider(store, 'mqtt-1', 'Src.Fb', true, 'line/1');
    manager.tick(0.02);

    expect(boundMapping(manager, 'Conv').interfaceId).toBe('mqtt-1');
    expect(boundMapping(manager, 'Conv').topic).toBe('line/1');
    expect(manager.getBindingLiveness('Conv', 'Flow.Run')).toBe('live');

    // Probe that the OLD (empty-identity) claim was released, not stranded: a
    // second element binding the same name while no provider is visible must
    // still get a clean claim. With a non-atomic move it would see the first
    // element's abandoned entry and report a fan-in conflict.
    store.unregisterSignalProvider({ interfaceId: 'mqtt-1', topic: 'line/1' });
    const second = new Object3D();
    second.name = 'Conv2';
    second.userData.realvirtual = { LayoutObject: { Label: 'Conv2' }, Conveyor: {} };
    manager['_registry'].registerNode('Conv2', second);
    store.register(scopeSignalName('Conv2', 'Flow.Run'), 'Conv2/Flow.Run', false, 'PLCInputBool');
    manager.applyMappings('Conv2', second, [namesOnly('Src.Fb', { direction: 'plcInput' })]);
    manager.tick(0.02);
    expect(manager.getBindingLiveness('Conv2', 'Flow.Run')).not.toBe('conflict');
  });

  it('moves the feedback claim so a fan-in with an already-resolved peer is detected', () => {
    const { store, manager, root } = fixture('PLCInputBool');
    addProvider(store, 'mqtt-1', 'Src.Fb');
    // Peer element, already carrying the resolved identity (the persisted case).
    const peer = new Object3D();
    peer.name = 'Peer';
    peer.userData.realvirtual = { LayoutObject: { Label: 'Peer' }, Conveyor: {} };
    manager['_registry'].registerNode('Peer', peer);
    store.register(scopeSignalName('Peer', 'Flow.Run'), 'Peer/Flow.Run', false, 'PLCInputBool');
    manager.applyMappings('Peer', peer, [
      namesOnly('Src.Fb', { direction: 'plcInput', interfaceId: 'mqtt-1' }),
    ]);
    // Names-only element joins afterwards and resolves onto the SAME identity.
    manager.applyMappings('Conv', root, [namesOnly('Src.Fb', { direction: 'plcInput' })]);
    manager.tick(0.02);

    expect(manager.getBindingLiveness('Peer', 'Flow.Run')).toBe('live');
    expect(manager.getBindingLiveness('Conv', 'Flow.Run')).toBe('conflict');
  });

  it('never guesses: two providers stay `conflict`, one resolves (0 → 2 → 1)', () => {
    const { store, manager, root } = fixture();
    manager.applyMappings('Conv', root, [namesOnly('Src.Run')]);
    manager.tick(0.02);
    expect(manager.getBindingLiveness('Conv', 'Flow.Run')).toBe('pending');

    addProvider(store, 'mqtt-1', 'Src.Run');
    addProvider(store, 'mqtt-2', 'Src.Run');
    manager.tick(0.02);
    expect(manager.getBindingLiveness('Conv', 'Flow.Run')).toBe('conflict');

    store.unregisterSignalProvider({ interfaceId: 'mqtt-2' });
    manager.tick(0.02);
    expect(manager.getBindingLiveness('Conv', 'Flow.Run')).toBe('live');
  });

  it('resolves after the ambiguity clears the other way round (2 → 0 → 1)', () => {
    const { store, manager, root } = fixture();
    keepProviderLayerAlive(store);
    addProvider(store, 'mqtt-1', 'Src.Run');
    addProvider(store, 'mqtt-2', 'Src.Run');
    manager.applyMappings('Conv', root, [namesOnly('Src.Run')]);
    manager.tick(0.02);
    expect(manager.getBindingLiveness('Conv', 'Flow.Run')).toBe('conflict');

    store.unregisterSignalProvider({ interfaceId: 'mqtt-1' });
    store.unregisterSignalProvider({ interfaceId: 'mqtt-2' });
    manager.tick(0.02);
    expect(manager.getBindingLiveness('Conv', 'Flow.Run')).toBe('pending');
    expect(boundMapping(manager, 'Conv').interfaceId).toBeUndefined();

    addProvider(store, 'mqtt-3', 'Src.Run');
    manager.tick(0.02);
    expect(manager.getBindingLiveness('Conv', 'Flow.Run')).toBe('live');
    expect(boundMapping(manager, 'Conv').interfaceId).toBe('mqtt-3');
  });

  it('treats the same name on two topics of ONE interface as ambiguous', () => {
    const { store, manager, root } = fixture();
    addProvider(store, 'mqtt-1', 'Src.Run', true, 'line/1');
    addProvider(store, 'mqtt-1', 'Src.Run', true, 'line/2');
    manager.applyMappings('Conv', root, [namesOnly('Src.Run')]);
    manager.tick(0.02);
    // Two provider KEYS (interface+topic) → no resolution, no guess.
    expect(manager.getBindingLiveness('Conv', 'Flow.Run')).toBe('conflict');
    expect(boundMapping(manager, 'Conv').interfaceId).toBeUndefined();

    store.unregisterSignalProvider({ interfaceId: 'mqtt-1', topic: 'line/2' });
    manager.tick(0.02);
    expect(manager.getBindingLiveness('Conv', 'Flow.Run')).toBe('live');
    expect(boundMapping(manager, 'Conv').topic).toBe('line/1');
  });

  it('keeps the resolved identity when a DIFFERENT provider takes over the name (A → B)', () => {
    const { store, manager, root } = fixture();
    addProvider(store, 'A', 'Src.Run');
    manager.applyMappings('Conv', root, [namesOnly('Src.Run')]);
    manager.tick(0.02);
    expect(boundMapping(manager, 'Conv').interfaceId).toBe('A');
    expect(manager.getBindingLiveness('Conv', 'Flow.Run')).toBe('live');

    // A goes, B arrives advertising the same name. The binding does NOT follow:
    // "no guessing" outranks convenience (plan-421 SOL-R2-4). A reload resolves
    // onto B naturally, because nothing about A was persisted.
    store.unregisterSignalProvider({ interfaceId: 'A' });
    addProvider(store, 'B', 'Src.Run');
    manager.tick(0.02);
    expect(boundMapping(manager, 'Conv').interfaceId).toBe('A');
    expect(manager.getBindingLiveness('Conv', 'Flow.Run')).toBe('pending');
    expect(manager.isLive('Conv')).toBe(false);
  });

  it('survives a CONNECT off/on cycle: live → hold → disconnected → live', () => {
    const { store, manager, root } = fixture();
    addProvider(store, 'A', 'Src.Run');
    manager.applyMappings('Conv', root, [namesOnly('Src.Run')]);
    manager.tick(0.02);
    expect(manager.getBindingLiveness('Conv', 'Flow.Run')).toBe('live');

    // CONNECT drops: the provider stays REGISTERED but reports disconnected —
    // exactly what ConnectPlugin.syncProviders does on state !== 'connected'.
    store.setSignalProviderConnected({ interfaceId: 'A' }, false);
    manager.tick(0.5);
    expect(manager.getBindingLiveness('Conv', 'Flow.Run')).toBe('hold');
    manager.tick(0.4);
    expect(manager.getBindingLiveness('Conv', 'Flow.Run')).toBe('disconnected');

    store.setSignalProviderConnected({ interfaceId: 'A' }, true);
    manager.tick(0.02);
    expect(manager.getBindingLiveness('Conv', 'Flow.Run')).toBe('live');
  });

  it('re-resolves after the provider vanishes entirely and comes back (on/off/on)', () => {
    const { store, manager, root } = fixture();
    keepProviderLayerAlive(store);
    addProvider(store, 'A', 'Src.Run');
    manager.applyMappings('Conv', root, [namesOnly('Src.Run')]);
    manager.tick(0.02);
    expect(manager.getBindingLiveness('Conv', 'Flow.Run')).toBe('live');

    store.unregisterSignalProvider({ interfaceId: 'A' });
    manager.tick(0.02);
    expect(manager.getBindingLiveness('Conv', 'Flow.Run')).toBe('pending');

    addProvider(store, 'A', 'Src.Run');
    manager.tick(0.02);
    expect(manager.getBindingLiveness('Conv', 'Flow.Run')).toBe('live');
  });

  it('costs no allocating provider lookup per tick while unresolved', () => {
    const { store, manager, root } = fixture();
    const spy = vi.spyOn(store, 'getSignalProviders');
    manager.applyMappings('Conv', root, [namesOnly('Src.Run')]);
    spy.mockClear();

    // No provider at all: the tick may only use the allocation-free COUNT.
    for (let i = 0; i < 60; i++) manager.tick(1 / 60);
    expect(spy).not.toHaveBeenCalled();

    // Exactly one provider: the allocating identity lookup happens ONCE, at the
    // transition — not on every one of the following 60 ticks.
    addProvider(store, 'A', 'Src.Run');
    for (let i = 0; i < 60; i++) manager.tick(1 / 60);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('leaves a mapping that already carries an interfaceId completely alone', () => {
    const { store, manager, root } = fixture();
    addProvider(store, 'other', 'Src.Run');
    const spy = vi.spyOn(store, 'getSignalProviders');
    manager.applyMappings('Conv', root, [namesOnly('Src.Run', { interfaceId: 'pinned' })]);
    spy.mockClear();
    for (let i = 0; i < 10; i++) manager.tick(1 / 60);

    // Not re-pointed at the only live provider, and not even looked up.
    expect(boundMapping(manager, 'Conv').interfaceId).toBe('pinned');
    expect(spy).not.toHaveBeenCalled();
    expect(manager.getBindingLiveness('Conv', 'Flow.Run')).toBe('pending');
    spy.mockRestore();
  });

  it('never adopts a CONNECT provider for an INTERNAL source mapping', () => {
    const { store, manager, root } = fixture();
    addProvider(store, 'A', 'Src.Run');
    manager.applyMappings('Conv', root, [namesOnly('Src.Run', { sourceKind: 'internal' })]);
    manager.tick(0.02);
    expect(boundMapping(manager, 'Conv').interfaceId).toBeUndefined();
  });
});
