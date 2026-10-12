// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-760 §9.5 — the persisted height of the Quick Edit groups list:
 * default without a value, clamp to [min, max], garbage and a throwing
 * localStorage fall back to the default. Twin of the kinematics-list test.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GROUPS_LIST_HEIGHT,
  GROUPS_LIST_MAX_HEIGHT,
  GROUPS_LIST_MIN_HEIGHT,
  LS_KEY_GROUPS_LIST_HEIGHT,
  LS_KEY_KINEMATICS_LIST_HEIGHT,
  getStoredGroupsListHeight,
} from '../src/core/hmi/layout-constants';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem(LS_KEY_GROUPS_LIST_HEIGHT);
});

describe('getStoredGroupsListHeight', () => {
  it('returns default 240 without a stored value, under its own storage key', () => {
    localStorage.removeItem(LS_KEY_GROUPS_LIST_HEIGHT);
    expect(GROUPS_LIST_HEIGHT).toBe(240);
    expect(LS_KEY_GROUPS_LIST_HEIGHT).toBe('rv-groups-list-height');
    expect(LS_KEY_GROUPS_LIST_HEIGHT).not.toBe(LS_KEY_KINEMATICS_LIST_HEIGHT);
    expect(getStoredGroupsListHeight()).toBe(240);
  });

  it('returns a stored value inside the bounds unchanged', () => {
    localStorage.setItem(LS_KEY_GROUPS_LIST_HEIGHT, '500');
    expect(getStoredGroupsListHeight()).toBe(500);
  });

  it('clamps stored value to [min, max] and ignores NaN / Infinity', () => {
    expect(GROUPS_LIST_MIN_HEIGHT).toBe(120);
    expect(GROUPS_LIST_MAX_HEIGHT).toBe(1200);
    localStorage.setItem(LS_KEY_GROUPS_LIST_HEIGHT, 'abc');
    expect(getStoredGroupsListHeight()).toBe(240);
    localStorage.setItem(LS_KEY_GROUPS_LIST_HEIGHT, '50');
    expect(getStoredGroupsListHeight()).toBe(120);
    localStorage.setItem(LS_KEY_GROUPS_LIST_HEIGHT, '5000');
    expect(getStoredGroupsListHeight()).toBe(1200);
    localStorage.setItem(LS_KEY_GROUPS_LIST_HEIGHT, 'Infinity');
    expect(getStoredGroupsListHeight()).toBe(240);
  });

  it('survives a throwing localStorage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
    expect(getStoredGroupsListHeight()).toBe(240);
  });
});
