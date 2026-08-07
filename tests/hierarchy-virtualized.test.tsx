// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RVViewer } from '../src/core/rv-viewer';
import { FlatNodeRow, TreeNodeRow, rowDomId } from '../src/core/hmi/HierarchyNodeRow';
import {
  flattenVisibleTree,
  type TreeNode,
  type VisibleTreeRow,
} from '../src/core/hmi/hierarchy-utils';
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

function leaf(path: string): TreeNode {
  return { name: path.split('/').pop()!, path, types: [], hasOverrides: false, children: [] };
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
  const [activePath, setActivePath] = useState(initialActive);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT_FINE,
    getItemKey: (index) => rows[index]?.rowKey ?? index,
    overscan: 10,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const mounted = useMemo(() => new Set(
    virtualItems.flatMap((item) => rows[item.index]?.node.path ?? []),
  ), [rows, virtualItems]);

  useEffect(() => {
    if (revealIndex !== null) virtualizer.scrollToIndex(revealIndex, { align: 'center' });
  }, [revealIndex, virtualizer]);

  useEffect(() => {
    if (!pendingPath || !mounted.has(pendingPath)) return;
    setActivePath(pendingPath);
    setPendingPath(null);
  }, [mounted, pendingPath]);

  return (
    <div
      ref={scrollRef}
      role="tree"
      tabIndex={0}
      aria-activedescendant={activePath && mounted.has(activePath) ? rowDomId(activePath) : undefined}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowDown') return;
        const current = rows.findIndex((row) => row.node.path === activePath);
        const next = Math.min(rows.length - 1, Math.max(0, current + 1));
        const path = rows[next]?.node.path;
        if (!path) return;
        virtualizer.scrollToIndex(next, { align: 'center' });
        setPendingPath(path);
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
              selectedPaths={new Set(activePath ? [activePath] : [])}
              expanded={new Set()}
              onToggleExpand={noop}
              onSelect={setActivePath}
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
    const rows = flattenVisibleTree(
      Array.from({ length: 10_000 }, (_, index) => leaf(`Root/Node-${index}`)),
      new Set(),
    );
    render(<VirtualTree rows={rows} />);

    await waitFor(() => expect(screen.getAllByRole('treeitem').length).toBeGreaterThan(0));
    expect(screen.getAllByRole('treeitem').length).toBeLessThan(100);
  });

  it('uses deferredTerm as the SSOT for every search-derived tree calculation', () => {
    expect(hierarchyBrowserSource).toContain('filterTree(tree, deferredTerm, viewer)');
    expect(hierarchyBrowserSource).toContain('if (!deferredTerm || typeFilter !== \'all\') return null;');
    expect(hierarchyBrowserSource).toContain("if (typeFilter !== 'all' || !deferredTerm) return [null, null];");
    expect(hierarchyBrowserSource).not.toContain('filterTree(tree, searchTerm, viewer)');
  });

  it('reveal scrolls an off-screen target into the rendered window', async () => {
    const rows = flattenVisibleTree(
      Array.from({ length: 1_000 }, (_, index) => leaf(`Root/Node-${index}`)),
      new Set(),
    );
    const { rerender } = render(<VirtualTree rows={rows} />);
    rerender(<VirtualTree rows={rows} revealIndex={900} />);

    await waitFor(() => expect(document.querySelector('[data-path="Root/Node-900"]')).toBeTruthy());
  });

  it('scrolls before moving aria-activedescendant to a mounted keyboard target', async () => {
    const rows = flattenVisibleTree(
      Array.from({ length: 500 }, (_, index) => leaf(`Root/Node-${index}`)),
      new Set(),
    );
    render(<VirtualTree rows={rows} initialActive="Root/Node-499" />);
    const tree = screen.getByRole('tree');
    expect(tree.hasAttribute('aria-activedescendant')).toBe(false);

    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    await waitFor(() => expect(tree.getAttribute('aria-activedescendant')).toBe(rowDomId('Root/Node-499')));
    expect(document.getElementById(rowDomId('Root/Node-499'))).toBeTruthy();
  });

  it('removes aria-activedescendant for an externally selected unmounted row', async () => {
    const rows = flattenVisibleTree(
      Array.from({ length: 500 }, (_, index) => leaf(`Root/Node-${index}`)),
      new Set(),
    );
    render(<VirtualTree rows={rows} initialActive="Root/Node-499" />);
    await waitFor(() => expect(screen.getAllByRole('treeitem').length).toBeGreaterThan(0));
    expect(screen.getByRole('tree').hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('passes shift-click modifiers so the caller can select a visible contiguous range', () => {
    const onSelect = vi.fn();
    const row = flattenVisibleTree([leaf('Root/A')], new Set())[0];
    render(
      <TreeNodeRow
        row={row}
        selectedPaths={new Set()}
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
    expect(onSelect).toHaveBeenCalledWith('Root/A', { shift: true, toggle: false });
  });

  it('maps flattened depth and sibling metadata onto ARIA treeitem attributes', () => {
    const nested: TreeNode = {
      ...leaf('Root/Parent'),
      children: [leaf('Root/Parent/A'), leaf('Root/Parent/B')],
    };
    const row = flattenVisibleTree([nested], new Set(['Root/Parent']))[2];
    render(
      <TreeNodeRow
        row={row}
        selectedPaths={new Set()}
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
    expect(item.getAttribute('aria-level')).toBe('2');
    expect(item.getAttribute('aria-posinset')).toBe('2');
    expect(item.getAttribute('aria-setsize')).toBe('2');
  });

  it('uses stable row keys when visible descendants are inserted above the viewport', () => {
    const beforeTree: TreeNode[] = [
      { ...leaf('Root/A'), children: [leaf('Root/A/A1')] },
      leaf('Root/B'),
    ];
    const collapsed = flattenVisibleTree(beforeTree, new Set());
    const expanded = flattenVisibleTree(beforeTree, new Set(['Root/A']));

    expect(expanded.find((row) => row.node.path === 'Root/B')?.rowKey)
      .toBe(collapsed.find((row) => row.node.path === 'Root/B')?.rowKey);
  });

  it('resolves one shared fine/coarse row height contract for tree and flat rows', () => {
    const fine = resolvePointerRowHeight(() => ({ matches: false }));
    const coarse = resolvePointerRowHeight(() => ({ matches: true }));
    expect(fine).toBe(ROW_HEIGHT_FINE);
    expect(coarse).toBe(ROW_HEIGHT_COARSE);

    const row = flattenVisibleTree([leaf('Root/Tree')], new Set())[0];
    const { rerender } = render(
      <TreeNodeRow
        row={row}
        selectedPaths={new Set()}
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
        info={{ path: 'Root/Flat', types: [] }}
        selectedPaths={new Set()}
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
    render(
      <FlatNodeRow
        info={{ path: 'Root/Signal', types: ['PLCOutputBool'] }}
        selectedPaths={new Set()}
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
