// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi } from 'vitest';
import { Mesh, BoxGeometry } from 'three';
import { ComponentEventDispatcher } from '../src/core/engine/rv-component-event-dispatcher';
import type { NodeRegistry } from '../src/core/engine/rv-node-registry';
import type { RVViewer } from '../src/core/rv-viewer';

describe('ComponentEventDispatcher', () => {
  function buildMockViewer() {
    const listeners: Record<string, Function[]> = {};
    return {
      on(ev: string, cb: Function) {
        (listeners[ev] ||= []).push(cb);
        return () => {
          const arr = listeners[ev] || [];
          const i = arr.indexOf(cb);
          if (i >= 0) arr.splice(i, 1);
        };
      },
      emit(ev: string, data: any) {
        (listeners[ev] || []).forEach(cb => cb(data));
      },
      _listenerCount(ev: string) { return (listeners[ev] || []).length; },
    } as unknown as RVViewer;
  }

  function buildMockRegistry(nodeMap: Record<string, Mesh>): NodeRegistry {
    return { getNode: (path: string) => nodeMap[path] ?? null } as unknown as NodeRegistry;
  }

  it('dispatches hover to matching component', () => {
    const viewer = buildMockViewer();
    new ComponentEventDispatcher(viewer, {} as NodeRegistry);

    const node = new Mesh(new BoxGeometry());
    const onHoverSpy = vi.fn();
    node.userData._rvComponentInstance = { node, isOwner: true, init: () => {}, onHover: onHoverSpy };

    (viewer as any).emit('object-hover', { node });
    expect(onHoverSpy).toHaveBeenCalledWith(true, expect.any(Object));

    (viewer as any).emit('object-unhover', {});
    expect(onHoverSpy).toHaveBeenCalledWith(false);
  });

  it('dispatches click via object-clicked (NOT object-click)', () => {
    const viewer = buildMockViewer();
    new ComponentEventDispatcher(viewer, {} as NodeRegistry);

    const node = new Mesh(new BoxGeometry());
    const onClickSpy = vi.fn();
    node.userData._rvComponentInstance = { node, isOwner: true, init: () => {}, onClick: onClickSpy };

    // REAL event is 'object-clicked' with payload { path, node }
    (viewer as any).emit('object-clicked', { node, path: 'foo' });
    expect(onClickSpy).toHaveBeenCalledWith({ node, path: 'foo' });

    // Dispatcher must NOT subscribe to 'object-click' (declared but never emitted by viewer)
    onClickSpy.mockClear();
    (viewer as any).emit('object-click', { node });
    expect(onClickSpy).not.toHaveBeenCalled();
  });

  it('walks up parent chain to find component (max depth 32)', () => {
    const viewer = buildMockViewer();
    new ComponentEventDispatcher(viewer, {} as NodeRegistry);

    const parent = new Mesh(new BoxGeometry());
    const child = new Mesh(new BoxGeometry());
    parent.add(child);
    const onHoverSpy = vi.fn();
    parent.userData._rvComponentInstance = { node: parent, isOwner: true, init: () => {}, onHover: onHoverSpy };

    (viewer as any).emit('object-hover', { node: child });
    expect(onHoverSpy).toHaveBeenCalledWith(true, expect.any(Object));
  });

  it('gracefully ignores nodes without component', () => {
    const viewer = buildMockViewer();
    new ComponentEventDispatcher(viewer, {} as NodeRegistry);
    expect(() => (viewer as any).emit('object-hover', { node: new Mesh(new BoxGeometry()) })).not.toThrow();
    expect(() => (viewer as any).emit('object-clicked', { node: new Mesh(new BoxGeometry()), path: 'x' })).not.toThrow();
  });

  it('resolves selection-changed via selectedPaths + registry.getNode()', () => {
    const viewer = buildMockViewer();
    const nodeA = new Mesh(new BoxGeometry());
    const registry = buildMockRegistry({ 'A': nodeA });
    new ComponentEventDispatcher(viewer, registry);

    const onSelectSpy = vi.fn();
    nodeA.userData._rvComponentInstance = { node: nodeA, isOwner: true, init: () => {}, onSelect: onSelectSpy };

    (viewer as any).emit('selection-changed', { selectedPaths: ['A'], primaryPath: 'A' });
    expect(onSelectSpy).toHaveBeenCalledWith(true);
  });

  it('dispatches onSelect(false) when node leaves selection', () => {
    const viewer = buildMockViewer();
    const nodeA = new Mesh(new BoxGeometry());
    const nodeB = new Mesh(new BoxGeometry());
    const registry = buildMockRegistry({ 'A': nodeA, 'B': nodeB });
    new ComponentEventDispatcher(viewer, registry);

    const onSelectA = vi.fn();
    const onSelectB = vi.fn();
    nodeA.userData._rvComponentInstance = { node: nodeA, isOwner: true, init: () => {}, onSelect: onSelectA };
    nodeB.userData._rvComponentInstance = { node: nodeB, isOwner: true, init: () => {}, onSelect: onSelectB };

    (viewer as any).emit('selection-changed', { selectedPaths: ['A'], primaryPath: 'A' });
    expect(onSelectA).toHaveBeenCalledWith(true);

    (viewer as any).emit('selection-changed', { selectedPaths: ['B'], primaryPath: 'B' });
    expect(onSelectA).toHaveBeenCalledWith(false);
    expect(onSelectB).toHaveBeenCalledWith(true);
  });

  it('isolates callback exceptions (one faulty component does not break others)', () => {
    const viewer = buildMockViewer();
    new ComponentEventDispatcher(viewer, {} as NodeRegistry);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const nodeA = new Mesh(new BoxGeometry());
    const nodeB = new Mesh(new BoxGeometry());
    nodeA.userData._rvComponentInstance = {
      node: nodeA, isOwner: true, init: () => {},
      onHover: () => { throw new Error('boom'); },
    };
    const nodeBHoverSpy = vi.fn();
    nodeB.userData._rvComponentInstance = { node: nodeB, isOwner: true, init: () => {}, onHover: nodeBHoverSpy };

    (viewer as any).emit('object-hover', { node: nodeA });
    (viewer as any).emit('object-hover', { node: nodeB });

    // B still gets its callback despite A throwing
    expect(nodeBHoverSpy).toHaveBeenCalledWith(true, expect.any(Object));
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('dispose() unsubscribes viewer listeners', () => {
    const viewer = buildMockViewer();
    const d = new ComponentEventDispatcher(viewer, {} as NodeRegistry);

    const before = (viewer as any)._listenerCount('object-hover');
    expect(before).toBeGreaterThan(0);

    d.dispose();
    const after = (viewer as any)._listenerCount('object-hover');
    expect(after).toBe(before - 1);
  });

  it('does not double-fire onHover when object-hover:null and object-unhover both arrive', () => {
    const viewer = buildMockViewer();
    new ComponentEventDispatcher(viewer, {} as NodeRegistry);

    const node = new Mesh(new BoxGeometry());
    const onHoverSpy = vi.fn();
    node.userData._rvComponentInstance = { node, isOwner: true, init: () => {}, onHover: onHoverSpy };

    (viewer as any).emit('object-hover', { node });
    onHoverSpy.mockClear();

    // Both null-hover and unhover may fire
    (viewer as any).emit('object-hover', null);
    (viewer as any).emit('object-unhover', {});

    // Second call should be a no-op (_lastHoveredNode already null after first)
    const falseCallCount = onHoverSpy.mock.calls.filter(c => c[0] === false).length;
    expect(falseCallCount).toBe(1);
  });
});
