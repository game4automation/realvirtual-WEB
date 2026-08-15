// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * library-cross-source-ops — copy and move a document between two writable
 * sources (plan-413 §9.4, phase 5).
 *
 * Run against **real `FolderBackend` instances over fake directories**, not
 * against a hand-written blob double. Everything this feature is about lives in
 * the parts a double would have replaced: `assertWritable` demanding
 * `writable && active`, `updateManifestCas` doing a compare-and-swap on a real
 * `project.json`, and `activate()`/`deactivate()` being what makes an inactive
 * project writable for the length of one transfer.
 *
 * Four properties carry the weight:
 *
 *  1. **Identity.** A copy is a NEW document (new id, `copiedFrom`); a move is
 *     the SAME document at a new address. Anything else makes the reference
 *     resolver's answer arbitrary.
 *  2. **The file wins.** The target's manifest row and sidecar are filled from
 *     the bytes that arrived, never from the source's row.
 *  3. **A torn move costs a duplicate, never the only copy.**
 *  4. **A torn copy leaves no orphan** in the target.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeDir, FailureInjector, asDirHandle } from './helpers/fake-fs-handles';
import { FolderBackend } from '../src/core/project/backends/folder-backend';
import {
  copyDocumentAcrossSources,
  moveDocumentAcrossSources,
  LIBRARY_FOLDER,
  TRASH_FOLDER,
} from '../src/core/library/library-asset-ops';
import {
  withTransferSession,
  openTransferSession,
  resetTransferSessionForTests,
  type DocumentTransferEndpoint,
} from '../src/core/project/rv-document-transfer';
import { findDocumentIdCollisions } from '../src/core/project/rv-project-documents';
import { readManifest } from '../src/core/project/rv-project-storage';
import { parseSidecar, SIDECAR_FILENAME } from '../src/core/library/library-sidecar';
import { createReferenceResolver } from '../src/core/engine/rv-glb-reference-resolver';
import {
  registerLibrarySourceProvider,
  resetLibrarySourceRegistryForTests,
  type LibrarySource,
} from '../src/core/library/library-source-registry';
import type { LibraryCatalogEntry } from '../src/core/library/library-types';
import type { RvDocumentEntry, RvProject } from '../src/core/project/rv-project-types';
import type { DocumentClassification } from '../src/core/project/rv-document-classification';

// ─── Fixtures ───────────────────────────────────────────────────────────

/**
 * A minimal but genuine GLB: header, JSON chunk, no BIN.
 *
 * Hand-built rather than baked so the test can pin *which* bytes travel — the
 * classification is read back out of the arrival, and a builder that went
 * through the bake path would make "the file wins" impossible to distinguish
 * from "the caller passed it in".
 */
function glbWith(json: Record<string, unknown>): Blob {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const padded = new Uint8Array(Math.ceil(text.length / 4) * 4).fill(0x20);
  padded.set(text);
  const out = new Uint8Array(12 + 8 + padded.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);          // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, padded.length, true);
  view.setUint32(16, 0x4e4f534a, true);         // 'JSON'
  out.set(padded, 20);
  return new Blob([out], { type: 'model/gltf-binary' });
}

/** A GLB whose default scene carries a classification (or none). */
function classifiedGlb(
  classification?: DocumentClassification,
  marker = 'A',
): Blob {
  const extras: Record<string, unknown> = { marker };
  if (classification) extras.Classification = classification;
  return glbWith({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ name: 'Scene', extras: { realvirtual: extras } }],
    nodes: [],
  });
}

const BELT_CLASSIFICATION: DocumentClassification = {
  v: 1,
  level: 'assembly',
  tags: ['conveyor', 'line3'],
};

const beltDoc: RvDocumentEntry = {
  id: 'doc_belt_source',
  path: `${LIBRARY_FOLDER}/belt.glb`,
  name: 'Belt',
  section: 'library',
  // Deliberately WRONG in the source row: the target must take what the bytes
  // say, not what the source's cache claims (§2.5).
  classification: { v: 1, level: 'part', tags: ['stale'] },
  // On the ROW since plan-717 §2.4 — collections have no home in the GLB, so
  // this is the only thing that can carry them to the target.
  collections: ['Conveyors'],
  sha256: 'source-sha',
  mtimeMs: 111,
  revision: 'source-revision',
};

function manifest(id: string, documents: RvDocumentEntry[]): RvProject {
  return {
    schemaVersion: 2,
    id,
    name: id,
    documents,
  } as RvProject;
}

let srcDir: FakeDir;
let dstDir: FakeDir;
let srcFail: FailureInjector;
let dstFail: FailureInjector;
let src: FolderBackend;
let dst: FolderBackend;

async function seed(): Promise<void> {
  srcFail = new FailureInjector();
  dstFail = new FailureInjector();
  srcDir = new FakeDir('src', srcFail);
  dstDir = new FakeDir('dst', dstFail);

  srcDir.seedText('project.json', JSON.stringify(manifest('prj_src', [beltDoc])));
  dstDir.seedText('project.json', JSON.stringify(manifest('prj_dst', [])));

  src = new FolderBackend(asDirHandle(srcDir), { writable: true, id: 'folder:src' });
  dst = new FolderBackend(asDirHandle(dstDir), { writable: true, id: 'folder:dst' });

  // Seeded through the production write path so the GLB stays BINARY. A
  // `seedText` round trip would re-encode it as UTF-8 and the classification
  // reader — which slices bytes, not characters — would see a different file.
  await src.activate();
  await src.writeBlob(beltDoc.path, classifiedGlb(BELT_CLASSIFICATION));
  await src.writeBlob(
    `${LIBRARY_FOLDER}/${SIDECAR_FILENAME}`,
    new Blob([JSON.stringify({
      schemaVersion: 1,
      assets: { 'belt.glb': { displayName: 'Belt', collections: ['Conveyors'], tags: ['stale'] } },
    })]),
  );
  await src.deactivate();
}

beforeEach(async () => {
  resetTransferSessionForTests();
  resetLibrarySourceRegistryForTests();
  await seed();
});

afterEach(() => {
  resetTransferSessionForTests();
  resetLibrarySourceRegistryForTests();
});

/** The endpoint pair used by most tests: an ACTIVE source, an inactive target. */
async function activeSource(): Promise<DocumentTransferEndpoint> {
  await src.activate();
  return { label: 'Source project', backend: src, dir: asDirHandle(srcDir), isActiveProject: true };
}

function inactiveTarget(): DocumentTransferEndpoint {
  return { label: 'Target project', backend: dst, dir: asDirHandle(dstDir) };
}

async function targetDocuments(): Promise<RvDocumentEntry[]> {
  return (await readManifest(asDirHandle(dstDir)))?.project.documents ?? [];
}

async function sourceDocuments(): Promise<RvDocumentEntry[]> {
  return (await readManifest(asDirHandle(srcDir)))?.project.documents ?? [];
}

async function fileBytes(dir: FakeDir, sub: string, name: string): Promise<Uint8Array | null> {
  try {
    const folder = await dir.getDirectoryHandle(sub);
    const file = await folder.getFileHandle(name);
    return new Uint8Array(await (await file.getFile()).arrayBuffer());
  } catch {
    return null;
  }
}

// ─── Copy ───────────────────────────────────────────────────────────────

describe('copyDocumentAcrossSources', () => {
  it('copies the bytes verbatim into the target library', async () => {
    const result = await withTransferSession(
      { source: await activeSource(), target: inactiveTarget() },
      s => copyDocumentAcrossSources(s, beltDoc),
    );

    expect(result.kind).toBe('ok');
    const before = await fileBytes(srcDir, LIBRARY_FOLDER, 'belt.glb');
    const after = await fileBytes(dstDir, LIBRARY_FOLDER, 'belt.glb');
    expect(after).not.toBeNull();
    expect([...after!]).toEqual([...before!]);
  });

  it('mints a NEW id and records where it came from', async () => {
    const result = await withTransferSession(
      { source: await activeSource(), target: inactiveTarget() },
      s => copyDocumentAcrossSources(s, beltDoc),
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    expect(result.id).not.toBe(beltDoc.id);
    const [entry] = await targetDocuments();
    expect(entry.id).toBe(result.id);
    expect(entry.copiedFrom).toBe(beltDoc.id);
  });

  it('fills the target row from the BYTES, not from the source row', async () => {
    await withTransferSession(
      { source: await activeSource(), target: inactiveTarget() },
      s => copyDocumentAcrossSources(s, beltDoc),
    );
    const [entry] = await targetDocuments();
    // The source row said `part` / `stale`; the file says `assembly`.
    expect(entry.classification).toEqual(BELT_CLASSIFICATION);
    // Stats and revisions describe the source's file and must not travel, or
    // the target's scan pre-filter would clear on bytes it never looked at.
    expect(entry.sha256).toBeUndefined();
    expect(entry.mtimeMs).toBeUndefined();
    expect(entry.revision).toBeUndefined();
  });

  it('carries tags and collections in the ROW, and writes no sidecar (plan-717 Phase 4)', async () => {
    await withTransferSession(
      { source: await activeSource(), target: inactiveTarget() },
      s => copyDocumentAcrossSources(s, beltDoc),
    );
    const [entry] = await targetDocuments();
    // Tags come from the classification the arrived BYTES carry…
    expect(entry.classification?.tags).toEqual(['conveyor', 'line3']);
    // …collections from the source ROW, because the GLB has nowhere to put them.
    expect(entry.collections).toEqual(['Conveyors']);
    // And no second home is created for either. The transfer used to mirror both
    // into a `library.json` beside the bytes; that write is deleted, which is
    // what makes the row the one answer a downstream reader can trust.
    expect(await dstDir.readTextAt(LIBRARY_FOLDER, SIDECAR_FILENAME)).toBeNull();
  });

  it('leaves the source untouched', async () => {
    await withTransferSession(
      { source: await activeSource(), target: inactiveTarget() },
      s => copyDocumentAcrossSources(s, beltDoc),
    );
    expect(await fileBytes(srcDir, LIBRARY_FOLDER, 'belt.glb')).not.toBeNull();
    expect(await sourceDocuments()).toHaveLength(1);
  });

  it('probes the name instead of overwriting, and the display name follows', async () => {
    const endpoints = { source: await activeSource(), target: inactiveTarget() };
    await withTransferSession(endpoints, s => copyDocumentAcrossSources(s, beltDoc));
    const second = await withTransferSession(
      endpoints, s => copyDocumentAcrossSources(s, beltDoc));

    expect(second.kind).toBe('ok');
    if (second.kind !== 'ok') return;
    expect(second.path).toBe(`${LIBRARY_FOLDER}/belt 2.glb`);
    const rows = await targetDocuments();
    expect(rows.map(r => r.name).sort()).toEqual(['Belt', 'belt 2']);
  });

  it('refuses a read-only target before writing anything', async () => {
    const readOnly = new FolderBackend(asDirHandle(dstDir), { writable: false, id: 'folder:ro' });
    const result = await withTransferSession(
      {
        source: await activeSource(),
        target: { label: 'Read-only project', backend: readOnly, dir: asDirHandle(dstDir) },
      },
      s => copyDocumentAcrossSources(s, beltDoc),
    );
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toContain('read-only');
    expect(await targetDocuments()).toHaveLength(0);
    expect(dstDir.has(LIBRARY_FOLDER)).toBe(false);
  });

  it('refuses a transfer into the same backend', async () => {
    const source = await activeSource();
    const result = await withTransferSession(
      { source, target: { label: 'Itself', backend: src, dir: asDirHandle(srcDir), isActiveProject: true } },
      s => copyDocumentAcrossSources(s, beltDoc),
    );
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toContain('Duplicate');
  });
});

// ─── Move ───────────────────────────────────────────────────────────────

describe('moveDocumentAcrossSources', () => {
  it('keeps the document id', async () => {
    const result = await withTransferSession(
      { source: await activeSource(), target: inactiveTarget() },
      s => moveDocumentAcrossSources(s, beltDoc),
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.id).toBe(beltDoc.id);
    const [entry] = await targetDocuments();
    expect(entry.id).toBe(beltDoc.id);
    expect(entry.copiedFrom).toBeUndefined();
  });

  it('retires the original into the source .trash/ and drops its row', async () => {
    await withTransferSession(
      { source: await activeSource(), target: inactiveTarget() },
      s => moveDocumentAcrossSources(s, beltDoc),
    );
    const lib = await srcDir.getDirectoryHandle(LIBRARY_FOLDER);
    expect(lib.has('belt.glb')).toBe(false);
    const trash = await lib.getDirectoryHandle(TRASH_FOLDER);
    expect(trash.has('belt.glb')).toBe(true);
    expect(await sourceDocuments()).toHaveLength(0);
    // Dropping the row is what drops the metadata now: the legacy sidecar the
    // fixture seeded is left EXACTLY as it was, because nothing writes it any
    // more (plan-717 Phase 4). It is a migration input for the adopt verb, and
    // a stale record in it can no longer reattach to anything — the row it
    // would have to attach to is gone.
    const sidecar = parseSidecar((await lib.readText(SIDECAR_FILENAME)) ?? '');
    expect(sidecar?.assets['belt.glb'].collections).toEqual(['Conveyors']);
  });

  it('probes the trash name rather than overwriting an earlier casualty', async () => {
    const lib = await srcDir.getDirectoryHandle(LIBRARY_FOLDER);
    lib.seedDir(TRASH_FOLDER).seedText('belt.glb', 'OLD');

    await withTransferSession(
      { source: await activeSource(), target: inactiveTarget() },
      s => moveDocumentAcrossSources(s, beltDoc),
    );
    const trash = await lib.getDirectoryHandle(TRASH_FOLDER);
    expect(trash.childNames()).toEqual(['belt 2.glb', 'belt.glb']);
    expect(await trash.readText('belt.glb')).toBe('OLD');
  });

  it('works with an INACTIVE writable source — the session activates it', async () => {
    // Nobody activates `src`: this is the case the review found (SOL R2-2), the
    // one where a passive handle cannot delete and the move would be a copy.
    expect(src.isActive).toBe(false);
    const result = await withTransferSession(
      {
        source: { label: 'Source project', backend: src, dir: asDirHandle(srcDir) },
        target: inactiveTarget(),
      },
      s => moveDocumentAcrossSources(s, beltDoc),
    );
    expect(result.kind).toBe('ok');
    const lib = await srcDir.getDirectoryHandle(LIBRARY_FOLDER);
    expect(lib.has('belt.glb')).toBe(false);
    // And the session gave the activation back.
    expect(src.isActive).toBe(false);
    expect(dst.isActive).toBe(false);
  });

  it('refuses to move OUT of a read-only source', async () => {
    const readOnly = new FolderBackend(asDirHandle(srcDir), { writable: false, id: 'folder:ro-src' });
    const result = await withTransferSession(
      {
        source: { label: 'Read-only source', backend: readOnly, dir: asDirHandle(srcDir) },
        target: inactiveTarget(),
      },
      s => moveDocumentAcrossSources(s, beltDoc),
    );
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toContain('copy it instead');
    expect(await targetDocuments()).toHaveLength(0);
  });
});

// ─── Failure paths ──────────────────────────────────────────────────────

describe('a torn transfer', () => {
  it('copy-ok / delete-fail leaves a duplicate and says so — never a loss', async () => {
    const source = await activeSource();
    // The trash copy fails, so the original is never removed.
    srcFail.fail({ point: 'write', name: 'belt.glb' });

    const result = await withTransferSession(
      { source, target: inactiveTarget() },
      s => moveDocumentAcrossSources(s, beltDoc),
    );

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.warning).toContain('exists in both');
    // Both copies are there. That is the intended outcome of this ordering.
    expect(await fileBytes(srcDir, LIBRARY_FOLDER, 'belt.glb')).not.toBeNull();
    expect(await fileBytes(dstDir, LIBRARY_FOLDER, 'belt.glb')).not.toBeNull();
    // And the source still lists it, so the state is visible rather than lost.
    expect(await sourceDocuments()).toHaveLength(1);
  });

  it('body-ok / manifest-fail cleans the partial copy out of the target', async () => {
    const source = await activeSource();
    // `project.json` in the target cannot be rewritten: the row never lands.
    dstFail.fail({ point: 'write', name: 'project.json' });

    const result = await withTransferSession(
      { source, target: inactiveTarget() },
      s => copyDocumentAcrossSources(s, beltDoc),
    );

    expect(result.kind).toBe('error');
    expect(await fileBytes(dstDir, LIBRARY_FOLDER, 'belt.glb')).toBeNull();
    expect(await targetDocuments()).toHaveLength(0);
    // The source is untouched — a failed copy costs nothing.
    expect(await fileBytes(srcDir, LIBRARY_FOLDER, 'belt.glb')).not.toBeNull();
  });

  it('reports a missing source document instead of writing an empty file', async () => {
    const result = await withTransferSession(
      { source: await activeSource(), target: inactiveTarget() },
      s => copyDocumentAcrossSources(s, { ...beltDoc, path: `${LIBRARY_FOLDER}/ghost.glb` }),
    );
    expect(result.kind).toBe('error');
    expect(dstDir.has(LIBRARY_FOLDER)).toBe(false);
  });
});

// ─── The session itself ─────────────────────────────────────────────────

describe('DocumentTransferSession', () => {
  it('never activates or deactivates the ACTIVE project', async () => {
    const source = await activeSource();
    expect(src.isActive).toBe(true);
    await withTransferSession(
      { source, target: inactiveTarget() },
      s => copyDocumentAcrossSources(s, beltDoc),
    );
    expect(src.isActive).toBe(true);      // still the open project's backend
  });

  it('gives the activation back even when the verb throws', async () => {
    await expect(withTransferSession(
      { source: { label: 'Source', backend: src, dir: asDirHandle(srcDir) }, target: inactiveTarget() },
      async () => { throw new Error('boom'); },
    )).rejects.toThrow('boom');
    expect(src.isActive).toBe(false);
    expect(dst.isActive).toBe(false);
  });

  it('allows exactly one open session at a time', async () => {
    const session = await openTransferSession({ target: inactiveTarget() });
    try {
      await expect(openTransferSession({ target: inactiveTarget() }))
        .rejects.toThrow(/still running/);
    } finally {
      await session.close();
    }
    // Closing releases the slot.
    const next = await openTransferSession({ target: inactiveTarget() });
    await next.close();
  });

  it('serialises queued transfers instead of interleaving them', async () => {
    const source = await activeSource();
    const endpoints = { source, target: inactiveTarget() };
    const [a, b] = await Promise.all([
      withTransferSession(endpoints, s => copyDocumentAcrossSources(s, beltDoc)),
      withTransferSession(endpoints, s => copyDocumentAcrossSources(s, beltDoc)),
    ]);
    expect(a.kind).toBe('ok');
    expect(b.kind).toBe('ok');
    // Two copies, two names, two rows — not one lost to a race.
    const rows = await targetDocuments();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(r => r.id)).size).toBe(2);
  });

  it('reports rather than persists when the side has no manifest file', async () => {
    const result = await withTransferSession(
      {
        source: await activeSource(),
        // `dir` omitted: a browser project's manifest is not a file this layer
        // can compare-and-swap.
        target: { label: 'Browser project', backend: dst },
      },
      s => copyDocumentAcrossSources(s, beltDoc),
    );
    expect(result.kind).toBe('ok');
    expect(result.kind === 'ok' && result.manifestSkipped).toBe(true);
    // The bytes still arrived — the manifest is a cache of them (§2.5).
    expect(await fileBytes(dstDir, LIBRARY_FOLDER, 'belt.glb')).not.toBeNull();
  });
});

// ─── Identity across sources ────────────────────────────────────────────

describe('the transient double-id state', () => {
  it('is reported by the scan while it lasts, and not afterwards', async () => {
    const source = await activeSource();
    srcFail.fail({ point: 'write', name: 'belt.glb' });   // force a duplicate

    await withTransferSession(
      { source, target: inactiveTarget() },
      s => moveDocumentAcrossSources(s, beltDoc),
    );

    const collisions = findDocumentIdCollisions([
      { sourceId: 'prj_src', documents: await sourceDocuments() },
      { sourceId: 'prj_dst', documents: await targetDocuments() },
    ]);
    expect(collisions).toHaveLength(1);
    expect(collisions[0].id).toBe(beltDoc.id);
    expect(collisions[0].sources).toEqual(['prj_src', 'prj_dst']);

    // A clean move leaves nothing to report.
    const clean = findDocumentIdCollisions([
      { sourceId: 'prj_src', documents: [] },
      { sourceId: 'prj_dst', documents: await targetDocuments() },
    ]);
    expect(clean).toHaveLength(0);
  });

  it('does not arise from a copy — a copy is a different document', async () => {
    await withTransferSession(
      { source: await activeSource(), target: inactiveTarget() },
      s => copyDocumentAcrossSources(s, beltDoc),
    );
    expect(findDocumentIdCollisions([
      { sourceId: 'prj_src', documents: await sourceDocuments() },
      { sourceId: 'prj_dst', documents: await targetDocuments() },
    ])).toHaveLength(0);
  });
});

// ─── References survive a move ──────────────────────────────────────────

/** A resolve context for a root scene with no base URL of its own. */
const REF_CONTEXT = { baseUrl: '', occurrence: 'root/0', depth: 0, resolvedPath: '' };

/** A library source that answers to a document id, like the project provider. */
function fakeSource(
  id: string,
  entries: LibraryCatalogEntry[],
  bytesOf: (assetId: string) => Blob,
): LibrarySource {
  const byId = new Map<string, LibraryCatalogEntry>();
  for (const e of entries) if (e.documentId) byId.set(e.documentId, e);
  for (const e of entries) byId.set(e.id, e);
  return {
    id,
    label: id,
    kind: 'project',
    writable: true,
    loaded: true,
    listEntries: () => entries,
    getEntry: (assetId) => byId.get(assetId) ?? null,
    resolveAsset: async (assetId) => {
      const entry = byId.get(assetId);
      if (!entry) throw new Error(`unknown ${assetId}`);
      const url = URL.createObjectURL(bytesOf(entry.id));
      return { url, revokeUrl: () => URL.revokeObjectURL(url) };
    },
  };
}

describe('an AssetReference after a move', () => {
  it('still resolves, because the id — not the path — is what it looks up', async () => {
    await withTransferSession(
      { source: await activeSource(), target: inactiveTarget() },
      s => moveDocumentAcrossSources(s, beltDoc),
    );
    const [moved] = await targetDocuments();

    // Only the TARGET project's library is registered now — the move took the
    // document out of the source. Its catalog id changed with the path; the
    // document id did not.
    const entry: LibraryCatalogEntry = {
      id: `project:${moved.path}`,
      name: moved.name,
      category: 'custom',
      localPath: moved.path,
      documentId: moved.id,
    };
    registerLibrarySourceProvider({
      id: 'project',
      listSources: () => [fakeSource('prj_dst', [entry], () => classifiedGlb(BELT_CLASSIFICATION))],
      subscribe: () => () => {},
    });

    const resolver = createReferenceResolver();
    // The placement recorded the OLD project and the OLD path; only the id is
    // still true, which is exactly the case §2.7 promises to survive.
    const resolved = await resolver(
      { assetId: beltDoc.id, providerId: 'project', sourceId: 'prj_src' },
      REF_CONTEXT,
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.bytes.byteLength).toBeGreaterThan(0);
  });

  it('resolves first-source-wins while two sources claim the same id', async () => {
    const shared: LibraryCatalogEntry = {
      id: 'project:library/belt.glb',
      name: 'Belt',
      category: 'custom',
      documentId: beltDoc.id,
    };
    registerLibrarySourceProvider({
      id: 'project',
      listSources: () => [
        fakeSource('first', [shared], () => classifiedGlb(BELT_CLASSIFICATION, 'FIRST')),
        fakeSource('second', [shared], () => classifiedGlb(BELT_CLASSIFICATION, 'SECOND')),
      ],
      subscribe: () => () => {},
    });

    const resolver = createReferenceResolver();
    const resolved = await resolver({ assetId: beltDoc.id }, REF_CONTEXT);
    expect(resolved).not.toBeNull();
    expect(new TextDecoder().decode(resolved!.bytes)).toContain('FIRST');
  });
});
