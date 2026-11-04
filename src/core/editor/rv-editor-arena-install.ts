// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Editor arena install — the one place that switches the editor's batched
 * display on and off (plan-766 Phase 2 Schritt 5).
 *
 * The asset-editor plugin calls {@link installEditorArena} from its
 * `_installAuthoringTools` (every load path, F5 restore included) and
 * `dispose()` from `_uninstallAuthoringTools` (document swap, F5 scene swap,
 * mode exit). Kept in CORE so the lifecycle is testable without the private
 * plugin and so every install wires the same four things in the same order:
 *
 *  1. `EditorArenaManager.build(viewer.currentModelRoot)` — arenas in
 *     `viewer.scene`, sources `layers.mask = 0`;
 *  2. `viewer.editorArena = manager` — the pre-frame seam, the model-clear
 *     dispose and every `bumpVisibility()` writer find it there;
 *  3. `EditorArenaOps.attach(executor)` — the op listener on the document's
 *     CURRENT executor (a re-bound document has a fresh one, so this runs on
 *     every install), including the replay brackets that hold the listener
 *     off during draft replay / recompose and build once at the end;
 *  4. the isolate latches of the group and auto-filter registries re-taken —
 *     an isolate that was already on when the arenas were built must hold a
 *     capture on THEM (decision "Latch nach Install nachziehen").
 *
 * {@link EditorArenaInstall.rebuild} re-runs 1, 2 and 4 on the same manager
 * after a reload the plugin did not route through an install (the bound
 * document's undo-by-recompose reloads the tree in place; the model clear
 * disposed the manager on the way).
 */

import type { Object3D } from 'three';
import { EditorArenaManager } from './rv-editor-arena';
import { EditorArenaOps } from './rv-editor-arena-ops';
import type { ArenaOpSource } from './rv-editor-arena-ops';

/** The slice of `RVViewer` the install needs (tests pass a plain object). */
export interface EditorArenaHost {
  readonly scene: Object3D;
  readonly currentModelRoot: Object3D | null;
  readonly isWebGPU?: boolean;
  editorArena: EditorArenaManager | null;
  readonly registry?: { getNode(path: string): Object3D | null } | null;
  readonly groups?: { resyncArenaCapture?(): void } | null;
  readonly autoFilters?: { resyncArenaCapture?(): void } | null;
  markRenderDirty?(): void;
  markShadowsDirty?(): void;
}

export interface EditorArenaInstall {
  readonly manager: EditorArenaManager;
  readonly ops: EditorArenaOps;
  /** Wall time of the last build in ms (`performance.now()` span). */
  readonly lastBuildMs: number;
  /** Build again on the viewer's current root (same manager, same listener). */
  rebuild(): void;
  /** Listener off, arenas gone, sources back on their layers, slot cleared. Idempotent. */
  dispose(): void;
}

export interface InstallEditorArenaOptions {
  /** Manager overrides (tests). */
  perObjectCulling?: boolean;
}

/**
 * Build the editor arenas for the viewer's current model and attach the op
 * listener to `source`. Returns `null` when there is no model root (nothing
 * is installed then). Any arena manager still in the viewer's slot is
 * disposed first — two managers on one scene would fight over the sources.
 */
export function installEditorArena(
  viewer: EditorArenaHost,
  source: ArenaOpSource,
  opts: InstallEditorArenaOptions = {},
): EditorArenaInstall | null {
  const root = viewer.currentModelRoot;
  if (!root) return null;
  if (viewer.editorArena) {
    viewer.editorArena.dispose();
    viewer.editorArena = null;
  }
  const manager = new EditorArenaManager({
    scene: viewer.scene,
    isWebGPU: viewer.isWebGPU ?? false,
    perObjectCulling: opts.perObjectCulling,
    onChanged: () => {
      viewer.markRenderDirty?.();
      viewer.markShadowsDirty?.();
    },
  });
  const ops = new EditorArenaOps(manager, {
    resolveNode: (p) => viewer.registry?.getNode(p) ?? null,
  });

  let lastBuildMs = 0;
  let disposed = false;
  const build = (): void => {
    const current = viewer.currentModelRoot;
    if (!current) return;
    if (viewer.editorArena && viewer.editorArena !== manager) viewer.editorArena.dispose();
    const t0 = performance.now();
    manager.build(current);
    lastBuildMs = performance.now() - t0;
    viewer.editorArena = manager;
    viewer.groups?.resyncArenaCapture?.();
    viewer.autoFilters?.resyncArenaCapture?.();
  };

  build();
  ops.attach(source);

  return {
    manager,
    ops,
    get lastBuildMs() { return lastBuildMs; },
    rebuild: () => { if (!disposed) build(); },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      ops.dispose();
      manager.dispose();
      if (viewer.editorArena === manager) viewer.editorArena = null;
      viewer.markRenderDirty?.();
      viewer.markShadowsDirty?.();
    },
  };
}
