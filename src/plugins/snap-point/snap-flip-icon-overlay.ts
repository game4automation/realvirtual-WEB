// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Snap-Flip Icon Overlay (plan-190) — visible click-to-flip handle.
 *
 * Sister plugin to the context-menu trigger in `snap-point/index.ts`. While
 * hovering or selecting a placed component that has a second compatible
 * snap, a small circular-arrow sprite appears above the asset's bounding
 * box. Clicking the sprite calls `flipPlacedComponent` exactly like the
 * context-menu entry. Hidden during gizmo drag (F13) and when the
 * `showSnapFlipIcons` visual setting is off (F14).
 *
 * Uses the existing `GizmoOverlayManager` so we don't carry our own sprite
 * + raycast plumbing — the manager already shares materials, integrates
 * with the central tick, and auto-registers the sprite as an aux raycast
 * target so the standard `'object-click'` event fires on the icon.
 */

import { Vector3, type Object3D, type Texture } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import type { RVViewerPlugin } from '../../core/rv-plugin';
import type { GizmoHandle } from '../../core/engine/rv-gizmo-manager';
import type { SnapPointRegistry } from '../../core/engine/rv-snap-point-registry';
import { canFlipPlacedComponent, flipPlacedComponent } from './snap-flip-service';
import { findLayoutAncestor } from '../layout-planner/layout-predicates';
import { getSnapFlipIconsVisible } from '../../core/hmi/visual-settings-store';
import { isContextActive } from '../../core/hmi/ui-context-store';
import { applyScreenSpaceScale } from '../../core/engine/rv-screen-space-scale';
import { makeSnapMarkerTexture } from './snap-marker-texture';

/** `userData` flag we set on the sprite mesh to identify it on click. */
const FLIP_ICON_MARKER = 'isFlipIcon';

/** Constant on-screen size of the rotate icon, in pixels — matches the active
 *  "+" snap marker (ACTIVE_MARKER_PX) so the rotate button and the hover marker
 *  are the same (small) size. Applied per frame, like the transform gizmo. */
const FLIP_ICON_PX = 15;

/**
 * Compute the inverse of the maximum world-scale along the node's parent
 * chain. Used to compensate the sprite's worldSize when attaching to a
 * node that lives under a scaled-down group (typical for CAD-imported
 * GLBs with mm→m root scale).
 */
function _scaleCompensation(node: Object3D, tmp: Vector3): number {
  node.updateWorldMatrix(true, false);
  node.getWorldScale(tmp);
  const maxScale = Math.max(Math.abs(tmp.x), Math.abs(tmp.y), Math.abs(tmp.z));
  if (!Number.isFinite(maxScale) || maxScale <= 0) return 1;
  return 1 / maxScale;
}

interface SnapPluginShape {
  getRegistry?(): SnapPointRegistry | null;
}

export class SnapFlipIconOverlay implements RVViewerPlugin {
  readonly id = 'snap-flip-icon';

  private viewer: RVViewer | null = null;
  private texture: Texture | null = null;
  private currentHandle: GizmoHandle | null = null;
  private currentRoot: Object3D | null = null;
  /** The snap-point Object3D we anchored the sprite under. The raycast
   *  manager resolves aux-target hits to their OWNER node (this one), so
   *  this is what `'object-clicked'` reports when the user clicks our icon
   *  — NOT the sprite mesh itself. We compare by identity instead of the
   *  userData marker because the marker only ends up on the sprite. */
  private currentAnchorNode: Object3D | null = null;
  /** The snap-point Object3D the sprite is visually anchored at (the occupied
   *  snap). Used to test whether a click actually landed ON the icon. */
  private currentIconAnchor: Object3D | null = null;
  /** World-space size the icon sprite was created at — used as the click
   *  hit-test radius so a click far from the icon never triggers a flip. */
  private currentIconWorldSize = 0;
  private dragging = false;
  private unsubs: Array<() => void> = [];
  private _tmpScale = new Vector3();
  private _tmpAnchorPos = new Vector3();
  /** Grace timer — keeps the icon visible after the cursor leaves the asset,
   *  long enough for the user to move the cursor onto the icon and click it.
   *  Matches the snap-point-controller pattern (DEFAULT_GRACE_MS = 600). */
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly GRACE_MS = 800;

  init(viewer: RVViewer): void {
    this.viewer = viewer;
    // Shared marker texture with the rotate glyph — same disc/ring base as the
    // snap-point "+" markers, tinted by the SpriteMaterial colour below.
    this.texture = makeSnapMarkerTexture('rotate');

    this.unsubs.push(
      viewer.on('object-hover', (data) => {
        const n = data?.node;
        if (!n) { this._maybeShow(null); return; }
        // If the cursor enters our sprite (RaycastManager substitutes the
        // owner anchor node — see _resolveHit) or anything carrying the
        // marker, cancel any pending hide; the user is on the icon.
        if (n === this.currentAnchorNode || n.userData?.[FLIP_ICON_MARKER] === true) {
          this._cancelHideTimer();
          return;
        }
        this._maybeShow(n);
      }),
      viewer.on('object-unhover', () => this._armHideTimer()),
      // Hover-only: the rotate icon appears solely while the cursor is over the
      // asset (plus the grace window to reach the icon). It no longer pins to
      // the current selection.
      viewer.on('model-cleared', () => this._hide()),
      viewer.on('layout-drag-start', () => { this.dragging = true; this._hide(); }),
      viewer.on('layout-drag-end', () => { this.dragging = false; }),
      // The actual emitted event name is 'object-clicked' (with -d).
      // 'object-click' is declared but never fired — see
      // src/core/engine/rv-component-event-dispatcher.ts:9.
      viewer.on('object-clicked', (data) => {
        const evt = data as { node?: Object3D; hitPoint?: [number, number, number] } | undefined;
        const node = evt?.node;
        if (!node || !this.currentRoot || !this.viewer || !this.currentAnchorNode) return;
        // RaycastManager resolves a sprite hit to its owner node (root) — but
        // the object's geometry ALSO resolves to root (aux-owner +
        // ancestor-override), so identity alone matches both an icon click and
        // a click/drag anywhere on the object's mesh. Require the click to have
        // actually landed ON the icon (its world hit-point is within the icon's
        // radius) — this stops a far-away mesh drag from triggering a flip.
        const onObject =
          node === this.currentAnchorNode ||
          node.userData?.[FLIP_ICON_MARKER] === true;
        if (!onObject) return;
        if (!this._clickLandedOnIcon(evt?.hitPoint)) return;
        const result = flipPlacedComponent(this.currentRoot, this.viewer);
        if (!result.ok) console.warn(`[snap-flip-icon] ${result.reason}`);
      }),
    );
  }

  /** Begin the grace timer; the icon stays visible until it fires. The grace
   *  window lets the cursor travel from the asset onto the icon to click it. */
  private _armHideTimer(): void {
    this._cancelHideTimer();
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      this._hide();
    }, this.GRACE_MS);
  }

  private _cancelHideTimer(): void {
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  onModelCleared?(): void { this._hide(); }

  /** Per-frame: keep the rotate icon at a constant on-screen pixel size (like
   *  the transform gizmo) and refresh the click hit-test radius accordingly. */
  onRender(): void {
    if (!this.currentHandle || !this.viewer) return;
    if (!this.currentHandle.root.visible) return;
    const camera = this.viewer.camera;
    const renderer = this.viewer.renderer;
    if (!camera || !renderer) return;
    this.currentIconWorldSize = applyScreenSpaceScale(
      this.currentHandle.root, FLIP_ICON_PX, camera, renderer.domElement.clientHeight,
    );
  }

  dispose(): void {
    this._hide();
    for (const off of this.unsubs) off();
    this.unsubs = [];
    this.viewer = null;
  }

  /**
   * Show the flip icon at the currently-occupied snap-point of `node`'s
   * placed-root iff:
   *   - the visual-settings toggle is on,
   *   - the node belongs to a placed component (has `_layoutId` ancestor),
   *   - that placed component is flippable (canFlipPlacedComponent),
   *   - we're not currently in a gizmo drag.
   *
   * The icon is anchored to the occupied snap-point node — not the bounding
   * box centre — because the occupied snap IS the geometric pivot of the
   * flip operation (the partner snap stays fixed in world space, the
   * component swings around it). Placing the icon there matches the user's
   * mental model: "I click where the flip happens."
   */
  private _maybeShow(node: Object3D | null): void {
    if (!this.viewer || !this.texture) return;
    if (this.dragging) return;
    // Snap-flip is a planner-only feature — never show the icon outside the
    // planner (hide immediately, bypassing the grace timer).
    if (!isContextActive('planner')) { this._hide(); return; }
    // "Not applicable" cases: don't tear down an existing icon immediately —
    // let the grace timer decide. This way, hovering off a flippable
    // component onto an irrelevant one still gives the user the grace window
    // to move onto the icon. _armHideTimer is a no-op if already armed.
    if (!getSnapFlipIconsVisible()) { this._armHideTimer(); return; }
    if (!node) return;

    const root = findLayoutAncestor(node);
    if (!root) return;

    const snapPlugin = this.viewer.getPlugin<SnapPluginShape & { id: string }>('snap-point');
    const registry = snapPlugin?.getRegistry?.() ?? null;
    if (!registry) return;
    if (!canFlipPlacedComponent(root, registry)) return;

    // Find the currently-occupied snap — that's the pivot of the flip.
    // No-op: if for some race reason no occupied snap exists, leave the
    // current (possibly grace-timed) icon alone.
    const occupied = registry.getByOwnerRoot(root).find(s => s.occupied);
    if (!occupied) return;
    const anchorNode = occupied.object3D;

    // Already showing for this root? Cancel any pending hide and keep it.
    if (this.currentRoot === root && this.currentHandle) {
      this._cancelHideTimer();
      return;
    }

    this._hide();                      // tears down any previous handle
    this.currentRoot = root;
    // currentAnchorNode is set to `root` AFTER create() below — that's what
    // the raycast manager will report as the hit node (because we override
    // auxOwner to `root` to pass the planner's allow-filter).
    // Anchor at the occupied snap node — its world position is the
    // connection seam between this component and its partner.
    //
    // Scale compensation: the snap node typically lives under a placed
    // group whose world-scale can be ≠ 1 (e.g. mm→m CAD imports give a
    // root scale of 0.001). Three.js sprites inherit the parent chain's
    // world scale, so a fixed worldSize would shrink to invisibility in
    // those scenes. We undo the inherited scale so the icon always
    // renders at its intended size in world units.
    // Initial world size for the first frame only — `onRender` immediately
    // rescales the icon to a constant on-screen pixel size (FLIP_ICON_PX).
    const comp = _scaleCompensation(anchorNode, this._tmpScale);
    const worldSize = 0.10 * comp;

    this.currentHandle = this.viewer.gizmoManager.create(anchorNode, {
      shape: 'sprite',
      // The 'rotate' texture bakes a green disc + white glyph (same look as the
      // "+" hover marker) → render untinted.
      color: 0xffffff,
      opacity: 1.0,
      depthTest: false,                // always-on-top
      spriteTexture: this.texture,
      attachToNode: true,              // sprite follows the snap node's transform
      worldSize,
      userDataMarker: FLIP_ICON_MARKER,
      // Use the placed ROOT (carries `_layoutId`) as the raycast aux owner
      // instead of the snap-empty (which doesn't pass the planner's allow
      // filter `isLayoutInstance`). Without this, the click resolution
      // skips our sprite and 'object-clicked' fires for the geometry behind
      // it — and the flip never triggers.
      auxOwner: root,
      category: 'markers',
    });
    // The click event will report `node === root`, so use that for
    // identity matching instead of the snap-empty.
    this.currentAnchorNode = root;
    // Remember WHERE the icon actually is (the occupied snap) and its size so
    // a click can be tested for landing on the icon vs. the object geometry —
    // both resolve to `root`, so identity alone can't tell them apart.
    this.currentIconAnchor = anchorNode;
    this.currentIconWorldSize = worldSize;
  }

  private _hide(): void {
    this._cancelHideTimer();
    if (this.currentHandle) this.currentHandle.dispose();
    this.currentHandle = null;
    this.currentRoot = null;
    this.currentAnchorNode = null;
    this.currentIconAnchor = null;
    this.currentIconWorldSize = 0;
  }

  /**
   * True only when a click's world hit-point landed ON the icon sprite (within
   * its world-space radius of the anchor snap). The icon and the object both
   * resolve to the same placed `root` through the raycast aux-target /
   * ancestor-override, so this spatial test is what tells "clicked the rotate
   * icon" apart from "clicked (or click-dragged) the object's mesh".
   */
  private _clickLandedOnIcon(hitPoint?: [number, number, number]): boolean {
    if (!hitPoint || !this.currentIconAnchor) return false;
    this.currentIconAnchor.updateWorldMatrix(true, false);
    const wp = this.currentIconAnchor.getWorldPosition(this._tmpAnchorPos);
    const dx = hitPoint[0] - wp.x;
    const dy = hitPoint[1] - wp.y;
    const dz = hitPoint[2] - wp.z;
    // A sprite hit lands within ~0.7×size of its centre; allow the full size
    // as the radius (with a small floor so tiny icons stay clickable).
    const r = Math.max(this.currentIconWorldSize, 0.05);
    return dx * dx + dy * dy + dz * dz <= r * r;
  }

}

export const snapFlipIconOverlay = new SnapFlipIconOverlay();
