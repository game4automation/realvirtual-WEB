// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-413 phase 2 — the two primitives the mirror tests do not touch:
 * `mergeDocumentTiers` / `forkDocumentEntry`, and the classification scan.
 *
 * The tier merge is a **behaviour transfer**, not a new idea: it has to do
 * exactly what `mergeSceneTiers` and `mergeAssetTiers` do, because those two
 * are what the shipped demos and every existing fork rely on. The catch is that
 * the two disagreed about what `forkedFrom` holds — scenes recorded an id,
 * assets a path — and a document is both at once. Half the forks silently
 * losing their shadow is the failure this file is here to catch.
 *
 * The scan tests are about a number: zero. §2.5 promises that a hundred
 * unchanged documents cost zero GLB reads, and that promise is the only reason
 * the scan can sit in the project-open path at all.
 */

import { describe, it, expect } from 'vitest';
import {
  forkDocumentEntry,
  mergeDocumentTiers,
} from '../src/core/project/rv-project-tiers';
import {
  classificationOfGlbBlob,
  classificationOfGltfJson,
  collectDocumentTags,
  reconcileClassificationCache,
} from '../src/core/project/rv-project-documents';
import type { RvDocumentEntry } from '../src/core/project/rv-project-types';
import type { DocumentClassification } from '../src/core/project/rv-document-classification';

// ─── Fixtures ───────────────────────────────────────────────────────────

function doc(over: Partial<RvDocumentEntry> & { id: string; path: string }): RvDocumentEntry {
  return { name: over.id, ...over };
}

const PLANT: DocumentClassification = { v: 1, level: 'plant', tags: ['line3'] };
const PART: DocumentClassification = { v: 1, level: 'part' };

// ─── Tiers ──────────────────────────────────────────────────────────────

describe('mergeDocumentTiers', () => {
  it('shows both tiers in one list, each tagged', () => {
    const merged = mergeDocumentTiers(
      [doc({ id: 'b1', path: 'models/demo.glb' })],
      [doc({ id: 'u1', path: 'models/mine.glb' })],
    );
    expect(merged.entries.map(e => [e.id, e.tier])).toEqual([['b1', 'bundled'], ['u1', 'user']]);
    expect([...merged.ids].sort()).toEqual(['b1', 'u1']);
  });

  it('lets a user entry with the same id shadow the bundled one, in its slot', () => {
    const merged = mergeDocumentTiers(
      [doc({ id: 'b1', path: 'a.glb' }), doc({ id: 'b2', path: 'b.glb' })],
      [doc({ id: 'b1', path: 'a.glb', name: 'edited' })],
    );
    expect(merged.entries.map(e => e.id)).toEqual(['b1', 'b2']);   // order kept
    expect(merged.entries[0]!.tier).toBe('user');
    expect(merged.entries[0]!.name).toBe('edited');
  });

  it('resolves forkedFrom by ID — the scene-tier convention', () => {
    const merged = mergeDocumentTiers(
      [doc({ id: 'scn_demo', path: 'scenes/demo.scene.glb' })],
      [doc({ id: 'scn_fork', path: 'scenes/fork.scene.glb', forkedFrom: 'scn_demo' })],
    );
    expect(merged.entries).toHaveLength(1);
    expect(merged.entries[0]!.id).toBe('scn_fork');
  });

  it('resolves forkedFrom by PATH — the asset-tier convention', () => {
    // The half that a key-on-id-only merge would silently drop: every asset
    // fork made before this plan recorded the origin's path.
    const merged = mergeDocumentTiers(
      [doc({ id: 'doc_demo', path: 'library/belt.glb' })],
      [doc({ id: 'doc_mine', path: 'library/belt-copy.glb', forkedFrom: 'library/belt.glb' })],
    );
    expect(merged.entries).toHaveLength(1);
    expect(merged.entries[0]!.id).toBe('doc_mine');
  });

  it('hides an entry without deleting it', () => {
    const merged = mergeDocumentTiers(
      [doc({ id: 'b1', path: 'a.glb' }), doc({ id: 'b2', path: 'b.glb' })],
      [],
      ['b1'],
    );
    expect(merged.entries.map(e => e.id)).toEqual(['b2']);
    expect(merged.ids.has('b1')).toBe(false);
  });
});

describe('forkDocumentEntry', () => {
  it('gives the fork a new id and points it back at the original', () => {
    const forked = forkDocumentEntry(
      doc({ id: 'b1', path: 'scenes/demo.scene.glb', classification: PLANT }),
      'u9',
    );
    expect(forked.id).toBe('u9');
    expect(forked.forkedFrom).toBe('b1');
    expect(forked.tier).toBe('user');
    // The classification travels with the fork: it describes the content, and
    // the copy has the same content.
    expect(forked.classification).toEqual(PLANT);
  });

  it('applies overrides without letting them take the id back', () => {
    const forked = forkDocumentEntry(
      doc({ id: 'b1', path: 'a.glb' }),
      'u9',
      { name: 'My copy', id: 'ignored' } as Partial<RvDocumentEntry>,
    );
    expect(forked.name).toBe('My copy');
    expect(forked.id).toBe('u9');
  });
});

// ─── The scan ───────────────────────────────────────────────────────────

describe('classification scan', () => {
  it('reads NOTHING when size and mtime are unchanged (the NFR)', async () => {
    const documents = Array.from({ length: 100 }, (_, i) =>
      doc({ id: `d${i}`, path: `models/${i}.glb`, sizeBytes: 10, mtimeMs: 5 }));
    const stats = documents.map(d => ({ path: d.path, size: 10, mtime: 5 }));

    const result = await reconcileClassificationCache(documents, {
      stats,
      readClassification: async () => { throw new Error('must not be called'); },
    });
    expect(result.read).toEqual([]);
    expect(result.changed).toEqual([]);
  });

  it('clears the pre-filter on an unchanged digest alone', async () => {
    // Content-addressed storage (the browser backend) has something better than
    // a timestamp: proof.
    const documents = [doc({ id: 'd', path: 'scenes/a.scene.glb', sha256: 'aa' })];
    const result = await reconcileClassificationCache(documents, {
      stats: [{ path: 'scenes/a.scene.glb', size: 999, sha256: 'aa' }],
      readClassification: async () => { throw new Error('must not be called'); },
    });
    expect(result.read).toEqual([]);
  });

  it('re-reads and lets the GLB win when the stats moved', async () => {
    const documents = [
      doc({ id: 'd', path: 'models/a.glb', sizeBytes: 10, mtimeMs: 5, classification: PART }),
    ];
    const result = await reconcileClassificationCache(documents, {
      stats: [{ path: 'models/a.glb', size: 20, mtime: 9 }],
      readClassification: async () => PLANT,
    });

    expect(result.read).toEqual(['models/a.glb']);
    expect(result.changed).toEqual(['models/a.glb']);
    expect(result.documents[0]!.classification).toEqual(PLANT);
    expect(result.documents[0]!.sizeBytes).toBe(20);
    expect(result.documents[0]!.mtimeMs).toBe(9);
  });

  it('drops a cached classification the file no longer carries', async () => {
    const documents = [doc({ id: 'd', path: 'models/a.glb', classification: PART })];
    const result = await reconcileClassificationCache(documents, {
      stats: [{ path: 'models/a.glb', size: 1 }],
      readClassification: async () => null,
    });
    expect(result.documents[0]).not.toHaveProperty('classification');
    expect(result.changed).toEqual(['models/a.glb']);
  });

  it('does not report a change when the file says what the cache already said', async () => {
    const documents = [doc({ id: 'd', path: 'models/a.glb', classification: PLANT })];
    const result = await reconcileClassificationCache(documents, {
      stats: [{ path: 'models/a.glb', size: 1 }],
      // Same value, different object and tag order — a value comparison, not a
      // reference one, or the open path would publish on every single scan.
      readClassification: async () => ({ v: 1, level: 'plant', tags: ['line3'] }),
    });
    expect(result.read).toEqual(['models/a.glb']);
    expect(result.changed).toEqual([]);
  });

  it('leaves a document alone when the backend cannot stat it', async () => {
    // "No stat" is how bundled/HTTP says its manifest is authoritative.
    const documents = [doc({ id: 'd', path: 'models/a.glb', classification: PART })];
    const result = await reconcileClassificationCache(documents, {
      stats: [],
      readClassification: async () => { throw new Error('must not be called'); },
    });
    expect(result.documents[0]!.classification).toEqual(PART);
  });

  it('treats an unreadable file as unclassified rather than throwing', async () => {
    const documents = [doc({ id: 'd', path: 'models/a.glb' })];
    const result = await reconcileClassificationCache(documents, {
      stats: [{ path: 'models/a.glb', size: 1 }],
      readClassification: async () => { throw new Error('disk on fire'); },
    });
    expect(result.documents[0]).not.toHaveProperty('classification');
  });
});

// ─── Reading a classification out of GLB bytes ──────────────────────────

describe('classificationOfGltfJson / classificationOfGlbBlob', () => {
  function gltf(sceneIndex: number, scenes: unknown[]): unknown {
    return { scene: sceneIndex, scenes };
  }

  it('reads the canonical default scene, not scene 0 (SOL R1-8)', () => {
    const json = gltf(1, [
      { extras: { realvirtual: { Classification: { v: 1, level: 'part' } } } },
      { extras: { realvirtual: { Classification: { v: 1, level: 'plant' } } } },
    ]);
    expect(classificationOfGltfJson(json)?.level).toBe('plant');
  });

  it('falls back to scene 0 when `scene` is absent', () => {
    const json = { scenes: [{ extras: { realvirtual: { Classification: { v: 1, level: 'part' } } } }] };
    expect(classificationOfGltfJson(json)?.level).toBe('part');
  });

  it('returns null for anything without one, and never throws', () => {
    expect(classificationOfGltfJson(null)).toBeNull();
    expect(classificationOfGltfJson({})).toBeNull();
    expect(classificationOfGltfJson(gltf(9, []))).toBeNull();
    expect(classificationOfGltfJson(gltf(0, [{ extras: 'not an object' }]))).toBeNull();
  });

  it('reads a real GLB by slicing only the JSON chunk', async () => {
    const json = JSON.stringify({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ extras: { realvirtual: { Classification: { v: 1, level: 'assembly', tags: ['x'] } } } }],
    });
    expect(await classificationOfGlbBlob(makeGlb(json))).toEqual({
      v: 1, level: 'assembly', tags: ['x'],
    });
  });

  it('returns null for a file that is not a GLB at all', async () => {
    expect(await classificationOfGlbBlob(new Blob(['not a glb, not even close']))).toBeNull();
    expect(await classificationOfGlbBlob(new Blob([]))).toBeNull();
  });
});

/** Minimal GLB container: 12-byte header + one JSON chunk. No BIN tail. */
function makeGlb(json: string): Blob {
  const jsonBytes = new TextEncoder().encode(json);
  const padded = new Uint8Array(Math.ceil(jsonBytes.length / 4) * 4).fill(0x20);
  padded.set(jsonBytes);
  const out = new Uint8Array(12 + 8 + padded.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);            // 'glTF'
  view.setUint32(4, 2, true);                     // version
  view.setUint32(8, out.length, true);            // total length
  view.setUint32(12, padded.length, true);        // chunk length
  view.setUint32(16, 0x4e4f534a, true);           // 'JSON'
  out.set(padded, 20);
  return new Blob([out]);
}

// ─── Tag collection (the phase-4 autocomplete source) ───────────────────

describe('collectDocumentTags', () => {
  it('collects every distinct tag, sorted, without duplicates', () => {
    expect(collectDocumentTags([
      doc({ id: 'a', path: 'a.glb', classification: { v: 1, tags: ['presse', 'kuka'] } }),
      doc({ id: 'b', path: 'b.glb', classification: { v: 1, tags: ['kuka'] } }),
      doc({ id: 'c', path: 'c.glb' }),
    ])).toEqual(['kuka', 'presse']);
  });
});
