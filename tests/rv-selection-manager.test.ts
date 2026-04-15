// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SelectionManager Unit Tests
 *
 * Tests central selection state management: select, toggle, deselect, clear,
 * Escape key handling, React external store API, and viewer event emission.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SelectionManager } from '../src/core/engine/rv-selection-manager';

// ── Minimal viewer mock ──────────────────────────────────────────────────

function createMockViewer() {
  const emitted: Array<{ event: string; data: unknown }> = [];
  const nodes = new Map<string, object>();
  // Pre-populate some nodes
  nodes.set('Robot/Axis1', { name: 'Axis1' });
  nodes.set('Robot/Axis2', { name: 'Axis2' });
  nodes.set('Conveyor1', { name: 'Conveyor1' });

  return {
    highlighter: {
      highlightSelection: vi.fn(),
      clearSelection: vi.fn(),
    },
    registry: {
      getNode: (path: string) => nodes.get(path) ?? null,
    },
    emit: vi.fn((event: string, data: unknown) => {
      emitted.push({ event, data });
    }),
    _emitted: emitted,
    _nodes: nodes,
  };
}

describe('SelectionManager', () => {
  let sm: SelectionManager;
  let viewer: ReturnType<typeof createMockViewer>;

  beforeEach(() => {
    sm = new SelectionManager();
    viewer = createMockViewer();
    sm.init(viewer as never);
  });

  // ── Basic selection ──

  it('should start with empty selection', () => {
    expect(sm.count).toBe(0);
    expect(sm.primaryPath).toBeNull();
    expect(sm.selectedPaths).toEqual([]);
  });

  it('select() sets a single path', () => {
    sm.select('Robot/Axis1');
    expect(sm.count).toBe(1);
    expect(sm.primaryPath).toBe('Robot/Axis1');
    expect(sm.isSelected('Robot/Axis1')).toBe(true);
    expect(sm.isSelected('Robot/Axis2')).toBe(false);
  });

  it('select() replaces previous selection', () => {
    sm.select('Robot/Axis1');
    sm.select('Robot/Axis2');
    expect(sm.count).toBe(1);
    expect(sm.primaryPath).toBe('Robot/Axis2');
    expect(sm.isSelected('Robot/Axis1')).toBe(false);
    expect(sm.isSelected('Robot/Axis2')).toBe(true);
  });

  it('select() same path twice is a no-op', () => {
    sm.select('Robot/Axis1');
    const emitCount = viewer.emit.mock.calls.length;
    sm.select('Robot/Axis1');
    // Should not emit again
    expect(viewer.emit.mock.calls.length).toBe(emitCount);
  });

  // ── Toggle (Shift+click) ──

  it('toggle() adds to multi-selection', () => {
    sm.select('Robot/Axis1');
    sm.toggle('Robot/Axis2');
    expect(sm.count).toBe(2);
    expect(sm.isSelected('Robot/Axis1')).toBe(true);
    expect(sm.isSelected('Robot/Axis2')).toBe(true);
    expect(sm.primaryPath).toBe('Robot/Axis2'); // last added
  });

  it('toggle() removes if already selected', () => {
    sm.select('Robot/Axis1');
    sm.toggle('Robot/Axis2');
    sm.toggle('Robot/Axis1'); // remove
    expect(sm.count).toBe(1);
    expect(sm.isSelected('Robot/Axis1')).toBe(false);
    expect(sm.isSelected('Robot/Axis2')).toBe(true);
  });

  it('toggle() on empty adds first selection', () => {
    sm.toggle('Conveyor1');
    expect(sm.count).toBe(1);
    expect(sm.primaryPath).toBe('Conveyor1');
  });

  // ── Deselect ──

  it('deselect() removes a single path', () => {
    sm.select('Robot/Axis1');
    sm.toggle('Robot/Axis2');
    sm.deselect('Robot/Axis1');
    expect(sm.count).toBe(1);
    expect(sm.isSelected('Robot/Axis1')).toBe(false);
  });

  it('deselect() on non-selected path is a no-op', () => {
    sm.select('Robot/Axis1');
    const emitCount = viewer.emit.mock.calls.length;
    sm.deselect('Conveyor1');
    expect(viewer.emit.mock.calls.length).toBe(emitCount);
  });

  // ── Clear ──

  it('clear() empties selection', () => {
    sm.select('Robot/Axis1');
    sm.toggle('Robot/Axis2');
    sm.clear();
    expect(sm.count).toBe(0);
    expect(sm.primaryPath).toBeNull();
    expect(sm.isSelected('Robot/Axis1')).toBe(false);
  });

  it('clear() on empty is a no-op', () => {
    const emitCount = viewer.emit.mock.calls.length;
    sm.clear();
    expect(viewer.emit.mock.calls.length).toBe(emitCount);
  });

  // ── Highlight calls ──

  it('select() calls highlightSelection with resolved node', () => {
    sm.select('Robot/Axis1');
    expect(viewer.highlighter.highlightSelection).toHaveBeenCalledWith(
      [viewer._nodes.get('Robot/Axis1')],
      { includeChildDrives: false },
    );
  });

  it('clear() calls clearSelection', () => {
    sm.select('Robot/Axis1');
    viewer.highlighter.clearSelection.mockClear();
    sm.clear();
    expect(viewer.highlighter.clearSelection).toHaveBeenCalled();
  });

  it('multi-select highlights all nodes', () => {
    sm.select('Robot/Axis1');
    sm.toggle('Robot/Axis2');
    expect(viewer.highlighter.highlightSelection).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        viewer._nodes.get('Robot/Axis1'),
        viewer._nodes.get('Robot/Axis2'),
      ]),
      { includeChildDrives: false },
    );
  });

  // ── Event emission ──

  it('emits selection-changed on select', () => {
    sm.select('Robot/Axis1');
    const event = viewer._emitted.find(e => e.event === 'selection-changed');
    expect(event).toBeDefined();
    expect(event!.data).toMatchObject({
      selectedPaths: ['Robot/Axis1'],
      primaryPath: 'Robot/Axis1',
    });
  });

  it('emits selection-changed on clear', () => {
    sm.select('Robot/Axis1');
    viewer._emitted.length = 0;
    sm.clear();
    const event = viewer._emitted.find(e => e.event === 'selection-changed');
    expect(event).toBeDefined();
    expect(event!.data).toMatchObject({
      selectedPaths: [],
      primaryPath: null,
    });
  });

  // ── React external store ──

  it('subscribe/getSnapshot works for React useSyncExternalStore', () => {
    const listener = vi.fn();
    const unsub = sm.subscribe(listener);

    sm.select('Robot/Axis1');
    expect(listener).toHaveBeenCalledTimes(1);

    const snap = sm.getSnapshot();
    expect(snap.selectedPaths).toEqual(['Robot/Axis1']);
    expect(snap.primaryPath).toBe('Robot/Axis1');

    unsub();
    sm.select('Robot/Axis2');
    expect(listener).toHaveBeenCalledTimes(1); // no more calls after unsub
  });

  it('getSnapshot returns new object on each change', () => {
    const snap1 = sm.getSnapshot();
    sm.select('Robot/Axis1');
    const snap2 = sm.getSnapshot();
    expect(snap1).not.toBe(snap2);
  });

  // ── Escape key ──

  it('Escape key clears selection', () => {
    sm.select('Robot/Axis1');
    const event = new KeyboardEvent('keydown', { key: 'Escape' });
    document.dispatchEvent(event);
    expect(sm.count).toBe(0);
  });

  it('Escape does not fire when focused on input', () => {
    sm.select('Robot/Axis1');
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    Object.defineProperty(event, 'target', { value: input });
    document.dispatchEvent(event);
    expect(sm.count).toBe(1); // not cleared
    document.body.removeChild(input);
  });

  // ── Dispose ──

  it('dispose removes event listeners', () => {
    sm.select('Robot/Axis1');
    sm.dispose();
    // After dispose, Escape should not clear
    sm = new SelectionManager();
    const viewer2 = createMockViewer();
    sm.init(viewer2 as never);
    sm.select('Robot/Axis1');
    // Old manager's Escape handler was removed, new one still works
    const event = new KeyboardEvent('keydown', { key: 'Escape' });
    document.dispatchEvent(event);
    expect(sm.count).toBe(0);
  });

  // ── Unknown paths ──

  it('select with unresolvable path still updates state but skips highlight', () => {
    sm.select('NonExistent/Path');
    expect(sm.count).toBe(1);
    expect(sm.primaryPath).toBe('NonExistent/Path');
    // No highlightSelection since node is null
    expect(viewer.highlighter.clearSelection).toHaveBeenCalled();
  });
});
