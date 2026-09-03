// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-736 §9.2 / Phase 2 — the measurement step, before the branch comes out.
 *
 * ## What is being measured, and why measuring came first
 *
 * Two places asked "is this row a scene?" and used the answer to decide whether
 * the row's body counts as scannable:
 *
 *  - `rv-asset-identity.ts` — the adopt/orphan filter. A row whose body the
 *    stat scan does not see is quarantined and, after the window, DELETED.
 *  - `project-store.ts` — `_liveUserDocuments`, which splits the user cache.
 *
 * The reason was never that scenes are special. It was that on the browser
 * backend a scene body lives in the GLB store (`rv-scene-glb/<id>` + OPFS) and
 * `statDocuments()` enumerated only the blob index — so every scene row looked
 * *missing*, and the section test was the guard standing between that and data
 * loss. Removing the guard while the hole was still there would have deleted
 * every browser scene after the quarantine window.
 *
 * Phase 1 closed the hole at its source: `statDocuments()` enumerates BOTH
 * stores. This file is the evidence that it did, per backend, and it is
 * deliberately written as a **characterisation of the scan**, not of the
 * removal — it states the property the removal depends on, so it keeps failing
 * loudly if a later change re-opens the hole.
 *
 * ## The three fixtures the re-review demanded
 *
 *  (a) **A manifest row with no `rv-scene-glb/` pointer** — a scene that never
 *      went through the plan-716 boot migration. It must NOT be quarantined
 *      into deletion by the mere removal of the exclusion; the quarantine
 *      window is what protects it, and it must be reachable again the moment
 *      its body appears.
 *  (b) **A root-level document whose path could collide with a scene id.**
 *      Nothing may resolve it to a scene body that does not exist.
 *  (c) **The browser bare-id scene, normal case** — the one the whole exclusion
 *      existed for.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { BrowserBackend, browserBlobIndexKey } from '../src/core/project/backends/browser-backend';
import { FolderBackend } from '../src/core/project/backends/folder-backend';
import { BundledBackend } from '../src/core/project/backends/bundled-backend';
import type { ProjectBackend } from '../src/core/project/backends/project-backend';
import { clearAllBlobs } from '../src/core/storage/rv-opfs-blobs';
import {
  LS_KEY_SCENE_GLB_PREFIX,
  readSceneGlbPointer,
} from '../src/core/storage/rv-scene-glb-store';
import { adoptDiscoveredDocuments } from '../src/core/project/rv-asset-identity';
import type { RvProject } from '../src/core/project/rv-project-types';

const PROJECT_ID = 'prj_predicate_equivalence';

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** A project whose rows are exactly the given paths (ids derived, stable). */
function manifestOf(rows: { id: string; path: string; name: string }[]): RvProject {
  return {
    schemaVersion: 3,
    id: PROJECT_ID,
    name: 'Predicate fixture',
    documents: rows,
  } as unknown as RvProject;
}

/** Paths a stat list reports, sorted — the scan's view of what bodies exist. */
async function statPaths(backend: ProjectBackend): Promise<string[]> {
  return (await backend.statDocuments()).map(s => s.path).sort();
}

// ─── The browser backend: two stores, one stat list ───────────────────────

describe('statDocuments is body-authoritative on the browser backend (Phase 1)', () => {
  let backend: BrowserBackend;

  beforeEach(async () => {
    localStorage.clear();
    await clearAllBlobs();
    backend = new BrowserBackend(PROJECT_ID, { requestPersistence: false });
    await backend.activate();
  });

  afterEach(async () => {
    localStorage.clear();
    await clearAllBlobs();
  });

  it('(c) reports a bare-id scene body — the case the exclusion existed for', async () => {
    const meta = { id: 'scn_line', name: 'Line', path: 'scn_line' };
    await backend.writeDocument(
      { path: meta.path, id: meta.id, meta }, bytes('scene'), { expectedRevision: 'create' });

    // The body is in the scene store, not the blob index…
    expect(readSceneGlbPointer('scn_line')).not.toBeNull();
    // …and the scan sees it anyway. THIS is what makes the section test in
    // `adoptDiscoveredDocuments` removable rather than merely relocatable.
    expect(await statPaths(backend)).toEqual(['scn_line']);
  });

  it('reports blob bodies and scene bodies in ONE list', async () => {
    const meta = { id: 'scn_line', name: 'Line', path: 'scn_line' };
    await backend.writeDocument(
      { path: meta.path, id: meta.id, meta }, bytes('scene'), { expectedRevision: 'create' });
    await backend.writeDocument('library/Belt.glb', bytes('belt'), { expectedRevision: 'create' });
    await backend.writeDocument('models/Press.glb', bytes('press'), { expectedRevision: 'create' });

    expect(await statPaths(backend)).toEqual(['library/Belt.glb', 'models/Press.glb', 'scn_line']);
  });

  it('carries the digest for a scene body, so the scan pre-filter clears on it', async () => {
    const meta = { id: 'scn_line', name: 'Line', path: 'scn_line' };
    const { revision } = await backend.writeDocument(
      { path: meta.path, id: meta.id, meta }, bytes('scene'), { expectedRevision: 'create' });
    const stat = (await backend.statDocuments()).find(s => s.path === 'scn_line');
    expect(stat?.sha256).toBe(revision);
    expect(stat?.size).toBeGreaterThan(0);
  });

  it('(a) reports NOTHING for a manifest row whose pointer never existed', async () => {
    // A scene that missed the plan-716 boot migration: a row, no body anywhere.
    // The scan must not invent a stat for it — see the adopt test below for
    // what protects such a row.
    expect(await statPaths(backend)).toEqual([]);
  });

  it('ignores an unparseable pointer rather than claiming a body exists', async () => {
    localStorage.setItem(LS_KEY_SCENE_GLB_PREFIX + 'scn_broken', '{not json');
    expect(await statPaths(backend)).toEqual([]);
  });

  it('(b) does not resolve a root-level document to a scene body it does not have', async () => {
    // `scn_line` is a plausible scene id AND a legal root-level file name. With
    // no pointer under it, it is a blob and nothing else — no path shape is
    // interpreted, so there is no way for this to be read as a scene.
    await backend.writeDocument('scn_line', bytes('not a scene'), { expectedRevision: 'create' });
    expect(readSceneGlbPointer('scn_line')).toBeNull();
    expect(await statPaths(backend)).toEqual(['scn_line']);

    const record = await backend.readDocument('scn_line');
    expect(new TextDecoder().decode(record!.bytes)).toBe('not a scene');
  });
});

// ─── The folder backend: one store, and it always was authoritative ───────

describe('statDocuments on the folder backend', () => {
  it('reports every document body, wherever in the tree it sits', async () => {
    const root = new FakeDir('customer');
    const backend = new FolderBackend(asDirHandle(root), { writable: true });
    await backend.activate();

    await backend.writeDocument('scenes/Line.glb', bytes('scene'), { expectedRevision: 'create' });
    await backend.writeDocument('library/Belt.glb', bytes('belt'), { expectedRevision: 'create' });
    // (b) A root-level document — the case the path heuristic could not classify.
    await backend.writeDocument('Root.glb', bytes('root'), { expectedRevision: 'create' });

    expect(await statPaths(backend)).toEqual(['Root.glb', 'library/Belt.glb', 'scenes/Line.glb']);
  });
});

// ─── The bundled backend: deliberately empty, and that is the contract ────

describe('statDocuments on the bundled backend', () => {
  it('stays empty — "my manifest is authoritative"', async () => {
    const backend = new BundledBackend({
      fetchImpl: (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch,
    });
    await backend.activate();
    expect(await backend.statDocuments()).toEqual([]);
  });

  it('an empty stat list quarantines nothing (the read-only invariant)', async () => {
    const project = manifestOf([
      { id: 'doc_a', path: 'models/A.glb', name: 'A' },
      { id: 'scn_line', path: 'scn_line', name: 'Line' },
    ]);
    const scan = await adoptDiscoveredDocuments(project, { stats: [] });
    expect(scan.delta).toEqual([]);
  });
});

// ─── The equivalence itself, at the consumer ──────────────────────────────

describe('the adopt scan over a body-authoritative stat list', () => {
  beforeEach(async () => {
    localStorage.clear();
    await clearAllBlobs();
  });
  afterEach(async () => {
    localStorage.clear();
    await clearAllBlobs();
  });

  it('(c) a scene row whose body the scan reports is NOT treated as missing', async () => {
    const backend = new BrowserBackend(PROJECT_ID, { requestPersistence: false });
    await backend.activate();
    const meta = { id: 'scn_line', name: 'Line', path: 'scn_line' };
    await backend.writeDocument(
      { path: meta.path, id: meta.id, meta }, bytes('scene'), { expectedRevision: 'create' });

    const project = manifestOf([{ id: 'scn_line', path: 'scn_line', name: 'Line' }]);
    const scan = await adoptDiscoveredDocuments(project, {
      stats: await backend.statDocuments(),
    });

    // Neither quarantined nor removed — and it did not have to be excluded by
    // section to get that answer. The scan simply SAW it.
    expect(scan.delta.filter(op => op.op === 'quarantine' || op.op === 'remove')).toEqual([]);
  });

  it('(a) a scene row with NO body is quarantined first, never removed on sight', async () => {
    const backend = new BrowserBackend(PROJECT_ID, { requestPersistence: false });
    await backend.activate();
    // One real body, so the stat list is non-empty (an empty one means "the
    // scan learnt nothing" and is a different branch entirely).
    await backend.writeDocument('library/Belt.glb', bytes('belt'), { expectedRevision: 'create' });

    const project = manifestOf([
      { id: 'scn_orphan', path: 'scn_orphan', name: 'Never migrated' },
      { id: 'doc_belt', path: 'library/Belt.glb', name: 'Belt' },
    ]);
    const scan = await adoptDiscoveredDocuments(project, {
      stats: await backend.statDocuments(),
    });

    // The row is marked, not deleted. This is the plan-736 §2.3 answer to "what
    // happens to a scene that missed the boot migration once the exclusion is
    // gone": the quarantine window is what protects it, and a body that turns
    // up inside the window clears the mark and keeps the id.
    const removed = scan.delta.filter(op => op.op === 'remove');
    expect(removed).toEqual([]);
    const marked = scan.delta.filter(op => op.op === 'quarantine');
    expect(marked.map(op => (op as { id: string }).id)).toEqual(['scn_orphan']);
  });

  it('(a) …and the mark is released the moment its body is there', async () => {
    const backend = new BrowserBackend(PROJECT_ID, { requestPersistence: false });
    await backend.activate();
    const meta = { id: 'scn_orphan', name: 'Never migrated', path: 'scn_orphan' };
    await backend.writeDocument(
      { path: meta.path, id: meta.id, meta }, bytes('late'), { expectedRevision: 'create' });

    const project = manifestOf([
      { id: 'scn_orphan', path: 'scn_orphan', name: 'Never migrated' },
    ]);
    // The row still carries yesterday's quarantine mark.
    (project.documents as { missingSince?: string }[])[0]!.missingSince =
      new Date(Date.now() - 86_400_000).toISOString();

    const scan = await adoptDiscoveredDocuments(project, {
      stats: await backend.statDocuments(),
    });
    expect(scan.delta.filter(op => op.op === 'remove')).toEqual([]);
    expect(scan.delta.some(op => op.op === 'restore')).toBe(true);
  });

  it('(b) a root-level document is adopted like any other — no classification needed', async () => {
    const root = new FakeDir('customer');
    const backend = new FolderBackend(asDirHandle(root), { writable: true });
    await backend.activate();
    await backend.writeDocument('Root.glb', bytes('root'), { expectedRevision: 'create' });

    const scan = await adoptDiscoveredDocuments(manifestOf([]), {
      stats: await backend.statDocuments(),
    });
    const adopted = scan.delta.filter(op => op.op === 'adopt');
    expect(adopted.map(op => (op as { path: string }).path)).toEqual(['Root.glb']);
  });
});
