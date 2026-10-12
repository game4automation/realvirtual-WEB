// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-518 §9.3 — the persisted height of the Quick Edit kinematics list:
 * default without a value, clamp to [min, max], garbage and a throwing
 * localStorage fall back to the default.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KINEMATICS_LIST_HEIGHT,
  KINEMATICS_LIST_MAX_HEIGHT,
  KINEMATICS_LIST_MIN_HEIGHT,
  LS_KEY_KINEMATICS_LIST_HEIGHT,
  getStoredKinematicsListHeight,
} from '../src/core/hmi/layout-constants';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem(LS_KEY_KINEMATICS_LIST_HEIGHT);
});

describe('getStoredKinematicsListHeight', () => {
  it('returns default 320 without a stored value', () => {
    localStorage.removeItem(LS_KEY_KINEMATICS_LIST_HEIGHT);
    expect(KINEMATICS_LIST_HEIGHT).toBe(320);
    expect(LS_KEY_KINEMATICS_LIST_HEIGHT).toBe('rv-kinematics-list-height');
    expect(getStoredKinematicsListHeight()).toBe(320);
  });

  it('returns a stored value inside the bounds unchanged', () => {
    localStorage.setItem(LS_KEY_KINEMATICS_LIST_HEIGHT, '700');
    expect(getStoredKinematicsListHeight()).toBe(700);
  });

  it('clamps stored value to [min, max] and ignores NaN', () => {
    expect(KINEMATICS_LIST_MIN_HEIGHT).toBe(120);
    expect(KINEMATICS_LIST_MAX_HEIGHT).toBe(1200);
    localStorage.setItem(LS_KEY_KINEMATICS_LIST_HEIGHT, 'abc');
    expect(getStoredKinematicsListHeight()).toBe(320);
    localStorage.setItem(LS_KEY_KINEMATICS_LIST_HEIGHT, '50');
    expect(getStoredKinematicsListHeight()).toBe(120);
    localStorage.setItem(LS_KEY_KINEMATICS_LIST_HEIGHT, '5000');
    expect(getStoredKinematicsListHeight()).toBe(1200);
    localStorage.setItem(LS_KEY_KINEMATICS_LIST_HEIGHT, 'Infinity');
    expect(getStoredKinematicsListHeight()).toBe(320);
  });

  it('survives a throwing localStorage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
    expect(getStoredKinematicsListHeight()).toBe(320);
  });
});
