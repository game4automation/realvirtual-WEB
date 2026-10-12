// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-505 §9.2 — the baked-geometry fold row.
 *
 * A boundary's direct chunk meshes render behind ONE display-only row,
 * "Geometry · N chunks · M tris", after the boundary's real children. The row
 * is the one documented exception to "a row IS an Object3D": no object, no
 * path, not selectable; a click toggles it. Its key hangs on the boundary's
 * uuid, so it survives a re-bake (R8).
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D, Scene } from 'three';
// Production capability registration (side effect) the category counts read.
import '../src/core/engine/rv-drive';
import { BAKED_EYE_REASON, TreeNodeRow } from '../src/core/hmi/HierarchyNodeRow';
import {
  chunkFoldKey,
  collectTypeCounts,
  collectTypeRows,
  flattenSceneRows,
  isChunkFoldRow,
  structuralListenTargets,
  type ChunkFoldRow,
  type SceneRowContext,
  type SceneTreeNode,
} from '../src/core/hmi/hierarchy-rows';
import type { VisibleTreeRow } from '../src/core/hmi/hierarchy-utils';

afterEach(cleanup);

const noop = () => {};

function chunkMesh(name: string): Mesh {
  const m = new Mesh(new BoxGeometry(), new MeshBasicMaterial());   // 12 triangles
  m.name = name;
  m.userData._rvBakeChunk = true;
  return m;
}

/** Scene ▸ Machine (boundary: 3 chunks + a Mover) ▸ Mover; Machine ▸ Covers (partition object, 2 chunks). */
function makeScene() {
  const scene = new Scene();
  const machine = new Group(); machine.name = 'Machine';
  const mover = new Group(); mover.name = 'Mover'; mover.userData.realvirtual = { Drive: {} };
  const chunks = [chunkMesh('static'), chunkMesh('tex:a'), chunkMesh('tex:b')];
  // Chunks first in the graph: the fold still comes AFTER the real children.
  machine.add(...chunks, mover);
  scene.add(machine);

  const paths = new Map<Object3D, string>([[machine, 'Machine'], [mover, 'Machine/Mover']]);
  const ctx: SceneRowContext = {
    getPathForNode: (n) => paths.get(n) ?? null,
    overlay: null,
    modelRoot: machine,
    hideRuntime: false,
  };
  return { scene, machine, mover, chunks, ctx, paths };
}

function names(rows: VisibleTreeRow[]): string[] {
  return rows.map((r) => r.node.displayLabel ?? r.node.name);
}

describe('fold row insertion (plan-505 §9.2)', () => {
  it('renders [Boundary, Mover, Fold]; the fold opens to the chunks at boundary depth + 2', () => {
    const s = makeScene();
    let rows = flattenSceneRows(s.scene, new Set([s.scene.uuid, s.machine.uuid]), s.ctx);
    expect(names(rows)).toEqual(['Scene', 'Machine', 'Mover', 'Geometry · 3 chunks · 36 tris']);
    const fold = rows[3];
    expect(isChunkFoldRow(fold.node)).toBe(true);
    expect(fold.node.hasChildren).toBe(true);
    expect(fold.node.path).toBeNull();
    expect(fold.rowKey).toBe(chunkFoldKey(s.machine));
    const machineDepth = rows[1].depth;
    expect(fold.depth).toBe(machineDepth + 1);
    // ARIA siblings count the fold row with the Mover.
    expect(fold.posInSet).toBe(2);
    expect(fold.setSize).toBe(2);

    rows = flattenSceneRows(s.scene, new Set([s.scene.uuid, s.machine.uuid, chunkFoldKey(s.machine)]), s.ctx);
    const chunkRows = rows.filter((r) => (r.node as Partial<SceneTreeNode>).chunk === true);
    expect(chunkRows.map((r) => (r.node as SceneTreeNode).object)).toEqual(s.chunks);
    for (const r of chunkRows) {
      expect(r.depth).toBe(machineDepth + 2);
      expect(r.rowKey).toBe((r.node as SceneTreeNode).object.uuid);
      expect(r.node.displayLabel).toBe('Chunk · 12 tris');
    }
  });

  it('emits a fold row for a single chunk too (consistent shape across models)', () => {
    const scene = new Scene();
    const root = new Group(); root.name = 'Root';
    root.add(chunkMesh('static'));
    scene.add(root);
    const ctx: SceneRowContext = { getPathForNode: () => null, overlay: null, modelRoot: null, hideRuntime: false };
    const rows = flattenSceneRows(scene, new Set([scene.uuid, root.uuid]), ctx);
    expect(names(rows)).toEqual(['Scene', 'Root', 'Geometry · 1 chunk · 12 tris']);
  });

  it('keeps the fold key stable across a re-bake of the same boundary (R8)', () => {
    const s = makeScene();
    const expanded = new Set([s.scene.uuid, s.machine.uuid]);
    const before = flattenSceneRows(s.scene, expanded, s.ctx).find((r) => isChunkFoldRow(r.node))!;
    // A re-bake replaces every chunk mesh; the boundary survives.
    for (const c of s.chunks) s.machine.remove(c);
    s.machine.add(chunkMesh('static'), chunkMesh('tex:c'));
    const after = flattenSceneRows(s.scene, expanded, s.ctx).find((r) => isChunkFoldRow(r.node))!;
    expect(after.rowKey).toBe(before.rowKey);
    expect((after.node as ChunkFoldRow).expandKey).toBe(`${s.machine.uuid}::baked`);
    expect(after.node.displayLabel).toBe('Geometry · 2 chunks · 24 tris');
  });

  it('gives a plan-755 partition object its own fold row', () => {
    const s = makeScene();
    const covers = new Group(); covers.name = 'Covers';
    covers.userData._rvSynthetic = true;
    const partChunks = [chunkMesh('grp:Covers'), chunkMesh('grp:Covers|tex:x')];
    covers.add(...partChunks);
    s.machine.add(covers);
    const rows = flattenSceneRows(s.scene, new Set([s.scene.uuid, s.machine.uuid, covers.uuid]), s.ctx);
    const folds = rows.filter((r) => isChunkFoldRow(r.node));
    expect(folds.map((r) => (r.node as ChunkFoldRow).boundary)).toEqual([covers, s.machine]);
    expect(folds[0].node.displayLabel).toBe('Geometry · 2 chunks · 24 tris');
  });

  it('structuralListenTargets skips fold rows and never throws', () => {
    const s = makeScene();
    const rows = flattenSceneRows(s.scene, new Set([s.scene.uuid, s.machine.uuid, chunkFoldKey(s.machine)]), s.ctx);
    const folds = rows.filter((r) => isChunkFoldRow(r.node)).length;
    expect(folds).toBe(1);
    let targets: Object3D[] = [];
    expect(() => { targets = structuralListenTargets(rows); }).not.toThrow();
    expect(targets).toHaveLength(rows.length - folds);
    expect(targets.every((t) => t instanceof Object3D)).toBe(true);
  });

  it('leaves collectTypeCounts / collectTypeRows as they were (no fold entry)', () => {
    const s = makeScene();
    const counts = collectTypeCounts(s.scene, s.ctx);
    // Scene, Machine, 3 chunks, Mover — chunks count like before, no fold row.
    expect(counts.total).toBe(6);
    expect(counts.bakedHidden).toBe(0);
    expect(counts.byCategory.get('drives')).toBe(1);
    expect(collectTypeRows(s.scene, 'all', s.ctx).map((r) => r.name)).toEqual(['Mover']);
  });
});

describe('fold row and chunk row rendering (plan-505 F3/F4)', () => {
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
        rowHeight={22}
        virtualStyle={{}}
        {...overrides}
      />,
    );
  }

  function rowsOf() {
    const s = makeScene();
    const rows = flattenSceneRows(s.scene, new Set([s.scene.uuid, s.machine.uuid, chunkFoldKey(s.machine)]), s.ctx);
    return {
      fold: rows.find((r) => isChunkFoldRow(r.node))!,
      chunk: rows.find((r) => (r.node as Partial<SceneTreeNode>).chunk === true)!,
    };
  }

  it('a click on the fold row toggles it and never selects', () => {
    const { fold } = rowsOf();
    const onToggleExpand = vi.fn();
    const onSelect = vi.fn();
    renderRow(fold, { onToggleExpand, onSelect });
    const item = screen.getByRole('treeitem');
    item.click();
    expect(onToggleExpand).toHaveBeenCalledWith(fold.rowKey);
    expect(onSelect).not.toHaveBeenCalled();
    expect(item.getAttribute('aria-expanded')).toBe('false');
    expect(item.getAttribute('aria-selected')).toBeNull();
    expect(screen.getByText('baked')).toBeTruthy();
  });

  it('Enter and Space on the fold row toggle it', () => {
    const { fold } = rowsOf();
    const onToggleExpand = vi.fn();
    renderRow(fold, { onToggleExpand });
    const item = screen.getByRole('treeitem');
    fireEvent.keyDown(item, { key: 'Enter' });
    fireEvent.keyDown(item, { key: ' ' });
    expect(onToggleExpand).toHaveBeenCalledTimes(2);
  });

  it('the fold row has no context menu and is no drag target', () => {
    const { fold } = rowsOf();
    const onContextMenu = vi.fn();
    const onRowDragOver = vi.fn();
    renderRow(fold, { onContextMenu, dndEnabled: true, onRowDragOver });
    const item = screen.getByRole('treeitem');
    fireEvent.contextMenu(item);
    fireEvent.dragOver(item);
    expect(onContextMenu).not.toHaveBeenCalled();
    expect(onRowDragOver).not.toHaveBeenCalled();
    expect(item.getAttribute('draggable')).toBeNull();
  });

  it('fold row and chunk row show a DISABLED eye with the baked reason', () => {
    const { fold, chunk } = rowsOf();
    for (const row of [fold, chunk]) {
      const onToggleVisible = vi.fn();
      const { container } = renderRow(row, {
        getNodeVisible: () => true,
        onToggleVisible,
        eyeDisabledReason: () => null,   // the old chunk eye was active (a silent no-op)
      });
      const eye = screen.getByLabelText('Hide');
      expect(eye.hasAttribute('disabled')).toBe(true);
      const wrap = container.querySelector('.rv-eye-toggle-wrap');
      expect(wrap?.getAttribute('aria-label')).toBe(BAKED_EYE_REASON);
      eye.click();
      expect(onToggleVisible).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it('a chunk row still selects its mesh', () => {
    const { chunk } = rowsOf();
    const onSelect = vi.fn();
    renderRow(chunk, { onSelect });
    screen.getByRole('treeitem').click();
    expect((onSelect.mock.calls[0][0] as SceneTreeNode).object).toBe((chunk.node as SceneTreeNode).object);
    expect(screen.getByText('chunk')).toBeTruthy();
  });
});
