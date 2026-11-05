// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * bbox-snap.ts — Magnetic bounding-box snap for the Layout Planner.
 *
 * Aligns the moving object's world AABB edges & center to other placed
 * objects' AABB edges & center. Axis-independent (X and Z snap separately).
 *
 * Lifecycle (per drag):
 *   1. armForDrag(movingRoot)      — capture moving AABB + freeze target AABBs
 *   2. applySnap(nx, nz, axisLock) — called per pointer-move, returns adjusted x/z
 *   3. disarm()                    — clear state, hide visual guides
 *
 * The controller is "always wired" to the FloorGizmo via a custom-snap
 * callback. It self-checks whether snap is enabled (store.bboxSnapEnabled)
 * and whether Alt is held (live keyboard listener), so the gizmo doesn't
 * need to know about either.
 *
 * Visualization: two pre-allocated dashed LineSegments on the floor plane
 * (one blue for X-axis alignment, one red for Z-axis alignment). They
 * extend between the moving and target bboxes with a small overshoot, plus
 * a perpendicular tick at the contact point.
 */

import {
  Box3,
  CanvasTexture,
  LinearFilter,
  Sprite,
  SpriteMaterial,
  type Object3D,
  type Scene,
} from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { markAsOverlay } from '../../core/engine/rv-group-registry';

import type { LayoutStore } from './rv-layout-store';

// ─── Types ──────────────────────────────────────────────────────────────

/** Axis lock for the active drag handle. */
export type SnapAxisLock = 'free' | 'x' | 'z';

/** Cardinal direction for neighbor-distance overlay. */
type NeighborDir = 'xMinus' | 'xPlus' | 'zMinus' | 'zPlus';
const NEIGHBOR_DIRS: readonly NeighborDir[] = ['xMinus', 'xPlus', 'zMinus', 'zPlus'];

/** Result of an applySnap() call. */
export interface SnapResult {
  /** Adjusted X (== input nx if !snappedX). */
  x: number;
  /** Adjusted Z (== input nz if !snappedZ). */
  z: number;
  /** True when X was magnetised to a target. */
  snappedX: boolean;
  /** True when Z was magnetised to a target. */
  snappedZ: boolean;
}

/** Custom-snap callback signature consumed by FloorGizmo. */
export type CustomSnapFn = (
  nx: number,
  nz: number,
  axisLock: SnapAxisLock,
) => SnapResult | null;

// ─── Internal frozen-target representation ─────────────────────────────

interface FrozenTarget {
  minX: number;
  maxX: number;
  cX: number;
  minZ: number;
  maxZ: number;
  cZ: number;
}

// ─── Snap math ─────────────────────────────────────────────────────────

/**
 * Find the best snap candidate on a single axis.
 *
 * Compares the moving object's three reference points (min/center/max) on
 * the given axis against each target's same three points. Returns the
 * smallest displacement within tolerance, plus the matched target index
 * and which moving/target line was used (for visualisation).
 *
 * Pure function — exported for unit testing.
 */
export function findBestAxisSnap(
  movingMin: number,
  movingCenter: number,
  movingMax: number,
  targetsMin: ArrayLike<number>,
  targetsCenter: ArrayLike<number>,
  targetsMax: ArrayLike<number>,
  targetCount: number,
  toleranceM: number,
  /** Include bbox centres (mid) as valid refs on both moving and target sides. */
  includeMid = true,
  /** Include bbox edges (min/max) as valid refs on both moving and target sides. */
  includeSide = true,
): {
  delta: number;
  snapped: boolean;
  targetIdx: number;
  /** World coordinate where the snap line is drawn. */
  snapValue: number;
} {
  let bestAbs = Infinity;
  let bestDelta = 0;
  let bestIdx = -1;
  let bestSnapValue = 0;

  // Up to 9 candidate pairs per target: {moving min/center/max} × {target min/center/max}.
  // Mid/Side flags filter which reference points participate on each side. If
  // both flags are off, the function reports `snapped:false`.
  // Keep the loop tight — pre-loaded scalars, no allocations.
  const movingRefs = [movingMin, movingCenter, movingMax];
  const refMask = [includeSide, includeMid, includeSide]; // index 0=min,1=center,2=max

  for (let t = 0; t < targetCount; t++) {
    const tMin = targetsMin[t];
    const tCen = targetsCenter[t];
    const tMax = targetsMax[t];
    const targetVals = [tMin, tCen, tMax];

    for (let mi = 0; mi < 3; mi++) {
      if (!refMask[mi]) continue;
      const mRef = movingRefs[mi];

      for (let ti = 0; ti < 3; ti++) {
        if (!refMask[ti]) continue;
        const tVal = targetVals[ti];
        const d = tVal - mRef;
        const a = Math.abs(d);
        if (a < bestAbs) {
          bestAbs = a; bestDelta = d; bestIdx = t; bestSnapValue = tVal;
        }
      }
    }
  }

  return {
    delta: bestDelta,
    snapped: bestAbs <= toleranceM,
    targetIdx: bestIdx,
    snapValue: bestSnapValue,
  };
}

// ─── Visualization helpers ─────────────────────────────────────────────

const COLOR_SNAP = 0x404040;   // dark grey
const LINE_WIDTH_PX = 1;       // pixel-space thickness via LineMaterial (Line2)
const LINE_OVERSHOOT_M = 0.25; // extend snap line a quarter metre past each bbox
const TICK_HALF_M = 0.06;      // perpendicular tick half-length at contact point
const FLOOR_LIFT_M = 0.002;    // float lines just above the floor to avoid Z-fight

/**
 * Non-degenerate, far-away seed positions. 3 segments × 2 endpoints × 3 floats
 * = 18 floats. Each segment has start ≠ end so the LineMaterial vertex shader
 * can compute a valid screen-space perpendicular without producing NaN — a
 * degenerate seed (all zeros) on some GPUs / drivers leaves a small black
 * pixel-space quad at world origin even when `visible=false`, because the
 * shader divides by `length(end - start) == 0` and the resulting NaN can
 * leak through to gl_Position. Anchored at -1e6 in all axes so the segments
 * land far outside any normal scene's frustum even if rendered.
 */
const _SEED_POS = (() => {
  const FAR = -1_000_000;
  const arr = new Array<number>(18);
  for (let i = 0; i < 3; i++) {
    arr[i * 6 + 0] = FAR;       // start.x
    arr[i * 6 + 1] = FAR;       // start.y
    arr[i * 6 + 2] = FAR;       // start.z
    arr[i * 6 + 3] = FAR + 1;   // end.x  (start ≠ end → no NaN in shader)
    arr[i * 6 + 4] = FAR;       // end.y
    arr[i * 6 + 5] = FAR;       // end.z
  }
  return arr;
})();

// ─── Neighbor-distance overlay (4-direction during drag) ──────────────

/** Dark slate: reads on the light floor (the old light grey 0x9aa8b6 was
 *  barely visible) and still defers to the coloured snap guides. */
const COLOR_NEIGHBOR = 0x2b3440;
/** Slightly thicker than the snap line so the solid dimension reads clearly
 *  against the floor pattern without competing in colour intensity. */
const NEIGHBOR_LINE_WIDTH_PX = 1.5;
const NEIGHBOR_OPACITY = 1;
/** Perpendicular half-tick length at each endpoint (metres). Matches snap-guide ticks. */
const NEIGHBOR_TICK_HALF_M = TICK_HALF_M;
/**
 * World-space label dimensions (metres). We use `sizeAttenuation:true` because
 * three.js's sprite shader leaves `sizeAttenuation:false` unmodified under
 * `OrthographicCamera` (the `isPerspective` branch is bypassed), so it
 * effectively behaves like world-space sizing there anyway — but then a tiny
 * NDC-sized scale shrinks to invisible. World-space sizing also scales
 * naturally with zoom in both modes, which suits the top-down planner view.
 *
 * Canvas is sized to match the world-space aspect ratio so the pill fills it
 * with no transparent letterboxing on the sides.
 */
const LABEL_WIDTH_M  = 0.55;
const LABEL_HEIGHT_M = 0.16;
const LABEL_CANVAS_W = 512;
const LABEL_CANVAS_H = 148; // ≈ 512 × (HEIGHT_M / WIDTH_M) — no letterboxing

const _NEIGHBOR_SEED = (() => {
  // 3 segments × 2 endpoints × 3 floats = 18 (main + 2 ticks).
  const FAR = -1_000_000;
  const arr = new Array<number>(18);
  for (let i = 0; i < 3; i++) {
    arr[i * 6 + 0] = FAR;
    arr[i * 6 + 1] = FAR;
    arr[i * 6 + 2] = FAR;
    arr[i * 6 + 3] = FAR + 1;
    arr[i * 6 + 4] = FAR;
    arr[i * 6 + 5] = FAR;
  }
  return arr;
})();

/**
 * Create a 3-segment dashed neighbor line: the main dimension line plus two
 * perpendicular end ticks (start + end) so the start and end of the
 * measurement are visually obvious. Muted colour keeps the brighter snap
 * guides the primary visual.
 */
function makeNeighborLine(): LineSegments2 {
  const geom = new LineSegmentsGeometry();
  geom.setPositions(_NEIGHBOR_SEED);
  const mat = new LineMaterial({
    color: COLOR_NEIGHBOR,
    linewidth: NEIGHBOR_LINE_WIDTH_PX,
    dashed: false, // solid dimension line for clearer readability
    transparent: true,
    opacity: NEIGHBOR_OPACITY,
    depthTest: false,
    depthWrite: false,
  });
  mat.resolution.set(window.innerWidth, window.innerHeight);
  const line = new LineSegments2(geom, mat);
  line.renderOrder = 10; // below snap lines (11)
  line.frustumCulled = false;
  line.visible = false;
  line.name = '_layoutNeighborGuide';
  markAsOverlay(line); // on-top UI — exclude from SSAO (see snap guide above)
  return line;
}

/**
 * Billboarded "<value> mm" badge for the neighbor lines. Pixel-constant size
 * via sizeAttenuation:false so it stays readable regardless of zoom.
 */
function makeDistanceLabel(): Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = LABEL_CANVAS_W;
  canvas.height = LABEL_CANVAS_H;
  const tex = new CanvasTexture(canvas);
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.anisotropy = 4;
  const mat = new SpriteMaterial({
    map: tex,
    sizeAttenuation: true,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new Sprite(mat);
  sprite.scale.set(LABEL_WIDTH_M, LABEL_HEIGHT_M, 1);
  sprite.renderOrder = 12;
  sprite.frustumCulled = false;
  sprite.visible = false;
  sprite.name = '_layoutNeighborDistance';
  markAsOverlay(sprite); // on-top UI — exclude from SSAO (SpriteMaterial would
                         // otherwise write depth into the GTAO gbuffer)
  return sprite;
}

function paintDistanceLabel(sprite: Sprite, mm: number): void {
  if (!Number.isFinite(mm) || mm < 0) { sprite.visible = false; return; }
  const tex = (sprite.material as SpriteMaterial).map as CanvasTexture | null;
  if (!tex) return;
  const canvas = tex.image as HTMLCanvasElement;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const text = `${Math.round(mm)} mm`;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Pill fills the whole canvas — sprite aspect matches canvas aspect, so
  // the sprite's outline IS the pill and there's no transparent "black
  // letterbox" margin around it. 2px inset keeps the stroke crisp.
  const inset = 2;
  const px = inset;
  const py = inset;
  const pillW = canvas.width  - inset * 2;
  const pillH = canvas.height - inset * 2;
  const r = pillH * 0.5; // fully-rounded ends

  ctx.fillStyle = 'rgba(20, 22, 28, 0.92)';
  ctx.beginPath();
  ctx.moveTo(px + r, py);
  ctx.arcTo(px + pillW, py,         px + pillW, py + pillH, r);
  ctx.arcTo(px + pillW, py + pillH, px,         py + pillH, r);
  ctx.arcTo(px,         py + pillH, px,         py,         r);
  ctx.arcTo(px,         py,         px + pillW, py,         r);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = '#9aa8b6';
  ctx.lineWidth = 3;
  ctx.stroke();

  // Text — auto-fit font size so the value always fills the pill nicely.
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const targetTextWidth = pillW - r * 1.6; // leave room for the rounded caps
  let fontPx = Math.floor(pillH * 0.62);
  ctx.font = `bold ${fontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  let w = ctx.measureText(text).width;
  if (w > targetTextWidth) {
    fontPx = Math.max(24, Math.floor(fontPx * targetTextWidth / w));
    ctx.font = `bold ${fontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  }
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 2);

  tex.needsUpdate = true;
  sprite.visible = true;
}

function makeSnapLine(): LineSegments2 {
  // 3 segments × 2 endpoints × 3 floats = 18 — main alignment line +
  // ticks at the moving edge midpoint and the target edge midpoint.
  const geom = new LineSegmentsGeometry();
  // Seed with a non-degenerate, far-away buffer. setPositions() overwrites
  // it on every snap frame — see _SEED_POS above for why "non-degenerate"
  // matters.
  geom.setPositions(_SEED_POS);
  const mat = new LineMaterial({
    color: COLOR_SNAP,
    linewidth: LINE_WIDTH_PX,
    dashed: true,
    dashSize: 0.08,
    gapSize: 0.05,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    depthWrite: false,
  });
  // Resolution is set per-draw (handles canvas resize without listeners).
  mat.resolution.set(window.innerWidth, window.innerHeight);
  const lines = new LineSegments2(geom, mat);
  lines.renderOrder = 11; // above floor, below FloorGizmo handles
  lines.frustumCulled = false;
  lines.visible = false;
  lines.name = '_layoutSnapGuide';
  // On-top UI (depthTest:false): keep it out of the GTAO/N8AO pass so the
  // dashed guide never casts SSAO halos onto the floor/geometry it overlaps.
  markAsOverlay(lines);
  return lines;
}

// ─── Controller ────────────────────────────────────────────────────────

export interface BboxSnapDeps {
  scene: Scene;
  store: LayoutStore;
  /** Returns the planner's id→Object3D map for ALL placed objects. */
  getAllPlaced: () => Iterable<Object3D>;
  /** Schedule a redraw (snap visuals don't tick on their own). */
  markRenderDirty: () => void;
  /** Tag a node as a viewer sceneFixture so clearModel skips it on every
   *  model switch. The snap guide LineSegments2 are direct children of
   *  `scene` and persist across loads — without this they'd be candidates
   *  for misidentification as a model root by code that diffs
   *  scene.children. */
  markAsFixture: (node: Object3D) => void;
  /** Inverse of `markAsFixture` — call before disposing so the set doesn't
   *  hold a stale reference. */
  unmarkAsFixture: (node: Object3D) => void;
}

/**
 * Per-drag magnetic snap controller. One instance per planner plugin.
 */
export class BboxSnapController {
  private _armed = false;
  private _suppressed = false;

  /** Frozen world AABB of moving root, captured at drag start. */
  private _movingMinX = 0;
  private _movingMaxX = 0;
  private _movingCenX = 0;
  private _movingMinZ = 0;
  private _movingMaxZ = 0;
  private _movingCenZ = 0;

  /** Drag-start position of moving root (used to compute drag delta). */
  private _dragStartPosX = 0;
  private _dragStartPosZ = 0;

  /** Frozen target AABBs (one entry per non-moving placed object). */
  private _targets: FrozenTarget[] = [];
  /** Tight typed arrays mirroring _targets for the hot path. */
  private _txMin = new Float32Array(0);
  private _txCen = new Float32Array(0);
  private _txMax = new Float32Array(0);
  private _tzMin = new Float32Array(0);
  private _tzCen = new Float32Array(0);
  private _tzMax = new Float32Array(0);

  private _xLine: LineSegments2 | null = null;
  private _zLine: LineSegments2 | null = null;

  /** Neighbor-distance overlay — one line + label per cardinal direction. */
  private _neighborLines: Record<NeighborDir, LineSegments2 | null> = {
    xMinus: null, xPlus: null, zMinus: null, zPlus: null,
  };
  private _neighborLabels: Record<NeighborDir, Sprite | null> = {
    xMinus: null, xPlus: null, zMinus: null, zPlus: null,
  };
  /** Floor rectangle of the dragged bbox, drawn with the neighbor distances. */
  private _footprint: LineSegments2 | null = null;
  private readonly _footprintBuf = new Array<number>(24).fill(0);
  /** Reused 3-segment buffer for neighbor-line setPositions() (main + 2 ticks). */
  private readonly _neighborLineBuf = new Array<number>(18).fill(0);
  /** Reused position buffer for setPositions() (3 segments × 6 floats). */
  private readonly _segBuf: number[] = new Array(18).fill(0);

  /** Reusable Box3 to avoid allocation during arm + applySnap. */
  private _scratchBox = new Box3();

  /** Bound listeners — kept as fields so we can remove them in disarm(). */
  private readonly _onKeyDown = (e: KeyboardEvent): void => {
    if (e.altKey && !this._suppressed) {
      this._suppressed = true;
      this._hideLines();
      this.deps.markRenderDirty();
    }
  };
  private readonly _onKeyUp = (e: KeyboardEvent): void => {
    if (!e.altKey && this._suppressed) {
      this._suppressed = false;
      this.deps.markRenderDirty();
    }
  };

  constructor(private deps: BboxSnapDeps) {}

  /** True iff a drag is currently armed (between armForDrag and disarm). */
  get isArmed(): boolean { return this._armed; }

  /**
   * Capture the moving AABB and freeze every other placed object's AABB.
   *
   * @param movingRoot  The single object OR centroid pivot Group being
   *                    dragged. Anything that is `movingRoot` itself or a
   *                    descendant of it is treated as part of the moving
   *                    set and excluded from snap targets.
   */
  armForDrag(movingRoot: Object3D): void {
    this.disarm(); // defensive — clear any prior state

    // Moving AABB (world space; for a multi-select pivot Group this walks
    // all re-parented children automatically).
    movingRoot.updateWorldMatrix(true, true);
    this._scratchBox.makeEmpty();
    this._scratchBox.setFromObject(movingRoot);
    if (this._scratchBox.isEmpty()) {
      // Nothing to snap (no geometry). Bail without arming.
      return;
    }

    this._movingMinX = this._scratchBox.min.x;
    this._movingMaxX = this._scratchBox.max.x;
    this._movingCenX = (this._movingMinX + this._movingMaxX) * 0.5;
    this._movingMinZ = this._scratchBox.min.z;
    this._movingMaxZ = this._scratchBox.max.z;
    this._movingCenZ = (this._movingMinZ + this._movingMaxZ) * 0.5;

    // The moving root's CURRENT world position is the drag-start anchor.
    // Per-frame: applySnap receives the proposed (nx, nz) which is the
    // root's NEW position. Delta = (nx - dragStart) shifts the moving AABB.
    this._dragStartPosX = movingRoot.position.x;
    this._dragStartPosZ = movingRoot.position.z;
    // For a re-parented pivot group, .position is in scene-local coords —
    // matches FloorGizmo's _setTargetWorldPositionXZ contract.

    // Build frozen target list — every placed Object3D that is NOT a
    // descendant of movingRoot (and not movingRoot itself).
    this._targets.length = 0;
    for (const obj of this.deps.getAllPlaced()) {
      if (obj === movingRoot) continue;
      if (isDescendantOf(obj, movingRoot)) continue;
      obj.updateWorldMatrix(true, false);
      this._scratchBox.makeEmpty();
      this._scratchBox.setFromObject(obj);
      if (this._scratchBox.isEmpty()) continue;
      this._targets.push({
        minX: this._scratchBox.min.x,
        maxX: this._scratchBox.max.x,
        cX: (this._scratchBox.min.x + this._scratchBox.max.x) * 0.5,
        minZ: this._scratchBox.min.z,
        maxZ: this._scratchBox.max.z,
        cZ: (this._scratchBox.min.z + this._scratchBox.max.z) * 0.5,
      });
    }

    // Pack into typed arrays for cache-friendly hot path.
    const n = this._targets.length;
    this._txMin = new Float32Array(n);
    this._txCen = new Float32Array(n);
    this._txMax = new Float32Array(n);
    this._tzMin = new Float32Array(n);
    this._tzCen = new Float32Array(n);
    this._tzMax = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = this._targets[i];
      this._txMin[i] = t.minX; this._txCen[i] = t.cX; this._txMax[i] = t.maxX;
      this._tzMin[i] = t.minZ; this._tzCen[i] = t.cZ; this._tzMax[i] = t.maxZ;
    }

    this._armed = true;
    this._suppressed = false;
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
  }

  /**
   * Compute snapped position for the current pointer-move frame.
   *
   * Returns null when snap is disabled, suppressed (Alt held), not armed,
   * or there are no targets — caller should fall through to grid snap.
   */
  applySnap(nx: number, nz: number, axisLock: SnapAxisLock): SnapResult | null {
    if (!this._armed) return null;
    if (this._suppressed) {
      this._hideLines();
      this._hideNeighbors();
      return null;
    }
    if (this._targets.length === 0) {
      this._hideLines();
      this._hideNeighbors();
      return null;
    }

    // Translate the moving AABB by the proposed delta to get its candidate
    // world AABB at this frame.
    const dx = nx - this._dragStartPosX;
    const dz = nz - this._dragStartPosZ;
    const movMinX = this._movingMinX + dx;
    const movMaxX = this._movingMaxX + dx;
    const movCenX = this._movingCenX + dx;
    const movMinZ = this._movingMinZ + dz;
    const movMaxZ = this._movingMaxZ + dz;
    const movCenZ = this._movingCenZ + dz;

    // Neighbor distances are updated AFTER snap resolution below so they
    // reflect the *snapped* bbox position — otherwise the labels would
    // continue jittering with the raw pointer while the object visually
    // rests on a snap target.
    if (!this.deps.store.bboxSnapEnabled) {
      // Magnetic snap off → no snap guides AND no neighbor distances: the
      // distance overlay belongs to magnetic snap (its settings live there).
      this._hideNeighbors();
      this._hideLines();
      return null;
    }

    const tolM = this.deps.store.bboxSnapToleranceMm / 1000;

    // Per-axis search (only run for axes the gizmo actually allows to move).
    let snappedX = false;
    let snappedZ = false;
    let outX = nx;
    let outZ = nz;
    let snapWorldX = 0;
    let snapWorldZ = 0;
    let snapTargetXIdx = -1;
    let snapTargetZIdx = -1;

    const includeMid = this.deps.store.bboxSnapMid;
    const includeSide = this.deps.store.bboxSnapSide;

    if (axisLock !== 'z') {
      const r = findBestAxisSnap(
        movMinX, movCenX, movMaxX,
        this._txMin, this._txCen, this._txMax,
        this._targets.length,
        tolM,
        includeMid,
        includeSide,
      );
      if (r.snapped) {
        outX = nx + r.delta;
        snappedX = true;
        snapWorldX = r.snapValue;
        snapTargetXIdx = r.targetIdx;
      }
    }

    if (axisLock !== 'x') {
      const r = findBestAxisSnap(
        movMinZ, movCenZ, movMaxZ,
        this._tzMin, this._tzCen, this._tzMax,
        this._targets.length,
        tolM,
        includeMid,
        includeSide,
      );
      if (r.snapped) {
        outZ = nz + r.delta;
        snappedZ = true;
        snapWorldZ = r.snapValue;
        snapTargetZIdx = r.targetIdx;
      }
    }

    // Update visualisation.
    if (snappedX) {
      // Recompute snapped moving AABB Z-range to span the guide
      const sMovMinZ = this._movingMinZ + (outZ - this._dragStartPosZ);
      const sMovMaxZ = this._movingMaxZ + (outZ - this._dragStartPosZ);
      const tgt = this._targets[snapTargetXIdx];
      this._drawXSnapLine(snapWorldX, sMovMinZ, sMovMaxZ, tgt.minZ, tgt.maxZ);
    } else {
      this._hideLine('x');
    }
    if (snappedZ) {
      const sMovMinX = this._movingMinX + (outX - this._dragStartPosX);
      const sMovMaxX = this._movingMaxX + (outX - this._dragStartPosX);
      const tgt = this._targets[snapTargetZIdx];
      this._drawZSnapLine(snapWorldZ, sMovMinX, sMovMaxX, tgt.minX, tgt.maxX);
    } else {
      this._hideLine('z');
    }

    // Neighbor distances reflect the SNAPPED bbox — so while an axis stays
    // pulled to a target, the values on the perpendicular axis only change
    // by their actual freed-axis movement, and the snapped-axis values stay
    // stable across the snap range.
    if (this.deps.store.showNeighborDistances) {
      const finalMinX = this._movingMinX + (outX - this._dragStartPosX);
      const finalMaxX = this._movingMaxX + (outX - this._dragStartPosX);
      const finalMinZ = this._movingMinZ + (outZ - this._dragStartPosZ);
      const finalMaxZ = this._movingMaxZ + (outZ - this._dragStartPosZ);
      this._updateNeighborDistances(finalMinX, finalMaxX, finalMinZ, finalMaxZ);
    } else {
      this._hideNeighbors();
    }

    if (snappedX || snappedZ) this.deps.markRenderDirty();

    if (!snappedX && !snappedZ) return null; // let grid take over both axes
    return { x: outX, z: outZ, snappedX, snappedZ };
  }

  /**
   * End the active drag — drop frozen target AABBs and hide guide lines.
   * Called from FloorGizmo's onDraggingChanged(false).
   */
  disarm(): void {
    if (!this._armed) {
      this._hideLines();
      this._hideNeighbors();
      return;
    }
    this._armed = false;
    this._suppressed = false;
    this._targets.length = 0;
    this._txMin = this._txCen = this._txMax = new Float32Array(0);
    this._tzMin = this._tzCen = this._tzMax = new Float32Array(0);
    this._hideLines();
    this._hideNeighbors();
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    this.deps.markRenderDirty();
  }

  /** Permanent teardown — disposes line geometry/material. Call from plugin.dispose(). */
  dispose(): void {
    this.disarm();
    if (this._footprint) {
      this.deps.unmarkAsFixture(this._footprint);
      this._footprint.parent?.remove(this._footprint);
      this._footprint.geometry.dispose();
      (this._footprint.material as LineMaterial).dispose();
      this._footprint = null;
    }
    if (this._xLine) {
      this.deps.unmarkAsFixture(this._xLine);
      this._xLine.parent?.remove(this._xLine);
      this._xLine.geometry.dispose();
      (this._xLine.material as LineMaterial).dispose();
      this._xLine = null;
    }
    if (this._zLine) {
      this.deps.unmarkAsFixture(this._zLine);
      this._zLine.parent?.remove(this._zLine);
      this._zLine.geometry.dispose();
      (this._zLine.material as LineMaterial).dispose();
      this._zLine = null;
    }
    for (const dir of NEIGHBOR_DIRS) {
      const ln = this._neighborLines[dir];
      if (ln) {
        this.deps.unmarkAsFixture(ln);
        ln.parent?.remove(ln);
        ln.geometry.dispose();
        (ln.material as LineMaterial).dispose();
        this._neighborLines[dir] = null;
      }
      const lb = this._neighborLabels[dir];
      if (lb) {
        this.deps.unmarkAsFixture(lb);
        lb.parent?.remove(lb);
        const mat = lb.material as SpriteMaterial;
        mat.map?.dispose();
        mat.dispose();
        this._neighborLabels[dir] = null;
      }
    }
  }

  // ─── Visualization (private) ─────────────────────────────────────────

  /**
   * Lazy-create the X snap line so a session that never produces an X-axis
   * snap doesn't pollute the scene with an unused (and seeded) line.
   * Independent from _ensureZLine — splitting the two avoids placing both
   * lines in the scene when only one axis ever fires.
   */
  private _ensureXLine(): void {
    if (this._xLine) return;
    this._xLine = makeSnapLine();
    this.deps.scene.add(this._xLine);
    this.deps.markAsFixture(this._xLine);
  }

  /** Lazy-create the Z snap line. See _ensureXLine. */
  private _ensureZLine(): void {
    if (this._zLine) return;
    this._zLine = makeSnapLine();
    this.deps.scene.add(this._zLine);
    this.deps.markAsFixture(this._zLine);
  }

  /** Refresh LineMaterial.resolution so pixel-space line width stays correct
   *  across canvas resizes. Called per-draw — cheap (two scalar writes). */
  private _syncLineResolution(line: LineSegments2): void {
    const mat = line.material as LineMaterial;
    mat.resolution.set(window.innerWidth, window.innerHeight);
  }

  private _hideLines(): void {
    if (this._xLine) this._xLine.visible = false;
    if (this._zLine) this._zLine.visible = false;
  }

  private _hideLine(which: 'x' | 'z'): void {
    if (which === 'x' && this._xLine) this._xLine.visible = false;
    if (which === 'z' && this._zLine) this._zLine.visible = false;
  }

  /** The dragged bbox's bottom rectangle on the floor — same thin line as the
   *  neighbor distances, shown and hidden with them. */
  private _drawFootprint(minX: number, maxX: number, minZ: number, maxZ: number): void {
    if (!this._footprint) {
      this._footprint = makeNeighborLine();
      this._footprint.name = '_layoutFootprint';
      this.deps.scene.add(this._footprint);
      this.deps.markAsFixture(this._footprint);
    }
    const y = FLOOR_LIFT_M;
    const b = this._footprintBuf;
    let i = 0;
    const seg = (ax: number, az: number, bx: number, bz: number): void => {
      b[i++] = ax; b[i++] = y; b[i++] = az; b[i++] = bx; b[i++] = y; b[i++] = bz;
    };
    seg(minX, minZ, maxX, minZ);
    seg(maxX, minZ, maxX, maxZ);
    seg(maxX, maxZ, minX, maxZ);
    seg(minX, maxZ, minX, minZ);
    this._footprint.geometry.setPositions(b);
    this._syncLineResolution(this._footprint);
    this._footprint.visible = true;
  }

  private _hideNeighbors(): void {
    if (this._footprint) this._footprint.visible = false;
    for (const dir of NEIGHBOR_DIRS) {
      const ln = this._neighborLines[dir];
      const lb = this._neighborLabels[dir];
      if (ln) ln.visible = false;
      if (lb) lb.visible = false;
    }
  }

  private _hideNeighbor(dir: NeighborDir): void {
    const ln = this._neighborLines[dir];
    const lb = this._neighborLabels[dir];
    if (ln) ln.visible = false;
    if (lb) lb.visible = false;
  }

  private _ensureNeighborLine(dir: NeighborDir): LineSegments2 {
    let ln = this._neighborLines[dir];
    if (ln) return ln;
    ln = makeNeighborLine();
    this.deps.scene.add(ln);
    this.deps.markAsFixture(ln);
    this._neighborLines[dir] = ln;
    return ln;
  }

  private _ensureNeighborLabel(dir: NeighborDir): Sprite {
    let lb = this._neighborLabels[dir];
    if (lb) return lb;
    lb = makeDistanceLabel();
    this.deps.scene.add(lb);
    this.deps.markAsFixture(lb);
    this._neighborLabels[dir] = lb;
    return lb;
  }

  /**
   * For each cardinal direction, find the nearest target whose axis-projection
   * overlaps the moving bbox on the perpendicular axis (Figma-style strahl
   * search), then draw a single dashed line + distance label from the moving
   * edge to the target edge along the projected overlap centreline.
   */
  private _updateNeighborDistances(
    mMinX: number, mMaxX: number,
    mMinZ: number, mMaxZ: number,
  ): void {
    this._drawFootprint(mMinX, mMaxX, mMinZ, mMaxZ);
    // Convert the configured max from mm to metres once (world space).
    const maxDistM = this.deps.store.neighborDistanceMaxMm / 1000;

    let leftIdx = -1,  leftDist = Infinity;   // -X
    let rightIdx = -1, rightDist = Infinity;  // +X
    let backIdx = -1,  backDist = Infinity;   // -Z
    let frontIdx = -1, frontDist = Infinity;  // +Z

    const n = this._targets.length;
    for (let i = 0; i < n; i++) {
      const t = this._targets[i];

      // Z-overlap (for X-direction neighbors)
      const zOverlap = !(t.maxZ < mMinZ || t.minZ > mMaxZ);
      if (zOverlap) {
        if (t.maxX <= mMinX) {
          const d = mMinX - t.maxX;
          if (d < leftDist) { leftDist = d; leftIdx = i; }
        }
        if (t.minX >= mMaxX) {
          const d = t.minX - mMaxX;
          if (d < rightDist) { rightDist = d; rightIdx = i; }
        }
      }

      // X-overlap (for Z-direction neighbors)
      const xOverlap = !(t.maxX < mMinX || t.minX > mMaxX);
      if (xOverlap) {
        if (t.maxZ <= mMinZ) {
          const d = mMinZ - t.maxZ;
          if (d < backDist) { backDist = d; backIdx = i; }
        }
        if (t.minZ >= mMaxZ) {
          const d = t.minZ - mMaxZ;
          if (d < frontDist) { frontDist = d; frontIdx = i; }
        }
      }
    }

    // Draw each found neighbor whose distance is within the configured
    // max-auto-measure radius; hide the rest.
    if (leftIdx >= 0 && leftDist <= maxDistM) {
      const t = this._targets[leftIdx];
      const overlapMin = Math.max(t.minZ, mMinZ);
      const overlapMax = Math.min(t.maxZ, mMaxZ);
      this._drawNeighbor('xMinus', t.maxX, (overlapMin + overlapMax) * 0.5, mMinX, (overlapMin + overlapMax) * 0.5, leftDist, 'x');
    } else this._hideNeighbor('xMinus');

    if (rightIdx >= 0 && rightDist <= maxDistM) {
      const t = this._targets[rightIdx];
      const overlapMin = Math.max(t.minZ, mMinZ);
      const overlapMax = Math.min(t.maxZ, mMaxZ);
      this._drawNeighbor('xPlus', mMaxX, (overlapMin + overlapMax) * 0.5, t.minX, (overlapMin + overlapMax) * 0.5, rightDist, 'x');
    } else this._hideNeighbor('xPlus');

    if (backIdx >= 0 && backDist <= maxDistM) {
      const t = this._targets[backIdx];
      const overlapMin = Math.max(t.minX, mMinX);
      const overlapMax = Math.min(t.maxX, mMaxX);
      this._drawNeighbor('zMinus', (overlapMin + overlapMax) * 0.5, t.maxZ, (overlapMin + overlapMax) * 0.5, mMinZ, backDist, 'z');
    } else this._hideNeighbor('zMinus');

    if (frontIdx >= 0 && frontDist <= maxDistM) {
      const t = this._targets[frontIdx];
      const overlapMin = Math.max(t.minX, mMinX);
      const overlapMax = Math.min(t.maxX, mMaxX);
      this._drawNeighbor('zPlus', (overlapMin + overlapMax) * 0.5, mMaxZ, (overlapMin + overlapMax) * 0.5, t.minZ, frontDist, 'z');
    } else this._hideNeighbor('zPlus');

    this.deps.markRenderDirty();
  }

  /**
   * Draw a neighbor dimension line from (ax, az) to (bx, bz) on the floor.
   * Three segments: main line + a perpendicular end-tick at each endpoint
   * so the measurement start and end are visually unambiguous. Label sits
   * at the midpoint.
   *
   * `axis` is the axis the line itself runs along — ticks are drawn
   * perpendicular to it.
   */
  private _drawNeighbor(
    dir: NeighborDir,
    ax: number, az: number, bx: number, bz: number,
    distM: number,
    axis: 'x' | 'z',
  ): void {
    const line = this._ensureNeighborLine(dir);
    const buf = this._neighborLineBuf;
    const h = NEIGHBOR_TICK_HALF_M;
    let i = 0;

    // Main dimension segment
    buf[i++] = ax; buf[i++] = FLOOR_LIFT_M; buf[i++] = az;
    buf[i++] = bx; buf[i++] = FLOOR_LIFT_M; buf[i++] = bz;

    if (axis === 'x') {
      // Line runs along X → ticks perpendicular along Z
      buf[i++] = ax; buf[i++] = FLOOR_LIFT_M; buf[i++] = az - h;
      buf[i++] = ax; buf[i++] = FLOOR_LIFT_M; buf[i++] = az + h;
      buf[i++] = bx; buf[i++] = FLOOR_LIFT_M; buf[i++] = bz - h;
      buf[i++] = bx; buf[i++] = FLOOR_LIFT_M; buf[i++] = bz + h;
    } else {
      // Line runs along Z → ticks perpendicular along X
      buf[i++] = ax - h; buf[i++] = FLOOR_LIFT_M; buf[i++] = az;
      buf[i++] = ax + h; buf[i++] = FLOOR_LIFT_M; buf[i++] = az;
      buf[i++] = bx - h; buf[i++] = FLOOR_LIFT_M; buf[i++] = bz;
      buf[i++] = bx + h; buf[i++] = FLOOR_LIFT_M; buf[i++] = bz;
    }

    line.geometry.setPositions(buf);
    // Solid line — no computeLineDistances() needed (only used for dashed).
    (line.material as LineMaterial).resolution.set(window.innerWidth, window.innerHeight);
    line.visible = true;

    const label = this._ensureNeighborLabel(dir);
    label.position.set((ax + bx) * 0.5, FLOOR_LIFT_M, (az + bz) * 0.5);
    paintDistanceLabel(label, distM * 1000);
  }

  /**
   * Draw the X-axis-alignment guide line. The shared X coordinate is
   * `worldX`; the line runs along Z between the moving and target Z-ranges
   * with a small overshoot, plus a perpendicular tick at each endpoint.
   */
  private _drawXSnapLine(
    worldX: number,
    movMinZ: number, movMaxZ: number,
    tgtMinZ: number, tgtMaxZ: number,
  ): void {
    this._ensureXLine();
    const line = this._xLine;
    if (!line) return;

    // Z-extent of the line: from min(all four) - overshoot to max(all four) + overshoot
    const zLo = Math.min(movMinZ, tgtMinZ) - LINE_OVERSHOOT_M;
    const zHi = Math.max(movMaxZ, tgtMaxZ) + LINE_OVERSHOOT_M;

    // Tick centers: the contact-edge midpoints. Place ticks at the moving
    // and target edges that face each other (the ones nearest the contact).
    const movEdgeZ = (movMinZ + movMaxZ) * 0.5;
    const tgtEdgeZ = (tgtMinZ + tgtMaxZ) * 0.5;

    const arr = this._segBuf;
    let i = 0;
    // Main line (Z-axis aligned at world X)
    arr[i++] = worldX; arr[i++] = FLOOR_LIFT_M; arr[i++] = zLo;
    arr[i++] = worldX; arr[i++] = FLOOR_LIFT_M; arr[i++] = zHi;
    // Tick at moving edge midpoint (perpendicular along X)
    arr[i++] = worldX - TICK_HALF_M; arr[i++] = FLOOR_LIFT_M; arr[i++] = movEdgeZ;
    arr[i++] = worldX + TICK_HALF_M; arr[i++] = FLOOR_LIFT_M; arr[i++] = movEdgeZ;
    // Tick at target edge midpoint
    arr[i++] = worldX - TICK_HALF_M; arr[i++] = FLOOR_LIFT_M; arr[i++] = tgtEdgeZ;
    arr[i++] = worldX + TICK_HALF_M; arr[i++] = FLOOR_LIFT_M; arr[i++] = tgtEdgeZ;

    line.geometry.setPositions(arr);
    line.computeLineDistances();
    this._syncLineResolution(line);
    line.visible = true;
  }

  /**
   * Draw the Z-axis-alignment guide line. Mirror of _drawXSnapLine: shared
   * Z coordinate is `worldZ`; line runs along X.
   */
  private _drawZSnapLine(
    worldZ: number,
    movMinX: number, movMaxX: number,
    tgtMinX: number, tgtMaxX: number,
  ): void {
    this._ensureZLine();
    const line = this._zLine;
    if (!line) return;

    const xLo = Math.min(movMinX, tgtMinX) - LINE_OVERSHOOT_M;
    const xHi = Math.max(movMaxX, tgtMaxX) + LINE_OVERSHOOT_M;

    const movEdgeX = (movMinX + movMaxX) * 0.5;
    const tgtEdgeX = (tgtMinX + tgtMaxX) * 0.5;

    const arr = this._segBuf;
    let i = 0;
    arr[i++] = xLo; arr[i++] = FLOOR_LIFT_M; arr[i++] = worldZ;
    arr[i++] = xHi; arr[i++] = FLOOR_LIFT_M; arr[i++] = worldZ;
    arr[i++] = movEdgeX; arr[i++] = FLOOR_LIFT_M; arr[i++] = worldZ - TICK_HALF_M;
    arr[i++] = movEdgeX; arr[i++] = FLOOR_LIFT_M; arr[i++] = worldZ + TICK_HALF_M;
    arr[i++] = tgtEdgeX; arr[i++] = FLOOR_LIFT_M; arr[i++] = worldZ - TICK_HALF_M;
    arr[i++] = tgtEdgeX; arr[i++] = FLOOR_LIFT_M; arr[i++] = worldZ + TICK_HALF_M;

    line.geometry.setPositions(arr);
    line.computeLineDistances();
    this._syncLineResolution(line);
    line.visible = true;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

/** True if `node` has `ancestor` somewhere in its parent chain (or is `ancestor`). */
function isDescendantOf(node: Object3D, ancestor: Object3D): boolean {
  let cur: Object3D | null = node;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parent;
  }
  return false;
}

