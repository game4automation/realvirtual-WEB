// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * §9.9 — asset identity is imprinted at the PERSISTENCE step, never by looking
 * (plan-703 Phase 5, §2.5).
 *
 * Four cases, and each one is a rule the plan states in one sentence:
 *
 *  1. a scan imprints nothing,
 *  2. the first persistence imprints exactly one manifest row,
 *  3. two files with one id is an error with a message,
 *  4. a transient placement imprints nothing.
 *
 * Renderer-free and storage-free: every function under test takes a manifest and
 * returns a manifest, which is the whole reason the rules were put in a pure
 * module instead of inside the store that persists them.
 */

import { describe, it, expect } from 'vitest';
import escalateSource from '../src/core/share/rv-share-escalate.ts?raw';
import sceneStoreSource from '../src/core/hmi/scene/scene-store.ts?raw';
import {
  DocumentIdCollisionError,
  assertNoDocumentIdCollisions,
  findDocumentById,
  findDocumentByPath,
  findLocalIdCollisions,
  mintAssetIdentity,
  mintReferencedAssets,
  mintableReferences,
  previewAssetId,
  type WrittenGlbReference,
} from '../src/core/project/rv-asset-identity';
import type { RvDocumentEntry, RvProject } from '../src/core/project/rv-project-types';

function project(documents: RvDocumentEntry[] = []): RvProject {
  return {
    schemaVersion: 2,
    id: 'proj_test',
    name: 'Test project',
    documents,
  } as unknown as RvProject;
}

/** What the Phase-6 tree finds on disk, before anything has a manifest row. */
const SCANNED = [
  'models/Filler.glb',
  'library/parts/Roll2m.glb',
  'library/parts/Roll3m.glb',
];

describe('§9.9.1 — browsing imprints nothing', () => {
  it('leaves the manifest empty while every scanned file still gets an id', () => {
    const before = project();
    const ids = SCANNED.map(previewAssetId);

    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(before.documents).toEqual([]);
    for (const path of SCANNED) expect(findDocumentByPath(before, path)).toBeNull();
  });

  it('derives the same id on every call and on every machine', () => {
    expect(previewAssetId('models/Filler.glb')).toBe(previewAssetId('models/Filler.glb'));
    expect(previewAssetId('models/Filler.glb')).not.toBe(previewAssetId('models/Capper.glb'));
  });

  it('a scan does not turn a browse-time id into a row', () => {
    const scanned = project();
    for (const path of SCANNED) {
      expect(findDocumentById(scanned, previewAssetId(path))).toBeNull();
    }
    expect(scanned.documents).toEqual([]);
  });
});

describe('§9.9.2 — the first persistence imprints exactly one row', () => {
  const written: WrittenGlbReference[] = [
    { assetId: previewAssetId('library/parts/Roll2m.glb'), path: 'library/parts/Roll2m.glb' },
  ];

  it('mints one row, with the id the browse already used', () => {
    const before = project();
    const due = mintableReferences(before, written);
    expect(due).toEqual([{ path: 'library/parts/Roll2m.glb' }]);

    const after = mintReferencedAssets(before, due);
    expect(after.minted).toHaveLength(1);
    expect(after.minted[0].id).toBe(previewAssetId('library/parts/Roll2m.glb'));
    expect(after.minted[0].path).toBe('library/parts/Roll2m.glb');
    expect(after.minted[0].section).toBe('library');
    expect(after.minted[0].name).toBe('Roll2m');
    expect(before.documents).toEqual([]);          // the input is not mutated
  });

  it('imprints ONE row for two hundred placements of the same asset', () => {
    const base = project();
    const many: WrittenGlbReference[] = Array.from({ length: 200 }, () => written[0]);
    const after = mintReferencedAssets(base, mintableReferences(base, many));
    expect(after.minted).toHaveLength(1);
  });

  it('is idempotent — a second save imprints nothing', () => {
    const base = project();
    const first = mintReferencedAssets(base, mintableReferences(base, written));
    const second = mintableReferences(first.project, written);
    expect(second).toEqual([]);

    const again = mintReferencedAssets(first.project, second);
    expect(again.minted).toEqual([]);
    // Same object back: the caller skips its disk write on identity.
    expect(again.project).toBe(first.project);
  });

  it('skips references that point outside the project', () => {
    const outside: WrittenGlbReference[] = [
      { assetId: 'cat_belt', path: 'https://cdn.example.com/belt.glb' },
      { assetId: 'cat_belt2', path: 'blob:http://localhost/abcd' },
      { assetId: 'cat_belt3', path: '../outside/thing.glb' },
      { assetId: 'cat_belt4', path: '' },
    ];
    expect(mintableReferences(project(), outside)).toEqual([]);
  });

  it('skips a reference whose id belongs to a catalog, not to this project', () => {
    // A library placement carries the catalog's own id. Re-issuing it here would
    // claim ownership of somebody else's identity.
    const catalog: WrittenGlbReference[] = [
      { assetId: 'conveyor-catalog:belt-2m', path: 'library/parts/Roll2m.glb' },
    ];
    expect(mintableReferences(project(), catalog)).toEqual([]);
  });

  it('skips a reference whose id already has a row', () => {
    const known = project([
      { id: 'doc_custom', path: 'library/parts/Roll2m.glb', name: 'Roll 2m', section: 'library' },
    ]);
    const refs: WrittenGlbReference[] = [
      { assetId: 'doc_custom', path: 'library/parts/Roll2m.glb' },
    ];
    expect(mintableReferences(known, refs)).toEqual([]);
  });
});

describe('§9.9.3 — a copy with the same id is reported, not aliased', () => {
  const copied = () => project([
    { id: 'doc_shared', path: 'library/A.glb', name: 'A', section: 'library' },
    { id: 'doc_shared', path: 'library/B.glb', name: 'B', section: 'library' },
  ]);

  it('finds the collision inside one manifest', () => {
    const found = findLocalIdCollisions(copied());
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe('doc_shared');
    expect(found[0].paths).toEqual(['library/A.glb', 'library/B.glb']);
  });

  it('throws with both paths named in the message', () => {
    let thrown: unknown = null;
    try { assertNoDocumentIdCollisions(copied()); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(DocumentIdCollisionError);
    const message = (thrown as Error).message;
    expect(message).toContain('library/A.glb');
    expect(message).toContain('library/B.glb');
    expect(message).toContain('doc_shared');
  });

  it('a clean manifest passes', () => {
    const clean = project([
      { id: 'doc_a', path: 'library/A.glb', name: 'A', section: 'library' },
      { id: 'doc_b', path: 'library/B.glb', name: 'B', section: 'library' },
    ]);
    expect(() => assertNoDocumentIdCollisions(clean)).not.toThrow();
    expect(findLocalIdCollisions(clean)).toEqual([]);
  });

  it('the mint refuses to write a row whose id another path already holds', () => {
    // The Unity fall pattern: a file copied in from outside carries an id that
    // derives from somebody else's path.
    const id = previewAssetId('library/A.glb');
    const squatted = project([
      { id, path: 'library/Elsewhere.glb', name: 'Elsewhere', section: 'library' },
    ]);
    expect(() => mintAssetIdentity(squatted, { path: 'library/A.glb' }))
      .toThrow(DocumentIdCollisionError);
  });
});

describe('§9.9.4 — a transient placement imprints nothing', () => {
  it('mints nothing when no reference reached the bytes', () => {
    const before = project();
    const result = mintReferencedAssets(before, mintableReferences(before, []));
    expect(result.minted).toEqual([]);
    expect(result.project).toBe(before);
  });

  it('rv-share-escalate needs no special rule — it cannot reach the mint', () => {
    // The plan is explicit (§2.5, A12): the transient path stays unnamed WITHOUT
    // a carve-out in the escalate code. The structural proof is that it knows
    // nothing about identity and writes no bytes.
    expect(escalateSource).not.toContain('rv-asset-identity');
    expect(escalateSource).not.toContain('mintReferencedAssetIdentities');
    // ...and the file still says so itself, so a future edit that starts writing
    // bytes there has to change this sentence first.
    expect(escalateSource).toContain('No new executor, nothing written');
  });

  it('the one production caller sits after the body write, not on the op', () => {
    const call = sceneStoreSource.indexOf('mintReferencedAssetIdentities');
    const bodyWrite = sceneStoreSource.indexOf('writeSceneGlbBody({');
    expect(call).toBeGreaterThan(-1);
    expect(bodyWrite).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(bodyWrite);
  });
});
