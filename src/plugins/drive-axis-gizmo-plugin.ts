// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * drive-axis-gizmo-plugin.ts — Drive axis gizmo on selection (plan-249).
 *
 * Selecting a node with a Drive component pops a passive 3D overlay that
 * visualizes the drive's motion axis:
 *   - LINEAR drive  → double arrow (cylinder shaft + a cone tip at both ends)
 *     along the motion axis; the positive-direction tip is solid, the
 *     negative one dimmed. With UseLimits, two end-stop washer disks mark
 *     the travel range at their true world offsets (the gizmo centre IS the
 *     current position, so the disks slide past it as the drive travels).
 *   - ROTARY drive  → dashed CAD-style centreline through the rotation
 *     centre + a torus ring with arc < 360° and a tangential cone tip
 *     indicating the positive rotation direction, plus a dot marking the
 *     current angle. With UseLimits the arc is clamped to the limit range.
 *
 * While a drive is running (isRunning/jog*) its gizmo subtly pulses in scale.
 *
 * The axis comes from `RVDrive.getAxis()` (Direction + ReverseDirection,
 * already glTF-converted) composed into world space via the pure helper
 * `resolveWorldAxis` (parent world rotation, plus the drive's home
 * orientation for rotary drives). Virtual drives (zero axis) show nothing.
 *
 * Selection policy (plan-249 §10.3): a gizmo appears for exactly-hit Drive
 * nodes; when the selected node itself has no Drive, a subtree descent runs
 * that STOPS at nested Drive boundaries — the fallback only shows a gizmo if
 * EXACTLY ONE drive is found (robot root with 6 axes → nothing; select the
 * concrete axis node instead).
 *
 * Resources (plan-249 §10.2): geometries + the one material are SHARED,
 * created lazily once and disposed ONLY in `dispose()`. Per deselect the
 * per-drive `Group` is merely removed from the scene (`removeFromParent`) —
 * never `disposeSubtree`, which would kill the shared GPU resources.
 *
 * Rendering: purely passive (no picking — raycaster layers are NOT enabled
 * for the overlay layer here). Everything lives on HIGHLIGHT_OVERLAY_LAYER
 * with depthTest:false so toon/SSAO passes never touch it and it stays
 * visible on top of scene geometry.
 *
 * Visibility: `viewer.showDriveAxisGizmo` (persisted `VisualSettings`
 * toggle, applied via `applyVisualSettings`) is read per frame in
 * `onRender` — flipping it hides/rebuilds the gizmos of the current
 * selection without re-selecting.
 */

import {
  BufferGeometry, ConeGeometry, CylinderGeometry, Group, Line,
  LineDashedMaterial, MathUtils, Matrix3, Mesh, MeshBasicMaterial,
  Quaternion, Raycaster, SphereGeometry, TorusGeometry, Vector2, Vector3,
} from 'three';
import type { Object3D } from 'three';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { SelectionSnapshot } from '../core/engine/rv-selection-manager';
import type { NodeRegistry } from '../core/engine/rv-node-registry';
import type { RVDrive } from '../core/engine/rv-drive';
import type { DriveGizmoSource } from '../core/engine/drive-gizmo-source';
import { resolveDriveGizmoFallback } from '../core/engine/drive-gizmo-source';
import { getDriveDragDriver, subscribeDriveDragDriver } from '../core/engine/drive-drag-driver';
import { HIGHLIGHT_OVERLAY_LAYER } from '../core/engine/rv-group-registry';
import { computeSubtreeAABB } from '../core/engine/rv-traverse-utils';
import { PLUGIN_ORDER } from '../core/rv-plugin-order';
import { subscribeOverlayVisibility, isOverlayVisible } from '../core/overlay-visibility-store';
import type { PerspectiveCamera, OrthographicCamera } from 'three';
import {
  resolveWorldAxis, perspectiveViewportWorldHeight, computeGizmoScale, minGizmoScale,
} from './drive-axis-math';

/** Dedicated drive accent color (plan-249 §6) — deliberately different from the
 *  red/green/blue transform handles so "motion axis" ≠ "transform gizmo". */
const DRIVE_GIZMO_COLOR = 0xff9800;
const GIZMO_RENDER_ORDER = 10500;

// ── Gizmo design sizes (unit design space — the group is scaled as a whole) ──
const SHAFT_RADIUS = 0.011;
const SHAFT_LEN = 1.1;
const TIP_RADIUS = 0.045;
const TIP_LEN = 0.14;
const RING_RADIUS = 0.5;
const RING_TUBE = 0.012;
/** Rotation ring arc < 2π so the direction arrow at the open end is readable. */
const RING_ARC = MathUtils.degToRad(300);
/** Dashed rotation-axis line (CAD-style centreline through the pivot). */
const AXIS_LINE_LEN = 1.35;
const AXIS_DASH_SIZE = 0.045;
const AXIS_GAP_SIZE = 0.03;

/** Screen-constant sizing: the gizmo is capped to a fixed fraction of the
 *  viewport height (FOV/zoom-correct — see drive-axis-math), so a large part
 *  never yields an oversized gizmo. Object size only shrinks it below that cap
 *  for small parts (so the gizmo never dwarfs a tiny drive). */
const BBOX_SCALE = 0.9;
/** Editor mode has no motion, so the axis gizmo is the main visual cue — scale
 *  it up (on top of the screen-constant sizing) relative to live modes. */
const EDITOR_GIZMO_SCALE = 2;

// ── Drag picker sizes (design units; the group scales as a whole) ──
/** Fat cylinder radius/height covering the linear double-arrow for easy grabbing. */
const PICKER_SHAFT_RADIUS = 0.14;
const PICKER_SHAFT_LEN = SHAFT_LEN + 2 * TIP_LEN;
/** Fat torus tube over the rotary ring. */
const PICKER_RING_TUBE = 0.09;
/** Negative-direction arrow tip is dimmed so the solid tip reads as the
 *  drive's POSITIVE direction at a glance. */
const DIM_OPACITY = 0.35;

// ── Limits / position markers / motion pulse ──
/** End-stop disk (washer ⊥ axis) marking a linear drive's travel limits. */
const TICK_RADIUS = 0.085;
const TICK_THICKNESS = 0.012;
/** Hide a limit end-stop disk when it lies farther than this (design units)
 *  from the gizmo centre — a lone disk floating far from the part reads as
 *  a glitch rather than as an end stop. */
const MAX_TICK_Y = 3;
/** Current-angle dot on the rotation ring. */
const DOT_RADIUS = 0.032;
/** Motion pulse: subtle scale "breathing" while the drive is running. */
const PULSE_AMP = 0.05;
const PULSE_FREQ = 0.008; // rad per ms → ~785 ms period

const UP = new Vector3(0, 1, 0);
const Z_AXIS = new Vector3(0, 0, 1);
/** Virtual drives have a zero axis — guard before any orientation math. */
const AXIS_EPS = 1e-6;

interface SharedResources {
  shaftGeo: CylinderGeometry;
  tipGeo: ConeGeometry;
  ringGeo: TorusGeometry;
  /** 2-point line geometry for the dashed rotation-axis centreline
   *  (lineDistance attribute pre-computed once, shared by all instances). */
  lineGeo: BufferGeometry;
  /** End-stop washer disk for linear travel limits. */
  tickGeo: CylinderGeometry;
  /** Current-angle dot on the rotation ring. */
  dotGeo: SphereGeometry;
  material: MeshBasicMaterial;
  /** Dimmed variant for the negative-direction arrow tip / lower end stop. */
  materialDim: MeshBasicMaterial;
  lineMaterial: LineDashedMaterial;
  /** Invisible "fat" drag pickers (editor drag): a cylinder along the shaft and
   *  a torus over the ring, raycast to start a drive-motion preview. */
  pickerCylGeo: CylinderGeometry;
  pickerTorusGeo: TorusGeometry;
  pickerMat: MeshBasicMaterial;
}

interface GizmoParts {
  group: Group;
  tickLower: Mesh | null;
  tickUpper: Mesh | null;
  posDot: Mesh | null;
  /** Instance-owned ring geometry (limit-clamped arc) — disposed with the
   *  entry; everything else is shared (§10.2). */
  ownedRingGeo: TorusGeometry | null;
}

interface DriveGizmoEntry extends GizmoParts {
  drive: DriveGizmoSource;
  kind: 'linear' | 'rotary';
  /** AABB-derived base scale — computed ONCE at build (plan-249 §10.8), only
   *  the camera-distance clamp runs per frame. */
  baseScale: number;
  /** Shape-relevant config snapshot — a live edit (kind, limits, offset)
   *  triggers a rebuild on the next frame. */
  cfgKey: string;
}

/** Live state of an in-progress drive-gizmo drag (editor preview). */
interface DriveDrag {
  source: DriveGizmoSource;
  node: Object3D;
  kind: 'linear' | 'rotary';
  /** Drive world +axis (= the gizmo group's world +Y). */
  worldAxis: Vector3;
  /** Gizmo world position (rotation centre / axis origin). */
  center: Vector3;
  /** Drive position at grab (mm or °) and the last previewed position. */
  homeP: number;
  lastP: number;
  pointerId: number;
  // linear: closest-point-on-axis grab param + world-metres per mm conversion.
  grab: number;
  worldPerMm: number;
  // rotary: screen-space swept-angle accumulation.
  centerPx: [number, number];
  lastPtrAngle: number;
  accumAngle: number;
  rotSign: number;
}

export class DriveAxisGizmoPlugin implements RVViewerPlugin {
  readonly id = 'drive-axis-gizmo';
  readonly order = PLUGIN_ORDER.UI_OVERLAY;
  // NOTE: deliberately NO `modes` field — this is a SHARED overlay, active in
  // every workspace mode (same decision as the reference IKTargetEditPlugin).

  private viewer: RVViewer | null = null;
  private unsub: (() => void) | null = null;
  /** Unsubscribe from the overlay-visibility store (plan-250). */
  private offOverlay: (() => void) | null = null;
  /** Cached: is the 'gizmos' overlay category currently user-hidden? Updated in
   *  the store callback (never read per-frame from the store). ANDed into the
   *  per-frame `show` so a category-hide clears the gizmos like the settings
   *  toggle does. */
  private _catHidden = false;
  /** drivePath → entry (multi-select: one gizmo per drive). */
  private readonly entries = new Map<string, DriveGizmoEntry>();
  /** Shared geometries/material — created lazily once, disposed ONLY in dispose(). */
  private shared: SharedResources | null = null;
  private _lastSnap: SelectionSnapshot | null = null;
  /** Last applied `showDriveAxisGizmo` value (change-detection in onRender). */
  private _appliedShow = true;

  // Pre-allocated per-frame temps — no allocation in onRender.
  private readonly _pos = new Vector3();
  private readonly _parentPos = new Vector3();
  private readonly _parentQuat = new Quaternion();
  private readonly _parentScl = new Vector3();
  private readonly _baseQuat = new Quaternion();
  private readonly _localAxis = new Vector3();
  private readonly _worldAxis = new Vector3();
  private readonly _scaleVec = new Vector3();
  private readonly _twistQuat = new Quaternion();

  // ── Drag interaction (editor drive-motion preview) ──
  /** Own raycaster (overlay layer enabled) — isolated from scene selection. */
  private readonly _raycaster = new Raycaster();
  private readonly _ndc = new Vector2();
  private _dragUnsub: (() => void) | null = null;
  private _dragListenersAttached = false;
  private _drag: DriveDrag | null = null;
  private _prevControlsEnabled = true;
  /** Mouse is over a handle (not dragging) — drives the grab cursor. */
  private _hoverHandle = false;
  /** Object hover suppressed while the pointer is over a handle. */
  private _hoverSuppressed = false;

  init(viewer: RVViewer): void {
    this.viewer = viewer;
    // Own raycaster must have the overlay layer enabled or pickHandle misses.
    // Permanent (no listener, no scene object) — set up once, never in attach.
    this._raycaster.layers.enable(HIGHLIGHT_OVERLAY_LAYER);
    this.attachRuntime();
  }

  onModelCleared(): void {
    this._lastSnap = null;
    this.clearAll();
  }

  /**
   * User switched the plugin off (plan-436). Everything `init()` installed goes
   * — a running drag, the global pointer/keyboard listeners, the drag-driver
   * and overlay-visibility subscriptions, the selection subscription and the
   * gizmos themselves.
   *
   * `this.shared` deliberately survives: those geometries/materials are freed
   * in `dispose()` and ONLY there (plan-249 §10.2). Disposing them here would
   * leave every gizmo rebuilt after a switch-on pointing at dead GPU buffers.
   */
  onDeactivate(): void {
    this.detachRuntime();
  }

  /**
   * User switched the plugin back on (plan-436). With `onActivate` present the
   * host replays NO `onModelLoaded` (plan-435 invariant 2), and a
   * `selection-changed` event does not repeat itself for an unchanged
   * selection — so the visible state has to be PULLED.
   *
   * It goes through `onSelection`, not `applySelection`: only `onSelection`
   * re-evaluates the visibility gates (`showDriveAxisGizmo`, `_catHidden`), and
   * `_lastSnap` is unusable as a source because the subscription was off while
   * the selection may well have changed (plan-436 §2.2).
   */
  onActivate(viewer: RVViewer): void {
    this.viewer = viewer;
    this.attachRuntime();
    const snap = viewer.selectionManager?.getSnapshot();
    if (snap) this.onSelection(snap);
  }

  dispose(): void {
    this.detachRuntime();
    if (this.shared) {
      // Shared resources are freed here and ONLY here (plan-249 §10.2).
      this.shared.shaftGeo.dispose();
      this.shared.tipGeo.dispose();
      this.shared.ringGeo.dispose();
      this.shared.lineGeo.dispose();
      this.shared.tickGeo.dispose();
      this.shared.dotGeo.dispose();
      this.shared.material.dispose();
      this.shared.materialDim.dispose();
      this.shared.lineMaterial.dispose();
      this.shared.pickerCylGeo.dispose();
      this.shared.pickerTorusGeo.dispose();
      this.shared.pickerMat.dispose();
      this.shared = null;
    }
    this._lastSnap = null;
    this.viewer = null;
  }

  onRender(): void {
    const viewer = this.viewer;
    if (!viewer) return;
    // AND the settings toggle with the 'gizmos' overlay category (plan-250).
    const show = viewer.showDriveAxisGizmo && !this._catHidden;
    if (show !== this._appliedShow) {
      // Reactive settings toggle: rebuild/clear the current selection's gizmos.
      this._appliedShow = show;
      if (!show) this.clearAll();
      else if (this._lastSnap) this.applySelection(this._lastSnap);
    }
    if (!show || this.entries.size === 0) return;

    const now = performance.now();
    for (const [path, mapped] of this.entries) {
      let entry = mapped;
      // Live-edit support (plan-249 §10.4): the axis DIRECTION is re-read from
      // `getAxis()` every frame (reapplyConfig changes show immediately); a
      // kind/limits/offset change additionally needs a shape rebuild.
      if (cfgKeyFor(entry.drive) !== entry.cfgKey) {
        this.removeEntry(entry);
        entry = this.buildEntry(entry.drive);
        this.entries.set(path, entry);
      }
      const node = entry.drive.node;
      const parent = node.parent;
      // Null-parent guard (plan-249 §10.1): re-parenting (kinematic
      // attach/detach) can momentarily leave the node parentless — skip the
      // frame instead of crashing; do NOT dispose the gizmo.
      if (!parent) {
        entry.group.visible = false;
        continue;
      }
      entry.group.visible = true;

      // Position: drive node's world position (rotation centre = node origin).
      // Read matrixWorld directly — frozen static ancestors have it baked.
      this._pos.setFromMatrixPosition(node.matrixWorld);
      entry.group.position.copy(this._pos);

      // Orientation: world axis = parentWorldQuat ⊗ baseQuat ⊗ localAxis, where
      // baseQuat is the node's home local orientation. Both linear and rotary
      // drives act in the object's OWN local frame (linear = Space.Self motion,
      // rotary = home · delta), so both compose the home quaternion.
      parent.matrixWorld.decompose(this._parentPos, this._parentQuat, this._parentScl);
      const baseQuat = entry.drive.getHomeLocalQuaternion(this._baseQuat);
      entry.drive.getAxis(this._localAxis);
      if (this._localAxis.lengthSq() < AXIS_EPS) {
        // Direction may have been live-edited to Virtual — hide, don't crash.
        entry.group.visible = false;
        continue;
      }
      // three >= 0.171 handles the antiparallel (180°) case internally —
      // no manual special-case needed (plan-249 §10.7).
      if (entry.kind === 'rotary') {
        // Rotary: compose the FULL home-frame orientation (deterministic
        // twist) so ring angles are meaningful — limits arc and current-angle
        // dot are parameterized in the home frame; the twist that
        // setFromUnitVectors alone picks would be arbitrary.
        this._twistQuat.setFromUnitVectors(UP, this._localAxis);
        entry.group.quaternion
          .copy(this._parentQuat).multiply(baseQuat).multiply(this._twistQuat);
      } else {
        // Linear: twist around the axis is irrelevant (rotationally
        // symmetric arrow) — the home-composed direction alone suffices.
        resolveWorldAxis(this._localAxis, this._parentQuat, baseQuat, this._worldAxis);
        entry.group.quaternion.setFromUnitVectors(UP, this._worldAxis);
      }

      // Scale: screen-constant cap (FOV/zoom-correct) so the gizmo never gets
      // too big; object-relative base size only shrinks it below the cap for
      // small parts. clamp(base, floor, cap) = screen-capped + stays visible.
      const cam = viewer.camera;
      const dist = cam.position.distanceTo(entry.group.position);
      const vwh = (cam as OrthographicCamera).isOrthographicCamera
        ? ((cam as OrthographicCamera).top - (cam as OrthographicCamera).bottom)
            / (cam as OrthographicCamera).zoom
        : perspectiveViewportWorldHeight((cam as PerspectiveCamera).fov, dist);
      let s = MathUtils.clamp(entry.baseScale, minGizmoScale(vwh), computeGizmoScale(vwh));

      // Editor authoring: nothing is moving, so the gizmo is the primary cue for
      // the drive axis — draw it twice as large as in live modes.
      if (viewer.modes?.activeMode === 'editor') s *= EDITOR_GIZMO_SCALE;

      // Motion pulse: subtle scale breathing while the drive is running.
      // Only active while moving — the sim is rendering frames then anyway.
      const d = entry.drive;
      if (d.isRunning || d.jogForward || d.jogBackward) {
        s *= 1 + PULSE_AMP * Math.sin(now * PULSE_FREQ);
      }
      entry.group.scale.setScalar(s);

      // Linear travel limits: end-stop washers at their TRUE world offsets
      // relative to the node (the gizmo centre IS the current position, so
      // the disks slide past it as the drive travels). Divide by the group
      // scale so the disks stay put while the arrow pulses/clamps.
      if (entry.tickLower && entry.tickUpper) {
        const perUnit = this._scaleVec.copy(this._localAxis).multiply(this._parentScl).length();
        const yLower = (d.positionToLocalOffset(d.LowerLimit - d.currentPosition) * perUnit) / s;
        const yUpper = (d.positionToLocalOffset(d.UpperLimit - d.currentPosition) * perUnit) / s;
        entry.tickLower.position.y = yLower;
        entry.tickUpper.position.y = yUpper;
        entry.tickLower.visible = Math.abs(yLower) <= MAX_TICK_Y;
        entry.tickUpper.visible = Math.abs(yUpper) <= MAX_TICK_Y;
      }

      // Rotary current-angle dot on the ring (home frame = ring zero; the
      // node's delta rotation about the axis equals the ring parameter θ).
      if (entry.posDot) {
        const theta = MathUtils.degToRad(d.currentPosition + d.Offset);
        entry.posDot.position.set(
          RING_RADIUS * Math.cos(theta), RING_RADIUS * Math.sin(theta), 0);
      }
    }
  }

  // ── Selection → gizmos ──────────────────────────────────────────────

  private onSelection(snap: SelectionSnapshot): void {
    this._lastSnap = snap;
    if (!this.viewer) return;
    if (!this.viewer.showDriveAxisGizmo || this._catHidden) {
      this._appliedShow = false;
      this.clearAll();
      return;
    }
    this.applySelection(snap);
  }

  private applySelection(snap: SelectionSnapshot): void {
    const viewer = this.viewer;
    const reg = viewer?.registry;
    if (!viewer || !reg) return;

    // Resolve the wanted set of drives (deduped by canonical drive path).
    const wanted = new Map<string, DriveGizmoSource>();
    for (const path of snap.selectedPaths) {
      const hit = this.resolveDrive(reg, path);
      if (!hit) continue;
      // Virtual drives (zero axis) never get a gizmo (F11).
      if (hit.drive.getAxis(this._localAxis).lengthSq() < AXIS_EPS) continue;
      wanted.set(hit.path, hit.drive);
    }

    // Partial deselect: remove ONLY the entries that dropped out (F8).
    for (const [path, entry] of this.entries) {
      if (!wanted.has(path)) {
        this.removeEntry(entry); // shared resources stay alive (§10.2)
        this.entries.delete(path);
      }
    }
    // Build gizmos for newly selected drives.
    for (const [path, drive] of wanted) {
      if (!this.entries.has(path)) {
        this.entries.set(path, this.buildEntry(drive));
      }
    }
  }

  /**
   * Resolve the Drive for a selected path: exact `getByPath('Drive', path)`
   * first; otherwise a subtree descent that stops at nested Drive boundaries
   * and only succeeds when EXACTLY ONE drive is found (plan-249 §10.3). When no
   * LIVE drive exists (asset-editor authoring mode), fall back to a source built
   * from the node's rv_extras Drive config so the gizmo still renders.
   */
  private resolveDrive(reg: NodeRegistry, path: string): { path: string; drive: DriveGizmoSource } | null {
    const exact = reg.getByPath<RVDrive>('Drive', path);
    if (exact) {
      return { path: reg.getPathForNode(exact.node) ?? path, drive: exact };
    }
    const node = reg.getNode(path);
    if (node) {
      const found: { path: string; drive: RVDrive }[] = [];
      this.collectBoundaryDrives(reg, node, found);
      if (found.length === 1) return found[0];
    }
    const authored = resolveDriveGizmoFallback(path);
    if (authored) {
      return { path: reg.getPathForNode(authored.node) ?? path, drive: authored };
    }
    return null;
  }

  /** Depth-first descent collecting drives, NOT descending past a node that
   *  itself carries a Drive (nested-drive boundary — `findAllInChildren`
   *  does not stop there, so this is a dedicated traversal). Bails early
   *  once more than one drive is found. */
  private collectBoundaryDrives(reg: NodeRegistry, node: Object3D, out: { path: string; drive: RVDrive }[]): void {
    for (const child of node.children) {
      if (out.length > 1) return;
      const path = reg.getPathForNode(child);
      const drive = path ? reg.getByPath<RVDrive>('Drive', path) : null;
      if (path && drive) {
        out.push({ path, drive });
        continue; // boundary: don't descend into a nested drive's subtree
      }
      this.collectBoundaryDrives(reg, child, out);
    }
  }

  // ── Gizmo construction ──────────────────────────────────────────────

  private ensureShared(): SharedResources {
    if (this.shared) return this.shared;
    const material = new MeshBasicMaterial({
      color: DRIVE_GIZMO_COLOR,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
    });
    const materialDim = material.clone();
    materialDim.opacity = DIM_OPACITY;
    const lineGeo = new BufferGeometry().setFromPoints([
      new Vector3(0, -AXIS_LINE_LEN / 2, 0),
      new Vector3(0, AXIS_LINE_LEN / 2, 0),
    ]);
    // lineDistance is a geometry attribute — compute once, all Lines share it.
    new Line(lineGeo).computeLineDistances();
    this.shared = {
      shaftGeo: new CylinderGeometry(SHAFT_RADIUS, SHAFT_RADIUS, SHAFT_LEN, 12),
      tipGeo: new ConeGeometry(TIP_RADIUS, TIP_LEN, 16),
      ringGeo: new TorusGeometry(RING_RADIUS, RING_TUBE, 8, 48, RING_ARC),
      lineGeo,
      tickGeo: new CylinderGeometry(TICK_RADIUS, TICK_RADIUS, TICK_THICKNESS, 24),
      dotGeo: new SphereGeometry(DOT_RADIUS, 12, 8),
      material,
      materialDim,
      lineMaterial: new LineDashedMaterial({
        color: DRIVE_GIZMO_COLOR,
        dashSize: AXIS_DASH_SIZE,
        gapSize: AXIS_GAP_SIZE,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
        depthWrite: false,
      }),
      // Fat invisible pickers: generous radius so the thin arrow/ring is easy
      // to grab. opacity 0 (still raycastable); depthTest off (overlay layer).
      pickerCylGeo: new CylinderGeometry(PICKER_SHAFT_RADIUS, PICKER_SHAFT_RADIUS, PICKER_SHAFT_LEN, 12),
      pickerTorusGeo: new TorusGeometry(RING_RADIUS, PICKER_RING_TUBE, 8, 32),
      pickerMat: new MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false, depthWrite: false }),
    };
    return this.shared;
  }

  private buildEntry(drive: DriveGizmoSource): DriveGizmoEntry {
    const kind: 'linear' | 'rotary' = drive.isRotary ? 'rotary' : 'linear';
    const parts = kind === 'rotary' ? this.buildRotary(drive) : this.buildLinear(drive);
    const group = parts.group;
    group.name = '__rvDriveAxisGizmo';

    // Overlay layer + render order on EVERY child (F6): rendered after the
    // EffectComposer so toon outlines / AO / bloom never touch the gizmo.
    // Raycasting is deliberately NOT enabled for this layer (purely passive).
    group.traverse((o) => {
      o.renderOrder = GIZMO_RENDER_ORDER;
      o.layers.set(HIGHLIGHT_OVERLAY_LAYER);
    });

    // AABB base size — computed once here, never per frame (plan-249 §10.8).
    const { size } = computeSubtreeAABB(drive.node);
    const maxDim = Math.max(size.x, size.y, size.z);
    const baseScale = Math.max(maxDim * BBOX_SCALE, 0.05);

    group.visible = false; // becomes visible on first onRender sync
    this.viewer!.scene.add(group);
    return { ...parts, drive, kind, baseScale, cfgKey: cfgKeyFor(drive) };
  }

  /** Double arrow along local +Y/-Y (the group quaternion maps Y → world axis).
   *  The +Y tip is solid (positive drive direction), the -Y tip is dimmed.
   *  With UseLimits, two end-stop washer disks mark the travel range —
   *  positioned per frame at their true world offsets (`onRender`). */
  private buildLinear(drive: DriveGizmoSource): GizmoParts {
    const r = this.ensureShared();
    const g = new Group();
    const shaft = new Mesh(r.shaftGeo, r.material);
    const tipUp = new Mesh(r.tipGeo, r.material);
    tipUp.position.y = SHAFT_LEN / 2 + TIP_LEN / 2;
    const tipDown = new Mesh(r.tipGeo, r.materialDim);
    tipDown.position.y = -(SHAFT_LEN / 2 + TIP_LEN / 2);
    tipDown.rotation.z = Math.PI;
    g.add(shaft, tipUp, tipDown, this.makePicker(r.pickerCylGeo, 'linear'));

    let tickLower: Mesh | null = null;
    let tickUpper: Mesh | null = null;
    if (drive.UseLimits) {
      tickLower = new Mesh(r.tickGeo, r.materialDim);
      tickLower.name = '__rvDriveLimitTick';
      tickUpper = new Mesh(r.tickGeo, r.material);
      tickUpper.name = '__rvDriveLimitTick';
      g.add(tickLower, tickUpper);
    }
    return { group: g, tickLower, tickUpper, posDot: null, ownedRingGeo: null };
  }

  /** Dashed axis centreline + rotation ring (arc < 2π) + tangential direction
   *  arrow + current-angle dot. Ring plane ⊥ local Y; CCW sweep = positive
   *  rotation about the axis (right-hand rule), so the arrow shows the
   *  positive drive direction. With UseLimits the arc is clamped to the
   *  [LowerLimit, UpperLimit] range (instance-owned geometry). */
  private buildRotary(drive: DriveGizmoSource): GizmoParts {
    const r = this.ensureShared();
    const g = new Group();
    const line = new Line(r.lineGeo, r.lineMaterial); // dashed CAD-style centreline
    g.add(line);

    // TorusGeometry lies in its local XY plane (normal +Z) — rotate the ring
    // subgroup so that normal aligns with the group's +Y axis. Ring parameter
    // θ then equals a positive (right-hand) rotation about the drive axis in
    // the node's home frame (the group orientation composes base + twist).
    const ringGrp = new Group();
    ringGrp.quaternion.setFromUnitVectors(Z_AXIS, UP);

    let startRad = 0;
    let endRad = RING_ARC;
    let ringGeo: TorusGeometry = r.ringGeo;
    let ownedRingGeo: TorusGeometry | null = null;
    if (drive.UseLimits) {
      startRad = MathUtils.degToRad(drive.LowerLimit + drive.Offset);
      endRad = MathUtils.degToRad(drive.UpperLimit + drive.Offset);
      const span = MathUtils.clamp(endRad - startRad, 0.1, Math.PI * 2);
      endRad = startRad + span;
      ownedRingGeo = new TorusGeometry(RING_RADIUS, RING_TUBE, 8, 48, span);
      ringGeo = ownedRingGeo;
    }
    const ring = new Mesh(ringGeo, r.material);
    ring.rotation.z = startRad; // arc spans [startRad, endRad]
    ringGrp.add(ring);

    // Arrow tip at the arc end (positive rotation limit / open 300° end),
    // oriented along the CCW tangent.
    const endCos = Math.cos(endRad);
    const endSin = Math.sin(endRad);
    const tip = new Mesh(r.tipGeo, r.material);
    tip.position.set(RING_RADIUS * endCos, RING_RADIUS * endSin, 0);
    tip.quaternion.setFromUnitVectors(UP, new Vector3(-endSin, endCos, 0));
    ringGrp.add(tip);

    // Current-angle dot — position synced per frame in onRender.
    const posDot = new Mesh(r.dotGeo, r.material);
    posDot.name = '__rvDrivePosDot';
    ringGrp.add(posDot);

    // Fat torus picker in the ring plane (full 360° so the whole ring grabs).
    ringGrp.add(this.makePicker(r.pickerTorusGeo, 'rotary'));

    g.add(ringGrp);
    return { group: g, tickLower: null, tickUpper: null, posDot, ownedRingGeo };
  }

  /** An invisible, raycastable drag handle tagged with its kind. Excluded from
   *  the shared RaycastManager (`_highlightOverlay`) so it never affects normal
   *  hover/selection; only this plugin's own raycaster (overlay layer enabled)
   *  hits it. */
  private makePicker(geo: CylinderGeometry | TorusGeometry, kind: 'linear' | 'rotary'): Mesh {
    const m = new Mesh(geo, this.ensureShared().pickerMat);
    m.name = '__rvDriveGizmoPicker';
    m.userData.driveGizmoHandle = kind;
    m.userData._highlightOverlay = true;
    return m;
  }

  /** Remove one gizmo from the scene. Shared geometries/materials stay alive
   *  (§10.2) — only the instance-owned limit-arc geometry is disposed. */
  private removeEntry(entry: DriveGizmoEntry): void {
    entry.group.removeFromParent();
    entry.ownedRingGeo?.dispose();
    entry.ownedRingGeo = null;
  }

  private clearAll(): void {
    for (const entry of this.entries.values()) this.removeEntry(entry);
    this.entries.clear();
  }

  // ── Attach / detach (ONE path, shared by init/dispose and the toggle) ──

  /**
   * Install every subscription and listener the plugin runs on. Idempotent —
   * each existing handle is released before it is replaced, so repeated
   * off/on cycles can never double a subscription (plan-436 F5).
   *
   * `ensureShared()` is deliberately NOT called here: the shared geometries
   * survive a deactivation and are (re)created lazily by `buildEntry()`.
   */
  private attachRuntime(): void {
    const viewer = this.viewer;
    if (!viewer) return;
    this.unsub?.();
    this.unsub = viewer.on('selection-changed', (s) => this.onSelection(s));
    // Overlay-visibility gate (plan-250): react to the 'gizmos' category being
    // switched off in the Display panel. onRender's change-detection then
    // clears/rebuilds the current selection's gizmos. The cached flag is
    // re-read here because the store can have moved while we were off.
    this._catHidden = !isOverlayVisible('gizmos');
    this.offOverlay?.();
    this.offOverlay = subscribeOverlayVisibility(() => {
      this._catHidden = !isOverlayVisible('gizmos');
      viewer.markRenderDirty?.();
    });
    // Attach drag listeners only while a drag driver is registered (editor mode).
    this._syncDragListeners();
    this._dragUnsub?.();
    this._dragUnsub = subscribeDriveDragDriver(() => this._syncDragListeners());
  }

  /**
   * Release everything {@link attachRuntime} installed, plus the gizmos in the
   * scene. Shared by `dispose()` and the user toggle. It does NOT touch
   * `this.shared` — see the note on {@link onDeactivate}.
   */
  private detachRuntime(): void {
    this._cancelDrag();
    this._teardownDragListeners();
    this._dragUnsub?.();
    this._dragUnsub = null;
    this.clearAll();
    this.unsub?.();
    this.unsub = null;
    this.offOverlay?.();
    this.offOverlay = null;
  }

  // ── Drag interaction (editor drive-motion preview) ─────────────────────
  //
  // Mirrors the TransformGizmo pattern: capture-phase window pointer listeners
  // (attached only while a drag driver is registered — i.e. editor mode), a
  // private raycaster against the invisible picker meshes, orbit suppressed for
  // the drag, and the projected drag amount handed to the injected driver which
  // owns the actual scene preview + spring-back. The gizmo itself moves nothing.

  /** True while a drag is in progress — the editor's onCanvasPointerDown checks
   *  this (via the driver) so a handle grab never starts a marquee/selection. */
  get isEngaged(): boolean {
    return this._drag !== null;
  }

  private _syncDragListeners(): void {
    const want = !!getDriveDragDriver();
    if (want === this._dragListenersAttached) return;
    if (want) {
      window.addEventListener('pointerdown', this._onPointerDown, true);
      window.addEventListener('pointermove', this._onPointerMove, true);
      window.addEventListener('pointerup', this._onPointerUp, true);
      window.addEventListener('keydown', this._onKeyDown, true);
    } else {
      this._cancelDrag();
      this._teardownDragListeners();
    }
    this._dragListenersAttached = want;
  }

  private _teardownDragListeners(): void {
    window.removeEventListener('pointerdown', this._onPointerDown, true);
    window.removeEventListener('pointermove', this._onPointerMove, true);
    window.removeEventListener('pointerup', this._onPointerUp, true);
    window.removeEventListener('keydown', this._onKeyDown, true);
    this._dragListenersAttached = false;
    // Never leave the grab cursor or suppressed hover behind.
    this._hoverHandle = false;
    this._setHoverSuppressed(false);
    const el = this.viewer?.renderer?.domElement;
    if (el) el.style.cursor = '';
  }

  private readonly _onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || this._drag) return;
    const driver = getDriveDragDriver();
    if (!driver || driver.isBlocked?.()) return; // yield to the transform gizmo
    if (!this._withinCanvas(e)) return;
    const hit = this._pickHandle(e);
    if (!hit) return;
    // Claim the gesture: block orbit, marquee, and click-select.
    e.stopImmediatePropagation();
    e.preventDefault();
    this._beginDrag(e, hit.entry, hit.kind);
  };

  private readonly _onPointerMove = (e: PointerEvent): void => {
    const viewer = this.viewer;
    if (!viewer) return;
    const drag = this._drag;
    if (!drag) { this._updateHover(e); return; }
    e.stopImmediatePropagation();
    e.preventDefault();
    this._setNdc(e);
    this._raycaster.setFromCamera(this._ndc, viewer.camera);
    const ray = this._raycaster.ray;
    let p: number;
    if (drag.kind === 'linear') {
      const s = this._closestOnAxis(drag.center, drag.worldAxis, ray.origin, ray.direction);
      const deltaMm = drag.worldPerMm !== 0 ? (s - drag.grab) / drag.worldPerMm : 0;
      p = drag.homeP + deltaMm;
    } else {
      const ptr = Math.atan2(e.clientY - drag.centerPx[1], e.clientX - drag.centerPx[0]);
      let inc = ptr - drag.lastPtrAngle;
      if (inc > Math.PI) inc -= 2 * Math.PI; else if (inc < -Math.PI) inc += 2 * Math.PI;
      drag.accumAngle += inc;
      drag.lastPtrAngle = ptr;
      p = drag.homeP + MathUtils.radToDeg(drag.rotSign * drag.accumAngle);
    }
    if (drag.source.UseLimits) p = MathUtils.clamp(p, drag.source.LowerLimit, drag.source.UpperLimit);
    drag.lastP = p;
    getDriveDragDriver()?.preview({ viewer, source: drag.source, node: drag.node, position: p });
  };

  private readonly _onPointerUp = (e: PointerEvent): void => {
    const drag = this._drag;
    const viewer = this.viewer;
    if (!drag || !viewer || e.button !== 0) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    getDriveDragDriver()?.release({ viewer, source: drag.source, node: drag.node, position: drag.lastP });
    this._endDrag();
  };

  private readonly _onKeyDown = (e: KeyboardEvent): void => {
    if (this._drag && e.key === 'Escape') {
      e.stopImmediatePropagation();
      this._cancelDrag();
    }
  };

  private _pickHandle(e: PointerEvent): { entry: DriveGizmoEntry; kind: 'linear' | 'rotary' } | null {
    const viewer = this.viewer;
    if (!viewer) return null;
    this._setNdc(e);
    this._raycaster.setFromCamera(this._ndc, viewer.camera);
    for (const entry of this.entries.values()) {
      if (!entry.group.visible) continue;
      entry.group.updateMatrixWorld(true);
      for (const hit of this._raycaster.intersectObject(entry.group, true)) {
        const kind = hit.object.userData?.driveGizmoHandle as 'linear' | 'rotary' | undefined;
        if (kind) return { entry, kind };
      }
    }
    return null;
  }

  private _beginDrag(e: PointerEvent, entry: DriveGizmoEntry, kind: 'linear' | 'rotary'): void {
    const viewer = this.viewer!;
    const group = entry.group;
    group.updateMatrixWorld(true);
    const source = entry.drive;
    const node = source.node;
    const center = group.getWorldPosition(new Vector3());
    // The gizmo group's world +Y IS the drive's world motion/rotation axis
    // (linear: setFromUnitVectors(UP, worldAxis); rotary: base⊗twist maps Y→axis).
    const worldAxis = new Vector3(0, 1, 0)
      .applyQuaternion(group.getWorldQuaternion(new Quaternion())).normalize();
    this._setNdc(e);
    this._raycaster.setFromCamera(this._ndc, viewer.camera);
    const ray = this._raycaster.ray;

    const drag: DriveDrag = {
      source, node, kind, worldAxis, center,
      homeP: source.currentPosition, lastP: source.currentPosition, pointerId: e.pointerId,
      grab: 0, worldPerMm: source.positionToLocalOffset(1),
      centerPx: [0, 0], lastPtrAngle: 0, accumAngle: 0, rotSign: 1,
    };
    if (kind === 'linear') {
      drag.grab = this._closestOnAxis(center, worldAxis, ray.origin, ray.direction);
      // World metres per mm of drive position: local-offset-per-mm × parent world
      // scale along the axis (so drives under a scaled parent still track 1:1).
      let scaleAlongAxis = 1;
      const parent = node.parent;
      if (parent) {
        const axisInParent = source.getAxis(new Vector3())
          .applyQuaternion(source.getHomeLocalQuaternion(new Quaternion()));
        const len = axisInParent.length();
        if (len > AXIS_EPS) {
          axisInParent.applyMatrix3(new Matrix3().setFromMatrix4(parent.matrixWorld));
          scaleAlongAxis = axisInParent.length() / len;
        }
      }
      drag.worldPerMm = source.positionToLocalOffset(1) * scaleAlongAxis;
    } else {
      this._screenOf(center, drag.centerPx);
      drag.lastPtrAngle = Math.atan2(e.clientY - drag.centerPx[1], e.clientX - drag.centerPx[0]);
      // Sign so a CW screen drag reads as a positive rotation from the viewed face.
      const toCam = this._scaleVec.subVectors(viewer.camera.position, center);
      drag.rotSign = worldAxis.dot(toCam) >= 0 ? -1 : 1;
    }

    this._drag = drag;
    this._prevControlsEnabled = viewer.controls?.enabled ?? true;
    if (viewer.controls) viewer.controls.enabled = false;
    viewer.renderer.domElement.style.cursor = 'grabbing';
    try { viewer.renderer.domElement.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }

  private _cancelDrag(): void {
    const drag = this._drag;
    const viewer = this.viewer;
    if (drag && viewer) {
      getDriveDragDriver()?.cancel({ viewer, source: drag.source, node: drag.node, position: drag.homeP });
    }
    this._endDrag();
  }

  private _endDrag(): void {
    const drag = this._drag;
    const viewer = this.viewer;
    this._drag = null;
    if (!drag || !viewer) return; // nothing was grabbed — don't touch the canvas
    if (viewer.controls) viewer.controls.enabled = this._prevControlsEnabled;
    viewer.renderer.domElement.style.cursor = '';
    // Re-detect hover on the next move (may still be over the handle).
    this._hoverHandle = false;
    this._setHoverSuppressed(false);
    try { viewer.renderer.domElement.releasePointerCapture(drag.pointerId); } catch { /* ignore */ }
  }

  /** Hover feedback while NOT dragging: grab cursor + suppress object hover so
   *  the gizmo reads as the thing under the pointer, not the object behind it. */
  private _updateHover(e: PointerEvent): void {
    const viewer = this.viewer;
    if (!viewer) return;
    const over = this._withinCanvas(e) && this._pickHandle(e) !== null;
    if (over === this._hoverHandle) return;
    this._hoverHandle = over;
    viewer.renderer.domElement.style.cursor = over ? 'grab' : '';
    this._setHoverSuppressed(over);
  }

  /** Toggle the shared raycast-manager hover detection (also clears any current
   *  object hover when disabling). Tracked so we never leave it stuck off. */
  private _setHoverSuppressed(on: boolean): void {
    if (on === this._hoverSuppressed) return;
    this._hoverSuppressed = on;
    this.viewer?.raycastManager?.setEnabled(!on);
  }

  private _withinCanvas(e: PointerEvent): boolean {
    const r = this.viewer!.renderer.domElement.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  }

  private _setNdc(e: PointerEvent): void {
    const r = this.viewer!.renderer.domElement.getBoundingClientRect();
    this._ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  /** Project a world position to client-pixel coordinates. */
  private _screenOf(world: Vector3, out: [number, number]): [number, number] {
    const r = this.viewer!.renderer.domElement.getBoundingClientRect();
    this._scaleVec.copy(world).project(this.viewer!.camera);
    out[0] = r.left + (this._scaleVec.x * 0.5 + 0.5) * r.width;
    out[1] = r.top + (-this._scaleVec.y * 0.5 + 0.5) * r.height;
    return out;
  }

  /** Parameter of the closest point on `axisO + t·axisD` to the given ray. */
  private _closestOnAxis(axisO: Vector3, axisD: Vector3, rayO: Vector3, rayD: Vector3): number {
    this._scaleVec.subVectors(axisO, rayO);
    const b = axisD.dot(rayD), c = rayD.dot(rayD), d = axisD.dot(this._scaleVec), e2 = rayD.dot(this._scaleVec);
    const denom = c - b * b;
    return denom !== 0 ? (b * e2 - c * d) / denom : 0;
  }
}

/** Shape-relevant config snapshot — changing any of these (live edit /
 *  undo-redo via reapplyConfig) rebuilds the gizmo on the next frame. */
function cfgKeyFor(drive: DriveGizmoSource): string {
  return `${drive.isRotary ? 'r' : 'l'}|${drive.UseLimits ? 1 : 0}|${drive.LowerLimit}|${drive.UpperLimit}|${drive.Offset}`;
}
