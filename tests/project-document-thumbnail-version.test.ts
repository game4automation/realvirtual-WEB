// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Project-document preview keys carry a content version even when the backend
 * has no stats. The bundled backend's `statDocuments()` returns `[]` on
 * purpose, so the key used to stay version-less and the render of an OLD GLB
 * was reused for ever. The manifest row's `sha256` (then `mtimeMs`) is the
 * fallback; the backend mtime still wins where it exists.
 */
import { describe, expect, it } from 'vitest';
import {
  buildThumbnailKey,
  documentThumbnailVersion,
  type ThumbnailKeyParts,
} from '../src/core/thumbnails/thumbnail-key';

function keyFor(
  stat: { mtime?: number } | undefined,
  doc: { sha256?: string; mtimeMs?: number } | undefined,
): string {
  const version = documentThumbnailVersion(stat, doc);
  const parts: ThumbnailKeyParts = {
    projectId: 'prj_sample',
    providerId: 'project-document',
    sourceId: 'prj_sample',
    assetId: 'prj_sample/fmu-demo.glb',
    ...(version !== undefined ? { version } : {}),
  };
  return buildThumbnailKey(parts);
}

const BASE = 'prj_sample:project-document:prj_sample:prj_sample/fmu-demo.glb';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

describe('documentThumbnailVersion', () => {
  it('uses the manifest sha256 when the backend has no stats', () => {
    expect(keyFor(undefined, { sha256: SHA_A, mtimeMs: 123 })).toBe(`${BASE}:${SHA_A}`);
  });

  it('gives a different key when the manifest sha256 changes', () => {
    expect(keyFor(undefined, { sha256: SHA_A })).not.toBe(keyFor(undefined, { sha256: SHA_B }));
  });

  it('keeps the backend mtime as the version when stats exist', () => {
    expect(keyFor({ mtime: 1790540696798 }, { sha256: SHA_A, mtimeMs: 5 }))
      .toBe(`${BASE}:1790540696798`);
  });

  it('falls back to the manifest mtimeMs when there is no sha256', () => {
    expect(keyFor({}, { mtimeMs: 42 })).toBe(`${BASE}:42`);
  });

  it('has no version segment without stats, sha256 or mtimeMs', () => {
    expect(documentThumbnailVersion(undefined, undefined)).toBeUndefined();
    expect(keyFor(undefined, {})).toBe(BASE);
    expect(keyFor({}, undefined)).toBe(BASE);
  });
});
