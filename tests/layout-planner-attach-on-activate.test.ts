// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-753 Phase 5 — entering planner mode attaches the plugin to the viewer.
 *
 * `onModelLoaded` used to be the only path that set `_viewer`. A page reload
 * into a document WITHOUT a GLB load (empty document, `?mode=planner`) entered
 * planner mode with `_viewer === null`: `placeComponent` threw "Viewer not
 * initialized", `web_mode_set planner` was a no-op, and only
 * `web_document_open(<same document>)` repaired the state (reproduced three
 * times, 2026-09-16/17). `onModeActivate` now attaches as well.
 *
 * The attach is guarded on viewer identity, so the normal path (model loaded,
 * then planner mode entered) must NOT run the host-scene setup a second time.
 */
import { describe, it, expect, vi } from 'vitest';
import { Group } from 'three';

import { LayoutPlannerPlugin } from '../src/plugins/layout-planner';
import type { ModelCache } from '../src/plugins/layout-planner/model-cache';
import {
  createControllableCache,
  createGizmoRecorder,
  createMockViewer,
  GLB_ENTRY,
} from './_layout-planner-async-harness';

const AUTOSAVE_KEY = 'rv-layout-autosave';

/** A planner that has NOT seen `onModelLoaded` — the reload-into-empty-document case. */
function plannerWithoutModel() {
  localStorage.removeItem(AUTOSAVE_KEY);
  const viewer = createMockViewer(createGizmoRecorder());
  // `setActive(true)` (run by onModeActivate) swaps the raycast allow filter;
  // the shared mock only covers what onModelLoaded touches.
  const rm = viewer.raycastManager as typeof viewer.raycastManager & {
    getAllowFilter: ReturnType<typeof vi.fn>;
    setAllowFilter: ReturnType<typeof vi.fn>;
  };
  rm.getAllowFilter = vi.fn(() => null);
  rm.setAllowFilter = vi.fn();
  const plugin = new LayoutPlannerPlugin();
  const cache = createControllableCache();
  plugin.placements.setModelCache(cache.cache);
  plugin.store.setDropToSurface(true);
  plugin.store.setGridEnabled(false);
  return { plugin, viewer };
}

describe('plan-753 Phase 5 — planner attaches on mode activation', () => {
  it('control: without any attach path placeComponent throws "Viewer not initialized"', async () => {
    const { plugin } = plannerWithoutModel();
    await expect(plugin.placeComponent(GLB_ENTRY, [0, 0, 0])).rejects.toThrow('Viewer not initialized');
  });

  it('onModeActivate without a prior onModelLoaded attaches — placeComponent succeeds', async () => {
    const { plugin, viewer } = plannerWithoutModel();

    plugin.onModeActivate('planner', viewer as never);

    const id = await plugin.placeComponent(GLB_ENTRY, [0, 0, 0]);
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    // The host-scene setup really ran: layout root in the scene, ghost/floor
    // exclude filter registered.
    expect(viewer.raycastManager.addExcludeFilter).toHaveBeenCalledTimes(1);
    expect(viewer.scene.children.some(c => c.userData._isLayoutRoot)).toBe(true);

    plugin.setActive(false);
  });

  it('onModeActivate after onModelLoaded does NOT re-run the host-scene setup', () => {
    const { plugin, viewer } = plannerWithoutModel();
    plugin.onModelLoaded?.({ scene: new Group() } as never, viewer as never);
    expect(viewer.raycastManager.addExcludeFilter).toHaveBeenCalledTimes(1);

    plugin.onModeActivate('planner', viewer as never);

    expect(viewer.raycastManager.addExcludeFilter).toHaveBeenCalledTimes(1);
    plugin.setActive(false);
  });
});
