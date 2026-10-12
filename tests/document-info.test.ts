// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-506 §9.1 — the `DocumentInfo` leaf module: parse, payload, normalise,
 * equality. Template: `document-classification.test.ts`.
 *
 * The block can come from a stranger's GLB, so "never throws" and "unknown
 * version reads as absent" are the load-bearing claims; the two equalities are
 * the other one — text equality for the editor's blur diff, stamp-inclusive
 * equality for the manifest cache (F15).
 */

import { describe, it, expect } from 'vitest';
import {
  documentInfoCacheEquals,
  documentInfoEquals,
  documentInfoPayload,
  isEmptyDocumentInfo,
  MAX_DESCRIPTION_CHARS,
  MAX_SUMMARY_CHARS,
  normaliseDocumentInfo,
  parseDocumentInfo,
} from '../src/core/project/rv-document-info';

describe('plan-506 §9.1 — DocumentInfo round trip', () => {
  it('parses a v1 block and drops empty fields on payload', () => {
    const info = parseDocumentInfo({ DocumentInfo: { v: 1, summary: ' Presse ', description: '' } });
    expect(info?.summary).toBe('Presse');
    expect(documentInfoPayload(info!)).toEqual({ v: 1, summary: 'Presse' });
  });

  it('returns null for v !== 1, non-objects and missing key, never throws', () => {
    for (const bad of [{ DocumentInfo: { v: 2 } }, { DocumentInfo: 'x' }, {}, null, 42,
      { DocumentInfo: [] }, { DocumentInfo: { v: 1 } }, { DocumentInfo: { v: 1, summary: '   ' } }]) {
      expect(parseDocumentInfo(bad)).toBeNull();
    }
  });

  it('drops wrongly-typed fields individually', () => {
    const info = parseDocumentInfo({ DocumentInfo: { v: 1, summary: 7, description: 'Text', updatedAt: {} } });
    expect(info).toEqual({ v: 1, description: 'Text' });
  });

  it('normalises CRLF to LF and enforces limits', () => {
    const info = normaliseDocumentInfo({ v: 1, description: 'a\r\nb'.padEnd(30_000, 'x') })!;
    expect(info.description).not.toContain('\r');
    expect(info.description!.length).toBe(MAX_DESCRIPTION_CHARS);
  });

  it('keeps the summary on one line and within its bound', () => {
    const info = normaliseDocumentInfo({ v: 1, summary: 'one\r\ntwo\nthree ' + 'y'.repeat(400) })!;
    expect(info.summary).not.toMatch(/[\r\n]/);
    expect(info.summary!.startsWith('one two three')).toBe(true);
    expect(info.summary!.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
  });

  it('a block with only stamps is empty', () => {
    expect(normaliseDocumentInfo({ v: 1, updatedAt: '2026-09-26T10:00:00Z' })).toBeNull();
    expect(isEmptyDocumentInfo({ v: 1, summary: ' ' })).toBe(true);
    expect(isEmptyDocumentInfo(null)).toBe(true);
    expect(isEmptyDocumentInfo({ v: 1, description: 'x' })).toBe(false);
  });

  it('equals ignores updatedAt/updatedBy', () => {
    const a = { v: 1 as const, summary: 'S', description: 'D', updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'A' };
    const b = { v: 1 as const, summary: ' S ', description: 'D', updatedAt: '2026-09-26T00:00:00Z' };
    expect(documentInfoEquals(a, b)).toBe(true);
    expect(documentInfoEquals(a, { ...a, description: 'E' })).toBe(false);
    expect(documentInfoEquals(null, { v: 1 })).toBe(true);
    expect(documentInfoEquals(null, a)).toBe(false);
  });

  it('cache equality includes the stamps (F15)', () => {
    const a = { v: 1 as const, summary: 'S', updatedAt: '2026-01-01T00:00:00Z' };
    expect(documentInfoCacheEquals(a, { ...a })).toBe(true);
    expect(documentInfoCacheEquals(a, { ...a, updatedAt: '2026-02-01T00:00:00Z' })).toBe(false);
    expect(documentInfoCacheEquals(a, { ...a, updatedBy: 'Thomas' })).toBe(false);
    expect(documentInfoCacheEquals(undefined, null)).toBe(true);
    expect(documentInfoCacheEquals(a, null)).toBe(false);
  });
});
