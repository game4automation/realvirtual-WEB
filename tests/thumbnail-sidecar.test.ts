// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * thumbnail-sidecar — the saved preview hangs on the ID and the content hash
 * (plan-744 F5, plan-776 F1/F3/F7/F12).
 *
 * Pinned here:
 *  - the encoder is injective and file-system safe (plan-744 #20);
 *  - the sidecar name is `.thumbnails/<enc(id)>.<hash8>.<webp|png>` — at the
 *    project root, or in a catalog's category folder;
 *  - the read side passes URL/absolute pointers through, refuses `..` and
 *    anything outside `.thumbnails/`, and never probes a conventional path;
 *  - the delete side only ever removes a sidecar of EXACTLY the given id.
 */

import { describe, it, expect } from 'vitest';
import {
  encodeThumbnailId,
  isOwnThumbnailSidecar,
  isReadableThumbnailPointer,
  legacyThumbnailSidecarPath,
  parseThumbnailSidecarTail,
  thumbnailSidecarPath,
} from '../src/core/library/library-types';
import {
  cleanupThumbnailSidecars,
  copyThumbnailSidecar,
  deleteThumbnailSidecar,
  resolveThumbnailUrl,
} from '../src/core/library/resolve-document-thumbnail';
import type { ProjectBackend } from '../src/core/project/backends/project-backend';

// ─── Fixtures ───────────────────────────────────────────────────────────

/** A backend that is a `Map<path, bytes>` and records every read and delete. */
function fakeBackend(files: Record<string, string> = {}, writable = true) {
  const store = new Map(Object.entries(files));
  const reads: string[] = [];
  const deletes: string[] = [];
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
      reads.push(relPath);
      if (!store.has(relPath)) return null;
      return { url: `blob:${relPath}`, release: () => {} };
    },
    async writeDocument(ref: unknown, bytes: Uint8Array) {
      const path = typeof ref === 'string' ? ref : (ref as { path: string }).path;
      store.set(path, new TextDecoder().decode(bytes));
      return { revision: 'r' };
    },
    async deleteDocument(ref: unknown) {
      const path = typeof ref === 'string' ? ref : (ref as { path: string }).path;
      deletes.push(path);
      store.delete(path);
    },
    async listDocuments() { return []; },
  } as unknown as ProjectBackend;
  return { backend, store, reads, deletes };
}

// ─── The encoding ───────────────────────────────────────────────────────

describe('encodeThumbnailId — injective and file-system safe', () => {
  it('escapes every character a file name cannot carry', () => {
    for (const c of ['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
      expect(encodeThumbnailId(`a${c}b`)).not.toContain(c);
    }
  });

  it('never maps two different ids onto one file', () => {
    const ids = [
      'a/b', 'a:b', 'a\\b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a_b',
      'a b', 'ab', 'a.b', 'a-b', 'doc_press_1a2b', 'doc/press/1a2b',
      // The fixed-width case: a 3-digit code point next to a literal digit.
      'Ā', '' + '0',
    ];
    const encoded = ids.map(encodeThumbnailId);
    expect(new Set(encoded).size).toBe(ids.length);
  });

  it('keeps a very long id inside a usable file name, still uniquely', () => {
    const a = `doc_${'x'.repeat(400)}_one`;
    const b = `doc_${'x'.repeat(400)}_two`;
    expect(encodeThumbnailId(a).length).toBeLessThanOrEqual(120);
    expect(encodeThumbnailId(a)).not.toBe(encodeThumbnailId(b));
  });
});

// ─── The name ───────────────────────────────────────────────────────────

describe('thumbnailSidecarPath — id + hash + real extension', () => {
  it('puts a document sidecar at the project root', () => {
    expect(thumbnailSidecarPath('doc_press', '3fa9c2d1', 'webp')).toBe('.thumbnails/doc_press.3fa9c2d1.webp');
    expect(thumbnailSidecarPath('a/b', '0000ffff', 'png')).toBe('.thumbnails/a~002fb.0000ffff.png');
  });

  it('puts a catalog sidecar into its category folder (P1)', () => {
    expect(thumbnailSidecarPath('belt', 'deadbeef', 'webp', 'PalletHandling'))
      .toBe('PalletHandling/.thumbnails/belt.deadbeef.webp');
  });

  it('parses the hash and extension back out', () => {
    expect(parseThumbnailSidecarTail('.thumbnails/doc.a.12345678.png')).toEqual({ hash8: '12345678', ext: 'png' });
    expect(parseThumbnailSidecarTail('.thumbnails/doc.png')).toBeNull();
  });

  it('names the legacy hash-less PNG only so a save can delete it', () => {
    expect(legacyThumbnailSidecarPath('doc_press')).toBe('.thumbnails/doc_press.png');
  });
});

// ─── The read side (F7) ─────────────────────────────────────────────────

describe('resolveThumbnailUrl — pointer only, never a probe', () => {
  it('passes a scheme or absolute pointer through unchanged', async () => {
    const { backend, reads } = fakeBackend();
    for (const p of ['https://cdn.example/a.png', 'data:image/png;base64,AA', 'blob:x', '/models/a.png']) {
      expect((await resolveThumbnailUrl(backend, p))?.url).toBe(p);
    }
    expect(reads).toEqual([]);
  });

  it('reads a valid relative pointer through the backend', async () => {
    const ptr = thumbnailSidecarPath('d1', 'aaaaaaaa', 'webp');
    const { backend } = fakeBackend({ [ptr]: 'WEBP' });
    expect((await resolveThumbnailUrl(backend, ptr))?.url).toBe(`blob:${ptr}`);
  });

  it('refuses `..`, foreign folders and deeper nesting without reading anything', async () => {
    const { backend, reads } = fakeBackend({ 'models/x.glb': 'GLB' });
    for (const p of ['../models/x.glb', 'models/x.glb', '.thumbnails/../models/x.glb', 'a/b/.thumbnails/x.webp', '']) {
      expect(await resolveThumbnailUrl(backend, p)).toBeNull();
    }
    expect(reads).toEqual([]);
    expect(isReadableThumbnailPointer('PalletHandling/.thumbnails/x.webp')).toBe(true);
  });

  it('never falls back to the legacy `<id>.png` when the row has no pointer', async () => {
    const { backend, reads } = fakeBackend({ [legacyThumbnailSidecarPath('d1')]: 'OLD' });
    expect(await resolveThumbnailUrl(backend, undefined)).toBeNull();
    expect(reads).toEqual([]);
  });

  it('answers null when the read throws (an encrypted deploy before unlock)', async () => {
    const { backend } = fakeBackend();
    (backend as unknown as { readDocumentUrl: () => Promise<never> }).readDocumentUrl = async () => {
      throw new Error('decrypt failed');
    };
    expect(await resolveThumbnailUrl(backend, '.thumbnails/x.aaaaaaaa.webp')).toBeNull();
  });
});

// ─── The delete side (F3) ───────────────────────────────────────────────

describe('delete safety — only this id\'s own sidecar', () => {
  it('accepts the hashed and the legacy name of exactly this id', () => {
    expect(isOwnThumbnailSidecar('.thumbnails/doc.12345678.webp', 'doc')).toBe(true);
    expect(isOwnThumbnailSidecar('.thumbnails/doc.png', 'doc')).toBe(true);
  });

  it('refuses another id that merely starts with the same characters', () => {
    // `encodeThumbnailId` keeps `.` literal: a prefix test would match `doc.a`.
    expect(isOwnThumbnailSidecar('.thumbnails/doc.a.12345678.webp', 'doc')).toBe(false);
  });

  it('refuses URLs, absolute paths, `..`, catalogs and other folders', () => {
    for (const p of ['https://x/doc.12345678.webp', '/doc.12345678.webp', '../models/x.glb',
      '.thumbnails/../doc.12345678.webp', 'Cat/.thumbnails/doc.12345678.webp', 'models/doc.12345678.webp']) {
      expect(isOwnThumbnailSidecar(p, 'doc')).toBe(false);
    }
  });

  it('deletes nothing it does not own, and nothing on a read-only backend', async () => {
    const own = '.thumbnails/doc.12345678.webp';
    const { backend, deletes } = fakeBackend({ [own]: 'X', 'models/x.glb': 'GLB' });
    expect(await deleteThumbnailSidecar(backend, '../models/x.glb', 'doc')).toBe(false);
    expect(await deleteThumbnailSidecar(backend, own, 'doc')).toBe(true);
    expect(deletes).toEqual([own]);
    const ro = fakeBackend({ [own]: 'X' }, false);
    expect(await deleteThumbnailSidecar(ro.backend, own, 'doc')).toBe(false);
  });

  it('cleans up the previous and the legacy sidecar but keeps the new one', async () => {
    const old = '.thumbnails/doc.11111111.webp';
    const next = '.thumbnails/doc.22222222.webp';
    const legacy = legacyThumbnailSidecarPath('doc');
    const { backend, store } = fakeBackend({ [old]: 'A', [next]: 'B', [legacy]: 'C' });
    await cleanupThumbnailSidecars(backend, 'doc', [old, next, 'https://x/y.png'], next);
    expect([...store.keys()]).toEqual([next]);
  });
});

// ─── The copy (F5) ──────────────────────────────────────────────────────

describe('copyThumbnailSidecar — bytes under the new id, never the old pointer', () => {
  it('copies to the target id with the same hash and extension', async () => {
    const src = '.thumbnails/a.abcdef01.png';
    const from = fakeBackend({ [src]: 'PNG' });
    const to = fakeBackend();
    const next = await copyThumbnailSidecar(
      { read: async (p) => (await from.backend.readDocument(p))?.bytes ?? null },
      { write: async (p, b) => { await to.backend.writeDocument(p, b, { expectedRevision: 'any' }); } },
      src, 'a', 'b',
    );
    expect(next).toBe('.thumbnails/b.abcdef01.png');
    expect(to.store.get('.thumbnails/b.abcdef01.png')).toBe('PNG');
  });

  it('answers null for a foreign pointer or a failed read', async () => {
    const io = { read: async () => null, write: async () => {} };
    expect(await copyThumbnailSidecar(io, io, 'https://x/a.png', 'a', 'b')).toBeNull();
    expect(await copyThumbnailSidecar(io, io, '.thumbnails/a.abcdef01.png', 'a', 'b')).toBeNull();
  });
});
