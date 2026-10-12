// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * thumbnail-sidecar — the preview hangs on the ID, not on the path
 * (plan-744 §9.3, F5/F6).
 *
 * The convention it replaces mirrored the asset's PATH under
 * `library/.thumbnails/<rel>.png`, which had two defects and they are the two
 * properties pinned here:
 *
 *  - a MOVE or a RENAME orphaned the picture, because the key WAS the
 *    location;
 *  - only `library/**` had one at all, so a model, a scene, or anything in a
 *    delivered project had no persisted preview and fell back to a per-browser
 *    render cache that a fresh machine does not have.
 *
 * Plus the three properties the review asked for: the encoder is injective
 * (#20), the lazy migration cannot overwrite a fresh save (#6), and a move
 * carries the old picture across before the path that finds it is gone (#5).
 */

import { describe, it, expect } from 'vitest';
import {
  encodeThumbnailId,
  legacyLibraryThumbnailPath,
  thumbnailSidecarPath,
} from '../src/core/library/library-types';
import {
  migrateLegacyThumbnailForMove,
  resolveDocumentThumbnail,
} from '../src/core/library/resolve-document-thumbnail';
import type { ProjectBackend } from '../src/core/project/backends/project-backend';

// ─── Fixtures ───────────────────────────────────────────────────────────

/**
 * A backend that is a `Map<path, bytes>` and an honest `'create'`
 * precondition.
 *
 * The precondition is the point: the lazy migration's whole safety argument is
 * that the BACKEND refuses an existing target, so there is no window between
 * a check and a write. A double that accepted every write would let a
 * read-then-write implementation pass.
 */
function fakeBackend(files: Record<string, string> = {}, writable = true) {
  const store = new Map(Object.entries(files));
  const urls = new Map<string, string>();
  let released = 0;
  const backend = {
    kind: 'folder',
    id: 'fake',
    writable,
    isActive: true,
    async readDocument(ref: unknown) {
      const path = typeof ref === 'string' ? ref : (ref as { path: string }).path;
      const body = store.get(path);
      return body === undefined
        ? null
        : { bytes: new TextEncoder().encode(body), meta: { id: '', name: path, path }, revision: 'r' };
    },
    async readDocumentUrl(relPath: string) {
      if (!store.has(relPath)) return null;
      const url = `blob:${relPath}`;
      urls.set(relPath, url);
      return { url, release: () => { released++; } };
    },
    async writeDocument(
      ref: unknown,
      bytes: Uint8Array,
      opts?: { expectedRevision?: unknown },
    ) {
      const path = typeof ref === 'string' ? ref : (ref as { path: string }).path;
      if (opts?.expectedRevision === 'create' && store.has(path)) {
        throw new Error(`"${path}" already exists`);
      }
      store.set(path, new TextDecoder().decode(bytes));
      return { revision: 'r' };
    },
    async listDocuments() { return []; },
  } as unknown as ProjectBackend;
  return { backend, store, releases: () => released };
}

/** The `TreeMoveIO` slice `migrateLegacyThumbnailForMove` needs. */
function moveIo(files: Record<string, string>) {
  const store = new Map(Object.entries(files));
  return {
    store,
    io: {
      async readBytes(relPath: string) {
        const body = store.get(relPath);
        return body === undefined ? null : new Blob([body]);
      },
      async writeBytes(relPath: string, blob: Blob) {
        store.set(relPath, await blob.text());
      },
    },
  };
}

// ─── The encoding ───────────────────────────────────────────────────────

describe('encodeThumbnailId — injective and file-system safe', () => {
  it('escapes every character a file name cannot carry', () => {
    for (const c of ['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
      expect(encodeThumbnailId(`a${c}b`)).not.toContain(c);
    }
  });

  it('never maps two different ids onto one file', () => {
    // The defect a naive `replace(/[^\w]/g, '_')` would have: every reserved
    // character collapses onto the same filler, and one asset's preview
    // silently overwrites another's.
    const ids = [
      'a/b', 'a:b', 'a\\b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a_b',
      'a b', 'ab', 'a.b', 'a-b', 'doc_press_1a2b', 'doc/press/1a2b',
      // The fixed-width case: a 3-digit code point next to a literal digit.
      'Ā', '' + '0',
    ];
    const encoded = ids.map(encodeThumbnailId);
    expect(new Set(encoded).size).toBe(ids.length);
  });

  it('keeps a very long id inside a usable file name, still uniquely', () => {
    const a = `doc_${'x'.repeat(400)}_one`;
    const b = `doc_${'x'.repeat(400)}_two`;
    expect(encodeThumbnailId(a).length).toBeLessThanOrEqual(120);
    // The hashed tail is over the WHOLE id, so a shared prefix is not a
    // shared file.
    expect(encodeThumbnailId(a)).not.toBe(encodeThumbnailId(b));
  });

  it('puts the sidecar at the project root, not under library/', () => {
    expect(thumbnailSidecarPath('doc_press')).toBe('.thumbnails/doc_press.png');
  });
});

describe('legacyLibraryThumbnailPath — the old convention, read-only', () => {
  it('mirrors a library path', () => {
    expect(legacyLibraryThumbnailPath('library/Custom/Belt.glb'))
      .toBe('library/.thumbnails/Custom/Belt.png');
  });

  it('answers null for everything else — it never existed there', () => {
    expect(legacyLibraryThumbnailPath('models/Press.glb')).toBeNull();
    expect(legacyLibraryThumbnailPath('Root.glb')).toBeNull();
    expect(legacyLibraryThumbnailPath('')).toBeNull();
  });
});

// ─── The read chain ─────────────────────────────────────────────────────

describe('resolveDocumentThumbnail — the chain, in order', () => {
  it('prefers what the manifest states (Review #4)', async () => {
    const { backend } = fakeBackend({
      [thumbnailSidecarPath('d1')]: 'SIDECAR',
    });
    const found = await resolveDocumentThumbnail(backend, {
      id: 'd1', path: 'models/a.glb', thumbnail: 'https://cdn.example/a.png',
    });
    // A bundled deploy fills `doc.thumbnail` in, and a manifest that names a
    // picture is the author saying which one to use.
    expect(found?.url).toBe('https://cdn.example/a.png');
  });

  it('reads the id-keyed sidecar', async () => {
    const { backend } = fakeBackend({ [thumbnailSidecarPath('d1')]: 'PNG' });
    const found = await resolveDocumentThumbnail(backend, { id: 'd1', path: 'models/a.glb' });
    expect(found?.url).toBe(`blob:${thumbnailSidecarPath('d1')}`);
  });

  it('finds the sidecar after the document MOVED — the whole point', async () => {
    const { backend } = fakeBackend({ [thumbnailSidecarPath('d1')]: 'PNG' });
    // Same id, a completely different path. Under the old path-mirrored
    // convention this lookup would have gone to `library/.thumbnails/old.png`
    // and found nothing.
    const found = await resolveDocumentThumbnail(backend, {
      id: 'd1', path: 'somewhere/else/renamed.glb',
    });
    expect(found?.url).toBe(`blob:${thumbnailSidecarPath('d1')}`);
  });

  it('answers null when nothing is stored, so the caller renders', async () => {
    const { backend } = fakeBackend();
    expect(await resolveDocumentThumbnail(backend, { id: 'd1', path: 'models/a.glb' }))
      .toBeNull();
  });

  it('answers null for a document with no id, and for no backend', async () => {
    const { backend } = fakeBackend({ [thumbnailSidecarPath('')]: 'PNG' });
    expect(await resolveDocumentThumbnail(backend, { id: '', path: 'a.glb' })).toBeNull();
    expect(await resolveDocumentThumbnail(null, { id: 'd1', path: 'a.glb' })).toBeNull();
  });
});

// ─── The lazy migration ─────────────────────────────────────────────────

describe('resolveDocumentThumbnail — lazy migration of the old sidecar', () => {
  it('copies `library/.thumbnails/<rel>.png` under the id on first sight', async () => {
    const { backend, store } = fakeBackend({
      'library/.thumbnails/Custom/Belt.png': 'OLD',
    });
    const doc = { id: 'd1', path: 'library/Custom/Belt.glb' };

    const found = await resolveDocumentThumbnail(backend, doc);
    expect(found?.url).toBe(`blob:${thumbnailSidecarPath('d1')}`);
    expect(store.get(thumbnailSidecarPath('d1'))).toBe('OLD');
    // Not a sweep: the old file stays for a release (§2.4).
    expect(store.get('library/.thumbnails/Custom/Belt.png')).toBe('OLD');
  });

  it('is idempotent — a second call copies nothing and answers the same', async () => {
    const { backend, store } = fakeBackend({
      'library/.thumbnails/Custom/Belt.png': 'OLD',
    });
    const doc = { id: 'd1', path: 'library/Custom/Belt.glb' };
    await resolveDocumentThumbnail(backend, doc);
    const again = await resolveDocumentThumbnail(backend, doc);
    expect(again?.url).toBe(`blob:${thumbnailSidecarPath('d1')}`);
    expect(store.get(thumbnailSidecarPath('d1'))).toBe('OLD');
  });

  it('never overwrites a FRESH sidecar with the stale copy (Review #6)', async () => {
    // The race: a save just wrote the current picture under the id, and the
    // stale path-mirrored one from before the rename is still on disk. The
    // `'create'` precondition is what makes the migration lose that race
    // rather than win it.
    const { backend, store } = fakeBackend({
      [thumbnailSidecarPath('d1')]: 'FRESH',
      'library/.thumbnails/Custom/Belt.png': 'STALE',
    });
    await resolveDocumentThumbnail(backend, { id: 'd1', path: 'library/Custom/Belt.glb' });
    expect(store.get(thumbnailSidecarPath('d1'))).toBe('FRESH');
  });

  it('writes nothing into a read-only project', async () => {
    const { backend, store } = fakeBackend({
      'library/.thumbnails/Custom/Belt.png': 'OLD',
    }, false);
    await resolveDocumentThumbnail(backend, { id: 'd1', path: 'library/Custom/Belt.glb' });
    expect(store.has(thumbnailSidecarPath('d1'))).toBe(false);
  });
});

// ─── The move hook ──────────────────────────────────────────────────────

describe('migrateLegacyThumbnailForMove — carried before the path goes', () => {
  it('copies the old picture under the id BEFORE the move (Review #5)', async () => {
    // Without this, a document dragged out of `library/` before anything ever
    // rendered its card loses the picture: the lazy migration keys off
    // `doc.path`, and after the move that path no longer says `library/`.
    const { io, store } = moveIo({ 'library/.thumbnails/Custom/Belt.png': 'OLD' });
    const copied = await migrateLegacyThumbnailForMove(io, 'd1', 'library/Custom/Belt.glb');
    expect(copied).toBe(true);
    expect(store.get(thumbnailSidecarPath('d1'))).toBe('OLD');
  });

  it('leaves an existing sidecar alone', async () => {
    const { io, store } = moveIo({
      [thumbnailSidecarPath('d1')]: 'FRESH',
      'library/.thumbnails/Custom/Belt.png': 'STALE',
    });
    expect(await migrateLegacyThumbnailForMove(io, 'd1', 'library/Custom/Belt.glb')).toBe(false);
    expect(store.get(thumbnailSidecarPath('d1'))).toBe('FRESH');
  });

  it('does nothing for a document that never had an old sidecar', async () => {
    const { io, store } = moveIo({});
    expect(await migrateLegacyThumbnailForMove(io, 'd1', 'models/Press.glb')).toBe(false);
    expect(store.size).toBe(0);
  });

  it('never throws — a thumbnail must not fail a move', async () => {
    const broken = {
      async readBytes() { throw new Error('gone'); },
      async writeBytes() { throw new Error('gone'); },
    };
    await expect(migrateLegacyThumbnailForMove(broken, 'd1', 'library/a.glb'))
      .resolves.toBe(false);
  });
});
