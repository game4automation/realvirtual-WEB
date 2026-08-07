// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Exercises the persisted-blob parse/filter path of the overlay-visibility
 * store via the pure exported `parseStoredHidden` — the module singleton caches
 * its hidden set at eval time, so the load path is tested through the pure
 * function directly (vi.resetModules does not re-run module init in the vitest
 * browser provider).
 */

import { describe, it, expect } from 'vitest';
import { parseStoredHidden } from '../src/core/overlay-visibility-store';

describe('parseStoredHidden', () => {
  it('returns [] for null / empty (all visible)', () => {
    expect(parseStoredHidden(null)).toEqual([]);
    expect(parseStoredHidden('')).toEqual([]);
  });

  it('keeps valid category ids', () => {
    expect(parseStoredHidden(JSON.stringify({ hidden: ['signals', 'status'] })))
      .toEqual(['signals', 'status']);
  });

  it('drops unknown ids (forward-compat)', () => {
    const out = parseStoredHidden(JSON.stringify({ hidden: ['signals', 'bogus', 'gizmos'] }));
    expect(out).toContain('signals');
    expect(out).toContain('gizmos');
    expect(out).not.toContain('bogus');
  });

  it('ignores a non-array hidden field', () => {
    expect(parseStoredHidden(JSON.stringify({ hidden: 'signals' }))).toEqual([]);
    expect(parseStoredHidden(JSON.stringify({ hidden: 42 }))).toEqual([]);
  });

  it('returns [] on corrupt JSON (no throw)', () => {
    expect(parseStoredHidden('{ not valid json')).toEqual([]);
  });

  it('returns [] when hidden is absent', () => {
    expect(parseStoredHidden(JSON.stringify({ other: 1 }))).toEqual([]);
  });
});
