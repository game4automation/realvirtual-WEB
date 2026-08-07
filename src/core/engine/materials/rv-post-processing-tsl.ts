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
 *
 * Effect ordering mirrors the WebGL composer chain:
 *   scene → AO modulate → + outline edges → renderOutput (tone map + color
 *   space) → saturation (post-tonemap, like the toon ShaderPass appended
 *   after OutputPass).
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
  MeshBasicNodeMaterial,
  QuadMesh,
  RenderPipeline,
  RenderTarget,
} from 'three/webgpu';
import type {
  Camera,
  Object3D,
  Renderer,
  Scene,
} from 'three/webgpu';
import {
  dot,
  float,
  mix,
  pass,
  renderOutput,
  texture,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import { outline } from 'three/addons/tsl/display/OutlineNode.js';
import type OutlineNode from 'three/addons/tsl/display/OutlineNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import type GTAONode from 'three/addons/tsl/display/GTAONode.js';

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

/** Channel ids mirror RVOutlineManager's TSL-backed channels. */
export type TslOutlineChannelId = 'selection' | 'hover' | 'chain' | 'flash';

const OUTLINE_CHANNEL_IDS: readonly TslOutlineChannelId[] = ['selection', 'hover', 'chain', 'flash'];

/** Style fields mirror rv-outline-manager's OutlineStyle. `pulsePeriod` is
 *  accepted for interface parity but not animated under TSL. */
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
 *  graph rebuilds. */
function createOutlineChannelTsl() {
  return {
    objects: [] as Object3D[],
    uVisible: uniform(new Color(0xffffff)),
    uHidden: uniform(new Color(0x000000)),
    uStrength: uniform(3),
    uThickness: uniform(1),
    uGlow: uniform(0),
    node: null as OutlineNode | null,
  };
}
type OutlineChannelTsl = ReturnType<typeof createOutlineChannelTsl>;

// ─── TSL post pipeline ─────────────────────────────────────────────────────

export interface TslPostPipelineOptions {
  /** MSAA sample count for the scene pass render target (mirrors the WebGL
   *  composer render-target samples when antialias is requested). */
  samples?: number;
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

  private _pipeline: RenderPipeline | null = null;
  private _scenePass: ReturnType<typeof pass> | null = null;
  private _gtao: GTAONode | null = null;

  // Graph identity — a change forces a rebuild in render().
  private _builtScene: Scene | null = null;
  private _builtCamera: Camera | null = null;
  private _builtAo = false;

  // ── Persistent effect state (survives graph rebuilds) ──
  private _aoEnabled = false;
  /** Parity with the WebGL GTAO defaults (radius 0.15, blendIntensity 1). */
  private _aoRadius = 0.15;
  private readonly _uAoIntensity = uniform(1);
  private readonly _uSaturation = uniform(1);
  private readonly _channels: Record<TslOutlineChannelId, OutlineChannelTsl> = {
    selection: createOutlineChannelTsl(),
    hover: createOutlineChannelTsl(),
    chain: createOutlineChannelTsl(),
    flash: createOutlineChannelTsl(),
  };

  constructor(renderer: Renderer, options: TslPostPipelineOptions = {}) {
    this._renderer = renderer;
    this._samples = options.samples ?? 0;
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
  }

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

  // ─── Render orchestration ─────────────────────────────────────────────

  /** True when routing the frame through the pipeline changes the image —
   *  the viewer's render loop uses this exactly like `useComposer`. */
  get anyEffectActive(): boolean {
    return this._aoEnabled || this.anyOutlined || (this._uSaturation.value as number) !== 1;
  }

  /**
   * Render one frame through the TSL pipeline. REPLACES
   * `renderer.render(scene, camera)` — the scene pass renders internally and
   * the final effect quad lands in the current render target (the default
   * framebuffer in the viewer's render loop). Rebuilds the node graph when
   * the scene/camera identity or the AO toggle changed since the last build.
   */
  render(scene: Scene, camera: Camera): void {
    if (
      !this._pipeline
      || scene !== this._builtScene
      || camera !== this._builtCamera
      || this._aoEnabled !== this._builtAo
    ) {
      this._build(scene, camera);
    }
    this._pipeline!.render();
  }

  /** Free all GPU resources (pass RTs, outline buffers, AO RT). Idempotent. */
  dispose(): void {
    this._disposeGraph();
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
    if (this._scenePass) {
      this._scenePass.dispose();
      this._scenePass = null;
    }
    if (this._pipeline) {
      this._pipeline.dispose();
      this._pipeline = null;
    }
    this._builtScene = null;
    this._builtCamera = null;
  }

  private _build(scene: Scene, camera: Camera): void {
    this._disposeGraph();

    // three r185's GTAONode samples the pass depth texture with a mip-level
    // argument. WGSL forbids that overload for multisampled depth textures,
    // producing an invalid shader (`textureDimensions(depthMS, 0)`) on the
    // real WebGPU backend. Keep MSAA for outline/saturation-only graphs, but
    // use a single-sample scene pass whenever AO consumes depth. This is
    // intentionally WebGPU/TSL-only; the classic WebGL composer is untouched.
    const sceneSamples = this._aoEnabled ? 0 : this._samples;
    // PassNode otherwise inherits renderer.samples when the option is omitted,
    // so `samples: 0` must be explicit for the AO case.
    const scenePass = pass(scene, camera, { samples: sceneSamples });
    const sceneColor = scenePass.getTextureNode('output');
    let rgb: TslNode = sceneColor.rgb;

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
      const aoBlend = mix(float(1), gtao.getTextureNode().r, this._uAoIntensity);
      rgb = rgb.mul(aoBlend);
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
      const edge = (node.visibleEdge as TslNode).mul(ch.uVisible)
        .add((node.hiddenEdge as TslNode).mul(ch.uHidden))
        .mul(ch.uStrength);
      rgb = rgb.add(edge);
    }

    // Tone mapping + color space (the composer's OutputPass equivalent),
    // then the shared saturation term POST-tonemap — parity with the toon
    // saturation ShaderPass appended after OutputPass. saturation == 1 is an
    // identity mix, so the term can stay in the graph permanently.
    const output: TslNode = renderOutput(vec4(rgb, sceneColor.a));
    const graded = vec4(saturationRec601(output.rgb, this._uSaturation), output.a);

    const pipeline = new RenderPipeline(this._renderer);
    pipeline.outputColorTransform = false; // renderOutput above owns the transform
    pipeline.outputNode = graded;
    pipeline.needsUpdate = true;

    this._pipeline = pipeline;
    this._scenePass = scenePass;
    this._builtScene = scene;
    this._builtCamera = camera;
    this._builtAo = this._aoEnabled;
  }
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
