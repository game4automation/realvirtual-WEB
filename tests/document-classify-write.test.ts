// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-413 §2.5 / §9.6 — classifying a document writes the FILE.
 *
 * The classification editor is the first thing in the product that changes what
 * a document says it is, and the plan is exact about the order it must do that
 * in: **bytes first, cache second**. The reason is asymmetric damage. A file
 * written but not cached is repaired by the next scan (§2.5 says the GLB wins);
 * a cache written but not file is a manifest describing something that never
 * happened, and nothing in the system can tell that it is wrong.
 *
 * So these tests check three things about the byte write itself:
 *
 *  - it goes through the **same bake** the save path uses, on its fast path, so
 *    the block written here and the block written by a Save are one spelling
 *    and a 100 MB model costs its JSON chunk, not a re-export;
 *  - the write carries the plan-397 **compare-and-swap** token, so a body
 *    somebody else changed in the meantime is refused rather than clobbered;
 *  - a refused write **throws**, which is what keeps a caller's cache update
 *    from running after a write that did not happen.
 *
 * ## What plan-736 changed about this file
 *
 * It used to have two `describe` blocks — "a scene body" and "an asset body" —
 * because `writeDocumentClassification` had two branches and chose between them
 * with `sectionOfDocument(doc)`. The scene branch went through
 * `readScene`/`writeScene` with a compare-and-swap; the asset branch went
 * through `readBlobUrl`/`writeBlob`, unprotected until plan-709 and optionally
 * protected after it. The result even reported which one had run (`surface`).
 *
 * That branch is gone, so the two blocks became one and the interesting
 * assertion changed shape with them: it is no longer "each surface carries the
 * same token" (a statement about two things agreeing) but "a scene row and a
 * model row are **indistinguishable** to this verb" (a statement about there
 * being one thing). The last test below is that claim, written so it would fail
 * if a second surface ever came back.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';

import { objectToGlb } from '../src/core/import/rv-import-object';
import { writeDocumentClassification } from '../src/core/project/rv-document-classify';
import { classificationOfGlbBlob } from '../src/core/project/rv-project-documents';
import { parseGlbChunks } from '../src/core/persistence/rv-glb-chunks';
import { revisionOfBytes } from '../src/core/project/rv-scene-record';
import {
  docPathOf,
  type DocRef,
  type DocumentRecord,
  type ProjectBackend,
  type WriteDocumentOptions,
} from '../src/core/project/backends/project-backend';
import type { RvDocumentEntry } from '../src/core/project/rv-project-types';

const material = new MeshStandardMaterial({ color: 0x334455 });

function buildTree(): Group {
  const root = new Group();
  root.name = 'Cell';
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
  mesh.name = 'Ram';
  root.add(mesh);
  return root;
}

let bytes: Uint8Array;
let revision: string;

beforeEach(async () => {
  bytes = new Uint8Array(await objectToGlb(buildTree()));
  revision = await revisionOfBytes(bytes);
});

// ─── a backend that records what it was asked to do ──────────────────────

interface FakeBackend extends ProjectBackend {
  calls: string[];
  written: Uint8Array | null;
  /** The DocRef the write named — `meta` is how the caller states identity. */
  lastRef: DocRef | null;
  /** The precondition the write carried. Mandatory since plan-736. */
  lastOpts: WriteDocumentOptions | null;
  writeImpl: ((ref: DocRef, bytes: Uint8Array) => Promise<{ revision: string }>) | null;
  readImpl: (() => Promise<DocumentRecord | null>) | null;
}

function fakeBackend(writable = true): FakeBackend {
  const b = {
    kind: 'folder',
    id: 'fake',
    writable,
    isActive: true,
    calls: [] as string[],
    written: null as Uint8Array | null,
    lastRef: null as DocRef | null,
    lastOpts: null as WriteDocumentOptions | null,
    writeImpl: null as ((ref: DocRef, bytes: Uint8Array) => Promise<{ revision: string }>) | null,
    readImpl: null as (() => Promise<DocumentRecord | null>) | null,

    async readDocument(ref: DocRef): Promise<DocumentRecord | null> {
      b.calls.push('readDocument:' + docPathOf(ref));
      if (b.readImpl) return b.readImpl();
      return {
        bytes, revision,
        meta: { id: 'doc-1', name: 'Line', path: docPathOf(ref) },
      };
    },
    async readDocumentUrl() { return null; },
    async writeDocument(ref: DocRef, written: Uint8Array, opts: WriteDocumentOptions) {
      b.calls.push('writeDocument:' + docPathOf(ref));
      b.lastRef = ref;
      b.lastOpts = opts;
      if (b.writeImpl) return b.writeImpl(ref, written);
      b.written = written;
      return { revision: await revisionOfBytes(written) };
    },
    // Unused by this verb, present because the contract has them.
    readManifest: async () => null,
    readSettings: async () => null,
    listModels: async () => [],
    listLibrary: async () => [],
    listDocuments: async () => [],
    statDocuments: async () => [],
    activate: async () => {},
    deactivate: async () => {},
    deleteDocument: async () => {},
    flush: async () => {},
  } as unknown as FakeBackend;
  return b;
}

const sceneDoc: RvDocumentEntry = {
  id: 'doc-1', path: 'scenes/Line.scene.glb', name: 'Line',
};
const modelDoc: RvDocumentEntry = {
  id: 'doc-2', path: 'models/Press.glb', name: 'Press',
};

// ─── tests ───────────────────────────────────────────────────────────────

describe('writeDocumentClassification', () => {
  it('reads, patches and writes back under the revision it read', async () => {
    const b = fakeBackend();
    const result = await writeDocumentClassification(
      b, sceneDoc, { v: 1, level: 'plant', tags: ['line3'] });

    expect(b.calls).toEqual([
      'readDocument:scenes/Line.scene.glb',
      'writeDocument:scenes/Line.scene.glb',
    ]);
    // The compare-and-swap token of plan-397, handed straight back: a body
    // somebody else wrote in between changes the revision and the write is
    // refused instead of overwriting them.
    expect(b.lastOpts?.expectedRevision).toBe(revision);
    expect(result.revision).toBe(await revisionOfBytes(b.written!));
    expect(result.classification).toEqual({ v: 1, level: 'plant', tags: ['line3'] });
  });

  it('the bytes it wrote actually carry the classification', async () => {
    const b = fakeBackend();
    await writeDocumentClassification(b, sceneDoc, { v: 1, level: 'assembly' });
    const read = await classificationOfGlbBlob(new Blob([b.written! as BlobPart]));
    expect(read).toEqual({ v: 1, level: 'assembly' });
  });

  it('leaves the BIN chunk byte-identical', async () => {
    const b = fakeBackend();
    await writeDocumentClassification(b, sceneDoc, { v: 1, level: 'part' });
    // `parseGlbChunks` never decodes the BIN chunk, it only locates it: the
    // tail from `restOffset` on is the verbatim rest of the file.
    const before = parseGlbChunks(bytes);
    const after = parseGlbChunks(b.written!);
    const tail = (c: ReturnType<typeof parseGlbChunks>) => c.bytes.subarray(c.restOffset);
    expect(tail(after).length).toBeGreaterThan(0);
    expect(tail(after)).toEqual(tail(before));
  });

  it('states the row it wrote, so the manifest cache can follow the bytes', async () => {
    const b = fakeBackend();
    await writeDocumentClassification(b, sceneDoc, { v: 1, level: 'plant' });
    const ref = b.lastRef as { id?: string; meta?: { classification?: unknown } };
    expect(ref.id).toBe('doc-1');
    expect(ref.meta?.classification).toEqual({ v: 1, level: 'plant' });
  });

  it('an empty classification is a removal, not a block that says nothing', async () => {
    const b = fakeBackend();
    await writeDocumentClassification(b, sceneDoc, { v: 1, level: 'part' });
    const stamped = b.written!;

    // Feed the stamped bytes back in and clear them.
    bytes = stamped;
    revision = await revisionOfBytes(bytes);
    const b2 = fakeBackend();
    const result = await writeDocumentClassification(b2, sceneDoc, { v: 1 });
    expect(result.classification).toBeNull();
    expect(await classificationOfGlbBlob(new Blob([b2.written! as BlobPart]))).toBeNull();
  });

  it('propagates a refused write instead of reporting success', async () => {
    const b = fakeBackend();
    b.writeImpl = async () => { throw new Error('changed since it was read'); };
    await expect(writeDocumentClassification(b, sceneDoc, { v: 1, level: 'part' }))
      .rejects.toThrow(/changed since it was read/);
    // Nothing landed. This is the whole reason the verb throws: a caller that
    // updates its cache after the await never reaches it.
    expect(b.written).toBeNull();
  });
});

describe('writeDocumentClassification — refusals', () => {
  it('refuses a read-only backend before touching anything', async () => {
    const b = fakeBackend(false);
    await expect(writeDocumentClassification(b, sceneDoc, { v: 1, level: 'part' }))
      .rejects.toThrow(/read-only/);
    expect(b.calls).toEqual([]);
  });

  it('refuses a document whose body is not there', async () => {
    const b = fakeBackend();
    b.readImpl = async () => null;
    await expect(writeDocumentClassification(b, sceneDoc, { v: 1, level: 'part' }))
      .rejects.toThrow(/could not be read/);
  });
});

// ─── plan-736: the two surfaces were one operation all along ─────────────

describe('a scene row and a model row are the same operation (plan-736 §2.3 #1)', () => {
  it('takes the same calls, in the same order, with the same precondition', async () => {
    const scene = fakeBackend();
    const model = fakeBackend();
    await writeDocumentClassification(scene, sceneDoc, { v: 1, level: 'assembly' });
    await writeDocumentClassification(model, modelDoc, { v: 1, level: 'assembly' });

    // Same verbs, same order — only the paths differ, which is the ONLY thing
    // that ever legitimately differed between these two documents.
    expect(scene.calls.map(c => c.split(':')[0]))
      .toEqual(model.calls.map(c => c.split(':')[0]));
    expect(model.calls).toEqual([
      'readDocument:models/Press.glb',
      'writeDocument:models/Press.glb',
    ]);

    // The split plan-709 narrowed and plan-736 removed: classifying a scene was
    // conflict-safe, classifying a model was a last-writer-wins overwrite of
    // whatever happened to be on disk. Both carry the read revision now, and
    // there is no spelling of this call that does not carry one.
    expect(model.lastOpts?.expectedRevision).toBe(revision);
    expect(scene.lastOpts?.expectedRevision).toBe(model.lastOpts?.expectedRevision);

    // And the bytes are equally real on both.
    expect(await classificationOfGlbBlob(new Blob([model.written! as BlobPart])))
      .toEqual({ v: 1, level: 'assembly' });
  });

  it('a refused write on a model body throws exactly as on a scene body', async () => {
    const b = fakeBackend();
    b.writeImpl = async () => { throw new Error('changed since it was read'); };
    await expect(writeDocumentClassification(b, modelDoc, { v: 1, level: 'part' }))
      .rejects.toThrow(/changed since it was read/);
    expect(b.written).toBeNull();
  });

  it('never resolves an object URL — the read hands over bytes (plan-709 §2.5)', async () => {
    // The asset branch used to `readBlobUrl` + `fetch` + `release()`, which is
    // the object-URL leak the unified read has no way to create.
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const create = vi.spyOn(URL, 'createObjectURL');
    const b = fakeBackend();
    await writeDocumentClassification(b, modelDoc, { v: 1, level: 'part' });
    expect(create).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    create.mockRestore();
    revoke.mockRestore();
  });
});
