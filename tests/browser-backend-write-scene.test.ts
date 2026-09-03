// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * browser-backend-write-scene.test — plan-454 §9.
 *
 * `BrowserBackend.writeScene` used to derive the scene id back out of
 * `relPath` and refuse the write when the two disagreed. That derivation
 * cannot exist: `sceneIdToken()` is deliberately lossy and
 * `sceneGlbFileNameFor()` puts a name slug in front of it, so a filename does
 * not carry an id at all. For a builtin **draft** id — one with `/`, `:` and
 * `%` in it — that turned every autosave into a failure.
 *
 * What replaces it is a three-stage **belonging** check, and each stage is
 * pinned here:
 *
 *  1. a path another document owns is refused — always, even when it is also
 *     the canonical path of the scene being written (§9.2, §9.4, §9.6);
 *  2. an existing row pins its own path (§9.5) — a browser-specific
 *     tightening the folder backend deliberately does not make (§9.4);
 *  3. without a row, the canonical path (or the scene's own id) is accepted
 *     (§9.1), and `meta.id` is mandatory (§9.3).
 *
 * §9.6 is the one that earns stage 1 its place: `sceneIdToken()` maps `a:b`
 * and `a/b` onto the same token, so with an equal name the two scenes produce
 * the *identical* filename. The test does not take that on trust — it asserts
 * the collision against `sceneGlbRelPathFor` before using it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BrowserBackend } from '../src/core/project/backends/browser-backend';
import { FolderBackend } from '../src/core/project/backends/folder-backend';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { glbWrite } from './helpers/scene-write';
import {
  RV_PROJECT_SCHEMA_VERSION,
  sceneGlbRelPathFor,
  type RvDocumentEntry,
  type RvProject,
  type RvProjectSceneEntry,
} from '../src/core/project/rv-project-types';
import type { SceneWrite } from '../src/core/project/rv-scene-record';
import { clearAllScenes } from '../src/core/hmi/scene/rv-scene-storage';
import { clearAllSceneOwners } from '../src/core/project/rv-scene-owner';
import { clearAllBlobs } from '../src/core/storage/rv-opfs-blobs';
import { readSceneGlbPointer } from '../src/core/storage/rv-scene-glb-store';
import { clearSceneMutationListeners } from '../src/core/hmi/scene/rv-scene-mutations';
import { writeSceneDocument } from './helpers/document-io';

// ─── Fixtures ───────────────────────────────────────────────────────────

const PRJ = 'prj_454';

/** The id shape that broke: a builtin draft, with `/`, `:` and `%` in it. */
const BUILTIN_DRAFT = {
  id: 'draft/builtin:%2Fmodels%2FDemoRealvirtualWeb.glb',
  name: 'DemoRealvirtualWeb',
};

/** A scene row as the manifest stores it. */
function row(scene: { id: string; name: string }, path = sceneGlbRelPathFor(scene)): RvDocumentEntry {
  return { id: scene.id, name: scene.name, path, section: 'scenes' };
}

function manifest(documents: RvDocumentEntry[]): RvProject {
  return {
    schemaVersion: RV_PROJECT_SCHEMA_VERSION,
    id: PRJ,
    name: 'Plan 454',
    documents,
  };
}

/** An activated browser backend whose manifest already holds `documents`. */
async function openBrowser(documents: RvDocumentEntry[] = []): Promise<BrowserBackend> {
  const backend = new BrowserBackend(PRJ, { requestPersistence: false });
  await backend.activate();
  if (documents.length > 0) await backend.writeManifest(manifest(documents));
  return backend;
}

const folders: FolderBackend[] = [];

/** An activated folder backend with the same manifest, through a writer host. */
async function openFolder(documents: RvDocumentEntry[] = []): Promise<FolderBackend> {
  const root = new FakeDir('customer');
  let stored = manifest(documents);
  root.seedText('project.json', JSON.stringify(stored));
  const backend = new FolderBackend(asDirHandle(root), {
    writable: true,
    id: 'folder:454',
    writerHost: {
      getDirectory: () => asDirHandle(root),
      getManifest: () => stored,
      setManifest: (p: RvProject) => { stored = p; },
      readScene: () => null,
    },
    debounceMs: 5,
  });
  folders.push(backend);
  await backend.activate();
  return backend;
}

beforeEach(async () => {
  clearSceneMutationListeners();
  folders.length = 0;
  localStorage.clear();
  clearAllScenes();
  clearAllSceneOwners();
  await clearAllBlobs();
});

afterEach(async () => {
  for (const b of folders) await b.deactivate();
  clearSceneMutationListeners();
  localStorage.clear();
  await clearAllBlobs();
});

// ─── 9.1 ────────────────────────────────────────────────────────────────

describe('BrowserBackend.writeScene — the id is given, not derived', () => {
  it('a builtin draft id writes without throwing', async () => {
    const backend = await openBrowser();
    const relPath = sceneGlbRelPathFor(BUILTIN_DRAFT);

    // The precondition that used to fail: the filename is lossy, so no
    // round-trip can produce the id back out of it.
    expect(relPath).toBe(
      'scenes/demorealvirtualweb-draft_builtin__2Fmodels_2FDemoRealvirtualWeb_glb.scene.glb',
    );
    expect(relPath).not.toContain(BUILTIN_DRAFT.id);

    const revision = await writeSceneDocument(backend, 
      relPath,
      glbWrite(BUILTIN_DRAFT.id, BUILTIN_DRAFT.name),
    );

    expect(revision).toMatch(/^[0-9a-f]{64}$/i);
    expect(readSceneGlbPointer(BUILTIN_DRAFT.id)?.sha).toBe(revision);
  });

  it('still accepts the id-addressing forms it always accepted', async () => {
    const backend = await openBrowser();
    // `<id>` is how most callers reach a browser body — the backend keys them
    // by scene id — and dropping it would have been a silent regression.
    await expect(writeSceneDocument(backend, 'scn_a', glbWrite('scn_a', 'Cell'))).resolves.toBeTruthy();
    await expect(writeSceneDocument(backend, 'scenes/scn_b', glbWrite('scn_b', 'Cell'))).resolves.toBeTruthy();
  });
});

// ─── 9.2 ────────────────────────────────────────────────────────────────

describe('BrowserBackend.writeScene — foreign ownership', () => {
  it('a path owned by another scene is still refused', async () => {
    const b = { id: 'scn_b', name: 'Line B' };
    const backend = await openBrowser([row(b)]);

    await expect(
      writeSceneDocument(backend, sceneGlbRelPathFor(b), glbWrite('scn_a', 'Line A')),
    ).rejects.toThrow(/belongs to scene scn_b/);

    // The protection is worth nothing if the bytes went in anyway.
    expect(readSceneGlbPointer('scn_a')).toBeNull();
  });
});

// ─── 9.3 ────────────────────────────────────────────────────────────────

describe('BrowserBackend — a scene row without an id is refused', () => {
  /**
   * plan-736 narrowed this guard, and the narrowing is the point.
   *
   * It used to be "`writeScene` requires `meta.id`", which it could be because
   * `writeScene` was a separate method that only scene saves reached. There is
   * one `writeDocument` now, and most of its callers legitimately have no row
   * at all — a library import, a screenshot, a docs index. "No meta" therefore
   * cannot be an error any more; it is simply a document write.
   *
   * What IS still an error is a caller that hands over a row with an empty id.
   * That is a scene save that has lost track of what it is saving, and it is
   * the case the old guard existed for: the body would land in the blob index
   * under a path key, where `readSceneGlb(id)` — which the scene layer calls
   * directly — can never find it.
   */
  it('a write carrying a row with an empty id is refused', async () => {
    const backend = await openBrowser();
    const idless = {
      glb: new TextEncoder().encode('glTF-stand-in'),
      meta: { id: '', name: 'Nameless' } as unknown as RvProjectSceneEntry,
    } satisfies SceneWrite;

    // Same words as the folder backend — one contract, one message.
    await expect(writeSceneDocument(backend, 'scenes/x.scene.glb', idless))
      .rejects.toThrow('writeScene needs meta.id.');
    expect(readSceneGlbPointer('')).toBeNull();
  });

  it('a write carrying NO row is an ordinary document write, not an error', async () => {
    const backend = await openBrowser();
    await backend.writeDocument(
      'library/Loose.glb',
      new TextEncoder().encode('glTF-stand-in'),
      { expectedRevision: 'create' },
    );
    const record = await backend.readDocument('library/Loose.glb');
    expect(new TextDecoder().decode(record!.bytes)).toBe('glTF-stand-in');
    // It went to the blob store, not the scene store: nothing said it was a scene.
    expect(readSceneGlbPointer('Loose.glb')).toBeNull();
  });
});

// ─── 9.4 ────────────────────────────────────────────────────────────────

describe('the shared invariant', () => {
  it('both backends refuse a foreign-owned path', async () => {
    const b = { id: 'scn_b', name: 'Line B' };
    const stolen = sceneGlbRelPathFor(b);
    const mine = glbWrite('scn_a', 'Line A');

    const browser = await openBrowser([row(b)]);
    const folder = await openFolder([row(b)]);

    await expect(writeSceneDocument(browser, stolen, mine)).rejects.toThrow(/belongs to scene scn_b/);
    await expect(writeSceneDocument(folder, stolen, mine)).rejects.toThrow(/belongs to scene scn_b/);
  });

  it('the folder backend does NOT pin an existing row to its path', async () => {
    // The counterpart to 9.5: the path-pinning is a browser tightening (§2.2),
    // and pinning it here too would be a change this plan deliberately did not
    // make. Pinned so the difference is a decision with a witness, not drift.
    const a = { id: 'scn_a', name: 'Line A' };
    const folder = await openFolder([row(a, 'scenes/pinned-a.scene.glb')]);

    await expect(writeSceneDocument(folder, 'scenes/somewhere-else.scene.glb', glbWrite('scn_a', 'Line A')))
      .resolves.toBeTruthy();
  });
});

// ─── 9.5 ────────────────────────────────────────────────────────────────

describe('BrowserBackend.writeScene — an existing row pins the path', () => {
  it('refuses a second home for a document that already has one', async () => {
    const a = { id: 'scn_a', name: 'Line A' };
    const backend = await openBrowser([row(a, 'scenes/pinned-a.scene.glb')]);

    // `scenes/free.scene.glb` is well-formed and owned by nobody — and still
    // refused, because `scn_a` already lives somewhere.
    await expect(writeSceneDocument(backend, 'scenes/free.scene.glb', glbWrite('scn_a', 'Line A')))
      .rejects.toThrow(/Scene scn_a is stored at "scenes\/pinned-a\.scene\.glb"/);

    // Its own stored path goes through, of course.
    await expect(writeSceneDocument(backend, 'scenes/pinned-a.scene.glb', glbWrite('scn_a', 'Line A')))
      .resolves.toBeTruthy();
  });
});

// ─── 9.6 ────────────────────────────────────────────────────────────────

describe('BrowserBackend.writeScene — the token collision', () => {
  it('colliding ids do not overwrite each other', async () => {
    // `sceneIdToken()` replaces every character outside [A-Za-z0-9_-] with `_`,
    // so `a:b` and `a/b` both become `a_b`. With an equal name the slug
    // collides too — and the whole path is identical. Verified here rather
    // than assumed, because the test is worthless if it is not.
    const a = { id: 'a:b', name: 'Cell' };
    const b = { id: 'a/b', name: 'Cell' };
    const shared = sceneGlbRelPathFor(a);
    expect(sceneGlbRelPathFor(b)).toBe(shared);
    expect(shared).toBe('scenes/cell-a_b.scene.glb');

    // B owns the path.
    const backend = await openBrowser([row(b, shared)]);
    const bRevision = await writeSceneDocument(backend, shared, glbWrite(b.id, b.name));
    expect(readSceneGlbPointer(b.id)?.sha).toBe(bRevision);

    // A wants the same path. Its own canonical path IS this path — a check
    // that only compared against `sceneGlbRelPathFor(meta)` would have let it
    // through, and A would have taken over B's row.
    await expect(writeSceneDocument(backend, shared, glbWrite(a.id, a.name)))
      .rejects.toThrow(/belongs to scene a\/b/);

    // B is untouched and A never got a body.
    expect(readSceneGlbPointer(b.id)?.sha).toBe(bRevision);
    expect(readSceneGlbPointer(a.id)).toBeNull();
  });
});
