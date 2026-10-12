// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-754 §9.10 — the `runtime` badge and its toggle (D2).
 *
 * "Runtime" has exactly one definition: the `NodeRegistry` does not know this
 * node. That replaces five partial predicates (gizmo markers, ghost overlays,
 * bake chunks, helper names, `__rvAdded`) with the registry, which IS the
 * document's address book. Everything downstream follows from it: no eye, no
 * drag, no context menu, and the toolbar can hide them.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D, Scene } from 'three';
import { TreeNodeRow } from '../src/core/hmi/HierarchyNodeRow';
import { flattenSceneRows, type SceneRowContext, type SceneTreeNode } from '../src/core/hmi/hierarchy-rows';

afterEach(cleanup);

const noop = () => {};

/** Scene ▸ Cell (registered, model root) ▸ Drive; plus an unregistered helper. */
function makeScene(hideRuntime = false) {
  const scene = new Scene();
  const cell = new Group(); cell.name = 'Cell';
  const drive = new Group(); drive.name = 'Axis'; drive.userData.realvirtual = { Drive: {} };
  const driveMesh = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  driveMesh.name = 'AxisMesh';
  drive.add(driveMesh);
  const helper = new Object3D(); helper.name = 'GridHelper';
  cell.add(drive);
  scene.add(cell, helper);

  const paths = new Map<Object3D, string>([
    [cell, 'Cell'], [drive, 'Cell/Axis'], [driveMesh, 'Cell/Axis/AxisMesh'],
  ]);
  const ctx: SceneRowContext = {
    getPathForNode: (n) => paths.get(n) ?? null,
    overlay: null,
    modelRoot: cell,
    modelRootLabel: 'Welding Cell',
    hideRuntime,
  };
  const expanded = new Set<string>();
  scene.traverse((n) => expanded.add(n.uuid));
  return { scene, cell, drive, driveMesh, helper, ctx, expanded };
}

function rows(s: ReturnType<typeof makeScene>): SceneTreeNode[] {
  return flattenSceneRows(s.scene, s.expanded, s.ctx).map((r) => r.node as SceneTreeNode);
}

function renderRow(node: SceneTreeNode, overrides: Partial<React.ComponentProps<typeof TreeNodeRow>> = {}) {
  render(
    <TreeNodeRow
      row={{ node, depth: 0, rowKey: node.object.uuid, posInSet: 1, setSize: 1 }}
      expanded={new Set()}
      onToggleExpand={noop}
      onSelect={noop}
      onDoubleClick={noop}
      onHover={noop}
      signalStore={null}
      logicEngine={null}
      rowHeight={22}
      virtualStyle={{}}
      {...overrides}
    />,
  );
}

describe('runtime rows (§9.10)', () => {
  it('flags an unregistered node as runtime and a registered one as not', () => {
    const s = makeScene();
    const byName = new Map(rows(s).map((r) => [r.name, r]));
    expect(byName.get('GridHelper')!.runtime).toBe(true);
    expect(byName.get('GridHelper')!.path).toBeNull();
    expect(byName.get('Axis')!.runtime).toBe(false);
    expect(byName.get('Axis')!.path).toBe('Cell/Axis');
    // The scene root itself is unregistered too — it is a runtime row (D1).
    expect(byName.get('Scene')!.runtime).toBe(true);
  });

  it('renders the runtime badge, and none on a document row', () => {
    const s = makeScene();
    const byName = new Map(rows(s).map((r) => [r.name, r]));
    renderRow(byName.get('GridHelper')!);
    expect(screen.getByText('runtime')).toBeTruthy();
    cleanup();
    renderRow(byName.get('Axis')!);
    expect(screen.queryByText('runtime')).toBeNull();
  });

  it('a runtime row is read-only: no eye, no drag handle, no context menu', () => {
    const s = makeScene();
    const helperRow = rows(s).find((r) => r.name === 'GridHelper')!;
    const onContextMenu = vi.fn();
    renderRow(helperRow, {
      getNodeVisible: () => true,
      onToggleVisible: vi.fn(),
      dndEnabled: true,
      onContextMenu,
    });
    expect(screen.queryByLabelText('Hide')).toBeNull();
    expect(screen.queryByLabelText('Show')).toBeNull();
    expect(screen.getByRole('treeitem').getAttribute('draggable')).toBeNull();
    expect(screen.getByRole('treeitem').getAttribute('data-runtime')).toBe('true');
  });

  it('the toggle hides runtime rows and only those', () => {
    const shown = rows(makeScene(false)).map((r) => r.name);
    const hidden = rows(makeScene(true)).map((r) => r.name);
    expect(shown).toContain('GridHelper');
    expect(hidden).not.toContain('GridHelper');
    // The document's own rows are untouched.
    expect(hidden).toEqual(expect.arrayContaining(['Cell', 'Axis', 'AxisMesh']));
  });

  it('hiding runtime rows also removes the scene root, so the document leads', () => {
    const hidden = rows(makeScene(true));
    expect(hidden[0].name).toBe('Scene');   // the ROOT row always renders…
    expect(hidden.slice(1).some((r) => r.runtime)).toBe(false); // …nothing below it does
  });

  it('leaves the model-root label and lock exactly as they were (plan-715)', () => {
    const s = makeScene();
    const rootRow = rows(s).find((r) => r.object === s.cell)!;
    expect(rootRow.isModelRoot).toBe(true);
    expect(rootRow.displayLabel).toBe('Welding Cell');
    renderRow(rootRow, { getNodeVisible: () => true, onToggleVisible: vi.fn(), dndEnabled: true });
    expect(screen.getByText('Welding Cell')).toBeTruthy();
    expect(screen.queryByLabelText('Hide')).toBeNull();
    expect(screen.getByRole('treeitem').getAttribute('draggable')).toBeNull();
  });
});
