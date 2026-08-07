// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * PostProcessingManager — Owns the WebGL post-processing pipeline.
 *
 * Encapsulates the {@link EffectComposer} plus the GTAO, N8AO, UnrealBloom,
 * fullscreen desaturation, and group-isolate overlay resources. Extracted
 * from {@link RVViewer} as part of plan-177 phase 7b so the post-processing
 * concerns can be owned and tested in isolation.
 *
 * The manager is a thin layer of state and accessors — the actual render
 * orchestration (multi-pass isolate, overlay layers, composer-vs-direct
 * decision) stays on the viewer because it touches the wider scene graph
 * and runtime state. The manager exposes everything the viewer needs to
 * drive those decisions.
 *
 * The viewer keeps a one-to-one delegating proxy on its public API
 * (`viewer.bloomEnabled`, `viewer.aoMode`, …) so the 71 external consumers
 * of RVViewer remain unchanged. The side-effects that the original setters
 * triggered (composer lazily ensured, `_renderDirty` flag set, AO pass
 * lazy-imported) all live here now, behind the same property names.
 *
 * On WebGPU the composer is never created — instead the manager owns a lazy
 * TSL node-post pipeline (plan-271 Phase 3, see rv-post-processing-tsl.ts):
 * `ensureTslPost()` mirrors `ensureComposer()`, `useTslPost` mirrors
 * `useComposer`, and the viewer's render loop routes the frame through
 * `renderTslPost()` (which REPLACES `renderer.render()`) whenever any TSL
 * effect (AO / outlines / saturation) is active. Bloom remains WebGL-only;
 * the manager still tracks `_bloomEnabled` so the value re-applies if the
 * user later falls back to the WebGL renderer.
 */

import {
  Vector2,
  Scene,
  PerspectiveCamera,
  OrthographicCamera,
  Mesh,
  MeshBasicMaterial,
  ShaderMaterial,
  WebGLRenderTarget,
  WebGLRenderer,
  PlaneGeometry,
  Plane,
  DoubleSide,
} from 'three';
import type { Renderer } from 'three/webgpu';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { Pass } from 'three/addons/postprocessing/Pass.js';

import type { AOMode } from './hmi/visual-settings-store';
import { NO_AO_LAYER } from './engine/rv-constants';
import { getTslMaterials } from './engine/materials/material-factory';
import type { TslPostPipeline, DesatBlitTsl } from './engine/materials/rv-post-processing-tsl';

// ─── Host interface ───────────────────────────────────────────────────────

/**
 * Minimal viewer surface the manager needs. Defined as an interface so the
 * manager has no hard dependency on {@link RVViewer} — mirrors the existing
 * {@link OutlineHostViewer} pattern in rv-outline-manager.ts.
 */
export interface PostProcessingHost {
  readonly renderer: Renderer | WebGLRenderer;
  readonly scene: Scene;
  /** Active camera. Used to seed RenderPass / GTAO / N8AO at composer-build
   *  time; the viewer re-binds the live camera per frame inside its render
   *  loop, so this is mostly bootstrap. */
  readonly camera: PerspectiveCamera | OrthographicCamera;
  readonly isWebGPU: boolean;
  /** True when MSAA was requested at renderer-create time. Mirrored into
   *  composer render-target samples and into the desaturation RT. */
  readonly antialiasActive: boolean;
  /** Whether the outline subsystem currently has any outlined nodes. The
   *  manager folds this into `useComposer` so OutlinePass becomes a
   *  composer-only path when nothing else (AO/Bloom) is on. */
  readonly outlineHasOutlines: boolean;
  /** Whether the Toon render mode's post passes (posterize + outline) are
   *  active. Folds into `useComposer` so toon engages the composer even when
   *  AO/Bloom are off. */
  readonly toonPassActive: boolean;
  /** Mark the next frame as needing a render. The viewer's render-on-demand
   *  loop reads this flag — every state-changing setter on the manager
   *  calls into here so users see the change immediately. */
  markRenderDirty(): void;
}

// ─── Constants ────────────────────────────────────────────────────────────

/** Internal buffers for GTAO/N8AO/Bloom run at half resolution for performance. */
export const PP_SCALE = 0.5;

/**
 * Classic WebGL compatibility only. three r185 multiplies UnrealBloomPass'
 * composite color by 3, while the WebGL presets were authored against r171.
 * WebGPU uses its separate TSL pipeline and must never consume this factor.
 */
const WEBGL_R171_BLOOM_COMPATIBILITY_GAIN = 3;

function toWebGLBloomStrength(intensity: number): number {
  return intensity / WEBGL_R171_BLOOM_COMPATIBILITY_GAIN;
}

// ─── Manager ──────────────────────────────────────────────────────────────

export class PostProcessingManager {
  private readonly host: PostProcessingHost;

  // ── Composer + pass refs ────────────────────────────────────────────
  /** EffectComposer used for AO / Bloom / Outline. WebGPU: always null. */
  private _composer: EffectComposer | null = null;
  private _gtaoPass: GTAOPass | null = null;
  /** N8AO pass — lazily loaded on first use (dynamic-imported so the ~60 KB
   *  dep stays out of the initial bundle when the user is on GTAO). */
  private _n8aoPass: Pass | null = null;
  private _bloomPass: UnrealBloomPass | null = null;
  /** Section planes mirrored onto GTAO's override normal material. Without
   *  this, clipped geometry still contributes to the AO gbuffer and appears
   *  as a faint ghost over the already-discarded beauty pass. */
  private _clippingPlanes: Plane[] | null = null;
  /** Clone of the active camera with NO_AO_LAYER disabled — fed to GTAO/N8AO so
   *  NO_AO-tagged UI never enters the AO gbuffer. Reused across frames; rebuilt
   *  only on a persp↔ortho switch. See {@link syncAoCamera}. */
  private _aoCamera: PerspectiveCamera | OrthographicCamera | null = null;

  // ── State (source of truth) ──────────────────────────────────────────
  private _aoMode: AOMode = 'gtao';
  /** True iff an n8ao-import attempt is currently in flight, to coalesce
   *  rapid toggle clicks while the network / module eval resolves. */
  private _n8aoLoading = false;
  private _bloomEnabled = false;
  /** Persist bloom values independently of the lazy WebGL pass. This also
   *  preserves settings configured while bloom is disabled or on WebGPU. */
  private _bloomIntensity = 0.5;
  private _bloomThreshold = 0.85;
  private _bloomRadius = 0.4;

  // ── Isolate overlay (semi-transparent wash for group-isolate) ────────
  private _isolateOverlayScene: Scene | null = null;
  private _isolateOverlayCam: OrthographicCamera | null = null;
  private _isolateOverlayMat: MeshBasicMaterial | null = null;

  // ── Desaturation pass (framebuffer-level grayscale during isolate) ──
  private _desatRT: WebGLRenderTarget | null = null;
  private _desatScene: Scene | null = null;
  private _desatCam: OrthographicCamera | null = null;
  private _desatMat: ShaderMaterial | null = null;

  // ── TSL node post (WebGPURenderer paths — plan-271 Phase 3) ─────────
  /** TSL RenderPipeline wrapper (AO / outlines / saturation). WebGL: always null. */
  private _tslPost: TslPostPipeline | null = null;
  /** TSL isolate-desaturation blit (shared Rec601 node). WebGL: always null. */
  private _tslDesat: DesatBlitTsl | null = null;
  private _warnedTslPostUnavailable = false;

  constructor(host: PostProcessingHost) {
    this.host = host;
  }

  // ─── Composer accessors (for OutlineManager and render orchestration) ──

  /** Current composer. Null when not yet built or when on WebGPU. */
  get composer(): EffectComposer | null { return this._composer; }

  /** Always-on read of the GTAO pass for the render path (camera re-bind). */
  get gtaoPass(): GTAOPass | null { return this._gtaoPass; }

  /** Always-on read of the N8AO pass for the render path (camera re-bind). */
  get n8aoPass(): Pass | null { return this._n8aoPass; }

  /** Keep WebGL auxiliary buffers consistent with per-material section cuts. */
  setClippingPlanes(planes: Plane[] | null): void {
    this._clippingPlanes = planes;
    if (this._gtaoPass) {
      this._gtaoPass.normalMaterial.clippingPlanes = planes;
      this._gtaoPass.normalMaterial.needsUpdate = true;
    }
    this.host.markRenderDirty();
  }

  /**
   * Return the camera the AO passes (GTAO / N8AO) should render their gbuffer
   * with this frame: a clone of `active` that mirrors its transform, projection
   * and layer mask but with NO_AO_LAYER turned OFF. Tagged in-scene UI (ghost,
   * grid, glow gizmos) therefore never enters the AO gbuffer and casts no halos,
   * while the RenderPass still draws it via the real camera (depth + bloom kept).
   *
   * The clone is reused across frames and only re-created when the active
   * camera's projection type changes — which also re-syncs GTAO's
   * PERSPECTIVE_CAMERA shader define (the stock pass bakes it once at
   * construction and never updates it on a persp↔ortho swap).
   */
  syncAoCamera(
    active: PerspectiveCamera | OrthographicCamera,
  ): PerspectiveCamera | OrthographicCamera {
    if (!this._aoCamera || this._aoCamera.type !== active.type) {
      this._aoCamera = active.clone() as PerspectiveCamera | OrthographicCamera;
      if (this._gtaoPass) {
        const mat = (this._gtaoPass as unknown as { gtaoMaterial: ShaderMaterial })
          .gtaoMaterial as ShaderMaterial & { defines: Record<string, unknown> };
        const want = (active as PerspectiveCamera).isPerspectiveCamera ? 1 : 0;
        if (mat?.defines && mat.defines.PERSPECTIVE_CAMERA !== want) {
          mat.defines.PERSPECTIVE_CAMERA = want;
          mat.needsUpdate = true;
        }
      }
    }
    // Mirror transform + projection + layer mask, then exclude NO_AO so the AO
    // gbuffer render skips NO_AO-tagged objects. `copy` is polymorphic — the
    // cast only satisfies the union type, the runtime call hits the real
    // (persp or ortho) method.
    (this._aoCamera as PerspectiveCamera).copy(active as PerspectiveCamera);
    this._aoCamera.layers.disable(NO_AO_LAYER);
    return this._aoCamera;
  }

  /** Whether the EffectComposer path is the right choice this frame.
   *  Always false on WebGPU; respects active AO mode, bloom toggle, and
   *  outline state (passed in via the host). The viewer's render loop
   *  short-circuits to a direct `renderer.render()` when this returns false. */
  get useComposer(): boolean {
    if (this.host.isWebGPU) return false;
    const xr = (this.host.renderer as unknown as WebGLRenderer).xr;
    if (xr?.isPresenting) return false;
    return !!this._composer && (
      this._aoMode !== 'off'
      || this._bloomEnabled
      || this.host.outlineHasOutlines
      || this.host.toonPassActive
    );
  }

  // ─── TSL node post (WebGPURenderer, plan-271 Phase 3) ────────────────

  /** Current TSL post pipeline. Null when not yet built or on classic WebGL. */
  get tslPost(): TslPostPipeline | null { return this._tslPost; }

  /**
   * Lazily create the TSL node-post pipeline — the `ensureComposer()`
   * counterpart for the WebGPURenderer paths. Returns null on classic WebGL
   * and when the TSL module pre-warm has not completed (F4 guard behavior:
   * effects stay off with a one-time warning).
   */
  ensureTslPost(): TslPostPipeline | null {
    if (this.host.isWebGPU === false) return null;
    if (this._tslPost) return this._tslPost;
    const tsl = getTslMaterials();
    if (!tsl) {
      if (!this._warnedTslPostUnavailable) {
        this._warnedTslPostUnavailable = true;
        console.warn('[rv-post-processing] TSL post requested before the material pre-warm completed — AO/outline/saturation stay off under WebGPU.');
      }
      return null;
    }
    const pipeline = new tsl.TslPostPipeline(this.host.renderer as Renderer, {
      samples: this.host.antialiasActive ? 4 : 0,
    });
    // Re-apply AO state remembered while no pipeline existed yet.
    pipeline.setAoEnabled(this._aoMode !== 'off');
    this._tslPost = pipeline;
    return pipeline;
  }

  /** Whether the TSL pipeline path is the right choice this frame — the
   *  `useComposer` counterpart for WebGPURenderer. The viewer's render loop
   *  calls `renderTslPost()` (which REPLACES `renderer.render()`) when true. */
  get useTslPost(): boolean {
    if (this.host.isWebGPU === false || !this._tslPost) return false;
    const xr = (this.host.renderer as unknown as WebGLRenderer).xr;
    if (xr?.isPresenting) return false;
    return this._tslPost.anyEffectActive;
  }

  /** Render one frame through the TSL pipeline (replaces renderer.render()). */
  renderTslPost(scene: Scene, camera: PerspectiveCamera | OrthographicCamera): void {
    this._tslPost?.render(scene, camera);
  }

  /** Lazily build the TSL isolate-desaturation blit (shared Rec601 node).
   *  Null on classic WebGL or when the pre-warm failed. */
  ensureDesatBlitTsl(): DesatBlitTsl | null {
    if (this.host.isWebGPU === false) return null;
    if (this._tslDesat) return this._tslDesat;
    const tsl = getTslMaterials();
    if (!tsl) return null;
    this._tslDesat = tsl.createDesatBlitTsl({ samples: this.host.antialiasActive ? 4 : 0 });
    return this._tslDesat;
  }

  // ─── Composer lifecycle ─────────────────────────────────────────────

  /**
   * Lazily create the EffectComposer with the always-built passes
   * (RenderPass / GTAO / Bloom / Output). Idempotent. No-op on WebGPU.
   *
   * Public so the outline manager and viewer can both force a composer
   * into existence before inserting their own passes — the original
   * RVViewer exposed this as `_ensureComposer()` for the same reason.
   */
  ensureComposer(): void {
    if (this._composer || this.host.isWebGPU) return;
    const renderer = this.host.renderer as unknown as WebGLRenderer;
    const w = renderer.domElement.width;
    const h = renderer.domElement.height;
    const hw = Math.max(1, Math.floor(w * PP_SCALE));
    const hh = Math.max(1, Math.floor(h * PP_SCALE));
    const composer = new EffectComposer(renderer);

    // Enable MSAA on composer render targets to match renderer antialias setting
    if (this.host.antialiasActive) {
      composer.renderTarget1.samples = 4;
      composer.renderTarget2.samples = 4;
    }

    // Pass 1: Scene render (full resolution)
    composer.addPass(new RenderPass(this.host.scene, this.host.camera));

    // Pass 2: GTAO (ambient occlusion) — half-res internal buffers
    const gtaoPass = new GTAOPass(this.host.scene, this.host.camera, hw, hh);
    gtaoPass.normalMaterial.clippingPlanes = this._clippingPlanes;
    gtaoPass.output = GTAOPass.OUTPUT.Default;
    gtaoPass.blendIntensity = 1.0;
    gtaoPass.updateGtaoMaterial({ radius: 0.15, scale: 1.0, thickness: 0.5 });
    gtaoPass.enabled = this._aoMode === 'gtao';
    composer.addPass(gtaoPass);

    // Pass 3: Bloom (glow on bright areas) — half-res internal buffers
    const bloomPass = new UnrealBloomPass(
      new Vector2(hw, hh),
      toWebGLBloomStrength(this._bloomIntensity),
      this._bloomRadius,
      this._bloomThreshold,
    );
    bloomPass.enabled = this._bloomEnabled;
    composer.addPass(bloomPass);

    // Pass 4: Output (tone mapping + color space)
    composer.addPass(new OutputPass());

    this._composer = composer;
    this._gtaoPass = gtaoPass;
    this._bloomPass = bloomPass;

    // composer.addPass() sets all passes to full-res — override to half-res
    this.applyHalfRes();
  }

  /** Re-apply the half-res size to GTAO/N8AO/Bloom internal buffers. */
  applyHalfRes(): void {
    if (!this._composer) return;
    // EffectComposer stores CSS dims in _width/_height and scales by pixelRatio
    const c = this._composer as unknown as { _width: number; _height: number; _pixelRatio: number };
    const pw = c._width * c._pixelRatio;
    const ph = c._height * c._pixelRatio;
    const hw = Math.max(1, Math.floor(pw * PP_SCALE));
    const hh = Math.max(1, Math.floor(ph * PP_SCALE));
    if (this._gtaoPass) this._gtaoPass.setSize(hw, hh);
    if (this._n8aoPass) this._n8aoPass.setSize(hw, hh);
    if (this._bloomPass) this._bloomPass.setSize(hw, hh);
  }

  /** Forward a resize to the composer + half-res buffers in one call.
   *  Mirrors the dance the viewer's resize handler used to do inline. */
  setSize(w: number, h: number): void {
    if (!this._composer) return;
    this._composer.setSize(w, h);
    this.applyHalfRes();
  }

  // ─── AO state ────────────────────────────────────────────────────────

  /** Ambient-occlusion backend: 'off' | 'gtao' | 'n8ao'. On WebGL this drives
   *  the composer passes; switching to 'n8ao' triggers a dynamic import of the
   *  `n8ao` package (silent revert to 'gtao' on failure). On WebGPU any non-off
   *  mode runs three's native TSL GTAONode (plan-271 Phase 3) — n8ao is a
   *  WebGL-only library and maps to the TSL GTAO there. */
  get aoMode(): AOMode { return this._aoMode; }
  set aoMode(mode: AOMode) {
    if (mode === this._aoMode) return;
    if (this.host.isWebGPU) {
      // TSL node post (plan-271 Phase 3): AO via the native TSL GTAONode.
      this._aoMode = mode;
      const pipeline = mode !== 'off' ? this.ensureTslPost() : this._tslPost;
      pipeline?.setAoEnabled(mode !== 'off');
      this.host.markRenderDirty();
      return;
    }
    this._aoMode = mode;
    if (mode !== 'off') this.ensureComposer();
    this.applyAoModeToComposer();
    this.host.markRenderDirty();
  }

  /** Activate/deactivate the right pass for the current `_aoMode`. For N8AO,
   *  lazy-loads the module the first time and ensures exactly one N8AO pass
   *  exists in the composer. Idempotent. */
  private applyAoModeToComposer(): void {
    const mode = this._aoMode;
    // Toggle the always-built GTAO pass.
    if (this._gtaoPass) this._gtaoPass.enabled = mode === 'gtao';
    // N8AO: enable if present, lazy-load if not.
    if (mode === 'n8ao') {
      if (this._n8aoPass) {
        this._n8aoPass.enabled = true;
      } else if (!this._n8aoLoading) {
        this.loadN8AO().catch((err) => {
          console.warn('[rv-viewer] N8AO load failed — falling back to GTAO:', err);
          this._aoMode = 'gtao';
          if (this._gtaoPass) this._gtaoPass.enabled = true;
          this.host.markRenderDirty();
        });
      }
    } else if (this._n8aoPass) {
      this._n8aoPass.enabled = false;
    }
  }

  /** Dynamic-import n8ao and insert its pass into the composer immediately
   *  after the RenderPass. Shares intensity/radius with GTAO so switching
   *  backends keeps the look roughly comparable. */
  private async loadN8AO(): Promise<void> {
    if (this._n8aoPass || !this._composer) return;
    this._n8aoLoading = true;
    try {
      // Untyped import — n8ao ships its own types but we keep this resilient
      // to version-specific default-vs-named export variance.
      const mod = await import('n8ao') as Record<string, unknown>;
      const Ctor = (mod.N8AOPass ?? mod.default) as new (
        scene: Scene, camera: PerspectiveCamera | OrthographicCamera, w: number, h: number,
      ) => Pass & {
        configuration: {
          aoRadius: number;
          intensity: number;
          aoSamples: number;
          denoiseSamples: number;
        };
      };
      if (typeof Ctor !== 'function') throw new Error('n8ao: no N8AOPass export');
      const composer = this._composer;
      if (!composer) return;
      // Initial dimensions copy GTAO's half-res math.
      const c = composer as unknown as { _width: number; _height: number; _pixelRatio: number };
      const pw = c._width * c._pixelRatio;
      const ph = c._height * c._pixelRatio;
      const hw = Math.max(1, Math.floor(pw * PP_SCALE));
      const hh = Math.max(1, Math.floor(ph * PP_SCALE));
      const pass = new Ctor(this.host.scene, this.host.camera, hw, hh);
      // Seed N8AO config from the shared SSAO sliders so the result looks
      // similar at first glance and the UI sliders keep meaning.
      pass.configuration.aoRadius = this.ssaoRadius * 30; // GTAO radius is tiny;
                                                          // N8AO expects world units.
      pass.configuration.intensity = Math.max(1, this.ssaoIntensity * 3);
      // Insert BEFORE the GTAO slot so downstream passes (bloom, output) see
      // the darkened color. composer.passes: [RenderPass, GTAO, Bloom, Output]
      // — we want [RenderPass, N8AO, GTAO(disabled), Bloom, Output].
      composer.insertPass(pass, 1);
      this._n8aoPass = pass;
      pass.enabled = this._aoMode === 'n8ao';
      if (this._gtaoPass) this._gtaoPass.enabled = this._aoMode === 'gtao';
      this.host.markRenderDirty();
    } finally {
      this._n8aoLoading = false;
    }
  }

  /**
   * Legacy back-compat: boolean toggle mapping onto `aoMode`.
   *   true  → aoMode = 'gtao' (current default)
   *   false → aoMode = 'off'
   * Prefer `aoMode` directly in new code.
   */
  get ssaoEnabled(): boolean { return this._aoMode !== 'off'; }
  set ssaoEnabled(v: boolean) { this.aoMode = v ? 'gtao' : 'off'; }

  /** AO blend intensity (0 = invisible, 1 = full). Writes to whichever backend
   *  is currently active; non-active backend picks it up on next activation.
   *  On WebGPU the value drives the TSL GTAO blend uniform instead. */
  get ssaoIntensity(): number {
    if (this.host.isWebGPU) return this._tslPost?.aoIntensity ?? 1.0;
    return this._gtaoPass?.blendIntensity ?? 1.0;
  }
  set ssaoIntensity(v: number) {
    if (this.host.isWebGPU) {
      this.ensureTslPost()?.setAoIntensity(v);
      this.host.markRenderDirty();
      return;
    }
    if (this._gtaoPass) this._gtaoPass.blendIntensity = v;
    const n8 = this._n8aoPass as (Pass & { configuration?: { intensity: number } }) | null;
    if (n8?.configuration) n8.configuration.intensity = Math.max(1, v * 3);
    this.host.markRenderDirty();
  }

  /** AO sampling radius in world units (GTAO scale; N8AO radius is derived).
   *  On WebGPU the value drives the TSL GTAO radius uniform instead. */
  get ssaoRadius(): number {
    if (this.host.isWebGPU) return this._tslPost?.aoRadius ?? 0.15;
    return this._gtaoPass?.gtaoMaterial?.uniforms?.radius?.value ?? 0.15;
  }
  set ssaoRadius(v: number) {
    if (this.host.isWebGPU) {
      this.ensureTslPost()?.setAoRadius(v);
      this.host.markRenderDirty();
      return;
    }
    if (this._gtaoPass) this._gtaoPass.updateGtaoMaterial({ radius: v });
    const n8 = this._n8aoPass as (Pass & { configuration?: { aoRadius: number } }) | null;
    if (n8?.configuration) n8.configuration.aoRadius = v * 30;
    this.host.markRenderDirty();
  }

  // ─── Bloom state ─────────────────────────────────────────────────────

  /** Whether bloom (glow on bright areas) is enabled. WebGL only.
   *  Side-effects (composer lazily ensured, pass toggled, render dirty)
   *  match the original RVViewer setter exactly. */
  get bloomEnabled(): boolean { return this._bloomEnabled; }
  set bloomEnabled(v: boolean) {
    if (v === this._bloomEnabled) return;
    this._bloomEnabled = v;
    if (v && !this.host.isWebGPU) this.ensureComposer();
    if (this._bloomPass) this._bloomPass.enabled = v;
    this.host.markRenderDirty();
  }

  /** Bloom glow intensity (0–2). */
  get bloomIntensity(): number { return this._bloomIntensity; }
  set bloomIntensity(v: number) {
    this._bloomIntensity = v;
    if (this._bloomPass) this._bloomPass.strength = toWebGLBloomStrength(v);
    this.host.markRenderDirty();
  }

  /** Brightness threshold for bloom (0–1). */
  get bloomThreshold(): number { return this._bloomThreshold; }
  set bloomThreshold(v: number) {
    this._bloomThreshold = v;
    if (this._bloomPass) this._bloomPass.threshold = v;
    this.host.markRenderDirty();
  }

  /** Bloom spread radius (0–1). */
  get bloomRadius(): number { return this._bloomRadius; }
  set bloomRadius(v: number) {
    this._bloomRadius = v;
    if (this._bloomPass) this._bloomPass.radius = v;
    this.host.markRenderDirty();
  }

  // ─── Isolate overlay (group-isolate "wash") ──────────────────────────

  /** Lazy overlay scene used for the semi-transparent wash during group isolate. */
  get isolateOverlayScene(): Scene | null { return this._isolateOverlayScene; }
  /** Orthographic camera for the isolate overlay pass (NDC -1..1). */
  get isolateOverlayCam(): OrthographicCamera | null { return this._isolateOverlayCam; }
  /** Overlay material — color is refreshed to match scene background each frame. */
  get isolateOverlayMat(): MeshBasicMaterial | null { return this._isolateOverlayMat; }

  /** Lazily build the semi-transparent fullscreen overlay resources. */
  ensureIsolateOverlay(): void {
    if (this._isolateOverlayScene) return;
    const scene = new Scene();
    // Must stay null — `scene.background = Color` triggers Three.js's
    // forceClear path (Background.js:44) which bypasses autoClear and
    // would wipe the dim backdrop drawn in pass 1.
    scene.background = null;
    const cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const mat = new MeshBasicMaterial({
      color: 0xffffff, // refreshed from scene background each frame in _renderIsolateMode
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
    });
    const mesh = new Mesh(new PlaneGeometry(2, 2), mat);
    mesh.frustumCulled = false;
    scene.add(mesh);
    this._isolateOverlayScene = scene;
    this._isolateOverlayCam = cam;
    this._isolateOverlayMat = mat;
  }

  // ─── Desaturation pass ───────────────────────────────────────────────

  get desatRT(): WebGLRenderTarget | null { return this._desatRT; }
  get desatScene(): Scene | null { return this._desatScene; }
  get desatCam(): OrthographicCamera | null { return this._desatCam; }
  get desatMat(): ShaderMaterial | null { return this._desatMat; }

  /** Lazily build the fullscreen desaturation resources. */
  ensureDesatPass(): void {
    if (this._desatScene) return;
    const renderer = this.host.renderer as unknown as WebGLRenderer;
    const w = renderer.domElement.width || 1;
    const h = renderer.domElement.height || 1;
    this._desatRT = new WebGLRenderTarget(w, h, { samples: this.host.antialiasActive ? 4 : 0 });
    const cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const mat = new ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this._desatRT.texture },
        saturation: { value: 0.0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform float saturation;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(tDiffuse, vUv);
          float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));
          gl_FragColor = vec4(mix(vec3(lum), c.rgb, saturation), c.a);
        }
      `,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const mesh = new Mesh(new PlaneGeometry(2, 2), mat);
    mesh.frustumCulled = false;
    const scene = new Scene();
    scene.background = null;
    scene.add(mesh);
    this._desatScene = scene;
    this._desatCam = cam;
    this._desatMat = mat;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  /** Release all GPU resources owned by the manager. Idempotent. */
  dispose(): void {
    if (this._composer) {
      // EffectComposer holds two ping-pong render targets; pass refs are
      // owned by the composer and disposed alongside it.
      try { this._composer.dispose(); } catch { /* ignore */ }
    }
    this._composer = null;
    this._gtaoPass = null;
    this._n8aoPass = null;
    this._bloomPass = null;
    this._aoCamera = null;

    if (this._isolateOverlayMat) this._isolateOverlayMat.dispose();
    this._isolateOverlayScene = null;
    this._isolateOverlayCam = null;
    this._isolateOverlayMat = null;

    if (this._desatMat) this._desatMat.dispose();
    if (this._desatRT) this._desatRT.dispose();
    this._desatRT = null;
    this._desatScene = null;
    this._desatCam = null;
    this._desatMat = null;

    // TSL node post (WebGPURenderer paths)
    if (this._tslPost) this._tslPost.dispose();
    this._tslPost = null;
    if (this._tslDesat) this._tslDesat.dispose();
    this._tslDesat = null;
  }
}
