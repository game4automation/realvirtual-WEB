// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * library-asset-ops — what is left of it after plan-717 Phase 4.
 *
 * This file used to pin four blob-only verbs: rename, duplicate, delete and
 * create, each moving bytes and a `library.json` record past the manifest. All
 * four are deleted (F1/F6/F9) and their cases went with them — they were
 * characterising a route, and the route is gone. Where each one's behaviour is
 * pinned now:
 *
 *  - rename  → `one-rename-path.test.ts` (row name + file name, id stable)
 *  - create  → `open-save-document.test.ts` / `dashboard-documents.test.ts`
 *  - delete / duplicate → `open-save-document.test.ts` (row route, `.trash/`)
 *  - the deletions themselves → `registration-removal-guard.test.ts`
 *
 * What remains in the module, and therefore here, is `setAssetCollections`:
 * one field, one row, one write. The full round trip (row → catalog → filter)
 * is `collections-roundtrip.test.ts`; what is pinned here is the verb.
 *
 * The cross-source transfer verbs living in the same module have their own
 * file, `library-cross-source-ops.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  LIBRARY_FOLDER,
  setAssetCollections,
  type DocumentRowWriter,
} from '../src/core/library/library-asset-ops';
import type { RvDocumentEntry, RvProject } from '../src/core/project/rv-project-types';

/**
 * The manifest half `setAssetCollections` writes through, in memory.
 *
 * Deliberately not a `ProjectStore`: the verb takes the narrow
 * {@link DocumentRowWriter} precisely so the row write can be exercised
 * without a backend, a folder handle or a boot path.
 */
class FakeRows implements DocumentRowWriter {
  publishes = 0;
  constructor(public project: RvProject | null) {}

  async applyManifestDelta(
    apply: (current: RvProject) => RvProject,
    opts: { publish?: boolean } = {},
  ): Promise<RvProject | null> {
    if (!this.project) return null;             // no manifest to record into
    this.project = apply(this.project);
    if (opts.publish !== false) this.publishes++;
    return this.project;
  }

  row(path: string): RvDocumentEntry | undefined {
    return (this.project?.documents ?? []).find(d => d.path === path);
  }
}

function projectWith(...paths: string[]): RvProject {
  return {
    schemaVersion: 3,
    id: 'prj_ops',
    name: 'Ops fixture',
    documents: paths.map(path => ({
      id: `doc_${path}`,
      path,
      name: (path.split('/').pop() ?? path).replace(/\.glb$/, ''),
      section: 'library' as const,
    })),
  } as unknown as RvProject;
}

const BELT = `${LIBRARY_FOLDER}/conveyor/belt.glb`;

describe('setAssetCollections writes the row', () => {
  it('trims, drops blanks and de-duplicates user-typed names', async () => {
    const rows = new FakeRows(projectWith(BELT));
    const r = await setAssetCollections(rows, 'conveyor/belt.glb', [' Conveyors ', 'Conveyors', '', '  ']);
    expect(r.kind).toBe('ok');
    expect(rows.row(BELT)?.collections).toEqual(['Conveyors']);
  });

  it('an empty list is stored as an empty array — "filed under nothing" is an answer', async () => {
    const rows = new FakeRows(projectWith(BELT));
    await setAssetCollections(rows, 'conveyor/belt.glb', ['A']);
    await setAssetCollections(rows, 'conveyor/belt.glb', []);
    // Deleting the field instead would re-open the legacy sidecar fallback for
    // this row, which is the opposite of what the user just asked for.
    expect(rows.row(BELT)?.collections).toEqual([]);
  });

  it('touches only the row it was asked about', async () => {
    const other = `${LIBRARY_FOLDER}/other.glb`;
    const rows = new FakeRows(projectWith(BELT, other));
    await setAssetCollections(rows, 'conveyor/belt.glb', ['Conveyors']);
    expect(rows.row(other)?.collections).toBeUndefined();
  });

  it('reports a document with no row instead of writing a manifest nobody asked for', async () => {
    const rows = new FakeRows(projectWith(`${LIBRARY_FOLDER}/other.glb`));
    const r = await setAssetCollections(rows, 'conveyor/belt.glb', ['A']);
    expect(r.kind).toBe('error');
    expect(r.kind === 'error' && r.message).toMatch(/not registered/i);
  });

  it('reports a project with no manifest to write into', async () => {
    const r = await setAssetCollections(new FakeRows(null), 'conveyor/belt.glb', ['A']);
    expect(r.kind).toBe('error');
    expect(r.kind === 'error' && r.message).toMatch(/no manifest/i);
  });
});
