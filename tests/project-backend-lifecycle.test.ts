// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * project-backend-lifecycle.test — plan-372 §9.27 (review finding S5).
 *
 * Workspace discovery constructs a backend per candidate folder, for projects
 * that are **not** open. The scene mutation bus is global and unscoped —
 * `SceneMutation` carries an id and no projectId, so every listener sees every
 * event. A writer per discovered backend would therefore write one save into
 * every discovered folder.
 *
 * The rules that prevent it, and that this file pins:
 *
 *  1. a constructed backend is `isActive === false`, has **no writer**, and
 *     throws from every write method;
 *  2. `activate()` creates the writer and subscribes it; `deactivate()`
 *     flushes, unsubscribes and is idempotent;
 *  3. **the core case:** with two discovered folders and one activated, a
 *     scene mutation lands in exactly one of them — never in the other;
 *  4. a project switch deactivates the old backend *before* activating the new.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { glbWriteFor } from './helpers/scene-write';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { FolderBackend } from '../src/core/project/backends/folder-backend';
import { BackendNotWritableError } from '../src/core/project/backends/project-backend';
import {
  clearSceneMutationListeners,
  emitSceneMutation,
} from '../src/core/hmi/scene/rv-scene-mutations';
import { sceneGlbRelPathFor, type RvProject } from '../src/core/project/rv-project-types';
import { sceneDocumentsOf } from '../src/core/project/rv-project-documents';
import type { RvScene } from '../src/core/hmi/scene/rv-scene-types';
import { writeSceneDocument, writeBlobDocument } from './helpers/document-io';

// ─── Fixtures ───────────────────────────────────────────────────────────

const DEBOUNCE = 5;

const scene = (id: string, name: string): RvScene => ({
  id,
  name,
  createdAt: '2025-01-01T00:00:00.000Z',
  modifiedAt: '2025-01-01T00:00:00.000Z',
  schemaVersion: 3,
  base: { kind: 'empty' },
  edits: { ops: [], settings: { catalogUrls: [], gridSizeMm: 500 } },
});

interface Candidate {
  root: FakeDir;
  backend: FolderBackend;
  manifest: RvProject;
  /**
   * The scene PATHS the writer recorded in this folder's manifest.
   *
   * The writer stopped writing bodies in plan-413 phase 6 — the GLB goes
   * through `writeSceneDocument(backend, )` before the mutation is even emitted — so
   * "did this folder receive the mutation?" is answered by its manifest, not by
   * its `scenes/` directory. Same question, the surface that still answers it.
   */
  sceneRows(): string[];
}

/** Build a backend the way *discovery* does: read-only, no host — plus a host. */
function candidate(name: string, bodies: Map<string, RvScene>): Candidate {
  const root = new FakeDir(name);
  const c = {
    root,
    manifest: { schemaVersion: 2, id: `prj_${name}`, name, documents: [] } as RvProject,
  } as Candidate;
  c.backend = new FolderBackend(asDirHandle(root), {
    writable: true,
    id: `folder:${name}`,
    writerHost: {
      getDirectory: () => asDirHandle(root),
      getManifest: () => c.manifest,
      setManifest: p => { c.manifest = p; },
      readScene: id => bodies.get(id) ?? null,
    },
    debounceMs: DEBOUNCE,
  });
  c.sceneRows = () => sceneDocumentsOf(c.manifest).map(e => e.path.split('/')[1]!).sort();
  return c;
}

const live: FolderBackend[] = [];

function track(c: Candidate): Candidate {
  live.push(c.backend);
  return c;
}

beforeEach(() => {
  clearSceneMutationListeners();
  live.length = 0;
});

afterEach(async () => {
  for (const b of live) await b.deactivate();
  clearSceneMutationListeners();
});

// ─── 1. Construction is inert ───────────────────────────────────────────

describe('a discovered backend', () => {
  it('is not active and has no writer', () => {
    const c = track(candidate('a', new Map()));
    expect(c.backend.isActive).toBe(false);
    expect(c.backend.hasWriter).toBe(false);
  });

  it('throws from every write method while inactive', async () => {
    const c = track(candidate('a', new Map()));
    const s = scene('scn_a', 'A');
    await expect(writeSceneDocument(c.backend, sceneGlbRelPathFor(s), glbWriteFor(s)))
      .rejects.toBeInstanceOf(BackendNotWritableError);
    await expect(c.backend.deleteDocument(sceneGlbRelPathFor(s)))
      .rejects.toBeInstanceOf(BackendNotWritableError);
    await expect(writeBlobDocument(c.backend, 'models/x.glb', new Blob(['x'])))
      .rejects.toBeInstanceOf(BackendNotWritableError);
  });

  it('still reads — discovery has to be able to look at the manifest', async () => {
    const c = track(candidate('a', new Map()));
    c.root.seedText('project.json', JSON.stringify(c.manifest));
    expect((await c.backend.readManifest())?.name).toBe('a');
  });

  it('does not subscribe to the mutation bus before activation', async () => {
    const bodies = new Map([['scn_a', scene('scn_a', 'A')]]);
    const c = track(candidate('a', bodies));
    emitSceneMutation({ type: 'upsert', id: 'scn_a', scene: bodies.get('scn_a')! });
    await c.backend.flush();
    expect(c.sceneRows()).toEqual([]);
    expect(c.root.has('project.json')).toBe(false);
  });
});

// ─── 2. Activation ──────────────────────────────────────────────────────

describe('activate / deactivate', () => {
  it('activate creates the writer, deactivate disposes it', async () => {
    const c = track(candidate('a', new Map()));
    await c.backend.activate();
    expect(c.backend.isActive).toBe(true);
    expect(c.backend.hasWriter).toBe(true);
    await c.backend.deactivate();
    expect(c.backend.isActive).toBe(false);
    expect(c.backend.hasWriter).toBe(false);
  });

  it('both halves are idempotent', async () => {
    const c = track(candidate('a', new Map()));
    await c.backend.activate();
    await c.backend.activate();
    expect(c.backend.hasWriter).toBe(true);
    await c.backend.deactivate();
    await c.backend.deactivate();
    expect(c.backend.hasWriter).toBe(false);
  });

  it('deactivate flushes queued work rather than dropping it', async () => {
    const s = scene('scn_a', 'A');
    const c = track(candidate('a', new Map([['scn_a', s]])));
    await c.backend.activate();
    emitSceneMutation({ type: 'upsert', id: 'scn_a', scene: s });
    // No explicit flush — deactivate() is the flush.
    await c.backend.deactivate();
    expect(c.sceneRows()).toEqual([sceneGlbRelPathFor(s).split('/')[1]]);
  });

  it('after deactivation the bus is silent again', async () => {
    const s = scene('scn_b', 'B');
    const c = track(candidate('a', new Map([['scn_b', s]])));
    await c.backend.activate();
    await c.backend.deactivate();
    emitSceneMutation({ type: 'upsert', id: 'scn_b', scene: s });
    await c.backend.flush();
    expect(c.sceneRows()).toEqual([]);
  });

  it('refuses a host swap while active — that is how a write lands elsewhere', async () => {
    const c = track(candidate('a', new Map()));
    await c.backend.activate();
    expect(() => c.backend.setWriterHost(null)).toThrow();
    expect(() => c.backend.setWritable(false)).toThrow();
  });
});

// ─── 3. The core case ───────────────────────────────────────────────────

describe('two discovered folders, one activated', () => {
  it('a mutation reaches exactly one folder', async () => {
    const s = scene('scn_a', 'A');
    const bodies = new Map([['scn_a', s]]);
    const open = track(candidate('open', bodies));
    const other = track(candidate('other', bodies));
    const third = track(candidate('third', bodies));

    await open.backend.activate();   // only this one

    emitSceneMutation({ type: 'upsert', id: 'scn_a', scene: s });
    await open.backend.flush();
    await other.backend.flush();
    await third.backend.flush();

    expect(open.sceneRows()).toHaveLength(1);
    expect(other.sceneRows()).toEqual([]);
    expect(third.sceneRows()).toEqual([]);
    // …and nothing reached the untouched folders on disk either.
    expect(other.root.has('project.json')).toBe(false);
    expect(third.root.has('project.json')).toBe(false);
  });

  it('a switch deactivates the old backend before activating the new', async () => {
    const s1 = scene('scn_1', 'One');
    const s2 = scene('scn_2', 'Two');
    const bodies = new Map([['scn_1', s1], ['scn_2', s2]]);
    const first = track(candidate('first', bodies));
    const second = track(candidate('second', bodies));

    await first.backend.activate();
    emitSceneMutation({ type: 'upsert', id: 'scn_1', scene: s1 });

    // The switch, in the order `openProjectFolder()` enforces.
    await first.backend.deactivate();
    await second.backend.activate();

    emitSceneMutation({ type: 'upsert', id: 'scn_2', scene: s2 });
    await second.backend.flush();
    await first.backend.flush();

    expect(first.sceneRows()).toEqual([sceneGlbRelPathFor(s1).split('/')[1]]);
    expect(second.sceneRows()).toEqual([sceneGlbRelPathFor(s2).split('/')[1]]);
  });

  it('activating both is what the store must never do — and it shows why', async () => {
    const s = scene('scn_a', 'A');
    const bodies = new Map([['scn_a', s]]);
    const a = track(candidate('a', bodies));
    const b = track(candidate('b', bodies));

    await a.backend.activate();
    await b.backend.activate();
    emitSceneMutation({ type: 'upsert', id: 'scn_a', scene: s });
    await a.backend.flush();
    await b.backend.flush();

    // Both folders got the write. This is the failure mode `activate()`
    // exists to make impossible, documented here so the rule has a witness.
    expect(a.sceneRows()).toHaveLength(1);
    expect(b.sceneRows()).toHaveLength(1);
  });
});

// ─── 4. RR1 survives the move ───────────────────────────────────────────

describe('RR1 path ownership', () => {
  it('refuses a path that belongs to a different scene', async () => {
    const mine = scene('scn_mine', 'Cell');
    const yours = scene('scn_yours', 'Cell');
    const c = track(candidate('a', new Map([['scn_mine', mine]])));
    c.manifest = {
      ...c.manifest,
      documents: [{
        id: 'scn_yours', name: 'Cell',
        path: sceneGlbRelPathFor(yours), section: 'scenes',
      }],
    };
    await c.backend.activate();
    await expect(writeSceneDocument(c.backend, sceneGlbRelPathFor(yours), glbWriteFor(mine))).rejects.toThrow(/belongs to scene/);
  });

  /**
   * plan-736 §2.3: this used to refuse, and the refusal was the section split
   * showing through on the delete path.
   *
   * `deleteScene` threw for a path no manifest row owned, while `deleteBlob` —
   * one screen down in the same class — deleted it without a word. Which of the
   * two a caller got was decided by `sectionOfDocument`, so "may I delete an
   * unowned file" had two answers depending on which folder the file happened
   * to be in. One method cannot keep both.
   *
   * Tolerance wins because it is the one of the two that is idempotent: the
   * caller's intent ("this must not be there") is already satisfied by a file
   * that is not there, and a second Delete click must not become an error. R2 —
   * never tidy away what nobody asked about — is untouched: it constrains the
   * writer's own sweeps, not an explicit delete somebody asked for.
   */
  it('a delete for a path no manifest entry owns is a no-op, not a refusal', async () => {
    const c = track(candidate('a', new Map()));
    await c.backend.activate();
    await expect(c.backend.deleteDocument('scenes/ghost.scene.glb')).resolves.toBeUndefined();
  });
});
