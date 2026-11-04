// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-741 Phase 0 — the locked-placement seam.
 *
 * A DXF hall floor plan is placed as a REFERENCE: the user builds a layout on
 * top of it and must not be able to nudge or delete it by accident. Before
 * plan-741 that was inexpressible — seven call sites in `scene-mutations.ts`
 * hard-coded `Locked: false`, so a `Locked: true` carried in a GLB was
 * overwritten at placement time (plan §7 Alternative 5).
 *
 * This file pins the whole chain that now carries the intent:
 *   `ImportObjectOptions.locked` → `placeComponent(entry, pos, { locked })`
 *   → `AddPlacedOptions.locked` → `makeLayoutObject` → `isLockedLayoutInstance`
 * and — just as important — that the DEFAULT is byte-identical to before.
 */
import { describe, test, expect, vi } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshBasicMaterial, Scene } from 'three';
import type { Object3D } from 'three';

import {
  addPlacedToScene,
  adoptPlacedNode,
  makeLayoutObject,
  prepPlacedVisual,
  type SceneMutationDeps,
} from '../src/plugins/layout-planner/scene-mutations';
import { isLockedLayoutInstance } from '../src/plugins/layout-planner/layout-predicates';
import { importObject, type ImportPlannerLike, type ImportViewerLike } from '../src/core/import/rv-import-object';
import type { LibraryCatalogEntry } from '../src/plugins/layout-planner/rv-layout-store';

// ─── Harness (mirrors layout-planner-scene-mutations.test.ts) ───────────

function makeClone(name: string): Group {
  const g = new Group();
  g.name = name;
  const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  m.name = name + '_geo';
  g.add(m);
  return g;
}

function makeHarness(): { deps: SceneMutationDeps; modelRoot: Group } {
  const scene = new Scene();
  const layoutRoot = new Group();
  layoutRoot.name = '_layoutRoot';
  scene.add(layoutRoot);
  const modelRoot = new Group();
  modelRoot.name = 'modelRoot';
  scene.add(modelRoot);

  const viewer = {
    scene,
    registry: {
      registerNode: vi.fn(),
      unregisterSubtree: vi.fn(() => new Set<string>()),
      getPathForNode: vi.fn(() => null),
    },
    signalStore: null, // null disables the processExtras path
    transportManager: null,
    drives: [],
    rebuildGroupedBvh: vi.fn(),
    raycastManager: { addAuxRaycastTarget: vi.fn(), removeAuxRaycastTarget: vi.fn() },
    getPlugin: vi.fn(),
  };

  const deps: SceneMutationDeps = {
    getViewer: () => viewer as never,
    objectMap: new Map<string, Object3D>(),
    idByObject: new WeakMap<Object3D, string>(),
    getLayoutRoot: () => layoutRoot,
    getTransformControls: () => ({ detach: vi.fn() }) as never,
    getModelRoot: () => modelRoot,
  };
  return { deps, modelRoot };
}

function layoutObjectOf(node: Object3D): { Label: string; CatalogId: string; Locked: boolean } {
  return (node.userData.realvirtual as { LayoutObject: { Label: string; CatalogId: string; Locked: boolean } }).LayoutObject;
}

// ─── makeLayoutObject ───────────────────────────────────────────────────

describe('makeLayoutObject', () => {
  test('defaults to unlocked and produces the exact legacy payload', () => {
    expect(makeLayoutObject('Belt', 'cat:belt')).toEqual({
      Label: 'Belt', CatalogId: 'cat:belt', Locked: false,
    });
  });

  test('carries an explicit lock', () => {
    expect(makeLayoutObject('Hall', 'cat:hall', true)).toEqual({
      Label: 'Hall', CatalogId: 'cat:hall', Locked: true,
    });
  });

  test('key order matches the legacy literal (GLB payload stability)', () => {
    expect(Object.keys(makeLayoutObject('a', 'b'))).toEqual(['Label', 'CatalogId', 'Locked']);
  });
});

// ─── Placement paths ────────────────────────────────────────────────────

describe('locked placement through scene-mutations', () => {
  test('addPlacedToScene({ locked: true }) yields a locked layout instance', () => {
    const { deps } = makeHarness();
    const clone = makeClone('hall');
    addPlacedToScene(deps, clone, 'id-1', 'Hall', 'cat:hall', { locked: true });
    expect(layoutObjectOf(clone)).toEqual({ Label: 'Hall', CatalogId: 'cat:hall', Locked: true });
    expect(isLockedLayoutInstance(clone)).toBe(true);
  });

  test('addPlacedToScene without the option stays unlocked (unchanged default)', () => {
    const { deps } = makeHarness();
    const clone = makeClone('belt');
    addPlacedToScene(deps, clone, 'id-2', 'Belt', 'cat:belt');
    expect(layoutObjectOf(clone)).toEqual({ Label: 'Belt', CatalogId: 'cat:belt', Locked: false });
    expect(isLockedLayoutInstance(clone)).toBe(false);
  });

  test('prepPlacedVisual carries locked into an EXISTING rv-extras object', () => {
    const { deps } = makeHarness();
    const clone = makeClone('hall');
    clone.userData.realvirtual = { Drive: { Direction: 'LinearX' } };
    prepPlacedVisual(deps, clone, 'id-3', 'Hall', 'cat:hall', { locked: true });
    expect(isLockedLayoutInstance(clone)).toBe(true);
    // …without clobbering what was already there
    expect((clone.userData.realvirtual as Record<string, unknown>).Drive).toBeDefined();
  });

  test('adoptPlacedNode (reload path) preserves the lock', () => {
    const { deps, modelRoot } = makeHarness();
    const node = makeClone('hall');
    modelRoot.add(node);
    adoptPlacedNode(deps, node, 'id-4', 'Hall', 'cat:hall', { locked: true });
    expect(isLockedLayoutInstance(node)).toBe(true);
  });

  test('adoptPlacedNode without options is unlocked', () => {
    const { deps, modelRoot } = makeHarness();
    const node = makeClone('belt');
    modelRoot.add(node);
    adoptPlacedNode(deps, node, 'id-5', 'Belt', 'cat:belt');
    expect(layoutObjectOf(node)).toEqual({ Label: 'Belt', CatalogId: 'cat:belt', Locked: false });
  });
});

// ─── importObject → planner pass-through ────────────────────────────────

interface FakePlacement { opts?: { skipAutoAlign?: boolean; locked?: boolean } }

function makeFakePlanner(): ImportPlannerLike & { placements: FakePlacement[] } {
  const placements: FakePlacement[] = [];
  return {
    placements,
    placeComponent: async (_entry, _position, opts) => {
      placements.push({ opts });
      return `placed-${placements.length}`;
    },
  };
}

const ENTRY = { id: 'cat:hall', name: 'Hall', glbUrl: 'blob:hall' } as unknown as LibraryCatalogEntry;

function makeViewer(planner: ImportPlannerLike): ImportViewerLike {
  return { getPlugin: (id: string) => (id === 'layout-planner' ? planner : undefined) };
}

describe('importObject locked pass-through', () => {
  test('forwards locked to placeComponent', async () => {
    const planner = makeFakePlanner();
    await importObject(makeViewer(planner), { kind: 'catalog', entries: [ENTRY] }, { locked: true });
    expect(planner.placements[0].opts).toEqual({ locked: true });
  });

  test('forwards BOTH flags together (a DXF reference wants skipAutoAlign too)', async () => {
    const planner = makeFakePlanner();
    await importObject(
      makeViewer(planner),
      { kind: 'catalog', entries: [ENTRY] },
      { skipAutoAlign: true, locked: true },
    );
    expect(planner.placements[0].opts).toEqual({ skipAutoAlign: true, locked: true });
  });

  test('passes undefined opts when neither flag is set (unchanged default)', async () => {
    const planner = makeFakePlanner();
    await importObject(makeViewer(planner), { kind: 'catalog', entries: [ENTRY] });
    expect(planner.placements[0].opts).toBeUndefined();
  });

  test('locked:false is not forwarded as a flag', async () => {
    const planner = makeFakePlanner();
    await importObject(makeViewer(planner), { kind: 'catalog', entries: [ENTRY] }, { locked: false });
    expect(planner.placements[0].opts).toBeUndefined();
  });
});
