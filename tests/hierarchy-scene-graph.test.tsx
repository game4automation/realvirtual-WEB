// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-754 §9.9 — the hierarchy IS the scene graph.
 *
 * One claim, tested from four sides: the rendered rows are exactly the objects
 * under `viewer.scene` that the user has opened (D1), chunk meshes are rows like
 * anything else, a nameless node still gets a legible label, and the row key is
 * the object identity — so a reparent moves a row instead of destroying it.
 *
 * plan-505 narrowed "chunk meshes are rows like anything else": they are still
 * real rows, but folded behind ONE display-only "Geometry · N chunks" row per
 * boundary, and labelled "kind + size" instead of by their boundary's name.
 */

import { describe, it, expect } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D, Scene } from 'three';
import {
  chunkFoldKey,
  flattenSceneRows,
  isChunkFoldRow,
  isChunkMesh,
  rowLabel,
  sceneRow,
  type SceneRowContext,
  type SceneTreeNode,
} from '../src/core/hmi/hierarchy-rows';
import { chunkRowLabel } from '../src/core/hmi/chunk-row-labels';

function makeCtx(paths: Map<Object3D, string>, hideRuntime = false): SceneRowContext {
  return {
    getPathForNode: (n) => paths.get(n) ?? null,
    overlay: null,
    modelRoot: null,
    hideRuntime,
  };
}

/** Scene ▸ Cell ▸ { Robot ▸ A1 ▸ [chunk], Lamp } plus an unregistered light. */
function makeCell() {
  const scene = new Scene();
  const cell = new Group(); cell.name = 'Cell';
  const robot = new Group(); robot.name = 'Robot';
  const a1 = new Group(); a1.name = 'A1'; a1.userData.realvirtual = { Drive: {} };
  const chunk = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  chunk.name = 'mover:Cell/Robot/A1|tex:abcdef';
  chunk.userData._rvBakeChunk = true;
  const lamp = new Group(); lamp.name = 'Lamp';
  const light = new Object3D();   // nameless + unregistered: a runtime object

  a1.add(chunk);
  robot.add(a1);
  cell.add(robot, lamp);
  scene.add(cell, light);

  const paths = new Map<Object3D, string>([
    [cell, 'Cell'], [robot, 'Cell/Robot'], [a1, 'Cell/Robot/A1'], [lamp, 'Cell/Lamp'],
  ]);
  return { scene, cell, robot, a1, chunk, lamp, light, paths };
}

describe('rows are the scene graph (§9.9)', () => {
  it('renders exactly the children of every EXPANDED object, recursively', () => {
    const s = makeCell();
    const ctx = makeCtx(s.paths);

    // Only the scene open: its two direct children, nothing deeper.
    let rows = flattenSceneRows(s.scene, new Set([s.scene.uuid]), ctx);
    expect(rows.map((r) => r.node.name)).toEqual(['Scene', 'Cell', 'Object3D']);

    // Open the cell: its children join, the robot's do not.
    rows = flattenSceneRows(s.scene, new Set([s.scene.uuid, s.cell.uuid]), ctx);
    expect(rows.map((r) => r.node.name)).toEqual(['Scene', 'Cell', 'Robot', 'Lamp', 'Object3D']);

    // All the way down — including the chunk mesh (D1), which sits behind its
    // boundary's fold row (plan-505): open the fold too.
    const all = new Set<string>();
    s.scene.traverse((n) => all.add(n.uuid));
    all.add(chunkFoldKey(s.a1));
    rows = flattenSceneRows(s.scene, all, ctx);
    const names: string[] = [];
    s.scene.traverse((n) => names.push(n.name || n.type));
    // Every object once, plus exactly one fold row.
    expect(rows).toHaveLength(names.length + 1);
    expect(rows.filter((r) => isChunkFoldRow(r.node))).toHaveLength(1);
    expect(rows.filter((r) => !isChunkFoldRow(r.node)).map((r) => (r.node as SceneTreeNode).object)).toEqual(
      (() => { const o: Object3D[] = []; s.scene.traverse((n) => o.push(n)); return o; })(),
    );
  });

  it('gives a chunk mesh a row, a chunk flag and a readable label', () => {
    const s = makeCell();
    const ctx = makeCtx(s.paths);
    const all = new Set<string>();
    s.scene.traverse((n) => all.add(n.uuid));
    all.add(chunkFoldKey(s.a1));

    const chunkRow = flattenSceneRows(s.scene, all, ctx)
      .map((r) => r.node as SceneTreeNode)
      .find((r) => r.object === s.chunk)!;
    expect(chunkRow).toBeDefined();
    expect(chunkRow.chunk).toBe(true);
    // "Kind + size" (plan-505): no boundary name, no chunk key. A fixture
    // without bake meta falls back to the geometry's triangle count.
    expect(chunkRow.displayLabel).toBe('Chunk · 12 tris');
    // The NAME is untouched — it is the pick/debug identity.
    expect(chunkRow.object.name).toBe('mover:Cell/Robot/A1|tex:abcdef');
    expect(isChunkMesh(s.chunk)).toBe(true);
  });

  it('labels a chunk by kind + size, never by its parent (no file-name leak)', () => {
    const root = new Group();
    root.name = 'MyFactory.glb';
    const chunk = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    chunk.userData._rvBakeChunk = true;
    root.add(chunk);
    expect(chunkRowLabel(chunk)).toBe('Chunk · 12 tris');
    expect(rowLabel(chunk)).not.toContain('MyFactory');
  });

  it('labels a nameless node by type + short uuid, and the scene as "Scene"', () => {
    const s = makeCell();
    expect(rowLabel(s.light)).toBe(`Object3D ${s.light.uuid.slice(0, 6)}`);
    expect(rowLabel(s.scene)).toBe('Scene');
  });

  it('keys rows on uuid, so a reparent moves the row instead of replacing it', () => {
    const s = makeCell();
    const ctx = makeCtx(s.paths);
    const all = () => { const set = new Set<string>(); s.scene.traverse((n) => set.add(n.uuid)); return set; };

    const before = flattenSceneRows(s.scene, all(), ctx).find((r) => r.rowKey === s.a1.uuid)!;
    expect(before.node.path).toBe('Cell/Robot/A1');

    // Move the axis out of the robot; the registry re-addresses it.
    s.lamp.add(s.a1);
    s.paths.set(s.a1, 'Cell/Lamp/A1');

    const after = flattenSceneRows(s.scene, all(), ctx).find((r) => r.rowKey === s.a1.uuid)!;
    expect(after.rowKey).toBe(before.rowKey);          // same virtualizer identity
    expect(after.node.path).toBe('Cell/Lamp/A1');      // new address
    expect((after.node as SceneTreeNode).object).toBe(s.a1);
  });

  it('a model with no components at all is still one root row plus its chunk (R14)', () => {
    // The raw-CAD case: the bake prunes everything unclaimed, so what is left is
    // the root and one static chunk. The panel must show that, not crash.
    const scene = new Scene();
    const root = new Group(); root.name = 'RawCAD';
    const chunk = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    chunk.name = 'static';
    chunk.userData._rvBakeChunk = true;
    root.add(chunk);
    scene.add(root);

    const ctx = makeCtx(new Map([[root, 'RawCAD']]));
    const rows = flattenSceneRows(scene, new Set([scene.uuid, root.uuid, chunkFoldKey(root)]), ctx);
    expect(rows.map((r) => r.node.displayLabel ?? r.node.name)).toEqual(
      ['Scene', 'RawCAD', 'Geometry · 1 chunk · 12 tris', 'Chunk · 12 tris'],
    );
    expect(rows.every((r) => r.node.types.length === 0)).toBe(true);
  });

  it('a single row is a few field reads — no traversal (hot-path contract)', () => {
    const s = makeCell();
    const ctx = makeCtx(s.paths);
    let lookups = 0;
    const counting: SceneRowContext = { ...ctx, getPathForNode: (n) => { lookups++; return ctx.getPathForNode(n); } };
    sceneRow(s.robot, counting);
    expect(lookups).toBe(1);
  });
});
