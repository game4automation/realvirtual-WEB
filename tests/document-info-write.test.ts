// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-506 §9.2 — describing a document writes the FILE, bytes first.
 *
 * Template: `document-classify-write.test.ts`. The same three claims about the
 * byte write — the fast bake path (JSON chunk patched, BIN tail byte-identical),
 * the mandatory compare-and-swap on the revision just read, and a refused write
 * that throws — plus the one thing this verb adds: it STAMPS the block
 * (`updatedAt`, `updatedBy`) and ignores whatever stamps a caller brought.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';

import { objectToGlb } from '../src/core/import/rv-import-object';
import { writeDocumentInfo } from '../src/core/project/rv-document-info-write';
import { writeDocumentClassification } from '../src/core/project/rv-document-classify';
import { sceneExtrasOfGlbBlob } from '../src/core/project/rv-project-documents';
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
  root.add(new Mesh(new BoxGeometry(1, 1, 1), material));
  return root;
}

let bytes: Uint8Array;
let revision: string;

beforeEach(async () => {
  bytes = new Uint8Array(await objectToGlb(buildTree()));
  revision = await revisionOfBytes(bytes);
});

interface FakeBackend extends ProjectBackend {
  calls: string[];
  written: Uint8Array | null;
  lastRef: DocRef | null;
  lastOpts: WriteDocumentOptions | null;
  failWrite: boolean;
}

function fakeBackend(writable = true): FakeBackend {
  const b = {
    kind: 'folder', id: 'fake', writable, isActive: true,
    calls: [] as string[], written: null as Uint8Array | null,
    lastRef: null as DocRef | null, lastOpts: null as WriteDocumentOptions | null,
    failWrite: false,
    async readDocument(ref: DocRef): Promise<DocumentRecord | null> {
      b.calls.push('readDocument:' + docPathOf(ref));
      return { bytes, revision, meta: { id: 'doc-1', name: 'Press', path: docPathOf(ref) } };
    },
    async readDocumentUrl() { return null; },
    async writeDocument(ref: DocRef, written: Uint8Array, opts: WriteDocumentOptions) {
      b.calls.push('writeDocument:' + docPathOf(ref));
      b.lastRef = ref;
      b.lastOpts = opts;
      if (b.failWrite) throw new Error('changed since it was read');
      b.written = written;
      return { revision: await revisionOfBytes(written) };
    },
  } as unknown as FakeBackend;
  return b;
}

const doc: RvDocumentEntry = { id: 'doc-1', path: 'models/Press.glb', name: 'Press' };
const NOW = () => new Date('2026-09-26T10:00:00.000Z');

describe('plan-506 §9.2 — writeDocumentInfo', () => {
  it('reads, patches and writes back under the revision it read', async () => {
    const b = fakeBackend();
    const result = await writeDocumentInfo(b, doc, { v: 1, summary: 'Press 400 t' }, { now: NOW, updatedBy: null });
    expect(b.calls).toEqual(['readDocument:models/Press.glb', 'writeDocument:models/Press.glb']);
    expect(b.lastOpts?.expectedRevision).toBe(revision);
    expect(result.revision).toBe(await revisionOfBytes(b.written!));
    expect(result.documentInfo).toEqual({ v: 1, summary: 'Press 400 t', updatedAt: '2026-09-26T10:00:00.000Z' });
  });

  it('stamps updatedAt and updatedBy, ignoring caller stamps', async () => {
    const b = fakeBackend();
    const result = await writeDocumentInfo(b, doc,
      { v: 1, description: '# P\n\nText', updatedAt: '1999-01-01T00:00:00Z', updatedBy: 'Forged' },
      { now: NOW, updatedBy: 'Thomas' });
    expect(result.documentInfo?.updatedAt).toBe('2026-09-26T10:00:00.000Z');
    expect(result.documentInfo?.updatedBy).toBe('Thomas');
    const read = await sceneExtrasOfGlbBlob(new Blob([b.written! as BlobPart]));
    expect(read?.documentInfo).toEqual(result.documentInfo);
  });

  it('leaves the BIN chunk byte-identical', async () => {
    const b = fakeBackend();
    await writeDocumentInfo(b, doc, { v: 1, summary: 'S' }, { now: NOW });
    const tail = (c: ReturnType<typeof parseGlbChunks>) => c.bytes.subarray(c.restOffset);
    const after = tail(parseGlbChunks(b.written!));
    expect(after.length).toBeGreaterThan(0);
    expect(after).toEqual(tail(parseGlbChunks(bytes)));
  });

  it('states the row it wrote, with the scan marker (F13)', async () => {
    const b = fakeBackend();
    await writeDocumentInfo(b, doc, { v: 1, summary: 'S' }, { now: NOW, updatedBy: null });
    const meta = (b.lastRef as { meta?: Record<string, unknown> }).meta!;
    expect(meta.documentInfo).toEqual({ v: 1, summary: 'S', updatedAt: '2026-09-26T10:00:00.000Z' });
    expect(meta.extrasScan).toBe(2);
  });

  it('can keep an imported blob path-addressed without dropping revision protection', async () => {
    const b = fakeBackend();
    const result = await writeDocumentInfo(b, doc, { v: 1, summary: 'Imported part' },
      { addressByPath: true, now: NOW, updatedBy: null });
    expect(b.lastRef).toBe(doc.path);
    expect(b.lastOpts?.expectedRevision).toBe(revision);
    const read = await sceneExtrasOfGlbBlob(new Blob([b.written! as BlobPart]));
    expect(read?.documentInfo).toEqual(result.documentInfo);
  });

  it('an empty block is a removal, and the neighbour block survives', async () => {
    const b1 = fakeBackend();
    await writeDocumentClassification(b1, doc, { v: 1, level: 'plant' });
    bytes = b1.written!; revision = await revisionOfBytes(bytes);
    const b2 = fakeBackend();
    await writeDocumentInfo(b2, doc, { v: 1, summary: 'S' }, { now: NOW });
    bytes = b2.written!; revision = await revisionOfBytes(bytes);
    const b3 = fakeBackend();
    const result = await writeDocumentInfo(b3, doc, { v: 1, summary: '  ' }, { now: NOW });
    expect(result.documentInfo).toBeNull();
    const read = await sceneExtrasOfGlbBlob(new Blob([b3.written! as BlobPart]));
    expect(read?.documentInfo).toBeNull();
    expect(read?.classification).toEqual({ v: 1, level: 'plant' });
    expect((b3.lastRef as { meta?: Record<string, unknown> }).meta).not.toHaveProperty('documentInfo');
  });

  it('propagates a refused write, and refuses a read-only backend untouched', async () => {
    const b = fakeBackend();
    b.failWrite = true;
    await expect(writeDocumentInfo(b, doc, { v: 1, summary: 'S' })).rejects.toThrow(/changed since/);
    expect(b.written).toBeNull();
    const ro = fakeBackend(false);
    await expect(writeDocumentInfo(ro, doc, { v: 1, summary: 'S' })).rejects.toThrow(/read-only/);
    expect(ro.calls).toEqual([]);
  });
});
