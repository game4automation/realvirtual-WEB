// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-signal-activity.test.ts — pure activity derivation (deriveSignalActivity).
 *
 * Covers all five states (live / supplied / stale / local / no-source) and the
 * connection-based `stale` rule: `stale` is caused ONLY by a disconnected
 * interface, never by a value that stopped changing.
 */
import { describe, it, expect } from 'vitest';
import { deriveSignalActivity } from '../src/core/engine/rv-signal-activity';

describe('deriveSignalActivity', () => {
  const base = { mode: 'live' as const };

  it('connected + written → live', () => {
    expect(
      deriveSignalActivity({ ...base, hasSource: true, sourceConnected: true, lastUpdateTs: 9_800 }),
    ).toBe('live');
  });

  it('connected + written long ago → still live (no freshness decay)', () => {
    // A static bool that has not changed in an hour stays live while connected.
    expect(
      deriveSignalActivity({ ...base, hasSource: true, sourceConnected: true, lastUpdateTs: 1 }),
    ).toBe('live');
  });

  it('connected + no update yet → supplied', () => {
    expect(
      deriveSignalActivity({ ...base, hasSource: true, sourceConnected: true, lastUpdateTs: undefined }),
    ).toBe('supplied');
  });

  it('source present but interface disconnected → stale', () => {
    expect(
      deriveSignalActivity({ ...base, hasSource: true, sourceConnected: false, lastUpdateTs: 9_900 }),
    ).toBe('stale');
  });

  it('disconnected is stale even with no prior update', () => {
    expect(
      deriveSignalActivity({ ...base, hasSource: true, sourceConnected: false, lastUpdateTs: undefined }),
    ).toBe('stale');
  });

  it('no source in live mode → no-source', () => {
    expect(
      deriveSignalActivity({ ...base, hasSource: false, sourceConnected: false, lastUpdateTs: undefined }),
    ).toBe('no-source');
  });

  it('no source in standalone → local (not dead)', () => {
    expect(
      deriveSignalActivity({
        ...base,
        mode: 'standalone',
        hasSource: false,
        sourceConnected: false,
        lastUpdateTs: 9_900,
      }),
    ).toBe('local');
  });

  it('no source in direct mode → no-source', () => {
    expect(
      deriveSignalActivity({
        ...base,
        mode: 'direct',
        hasSource: false,
        sourceConnected: false,
        lastUpdateTs: undefined,
      }),
    ).toBe('no-source');
  });

  it('direct mode + connected + written → live', () => {
    expect(
      deriveSignalActivity({
        ...base,
        mode: 'direct',
        hasSource: true,
        sourceConnected: true,
        lastUpdateTs: 9_900,
      }),
    ).toBe('live');
  });

  it('standalone WITH a connected source is live (not forced to local)', () => {
    expect(
      deriveSignalActivity({
        ...base,
        mode: 'standalone',
        hasSource: true,
        sourceConnected: true,
        lastUpdateTs: 9_800,
      }),
    ).toBe('live');
  });
});
