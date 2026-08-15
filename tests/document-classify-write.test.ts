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
 *  - a scene body carries the plan-397 **compare-and-swap** token, so a body
 *    somebody else changed in the meantime is refused rather than clobbered;
 *  - a refused write **throws**, which is what keeps a caller's cache update
 *    from running after a write that did not happen.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';

import { objectToGlb } from '../src/core/import/rv-import-object';
import { writeDocumentClassification } from '../src/core/project/rv-document-classify';
import { classificationOfGlbBlob } from '../src/core/project/rv-project-documents';
import { parseGlbChunks } from '../src/core/persistence/rv-glb-chunks';
import { revisionOfBytes, type SceneRecord, type SceneWrite } from '../src/core/project/rv-scene-record';
import type {
  ProjectBackend,
  WriteBlobOptions,
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
  lastWrite: SceneWrite | null;
  /** What the BLOB surface was asked to check (plan-709 §2.3). */
  lastBlobOpts: WriteBlobOptions | undefined;
  writeSceneImpl: ((relPath: string, write: SceneWrite) => Promise<string>) | null;
  writeBlobImpl: ((relPath: string, blob: Blob) => Promise<void>) | null;
}

function fakeBackend(writable = true): FakeBackend {
  const urls: string[] = [];
  const b = {
    kind: 'folder',
    id: 'fake',
    writable,
    isActive: true,
    calls: [] as string[],
    written: null as Uint8Array | null,
    lastWrite: null as SceneWrite | null,
    lastBlobOpts: undefined as WriteBlobOptions | undefined,
    writeSceneImpl: null as ((relPath: string, write: SceneWrite) => Promise<string>) | null,
    writeBlobImpl: null as ((relPath: string, blob: Blob) => Promise<void>) | null,

    async readScene(relPath: string): Promise<SceneRecord | null> {
      b.calls.push('readScene:' + relPath);
      return {
        glb: bytes, revision,
        meta: { id: 'doc-1', name: 'Line', path: relPath },
      };
    },
    async readBlobUrl(relPath: string) {
      b.calls.push('readBlobUrl:' + relPath);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
      urls.push(url);
      return { url, release: () => URL.revokeObjectURL(url) };
    },
    async writeScene(relPath: string, write: SceneWrite) {
      b.calls.push('writeScene:' + relPath);
      if (b.writeSceneImpl) return b.writeSceneImpl(relPath, write);
      b.written = write.glb;
      b.lastWrite = write;
      return revisionOfBytes(write.glb);
    },
    async writeBlob(relPath: string, blob: Blob, opts?: WriteBlobOptions) {
      b.calls.push('writeBlob:' + relPath);
      b.lastBlobOpts = opts;
      if (b.writeBlobImpl) return b.writeBlobImpl(relPath, blob);
      b.written = new Uint8Array(await blob.arrayBuffer());
    },
    // Unused by this verb, present because the contract has them.
    readManifest: async () => null,
    readSettings: async () => null,
    listScenes: async () => [],
    listModels: async () => [],
    listLibrary: async () => [],
    listDocuments: async () => [],
    statDocuments: async () => [],
    activate: async () => {},
    deactivate: async () => {},
    deleteScene: async () => {},
    deleteBlob: async () => {},
    flush: async () => {},
  } as unknown as FakeBackend;
  return b;
}

const sceneDoc: RvDocumentEntry = {
  id: 'doc-1', path: 'scenes/Line.scene.glb', name: 'Line', section: 'scenes',
};
const modelDoc: RvDocumentEntry = {
  id: 'doc-2', path: 'models/Press.glb', name: 'Press', section: 'models',
};

// ─── tests ───────────────────────────────────────────────────────────────

describe('writeDocumentClassification — a scene body', () => {
  it('reads, patches and writes back under the revision it read', async () => {
    const b = fakeBackend();
    const result = await writeDocumentClassification(
      b, sceneDoc, { v: 1, level: 'plant', tags: ['line3'] });

    expect(b.calls).toEqual(['readScene:scenes/Line.scene.glb', 'writeScene:scenes/Line.scene.glb']);
    // The compare-and-swap token of plan-397, handed straight back: a body
    // somebody else wrote in between changes the revision and the write is
    // refused instead of overwriting them.
    expect(b.lastWrite?.expectedRevision).toBe(revision);
    expect(result.surface).toBe('scene');
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
    b.writeSceneImpl = async () => { throw new Error('changed since it was read'); };
    await expect(writeDocumentClassification(b, sceneDoc, { v: 1, level: 'part' }))
      .rejects.toThrow(/changed since it was read/);
    // Nothing landed. This is the whole reason the verb throws: a caller that
    // updates its cache after the await never reaches it.
    expect(b.written).toBeNull();
  });
});

describe('writeDocumentClassification — an asset body', () => {
  it('goes through the blob surface and says so', async () => {
    const b = fakeBackend();
    const result = await writeDocumentClassification(b, modelDoc, { v: 1, level: 'assembly' });
    expect(b.calls).toEqual(['readBlobUrl:models/Press.glb', 'writeBlob:models/Press.glb']);
    // `surface` still names WHICH store took the bytes. Since plan-709 §2.3 it
    // no longer implies anything about safety — see the next test.
    expect(result.surface).toBe('blob');
    expect(await classificationOfGlbBlob(new Blob([b.written! as BlobPart])))
      .toEqual({ v: 1, level: 'assembly' });
  });

  it('carries the SAME compare-and-swap token the scene branch does (§2.3)', async () => {
    // This is the split plan-709 removed. It used to be a documented asymmetry:
    // classifying a scene was conflict-safe, classifying a model was a
    // last-writer-wins overwrite of whatever was on disk.
    const b = fakeBackend();
    await writeDocumentClassification(b, modelDoc, { v: 1, level: 'assembly' });
    expect(b.lastBlobOpts?.expectedRevision).toBe(await revisionOfBytes(bytes));
  });

  it('propagates a refused BLOB write instead of reporting success', async () => {
    const b = fakeBackend();
    b.writeBlobImpl = async () => { throw new Error('changed since it was read'); };
    await expect(writeDocumentClassification(b, modelDoc, { v: 1, level: 'part' }))
      .rejects.toThrow(/changed since it was read/);
    expect(b.written).toBeNull();
  });

  it('releases the object URL even when the read throws', async () => {
    const b = fakeBackend();
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('network'));
    await expect(writeDocumentClassification(b, modelDoc, { v: 1, level: 'part' }))
      .rejects.toThrow(/network/);
    expect(revoke).toHaveBeenCalled();
    fetchSpy.mockRestore();
    revoke.mockRestore();
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
    b.readScene = async () => null;
    await expect(writeDocumentClassification(b, sceneDoc, { v: 1, level: 'part' }))
      .rejects.toThrow(/could not be read/);
  });
});
