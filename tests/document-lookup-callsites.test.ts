// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * document-lookup-callsites — each retired `sceneDocumentsOf()` caller, by
 * BEHAVIOUR (plan-744 §9.2b, Review #13).
 *
 * The guard test pins that the symbol is gone. That is not the same claim as
 * "the call sites still do the right thing", and the risk the plan names in
 * §5.4 is exactly the difference: a consumer that genuinely meant "only
 * scenes" would now silently see every document.
 *
 * Nine of them turned out to mean one of two things, and both are tested here
 * against a manifest that deliberately mixes all three shapes — a `scenes/`
 * row, a `models/` row, a `library/` row and a BROWSER row whose path is its
 * bare id:
 *
 *  - **an identity lookup** (`find(e => e.id === …)`). Widening cannot change
 *    the answer: an id is unique across the manifest. It can only ADD answers
 *    the section filter was losing, and the browser row is the one it lost.
 *  - **a place question** (`some(e => e.path === …)`, "is this path claimed").
 *    Widening makes it stricter, which is the correct direction for a guard
 *    that refuses to overwrite somebody else's file.
 *
 * The tenth, `rv-project-storage.assertNoLegacyScenes`, is its own case: the
 * section filter there was pure overhead in front of two predicates that
 * already identify a legacy body.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { documentsOf } from '../src/core/project/rv-project-documents';
import { readManifest } from '../src/core/project/rv-project-storage';
import { LegacyFormatError } from '../src/core/project/rv-legacy-format';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { ProjectStore, resetProjectStore } from '../src/core/project/project-store';
import type { RvProject } from '../src/core/project/rv-project-types';

/**
 * Every document shape the product has, in one manifest.
 *
 * The browser row is the load-bearing one. Its path IS its id, so the path
 * heuristic behind `sectionOfDocument` reads it as `library` — which is why
 * the scene projection returned nothing for a browser project once the
 * transitional stamp was removed.
 */
const MIXED: RvProject = {
  schemaVersion: 3,
  id: 'prj_mixed',
  name: 'Mixed',
  documents: [
    { id: 'scn_folder', name: 'Cell', path: 'scenes/Cell.scene.glb' },
    { id: 'doc_model', name: 'Press', path: 'models/Press.glb' },
    { id: 'doc_lib', name: 'Belt', path: 'library/Custom/Belt.glb' },
    { id: 'scn_browser', name: 'Browser cell', path: 'scn_browser' },
    { id: 'doc_root', name: 'Machine', path: 'Machine.glb' },
  ],
} as unknown as RvProject;

/** The projection the retired helper computed, for the contrast assertions. */
function scenesOnly(project: RvProject): string[] {
  return documentsOf(project)
    .filter(d => /^scenes\//i.test(d.path) || /\.scene\.glb$/i.test(d.path))
    .map(d => d.id);
}

describe('the shape of the change — what widening actually did', () => {
  it('the section projection saw three of five documents', () => {
    // Two were invisible to it, and one of those is a SCENE: the browser row.
    expect(scenesOnly(MIXED)).toEqual(['scn_folder']);
  });

  it('the one list sees all five', () => {
    expect(documentsOf(MIXED).map(d => d.id)).toEqual([
      'scn_folder', 'doc_model', 'doc_lib', 'scn_browser', 'doc_root',
    ]);
  });
});

describe('identity lookups — widening can only ADD, never change', () => {
  /** The shape of `_sceneEntry`, `projectEntry`, `_manifestEntry`. */
  const byId = (id: string) => documentsOf(MIXED).find(e => e.id === id);

  it('answers the same row for a document the projection could see', () => {
    expect(byId('scn_folder')?.path).toBe('scenes/Cell.scene.glb');
  });

  it('answers the browser scene the projection could NOT see', () => {
    // This is the defect the widening fixes, not a side effect of it: before
    // it, `_sceneEntry('scn_browser')` was undefined, so a browser project's
    // save, reconcile and hydrate all looked at a document that "did not
    // exist".
    expect(byId('scn_browser')?.name).toBe('Browser cell');
  });

  it('still answers nothing for an id the project does not have', () => {
    expect(byId('scn_nope')).toBeUndefined();
  });

  it('ids are unique, so there is nothing for widening to make ambiguous', () => {
    const ids = documentsOf(MIXED).map(d => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('place questions — widening makes the guard stricter', () => {
  /** The shape of the folder writer's stale-rename and ownership checks. */
  const claimedBy = (path: string, notId: string) =>
    documentsOf(MIXED).some(e => e.id !== notId && e.path === path);

  it('a models/ row now defends its own path against a scene write', () => {
    // Under the scene-only filter this answered false, and the writer would
    // have deleted or overwritten a file belonging to another document.
    expect(claimedBy('models/Press.glb', 'scn_folder')).toBe(true);
  });

  it('a path nothing holds is still free', () => {
    expect(claimedBy('models/Unclaimed.glb', 'scn_folder')).toBe(false);
  });

  it('a document never claims its own path against itself', () => {
    expect(claimedBy('models/Press.glb', 'doc_model')).toBe(false);
  });
});

describe('assertNoLegacyScenes — the predicate was always the whole rule', () => {
  const withManifest = (project: unknown): FileSystemDirectoryHandle => {
    const root = new FakeDir('p');
    root.seedText('project.json', JSON.stringify(project));
    return asDirHandle(root);
  };

  it('refuses a legacy JSON body wherever it sits', async () => {
    await expect(readManifest(withManifest({
      schemaVersion: 3, id: 'p', name: 'P',
      documents: [{ id: 'd1', name: 'Old', path: 'scenes/Old.scene.json' }],
    }))).rejects.toBeInstanceOf(LegacyFormatError);
  });

  it('refuses a `format: json` row that the section filter would have hidden', () => {
    // A JSON body at a path the heuristic does not read as a scene — the case
    // the filter could hide, and the reason the filter went.
    return expect(readManifest(withManifest({
      schemaVersion: 3, id: 'p', name: 'P',
      documents: [{ id: 'd1', name: 'Odd', path: 'models/Odd.glb', format: 'json' }],
    }))).rejects.toBeInstanceOf(LegacyFormatError);
  });

  it('accepts an ordinary GLB manifest', async () => {
    const read = await readManifest(withManifest(MIXED));
    expect(read?.project.documents).toHaveLength(5);
  });
});

describe('_adoptProject reads the backend listing exactly once (Review #8)', () => {
  let store: ProjectStore;

  beforeEach(() => { resetProjectStore(); store = new ProjectStore(); });
  afterEach(() => { resetProjectStore(); });

  it('does not walk the project a second time, and keeps no models projection', async () => {
    // Before plan-744 this method called `listDocuments()` AND `listModels()`,
    // and on a folder project each is a full recursive directory walk. The
    // second one was a filter of the first — and since plan-777 (P3) the
    // filtered `models` view itself is gone: one listing, one list.
    const documents = [
      { id: 'doc_model', name: 'Press', path: 'models/Press.glb' },
      { id: 'doc_lib', name: 'Belt', path: 'library/Belt.glb' },
    ];
    const listDocuments = vi.fn(async () => [...documents]);
    const backend = {
      kind: 'folder', id: 'fake', writable: true, isActive: true,
      listDocuments,
      async readManifest() { return MIXED; },
      async readSettings() { return null; },
      async activate() {}, async deactivate() {},
      async readDocument() { return null; },
      async readDocumentUrl() { return null; },
    } as never;

    const privates = store as unknown as {
      _adoptProject(b: unknown, p: RvProject): Promise<void>;
      _userDocuments: Array<{ path: string }>;
    };
    // The adopt path does a great deal more than this (drafts, reconcile,
    // settings) and some of it needs a browser the fake has not got. What is
    // under test is the listing arithmetic at the top, so a later failure is
    // allowed to end the method — the two fields below are already written.
    await privates._adoptProject(backend, MIXED).catch(() => {});

    expect(listDocuments).toHaveBeenCalledTimes(1);
    // …and there is no second, filtered list beside the one result.
    expect(privates).not.toHaveProperty('_userModels');
    expect(privates).not.toHaveProperty('_bundledModels');
    expect(privates._userDocuments.map(d => d.path))
      .toEqual(['models/Press.glb', 'library/Belt.glb']);
  });
});
