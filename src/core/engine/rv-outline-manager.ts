// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVOutlineManager — Wraps Three.js OutlinePass for plugin-driven outline
 * highlights.
 *
 * Two independent channels:
 *   - **selection** (cyan by default): persistent outlines for selected nodes,
 *     used by the SelectionManager via the highlight manager. The layout
 *     planner overrides the style to a green silhouette while active.
 *   - **hover** (orange by default): transient outlines for the node under
 *     the cursor, used by RaycastManager via the highlight manager.
 *
 * Each channel owns its own OutlinePass instance + style, so hover and
 * selection can render different colors simultaneously. Passes are lazily
 * inserted into the viewer's EffectComposer (just before the OutputPass) on
 * first use.
 *
 * WebGPURenderer paths (plan-271 Phase 3): instead of the composer, the
 * channels drive three's native TSL outline node on the viewer's TSL post
 * pipeline (rv-post-processing-tsl.ts) — same channel/style API, lazily
 * linked via the host's `_ensureTslPost()`. `pulsePeriod` is not animated
 * on the TSL path (all app styles use 0).
 *
 * Usage:
 *   viewer.outlineManager.setStyle({ visibleEdgeColor: 0x4fc34f });   // selection
 *   viewer.outlineManager.setOutlined([selectedRoot]);
 *   viewer.outlineManager.setHoverStyle({ visibleEdgeColor: 0xffb870 });
 *   viewer.outlineManager.setHoverOutlined([hoveredRoot]);
 *   ...
 *   viewer.outlineManager.clearAll();
 */

import { Vector2, Color } from 'three';
import type { Object3D, PerspectiveCamera, OrthographicCamera, Plane, Scene } from 'three';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import type { TslPostPipeline, TslOutlineChannelId } from './materials/rv-post-processing-tsl';

// ─── Style ────────────────────────────────────────────────────────────

export interface OutlineStyle {
  /** Hex color of the outline edge over visible faces. */
  visibleEdgeColor: number;
  /** Hex color of the outline edge through occluding geometry. */
  hiddenEdgeColor: number;
  /** Edge intensity multiplier (1 thin, 10 strong). */
  edgeStrength: number;
  /** Edge thickness in pixels (1..4). */
  edgeThickness: number;
  /** Glow halo around the edge (0 = crisp, 1 = wide bloom). */
  edgeGlow: number;
  /** Pulse period in seconds (0 = no pulse). */
  pulsePeriod: number;
}

/** Default selection outline — the deeper BLUE silhouette used by HMI and DES
 *  modes (the modes that keep the app-wide defaults). Editor mode overrides this
 *  with amber-yellow, the planner with green, so the outline color signals the
 *  active mode. Matches DEFAULT_SELECTION_STYLE.edgeColor so the overlay and the
 *  post-process silhouette agree. */
export const DEFAULT_OUTLINE_STYLE: OutlineStyle = Object.freeze({
  visibleEdgeColor: 0x1e88ff,
  hiddenEdgeColor: 0x0a3059,
  edgeStrength: 6,
  edgeThickness: 2,
  edgeGlow: 0.35,
  pulsePeriod: 0,
});

/** Default hover outline — a lighter, less intense BLUE than the selection
 *  silhouette so a hovered object reads as a hint. Matches
 *  DEFAULT_HOVER_STYLE.edgeColor. */
export const DEFAULT_HOVER_OUTLINE_STYLE: OutlineStyle = Object.freeze({
  visibleEdgeColor: 0x4aa3ff,
  hiddenEdgeColor: 0x1a3959,
  edgeStrength: 4.5,
  edgeThickness: 2,
  edgeGlow: 0.3,
  pulsePeriod: 0,
});

/** Default chain outline — pale green, distinct from the vivid green used for the
 *  focused (hovered/selected) object. Used by the snap-point chain preview to
 *  outline every asset that will follow the focused one in chain mode. */
export const DEFAULT_CHAIN_OUTLINE_STYLE: OutlineStyle = Object.freeze({
  visibleEdgeColor: 0xa6e8ad,
  hiddenEdgeColor: 0x4a6b4f,
  edgeStrength: 3,
  edgeThickness: 2,
  edgeGlow: 0.25,
  pulsePeriod: 0,
});

/** Edge geometry shared by the attention channels (status + flash).
 *
 *  Deliberately the SAME crisp silhouette as the selection outline above: only
 *  the color and the pulse should tell an alarm apart from a selection. The
 *  original Toray values (strength 20, thickness 10, glow 1.5) were far outside
 *  the 1..4 px thickness the OutlinePass is built for — the blur kernel widened
 *  faster than the mask, so the "outline" rendered as a fat, washed-out halo
 *  around the part instead of an edge. Change these three numbers here and both
 *  attention channels follow. */
export const ATTENTION_OUTLINE_GEOMETRY = Object.freeze({
  edgeStrength: 6,
  edgeThickness: 2,
  edgeGlow: 0.35,
});

/** Default status outline — the alarm/severity silhouette. Callers always
 *  override color + pulsePeriod per status via setStatusStyle; these defaults
 *  just keep the channel sane before first use.
 *  WebGL only — the status channel has no TSL mirror (WebGPU shows no status
 *  outline; the OutlinePass pulse never animated there anyway). */
export const DEFAULT_STATUS_OUTLINE_STYLE: OutlineStyle = Object.freeze({
  visibleEdgeColor: 0xffa726,
  hiddenEdgeColor: 0x8c5c15,
  ...ATTENTION_OUTLINE_GEOMETRY,
  pulsePeriod: 0.6,
});

/** Default flash outline — the alarm-flash silhouette used by
 *  RVHighlightManager.flash() (fill + edges + outline combined, all modes).
 *  Callers override color per alarm via setFlashStyle. Independent of the
 *  selection channel, so an alarm pulse never clobbers the user's selection
 *  outline. */
export const DEFAULT_FLASH_OUTLINE_STYLE: OutlineStyle = Object.freeze({
  visibleEdgeColor: 0xff3030,
  hiddenEdgeColor: 0x591111,
  ...ATTENTION_OUTLINE_GEOMETRY,
  pulsePeriod: 0.6,
});

// ─── Manager ──────────────────────────────────────────────────────────

/**
 * Minimal viewer surface this manager needs. Defined as an interface so
 * we don't take a hard dependency on RVViewer (avoids a circular import).
 */
export interface OutlineHostViewer {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera | OrthographicCamera;
  readonly renderer: { domElement: HTMLCanvasElement };
  readonly isWebGPU: boolean;
  /** Lazily creates the EffectComposer (no-op if it already exists). */
  _ensureComposer(): void;
  /** The composer once `_ensureComposer` has run; null on WebGPU. */
  readonly _composer: EffectComposer | null;
  /** Lazily creates the TSL post pipeline (WebGPURenderer paths only —
   *  plan-271 Phase 3). Optional so lightweight test hosts stay valid. */
  _ensureTslPost?(): TslPostPipeline | null;
  /** Mark the next frame as needing a render. */
  markRenderDirty(): void;
}

interface ChannelState {
  /** Channel id on the TSL post pipeline (WebGPURenderer paths). Null for
   *  WebGL-only channels (status) that have no TSL mirror. */
  readonly id: TslOutlineChannelId | null;
  pass: OutlinePass | null;
  outlined: Object3D[];
  style: OutlineStyle;
}

export class RVOutlineManager {
  private readonly _viewer: OutlineHostViewer;
  private readonly _selection: ChannelState = {
    id: 'selection', pass: null, outlined: [], style: { ...DEFAULT_OUTLINE_STYLE },
  };
  private readonly _hover: ChannelState = {
    id: 'hover', pass: null, outlined: [], style: { ...DEFAULT_HOVER_OUTLINE_STYLE },
  };
  private readonly _chain: ChannelState = {
    id: 'chain', pass: null, outlined: [], style: { ...DEFAULT_CHAIN_OUTLINE_STYLE },
  };
  private readonly _status: ChannelState = {
    id: null, pass: null, outlined: [], style: { ...DEFAULT_STATUS_OUTLINE_STYLE },
  };
  private readonly _flash: ChannelState = {
    id: 'flash', pass: null, outlined: [], style: { ...DEFAULT_FLASH_OUTLINE_STYLE },
  };
  /** TSL post pipeline once linked (WebGPURenderer paths, plan-271 Phase 3). */
  private _tslPost: TslPostPipeline | null = null;
  /** Section planes mirrored to OutlinePass' depth and selection-mask
   *  override materials so selected clipped geometry cannot reappear. */
  private _clippingPlanes: Plane[] | null = null;

  constructor(viewer: OutlineHostViewer) {
    this._viewer = viewer;
  }

  // ─── Public API ────────────────────────────────────────────────────

  /**
   * True when the manager can render outlines. On WebGL always true —
   * passes are lazily created on first use. On the WebGPURenderer paths
   * true when the host exposes the TSL post pipeline (plan-271 Phase 3);
   * the actual link happens lazily and falls back to a no-op when the TSL
   * module pre-warm failed.
   */
  get available(): boolean {
    if (!this._viewer.isWebGPU) return true;
    return typeof this._viewer._ensureTslPost === 'function';
  }

  /** Whether any outlines are currently active in any channel. */
  get hasOutlines(): boolean {
    return this._selection.outlined.length > 0
      || this._hover.outlined.length > 0
      || this._chain.outlined.length > 0
      || this._status.outlined.length > 0
      || this._flash.outlined.length > 0;
  }

  /** Whether any channel is showing a PULSING outline (pulsePeriod > 0).
   *  The render loop must keep rendering while true — the OutlinePass pulse
   *  animates from the wall clock and only advances when frames render. */
  get hasPulsingOutlines(): boolean {
    for (const ch of [this._selection, this._hover, this._chain, this._status, this._flash]) {
      if (ch.outlined.length > 0 && ch.style.pulsePeriod > 0) return true;
    }
    return false;
  }

  /** The selection-channel OutlinePass instance, or null if not yet created. */
  get pass(): OutlinePass | null {
    return this._selection.pass;
  }

  /** The hover-channel OutlinePass instance, or null if not yet created. */
  get hoverPass(): OutlinePass | null {
    return this._hover.pass;
  }

  /** Keep all lazily-created WebGL outline masks consistent with section cuts. */
  setClippingPlanes(planes: Plane[] | null): void {
    this._clippingPlanes = planes;
    for (const ch of [this._selection, this._hover, this._chain, this._status, this._flash]) {
      if (!ch.pass) continue;
      ch.pass.depthMaterial.clippingPlanes = planes;
      ch.pass.depthMaterial.needsUpdate = true;
      ch.pass.prepareMaskMaterial.clippingPlanes = planes;
      ch.pass.prepareMaskMaterial.needsUpdate = true;
    }
    this._viewer.markRenderDirty();
  }

  // ─── Selection channel (default channel — backward-compatible API) ──

  /**
   * Replace the selection-channel outlined objects. Empty array clears.
   */
  setOutlined(objects: readonly Object3D[]): void {
    this._setChannelOutlined(this._selection, objects);
  }

  /** Clear selection-channel outlines. */
  clear(): void {
    this.setOutlined([]);
  }

  /** Update selection-channel style (partial — only provided fields change). */
  setStyle(style: Partial<OutlineStyle>): void {
    this._selection.style = { ...this._selection.style, ...style };
    this._applyStyle(this._selection);
    if (this._selection.outlined.length > 0) this._viewer.markRenderDirty();
  }

  /** Read the current selection-channel style. */
  getStyle(): Readonly<OutlineStyle> {
    return this._selection.style;
  }

  // ─── Hover channel ─────────────────────────────────────────────────

  /** Replace the hover-channel outlined objects. Empty array clears. */
  setHoverOutlined(objects: readonly Object3D[]): void {
    this._setChannelOutlined(this._hover, objects);
  }

  /** Clear hover-channel outlines. */
  clearHover(): void {
    this.setHoverOutlined([]);
  }

  /** Update hover-channel style. */
  setHoverStyle(style: Partial<OutlineStyle>): void {
    this._hover.style = { ...this._hover.style, ...style };
    this._applyStyle(this._hover);
    if (this._hover.outlined.length > 0) this._viewer.markRenderDirty();
  }

  /** Read the current hover-channel style. */
  getHoverStyle(): Readonly<OutlineStyle> {
    return this._hover.style;
  }

  // ─── Chain channel (pale green — snap-point chain preview) ─────────

  /** The chain-channel OutlinePass instance, or null if not yet created. */
  get chainPass(): OutlinePass | null {
    return this._chain.pass;
  }

  /** Replace the chain-channel outlined objects. Empty array clears. */
  setChainOutlined(objects: readonly Object3D[]): void {
    this._setChannelOutlined(this._chain, objects);
  }

  /** Clear chain-channel outlines. */
  clearChain(): void {
    this.setChainOutlined([]);
  }

  /** Update chain-channel style. */
  setChainStyle(style: Partial<OutlineStyle>): void {
    this._chain.style = { ...this._chain.style, ...style };
    this._applyStyle(this._chain);
    if (this._chain.outlined.length > 0) this._viewer.markRenderDirty();
  }

  /** Read the current chain-channel style. */
  getChainStyle(): Readonly<OutlineStyle> {
    return this._chain.style;
  }

  // ─── Status channel (alarm/severity/instruction outline — WebGL only) ──

  /** The status-channel OutlinePass instance, or null if not yet created. */
  get statusPass(): OutlinePass | null {
    return this._status.pass;
  }

  /** Replace the status-channel outlined objects. Empty array clears.
   *  Prefer the rv-status-outline.ts helpers over calling this directly —
   *  they add batched-geometry proxies and owner tracking. */
  setStatusOutlined(objects: readonly Object3D[]): void {
    this._setChannelOutlined(this._status, objects);
  }

  /** Clear status-channel outlines. */
  clearStatus(): void {
    this.setStatusOutlined([]);
  }

  /** Update status-channel style. */
  setStatusStyle(style: Partial<OutlineStyle>): void {
    this._status.style = { ...this._status.style, ...style };
    this._applyStyle(this._status);
    if (this._status.outlined.length > 0) this._viewer.markRenderDirty();
  }

  /** Read the current status-channel style. */
  getStatusStyle(): Readonly<OutlineStyle> {
    return this._status.style;
  }

  // ─── Flash channel (alarm flash — RVHighlightManager.flash()) ──────

  /** The flash-channel OutlinePass instance, or null if not yet created. */
  get flashPass(): OutlinePass | null {
    return this._flash.pass;
  }

  /** Replace the flash-channel outlined objects. Empty array clears.
   *  Prefer RVHighlightManager.flash() over calling this directly — it adds
   *  the matching fill+edges overlay set and the auto-clear timer. */
  setFlashOutlined(objects: readonly Object3D[]): void {
    this._setChannelOutlined(this._flash, objects);
  }

  /** Clear flash-channel outlines. */
  clearFlash(): void {
    this.setFlashOutlined([]);
  }

  /** Update flash-channel style. */
  setFlashStyle(style: Partial<OutlineStyle>): void {
    this._flash.style = { ...this._flash.style, ...style };
    this._applyStyle(this._flash);
    if (this._flash.outlined.length > 0) this._viewer.markRenderDirty();
  }

  /** Read the current flash-channel style. */
  getFlashStyle(): Readonly<OutlineStyle> {
    return this._flash.style;
  }

  // ─── Aggregated ────────────────────────────────────────────────────

  /** Clear all channels. */
  clearAll(): void {
    this.clear();
    this.clearHover();
    this.clearChain();
    this.clearStatus();
    this.clearFlash();
  }

  /** Resize handler — call from the renderer's resize observer. */
  setSize(width: number, height: number): void {
    if (this._selection.pass) this._selection.pass.setSize(width, height);
    if (this._hover.pass) this._hover.pass.setSize(width, height);
    if (this._chain.pass) this._chain.pass.setSize(width, height);
    if (this._status.pass) this._status.pass.setSize(width, height);
    if (this._flash.pass) this._flash.pass.setSize(width, height);
  }

  /**
   * Re-bind every active OutlinePass to the host viewer's currently active
   * camera. Cheap (single property write per pass) — call from the per-frame
   * render loop so outlines stay correctly projected after a perspective ↔
   * orthographic swap. No-op when no passes have been created yet.
   */
  syncCamera(): void {
    if (this._selection.pass) this._selection.pass.renderCamera = this._viewer.camera;
    if (this._hover.pass) this._hover.pass.renderCamera = this._viewer.camera;
    if (this._chain.pass) this._chain.pass.renderCamera = this._viewer.camera;
    if (this._status.pass) this._status.pass.renderCamera = this._viewer.camera;
    if (this._flash.pass) this._flash.pass.renderCamera = this._viewer.camera;
  }

  /** Tear down all passes (does not remove them from the composer chain).
   *  The TSL pipeline itself is owned + disposed by PostProcessingManager —
   *  only the channel selections are cleared here. */
  dispose(): void {
    for (const ch of [this._selection, this._hover, this._chain, this._status, this._flash]) {
      if (ch.pass) {
        ch.pass.dispose();
        ch.pass.selectedObjects = [];
        ch.pass = null;
      }
      ch.outlined = [];
      if (ch.id) this._tslPost?.setOutlined(ch.id, []);
    }
    this._tslPost = null;
  }

  // ─── Internal ──────────────────────────────────────────────────────

  private _setChannelOutlined(channel: ChannelState, objects: readonly Object3D[]): void {
    if (!this.available) return;
    if (objects.length === 0) {
      if (channel.outlined.length === 0) return;
      channel.outlined = [];
      if (channel.pass) channel.pass.selectedObjects = channel.outlined;
      if (channel.id) this._tslPost?.setOutlined(channel.id, channel.outlined);
      this._viewer.markRenderDirty();
      return;
    }
    this._ensurePass(channel);
    channel.outlined = [...objects];
    if (channel.pass) channel.pass.selectedObjects = channel.outlined;
    if (channel.id) this._tslPost?.setOutlined(channel.id, channel.outlined);
    this._viewer.markRenderDirty();
  }

  /** Lazily link the host's TSL post pipeline (WebGPURenderer paths) and push
   *  all current channel styles once — styles set before the link (e.g. the
   *  highlighter's constructor-time setStyle) would otherwise be lost. */
  private _ensureTslLink(): void {
    if (this._tslPost || !this._viewer._ensureTslPost) return;
    const pipeline = this._viewer._ensureTslPost();
    if (!pipeline) return; // pre-warm failed — outlines stay off (F4 guard)
    this._tslPost = pipeline;
    for (const ch of [this._selection, this._hover, this._chain, this._flash]) {
      if (ch.id) pipeline.setOutlineStyle(ch.id, ch.style);
    }
  }

  /**
   * Create an OutlinePass on first need and insert it just before the
   * OutputPass. Forces composer creation if it doesn't exist yet (planner
   * mode may activate before AO or bloom turn on). On the WebGPURenderer
   * paths there is no OutlinePass — the channel drives the TSL pipeline's
   * native outline node instead (plan-271 Phase 3).
   */
  private _ensurePass(channel: ChannelState): void {
    if (this._viewer.isWebGPU) {
      this._ensureTslLink();
      return;
    }
    if (channel.pass || !this.available) return;

    // Force the composer into existence — needed because the viewer only
    // builds it lazily when AO or bloom flips on. Outlines also need it.
    this._viewer._ensureComposer();
    const composer = this._viewer._composer;
    if (!composer) return;

    const canvas = this._viewer.renderer.domElement;
    const w = canvas.width || canvas.clientWidth || 1;
    const h = canvas.height || canvas.clientHeight || 1;

    const pass = new OutlinePass(
      new Vector2(w, h),
      this._viewer.scene,
      this._viewer.camera,
    );
    channel.pass = pass;
    pass.depthMaterial.clippingPlanes = this._clippingPlanes;
    pass.prepareMaskMaterial.clippingPlanes = this._clippingPlanes;
    this._applyStyle(channel);

    // Insert just before the OutputPass so the outline is composited
    // onto the post-AO + post-bloom buffer and then tone-mapped together
    // with everything else. If no OutputPass is found (defensive), append.
    const passes = composer.passes;
    const outputIdx = passes.findIndex((p) => p instanceof OutputPass);
    if (outputIdx >= 0) {
      composer.insertPass(pass, outputIdx);
    } else {
      composer.addPass(pass);
    }
  }

  private _applyStyle(channel: ChannelState): void {
    // TSL path (WebGPURenderer): mirror the style into the pipeline's
    // channel uniforms (pulsePeriod is not animated there). WebGL-only
    // channels (status, id null) have no TSL mirror.
    if (channel.id) this._tslPost?.setOutlineStyle(channel.id, channel.style);
    if (!channel.pass) return;
    const s = channel.style;
    channel.pass.visibleEdgeColor = new Color(s.visibleEdgeColor);
    channel.pass.hiddenEdgeColor = new Color(s.hiddenEdgeColor);
    channel.pass.edgeStrength = s.edgeStrength;
    channel.pass.edgeThickness = s.edgeThickness;
    channel.pass.edgeGlow = s.edgeGlow;
    channel.pass.pulsePeriod = s.pulsePeriod;
  }
}
