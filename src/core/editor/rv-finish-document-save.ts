// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-finish-document-save — the ONE step that follows a successful document
 * write (plan-777 F5, P4).
 *
 * There are two save pipelines and they stay two: the planner (`SceneStore`)
 * bakes its bytes from an op log, the editor (`rv-save-document`) exports its
 * own tree, and an MCP replace installs bytes it was handed. What happens AFTER
 * the bytes are on disk is the same for all three, and it lives here:
 *
 *  1. **thumbnail** — `writeDocumentThumbnail` (plan-776) renders the open
 *     document and points the row at the picture, awaited; `render: false`
 *     drops the pointer instead (an MCP replace of a document nobody shows).
 *     A read-only backend or a viewer that cannot render skips this step and
 *     leaves the pointer alone — the next save from a real viewer catches up;
 *  2. **announce** — {@link announceDocumentSaved}, the one `document-saved`
 *     emit in `src/` (`tests/document-vocabulary-guard.node.test.ts` pins it);
 *  3. **rescan** — `store.rescanDocuments()`, NOT awaited: a folder listing
 *     must not hold the save queue. It is single-flighted with a dirty re-run
 *     (`ProjectStore.rescanDocuments`), so two quick saves cost at most one
 *     running and one queued scan.
 *
 * The order is the contract `doc-webviewer-interface.md` documents: a
 * `document-saved` subscriber sees the new pointer, and nothing it does waits
 * for the rescan. Every step is guarded on its own — a failure in one never
 * skips the next, and this function never throws.
 *
 * A leaf module: it imports nothing at runtime except the thumbnail writer,
 * lazily (plan-776 P10), so the renderer stays out of the startup chunk and no
 * edge leads back to the project store or the scene store. It is the only save
 * path that imports the writer (`thumbnail-read-import-boundary.node.test.ts`).
 */

import type { ProjectBackend } from '../project/backends/project-backend';
import type { RvDocumentEntry } from '../project/rv-project-types';
import type { ThumbnailRowStore, ThumbnailViewer } from '../thumbnails/rv-thumbnail-write';

/** Payload of the `document-saved` viewer event (`rv-viewer-events.ts`). */
export interface DocumentSavedPayload {
  documentId: string;
  /** Project-relative path just written; `''` for a slot-addressed document. */
  relPath: string;
}

/**
 * The part of the viewer the post-save step needs. Structural, so the loosely
 * typed MCP bridge and the tests can pass what they hold.
 */
export interface FinishSaveViewer {
  emit?(event: 'document-saved', payload: DocumentSavedPayload): unknown;
  renderer?: unknown;
  scene?: unknown;
}

/** The part of the project store the post-save step needs. */
export interface FinishSaveStore extends ThumbnailRowStore {
  rescanDocuments?(): Promise<void>;
}

export interface FinishDocumentSaveContext {
  viewer: FinishSaveViewer | null | undefined;
  store: FinishSaveStore | null | undefined;
  backend: ProjectBackend | null | undefined;
  /**
   * The saved document's id. `null` when the caller does not know it (the
   * planner's "save settings into a model" writes a new file by path): the row
   * is then resolved by `relPath`, after the thumbnail writer's own lookup, and
   * without a row there is nothing to announce.
   */
  documentId: string | null;
  relPath: string;
  /** The pointer the save started from; deleted unless it is the new one. */
  previous?: string | null;
  /** Default true. `false` drops the pointer instead of rendering. */
  render?: boolean;
  /** Default true. `false` for a caller that announced earlier itself (MCP replace). */
  announce?: boolean;
}

/**
 * Announce that a document was written: the ONE `document-saved` emit.
 *
 * Exported on its own for the MCP replace, which has to announce BEFORE it
 * reloads the open document (the planner drops its stale bytes on the event)
 * and runs the rest of {@link finishDocumentSave} at the end. Never throws —
 * the listeners are not ours.
 */
export function announceDocumentSaved(
  viewer: FinishSaveViewer | null | undefined,
  payload: DocumentSavedPayload,
): void {
  try {
    viewer?.emit?.('document-saved', { documentId: payload.documentId, relPath: payload.relPath });
  } catch (e) {
    console.warn('[save] a document-saved listener threw (the document saved fine):', e);
  }
}

/**
 * Run the post-save step: thumbnail → announce → background rescan. Call it
 * once the saved document's identity is final, and only after a successful
 * write — a conflict or a moved target calls nothing. Never throws.
 *
 * @returns the new thumbnail pointer, or null when none was written.
 */
export async function finishDocumentSave(
  ctx: FinishDocumentSaveContext,
): Promise<{ thumbnail: string | null }> {
  const { viewer, store, backend, relPath } = ctx;
  let thumbnail: string | null = null;

  // 1. Thumbnail. Guarded like the three wrappers this replaced: nothing to
  // write into, or nothing that can render → skip, pointer untouched, and the
  // renderer's chunk is not even loaded.
  try {
    if (store && backend?.writable) {
      if (ctx.render === false) {
        const id = ctx.documentId ?? rowByPath(store, relPath)?.id ?? null;
        if (id) {
          const write = await import('../thumbnails/rv-thumbnail-write');
          await write.dropDocumentThumbnail({ store, backend, documentId: id });
        }
      } else if (viewer?.renderer && viewer.scene) {
        const write = await import('../thumbnails/rv-thumbnail-write');
        thumbnail = await write.writeDocumentThumbnail({
          viewer: viewer as unknown as ThumbnailViewer,
          store,
          backend,
          documentId: ctx.documentId,
          relPath,
          previous: ctx.previous ?? null,
        });
      }
    }
  } catch (e) {
    console.warn('[save] the thumbnail step failed (the document saved fine):', e);
  }

  // 2. Announce — with the id the caller knew, else the row's by path.
  if (ctx.announce !== false) {
    try {
      const id = ctx.documentId ?? (store ? rowByPath(store, relPath)?.id : null) ?? null;
      if (id) announceDocumentSaved(viewer, { documentId: id, relPath });
    } catch (e) {
      console.warn('[save] the document-saved announce failed:', e);
    }
  }

  // 3. Rescan — fire and forget (P5): the save queue is not held by a listing.
  try {
    const scan = store?.rescanDocuments?.();
    if (scan && typeof scan.catch === 'function') {
      void scan.catch((e: unknown) => console.warn('[save] the post-save rescan failed:', e));
    }
  } catch (e) {
    console.warn('[save] the post-save rescan failed:', e);
  }

  return { thumbnail };
}

function normalisePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

/** The manifest row at `relPath` — the same path rule the thumbnail writer uses. */
function rowByPath(store: ThumbnailRowStore, relPath: string): RvDocumentEntry | null {
  const path = typeof relPath === 'string' ? normalisePath(relPath) : '';
  if (!path) return null;
  const rows = store.getProject()?.documents;
  if (!Array.isArray(rows)) return null;
  return rows.find((d) => typeof d?.path === 'string' && normalisePath(d.path) === path) ?? null;
}
