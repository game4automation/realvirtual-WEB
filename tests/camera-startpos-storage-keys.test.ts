// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach } from 'vitest';
import { clearAllRVStorage, RV_DYNAMIC_PREFIXES } from '../src/core/hmi/rv-storage-keys';
import { saveStartPos } from '../src/core/hmi/camera-startpos-store';

describe('rv-storage-keys — camera-start integration (F8)', () => {
  beforeEach(() => localStorage.clear());

  it('registers rv-camera-start: prefix', () => {
    expect(RV_DYNAMIC_PREFIXES).toContain('rv-camera-start:');
  });

  it('clearAllRVStorage removes all rv-camera-start:* keys', () => {
    saveStartPos('A', { px: 1, py: 1, pz: 1, tx: 0, ty: 1, tz: 0 });
    saveStartPos('B', { px: 2, py: 2, pz: 2, tx: 0, ty: 1, tz: 0 });
    clearAllRVStorage();
    expect(localStorage.getItem('rv-camera-start:A')).toBeNull();
    expect(localStorage.getItem('rv-camera-start:B')).toBeNull();
  });

  it('preserves unrelated keys', () => {
    localStorage.setItem('keep-me', 'value');
    saveStartPos('X', { px: 1, py: 1, pz: 1, tx: 0, ty: 1, tz: 0 });
    clearAllRVStorage();
    expect(localStorage.getItem('keep-me')).toBe('value');
  });
});
