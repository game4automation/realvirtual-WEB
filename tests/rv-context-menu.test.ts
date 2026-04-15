// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi } from 'vitest';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import type { ContextMenuTarget } from '../src/core/hmi/context-menu-store';

function makeTarget(path = '/foo'): ContextMenuTarget {
  return { path, node: {} as any, types: [], extras: {} };
}

describe('ContextMenuStore', () => {
  // --- Core ---

  it('register adds items and filters by condition on open', () => {
    const store = new ContextMenuStore();
    store.register({
      pluginId: 'test',
      items: [
        { id: 'a', label: 'A', order: 10, action: vi.fn() },
        { id: 'b', label: 'B', order: 20, action: vi.fn(), condition: () => false },
      ],
    });
    store.open({ x: 100, y: 200 }, makeTarget());
    const snap = store.getSnapshot();
    expect(snap.open).toBe(true);
    expect(snap.items).toHaveLength(1);
    expect(snap.items[0].id).toBe('a');
  });

  it('unregister removes items', () => {
    const store = new ContextMenuStore();
    store.register({ pluginId: 'test', items: [{ id: 'a', label: 'A', action: vi.fn() }] });
    store.unregister('test');
    store.open({ x: 0, y: 0 }, makeTarget());
    expect(store.getSnapshot().open).toBe(false); // No items -> stays closed
  });

  it('re-register replaces items for same pluginId', () => {
    const store = new ContextMenuStore();
    store.register({ pluginId: 'test', items: [{ id: 'a', label: 'A', action: vi.fn() }] });
    store.register({ pluginId: 'test', items: [{ id: 'b', label: 'B', action: vi.fn() }] });
    store.open({ x: 0, y: 0 }, makeTarget());
    const snap = store.getSnapshot();
    expect(snap.items).toHaveLength(1);
    expect(snap.items[0].id).toBe('b');
  });

  it('open sorts items by order', () => {
    const store = new ContextMenuStore();
    store.register({
      pluginId: 'test',
      items: [
        { id: 'c', label: 'C', order: 300, action: vi.fn() },
        { id: 'a', label: 'A', order: 10, action: vi.fn() },
        { id: 'b', label: 'B', order: 50, action: vi.fn() },
      ],
    });
    store.open({ x: 0, y: 0 }, makeTarget());
    const ids = store.getSnapshot().items.map((i) => i.id);
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('multiple plugins register independently', () => {
    const store = new ContextMenuStore();
    store.register({ pluginId: 'plugA', items: [{ id: 'a1', label: 'A1', order: 10, action: vi.fn() }] });
    store.register({ pluginId: 'plugB', items: [{ id: 'b1', label: 'B1', order: 20, action: vi.fn() }] });
    store.open({ x: 0, y: 0 }, makeTarget());
    expect(store.getSnapshot().items).toHaveLength(2);
    store.unregister('plugA');
    store.open({ x: 0, y: 0 }, makeTarget());
    expect(store.getSnapshot().items).toHaveLength(1);
    expect(store.getSnapshot().items[0].id).toBe('b1');
  });

  it('close resets state', () => {
    const store = new ContextMenuStore();
    store.register({ pluginId: 'test', items: [{ id: 'a', label: 'A', action: vi.fn() }] });
    store.open({ x: 0, y: 0 }, makeTarget());
    store.close();
    const snap = store.getSnapshot();
    expect(snap.open).toBe(false);
    expect(snap.target).toBeNull();
    expect(snap.items).toHaveLength(0);
  });

  // --- Edge Cases ---

  it('open with no matching items does not open', () => {
    const store = new ContextMenuStore();
    store.register({
      pluginId: 'test',
      items: [{ id: 'a', label: 'A', action: vi.fn(), condition: () => false }],
    });
    store.open({ x: 0, y: 0 }, makeTarget());
    expect(store.getSnapshot().open).toBe(false);
  });

  it('close is idempotent — double close does not notify twice', () => {
    const store = new ContextMenuStore();
    store.register({ pluginId: 'test', items: [{ id: 'a', label: 'A', action: vi.fn() }] });
    store.open({ x: 0, y: 0 }, makeTarget());
    const listener = vi.fn();
    store.subscribe(listener);
    store.close();
    store.close(); // Second close — should not trigger listener again
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('snapshot reference stable when no change', () => {
    const store = new ContextMenuStore();
    const snap1 = store.getSnapshot();
    const snap2 = store.getSnapshot();
    expect(snap1).toBe(snap2); // Same reference
  });

  it('condition that throws is treated as false', () => {
    const store = new ContextMenuStore();
    store.register({
      pluginId: 'test',
      items: [
        { id: 'good', label: 'Good', order: 10, action: vi.fn() },
        {
          id: 'bad',
          label: 'Bad',
          order: 20,
          action: vi.fn(),
          condition: () => { throw new Error('plugin bug'); },
        },
      ],
    });
    // Should not throw — error is swallowed
    store.open({ x: 0, y: 0 }, makeTarget());
    const snap = store.getSnapshot();
    expect(snap.open).toBe(true);
    expect(snap.items).toHaveLength(1);
    expect(snap.items[0].id).toBe('good');
  });

  it('unregister while menu open closes menu if items belonged to that plugin', () => {
    const store = new ContextMenuStore();
    store.register({ pluginId: 'test', items: [{ id: 'a', label: 'A', action: vi.fn() }] });
    store.open({ x: 0, y: 0 }, makeTarget());
    expect(store.getSnapshot().open).toBe(true);
    store.unregister('test');
    expect(store.getSnapshot().open).toBe(false);
  });

  // --- API ---

  it('dynamic label called with target', () => {
    const store = new ContextMenuStore();
    const labelFn = vi.fn(() => 'Dynamic');
    store.register({ pluginId: 'test', items: [{ id: 'a', label: labelFn, action: vi.fn() }] });
    const target = makeTarget();
    store.open({ x: 0, y: 0 }, target);
    expect(labelFn).toHaveBeenCalledWith(target);
    expect(store.getSnapshot().items[0].resolvedLabel).toBe('Dynamic');
  });

  it('danger flag preserved in snapshot', () => {
    const store = new ContextMenuStore();
    store.register({
      pluginId: 'test',
      items: [{ id: 'del', label: 'Delete', action: vi.fn(), danger: true }],
    });
    store.open({ x: 0, y: 0 }, makeTarget());
    expect(store.getSnapshot().items[0].danger).toBe(true);
  });

  it('dividerBefore preserved in snapshot', () => {
    const store = new ContextMenuStore();
    store.register({
      pluginId: 'test',
      items: [{ id: 'del', label: 'Delete', action: vi.fn(), dividerBefore: true }],
    });
    store.open({ x: 0, y: 0 }, makeTarget());
    expect(store.getSnapshot().items[0].dividerBefore).toBe(true);
  });

  it('subscriber notified on open and close', () => {
    const store = new ContextMenuStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.register({ pluginId: 'test', items: [{ id: 'a', label: 'A', action: vi.fn() }] });
    store.open({ x: 0, y: 0 }, makeTarget());
    const callsAfterOpen = listener.mock.calls.length;
    expect(callsAfterOpen).toBeGreaterThan(0);
    store.close();
    expect(listener.mock.calls.length).toBeGreaterThan(callsAfterOpen);
  });
});
