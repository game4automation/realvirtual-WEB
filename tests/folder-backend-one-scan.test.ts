// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * folder-backend-one-scan — ONE walk, ONE row shape (plan-744 §9.2).
 *
 * The property under test is not "listDocuments returns things". It is that
 * the listing no longer varies with the FOLDER a file happens to sit in:
 *
 *  - depth is uniform. `models/sub/x.glb` is listed, and before plan-744 it
 *    was not — the models listing walked one level while the library listing
 *    walked the tree, so a GLB in a models subfolder existed on disk, existed
 *    in the manifest, and appeared in neither list;
 *  - the row SHAPE is uniform. Every row carries `id`, `name`, `path` and no
 *    `section`, whichever folder it came out of. The scan used to bucket its
 *    own paths into three arrays and hand them to `documentsFromLists`, which
 *    is where the shape could diverge;
 *  - every scan-minted row has a non-empty id (Review #11). An empty one would
 *    make two documents share `.thumbnails/.png`.
 *
 * All three backends are exercised (Review #12), because all three had their
 * own copy of the split and only the folder one had a scan test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { FolderBackend } from '../src/core/project/backends/folder-backend';
import { BundledBackend } from '../src/core/project/backends/bundled-backend';
import { BrowserBackend } from '../src/core/project/backends/browser-backend';
import { stableDocumentId } from '../src/core/project/rv-project-documents';
import type { RvDocumentEntry } from '../src/core/project/rv-project-types';

/** `a/b/c.glb` into a FakeDir tree, creating directories as needed. */
async function seedAt(root: FakeDir, path: string, body: string): Promise<void> {
  const segments = path.split('/').filter(Boolean);
  const file = segments.pop()!;
  let dir = root;
  for (const segment of segments) {
    dir = await dir.getDirectoryHandle(segment, { create: true });
  }
  dir.seedText(file, body);
}

/** Every row carries the same four facts, and no fifth. */
function assertUniformRows(rows: RvDocumentEntry[]): void {
  for (const row of rows) {
    expect(row.id.trim(), `id of ${row.path}`).not.toBe('');
    expect(typeof row.name, `name of ${row.path}`).toBe('string');
    expect(row.name, `name of ${row.path}`).not.toBe('');
    expect(row.section, `section of ${row.path}`).toBeUndefined();
  }
}

describe('FolderBackend.listDocuments — one recursive scan', () => {
  it('lists every GLB of the tree and nothing else', async () => {
    const root = new FakeDir('p');
    root.seedText('project.json', JSON.stringify({
      schemaVersion: 3, id: 'prj_scan', name: 'Scan', documents: [],
    }));
    await seedAt(root, 'models/sub/x.glb', 'GLB');
    await seedAt(root, 'library/a/b.glb', 'GLB');
    await seedAt(root, 'scenes/s.glb', 'GLB');
    // Excluded, each for its own reason: a dot-folder is our own bookkeeping,
    // `imports/` is a staging area, and a `.txt` is not an asset at all.
    await seedAt(root, '.thumbnails/x.png', 'PNG');
    await seedAt(root, 'imports/y.glb', 'GLB');
    await seedAt(root, 'notes.txt', 'text');

    const backend = new FolderBackend(asDirHandle(root), { writable: true });
    const rows = await backend.listDocuments();

    expect(rows.map(r => r.path)).toEqual([
      'library/a/b.glb', 'models/sub/x.glb', 'scenes/s.glb',
    ]);
    assertUniformRows(rows);
  });

  it('mints a non-empty, path-derived id for a bare scanned file', async () => {
    const root = new FakeDir('p');
    root.seedText('project.json', JSON.stringify({
      schemaVersion: 3, id: 'prj_scan', name: 'Scan', documents: [],
    }));
    await seedAt(root, 'models/press.glb', 'GLB');

    const backend = new FolderBackend(asDirHandle(root), { writable: true });
    const [row] = await backend.listDocuments();
    // Not just "non-empty" — the SAME derivation everything else uses, or two
    // readers of the same file would disagree about which document it is.
    expect(row!.id).toBe(stableDocumentId('models/press.glb'));
  });

  it('a root-level GLB is a document like any other', async () => {
    // The case the three-way split could not express: the project root is not
    // one of the three folders, so a file there fell through every bucket.
    const root = new FakeDir('p');
    root.seedText('project.json', JSON.stringify({
      schemaVersion: 3, id: 'prj_scan', name: 'Scan', documents: [],
    }));
    await seedAt(root, 'Machine.glb', 'GLB');

    const backend = new FolderBackend(asDirHandle(root), { writable: true });
    const rows = await backend.listDocuments();
    expect(rows.map(r => r.path)).toEqual(['Machine.glb']);
    assertUniformRows(rows);
  });

  it('the manifest row wins on every field it carries', async () => {
    const root = new FakeDir('p');
    root.seedText('project.json', JSON.stringify({
      schemaVersion: 3, id: 'prj_scan', name: 'Scan',
      documents: [{
        id: 'doc_authored', name: 'The Press', path: 'models/press.glb',
        collections: ['Machines'],
      }],
    }));
    await seedAt(root, 'models/press.glb', 'GLB');

    const backend = new FolderBackend(asDirHandle(root), { writable: true });
    const [row] = await backend.listDocuments();
    expect(row!.id).toBe('doc_authored');
    expect(row!.name).toBe('The Press');
    expect(row!.collections).toEqual(['Machines']);
  });
});

describe('BundledBackend.listDocuments — the manifest IS the scan', () => {
  const fetchOf = (files: Record<string, unknown>): typeof fetch =>
    (async (input: RequestInfo | URL) => {
      const key = Object.keys(files).find(k => String(input).endsWith(k));
      if (!key) {
        return {
          ok: false, status: 404,
          json: async () => null,
          arrayBuffer: async () => new ArrayBuffer(0),
        } as unknown as Response;
      }
      const value = files[key];
      return {
        ok: true, status: 200,
        json: async () => value,
        arrayBuffer: async () =>
          new TextEncoder().encode(
            typeof value === 'string' ? value : JSON.stringify(value),
          ).buffer,
      } as unknown as Response;
    }) as typeof fetch;

  it('lists declared asset rows at any depth, in one shape', async () => {
    const backend = new BundledBackend({
      fetchImpl: fetchOf({
        'project.json': {
          schemaVersion: 2, id: 'prj_deploy', name: 'Deploy',
          documents: [
            { id: 'd1', path: 'models/sub/x.glb' },
            { id: 'd2', path: 'library/a/b.glb' },
            { id: 'd3', path: 'Root.glb' },
            { id: 'd4', path: 'docs/manual.knowledge.md' },   // a file, not a document
          ],
        },
      }),
    });
    const rows = await backend.listDocuments();
    expect(rows.map(r => r.path))
      .toEqual(['models/sub/x.glb', 'library/a/b.glb', 'Root.glb']);
    assertUniformRows(rows);
  });

  it('names a `.scene.glb` by its full stem, not by half of it', async () => {
    // The bundled backend used to derive names with its own regex, which
    // stripped only the last extension: `Line.scene.glb` listed as
    // "Line.scene". One lift, one rule (plan-744 F2).
    const backend = new BundledBackend({
      fetchImpl: fetchOf({
        'project.json': {
          schemaVersion: 2, id: 'prj_deploy', name: 'Deploy',
          documents: [{ id: 'd5', path: 'scenes/Line.scene.glb' }],
        },
      }),
    });
    expect((await backend.listDocuments())[0]!.name).toBe('Line');
  });
});

describe('BrowserBackend.listDocuments — the stored manifest', () => {
  const PRJ = 'prj_one_scan';
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { localStorage.clear(); });

  it('lists every stored row, whatever its path looks like', async () => {
    const backend = new BrowserBackend(PRJ, { requestPersistence: false });
    await backend.activate();
    await backend.writeManifest({
      schemaVersion: 3, id: PRJ, name: 'Browser',
      documents: [
        // A browser scene's path IS its bare id — the shape for which the
        // section heuristic answered `library` and the scene projection
        // answered nothing at all.
        { id: 'scn_a', name: 'Cell', path: 'scn_a' },
        { id: 'doc_b', name: 'Press', path: 'models/press.glb' },
      ],
    } as never);

    const rows = await backend.listDocuments();
    expect(rows.map(r => r.path)).toEqual(['scn_a', 'models/press.glb']);
    assertUniformRows(rows);
  });
});
