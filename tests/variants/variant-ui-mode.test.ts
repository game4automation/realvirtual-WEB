// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2013 Concept D — the "Variant management" mode preference.
 *
 * Codex's rule, asserted here: the decision is per user and per DOCUMENT, a document with
 * variants is ON without anyone switching it, and an explicit OFF survives a reload (the
 * per-session switch Claude first drafted would have shown the icons again).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  getVariantModeContext,
  rememberVariantMode,
  setVariantModeContext,
  subscribeVariantMode,
  variantModeActive,
  variantModeOf,
  variantModeVersion,
} from '../../src/core/hmi/rv-variant-ui-mode';

beforeEach(() => { localStorage.clear(); setVariantModeContext(null); });

describe('variant UI mode', () => {
  it('auto-on for a document with variants, off for one without', () => {
    expect(variantModeOf('a.glb', true)).toBe(true);
    expect(variantModeOf('b.glb', false)).toBe(false);
  });

  it('an explicit decision wins and survives — per document', () => {
    rememberVariantMode('a.glb', false, true);
    expect(variantModeOf('a.glb', true)).toBe(false);     // a reload reads the same answer
    expect(variantModeOf('c.glb', true)).toBe(true);      // another document is untouched

    rememberVariantMode('b.glb', true, false);
    expect(variantModeOf('b.glb', false)).toBe(true);
  });

  it('a decision equal to the default is forgotten rather than stored', () => {
    rememberVariantMode('a.glb', false, true);
    rememberVariantMode('a.glb', true, true);
    expect(JSON.parse(localStorage.getItem('rv-variants-ui-mode') ?? '{}')).toEqual({});
    expect(variantModeOf('a.glb', true)).toBe(true);
  });

  it('publishes context changes and resolves the open document', async () => {
    const seen: number[] = [];
    const off = subscribeVariantMode(() => seen.push(variantModeVersion()));
    expect(variantModeActive()).toBe(false);          // no document → no menu entry

    setVariantModeContext({ docKey: 'a.glb', hasVariants: true, setMode: async () => {} });
    expect(getVariantModeContext()?.docKey).toBe('a.glb');
    expect(variantModeActive()).toBe(true);
    rememberVariantMode('a.glb', false, true);
    expect(variantModeActive()).toBe(false);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    off();
  });

  it('unreadable storage reads as the default instead of throwing', () => {
    localStorage.setItem('rv-variants-ui-mode', 'not json');
    expect(variantModeOf('a.glb', true)).toBe(true);
    expect(variantModeOf('a.glb', false)).toBe(false);
  });
});
