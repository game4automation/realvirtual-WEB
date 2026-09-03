// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-736 §9.3 / F4 — a `section` this build no longer writes is a field it
 * must never DELETE.
 *
 * Eleven of the fifteen delivered per-project `project.json` files carry
 * `section` values (Toray, festo, mauser3dhmi, wmyb, demo-process-industry, …).
 * Those deploys shipped; nothing can go back and rewrite them, and nothing
 * should: the field costs a delivered customer nothing, while an update that
 * silently stripped it would be an unannounced edit to a file the customer owns
 * — and one that an older client of theirs still reads for storage routing.
 *
 * So the contract has two halves, and they are opposite:
 *
 *  - **Old rows keep it.** A manifest with `section` opens, is edited, is saved,
 *    and the untouched rows come back byte-identical.
 *  - **New rows do not get it.** Nothing this build writes stamps the field.
 *
 * Both are the forward-compatibility contract that already existed —
 * `isValidProjectV1` rejects nothing for carrying an unknown field, and
 * `mergeManifest`'s `{...prev, ...incoming}` read-modify-write carries one
 * through untouched. This file pins that the plan USED that contract rather
 * than changing it.
 */

import { describe, it, expect } from 'vitest';
import {
  documentsOf,
  readDocuments,
  sectionOfDocument,
  withDerivedDocuments,
} from '../src/core/project/rv-project-documents';
import { documentRowFor } from '../src/core/project/rv-document-ops';
import { mintAssetIdentity } from '../src/core/project/rv-asset-identity';
import { isValidProjectV1, type RvProject } from '../src/core/project/rv-project-types';

/** A manifest as a customer deploy shipped it, section values and all. */
function deliveredManifest(): RvProject {
  return {
    schemaVersion: 3,
    id: 'prj_toray_like',
    name: 'Delivered',
    documents: [
      { id: 'scn_line', name: 'Line', path: 'scenes/Line.scene.glb', section: 'scenes' },
      { id: 'doc_press', name: 'Press', path: 'models/Press.glb', section: 'models' },
      { id: 'doc_belt', name: 'Belt', path: 'library/Belt.glb', section: 'library' },
      // The interesting one: a stored section that does NOT match the path.
      // A bare-id browser scene looks exactly like this.
      { id: 'scn_bare', name: 'Bare', path: 'scn_bare', section: 'scenes' },
    ],
  } as unknown as RvProject;
}

describe('a delivered manifest that carries section', () => {
  it('is still valid — nothing rejects a field this build does not write', () => {
    expect(isValidProjectV1(deliveredManifest())).toBe(true);
  });

  it('reads back every row with its section intact', () => {
    const rows = readDocuments(deliveredManifest())!;
    expect(rows.map(r => r.section))
      .toEqual(['scenes', 'models', 'library', 'scenes']);
  });

  it('survives the read-side derivation that runs on every foreign manifest', () => {
    // `withDerivedDocuments` is what the bundled and browser backends put a
    // manifest through before anything reads it. It drops the legacy ARRAYS and
    // must not touch the rows.
    const derived = withDerivedDocuments(deliveredManifest());
    expect(documentsOf(derived).map(r => r.section))
      .toEqual(['scenes', 'models', 'library', 'scenes']);
  });

  it('an untouched row comes back byte-identical through a read-modify-write', () => {
    // The `{...prev, ...incoming}` shape every manifest write goes through. A
    // save that edits one row must leave the others exactly as they were,
    // including fields this build has no type for.
    const before = deliveredManifest();
    const rows = readDocuments(before)!;
    const edited = rows.map(r => (r.id === 'doc_press' ? { ...r, name: 'Press 2' } : r));
    const after = { ...before, documents: edited } as RvProject;

    const untouched = documentsOf(after).filter(r => r.id !== 'doc_press');
    expect(JSON.stringify(untouched))
      .toBe(JSON.stringify(documentsOf(before).filter(r => r.id !== 'doc_press')));
    // …and the edited row kept its own section too — the edit was a name.
    expect(documentsOf(after).find(r => r.id === 'doc_press')?.section).toBe('models');
  });

  it('the stored value still wins over the path heuristic where they disagree', () => {
    // The `scn_bare` row: path says "library" to the heuristic, the stored value
    // says "scenes". Reading it correctly is what the transitional stamp on
    // `documentOfSceneEntry` is FOR, so the legacy reader has to prefer it.
    const bare = documentsOf(deliveredManifest()).find(r => r.id === 'scn_bare')!;
    expect(sectionOfDocument(bare)).toBe('scenes');
    expect(sectionOfDocument({ ...bare, section: undefined })).toBe('library');
  });
});

describe('a row this build writes', () => {
  it('documentRowFor stamps no section', () => {
    const row = documentRowFor(
      { documentId: 'doc_new', relPath: 'library/parts/New.glb', name: 'New' },
      '2026-09-02T00:00:00.000Z',
    );
    expect(row.section).toBeUndefined();
    expect(row.path).toBe('library/parts/New.glb');
  });

  it('documentRowFor stamps no section for a scenes/ path either', () => {
    const row = documentRowFor(
      { documentId: 'doc_scene', relPath: 'scenes/New.glb', name: 'New' },
      '2026-09-02T00:00:00.000Z',
    );
    expect(row.section).toBeUndefined();
  });

  it('mintAssetIdentity stamps no section', () => {
    const empty = { schemaVersion: 3, id: 'p', name: 'P', documents: [] } as unknown as RvProject;
    for (const path of ['models/A.glb', 'library/B.glb', 'scenes/C.glb', 'Root.glb']) {
      const { entry } = mintAssetIdentity(empty, { path });
      expect(entry.section, path).toBeUndefined();
      expect(entry.path).toBe(path);
    }
  });

  it('a new row added beside old ones does not disturb theirs', () => {
    const before = deliveredManifest();
    const fresh = documentRowFor(
      { documentId: 'doc_fresh', relPath: 'library/Fresh.glb', name: 'Fresh' },
      '2026-09-02T00:00:00.000Z',
    );
    const after = { ...before, documents: [...documentsOf(before), fresh] } as RvProject;

    expect(documentsOf(after).map(r => r.section))
      .toEqual(['scenes', 'models', 'library', 'scenes', undefined]);
  });
});
