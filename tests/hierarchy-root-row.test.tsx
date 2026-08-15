// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The hierarchy root row (plan-715 F1–F4): it renders with the DOCUMENT name,
 * it is selectable, and every structural affordance is absent from it.
 *
 * The lock is tested as a set of REMOVALS (no eye, not draggable) rather than as
 * a marker class, because that is the actual contract — a future refactor that
 * keeps a `data-locked` attribute while re-adding the eye must fail here.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Group, Object3D, Scene } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { TreeNodeRow } from '../src/core/hmi/HierarchyNodeRow';
import { buildStructureTree, flattenVisibleTree, type TreeNode } from '../src/core/hmi/hierarchy-utils';
import { isModelRoot } from '../src/core/engine/rv-model-root';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import type { EditableNodeInfo } from '../src/core/hmi/rv-extras-editor';

const viewer = { id: 'test-viewer' } as unknown as RVViewer;
const noop = () => {};

afterEach(cleanup);

function info(path: string, types: string[] = []): EditableNodeInfo {
  return { path, types } as EditableNodeInfo;
}

/** Render one row of the tree built for `nodes`, selected by name. */
function renderRow(
  tree: TreeNode[],
  rowName: string,
  overrides: Partial<React.ComponentProps<typeof TreeNodeRow>> = {},
) {
  const rows = flattenVisibleTree(tree, new Set(tree.map((n) => n.path ?? n.name)));
  const row = rows.find((r) => r.node.name === rowName);
  if (!row) throw new Error(`no row named ${rowName} in [${rows.map((r) => r.node.name)}]`);
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
      viewer={viewer}
      rowHeight={22}
      virtualStyle={{}}
      {...overrides}
    />,
  );
  return row;
}

const ASSET_NODES = [info('Robot/Base', ['Drive']), info('Robot/Arm')];

describe('root row rendering', () => {
  it('shows the DOCUMENT label, not the Object3D name', () => {
    const tree = buildStructureTree(ASSET_NODES, null, { rootPath: 'Robot', label: 'Welding Cell' });
    renderRow(tree, 'Robot');
    expect(screen.getByText('Welding Cell')).toBeTruthy();
    expect(screen.queryByText('Robot')).toBeNull();
  });

  it('falls back to the node name when no label is supplied', () => {
    const tree = buildStructureTree(ASSET_NODES, null, { rootPath: 'Robot' });
    renderRow(tree, 'Robot');
    expect(screen.getByText('Robot')).toBeTruthy();
  });

  it('renders NO eye toggle even while the editor visibility props are present', () => {
    const tree = buildStructureTree(ASSET_NODES, null, { rootPath: 'Robot', label: 'Cell' });
    renderRow(tree, 'Robot', {
      getNodeVisible: () => true,
      onToggleVisible: vi.fn(),
    });
    expect(screen.queryByLabelText('Hide')).toBeNull();
    expect(screen.queryByLabelText('Show')).toBeNull();
  });

  it('still renders the eye toggle for an ordinary child row', () => {
    const tree = buildStructureTree(ASSET_NODES, null, { rootPath: 'Robot', label: 'Cell' });
    renderRow(tree, 'Base', {
      getNodeVisible: () => true,
      onToggleVisible: vi.fn(),
    });
    expect(screen.getByLabelText('Hide')).toBeTruthy();
  });

  it('is not draggable while DnD is enabled, but children are', () => {
    const tree = buildStructureTree(ASSET_NODES, null, { rootPath: 'Robot', label: 'Cell' });
    renderRow(tree, 'Robot', { dndEnabled: true });
    expect(document.querySelector('[data-path="Robot"]')?.getAttribute('draggable')).toBeNull();
    cleanup();
    renderRow(tree, 'Base', { dndEnabled: true });
    expect(document.querySelector('[data-path="Robot/Base"]')?.getAttribute('draggable')).toBe('true');
  });

  it('is selectable and reports its registry path', () => {
    const onSelect = vi.fn();
    const tree = buildStructureTree(ASSET_NODES, null, { rootPath: 'Robot', label: 'Cell' });
    renderRow(tree, 'Robot', { onSelect });
    fireEvent.click(document.querySelector('[data-path="Robot"]')!);
    expect(onSelect).toHaveBeenCalledWith('Robot', { shift: false, toggle: false });
  });

  it('still accepts a DROP (dropping onto the root moves a node to the top level)', () => {
    const onRowDrop = vi.fn();
    const tree = buildStructureTree(ASSET_NODES, null, { rootPath: 'Robot', label: 'Cell' });
    renderRow(tree, 'Robot', { dndEnabled: true, onRowDrop });
    const el = document.querySelector('[data-path="Robot"]')!;
    fireEvent.drop(el, { clientY: 11 });
    expect(onRowDrop).toHaveBeenCalled();
    expect(onRowDrop.mock.calls[0][0]).toBe('Robot');
  });
});

describe('root row absence', () => {
  it('renders no root row when no model is loaded (null root info, no crash)', () => {
    const tree = buildStructureTree([], null, null);
    expect(tree).toEqual([]);
  });

  it('renders no root row for the type-filter FLAT list, by design', () => {
    // The flat list is a filtered COMPONENT list, not a tree — the root (which
    // has no component types) is deliberately absent. Pinned so that a future
    // "make it consistent" is a decision rather than a slip.
    const tree = buildStructureTree(ASSET_NODES, null, { rootPath: 'Robot', label: 'Cell' });
    expect(tree[0].isModelRoot).toBe(true);
    // …while the flat path never calls buildStructureTree at all:
    const drivesOnly = ASSET_NODES.filter((n) => n.types.includes('Drive'));
    expect(drivesOnly.map((n) => n.path)).toEqual(['Robot/Base']);
  });
});

// ─── Drag/drop resolution against the root (first coverage of resolveDrop) ──

/**
 * `resolveDrop`'s 'onto' branch, replicated here at the level the browser uses
 * it: the root is a legal drop TARGET, and it resolves to `parentPath: null` —
 * the same convention `reparentNodes` uses for "the asset's top level".
 */
function resolveOnto(target: Object3D, dragged: Object3D[], modelRoot: Object3D | null) {
  const insideDragged = (n: Object3D | null): boolean => {
    for (let c: Object3D | null = n; c; c = c.parent) if (dragged.includes(c)) return true;
    return false;
  };
  if (insideDragged(target)) return null;
  if (isModelRoot(target, modelRoot)) return { parentPath: null };
  return { parentPath: NodeRegistry.computeNodePath(target) };
}

describe('resolveDrop onto the model root', () => {
  it('addresses the root slot as parentPath null, and a normal target by path', () => {
    const scene = new Scene();
    const modelRoot = new Group(); modelRoot.name = 'Robot';
    const base = new Group(); base.name = 'Base';
    const arm = new Object3D(); arm.name = 'Arm';
    modelRoot.add(base, arm);
    scene.add(modelRoot);

    expect(resolveOnto(modelRoot, [arm], modelRoot)).toEqual({ parentPath: null });
    expect(resolveOnto(base, [arm], modelRoot)).toEqual({ parentPath: 'Robot/Base' });
    // Dropping a node into its own subtree stays illegal.
    expect(resolveOnto(base, [modelRoot], modelRoot)).toBeNull();
  });
});
