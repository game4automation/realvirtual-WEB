// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-363 Phase 8 — "a newer CONNECT exists", as a pure comparison.
 *
 * The cases the plan names as the acceptance raster: equal / newer / older / an unparsable version
 * on either side / an unreachable manifest / `updateSupported: false` with a reason. Plus the one
 * property the whole feature stands on — the comparison is semantic, so `6.3.10` beats `6.3.9`
 * instead of losing to it the way a string comparison would.
 */

import { describe, it, expect } from 'vitest';
import {
  compareVersions,
  parseVersionSegments,
  resolveUpdateAvailability,
} from '../src/core/hmi/connect-update-available';
import type { ConnectChannelInfo } from '../src/core/hmi/connect-downloads';

function channel(version: string | null): ConnectChannelInfo {
  return {
    url: 'https://web.realvirtual.io/download/realvirtual-Connect.exe',
    version,
    build: 31,
    buildDate: '2026-08-01',
  };
}

function input(partial: Partial<Parameters<typeof resolveUpdateAvailability>[0]> = {}) {
  return {
    runningVersion: '6.3.9',
    available: channel('6.3.10'),
    updateSupported: true,
    updateReason: null,
    ...partial,
  };
}

describe('compareVersions', () => {
  it('compares numerically, not lexicographically', () => {
    expect(compareVersions('6.3.10', '6.3.9')).toBe(1);
    expect(compareVersions('6.3.9', '6.3.10')).toBe(-1);
    expect(compareVersions('6.10.0', '6.9.99')).toBe(1);
  });

  it('treats missing segments as zero', () => {
    expect(compareVersions('6.3', '6.3.0')).toBe(0);
    expect(compareVersions('6.3.1', '6.3')).toBe(1);
  });

  it('ignores a leading v and any prerelease/build metadata', () => {
    expect(parseVersionSegments('v6.3.10')).toEqual([6, 3, 10]);
    expect(compareVersions('6.4.0-beta.1', '6.4.0')).toBe(0);
    expect(compareVersions('6.4.0+ci7', '6.4.0')).toBe(0);
  });

  it('reports an unreadable version instead of guessing', () => {
    expect(compareVersions('nightly', '6.3.9')).toBeNull();
    expect(compareVersions('6.3.9', '')).toBeNull();
    expect(parseVersionSegments('6.x.1')).toBeNull();
  });
});

describe('resolveUpdateAvailability', () => {
  it('says nothing when the running version equals the available one', () => {
    expect(resolveUpdateAvailability(input({ available: channel('6.3.9') }))).toBeNull();
  });

  it('says nothing when the offered build is older — an update never points backwards', () => {
    expect(resolveUpdateAvailability(input({ available: channel('6.3.8') }))).toBeNull();
  });

  it('announces a newer build with both versions and the download it refers to', () => {
    const hint = resolveUpdateAvailability(input());
    expect(hint).toEqual({
      runningVersion: '6.3.9',
      availableVersion: '6.3.10',
      downloadUrl: 'https://web.realvirtual.io/download/realvirtual-Connect.exe',
      supported: true,
      reasonSentence: null,
    });
  });

  it('says nothing when either version cannot be parsed', () => {
    expect(resolveUpdateAvailability(input({ runningVersion: 'dev' }))).toBeNull();
    expect(resolveUpdateAvailability(input({ available: channel('latest') }))).toBeNull();
  });

  it('says nothing while the manifest is unreachable — an offline channel is not a fault', () => {
    expect(resolveUpdateAvailability(input({ available: null }))).toBeNull();
    expect(resolveUpdateAvailability(input({ available: channel(null) }))).toBeNull();
  });

  it('says nothing when no gateway answered yet', () => {
    expect(resolveUpdateAvailability(input({ runningVersion: '' }))).toBeNull();
  });

  it('still announces the newer build when the gateway cannot update itself, and names the reason', () => {
    const hint = resolveUpdateAvailability(input({
      updateSupported: false,
      updateReason: 'no-write-permission',
    }));
    expect(hint?.supported).toBe(false);
    expect(hint?.reasonSentence).toContain('own program directory');
  });

  it('leaves the reason empty when an older gateway names none, so the caller can offer the download', () => {
    const hint = resolveUpdateAvailability(input({ updateSupported: false, updateReason: null }));
    expect(hint?.supported).toBe(false);
    expect(hint?.reasonSentence).toBeNull();
    expect(hint?.downloadUrl).toContain('realvirtual-Connect.exe');
  });
});
