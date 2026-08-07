// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * projects-dashboard-store — open state and selection for the Projects
 * dashboard (plan-372 Phase 7).
 *
 * The snapshot-identity case is the important one: this store feeds
 * `useSyncExternalStore`, and a fresh object per read is an infinite render
 * loop, not a cosmetic issue (§2.6.4).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  closeProjectsDashboard,
  getProjectsDashboardSnapshot,
  openProjectsDashboard,
  resetProjectsDashboardForTests,
  setProjectsChip,
  setProjectsRailGroup,
  setProjectsSearch,
  setProjectsSelection,
  subscribeProjectsDashboard,
  toggleProjectsDashboard,
} from '../src/core/hmi/projects/projects-dashboard-store';

beforeEach(() => resetProjectsDashboardForTests());

describe('snapshot identity', () => {
  it('returns the identical object until something changes', () => {
    const a = getProjectsDashboardSnapshot();
    expect(getProjectsDashboardSnapshot()).toBe(a);
    openProjectsDashboard();
    const b = getProjectsDashboardSnapshot();
    expect(b).not.toBe(a);
    expect(getProjectsDashboardSnapshot()).toBe(b);
  });
});

describe('open / close / toggle', () => {
  it('starts closed and toggles both ways', () => {
    expect(getProjectsDashboardSnapshot().open).toBe(false);
    toggleProjectsDashboard();
    expect(getProjectsDashboardSnapshot().open).toBe(true);
    toggleProjectsDashboard();
    expect(getProjectsDashboardSnapshot().open).toBe(false);
  });

  it('can open directly onto a rail group', () => {
    openProjectsDashboard({ kind: 'scenes' });
    expect(getProjectsDashboardSnapshot().group).toEqual({ kind: 'scenes' });
  });

  it('clears transient view state on close but keeps the rail group', () => {
    openProjectsDashboard({ kind: 'library', sourceId: 'lib1' });
    setProjectsSearch('belt');
    setProjectsChip('conveyor');
    setProjectsSelection({ kind: 'scene', sceneId: 's1' });

    closeProjectsDashboard();
    const s = getProjectsDashboardSnapshot();
    expect(s.open).toBe(false);
    expect(s.search).toBe('');
    expect(s.chip).toBeNull();
    expect(s.selection).toEqual({ kind: 'none' });
    // The group survives so reopening lands where the user left off.
    expect(s.group).toEqual({ kind: 'library', sourceId: 'lib1' });
  });
});

describe('selection', () => {
  it('drops the selection and the chip when the rail group changes', () => {
    openProjectsDashboard();
    setProjectsSelection({ kind: 'scene', sceneId: 's1' });
    setProjectsChip('robot');
    setProjectsRailGroup({ kind: 'models' });
    const s = getProjectsDashboardSnapshot();
    expect(s.selection).toEqual({ kind: 'none' });
    expect(s.chip).toBeNull();
  });

  it('carries the full provider identity for an asset selection', () => {
    setProjectsSelection({ kind: 'asset', providerId: 'core', sourceId: 'lib', assetId: 'a1' });
    expect(getProjectsDashboardSnapshot().selection).toEqual({
      kind: 'asset', providerId: 'core', sourceId: 'lib', assetId: 'a1',
    });
  });
});

describe('subscribers', () => {
  it('notifies on change and stops after unsubscribe', () => {
    let calls = 0;
    const unsub = subscribeProjectsDashboard(() => { calls++; });
    openProjectsDashboard();
    setProjectsSearch('x');
    expect(calls).toBe(2);
    unsub();
    setProjectsSearch('y');
    expect(calls).toBe(2);
  });

  it('a throwing subscriber never blocks the others', () => {
    let reached = false;
    subscribeProjectsDashboard(() => { throw new Error('boom'); });
    subscribeProjectsDashboard(() => { reached = true; });
    expect(() => openProjectsDashboard()).not.toThrow();
    expect(reached).toBe(true);
  });
});
