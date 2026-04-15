// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Signal Wiring Helper Tests
 *
 * Tests wireBoolSignal and wireRefBoolSignal from rv-signal-wiring.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { wireBoolSignal, wireRefBoolSignal } from '../src/core/engine/rv-signal-wiring';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import type { ComponentRef } from '../src/core/engine/rv-node-registry';

// ─── Mock NodeRegistry ───────────────────────────────────────────

function createMockRegistry(resolvedAddr: string | null) {
  return {
    resolve: (_ref: ComponentRef) => ({
      signalAddress: resolvedAddr ?? undefined,
    }),
  } as any;
}

// ─── wireBoolSignal ──────────────────────────────────────────────

describe('wireBoolSignal', () => {
  let store: SignalStore;

  beforeEach(() => {
    store = new SignalStore();
    store.register('TestSignal', '/Root/TestSignal', false);
  });

  it('returns null addr and noop unsubscribe for null address', () => {
    let called = false;
    const result = wireBoolSignal(store, null, () => { called = true; });
    expect(result.addr).toBeNull();
    expect(called).toBe(false);
    result.unsubscribe(); // should not throw
  });

  it('returns null addr for undefined address', () => {
    const result = wireBoolSignal(store, undefined, () => {});
    expect(result.addr).toBeNull();
  });

  it('rejects non-string values (type guard)', () => {
    const result = wireBoolSignal(store, 42 as any, () => {});
    expect(result.addr).toBeNull();
  });

  it('sets initial value from store', () => {
    store.set('TestSignal', true);

    let value = false;
    wireBoolSignal(store, '/Root/TestSignal', (v) => { value = v; });
    expect(value).toBe(true);
  });

  it('sets initial value false when signal not set', () => {
    let value = true;
    wireBoolSignal(store, '/Root/TestSignal', (v) => { value = v; });
    expect(value).toBe(false);
  });

  it('subscribes and updates on signal change', () => {
    let value = false;
    wireBoolSignal(store, '/Root/TestSignal', (v) => { value = v; });

    store.set('TestSignal', true);
    expect(value).toBe(true);

    store.set('TestSignal', false);
    expect(value).toBe(false);
  });

  it('coerces numeric 1 to true', () => {
    let value = false;
    wireBoolSignal(store, '/Root/TestSignal', (v) => { value = v; });

    store.set('TestSignal', 1);
    // 1 === true is false, so value should be false (strict boolean coercion)
    expect(value).toBe(false);
  });

  it('returns working unsubscribe function', () => {
    let value = false;
    const result = wireBoolSignal(store, '/Root/TestSignal', (v) => { value = v; });

    store.set('TestSignal', true);
    expect(value).toBe(true);

    result.unsubscribe();

    store.set('TestSignal', false);
    // Should remain true since unsubscribed
    expect(value).toBe(true);
  });

  it('returns the resolved addr', () => {
    const result = wireBoolSignal(store, '/Root/TestSignal', () => {});
    expect(result.addr).toBe('/Root/TestSignal');
  });
});

// ─── wireRefBoolSignal ───────────────────────────────────────────

describe('wireRefBoolSignal', () => {
  let store: SignalStore;

  beforeEach(() => {
    store = new SignalStore();
    store.register('MySignal', '/Root/MySignal', false);
  });

  it('returns null for null ref', () => {
    const registry = createMockRegistry('/Root/MySignal');
    const result = wireRefBoolSignal(registry, store, null, () => {});
    expect(result.addr).toBeNull();
  });

  it('returns null for undefined ref', () => {
    const registry = createMockRegistry('/Root/MySignal');
    const result = wireRefBoolSignal(registry, store, undefined, () => {});
    expect(result.addr).toBeNull();
  });

  it('resolves ComponentRef and wires signal', () => {
    const registry = createMockRegistry('/Root/MySignal');
    const ref: ComponentRef = { type: 'ComponentReference', path: 'Root/MySignal', componentType: 'realvirtual.PLCOutputBool' };

    store.set('MySignal', true);

    let value = false;
    const result = wireRefBoolSignal(registry, store, ref, (v) => { value = v; });

    expect(result.addr).toBe('/Root/MySignal');
    expect(value).toBe(true);

    store.set('MySignal', false);
    expect(value).toBe(false);
  });

  it('returns null for unresolvable ref', () => {
    const registry = createMockRegistry(null);
    const ref: ComponentRef = { type: 'ComponentReference', path: 'Bad/Path', componentType: 'realvirtual.PLCOutputBool' };

    let called = false;
    const result = wireRefBoolSignal(registry, store, ref, () => { called = true; });

    expect(result.addr).toBeNull();
    expect(called).toBe(false);
  });
});
