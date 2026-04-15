// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadGroupVisibilitySettings,
  saveGroupVisibilitySettings,
} from '../src/core/hmi/group-visibility-store';

describe('Group Visibility Store', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns empty defaults when no saved state', () => {
    const state = loadGroupVisibilitySettings();
    expect(state.hiddenGroups).toEqual([]);
    expect(state.isolatedGroup).toBeNull();
  });

  it('round-trips hidden groups', () => {
    saveGroupVisibilitySettings({ hiddenGroups: ['A', 'B'], isolatedGroup: null });
    const loaded = loadGroupVisibilitySettings();
    expect(loaded.hiddenGroups).toEqual(['A', 'B']);
  });

  it('round-trips isolated group', () => {
    saveGroupVisibilitySettings({ hiddenGroups: [], isolatedGroup: 'Robots' });
    const loaded = loadGroupVisibilitySettings();
    expect(loaded.isolatedGroup).toBe('Robots');
  });

  it('handles corrupted localStorage gracefully', () => {
    localStorage.setItem('rv-group-visibility', '{invalid json');
    const state = loadGroupVisibilitySettings();
    expect(state.hiddenGroups).toEqual([]);
    expect(state.isolatedGroup).toBeNull();
  });

  it('loads excludedFromOverlay with backward compat', () => {
    localStorage.setItem('rv-group-visibility', JSON.stringify({
      hiddenGroups: ['A'], isolatedGroup: null
      // no excludedFromOverlay or defaultHiddenGroups
    }));
    const settings = loadGroupVisibilitySettings();
    expect(settings.excludedFromOverlay).toEqual([]);
    expect(settings.defaultHiddenGroups).toEqual([]);
  });

  it('saves and loads new group config fields', () => {
    saveGroupVisibilitySettings({
      hiddenGroups: [],
      isolatedGroup: null,
      excludedFromOverlay: ['Fences'],
      defaultHiddenGroups: ['CNCDoor'],
    });
    const loaded = loadGroupVisibilitySettings();
    expect(loaded.excludedFromOverlay).toEqual(['Fences']);
    expect(loaded.defaultHiddenGroups).toEqual(['CNCDoor']);
  });
});
