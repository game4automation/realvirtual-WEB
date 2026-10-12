// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Persisted group visibility survives every model load, and the panel's
 * exclusion filter is observable (2026-09-24, Festo `Cover`).
 *
 * Two defects Codex and the field session agreed on: the restore ran only
 * from the Groups LIST, which is unmounted while the Display panel is closed,
 * so a group hidden in the editor came back after the switch to the HMI; and
 * the list's exclusion filter read localStorage inside a memo nobody
 * invalidated, so a group released from the filter stayed unlisted.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { GroupRegistry } from '../src/core/engine/rv-group-registry';
import { applyPersistedGroupVisibility } from '../src/core/hmi/GroupsListContent';
import {
  loadGroupVisibilitySettings, saveGroupVisibilitySettings, subscribeGroupVisibilitySettings,
} from '../src/core/hmi/group-visibility-store';
import type { RVViewer } from '../src/core/rv-viewer';

function registry(names: string[]): GroupRegistry {
  const g = new GroupRegistry();
  for (const n of names) { const node = new Object3D(); node.name = n + 'Part'; g.register(n, node); }
  return g;
}

function fakeViewer(groups: GroupRegistry): RVViewer & { shadows: number } {
  const v = { groups, autoFilters: null, shadows: 0, markShadowsDirty() { v.shadows++; }, markRenderDirty() {} };
  return v as unknown as RVViewer & { shadows: number };
}

describe('applyPersistedGroupVisibility', () => {
  beforeEach(() => { localStorage.removeItem('rv-group-visibility'); });

  it('re-hides the persisted hidden groups on a fresh registry (editor → HMI → editor)', () => {
    saveGroupVisibilitySettings({ ...loadGroupVisibilitySettings(), hiddenGroups: ['Cover'] });
    // HMI load: fresh registry, everything visible.
    const hmi = fakeViewer(registry(['Cover', 'AxisLeft_Travel']));
    applyPersistedGroupVisibility(hmi, { drivenKinematicGroupNames: ['AxisLeft_Travel'], kinematicGroupNames: ['AxisLeft_Travel'] });
    expect(hmi.groups!.get('Cover')!.visible).toBe(false);
    expect(hmi.groups!.get('AxisLeft_Travel')!.visible).toBe(true);
    expect(hmi.shadows).toBe(1);
    // Editor open: another fresh registry — still hidden.
    const editor = fakeViewer(registry(['Cover', 'AxisLeft_Travel']));
    applyPersistedGroupVisibility(editor, { drivenKinematicGroupNames: [], kinematicGroupNames: ['AxisLeft_Travel'] });
    expect(editor.groups!.get('Cover')!.visible).toBe(false);
  });

  it('auto-excludes only drive-moved kinematic groups and releases a legacy exclusion of a plain group', () => {
    // Legacy profile: the old rule excluded Cover; no auto record yet.
    saveGroupVisibilitySettings({ ...loadGroupVisibilitySettings(), excludedFromOverlay: ['Cover', 'AxisLeft_Travel', 'Manual'] });
    const v = fakeViewer(registry(['Cover', 'AxisLeft_Travel', 'Manual']));
    applyPersistedGroupVisibility(v, { drivenKinematicGroupNames: ['AxisLeft_Travel'], kinematicGroupNames: ['AxisLeft_Travel', 'Cover'] });
    const s = loadGroupVisibilitySettings();
    // Cover released; AxisLeft_Travel kept; Manual ALSO released once (it was
    // indistinguishable from an auto-exclusion in a legacy profile).
    expect(s.excludedFromOverlay).toEqual(['AxisLeft_Travel']);
    expect(s.autoExcludedKinematic).toEqual(['AxisLeft_Travel']);
    // From now on a manual exclusion is left alone.
    saveGroupVisibilitySettings({ ...loadGroupVisibilitySettings(), excludedFromOverlay: ['AxisLeft_Travel', 'Manual'] });
    applyPersistedGroupVisibility(v, { drivenKinematicGroupNames: ['AxisLeft_Travel'], kinematicGroupNames: ['AxisLeft_Travel'] });
    expect(loadGroupVisibilitySettings().excludedFromOverlay).toEqual(['AxisLeft_Travel', 'Manual']);
  });

  it('a driven group the user excluded by hand stays excluded when it loses its drive', () => {
    // Record exists (non-legacy); the user excluded Cover manually, nothing auto.
    saveGroupVisibilitySettings({ ...loadGroupVisibilitySettings(), excludedFromOverlay: ['Cover'], autoExcludedKinematic: [] });
    const v = fakeViewer(registry(['Cover']));
    // Cover is driven now: it must NOT become auto-owned (it was excluded before).
    applyPersistedGroupVisibility(v, { drivenKinematicGroupNames: ['Cover'], kinematicGroupNames: ['Cover'] });
    expect(loadGroupVisibilitySettings().autoExcludedKinematic).toEqual([]);
    // Cover loses its drive: the manual exclusion survives.
    applyPersistedGroupVisibility(v, { drivenKinematicGroupNames: [], kinematicGroupNames: [] });
    expect(loadGroupVisibilitySettings().excludedFromOverlay).toEqual(['Cover']);
  });

  it('drops a malformed autoExcludedKinematic on load instead of throwing later', () => {
    localStorage.setItem('rv-group-visibility', JSON.stringify({ hiddenGroups: ['Cover'], isolatedGroup: null, autoExcludedKinematic: 'nope' }));
    const s = loadGroupVisibilitySettings();
    expect(s.autoExcludedKinematic).toBeUndefined();
    const v = fakeViewer(registry(['Cover']));
    expect(() => applyPersistedGroupVisibility(v)).not.toThrow();
    expect(v.groups!.get('Cover')!.visible).toBe(false);
  });

  it('is idempotent on the same registry', () => {
    saveGroupVisibilitySettings({ ...loadGroupVisibilitySettings(), hiddenGroups: ['Cover'] });
    const v = fakeViewer(registry(['Cover']));
    applyPersistedGroupVisibility(v);
    const once = JSON.stringify(loadGroupVisibilitySettings());
    applyPersistedGroupVisibility(v);
    expect(JSON.stringify(loadGroupVisibilitySettings())).toBe(once);
    expect(v.groups!.get('Cover')!.visible).toBe(false);
  });
});

describe('subscribeGroupVisibilitySettings', () => {
  it('fires after every save and stops after unsubscribe', () => {
    let n = 0;
    const off = subscribeGroupVisibilitySettings(() => { n++; });
    saveGroupVisibilitySettings(loadGroupVisibilitySettings());
    expect(n).toBe(1);
    off();
    saveGroupVisibilitySettings(loadGroupVisibilitySettings());
    expect(n).toBe(1);
  });
});
