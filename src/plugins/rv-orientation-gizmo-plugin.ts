// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * OrientationGizmoPlugin — viewport orientation gizmo with CSS 3D cube.
 *
 * SVG/DOM implementation. Sits in the top-right corner as an HTML overlay.
 * The gizmo is drawn as 6 colored bars (positive axes with cone tips,
 * negative axes plain) radiating from a CSS 3D rotating cube that follows
 * the camera orientation. Clicking the cube toggles perspective/orthographic.
 * Clicking a bar snaps the camera to that axis view.
 */

import { Matrix4, Vector3 } from 'three';
import type { Object3D } from 'three';

import type { RVViewerPlugin } from '../core/rv-plugin';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import type { RVViewer } from '../core/rv-viewer';
import { getAppConfig } from '../core/rv-app-config';
import { isCompactWidth } from '../hooks/use-mobile-layout';
import {
  getProjectsDashboardSnapshot,
  subscribeProjectsDashboard,
} from '../core/hmi/projects/projects-dashboard-store';

// ─── Public types ────────────────────────────────────────────────────

export type OrientationView = 'pos-x' | 'neg-x' | 'pos-y' | 'neg-y' | 'pos-z' | 'neg-z';
type HandleId = OrientationView | 'cube';

// ─── Layout constants (CSS pixels) ───────────────────────────────────

/** Edge length of the gizmo widget. The box is kept just large enough to hold
 *  the cube + its axis bars/labels: content reaches ~RADIUS+label (~38 px) from
 *  the centre, so a half-edge of 44 px leaves only a thin (~6 px) margin and the
 *  cube tucks snugly into the corner instead of floating ~22 px away from it.
 *  (The cube and bars themselves are fixed-size — shrinking the box only trims
 *  the empty padding around them, it does not scale the gizmo.) */
const SIZE_PX = 88;
/** Distance from the right edge of the viewport — flush in the corner. */
const MARGIN_RIGHT_PX = 0;
/** Distance from the top edge of the viewport. The cube sits at the box centre
 *  (~SIZE_PX/2 below this), and the topmost content (the "Y" axis label) sits
 *  ~RADIUS above the cube — so at 0 the "Y" label lands ~8 px from the top, lining
 *  up with the floating top-left toolbar's FLOATING_TOP_MARGIN (8 px) instead of
 *  sitting well below it. The camera/view controls float at the BOTTOM-right, so
 *  the gizmo owns the top-right corner. SVG `overflow: visible` keeps labels that
 *  spill out of the box readable. */
const MARGIN_TOP_PX = 0;

/** SVG center coord — bars project outward from here. */
const CENTER = SIZE_PX / 2;
/** Distance from center to the (invisible) hit line tip / label anchor. */
const RADIUS = 28;
/** Distance from center to the hit line's inner end. */
const INNER_RADIUS = 0;
/** Invisible hit-test stroke width — wider for easy clicking/touch. */
const HIT_STROKE = 18;
/** Extra offset past the bar tip for the axis label. Small so the X/Y/Z
 *  letters sit close to the cube — the gizmo's visual anchor. */
const LABEL_OFFSET = 4;
/** Axis labels for positive directions. */
const AXIS_LABELS: Partial<Record<OrientationView, string>> = {
  'pos-x': 'X',
  'pos-y': 'Y',
  'pos-z': 'Z',
};

// ─── 3D Cube constants ──────────────────────────────────────────────

/** Edge length of the CSS 3D cube (CSS px). */
const CUBE_3D_SIZE = 36;
/** Half edge for face positioning. */
const CUBE_3D_HALF = CUBE_3D_SIZE / 2;
/** CSS perspective distance for the 3D cube. */
const CUBE_3D_PERSPECTIVE = 200;

// ─── Colors (CSS) ────────────────────────────────────────────────────

const COLOR_X = '#e03131';
const COLOR_X_HOVER = '#ff6b6b';
const COLOR_Y = '#2f9e44';
const COLOR_Y_HOVER = '#69db7c';
const COLOR_Z = '#1971c2';
const COLOR_Z_HOVER = '#4dabf7';

const COLORS_BY_AXIS: Record<OrientationView, { idle: string; hover: string }> = {
  'pos-x': { idle: COLOR_X, hover: COLOR_X_HOVER },
  'neg-x': { idle: COLOR_X, hover: COLOR_X_HOVER },
  'pos-y': { idle: COLOR_Y, hover: COLOR_Y_HOVER },
  'neg-y': { idle: COLOR_Y, hover: COLOR_Y_HOVER },
  'pos-z': { idle: COLOR_Z, hover: COLOR_Z_HOVER },
  'neg-z': { idle: COLOR_Z, hover: COLOR_Z_HOVER },
};

/** Cube face colors — subtle axis-tinted grays. */
const CUBE_FACE_COLORS = {
  right:  'rgba(224, 49, 49, 0.35)',   // +X red
  left:   'rgba(224, 49, 49, 0.18)',   // -X red dim
  top:    'rgba(47, 158, 68, 0.35)',   // +Y green
  bottom: 'rgba(47, 158, 68, 0.18)',   // -Y green dim
  front:  'rgba(25, 113, 194, 0.35)',  // +Z blue
  back:   'rgba(25, 113, 194, 0.18)',  // -Z blue dim
};
const CUBE_FACE_HOVER = 'rgba(255, 255, 255, 0.45)';

/** Unit world-space direction the camera moves to when each handle is clicked. */
export const AXIS_VECTORS: Record<OrientationView, Readonly<Vector3>> = {
  'pos-x': new Vector3(1, 0, 0),
  'neg-x': new Vector3(-1, 0, 0),
  'pos-y': new Vector3(0, 1, 0),
  'neg-y': new Vector3(0, -1, 0),
  'pos-z': new Vector3(0, 0, 1),
  'neg-z': new Vector3(0, 0, -1),
};

const ALL_VIEWS: OrientationView[] = ['pos-x', 'neg-x', 'pos-y', 'neg-y', 'pos-z', 'neg-z'];

// ─── Pure helpers (testable without DOM) ─────────────────────────────

/**
 * Compute the camera position for a snap-to-view action.
 *
 * For `pos-y` / `neg-y` views the lookAt is degenerate with a world-Y up
 * vector, so we apply a tiny lateral offset that determines which XZ
 * direction appears as "up on screen". `upWorld` is the desired world-space
 * up-on-screen direction (XZ component only); defaults to (0,0,-1).
 *
 * Geometry: for `pos-y` the camera's local +Y maps to `-(offsetXZ)/h`, so we
 * offset by `-upWorld * ε`. For `neg-y` the mapping flips sign.
 */
export function viewToCameraPose(
  view: OrientationView,
  target: Vector3,
  distance: number,
  upWorld?: Vector3,
): Vector3 {
  const dir = AXIS_VECTORS[view];
  const pos = target.clone().addScaledVector(dir, distance);
  if (view === 'pos-y' || view === 'neg-y') {
    const u = upWorld ?? new Vector3(0, 0, -1);
    const sign = view === 'pos-y' ? -1 : 1;
    pos.x += sign * u.x * 1e-3;
    pos.z += sign * u.z * 1e-3;
  }
  return pos;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// ─── Plugin ──────────────────────────────────────────────────────────

interface BarElements {
  hit: SVGLineElement;
  axisLabel: SVGTextElement | null;
}

interface BarState {
  id: OrientationView;
  depth: number;
  tx: number;
  ty: number;
  ix: number;
  iy: number;
}

export class OrientationGizmoPlugin implements RVViewerPlugin {
  readonly id = 'orientation-gizmo';

  private _viewer: RVViewer | null = null;
  private _enabled = false;

  // DOM
  private _container: HTMLDivElement | null = null;
  private _svg: SVGSVGElement | null = null;
  private _label: HTMLDivElement | null = null;
  private _cubeWrap: HTMLDivElement | null = null;
  private _cubeInner: HTMLDivElement | null = null;
  private _cubeFaces: HTMLDivElement[] = [];
  private _bars: Map<OrientationView, BarElements> = new Map();

  // Per-frame state
  private _barStates: BarState[] = ALL_VIEWS.map((id) => ({
    id, depth: 0, tx: CENTER, ty: CENTER, ix: CENTER, iy: CENTER,
  }));
  private _hovered: HandleId | null = null;
  private _lastLabelText = '';
  private _panelUnsub: (() => void) | null = null;
  private _dashboardUnsub: (() => void) | null = null;
  private _resizeObs: ResizeObserver | null = null;
  private _intendedLabel: string | null = null;
  private _lastCamW = NaN;
  private _lastCamX = NaN;
  private _lastCamY = NaN;
  private _lastCamZ = NaN;

  // Reused temps
  private _v3 = new Vector3();
  private _rotMatrix = new Matrix4();

  // Bound listeners
  private _onElementEnter = (e: PointerEvent) => this._setHovered(this._handleFor(e));
  private _onElementLeave = () => this._setHovered(null);
  private _onElementClick = (e: PointerEvent) => {
    const handle = this._handleFor(e);
    if (handle) {
      e.stopPropagation();
      this._executeAction(handle);
    }
  };

  // ─── Lifecycle ─────────────────────────────────────────────────────

  onModelLoaded(_result: LoadResult, viewer: RVViewer): void {
    if (this._enabled) return;
    const cfg = getAppConfig().pluginConfig?.['orientationGizmo'] as
      | { enabled?: boolean }
      | undefined;
    if (cfg?.enabled === false) return;

    this._viewer = viewer;
    this._buildDOM();
    this._refreshLabel();
    this._project();
    this._writeBarAttrs();
    this._updateCubeRotation();
    this._reorderForDepth();
    this._panelUnsub = viewer.leftPanelManager.subscribe(() => this._refreshPosition());
    // The dashboard is a body-level overlay, so no resize or panel event fires
    // when it opens — without this the cube would stay on screen on top of it.
    this._dashboardUnsub = subscribeProjectsDashboard(() => this._refreshPosition());
    // Track the real 3D viewport rect: ViewportFrame insets #rv-viewport for the
    // title bar, right-docked panels, and UI zoom — observing its size keeps the
    // gizmo glued to the viewport's top-right corner through all of them.
    const vp = document.getElementById('rv-viewport');
    if (vp && typeof ResizeObserver !== 'undefined') {
      this._resizeObs = new ResizeObserver(() => this._refreshPosition());
      this._resizeObs.observe(vp);
    }
    this._refreshPosition();
    this._enabled = true;
  }

  onRender(_dt: number): void {
    if (!this._enabled || !this._viewer) return;
    const cam = this._viewer.camera;
    cam.updateMatrixWorld(true);
    const q = cam.quaternion;
    if (q.x === this._lastCamX && q.y === this._lastCamY && q.z === this._lastCamZ && q.w === this._lastCamW) {
      this._refreshLabel();
      return;
    }
    this._lastCamX = q.x;
    this._lastCamY = q.y;
    this._lastCamZ = q.z;
    this._lastCamW = q.w;
    this._project();
    this._writeBarAttrs();
    this._updateCubeRotation();
    this._reorderForDepth();
    this._refreshLabel();
  }

  dispose(): void {
    this._panelUnsub?.();
    this._panelUnsub = null;
    this._dashboardUnsub?.();
    this._dashboardUnsub = null;
    this._resizeObs?.disconnect();
    this._resizeObs = null;
    if (this._container) {
      this._container.remove();
      this._container = null;
    }
    this._svg = null;
    this._label = null;
    this._cubeWrap = null;
    this._cubeInner = null;
    this._cubeFaces = [];
    this._bars.clear();
    this._enabled = false;
    this._viewer = null;
  }

  // ─── Layout: glue to the 3D viewport's top-right corner ────────────

  /** Pin the gizmo to the top-right corner of the actual 3D viewport region.
   *  Reads the live `#rv-viewport` rect (already inset by ViewportFrame for the
   *  optional title bar, right-docked panels and UI zoom) so the gizmo follows
   *  the corner exactly. Falls back to the right-dock width if the element is
   *  missing. */
  private _refreshPosition(): void {
    if (!this._container) return;
    // Two reasons to be invisible, both "there is no viewport to orient":
    //
    //  - Compact (phone-width) layout: the gizmo is a desktop mouse tool and
    //    would sit on top of the fullscreen panel headers, covering their close
    //    button.
    //  - The Projects dashboard: it covers the whole viewport, so the cube
    //    orients nothing and merely overlaps the header controls.
    //
    // Hiding is the only option available to us, not merely the tidiest one.
    // The gizmo is a direct child of <body> at z-index 1100, while the dashboard
    // lives inside #react-root — which is itself `position: fixed; z-index: 1000`
    // and therefore a stacking context. Every z-index inside it is resolved
    // against 1000, so no value the dashboard sets can ever rise above 1100.
    // Raising #react-root instead would lift the entire HMI over every
    // body-level overlay, which is a much larger change than this problem.
    //
    // Driven from the same ResizeObserver as the positioning, plus the
    // dashboard subscription, so it toggles live in both directions.
    const dashboardOpen = getProjectsDashboardSnapshot().open;
    this._container.style.display =
      isCompactWidth(window.innerWidth) || dashboardOpen ? 'none' : '';
    const vp = document.getElementById('rv-viewport');
    if (vp) {
      const rect = vp.getBoundingClientRect();
      this._container.style.top = `${rect.top + MARGIN_TOP_PX}px`;
      this._container.style.right = `${Math.max(0, window.innerWidth - rect.right) + MARGIN_RIGHT_PX}px`;
      return;
    }
    if (!this._viewer) return;
    const rightDockWidth = this._viewer.leftPanelManager.getActiveWidth('right');
    this._container.style.top = `${MARGIN_TOP_PX}px`;
    this._container.style.right = `${MARGIN_RIGHT_PX + rightDockWidth}px`;
  }

  // ─── Projection ────────────────────────────────────────────────────

  private _project(): void {
    if (!this._viewer) return;
    this._rotMatrix.extractRotation(this._viewer.camera.matrixWorldInverse);
    for (const bar of this._barStates) {
      this._v3.copy(AXIS_VECTORS[bar.id]).applyMatrix4(this._rotMatrix);
      bar.depth = -this._v3.z;
      bar.tx = CENTER + this._v3.x * RADIUS;
      bar.ty = CENTER - this._v3.y * RADIUS;
      bar.ix = CENTER + this._v3.x * INNER_RADIUS;
      bar.iy = CENTER - this._v3.y * INNER_RADIUS;
    }
  }

  private _writeBarAttrs(): void {
    for (const bar of this._barStates) {
      const els = this._bars.get(bar.id);
      if (!els) continue;
      const ix = bar.ix.toFixed(2);
      const iy = bar.iy.toFixed(2);
      const tx = bar.tx.toFixed(2);
      const ty = bar.ty.toFixed(2);
      els.hit.setAttribute('x1', ix);
      els.hit.setAttribute('y1', iy);
      els.hit.setAttribute('x2', tx);
      els.hit.setAttribute('y2', ty);
      // Position axis label just past the shaft tip (positive axes only).
      if (els.axisLabel) {
        const dx = bar.tx - CENTER;
        const dy = bar.ty - CENTER;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const lx = bar.tx + (dx / len) * LABEL_OFFSET;
        const ly = bar.ty + (dy / len) * LABEL_OFFSET;
        els.axisLabel.setAttribute('x', lx.toFixed(2));
        els.axisLabel.setAttribute('y', ly.toFixed(2));
      }
    }
  }

  // ─── CSS 3D Cube rotation ─────────────────────────────────────────

  /**
   * Apply the camera's rotation to the CSS 3D cube via matrix3d().
   * We conjugate with a Y-flip matrix (CSS Y is down, Three.js Y is up).
   */
  private _updateCubeRotation(): void {
    if (!this._cubeInner) return;
    const e = this._rotMatrix.elements;
    // Conjugate rotation with diag(1,-1,1,1) to flip Y for CSS coords
    const m = `matrix3d(${e[0]},${-e[1]},${e[2]},0,${-e[4]},${e[5]},${-e[6]},0,${e[8]},${-e[9]},${e[10]},0,0,0,0,1)`;
    this._cubeInner.style.transform = m;
  }

  /**
   * Re-order SVG children by depth. The CSS 3D cube sits as a separate
   * div over the SVG center — bars don't overlap the cube area, so no
   * mixed SVG/HTML depth sorting needed.
   */
  private _reorderForDepth(): void {
    const svg = this._svg;
    if (!svg) return;
    const sorted = [...this._barStates].sort((a, b) => a.depth - b.depth);
    const fragment = document.createDocumentFragment();
    for (const bar of sorted) {
      const els = this._bars.get(bar.id);
      if (!els) continue;
      fragment.appendChild(els.hit);
      if (els.axisLabel) fragment.appendChild(els.axisLabel);
    }
    svg.replaceChildren(fragment);
  }

  // ─── DOM construction ──────────────────────────────────────────────

  private _buildDOM(): void {
    const container = document.createElement('div');
    container.className = 'rv-orientation-gizmo';
    container.style.cssText = `
      position: fixed;
      top: ${MARGIN_TOP_PX}px;
      right: ${MARGIN_RIGHT_PX}px;
      width: ${SIZE_PX}px;
      height: ${SIZE_PX + 30}px;
      z-index: 1100;
      pointer-events: none;
      user-select: none;
      -webkit-user-select: none;
      font-family: Inter, Roboto, system-ui, sans-serif;
    `;

    // ── SVG layer for axis bars ──
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', String(SIZE_PX));
    svg.setAttribute('height', String(SIZE_PX));
    svg.setAttribute('viewBox', `0 0 ${SIZE_PX} ${SIZE_PX}`);
    svg.style.cssText = 'display: block; overflow: visible; position: absolute; top: 0; left: 0;';

    for (const id of ALL_VIEWS) {
      const isPositive = id.startsWith('pos-');

      const hit = document.createElementNS(SVG_NS, 'line');
      hit.setAttribute('stroke', 'transparent');
      hit.setAttribute('stroke-width', String(HIT_STROKE));
      hit.setAttribute('stroke-linecap', 'round');
      hit.setAttribute('pointer-events', 'stroke');
      hit.style.cursor = 'pointer';
      hit.dataset.handle = id;

      let axisLabel: SVGTextElement | null = null;
      if (isPositive) {
        const labelChar = AXIS_LABELS[id];
        if (labelChar) {
          axisLabel = document.createElementNS(SVG_NS, 'text');
          axisLabel.textContent = labelChar;
          axisLabel.setAttribute('fill', COLORS_BY_AXIS[id].idle);
          axisLabel.setAttribute('font-size', '11');
          axisLabel.setAttribute('font-weight', '700');
          axisLabel.setAttribute('font-family', 'Inter, Roboto, system-ui, sans-serif');
          axisLabel.setAttribute('text-anchor', 'middle');
          axisLabel.setAttribute('dominant-baseline', 'central');
          axisLabel.setAttribute('pointer-events', 'auto');
          axisLabel.dataset.handle = id;
          axisLabel.style.cursor = 'pointer';
          axisLabel.style.transition = 'fill 120ms ease';
          this._attachHandlers(axisLabel);
        }
      }

      this._attachHandlers(hit);
      this._bars.set(id, { hit, axisLabel });
      svg.append(hit);
      if (axisLabel) svg.append(axisLabel);
    }

    // ── CSS 3D Cube ──
    const cubeWrap = document.createElement('div');
    cubeWrap.style.cssText = `
      position: absolute;
      left: ${CENTER - CUBE_3D_SIZE / 2}px;
      top: ${CENTER - CUBE_3D_SIZE / 2}px;
      width: ${CUBE_3D_SIZE}px;
      height: ${CUBE_3D_SIZE}px;
      perspective: ${CUBE_3D_PERSPECTIVE}px;
      pointer-events: none;
      z-index: 1;
    `;

    const cubeInner = document.createElement('div');
    cubeInner.style.cssText = `
      width: 100%;
      height: 100%;
      transform-style: preserve-3d;
      pointer-events: none;
    `;

    // Face definitions: [handle, bg color, CSS transform]
    // Each face maps to the axis view you'd see when looking at that face.
    const faces: [OrientationView, string, string][] = [
      ['pos-z',  CUBE_FACE_COLORS.front,  `translateZ(${CUBE_3D_HALF}px)`],
      ['neg-z',  CUBE_FACE_COLORS.back,   `rotateY(180deg) translateZ(${CUBE_3D_HALF}px)`],
      ['pos-x',  CUBE_FACE_COLORS.right,  `rotateY(90deg) translateZ(${CUBE_3D_HALF}px)`],
      ['neg-x',  CUBE_FACE_COLORS.left,   `rotateY(-90deg) translateZ(${CUBE_3D_HALF}px)`],
      ['pos-y',  CUBE_FACE_COLORS.top,    `rotateX(90deg) translateZ(${CUBE_3D_HALF}px)`],
      ['neg-y',  CUBE_FACE_COLORS.bottom, `rotateX(-90deg) translateZ(${CUBE_3D_HALF}px)`],
    ];

    this._cubeFaces = [];
    for (const [handle, bg, transform] of faces) {
      const face = document.createElement('div');
      face.dataset.handle = handle;
      face.style.cssText = `
        position: absolute;
        width: ${CUBE_3D_SIZE}px;
        height: ${CUBE_3D_SIZE}px;
        background: ${bg};
        border: 1px solid rgba(255, 255, 255, 0.25);
        box-sizing: border-box;
        backface-visibility: hidden;
        transform: ${transform};
        pointer-events: auto;
        cursor: pointer;
      `;
      face.style.transition = 'background 120ms ease';
      this._attachHandlers(face as unknown as SVGElement);
      cubeInner.appendChild(face);
      this._cubeFaces.push(face);
    }


    cubeWrap.appendChild(cubeInner);

    // ── Projection label — small pill overlaid below the cube ──
    const label = document.createElement('div');
    label.dataset.handle = 'cube';
    label.style.cssText = `
      position: absolute;
      left: 50%;
      top: ${CENTER + RADIUS + 16}px;
      transform: translateX(-50%);
      padding: 2px 8px;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.04em;
      color: #f0f0f0;
      background: rgba(20, 20, 20, 0.65);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 999px;
      backdrop-filter: blur(calc(6px * var(--rv-ui-blur-scale, 1)));
      -webkit-backdrop-filter: blur(calc(6px * var(--rv-ui-blur-scale, 1)));
      cursor: pointer;
      pointer-events: auto;
      transition: background 120ms ease, border-color 120ms ease;
      user-select: none;
      -webkit-user-select: none;
      white-space: nowrap;
      z-index: 2;
    `;
    this._attachHandlers(label as unknown as SVGElement);

    container.append(svg, cubeWrap, label);
    document.body.appendChild(container);

    this._container = container;
    this._svg = svg;
    this._label = label;
    this._cubeWrap = cubeWrap;
    this._cubeInner = cubeInner;
  }

  private _attachHandlers(el: SVGElement | HTMLElement): void {
    el.addEventListener('pointerenter', this._onElementEnter as EventListener);
    el.addEventListener('pointerleave', this._onElementLeave as EventListener);
    el.addEventListener('click', this._onElementClick as EventListener);
  }

  private _handleFor(e: Event): HandleId | null {
    const t = e.currentTarget as HTMLElement | null;
    return (t?.dataset?.handle as HandleId | undefined) ?? null;
  }

  // ─── Hover + actions ───────────────────────────────────────────────

  private _setHovered(handle: HandleId | null): void {
    if (this._hovered === handle) return;
    this._hovered = handle;
    this._refreshColors();
  }

  private _refreshColors(): void {
    for (const id of ALL_VIEWS) {
      const els = this._bars.get(id);
      if (!els) continue;
      const isHovered = this._hovered === id;
      const color = isHovered ? COLORS_BY_AXIS[id].hover : COLORS_BY_AXIS[id].idle;
      els.axisLabel?.setAttribute('fill', color);
    }
    // Cube face hover — each face highlights individually.
    // Order must match face construction in _buildDOM:
    // [front/+Z, back/-Z, right/+X, left/-X, top/+Y, bottom/-Y]
    const faceHandles: OrientationView[] = ['pos-z', 'neg-z', 'pos-x', 'neg-x', 'pos-y', 'neg-y'];
    const faceIdleColors = [
      CUBE_FACE_COLORS.front, CUBE_FACE_COLORS.back,
      CUBE_FACE_COLORS.right, CUBE_FACE_COLORS.left,
      CUBE_FACE_COLORS.top,   CUBE_FACE_COLORS.bottom,
    ];
    for (let i = 0; i < this._cubeFaces.length; i++) {
      const isHovered = this._hovered === faceHandles[i];
      this._cubeFaces[i].style.background = isHovered ? CUBE_FACE_HOVER : faceIdleColors[i];
    }
    if (this._label) {
      const isHovered = this._hovered === 'cube';
      this._label.style.background = isHovered
        ? 'rgba(255, 255, 255, 0.18)'
        : 'rgba(20, 20, 20, 0.65)';
      this._label.style.borderColor = isHovered
        ? 'rgba(255, 255, 255, 0.3)'
        : 'rgba(255, 255, 255, 0.12)';
    }
  }

  private _executeAction(handle: HandleId): void {
    const viewer = this._viewer;
    if (!viewer) return;
    if (handle === 'cube') {
      const next = viewer.projection === 'perspective' ? 'orthographic' : 'perspective';
      this._intendedLabel = next === 'orthographic' ? 'Iso' : 'Persp';
      this._writeLabel(this._intendedLabel);
      viewer.animateProjectionTo(next, 0.45);
      viewer.markRenderDirty();
      return;
    }
    // Axis handle — snap to face view
    const target = viewer.controls.target.clone();
    const distance = Math.max(viewer.camera.position.distanceTo(target), this._modelFallbackDistance());
    // For Y-axis views: snap the on-screen "up" direction to the nearest
    // cardinal XZ axis based on the current camera orientation, so the user
    // sees the closest 90°-rotation of their current view (minimal rotation
    // around Y).
    const upHint = (handle === 'pos-y' || handle === 'neg-y')
      ? this._computeYViewUpSnap()
      : undefined;
    const pos = viewToCameraPose(handle, target, distance, upHint);
    viewer.animateCameraTo(pos, target, 0.5);
  }

  /**
   * Pick the world XZ cardinal direction (±X or ±Z) closest to the current
   * camera's "up on screen" projection. Used when jumping to top/bottom view
   * so the orbit around Y is preserved to the nearest 90°.
   */
  private _computeYViewUpSnap(): Vector3 {
    const cam = this._viewer!.camera;
    cam.updateMatrixWorld(true);
    // Camera's local +Y axis in world coords = current "up on screen".
    const camUp = new Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    camUp.y = 0;
    if (camUp.lengthSq() < 1e-6) {
      // Camera looking horizontally → local Y ≈ world Y. Fall back to using
      // −forward (the direction the camera was facing away from) so the
      // resulting top view keeps a sensible orientation.
      const forward = new Vector3();
      cam.getWorldDirection(forward);
      forward.y = 0;
      if (forward.lengthSq() < 1e-6) return new Vector3(0, 0, -1);
      camUp.copy(forward).negate();
    }
    const absX = Math.abs(camUp.x);
    const absZ = Math.abs(camUp.z);
    if (absX >= absZ) return new Vector3(Math.sign(camUp.x) || 1, 0, 0);
    return new Vector3(0, 0, Math.sign(camUp.z) || 1);
  }

  private _modelFallbackDistance(): number {
    const viewer = this._viewer;
    if (!viewer) return 5;
    const root = (viewer as unknown as { currentModel: Object3D | null }).currentModel;
    if (!root) return 5;
    const v = new Vector3();
    root.updateMatrixWorld(true);
    root.getWorldPosition(v);
    const d = v.distanceTo(viewer.controls.target);
    return d > 0.5 ? d * 2 : 5;
  }

  // ─── Label ─────────────────────────────────────────────────────────

  private _refreshLabel(): void {
    if (!this._viewer || !this._label) return;
    const liveText = this._viewer.projection === 'orthographic' ? 'Iso' : 'Persp';
    if (this._intendedLabel === liveText) this._intendedLabel = null;
    const text = this._intendedLabel ?? liveText;
    this._writeLabel(text);
  }

  private _writeLabel(text: string): void {
    if (!this._label || text === this._lastLabelText) return;
    this._lastLabelText = text;
    this._label.textContent = text;
  }
}
