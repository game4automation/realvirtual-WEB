// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TooltipStore Tests
 *
 * Tests store lifecycle: show/hide, priority resolution, subscribe/unsubscribe,
 * stable snapshot references, shallow-compare guard, hideAll,
 * hover/pin lifecycle, multi-tooltip visibility, and merge-by-targetPath.
 */
import { describe, it, expect, vi } from 'vitest';
import { TooltipStore } from '../src/core/hmi/tooltip/tooltip-store';

/** Helper: get the first visible tooltip's primary entry (replaces old `.active`). */
function firstVisible(store: TooltipStore) {
  const { visible } = store.getSnapshot();
  return visible.length > 0 ? visible[0].primary : null;
}

describe('TooltipStore', () => {
  // ── Basic lifecycle ──

  it('should start with no visible tooltips', () => {
    const store = new TooltipStore();
    expect(store.getSnapshot().visible).toEqual([]);
  });

  it('should show and hide a tooltip', () => {
    const store = new TooltipStore();
    store.show({ id: 'drive', data: { type: 'drive', driveName: 'Axis1' }, mode: 'cursor', cursorPos: { x: 100, y: 200 } });
    expect(firstVisible(store)?.id).toBe('drive');
    store.hide('drive');
    expect(store.getSnapshot().visible).toEqual([]);
  });

  it('should notify listeners on show/hide', () => {
    const store = new TooltipStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.show({ id: 'test', data: { type: 'sensor' }, mode: 'fixed', fixedPos: { x: 0, y: 0 } });
    expect(listener).toHaveBeenCalledTimes(1);
    store.hide('test');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('should return stable snapshot when state unchanged', () => {
    const store = new TooltipStore();
    const snap1 = store.getSnapshot();
    const snap2 = store.getSnapshot();
    expect(snap1).toBe(snap2);
  });

  it('should NOT notify when show() called with identical data (shallow-compare)', () => {
    const store = new TooltipStore();
    const listener = vi.fn();
    store.show({ id: 'drive', data: { type: 'drive', driveName: 'Axis1' }, mode: 'cursor', cursorPos: { x: 0, y: 0 } });
    store.subscribe(listener);
    store.show({ id: 'drive', data: { type: 'drive', driveName: 'Axis1' }, mode: 'cursor', cursorPos: { x: 50, y: 50 } });
    expect(listener).toHaveBeenCalledTimes(0);
  });

  it('should update existing tooltip data when changed', () => {
    const store = new TooltipStore();
    store.show({ id: 'drive', data: { type: 'drive', driveName: 'Axis1' }, mode: 'cursor', cursorPos: { x: 0, y: 0 } });
    store.show({ id: 'drive', data: { type: 'drive', driveName: 'Axis2' }, mode: 'cursor', cursorPos: { x: 50, y: 50 } });
    expect(firstVisible(store)?.data.driveName).toBe('Axis2');
  });

  it('should unsubscribe correctly', () => {
    const store = new TooltipStore();
    const listener = vi.fn();
    const unsub = store.subscribe(listener);
    unsub();
    store.show({ id: 'x', data: { type: 'custom' }, mode: 'fixed' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('should hideAll and clear all tooltips', () => {
    const store = new TooltipStore();
    store.show({ id: 'a', data: { type: 'drive' }, mode: 'cursor' });
    store.show({ id: 'b', data: { type: 'sensor' }, mode: 'cursor', priority: 20 });
    store.hideAll();
    expect(store.getSnapshot().visible).toEqual([]);
  });

  it('should not notify on hide of non-existent tooltip', () => {
    const store = new TooltipStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.hide('nonexistent');
    expect(listener).not.toHaveBeenCalled();
  });

  it('should not notify on hideAll when already empty', () => {
    const store = new TooltipStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.hideAll();
    expect(listener).not.toHaveBeenCalled();
  });

  it('should store cursor position ref-based via getCursorPos', () => {
    const store = new TooltipStore();
    store.show({ id: 'drive', data: { type: 'drive' }, mode: 'cursor', cursorPos: { x: 100, y: 200 } });
    expect(store.getCursorPos('drive')).toEqual({ x: 100, y: 200 });

    const listener = vi.fn();
    store.subscribe(listener);
    store.show({ id: 'drive', data: { type: 'drive' }, mode: 'cursor', cursorPos: { x: 300, y: 400 } });
    expect(store.getCursorPos('drive')).toEqual({ x: 300, y: 400 });
    expect(listener).not.toHaveBeenCalled();
  });

  it('should create new snapshot reference on state change', () => {
    const store = new TooltipStore();
    const snap1 = store.getSnapshot();
    store.show({ id: 'test', data: { type: 'test' }, mode: 'fixed' });
    const snap2 = store.getSnapshot();
    expect(snap1).not.toBe(snap2);
  });

  // ── Hover priority resolution (single hover winner) ──

  it('should resolve hover priority: higher wins', () => {
    const store = new TooltipStore();
    store.show({ id: 'low', data: { type: 'drive', driveName: 'Axis1' }, mode: 'cursor', priority: 5 });
    store.show({ id: 'high', data: { type: 'sensor' }, mode: 'cursor', priority: 20 });
    // Only one hover visible (the winner)
    expect(store.getSnapshot().visible.length).toBe(1);
    expect(firstVisible(store)?.id).toBe('high');
    store.hide('high');
    expect(firstVisible(store)?.id).toBe('low');
  });

  it('should fall back to lower priority hover when higher is hidden', () => {
    const store = new TooltipStore();
    store.show({ id: 'p5', data: { type: 'a' }, mode: 'cursor', priority: 5 });
    store.show({ id: 'p10', data: { type: 'b' }, mode: 'cursor', priority: 10 });
    store.show({ id: 'p20', data: { type: 'c' }, mode: 'cursor', priority: 20 });
    expect(firstVisible(store)?.id).toBe('p20');

    store.hide('p20');
    expect(firstVisible(store)?.id).toBe('p10');

    store.hide('p10');
    expect(firstVisible(store)?.id).toBe('p5');
  });

  // ── Hover/Pin lifecycle ──

  it('should show multiple pinned tooltips simultaneously', () => {
    const store = new TooltipStore();
    store.show({
      id: 'pin-a', data: { type: 'drive', driveName: 'Axis1' }, mode: 'world',
      lifecycle: 'pinned', targetPath: '/Robot/Axis1', priority: 5,
    });
    store.show({
      id: 'pin-b', data: { type: 'drive', driveName: 'Axis2' }, mode: 'world',
      lifecycle: 'pinned', targetPath: '/Robot/Axis2', priority: 5,
    });
    expect(store.getSnapshot().visible.length).toBe(2);
  });

  it('should show hover alongside pinned when targeting different paths', () => {
    const store = new TooltipStore();
    store.show({
      id: 'pin-a', data: { type: 'drive', driveName: 'Axis1' }, mode: 'world',
      lifecycle: 'pinned', targetPath: '/Robot/Axis1', priority: 5,
    });
    store.show({
      id: 'hover', data: { type: 'drive', driveName: 'Axis2' }, mode: 'cursor',
      lifecycle: 'hover', targetPath: '/Robot/Axis2', priority: 10,
    });
    // Both should be visible: 1 pinned + 1 hover
    expect(store.getSnapshot().visible.length).toBe(2);
  });

  it('should suppress hover when targeting same path as a pinned entry', () => {
    const store = new TooltipStore();
    store.show({
      id: 'pin-a', data: { type: 'drive', driveName: 'Axis1' }, mode: 'world',
      lifecycle: 'pinned', targetPath: '/Robot/Axis1', priority: 5,
    });
    store.show({
      id: 'hover', data: { type: 'drive', driveName: 'Axis1' }, mode: 'cursor',
      lifecycle: 'hover', targetPath: '/Robot/Axis1', priority: 10,
    });
    // Hover suppressed — only pinned visible
    expect(store.getSnapshot().visible.length).toBe(1);
    expect(store.getSnapshot().visible[0].primary.id).toBe('pin-a');
  });

  it('should keep pinned tooltips when hover is hidden', () => {
    const store = new TooltipStore();
    store.show({
      id: 'pin-a', data: { type: 'drive', driveName: 'Axis1' }, mode: 'world',
      lifecycle: 'pinned', targetPath: '/Robot/Axis1', priority: 5,
    });
    store.show({
      id: 'hover', data: { type: 'drive', driveName: 'Axis2' }, mode: 'cursor',
      lifecycle: 'hover', targetPath: '/Robot/Axis2', priority: 10,
    });
    expect(store.getSnapshot().visible.length).toBe(2);

    // Hide hover — pinned stays
    store.hide('hover');
    expect(store.getSnapshot().visible.length).toBe(1);
    expect(store.getSnapshot().visible[0].primary.id).toBe('pin-a');
  });

  // ── Merge by targetPath ──

  it('should merge entries with same targetPath into one VisibleTooltip', () => {
    const store = new TooltipStore();
    store.show({
      id: 'pin-drive', data: { type: 'drive', driveName: 'Axis1' }, mode: 'world',
      lifecycle: 'pinned', targetPath: '/Robot/Axis1', priority: 5,
    });
    store.show({
      id: 'pin-meta', data: { type: 'metadata', content: 'info' }, mode: 'world',
      lifecycle: 'pinned', targetPath: '/Robot/Axis1', priority: 3,
    });
    const { visible } = store.getSnapshot();
    expect(visible.length).toBe(1);
    expect(visible[0].contentEntries.length).toBe(2);
    // Primary should be the higher priority entry
    expect(visible[0].primary.id).toBe('pin-drive');
    // Both content types present
    const types = visible[0].contentEntries.map(e => e.data.type);
    expect(types).toContain('drive');
    expect(types).toContain('metadata');
  });

  it('should keep entries with different targetPaths as separate VisibleTooltips', () => {
    const store = new TooltipStore();
    store.show({
      id: 'pin-a', data: { type: 'drive' }, mode: 'world',
      lifecycle: 'pinned', targetPath: '/Robot/Axis1', priority: 5,
    });
    store.show({
      id: 'pin-b', data: { type: 'drive' }, mode: 'world',
      lifecycle: 'pinned', targetPath: '/Robot/Axis2', priority: 5,
    });
    const { visible } = store.getSnapshot();
    expect(visible.length).toBe(2);
    expect(visible[0].contentEntries.length).toBe(1);
    expect(visible[1].contentEntries.length).toBe(1);
  });

  it('should merge hover entries sharing same targetPath into one stacked bubble', () => {
    const store = new TooltipStore();
    // Two hover entries on same node (e.g. drive + metadata on same node)
    store.show({
      id: 'drive-hover', data: { type: 'drive', driveName: 'Axis1' }, mode: 'cursor',
      lifecycle: 'hover', targetPath: '/Robot/Axis1', priority: 10,
    });
    store.show({
      id: 'meta-hover', data: { type: 'metadata', content: 'info' }, mode: 'cursor',
      lifecycle: 'hover', targetPath: '/Robot/Axis1', priority: 8,
    });
    const { visible } = store.getSnapshot();
    // Both hovers share targetPath — they are in the same group and both survive
    expect(visible.length).toBe(1);
    expect(visible[0].primary.id).toBe('drive-hover'); // highest priority is primary
    expect(visible[0].contentEntries.length).toBe(2);
    const types = visible[0].contentEntries.map(e => e.data.type);
    expect(types).toContain('drive');
    expect(types).toContain('metadata');
  });

  it('should NOT merge hover entries with different targetPaths', () => {
    const store = new TooltipStore();
    store.show({
      id: 'drive-hover', data: { type: 'drive' }, mode: 'cursor',
      lifecycle: 'hover', targetPath: '/Robot/Axis1', priority: 10,
    });
    store.show({
      id: 'pipe-hover', data: { type: 'pipe' }, mode: 'cursor',
      lifecycle: 'hover', targetPath: '/Pipeline/Pipe1', priority: 10,
    });
    const { visible } = store.getSnapshot();
    // Different targetPaths — only one hover group wins
    expect(visible.length).toBe(1);
  });

  // ── Backward compatibility (entries without lifecycle/targetPath) ──

  it('should treat entries without lifecycle as hover (backward compat)', () => {
    const store = new TooltipStore();
    store.show({ id: 'legacy', data: { type: 'custom' }, mode: 'cursor', priority: 5 });
    expect(firstVisible(store)?.id).toBe('legacy');
    // Should be treated as hover (only one visible)
    store.show({ id: 'legacy2', data: { type: 'custom2' }, mode: 'cursor', priority: 10 });
    expect(store.getSnapshot().visible.length).toBe(1);
    expect(firstVisible(store)?.id).toBe('legacy2');
  });

  it('should not merge entries without targetPath', () => {
    const store = new TooltipStore();
    store.show({
      id: 'pin-a', data: { type: 'drive' }, mode: 'world',
      lifecycle: 'pinned', priority: 5,
    });
    store.show({
      id: 'pin-b', data: { type: 'sensor' }, mode: 'world',
      lifecycle: 'pinned', priority: 5,
    });
    // Without targetPath, each is its own group
    expect(store.getSnapshot().visible.length).toBe(2);
  });

  it('should compare lifecycle and targetPath in shallow-equal', () => {
    const store = new TooltipStore();
    const listener = vi.fn();
    store.show({
      id: 'drive', data: { type: 'drive' }, mode: 'cursor',
      lifecycle: 'hover', targetPath: '/A',
    });
    store.subscribe(listener);
    // Same data but different lifecycle should trigger notify
    store.show({
      id: 'drive', data: { type: 'drive' }, mode: 'cursor',
      lifecycle: 'pinned', targetPath: '/A',
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
