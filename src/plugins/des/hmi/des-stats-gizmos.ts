// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * des-stats-gizmos.ts -- per-component in-scene mini statistics badges.
 *
 * When enabled, anchors a small billboard ABOVE each DES component showing a
 * stacked utilization bar (Working / Setup / Blocked / Empty / Failure) and the
 * throughput (output/h). The badges are camera-facing Three.js sprites drawn from
 * a per-component canvas texture, redrawn on a timer from the live statistics.
 *
 * Toggled on/off from the DES toolbar (off by default — keeps the scene clean).
 * Self-contained: manages its own sprites (not the shared GizmoOverlayManager,
 * which only does square, node-centred sprites) so the badge can float above the
 * part with the right aspect ratio and never intercept raycasts.
 *
 * Moving components (plan-612 CP1d-a — a vehicle): each badge remembers its
 * anchor in the LOCAL frame of its node at creation and is carried along per
 * frame by `updateFrame()` (DES-HMI plugin `onRender`, no own render trigger):
 * x/z from the node's current world matrix, the height above the node's origin
 * kept constant — the badge stays vertical above the vehicle. Allocation-free
 * (pre-allocated vectors, an array instead of a map iterator). A standing node
 * keeps its badge where it was. A node carrying a state of charge
 * (`userData[DES_SOC_USERDATA_KEY]`, like the tooltip) gets a SOC row.
 *
 * Extension point (plan-644 D8): KPI rows come from registered providers
 * (`registerDesKpiRowProvider`; the SOC row is the first, built-in one) and
 * extra states from `registerDesState` (des-stat-colors.ts). A badge's height
 * is its row count; a registry change refreshes every badge, a changed row
 * count rebuilds it (texture + material disposed). With a custom
 * `DesBadgeRendererSpec` the KPI rows stay out — the renderer draws itself.
 */

import { type Sprite, type CanvasTexture, type Object3D, Box3, Vector3 } from 'three';
import type { PerspectiveCamera, OrthographicCamera } from 'three';
import type { RVViewer } from '../../../core/rv-viewer';
import { HIGHLIGHT_OVERLAY_LAYER } from '../../../core/engine/rv-group-registry';
import { createLabelSprite } from '../../../core/engine/rv-label-sprite';
import { getActiveDesRunner, desComponentsOf } from './des-active-runner';
import type { DESComponent } from '../rv-des-component';
import {
  DES_STATE_STACK as STATES,
  desStatePercent,
  notifyDesHmiExtensionsChanged,
  registeredDesStates,
  socOf,
  subscribeDesHmiExtensions,
  warnDesHmiDuplicate,
} from './des-stat-colors';
import { setDesStatsWindowOpen } from '../../sim-controller/des-stats-window-store';

const REFRESH_MS = 500;
const CANVAS_W = 200;
const CANVAS_H = 80;
const BADGE_HEIGHT_M = 0.4;           // world height of the badge
const BADGE_OFFSET_M = 0.65;          // gap above the component's bbox top
/** Canvas supersample factor: the texture is rendered at SUPERSAMPLE× the logical
 *  size (draw code keeps working in logical coords via `ctx.scale`) so the badge
 *  stays crisp when it appears larger than its logical size on screen — e.g. a
 *  screen-fixed badge on a high-DPI display. */
const BADGE_SUPERSAMPLE = 2;
/** Extra canvas height (logical px) of ONE KPI row of the default badge (the SOC row's height). */
const SOC_ROW_H = 22;

// ── KPI rows (plan-644 D8) ────────────────────────────────────────────────

/** One KPI row of a DES component, shown in the badge and the tooltip. */
export interface DesKpiRow {
  readonly label: string;
  readonly value: string;
  /** Value color in the tooltip. Default: white. */
  readonly color?: string;
  /** Text of the badge row. Default: `${label} ${value}`. */
  readonly badgeText?: string;
}

/** A source of KPI rows; `rows()` returns `[]` for a component it has nothing for. */
export interface DesKpiRowProvider {
  readonly id: string;
  rows(comp: DESComponent): ReadonlyArray<DesKpiRow>;
}

const _kpiProviders: DesKpiRowProvider[] = [];
const NO_ROWS: ReadonlyArray<DesKpiRow> = Object.freeze([]);

/**
 * Register a KPI row provider (plan-644 D8): its rows appear in every default
 * badge and in the tooltip, after the providers registered before it. A
 * duplicate `id` keeps the FIRST provider (DEV warning, no-op return).
 * Returns the unregister.
 */
export function registerDesKpiRowProvider(p: DesKpiRowProvider): () => void {
  if (_kpiProviders.some((q) => q.id === p.id)) {
    warnDesHmiDuplicate('KPI row provider', p.id);
    return () => {};
  }
  _kpiProviders.push(p);
  notifyDesHmiExtensionsChanged();
  return () => {
    const i = _kpiProviders.indexOf(p);
    if (i < 0) return;
    _kpiProviders.splice(i, 1);
    notifyDesHmiExtensionsChanged();
  };
}

/** All KPI rows of `comp`, provider by provider in registration order. */
export function desKpiRowsOf(comp: DESComponent): DesKpiRow[] {
  const out: DesKpiRow[] = [];
  for (const p of _kpiProviders) for (const r of p.rows(comp)) out.push(r);
  return out;
}

/** The built-in first provider: the state of charge of a battery vehicle (plan-612). */
registerDesKpiRowProvider({
  id: 'des.soc',
  rows(comp: DESComponent): ReadonlyArray<DesKpiRow> {
    const soc = socOf(comp.node);
    if (soc === null) return NO_ROWS;
    // Tooltip `SOC` | `47%`, badge `SOC 47 %` — exactly the former rows.
    return [{ label: 'SOC', value: `${soc.toFixed(0)}%`, badgeText: `SOC ${Math.round(soc)} %` }];
  },
});

interface Badge {
  comp: DESComponent;
  name: string;
  /** Logical (unscaled) canvas dimensions the draw code works in. */
  logicalW: number;
  logicalH: number;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: CanvasTexture;
  sprite: Sprite;
  /** The node the badge floats above (followed per frame). */
  node: Object3D;
  /** Anchor in the node's LOCAL frame (x/z follow the node). */
  local: Vector3;
  /** Anchor height above the node's world origin (m) — kept vertical. */
  heightAboveNode: number;
  /** KPI rows the default layout reserved at creation (0 with a custom renderer). */
  rowCount: number;
}

/**
 * Custom badge appearance, installable per viewer via
 * `DesStatsGizmos.setBadgeRenderer`. Lets a model plugin replace the default
 * name + stacked-bar + output/h layout (e.g. with an OEE badge) while keeping
 * all anchoring, raycast, visibility and refresh plumbing.
 */
export interface DesBadgeRendererSpec {
  canvasWidth: number;   // canvas px (default badge: 200)
  canvasHeight: number;  // canvas px (default badge: 80)
  worldHeightM: number;  // world height of the sprite (default badge: 0.4)
  offsetM: number;       // gap between the component's bbox top and the badge's BOTTOM edge
  /** When false, the badge is display-only: it does NOT register as a raycast
   *  target, so it never intercepts hover/click of the geometry beneath it
   *  (e.g. a badge floating above a machine won't block drive hovers from an
   *  elevated camera). Defaults to true (badge click opens the stats window). */
  interactive?: boolean;
  /** When set (> 0), the badge is rendered at a FIXED screen size: each frame it
   *  is rescaled (via `DesStatsGizmos.updateScreenSpaceSizing`, driven by a plugin
   *  `onRender` hook) so its on-screen height stays this many pixels regardless of
   *  camera distance / zoom. `worldHeightM` is then used only for the float anchor,
   *  not the visible size. Works for perspective and orthographic cameras. */
  screenHeightPx?: number;
  /** Draw the badge content; canvas is already cleared. */
  draw(ctx: CanvasRenderingContext2D, comp: DESComponent, w: number, h: number): void;
}

/** Scratch vector for the per-frame screen-space rescale (no per-call alloc). */
const _camPos = new Vector3();
/** Scratch vector for the per-frame follow (no per-call alloc). */
const _anchor = new Vector3();

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Draw the stacked per-state utilization bar (Working / Setup / Blocked / Empty /
 * Failure in `DES_STATE_STACK` order + colors). Shared with custom badge
 * renderers so every badge flavor keeps the identical state visualization.
 */
export function drawStateStackBar(
  ctx: CanvasRenderingContext2D,
  stats: unknown,
  x: number, y: number, w: number, h: number,
  comp?: DESComponent,
): void {
  let cx = x;
  for (const st of STATES) {
    const pct = (stats as Record<string, number>)[st.key] ?? 0;
    const seg = (w * pct) / 100;
    if (seg > 0.5) { ctx.fillStyle = st.color; ctx.fillRect(cx, y, seg, h); cx += seg; }
  }
  // Registered states (plan-644 D8) after the stack — only when the component is known.
  if (comp) {
    for (const st of registeredDesStates()) {
      const seg = (w * desStatePercent(comp, st.name)) / 100;
      if (seg > 0.5) { ctx.fillStyle = st.color; ctx.fillRect(cx, y, seg, h); cx += seg; }
    }
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
}

/** Draw the component name + stacked utilization bar + output/h into the canvas. */
function drawBadge(b: Badge): void {
  const { ctx } = b;
  const s = b.comp.getStatistics();
  const h = b.logicalH;
  ctx.clearRect(0, 0, CANVAS_W, h);

  // Background panel (semi-transparent dark, rounded).
  ctx.fillStyle = 'rgba(12,12,14,0.80)';
  roundRect(ctx, 1, 1, CANVAS_W - 2, h - 2, 9);
  ctx.fill();

  // Component name (top).
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = '13px Inter, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(b.name, CANVAS_W / 2, 16, CANVAS_W - 14);

  // Stacked utilization bar (middle).
  drawStateStackBar(ctx, s, 8, 28, CANVAS_W - 16, 18, b.comp);

  // Throughput text (bottom).
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 18px Inter, Arial, sans-serif';
  ctx.fillText(`${s.outputPerHour.toFixed(0)}/h`, CANVAS_W / 2, CANVAS_H - 14);

  // KPI rows (the SOC row of a battery vehicle first), one SOC_ROW_H band each.
  if (b.rowCount > 0) {
    const rows = desKpiRowsOf(b.comp);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '14px Inter, Arial, sans-serif';
    for (let i = 0; i < b.rowCount && i < rows.length; i++) {
      const r = rows[i];
      ctx.fillText(r.badgeText ?? `${r.label} ${r.value}`, CANVAS_W / 2, CANVAS_H + SOC_ROW_H * i + SOC_ROW_H / 2 - 4);
    }
  }

  b.texture.needsUpdate = true;
}

/**
 * Manages the set of in-scene stat badges (one instance per viewer — see
 * `getDesStatsGizmos`). Two independent visibility drivers, reconciled into the
 * actual badge set:
 *  - `setEnabled(true)`  → a badge above EVERY component (toolbar toggle).
 *  - `setTransient(path)`→ a single badge for the chart-hovered component (shown
 *                          even when the global toggle is OFF).
 * Badges are clickable (aux raycast → owner component); a click opens the chart.
 */
export class DesStatsGizmos {
  private readonly viewer: RVViewer;
  private badges = new Map<string, Badge>();
  /** The same badges as an array — the per-frame paths iterate it without an iterator allocation. */
  private readonly list: Badge[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private _all = false;
  private _transient: string | null = null;
  private _selected: string | null = null;
  private _renderer: DesBadgeRendererSpec | null = null;
  private readonly _offClick: () => void;
  /** Unsubscribe of the DES-HMI extension registries (states, KPI rows). */
  private _offExtensions: (() => void) | null;

  constructor(viewer: RVViewer) {
    this.viewer = viewer;
    // Clicking a badge (resolves to its owner component via aux raycast) opens
    // the stats chart. Only fires for components that currently have a badge.
    // NOTE: the viewer's event is 'object-clicked' with `{ path }` (not 'object-click').
    this._offClick = viewer.on('object-clicked', (data: unknown) => {
      const path = (data as { path?: string })?.path;
      if (path && this.badges.has(path)) setDesStatsWindowOpen(true);
    });
    // A registered / unregistered state or KPI row redraws (or resizes) every badge.
    this._offExtensions = subscribeDesHmiExtensions(() => this.refresh());
  }

  get enabled(): boolean {
    return this._all;
  }

  /** The live badge sprite of a component path, or null (diagnostics, tests). */
  spriteOf(path: string): Sprite | null {
    return this.badges.get(path)?.sprite ?? null;
  }

  /** Install (or clear with `null`) a custom badge appearance. Live badges are
   *  rebuilt so the new canvas / world dimensions take effect immediately. */
  setBadgeRenderer(spec: DesBadgeRendererSpec | null): void {
    if (spec === this._renderer) return;
    this._renderer = spec;
    for (const b of [...this.list]) this._removeBadge(b);
    this.reconcile();
  }

  /** Toggle a badge above every component. */
  setEnabled(on: boolean): void {
    if (on === this._all) return;
    this._all = on;
    this.reconcile();
  }

  /** Show a single transient badge for the chart-hovered component (null = none).
   *  No-op visually when the global toggle is on (that component already has one). */
  setTransient(path: string | null): void {
    if (path === this._transient) return;
    this._transient = path;
    this.reconcile();
  }

  /** Keep a PERSISTENT badge for the chart-SELECTED component (null = none). Unlike
   *  `setTransient` this survives mouse-out — cleared only on a new selection or
   *  when the window closes. */
  setSelected(path: string | null): void {
    if (path === this._selected) return;
    this._selected = path;
    this.reconcile();
  }

  /** The set of component paths that SHOULD have a badge right now. */
  private desiredPaths(source = getActiveDesRunner(this.viewer)): Set<string> {
    const want = new Set<string>();
    if (this._all && source) for (const c of desComponentsOf(source)) want.add(c.path);
    if (this._transient) want.add(this._transient);
    if (this._selected) want.add(this._selected);
    return want;
  }

  /** Create/remove badges so the live set matches `desiredPaths()`. */
  private reconcile(): void {
    const source = getActiveDesRunner(this.viewer);
    const want = this.desiredPaths(source);
    // Remove badges no longer wanted.
    for (const b of [...this.list]) {
      if (!want.has(b.comp.path)) this._removeBadge(b);
    }
    // Add missing badges.
    if (source) {
      const byPath = new Map(desComponentsOf(source).map((c) => [c.path, c]));
      for (const path of want) {
        if (this.badges.has(path)) continue;
        const comp = byPath.get(path);
        const badge = comp ? this.createBadge(comp) : null;
        if (badge) this._addBadge(badge);
      }
    }
    // Run the redraw timer only while at least one badge exists.
    if (this.badges.size > 0 && !this.timer) this.timer = setInterval(() => this.refresh(), REFRESH_MS);
    else if (this.badges.size === 0 && this.timer) { clearInterval(this.timer); this.timer = null; }
    this.refresh();
    // Size fixed-screen-size badges right away so they don't flash at world size
    // for one frame before the first onRender tick.
    this.updateScreenSpaceSizing();
  }

  /** Build one badge sprite above `comp`; null if its node can't be resolved. */
  private createBadge(comp: DESComponent): Badge | null {
    const node = this.viewer.registry?.getNode(comp.path) ?? null;
    if (!node) return null;
    // Default layout: one band per KPI row (the SOC row of a battery vehicle first).
    const rowCount = this.rowCountOf(comp);
    const w = this._renderer?.canvasWidth ?? CANVAS_W;
    const h = this._renderer?.canvasHeight ?? (CANVAS_H + rowCount * SOC_ROW_H);
    // Same pixel density with or without KPI rows (the rows only add height).
    const heightM = this._renderer?.worldHeightM ?? BADGE_HEIGHT_M * (h / CANVAS_H);
    const offsetM = this._renderer?.offsetM ?? BADGE_OFFSET_M;
    const canvas = document.createElement('canvas');
    // Render the texture at SUPERSAMPLE× resolution but keep the draw code in
    // logical coords (ctx.scale), so the badge is crisp when scaled up on screen.
    canvas.width = w * BADGE_SUPERSAMPLE; canvas.height = h * BADGE_SUPERSAMPLE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.scale(BADGE_SUPERSAMPLE, BADGE_SUPERSAMPLE);
    // Shared label contract (rv-label-sprite.ts): overlay layer (pulled OUT of
    // the AO/composer pass and drawn on top), toneMapped:false (canvas colors
    // render exactly as drawn), sRGB + anisotropy, no depth.
    const { sprite, texture } = createLabelSprite(canvas, { layer: HIGHLIGHT_OVERLAY_LAYER, renderOrder: 999 });
    sprite.scale.set(heightM * (w / h), heightM, 1);
    // Anchor at the TOP-CENTER of the component's world bbox: horizontally at the
    // bbox center, vertically above the bbox top. For a custom renderer the sprite
    // is lifted by heightM/2 so its BOTTOM edge sits `offsetM` above the top (an
    // unambiguous "floating just above"); the default badge keeps its original
    // center-at-top+offset placement.
    const box = new Box3().setFromObject(node);
    const center = new Vector3();
    let topY: number;
    if (box.isEmpty()) { node.getWorldPosition(center); topY = center.y; }
    else { box.getCenter(center); topY = box.max.y; }
    const lift = this._renderer ? heightM / 2 : 0;
    sprite.position.set(center.x, topY + offsetM + lift, center.z);
    // Remember the anchor in the node's frame (follow per frame, see updateFrame).
    const local = node.worldToLocal(sprite.position.clone());
    const heightAboveNode = sprite.position.y - node.matrixWorld.elements[13];
    this.viewer.scene.add(sprite);
    // Clickable (unless display-only): a hit on the badge resolves to the owner
    // component so a click opens the chart and a hover highlights the part.
    if (this._renderer?.interactive !== false) {
      this.viewer.raycastManager?.addAuxRaycastTarget(sprite, node);
    }
    const name = (comp as { displayName?: string }).displayName ?? comp.path.split('/').pop() ?? comp.path;
    const badge: Badge = { comp, name, logicalW: w, logicalH: h, canvas, ctx, texture, sprite, node, local, heightAboveNode, rowCount };
    this.draw(badge);
    return badge;
  }

  /** KPI rows of the default layout for `comp` (none with a custom renderer). */
  private rowCountOf(comp: DESComponent): number {
    if (this._renderer) return 0;
    let n = 0;
    for (const p of _kpiProviders) n += p.rows(comp).length;
    return n;
  }

  /** The ONE way a badge enters the set: list (iteration source) + map (index). */
  private _addBadge(b: Badge): void {
    this.badges.set(b.comp.path, b);
    this.list.push(b);
  }

  /** The ONE way a badge leaves the set: GPU resources freed, list + map updated. */
  private _removeBadge(b: Badge): void {
    this.removeBadge(b);
    if (this.badges.get(b.comp.path) === b) this.badges.delete(b.comp.path);
    const i = this.list.indexOf(b);
    if (i >= 0) this.list.splice(i, 1);
  }

  private removeBadge(b: Badge): void {
    this.viewer.raycastManager?.removeAuxRaycastTarget(b.sprite);
    this.viewer.scene.remove(b.sprite);
    b.sprite.material.dispose();
    b.texture.dispose();
  }

  /** Draw one badge — custom renderer when installed, else the default layout. */
  private draw(b: Badge): void {
    if (this._renderer) {
      // Draw in LOGICAL coords — the ctx is pre-scaled by BADGE_SUPERSAMPLE, so the
      // renderer's fixed pixel layout maps onto the higher-res canvas.
      b.ctx.clearRect(0, 0, b.logicalW, b.logicalH);
      this._renderer.draw(b.ctx, b.comp, b.logicalW, b.logicalH);
      b.texture.needsUpdate = true;
    } else {
      drawBadge(b);
    }
  }

  /** Redraw all live badge canvases from the current statistics. */
  private refresh(): void {
    for (const b of [...this.list]) {
      // The KPI row count changed since the badge was built (a SOC appeared /
      // vanished, a provider registered / unregistered): rebuild it at the new
      // height. Rare (bind / unbind of a project, registration).
      if (this.rowCountOf(b.comp) !== b.rowCount) {
        this._removeBadge(b);
        const nb = this.createBadge(b.comp);
        if (nb) this._addBadge(nb); // createBadge drew it
        continue;
      }
      this.draw(b);
    }
  }

  /**
   * Per-frame update (DES-HMI plugin `onRender`): carry every badge along with
   * its node, then the fixed-screen-size rescale. Allocation-free; the node's
   * world matrix is the one the viewer refreshed for this frame. No render
   * trigger of its own — a node only moves while the scene is being rendered.
   */
  updateFrame(): void {
    if (this.list.length === 0) return;
    this.followNodes();
    this.updateScreenSpaceSizing();
  }

  /** Badge position from the node's CURRENT world matrix: x/z of the local anchor, height above the node origin. */
  private followNodes(): void {
    for (let i = 0; i < this.list.length; i++) {
      const b = this.list[i];
      const m = b.node.matrixWorld;
      _anchor.copy(b.local).applyMatrix4(m);
      b.sprite.position.set(_anchor.x, m.elements[13] + b.heightAboveNode, _anchor.z);
    }
  }

  /**
   * Rescale fixed-screen-size badges (renderer `screenHeightPx`) so each keeps a
   * constant on-screen pixel height regardless of camera distance / zoom. Call
   * every frame from a plugin `onRender` hook; no-op unless the active renderer
   * requests it. Supports perspective and orthographic cameras — the codebase
   * avoids `sizeAttenuation:false` because three.js bypasses it under ortho.
   */
  updateScreenSpaceSizing(): void {
    const px = this._renderer?.screenHeightPx;
    if (!px || px <= 0 || this.badges.size === 0) return;
    const cam = this.viewer.camera;
    const vpH = (this.viewer.renderer.domElement as HTMLElement).clientHeight || 1;
    const aspect = this._renderer!.canvasWidth / this._renderer!.canvasHeight;
    const frac = px / vpH; // desired badge height as a fraction of the viewport
    if ((cam as OrthographicCamera).isOrthographicCamera) {
      const oc = cam as OrthographicCamera;
      const worldH = ((oc.top - oc.bottom) / oc.zoom) * frac;
      const worldW = worldH * aspect;
      for (let i = 0; i < this.list.length; i++) this.list[i].sprite.scale.set(worldW, worldH, 1);
    } else {
      const pc = cam as PerspectiveCamera;
      const tanHalf = Math.tan((pc.fov * Math.PI) / 360); // tan(fov/2), fov in deg
      pc.getWorldPosition(_camPos);
      for (let i = 0; i < this.list.length; i++) {
        const b = this.list[i];
        const dist = _camPos.distanceTo(b.sprite.position);
        const worldH = 2 * dist * tanHalf * frac;
        b.sprite.scale.set(worldH * aspect, worldH, 1);
      }
    }
  }

  /** Tear down (on leaving DES mode / dispose). */
  dispose(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this._offExtensions?.();
    this._offExtensions = null;
    for (const b of [...this.list]) this._removeBadge(b);
    this._all = false;
    this._transient = null;
    this._selected = null;
    this._offClick();
  }
}

// ── Per-viewer singleton (the toolbar button and the chart hover share one) ──

const _instances = new WeakMap<RVViewer, DesStatsGizmos>();

/** Get (or lazily create) the in-scene badge manager for a viewer. */
export function getDesStatsGizmos(viewer: RVViewer): DesStatsGizmos {
  let m = _instances.get(viewer);
  if (!m) { m = new DesStatsGizmos(viewer); _instances.set(viewer, m); }
  return m;
}

/** Return the existing badge manager WITHOUT creating one (safe for cleanup). */
export function peekDesStatsGizmos(viewer: RVViewer): DesStatsGizmos | undefined {
  return _instances.get(viewer);
}

/** Dispose + forget the badge manager for a viewer (on leaving DES mode). */
export function disposeDesStatsGizmos(viewer: RVViewer): void {
  const m = _instances.get(viewer);
  if (m) { m.dispose(); _instances.delete(viewer); }
}
