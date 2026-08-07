// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-325 §9.11 — relay chain slot ← internal ← extern (S2 drain loop):
 *  - a CONNECT change on the external source reaches the END of the chain IN
 *    THE SAME tick (the pending object is swapped and re-drained inside
 *    _flushWrites, not deferred to the next tick).
 *  - a pathological cycle stops at the drain cap with a dev warning.
 *  - the chain-indicator lookup resolves the CONNECT source of an internal
 *    assignment.
 */
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { Object3D } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import {
  MAX_FLUSH_DRAIN_CYCLES,
  SignalBindingManager,
} from '../src/core/engine/rv-signal-binding-manager';
import { resetSlotAuthority } from '../src/core/engine/rv-slot-authority';
import { scopeSignalName } from '../src/core/engine/rv-instance-scope';

function makeConveyor(store: SignalStore, registry: NodeRegistry, scope: string): Object3D {
  const root = new Object3D();
  root.name = scope;
  root.userData.realvirtual = { LayoutObject: { Label: scope }, Conveyor: {} };
  registry.registerNode(scope, root);
  store.register(scopeSignalName(scope, 'Flow.Run'), `${scope}/Flow.Run`, false, 'PLCOutputBool');
  return root;
}

describe('signal chain relay (plan-325 9.11)', () => {
  beforeEach(() => resetSlotAuthority());
  afterEach(() => vi.restoreAllMocks());

  it('relays extern → internal → slot within ONE tick (drain loop, S2)', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    // External CONNECT source.
    store.register('Ext.Run', '__iface__/Ext.Run', false, 'PLCOutputBool');
    store.registerSignalProvider({ interfaceId: 'plc', signal: 'Ext.Run' }, true);

    const mgr = new SignalBindingManager(store, registry);
    const mid = makeConveyor(store, registry, 'Mid');   // Mid.Flow.Run = the internal middle signal
    const end = makeConveyor(store, registry, 'End');   // End.Flow.Run = the chain end

    // Chain: Mid.Flow.Run ← CONNECT Ext.Run; End.Flow.Run ← internal Mid.Flow.Run.
    mgr.bind('mid', mid, {
      slot: 'Flow.Run', signal: 'Ext.Run', interfaceId: 'plc', direction: 'plcOutput', enabled: true,
    });
    mgr.bind('end', end, {
      slot: 'Flow.Run', sourceKind: 'internal', signal: scopeSignalName('Mid', 'Flow.Run'),
      direction: 'plcOutput', enabled: true,
    });

    mgr.tick(0.02);
    expect(mgr.getBindingLiveness('mid', 'Flow.Run')).toBe('live');
    expect(mgr.getBindingLiveness('end', 'Flow.Run')).toBe('live');

    // External change → queued relay write for Mid; the drain loop must carry
    // it through to End within the SAME tick.
    store.set('Ext.Run', true);
    mgr.tick(0.02);
    expect(store.get(scopeSignalName('Mid', 'Flow.Run'))).toBe(true);
    expect(store.get(scopeSignalName('End', 'Flow.Run'))).toBe(true);

    // Chain-indicator data: the internal assignment resolves its CONNECT source.
    expect(mgr.getConnectSourceForTarget(scopeSignalName('Mid', 'Flow.Run'))).toBe('Ext.Run');
    expect(mgr.getConnectSourceForTarget(scopeSignalName('End', 'Flow.Run'))).toBeUndefined();
  });

  it('stops a pathological re-queue cycle at the drain cap with a dev warning', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    const mgr = new SignalBindingManager(store, registry);
    store.register('Cycle.A', 'Cell/Cycle.A', false, 'PLCOutputBool');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* capture */ });

    // Synthetic non-idempotent cycle: every flushed write of Cycle.A queues the
    // inverted value again (models an A→B→A chain that never settles).
    const internals = mgr as unknown as {
      _queueWrite(name: string, value: boolean | number): void;
      _flushWrites(): void;
    };
    let requeues = 0;
    store.subscribe('Cycle.A', (value) => {
      requeues++;
      internals._queueWrite('Cycle.A', !(value as boolean));
    });

    internals._queueWrite('Cycle.A', true);
    internals._flushWrites();

    // The cap bounded the drain (no unbounded loop) and warned once in dev.
    expect(requeues).toBeLessThanOrEqual(MAX_FLUSH_DRAIN_CYCLES);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('relay drain cap reached'));
  });
});
