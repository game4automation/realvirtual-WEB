// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-post-processing-tsl — TSL node post-processing for the WebGPURenderer
 * paths (plan-271 Phase 3).
 *
 * Under `webgpu` / `webgpu-gl` the classic EffectComposer stack (GLSL
 * ShaderPass / OutlinePass / GTAOPass) is silently non-functional, so the
 * post effects run on three's TSL `RenderPipeline` (r183+ name of the
 * `PostProcessing` class) instead:
 *
 *  - **Saturation/Desaturation** — ONE shared Rec.601 luma-mix building block
 *    ({@link saturationRec601}) used by BOTH consumers that had separate GLSL
 *    copies: the toon full-screen saturation grade (rv-toon-materials.ts) and
 *    the isolate-mode desaturation blit (rv-post-processing.ts) — the dedup
 *    mandated by plan-271 §2.4.
 *  - **Selection/hover/chain outlines** — three's NATIVE TSL `outline()` node
 *    (three/addons/tsl/display/OutlineNode.js), the direct counterpart of the
 *    WebGL OutlinePass. No custom Sobel needed for selection silhouettes.
 *    `pulsePeriod` is not animated under TSL (all app styles use 0).
 *  - **Ambient occlusion** — three's NATIVE TSL `ao()` node (GTAONode).
 *    Normals are reconstructed from depth (normalNode = null), so no MRT
 *    setup is required. `aoMode: 'n8ao'` (a WebGL-only library) maps to this
 *    GTAO under WebGPU.
 *  - **Ray traced composite** (plan-762) — only while the ray traced mode is
 *    READY ({@link TslPostPipeline.setRaytraced}): the scene pass becomes a
 *    single-sample MRT G-buffer (`output`, metalness-corrected `diffuseColor`,
 *    `directionToColor(normalWorld)`, raster `specular`), the pipeline records
 *    the pass camera after every render ({@link TslRaytracedGBuffer}) and the
 *    lit colour is replaced by `diffuse × irradiance + specular` where the
 *    pixel has geometry (depth < 1) AND history (irradiance.a > 0). Without it
 *    the graph is identical to the plain one.
 *  - **Overlay layers** (highlight / measurement / agent-eye) — composited
 *    IN the graph by {@link OverlayPassNode} instead of the viewer's
 *    post-composer re-render (`RVViewer._renderOverlayLayers`). Under the
 *    WebGPURenderer that re-render is not an option: `RenderPipeline.render()`
 *    draws its quad straight onto the canvas, but every plain
 *    `renderer.render()` / `renderer.clear()` afterwards goes through three's
 *    intermediate frame-buffer target and ends with a blit of that target
 *    over the canvas — which replaced the finished frame with transparent
 *    black ("grey fullscreen" on WebGPU, 2026-10-13).
 *
 * Effect ordering mirrors the WebGL composer chain:
 *   scene → AO modulate → + outline edges → renderOutput (tone map + color
 *   space) → saturation (post-tonemap, like the toon ShaderPass appended
 *   after OutputPass) → overlay layers "over" (like the post-composer
 *   overlay pass).
 *
 * Graph rebuilds happen only on scene/camera identity change or an AO
 * enable/disable toggle. Outline channels and the saturation term stay
 * permanently in the graph: OutlineNode early-outs on an empty selection and
 * `saturation == 1` is an identity mix, so per-selection / per-hover changes
 * never trigger a shader recompile.
 *
 * NOT ported here (documented open items of plan-271 Phase 3):
 *  - UnrealBloom (WebGL composer only)
 *  - the toon Sobel edge-line pass (normal+depth gbuffer Sobel) — toon under
 *    WebGPU renders banded materials + recolor + saturation, without lines
 *
 * Import hygiene: only 'three/webgpu' / 'three/tsl' / 'three/addons/tsl/*'
 * (the addon TSL display nodes themselves import exclusively from
 * three/webgpu + three/tsl); loaded exclusively via the dynamic import in
 * material-factory.ts.
 */

import {
  Color,
  DataTexture,
  FloatType,
  Layers,
  LightsNode,
  Matrix4,
  MeshBasicNodeMaterial,
  NoColorSpace,
  PassNode,
  QuadMesh,
  RenderPipeline,
  RenderTarget,
  RGBAFormat,
  UnsignedByteType,
  Vector2,
} from 'three/webgpu';
import type {
  Camera,
  Object3D,
  Renderer,
  Scene,
  Texture,
} from 'three/webgpu';
import * as ThreeWebGPUNs from 'three/webgpu';
import {
  abs,
  clamp,
  diffuseColor,
  directionToColor,
  distance,
  dot,
  exp2,
  float,
  floor,
  ivec2,
  length,
  max,
  metalness,
  min,
  mix,
  mrt,
  normalView,
  normalize,
  normalWorld,
  output,
  pass,
  perspectiveDepthToViewZ,
  renderOutput,
  roughness,
  screenSize,
  screenUV,
  select,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  viewZToOrthographicDepth,
} from 'three/tsl';
import { outline } from 'three/addons/tsl/display/OutlineNode.js';
import type OutlineNode from 'three/addons/tsl/display/OutlineNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import type GTAONode from 'three/addons/tsl/display/GTAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';

// The project's minimal `three/webgpu` shim (src/three-webgpu.d.ts) does not
// declare LightsNode; the runtime class exists since r16x. Only the property
// the ray traced G-buffer reads is declared (plan-762 spike 0.d).
declare module 'three/webgpu' {
  export class LightsNode {
    /** Module-wide property node `directSpecular + indirectSpecular`, assigned in every lit fragment. */
    readonly totalSpecularNode: unknown;
  }
}
// `specularColorBlended` (the metal-blended F0 property node, r185) is not in
// the `three/tsl` build's export list — only in the `TSL` namespace object of
// three/webgpu (same three instance).
const specularColorBlended: unknown = (ThreeWebGPUNs as unknown as { TSL: { specularColorBlended: unknown } }).TSL.specularColorBlended;

/** TSL node representation for graph composition. Deliberately loose: the
 *  strict @types/three node generics are not reachable through the project's
 *  minimal `three/webgpu` shim (src/three-webgpu.d.ts) — values flowing
 *  through this alias come from and go back into three/tsl factory calls,
 *  which validate the graph at build time. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TslNode = any;

// ─── Shared saturation/desaturation building block ────────────────────────

/**
 * Rec.601 luma-mix saturation — THE shared node for both post-saturation
 * consumers (toon saturation grade + isolate desaturation). Exact parity with
 * the GLSL `mix(vec3(luma), c.rgb, saturation)` used by SATURATION_FRAG
 * (rv-toon-materials.ts) and the isolate desat shader (rv-post-processing.ts):
 * 0 = full greyscale, 1 = identity, 2 = boosted.
 */
export function saturationRec601(rgb: TslNode, saturation: TslNode | number): TslNode {
  const luma = dot(rgb, vec3(0.299, 0.587, 0.114));
  return mix(vec3(luma), rgb, saturation);
}

// ─── Outline channels ──────────────────────────────────────────────────────

/** Channel ids mirror RVOutlineManager's TSL-backed channels (plan-763 added
 *  `status` — the alarm / severity / instruction outline). */
export type TslOutlineChannelId = 'selection' | 'hover' | 'chain' | 'flash' | 'status';

const OUTLINE_CHANNEL_IDS: readonly TslOutlineChannelId[] = ['selection', 'hover', 'chain', 'flash', 'status'];

/** Style fields mirror rv-outline-manager's OutlineStyle. `pulsePeriod` (s)
 *  drives the channel's `uPulse` factor, updated by {@link TslPostPipeline.render}
 *  with the same cosine three's OutlinePass uses (plan-763). */
export interface TslOutlineStyleInput {
  visibleEdgeColor?: number;
  hiddenEdgeColor?: number;
  edgeStrength?: number;
  edgeThickness?: number;
  edgeGlow?: number;
  pulsePeriod?: number;
}

/** One outline channel: a LIVE selected-objects array (OutlineNode keeps the
 *  reference — mutate in place) + persistent style uniforms that survive
 *  graph rebuilds. `uPulse` is a SEPARATE factor (default 1) so the pulse never
 *  re-multiplies the style strength. */
function createOutlineChannelTsl() {
  return {
    objects: [] as Object3D[],
    uVisible: uniform(new Color(0xffffff)),
    uHidden: uniform(new Color(0x000000)),
    uStrength: uniform(3),
    uThickness: uniform(1),
    uGlow: uniform(0),
    uPulse: uniform(1),
    pulsePeriod: 0,
    node: null as OutlineNode | null,
  };
}
type OutlineChannelTsl = ReturnType<typeof createOutlineChannelTsl>;

/** OutlinePass parity: `(1 + 0.25) / 2 + cos(t·0.01 / period) · (1 − 0.25) / 2`, in [0.25, 1]. */
function pulseFactor(nowMs: number, period: number): number {
  return 0.625 + Math.cos(nowMs * 0.01 / period) * 0.375;
}

/** Edge-detection constants shared with the WebGL Sobel pass (rv-toon-materials.ts);
 *  passed in as an option because `*-tsl.ts` modules import nothing relative. */
export interface TslToonEdgeConstants {
  /** Weight of the normal difference (GLSL `NORMAL_SENS`). */
  normalSens: number;
  /** Weight of the depth difference (GLSL `DEPTH_SENS`). */
  depthSens: number;
  /** Width of the smoothstep window above the threshold. */
  smoothWindow: number;
}

const DEFAULT_TOON_EDGE: TslToonEdgeConstants = { normalSens: 1.5, depthSens: 6.0, smoothWindow: 0.25 };

/** Frame-stats bucket a pass node books into (a local literal union — the
 *  TSL module imports nothing from the viewer). */
export type TslStatsBucket = 'scene' | 'ao' | 'outline' | 'post' | 'overlay';

/** One instrumentable pass of the built graph. */
export interface TslPassHandle {
  node: { updateBefore(frame: unknown): unknown };
  bucket: TslStatsBucket;
}

/**
 * The G-buffer of the last rendered ray traced scene pass — structurally the
 * engine hook's `RaytracedGBuffer` (rv-raytraced-hook.ts; `*-tsl.ts` modules
 * import nothing relative, so the shape is repeated here). Mutated in place
 * after every `render()`; see the hook for the texture conventions.
 */
export interface TslRaytracedGBuffer {
  readonly depth: Texture;
  readonly diffuse: Texture;
  readonly normal: Texture;
  readonly specular: Texture;
  /** `specular` holds the traced-specular layout (rgb = F0, a = roughness, plan-767 run 3). */
  readonly specularMaterial: boolean;
  readonly viewProjectionInverse: Float32Array;
  readonly viewProjection: Float32Array;
  readonly cameraPosition: [number, number, number];
  readonly isOrthographic: boolean;
  readonly width: number;
  readonly height: number;
  readonly generation: number;
}

/** Writable view of {@link TslRaytracedGBuffer} for the owning pipeline. */
type MutableGBuffer = { -readonly [K in keyof TslRaytracedGBuffer]: TslRaytracedGBuffer[K] };

// ─── Overlay-layer pass ────────────────────────────────────────────────────

/**
 * Scene pass restricted to the overlay layers — the in-graph counterpart of
 * the viewer's post-composer `_renderOverlayLayers()` (depth cleared, no
 * background, overlay layers only).
 *
 * A plain `pass()` would paint `scene.background` and clear with the
 * renderer's clear color; this pass suppresses the background and clears to
 * transparent black, so its texture holds ONLY the overlay pixels — each
 * premultiplied by its coverage (normal blending onto a transparent target) —
 * for the output node to composite "over" the graded frame.
 */
class OverlayPassNode extends PassNode {
  private readonly _overlayLayers = new Layers();
  private readonly _savedClearColor = new Color();

  constructor(scene: Scene, camera: Camera, layerMask: number, samples: number) {
    super(PassNode.COLOR, scene, camera, { samples });
    this._overlayLayers.mask = layerMask;
    this.setLayers(this._overlayLayers);
  }

  override updateBefore(frame: { renderer: Renderer }): void {
    const { renderer } = frame;
    const scene = this.scene;
    const savedBackground = scene.background;
    renderer.getClearColor(this._savedClearColor);
    const savedClearAlpha = renderer.getClearAlpha();
    scene.background = null;
    renderer.setClearColor(0x000000, 0);
    try {
      super.updateBefore(frame);
    } finally {
      renderer.setClearColor(this._savedClearColor, savedClearAlpha);
      scene.background = savedBackground;
    }
  }
}

// ─── TSL post pipeline ─────────────────────────────────────────────────────

export interface TslPostPipelineOptions {
  /** MSAA sample count for the scene pass render target (mirrors the WebGL
   *  composer render-target samples when antialias is requested). */
  samples?: number;
  /** Post antialiasing when the scene pass CANNOT be multisampled (AO or toon
   *  edges read its depth — WGSL has no sampled multisampled depth): `auto`
   *  (default) runs three's FXAA on the tone-mapped frame, before the overlay
   *  composite, whenever `samples > 0` and the scene pass fell back to one
   *  sample; `none` keeps the aliased single-sample frame (tests, A/B). */
  postAntialias?: 'auto' | 'none';
  /** Camera layer mask of the overlay layers (highlight / measurement /
   *  agent-eye) to composite on top of the post result INSIDE the pipeline —
   *  see {@link OverlayPassNode}. Omit (or null) for a pipeline without an
   *  overlay pass; then `compositesOverlayLayers` is false and the caller
   *  keeps rendering overlays itself. */
  overlayLayerMask?: number | null;
  /** Toon edge constants (defaults match the WebGL Sobel pass). */
  toonEdge?: Partial<TslToonEdgeConstants>;
  /** Called at the end of every graph build with the fresh pass nodes — the
   *  viewer wires its per-pass frame stats here (plan-763 Phase 4). */
  instrument?: (passes: readonly TslPassHandle[]) => void;
  /** Clock for the outline pulse (ms). Defaults to `performance.now`; a
   *  capture or a test passes a fixed clock. */
  now?: () => number;
}

/**
 * Owns the TSL `RenderPipeline` + effect node graph for one renderer.
 * `render()` REPLACES `renderer.render(scene, camera)` in the viewer's render
 * loop whenever any effect is active (see `anyEffectActive`); when nothing is
 * active the viewer keeps its cheaper direct render.
 */
export class TslPostPipeline {
  private readonly _renderer: Renderer;
  private readonly _samples: number;
  private readonly _postAntialias: 'auto' | 'none';
  private readonly _overlayLayerMask: number | null;
  private readonly _edgeConst: TslToonEdgeConstants;
  private readonly _instrument: ((passes: readonly TslPassHandle[]) => void) | null;
  private readonly _now: () => number;

  private _pipeline: RenderPipeline | null = null;
  private _scenePass: ReturnType<typeof pass> | null = null;
  private _overlayPass: OverlayPassNode | null = null;
  private _gtao: GTAONode | null = null;
  private _bloom: ReturnType<typeof bloom> | null = null;
  private _fxaa: ReturnType<typeof fxaa> | null = null;
  private _passes: TslPassHandle[] = [];

  // Graph identity — a change forces a rebuild in render().
  private _builtScene: Scene | null = null;
  private _builtCamera: Camera | null = null;
  private _builtAo = false;
  private _builtBloom = false;
  private _builtEdges = false;
  private _builtRaytraced = false;

  // ── Persistent effect state (survives graph rebuilds) ──
  private _aoEnabled = false;
  /** Parity with the WebGL GTAO defaults (radius 0.15, blendIntensity 1). */
  private _aoRadius = 0.15;
  private readonly _uAoIntensity = uniform(1);
  private readonly _uSaturation = uniform(1);
  // Bloom (plan-763): in the graph only while enabled — BloomNode renders its
  // 12 passes every frame regardless of strength (updateBeforeType FRAME).
  private _bloomEnabled = false;
  private readonly _uBloomStrength = uniform(0.2);
  private readonly _uBloomRadius = uniform(0);
  private readonly _uBloomThreshold = uniform(0);
  // Toon edges (plan-763): MRT normal attachment + edge node only while enabled.
  private _edgesEnabled = false;
  private readonly _uEdgeAmount = uniform(0);
  private readonly _uEdgeThickness = uniform(1);
  private readonly _uEdgeThreshold = uniform(0.1);
  private readonly _uEdgeCutoff = uniform(50);
  private readonly _uEdgeColor = uniform(new Color(0x000000));
  private readonly _uNear = uniform(0.1);
  private readonly _uFar = uniform(1000);
  // Ray traced composite (plan-762 F5/F6): the irradiance node and the mix
  // uniform are PERSISTENT — they survive _disposeGraph/_build, the backend
  // swaps `irradianceNode.value` per frame (ping-pong) without a rebuild.
  private _raytracedReady = false;
  /** 1×1 black, N = 0 — the composite shows the raster output through it. */
  private readonly _rtPlaceholder: DataTexture = createRaytracedPlaceholder();
  private readonly _irradianceNode: TslNode = texture(this._rtPlaceholder);
  private readonly _uRaytracedMix = uniform(1);
  /** Pass textures of the current ray traced graph (null when not built). */
  private _rtTextures: Pick<TslRaytracedGBuffer, 'depth' | 'diffuse' | 'normal' | 'specular'> | null = null;
  /** Null until the first render() of a ray traced graph (spike 0.a). */
  private _gbuffer: MutableGBuffer | null = null;
  /** Monotonic across builds — bumps on every ray traced build and size change. */
  private _rtGeneration = 0;
  private readonly _rtMatrix = new Matrix4();
  // Composite reprojection (plan-767 F9): persistent like the irradiance node.
  // uRtReproject 0 = same pixel (no reprojection set), 1 = reproject into the
  // G-buffer the irradiance was computed on and validate against its copy.
  private readonly _uRtReproject = uniform(0);
  /** (P·V)⁻¹ of the camera of THIS render (set right before the pipeline render). */
  private readonly _uRtCurInvVP = uniform(new Matrix4());
  /** P·V and its inverse of the irradiance's G-buffer (the last dispatch). */
  private readonly _uRtPrevVP = uniform(new Matrix4());
  private readonly _uRtPrevInvVP = uniform(new Matrix4());
  /** Size (px) of the irradiance / geometry copy. */
  private readonly _uRtGeoSize = uniform(new Vector2(1, 1));
  private readonly _rtGeoPlaceholder: DataTexture = createRaytracedGeometryPlaceholder();
  private readonly _rtGeoNode: TslNode = texture(this._rtGeoPlaceholder);
  // Traced specular (plan-767 run 3): persistent like the irradiance node.
  // Requesting it switches the MRT specular attachment to the material layout
  // (rgb = F0, a = roughness) — a rebuild; the history value swaps without one.
  private readonly _rtSpecPlaceholder: DataTexture = createRaytracedPlaceholder();
  private readonly _rtSpecularNode: TslNode = texture(this._rtSpecPlaceholder);
  private _rtSpecularRequested = false;
  private _builtRtSpecular = false;
  private readonly _channels: Record<TslOutlineChannelId, OutlineChannelTsl> = {
    selection: createOutlineChannelTsl(),
    hover: createOutlineChannelTsl(),
    chain: createOutlineChannelTsl(),
    flash: createOutlineChannelTsl(),
    status: createOutlineChannelTsl(),
  };

  constructor(renderer: Renderer, options: TslPostPipelineOptions = {}) {
    this._renderer = renderer;
    this._samples = options.samples ?? 0;
    this._postAntialias = options.postAntialias ?? 'auto';
    this._overlayLayerMask = options.overlayLayerMask ?? null;
    this._edgeConst = { ...DEFAULT_TOON_EDGE, ...(options.toonEdge ?? {}) };
    this._instrument = options.instrument ?? null;
    this._now = options.now ?? (() => performance.now());
  }

  /** Number of graph builds so far — tests pin that toggles rebuild exactly once. */
  get buildCount(): number { return this._buildCount; }
  private _buildCount = 0;

  /** The pass nodes of the current graph with their stats bucket. */
  get passes(): readonly TslPassHandle[] { return this._passes; }

  /** True while the CURRENT graph antialiases through FXAA — i.e. MSAA was
   *  requested but AO / toon edges forced a single-sample scene pass and
   *  `postAntialias` is `auto`. False when MSAA is live or nothing was asked. */
  get postAntialiasActive(): boolean { return this._fxaa !== null; }

  /** True when `render()` also composites the overlay layers (an
   *  `overlayLayerMask` was given) — the caller must then NOT re-render them
   *  after the pipeline (see {@link OverlayPassNode} for why that wipes the
   *  canvas under the WebGPURenderer). */
  get compositesOverlayLayers(): boolean {
    return this._overlayLayerMask !== null;
  }

  // ─── Outlines ────────────────────────────────────────────────────────

  /** Replace a channel's outlined objects (empty array clears). Mutates the
   *  LIVE array shared with the OutlineNode — no graph rebuild. */
  setOutlined(id: TslOutlineChannelId, objects: readonly Object3D[]): void {
    const ch = this._channels[id];
    ch.objects.length = 0;
    for (const o of objects) ch.objects.push(o);
  }

  /** Update a channel's style uniforms (partial — only provided fields). */
  setOutlineStyle(id: TslOutlineChannelId, style: TslOutlineStyleInput): void {
    const ch = this._channels[id];
    if (style.visibleEdgeColor !== undefined) ch.uVisible.value.setHex(style.visibleEdgeColor);
    if (style.hiddenEdgeColor !== undefined) ch.uHidden.value.setHex(style.hiddenEdgeColor);
    if (style.edgeStrength !== undefined) ch.uStrength.value = style.edgeStrength;
    if (style.edgeThickness !== undefined) ch.uThickness.value = style.edgeThickness;
    if (style.edgeGlow !== undefined) ch.uGlow.value = style.edgeGlow;
    if (style.pulsePeriod !== undefined) {
      ch.pulsePeriod = Math.max(0, style.pulsePeriod);
      if (ch.pulsePeriod === 0) ch.uPulse.value = 1;
    }
  }

  /** Set a channel's pulse factor directly (0..1; 1 = full strength). Overrides
   *  the clock-driven pulse until the next `render()` with a period > 0. */
  setOutlinePulse(id: TslOutlineChannelId, factor: number): void {
    this._channels[id].uPulse.value = Math.max(0, Math.min(1, factor));
  }

  // ─── Bloom (plan-763) ────────────────────────────────────────────────

  /** Enable toggles rebuild the graph (like AO); the three parameters are
   *  live uniforms. `strength` is the RAW setting — the WebGL gain factor
   *  (`toWebGLBloomStrength`) must never reach this path. */
  setBloom(enabled: boolean, strength: number, radius: number, threshold: number): void {
    this._bloomEnabled = enabled;
    this._uBloomStrength.value = strength;
    this._uBloomRadius.value = radius;
    this._uBloomThreshold.value = threshold;
  }

  get bloomEnabled(): boolean { return this._bloomEnabled; }

  // ─── Toon edges (plan-763) ───────────────────────────────────────────

  /** Enable toggles rebuild the graph (MRT normal attachment + edge node);
   *  amount / thickness / threshold / colour / distance are live uniforms.
   *  `distance` (m) is the cutoff beyond which edges fade out. */
  setToonEdges(enabled: boolean, amount: number, thickness: number, threshold: number, color: number, distance: number): void {
    this._edgesEnabled = enabled;
    this._uEdgeAmount.value = amount;
    this._uEdgeThickness.value = thickness;
    this._uEdgeThreshold.value = threshold;
    this._uEdgeColor.value.setHex(color);
    this._uEdgeCutoff.value = distance;
  }

  get toonEdgesEnabled(): boolean { return this._edgesEnabled; }

  /** Whether any channel currently outlines at least one object. */
  get anyOutlined(): boolean {
    return OUTLINE_CHANNEL_IDS.some((id) => this._channels[id].objects.length > 0);
  }

  // ─── Saturation (shared Rec.601 node — toon grade) ──────────────────

  /** 0 = greyscale, 1 = identity (effect off), 2 = boosted. */
  setSaturation(v: number): void {
    this._uSaturation.value = v;
  }

  get saturation(): number {
    return this._uSaturation.value as number;
  }

  // ─── Ambient occlusion (native TSL GTAONode) ─────────────────────────

  /** Toggling AO changes the node graph — applied on the next render(). */
  setAoEnabled(enabled: boolean): void {
    this._aoEnabled = enabled;
  }

  get aoEnabled(): boolean {
    return this._aoEnabled;
  }

  /** AO blend intensity (0 = invisible, 1 = full) — mirrors GTAOPass.blendIntensity. */
  setAoIntensity(v: number): void {
    this._uAoIntensity.value = v;
  }

  get aoIntensity(): number {
    return this._uAoIntensity.value as number;
  }

  /** AO sampling radius in world units — mirrors the WebGL GTAO radius. */
  setAoRadius(v: number): void {
    this._aoRadius = v;
    if (this._gtao) this._gtao.radius.value = v;
  }

  get aoRadius(): number {
    return this._aoRadius;
  }

  // ─── Ray traced composite (plan-762) ─────────────────────────────────

  /**
   * Enter (`irradiance` = a texture) or leave (`null`) the ray traced graph.
   * Entering / leaving rebuilds the graph on the next render (MRT pass +
   * composite); a call while already ready only rebinds the irradiance (no
   * rebuild). Any `Texture` is accepted — a `StorageTexture` from the
   * backend, a `DataTexture` in a test (F18).
   */
  setRaytraced(irradiance: Texture | null): void {
    this._raytracedReady = irradiance !== null;
    this.setRaytracedIrradiance(irradiance);
    if (irradiance === null) {
      this.setRaytracedReprojection(null, null);
      this.setRaytracedSpecular(null);
    }
  }

  /**
   * Traced specular (plan-767 run 3): the backend's specular history read side
   * (rgb = specular radiance / envBrdf(F0, roughness, N·V), a = N), sampled and
   * reprojected like the irradiance. A texture switches the MRT specular
   * attachment to the material layout (rgb = F0, a = roughness) — one graph
   * rebuild on the next render; `null` returns to the raster specular.
   */
  setRaytracedSpecular(specular: Texture | null): void {
    this._rtSpecularRequested = specular !== null;
    this._rtSpecularNode.value = specular ?? this._rtSpecPlaceholder;
  }

  /** True while the CURRENT ray traced graph composites the traced specular. */
  get raytracedSpecularActive(): boolean { return this._builtRaytraced && this._builtRtSpecular; }

  /**
   * Composite reprojection (plan-767 F9): `viewProjection` (column-major P·V,
   * copied) of the G-buffer the bound irradiance was computed on and a copy of
   * that G-buffer (`rgba32float`, rgb = packed world normal, a = standard
   * depth). `null` → sample the irradiance at the same pixel. Uniforms only,
   * no graph rebuild.
   */
  setRaytracedReprojection(viewProjection: Float32Array | null, geometry: Texture | null): void {
    if (!viewProjection || !geometry) {
      this._uRtReproject.value = 0;
      this._rtGeoNode.value = this._rtGeoPlaceholder;
      return;
    }
    const vp = this._uRtPrevVP.value as Matrix4;
    vp.fromArray(viewProjection);
    (this._uRtPrevInvVP.value as Matrix4).copy(vp).invert();
    const img = geometry.image as { width?: number; height?: number } | null;
    (this._uRtGeoSize.value as Vector2).set(Math.max(1, img?.width ?? 1), Math.max(1, img?.height ?? 1));
    this._rtGeoNode.value = geometry;
    this._uRtReproject.value = 1;
  }

  /** 1 while a composite reprojection is bound (plan-767 F9). */
  get raytracedReprojecting(): boolean { return (this._uRtReproject.value as number) > 0; }

  /** Bind the irradiance texture (rgb = E, a = sample count) without a rebuild; `null` → the placeholder (raster output everywhere). */
  setRaytracedIrradiance(irradiance: Texture | null): void {
    this._irradianceNode.value = irradiance ?? this._rtPlaceholder;
  }

  /** The bound irradiance texture (the placeholder when none is bound). */
  get raytracedIrradiance(): Texture { return this._irradianceNode.value as Texture; }

  /** True while the ray traced graph is requested (`setRaytraced(texture)`). */
  get raytracedReady(): boolean { return this._raytracedReady; }

  /** 0 = composite off (raster output, no rebuild — wireframe / capture, F17), 1 = on. */
  setRaytracedMix(v: number): void {
    this._uRaytracedMix.value = v;
  }

  get raytracedMix(): number { return this._uRaytracedMix.value as number; }

  /** The G-buffer of the last rendered ray traced pass; null before the first one or outside the mode. */
  get raytracedGBuffer(): TslRaytracedGBuffer | null { return this._gbuffer; }

  // ─── Render orchestration ─────────────────────────────────────────────

  /** True when routing the frame through the pipeline changes the image —
   *  the viewer's render loop uses this exactly like `useComposer`. */
  get anyEffectActive(): boolean {
    return this._aoEnabled || this._bloomEnabled || this._edgesEnabled || this._raytracedReady
      || this.anyOutlined || (this._uSaturation.value as number) !== 1;
  }

  /**
   * Render one frame through the TSL pipeline. REPLACES
   * `renderer.render(scene, camera)` — the scene pass renders internally and
   * the final effect quad lands in the current render target (the default
   * framebuffer in the viewer's render loop). Rebuilds the node graph when
   * the scene/camera identity or an AO / bloom / edge toggle changed since the
   * last build; updates the per-frame uniforms (pulse, near/far) before.
   */
  render(scene: Scene, camera: Camera): void {
    if (
      !this._pipeline
      || scene !== this._builtScene
      || camera !== this._builtCamera
      || this._aoEnabled !== this._builtAo
      || this._bloomEnabled !== this._builtBloom
      || this._edgesEnabled !== this._builtEdges
      || this._raytracedReady !== this._builtRaytraced
      || (this._raytracedReady && this._rtSpecularRequested !== this._builtRtSpecular)
    ) {
      this._build(scene, camera);
    }
    const now = this._now();
    for (const id of OUTLINE_CHANNEL_IDS) {
      const ch = this._channels[id];
      if (ch.pulsePeriod > 0 && ch.objects.length > 0) ch.uPulse.value = pulseFactor(now, ch.pulsePeriod);
    }
    const cam = camera as Camera & { near?: number; far?: number };
    if (typeof cam.near === 'number') this._uNear.value = cam.near;
    if (typeof cam.far === 'number') this._uFar.value = cam.far;
    if (this._rtTextures) {
      // plan-767 F9: the composite reconstructs the world position of THIS
      // render; the scene pass would update the world matrix itself, a moved
      // camera must not be one frame behind here.
      if (camera.matrixWorldAutoUpdate && !camera.parent) camera.updateMatrixWorld();
      (this._uRtCurInvVP.value as Matrix4).multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse);
    }
    this._pipeline!.render();
    if (this._rtTextures) this._captureGBuffer(camera);
  }

  /** Free all GPU resources (pass RTs, outline buffers, AO RT, placeholder). Idempotent. */
  dispose(): void {
    this._disposeGraph();
    this._raytracedReady = false;
    this._irradianceNode.value = this._rtPlaceholder;
    this._rtPlaceholder.dispose();
    this._uRtReproject.value = 0;
    this._rtGeoNode.value = this._rtGeoPlaceholder;
    this._rtGeoPlaceholder.dispose();
    this._rtSpecularRequested = false;
    this._rtSpecularNode.value = this._rtSpecPlaceholder;
    this._rtSpecPlaceholder.dispose();
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  private _disposeGraph(): void {
    for (const id of OUTLINE_CHANNEL_IDS) {
      const ch = this._channels[id];
      // OutlineNode.dispose() truncates its selectedObjects array — ours.
      // Detach first so the channel selection survives a graph rebuild.
      // (dispose() exists at runtime but is missing from the .d.ts.)
      if (ch.node) {
        ch.node.selectedObjects = [];
        (ch.node as unknown as { dispose(): void }).dispose();
        ch.node = null;
      }
    }
    if (this._gtao) {
      (this._gtao as unknown as { dispose(): void }).dispose();
      this._gtao = null;
    }
    if (this._bloom) {
      (this._bloom as unknown as { dispose(): void }).dispose();
      this._bloom = null;
    }
    if (this._fxaa) {
      (this._fxaa as unknown as { dispose?: () => void }).dispose?.();
      this._fxaa = null;
    }
    this._passes = [];
    if (this._scenePass) {
      this._scenePass.dispose();
      this._scenePass = null;
    }
    if (this._overlayPass) {
      this._overlayPass.dispose();
      this._overlayPass = null;
    }
    if (this._pipeline) {
      this._pipeline.dispose();
      this._pipeline = null;
    }
    this._builtScene = null;
    this._builtCamera = null;
    // The history belongs to the backend; the pass textures die with the pass.
    this._rtTextures = null;
    this._gbuffer = null;
  }

  /** Record the pass camera + size after a ray traced render (F5). */
  private _captureGBuffer(camera: Camera): void {
    const tex = this._rtTextures!;
    const rt = (this._scenePass as unknown as { renderTarget: { width: number; height: number } }).renderTarget;
    let gb = this._gbuffer;
    if (!gb) {
      gb = {
        ...tex,
        viewProjectionInverse: new Float32Array(16),
        viewProjection: new Float32Array(16),
        cameraPosition: [0, 0, 0],
        isOrthographic: false,
        width: rt.width,
        height: rt.height,
        generation: this._rtGeneration,
        specularMaterial: this._builtRtSpecular,
      };
      this._gbuffer = gb;
    } else if (gb.width !== rt.width || gb.height !== rt.height) {
      gb.width = rt.width;
      gb.height = rt.height;
      gb.generation = ++this._rtGeneration;
    }
    // (P·V)⁻¹ = V⁻¹ · P⁻¹ = matrixWorld · projectionMatrixInverse.
    this._rtMatrix.multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse);
    const e = this._rtMatrix.elements;
    const out = gb.viewProjectionInverse;
    for (let i = 0; i < 16; i++) out[i] = e[i];
    // forward P·V (plan-767 F6) — the backend reprojects later pixels into this pass
    this._rtMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const fwd = gb.viewProjection;
    for (let i = 0; i < 16; i++) fwd[i] = e[i];
    const w = camera.matrixWorld.elements;
    gb.cameraPosition[0] = w[12];
    gb.cameraPosition[1] = w[13];
    gb.cameraPosition[2] = w[14];
    gb.isOrthographic = (camera as { isOrthographicCamera?: boolean }).isOrthographicCamera === true;
  }

  private _build(scene: Scene, camera: Camera): void {
    this._disposeGraph();

    // three r185's GTAONode samples the pass depth texture with a mip-level
    // argument. WGSL forbids that overload for multisampled depth textures,
    // producing an invalid shader (`textureDimensions(depthMS, 0)`) on the
    // real WebGPU backend. Keep MSAA for outline/saturation-only graphs, but
    // use a single-sample scene pass whenever AO consumes depth. This is
    // intentionally WebGPU/TSL-only; the classic WebGL composer is untouched.
    // The toon edge node samples the pass depth the same way (plan-763), so it
    // forces the single-sample pass too.
    // The ray traced G-buffer is single-sampled too — with MSAA depth / normal
    // are silently wrong at ~20 % of the pixels (spike 0.a).
    const raytraced = this._raytracedReady;
    const tracedSpecular = raytraced && this._rtSpecularRequested;
    const sceneSamples = (this._aoEnabled || this._edgesEnabled || raytraced) ? 0 : this._samples;
    // PassNode otherwise inherits renderer.samples when the option is omitted,
    // so `samples: 0` must be explicit for the AO case.
    const scenePass = pass(scene, camera, { samples: sceneSamples });
    // Toon edges read a view-space normal attachment next to the colour —
    // the MRT exists only while edges are enabled (bandwidth, and transparent
    // materials write blended normals into it).
    // The ray traced G-buffer (plan-762 F5, spike 0.d) replaces the edge MRT —
    // the two never coexist (toon is not ray traced). The layout fits the
    // 32 B colour-attachment limit: output 8 + diffuse 8 + normal 4 + specular 8.
    if (raytraced) {
      // `totalSpecular` is a module-wide property node; any LightsNode exposes it.
      const lights = new LightsNode();
      const dc = diffuseColor as TslNode;
      scenePass.setMRT(mrt({
        output,
        // MRT diffuseColor is NOT metalness-corrected (spike 0.d): metal → 0.
        diffuseColor: vec4(dc.rgb.mul((metalness as TslNode).oneMinus()), dc.a),
        normal: directionToColor(normalWorld),
        // plan-767 run 3: with the traced specular the attachment carries the
        // material instead of the raster radiance — rgb = F0 (metal-blended
        // specular colour), a = roughness (three's clamped / AA'd value).
        specular: tracedSpecular
          ? vec4(specularColorBlended as TslNode, roughness as TslNode)
          : lights.totalSpecularNode as TslNode,
      }));
      const normalTexture = scenePass.getTexture('normal');
      normalTexture.type = UnsignedByteType;
      const diffuseTexture = scenePass.getTexture('diffuseColor');
      const specularTexture = scenePass.getTexture('specular');
      for (const t of [normalTexture, diffuseTexture, specularTexture]) t.colorSpace = NoColorSpace;
      this._rtTextures = {
        depth: scenePass.getTexture('depth'),
        diffuse: diffuseTexture,
        normal: normalTexture,
        specular: specularTexture,
      };
      this._rtGeneration++;
    } else if (this._edgesEnabled) {
      scenePass.setMRT(mrt({ output, normal: normalView }));
    }
    const sceneColor = scenePass.getTextureNode('output');
    let rgb: TslNode = sceneColor.rgb;
    const passes: TslPassHandle[] = [{ node: scenePass as unknown as TslPassHandle['node'], bucket: 'scene' }];

    // Ray traced composite (plan-762 F6) — BEFORE AO / outlines / renderOutput.
    // Sky (depth = 1) and pixels without history (irradiance.a = 0: reset,
    // rows outside the budget so far) keep the raster output: no black, no
    // flicker on a resize drag. `uRaytracedMix = 0` shows the raster output
    // without a rebuild (wireframe / video capture, F17).
    if (raytraced) {
      const depthN: TslNode = scenePass.getTextureNode('depth');
      const diffuseN: TslNode = scenePass.getTextureNode('diffuseColor');
      const specularN: TslNode = scenePass.getTextureNode('specular');
      const normalN: TslNode = scenePass.getTextureNode('normal');
      // plan-767 F9: the irradiance was computed on the PREVIOUS G-buffer (the
      // kernel runs before the scene pass). Reproject: world position of this
      // pixel (this render's camera) → texel of that G-buffer (its P·V), then
      // validate the tap against the G-buffer copy (plane distance along this
      // pixel's normal, m7) — an invalid tap shows the raster output. Every
      // term is evaluated unconditionally and blended by the 0/1 uniform (no
      // node in both branches of a select, see below).
      const rp: TslNode = this._uRtReproject;
      const ndcCur: TslNode = vec2((screenUV as TslNode).x.mul(2).sub(1), (float(1) as TslNode).sub((screenUV as TslNode).y.mul(2)));
      const wpH: TslNode = this._uRtCurInvVP.mul(vec4(ndcCur, depthN.r, float(1)));
      const npH: TslNode = this._uRtCurInvVP.mul(vec4(ndcCur, float(0), float(1)));
      const worldP: TslNode = wpH.xyz.div(wpH.w);
      const viewDist: TslNode = length(worldP.sub(npH.xyz.div(npH.w)));
      const clipP: TslNode = this._uRtPrevVP.mul(vec4(worldP, float(1)));
      const pndc: TslNode = clipP.xy.div(max(abs(clipP.w), float(1e-6)));
      const gsize: TslNode = this._uRtGeoSize;
      const pix: TslNode = vec2(pndc.x.mul(0.5).add(0.5).mul(gsize.x), (float(0.5) as TslNode).sub(pndc.y.mul(0.5)).mul(gsize.y));
      const pixF: TslNode = floor(pix);
      const inside: TslNode = clipP.w.greaterThan(0)
        .and(pixF.x.greaterThanEqual(0)).and(pixF.y.greaterThanEqual(0))
        .and(pixF.x.lessThan(gsize.x)).and(pixF.y.lessThan(gsize.y));
      const texel: TslNode = ivec2(clamp(pixF, vec2(0, 0), gsize.sub(1)));
      const geo: TslNode = this._rtGeoNode.load(texel);
      const tndc: TslNode = vec2(pixF.x.add(0.5).div(gsize.x).mul(2).sub(1), (float(1) as TslNode).sub(pixF.y.add(0.5).div(gsize.y).mul(2)));
      const pwH: TslNode = this._uRtPrevInvVP.mul(vec4(tndc, geo.a, float(1)));
      const nCur: TslNode = normalize(normalN.rgb.mul(2).sub(1));
      const planeDiff: TslNode = abs(dot(pwH.xyz.div(pwH.w).sub(worldP), nCur));
      const tapOk: TslNode = inside.and(geo.a.lessThan(1)).and(planeDiff.lessThan(viewDist.mul(0.02).add(1e-4)));
      const valid: TslNode = mix(float(1), select(tapOk, float(1), float(0)), rp);
      const irradiance: TslNode = mix(this._irradianceNode, this._irradianceNode.load(texel), rp);
      let gate: TslNode = this._uRaytracedMix.greaterThan(0)
        .and(depthN.r.lessThan(1))
        .and(irradiance.a.greaterThan(0))
        .and(valid.greaterThan(0.5));
      let specularRgb: TslNode = specularN.rgb;
      if (tracedSpecular) {
        // plan-767 run 3: traced specular = envBrdf(F0, roughness, N·V) × the
        // demodulated history (same texel / validation as the irradiance). The
        // env BRDF is Karis' analytic fit — bit-identical to the backend's
        // `rtEnvBrdf` (divisor ≥ 1e-3, the same clamp on both sides).
        const spec: TslNode = mix(this._rtSpecularNode, this._rtSpecularNode.load(texel), rp);
        const f0: TslNode = clamp(specularN.rgb, vec3(0, 0, 0), vec3(1, 1, 1));
        const rough: TslNode = clamp(specularN.a, 0.02, 1);
        const viewDir: TslNode = normalize(worldP.sub(npH.xyz.div(npH.w)));
        const nDotV: TslNode = clamp(abs(dot(nCur, viewDir)), 1e-4, 1);
        const r: TslNode = rough.mul(vec4(-1, -0.0275, -0.572, 0.022)).add(vec4(1, 0.0425, 1.04, -0.04));
        const a004: TslNode = min(r.x.mul(r.x), exp2(nDotV.mul(-9.28))).mul(r.x).add(r.y);
        const envA: TslNode = a004.mul(-1.04).add(r.z);
        const envB: TslNode = a004.mul(1.04).add(r.w);
        const envBrdf: TslNode = max(max(f0.mul(envA).add(envB), vec3(0, 0, 0)), vec3(1e-3, 1e-3, 1e-3));
        specularRgb = envBrdf.mul(spec.rgb);
        gate = gate.and(spec.a.greaterThan(0));
      }
      const traced: TslNode = diffuseN.rgb.mul(irradiance.rgb).add(specularRgb);
      // Blend by a gated WEIGHT, never `select(gate, f(rgb), rgb)`: a node used
      // in both branches of a TSL select is emitted inside one branch only and
      // reads black in the other (observed on webgpu-gl, 2026-10-19).
      // × the MRT diffuse alpha (material opacity × alpha map): a blended
      // receiver — the ground fade disc writes depth in this mode (rv-viewer
      // `_syncRaytracedGroundDepth`) — fades back to the raster output instead
      // of ending in a hard edge; opaque surfaces have alpha 1 (plan-762 Phase 3).
      const weight: TslNode = select(gate, this._uRaytracedMix, float(0)).mul(diffuseN.a.clamp(0, 1));
      rgb = mix(rgb, traced, weight);
    }

    // AO first — modulates the scene color like GTAOPass right after the
    // RenderPass. Normals are reconstructed from depth (no MRT needed).
    if (this._aoEnabled) {
      const gtao = ao(
        scenePass.getTextureNode('depth'),
        null as unknown as Parameters<typeof ao>[1], // null → normals from depth
        camera,
      );
      gtao.resolutionScale = 0.5; // parity with the composer's half-res AO (PP_SCALE)
      gtao.radius.value = this._aoRadius;
      gtao.thickness.value = 0.5; // parity with updateGtaoMaterial({ thickness: 0.5 })
      this._gtao = gtao;
      passes.push({ node: gtao as unknown as TslPassHandle['node'], bucket: 'ao' });
      const aoBlend = mix(float(1), gtao.getTextureNode().r, this._uAoIntensity);
      rgb = rgb.mul(aoBlend);
    }

    // Bloom (plan-763) — on the lit colour before the outlines and before tone
    // mapping, the composer order (RenderPass → GTAO → Bloom → OutputPass).
    if (this._bloomEnabled) {
      const node = bloom(vec4(rgb, float(1)), this._uBloomStrength, this._uBloomRadius, this._uBloomThreshold);
      this._bloom = node;
      passes.push({ node: node as unknown as TslPassHandle['node'], bucket: 'post' });
      rgb = rgb.add((node as unknown as TslNode).rgb);
    }

    // Outline channels — three's native TSL outline node, additively
    // composited like the WebGL OutlinePass (pre-tonemap). Channels with an
    // empty selection early-out inside OutlineNode (no extra passes).
    for (const id of OUTLINE_CHANNEL_IDS) {
      const ch = this._channels[id];
      const node = outline(scene, camera, {
        selectedObjects: ch.objects, // LIVE array — setOutlined mutates in place
        edgeThickness: ch.uThickness,
        edgeGlow: ch.uGlow,
      });
      // three r185 quirk: with an EMPTY selection OutlineNode never
      // initializes its composite RT (it only clears on the 1→0 selection
      // transition) — sampling the uninitialized RT produced garbage edge
      // pixels on the first frame (observed under SwiftShader; composite
      // encodes visibleEdge in R / hiddenEdge in G). Priming the internal
      // counter makes the node run its OWN clear path on the first update.
      (node as unknown as { _lastSelectionCount: number })._lastSelectionCount = 1;
      ch.node = node;
      passes.push({ node: node as unknown as TslPassHandle['node'], bucket: 'outline' });
      const edge = (node.visibleEdge as TslNode).mul(ch.uVisible)
        .add((node.hiddenEdge as TslNode).mul(ch.uHidden))
        .mul(ch.uStrength)
        .mul(ch.uPulse);
      rgb = rgb.add(edge);
    }

    // Tone mapping + color space (the composer's OutputPass equivalent).
    const outputColor: TslNode = renderOutput(vec4(rgb, sceneColor.a));
    let shaded: TslNode = outputColor.rgb;

    // Toon edge lines (plan-763): the WebGL Sobel ShaderPass ported one to one
    // — 4-neighbour normal + depth differences, smoothstep window, distance
    // cutoff — applied AFTER the output transform (the ShaderPass sits after
    // OutputPass) and before the saturation grade.
    if (this._edgesEnabled) {
      const isPerspective = (camera as { isPerspectiveCamera?: boolean }).isPerspectiveCamera === true;
      const normalTex: TslNode = scenePass.getTextureNode('normal');
      const depthTex: TslNode = scenePass.getTextureNode('depth');
      const uvN: TslNode = uv();
      const texel: TslNode = vec2(this._uEdgeThickness).div(screenSize);
      // Normalised linear depth 0..1 between near and far, like the gbuffer alpha.
      const linearDepthAt = (off: TslNode): TslNode => {
        const d: TslNode = depthTex.sample(uvN.add(off)).r;
        if (!isPerspective) return d;
        return viewZToOrthographicDepth(perspectiveDepthToViewZ(d, this._uNear, this._uFar), this._uNear, this._uFar);
      };
      // The GLSL pass compared PACKED normals (n·0.5+0.5); raw view normals
      // double every difference, hence the 0.5.
      const normalAt = (off: TslNode): TslNode => normalTex.sample(uvN.add(off)).rgb.mul(0.5);
      const zero: TslNode = vec2(0, 0);
      const offL: TslNode = vec2(texel.x.negate(), 0);
      const offR: TslNode = vec2(texel.x, 0);
      const offU: TslNode = vec2(0, texel.y);
      const offD: TslNode = vec2(0, texel.y.negate());
      const nC = normalAt(zero);
      const ne: TslNode = distance(nC, normalAt(offL)).add(distance(nC, normalAt(offR)))
        .add(distance(nC, normalAt(offU))).add(distance(nC, normalAt(offD)));
      const dC = linearDepthAt(zero);
      const de: TslNode = abs(dC.sub(linearDepthAt(offL))).add(abs(dC.sub(linearDepthAt(offR))))
        .add(abs(dC.sub(linearDepthAt(offU)))).add(abs(dC.sub(linearDepthAt(offD))));
      let edge: TslNode = max(ne.mul(this._edgeConst.normalSens), de.mul(this._edgeConst.depthSens));
      edge = smoothstep(this._uEdgeThreshold, this._uEdgeThreshold.add(this._edgeConst.smoothWindow), edge).mul(this._uEdgeAmount);
      const dist: TslNode = this._uNear.add(dC.mul(this._uFar.sub(this._uNear)));
      edge = edge.mul(float(1).sub(smoothstep(this._uEdgeCutoff.mul(0.9), this._uEdgeCutoff, dist)));
      shaded = mix(shaded, this._uEdgeColor, edge);
    }

    // The shared saturation term POST-tonemap — parity with the toon
    // saturation ShaderPass appended after OutputPass. saturation == 1 is an
    // identity mix, so the term can stay in the graph permanently.
    let graded: TslNode = vec4(saturationRec601(shaded, this._uSaturation), outputColor.a);

    // Post antialiasing (FXAA) stands in for the MSAA that AO / toon edges
    // took away from the scene pass. It needs the sRGB, tone-mapped frame
    // (three's FXAANode contract) and runs BEFORE the overlay composite so
    // the overlay pass keeps its own MSAA and its gizmo lines stay crisp.
    // In the graph only when it replaces something: with MSAA live or with
    // no antialias asked for it is not built at all.
    if (this._postAntialias === 'auto' && this._samples > 0 && sceneSamples === 0) {
      const node = fxaa(graded);
      this._fxaa = node;
      passes.push({ node: node as unknown as TslPassHandle['node'], bucket: 'post' });
      graded = node as unknown as TslNode;
    }

    // Overlay layers LAST, over the graded frame — what the post-composer
    // overlay pass did by drawing onto the tone-mapped framebuffer. The
    // overlay texture is premultiplied by coverage (normal blending onto a
    // transparent target), so: un-premultiply, run the SAME output transform
    // as the scene, then blend by coverage in output space — i.e. the
    // overlay's straight colour, encoded, "over" the frame.
    let final: TslNode = graded;
    let overlayPass: OverlayPassNode | null = null;
    if (this._overlayLayerMask !== null) {
      overlayPass = new OverlayPassNode(scene, camera, this._overlayLayerMask, this._samples);
      passes.push({ node: overlayPass as unknown as TslPassHandle['node'], bucket: 'overlay' });
      const overlay: TslNode = overlayPass.getTextureNode('output');
      const coverage: TslNode = overlay.a;
      const straight: TslNode = overlay.rgb.div(max(coverage, float(1e-4)));
      const encoded: TslNode = renderOutput(vec4(straight, float(1))).rgb;
      const composited: TslNode = mix(graded.rgb, encoded, coverage);
      const alpha: TslNode = max(graded.a, coverage);
      final = vec4(composited, alpha);
    }

    const pipeline = new RenderPipeline(this._renderer);
    pipeline.outputColorTransform = false; // renderOutput above owns the transform
    pipeline.outputNode = final;
    pipeline.needsUpdate = true;

    this._pipeline = pipeline;
    this._scenePass = scenePass;
    this._overlayPass = overlayPass;
    this._builtScene = scene;
    this._builtCamera = camera;
    this._builtAo = this._aoEnabled;
    this._builtBloom = this._bloomEnabled;
    this._builtEdges = this._edgesEnabled;
    this._builtRaytraced = raytraced;
    this._builtRtSpecular = tracedSpecular;
    this._passes = passes;
    this._buildCount++;
    // Instrumentation hooks in HERE, not after the first render: a frame
    // rendered between the build and a later wrap would land in `other`.
    this._instrument?.(passes);
  }
}

/** 1×1 RGBA float geometry copy (plan-767 F9): depth 1 = sky, never a valid tap. */
function createRaytracedGeometryPlaceholder(): DataTexture {
  const tex = new DataTexture(new Float32Array([0.5, 0.5, 1, 1]), 1, 1, RGBAFormat, FloatType);
  tex.colorSpace = NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** 1×1 RGBA zero texture: irradiance 0 with sample count 0. */
function createRaytracedPlaceholder(): DataTexture {
  const tex = new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat, UnsignedByteType);
  tex.colorSpace = NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ─── Isolate-mode desaturation blit ────────────────────────────────────────

export interface DesatBlitTslOptions {
  /** MSAA samples for the backdrop render target (mirrors the WebGL desat RT). */
  samples?: number;
}

/**
 * TSL replacement for the isolate-mode desaturation blit
 * (rv-post-processing.ts `ensureDesatPass()` — a raw ShaderMaterial that the
 * WebGPURenderer cannot run): render the dim backdrop into `renderTarget`,
 * then `blit()` it to the current framebuffer through the SHARED
 * {@link saturationRec601} node.
 */
export interface DesatBlitTsl {
  readonly renderTarget: RenderTarget;
  /** Saturation uniform handle: 0 = full greyscale (isolate default). */
  readonly saturation: { value: number };
  setSize(width: number, height: number): void;
  /** Draw the desaturated fullscreen quad into the CURRENT render target. */
  blit(renderer: Renderer): void;
  dispose(): void;
}

/** Create the lazy desaturation blit resources (RT + node-material quad). */
export function createDesatBlitTsl(options: DesatBlitTslOptions = {}): DesatBlitTsl {
  const renderTarget = new RenderTarget(1, 1, { samples: options.samples ?? 0 });
  const uSaturation = uniform(0);
  const material = new MeshBasicNodeMaterial();
  const backdrop = texture(renderTarget.texture);
  material.colorNode = saturationRec601(backdrop.rgb, uSaturation);
  material.depthTest = false;
  material.depthWrite = false;
  material.toneMapped = false; // the backdrop RT already holds tone-mapped colors
  const quad = new QuadMesh(material);

  return {
    renderTarget,
    saturation: uSaturation as unknown as { value: number },
    setSize(width: number, height: number): void {
      if (renderTarget.width !== width || renderTarget.height !== height) {
        renderTarget.setSize(width, height);
      }
    },
    blit(renderer: Renderer): void {
      quad.render(renderer);
    },
    dispose(): void {
      material.dispose();
      renderTarget.dispose();
    },
  };
}
