// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * library-sidecar — READING the legacy `library.json`
 * (plan-372 §2.6.5 Phase 9, reduced by plan-717 Phase 4).
 *
 * The parsing tests are all that is left, and they always carried the weight. A
 * sidecar is derived convenience, so the rule is: unusable input is ignored,
 * never thrown on — one bad character must not take a whole library offline.
 *
 * The mutation cases went with the API they exercised. `withAssetMeta`,
 * `withRenamedAsset` and `serialiseSidecar` are deleted (F9): collections live
 * on the manifest row since §2.4 and nothing in this build may produce a
 * `library.json` again. `resolveAssetMeta` is deleted too — it was the read
 * half nobody called, and its folder-derived fallback is now the catalog's
 * folder chips (`toCatalogEntry`, pinned in `collections-roundtrip.test.ts`).
 *
 * What still consumes this module: `library-sidecar-ingest.ts` (one-time
 * ingestion into the rows) and `project-store`'s adopt run. Both parse; neither
 * writes.
 */

import { describe, it, expect } from 'vitest';
import {
  emptySidecar,
  isValidSidecarV1,
  parseSidecar,
} from '../src/core/library/library-sidecar';

describe('parseSidecar — defensive', () => {
  it('parses a well-formed v1 sidecar', () => {
    const s = parseSidecar(JSON.stringify({
      schemaVersion: 1,
      assets: { 'conveyor/belt.glb': { displayName: 'Belt', collections: ['Conveyors'], tags: ['fast'] } },
    }));
    expect(s?.assets['conveyor/belt.glb'].displayName).toBe('Belt');
    expect(s?.assets['conveyor/belt.glb'].collections).toEqual(['Conveyors']);
  });

  it('returns null on malformed JSON rather than throwing', () => {
    expect(() => parseSidecar('{not json')).not.toThrow();
    expect(parseSidecar('{not json')).toBeNull();
  });

  it('returns null for a future schema version so the file is left alone', () => {
    expect(parseSidecar(JSON.stringify({ schemaVersion: 2, assets: {} }))).toBeNull();
  });

  it('rejects an array in place of the assets record', () => {
    expect(parseSidecar(JSON.stringify({ schemaVersion: 1, assets: [] }))).toBeNull();
  });

  it('drops one bad record without losing the others', () => {
    const s = parseSidecar(JSON.stringify({
      schemaVersion: 1,
      assets: { good: { displayName: 'ok' }, bad: 42 },
    }));
    expect(s?.assets.good.displayName).toBe('ok');
    expect(s?.assets.bad).toBeUndefined();
  });

  it('strips non-string entries out of collections and tags', () => {
    const s = parseSidecar(JSON.stringify({
      schemaVersion: 1,
      assets: { a: { collections: ['ok', 7, null], tags: [1, 'keep'] } },
    }));
    expect(s?.assets.a.collections).toEqual(['ok']);
    expect(s?.assets.a.tags).toEqual(['keep']);
  });
});

describe('isValidSidecarV1', () => {
  it('accepts the empty sidecar and rejects non-objects', () => {
    expect(isValidSidecarV1(emptySidecar())).toBe(true);
    expect(isValidSidecarV1(null)).toBe(false);
    expect(isValidSidecarV1('x')).toBe(false);
  });
});

describe('an explicit empty collections list survives the parse', () => {
  it('is kept as an empty array, not dropped as "missing"', () => {
    // The distinction the ingestion depends on: "the user filed this under
    // nothing" is an answer and must reach the row as one, where a MISSING
    // field is what re-opens the legacy fallback for that row.
    const s = parseSidecar(JSON.stringify({
      schemaVersion: 1,
      assets: { 'conveyor/belt.glb': { collections: [] } },
    }));
    expect(s?.assets['conveyor/belt.glb'].collections).toEqual([]);
  });
});
