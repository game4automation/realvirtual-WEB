// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * library-sidecar — per-asset metadata beside a writable library root
 * (plan-372 §2.6.5, Phase 9).
 *
 * The parsing tests carry the weight here. A sidecar is derived convenience,
 * so the rule is: unusable input is ignored and the file is NEVER rewritten.
 * Overwriting a sidecar written by a newer build would destroy a user's
 * collections, which is exactly the failure the version check prevents.
 */

import { describe, it, expect } from 'vitest';
import {
  emptySidecar,
  isValidSidecarV1,
  parseSidecar,
  resolveAssetMeta,
  serialiseSidecar,
  withAssetMeta,
  withRenamedAsset,
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

describe('resolveAssetMeta — folder fallback', () => {
  it('derives the collection from the parent folder when there is no entry', () => {
    const meta = resolveAssetMeta(null, 'conveyor/belt.glb');
    expect(meta.collections).toEqual(['conveyor']);
    expect(meta.displayName).toBe('belt');
  });

  it('gives a root-level asset no collection rather than inventing one', () => {
    expect(resolveAssetMeta(null, 'belt.glb').collections).toEqual([]);
  });

  it('lets the sidecar win over the folder derivation', () => {
    const s = { schemaVersion: 1 as const, assets: { 'conveyor/belt.glb': { collections: ['Custom'] } } };
    expect(resolveAssetMeta(s, 'conveyor/belt.glb').collections).toEqual(['Custom']);
  });

  it('treats an explicit empty array as "no collections", not as missing', () => {
    const s = { schemaVersion: 1 as const, assets: { 'conveyor/belt.glb': { collections: [] } } };
    expect(resolveAssetMeta(s, 'conveyor/belt.glb').collections).toEqual([]);
  });
});

describe('mutations', () => {
  it('does not persist an empty record', () => {
    const s = withAssetMeta(emptySidecar(), 'a.glb', {});
    expect(s.assets['a.glb']).toBeUndefined();
  });

  it('replaces an existing record', () => {
    let s = withAssetMeta(emptySidecar(), 'a.glb', { tags: ['x'] });
    s = withAssetMeta(s, 'a.glb', { tags: ['y'] });
    expect(s.assets['a.glb'].tags).toEqual(['y']);
  });

  it('moves a record on rename and leaves nothing behind', () => {
    const s = withRenamedAsset(
      withAssetMeta(emptySidecar(), 'old.glb', { displayName: 'Old' }),
      'old.glb',
      'new.glb',
    );
    expect(s.assets['old.glb']).toBeUndefined();
    expect(s.assets['new.glb'].displayName).toBe('Old');
  });

  it('round-trips through serialise/parse with sorted keys', () => {
    let s = withAssetMeta(emptySidecar(), 'z.glb', { tags: ['t'] });
    s = withAssetMeta(s, 'a.glb', { tags: ['t'] });
    const text = serialiseSidecar(s);
    expect(text.indexOf('a.glb')).toBeLessThan(text.indexOf('z.glb'));
    expect(parseSidecar(text)).toEqual(s);
  });
});
