// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVToonMaterialManager — drives the "Toon" (cel-shaded) render mode.
 *
 * Two responsibilities, both owned here so the rest of the viewer stays
 * mode-agnostic:
 *
 *  1. **Direction-based shading (material swap).** On enter, every scene
 *     `MeshStandardMaterial` is replaced by a banded {@link MeshToonMaterial}
 *     (sharing the original's textures by reference). The toon material's
 *     `gradientMap` quantizes the diffuse by light direction (N·L) — the cel
 *     bands — and a small `onBeforeCompile` patch recolors metallic surfaces with
 *     a single configurable metal colour (kept cel-banded) plus an **albedo grade**
 *     (saturation + min/max brightness remap on the full base colour — material
 *     colour × base-colour texture × vertex colour). A flat AmbientLight provides
 *     the base brightness; there is no environment and no shadows.
 *     Conversions are cached by the original material instance, so the single
 *     shared `RVUberMaterial` maps to exactly one toon material reused
 *     everywhere; originals are restored on exit.
 *
 *  2. **Outline.** A screen-space Sobel pass over a packed normal+depth gbuffer
 *     draws the silhouette / crease lines. The gbuffer packs view-normal in RGB
 *     and normalized linear depth in A of ONE ordinary RGBA8 color buffer
 *     (written by a custom override material) — deliberately NOT a hardware
 *     DepthTexture, which is non-portable across GPUs. Composer-only, so on
 *     WebGPU toon renders as banded materials without lines. The full-screen
 *     SATURATION grade, however, does run under WebGPU: it uses the shared
 *     Rec601 saturation node on the TSL post pipeline (plan-271 Phase 3).
 *
 * Lifecycle (driven by RVViewer): `enable(root)` / `disable(root)` swap +
 * restore materials and toggle the edge pass; `convert(root)` handles a model
 * loaded while toon is active; `onModelClearing(roots)` restores originals
 * before the viewer disposes a model; `renderPrepass(camera)` fills the gbuffer;
 * `dispose()` frees GPU resources.
 */

import {
  MathUtils,
  Color,
  DataTexture,
  LinearFilter,
  Material,
  Mesh,
  MeshStandardMaterial,
  MeshToonMaterial,
  NearestFilter,
  Object3D,
  OrthographicCamera,
  Plane,
  PerspectiveCamera,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  WebGLRenderer,
  type IUniform,
  type Texture,
} from 'three';
import type { Renderer } from 'three/webgpu';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { getTslMaterials } from './engine/materials/material-factory';
import type {
  ToonRecolorStateTsl,
  ToonSourceMaterialLike,
} from './engine/materials/rv-toon-materials-tsl';
import type { TslPostPipeline } from './engine/materials/rv-post-processing-tsl';

/**
 * Minimal viewer surface this manager needs. Mirrors the `OutlineHostViewer` /
 * `PostProcessingHost` pattern so we don't take a hard dependency on RVViewer.
 */
export interface ToonHostViewer {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera | OrthographicCamera;
  readonly renderer: Renderer | WebGLRenderer;
  readonly isWebGPU: boolean;
  /** Fixtures (lights, ground, reflector) that must never be cel-converted. */
  readonly sceneFixtures: Set<Object3D>;
  /** The checker ground plane, if any. Force-converted to a toon material in
   *  toon mode (despite being a fixture) so the floor reads as cel-shaded. */
  readonly groundMesh?: Mesh | null;
  /** Whether the renderer was created with native MSAA. When true the outline
   *  gbuffer is multisampled, so MSAA also anti-aliases the Sobel edges (and the
   *  edge AA stays coherent with the display Antialiasing toggle). Optional:
   *  hosts that omit it get a non-multisampled gbuffer. */
  readonly antialiasActive?: boolean;
  /** Lazily creates the EffectComposer (no-op on WebGPU). */
  _ensureComposer(): void;
  /** The composer once `_ensureComposer` has run; null on WebGPU. */
  readonly _composer: EffectComposer | null;
  /** Lazily creates the TSL post pipeline (WebGPURenderer paths only —
   *  plan-271 Phase 3). Optional so lightweight test hosts stay valid. */
  _ensureTslPost?(): TslPostPipeline | null;
  /** Mark the next frame as needing a render. */
  markRenderDirty(): void;
}

const MIN_BANDS = 2;
const MAX_BANDS = 6;

/** Common surface of the classic MeshToonMaterial and the TSL
 *  MeshToonNodeMaterial variant — everything the manager touches after
 *  conversion (gradient swap + disposal). */
type ToonLikeMaterial = Material & { gradientMap: Texture | null };

// Module-local warn-once flag (repo convention — no external warnOnce util).
// Fires only as a FALLBACK: WebGPURenderer active but the TSL material module
// was not pre-warmed (plan-271 Phase 2) — toon then keeps cel banding, but
// the metal tint + albedo grade recolor is skipped (onBeforeCompile is
// silently ignored under WebGPURenderer).
let _warnedToonWebGPU = false;
function warnToonRecolorWebGPUOnce(): void {
  if (_warnedToonWebGPU) return;
  _warnedToonWebGPU = true;
  console.warn(
    '[ToonMaterials] WebGPU renderer active but the TSL material module is ' +
    'not preloaded — toon keeps the cel banding, but the metal tint / albedo ' +
    'grade recolor is disabled (onBeforeCompile is silently ignored under ' +
    'WebGPURenderer).',
  );
}

/**
 * Store an internal back-reference on a `userData`/`Material.userData` bag as a
 * NON-ENUMERABLE property. Critical: `Object3D.copy()` (run by `clone()`) deep-copies
 * userData via `JSON.parse(JSON.stringify(userData))`. If a toon back-ref (a `Material`)
 * were enumerable, that stringify would call `Material.toJSON()` → `Texture.toJSON()` →
 * `ImageUtils.getDataURL()`, JPEG-encoding every texture on EVERY spawned-MU clone — a
 * multi-ms stall in toon mode. Non-enumerable keeps it out of all JSON.stringify paths
 * (clone, GLB export, debug snapshot) while direct reads, the `!== undefined` guard, and
 * `delete` all keep working (configurable: true).
 */
function setHidden(bag: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(bag, key, { value, enumerable: false, writable: true, configurable: true });
}

const clamp01 = (v: number): number => MathUtils.clamp(v, 0, 1);
function clampBands(n: number): number {
  return Math.max(MIN_BANDS, Math.min(MAX_BANDS, Math.round(n)));
}

/**
 * Build the toon gradient ramp — a `bands×1` RGBA8 lookup texture sampled by
 * N·L to quantize the diffuse term into discrete steps. `NearestFilter` (no
 * interpolation) is what produces the hard band edges. When `coolShadows` is
 * set the darker steps are tinted slightly toward blue.
 */
export function buildToonGradient(bands: number, coolShadows: boolean): DataTexture {
  const n = clampBands(bands);
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 1 : i / (n - 1);          // 0 (shadow) … 1 (lit)
    const lum = 0.18 + 0.82 * t;                   // raised floor: darkest band isn't pure black
    let r = lum, g = lum, b = lum;
    if (coolShadows) {
      const tint = 1 - t;                          // strongest in shadow, fades toward the lit band
      r = lum * (1 - 0.12 * tint);
      g = lum * (1 - 0.04 * tint);
      b = lum * (1 + 0.08 * tint);
    }
    data[i * 4 + 0] = Math.round(clamp01(r) * 255);
    data[i * 4 + 1] = Math.round(clamp01(g) * 255);
    data[i * 4 + 2] = Math.round(clamp01(b) * 255);
    data[i * 4 + 3] = 255;
  }
  const tex = new DataTexture(data, n, 1, RGBAFormat);
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

// ─── Toon metallic colour injection ──────────────────────────────────────────
// Replaces <opaque_fragment> so it can modify `outgoingLight` directly.
// MeshToonMaterial has no metalness/reflection, so metallic parts would read as
// ordinary cel diffuse. Instead we recolor metal surfaces with a single
// configurable "metal colour", kept cel-banded: `outgoingLight` at this point is
// the banded diffuse `albedo × bandedLight`, so dividing out the albedo recovers
// the light bands, then `× uMetalColor` re-tints them. Blended by
// metalness × uMetalReflectivity. `metalExpr` is this material's metalness GLSL —
// `uMetalness` (scalar) or `vRm.y` (uber per-vertex).
function toonLightInject(metalExpr: string): string {
  return /* glsl */`{
  float rvMetalK = clamp( (${metalExpr}) * uMetalReflectivity, 0.0, 1.0 );
  if ( rvMetalK > 0.001 ) {
    vec3 rvLight = outgoingLight / max( diffuseColor.rgb, vec3( 1e-3 ) );
    outgoingLight = mix( outgoingLight, rvLight * uMetalColor, rvMetalK );
  }
}
#include <opaque_fragment>`;
}

// ─── Toon albedo grade injection ─────────────────────────────────────────────
// Grades the albedo brightness (a linear remap into [uAlbedoMinBright,
// uAlbedoMaxBright]) on the FULL base colour — material colour × base-colour
// texture × vertex colour — by running after <color_fragment> (which itself runs
// after <map_fragment>). Brightness is the max channel (HSV value), so the remap
// can't push a channel above uAlbedoMaxBright → no clipping. The remap scales rgb
// by newV/V to preserve hue; a value-less pixel (pure black, V≈0) has no hue to
// preserve, so it becomes a neutral grey at the remapped value (= uAlbedoMinBright)
// instead of staying black — otherwise the min-brightness floor could never lift a
// black albedo. Defaults (min 0, max 1) are an identity transform (black → grey(0)
// = black). See `_toToon` for how this is spliced in.
//
// Saturation is NOT graded here — it runs as a full-screen post-process pass on the
// final composited image (see `_ensureSaturationPass` / SATURATION_FRAG), so it
// affects lit colours, shadows and the ground rather than only the pre-lighting
// albedo.
const ALBEDO_INJECT = /* glsl */`{
  vec3 rvAlb = max(diffuseColor.rgb, 0.0);
  float rvV = max(max(rvAlb.r, rvAlb.g), rvAlb.b);
  float rvNewV = uAlbedoMinBright + rvV * (uAlbedoMaxBright - uAlbedoMinBright);
  rvAlb = (rvV > 1e-4) ? rvAlb * (rvNewV / rvV) : vec3(rvNewV);
  diffuseColor.rgb = clamp(rvAlb, 0.0, 1.0);
}`;

// ─── Normal+depth gbuffer override material (portable, no DepthTexture) ──────

// This material is applied via `scene.overrideMaterial`, so it renders EVERY
// object in the scene — including the BatchedMesh arenas of the batched render
// pipeline. Any such override material MUST be batching-aware: the renderer
// injects `#define USE_BATCHING` and binds the batching textures per object,
// but only the <batching_pars_vertex> / <batching_vertex> chunks make the
// per-instance matrix available; <defaultnormal_vertex> and <project_vertex>
// then apply it. Without these includes, batched geometry renders with its
// instance transforms unapplied and the gbuffer (and thus every edge) is wrong.
const GBUFFER_VERT = /* glsl */`
#include <common>
#include <batching_pars_vertex>
uniform float uNear;
uniform float uFar;
varying vec3 vNrm;
varying float vDepth;
void main() {
  #include <batching_vertex>
  #include <beginnormal_vertex>
  #include <defaultnormal_vertex>
  vNrm = normalize(transformedNormal);
  #include <begin_vertex>
  #include <project_vertex>
  vDepth = clamp((-mvPosition.z - uNear) / max(uFar - uNear, 1e-4), 0.0, 1.0);
}`;

const GBUFFER_FRAG = /* glsl */`
varying vec3 vNrm;
varying float vDepth;
void main() {
  gl_FragColor = vec4(normalize(vNrm) * 0.5 + 0.5, vDepth);
}`;

// ─── Sobel outline shader (reads the single packed gbuffer + scene color) ────

const OUTLINE_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const OUTLINE_FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform sampler2D tNormalDepth;
uniform vec2 resolution;
uniform vec3 outlineColor;
uniform float thickness;
uniform float threshold;
uniform float amount;
uniform float uNear;
uniform float uFar;
uniform float uEdgeCutoff;   // max view distance (world units) for edges; fades out beyond
varying vec2 vUv;

const float NORMAL_SENS = 1.5;
const float DEPTH_SENS = 6.0;

void main() {
  vec2 texel = thickness / resolution;
  vec4 c = texture2D(tNormalDepth, vUv);
  vec4 l = texture2D(tNormalDepth, vUv - vec2(texel.x, 0.0));
  vec4 r = texture2D(tNormalDepth, vUv + vec2(texel.x, 0.0));
  vec4 u = texture2D(tNormalDepth, vUv + vec2(0.0, texel.y));
  vec4 d = texture2D(tNormalDepth, vUv - vec2(0.0, texel.y));

  float ne = distance(c.rgb, l.rgb) + distance(c.rgb, r.rgb)
           + distance(c.rgb, u.rgb) + distance(c.rgb, d.rgb);
  float de = abs(c.a - l.a) + abs(c.a - r.a) + abs(c.a - u.a) + abs(c.a - d.a);

  float edge = max(ne * NORMAL_SENS, de * DEPTH_SENS);
  edge = smoothstep(threshold, threshold + 0.25, edge) * amount;

  // Distance cutoff: gbuffer alpha is linear depth normalized between near/far.
  // Reconstruct the world distance of this pixel and fade the edge out as it
  // approaches uEdgeCutoff (10% feather), so far-away geometry loses its lines.
  float dist = uNear + c.a * (uFar - uNear);
  edge *= 1.0 - smoothstep(uEdgeCutoff * 0.9, uEdgeCutoff, dist);

  vec4 scene = texture2D(tDiffuse, vUv);
  gl_FragColor = vec4(mix(scene.rgb, outlineColor, edge), scene.a);
}`;

// ─── Saturation post-process shader ──────────────────────────────────────────
// Full-screen luma-mix saturation, applied to the final composited image (runs
// last in the composer, after OutputPass + the outline). uSaturation: 0 = full
// greyscale, 1 = unchanged (identity), 2 = boosted. Rec.601 luma weights match the
// isolate-mode desaturation pass in rv-post-processing.ts (both operate on the
// already-tone-mapped / sRGB framebuffer). Reuses OUTLINE_VERT for the quad.
const SATURATION_FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform float uSaturation;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  float luma = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  gl_FragColor = vec4(mix(vec3(luma), c.rgb, uSaturation), c.a);
}`;

export class RVToonMaterialManager {
  private readonly host: ToonHostViewer;

  private _active = false;

  // Material cache: original material instance → its toon counterpart
  // (classic MeshToonMaterial on WebGL, MeshToonNodeMaterial via the TSL
  // module under WebGPURenderer — plan-271 Phase 2).
  private readonly toonByOriginal = new Map<Material, ToonLikeMaterial>();

  // Shared TSL recolor uniforms (WebGPURenderer path only) — mirrors the
  // shared _albedoUniforms/_metalUniforms of the GLSL path; created lazily on
  // the first TSL conversion and kept in sync by the setters below.
  private _tslRecolorState: ToonRecolorStateTsl | null = null;

  // Shared cel gradient (reassigned to every toon material on change).
  private _gradient: DataTexture | null = null;
  private _bands = 3;
  private _coolShadows = true;

  // Shared albedo-grade uniforms — referenced by every toon material's injected
  // shader (one write updates them all). Defaults are an identity transform.
  // Saturation is NOT here — it lives in the post-process pass (see _saturationPass).
  private readonly _albedoUniforms: {
    uAlbedoMinBright: IUniform<number>;
    uAlbedoMaxBright: IUniform<number>;
  } = {
    uAlbedoMinBright: { value: 0 },
    uAlbedoMaxBright: { value: 1 },
  };
  private _albedoMinBright = 0;
  private _albedoMaxBright = 1;
  private _albedoSaturation = 1;

  // Shared metallic uniforms — referenced by every toon material's injected
  // shader (one write updates them all). `uMetalColor` is the flat metal tint;
  // `uMetalReflectivity` scales how strongly metal surfaces are recoloured.
  private readonly _metalUniforms: {
    uMetalColor: IUniform<Color>;
    uMetalReflectivity: IUniform<number>;
  } = {
    uMetalColor: { value: new Color('#b0b4bc') },
    uMetalReflectivity: { value: 0.85 },
  };
  private _metallic = 0.85;
  private readonly _metalColor = new Color('#b0b4bc');

  // Outline (WebGL only).
  private _outlineAmount = 1.0;
  private _outlineThickness = 1.5;
  private _outlineThreshold = 0.3;
  private _outlineDistance = 100;
  private readonly _outlineColor = new Color(0x1a1a1a);
  private _gbufferRT: WebGLRenderTarget | null = null;
  private _gbufferMat: ShaderMaterial | null = null;
  /** Section planes for the override normal/depth gbuffer material. */
  private _clippingPlanes: Plane[] | null = null;
  private _sobelPass: ShaderPass | null = null;
  // Full-screen saturation post-process. WebGL: a ShaderPass appended last in
  // the composer; enabled only when saturation != 1. WebGPURenderer paths:
  // the shared Rec601 saturation node on the TSL post pipeline instead
  // (plan-271 Phase 3). See `_ensureSaturationPass`.
  private _saturationPass: ShaderPass | null = null;
  // TSL post pipeline once linked (WebGPURenderer paths) — carries the
  // saturation uniform the setters below write to.
  private _tslPost: TslPostPipeline | null = null;
  // Supersample the depth/normal gbuffer at 2× resolution for higher-quality
  // edges (heavier). Edge AA otherwise comes from MSAA on the gbuffer.
  private _supersample = false;
  // Last gbuffer size the outline resources were sized to (device px × SSAA scale).
  private _sizeW = 0;
  private _sizeH = 0;

  constructor(host: ToonHostViewer) {
    this.host = host;
  }

  /** Keep the Toon outline prepass consistent with the clipped beauty pass. */
  setClippingPlanes(planes: Plane[] | null): void {
    this._clippingPlanes = planes;
    if (this._gbufferMat) {
      this._gbufferMat.clippingPlanes = planes;
      this._gbufferMat.needsUpdate = true;
    }
    this.host.markRenderDirty();
  }

  // ─── Public read accessors (for the viewer's delegating proxies) ──────────

  get isActive(): boolean { return this._active; }
  get bands(): number { return this._bands; }
  get coolShadows(): boolean { return this._coolShadows; }
  get albedoMinBrightness(): number { return this._albedoMinBright; }
  get albedoMaxBrightness(): number { return this._albedoMaxBright; }
  get albedoSaturation(): number { return this._albedoSaturation; }
  get metallic(): number { return this._metallic; }
  get metallicColorHex(): string { return '#' + this._metalColor.getHexString(); }
  get outlineAmount(): number { return this._outlineAmount; }
  get outlineThickness(): number { return this._outlineThickness; }
  get outlineThreshold(): number { return this._outlineThreshold; }
  get outlineDistance(): number { return this._outlineDistance; }
  get outlineSupersample(): boolean { return this._supersample; }
  get outlineColorHex(): string { return '#' + this._outlineColor.getHexString(); }

  /** Whether the composer is needed — for the outline edge OR the saturation
   *  grade (banding itself is in-material and needs no composer). */
  get passActive(): boolean { return this.outlineActive || this.saturationActive; }

  /** True when the full-screen saturation post-process should run (toon
   *  active and saturation != 1). WebGL: ShaderPass; WebGPURenderer paths:
   *  the shared saturation node on the TSL post pipeline. */
  get saturationActive(): boolean {
    if (this.host.isWebGPU) {
      return this._active && !!this._tslPost && this._albedoSaturation !== 1;
    }
    return this._active
      && !!this._saturationPass
      && this._saturationPass.enabled;
  }

  /** True when the per-frame gbuffer prepass + Sobel outline should run. */
  get outlineActive(): boolean {
    return this._active
      && !this.host.isWebGPU
      && this._outlineAmount > 0
      && this._outlineThickness > 0
      && !!this._sobelPass
      && this._sobelPass.enabled
      && !!this._gbufferRT;
  }

  // ─── Lifecycle (driven by RVViewer) ───────────────────────────────────────

  /** Enter toon mode: build resources and convert the model subtree (if loaded). */
  enable(root: Object3D | null): void {
    this._active = true;
    if (!this._gradient) this._gradient = buildToonGradient(this._bands, this._coolShadows);
    this._ensureOutline();
    this._ensureSaturationPass();
    if (root) this._convertTree(root);
    // The checker floor is a fixture (normally skipped) — force-convert it so it
    // reads as a cel-shaded floor in toon mode.
    if (this.host.groundMesh) this._convertMesh(this.host.groundMesh, true);
    this.host.markRenderDirty();
  }

  /** Leave toon mode: restore the model subtree and drop the toon cache. */
  disable(root: Object3D | null): void {
    if (root) this._restoreTree(root);
    if (this.host.groundMesh) this._restoreMesh(this.host.groundMesh);
    this._disposeToonCache();
    this._active = false;
    if (this._sobelPass) this._sobelPass.enabled = false;
    if (this._saturationPass) this._saturationPass.enabled = false;
    this._applyTslSaturation(); // TSL path: back to identity (saturation 1)
    this.host.markRenderDirty();
  }

  /** Convert a model loaded while toon is already active. No-op when inactive. */
  convert(root: Object3D): void {
    if (!this._active) return;
    if (!this._gradient) this._gradient = buildToonGradient(this._bands, this._coolShadows);
    this._ensureOutline();
    this._ensureSaturationPass();
    this._convertTree(root);
    this.host.markRenderDirty();
  }

  /**
   * Called from `clearModel` BEFORE the viewer disposes the model. Restores the
   * original PBR materials (so the viewer's MeshStandardMaterial-typed disposal
   * frees them + their textures) and drops the now-stale toon cache. Keeps toon
   * ACTIVE — the next model load re-converts via `convert`.
   */
  onModelClearing(roots: Iterable<Object3D>): void {
    if (!this._active) return;
    for (const root of roots) this._restoreTree(root);
    this._disposeToonCache();
  }

  // ─── Live settings ────────────────────────────────────────────────────────

  /** Update band count (2–6) + cool-shadow tint and rebuild the shared gradient. */
  setGradient(bands: number, coolShadows: boolean): void {
    this._bands = clampBands(bands);
    this._coolShadows = coolShadows;
    if (!this._gradient) return; // not built yet — `enable()` will build with these values
    const old = this._gradient;
    this._gradient = buildToonGradient(this._bands, this._coolShadows);
    for (const toon of this.toonByOriginal.values()) {
      toon.gradientMap = this._gradient;
      toon.needsUpdate = true;
    }
    old.dispose();
    this.host.markRenderDirty();
  }

  /** Update the metallic look strength (0 = off … 1 = fully recoloured metal). */
  setMetallic(strength: number): void {
    this._metallic = clamp01(strength);
    this._metalUniforms.uMetalReflectivity.value = this._metallic;
    if (this._tslRecolorState) this._tslRecolorState.uMetalReflectivity.value = this._metallic;
    this.host.markRenderDirty();
  }

  /** Update the flat metallic tint colour (#rrggbb) applied to metal surfaces. */
  setMetallicColor(colorHex: string): void {
    this._metalColor.set(colorHex);
    this._metalUniforms.uMetalColor.value.copy(this._metalColor);
    if (this._tslRecolorState) this._tslRecolorState.uMetalColor.value.copy(this._metalColor);
    this.host.markRenderDirty();
  }

  /**
   * Update the albedo grade: min/max brightness (each 0–1, remapped linearly)
   * and saturation (0 = greyscale … 1 = unchanged … 2 = boosted). Min and max
   * are clamped independently — `min > max` simply inverts the ramp. Applies to
   * the full base colour (material colour × base-colour texture × vertex colour).
   */
  setAlbedo(minBright: number, maxBright: number, saturation: number): void {
    this._albedoMinBright = clamp01(minBright);
    this._albedoMaxBright = clamp01(maxBright);
    this._albedoSaturation = Math.max(0, Math.min(2, saturation));
    this._albedoUniforms.uAlbedoMinBright.value = this._albedoMinBright;
    this._albedoUniforms.uAlbedoMaxBright.value = this._albedoMaxBright;
    if (this._tslRecolorState) {
      this._tslRecolorState.uAlbedoMinBright.value = this._albedoMinBright;
      this._tslRecolorState.uAlbedoMaxBright.value = this._albedoMaxBright;
    }
    // Saturation is a post-process pass (guard: setAlbedo can run before toon is
    // enabled, e.g. applying settings at load — the pass is built in `enable`).
    if (this.host.isWebGPU) {
      this._applyTslSaturation();
    } else if (this._saturationPass) {
      this._saturationPass.uniforms.uSaturation.value = this._albedoSaturation;
      this._saturationPass.enabled = this._active && this._albedoSaturation !== 1;
    }
    this.host.markRenderDirty();
  }

  /** Update outline strength (0–1), thickness (px), threshold (0–1), color. */
  setOutline(
    amount: number,
    thickness: number,
    threshold: number,
    colorHex: string,
    distance: number = this._outlineDistance,
  ): void {
    this._outlineAmount = Math.max(0, Math.min(1, amount));
    this._outlineThickness = Math.max(0, thickness);
    this._outlineThreshold = Math.max(0, Math.min(1, threshold));
    this._outlineDistance = Math.max(0, distance);
    this._outlineColor.set(colorHex);
    if (this._sobelPass) {
      const u = this._sobelPass.uniforms;
      u.amount.value = this._outlineAmount;
      u.thickness.value = this._outlineThickness;
      u.threshold.value = this._outlineThreshold;
      u.uEdgeCutoff.value = this._outlineDistance;
      (u.outlineColor.value as Color).copy(this._outlineColor);
      this._sobelPass.enabled = this._active && this._outlineAmount > 0 && this._outlineThickness > 0;
    }
    this.host.markRenderDirty();
  }

  /**
   * Toggle 2× supersampling of the depth/normal gbuffer. When on, the gbuffer is
   * rendered at twice the drawing-buffer resolution and box-filtered on read, so
   * the Sobel edges are computed from higher-resolution depth — smoother edges at
   * a (significant) GPU cost. Rebuilds the gbuffer RT to apply the size/filter.
   */
  setSupersample(enabled: boolean): void {
    if (enabled === this._supersample) return;
    this._supersample = enabled;
    if (this._gbufferRT) this._rebuildGbuffer();
    this.host.markRenderDirty();
  }

  // ─── Per-frame outline gbuffer ─────────────────────────────────────────────

  /**
   * Render the scene's view-normal + linear depth into the packed gbuffer that
   * the Sobel pass reads. Called just before `composer.render()` when
   * {@link outlineActive}. `camera` should be the AO clone (overlay + NO_AO
   * layers excluded) so gizmos / ghosts are not outlined.
   */
  renderPrepass(camera: PerspectiveCamera | OrthographicCamera): void {
    if (!this.outlineActive || !this._gbufferRT || !this._gbufferMat) return;
    // Keep the gbuffer locked to the real drawing-buffer resolution (covers a
    // DPR / maxDpr change that doesn't fire a layout resize).
    this._syncOutlineSize();
    const renderer = this.host.renderer as unknown as WebGLRenderer;
    const scene = this.host.scene;

    this._gbufferMat.uniforms.uNear.value = camera.near;
    this._gbufferMat.uniforms.uFar.value = camera.far;
    // Mirror near/far to the Sobel pass so it can reconstruct world distance for
    // the edge distance cutoff (the gbuffer alpha is depth normalized near→far).
    if (this._sobelPass) {
      this._sobelPass.uniforms.uNear.value = camera.near;
      this._sobelPass.uniforms.uFar.value = camera.far;
    }

    const prevRT = renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    const prevAutoClear = renderer.autoClear;
    renderer.getClearColor(this._tmpClear);
    const prevClearAlpha = renderer.getClearAlpha();

    // Clear to alpha=1 so the geometry-free background reads as the far plane →
    // object silhouettes against it always produce a depth edge.
    scene.overrideMaterial = this._gbufferMat;
    renderer.autoClear = true;
    renderer.setClearColor(0x000000, 1);
    renderer.setRenderTarget(this._gbufferRT);
    renderer.render(scene, camera);

    scene.overrideMaterial = prevOverride;
    renderer.setRenderTarget(prevRT);
    renderer.setClearColor(this._tmpClear, prevClearAlpha);
    renderer.autoClear = prevAutoClear;
  }

  private readonly _tmpClear = new Color();

  /**
   * Resize the outline resources. The CSS dimensions passed by the viewer are
   * intentionally ignored in favour of the renderer's real DEVICE-pixel drawing
   * buffer (CSS × pixelRatio), so the gbuffer/outline always match the scene
   * resolution and honour the DPR / render-resolution (maxDpr) setting. Sizing
   * the gbuffer in CSS pixels was the cause of the heavily aliased outline on
   * DPR > 1 displays.
   */
  setSize(_cssWidth: number, _cssHeight: number): void {
    this._syncOutlineSize();
  }

  /**
   * Keep the gbuffer RT and the Sobel resolution tracking the renderer's actual
   * drawing-buffer size (device pixels). The gbuffer is sized at device × the
   * supersample scale (2× when enabled); the Sobel's `resolution` is always the
   * device size because its neighbour offsets are in screen pixels. Resizes only
   * on an actual change (cheap no-op every frame). Called from the prepass too,
   * so a DPR / maxDpr change is picked up even without a layout resize.
   */
  private _syncOutlineSize(): void {
    if (!this._gbufferRT) return; // no outline (WebGPU / not built) — nothing to size
    const renderer = this.host.renderer as unknown as WebGLRenderer;
    const dw = renderer.domElement.width || 1;
    const dh = renderer.domElement.height || 1;
    const scale = this._supersample ? 2 : 1;
    const gw = dw * scale;
    const gh = dh * scale;
    if (gw !== this._sizeW || gh !== this._sizeH) {
      this._sizeW = gw;
      this._sizeH = gh;
      this._gbufferRT.setSize(gw, gh);
    }
    if (this._sobelPass) {
      const r = this._sobelPass.uniforms.resolution.value as Vector2;
      if (r.x !== dw || r.y !== dh) r.set(dw, dh);
    }
  }

  /** Free all GPU resources owned by the manager. */
  dispose(): void {
    this._disposeToonCache();
    this._gradient?.dispose();
    this._gradient = null;
    this._gbufferRT?.dispose();
    this._gbufferRT = null;
    this._gbufferMat?.dispose();
    this._gbufferMat = null;
    if (this._sobelPass) {
      (this._sobelPass.material as ShaderMaterial).dispose();
      this._sobelPass = null;
    }
    this._active = false;
  }

  // ─── Internal: material conversion ─────────────────────────────────────────

  private _convertTree(root: Object3D): void {
    root.traverse((node) => {
      if ((node as Mesh).isMesh) this._convertMesh(node as Mesh);
    });
  }

  private _restoreTree(root: Object3D): void {
    root.traverse((node) => {
      if ((node as Mesh).isMesh) this._restoreMesh(node as Mesh);
    });
  }

  /** Restore one mesh's original material(s) from the stored ref / back-ref. */
  private _restoreMesh(mesh: Mesh): void {
    if (!mesh.isMesh) return;
    let orig = mesh.userData?._rvToonOriginal as Material | Material[] | undefined;
    if (orig === undefined) orig = this._recoverOriginal(mesh.material as Material | Material[]);
    if (orig === undefined) return;
    mesh.material = orig;
    delete mesh.userData._rvToonOriginal;
    if (Array.isArray(orig)) orig.forEach((m) => { m.needsUpdate = true; });
    else orig.needsUpdate = true;
  }

  /** Recover the original material(s) from a toon material's `_rvToonOf` back-ref. */
  private _recoverOriginal(mat: Material | Material[]): Material | Material[] | undefined {
    if (Array.isArray(mat)) {
      const recovered = mat.map((m) => (m.userData?._rvToonOf as Material | undefined) ?? m);
      return recovered.some((m, i) => m !== mat[i]) ? recovered : undefined;
    }
    return (mat?.userData?._rvToonOf as Material | undefined) ?? undefined;
  }

  private _convertMesh(mesh: Mesh, force = false): void {
    if (!force && this._shouldSkip(mesh)) return;
    if (mesh.userData._rvToonOriginal !== undefined) return; // already converted
    const mat = mesh.material as Material | Material[];
    if (Array.isArray(mat)) {
      const toon = mat.map((m) => this._toToon(m));
      if (toon.some((m, i) => m !== mat[i])) {
        setHidden(mesh.userData, '_rvToonOriginal', mat);
        mesh.material = toon;
      }
    } else {
      const toon = this._toToon(mat);
      if (toon === mat) return; // not a convertible material
      setHidden(mesh.userData, '_rvToonOriginal', mat);
      mesh.material = toon;
    }
  }

  /** Lazily create + seed the shared TSL recolor uniform state (WebGPU path). */
  private _ensureTslRecolorState(
    tsl: NonNullable<ReturnType<typeof getTslMaterials>>,
  ): ToonRecolorStateTsl {
    if (!this._tslRecolorState) {
      const state = tsl.createToonRecolorStateTsl();
      state.uMetalColor.value.copy(this._metalColor);
      state.uMetalReflectivity.value = this._metallic;
      state.uAlbedoMinBright.value = this._albedoMinBright;
      state.uAlbedoMaxBright.value = this._albedoMaxBright;
      this._tslRecolorState = state;
    }
    return this._tslRecolorState;
  }

  /** Convert one material (cached). Non-Standard materials pass through unchanged. */
  private _toToon(src: Material): Material {
    // Convertible sources: classic MeshStandardMaterial, or the shared uber
    // MeshStandardNodeMaterial (TSL variant, plan-271 port coupling #1→#2).
    const isStandard = src instanceof MeshStandardMaterial;
    const isStandardNode =
      (src as { isMeshStandardNodeMaterial?: boolean }).isMeshStandardNodeMaterial === true;
    if (!isStandard && !isStandardNode) return src;
    const cached = this.toonByOriginal.get(src);
    if (cached) return cached;

    // WebGPURenderer (both backends): onBeforeCompile is silently ignored —
    // the recolor (metal tint + albedo grade) runs as a TSL colorNode chain
    // instead (plan-271 Phase 2 port #2). The saturation grade runs on the
    // TSL post pipeline (Phase 3); only the Sobel edge lines stay disabled
    // under WebGPU (open item).
    if (this.host.isWebGPU) {
      const tsl = getTslMaterials();
      if (tsl) {
        const state = this._ensureTslRecolorState(tsl);
        const isUber = src.name === '__rvUberMaterial';
        const toon = tsl.createToonMaterialTsl(src as unknown as ToonSourceMaterialLike, {
          state,
          gradientMap: this._gradient,
          isUber,
        }) as ToonLikeMaterial;
        toon.name = (src.name || 'material') + '__toon';
        setHidden(toon.userData, '_rvToonOf', src);
        this.toonByOriginal.set(src, toon);
        return toon;
      }
      // Fallback (no pre-warm): classic MeshToonMaterial below still gives
      // cel banding under WebGPURenderer — only the recolor patch is lost.
      warnToonRecolorWebGPUOnce();
    }

    // Classic (GLSL) path — requires a real MeshStandardMaterial source (the
    // uber node material only ever exists when the TSL module is loaded).
    if (!(src instanceof MeshStandardMaterial)) return src;
    const toon = new MeshToonMaterial({
      color: src.color.clone(),
      map: src.map ?? null,
      normalMap: src.normalMap ?? null,
      emissive: src.emissive ? src.emissive.clone() : new Color(0x000000),
      emissiveMap: src.emissiveMap ?? null,
      emissiveIntensity: src.emissiveIntensity ?? 1,
      alphaMap: src.alphaMap ?? null,
      transparent: src.transparent,
      opacity: src.opacity,
      alphaTest: src.alphaTest,
      side: src.side,
      vertexColors: src.vertexColors,
      gradientMap: this._gradient,
    });
    // Preserve depth behaviour — matters for the transparent, depthWrite:false
    // ground plane (the toon floor) so it doesn't occlude itself or the disc fade.
    toon.depthWrite = src.depthWrite;
    toon.depthTest = src.depthTest;
    if (src.normalScale) toon.normalScale.copy(src.normalScale);
    // The merged static mesh (RVUberMaterial) carries metalness per-vertex in the
    // `rmPacked.y` attribute; every other material uses the scalar `.metalness`.
    const isUber = src.name === '__rvUberMaterial';
    const metalExpr = isUber ? 'vRm.y' : 'uMetalness';
    // Patch the shader via the shared uniforms: an albedo grade, plus a flat
    // metallic colour (cel-banded) folded into outgoingLight.
    toon.onBeforeCompile = (shader) => {
      shader.uniforms.uAlbedoMinBright = this._albedoUniforms.uAlbedoMinBright;
      shader.uniforms.uAlbedoMaxBright = this._albedoUniforms.uAlbedoMaxBright;
      shader.uniforms.uMetalColor = this._metalUniforms.uMetalColor;
      shader.uniforms.uMetalReflectivity = this._metalUniforms.uMetalReflectivity;
      if (!isUber) shader.uniforms.uMetalness = { value: src.metalness };

      // Uber: forward the per-vertex metalness (rmPacked.y) to the fragment.
      if (isUber) {
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nattribute vec2 rmPacked;\nvarying vec2 vRm;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRm = rmPacked;');
      }

      let f = shader.fragmentShader;
      // Grade right after <color_fragment> — which runs after <map_fragment> —
      // so the grade covers material colour × base-colour texture × vertex colour.
      f = f.replace('#include <color_fragment>', '#include <color_fragment>\n' + ALBEDO_INJECT);
      // Metallic colour folds into outgoingLight at <opaque_fragment>.
      f = f.replace('#include <opaque_fragment>', toonLightInject(metalExpr));
      shader.fragmentShader =
        'uniform float uAlbedoMinBright;\nuniform float uAlbedoMaxBright;\n'
        + 'uniform vec3 uMetalColor;\nuniform float uMetalReflectivity;\n'
        + (isUber ? 'varying vec2 vRm;\n' : 'uniform float uMetalness;\n')
        + f;
    };
    toon.name = (src.name || 'material') + '__toon';
    setHidden(toon.userData, '_rvToonOf', src);
    this.toonByOriginal.set(src, toon);
    return toon;
  }

  /** Dispose every cached toon material and clear the cache (keeps the gradient). */
  private _disposeToonCache(): void {
    for (const toon of this.toonByOriginal.values()) toon.dispose();
    this.toonByOriginal.clear();
  }

  /**
   * Skip fixtures (lights, ground, reflector) and source ghost / preview /
   * overlay subtrees. Walks ancestors so a flag on any parent excludes the
   * whole subtree.
   */
  private _shouldSkip(obj: Object3D): boolean {
    let n: Object3D | null = obj;
    while (n) {
      if (this.host.sceneFixtures.has(n)) return true;
      const u = n.userData;
      if (u && (u._isSourceGhost || u._isSourcePreview || u._isGhostOverlay
        || u._rvGroundPlane || u._rvGroundReflector || u._rvToonOutline)) return true;
      n = n.parent;
    }
    return false;
  }

  // ─── Internal: outline pipeline ────────────────────────────────────────────

  private _ensureOutline(): void {
    if (this.host.isWebGPU) return;
    this.host._ensureComposer();
    const composer = this.host._composer;
    if (!composer) return;

    if (!this._sobelPass) {
      this._buildOutlineResources();
      const outputIdx = composer.passes.findIndex((p) => p instanceof OutputPass);
      // Insert AFTER OutputPass so the outline overlays the final (sRGB) image.
      if (outputIdx >= 0) composer.insertPass(this._sobelPass!, outputIdx + 1);
      else composer.addPass(this._sobelPass!);
    }
    this._sobelPass!.enabled = this._outlineAmount > 0 && this._outlineThickness > 0;
  }

  /** Push the current toon saturation into the TSL pipeline's shared node
   *  (WebGPURenderer paths). Identity (1) while toon is inactive. */
  private _applyTslSaturation(): void {
    this._tslPost?.setSaturation(this._active ? this._albedoSaturation : 1);
  }

  /**
   * Lazily build the saturation pass and append it LAST in the composer (after
   * OutputPass and the Sobel outline), so it grades the final composited image.
   * Idempotent. On the WebGPURenderer paths the grade runs as the shared
   * Rec601 saturation node on the TSL post pipeline instead (plan-271
   * Phase 3). Enabled state is driven by `setAlbedo` / `enable` (only on when
   * saturation != 1).
   */
  private _ensureSaturationPass(): void {
    if (this.host.isWebGPU) {
      if (!this._tslPost && this.host._ensureTslPost) {
        this._tslPost = this.host._ensureTslPost() ?? null;
      }
      this._applyTslSaturation();
      return;
    }
    this.host._ensureComposer();
    const composer = this.host._composer;
    if (!composer) return;

    if (!this._saturationPass) {
      this._saturationPass = new ShaderPass({
        uniforms: {
          tDiffuse: { value: null },
          uSaturation: { value: this._albedoSaturation },
        },
        vertexShader: OUTLINE_VERT,
        fragmentShader: SATURATION_FRAG,
      });
      composer.addPass(this._saturationPass);
    }
    this._saturationPass.enabled = this._active && this._albedoSaturation !== 1;
  }

  private _buildOutlineResources(): void {
    const renderer = this.host.renderer as unknown as WebGLRenderer;
    const dw = renderer.domElement.width || 1;
    const dh = renderer.domElement.height || 1;

    this._rebuildGbuffer(); // creates _gbufferRT at the right size / filter / MSAA samples
    this._gbufferMat = new ShaderMaterial({
      uniforms: { uNear: { value: 0.1 }, uFar: { value: 1000 } },
      vertexShader: GBUFFER_VERT,
      fragmentShader: GBUFFER_FRAG,
      clippingPlanes: this._clippingPlanes,
    });

    this._sobelPass = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        tNormalDepth: { value: null },
        // Sobel neighbour offsets are in SCREEN pixels → device size, independent
        // of the gbuffer's supersample scale.
        resolution: { value: new Vector2(dw, dh) },
        outlineColor: { value: this._outlineColor.clone() },
        amount: { value: this._outlineAmount },
        thickness: { value: this._outlineThickness },
        threshold: { value: this._outlineThreshold },
        uNear: { value: 0.1 },
        uFar: { value: 1000 },
        uEdgeCutoff: { value: this._outlineDistance },
      },
      vertexShader: OUTLINE_VERT,
      fragmentShader: OUTLINE_FRAG,
    });
    // ShaderPass clones the uniforms; UniformsUtils cannot clone render-target
    // textures (it nulls them). Assign the gbuffer texture AFTER construction.
    this._sobelPass.uniforms.tNormalDepth.value = this._gbufferRT!.texture;
  }

  /**
   * (Re)create the normal+depth gbuffer render target at the current resolution,
   * filter and MSAA sample count, then re-point the Sobel pass at the new
   * texture. Size = device drawing buffer × supersample scale (2× when enabled).
   * MSAA samples come from the display Antialiasing setting (so MSAA also
   * anti-aliases the edges) — skipped under supersampling, where the 2× render
   * already provides the edge AA and MSAA on top would be wasteful.
   */
  private _rebuildGbuffer(): void {
    const renderer = this.host.renderer as unknown as WebGLRenderer;
    const dw = renderer.domElement.width || 1;
    const dh = renderer.domElement.height || 1;
    const scale = this._supersample ? 2 : 1;
    const gw = dw * scale;
    const gh = dh * scale;
    const old = this._gbufferRT;
    this._gbufferRT = new WebGLRenderTarget(gw, gh, {
      minFilter: this._supersample ? LinearFilter : NearestFilter,
      magFilter: this._supersample ? LinearFilter : NearestFilter,
      samples: (this.host.antialiasActive && !this._supersample) ? 4 : 0,
    });
    old?.dispose();
    this._sizeW = gw;
    this._sizeH = gh;
    if (this._sobelPass) {
      this._sobelPass.uniforms.tNormalDepth.value = this._gbufferRT.texture;
      (this._sobelPass.uniforms.resolution.value as Vector2).set(dw, dh);
    }
  }
}
