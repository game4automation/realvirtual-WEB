// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * A locked placement (`LayoutObject.Locked`) is VISIBLE in the hierarchy.
 *
 * Before this the lock was only in the context menu's verb ("Lock" / "Unlock")
 * and the inspector; the tree gave no cue. Contract:
 *
 *  1. the row adapter flags the placement root, and only it — never a child of
 *     the placement, never an unlocked placement, never a non-placement;
 *  2. the row renders a lock glyph that unlocks on click (same handler route
 *     as the context menu: one overlay field);
 *  3. the row loses its drag source, but keeps the eye — hiding a locked
 *     machine is viewing, not editing.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Group, Object3D, Scene } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { TreeNodeRow, LOCKED_ROW_TITLE } from '../src/core/hmi/HierarchyNodeRow';
import { flattenSceneRows, type SceneRowContext } from '../src/core/hmi/hierarchy-rows';
import type { TreeNode, VisibleTreeRow } from '../src/core/hmi/hierarchy-utils';

const viewer = { id: 'test-viewer' } as unknown as RVViewer;
const noop = () => {};

afterEach(cleanup);

/** Layout root with two placements: `Cell_1` locked, `Cell_2` not. Each has a
 *  Drive child, so a locked placement's child is exercised too. */
function makeLayout() {
  const scene = new Scene();
  const root = new Group(); root.name = 'Layout';
  const cell1 = new Group(); cell1.name = 'Cell_1';
  cell1.userData.realvirtual = { LayoutObject: { Label: 'Cell 1', CatalogId: 'x', Locked: true } };
  const drive1 = new Object3D(); drive1.name = 'Axis';
  drive1.userData.realvirtual = { Drive: {} };
  cell1.add(drive1);
  const cell2 = new Group(); cell2.name = 'Cell_2';
  cell2.userData.realvirtual = { LayoutObject: { Label: 'Cell 2', CatalogId: 'x', Locked: false } };
  const plain = new Object3D(); plain.name = 'Plain';
  root.add(cell1, cell2, plain);
  scene.add(root);

  const paths = new Map<Object3D, string>([
    [root, 'Layout'], [cell1, 'Layout/Cell_1'], [drive1, 'Layout/Cell_1/Axis'],
    [cell2, 'Layout/Cell_2'], [plain, 'Layout/Plain'],
  ]);
  const ctx: SceneRowContext = {
    getPathForNode: (n) => paths.get(n) ?? null,
    overlay: null,
    modelRoot: root,
    hideRuntime: false,
  };
  const expanded = new Set<string>([scene.uuid, root.uuid, cell1.uuid]);
  return { scene, root, cell1, drive1, cell2, plain, ctx, expanded };
}

function rowNamed(layout: ReturnType<typeof makeLayout>, name: string): VisibleTreeRow {
  const rows = flattenSceneRows(layout.scene, layout.expanded, layout.ctx);
  const row = rows.find((r) => r.node.name === name);
  if (!row) throw new Error(`no row named ${name} in [${rows.map((r) => r.node.name)}]`);
  return row;
}

function renderRow(row: VisibleTreeRow, overrides: Partial<React.ComponentProps<typeof TreeNodeRow>> = {}) {
  return render(
    <TreeNodeRow
      row={row}
      expanded={new Set()}
      onToggleExpand={noop}
      onSelect={noop}
      onDoubleClick={noop}
      onHover={noop}
      signalStore={null}
      logicEngine={null}
      viewer={viewer}
      rowHeight={22}
      virtualStyle={{}}
      {...overrides}
    />,
  );
}

describe('row adapter: locked flag', () => {
  it('flags the locked placement root and nothing else', () => {
    const layout = makeLayout();
    expect(rowNamed(layout, 'Cell_1').node.locked).toBe(true);
    expect(rowNamed(layout, 'Axis').node.locked).toBeUndefined();   // child of a locked placement
    expect(rowNamed(layout, 'Cell_2').node.locked).toBeUndefined(); // Locked: false
    expect(rowNamed(layout, 'Plain').node.locked).toBeUndefined();  // no LayoutObject
    expect(rowNamed(layout, 'Layout').node.locked).toBeUndefined(); // model root
  });

  it('follows the live userData, so an unlock refreshes the flag on the next flatten', () => {
    const layout = makeLayout();
    (layout.cell1.userData.realvirtual as { LayoutObject: { Locked: boolean } }).LayoutObject.Locked = false;
    expect(rowNamed(layout, 'Cell_1').node.locked).toBeUndefined();
  });
});

describe('locked row rendering', () => {
  it('renders a lock glyph that unlocks THIS row on click, without selecting it', () => {
    const layout = makeLayout();
    const onUnlock = vi.fn<(node: TreeNode) => void>();
    const onSelect = vi.fn();
    renderRow(rowNamed(layout, 'Cell_1'), { onUnlock, onSelect });

    const lock = screen.getByRole('button', { name: 'Unlock' });
    expect(lock.getAttribute('data-locked')).toBe('true');
    expect(lock.getAttribute('aria-label')).toBe('Unlock');
    fireEvent.click(lock);
    expect(onUnlock).toHaveBeenCalledTimes(1);
    expect(onUnlock.mock.calls[0][0].path).toBe('Layout/Cell_1');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('shows the glyph as a plain indicator when no unlock handler is passed', () => {
    const layout = makeLayout();
    renderRow(rowNamed(layout, 'Cell_1'));
    expect(screen.getByRole('button', { name: 'Locked' })).toBeTruthy();
  });

  it('renders no glyph on an unlocked placement or on a child of a locked one', () => {
    const layout = makeLayout();
    renderRow(rowNamed(layout, 'Cell_2'), { onUnlock: noop });
    renderRow(rowNamed(layout, 'Axis'), { onUnlock: noop });
    expect(screen.queryByRole('button', { name: 'Unlock' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Locked' })).toBeNull();
  });

  it('drops the drag source but keeps the eye', () => {
    const layout = makeLayout();
    const onToggleVisible = vi.fn();
    const { container } = renderRow(rowNamed(layout, 'Cell_1'), {
      onUnlock: noop,
      dndEnabled: true,
      onRowDragStart: noop,
      getNodeVisible: () => true,
      onToggleVisible,
    });
    const rowEl = container.querySelector('[role="treeitem"]') ?? container.firstElementChild!;
    expect(rowEl.getAttribute('draggable')).toBeNull();

    const eye = screen.getByRole('button', { name: 'Hide' });
    fireEvent.click(eye);
    expect(onToggleVisible).toHaveBeenCalledTimes(1);
  });

  it('the unlocked sibling keeps its drag source under the same props', () => {
    const layout = makeLayout();
    const { container } = renderRow(rowNamed(layout, 'Cell_2'), {
      onUnlock: noop,
      dndEnabled: true,
      onRowDragStart: noop,
    });
    const rowEl = container.querySelector('[role="treeitem"]') ?? container.firstElementChild!;
    expect(rowEl.getAttribute('draggable')).toBe('true');
  });

  it('exports the tooltip text the glyph uses', () => {
    expect(LOCKED_ROW_TITLE).toMatch(/unlock/i);
  });
});
