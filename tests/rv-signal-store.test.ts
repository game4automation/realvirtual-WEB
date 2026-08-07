// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SignalStore Unit Tests
 *
 * Tests the central signal store for PLC signal communication.
 * Two lookup tables: by name (primary) and by path (secondary).
 */
import { describe, it, expect, vi } from 'vitest';
import { SignalStore } from '../src/core/engine/rv-signal-store';

describe('SignalStore', () => {
  // ── Name-based access (primary) ──

  it('should register and get signals by name', () => {
    const store = new SignalStore();
    store.register('bool1', 'sig/bool1', false);
    store.register('float1', 'sig/float1', 42.5);

    expect(store.get('bool1')).toBe(false);
    expect(store.get('float1')).toBe(42.5);
    expect(store.size).toBe(2);
  });

  it('should return undefined for unknown signals', () => {
    const store = new SignalStore();
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('should set and get bool signals by name', () => {
    const store = new SignalStore();
    store.register('bool1', 'sig/bool1', false);

    expect(store.getBool('bool1')).toBe(false);
    store.set('bool1', true);
    expect(store.getBool('bool1')).toBe(true);
  });

  it('should getBool return false for missing signal', () => {
    const store = new SignalStore();
    expect(store.getBool('missing')).toBe(false);
  });

  it('should set and get float signals by name', () => {
    const store = new SignalStore();
    store.register('float1', 'sig/float1', 0);

    store.set('float1', 3.14);
    expect(store.getFloat('float1')).toBeCloseTo(3.14);
  });

  it('should getFloat return 0 for missing signal', () => {
    const store = new SignalStore();
    expect(store.getFloat('missing')).toBe(0);
  });

  it('should set and get int signals by name', () => {
    const store = new SignalStore();
    store.register('int1', 'sig/int1', 0);

    store.set('int1', 99);
    expect(store.getInt('int1')).toBe(99);
  });

  it('should getInt return 0 for missing signal', () => {
    const store = new SignalStore();
    expect(store.getInt('missing')).toBe(0);
  });

  it('should notify subscribers on value change', () => {
    const store = new SignalStore();
    store.register('bool1', 'sig/bool1', false);

    const cb = vi.fn();
    store.subscribe('bool1', cb);

    store.set('bool1', true);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(true);
  });

  it('should NOT notify when value unchanged', () => {
    const store = new SignalStore();
    store.register('bool1', 'sig/bool1', false);

    const cb = vi.fn();
    store.subscribe('bool1', cb);

    store.set('bool1', false); // same value
    expect(cb).not.toHaveBeenCalled();
  });

  it('should unsubscribe correctly', () => {
    const store = new SignalStore();
    store.register('bool1', 'sig/bool1', false);

    const cb = vi.fn();
    const unsub = store.subscribe('bool1', cb);

    store.set('bool1', true);
    expect(cb).toHaveBeenCalledTimes(1);

    unsub();
    store.set('bool1', false);
    expect(cb).toHaveBeenCalledTimes(1); // not called again
  });

  it('should support multiple subscribers', () => {
    const store = new SignalStore();
    store.register('x', 'sig/x', 0);

    const cb1 = vi.fn();
    const cb2 = vi.fn();
    store.subscribe('x', cb1);
    store.subscribe('x', cb2);

    store.set('x', 10);
    expect(cb1).toHaveBeenCalledWith(10);
    expect(cb2).toHaveBeenCalledWith(10);
  });

  it('should set signals even without prior register', () => {
    const store = new SignalStore();
    store.set('new_sig', true);
    expect(store.getBool('new_sig')).toBe(true);
  });

  it('should setMany update multiple signals', () => {
    const store = new SignalStore();
    store.setMany({ 'a': true, 'b': 42, 'c': false });

    expect(store.getBool('a')).toBe(true);
    expect(store.getFloat('b')).toBe(42);
    expect(store.getBool('c')).toBe(false);
  });

  it('should batch setMany notifications — all values set before any listener fires', () => {
    const store = new SignalStore();
    store.register('x', 'sig/x', false);
    store.register('y', 'sig/y', false);

    // Listener for 'x' reads 'y' — with batching, 'y' should already be updated
    let ySeenByXListener: boolean | number | undefined;
    store.subscribe('x', () => {
      ySeenByXListener = store.get('y');
    });

    store.setMany({ x: true, y: true });
    expect(ySeenByXListener).toBe(true);
  });

  it('should clear all signals', () => {
    const store = new SignalStore();
    store.register('a', 'sig/a', true);
    store.register('b', 'sig/b', 42);

    store.clear();
    expect(store.size).toBe(0);
    expect(store.get('a')).toBeUndefined();
  });

  // ── Path-based access (secondary) ──

  it('should get signals by path', () => {
    const store = new SignalStore();
    store.register('ConveyorStart', 'Robot/Signals/ConveyorStart', false);

    expect(store.getByPath('Robot/Signals/ConveyorStart')).toBe(false);
    expect(store.getBoolByPath('Robot/Signals/ConveyorStart')).toBe(false);
  });

  it('should set signals by path', () => {
    const store = new SignalStore();
    store.register('ConveyorStart', 'Robot/Signals/ConveyorStart', false);

    store.setByPath('Robot/Signals/ConveyorStart', true);
    expect(store.getBool('ConveyorStart')).toBe(true);
    expect(store.getBoolByPath('Robot/Signals/ConveyorStart')).toBe(true);
  });

  it('should subscribe by path', () => {
    const store = new SignalStore();
    store.register('Speed', 'Cell/Signals/Speed', 0);

    const cb = vi.fn();
    store.subscribeByPath('Cell/Signals/Speed', cb);

    store.set('Speed', 100);
    expect(cb).toHaveBeenCalledWith(100);
  });

  it('should use Signal.Name as primary key when different from node name', () => {
    const store = new SignalStore();
    // Signal.Name = "MyStart", node name = "PLCOutput1", path = "Cell/PLCOutput1"
    store.register('MyStart', 'Cell/PLCOutput1', false);

    // Access by Signal.Name
    expect(store.getBool('MyStart')).toBe(false);
    store.set('MyStart', true);
    expect(store.getBool('MyStart')).toBe(true);

    // Access by path
    expect(store.getBoolByPath('Cell/PLCOutput1')).toBe(true);
  });

  it('should resolve path to name', () => {
    const store = new SignalStore();
    store.register('ConveyorStart', 'Robot/Signals/ConveyorStart', false);

    expect(store.nameForPath('Robot/Signals/ConveyorStart')).toBe('ConveyorStart');
    expect(store.nameForPath('unknown/path')).toBeUndefined();
  });

  it('should getByPath return undefined for unknown path', () => {
    const store = new SignalStore();
    expect(store.getByPath('unknown/path')).toBeUndefined();
  });

  it('should subscribeByPath return no-op for unknown path', () => {
    const store = new SignalStore();
    const cb = vi.fn();
    const unsub = store.subscribeByPath('unknown/path', cb);
    unsub(); // should not throw
    expect(cb).not.toHaveBeenCalled();
  });

  // ── Suffix-based path resolution (GLB root prefix mismatch) ──

  it('should resolve path via suffix when GLB root prefix is missing', () => {
    const store = new SignalStore();
    // Signal registered with full GLB path (root/Robot/Grip)
    store.register('Grip', 'demoglb/Robot/Grip', false);

    // Inspector uses raw ComponentRef path without GLB root prefix
    expect(store.getByPath('Robot/Grip')).toBe(false);
    expect(store.getBoolByPath('Robot/Grip')).toBe(false);
  });

  it('should setByPath work via suffix match', () => {
    const store = new SignalStore();
    store.register('Grip', 'demoglb/Robot/Grip', false);

    store.setByPath('Robot/Grip', true);
    expect(store.getBool('Grip')).toBe(true);
  });

  it('should subscribeByPath work via suffix match', () => {
    const store = new SignalStore();
    store.register('Grip', 'demoglb/Robot/Grip', false);

    const cb = vi.fn();
    store.subscribeByPath('Robot/Grip', cb);

    store.set('Grip', true);
    expect(cb).toHaveBeenCalledWith(true);
  });

  it('should cache suffix resolution for fast repeated lookups', () => {
    const store = new SignalStore();
    store.register('Grip', 'demoglb/Robot/Grip', false);

    // First call: suffix scan
    expect(store.getByPath('Robot/Grip')).toBe(false);
    // Second call: cached
    store.set('Grip', true);
    expect(store.getByPath('Robot/Grip')).toBe(true);
  });

  it('should resolve suffix match with space normalization', () => {
    const store = new SignalStore();
    store.register('ConvStart', 'demoglb/Robot/Entry_Conveyor/Start', false);

    // C# path has spaces, Three.js sanitizes to underscores
    expect(store.getByPath('Robot/Entry Conveyor/Start')).toBe(false);
  });
});

// ── Force / override (operator pin) ──

describe('SignalStore — force', () => {
  it('forceSignal pins a value and applies it immediately', () => {
    const store = new SignalStore();
    store.register('b', 'sig/b', false);
    store.forceSignal('b', true);
    expect(store.getBool('b')).toBe(true);
    expect(store.isForced('b')).toBe(true);
    expect(store.getForcedValue('b')).toBe(true);
    expect(store.forcedCount).toBe(1);
  });

  it('set() is ignored while a signal is forced', () => {
    const store = new SignalStore();
    store.register('b', 'sig/b', false);
    store.forceSignal('b', true);
    store.set('b', false);            // interface tries to update
    expect(store.getBool('b')).toBe(true);  // forced value held
  });

  it('setMany() skips forced signals but updates the rest', () => {
    const store = new SignalStore();
    store.register('a', 'sig/a', false);
    store.register('b', 'sig/b', false);
    store.forceSignal('a', true);
    store.setMany({ a: false, b: true });
    expect(store.getBool('a')).toBe(true);   // forced → unchanged
    expect(store.getBool('b')).toBe(true);   // not forced → updated
  });

  it('setByPath() is ignored while forced', () => {
    const store = new SignalStore();
    store.register('Grip', 'demoglb/Robot/Grip', false);
    store.forceSignal('Grip', true);
    store.setByPath('Robot/Grip', false);
    expect(store.getBool('Grip')).toBe(true);
  });

  it('unforce releases so interface updates flow again', () => {
    const store = new SignalStore();
    store.register('b', 'sig/b', false);
    store.forceSignal('b', true);
    store.unforce('b');
    expect(store.isForced('b')).toBe(false);
    store.set('b', false);
    expect(store.getBool('b')).toBe(false);
  });

  it('unforceAll clears every forced signal', () => {
    const store = new SignalStore();
    store.register('a', 'sig/a', false);
    store.register('b', 'sig/b', false);
    store.forceSignal('a', true);
    store.forceSignal('b', true);
    expect(store.forcedCount).toBe(2);
    store.unforceAll();
    expect(store.forcedCount).toBe(0);
  });

  it('forceSignal can change a forced value (re-force)', () => {
    const store = new SignalStore();
    store.register('i', 'sig/i', 0);
    store.forceSignal('i', 5);
    expect(store.getInt('i')).toBe(5);
    store.forceSignal('i', 9);
    expect(store.getInt('i')).toBe(9);
    expect(store.getForcedValue('i')).toBe(9);
  });

  it('notifies value listeners when a forced value is applied', () => {
    const store = new SignalStore();
    store.register('b', 'sig/b', false);
    const cb = vi.fn();
    store.subscribe('b', cb);
    store.forceSignal('b', true);
    expect(cb).toHaveBeenCalledWith(true);
  });

  it('subscribeForce fires on force and unforce, and unsubscribes', () => {
    const store = new SignalStore();
    store.register('b', 'sig/b', false);
    const cb = vi.fn();
    const unsub = store.subscribeForce(cb);
    store.forceSignal('b', true);
    store.unforce('b');
    expect(cb).toHaveBeenCalledTimes(2);
    unsub();
    store.forceSignal('b', true);
    expect(cb).toHaveBeenCalledTimes(2);  // no further calls after unsubscribe
  });

  it('forceSink receives value on force and null on release', () => {
    const store = new SignalStore();
    store.register('b', 'sig/b', false);
    const sink = vi.fn();
    store.setForceSink(sink);
    store.forceSignal('b', true);
    store.unforce('b');
    expect(sink).toHaveBeenNthCalledWith(1, 'b', true);
    expect(sink).toHaveBeenNthCalledWith(2, 'b', null);
  });

  it('clear() removes forced state', () => {
    const store = new SignalStore();
    store.register('b', 'sig/b', false);
    store.forceSignal('b', true);
    store.clear();
    expect(store.forcedCount).toBe(0);
    expect(store.isForced('b')).toBe(false);
  });
});
