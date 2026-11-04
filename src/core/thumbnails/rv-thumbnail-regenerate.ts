// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-thumbnail-regenerate — the loop behind "Regenerate thumbnails"
 * (plan-776 #20; the command is `rv-thumbnail-regenerate-commands.ts`).
 *
 * ## Exactly the save path, one document after another
 *
 * Every document of the project is OPENED in the viewer through the one open
 * funnel (`SceneStore.openDocument`, as a background open that leaves no
 * recents / URL / resume trace), the run waits until the scene is complete —
 * every placed reference materialised — and then calls the ONE writer
 * (`writeDocumentThumbnail`): the same capture, the same studio render, the
 * same validity check, the same hashed sidecar, id-bound cleanup and
 * `setDocumentThumbnail` a save uses. There is no second render variant.
 *
 * ## Why not offscreen
 *
 * Loading each document into a private, never-displayed graph would leave the
 * live view untouched — but a document's placed references are materialised
 * by the VIEWER's `PlacementInstancer` (`viewer.placements`), which registers
 * the nested content in the viewer's `NodeRegistry` and joins the viewer's
 * scene-ready gate. A `ModelCache` bake alone gives the outer document without
 * its nested placements, i.e. exactly the picture plan-776's 2026-11-02 fix
 * removed. So the run uses the live viewer, sequentially, and puts back what
 * was open before (document, or bundled model / empty workspace, and the
 * mode) at the end. The command refuses while there is unsaved work, so
 * nothing on screen can be lost by the swap.
 *
 * ## Failures and Cancel
 *
 * A document that cannot be opened, that comes back with unsaved changes (a
 * recovered autosave draft — its picture would not show the file) or for
 * which the writer writes nothing is a failure, named in the result; the run
 * goes on. Cancel is checked between documents: the current one finishes,
 * every thumbnail written so far stays.
 */

import type { RvDocumentEntry } from '../project/rv-project-types';
import { documentsOf } from '../project/rv-project-documents';
import { getProjectStore } from '../project/project-store';
import { getSceneStore } from '../hmi/scene/scene-store-singleton';
import { handoffParkMode } from '../project/rv-document-mode';
import { writeDocumentThumbnail, type ThumbnailViewer } from './rv-thumbnail-write';
import {
  recordRegenerateResult,
  setRegenerateCurrent,
  setRegenerateTotal,
  type RegenerateFailure,
} from './rv-thumbnail-regenerate-progress';
import type { WorkspaceBookmark } from './rv-thumbnail-regenerate-commands';

/** How long one document may take to become complete before it is rendered as it is. */
export const DOCUMENT_READY_WAIT_MS = 120_000;

export const UNSAVED_DRAFT_REASON =
  'Opens with unsaved changes from an autosave — open it and save it to render its thumbnail.';
export const NOT_WRITTEN_REASON =
  'Nothing could be rendered (empty document, lost graphics context or blank picture).';

/** What the loop needs of the world. Injected so the loop runs without a viewer in tests. */
export interface RegenerateDeps {
  /** The project's documents — read after the project is open. */
  documents(): readonly RvDocumentEntry[];
  /** Once, before the first document (the real one leaves the editor: its binding would follow the loads). */
  prepare?(): Promise<void>;
  /** Load the document the way a save sees it: placements materialised, the scene complete. */
  open(doc: RvDocumentEntry): Promise<void>;
  /** True when what is on screen now is not the file (a recovered draft). */
  showsUnsavedChanges?(): boolean;
  /** The ONE writer. Answers the new pointer, or null when nothing was written. */
  write(doc: RvDocumentEntry): Promise<string | null>;
  /** Once, at the end — also after a Cancel or a throw. */
  restore?(): Promise<void>;
}

export interface RegenerateResult {
  projectId: string;
  /** Documents in the project. */
  total: number;
  /** Documents the run got to (less than `total` after a Cancel). */
  processed: number;
  written: number;
  failed: RegenerateFailure[];
  cancelled: boolean;
}

function displayName(doc: RvDocumentEntry): string {
  return doc.name || doc.path || doc.id;
}

/**
 * Render every document's thumbnail through `deps`, reporting into the
 * progress store. Never throws for one document; `restore` runs in any case.
 */
export async function regenerateProjectThumbnails(
  deps: RegenerateDeps,
  opts: { projectId: string; projectName?: string | null; signal?: AbortSignal },
): Promise<RegenerateResult> {
  const docs = [...deps.documents()];
  setRegenerateTotal(docs.length, opts.projectName);
  const failed: RegenerateFailure[] = [];
  let processed = 0;
  let written = 0;
  let cancelled = false;
  try {
    if (docs.length > 0) await deps.prepare?.();
    for (const doc of docs) {
      // Between documents only: the current one always finishes.
      if (opts.signal?.aborted) { cancelled = true; break; }
      const name = displayName(doc);
      setRegenerateCurrent(name);
      let failure: RegenerateFailure | null = null;
      try {
        await deps.open(doc);
        if (deps.showsUnsavedChanges?.()) {
          failure = { documentId: doc.id, name, reason: UNSAVED_DRAFT_REASON };
        } else if (!(await deps.write(doc))) {
          failure = { documentId: doc.id, name, reason: NOT_WRITTEN_REASON };
        }
      } catch (e) {
        failure = { documentId: doc.id, name, reason: e instanceof Error ? e.message : String(e) };
      }
      processed++;
      if (failure) failed.push(failure);
      else written++;
      recordRegenerateResult(failure);
    }
  } finally {
    setRegenerateCurrent(null);
    try { await deps.restore?.(); } catch (e) {
      console.warn('[thumbnail] could not re-open the previous document after regenerating:', e);
    }
  }
  return { projectId: opts.projectId, total: docs.length, processed, written, failed, cancelled };
}

// ─── The real dependencies ──────────────────────────────────────────────

/** The part of `RVViewer` the run touches. */
export interface RegenerateViewer extends ThumbnailViewer {
  modes?: {
    activeMode: string | null;
    list(): readonly { id: string }[];
    available?(): readonly { id: string }[];
    setMode(id: string): void;
    switchMode?(id: string): boolean | Promise<boolean>;
    requestMode(id: string): unknown;
  };
}

/** Wait for the scene-complete join, at most `ms`. Never throws. */
async function sceneReady(viewer: RegenerateViewer, ms: number): Promise<void> {
  if (typeof viewer.whenSceneReady !== 'function') return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      viewer.whenSceneReady().catch(() => {}),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function switchModeAwaited(modes: NonNullable<RegenerateViewer['modes']>, id: string): Promise<void> {
  if (modes.activeMode === id) return;
  if (typeof modes.switchMode === 'function') {
    const r = modes.switchMode(id);
    if (typeof r !== 'boolean') await r;
    return;
  }
  modes.setMode(id);
}

/**
 * The live-viewer dependencies: background opens through the scene store, the
 * one writer, and the re-open of `bookmark` at the end.
 */
export function viewerRegenerateDeps(viewer: RegenerateViewer, bookmark: WorkspaceBookmark): RegenerateDeps {
  const scene = getSceneStore();
  const projects = getProjectStore();
  if (!scene) throw new Error('The scene store is not available.');
  const modes = viewer.modes;
  return {
    documents: () => documentsOf(projects.getProject()),

    prepare: async () => {
      // The editor resolves what it shows on activation and follows its bound
      // document; loading other documents under it would rebind it. Park in the
      // first non-editor mode, exactly like the dashboard's editor handoff.
      if (modes?.activeMode === 'editor') await switchModeAwaited(modes, handoffParkMode(modes));
    },

    open: async (doc) => {
      await scene.openDocument(doc.id, { background: true });
      await sceneReady(viewer, DOCUMENT_READY_WAIT_MS);
    },

    showsUnsavedChanges: () => scene.getSnapshot().dirty === true,

    write: (doc) => writeDocumentThumbnail({
      viewer,
      store: projects,
      backend: projects.getBackend(),
      documentId: doc.id,
      previous: typeof doc.thumbnail === 'string' ? doc.thumbnail : null,
    }),

    restore: async () => {
      const sameProject = bookmark.projectId !== null && projects.getProject()?.id === bookmark.projectId;
      let reopened = false;
      if (sameProject && bookmark.documentId
          && documentsOf(projects.getProject()).some(d => d.id === bookmark.documentId)) {
        await scene.openDocument(bookmark.documentId, { background: true });
        reopened = true;
      } else if (sameProject && bookmark.base?.kind === 'builtin') {
        await scene.openBuiltin(bookmark.base.url, bookmark.base.label, { updateUrl: false });
        reopened = true;
      } else if (sameProject && bookmark.base?.kind === 'empty') {
        await scene.openEmpty();
        reopened = true;
      }
      if (!modes || !bookmark.mode || modes.activeMode === bookmark.mode) return;
      // Back into the editor only with its document on screen again: the
      // activation binds the living document the open just published.
      if (bookmark.mode === 'editor') {
        if (reopened && bookmark.documentId) await modes.requestMode('editor');
        return;
      }
      await switchModeAwaited(modes, bookmark.mode);
    },
  };
}
