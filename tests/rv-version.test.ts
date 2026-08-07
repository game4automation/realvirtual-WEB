// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import {
  RV_VERSION,
  formatVersionShort,
  formatVersionFull,
  type RVVersionInfo,
} from '../src/core/rv-version';

const FULL: RVVersionInfo = {
  version: '6.3.0',
  webBuild: '1247',
  commit: 'a1b2c3d',
  buildDate: '2026-07-01',
};

describe('rv-version formatting', () => {
  it('formats the short label', () => {
    expect(formatVersionShort(FULL)).toBe('v6.3.0 · build 1247');
  });

  it('formats the full label with commit and date', () => {
    expect(formatVersionFull(FULL)).toBe('v6.3.0 · web build 1247 (a1b2c3d) · 2026-07-01');
  });

  it('omits the commit segment when unavailable', () => {
    expect(formatVersionFull({ ...FULL, commit: '' }))
      .toBe('v6.3.0 · web build 1247 · 2026-07-01');
  });

  it('omits the date segment when unavailable', () => {
    expect(formatVersionFull({ ...FULL, buildDate: '' }))
      .toBe('v6.3.0 · web build 1247 (a1b2c3d)');
  });

  it('exposes the injected build constants at runtime', () => {
    // Values come from Vite `define`; assert shape, not exact (build-dependent) values.
    expect(typeof RV_VERSION.version).toBe('string');
    expect(RV_VERSION.version.length).toBeGreaterThan(0);
    expect(typeof RV_VERSION.webBuild).toBe('string');
    expect(typeof RV_VERSION.commit).toBe('string');
    expect(typeof RV_VERSION.buildDate).toBe('string');
  });
});
