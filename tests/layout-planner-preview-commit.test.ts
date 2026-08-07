// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for the LayoutPlannerPlugin live-draft drag-in model.
 *
 * The dragged object is instantiated + registered on drag-ENTER (a real,
 * selectable, gizmo-bearing placement) — only the store/undo commit is deferred
 * to drop. On cancel it is fully torn down. These tests drive that lifecycle at
 * the plugin level using a VIRTUAL catalog entry (a wireframe gizmo) so no GLB
 * has to be fetched.
 *
 * SCOPE (plan-371): a virtual entry takes the UNCHANGED branch of `_startDraft`
 * — it needs no network, so it is instantiated in FULL mode immediately and
 * never becomes a pending placement. The GLB branch, where a placeholder is
 * registered in `light` mode and the real geometry swaps in later, is covered
 * by `layout-planner-async-placement.test.ts`. `_startDraft` still returns a
 * promise for this branch, hence the `await`s below.
 */
import { describe, test, expect, vi } from 'vitest';
import { Group, PerspectiveCamera } from 'three';
import type { Object3D } from 'three';
import { LayoutPlannerPlugin } from '../src/plugins/layout-planner';
import type { LibraryCatalogEntry } from '../src/plugins/layout-planner/rv-layout-store';

function createMockViewer() {
  const scene = new Group();
  return {
    scene,
    sceneFixtures: new Set<unknown>(),
    camera: new PerspectiveCamera(),
    controls: { enabled: true },
    raycastManager: {
      addExcludeFilter: vi.fn(),
      addAncestorOverride: vi.fn(),
      removeAncestorOverride: vi.fn(),
      updateTargets: vi.fn(),
      addAuxRaycastTarget: vi.fn(),
      removeAuxRaycastTarget: vi.fn(),
    },
    leftPanelManager: { open: vi.fn(), close: vi.fn() },
    markRenderDirty: vi.fn(),
    markShadowsDirty: vi.fn(),
    fitToNodes: vi.fn(),
    highlighter: { highlight: vi.fn(), clear: vi.fn(), setAuxEmphasis: vi.fn() },
    outlineManager: {
      available: false, hasOutlines: false,
      setStyle: vi.fn(), setOutlined: vi.fn(), clear: vi.fn(), setSize: vi.fn(),
    },
    selectionManager: {
      getSnapshot: vi.fn(() => ({ selectedPaths: [], primaryPath: null })),
      clear: vi.fn(), select: vi.fn(),
    },
    renderer: { domElement: document.createElement('canvas') },
    on: vi.fn(() => vi.fn()),
    emit: vi.fn(),
    getPlugin: vi.fn(),
    currentModel: null,
    signalStore: null,
    transportManager: null,
    registry: null,
    drives: [],
  };
}

/** A virtual DES entry with an unregistered desType → wireframe placeholder. */
const VIRTUAL_ENTRY: LibraryCatalogEntry = {
  id: 'cat:test',
  name: 'TestBox',
  category: 'custom',
  glbUrl: '',
  thumbnailUrl: '',
  virtual: true,
  desType: 'UnregisteredTestType',
  gizmoSize: [500, 500, 500],
};

function makePlugin() {
  const viewer = createMockViewer();
  const plugin = new LayoutPlannerPlugin();
  plugin.onModelLoaded?.({ scene: new Group() } as never, viewer as never);
  return { plugin, viewer };
}

/** Access the planner's private draft lifecycle for assertions. */
function internals(plugin: LayoutPlannerPlugin) {
  return plugin as unknown as {
    _draft: { id: string; node: Object3D; positioned: boolean } | null;
    _objectMap: Map<string, Object3D>;
    _dropCommitted: boolean;
    _startDraft(entry: LibraryCatalogEntry): Promise<void>;
    _moveDraft(x: number, z: number): boolean;
    _commitDraft(entry: LibraryCatalogEntry, coords: [number, number] | null): Promise<string | null>;
    _cancelDraft(): void;
  };
}

describe('LayoutPlannerPlugin — live-draft drag-in (virtual entries)', () => {
  test('ENTER: a virtual entry never becomes a pending placeholder', async () => {
    const { plugin } = makePlugin();
    const p = internals(plugin);

    await p._startDraft(VIRTUAL_ENTRY);

    // Virtual entries are routed by the `virtual` FLAG, not by glbUrl
    // truthiness — theirs is the empty string, not undefined (plan-371 §2.9).
    expect(VIRTUAL_ENTRY.glbUrl).toBe('');
    expect(p._draft!.node.userData._rvPendingPlaceholder).toBeUndefined();
  });

  test('ENTER: _startDraft registers a hidden, real (non-ghost) draft', async () => {
    const { plugin } = makePlugin();
    const p = internals(plugin);

    await p._startDraft(VIRTUAL_ENTRY);

    expect(p._draft).not.toBeNull();
    const node = p._draft!.node;
    // Registered — in the object map, a real layout instance (NOT a ghost).
    expect(p._objectMap.size).toBe(1);
    expect(p._objectMap.get(p._draft!.id)).toBe(node);
    expect(node.userData._layoutId).toBe(p._draft!.id);
    expect(node.userData._isGhost).toBeUndefined();
    // Hidden until first positioned; not yet committed to the store.
    expect(node.visible).toBe(false);
    expect(plugin.store.getSnapshot().placed).toHaveLength(0);
  });

  test('MOVE: positions + reveals the draft (selects on first move)', async () => {
    const { plugin } = makePlugin();
    const p = internals(plugin);
    await p._startDraft(VIRTUAL_ENTRY);

    const node = p._draft!.node;
    expect(p._draft!.positioned).toBe(false);
    p._moveDraft(1.5, 2.5);

    expect(node.visible).toBe(true);
    expect(node.position.x).toBeCloseTo(1.5, 5);
    expect(node.position.z).toBeCloseTo(2.5, 5);
    expect(p._draft!.positioned).toBe(true);
  });

  test('COMMIT: keeps the SAME registered node, records the store', async () => {
    const { plugin } = makePlugin();
    const p = internals(plugin);
    await p._startDraft(VIRTUAL_ENTRY);
    const node = p._draft!.node;
    const id = p._draft!.id;

    const committed = await p._commitDraft(VIRTUAL_ENTRY, [1, 2]);
    expect(committed).toBe(id);

    // Same node (no re-clone), still registered, now visible, draft cleared.
    expect(p._objectMap.get(id)).toBe(node);
    expect(node.visible).toBe(true);
    expect(p._draft).toBeNull();
    // Persisted exactly one placement with that id.
    const placed = plugin.store.getSnapshot().placed;
    expect(placed).toHaveLength(1);
    expect(placed[0].id).toBe(id);
  });

  test('CANCEL: _cancelDraft tears the draft down, no placement recorded', async () => {
    const { plugin } = makePlugin();
    const p = internals(plugin);
    await p._startDraft(VIRTUAL_ENTRY);
    const node = p._draft!.node;

    p._cancelDraft();

    expect(node.parent).toBeNull();          // removed from the scene
    expect(p._draft).toBeNull();
    expect(p._objectMap.size).toBe(0);        // unregistered (removePlacedFromScene)
    expect(plugin.store.getSnapshot().placed).toHaveLength(0);
  });

  test('DRAGEND true-cancel: setDragEntry(null) tears down the uncommitted draft', async () => {
    const { plugin } = makePlugin();
    const p = internals(plugin);
    await p._startDraft(VIRTUAL_ENTRY);
    const node = p._draft!.node;

    // No drop happened → not committed → setDragEntry(null) cancels.
    plugin.setDragEntry(null);

    expect(node.parent).toBeNull();
    expect(p._draft).toBeNull();
    expect(p._objectMap.size).toBe(0);
  });

  test('DROP-then-DRAGEND: _dropCommitted makes setDragEntry(null) keep the node', async () => {
    const { plugin } = makePlugin();
    const p = internals(plugin);
    await p._startDraft(VIRTUAL_ENTRY);
    const node = p._draft!.node;

    // Simulate onDrop having marked the commit synchronously: the dragend-fired
    // setDragEntry(null) must NOT tear the draft down.
    p._dropCommitted = true;
    plugin.setDragEntry(null);

    expect(node.parent).not.toBeNull(); // draft survives
    expect(p._draft).not.toBeNull();
    expect(p._dropCommitted).toBe(false); // flag consumed
  });
});
