// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Registry ordering, capture completeness and cross-participant identity gate. */
import { describe, expect, it, vi } from 'vitest';
import { createCaptureSession } from '@rv/plugins/des/rv-snapshot-contract';
import { SnapshotRegistry, type Snapshottable } from '@rv/plugins/des/rv-snapshot-registry';

function participant(key: string, extra: Partial<Snapshottable> = {}): Snapshottable {
  return { key, version: 1, capture: () => ({ count: 2 }), validate: () => [],
    prepare: vi.fn(), commit: vi.fn(), onRestore: vi.fn(), ...extra };
}

describe('snapshot registry', () => {
  it('uses stable topological order, selecting the first registered ready participant', () => {
    const registry = new SnapshotRegistry();
    registry.register(participant('consumer', { dependencies: ['base'] }));
    registry.register(participant('independent'));
    registry.register(participant('base'));
    registry.register(participant('last'));
    expect(registry.order().map(p => p.key)).toEqual(['independent', 'base', 'consumer', 'last']);
    expect(registry.captureAll(createCaptureSession()).map(p => p.key)).toEqual(['independent', 'base', 'consumer', 'last']);
  });

  it('rejects duplicates and allows unregister and re-registration', () => {
    const registry = new SnapshotRegistry();
    registry.register(participant('a'));
    expect(() => registry.register(participant('a'))).toThrow("duplicate participant 'a'");
    registry.unregister('a');
    registry.unregister('missing');
    registry.register(participant('a'));
    expect(registry.order()).toHaveLength(1);
    expect(new SnapshotRegistry().captureAll(createCaptureSession())).toEqual([]);
  });

  it('names a missing dependency before capture', () => {
    const registry = new SnapshotRegistry();
    const capture = vi.fn();
    registry.register(participant('consumer', { dependencies: ['missing'], capture }));
    expect(() => registry.captureAll(createCaptureSession())).toThrow("missing dependency 'missing' for 'consumer'");
    expect(capture).not.toHaveBeenCalled();
  });

  it('names cycles, including self-dependency', () => {
    const registry = new SnapshotRegistry();
    registry.register(participant('a', { dependencies: ['b'] }));
    registry.register(participant('b', { dependencies: ['a'] }));
    expect(() => registry.order()).toThrow('cycle: a -> b');
    registry.unregister('b');
    registry.unregister('a');
    registry.register(participant('self', { dependencies: ['self'] }));
    expect(() => registry.order()).toThrow('cycle: self');
  });

  it('captures declared state while excluding classified service fields', () => {
    const owner = { state: { count: 2 }, clock: { tick() {} }, listener() {} };
    const p = participant('orders', { owner, stateKeys: ['state'], services: ['clock', 'listener'], capture: () => owner.state });
    const registry = new SnapshotRegistry(); registry.register(p);
    const parts = registry.captureAll(createCaptureSession());
    expect(parts).toEqual([{ key: 'orders', version: 1, state: { count: 2 } }]);
    owner.state.count = 9;
    expect(parts[0].state).toEqual({ count: 2 });
    expect(p.prepare).not.toHaveBeenCalled();
    expect(p.commit).not.toHaveBeenCalled();
    expect(p.onRestore).not.toHaveBeenCalled();
  });

  it('guards only on capture and reports undeclared owner fields without reading them', () => {
    const getter = vi.fn();
    const owner = Object.defineProperty({ state: {} }, 'forgotten', { get: getter });
    const capture = vi.fn();
    const registry = new SnapshotRegistry();
    registry.register(participant('orders', { owner, stateKeys: ['state'], capture }));
    expect(() => registry.order()).not.toThrow();
    expect(() => registry.captureAll(createCaptureSession())).toThrow('des-state-not-declared: orders.forgotten');
    try { registry.captureAll(createCaptureSession()); } catch (error) {
      expect(error).toMatchObject({ code: 'des-state-not-declared', participant: 'orders', property: 'forgotten' });
    }
    expect(capture).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
  });

  it('checks symbol own keys, but not prototype fields', () => {
    const registry = new SnapshotRegistry();
    const owner = Object.create({ inherited: 1 });
    registry.register(participant('a', { owner }));
    expect(() => registry.captureAll(createCaptureSession())).not.toThrow();
    owner[Symbol('state')] = 2;
    expect(() => registry.captureAll(createCaptureSession())).toThrow('Symbol(state)');
  });

  it.each([false, true])('rejects aliases across participants before validation (nested=%s)', nested => {
    const registry = new SnapshotRegistry();
    const shared = {};
    const validate = vi.fn(() => []);
    registry.register(participant('a', { capture: () => nested ? { local: shared } : shared, validate }));
    registry.register(participant('b', { capture: () => nested ? { other: shared } : shared, validate }));
    expect(() => registry.captureAll(createCaptureSession())).toThrow(nested ? 'a.local' : 'a.<root>');
    expect(validate).not.toHaveBeenCalled();
  });

  it('passes schema codecs to the session and validates the encoded state', () => {
    const registry = new SnapshotRegistry();
    const validate = vi.fn(() => []);
    registry.register(participant('a', { schema: { codecs: { held: 'set' } }, capture: () => ({ held: new Set(['b', 'a']) }), validate }));
    const parts = registry.captureAll(createCaptureSession());
    expect(parts[0].state).toEqual({ held: { $set: ['b', 'a'] } });
    expect(validate).toHaveBeenCalledWith(parts[0].state);
  });

  it('reports schema validation failures from every participant', () => {
    const registry = new SnapshotRegistry();
    registry.register(participant('a', { validate: () => ['count invalid'] }));
    registry.register(participant('b', { validate: () => ['missing id'] }));
    expect(() => registry.captureAll(createCaptureSession())).toThrow('a: count invalid; b: missing id');
  });
});
