// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * save-flow — the shared Save orchestration (card Save button + exit guard).
 *
 * Prompts for a name when needed, writes GLB + thumbnail into
 * `<workfolder>/library/Custom/`, refreshes the planner's local catalog so the
 * asset appears immediately, and falls back to a .glb download when the File
 * System Access API / work folder is unavailable. Returns `true` when the
 * document ended up clean (saved or downloaded), `false` on cancel/failure.
 */

import type { ActiveAssetContext } from './active-asset-store';
import {
  saveAssetToCustomLibrary,
  downloadAssetGlb,
} from '../../core/editor/rv-asset-library-save';
import { askAssetName, askSaveFallback } from './editor-dialog-store';
import type { LibraryCatalogEntry } from '../layout-planner/rv-layout-store';

/** Structural slice of the LayoutPlannerPlugin we consult (no hard import). */
interface PlannerCachesLike {
  store?: {
    getSnapshot?: () => { catalogs?: Map<string, { entries?: LibraryCatalogEntry[] }> };
  };
  modelCache?: { invalidate?: (url: string) => void };
}

/**
 * Synchronously look up the planner catalog URL of the saved asset (by its
 * library-relative path) and drop the planner's decoded model for it. Must
 * run BEFORE `refreshLocalFolder()` re-mints the local blob URLs —
 * afterwards the stale entry's URL is unreachable. Best-effort: silently
 * no-ops when the planner/plugin/store is absent.
 */
function invalidatePlannerModelForSavedAsset(
  planner: PlannerCachesLike | undefined,
  relPath: string,
): void {
  try {
    const catalogs = planner?.store?.getSnapshot?.()?.catalogs;
    if (!catalogs) return;
    const wanted = relPath.toLowerCase();
    for (const catalog of catalogs.values()) {
      for (const entry of catalog.entries ?? []) {
        if ((entry.localPath ?? '').toLowerCase() !== wanted) continue;
        if (entry.glbUrl) planner?.modelCache?.invalidate?.(entry.glbUrl);
        return;
      }
    }
  } catch {
    /* best-effort — never disturb the save flow */
  }
}

/** Structural slice of the LayoutPlannerPlugin we refresh (no hard import). */
interface PlannerLike extends PlannerCachesLike {
  store?: NonNullable<PlannerCachesLike['store']> & { refreshLocalFolder(): Promise<void> };
}

/** Outcome of the headless (dialog-free) save — see {@link saveAssetAs}. */
export type SaveAsResult =
  | { kind: 'saved'; fileName: string; relPath: string }
  | { kind: 'unsupported' | 'write-denied' }
  // Carries WHY there is no writable target (no project / bundled / read-only)
  // so the dialog can say something the user can act on (plan-372 section 2.9).
  | { kind: 'no-writable-project'; reason: string }
  | { kind: 'error'; message: string };

/**
 * Dialog-free core of the save flow: pre-export restore, GLB + thumbnail write
 * into `library/Custom/`, markSaved, planner catalog refresh. Shared by
 * {@link runSaveFlow} (which adds the name prompt + download fallback dialogs)
 * and the MCP `web_editor_save` tool (which reports failures as errors instead
 * of prompting).
 */
export async function saveAssetAs(ctx: ActiveAssetContext, name: string): Promise<SaveAsResult> {
  const { viewer, doc } = ctx;

  // Let live-preview holders (drive jog, …) restore their ephemeral state
  // BEFORE the scene is cloned for export — preview poses must not bake in.
  viewer.emit('asset-editor-pre-export', { source: 'save-flow' });

  const outcome = await saveAssetToCustomLibrary(viewer, doc, name);
  if (outcome.kind === 'saved') {
    // Awaited: the clean draft (re-opens the saved asset on reload) must be
    // persisted before anything — e.g. a dev-server reload — can interrupt.
    await doc.markSaved({ kind: 'libraryGlb', fileName: outcome.fileName, relPath: outcome.relPath }, name);

    const planner = viewer.getPlugin('layout-planner') as PlannerLike | undefined;

    // Plan-301 §2.8 item 3: drop the planner's decoded model for the saved
    // asset URL. Runs BEFORE refreshLocalFolder re-mints the local blob URLs
    // (afterwards the stale entry's URL is no longer discoverable).
    invalidatePlannerModelForSavedAsset(planner, outcome.relPath);

    // Refresh the planner's local catalog so the asset shows up immediately.
    // Structural access — the planner plugin may be disabled in editor mode,
    // but its store refresh is mode-independent. Best-effort.
    try {
      await planner?.store?.refreshLocalFolder();
    } catch (e) {
      console.warn('[asset-editor] library refresh after save failed:', e);
    }
  }
  return outcome;
}

export async function runSaveFlow(
  ctx: ActiveAssetContext,
  opts?: { forceNamePrompt?: boolean },
): Promise<boolean> {
  const { viewer, doc } = ctx;

  let name = doc.name;
  if (opts?.forceNamePrompt || !name || name === 'Untitled') {
    const picked = await askAssetName(name === 'Untitled' ? '' : name);
    if (picked === null || !picked.trim()) return false;
    name = picked.trim();
  }

  const outcome = await saveAssetAs(ctx, name);
  if (outcome.kind === 'saved') return true;

  // Saving into the library is unavailable — offer the .glb download fallback.
  const choice = await askSaveFallback(
    outcome.kind === 'error' ? 'error' : outcome.kind,
    outcome.kind === 'error' ? outcome.message : undefined,
  );
  if (choice !== 'download') return false;
  const ok = await downloadAssetGlb(viewer, doc, name);
  if (ok) {
    // The user holds the file — treat the document as clean (draft cleared).
    await doc.markSaved(doc.base, name);
  }
  return ok;
}
