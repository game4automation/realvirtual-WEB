// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * resolve-document-thumbnail — the saved preview of a document, read and
 * looked after WITHOUT ever rendering one (plan-776 F3/F5/F7/F12).
 *
 * ## The rule this module exists to keep
 *
 * A thumbnail is a write-time artefact. A save renders it, writes it as a
 * sidecar `.thumbnails/<id>.<hash8>.<webp|png>` and points the document's row
 * at it (`rv-thumbnail-write.ts`). Everything that SHOWS a card reads that
 * pointer through {@link resolveThumbnailUrl} and nothing else: no probing of
 * conventional paths, no `.png` fallback, no legacy path, and above all no GLB
 * load — a missing pointer is the type placeholder (#2). The import guard
 * `tests/thumbnail-read-import-boundary.node.test.ts` keeps the renderer out of
 * this module's reach.
 *
 * ## Why it lives in `library/` and not in `thumbnails/`
 *
 * `src/core/thumbnails/` renders. A module that renders an `Object3D` has no
 * business holding a `ProjectBackend`, and a card must not import a renderer —
 * so the backend half of thumbnails sits one folder over, beside
 * `project-library-provider.ts`, which already couples library and backend.
 *
 * ## Delete safety (F3)
 *
 * Every delete in this plan goes through {@link deleteThumbnailSidecar}, which
 * refuses anything that is not a project-root sidecar of exactly the document
 * being saved or deleted (`isOwnThumbnailSidecar`). A pointer somebody typed
 * into a manifest by hand — `https://…`, `../models/x.glb`, another id's file —
 * is never deleted.
 */

import type { ProjectBackend } from '../project/backends/project-backend';
import {
  isExternalThumbnailPointer,
  isOwnThumbnailSidecar,
  isReadableThumbnailPointer,
  legacyThumbnailSidecarPath,
  parseThumbnailSidecarTail,
  thumbnailSidecarPath,
} from './library-types';

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
 * concurrent File System Access reads the moment the grid mounts. The cards
 * read on mount (plan-776 P9: there is no visibility gate any more — it existed
 * to throttle GLB renders, which are gone), so this gate is the one limit.
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
 * The loadable URL behind a row's `thumbnail` pointer, or null (placeholder).
 *
 *  - a pointer with a URL scheme (`http(s):`, `data:`, `blob:`) or a leading
 *    `/` passes through unchanged — a value a delivered manifest or another
 *    provider states; this plan never writes and never deletes one;
 *  - a relative pointer must name a `.thumbnails/` file (`.thumbnails/x` or
 *    `<Category>/.thumbnails/x`) with no `..`, else null;
 *  - a valid relative pointer is read through the backend — a blob URL for a
 *    folder or browser project, a plain (or, for an encrypted deploy, a
 *    decrypted blob) URL for a bundled one.
 *
 * Never throws: a read error, or a decrypt failure before the deploy is
 * unlocked, is null — the next project/unlock publish asks again.
 */
export async function resolveThumbnailUrl(
  backend: ProjectBackend | null | undefined,
  pointer: unknown,
): Promise<ResolvedDocumentThumbnail | null> {
  const value = typeof pointer === 'string' ? pointer.trim() : '';
  if (value === '') return null;
  if (isExternalThumbnailPointer(value)) return { url: value };
  if (!backend || !isReadableThumbnailPointer(value)) return null;
  return withReadSlot(async () => {
    try {
      const resolved = await backend.readDocumentUrl(value);
      return resolved ? { url: resolved.url, release: resolved.release } : null;
    } catch {
      return null;
    }
  });
}

/**
 * Delete `pointer` from `backend` — only if it is a sidecar OF `documentId`
 * (F3). Best-effort and silent: a sidecar that outlives its document is a few
 * kilobytes of dead file, a failed delete must never fail the verb around it.
 *
 * @returns true when a delete was attempted and did not throw.
 */
export async function deleteThumbnailSidecar(
  backend: Pick<ProjectBackend, 'writable' | 'deleteDocument'> | null | undefined,
  pointer: unknown,
  documentId: string,
): Promise<boolean> {
  if (!backend?.writable || !isOwnThumbnailSidecar(pointer, documentId)) return false;
  try {
    await backend.deleteDocument(pointer as string);
    return true;
  } catch {
    return false;
  }
}

/**
 * The id-bound cleanup of a save or a delete (F3 step 4, F12): remove every
 * KNOWN sidecar of `documentId` except `keep` — the pointers handed in (the
 * row's value at delete time, the one the save started from) and the
 * hash-less legacy `.thumbnails/<id>.png` of the same id.
 *
 * "Known" because no backend lists the hidden `.thumbnails/` folder: the
 * dot rule keeps it out of every listing, which is exactly what makes the
 * folder invisible in the dashboard. A stray file this misses is dead weight,
 * never a wrong picture — the reader goes by the pointer only.
 */
export async function cleanupThumbnailSidecars(
  backend: Pick<ProjectBackend, 'writable' | 'deleteDocument'> | null | undefined,
  documentId: string,
  candidates: readonly unknown[],
  keep: string | null,
): Promise<void> {
  if (!backend?.writable) return;
  const seen = new Set<string>();
  for (const candidate of [...candidates, legacyThumbnailSidecarPath(documentId)]) {
    if (typeof candidate !== 'string' || candidate === keep || seen.has(candidate)) continue;
    seen.add(candidate);
    await deleteThumbnailSidecar(backend, candidate, documentId);
  }
}

/** The byte I/O a sidecar copy needs on each side. */
export interface SidecarIO {
  read(relPath: string): Promise<Uint8Array | null>;
  write(relPath: string, bytes: Uint8Array): Promise<void>;
}

/**
 * Copy the sidecar of `sourceId` to the name of `targetId` (F5): duplicate,
 * cross-source copy and move. The bytes are copied, never re-rendered, and keep
 * their hash and extension — the picture is the same file content.
 *
 * @returns the target's new pointer, or null when there is nothing to copy or
 *   the copy failed — the caller then writes a row WITHOUT `thumbnail`, never
 *   one that carries the source's pointer into a place it does not exist.
 */
export async function copyThumbnailSidecar(
  from: Pick<SidecarIO, 'read'>,
  to: Pick<SidecarIO, 'write'>,
  pointer: unknown,
  sourceId: string,
  targetId: string,
): Promise<string | null> {
  if (!isOwnThumbnailSidecar(pointer, sourceId)) return null;
  const tail = parseThumbnailSidecarTail(pointer as string);
  if (!tail) return null;
  try {
    const bytes = await from.read(pointer as string);
    if (!bytes || bytes.byteLength === 0) return null;
    const next = thumbnailSidecarPath(targetId, tail.hash8, tail.ext);
    await to.write(next, bytes);
    return next;
  } catch {
    return null;
  }
}
