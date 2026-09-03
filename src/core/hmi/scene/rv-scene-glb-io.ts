// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-scene-glb-io — where a scene's GLB body is read from and written to
 * (plan-397 phase 6).
 *
 * ## The one place that answers "which store?"
 *
 * The plan's decision log says the bodies live in **OPFS + the project
 * folder**, and that localStorage is out. That is two destinations, and which
 * one applies is not a preference — it depends on what is open:
 *
 *  - a **writable** `ProjectBackend` (a folder project, or a browser project)
 *    owns the scene: the body belongs in the project, so it goes through
 *    `writeScene()` and travels with the folder;
 *  - otherwise the body goes into the id-keyed OPFS store from phase 5
 *    (`rv-scene-glb-store`), which knows nothing about projects.
 *
 * The second branch is not an edge case, and getting it wrong would have been
 * a data-loss bug rather than an inconvenience: `resolveActiveProject()` always
 * ends up with *some* backend, but its last fallback is the **bundled** one,
 * and that is `writable = false` with a `writeScene()` that throws. A user who
 * never opened a project — the default — would have had every save rejected.
 *
 * Both branches are GLB-only and both carry the same compare-and-swap
 * revision (§2.8): a SHA-256 of the stored bytes. Only the owner of the file
 * differs, so the caller never has to know which one it got.
 */

import { getProjectStore } from '../../project/project-store';
import {
  deleteSceneGlb,
  readSceneGlb,
  sceneGlbRevision,
  writeSceneGlb,
} from '../../storage/rv-scene-glb-store';
import {
  SceneRevisionConflictError,
  type SceneRevision,
} from '../../project/rv-scene-record';
import { sceneDocumentsOf } from '../../project/rv-project-documents';
import {
  sceneGlbRelPathFor,
  type RvProjectSceneEntry,
} from '../../project/rv-project-types';
import type { ProjectBackend } from '../../project/backends/project-backend';

/** Where a body ended up, for diagnostics and for the tests that pin it. */
export type SceneGlbTarget = 'project' | 'opfs';

export interface SceneGlbWriteResult {
  revision: SceneRevision;
  target: SceneGlbTarget;
}

export interface SceneGlbBody {
  glb: Uint8Array;
  revision: SceneRevision;
  target: SceneGlbTarget;
}

/**
 * The backend that may own scene bodies, or null.
 *
 * `writable` is the whole test. A read-only backend (bundled, or a remote
 * deploy) is a perfectly good place to *read* a project from and never a place
 * to write one to.
 */
function writableBackend(): ProjectBackend | null {
  const backend = getProjectStore().getBackend();
  return backend && backend.writable ? backend : null;
}

/** The manifest entry for a scene in the open project, or null. */
function projectEntry(sceneId: string): RvProjectSceneEntry | null {
  const project = getProjectStore().getProject();
  return sceneDocumentsOf(project).find((e) => e?.id === sceneId) ?? null;
}

// ─── Read ───────────────────────────────────────────────────────────────

/**
 * The GLB body of a scene, from wherever it lives.
 *
 * The project is asked first and the OPFS store is the fallback — never the
 * other way round. A scene that belongs to a project has its authoritative
 * body in the folder, and an OPFS copy left over from before it was adopted
 * would otherwise shadow it and quietly serve a stale layout.
 */
export async function readSceneGlbBody(sceneId: string): Promise<SceneGlbBody | null> {
  const backend = writableBackend();
  const entry = projectEntry(sceneId);
  if (backend && entry?.path) {
    try {
      const record = await backend.readDocument({ path: entry.path, id: sceneId });
      if (record?.bytes) return { glb: record.bytes, revision: record.revision, target: 'project' };
    } catch {
      // Fall through: an unreadable project file is not a reason to withhold a
      // body the OPFS store may still have.
    }
  }

  const glb = await readSceneGlb(sceneId);
  if (!glb) return null;
  const revision = sceneGlbRevision(sceneId);
  return { glb, revision: revision ?? '', target: 'opfs' };
}

/** The stored revision of a scene's body, or null when it has none. */
export async function sceneGlbBodyRevision(sceneId: string): Promise<SceneRevision | null> {
  const entry = projectEntry(sceneId);
  if (entry?.revision && writableBackend()) return entry.revision;
  return sceneGlbRevision(sceneId);
}

// ─── Write ──────────────────────────────────────────────────────────────

export interface SceneGlbWrite {
  sceneId: string;
  name: string;
  glb: Uint8Array;
  /**
   * The revision the caller believes is stored. `undefined` writes
   * unconditionally — reserved for migration and import, exactly as
   * {@link SceneWrite.expectedRevision} defines it.
   */
  expectedRevision?: SceneRevision | null;
  createdAt?: string;
}

/**
 * Persist a scene body and return its new revision.
 *
 * Throws {@link SceneRevisionConflictError} when the precondition does not
 * hold — on both branches. The OPFS branch has to check by hand because the
 * store's `writeSceneGlb` is a plain put; doing it here rather than there
 * keeps the store a dumb, testable byte sink and puts the one definition of
 * "conflict" beside the one definition of "destination".
 */
export async function writeSceneGlbBody(write: SceneGlbWrite): Promise<SceneGlbWriteResult> {
  const backend = writableBackend();

  if (backend) {
    const existing = projectEntry(write.sceneId);
    const meta: RvProjectSceneEntry = {
      ...(existing ?? {}),
      id: write.sceneId,
      name: write.name,
      path: existing?.path ?? sceneGlbRelPathFor({ id: write.sceneId, name: write.name }),
      modifiedAt: new Date().toISOString(),
      ...(write.createdAt ? { createdAt: write.createdAt } : {}),
    };
    // `meta` is what makes this a scene body on a backend that keys scene
    // bodies by id (the browser one). It is caller intent at the call site, not
    // a stored category — see `BrowserBackend.writeDocument` (plan-736).
    const { revision } = await backend.writeDocument(
      { path: meta.path, id: write.sceneId, meta },
      write.glb,
      {
        expectedRevision: write.expectedRevision === undefined
          ? 'any'
          : write.expectedRevision === null ? 'create' : write.expectedRevision,
      },
    );
    return { revision, target: 'project' };
  }

  const actual = sceneGlbRevision(write.sceneId);
  if (write.expectedRevision !== undefined) {
    const want = write.expectedRevision === null ? null : write.expectedRevision.toLowerCase();
    const have = actual === null ? null : actual.toLowerCase();
    if (want !== have) throw new SceneRevisionConflictError(write.sceneId, want, have);
  }
  const revision = await writeSceneGlb(write.sceneId, write.glb);
  return { revision, target: 'opfs' };
}

/** Remove a scene's OPFS body. The project branch deletes through the backend. */
export async function dropSceneGlbBody(sceneId: string): Promise<void> {
  await deleteSceneGlb(sceneId);
}
