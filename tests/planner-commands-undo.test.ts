// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-499 Phase 3 acceptance — the planner commands are ADAPTERS of the one
 * SceneStore history, not a second one: a place (with a height = add + move),
 * a move and a multi-delete are each exactly ONE undo step, and redo restores
 * them.
 *
 * The history is a REAL `RvDocument` (the op log the SceneStore delegates to)
 * whose executor is the production scene executor (`rv-scene-executors`) —
 * so undo/redo really replay `removePlacementById` / `placeFromRecord` /
 * `applyTransformById` against a real `LayoutPlannerPlugin`
 * (`_layout-planner-async-harness`). Only the `getSceneStore()` singleton is
 * swapped for a thin facade over that document; the commands run through a
 * real `CommandRegistry` exactly as a button or `web_layout_*` would.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setupPlanner,
  internals,
  flush,
  GLB_ENTRY,
  type PlannerHarness,
} from './_layout-planner-async-harness';
import { RvDocument } from '../src/core/ops/rv-document';
import type { RvOp } from '../src/core/ops/rv-unified-ops';
import { applyForward, applyInverse } from '../src/core/hmi/scene/rv-scene-executors';
import type { RvSceneOp } from '../src/core/ops/rv-unified-ops';
import type { RVViewer } from '../src/core/rv-viewer';
import { CommandRegistry, type ExecuteResult } from '../src/core/hmi/rv-command-registry';
import { ensurePlannerCommandsRegistered } from '../src/plugins/layout-planner/planner-commands';

// ─── The SceneStore singleton → a facade over one real RvDocument ───────

const h = vi.hoisted(() => ({ store: null as unknown }));

vi.mock('../src/core/hmi/scene/scene-store-singleton', () => ({
  getSceneStore: () => h.store,
}));

function installHistory(viewer: unknown): RvDocument {
  const ctx = { viewer: viewer as RVViewer };
  const doc = new RvDocument({
    id: 'plan-499-planner-undo',
    name: 'undo',
    mode: 'scene',
    executor: {
      applyForward: (op: RvOp) => applyForward(op as RvSceneOp, ctx),
      applyInverse: (op: RvOp) => applyInverse(op as RvSceneOp, ctx),
    },
  });
  h.store = {
    applyOp: (op: RvOp) => doc.applyOp(op),
    withTransaction: <T>(label: string, fn: () => T | Promise<T>) => doc.withTransaction(label, fn),
    undo: () => doc.undo(),
    redo: () => doc.redo(),
    canUndo: () => doc.canUndo(),
    canRedo: () => doc.canRedo(),
    describeUndo: () => doc.describeUndo(),
    describeRedo: () => doc.describeRedo(),
    subscribe: () => () => {},
  };
  return doc;
}

const CATALOG_URL = 'test://plan499-undo';

async function boot(): Promise<{ harness: PlannerHarness; doc: RvDocument; reg: CommandRegistry }> {
  const harness = setupPlanner();
  // The executors resolve the planner through the viewer, like production.
  const plannerLookup = harness.viewer.getPlugin.getMockImplementation();
  harness.viewer.getPlugin.mockImplementation(((id?: string) =>
    (id === 'layout-planner' ? harness.plugin : plannerLookup?.(id))) as never);
  harness.plugin.store.addCatalogDirect(CATALOG_URL, { version: '1.0', name: 'plan499', entries: [GLB_ENTRY] });
  await internals(harness.plugin)._catalogsLoaded;
  await flush();
  const doc = installHistory(harness.viewer);
  const reg = new CommandRegistry();
  ensurePlannerCommandsRegistered(reg);
  return { harness, doc, reg };
}

function run(reg: CommandRegistry, harness: PlannerHarness, id: string, args: unknown): Promise<ExecuteResult> {
  return reg.execute(id, args, { origin: 'ui', viewer: harness.viewer as unknown as RVViewer });
}

const placedIds = (harness: PlannerHarness): string[] => harness.store.getSnapshot().placed.map((p) => p.id);

// ─── Tests ──────────────────────────────────────────────────────────────

describe('planner commands — one undo step each (plan-499 Phase 3)', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    localStorage.removeItem('rv-layout-autosave');
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    h.store = null;
    localStorage.removeItem('rv-layout-autosave');
  });

  it('layout.place with a height (add + move) is ONE step; undo removes it, redo restores it at that height', async () => {
    const { harness, doc, reg } = await boot();
    const r = await run(reg, harness, 'layout.place', { catalogId: GLB_ENTRY.id, x: 1, y: 0.5, z: 2, onto: null });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const id = (r as { value: { id: string } }).value.id;
    await doc.whenIdle?.();
    await flush();

    expect(doc.opCount).toBe(1);
    expect(doc.describeUndo()).toContain('Place');
    expect(placedIds(harness)).toEqual([id]);

    await doc.undo();
    await flush();
    expect(placedIds(harness)).toEqual([]);
    expect(harness.plugin.getPlacedRootById(id)).toBeNull();
    expect(doc.canUndo()).toBe(false);

    await doc.redo();
    await flush();
    expect(placedIds(harness)).toEqual([id]);
    expect(harness.plugin.getPlacedRootById(id)?.position.y).toBeCloseTo(0.5, 5);
  });

  it('layout.move is ONE step; undo puts the part back, redo moves it again', async () => {
    const { harness, doc, reg } = await boot();
    const placed = await run(reg, harness, 'layout.place', { catalogId: GLB_ENTRY.id, x: 0, y: 0, z: 0, onto: null });
    const id = (placed as { value: { id: string } }).value.id;
    await flush();
    const before = doc.opCount;

    const r = await run(reg, harness, 'layout.move', { id, x: 3, y: 0, z: 1, rx: null, ry: 90, rz: null });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    await flush();
    expect(doc.opCount).toBe(before + 1);
    const node = () => harness.plugin.getPlacedRootById(id)!;
    expect(node().position.x).toBeCloseTo(3, 5);

    await doc.undo();
    await flush();
    expect(node().position.x).toBeCloseTo(0, 5);
    expect(doc.opCount).toBe(before);

    await doc.redo();
    await flush();
    expect(node().position.x).toBeCloseTo(3, 5);
    expect(node().position.z).toBeCloseTo(1, 5);
  });

  it('layout.remove on a multi-selection is ONE step; undo brings every part back, redo removes them again', async () => {
    const { harness, doc, reg } = await boot();
    const ids: string[] = [];
    for (const x of [0, 2, 4]) {
      const r = await run(reg, harness, 'layout.place', { catalogId: GLB_ENTRY.id, x, y: 0, z: 0, onto: null });
      ids.push((r as { value: { id: string } }).value.id);
    }
    await flush();
    expect(doc.opCount).toBe(3);

    const paths = ids.slice(0, 2).map((id) => harness.viewer.registry.getPathForNode(harness.plugin.getPlacedRootById(id)!)!);
    harness.viewer.selectionManager.selectPaths(paths);

    // The toolbar Delete: `id: null` = the selection.
    expect(reg.enabled('layout.remove', { id: null }, harness.viewer as unknown as RVViewer)).toBe(true);
    const r = await run(reg, harness, 'layout.remove', { id: null });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    await flush();
    expect(placedIds(harness)).toEqual([ids[2]]);
    expect(doc.opCount).toBe(4);

    await doc.undo();
    await flush();
    expect(placedIds(harness).sort()).toEqual([...ids].sort());
    expect(doc.opCount).toBe(3);

    await doc.redo();
    await flush();
    expect(placedIds(harness)).toEqual([ids[2]]);
  });

  it('nothing selected: the Delete rule refuses with the tooltip text and changes nothing', async () => {
    const { harness, doc, reg } = await boot();
    harness.viewer.selectionManager.clear();
    const en = reg.enabled('layout.remove', { id: null }, harness.viewer as unknown as RVViewer);
    expect(en).toEqual({ reason: 'Delete (select something first)' });
    const r = await run(reg, harness, 'layout.remove', { id: null });
    expect(r).toMatchObject({ ok: false, kind: 'disabled', reason: 'Delete (select something first)' });
    expect(doc.opCount).toBe(0);
  });

  it('layout.undo / layout.redo are views of the same history', async () => {
    const { harness, doc, reg } = await boot();
    expect(reg.enabled('layout.undo', {}, harness.viewer as unknown as RVViewer)).toEqual({ reason: 'Nothing to undo' });
    await run(reg, harness, 'layout.place', { catalogId: GLB_ENTRY.id, x: 0, y: 0, z: 0, onto: null });
    await flush();
    expect(reg.enabled('layout.undo', {}, harness.viewer as unknown as RVViewer)).toBe(true);
    expect((await run(reg, harness, 'layout.undo', {})).ok).toBe(true);
    await flush();
    expect(placedIds(harness)).toEqual([]);
    expect((await run(reg, harness, 'layout.redo', {})).ok).toBe(true);
    await flush();
    expect(placedIds(harness)).toHaveLength(1);
    expect(doc.canRedo()).toBe(false);
  });
});
