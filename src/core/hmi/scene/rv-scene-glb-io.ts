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
 *
 * ## Drafts are the exception, and always browser-side
 *
 * The rule above is about a **committed** body, where the folder has to be
 * authoritative so a stale browser copy cannot shadow it. A `draft/` slot is
 * the opposite kind of thing: the autosaved copy of UNSAVED edits, kept only so
 * a reload or a crash does not lose them, and dropped again the moment the
 * document is saved. It belongs to this browser and this session, never to the
 * project.
 *
 * It used to inherit the committed rule by accident, which put a private
 * recovery file into the user's project folder — synced, committed, delivered,
 * and (because a draft is a full GLB) rescanned as a ghost document. Worse, the
 * path it landed on came from `sceneGlbRelPathFor()`, which still hard-codes the
 * `scenes/` prefix that plan-716/736 abolished: the draft was the last thing in
 * the product still creating that folder.
 *
 * So every `draft/` slot goes to the OPFS store unconditionally. Cross-tab
 * conflict detection survives the move — the store carries the same revision.
 * What does NOT survive is finding your unsaved edits after opening the same
 * folder in another browser, which is what "unsaved" means everywhere else.
 */

import { getProjectStore } from '../../project/project-store';
import {
  deleteSceneGlb,
  listSceneGlbSlots,
  moveSceneGlbPointer,
  readSceneGlb,
  readSceneGlbPointer,
  sceneGlbRevision,
  writeSceneGlb,
  type SceneGlbMoveResult,
  type SceneGlbMoveStamp,
} from '../../storage/rv-scene-glb-store';
import {
  SceneRevisionConflictError,
  type SceneRevision,
} from '../../project/rv-scene-record';
import { documentsOf } from '../../project/rv-project-documents';
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
  /**
   * OPFS bodies only (plan-546): the document revision the body was baked
   * from, as the pointer records it. Absent = a legacy or unstamped body.
   */
  baseSha?: string;
  /** OPFS bodies only (plan-546): when the pointer was written (ISO). */
  updatedAt?: string;
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

/**
 * The prefix every autosave slot carries.
 *
 * It lives here beside the branch it steers rather than in the scene store that
 * mints it: this module is the one place that decides which store a body goes
 * to, so it has to be the one place that knows what a draft looks like.
 */
const DRAFT_SLOT_PREFIX = 'draft/';

/** Is this slot the autosaved copy of unsaved edits, rather than a document? */
function isDraftSlot(sceneId: string): boolean {
  return typeof sceneId === 'string' && sceneId.startsWith(DRAFT_SLOT_PREFIX);
}

/**
 * The backend that owns this body, or null when the OPFS store does.
 *
 * One helper rather than a `writableBackend()` plus a draft test at each of the
 * three call sites: read, write and revision have to agree about the
 * destination, and three copies of a condition is how they stop agreeing.
 */
function ownerBackendFor(sceneId: string): ProjectBackend | null {
  return isDraftSlot(sceneId) ? null : writableBackend();
}

/**
 * The manifest entry for a scene in the open project, or null.
 *
 * By ID over the one list (plan-744 F3) — an id is unique across the manifest,
 * so the scene-shaped filter this used to run through could only ever lose the
 * row. It lost every browser one, whose path is its bare id.
 */
function projectEntry(sceneId: string): RvProjectSceneEntry | null {
  const project = getProjectStore().getProject();
  return (documentsOf(project).find((e) => e?.id === sceneId) ?? null) as
    RvProjectSceneEntry | null;
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
  const backend = ownerBackendFor(sceneId);
  const entry = backend ? projectEntry(sceneId) : null;
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
  const pointer = readSceneGlbPointer(sceneId);
  return {
    glb,
    revision: pointer?.sha ?? '',
    target: 'opfs',
    ...(pointer?.baseSha ? { baseSha: pointer.baseSha } : {}),
    ...(pointer?.updatedAt ? { updatedAt: pointer.updatedAt } : {}),
  };
}

/** The stored revision of a scene's body, or null when it has none. */
export async function sceneGlbBodyRevision(sceneId: string): Promise<SceneRevision | null> {
  const entry = projectEntry(sceneId);
  if (entry?.revision && ownerBackendFor(sceneId)) return entry.revision;
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
  /**
   * The document revision a DRAFT body was baked from (plan-546). Stamped on
   * the OPFS pointer; ignored by the project branch. Omitted = no stamp.
   */
  baseSha?: string;
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
  const backend = ownerBackendFor(write.sceneId);

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
  const revision = await writeSceneGlb(
    write.sceneId,
    write.glb,
    write.baseSha ? { baseSha: write.baseSha } : {},
  );
  return { revision, target: 'opfs' };
}

/** Remove a scene's OPFS body. The project branch deletes through the backend. */
export async function dropSceneGlbBody(sceneId: string): Promise<void> {
  await deleteSceneGlb(sceneId);
}

// ─── Set-aside drafts (plan-546) ────────────────────────────────────────

/**
 * The slot prefix under which a document's stale drafts are kept aside.
 *
 * Under `draft/` on purpose: every guard that keeps drafts out of the project
 * folder, out of the migration's orphan adoption and out of the document list
 * already keys on that prefix.
 */
export function setAsideSlotPrefix(documentId: string): string {
  return `${DRAFT_SLOT_PREFIX}~stale/${documentId}/`;
}

/** The set-aside slot for one draft body of a document. */
export function setAsideSlotFor(documentId: string, sha: string): string {
  return `${setAsideSlotPrefix(documentId)}${sha.slice(0, 12)}`;
}

/** One set-aside draft, as its pointer describes it. */
export interface SetAsideBody {
  slot: string;
  sha: string;
  /** The document revision the draft was baked from, when stamped. */
  baseSha?: string;
  /** When it was moved aside (ISO); falls back to its write time. */
  movedAt: string;
  updatedAt: string;
}

/** Every set-aside draft of `documentId`, newest move first. */
export function listSetAsideBodies(documentId: string): SetAsideBody[] {
  if (!documentId) return [];
  const out: SetAsideBody[] = [];
  for (const slot of listSceneGlbSlots(setAsideSlotPrefix(documentId))) {
    const pointer = readSceneGlbPointer(slot);
    if (!pointer) continue;
    out.push({
      slot,
      sha: pointer.sha,
      ...(pointer.baseSha ? { baseSha: pointer.baseSha } : {}),
      movedAt: pointer.movedAt ?? pointer.updatedAt,
      updatedAt: pointer.updatedAt,
    });
  }
  const t = (iso: string) => { const v = Date.parse(iso); return Number.isFinite(v) ? v : 0; };
  return out.sort((a, b) => t(b.movedAt) - t(a.movedAt));
}

/** The OPFS pointer of a body slot (sha + stamps), or null. */
export function sceneGlbBodyPointer(sceneId: string): {
  sha: string; baseSha?: string; updatedAt: string;
} | null {
  const pointer = readSceneGlbPointer(sceneId);
  if (!pointer) return null;
  return {
    sha: pointer.sha,
    updatedAt: pointer.updatedAt,
    ...(pointer.baseSha ? { baseSha: pointer.baseSha } : {}),
  };
}

/**
 * Move an OPFS body to another slot, compare-and-swap on its sha. Draft slots
 * only — a committed body belongs to its owner and is never renamed here.
 */
export function moveSceneGlbBody(
  from: string,
  to: string,
  expectedSha: string,
  stamp: SceneGlbMoveStamp = {},
): SceneGlbMoveResult {
  if (!isDraftSlot(from) || !isDraftSlot(to)) return 'conflict';
  return moveSceneGlbPointer(from, to, expectedSha, stamp);
}
