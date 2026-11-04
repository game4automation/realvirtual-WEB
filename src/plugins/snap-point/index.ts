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
import { PathSnapSource, PATH_SNAP_ID_PREFIX, pathPlacementPorts, type PathPlacementPort } from './path-snap-source';
import { flowsCompatible, type SnapFlow } from './snap-name-parser';
import { SnapPointController } from './snap-point-controller';
import { SnapMarkerRenderer } from './snap-marker-renderer';
import { SnapPlacementService } from './snap-placement-service';
import { SnapMagneticController } from './snap-magnetic-controller';
import { SnapChainPreview } from './snap-chain-preview';
import { scanAndRegisterSnaps } from './snap-scanner';
import { pairRegistryByProximity } from '../../core/connect/rv-connection-registry';
import { SNAP_PAIR_EPS_M } from '../../core/connect/snap-pairing';
import { snapHoverStore } from './snap-hover-store';
import { snapToolbarStore } from './snap-toolbar-store';
import { Group, Vector3, type Object3D } from 'three';
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

/** World-space distance below which two snaps count as mated when the connection
 *  graph is reconstructed from geometry. Mated snaps are placed exactly
 *  coincident in-session (the magnetic controller decomposes to an exact pose),
 *  but the live geometry can drift by up to ~1 cm by the time it is
 *  reconstructed on reload (drop-to-surface re-adjust, a snap riding a drive
 *  node, accumulated align recompute). The old 5 mm tolerance silently dropped
 *  such connections even though they were clearly mated — far stricter than the
 *  tolerance at which the magnetic system forms (≈400 mm engage) and holds a
 *  chain. 30 mm comfortably absorbs the drift while staying well below the
 *  spacing between any two distinct, non-mated compatible ports (≥ a module
 *  length, typically ≥ 250 mm). The greedy nearest-match in
 *  `computeProximityPairings` still prefers the closest partner, so widening the
 *  window does not mis-pair when the true partner is nearer. */
export const SNAP_PAIR_REBUILD_EPS_M = SNAP_PAIR_EPS_M; // one value, owned by core/connect (plan-633)

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
  /** plan-628 8.2: scene container of the path-end snap holders. */
  private pathSnapHolders: Group | null = null;
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
  /** Per-placement re-scan as deferred placements land (plan-757 Phase 2). */
  private unsubscribePlacementAdded: (() => void) | null = null;
  /** Connection-graph rebuild once a load's placements have settled. */
  private unsubscribePlacementsDone: (() => void) | null = null;
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
    // plan-628 8.2: path ends are standard snaps — a newly placed block gets its
    // markers (rebuild when ends appeared / vanished), a link change hides or
    // shows the marker of the end it connects (occupancy refresh).
    // The holders live in the scene (an empty overlay container), or the
    // sprites the marker renderer attaches to the end nodes would never draw.
    this.pathSnapHolders = new Group();
    this.pathSnapHolders.name = '__pathSnapHolders';
    viewer.scene?.add?.(this.pathSnapHolders);
    this.pathSnaps = new PathSnapSource(this.registry, {
      holderParent: this.pathSnapHolders,
      onChange: (idsChanged) => {
        if (!this.registry || !this.markerRenderer) return;
        // A handle takes its idle / occupied colour when it is built, so an
        // end whose occupancy flipped (a move freed or linked it, 8.8) needs a
        // rebuild too, not only a visibility refresh.
        const occ = this.pathOccupancySignature();
        const occChanged = occ !== this.lastPathOccupancy;
        this.lastPathOccupancy = occ;
        if (idsChanged || occChanged) {
          this.markerRenderer.rebuild(this.registry.size);
          // New handles start hidden: re-apply hover + pinned reveals (8.8).
          this.applyPinnedPathSnaps();
          this.controller?.reapplyReveals();
        } else {
          this.markerRenderer.refreshAll();
        }
      },
    });
    this.wirePathDragCandidates(viewer);
    this.wirePathLineHover(viewer);

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

    // ── Deferred placements (plan-757 Phase 2) ──────────────────────────────
    // Since every AssetReference became a placement the VIEWER materialises,
    // `onModelLoaded` no longer sees the content it is supposed to scan: at
    // that moment each placement root is still an empty stub, and the
    // `Snap-*` nodes only appear a second or two later. Worse, the one scan
    // there records the MODEL ROOT as ownerRoot for everything it does find,
    // and same-owner snaps can never pair (`b.owner === a.owner` in
    // computeProximityPairings). Either way the registry ends up without a
    // single usable pairing, so every Conveyor's downstream interlock reads
    // "no successor → blocked" and the line stops at the first part.
    // (Same failure the planner's adopt path fixed on 2026-09-01; the
    // instancer path bypasses it.) So: re-scan PER PLACEMENT, owned by the
    // placement root, as each one lands…
    this.unsubscribePlacementAdded = viewer.on('layout-content-added', (payload) => {
      if (payload?.root) this.rescanOwner(payload.root);
    });
    // …and reconstruct the connection graph once the load has settled, when
    // both ends of every connection are guaranteed to be in the scene.
    this.unsubscribePlacementsDone = viewer.on('placements-materialized', (info) => {
      if (!info?.aborted) this.rebuildPairings();
    });

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

  /**
   * plan-628 8.3: every free `path`-typed placement port as a tangent-true
   * attach target for path blocks (the path-network tool merges them with the
   * free path ends).
   */
  listPathPlacementPorts(): PathPlacementPort[] {
    return this.registry ? pathPlacementPorts(this.registry) : [];
  }

  /** Re-derive the path-end snaps from the current network (plan-628: after a path-network command, undo or redo). */
  syncPathSnaps(): void {
    this.pathSnaps?.syncAll();
  }

  /**
   * plan-628 8.8: keep the FREE end snaps of these paths revealed without
   * hover — the path network UI pins the selected block's paths and the ends a
   * move freed. Empty clears. Unknown / closed paths are skipped.
   */
  setPinnedPathSnaps(pathIds: readonly string[]): void {
    this.pinnedPathIds = [...pathIds];
    this.applyPinnedPathSnaps();
  }

  private pinnedPathIds: string[] = [];
  /** Occupied path-end snap ids at the last path-snap change (marker colour refresh, 8.8). */
  private lastPathOccupancy = '';

  private pathOccupancySignature(): string {
    let sig = '';
    for (const sp of this.registry?.getAll() ?? []) {
      if (sp.occupied && sp.id.startsWith(`${PATH_SNAP_ID_PREFIX}:`)) sig += `${sp.id};`;
    }
    return sig;
  }

  private applyPinnedPathSnaps(): void {
    const owners: Object3D[] = [];
    for (const id of this.pinnedPathIds) {
      const h = this.pathSnaps?.holderOf(id);
      if (h) owners.push(h);
    }
    this.controller?.setPinnedOwners(owners);
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
    this.unsubscribePlacementAdded?.();
    this.unsubscribePlacementAdded = null;
    this.unsubscribePlacementsDone?.();
    this.unsubscribePlacementsDone = null;
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
    this.pathSnapHolders?.removeFromParent();
    this.pathSnapHolders = null;
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

  /**
   * plan-628 8.2 (G4): hovering a path LINE reveals its end snaps. Path lines
   * are overlay geometry the raycast manager never hovers, and the snaps' owner
   * (an invisible holder per path) is not in the scene, so the controller gets
   * a pointer resolver: the visualizer's fat-line pick → the hovered path's
   * holder. Looked up by plugin id with a structural type (no module import).
   */
  private wirePathLineHover(viewer: RVViewer): void {
    if (typeof viewer.getPlugin !== 'function') return;
    this.controller?.setPointerOwnerResolver((clientX, clientY) => {
      const viz = viewer.getPlugin<{ id: string; pickLineAt?(x: number, y: number, px?: number): { pathId: string } | null }>('path-visualizer');
      const hit = viz?.pickLineAt?.(clientX, clientY);
      const holder = hit ? this.pathSnaps?.holderOf(hit.pathId) ?? null : null;
      return holder ? [holder] : NO_OWNERS;
    });
  }

  /**
   * Re-register every snap under `root` with `root` itself as ownerRoot.
   *
   * The owner is what makes a snap pairable: `computeProximityPairings` skips
   * same-owner candidates, and `findOutputPairings` looks a unit's ports up by
   * owner root. A subtree scanned as part of a larger root therefore carries a
   * useless owner, so we drop those entries before re-scanning.
   *
   * Idempotent — safe to call again for a placement that is already correct.
   */
  rescanOwner(root: Object3D): void {
    if (!this.registry) return;
    this.registry.unregisterUnder(root);
    scanAndRegisterSnaps(root, this.registry, root);
    this.markerRenderer?.rebuild(this.registry.size);
  }

  /**
   * Reconstruct the snap CONNECTION graph (`pairedSnapId` / `occupied`) from
   * geometry, for every snap that is not already connected.
   *
   * Nothing persists the runtime pairing: a restored layout, and since
   * plan-757 Phase 2 every materialised placement, arrives with the right
   * transforms but no connections. Two mated snaps are placed exactly
   * coincident in world space, so the graph can be recovered by proximity.
   *
   * Safe to call repeatedly: only unoccupied snaps take part, so connections
   * established live are never disturbed.
   *
   * @param placedIdOf Maps an owner root to the planner's placement id, so the
   *   occupancy marker names the real placement. Falls back to `snap:<id>`.
   */
  rebuildPairings(placedIdOf?: (root: Object3D) => string | null): void {
    const v = this.viewer;
    const reg = this.registry;
    if (!v || !reg) return;

    // ONE pairing logic (plan-633): the core `pairRegistryByProximity` — the
    // same function the headless DES binding uses. Ports riding a drive (a
    // turntable's rotating platform) are sampled in the drive's HOME pose,
    // where they were mated (snapshot, move home, sample, restore); only
    // unoccupied snaps take part, so live connections are never disturbed;
    // each snap is occupied BY the asset on the OPPOSITE side, the convention
    // placeAtSnapPoint and the magnetic drag controller use.
    const pairs = pairRegistryByProximity(reg, {
      epsilon: SNAP_PAIR_REBUILD_EPS_M,
      drives: v.drives ?? [],
      roots: [v.scene],
      ...(placedIdOf ? { placedIdOf } : {}),
    });
    if (pairs > 0) v.markRenderDirty();
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

  /**
   * The placement roots that move together with `root` — the same set a gizmo
   * drag follows: with chain mode on, every root reachable through paired
   * snaps (including `root`); with chain mode off, just `root`. Used by the
   * planner Align tool (plan-779).
   */
  chainRootsFor(root: Object3D): Object3D[] {
    if (!this.registry || !this._isChainEnabled()) return [root];
    return [...this.registry.walkChain(root)];
  }

  /** Public form of the solo-drag detach (plan-779 Align with chain mode off). */
  detachAssetConnections(assetRoot: Object3D): void {
    this._detachAssetConnections(assetRoot);
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

const NO_OWNERS: readonly Object3D[] = Object.freeze([]);

export const snapPointPlugin = new SnapPointPlugin();
