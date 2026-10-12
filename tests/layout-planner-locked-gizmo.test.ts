// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * A locked placement (`LayoutObject.Locked`) must never get the transform
 * gizmo.
 *
 * The viewport pick filter keeps locked placements out of hover and click,
 * but a selection can also arrive from the hierarchy panel or a box-select —
 * and with the hierarchy's lock glyph that is the normal way to reach one.
 * All routes converge in the planner's gizmo sync, so the lock is enforced
 * there: a locked single selection detaches, a locked member of a multi
 * selection is left out of the pivot and stays put.
 *
 * `LayoutObject` is metadata, not a registered component, so the planner
 * cannot hear a lock through `component-field-changed`; the extras editor
 * emits `layout-lock-changed` from its one write path instead, and the
 * planner re-runs the same sync on it.
 */
import { describe, it, expect, vi } from 'vitest';
import { Group, Object3D, Scene } from 'three';
import { LayoutPlannerPlugin } from '../src/plugins/layout-planner';
import { RvExtrasEditorPlugin } from '../src/core/hmi/rv-extras-editor';

function placement(name: string, locked: boolean): Group {
  const g = new Group();
  g.name = name;
  g.userData.realvirtual = { LayoutObject: { Label: name, CatalogId: 'x', Locked: locked } };
  g.userData._layoutId = `id-${name}`; // what makes it a planner placement (isLayoutInstance)
  return g;
}

/** A planner with just enough private state for the gizmo sync to run. */
function plannerWith(nodes: Record<string, Object3D>) {
  const scene = new Scene();
  for (const n of Object.values(nodes)) scene.add(n);
  const tc = { attach: vi.fn(), detach: vi.fn(), setTranslationSnap: vi.fn(), setRotationSnap: vi.fn(), isDragging: false };
  const viewer = {
    scene,
    registry: { getNode: (p: string) => nodes[p] ?? null },
    selectionManager: { getSnapshot: () => snap },
  };
  let snap = { selectedPaths: [] as string[], primaryPath: null as string | null };
  const plugin = new LayoutPlannerPlugin();
  const p = plugin as unknown as {
    _viewer: unknown; _transformControls: unknown; _active: boolean;
    _syncTransformControlsToSelection(s: unknown): void;
  };
  p._viewer = viewer;
  p._transformControls = tc;
  p._active = true;
  const select = (...paths: string[]) => {
    snap = { selectedPaths: paths, primaryPath: paths[paths.length - 1] ?? null };
    p._syncTransformControlsToSelection(snap);
  };
  return { tc, select, scene };
}

describe('planner gizmo sync honours LayoutObject.Locked', () => {
  it('attaches the gizmo to an unlocked single selection (control)', () => {
    const cell = placement('Cell_2', false);
    const { tc, select } = plannerWith({ 'Layout/Cell_2': cell });
    select('Layout/Cell_2');
    expect(tc.attach).toHaveBeenCalledWith(cell);
  });

  it('detaches instead of attaching when the single selection is locked', () => {
    const cell = placement('Cell_1', true);
    const { tc, select } = plannerWith({ 'Layout/Cell_1': cell });
    select('Layout/Cell_1');
    expect(tc.attach).not.toHaveBeenCalled();
    expect(tc.detach).toHaveBeenCalled();
  });

  it('leaves the locked member out of a multi selection — the other one gets a plain attach', () => {
    const locked = placement('Cell_1', true);
    const free = placement('Cell_2', false);
    const { tc, select } = plannerWith({ 'Layout/Cell_1': locked, 'Layout/Cell_2': free });
    select('Layout/Cell_1', 'Layout/Cell_2');
    // One movable member → no centroid pivot, the gizmo sits on the free one.
    expect(tc.attach).toHaveBeenCalledTimes(1);
    expect(tc.attach).toHaveBeenCalledWith(free);
  });

  it('takes the gizmo away when the selected placement is locked afterwards', () => {
    const cell = placement('Cell_1', false);
    const { tc, select } = plannerWith({ 'Layout/Cell_1': cell });
    select('Layout/Cell_1');
    expect(tc.attach).toHaveBeenCalledWith(cell);
    tc.attach.mockClear(); tc.detach.mockClear();

    (cell.userData.realvirtual as { LayoutObject: { Locked: boolean } }).LayoutObject.Locked = true;
    select('Layout/Cell_1'); // what the `layout-lock-changed` listener re-runs
    expect(tc.attach).not.toHaveBeenCalled();
    expect(tc.detach).toHaveBeenCalled();
  });
});

describe('extras editor announces lock writes', () => {
  it('emits layout-lock-changed for LayoutObject.Locked and for nothing else', () => {
    const cell = placement('Cell_1', false);
    const emit = vi.fn();
    const plugin = new RvExtrasEditorPlugin();
    (plugin as unknown as { _viewer: unknown })._viewer = {
      registry: {
        getNode: (p: string) => (p === 'Layout/Cell_1' ? cell : null),
        getPathForNode: (n: Object3D) => (n === cell ? 'Layout/Cell_1' : null),
      },
      emit,
    };

    expect(plugin.updateOverlayField('Layout/Cell_1', 'LayoutObject', 'Locked', true)).toBe(true);
    expect(emit).toHaveBeenCalledWith('layout-lock-changed', { path: 'Layout/Cell_1', locked: true });
    expect((cell.userData.realvirtual as { LayoutObject: { Locked: boolean } }).LayoutObject.Locked).toBe(true);

    emit.mockClear();
    plugin.updateOverlayField('Layout/Cell_1', 'LayoutObject', 'Locked', false);
    expect(emit).toHaveBeenCalledWith('layout-lock-changed', { path: 'Layout/Cell_1', locked: false });

    emit.mockClear();
    plugin.updateOverlayField('Layout/Cell_1', 'LayoutObject', 'Label', 'Renamed');
    expect(emit).not.toHaveBeenCalledWith('layout-lock-changed', expect.anything());
  });
});
