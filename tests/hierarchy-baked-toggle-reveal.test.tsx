// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-505 §9.3 — "Show baked geometry" toggle and the auto-reveal of a
 * selected chunk.
 *
 * With the toggle off (the default) neither fold rows nor chunk rows render
 * and the footer counts what is hidden. A SELECTED chunk stays visible anyway,
 * dimmed, with its fold row — and a chunk picked in 3D (no path) is revealed
 * by walking its parent chain, which must land on a real row index.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D, Scene } from 'three';
import { BAKED_REVEALED_TITLE, TreeNodeRow } from '../src/core/hmi/HierarchyNodeRow';
import {
  buildSceneSearchTree,
  chunkFoldKey,
  collectTypeCounts,
  flattenSceneRows,
  isChunkFoldRow,
  revealExpandKeysFor,
  searchExpandKeys,
  type ChunkFoldRow,
  type SceneRowContext,
  type SceneTreeNode,
} from '../src/core/hmi/hierarchy-rows';
import { flattenVisibleTree } from '../src/core/hmi/hierarchy-utils';
import { LS_KEY_SHOW_BAKED, SearchRowToggle, loadHideBaked, persistHideBaked } from '../src/core/hmi/rv-hierarchy-browser';
import { RvExtrasEditorPlugin } from '../src/core/hmi/rv-extras-editor';
import { ThemeProvider } from '@mui/material/styles';
import { rvDarkTheme } from '../src/core/hmi/theme';

afterEach(cleanup);

const noop = () => {};

function chunkMesh(name: string): Mesh {
  const m = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  m.name = name;
  m.userData._rvBakeChunk = true;
  return m;
}

/** Scene ▸ Cell ▸ { Robot, chunkA, chunkB, chunkC }. */
function makeScene(hideBaked: boolean, reveal: Object3D[] = []) {
  const scene = new Scene();
  const cell = new Group(); cell.name = 'Cell';
  const robot = new Group(); robot.name = 'Robot';
  const chunkA = chunkMesh('static');
  const chunkB = chunkMesh('tex:b');
  const chunkC = chunkMesh('tex:c');
  cell.add(robot, chunkA, chunkB, chunkC);
  scene.add(cell);
  const paths = new Map<Object3D, string>([[cell, 'Cell'], [robot, 'Cell/Robot']]);
  const ctx: SceneRowContext = {
    getPathForNode: (n) => paths.get(n) ?? null,
    overlay: null,
    modelRoot: cell,
    hideRuntime: false,
    hideBaked,
    revealObjects: new Set(reveal),
  };
  return { scene, cell, robot, chunkA, chunkB, chunkC, ctx };
}

function allOpen(s: ReturnType<typeof makeScene>): Set<string> {
  return new Set([s.scene.uuid, s.cell.uuid, chunkFoldKey(s.cell)]);
}

describe('the baked toggle (plan-505 F5)', () => {
  it('hides fold and chunk rows and counts the hidden chunks', () => {
    const s = makeScene(true);
    const rows = flattenSceneRows(s.scene, allOpen(s), s.ctx);
    expect(rows.map((r) => r.node.name)).toEqual(['Scene', 'Cell', 'Robot']);
    expect(rows.some((r) => isChunkFoldRow(r.node))).toBe(false);
    const counts = collectTypeCounts(s.scene, s.ctx);
    expect(counts.bakedHidden).toBe(3);
    // Scene, Cell, Robot remain in the total.
    expect(counts.total).toBe(3);
  });

  it('shows them again when off, with the full count on the fold', () => {
    const s = makeScene(false);
    const rows = flattenSceneRows(s.scene, allOpen(s), s.ctx);
    expect(rows.map((r) => r.node.displayLabel ?? r.node.name)).toEqual([
      'Scene', 'Cell', 'Robot', 'Geometry · 3 chunks · 36 tris',
      'Chunk · 12 tris', 'Chunk · 12 tris', 'Chunk · 12 tris',
    ]);
    expect(collectTypeCounts(s.scene, s.ctx).bakedHidden).toBe(0);
  });
});

describe('auto-reveal of a selected chunk (plan-505 F6)', () => {
  it('keeps exactly the fold row and the selected chunk, both marked revealed', () => {
    const s = makeScene(true);
    s.ctx.revealObjects = new Set([s.chunkB]);
    const rows = flattenSceneRows(s.scene, allOpen(s), s.ctx);
    const fold = rows.find((r) => isChunkFoldRow(r.node))!;
    expect(fold).toBeDefined();
    expect((fold.node as ChunkFoldRow).revealed).toBe(true);
    // The fold still states the boundary's real content.
    expect(fold.node.displayLabel).toBe('Geometry · 3 chunks · 36 tris');
    const chunks = rows.filter((r) => (r.node as Partial<SceneTreeNode>).chunk === true);
    expect(chunks.map((r) => (r.node as SceneTreeNode).object)).toEqual([s.chunkB]);
    expect((chunks[0].node as SceneTreeNode).revealed).toBe(true);
    expect(chunks[0].setSize).toBe(1);
  });

  it('renders a revealed chunk row dimmed with the "shown despite filter" tooltip', () => {
    const s = makeScene(true);
    s.ctx.revealObjects = new Set([s.chunkB]);
    const row = flattenSceneRows(s.scene, allOpen(s), s.ctx)
      .find((r) => (r.node as Partial<SceneTreeNode>).object === s.chunkB)!;
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
        rowHeight={22}
        virtualStyle={{}}
      />,
    );
    const item = screen.getByRole('treeitem');
    expect(item.getAttribute('data-revealed')).toBe('true');
    const label = screen.getByText('Chunk · 12 tris');
    expect(getComputedStyle(label).opacity).toBe('0.6');
    expect(label.getAttribute('aria-label') ?? '').toContain(BAKED_REVEALED_TITLE);
  });

  it('the object reveal opens the ancestors and the fold, landing on a real index', () => {
    const s = makeScene(true, []);
    s.ctx.revealObjects = new Set([s.chunkC]);
    // Nothing open yet: the chunk was picked in 3D.
    const keys = revealExpandKeysFor(s.chunkC, s.scene);
    expect(keys).toEqual([s.scene.uuid, s.cell.uuid, chunkFoldKey(s.cell)]);
    const rows = flattenSceneRows(s.scene, new Set(keys), s.ctx);
    const idx = rows.findIndex((r) => r.rowKey === s.chunkC.uuid);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(rows[idx - 1].rowKey).toBe(chunkFoldKey(s.cell));
  });

  it('stops the ancestor walk at the rendered root', () => {
    const s = makeScene(true);
    expect(revealExpandKeysFor(s.chunkA, s.cell)).toEqual([s.cell.uuid, chunkFoldKey(s.cell)]);
    // A non-chunk gets no fold key.
    expect(revealExpandKeysFor(s.robot, s.scene)).toEqual([s.scene.uuid, s.cell.uuid]);
  });
});

describe('search ignores the baked toggle (plan-505 F8)', () => {
  it('finds a hidden chunk and opens its fold row', () => {
    const s = makeScene(true);
    s.chunkB.name = 'tex:needle';
    const tree = buildSceneSearchTree(s.scene, 'needle', s.ctx);
    const keys = searchExpandKeys(tree);
    expect(keys.has(chunkFoldKey(s.cell))).toBe(true);
    const rows = flattenVisibleTree(tree, keys);
    expect(rows.map((r) => r.node.name)).toEqual(['Scene', 'Cell', 'Geometry', 'tex:needle']);
    expect((rows[3].node as SceneTreeNode).object).toBe(s.chunkB);
  });
});

describe('toggle persistence and the object reveal request', () => {
  beforeEach(() => { try { localStorage.removeItem(LS_KEY_SHOW_BAKED); } catch { /* */ } });

  it('defaults to hidden and round-trips through localStorage', () => {
    expect(loadHideBaked()).toBe(true);
    persistHideBaked(false);
    expect(localStorage.getItem('rv-hierarchy-show-baked')).toBe('true');
    expect(loadHideBaked()).toBe(false);
    persistHideBaked(true);
    expect(localStorage.getItem('rv-hierarchy-show-baked')).toBe('false');
    expect(loadHideBaked()).toBe(true);
    localStorage.removeItem(LS_KEY_SHOW_BAKED);
  });

  it('selectObject on a path-less chunk requests an object reveal; clearReveal consumes it', () => {
    const plugin = new RvExtrasEditorPlugin();
    const chunk = chunkMesh('static');
    plugin.selectObject(chunk);
    expect(plugin.getSnapshot().revealObject).toBe(chunk);
    expect(plugin.getSnapshot().selectedNode).toBe(chunk);
    plugin.clearReveal();
    expect(plugin.getSnapshot().revealObject).toBeNull();
    // A click inside the hierarchy passes reveal = false (the row is on screen).
    plugin.selectObject(chunk, false, false);
    expect(plugin.getSnapshot().revealObject ?? null).toBeNull();
    plugin.requestRevealObject(chunk);
    expect(plugin.getSnapshot().revealObject).toBe(chunk);
  });
});

describe('the runtime / baked toggles in the search row (plan-597 Phase 6b)', () => {
  it('is an aria-pressed icon button named by its action, accent only while pressed', () => {
    let pressed = false;
    const onToggle = () => { pressed = !pressed; };
    const ui = () => (
      <ThemeProvider theme={rvDarkTheme}>
        <SearchRowToggle label="Show baked geometry" pressed={pressed} onToggle={onToggle} icon={<span>i</span>} />
      </ThemeProvider>
    );
    const { rerender } = render(ui());
    const button = screen.getByRole('button', { name: 'Show baked geometry' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    const idleColor = getComputedStyle(button).color;
    fireEvent.click(button);
    expect(pressed).toBe(true);
    rerender(ui());
    const now = screen.getByRole('button', { name: 'Show baked geometry' });
    expect(now.getAttribute('aria-pressed')).toBe('true');
    // Instrument Blue #4fc3f7 = rgb(79, 195, 247), only in the pressed state.
    expect(getComputedStyle(now).color).toBe('rgb(79, 195, 247)');
    expect(idleColor).not.toBe('rgb(79, 195, 247)');
    // Same height as the search field (26 px).
    expect(now.getBoundingClientRect().height).toBe(26);
  });
});
