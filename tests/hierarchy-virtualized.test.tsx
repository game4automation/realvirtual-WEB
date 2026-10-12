// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Virtualization of the hierarchy rows.
 *
 * Since plan-754 the rows come from the scene graph, so the fixtures here are
 * real `Object3D` trees; the row pipeline (`flattenSceneRows` → virtualizer →
 * `TreeNodeRow`) and its guarantees — mount only what is on screen, stable
 * uuid keys, ARIA sibling metadata — are unchanged.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Group, Object3D, Scene } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { FlatNodeRow, TreeNodeRow, rowDomId } from '../src/core/hmi/HierarchyNodeRow';
import { flattenSceneRows, type SceneRowContext, type SceneTreeNode } from '../src/core/hmi/hierarchy-rows';
import type { TreeNode, VisibleTreeRow } from '../src/core/hmi/hierarchy-utils';
import {
  resolvePointerRowHeight,
  ROW_HEIGHT_COARSE,
  ROW_HEIGHT_FINE,
} from '../src/hooks/use-pointer-row-height';
import hierarchyBrowserSource from '../src/core/hmi/rv-hierarchy-browser.tsx?raw';

const badgeViewerSpy = vi.hoisted(() => vi.fn());

vi.mock('../src/core/hmi/hierarchy-badge-components', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/hmi/hierarchy-badge-components')>();
  return {
    ...actual,
    NodeBadges: (props: { viewer?: RVViewer }) => {
      badgeViewerSpy(props.viewer);
      return <span data-testid="node-badges" />;
    },
  };
});

const viewer = { id: 'test-viewer' } as unknown as RVViewer;
const noop = () => {};

/** A registered scene of `count` flat children under one root. */
function makeScene(count: number, childFactory?: (i: number) => Object3D) {
  const scene = new Scene();
  const root = new Group(); root.name = 'Root';
  scene.add(root);
  const paths = new Map<Object3D, string>([[root, 'Root']]);
  for (let i = 0; i < count; i++) {
    const child = childFactory ? childFactory(i) : new Group();
    if (!child.name) child.name = `Node-${i}`;
    root.add(child);
    paths.set(child, `Root/${child.name}`);
    for (const g of child.children) paths.set(g, `Root/${child.name}/${g.name}`);
  }
  const ctx: SceneRowContext = {
    getPathForNode: (n) => paths.get(n) ?? null,
    overlay: null,
    modelRoot: null,
    hideRuntime: false,
  };
  const expandAll = new Set<string>();
  scene.traverse((n) => expandAll.add(n.uuid));
  return { scene, root, ctx, expandAll, paths };
}

function rowsOf(count: number) {
  const s = makeScene(count);
  return flattenSceneRows(s.scene, s.expandAll, s.ctx);
}

function VirtualTree({
  rows,
  height = 200,
  revealIndex = null,
  initialActive = null,
}: {
  rows: VisibleTreeRow[];
  height?: number;
  revealIndex?: number | null;
  initialActive?: string | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeKey, setActiveKey] = useState(initialActive);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT_FINE,
    getItemKey: (index) => rows[index]?.rowKey ?? index,
    overscan: 10,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const mounted = useMemo(() => new Set(
    virtualItems.flatMap((item) => rows[item.index]?.rowKey ?? []),
  ), [rows, virtualItems]);

  useEffect(() => {
    if (revealIndex !== null) virtualizer.scrollToIndex(revealIndex, { align: 'center' });
  }, [revealIndex, virtualizer]);

  useEffect(() => {
    if (!pendingKey || !mounted.has(pendingKey)) return;
    setActiveKey(pendingKey);
    setPendingKey(null);
  }, [mounted, pendingKey]);

  return (
    <div
      ref={scrollRef}
      role="tree"
      tabIndex={0}
      aria-activedescendant={activeKey && mounted.has(activeKey) ? rowDomId(activeKey) : undefined}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowDown') return;
        const current = rows.findIndex((row) => row.rowKey === activeKey);
        const next = Math.min(rows.length - 1, Math.max(0, current + 1));
        const key = rows[next]?.rowKey;
        if (!key) return;
        virtualizer.scrollToIndex(next, { align: 'center' });
        setPendingKey(key);
      }}
      style={{ height, width: 320, overflow: 'auto', position: 'relative' }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualItems.map((item) => {
          const row = rows[item.index];
          return (
            <TreeNodeRow
              key={row.rowKey}
              row={row}
              selected={row.rowKey === activeKey}
              expanded={new Set()}
              onToggleExpand={noop}
              onSelect={(node) => setActiveKey((node as SceneTreeNode).object.uuid)}
              onDoubleClick={noop}
              onHover={noop}
              signalStore={null}
              logicEngine={null}
              viewer={viewer}
              rowHeight={ROW_HEIGHT_FINE}
              virtualStyle={{
                position: 'absolute',
                width: '100%',
                height: item.size,
                transform: `translateY(${item.start}px)`,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

afterEach(() => {
  cleanup();
  badgeViewerSpy.mockClear();
});

describe('HierarchyBrowser tree virtualization', () => {
  it('mounts only viewport rows for a 10k-node expanded tree', async () => {
    render(<VirtualTree rows={rowsOf(10_000)} />);

    await waitFor(() => expect(screen.getAllByRole('treeitem').length).toBeGreaterThan(0));
    expect(screen.getAllByRole('treeitem').length).toBeLessThan(100);
  });

  it('derives every tree-view row set from the scene graph, not a node scan', () => {
    expect(hierarchyBrowserSource).toContain('flattenSceneRows(rootObject, expanded, rowCtx)');
    expect(hierarchyBrowserSource).toContain('buildSceneSearchTree(rootObject, deferredTerm, rowCtx');
    expect(hierarchyBrowserSource).not.toContain('state.editableNodes');
    expect(hierarchyBrowserSource).not.toContain('hierarchyScope');
  });

  it('reveal scrolls an off-screen target into the rendered window', async () => {
    const rows = rowsOf(1_000);
    const target = rows[900].node.path;
    const { rerender } = render(<VirtualTree rows={rows} />);
    rerender(<VirtualTree rows={rows} revealIndex={900} />);

    await waitFor(() => expect(document.querySelector(`[data-path="${target}"]`)).toBeTruthy());
  });

  it('scrolls before moving aria-activedescendant to a mounted keyboard target', async () => {
    const rows = rowsOf(500);
    const last = rows[rows.length - 1].rowKey;
    render(<VirtualTree rows={rows} initialActive={last} />);
    const tree = screen.getByRole('tree');
    expect(tree.hasAttribute('aria-activedescendant')).toBe(false);

    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    await waitFor(() => expect(tree.getAttribute('aria-activedescendant')).toBe(rowDomId(last)));
    expect(document.getElementById(rowDomId(last))).toBeTruthy();
  });

  it('removes aria-activedescendant for an externally selected unmounted row', async () => {
    const rows = rowsOf(500);
    render(<VirtualTree rows={rows} initialActive={rows[rows.length - 1].rowKey} />);
    await waitFor(() => expect(screen.getAllByRole('treeitem').length).toBeGreaterThan(0));
    expect(screen.getByRole('tree').hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('passes shift-click modifiers so the caller can select a visible contiguous range', () => {
    const onSelect = vi.fn();
    const rows = rowsOf(1);
    const row = rows[rows.length - 1];
    render(
      <TreeNodeRow
        row={row}
        expanded={new Set()}
        onToggleExpand={noop}
        onSelect={onSelect}
        onDoubleClick={noop}
        onHover={noop}
        signalStore={null}
        logicEngine={null}
        rowHeight={ROW_HEIGHT_FINE}
        virtualStyle={{}}
      />,
    );

    fireEvent.click(screen.getByRole('treeitem'), { shiftKey: true });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].object).toBe((row.node as SceneTreeNode).object);
    expect(onSelect.mock.calls[0][1]).toEqual({ shift: true, toggle: false });
  });

  it('maps flattened depth and sibling metadata onto ARIA treeitem attributes', () => {
    const s = makeScene(2, (i) => {
      const parent = new Group(); parent.name = `Parent-${i}`;
      const child = new Group(); child.name = 'Leaf';
      parent.add(child);
      return parent;
    });
    const rows = flattenSceneRows(s.scene, s.expandAll, s.ctx);
    const row = rows.find((r) => r.node.name === 'Parent-1')!;
    render(
      <TreeNodeRow
        row={row}
        expanded={new Set()}
        onToggleExpand={noop}
        onSelect={noop}
        onDoubleClick={noop}
        onHover={noop}
        signalStore={null}
        logicEngine={null}
        rowHeight={ROW_HEIGHT_FINE}
        virtualStyle={{}}
      />,
    );

    const item = screen.getByRole('treeitem');
    expect(item.getAttribute('aria-level')).toBe('3'); // Scene > Root > Parent-1
    expect(item.getAttribute('aria-posinset')).toBe('2');
    expect(item.getAttribute('aria-setsize')).toBe('2');
  });

  it('uses stable uuid row keys when visible descendants are inserted above the viewport', () => {
    const s = makeScene(2, (i) => {
      const parent = new Group(); parent.name = i === 0 ? 'A' : 'B';
      if (i === 0) { const c = new Group(); c.name = 'A1'; parent.add(c); }
      return parent;
    });
    const b = s.root.children.find((c) => c.name === 'B')!;
    const collapsed = flattenSceneRows(s.scene, new Set([s.scene.uuid, s.root.uuid]), s.ctx);
    const expanded = flattenSceneRows(
      s.scene,
      new Set([s.scene.uuid, s.root.uuid, s.root.children[0].uuid]),
      s.ctx,
    );

    expect(expanded.find((r) => r.rowKey === b.uuid)?.rowKey)
      .toBe(collapsed.find((r) => r.rowKey === b.uuid)?.rowKey);
    // …and the key is the object identity, not the path.
    expect(collapsed.find((r) => r.node.path === 'Root/B')!.rowKey).toBe(b.uuid);
  });

  it('resolves one shared fine/coarse row height contract for tree and flat rows', () => {
    const fine = resolvePointerRowHeight(() => ({ matches: false }));
    const coarse = resolvePointerRowHeight(() => ({ matches: true }));
    expect(fine).toBe(ROW_HEIGHT_FINE);
    expect(coarse).toBe(ROW_HEIGHT_COARSE);

    const row = rowsOf(1)[1];
    const { rerender } = render(
      <TreeNodeRow
        row={row}
        expanded={new Set()}
        onToggleExpand={noop}
        onSelect={noop}
        onDoubleClick={noop}
        onHover={noop}
        signalStore={null}
        logicEngine={null}
        rowHeight={coarse}
        virtualStyle={{}}
      />,
    );
    expect(getComputedStyle(screen.getByRole('treeitem')).height).toBe('44px');

    rerender(
      <FlatNodeRow
        node={row.node as TreeNode}
        rowKey={row.rowKey}
        onSelect={noop}
        onDoubleClick={noop}
        onHover={noop}
        signalStore={null}
        logicEngine={null}
        rowHeight={coarse}
      />,
    );
    expect(getComputedStyle(screen.getByRole('treeitem')).height).toBe('44px');
  });
});

describe('FlatNodeRow badges', () => {
  it('passes viewer to NodeBadges so signal chips stay live and interactive', () => {
    const s = makeScene(1, () => {
      const n = new Group(); n.name = 'Signal';
      n.userData.realvirtual = { PLCOutputBool: {} };
      return n;
    });
    const rows = flattenSceneRows(s.scene, s.expandAll, s.ctx);
    const row = rows.find((r) => r.node.name === 'Signal')!;
    render(
      <FlatNodeRow
        node={row.node as TreeNode}
        rowKey={row.rowKey}
        onSelect={noop}
        onDoubleClick={noop}
        onHover={noop}
        signalStore={null}
        logicEngine={null}
        viewer={viewer}
        rowHeight={ROW_HEIGHT_FINE}
      />,
    );

    expect(screen.getByTestId('node-badges')).toBeTruthy();
    expect(badgeViewerSpy).toHaveBeenCalledWith(viewer);
  });
});
