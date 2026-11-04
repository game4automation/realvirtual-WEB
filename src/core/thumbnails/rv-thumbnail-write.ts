// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-thumbnail-write — the ONE writer of a document's thumbnail (plan-776).
 *
 * A thumbnail is rendered when a document is SAVED and at no other time: the
 * editor save, the planner's save (first save, save as, in place, settings
 * into a model) and an MCP replace of the loaded document all end in
 * `finishDocumentSave` (`core/editor/rv-finish-document-save.ts`, plan-777),
 * which calls {@link writeDocumentThumbnail}. There is one kind of document (plan-716), so
 * there is one source and one render path: the viewer's document content
 * (`thumbnail-content.ts` — authored content and materialised placements),
 * cloned into the renderer's studio scene. It renders a 512×512 image, writes
 * it as the sidecar `.thumbnails/<encodeThumbnailId(id)>.<hash8>.<webp|png>`
 * and points the document's row at it. The dashboard and the library only read
 * that pointer — nothing ever loads a GLB to draw a card.
 *
 * Loaded on demand (`await import(...)`, plan-776 P10) by the one post-save
 * step `rv-finish-document-save.ts` (plan-777 P4) and by the explicit
 * "Regenerate thumbnails" loop, so the renderer and its post-processing stay
 * out of the startup chunk. Those two plus this file are the only importers of
 * the renderer (guard 2).
 *
 * ## The save sequence (F3)
 *
 *  0. no writable backend, or no manifest row for the document (a Custom
 *     library save, a read-only deploy) → nothing happens, silently;
 *  1. the GLB is written by the caller — the only step that can fail a save;
 *  2. wait (bounded) until the scene is complete, render + validity check +
 *     encode, write the sidecar;
 *  3. `await store.setDocumentThumbnail(id, pointer)` — before the post-save
 *     step announces and rescans, so the adopt never sees a row without it;
 *  4. id-bound cleanup: the row's previous pointer (read NOW, not at save
 *     start), the caller's `previous` and the legacy `<id>.png`.
 *
 * Any failure in 2–4 is a `console.warn`, the pointer REMOVED and the old
 * sidecar deleted — a placeholder, never a stale picture (#10). The save itself
 * still reports success.
 */

import type { Object3D, Scene } from 'three';
import type { ProjectBackend } from '../project/backends/project-backend';
import type { RvDocumentEntry, RvProject } from '../project/rv-project-types';
import { documentsOf } from '../project/rv-project-documents';
import { thumbnailSidecarPath } from '../library/library-types';
import { cleanupThumbnailSidecars } from '../library/resolve-document-thumbnail';
import { ThumbnailRenderer } from './thumbnail-renderer';
import { documentContentRoots } from './thumbnail-content';
import { encodeThumbnail, type ThumbnailImage } from './rv-thumbnail-encode';

export type { ThumbnailImage } from './rv-thumbnail-encode';
export { isThumbnailExcludedNode, documentContentRoots } from './thumbnail-content';

/** Edge length of a saved thumbnail, px (rendered at 2× and downscaled once). */
export const THUMBNAIL_SIZE = 512;

/**
 * How long a save waits for the scene to be complete (placements still
 * materialising) before it renders what is there. Bounded, because the
 * thumbnail runs inside the save and must never hold it up indefinitely.
 */
export const SCENE_READY_WAIT_MS = 5000;

/** The part of `RVViewer` the render needs. Structural, so tests need no viewer. */
export interface ThumbnailViewer {
  renderer: unknown;
  scene: Scene;
  /** The open document's root — in the editor the asset root, in the planner the layout document. */
  currentModelRoot?: Object3D | null;
  /** The scene-complete join (no load in flight, every placement materialised). */
  whenSceneReady?(): Promise<void>;
}

/** The part of `ProjectStore` the write needs. */
export interface ThumbnailRowStore {
  getProject(): RvProject | null;
  setDocumentThumbnail(documentId: string, pointer: string | null): Promise<void>;
  /** Asked once when the row is not in the manifest yet (a copy the adopt has not reached). */
  rescanDocuments?(): Promise<void>;
}

export interface WriteDocumentThumbnailContext {
  viewer: ThumbnailViewer;
  store: ThumbnailRowStore;
  backend: ProjectBackend | null | undefined;
  /** The document's id — the sidecar is keyed by it. */
  documentId?: string | null;
  /** The document's path — the fallback row lookup when the id is not known (yet). */
  relPath?: string | null;
  /** The pointer the save started from; deleted unless it is the new one. */
  previous?: string | null;
}

// ─── Render ─────────────────────────────────────────────────────────────

/** True when the WebGL context is gone — a render would read back nothing. */
function isContextLost(renderer: unknown): boolean {
  const gl = (renderer as { getContext?: () => { isContextLost?: () => boolean } | null })
    .getContext?.();
  return typeof gl?.isContextLost === 'function' && gl.isContextLost() === true;
}

/** True when at least one pixel of `canvas` is not fully transparent. */
function hasVisiblePixels(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
  return false;
}

/** Wait for the scene-complete join, at most {@link SCENE_READY_WAIT_MS}. Never throws. */
async function waitForCompleteScene(viewer: ThumbnailViewer): Promise<void> {
  if (typeof viewer.whenSceneReady !== 'function') return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      viewer.whenSceneReady().catch(() => {}),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, SCENE_READY_WAIT_MS); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Render and encode the thumbnail of the viewer's open document, or null when
 * the result would not be a picture of the document (#10): no content, empty
 * or non-finite bounds, a lost WebGL context, or an image without a single
 * visible pixel.
 *
 * A `ThumbnailRenderer` is built for this call and disposed afterwards (the
 * canvas is encoded before the dispose) — it reuses the viewer's renderer, no
 * second GL context. Throws only on a genuine error; the caller turns that
 * into "no thumbnail" too.
 */
export async function renderThumbnailImage(viewer: ThumbnailViewer): Promise<ThumbnailImage | null> {
  if (!viewer?.renderer || !viewer.scene || isContextLost(viewer.renderer)) return null;
  await waitForCompleteScene(viewer);
  if (isContextLost(viewer.renderer)) return null;
  const roots = documentContentRoots(viewer);
  if (roots.length === 0) return null;
  const renderer = new ThumbnailRenderer(viewer.renderer as never, viewer.scene);
  try {
    const canvas = await renderer.render(roots, THUMBNAIL_SIZE);
    if (!canvas || isContextLost(viewer.renderer) || !hasVisiblePixels(canvas)) return null;
    return await encodeThumbnail(canvas);
  } finally {
    renderer.dispose();
  }
}

// ─── Write ──────────────────────────────────────────────────────────────

function normalisePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

/** The manifest row of the document — by id first, by path second. */
function rowOf(
  store: ThumbnailRowStore,
  documentId: string | null | undefined,
  relPath: string | null | undefined,
): RvDocumentEntry | null {
  const rows = documentsOf(store.getProject());
  const id = typeof documentId === 'string' ? documentId.trim() : '';
  if (id) {
    const byId = rows.find((d) => d.id === id);
    if (byId) return byId;
  }
  const path = typeof relPath === 'string' ? normalisePath(relPath) : '';
  if (path) return rows.find((d) => typeof d.path === 'string' && normalisePath(d.path) === path) ?? null;
  return null;
}

/**
 * Render, write and point at the thumbnail of one saved document (F3 steps
 * 2–4). Never throws.
 *
 * @returns the new pointer, or null when no thumbnail was written (skipped, or
 *   failed — then the row's `thumbnail` is gone).
 */
export async function writeDocumentThumbnail(ctx: WriteDocumentThumbnailContext): Promise<string | null> {
  const { store, backend } = ctx;
  if (!backend?.writable || !store) return null;
  if (!ctx.viewer?.renderer || !ctx.viewer.scene || isContextLost(ctx.viewer.renderer)) {
    // Nothing can render here (no renderer, a lost context): the picture the
    // row may still point at no longer describes the file — take it away,
    // quietly, and write nothing else (a row without one stays untouched).
    const row = rowOf(store, ctx.documentId, ctx.relPath);
    if (row) await dropDocumentThumbnail({ store, backend, documentId: row.id });
    return null;
  }
  let row = rowOf(store, ctx.documentId, ctx.relPath);
  if (!row && typeof store.rescanDocuments === 'function') {
    await store.rescanDocuments().catch(() => {});
    row = rowOf(store, ctx.documentId, ctx.relPath);
  }
  if (!row || typeof row.id !== 'string' || row.id === '') return null;
  const id = row.id;

  let written: string | null = null;
  try {
    const image = await renderThumbnailImage(ctx.viewer);
    if (!image) throw new Error('nothing renderable (empty scene, lost context or blank image)');
    const pointer = thumbnailSidecarPath(id, image.hash8, image.ext);
    await backend.writeDocument(pointer, image.bytes, { expectedRevision: 'any' });
    written = pointer;
    // Read the row's pointer NOW — a save that started minutes ago must not
    // delete the picture another write has put there since.
    const before = rowOf(store, id, null)?.thumbnail;
    await store.setDocumentThumbnail(id, pointer);
    await cleanupThumbnailSidecars(backend, id, [before, ctx.previous], pointer);
    return pointer;
  } catch (e) {
    console.warn('[thumbnail] the thumbnail could not be written (the document saved fine):', e);
    const before = rowOf(store, id, null)?.thumbnail;
    if (before !== undefined) {
      try { await store.setDocumentThumbnail(id, null); } catch { /* the next save tries again */ }
    }
    await cleanupThumbnailSidecars(backend, id, [before, ctx.previous, written], null);
    return null;
  }
}

/**
 * Forget a document's thumbnail: pointer removed, sidecar deleted (F6 — an MCP
 * replace of a document that is not loaded, so nothing can render it). Never
 * throws.
 */
export async function dropDocumentThumbnail(ctx: {
  store: ThumbnailRowStore;
  backend: ProjectBackend | null | undefined;
  documentId: string;
}): Promise<void> {
  const row = rowOf(ctx.store, ctx.documentId, null);
  if (!row) return;
  const before = row.thumbnail;
  // A row without a pointer has nothing of ours to forget — no write, no delete.
  if (before === undefined) return;
  try { await ctx.store.setDocumentThumbnail(row.id, null); } catch { /* best effort */ }
  await cleanupThumbnailSidecars(ctx.backend, row.id, [before], null);
}
