// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-754 §9.19 — flat type filters, counts and search, all from a scene walk.
 *
 * D11 dropped the planner's composition projection; the flat filters stay and
 * are fed by `userData.realvirtual` on the graph, deliberately NOT by
 * `NodeRegistry.typeIndex` — the panel shows the graph, and the graph is the one
 * thing that is also true for unregistered nodes.
 *
 * Also pinned here: the eye's disabled state on a merged row (D8), that a stale
 * PATH key in `rv-hierarchy-expanded` expands nothing, and that drag-reorder is
 * refused on a runtime row.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D, Scene } from 'three';
import { TreeNodeRow } from '../src/core/hmi/HierarchyNodeRow';
import {
  buildSceneSearchTree,
  collectTypeCounts,
  collectTypeRows,
  filterCount,
  flattenSceneRows,
  matchesSearchTerm,
  mergedBoundaryName,
  searchExpandKeys,
  subtreeHasDrawable,
  type SceneRowContext,
  type SceneTreeNode,
} from '../src/core/hmi/hierarchy-rows';
import { flattenVisibleTree } from '../src/core/hmi/hierarchy-utils';
// Production capability registrations (side effects) the category counts read.
import '../src/core/engine/rv-drive';
import '../src/core/engine/rv-sensor';
import '../src/core/engine/rv-transport-surface';

afterEach(cleanup);

const noop = () => {};

/**
 * Cell ▸ { Belt (Drive + TransportSurface, has a chunk mesh),
 *          Eye (Sensor), Flow (PLCOutputBool), Step (LogicStep_Delay),
 *          Info (RuntimeMetadata, merged — no drawable of its own) }
 * plus an unregistered helper.
 */
function makeCell(hideRuntime = false) {
  const scene = new Scene();
  const cell = new Group(); cell.name = 'Cell';

  const belt = new Group(); belt.name = 'Belt';
  belt.userData.realvirtual = { Drive: {}, TransportSurface: {} };
  const chunk = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  chunk.name = 'mover:Cell/Belt';
  chunk.userData._rvBakeChunk = true;
  belt.add(chunk);

  const eye = new Group(); eye.name = 'Eye'; eye.userData.realvirtual = { Sensor: {} };
  const flow = new Group(); flow.name = 'Occupied'; flow.userData.realvirtual = { PLCOutputBool: {} };
  const step = new Group(); step.name = 'Wait'; step.userData.realvirtual = { LogicStep_Delay: {} };
  const info = new Group(); info.name = 'Info'; info.userData.realvirtual = { RuntimeMetadata: {} };
  const helper = new Object3D(); helper.name = 'Helper';

  // The document's static chunk: where the triangles of every merged node below
  // the cell ended up — including `Info`'s, which is why its eye is disabled.
  const staticChunk = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  staticChunk.name = 'static';
  staticChunk.userData._rvBakeChunk = true;

  cell.add(staticChunk, belt, eye, flow, step, info);
  scene.add(cell, helper);

  const paths = new Map<Object3D, string>([
    [cell, 'Cell'], [belt, 'Cell/Belt'], [eye, 'Cell/Eye'],
    [flow, 'Cell/Occupied'], [step, 'Cell/Wait'], [info, 'Cell/Info'],
  ]);
  const ctx: SceneRowContext = {
    getPathForNode: (n) => paths.get(n) ?? null,
    overlay: null,
    modelRoot: cell,
    hideRuntime,
  };
  const expanded = new Set<string>();
  scene.traverse((n) => expanded.add(n.uuid));
  return { scene, cell, belt, chunk, staticChunk, eye, flow, step, info, helper, ctx, expanded, paths };
}

describe('flat type filters + counts (§9.19)', () => {
  it('counts every filter from the scene walk, "all" = every rendered row', () => {
    const s = makeCell();
    const counts = collectTypeCounts(s.scene, s.ctx);
    // Scene, Cell, static chunk, Belt, mover chunk, Eye, Occupied, Wait, Info, Helper
    expect(counts.total).toBe(10);
    expect(filterCount(counts, 'all')).toBe(10);
    expect(counts.byCategory.get('drives')).toBe(1);
    expect(counts.byCategory.get('transport')).toBe(1);
    expect(counts.byCategory.get('sensors')).toBe(1);
    expect(counts.byCategory.get('signals')).toBe(1);
    expect(counts.byCategory.get('logic')).toBe(1);
    expect(counts.byLabel.get('transport')?.get('Conveyors')).toBe(1);
    expect(counts.byLabel.get('logic')?.get('Delay')).toBe(1);
  });

  it('the runtime toggle changes the total, not the component counts', () => {
    const s = makeCell(true);
    const counts = collectTypeCounts(s.scene, s.ctx);
    expect(counts.total).toBe(8);   // Scene + Helper drop out
    expect(counts.runtimeHidden).toBe(2);
    expect(counts.byCategory.get('drives')).toBe(1);
  });

  it('collectTypeRows returns the matching rows in scene order', () => {
    const s = makeCell();
    expect(collectTypeRows(s.scene, 'cat:drives', s.ctx).map((r) => r.path)).toEqual(['Cell/Belt']);
    expect(collectTypeRows(s.scene, 'cat:signals', s.ctx).map((r) => r.path)).toEqual(['Cell/Occupied']);
    expect(collectTypeRows(s.scene, 'cat:transport/Conveyors', s.ctx).map((r) => r.path)).toEqual(['Cell/Belt']);
    expect(collectTypeRows(s.scene, 'all', s.ctx).map((r) => r.name))
      .toEqual(['Belt', 'Eye', 'Occupied', 'Wait', 'Info']);
  });

  it('counts overrides from the overlay, by path', () => {
    const s = makeCell();
    const ctx = { ...s.ctx, overlay: { nodes: { 'Cell/Belt': {} } } as never };
    expect(collectTypeCounts(s.scene, ctx).withOverrides).toBe(1);
  });
});

describe('search is a scene walk (§9.19)', () => {
  it('keeps matching branches with their ancestors and drops the rest', () => {
    const s = makeCell();
    const tree = buildSceneSearchTree(s.scene, 'belt', s.ctx);
    const rows = flattenVisibleTree(tree, searchExpandKeys(tree));
    // Cell survives as an ANCESTOR of the match; the mover chunk because its own
    // name carries the boundary path — which is the point of searching the graph.
    // The chunk keeps its fold row ("Geometry", plan-505), open for the search.
    expect(rows.map((r) => r.node.name)).toEqual(['Scene', 'Cell', 'Belt', 'Geometry', 'mover:Cell/Belt']);
    expect(rows.map((r) => r.node.name)).not.toContain('Eye');
  });

  it('matches the PATH, not just the leaf name', () => {
    const s = makeCell();
    const tree = buildSceneSearchTree(s.scene, 'cell/occ', s.ctx);
    expect(flattenVisibleTree(tree, searchExpandKeys(tree)).map((r) => r.node.name))
      .toEqual(['Scene', 'Cell', 'Occupied']);
  });

  it('finds a chunk mesh by its readable label — a projection could not', () => {
    const s = makeCell();
    // plan-505 label: "kind + size" (`Chunk · 12 tris` without bake meta).
    const tree = buildSceneSearchTree(s.scene, 'chunk ·', s.ctx);
    const rows = flattenVisibleTree(tree, searchExpandKeys(tree));
    expect(rows.map((r) => r.node as SceneTreeNode).some((n) => n.object === s.chunk)).toBe(true);
  });

  it('consults the component search-text provider (AAS/Metadata content)', () => {
    const s = makeCell();
    const tree = buildSceneSearchTree(s.scene, 'order-4711', s.ctx,
      (obj) => (obj === s.info ? ['Batch order-4711'] : []));
    expect(flattenVisibleTree(tree, searchExpandKeys(tree)).map((r) => r.node.name))
      .toEqual(['Scene', 'Cell', 'Info']);
  });

  it('returns an empty tree when nothing matches', () => {
    const s = makeCell();
    expect(buildSceneSearchTree(s.scene, 'nothing-like-this', s.ctx)).toEqual([]);
  });

  it('finds runtime objects while the toggle hides them', () => {
    const s = makeCell(true);
    const tree = buildSceneSearchTree(s.scene, 'helper', s.ctx);
    expect(searchExpandKeys(tree).has(s.helper.uuid)).toBe(true);
  });
});

describe('expansion keys (§9.19)', () => {
  it('a stale PATH key expands nothing, a live one still works', () => {
    const s = makeCell();
    // Nothing in the graph is addressed 'Old/Gone' any more.
    expect(flattenSceneRows(s.scene, new Set([s.scene.uuid, 'Old/Gone']), s.ctx).map((r) => r.node.name))
      .toEqual(['Scene', 'Cell', 'Helper']);
    // A path key that DOES resolve keeps a pre-754 expand set working.
    expect(flattenSceneRows(s.scene, new Set([s.scene.uuid, 'Cell']), s.ctx).map((r) => r.node.name))
      .toContain('Belt');
  });
});

describe('the eye on a merged row (D8)', () => {
  it('is disabled with the boundary in its tooltip when nothing is drawn below', () => {
    const s = makeCell();
    const infoRow = flattenSceneRows(s.scene, s.expanded, s.ctx)
      .map((r) => r.node as SceneTreeNode).find((r) => r.object === s.info)!;

    expect(subtreeHasDrawable(s.info)).toBe(false);
    expect(mergedBoundaryName(s.info)).toBe('Cell');

    render(
      <TreeNodeRow
        row={{ node: infoRow, depth: 0, rowKey: infoRow.object.uuid, posInSet: 1, setSize: 1 }}
        expanded={new Set()}
        onToggleExpand={noop}
        onSelect={noop}
        onDoubleClick={noop}
        onHover={noop}
        signalStore={null}
        logicEngine={null}
        rowHeight={22}
        virtualStyle={{}}
        getNodeVisible={() => true}
        onToggleVisible={vi.fn()}
        eyeDisabledReason={() => 'Merged into Cell — cannot be hidden separately'}
      />,
    );
    const eye = screen.getByLabelText('Hide');
    expect(eye.hasAttribute('disabled')).toBe(true);
  });

  // plan-755: a boundary whose geometry is ALL partitioned has no direct chunk
  // child — the chunks hang under the synthetic partition objects. It is still
  // the boundary the merged node's triangles went into.
  it('names the boundary even when all its chunks hang under partition objects', () => {
    const axis = new Group(); axis.name = 'Axis';
    const merged = new Group(); merged.name = 'Info';
    const partitionObject = new Group(); partitionObject.name = 'Covers';
    partitionObject.userData._rvSynthetic = true;
    const chunk = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    chunk.userData._rvBakeChunk = true;
    partitionObject.add(chunk);
    axis.add(merged, partitionObject);
    const world = new Group(); world.name = 'World';
    world.add(axis);
    expect(mergedBoundaryName(merged)).toBe('Axis');
  });

  it('is enabled on a row that owns a chunk mesh', () => {
    const s = makeCell();
    expect(subtreeHasDrawable(s.belt)).toBe(true);
    const beltRow = flattenSceneRows(s.scene, s.expanded, s.ctx)
      .map((r) => r.node as SceneTreeNode).find((r) => r.object === s.belt)!;
    const onToggle = vi.fn();
    render(
      <TreeNodeRow
        row={{ node: beltRow, depth: 0, rowKey: beltRow.object.uuid, posInSet: 1, setSize: 1 }}
        expanded={new Set()}
        onToggleExpand={noop}
        onSelect={noop}
        onDoubleClick={noop}
        onHover={noop}
        signalStore={null}
        logicEngine={null}
        rowHeight={22}
        virtualStyle={{}}
        getNodeVisible={() => true}
        onToggleVisible={onToggle}
        eyeDisabledReason={() => null}
      />,
    );
    const eye = screen.getByLabelText('Hide');
    expect(eye.hasAttribute('disabled')).toBe(false);
    eye.click();
    expect(onToggle).toHaveBeenCalledWith(beltRow);
  });

  it('memoises the drawable answer per bake revision', () => {
    const s = makeCell();
    expect(subtreeHasDrawable(s.info, 1)).toBe(false);
    // A chunk arrives for it and the bake revision moves on.
    const chunk = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    chunk.userData._rvBakeChunk = true;
    s.info.add(chunk);
    expect(subtreeHasDrawable(s.info, 1)).toBe(false);   // cached at revision 1
    expect(subtreeHasDrawable(s.info, 2)).toBe(true);    // recomputed
  });
});

describe('multi-select and drag on scene rows (§9.19)', () => {
  it('reports the row node to the caller so a range can be built over objects', () => {
    const s = makeCell();
    const rows = flattenSceneRows(s.scene, s.expanded, s.ctx);
    const beltRow = rows.find((r) => r.node.name === 'Belt')!;
    const onSelect = vi.fn();
    render(
      <TreeNodeRow
        row={beltRow}
        expanded={new Set()}
        onToggleExpand={noop}
        onSelect={onSelect}
        onDoubleClick={noop}
        onHover={noop}
        signalStore={null}
        logicEngine={null}
        rowHeight={22}
        virtualStyle={{}}
      />,
    );
    screen.getByRole('treeitem').click();
    expect((onSelect.mock.calls[0][0] as SceneTreeNode).object).toBe(s.belt);
  });

  it('refuses to make a runtime row draggable even with DnD on', () => {
    const s = makeCell();
    const helperRow = flattenSceneRows(s.scene, s.expanded, s.ctx)
      .find((r) => r.node.name === 'Helper')!;
    render(
      <TreeNodeRow
        row={helperRow}
        expanded={new Set()}
        onToggleExpand={noop}
        onSelect={noop}
        onDoubleClick={noop}
        onHover={noop}
        signalStore={null}
        logicEngine={null}
        rowHeight={22}
        virtualStyle={{}}
        dndEnabled
      />,
    );
    expect(screen.getByRole('treeitem').getAttribute('draggable')).toBeNull();
  });
});

describe('search-restricted counts, the "3/21" of the chips (plan-597 Phase 6b)', () => {
  it('counts only nodes that match the term, per category and label', () => {
    const s = makeCell();
    const m = collectTypeCounts(s.scene, s.ctx, { term: 'cell/' });
    // Path hits Cell/Belt, Cell/Eye, Cell/Occupied, Cell/Wait, Cell/Info and the
    // mover chunk by name (mover:Cell/Belt); Cell itself (path "Cell") does not.
    expect(m.total).toBe(6);
    expect(m.byCategory.get('drives')).toBe(1);
    expect(m.byCategory.get('sensors')).toBe(1);
    expect(m.byLabel.get('transport')?.get('Conveyors')).toBe(1);

    const eye = collectTypeCounts(s.scene, s.ctx, { term: 'EYE' });
    expect(eye.total).toBe(1);
    expect(eye.byCategory.get('sensors')).toBe(1);
    expect(eye.byCategory.has('drives')).toBe(false);
  });

  it('uses the same component search text as the tree search', () => {
    const s = makeCell();
    const searchText = (o: Object3D) => (o === s.belt ? ['ACME gear motor'] : []);
    const m = collectTypeCounts(s.scene, s.ctx, { term: 'acme', searchText });
    expect(m.total).toBe(1);
    expect(m.byCategory.get('drives')).toBe(1);
    const tree = buildSceneSearchTree(s.scene, 'acme', s.ctx, searchText);
    const hits = flattenVisibleTree(tree, searchExpandKeys(tree))
      .map((r) => r.node as SceneTreeNode)
      .filter((n) => matchesSearchTerm(n.object, n.path, 'acme', s.ctx, searchText));
    expect(hits.map((n) => n.object)).toEqual([s.belt]);
  });

  it('a category\'s matching count equals its flat list under the same term', () => {
    const s = makeCell();
    for (const term of ['cell/', 'o', 'wait', 'zzz']) {
      const m = collectTypeCounts(s.scene, s.ctx, { term });
      for (const cat of ['drives', 'transport', 'sensors', 'signals', 'logic'] as const) {
        const rows = collectTypeRows(s.scene, `cat:${cat}`, s.ctx)
          .filter((r) => matchesSearchTerm(r.object, r.path, term.toLowerCase(), s.ctx));
        expect(m.byCategory.get(cat) ?? 0, `${cat} / ${term}`).toBe(rows.length);
      }
    }
  });

  it('applies the same toggles as the totals, so matching never exceeds total', () => {
    const s = makeCell(true);
    const m = collectTypeCounts(s.scene, s.ctx, { term: 'helper' });
    expect(m.total).toBe(0);            // Helper is a runtime node the toggle hides
    expect(m.runtimeHidden).toBe(2);    // toggle hints stay unfiltered
    const all = collectTypeCounts(s.scene, s.ctx);
    const any = collectTypeCounts(s.scene, s.ctx, { term: 'e' });
    expect(any.total).toBeLessThanOrEqual(all.total);
  });
});
