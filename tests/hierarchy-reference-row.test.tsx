// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * A node carrying an `AssetReference` gets a leading link glyph in the
 * hierarchy. The row adapter flags it (never the model root, never a plain
 * node), and the tree row renders the glyph only for flagged rows.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Group, Object3D, Scene } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { TreeNodeRow, OPEN_REFERENCE_TITLE } from '../src/core/hmi/HierarchyNodeRow';
import { referencedDocumentId } from '../src/core/hmi/hierarchy-reference-open';
import type { RvProject } from '../src/core/project/rv-project-types';
import { flattenSceneRows, type SceneRowContext } from '../src/core/hmi/hierarchy-rows';
import type { VisibleTreeRow } from '../src/core/hmi/hierarchy-utils';

const viewer = { id: 'test-viewer' } as unknown as RVViewer;
const noop = () => {};

afterEach(cleanup);

function makeScene() {
  const scene = new Scene();
  const root = new Group(); root.name = 'Layout';
  const machine = new Group(); machine.name = 'Machine_1';
  machine.userData.realvirtual = { AssetReference: { uri: 'library/machine.glb' } };
  const placed = new Group(); placed.name = 'Placed_1';
  placed.userData._layoutId = 'p1';
  const plain = new Object3D(); plain.name = 'Plain';
  root.add(machine, placed, plain);
  scene.add(root);
  const paths = new Map<Object3D, string>([
    [root, 'Layout'], [machine, 'Layout/Machine_1'], [placed, 'Layout/Placed_1'], [plain, 'Layout/Plain'],
  ]);
  const ctx: SceneRowContext = {
    getPathForNode: (n) => paths.get(n) ?? null,
    overlay: null,
    modelRoot: root,
    hideRuntime: false,
  };
  const expanded = new Set<string>([scene.uuid, root.uuid]);
  return { scene, ctx, expanded };
}

function rowNamed(name: string): VisibleTreeRow {
  const s = makeScene();
  const row = flattenSceneRows(s.scene, s.expanded, s.ctx).find((r) => r.node.name === name);
  if (!row) throw new Error(`no row named ${name}`);
  return row;
}

function renderRow(row: VisibleTreeRow) {
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
    />,
  );
}

describe('hierarchy reference row', () => {
  it('flags only the AssetReference node', () => {
    expect(rowNamed('Machine_1').node.reference).toBe(true);
    expect(rowNamed('Placed_1').node.reference).toBe(true);
    expect(rowNamed('Plain').node.reference).toBeUndefined();
    expect(rowNamed('Layout').node.reference).toBeUndefined();
  });

  it('renders the link glyph for a reference row only', () => {
    renderRow(rowNamed('Machine_1'));
    expect(screen.getByTestId('hierarchy-reference-glyph')).toBeTruthy();
    cleanup();
    renderRow(rowNamed('Plain'));
    expect(screen.queryByTestId('hierarchy-reference-glyph')).toBeNull();
  });
});

describe('hierarchy reference open', () => {
  const project = {
    documents: [
      { id: 'doc_mhm_1', path: 'mhm.glb', name: 'mhm' },
      { id: 'doc_side_2', path: 'sub/side.glb', name: 'side' },
    ],
  } as unknown as RvProject;

  function node(rv: Record<string, unknown>): Object3D {
    const o = new Object3D();
    o.userData.realvirtual = rv;
    return o;
  }

  it('resolves a project: asset id through the manifest path', () => {
    expect(referencedDocumentId(node({ AssetReference: { assetId: 'project:mhm.glb' } }), project)).toBe('doc_mhm_1');
    expect(referencedDocumentId(node({ AssetReference: { assetId: 'project:sub/side.glb' } }), project)).toBe('doc_side_2');
  });

  it('falls back to LayoutObject.CatalogId and to a plain document id', () => {
    expect(referencedDocumentId(node({ LayoutObject: { CatalogId: 'project:mhm.glb' } }), project)).toBe('doc_mhm_1');
    expect(referencedDocumentId(node({ AssetReference: { assetId: 'doc_side_2' } }), project)).toBe('doc_side_2');
  });

  it('answers null for an asset that is not a project document', () => {
    expect(referencedDocumentId(node({ AssetReference: { assetId: 'realvirtual-library-x-glb' } }), project)).toBeNull();
    expect(referencedDocumentId(node({ AssetReference: { assetId: 'project:missing.glb' } }), project)).toBeNull();
    expect(referencedDocumentId(node({}), project)).toBeNull();
  });

  it('the glyph is a button that calls onOpenReference without selecting the row', () => {
    const onOpen = vi.fn();
    const onSelect = vi.fn();
    render(
      <TreeNodeRow
        row={rowNamed('Machine_1')}
        expanded={new Set()}
        onToggleExpand={noop}
        onSelect={onSelect}
        onDoubleClick={noop}
        onHover={noop}
        signalStore={null}
        logicEngine={null}
        viewer={viewer}
        rowHeight={22}
        virtualStyle={{}}
        onOpenReference={onOpen}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: OPEN_REFERENCE_TITLE }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][0].name).toBe('Machine_1');
    expect(onSelect).not.toHaveBeenCalled();
  });
});
