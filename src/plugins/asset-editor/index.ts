// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * AssetEditorPlugin — the public editor-mode shell (GLB asset authoring).
 *
 * The `editor` workspace mode is always the context of ONE GLB asset document:
 * entering the mode opens an empty "Untitled" asset (or a pending "Edit asset"
 * request from the library, or a crash-recovery draft), edits are op-logged in
 * the AssetDocument (undo/redo + IndexedDB draft autosave), and Save writes a
 * GLB into `<workfolder>/library/Custom/`. Leaving the mode with unsaved
 * changes runs a Save / Discard / Cancel exit guard; the previous scene is
 * restored on exit. The SimulationRuntime is fully detached in this mode
 * (`runtime: 'detached'` on the mode registration) — no time integration.
 *
 * CAD (STEP) import stays in the PRIVATE step-import plugin, which feeds
 * imported trees into `importCad()` and registers the CadGeometryProvider.
 */

import type { Mesh, Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import type { RVViewerPlugin } from '../../core/rv-plugin';
import type { ModeId } from '../../core/rv-mode-manager';
// Reuse the planner's now-mode-agnostic marquee controller. It is pure DOM +
// event plumbing (selectable roots + registry + colors come in via deps), so a
// static import couples nothing beyond the class — the planner plugin does not
// need to be registered for the editor to construct its own instance.
import {
  BoxSelectController,
  type MarqueeColors,
} from '../layout-planner/box-select-controller';
import type { UISlotEntry } from '../../core/rv-ui-plugin';
import { AssetDocument, type AssetBase } from '../../core/editor/rv-asset-document';
import { loadAssetDraft, clearAssetDraft } from '../../core/editor/rv-asset-draft-storage';
import type { CadImportResult } from '../../core/editor/rv-cad-provider';
import type { ImportResultItem } from '../../core/import/rv-import-provider';
import { importIntoAsset } from '../../core/import/rv-import-asset';
import { setActiveEditTarget, getActiveEditTarget, type EditTarget } from '../../core/hmi/rv-edit-target';
import { registerHierarchyHeader } from '../../core/hmi/hierarchy-header-registry';
import { componentActionRegistry } from '../../core/hmi/rv-component-action-registry';
import { getLibrarySource } from '../../core/library/library-source-registry';
import { getTypesWithCapability } from '../../core/engine/rv-component-registry';
import { hasCadProvider } from '../../core/editor/rv-cad-provider';
import { runReimportFlow } from './reimport-flow';
import { Delete as DeleteIcon, UploadFile as UploadFileIcon } from '@mui/icons-material';
// Side effect: register the CADLink component schema (read-only metadata on
// imported CAD roots — see rv-cadlink.ts).
import '../../core/editor/rv-cadlink';
// Side effect: register the JTData component schema (read-only CAD metadata the
// JT reader writes per node — see rv-jt-data.ts).
import '../../core/editor/rv-jt-data';
import { getEmptyGlbUrl } from '../../core/hmi/scene/empty-glb';
import { getStoredKinematicsPanelWidth } from '../../core/hmi/layout-constants';
import { getSceneStore } from '../../core/hmi/scene/scene-store-singleton';
import type { SceneBase } from '../../core/hmi/scene/rv-scene-types';
import { getWorkFolder, getSubfolder, readFileAsUrl } from '../../core/engine/rv-local-filesystem';
import { AssetActiveCard } from './AssetActiveCard';
import { AssetEditorDialogs } from './AssetEditorDialogs';
import { EditorDeleteButton, EditorKinematicsButton, EditorMaterialsButton, EditorPivotModeButton, EditorRedoButton, EditorUndoButton } from './EditorToolbarButtons';
import { KinematicsPanel } from './kinematics/KinematicsPanel';
import { MaterialsPanel } from './materials/MaterialsPanel';
import { EditorTransformTool } from './EditorTransformTool';
import { deleteSelectedNodes } from './delete-selection';
import { setActiveAssetContext, getActiveAssetContext } from './active-asset-store';
import {
  ungroupSelection,
  buildKinematicMenuItems,
  selectionHasAnyGroup,
  kinematicGroupNodesForSelection,
  autoAssignToKinematic,
} from './group-actions';
import { buildSelectMenuItems } from './select-actions';
import {
  buildSeparateMenuItems,
  disposeSeparatorClient,
  isSeparableTarget,
} from './mesh-separator-actions';
import {
  buildMergeMenuItem,
  disposeMergeClient,
} from './mesh-merge-actions';
import { showKeyBadge } from '../../core/hmi/key-badge-store';
import { getAutoAssignTarget } from './kinematics/auto-assign-store';
import { cancelPivotPick } from './pivot-pick';
import { setDriveGizmoFallbackResolver } from '../../core/engine/drive-gizmo-source';
import { resolveEditorDriveGizmoSource } from './editor-drive-gizmo-source';
import { setDriveDragDriver } from '../../core/engine/drive-drag-driver';
import { DriveDragPreview } from './drive-drag-preview';
import type { DriveAxisGizmoPlugin } from '../drive-axis-gizmo-plugin';
import { EDITOR_KINEMATIC_SELECTION_STYLE } from '../../core/engine/rv-highlight-profiles';
import type { SelectionSnapshot } from '../../core/engine/rv-selection-manager';
import { takePendingAssetOpen } from './pending-open-store';
import { askUnsavedChoice, showCadMissing, showMergeUnapplied } from './editor-dialog-store';
import { runSaveFlow } from './save-flow';

/** What to restore when leaving the editor. */
interface RestoreInfo {
  savedSceneId: string | null;
  base: SceneBase | null;
}

// ─── Editor-mode selection colors (YELLOW) ──────────────────────────────
// The editor's yellow hover/selection styles (overlay fallback + OutlinePass)
// now live in the 'editor' HighlightProfile (core/engine/rv-highlight-profiles.ts),
// applied by RVHighlightPolicy on mode-changed — the plugin installs nothing.

/** Yellow rubber-band marquee to match the editor selection color. */
const EDITOR_MARQUEE_COLORS: MarqueeColors = {
  border: 'rgba(255, 196, 0, 0.95)',
  fill: 'rgba(255, 196, 0, 0.14)',
};

/** Pink marquee while Auto Assign is armed — the drag collects parts into a
 *  kinematic's group rather than selecting them, so it must not read as a
 *  normal (yellow) selection. Matches KINEMATIC_ACCENT `#ce93d8`. */
const AUTO_ASSIGN_MARQUEE_COLORS: MarqueeColors = {
  border: 'rgba(206, 147, 216, 0.95)',
  fill: 'rgba(206, 147, 216, 0.14)',
};

/** True when `obj` and every ancestor up to (and including) `root` is visible. */
function isEffectivelyVisible(obj: Object3D, root: Object3D): boolean {
  let n: Object3D | null = obj;
  while (n) {
    if (!n.visible) return false;
    if (n === root) break;
    n = n.parent;
  }
  return true;
}

/** True when `obj` or any ancestor up to `root` carries the authored hidden
 *  flag (`rv.Hidden`). Same exclusion criterion as the raycast BVH — keeps the
 *  marquee in agreement with hover/click picking. Keyed on the extras flag,
 *  not `.visible`, because the static merge uses `.visible` for its own
 *  bookkeeping. */
function hasAuthoredHiddenAncestor(obj: Object3D, root: Object3D): boolean {
  let n: Object3D | null = obj;
  while (n) {
    const rv = (n.userData as Record<string, unknown> | undefined)?.['realvirtual'] as
      Record<string, unknown> | undefined;
    if (rv?.['Hidden'] === true) return true;
    if (n === root) break;
    n = n.parent;
  }
  return false;
}

/**
 * Selectable set for the editor marquee: every effectively-visible MESH in the
 * loaded asset, keyed by its OWN scene path. Unlike the planner (which selects
 * whole placed units), the editor marquee selects individual objects — it does
 * NOT walk up to the nearest rv-extras owner. Each entry is a leaf mesh, so the
 * box-select hit-test measures that mesh's own geometry bounds (a leaf has no
 * children for `Box3.setFromObject` to expand into). Rebuilt on every commit
 * (passed as `getObjectMap`) because `currentModelRoot` is replaced on each
 * asset load. Every node — including leaf meshes — is registered with a path by
 * the scene loader, so `getPathForNode` resolves each mesh directly.
 */
export function buildEditorSelectableMap(viewer: RVViewer): Map<string, Object3D> {
  const map = new Map<string, Object3D>();
  const root = viewer.currentModelRoot;
  const registry = viewer.registry;
  if (!root || !registry) return map;
  root.traverse((obj) => {
    if (!(obj as Mesh).isMesh) return;
    if (!isEffectivelyVisible(obj, root)) return;
    if (hasAuthoredHiddenAncestor(obj, root)) return;
    const path = registry.getPathForNode(obj);
    if (path) map.set(path, obj);
  });
  return map;
}

export class AssetEditorPlugin implements RVViewerPlugin {
  readonly id = 'asset-editor';
  readonly order = 260;
  readonly modes: ModeId[] = ['editor'];
  readonly slots: UISlotEntry[] = [
    { slot: 'overlay', component: AssetEditorDialogs },
    // Read-only "Runtime view" banner (plan-301 §2.9) — renders null unless
    // the preview is active.
    // Right-docked Kinematics window (the QuickEdit port) — renders null
    // while its LeftPanelManager slot is closed.
    { slot: 'overlay', component: KinematicsPanel, order: 110 },
    // Materials window — shares the right dock slot with Quick Edit above.
    { slot: 'overlay', component: MaterialsPanel, order: 120 },
    // Floating viewport toolbar (shared ButtonPanel). Orders mirror the
    // planner's grouping (undo 250, redo 260, delete 270); the UI registry
    // auto-gates these to mode:editor.
    // Gizmo anchor toggle (Pivot/Center) sits above the history group —
    // it configures the transform tool the buttons below act around.
    { slot: 'button-group', component: EditorPivotModeButton, order: 240 },
    { slot: 'button-group', component: EditorUndoButton, order: 250 },
    { slot: 'button-group', component: EditorRedoButton, order: 260 },
    { slot: 'button-group', component: EditorDeleteButton, order: 270 },
    { slot: 'button-group', component: EditorKinematicsButton, order: 280 },
    { slot: 'button-group', component: EditorMaterialsButton, order: 290 },
  ];

  private viewer!: RVViewer;
  private doc: AssetDocument | null = null;
  private transformTool: EditorTransformTool | null = null;
  private driveDragPreview: DriveDragPreview | null = null;
  private boxSelect: BoxSelectController | null = null;
  private restore: RestoreInfo | null = null;
  private unregisterHeader: (() => void) | null = null;
  private unregisterGuard: (() => void) | null = null;
  private unsubSelection: (() => void) | null = null;

  /** Selecting a kinematic axis overlay-highlights its group's members —
   *  same per-mesh overlay visual as hovering the group in the Kinematics
   *  window's Groups list, but persistent (selection channel). Runs AFTER
   *  the SelectionManager applied its own highlight (it emits post-apply),
   *  so re-highlighting with the union simply replaces it. Non-kinematic
   *  selections leave the manager's default highlight untouched. */
  private readonly onSelectionChangedGroupPreview = (snapshot: SelectionSnapshot): void => {
    const viewer = this.viewer;
    const groupNodes = kinematicGroupNodesForSelection(viewer, snapshot.selectedPaths);
    if (groupNodes.length === 0) return;
    const selNodes = snapshot.selectedPaths
      .map((p) => viewer.registry?.getNode(p))
      .filter((n): n is Object3D => !!n);
    viewer.highlighter.highlightSelection(
      [...new Set([...selNodes, ...groupNodes])],
      { visual: 'overlay', style: EDITOR_KINEMATIC_SELECTION_STYLE },
    );
  };
  private readonly onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (this.doc?.dirty) e.preventDefault();
  };
  private readonly onKeyDown = (e: KeyboardEvent) => this._handleEditorKeys(e);

  /** Last pointer position on the canvas — anchor for keyboard-opened menus (G). */
  private lastPointerPos: { x: number; y: number } | null = null;
  private readonly onCanvasPointerMove = (e: PointerEvent) => {
    this.lastPointerPos = { x: e.clientX, y: e.clientY };
  };

  /**
   * Start a marquee when a left mouse-button press lands on empty canvas.
   * Skips presses on the transform gizmo (let it drag) and presses on an
   * rv-node (let the normal pointerup single-select run). Mirrors the planner's
   * "empty-canvas drag → box select" gesture.
   */
  private readonly onCanvasPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || e.pointerType !== 'mouse') return;
    if (this.transformTool?.isEngaged) return;
    // A drive-gizmo drag claims the pointer at window-capture, but guard here too
    // so a handle grab never starts a marquee.
    if (this.viewer.getPlugin<DriveAxisGizmoPlugin>('drive-axis-gizmo')?.isEngaged) return;
    const hit = this.viewer.raycastManager?.raycastForRVNodeDetailed(e);
    if (hit?.path) return;
    this.boxSelect?.start(e);
  };

  init(viewer: RVViewer): void {
    this.viewer = viewer;
    this.unregisterHeader = registerHierarchyHeader('editor', AssetActiveCard);
    this.unregisterGuard = viewer.modes.registerExitGuard('editor', () => this._exitGuard());

    // "Remove" action on every authorable component section — visible only
    // while the asset editor's EditTarget is active. Registered per base type;
    // ctx.componentType carries the concrete `_N`-suffixed key.
    for (const type of getTypesWithCapability('authorable')) {
      componentActionRegistry.register(type, [{
        id: 'asset-editor-remove',
        label: 'Remove',
        icon: DeleteIcon,
        tooltip: 'Remove this component from the node',
        order: 900,
        visible: () => !!getActiveEditTarget().removeComponent,
        onClick: (ctx) => {
          getActiveEditTarget().removeComponent?.(ctx.nodePath, ctx.componentType);
        },
      }]);
    }

    // "Re-import CAD…" on the CADLink section: swap the subtree geometry from
    // a newer CAD revision, preserving components on matched nodes. Needs the
    // private CadGeometryProvider (OCCT) — hidden in the public build.
    componentActionRegistry.register('CADLink', [{
      id: 'asset-editor-reimport',
      label: 'Re-import…',
      icon: UploadFileIcon,
      tooltip: 'Swap geometry from a newer CAD file — components on matched nodes are preserved',
      order: 10,
      visible: () => !!getActiveEditTarget().addComponent && hasCadProvider(),
      onClick: (ctx) => {
        const quality = String(ctx.componentData['Quality'] ?? 'standard');
        void runReimportFlow(ctx.viewer, ctx.nodePath, quality);
      },
    }]);

    // Editor context-menu items — flat, Blender-style, first level next to
    // Focus. Group/Ungroup act on the current multi-selection. All gating
    // happens in the condition callbacks (evaluated at menu-open time); the
    // document is fetched at action time so the registration stays static.
    const selectedPaths = () => viewer.selectionManager.getSnapshot().selectedPaths;
    // Hide/Show acts on the whole selection when the clicked node is part of a
    // multi-selection, otherwise on just the clicked node.
    const visibilityTargets = (t: { path: string }): string[] => {
      const sel = selectedPaths();
      return sel.length > 1 && sel.includes(t.path) ? [...sel] : [t.path];
    };
    const isNodeVisible = (path: string) => viewer.registry?.getNode(path)?.visible ?? true;
    viewer.contextMenu.register({
      pluginId: 'asset-editor',
      items: [
        {
          // Select-similar submenu (Blender style). NOT gated on a non-empty
          // selection: Identical/Material seed from the clicked node, and
          // Invert with nothing selected doubles as Select All. The store's
          // auto-hide rule drops the parent when all children resolve empty.
          id: 'editor.select',
          label: 'Select',
          order: 1.5,
          shortcut: 'S',
          condition: () => viewer.modes.activeMode === 'editor' && !!viewer.currentModelRoot,
          children: (t) => buildSelectMenuItems(viewer, t, () => buildEditorSelectableMap(viewer)),
        },
        {
          id: 'editor.kinematic',
          label: 'Kinematic',
          order: 2,
          shortcut: 'K',
          condition: () => viewer.modes.activeMode === 'editor' && selectedPaths().length > 0,
          children: () => buildKinematicMenuItems(viewer),
        },
        {
          id: 'editor.ungroup',
          label: 'Ungroup',
          order: 3,
          condition: () =>
            viewer.modes.activeMode === 'editor'
            && selectionHasAnyGroup(viewer, [...selectedPaths()]),
          action: () => {
            const ctx = getActiveAssetContext();
            if (ctx) void ungroupSelection(viewer, ctx.doc, [...selectedPaths()]);
          },
        },
        {
          // Split ONE selected mesh into its connected islands or its material
          // groups. The submenu carries STATIC labels — the analysis is far too
          // expensive for a resolver that runs while the menu opens, so it runs
          // on click and reports into the confirmation dialog instead.
          id: 'editor.separate',
          label: 'Separate',
          order: 3.5,
          condition: (t) => {
            if (viewer.modes.activeMode !== 'editor') return false;
            const sel = selectedPaths();
            return sel.length === 1 && sel[0] === t.path && isSeparableTarget(t.node);
          },
          children: (t) => buildSeparateMenuItems(viewer, t),
        },
        // The inverse operation: collapse the clicked subtree into one mesh per material
        // and Group. Built by its own factory so the test suite exercises the REAL
        // condition — which reads the clicked target, never the selection (a right-click
        // on a hierarchy row does not select it).
        buildMergeMenuItem(viewer),
        {
          // Same visibility op the hierarchy eye-toggle uses (undoable, saved with the asset).
          id: 'editor.hide',
          label: 'Hide',
          order: 4,
          shortcut: 'H',
          dividerBefore: true,
          condition: (t) => viewer.modes.activeMode === 'editor'
            && !!getActiveEditTarget().setNodeVisible
            && visibilityTargets(t).some(isNodeVisible),
          action: (t) => {
            const et = getActiveEditTarget();
            for (const p of visibilityTargets(t)) if (isNodeVisible(p)) et.setNodeVisible?.(p, false);
          },
        },
        {
          id: 'editor.show',
          label: 'Show',
          order: 5,
          condition: (t) => viewer.modes.activeMode === 'editor'
            && !!getActiveEditTarget().setNodeVisible
            && visibilityTargets(t).some((p) => !isNodeVisible(p)),
          action: (t) => {
            const et = getActiveEditTarget();
            for (const p of visibilityTargets(t)) if (!isNodeVisible(p)) et.setNodeVisible?.(p, true);
          },
        },
      ],
    });
  }

  // ─── Mode lifecycle ───────────────────────────────────────────────────

  onModeActivate(_mode: ModeId, viewer: RVViewer): void {
    void this._activate(viewer);
  }

  /** Per-render: screen-constant gizmo sizing + pivot follow (undo/redo/inspector edits). */
  onRender(): void {
    this.transformTool?.update();
  }

  onModeDeactivate(_mode: ModeId | null, viewer: RVViewer): void {
    this._deactivate(viewer);
  }

  private async _activate(viewer: RVViewer): Promise<void> {
    // Remember what to restore on exit.
    const sceneSnap = getSceneStore()?.getSnapshot() ?? null;
    this.restore = {
      savedSceneId: sceneSnap?.saved?.id ?? null,
      base: sceneSnap?.draft?.base ?? null,
    };

    const pending = takePendingAssetOpen();
    const draft = pending ? null : await loadAssetDraft();

    let doc: AssetDocument;
    try {
      if (pending) {
        doc = new AssetDocument(viewer, {
          id: 'asset_' + Date.now().toString(36),
          name: baseDisplayName(pending),
          base: pending,
        });
        await this._loadBase(viewer, pending);
      } else if (draft) {
        // Crash-recovery / forced-exit draft: reopen its base and replay ops.
        // importCad ops re-materialise from the content-addressed GLB cache —
        // no re-tessellation, and no CAD provider needed (works in a public
        // build). Anything the cache can no longer produce is surfaced below
        // instead of vanishing into a console warning.
        doc = new AssetDocument(viewer, { ...draft.shell });
        await this._loadBase(viewer, draft.shell.base);
        await doc.replayOps(draft.ops);
        const missing = doc.executor.takeMissingCadGeometry();
        if (missing.length > 0) {
          void showCadMissing(missing.map((c) => c.File));
        }
        // A recorded merge that did not land leaves the draft claiming a tree the scene
        // does not have — the user has to learn about it, not a console warning.
        const unappliedMerges = doc.executor.takeUnappliedMerges();
        if (unappliedMerges.length > 0) {
          void showMergeUnapplied(unappliedMerges.map((m) => `${m.rootPath}: ${m.reason}`));
        }
      } else {
        doc = AssetDocument.newUntitled(viewer);
        await this._loadBase(viewer, { kind: 'empty' });
      }
    } catch (e) {
      console.error('[asset-editor] failed to open asset document:', e);
      doc = AssetDocument.newUntitled(viewer);
      await this._loadBase(viewer, { kind: 'empty' });
    }

    this.doc = doc;
    setActiveAssetContext({ viewer, doc });
    setActiveEditTarget(this._buildEditTarget(doc));

    this.transformTool = new EditorTransformTool(viewer, doc);
    this.transformTool.install();

    // Read-only "Runtime view" preview (plan-301 §2.9). The hooks are the
    // Drives are authoring rv_extras in the editor (no live RVDrive until save &
    // reload), so give the shared drive-axis gizmo an authoring source built
    // from a selected node's config — the gizmo then renders in editor mode too.
    setDriveGizmoFallbackResolver((path) => resolveEditorDriveGizmoSource(viewer, path));

    // Make the drive gizmo DRAGGABLE: dragging previews the drive's motion (and
    // its kinematic group), springing back on release. The driver yields to the
    // transform gizmo. Registering it also enables the gizmo's drag listeners.
    this.driveDragPreview = new DriveDragPreview(viewer, () => this.transformTool?.isEngaged ?? false);
    setDriveDragDriver(this.driveDragPreview);

    // Editor-mode selection colors (yellow) come from the 'editor'
    // HighlightProfile, applied by RVHighlightPolicy on mode-changed.

    // Rubber-band (marquee) selection — same controller the planner uses, wired
    // for editor: yellow marquee and a fresh selectable-roots map per commit.
    this.boxSelect = new BoxSelectController({
      viewer,
      canvas: viewer.renderer.domElement as HTMLCanvasElement,
      getObjectMap: () => buildEditorSelectableMap(viewer),
      getRegistry: () => viewer.registry,
      getActive: () => viewer.modes.activeMode === 'editor',
      getMuMap: () => null,
      marqueeColors: EDITOR_MARQUEE_COLORS,
      // Auto Assign takes over the marquee: pink rubber band, and the boxed
      // paths go into the armed kinematic's group instead of the selection.
      getMarqueeColors: () => (getAutoAssignTarget() ? AUTO_ASSIGN_MARQUEE_COLORS : null),
      onCommit: (paths) => {
        const armed = getAutoAssignTarget();
        const ctx = getActiveAssetContext();
        if (!armed || !ctx || paths.length === 0) return false;
        void autoAssignToKinematic(
          viewer, ctx.doc, paths, armed.groupName, armed.kinematicPath,
        );
        return true;
      },
    });
    this.boxSelect.attach();
    viewer.renderer.domElement.addEventListener('pointerdown', this.onCanvasPointerDown);
    viewer.renderer.domElement.addEventListener('pointermove', this.onCanvasPointerMove);

    // Kinematic-group selection preview (editor mode only).
    this.unsubSelection = viewer.on('selection-changed', this.onSelectionChangedGroupPreview);

    window.addEventListener('beforeunload', this.onBeforeUnload);
    window.addEventListener('keydown', this.onKeyDown);

    // Open the Kinematics window unless the user explicitly closed it last time.
    try {
      if (localStorage.getItem('rv-editor-kinematics-open') !== 'false') {
        viewer.leftPanelManager.open('kinematics', getStoredKinematicsPanelWidth(), 'right');
      }
    } catch { /* storage unavailable */ }
  }

  private _deactivate(viewer: RVViewer): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('beforeunload', this.onBeforeUnload);

    // Disarm a pending "Pivot to Object" pick so its window listeners/cursor
    // never outlive the editor session.
    cancelPivotPick();

    // Terminate the mesh-separator worker. Any answer still in flight describes
    // geometry of a document that is about to go away.
    disposeSeparatorClient();
    // Same for the merge worker — an answer still in flight describes geometry of a
    // document that is about to go away.
    disposeMergeClient();

    // Drop the authoring drive-gizmo source — live modes resolve real drives.
    setDriveGizmoFallbackResolver(null);

    // Stop drive-gizmo dragging (restores any live preview) and detach the gizmo
    // drag listeners by clearing the driver.
    setDriveDragDriver(null);
    this.driveDragPreview?.dispose();
    this.driveDragPreview = null;

    // The Kinematics window is editor-only — free the right slot for other
    // modes (does NOT overwrite the user's open/closed preference).
    viewer.leftPanelManager.close('kinematics');

    // Tear down the marquee before the transform tool / scene restore.
    viewer.renderer.domElement.removeEventListener('pointerdown', this.onCanvasPointerDown);
    viewer.renderer.domElement.removeEventListener('pointermove', this.onCanvasPointerMove);
    this.lastPointerPos = null;
    this.boxSelect?.dispose();
    this.boxSelect = null;

    this.unsubSelection?.();
    this.unsubSelection = null;

    // Clear the active selection so the yellow overlays/outlines are removed;
    // the next mode's styles come from its HighlightProfile (RVHighlightPolicy).
    viewer.selectionManager.clear();

    this.transformTool?.uninstall();
    this.transformTool = null;

    // Forced exits (boot / lock / programmatic setMode) skip the guard — keep
    // the crash-recovery draft so nothing is lost. Guard-approved exits have
    // already saved (draft cleared) or discarded (draft cleared) by now; a
    // still-dirty doc here means a forced path → flush the draft.
    if (this.doc?.dirty) void this.doc.flushDraft();
    setActiveEditTarget(null);
    setActiveAssetContext(null);
    this.doc?.dispose();
    this.doc = null;

    void this._restorePreviousScene(viewer);
  }

  // ─── Public API (private step-import plugin calls this) ──────────────

  /** Route freshly converted CAD geometry (GLB bytes + CADLink) into the document. */
  async importCad(result: CadImportResult): Promise<string | null> {
    if (!this.doc) {
      console.warn('[asset-editor] importCad ignored — no active document');
      return null;
    }
    return this.doc.importCad(result);
  }

  /**
   * EDITOR import sink for the Unified Import Dialog: attach every resolved item
   * under the current asset root. Editor mode has no scene, so there is no
   * additive-vs-replace choice — an import is always an addition to the asset.
   */
  async importItems(items: ImportResultItem[]): Promise<string[]> {
    if (!this.doc) throw new Error('Import requires an active asset document (Editor mode).');
    return importIntoAsset(this.doc, items);
  }

  /** The active document (null outside editor mode). */
  get document(): AssetDocument | null {
    return this.doc;
  }

  // ─── internals ────────────────────────────────────────────────────────

  private async _exitGuard(): Promise<boolean> {
    if (!this.doc?.dirty) {
      // Clean exit — drop the draft so the next editor session starts fresh.
      await clearAssetDraft();
      return true;
    }
    const choice = await askUnsavedChoice(this.doc.name);
    if (choice === 'cancel') return false;
    if (choice === 'discard') {
      await clearAssetDraft();
      // Poison the local dirty state so _deactivate doesn't re-flush the draft.
      await this.doc.markSaved(this.doc.base, undefined, { clearDraft: true });
      return true;
    }
    // Save: run the full flow; only proceed when the document ends up clean.
    const saved = await runSaveFlow({ viewer: this.viewer, doc: this.doc });
    return saved;
  }

  private async _loadBase(viewer: RVViewer, base: AssetBase): Promise<void> {
    if (base.kind === 'empty') {
      // Same authoring configuration as library assets (no batching, instance
      // pick backend) — everything imported into the empty asset is authored.
      await viewer.loadModel(getEmptyGlbUrl(), { preserveHierarchy: true });
      return;
    }
    // preserveHierarchy below: the editor authors individual nodes — the
    // static uber merge would swallow them into a mega-mesh, making eye
    // toggles and gizmo transforms visually dead on re-opened assets.

    if (base.kind === 'providerAsset') {
      // plan-372 §2.6.6: re-resolve through the registry rather than trusting a
      // stored URL. A cloud adapter's blob: URL is dead after a reload, which is
      // why the draft only ever kept the (providerId, sourceId, assetId) identity.
      const source = getLibrarySource(base.providerId, base.sourceId);
      if (!source) {
        throw new Error(`The library "${base.label}" is no longer connected.`);
      }
      if (!source.getEntry(base.assetId)) {
        throw new Error(`"${base.label}" is no longer in that library.`);
      }
      const resolved = await source.resolveAsset(base.assetId, 'edit');
      try {
        await viewer.loadModel(resolved.url, { preserveHierarchy: true });
      } finally {
        // The caller owns the URL and frees it in every path — success, throw
        // and cancel alike (§2.6.4).
        resolved.revokeUrl?.();
      }
      return;
    }

    // libraryGlb: resolve <workfolder>/library/<relPath> to a blob URL.
    const root = await getWorkFolder(true);
    if (!root) throw new Error('No work folder configured — cannot open library asset');
    const lib = await getSubfolder(root, 'library');
    if (!lib) throw new Error('Work folder has no library/ subfolder');
    let dir: FileSystemDirectoryHandle = lib;
    const segments = base.relPath.split('/');
    for (const seg of segments.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(seg);
    }
    const fileHandle = await dir.getFileHandle(segments[segments.length - 1]);
    const url = await readFileAsUrl(fileHandle);
    await viewer.loadModel(url, { preserveHierarchy: true });
  }

  private async _restorePreviousScene(viewer: RVViewer): Promise<void> {
    const store = getSceneStore();
    const restore = this.restore;
    this.restore = null;
    try {
      if (store && restore?.savedSceneId) {
        await store.openScene(restore.savedSceneId);
      } else if (store && restore?.base?.kind === 'builtin') {
        await store.openBuiltin(restore.base.url, restore.base.label);
      } else if (store) {
        await store.openEmpty();
      } else {
        await viewer.loadModel(getEmptyGlbUrl());
      }
    } catch (e) {
      console.error('[asset-editor] failed to restore previous scene:', e);
    }
  }

  private _buildEditTarget(doc: AssetDocument): EditTarget {
    return {
      available: true,
      setField: (nodePath, componentType, fieldName, value, prev) =>
        doc.setField(nodePath, componentType, fieldName, value, prev),
      unsetField: (nodePath, componentType, fieldName, prev) =>
        doc.unsetField(nodePath, componentType, fieldName, prev),
      withTransaction: (label, fn) => doc.withTransaction(label, fn),
      addComponent: (nodePath, baseType, fields) => doc.addComponent(nodePath, baseType, fields),
      removeComponent: (nodePath, componentType) => doc.removeComponent(nodePath, componentType),
      transformNode: (nodePath, transform, prev) => doc.transformNode(nodePath, transform, prev),
      renameNode: (nodePath, name, prevName) => doc.renameNode(nodePath, name, prevName),
      deleteNode: (nodePath) => doc.deleteNode(nodePath),
      setNodeVisible: (nodePath, visible) => doc.setNodeVisible(nodePath, visible),
    };
  }

  private _handleEditorKeys(e: KeyboardEvent): void {
    if (!this.doc) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
      // Same single-undo-unit path as the toolbar delete button.
      e.preventDefault();
      void deleteSelectedNodes(this.viewer, this.doc);
      return;
    }
    if (!mod && !e.altKey && e.code === 'KeyK') {
      // K — open the Kinematic picker for the current selection at the cursor
      // (Blender-style; the hint is shown in the context menu next to Kinematic).
      this._openKinematicPicker(e);
      return;
    }
    if (!mod && !e.altKey && e.code === 'KeyS') {
      // S — open the Select picker (Identical / Material / Invert) for the
      // current selection at the cursor, mirroring the K gesture.
      this._openSelectPicker(e);
      return;
    }
    if (!mod) return;
    if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault();
      void this.doc.undo();
    } else if (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) {
      e.preventDefault();
      void this.doc.redo();
    }
  }

  /** Open the Kinematic picker (same items as the context menu's
   *  "Kinematic ▸" submenu) as a standalone menu at the last cursor
   *  position: assign the selection to an existing kinematic's group, or
   *  create a new named kinematic whose group collects the selection. */
  private _openKinematicPicker(e: KeyboardEvent): void {
    const viewer = this.viewer;
    const snap = viewer.selectionManager.getSnapshot();
    if (snap.selectedPaths.length === 0 || !viewer.registry) return;
    const primary = snap.primaryPath ?? snap.selectedPaths[0];
    const node = viewer.registry.getNode(primary);
    if (!node) return;
    e.preventDefault();

    // Fall back to the canvas center when the pointer has not moved yet.
    let pos = this.lastPointerPos;
    if (!pos) {
      const rect = viewer.renderer.domElement.getBoundingClientRect();
      pos = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }

    showKeyBadge('K');
    viewer.contextMenu.openItems(pos, {
      path: primary,
      node,
      types: viewer.registry.getComponentTypes(primary),
      extras: ((node.userData as Record<string, unknown> | undefined)?.['realvirtual'] ?? {}) as Record<string, unknown>,
    }, buildKinematicMenuItems(viewer));
  }

  /** Open the Select picker (same items as the context menu's "Select ▸"
   *  submenu — Identical / Material / Invert with live counts) as a
   *  standalone menu at the last cursor position. Needs a non-empty
   *  selection: unlike the right-click path there is no clicked node to
   *  seed from. */
  private _openSelectPicker(e: KeyboardEvent): void {
    const viewer = this.viewer;
    const snap = viewer.selectionManager.getSnapshot();
    if (snap.selectedPaths.length === 0 || !viewer.registry) return;
    const primary = snap.primaryPath ?? snap.selectedPaths[0];
    const node = viewer.registry.getNode(primary);
    if (!node) return;
    e.preventDefault();

    // Fall back to the canvas center when the pointer has not moved yet.
    let pos = this.lastPointerPos;
    if (!pos) {
      const rect = viewer.renderer.domElement.getBoundingClientRect();
      pos = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }

    const target = {
      path: primary,
      node,
      types: viewer.registry.getComponentTypes(primary),
      extras: ((node.userData as Record<string, unknown> | undefined)?.['realvirtual'] ?? {}) as Record<string, unknown>,
    };
    showKeyBadge('S');
    viewer.contextMenu.openItems(pos, target,
      buildSelectMenuItems(viewer, target, () => buildEditorSelectableMap(viewer)));
  }

  dispose(): void {
    this.viewer?.contextMenu.unregister('asset-editor');
    this.unregisterHeader?.();
    this.unregisterGuard?.();
    setActiveEditTarget(null);
    setActiveAssetContext(null);
    this.doc?.dispose();
    this.doc = null;
  }
}

function baseDisplayName(base: AssetBase): string {
  if (base.kind === 'libraryGlb') return base.fileName.replace(/\.glb$/i, '');
  return 'Untitled';
}
