// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-760 F15 — the Display panel does not persist group visibility while
 * the asset editor is active.
 *
 * Rule: Quick Edit = live, Display panel = persisted. The editor's Quick Edit
 * lists hide / isolate groups for the session only (and the armed Auto Assign
 * target is hidden by the editor itself); closing the Display panel inside
 * the editor must not write that transient state into `rv-group-visibility`,
 * where every later HMI load would restore it. Outside the editor the close
 * persists exactly as before.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D } from 'three';
import { GroupRegistry } from '../src/core/engine/rv-group-registry';
import { closeGroupsOverlay } from '../src/core/hmi/GroupsOverlay';
import { setActiveAssetContext, getActiveAssetContext, type ActiveAssetContext } from '../src/core/editor/active-asset-store';
import { loadGroupVisibilitySettings } from '../src/core/hmi/group-visibility-store';
import { installMemoryLocalStorage } from './helpers/memory-local-storage';
import type { RVViewer } from '../src/core/rv-viewer';

const LS_KEY = 'rv-group-visibility';

function registry(names: string[]): GroupRegistry {
  const g = new GroupRegistry();
  for (const n of names) { const node = new Object3D(); node.name = n + 'Part'; g.register(n, node); }
  return g;
}

function fakeViewer(groups: GroupRegistry): RVViewer & { toggled: Array<boolean | undefined> } {
  const v = {
    groups,
    autoFilters: null,
    toggled: [] as Array<boolean | undefined>,
    toggleGroupsOverlay(force?: boolean) { v.toggled.push(force); },
    markShadowsDirty() {},
    markRenderDirty() {},
  };
  return v as unknown as RVViewer & { toggled: Array<boolean | undefined> };
}

describe('closeGroupsOverlay — persist guard while the asset editor is active (plan-760 F15)', () => {
  const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let ls: Storage;

  beforeEach(() => {
    ls = installMemoryLocalStorage();
    setActiveAssetContext(null);
  });

  afterEach(() => {
    setActiveAssetContext(null);
    if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  });

  it('case A: editor active → close toggles the panel but writes nothing', () => {
    const viewer = fakeViewer(registry(['Cover', 'Axis1']));
    viewer.groups!.setVisible('Cover', false);          // a live Quick Edit hide
    viewer.groups!.isolate('Axis1');                    // and a live isolate
    setActiveAssetContext({ viewer, doc: {} } as unknown as ActiveAssetContext);

    closeGroupsOverlay(viewer);

    expect(viewer.toggled).toEqual([false]);
    expect(ls.length).toBe(0);
    expect(ls.getItem(LS_KEY)).toBeNull();
  });

  it('case A keeps an existing profile untouched (no rewrite, no merge)', () => {
    const before = JSON.stringify({ hiddenGroups: ['Fence'], isolatedGroup: null });
    ls.setItem(LS_KEY, before);
    const viewer = fakeViewer(registry(['Cover', 'Fence']));
    viewer.groups!.setVisible('Cover', false);
    setActiveAssetContext({ viewer, doc: {} } as unknown as ActiveAssetContext);

    closeGroupsOverlay(viewer);

    expect(ls.getItem(LS_KEY)).toBe(before);
    expect(loadGroupVisibilitySettings().hiddenGroups).toEqual(['Fence']);
  });

  it('case B: editor not active → close persists hidden and isolated state as before', () => {
    const viewer = fakeViewer(registry(['Cover', 'Axis1']));
    viewer.groups!.setVisible('Cover', false);
    expect(getActiveAssetContext()).toBeNull();

    closeGroupsOverlay(viewer);

    expect(viewer.toggled).toEqual([false]);
    expect(ls.length).toBe(1);
    const saved = loadGroupVisibilitySettings();
    expect(saved.hiddenGroups).toEqual(['Cover']);
    expect(saved.isolatedGroup).toBeNull();

    viewer.groups!.isolate('Axis1');
    closeGroupsOverlay(viewer);
    expect(loadGroupVisibilitySettings().isolatedGroup).toBe('Axis1');
  });

  it('the guard follows the context: persisting resumes once the editor is closed', () => {
    const viewer = fakeViewer(registry(['Cover']));
    viewer.groups!.setVisible('Cover', false);
    setActiveAssetContext({ viewer, doc: {} } as unknown as ActiveAssetContext);
    closeGroupsOverlay(viewer);
    expect(ls.length).toBe(0);

    setActiveAssetContext(null);
    closeGroupsOverlay(viewer);
    expect(loadGroupVisibilitySettings().hiddenGroups).toEqual(['Cover']);
  });
});
