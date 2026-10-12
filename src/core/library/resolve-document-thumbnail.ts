// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * resolve-document-thumbnail — the persisted preview of one document
 * (plan-744 §2.4, F5/F6).
 *
 * ## Why it lives in `library/` and not in `thumbnails/`
 *
 * `src/core/thumbnails/` is rendering: a renderer, a queue, a cache, and a
 * card-side hook. It knows nothing about projects and must not start to — a
 * module that renders an `Object3D` has no business holding a `ProjectBackend`.
 * The coupling to the backend already exists one folder over, in
 * `project-library-provider.ts`, so that is where this belongs (Review #7).
 *
 * ## The chain
 *
 * 1. **`doc.thumbnail`** — a URL or path the MANIFEST states. Bundled deploys
 *    fill this in, and a manifest that names a picture is the author telling
 *    us which one to use (Review #4).
 * 2. **The id-keyed sidecar**, `<project>/.thumbnails/<encodeThumbnailId(id)>.png`.
 *    This is what {@link writeDocumentThumbnail} writes on every save.
 * 3. **Lazy migration** of the pre-plan-744 path-mirrored
 *    `library/.thumbnails/<rel>.png`, copied under the id on first sight.
 * 4. **`null`** — and the caller falls back to rendering the GLB, which is the
 *    path every document took before this module existed.
 *
 * The GLB-EMBEDDED preview of plan-438 is named as tier 1 in the plan and is
 * deliberately absent here: this repo has no reader for it. Its effective
 * stand-in is step 4, the live render off the same bytes — later in the chain
 * than plan-438 would put it, which costs a render and never correctness.
 *
 * ## Why the lazy migration is not a sweep
 *
 * The old files stay where they are for a release. A destructive pass over a
 * customer's `library/.thumbnails/` buys nothing (the folder is small and
 * ignored) and risks everything (it is the only copy). Reconciling orphans is
 * a later, separate job.
 *
 * The copy is **preconditioned on the target being absent** and therefore
 * idempotent: a save that landed a fresh sidecar a moment ago must not be
 * overwritten by a migration of the stale one it replaced (Review #6). The
 * precondition is enforced by the BACKEND (`expectedRevision: 'create'`), not
 * by a read-then-write here, so there is no window between the check and the
 * write.
 */

import type { ProjectBackend } from '../project/backends/project-backend';
import type { RvDocumentEntry } from '../project/rv-project-types';
import { legacyLibraryThumbnailPath, thumbnailSidecarPath } from './library-types';

/** A loadable preview URL plus the means to let it go again. */
export interface ResolvedDocumentThumbnail {
  url: string;
  /** Revokes an object URL. Absent for a plain URL, which owns nothing. */
  release?: () => void;
}

/**
 * How many sidecar reads may be in flight at once.
 *
 * A dashboard opening on a 200-document project would otherwise issue 200
 * concurrent File System Access reads the moment the grid mounts (Review #9).
 * The card hook already gates on visibility, so this is the second limit
 * rather than the only one — and it is a local gate rather than a detour
 * through `ThumbnailService`, whose queue carries `Object3D` renders and would
 * have to grow a second job kind to carry a byte read.
 */
const MAX_CONCURRENT_READS = 4;

let inFlight = 0;
const waiting: Array<() => void> = [];

async function withReadSlot<T>(run: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_CONCURRENT_READS) {
    await new Promise<void>(resolve => waiting.push(resolve));
  }
  inFlight++;
  try {
    return await run();
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

/**
 * The persisted preview of `doc`, or null when it has none.
 *
 * Never throws: a preview is decoration, and an unreadable one must not take a
 * card — let alone a dashboard — down with it.
 */
export async function resolveDocumentThumbnail(
  backend: ProjectBackend | null | undefined,
  doc: Pick<RvDocumentEntry, 'id' | 'path'> & { thumbnail?: unknown },
): Promise<ResolvedDocumentThumbnail | null> {
  // 1. What the manifest states.
  const declared = typeof doc.thumbnail === 'string' ? doc.thumbnail.trim() : '';
  if (declared !== '') return { url: declared };

  const id = typeof doc.id === 'string' ? doc.id.trim() : '';
  if (!backend || id === '') return null;

  return withReadSlot(async () => {
    const sidecar = thumbnailSidecarPath(id);
    // 2. The id-keyed sidecar.
    const found = await readUrl(backend, sidecar);
    if (found) return found;

    // 3. The pre-plan-744 path-mirrored one, copied under the id on sight.
    const legacy = legacyLibraryThumbnailPath(typeof doc.path === 'string' ? doc.path : '');
    if (!legacy) return null;
    const bytes = await readBytes(backend, legacy);
    if (!bytes) return null;
    await copyUnderId(backend, sidecar, bytes);
    return (await readUrl(backend, sidecar)) ?? null;
  });
}

/**
 * Carry a document's OLD path-mirrored thumbnail under its id, before a move
 * takes the path away (plan-744 Review #5).
 *
 * Without this, a document moved out of `library/` before anything ever
 * rendered its card loses the picture for good: the lazy migration keys off
 * `doc.path`, and after the move that path no longer says `library/`.
 *
 * Best-effort and silent. Returns true when a copy was made, which is what the
 * move's own tests assert on.
 */
export async function migrateLegacyThumbnailForMove(
  io: {
    readBytes(relPath: string): Promise<Blob | null>;
    writeBytes(relPath: string, blob: Blob): Promise<void>;
  },
  documentId: string,
  fromPath: string,
): Promise<boolean> {
  const legacy = legacyLibraryThumbnailPath(fromPath);
  const id = typeof documentId === 'string' ? documentId.trim() : '';
  if (!legacy || id === '') return false;
  try {
    const target = thumbnailSidecarPath(id);
    // No `create` precondition available on this IO, so the check is a read.
    // The race it leaves open is a save landing a fresh sidecar between the
    // two calls, and a tree move already holds the document still.
    if (await io.readBytes(target)) return false;
    const bytes = await io.readBytes(legacy);
    if (!bytes) return false;
    await io.writeBytes(target, bytes);
    return true;
  } catch {
    return false;   // a thumbnail never fails a move
  }
}

async function readUrl(
  backend: ProjectBackend,
  relPath: string,
): Promise<ResolvedDocumentThumbnail | null> {
  try {
    const resolved = await backend.readDocumentUrl(relPath);
    return resolved ? { url: resolved.url, release: resolved.release } : null;
  } catch {
    return null;
  }
}

async function readBytes(backend: ProjectBackend, relPath: string): Promise<Uint8Array | null> {
  try {
    const record = await backend.readDocument(relPath);
    return record?.bytes ?? null;
  } catch {
    return null;
  }
}

async function copyUnderId(
  backend: ProjectBackend,
  target: string,
  bytes: Uint8Array,
): Promise<void> {
  if (!backend.writable) return;
  try {
    // `'create'` is the whole point: the backend refuses if anything is there,
    // so a fresh save can never be clobbered by a migration of the stale copy
    // it replaced. The refusal is the success case for the second caller.
    await backend.writeDocument(target, bytes, { expectedRevision: 'create' });
  } catch {
    /* already there, or read-only — either way the next read answers. */
  }
}
