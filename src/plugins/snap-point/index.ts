// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SnapPointPlugin — Browser-side library-attach via snap points.
 *
 * On model load, scans the loaded subtree for nodes whose names match the
 * Snap-<DIR>-<TYPEID> convention and registers them. Activates a mouse-
 * proximity controller (only in planner mode) that highlights the closest
 * snap point and opens a picker popup on click.
 *
 * Plugin lifecycle integrates with the WebViewer ui-context-store: the
 * controller is enabled iff the 'planner' context is active.
 */

import type { RVViewer } from '../../core/rv-viewer';
import type { RVViewerPlugin } from '../../core/rv-plugin';
import type { LoadResult } from '../../core/engine/rv-scene-loader';
import type { UISlotEntry, UISlotProps } from '../../core/rv-ui-plugin';
import type { ModeId } from '../../core/rv-mode-manager';
import type { LayoutPlannerPlugin } from '../layout-planner';
import { SnapPointRegistry } from '../../core/engine/rv-snap-point-registry';
import { PathSnapSource, PATH_SNAP_ID_PREFIX } from './path-snap-source';
import { flowsCompatible, type SnapFlow } from './snap-name-parser';
import { SnapPointController } from './snap-point-controller';
import { SnapMarkerRenderer } from './snap-marker-renderer';
import { SnapPlacementService } from './snap-placement-service';
import { SnapMagneticController } from './snap-magnetic-controller';
import { SnapChainPreview } from './snap-chain-preview';
import { scanAndRegisterSnaps } from './snap-scanner';
import { snapHoverStore } from './snap-hover-store';
import { snapToolbarStore } from './snap-toolbar-store';
import { Vector3, type Object3D } from 'three';
import {
  _subscribe as subscribeUiContext,
  isContextActive,
} from '../../core/hmi/ui-context-store';
import { SnapPointPickerPopup } from './SnapPointPickerPopup';
import { canFlipPlacedComponent, flipPlacedComponent } from './snap-flip-service';
import { findLayoutAncestor } from '../layout-planner/layout-predicates';
import type { ComponentType } from 'react';

/** World-space distance at which an approaching moving snap lights up its
 *  compatible match during a drag. Much larger than the magnet pull radius
 *  (DEFAULT_MAGNET_RADIUS_M = 0.4) so nearby compatible ports are previewed
 *  early — only those within the pull radius actually snap. */
const SNAP_APPROACH_RADIUS_M = 5;

export class SnapPointPlugin implements RVViewerPlugin {
  readonly id = 'snap-point';

  /**
   * Snap points are an AUTHORING affordance (placement, magnets, chain preview)
   * — excluded from the Viewer workspace (plan-387 F4). Declaring `modes` is
   * safe here precisely because this plugin's ONLY slot is the overlay below:
   * it owns no ruleless `button-group` entry, so it cannot trigger the
   * ButtonPanel regression that `modes` causes for such plugins (see
   * doc-ui-visibility.md and plan-387 §2.2a/B2). This also takes the runtime
   * out in the Viewer, which is wanted — nothing there places components.
   */
  readonly modes: ModeId[] = ['hmi', 'des', 'planner', 'editor'];

  // The popup renders as a full-screen overlay portal
  readonly slots: UISlotEntry[] = [
    {
      slot: 'overlay',
      component: SnapPointPickerPopup as ComponentType<UISlotProps>,
      order: 200,
    },
  ];

  private registry: SnapPointRegistry | null = null;
  /** DES/AGV path ends as data-bound snappoints (plan-447 F2). */
  private pathSnaps: PathSnapSource | null = null;
  /** Unregisters the station-snap candidate source from the path visualizer (F4). */
  private unsubscribePathCandidates: (() => void) | null = null;
  private controller: SnapPointController | null = null;
  private markerRenderer: SnapMarkerRenderer | null = null;
  private placement: SnapPlacementService | null = null;
  private magnetic: SnapMagneticController | null = null;
  private chainPreview: SnapChainPreview | null = null;
  private unsubscribeObjectHover: (() => void) | null = null;
  private unsubscribeSelection: (() => void) | null = null;
  private unsubscribeCtx: (() => void) | null = null;
  private unsubscribeToolbar: (() => void) | null = null;
  private unsubscribeDragStart: (() => void) | null = null;
  private unsubscribeDragTick: (() => void) | null = null;
  private unsubscribeDragEnd: (() => void) | null = null;
  private viewer: RVViewer | null = null;

  /** Chain-preview focus: owner root currently hovered (or dragged), if any. */
  private _hoverFocus: Object3D | null = null;
  /** Chain-preview focus: owner roots of the current selection. */
  private _selectionFocus: Object3D[] = [];

  init(viewer: RVViewer): void {
    this.viewer = viewer;
    this.registry = new SnapPointRegistry();
    this.markerRenderer = new SnapMarkerRenderer(viewer, this.registry);
    this.controller = new SnapPointController(viewer, this.registry, this.markerRenderer);
    this.placement = new SnapPlacementService(viewer, this.registry);
    this.magnetic = new SnapMagneticController(this.registry);
    this.chainPreview = new SnapChainPreview(viewer, this.registry);
    // Path ends (rv_extras.Path) join the SAME registry as GLB-authored snaps.
    // The source subscribes to the path network's change channel itself, so a
    // planner drag re-registers them without anyone here knowing (plan-447).
    this.pathSnaps = new PathSnapSource(this.registry);
    this.wirePathDragCandidates(viewer);

    // Drag-time magnetic snap: the layout-planner emits the lifecycle on
    // the viewer's event bus. We listen here so the planner doesn't have to
    // know about the snap-point plugin at all. The user can disable the
    // pull-to-snap behaviour from the magnetic-snap settings panel; when
    // off, we skip arming so tick() is a no-op for the duration of the drag.
    const onStart = (d: { node: Object3D; altKey?: boolean }): void => {
      // Planner-only: never arm magnetic snap outside planner mode (gates the
      // whole drag — onTick/onEnd are no-ops without an arm).
      if (!isContextActive('planner')) return;
      if (!this._isMagnetEnabled()) return;
      const chainEnabledGlobal = this._isChainEnabled();
      // Solo drag = "move this asset alone, sever its chain edges". Triggered
      // by ALT-held (mouse) OR by chain-mode being OFF (touch-equivalent).
      // Without this, an already-paired asset's snaps stay `occupied` for the
      // duration of the drag, the magnetic controller skips them, and the
      // asset can be dropped on top of an existing one without snapping.
      const soloDrag = d.altKey === true || !chainEnabledGlobal;
      if (soloDrag) this._detachAssetConnections(d.node);
      const chainEnabled = chainEnabledGlobal && !d.altKey;
      this.magnetic?.armForDrag(
        d.node,
        (root) => this._resolvePlacedId(root),
        { chainEnabled },
      );
      // Faintly show the moving asset's own (GLB-defined) snap points for the
      // whole drag, so the user sees where it can connect.
      const movingIds = (this.magnetic?.getMovingSnaps() ?? []).map(s => s.id);
      this.markerRenderer?.setDragHints(movingIds, []);
      // Outline everyone that will follow this drag so the user can see the
      // chain BEFORE moving the mouse. Solo / ALT drags sever connections, so
      // there is no chain to preview.
      this._hoverFocus = chainEnabled ? d.node : null;
      this._updateChainPreview();
    };
    const onTick = (d: { node: Object3D }): void => {
      this.magnetic?.tick(d.node);
      // Rigid follow of chained members + break-on-stretch — runs even when
      // no snap engaged this tick (members must still follow the gizmo).
      this.magnetic?.applyChainFollow();
      // Snap-point hints: keep the moving snaps faint and light up any compatible
      // match an approaching moving snap can mate with (gold). When unarmed
      // (magnet off) getMovingSnaps() is empty → setDragHints clears nothing.
      const movingIds = (this.magnetic?.getMovingSnaps() ?? []).map(s => s.id);
      const targets = this.magnetic?.collectApproaching(SNAP_APPROACH_RADIUS_M).targets;
      this.markerRenderer?.setDragHints(movingIds, targets ? [...targets] : []);
      // Chain membership can change mid-drag (snap engaged / stretch broke an
      // edge); re-evaluate. Cached by member-set, so this is a no-op when the
      // chain is unchanged.
      this._updateChainPreview();
    };
    const onEnd = (_d: { node: Object3D }): void => {
      this.magnetic?.disarm(true);
      // Clear drag hints first (disarm has updated occupancy, so cleared snaps
      // resolve to their correct post-drop visibility), then refresh markers so
      // newly-occupied snaps disappear; drop the drag focus (selection focus,
      // if any, keeps its chain preview alive).
      this.markerRenderer?.clearDragHints();
      this.markerRenderer?.refreshAll();
      this._hoverFocus = null;
      this._updateChainPreview();
    };

    // Hover preview: outline every chain member as soon as the cursor enters
    // any asset that participates in a chain. Updates / clears as the cursor
    // moves. Planner-mode + chain-mode gating happens in _updateChainPreview.
    this.unsubscribeObjectHover = viewer.on('object-hover', (data) => {
      this._hoverFocus = data ? this._resolveOwnerRoot(data.node) : null;
      this._updateChainPreview();
    });
    // Selection preview: outline the chain members of every selected asset so
    // the chain is visible on selection too (not just on hover/drag).
    this.unsubscribeSelection = viewer.on('selection-changed', (snap) => {
      const roots: Object3D[] = [];
      const seen = new Set<Object3D>();
      for (const path of snap.selectedPaths ?? []) {
        const node = viewer.registry?.getNode(path);
        if (!node) continue;
        const owner = this._resolveOwnerRoot(node);
        if (owner && !seen.has(owner)) { seen.add(owner); roots.push(owner); }
      }
      this._selectionFocus = roots;
      this._updateChainPreview();
    });
    this.unsubscribeDragStart = viewer.on('layout-drag-start', onStart);
    this.unsubscribeDragTick = viewer.on('layout-drag-tick', onTick);
    this.unsubscribeDragEnd = viewer.on('layout-drag-end', onEnd);

    // Mode-based activation via ui-context-store
    this.unsubscribeCtx = subscribeUiContext(() => this._applyMode());
    // Apply once at start
    this._applyMode();

    // Toolbar "Show All Snaps" toggle propagates to the marker renderer
    this.unsubscribeToolbar = snapToolbarStore.subscribe(() => {
      const show = snapToolbarStore.getState().showAllSnaps;
      this.markerRenderer?.setShowAllIdle(show);
    });
    this.markerRenderer.setShowAllIdle(snapToolbarStore.getState().showAllSnaps);

    // Context-menu integration: "Flip orientation (180°)" appears only when
    // the right-clicked node belongs to a placed component whose currently
    // engaged snap has a same-typeId sibling — see snap-flip-service. The
    // guard handles minimal test viewers that don't wire up `contextMenu`.
    if (viewer.contextMenu?.register) {
      viewer.contextMenu.register({
        pluginId: 'snap-flip',
        items: [{
          id: 'flip-orientation',
          label: 'Flip orientation (180°)',
          order: 50,
          condition: (target) => {
            // Planner-only: never offer the flip action outside planner mode.
            if (!isContextActive('planner')) return false;
            const root = findLayoutAncestor(target.node);
            return root !== null && canFlipPlacedComponent(root, this.registry);
          },
          action: (target) => {
            const root = findLayoutAncestor(target.node);
            if (!root) return;
            const result = flipPlacedComponent(root, viewer);
            if (!result.ok) console.warn(`[snap-flip] ${result.reason}`);
          },
        }],
      });
    }
  }

  onModelLoaded(result: LoadResult): void {
    if (!this.registry || !this.markerRenderer) return;
    // Wipe previous model's snaps
    this.registry.clear();
    snapHoverStore.reset();
    // Re-sync planner mode AFTER the model is loaded. The layout-planner's
    // onModelLoaded restores its panel state and may call setActive(true)
    // during the same lifecycle pass — depending on plugin registration
    // order our subscribeUiContext callback may have already fired before
    // the planner activated, or before we owned the registry. A defensive
    // re-apply here guarantees the snap controller + marker renderer
    // reflect the actual planner-mode state on every model load (including
    // page-reload restores).
    this._applyMode();

    // Scan the new model root
    scanAndRegisterSnaps(result.root, this.registry, result.root);
    // Path ends of the freshly loaded model (registry.clear() above dropped the
    // previous ones, so the source must re-derive its bookkeeping too).
    this.pathSnaps?.clear();
    this.pathSnaps?.syncAll();

    // Recreate marker mesh sized to the new snap count
    this.markerRenderer.rebuild(this.registry.size);
  }

  onModelCleared?(): void {
    this.pathSnaps?.clear();
    this.registry?.clear();
    snapHoverStore.reset();
    this.markerRenderer?.rebuild(0);
  }

  /** Per-frame: keep snap markers a constant on-screen size (like the gizmo). */
  onRender(): void {
    this.markerRenderer?.updateScreenSize();
  }

  dispose(): void {
    this.viewer?.contextMenu?.unregister?.('snap-flip');
    this.unsubscribeCtx?.();
    this.unsubscribeCtx = null;
    this.unsubscribeToolbar?.();
    this.unsubscribeToolbar = null;
    this.unsubscribeDragStart?.();
    this.unsubscribeDragStart = null;
    this.unsubscribeDragTick?.();
    this.unsubscribeDragTick = null;
    this.unsubscribeDragEnd?.();
    this.unsubscribeDragEnd = null;
    this.unsubscribeObjectHover?.();
    this.unsubscribeObjectHover = null;
    this.unsubscribeSelection?.();
    this.unsubscribeSelection = null;
    this._hoverFocus = null;
    this._selectionFocus = [];
    this.chainPreview?.hide();
    this.chainPreview = null;
    this.controller?.dispose();
    this.controller = null;
    this.markerRenderer?.dispose();
    this.markerRenderer = null;
    this.placement?.dispose();
    this.placement = null;
    this.magnetic?.cancel();
    this.magnetic = null;
    this.pathSnaps?.dispose();
    this.pathSnaps = null;
    this.unsubscribePathCandidates?.();
    this.unsubscribePathCandidates = null;
    this.registry?.clear();
    this.registry = null;
    snapHoverStore.reset();
  }

  /**
   * Feed STATION snappoints into the path-endpoint rastung of the path
   * visualizer (plan-447 F4). The visualizer knows the free ends of every path
   * by itself; everything else lives in this registry, which core must not
   * import — so we push a candidate source into its tiny registry instead.
   * Looked up by plugin id with a structural type (same shape as the `fpv`
   * lookup in rv-viewer.ts): neither plugin imports the other's module.
   *
   * Path-end snaps are skipped here — the visualizer enumerates those itself
   * and must keep excluding the end currently being dragged.
   */
  private wirePathDragCandidates(viewer: RVViewer): void {
    // Defensive: several suites hand `init()` a hand-rolled viewer stub that
    // carries only what the snap plugin used to touch. A missing optional
    // wiring seam must not take the whole plugin down.
    if (typeof viewer.getPlugin !== 'function') return;
    const viz = viewer.getPlugin<{
      id: string;
      addSnapCandidateSource(
        source: (q: { pathId: string; handleId: string }) => readonly {
          id: string;
          position: [number, number, number];
        }[],
      ): () => void;
    }>('path-visualizer');
    if (!viz?.addSnapCandidateSource) return;
    const world = new Vector3();
    this.unsubscribePathCandidates = viz.addSnapCandidateSource((q) => {
      const registry = this.registry;
      if (!registry) return [];
      // A path START consumes (flow 'in'), a path END emits ('out') — handle
      // `v0` is the start, the other free vertex is the end.
      const draggedFlow: SnapFlow = q.handleId === 'v0' ? 'in' : 'out';
      const out: { id: string; position: [number, number, number] }[] = [];
      for (const sp of registry.getAll()) {
        if (sp.id.startsWith(`${PATH_SNAP_ID_PREFIX}:`)) continue;
        if (sp.occupied) continue;
        if (!flowsCompatible(draggedFlow, sp.flow)) continue;
        sp.object3D.getWorldPosition(world);
        out.push({ id: sp.id, position: [world.x, world.y, world.z] });
      }
      return out;
    });
  }

  // Public accessors for other modules (scene-mutations, picker)
  getRegistry(): SnapPointRegistry | null { return this.registry; }
  getPlacement(): SnapPlacementService | null { return this.placement; }
  getMarkerRenderer(): SnapMarkerRenderer | null { return this.markerRenderer; }

  /** Highlight a single snap in 3D (hierarchy hover/select), or clear with null.
   *  Forwards to the marker renderer's hierarchy-highlight. Safe before init. */
  highlightSnap(snapId: string | null): void {
    this.markerRenderer?.highlight(snapId);
  }
  getMagnetic(): SnapMagneticController | null { return this.magnetic; }
  isActive(): boolean { return this.controller?.isActive() ?? false; }

  /** Resolve a placed-component id by walking up from the moving root.
   *  Uses the layout-planner's typed lookup. */
  private _resolvePlacedId(root: Object3D): import('../../core/engine/rv-snap-point-registry').PlacedComponentId | null {
    const planner = this.viewer?.getPlugin<LayoutPlannerPlugin>('layout-planner');
    const id = planner?.findPlacedIdByRoot(root);
    return id ? (id as import('../../core/engine/rv-snap-point-registry').PlacedComponentId) : null;
  }

  /** Snap-point magnetic snapping is always on — it's core placement behavior.
   *  (The former per-tool toggle was removed from the magnetic-snap popover.) */
  private _isMagnetEnabled(): boolean {
    return true;
  }

  /** Read the chain-mode toggle from the planner store (default on). */
  private _isChainEnabled(): boolean {
    const planner = this.viewer?.getPlugin<LayoutPlannerPlugin>('layout-planner');
    return planner?.store?.chainModeEnabled ?? true;
  }

  /** Sever every chain connection owned by `assetRoot` — both ends of each
   *  paired snap are freed in the registry, so the asset becomes truly
   *  detached. Used by ALT-drag and by the explicit context-menu detach
   *  action (when implemented). */
  private _detachAssetConnections(assetRoot: Object3D): void {
    const reg = this.registry;
    if (!reg) return;
    for (const sp of reg.getAll()) {
      if (sp.ownerRoot !== assetRoot) continue;
      if (!sp.pairedSnapId) continue;
      reg.markFree(sp.id); // also clears the partner side
    }
    this.markerRenderer?.refreshAll();
  }

  /**
   * Recompute the chain preview from the current hover + selection focus.
   * The chain visualization is a PLANNER-MODE-ONLY feature: outside planner
   * mode (or with chain mode off) the preview is always hidden.
   */
  private _updateChainPreview(): void {
    if (!isContextActive('planner') || !this._isChainEnabled()) {
      this.chainPreview?.hide();
      return;
    }
    const focus: Object3D[] = [...this._selectionFocus];
    if (this._hoverFocus) focus.push(this._hoverFocus);
    if (focus.length === 0) { this.chainPreview?.hide(); return; }
    this.chainPreview?.showForRoots(focus);
  }

  /** Walk up from a hover-hit node to the nearest registered ownerRoot. */
  private _resolveOwnerRoot(node: Object3D): Object3D | null {
    const reg = this.registry;
    if (!reg) return null;
    let cur: Object3D | null = node;
    while (cur) {
      if (reg.getByOwnerRoot(cur).length > 0) return cur;
      cur = cur.parent;
    }
    return null;
  }

  private _applyMode(): void {
    const plannerActive = isContextActive('planner');
    if (!this.controller || !this.markerRenderer) return;
    // The toolbar "Show All Snaps" preference is the single source of truth
    // for whether idle markers stay visible permanently. Planner activation
    // only enables/disables the system itself — proximity-based reveal is
    // always the default and "show all" is a deliberate user opt-in.
    if (plannerActive) {
      this.controller.activate();
      this.markerRenderer.setEnabled(true);
      this.markerRenderer.setShowAllIdle(snapToolbarStore.getState().showAllSnaps);
    } else {
      this.controller.deactivate();
      this.markerRenderer.setEnabled(false);
      this.markerRenderer.setShowAllIdle(snapToolbarStore.getState().showAllSnaps);
      // Chain preview is planner-only — drop it (and its focus) on mode exit.
      this._hoverFocus = null;
      this._selectionFocus = [];
      this.chainPreview?.hide();
      // Close any open picker on mode exit
      if (snapHoverStore.getState().pickerOpen) {
        snapHoverStore.closePicker();
      }
    }
  }
}

export const snapPointPlugin = new SnapPointPlugin();
