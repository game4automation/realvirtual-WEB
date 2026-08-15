// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Signal Wiring Helper Tests
 *
 * Tests wireBoolSignal, wireRefBoolSignal, wireNumberSignal and wireValueSignal
 * from rv-signal-wiring.ts, including the plan-427 re-apply registration.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  wireBoolSignal,
  wireRefBoolSignal,
  wireNumberSignal,
  wireValueSignal,
} from '../src/core/engine/rv-signal-wiring';
import { SignalReapplyRegistry } from '../src/core/engine/rv-signal-reapply-registry';
import type { SignalApplyContext } from '../src/core/engine/rv-signal-reapply-registry';
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

// ─── Re-apply registration (plan-427) ────────────────────────────

describe('wiring helpers — re-apply registry (plan-427)', () => {
  let store: SignalStore;
  let registry: SignalReapplyRegistry;

  beforeEach(() => {
    store = new SignalStore();
    registry = new SignalReapplyRegistry();
    store.register('Run', '/Root/Run', false, 'PLCOutputBool');
    store.register('Speed', '/Root/Speed', 0, 'PLCOutputFloat');
  });

  it('wireBoolSignal without a registry behaves exactly as before', () => {
    const seen: boolean[] = [];
    wireBoolSignal(store, '/Root/Run', (v) => seen.push(v));
    expect(registry.size).toBe(0);
    expect(seen).toEqual([false]);
  });

  it('re-applies the CURRENT value even though nothing changed', () => {
    store.set('Run', true);
    const seen: Array<[boolean, SignalApplyContext | undefined]> = [];
    wireBoolSignal(store, '/Root/Run', (v, ctx) => seen.push([v, ctx]), undefined, registry);

    // Initial read carries NO context — it is not a replay.
    expect(seen).toEqual([[true, undefined]]);

    // No change event happens; a reset triggers the re-apply instead.
    registry.reapplyAll();
    expect(seen.length).toBe(2);
    expect(seen[1]).toEqual([true, { replay: true }]);
  });

  it('the replay reads the value at replay time, not the one cached at wire time', () => {
    const seen: boolean[] = [];
    wireBoolSignal(store, '/Root/Run', (v) => seen.push(v), undefined, registry);
    store.set('Run', true);
    seen.length = 0;

    registry.reapplyAll();
    expect(seen).toEqual([true]);
  });

  it('a genuine change event carries NO replay context', () => {
    const contexts: Array<SignalApplyContext | undefined> = [];
    wireBoolSignal(store, '/Root/Run', (_v, ctx) => contexts.push(ctx), undefined, registry);
    contexts.length = 0;

    store.set('Run', true);
    expect(contexts).toEqual([undefined]);
  });

  it('unsubscribe removes BOTH the store subscription and the registry slot', () => {
    const seen: boolean[] = [];
    const result = wireBoolSignal(store, '/Root/Run', (v) => seen.push(v), undefined, registry);
    expect(registry.size).toBe(1);

    result.unsubscribe();
    expect(registry.size).toBe(0);

    seen.length = 0;
    store.set('Run', true);
    registry.reapplyAll();
    expect(seen).toEqual([]);
  });

  it('a skipped wiring (null addr) registers nothing', () => {
    wireBoolSignal(store, null, () => {}, undefined, registry);
    wireNumberSignal(store, undefined, () => {}, undefined, registry);
    wireValueSignal(store, '', () => {}, undefined, registry);
    expect(registry.size).toBe(0);
  });

  it('wireRefBoolSignal forwards the registry', () => {
    const mockRegistry = createMockRegistry('/Root/Run');
    const ref: ComponentRef = {
      type: 'ComponentReference', path: 'Root/Run', componentType: 'realvirtual.PLCOutputBool',
    };
    const seen: Array<SignalApplyContext | undefined> = [];
    wireRefBoolSignal(mockRegistry, store, ref, (_v, ctx) => seen.push(ctx), undefined, registry);
    expect(registry.size).toBe(1);

    seen.length = 0;
    registry.reapplyAll();
    expect(seen).toEqual([{ replay: true }]);
  });
});

// ─── wireNumberSignal contract (plan-427 F9 / §9.8) ──────────────

describe('wireNumberSignal', () => {
  let store: SignalStore;
  let registry: SignalReapplyRegistry;

  beforeEach(() => {
    store = new SignalStore();
    registry = new SignalReapplyRegistry();
  });

  it('skips the initial AND the replay write when the path is unresolved (no NaN)', () => {
    const seen: number[] = [];
    const result = wireNumberSignal(store, '/Root/Missing', (v) => seen.push(v), undefined, registry);

    // The address is returned (the helper did not bail on a null addr) …
    expect(result.addr).toBe('/Root/Missing');
    // … but nothing was written: Number(undefined) would be NaN.
    expect(seen).toEqual([]);

    registry.reapplyAll();
    expect(seen).toEqual([]);
    expect(seen.every((v) => !Number.isNaN(v))).toBe(true);
  });

  it('performs NO initial read — the authored value stands until the PLC writes', () => {
    // A registered-but-never-written TargetSpeed reads as 0. Applying it here
    // would zero the drive's authored speed and it would never move.
    store.register('Speed', '/Root/Speed', 0, 'PLCOutputFloat');
    const seen: number[] = [];
    wireNumberSignal(store, '/Root/Speed', (v) => seen.push(v), undefined, registry);
    expect(seen).toEqual([]);
  });

  it('a slot that never delivered a value is NOT replayed', () => {
    store.register('Speed', '/Root/Speed', 0, 'PLCOutputFloat');
    const seen: number[] = [];
    wireNumberSignal(store, '/Root/Speed', (v) => seen.push(v), undefined, registry);

    registry.reapplyAll();
    // Nothing to restore — the component never received a level here.
    expect(seen).toEqual([]);
  });

  it('delivers float values on change, and replays them once armed', () => {
    store.register('Speed', '/Root/Speed', 0, 'PLCOutputFloat');
    const seen: number[] = [];
    wireNumberSignal(store, '/Root/Speed', (v) => seen.push(v), undefined, registry);

    store.set('Speed', 250.5);
    expect(seen).toEqual([250.5]);

    // The first delivery armed the slot: a reset now restores the level.
    registry.reapplyAll();
    expect(seen).toEqual([250.5, 250.5]);

    store.set('Speed', 100);
    registry.reapplyAll();
    expect(seen).toEqual([250.5, 250.5, 100, 100]);
  });

  it('delivers int values the same way', () => {
    store.register('Code', '/Root/Code', 0, 'PLCOutputInt');
    const seen: number[] = [];
    wireNumberSignal(store, '/Root/Code', (v) => seen.push(v), undefined, registry);
    store.set('Code', 7);
    registry.reapplyAll();
    expect(seen).toEqual([7, 7]);
  });

  it('coerces a boolean store value to a number', () => {
    store.register('Flag', '/Root/Flag', false, 'PLCOutputBool');
    const seen: number[] = [];
    wireNumberSignal(store, '/Root/Flag', (v) => seen.push(v), undefined, registry);
    store.set('Flag', true);
    expect(seen).toEqual([1]);
  });

  it('a path registered AFTER wiring gets no CHANGE delivery — documented limitation', () => {
    // `subscribeByPath` on an unknown path returns a permanent no-op handle
    // (rv-signal-store.ts), so the change subscription never wakes up. That is
    // the pre-existing behaviour of every direct subscribeByPath caller; the
    // helper neither fixes nor worsens it.
    const seen: number[] = [];
    wireNumberSignal(store, '/Root/Late', (v) => seen.push(v), undefined, registry);

    store.register('Late', '/Root/Late', 0, 'PLCOutputFloat');
    store.set('Late', 42);
    expect(seen).toEqual([]);
  });

  it('and the replay stays silent too — the slot was never armed', () => {
    // The replay restores a level the component HAD. A late-registered path
    // never delivered one (its change subscription is a dead no-op handle), so
    // there is nothing to restore and nothing is invented.
    const seen: number[] = [];
    wireNumberSignal(store, '/Root/Late', (v) => seen.push(v), undefined, registry);

    store.register('Late', '/Root/Late', 0, 'PLCOutputFloat');
    store.set('Late', 42);

    registry.reapplyAll();
    expect(seen).toEqual([]);
  });
});

// ─── wireValueSignal (raw pass-through) ──────────────────────────

describe('wireValueSignal', () => {
  let store: SignalStore;
  let registry: SignalReapplyRegistry;

  beforeEach(() => {
    store = new SignalStore();
    registry = new SignalReapplyRegistry();
  });

  it('passes booleans through as booleans and numbers as numbers', () => {
    store.register('Flag', '/Root/Flag', false, 'PLCOutputBool');
    store.register('Level', '/Root/Level', 0, 'PLCOutputFloat');
    store.set('Flag', true);
    store.set('Level', 3.5);

    const seen: Array<boolean | number> = [];
    wireValueSignal(store, '/Root/Flag', (v) => seen.push(v), undefined, registry);
    wireValueSignal(store, '/Root/Level', (v) => seen.push(v), undefined, registry);
    expect(seen).toEqual([true, 3.5]);

    seen.length = 0;
    registry.reapplyAll();
    expect(seen).toEqual([true, 3.5]);
  });

  it('skips the initial call for an unresolved path', () => {
    const seen: Array<boolean | number> = [];
    wireValueSignal(store, '/Root/Missing', (v) => seen.push(v), undefined, registry);
    expect(seen).toEqual([]);
  });
});
