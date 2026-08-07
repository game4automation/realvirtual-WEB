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

  // --- Submenus ---

  it('children resolver is called at open with the target', () => {
    const store = new ContextMenuStore();
    const resolver = vi.fn(() => [{ id: 'sub.a', label: 'Sub A', action: vi.fn() }]);
    store.register({
      pluginId: 'test',
      items: [{ id: 'parent', label: 'Parent', children: resolver }],
    });
    const target = makeTarget();
    store.open({ x: 0, y: 0 }, target);
    expect(resolver).toHaveBeenCalledWith(target);
    const snap = store.getSnapshot();
    expect(snap.items).toHaveLength(1);
    expect(snap.items[0].children).toHaveLength(1);
    expect(snap.items[0].children![0].id).toBe('sub.a');
  });

  it('children are sorted by order and filtered by condition', () => {
    const store = new ContextMenuStore();
    store.register({
      pluginId: 'test',
      items: [{
        id: 'parent', label: 'Parent',
        children: [
          { id: 'sub.c', label: 'C', order: 30, action: vi.fn() },
          { id: 'sub.a', label: 'A', order: 10, action: vi.fn() },
          { id: 'sub.b', label: 'B', order: 20, action: vi.fn(), condition: () => false },
        ],
      }],
    });
    store.open({ x: 0, y: 0 }, makeTarget());
    const ids = store.getSnapshot().items[0].children!.map((i) => i.id);
    expect(ids).toEqual(['sub.a', 'sub.c']);
  });

  it('parent with empty resolved children and no action is dropped', () => {
    const store = new ContextMenuStore();
    store.register({
      pluginId: 'test',
      items: [
        { id: 'keep', label: 'Keep', order: 1, action: vi.fn() },
        { id: 'empty', label: 'Empty', order: 2, children: () => [] },
        {
          id: 'allFiltered', label: 'AllFiltered', order: 3,
          children: [{ id: 'x', label: 'X', action: vi.fn(), condition: () => false }],
        },
      ],
    });
    store.open({ x: 0, y: 0 }, makeTarget());
    expect(store.getSnapshot().items.map((i) => i.id)).toEqual(['keep']);
  });

  it('menu stays closed when only empty submenu parents match', () => {
    const store = new ContextMenuStore();
    store.register({
      pluginId: 'test',
      items: [{ id: 'empty', label: 'Empty', children: () => [] }],
    });
    store.open({ x: 0, y: 0 }, makeTarget());
    expect(store.getSnapshot().open).toBe(false);
  });

  it('children resolver that throws is treated as empty', () => {
    const store = new ContextMenuStore();
    store.register({
      pluginId: 'test',
      items: [
        { id: 'good', label: 'Good', order: 1, action: vi.fn() },
        { id: 'bad', label: 'Bad', order: 2, children: () => { throw new Error('plugin bug'); } },
      ],
    });
    store.open({ x: 0, y: 0 }, makeTarget());
    expect(store.getSnapshot().items.map((i) => i.id)).toEqual(['good']);
  });

  it('three-level nesting resolves recursively', () => {
    const store = new ContextMenuStore();
    store.register({
      pluginId: 'test',
      items: [{
        id: 'l1', label: 'Level 1',
        children: () => [{
          id: 'l2', label: 'Level 2',
          children: () => [{ id: 'l3', label: 'Level 3', action: vi.fn() }],
        }],
      }],
    });
    store.open({ x: 0, y: 0 }, makeTarget());
    const l1 = store.getSnapshot().items[0];
    expect(l1.children![0].id).toBe('l2');
    expect(l1.children![0].children![0].id).toBe('l3');
  });

  it('shortcut hint passes through to the snapshot (top level and children)', () => {
    const store = new ContextMenuStore();
    store.register({
      pluginId: 'test',
      items: [
        { id: 'focus', label: 'Focus', shortcut: 'F', action: vi.fn() },
        { id: 'group', label: 'Group', shortcut: 'G', children: [{ id: 'g1', label: 'G1', action: vi.fn() }] },
      ],
    });
    store.open({ x: 0, y: 0 }, makeTarget());
    const items = store.getSnapshot().items;
    expect(items.find((i) => i.id === 'focus')?.shortcut).toBe('F');
    expect(items.find((i) => i.id === 'group')?.shortcut).toBe('G');
  });

  it('openItems opens with an explicit item list, bypassing registrations', () => {
    const store = new ContextMenuStore();
    store.register({ pluginId: 'test', items: [{ id: 'registered', label: 'R', action: vi.fn() }] });
    store.openItems({ x: 5, y: 6 }, makeTarget(), [
      { id: 'b', label: 'B', order: 20, action: vi.fn() },
      { id: 'a', label: 'A', order: 10, action: vi.fn() },
      { id: 'hidden', label: 'H', action: vi.fn(), condition: () => false },
    ]);
    const snap = store.getSnapshot();
    expect(snap.open).toBe(true);
    expect(snap.pos).toEqual({ x: 5, y: 6 });
    expect(snap.items.map((i) => i.id)).toEqual(['a', 'b']); // sorted, filtered, no 'registered'
  });

  it('openItems with nothing applicable stays closed', () => {
    const store = new ContextMenuStore();
    store.openItems({ x: 0, y: 0 }, makeTarget(), [
      { id: 'hidden', label: 'H', action: vi.fn(), condition: () => false },
    ]);
    expect(store.getSnapshot().open).toBe(false);
  });

  it('input spec passes through to the snapshot', () => {
    const store = new ContextMenuStore();
    const onSubmit = vi.fn();
    store.register({
      pluginId: 'test',
      items: [{
        id: 'parent', label: 'Parent',
        children: [{ id: 'new', label: 'New…', input: { placeholder: 'Name', onSubmit } }],
      }],
    });
    store.open({ x: 0, y: 0 }, makeTarget());
    const child = store.getSnapshot().items[0].children![0];
    expect(child.input?.placeholder).toBe('Name');
    expect(child.input?.onSubmit).toBe(onSubmit);
  });
});

describe('ContextMenuStore keyboard chords', () => {
  function makeStoreWithSubmenu() {
    const store = new ContextMenuStore();
    const identical = vi.fn();
    store.register({
      pluginId: 'test',
      items: [
        { id: 'focus', label: 'Focus', order: 1, shortcut: 'F', action: vi.fn() },
        {
          id: 'select', label: 'Select', order: 2, shortcut: 'S',
          children: [
            { id: 'select.identical', label: 'Identical (3)', shortcut: 'I', order: 0, action: identical },
            { id: 'select.invert', label: 'Invert (9)', shortcut: 'V', order: 2, action: vi.fn() },
          ],
        },
      ],
    });
    store.open({ x: 0, y: 0 }, makeTarget());
    return { store, identical };
  }

  it('findByShortcut matches the visible level case-insensitively', () => {
    const { store } = makeStoreWithSubmenu();
    expect(store.findByShortcut('s')?.id).toBe('select');
    expect(store.findByShortcut('S')?.id).toBe('select');
    // Child shortcuts are NOT reachable while the root level is visible.
    expect(store.findByShortcut('i')).toBeNull();
    expect(store.findByShortcut('x')).toBeNull();
  });

  it('findByShortcut returns null while closed and for multi-char keys', () => {
    const { store } = makeStoreWithSubmenu();
    expect(store.findByShortcut('Enter')).toBeNull();
    store.close();
    expect(store.findByShortcut('s')).toBeNull();
  });

  it('descendInto replaces the visible items with the submenu children', () => {
    const { store } = makeStoreWithSubmenu();
    expect(store.descendInto('select')).toBe(true);
    const ids = store.getSnapshot().items.map((i) => i.id);
    expect(ids).toEqual(['select.identical', 'select.invert']);
    expect(store.getSnapshot().open).toBe(true);
    // After descending, the child chord letter resolves (S then I).
    expect(store.findByShortcut('i')?.id).toBe('select.identical');
  });

  it('descendInto refuses unknown ids and leaf items', () => {
    const { store } = makeStoreWithSubmenu();
    expect(store.descendInto('nope')).toBe(false);
    expect(store.descendInto('focus')).toBe(false);
    expect(store.getSnapshot().items.map((i) => i.id)).toEqual(['focus', 'select']);
  });
});
