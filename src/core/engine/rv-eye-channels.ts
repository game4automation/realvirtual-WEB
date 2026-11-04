// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-eye-channels — the agent eye's render channels (plan-740 P2.3).
 *
 * The premise (D-U4): the renderer knows the object identity of every pixel
 * EXACTLY. A vision model asked to infer it from a beauty render is guessing at
 * something we can simply hand over. So one pose produces up to three aligned
 * images:
 *
 *   beauty   — the live scene through a private camera. Materials, lighting,
 *              what the thing looks like.
 *   idmask   — flat identity colours + white crease edges + a colour→path
 *              legend, and the `idBuffer` behind it: the ground truth for
 *              coverage, screen boxes and Set-of-Mark placement. The edges are
 *              DEPTH-TESTED (unlike x-ray's), so they trace only the surfaces
 *              that are actually visible, and they are rendered in a SECOND
 *              pass — the buffer is decoded from the edge-free frame, because
 *              white is not a palette colour and would read as background.
 *   xray     — the requested subtree ALONE on a near-black ground, as
 *              translucent fill plus crease edges in the selection style
 *              (the highlight manager's own EdgesGeometry cache), depth test
 *              off on BOTH. That is what makes it a channel for looking INSIDE
 *              a part: every internal surface draws, so bores, cavities and
 *              buried components are visible through the shell around them.
 *              Its edges and the idmask's come from the same app-wide cache;
 *              only the depth test and the colour differ — and that one
 *              difference is the whole distinction between the two channels,
 *              since depth-testing these edges would hide exactly the inner
 *              structure the channel exists to show.
 *
 * WITHDRAWN CHANNELS (2026-09-14). `normals`, `depth` and `edges` were channels
 * here and are gone, together with the two render passes that fed them — the
 * G-buffer normal pass and the `RGBADepthPacking` depth pass — and with the
 * linear-colour-space render target those two needed. Consequences worth
 * knowing: there is no `depthRange` in any sidecar any more and no per-node
 * depth range in `buildVisible`; metric questions go to `web_measure` and
 * `web_node_bounds`, which answer them from geometry rather than from a frame.
 * `unpackRGBADepth` moved to `rv-gbuffer-material.ts`, which still owns the
 * G-buffer for the toon outline path.
 *
 * NOTHING here touches `viewer.camera`, the controls, the selection, the
 * isolation state or the visible frame. Every pass runs through
 * {@link OffscreenCapture}, which restores whatever it changed.
 */

import {
  Box3,
  Color,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LinearFilter,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  UnsignedByteType,
  Vector3,
  WebGLRenderTarget,
  type Camera,
  type Object3D,
  type WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ISOLATE_FOCUS_LAYER, OVERLAY_LAYERS } from './rv-group-registry';
import { DEFAULT_SELECTION_STYLE, cachedEdgesGeometry } from './rv-highlight-manager';
import { OffscreenCapture, captureSupported, type OffscreenPass } from './rv-offscreen-capture';
import { sceneArenaSink } from './rv-arena-sink';
import {
  IDMASK_GROUP_CAP,
  idmaskColor,
  resolveIdmaskGroups,
  type IdmaskGrouping,
  type IdmaskLegendEntry,
  type IdmaskRegistry,
} from './rv-idmask-grouping';
import type { AgentPose, EyeProjection } from './rv-agent-eye';

export type EyeChannel = 'beauty' | 'idmask' | 'xray';

/** Every channel name, in the order a full request renders them. */
export const EYE_CHANNELS: readonly EyeChannel[] =
  ['beauty', 'idmask', 'xray'] as const;

/**
 * Ambient occlusion for the agent's beauty frame is ALWAYS ON and deliberately
 * independent of the viewport's visual settings: contact shadows are what make
 * "this part sits on that one" readable, and a perception channel must not
 * change meaning because a human toggled an effect for their own view.
 *
 * The radius follows the framed content instead of being a fixed world length.
 * The viewport can afford one tuned value because a human keeps roughly one
 * scale on screen; the agent jumps from a 1.7 m machine to a 0.1 m valve
 * terminal in consecutive calls, and a metre-scale radius on a 10 cm part
 * washes the image out completely.
 */
const AO_RADIUS_FRACTION = 0.02;
const AO_RADIUS_MIN_M = 0.005;
const AO_RADIUS_MAX_M = 0.5;

/** idmask background — near-black, distinct from every palette colour. */
export const IDMASK_BACKGROUND = '#101014';

/**
 * idmask crease-edge colour. White is unreachable for the palette — every
 * entry is HSL(h, 0.85, <=0.78), i.e. saturated — and {@link paletteToIds}
 * accepts only within 24 units, so an edge pixel can never be mistaken for a
 * group. It is maximally far from {@link IDMASK_BACKGROUND} too.
 */
export const IDMASK_EDGE_COLOR = '#ffffff';

/**
 * xray ground. The channel is for looking INSIDE a part, and a beauty base
 * fought that: it drew the subject opaquely underneath its own overlay, on a
 * mid-grey scene, so every translucent layer composited in the top half of the
 * value range and three or four of them saturated into one flat mass. On a
 * near-black ground the fill has the whole range to itself and depth ordering
 * becomes expressible. Same value as {@link IDMASK_BACKGROUND}, so the two dark
 * channels read as one family.
 */
export const XRAY_BACKGROUND = IDMASK_BACKGROUND;

/**
 * Depth bias applied to every flat idmask fill so the coincident crease lines
 * win the depth test instead of z-fighting into a stipple. Depth only — the
 * colour a pixel ends up with is untouched, which is why the edge-free ground
 * truth pass and the edged picture agree pixel for pixel.
 */
const IDMASK_FILL_OFFSET = {
  polygonOffset: true,
  polygonOffsetFactor: 1,
  polygonOffsetUnits: 1,
} as const;
/** No group owns this pixel. Cap 48 ≪ 0xFFFF, so it can never collide. */
export const IDMASK_NO_GROUP = 0xFFFF;

/**
 * The camera layer mask every agent render uses: all scene content plus the
 * isolate focus layer, minus every OVERLAY layer.
 *
 * The exclusion is not cosmetic. `AGENT_EYE_LAYER` is one of the overlay layers
 * (D-A4), so this is what stops the agent from photographing its own cone —
 * and, at the same time, keeps hover wireframes, measurement markers and
 * planner gizmos out of a picture that is supposed to show the machine.
 */
export const AGENT_LAYER_MASK: number = (() => {
  let mask = 0xFFFFFFFF | 0;
  for (const l of OVERLAY_LAYERS) mask &= ~(1 << l);
  return mask;
})();

export type Vec3Arr = [number, number, number];

export interface EyeCameraInfo {
  position: Vec3Arr;
  target: Vec3Arr;
  fov: number;
  aspect: number;
  projection: EyeProjection;
  near: number;
  far: number;
  orthoHalfHeight?: number;
}

export interface EyeRenderRequest {
  /** The agent pose to render from. */
  pose: AgentPose;
  /** Long edge in pixels; the short edge follows `pose.aspect`. */
  size: number;
  channels: EyeChannel[];
  /**
   * xray colouring. `single` (default) paints the whole subtree in one hue,
   * which keeps the channel a pure density read. `group` gives every group its
   * identity colour from the SAME grouping the idmask uses — so the two
   * channels key to one legend and an internal part becomes nameable, at the
   * cost of muddier reading where differently-coloured layers overlap.
   *
   * The grouping itself is never chosen separately: it comes from `idmask`
   * (groupBy / groupDepth / paths) for both channels. One grouping means one
   * subtree build and one legend; letting xray pick its own would need a
   * second build of the same scene to answer the same question twice.
   */
  xrayColorBy?: 'single' | 'group';
  /** Subtree to render (idmask grouping root). Defaults to the model root. */
  root?: Object3D;
  idmask?: IdmaskGrouping;
  /** World box to crop to (its on-screen rect + 8 %). */
  crop?: Box3;
}

export interface EyeChannelResult {
  channel: EyeChannel;
  canvas: HTMLCanvasElement;
  mime: 'image/png' | 'image/jpeg';
  /** idmask only: group index per pixel, {@link IDMASK_NO_GROUP} = background. */
  idBuffer?: Uint16Array;
}

export interface EyeRenderResult {
  width: number;
  height: number;
  camera: EyeCameraInfo;
  channels: EyeChannelResult[];
  legend: IdmaskLegendEntry[];
  /** The crop actually applied, as fractions of the uncropped frame. */
  crop?: { x: number; y: number; w: number; h: number };
  /**
   * True when the viewport's isolate was active for this frame: beauty shows
   * the non-isolated parts dimmed the way the viewport does, and idmask/xray
   * draw the isolated subtrees ALONE — a dimmed part has no identity.
   */
  isolate?: boolean;
}

/**
 * One isolate channel of the viewer — the shape `GroupRegistry` and
 * `AutoFilterRegistry` share. The eye reads it, never writes it: the isolate
 * is document state the viewport owns (plan-740 D-U3).
 */
export interface EyeIsolateSource {
  readonly isIsolateActive: boolean;
  /** Re-tag dynamically added descendants with the focus layer (idempotent). */
  refreshIsolateLayer(): void;
  /** Caller override of the dim opacity, `null`/absent for the default. */
  readonly dimOpacity?: number | null;
}

/** Minimal viewer surface — keeps this module off the RVViewer god-node. */
export interface EyeChannelHost {
  readonly scene: Scene;
  readonly renderer: unknown;
  readonly registry?: IdmaskRegistry;
  readonly currentModelRoot?: Object3D | null;
  /**
   * The viewport's two isolate channels (`RVViewer.groups` / `.autoFilters`).
   * Optional: a host without them renders no isolation, which is what a host
   * that cannot isolate anything should get.
   */
  readonly groups?: EyeIsolateSource | null;
  readonly autoFilters?: EyeIsolateSource | null;
}

/** The viewport's default dim opacity (`_renderIsolateMode`'s fallback). */
const ISOLATE_DIM_OPACITY = 0.9;

/** What one isolate-aware frame needs to know, resolved once per render. */
interface EyeIsolate {
  /** Everything the frame may draw EXCEPT objects that live on the focus layer only. */
  backdropMask: number;
  /** The focus layer alone — the isolated subtrees, drawn crisp on top. */
  focusMask: number;
  /** Opacity of the tint quad between backdrop and focus. */
  opacity: number;
}

/**
 * Run `fn` with every light of `scene` carrying the focus bit.
 *
 * three tests LIGHTS against the camera's layer mask like any other object
 * (`WebGLRenderer.projectObject`), and the viewer's lights live on layer 0 —
 * so a focus-only camera would draw the isolated part lit by the environment
 * map alone, or not at all without one. The bit is taken back afterwards; a
 * light that already had it is left alone.
 */
function withFocusLights<T>(scene: Scene, fn: () => T): T {
  const tagged: Object3D[] = [];
  scene.traverse((o) => {
    if ((o as { isLight?: boolean }).isLight && !o.layers.isEnabled(ISOLATE_FOCUS_LAYER)) {
      o.layers.enable(ISOLATE_FOCUS_LAYER);
      tagged.push(o);
    }
  });
  try {
    return fn();
  } finally {
    for (const o of tagged) o.layers.disable(ISOLATE_FOCUS_LAYER);
  }
}

/**
 * The eye's counterpart of the viewport's isolate passes 2 + 3
 * (`RVViewer._renderIsolateMode`): over the dimmed backdrop the composer has
 * already produced in `readBuffer`, draw the tint quad and then the focus
 * layer with a cleared depth buffer, so an isolated part that is physically
 * buried still shows through the dimmed shell around it.
 *
 * Sits BEFORE the `OutputPass`, so both the quad and the focus pass are blended
 * in linear space and encoded once, together with the backdrop. A plain
 * `RenderPass` would not do: the live scene's `background` is a `Color`, and a
 * Color background forces a clear on every `renderer.render()` (the same
 * `forceClear` gate the viewport works around), which would wipe the backdrop
 * the pass is supposed to draw over.
 */
class IsolateCompositePass extends Pass {
  layerMask = 0;
  constructor(
    private readonly scene: Scene,
    public camera: Camera,
    private readonly tintScene: Scene,
    private readonly tintCamera: Camera,
  ) {
    super();
    this.needsSwap = false;
    this.clear = false;
  }

  override render(renderer: WebGLRenderer, _writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget): void {
    const prevAutoClear = renderer.autoClear;
    const prevMask = this.camera.layers.mask;
    const prevBackground = this.scene.background;
    renderer.autoClear = false;
    this.scene.background = null;
    try {
      renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
      renderer.clearDepth();
      renderer.render(this.tintScene, this.tintCamera);
      renderer.clearDepth();
      this.camera.layers.mask = this.layerMask;
      withFocusLights(this.scene, () => renderer.render(this.scene, this.camera));
    } finally {
      this.camera.layers.mask = prevMask;
      this.scene.background = prevBackground;
      renderer.autoClear = prevAutoClear;
    }
  }
}

// ─── The renderer ───────────────────────────────────────────────────────

/**
 * Renders the agent eye's channels. ONE instance per owner (the agent-eye
 * plugin), holding one render target and the channel materials; `dispose()`
 * frees both and is called on model change and plugin teardown (D-A15).
 */
export class EyeChannels {
  /**
   * ONE sRGB target. There used to be a second, LINEAR one: three applies the
   * output colour-space conversion from the render target texture's
   * `colorSpace`, so an sRGB target gamma-encodes what the shader wrote —
   * right for pictures, wrong for the normals and depth passes, which were
   * numbers (the P2.0 spike measured a "distance" 2.4x too large purely from
   * the sRGB curve). Every remaining channel IS a picture, so the linear
   * target and the materials that fed it are gone with those passes.
   */
  private readonly _colorCapture: OffscreenCapture;
  /**
   * The eye's OWN post chain (composer + GTAO), never the viewport's.
   *
   * Reusing `RVPostProcessing`'s composer would mean re-pointing its passes at
   * the agent camera and resizing every internal target to the capture size —
   * i.e. mutating exactly the viewport state this class promises never to
   * touch, and inheriting whatever the user switched off. A private chain costs
   * one more set of render targets and keeps both properties.
   */
  private _aoComposer: EffectComposer | null = null;
  private _aoScenePass: RenderPass | null = null;
  private _aoGtao: GTAOPass | null = null;
  private _aoIsolatePass: IsolateCompositePass | null = null;
  private _aoOverlayPass: RenderPass | null = null;
  /** The isolate tint quad (viewport pass 2), shared by both renderer branches. */
  private _tintScene: Scene | null = null;
  private _tintCam: OrthographicCamera | null = null;
  private _tintMat: MeshBasicMaterial | null = null;
  /** Camera kind the GTAO pass was BUILT for — its `PERSPECTIVE_CAMERA` define
   *  is baked in the constructor, while every camera uniform refreshes per
   *  render, so only a persp/ortho switch forces a rebuild. */
  private _aoPerspective: boolean | null = null;
  private _aoW = 0;
  private _aoH = 0;
  private _xrayFillMat: MeshBasicMaterial | null = null;
  private _xrayEdgeMat: LineBasicMaterial | null = null;
  /** Per-group xray materials, one pair per colour. Rebuilt per render and
   *  owned by the xray scene, unlike the two single-hue singletons above. */
  private _xrayGroupMats: (MeshBasicMaterial | LineBasicMaterial)[] = [];
  private _xrayScene: Scene | null = null;
  private _idmaskScene: Scene | null = null;
  private _idmaskMats: MeshBasicMaterial[] = [];
  private _idmaskEdgeMat: LineBasicMaterial | null = null;
  private readonly _persp = new PerspectiveCamera(45, 4 / 3, 0.01, 1000);
  private readonly _ortho = new OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);

  constructor(private readonly host: EyeChannelHost) {
    const renderer = (): WebGLRenderer | undefined =>
      this.host.renderer as WebGLRenderer | undefined;
    this._colorCapture = new OffscreenCapture(renderer);
  }

  /** `null` when a capture can run, otherwise the agent-facing refusal. */
  guard(tool = 'This tool'): string | null {
    return captureSupported(this.host.renderer, tool);
  }

  /**
   * Render the requested channels. Returns `{ error }` for the conditions an
   * agent can cause (WebGPU, no model, an unresolvable group path) so the tool
   * hands the message straight back.
   */
  async renderChannels(req: EyeRenderRequest): Promise<EyeRenderResult | { error: string }> {
    const guard = this.guard('web_eye');
    if (guard) return { error: guard };
    // plan-766 F10: with editor arenas the agent captures (ID mask built from
    // the source meshes, beauty of the live scene) run in arena CAPTURE mode —
    // sources on their real layers, arenas masked out — for the whole capture,
    // so every channel describes the authored tree itself. No arenas = no-op.
    const arena = sceneArenaSink(this.host.scene);
    if (!arena) return this._renderChannels(req);
    arena.enterCapture();
    try {
      return await this._renderChannels(req);
    } finally {
      arena.leaveCapture();
    }
  }

  private async _renderChannels(req: EyeRenderRequest): Promise<EyeRenderResult | { error: string }> {
    const renderer = this.host.renderer as WebGLRenderer;
    const registry = this.host.registry;
    const root = req.root ?? this.host.currentModelRoot ?? null;
    if (!root || !registry) return { error: 'No model loaded' };
    root.updateMatrixWorld(true);

    const { width: W, height: H } = frameSize(req.size, req.pose.aspect);
    const camera = this._camera(req.pose, W / H);

    const layerMask = AGENT_LAYER_MASK;
    // The viewport's isolate, read once for the whole frame so every channel
    // sees the same focus set (a `refreshIsolateLayer` between two channels
    // could otherwise tag a freshly spawned MU into one and not the other).
    const isolate = this._isolate(layerMask);

    const wanted = dedupeChannels(req.channels);

    // Scale the AO radius to what the camera actually frames (see
    // AO_RADIUS_FRACTION): eye-to-target distance for perspective, frustum
    // height for orthographic.
    const framedExtent = (camera as PerspectiveCamera).isPerspectiveCamera
      ? Math.hypot(
        req.pose.px - req.pose.tx, req.pose.py - req.pose.ty, req.pose.pz - req.pose.tz,
      )
      : ((camera as OrthographicCamera).top - (camera as OrthographicCamera).bottom);
    const aoRadius = Math.min(
      AO_RADIUS_MAX_M,
      Math.max(AO_RADIUS_MIN_M, AO_RADIUS_FRACTION * framedExtent),
    );

    const legend: IdmaskLegendEntry[] = [];
    let idBuffer: Uint16Array | undefined;
    let idPixels: Uint8Array | undefined;

    // ── the subtree scene: idmask AND xray draw the requested root only ──
    // The legend is the idmask's; an xray-only request builds the same scene
    // but keeps its legend out of the sidecar.
    // A group-coloured xray needs the legend as much as the idmask does — the
    // colours are only nameable through it — so the legend is filled whenever
    // EITHER channel will show identity colours, not just for the idmask.
    const xrayByGroup = req.xrayColorBy === 'group';
    const wantsLegend = wanted.includes('idmask') || (wanted.includes('xray') && xrayByGroup);
    let built: { scene: Scene; colors: Color[]; edges: Group } | null = null;
    if (wanted.includes('idmask') || wanted.includes('xray')) {
      const b = await this._buildIdmaskScene(
        root, registry, req.idmask ?? {}, wantsLegend ? legend : [], isolate !== null,
      );
      if ('error' in b) return b;
      built = b;
    }

    // ── idmask (also the source of coverage, screen boxes and SoM) ──
    //
    // TWO passes of the same scene, and the reason is the whole design: the
    // flat pixels are both the picture an agent looks at AND the ground truth
    // `idBuffer` behind coverage, screen boxes and Set-of-Mark placement. A
    // white edge pixel is by construction not a palette colour, so decoding a
    // frame that already has edges on it would punch a hole in the identity of
    // every part it traces. So: render the mask WITHOUT edges and decode that,
    // then switch the edge group on and render again for the image. The cost
    // is one extra pass plus one extra readback on a tool with a 60 s budget;
    // the gain is that coverage and boxes stay exact to the pixel.
    if (wanted.includes('idmask') && built) {
      const idPass = {
        width: W, height: H, layerMask, colorSpace: SRGBColorSpace,
        scene: built.scene, camera, overrideMaterial: null,
        clearColor: IDMASK_BACKGROUND, clearAlpha: 1,
        background: new Color(IDMASK_BACKGROUND),
      };
      // Pass 1 — ground truth; pass 2 — the picture. Both readbacks are
      // ISSUED synchronously (each into its own buffer) and awaited together
      // once the renderer state is back to the viewport's.
      built.edges.visible = false;
      const truthRead = this._renderPass(this._colorCapture, idPass, built.scene, camera, renderer);
      built.edges.visible = true;
      const pictureRead = this._renderPass(this._colorCapture, idPass, built.scene, camera, renderer);
      built.edges.visible = false;
      const [truth, picture] = await Promise.all([truthRead, pictureRead]);
      idBuffer = paletteToIds(truth, built.colors);
      idPixels = picture;
    }

    // ── xray (the subject's overlay alone, on a near-black ground) ──
    //
    // NO beauty base (changed 2026-09-14, see XRAY_BACKGROUND). That also
    // takes the channel off the composer entirely: GTAO existed to light the
    // beauty base, and ambient occlusion on a translucent overlay is
    // meaningless. So an xray-only request now builds no AO chain at all.
    let xrayPixels: Uint8Array | undefined;
    if (wanted.includes('xray') && built) {
      const overlay = this._buildXrayScene(built.scene, xrayByGroup);
      xrayPixels = await this._renderPass(
        this._colorCapture,
        {
          width: W, height: H, layerMask, colorSpace: SRGBColorSpace,
          scene: overlay, camera, overrideMaterial: null,
          clearColor: XRAY_BACKGROUND, clearAlpha: 1,
          background: new Color(XRAY_BACKGROUND),
        },
        overlay, camera, renderer,
      );
    }

    // ── beauty (LIVE scene, private camera) ──
    let beautyPixels: Uint8Array | undefined;
    if (wanted.includes('beauty')) {
      beautyPixels = await this._renderBeautyAO(
        W, H, camera, renderer, layerMask, aoRadius, null, isolate,
      );
    }

    // ── Encode in the REQUESTED order ──
    const channels: EyeChannelResult[] = [];
    for (const ch of wanted) {
      if (ch === 'beauty' && beautyPixels) {
        channels.push({ channel: ch, canvas: pixelsToCanvas(beautyPixels, W, H), mime: 'image/jpeg' });
      } else if (ch === 'idmask' && idPixels) {
        channels.push({ channel: ch, canvas: pixelsToCanvas(idPixels, W, H), mime: 'image/png', idBuffer });
      } else if (ch === 'xray' && xrayPixels) {
        channels.push({ channel: ch, canvas: pixelsToCanvas(opaque(xrayPixels), W, H), mime: 'image/png' });
      }
    }

    const result: EyeRenderResult = {
      width: W, height: H,
      camera: cameraInfo(req.pose, camera),
      channels, legend,
      ...(isolate ? { isolate: true } : {}),
    };
    return req.crop ? cropResult(result, req.crop, camera, W, H) : result;
  }

  /**
   * The viewport's isolate state for ONE frame, or `null` when nothing is
   * isolated. Refreshes the focus layer first, exactly as the viewport does per
   * frame, so a descendant added since the isolate began (a spawned MU, async
   * geometry) carries the focus bit before any channel looks at it.
   */
  private _isolate(layerMask: number): EyeIsolate | null {
    const groups = this.host.groups ?? null;
    const autoFilters = this.host.autoFilters ?? null;
    if (!groups?.isIsolateActive && !autoFilters?.isIsolateActive) return null;
    groups?.refreshIsolateLayer();
    autoFilters?.refreshIsolateLayer();
    // Same precedence as the viewport: autoFilters over groups over the default.
    const opacity = autoFilters?.dimOpacity ?? groups?.dimOpacity ?? ISOLATE_DIM_OPACITY;
    return {
      backdropMask: layerMask & ~(1 << ISOLATE_FOCUS_LAYER),
      focusMask: 1 << ISOLATE_FOCUS_LAYER,
      opacity,
    };
  }

  /**
   * The tint quad between backdrop and focus (viewport pass 2), coloured like
   * the scene background so the dimmed parts fade towards the sky rather than
   * towards white. Built once; `dispose()` frees it.
   */
  private _tintQuad(renderer: WebGLRenderer, opacity: number): { scene: Scene; camera: Camera } {
    if (!this._tintScene) {
      const scene = new Scene();
      scene.background = null; // a Color here would force-clear the backdrop away
      const mat = new MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity,
        depthTest: false,
        depthWrite: false,
        side: DoubleSide,
        toneMapped: false,
      });
      const quad = new Mesh(new PlaneGeometry(2, 2), mat);
      quad.frustumCulled = false;
      scene.add(quad);
      this._tintScene = scene;
      this._tintCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
      this._tintMat = mat;
    }
    const mat = this._tintMat as MeshBasicMaterial;
    mat.opacity = opacity;
    const bg = this.host.scene.background;
    if (bg && (bg as Color).isColor) mat.color.copy(bg as Color);
    else renderer.getClearColor(mat.color);
    return { scene: this._tintScene, camera: this._tintCam as Camera };
  }

  /** Free the render target and every channel material. */
  dispose(): void {
    this._colorCapture.dispose();
    this._disposeAo();
    if (this._tintScene) {
      for (const o of this._tintScene.children) (o as Mesh).geometry?.dispose();
      this._tintScene = null;
    }
    this._tintMat?.dispose();
    this._tintMat = null;
    this._tintCam = null;
    this._xrayFillMat?.dispose();
    this._xrayFillMat = null;
    this._xrayEdgeMat?.dispose();
    this._xrayEdgeMat = null;
    this._idmaskEdgeMat?.dispose();
    this._idmaskEdgeMat = null;
    this._disposeXrayScene();
    this._disposeIdmaskScene();
  }

  // ─── internals ────────────────────────────────────────────────────

  /**
   * The x-ray overlay scene: one translucent fill mesh plus one crease-edge
   * LineSegments per mesh of the subtree scene, in the SELECTION style of the
   * highlight manager (its colours, opacities, edge threshold and edge cache),
   * with the depth test off so hidden parts show through. Rebuilt per render
   * — the wrappers are cheap, the EdgesGeometry is cached app-wide.
   */
  private _buildXrayScene(subtree: Scene, colorByGroup = false): Scene {
    this._disposeXrayScene();
    const style = DEFAULT_SELECTION_STYLE;
    // Group colouring reads the colour straight off the flat mesh the idmask
    // scene already built, so the two channels cannot drift apart: the hue an
    // internal part glows in here is by construction the hue the legend names.
    // Materials are cached per colour rather than per mesh — a 700-mesh
    // subtree still collapses to at most IDMASK_GROUP_CAP + 1 pairs.
    const byColor = new Map<number, { fill: MeshBasicMaterial; edge: LineBasicMaterial }>();
    const groupMats = (mesh: Mesh): { fill: MeshBasicMaterial; edge: LineBasicMaterial } => {
      const src = (mesh.material as MeshBasicMaterial).color;
      const key = src.getHex();
      let pair = byColor.get(key);
      if (!pair) {
        pair = {
          fill: new MeshBasicMaterial({
            color: src, transparent: true, opacity: style.overlayOpacity,
            depthTest: false, depthWrite: false, toneMapped: false,
          }),
          edge: new LineBasicMaterial({
            color: src, transparent: true, opacity: style.edgeOpacity,
            depthTest: false, depthWrite: false, toneMapped: false,
          }),
        };
        byColor.set(key, pair);
        this._xrayGroupMats.push(pair.fill, pair.edge);
      }
      return pair;
    };
    this._xrayFillMat ??= new MeshBasicMaterial({
      color: style.overlayColor,
      transparent: true,
      opacity: style.overlayOpacity,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this._xrayEdgeMat ??= new LineBasicMaterial({
      color: style.edgeColor,
      transparent: true,
      opacity: style.edgeOpacity,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const scene = new Scene();
    scene.background = null;
    for (const child of subtree.children) {
      const mesh = child as Mesh;
      if (!mesh.isMesh) continue;
      const mats = colorByGroup ? groupMats(mesh) : null;
      const fill = new Mesh(mesh.geometry, mats ? mats.fill : this._xrayFillMat);
      fill.matrixAutoUpdate = false;
      fill.matrix.copy(mesh.matrix);
      fill.renderOrder = 0;
      scene.add(fill);
      const edges = new LineSegments(
        cachedEdgesGeometry(mesh.geometry), mats ? mats.edge : this._xrayEdgeMat);
      edges.matrixAutoUpdate = false;
      edges.matrix.copy(mesh.matrix);
      edges.renderOrder = 1;
      scene.add(edges);
    }
    this._xrayScene = scene;
    return scene;
  }

  private _disposeXrayScene(): void {
    // Geometries are the live model's (fills) or the shared edge cache's
    // (lines) — neither is ours to dispose. Only the wrappers go, plus the
    // per-group materials, which unlike the two single-hue singletons are
    // built fresh for each render and belong to this scene.
    for (const m of this._xrayGroupMats) m.dispose();
    this._xrayGroupMats = [];
    this._xrayScene?.clear();
    this._xrayScene = null;
  }

  /** The private camera for a pose. Never `viewer.camera` — that is the human's. */
  private _camera(pose: AgentPose, aspect: number): PerspectiveCamera | OrthographicCamera {
    const pos = new Vector3(pose.px, pose.py, pose.pz);
    const target = new Vector3(pose.tx, pose.ty, pose.tz);
    if (pos.distanceToSquared(target) < 1e-12) target.set(pose.px, pose.py, pose.pz - 1);
    const dist = pos.distanceTo(target);
    // near/far bracket the pose generously: an agent flies from a plant
    // overview to a 20 mm bore in two calls, and a fixed pair would clip one
    // of them. Both feed the depth linearization, so they are reported.
    const near = Math.max(dist / 1000, 0.005);
    const far = Math.max(dist * 100, 100);
    if (pose.projection === 'orthographic') {
      const halfH = dist * Math.tan((pose.fov * Math.PI) / 360);
      const cam = this._ortho;
      cam.left = -halfH * aspect; cam.right = halfH * aspect;
      cam.top = halfH; cam.bottom = -halfH;
      cam.near = near; cam.far = far;
      cam.position.copy(pos); cam.lookAt(target);
      cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
      return cam;
    }
    const cam = this._persp;
    cam.fov = pose.fov; cam.aspect = aspect;
    cam.near = near; cam.far = far;
    cam.position.copy(pos); cam.lookAt(target);
    cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
    return cam;
  }

  /** One offscreen render + readback. The returned buffer is REUSED — copy it. */
  /**
   * Beauty (optionally with the x-ray overlay composited on top) through the
   * eye's private composer, with GTAO always applied.
   *
   * Reads back from `composer.readBuffer`: with `renderToScreen` off the last
   * pass writes there instead of the canvas, so the capture never touches the
   * visible frame. The whole thing still runs inside `withPass`, which is what
   * restores the render target, clear colour, tone mapping, scene background
   * and camera layer mask afterwards.
   */
  private _renderBeautyAO(
    W: number, H: number, camera: Camera, renderer: WebGLRenderer,
    layerMask: number, aoRadius: number, overlay: Scene | null,
    isolate: EyeIsolate | null = null,
  ): Promise<Uint8Array> {
    // With an isolate active the frame is composited the way the viewport
    // does it (`_renderIsolateMode`): the backdrop is everything that is not
    // on the focus layer alone, then a tint quad, then the focus layer crisp
    // on top with the depth cleared. The eye used to render the plain scene
    // here and show every part bright — so `web_view_isolate` dimmed the
    // user's viewport while `web_eye` kept photographing the whole machine.
    const sceneMask = isolate ? isolate.backdropMask : layerMask;
    // WebGPURenderer (plan-763): the EffectComposer + GTAOPass chain below is
    // WebGL-only, so the beauty channel is the plain lit scene without
    // ambient occlusion there (documented reduced look). The overlay, when
    // given, is drawn on top without clearing — same as the composer's
    // non-clearing overlay pass.
    if ((renderer as { isWebGPURenderer?: boolean }).isWebGPURenderer) {
      return this._colorCapture.withPass(
        { width: W, height: H, layerMask: sceneMask, colorSpace: SRGBColorSpace, scene: this.host.scene, camera },
        (ctx) => {
          renderer.clear();
          renderer.render(this.host.scene, camera);
          if (isolate) {
            const tint = this._tintQuad(renderer, isolate.opacity);
            const prevAutoClear = renderer.autoClear;
            const prevBackground = this.host.scene.background;
            renderer.autoClear = false;
            // A Color background forces a clear per render (Background.js);
            // the focus pass must draw OVER the tinted backdrop.
            this.host.scene.background = null;
            try {
              renderer.clearDepth();
              renderer.render(tint.scene, tint.camera);
              renderer.clearDepth();
              camera.layers.mask = isolate.focusMask;
              withFocusLights(this.host.scene, () => renderer.render(this.host.scene, camera));
            } finally {
              camera.layers.mask = sceneMask;
              this.host.scene.background = prevBackground;
              renderer.autoClear = prevAutoClear;
            }
          }
          if (overlay) {
            const prevAutoClear = renderer.autoClear;
            renderer.autoClear = false;
            try { renderer.render(overlay, camera); } finally { renderer.autoClear = prevAutoClear; }
          }
          return this._colorCapture.readPixels(ctx.target, ctx.width, ctx.height);
        },
      );
    }
    const perspective = (camera as PerspectiveCamera).isPerspectiveCamera === true;
    if (this._aoComposer && this._aoPerspective !== perspective) this._disposeAo();

    if (!this._aoComposer) {
      // EffectComposer's DEFAULT targets are HalfFloatType, and a byte
      // readback from one of those comes back black. The chain is read back as
      // 8-bit pixels, so it gets 8-bit targets. They stay in LINEAR space —
      // OutputPass is what encodes to sRGB, and an sRGB target here would make
      // the renderer encode on write and OutputPass encode again on top.
      const aoTarget = new WebGLRenderTarget(Math.max(1, W), Math.max(1, H), {
        type: UnsignedByteType,
        minFilter: LinearFilter,
        magFilter: LinearFilter,
      });
      const composer = new EffectComposer(renderer, aoTarget);
      // PIXEL RATIO 1, ALWAYS. EffectComposer seeds its ratio from the
      // renderer and multiplies every setSize by it, so on a HiDPI display the
      // targets come out 2x the requested size while the readback still asks
      // for W x H — which silently returns the bottom-left QUARTER of the
      // frame. The eye's size is already in device pixels; there is no second
      // scaling step to apply.
      composer.setPixelRatio(1);
      // The result must stay in a render target we can read; writing to the
      // canvas would overwrite what the human is looking at.
      composer.renderToScreen = false;
      const scenePass = new RenderPass(this.host.scene, camera);
      const gtao = new GTAOPass(this.host.scene, camera, W, H);
      gtao.output = GTAOPass.OUTPUT.Default;
      gtao.blendIntensity = 1.0;
      // The x-ray overlay draws ON TOP of the occluded frame, so it is a
      // non-clearing pass after AO rather than a second render into the same
      // target the way the forward path used to do it.
      const overlayPass = new RenderPass(this.host.scene, camera);
      overlayPass.clear = false;
      overlayPass.enabled = false;
      // Isolate composite (tint + focus) between AO and the x-ray overlay:
      // the focus pass has no AO, exactly like the viewport's pass 3.
      const tint = this._tintQuad(renderer, ISOLATE_DIM_OPACITY);
      const isolatePass = new IsolateCompositePass(this.host.scene, camera, tint.scene, tint.camera);
      isolatePass.enabled = false;
      composer.addPass(scenePass);
      composer.addPass(gtao);
      composer.addPass(isolatePass);
      composer.addPass(overlayPass);
      composer.addPass(new OutputPass());
      this._aoComposer = composer;
      this._aoScenePass = scenePass;
      this._aoGtao = gtao;
      this._aoIsolatePass = isolatePass;
      this._aoOverlayPass = overlayPass;
      this._aoPerspective = perspective;
      this._aoW = 0;
      this._aoH = 0;
    }

    const composer = this._aoComposer;
    const gtao = this._aoGtao as GTAOPass;
    if (this._aoW !== W || this._aoH !== H) {
      // Full resolution, unlike the viewport's half-res AO: this frame is read
      // by a vision model once, not drawn 60 times a second. setSize forwards
      // to every pass, so GTAO's own buffers follow.
      composer.setSize(W, H);
      this._aoW = W;
      this._aoH = H;
    }

    (this._aoScenePass as RenderPass).camera = camera;
    gtao.camera = camera;
    // Section planes must cut the AO normals too, or the occlusion is computed
    // against geometry the clip removed and a cut face darkens for no reason.
    gtao.normalMaterial.clippingPlanes = renderer.clippingPlanes ?? null;
    gtao.updateGtaoMaterial({ radius: aoRadius, scale: 1.0, thickness: 0.5 });

    const overlayPass = this._aoOverlayPass as RenderPass;
    overlayPass.enabled = overlay !== null;
    if (overlay) {
      overlayPass.scene = overlay;
      overlayPass.camera = camera;
    }

    const isolatePass = this._aoIsolatePass as IsolateCompositePass;
    isolatePass.enabled = isolate !== null;
    if (isolate) {
      this._tintQuad(renderer, isolate.opacity); // refresh colour + opacity
      isolatePass.camera = camera;
      isolatePass.layerMask = isolate.focusMask;
    }

    return this._colorCapture.withPass(
      {
        width: W, height: H, layerMask: sceneMask, colorSpace: SRGBColorSpace,
        scene: this.host.scene, camera,
      },
      () => {
        composer.render();
        return this._colorCapture.readPixels(composer.readBuffer, W, H);
      },
    );
  }

  /** Free the private post chain (composer targets + GTAO buffers). */
  private _disposeAo(): void {
    this._aoComposer?.dispose();
    this._aoGtao?.dispose();
    this._aoComposer = null;
    this._aoScenePass = null;
    this._aoGtao = null;
    this._aoIsolatePass = null;
    this._aoOverlayPass = null;
    this._aoPerspective = null;
    this._aoW = 0;
    this._aoH = 0;
  }

  /** Render one pass and ISSUE its readback; the promise resolves to a fresh
   *  top-down buffer. The renderer state is already restored when it resolves. */
  private _renderPass(
    capture: OffscreenCapture,
    pass: OffscreenPass,
    scene: Scene,
    camera: Camera,
    renderer: WebGLRenderer,
  ): Promise<Uint8Array> {
    return capture.withPass(pass, (ctx) => {
      renderer.clear();
      renderer.render(scene, camera);
      return capture.readPixels(ctx.target, ctx.width, ctx.height);
    });
  }

  /**
   * A private flat-coloured scene mirroring the model's world transforms.
   *
   * Flat meshes rather than an override material on the live scene, because an
   * override cannot give each GROUP a different colour — which is the entire
   * content of an ID mask.
   */
  private async _buildIdmaskScene(
    root: Object3D, registry: IdmaskRegistry, grouping: IdmaskGrouping,
    legend: IdmaskLegendEntry[], focusOnly = false,
  ): Promise<{ scene: Scene; colors: Color[]; edges: Group } | { error: string }> {
    const resolved = await resolveIdmaskGroups(root, registry, grouping);
    if ('error' in resolved) return resolved;
    // Under an isolate only the focus set has an identity: the viewport's
    // raycast gate refuses a dimmed part, and a mask that labelled one would
    // hand the agent a mark on something it can neither see nor select. The
    // meshes are dropped here, BEFORE the empty-group filter below, so a group
    // left without a mesh takes no palette slot and no legend row.
    if (focusOnly) {
      for (const g of resolved.groups) {
        const keep = g.meshes.map((m) => m.layers.isEnabled(ISOLATE_FOCUS_LAYER));
        if (keep.every(Boolean)) continue;
        g.meshes = g.meshes.filter((_, i) => keep[i]);
        if (g.paths) {
          g.paths = g.paths.filter((_, i) => keep[i]);
          // The label names the first copy; keep it a copy that survived.
          if (g.paths.length > 0) g.path = g.paths[0];
        }
        if (g.count != null) g.count = g.meshes.length;
      }
    }
    this._disposeIdmaskScene();
    const scene = new Scene();
    scene.background = new Color(IDMASK_BACKGROUND);
    const colors: Color[] = [];
    // Crease edges live in their own group so the mask can be rendered BOTH
    // ways from one scene: once without them for the ground truth, once with
    // them for the picture (see renderChannels).
    const edges = new Group();
    edges.visible = false;
    edges.matrixAutoUpdate = false;
    scene.add(edges);
    const edgeMat = this._idmaskEdgeMat ??= new LineBasicMaterial({
      color: IDMASK_EDGE_COLOR,
      // DEPTH-TESTED, unlike the x-ray overlay: an edge here must only appear
      // where its own surface is the visible one. Lines drawn through
      // occluders would contradict the very mask they sit on — the colour
      // under the line would belong to the part in front, the line to the
      // part behind. depthWrite stays off; renderOrder is what keeps the
      // lines on top (see below), so they never need to occlude a fill.
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    });
    const addFlat = (mesh: Mesh, mat: MeshBasicMaterial): void => {
      const flat = new Mesh(mesh.geometry, mat);
      flat.matrixAutoUpdate = false;
      flat.matrix.copy(mesh.matrixWorld);
      scene.add(flat);
      // Two things have to be true for a line to survive to the frame, and
      // getting one of them wrong loses edges SILENTLY — the mask just comes
      // back flat, which is exactly what it is supposed to look like.
      //
      // 1. It must beat its OWN fill, which is exactly coincident with it.
      //    Polygon offset is the fix that belongs on the POLYGON: push the
      //    fill away from the camera by a hair and the line wins. It shifts
      //    depth only, never colour, so the ground-truth pass decodes the
      //    same pixels either way.
      // 2. It must beat every fill drawn AFTER it. Lines write no depth, so
      //    a farther surface rasterized later — a wall behind the part, which
      //    the front-to-back opaque sort puts last — passes the depth test at
      //    that pixel and paints straight over the line. renderOrder 1 is the
      //    answer the x-ray builder above already uses: every fill first,
      //    every line after. The depth TEST still hides a line whose surface
      //    is occluded, which is the property that matters here.
      const line = new LineSegments(cachedEdgesGeometry(mesh.geometry), edgeMat);
      line.matrixAutoUpdate = false;
      line.matrix.copy(mesh.matrixWorld);
      line.renderOrder = 1;
      edges.add(line);
    };
    // Drop mesh-less groups BEFORE anything else. `colors` is what the
    // rendered mask is decoded against (`paletteToIds` yields an index into
    // it) and `legend` is what the sidecar indexes with that very number, so
    // the two must stay element-for-element parallel. Pushing a colour for a
    // group but skipping its legend entry shifted every later group down by
    // one: an empty first child made all 28 following marks name their
    // NEIGHBOUR, and the last real group — the largest one — fell off the end
    // with no entry at all and vanished from `visible` without a word.
    // Filtering here also stops empty groups from eating palette slots.
    const drawable = resolved.groups.filter((g) => g.meshes.length > 0);
    const capped = drawable.slice(0, IDMASK_GROUP_CAP);
    const overflow = drawable.slice(IDMASK_GROUP_CAP);
    capped.forEach((g, i) => {
      const color = idmaskColor(i);
      const mat = new MeshBasicMaterial({ color, ...IDMASK_FILL_OFFSET });
      this._idmaskMats.push(mat);
      colors.push(color);
      for (const mesh of g.meshes) addFlat(mesh, mat);
      legend.push({
        color: `#${color.getHexString()}`,
        path: g.path,
        meshCount: g.meshes.length,
        ...(g.count != null && g.count > 1 ? { count: g.count } : {}),
        ...(g.components?.length ? { components: g.components } : {}),
        ...(g.paths && g.paths.length > 1
          ? { paths: g.paths.slice(0, 8), ...(g.paths.length > 8 ? { morePaths: g.paths.length - 8 } : {}) }
          : {}),
      });
    });
    if (overflow.length > 0) {
      const otherMat = new MeshBasicMaterial({ color: '#555555', ...IDMASK_FILL_OFFSET });
      this._idmaskMats.push(otherMat);
      colors.push(new Color('#555555'));
      let otherCount = 0;
      for (const g of overflow) {
        for (const mesh of g.meshes) addFlat(mesh, otherMat);
        otherCount += g.meshes.length;
      }
      // Unconditional, for the same reason as above: the colour is already in
      // the palette, so a skipped entry here would leave the last index
      // unresolvable. `drawable` guarantees otherCount > 0 anyway.
      legend.push({
        color: '#555555',
        path: `(other — ${overflow.length} smaller groups)`,
        meshCount: otherCount,
      });
    }
    this._idmaskScene = scene;
    return { scene, colors, edges };
  }

  private _disposeIdmaskScene(): void {
    for (const m of this._idmaskMats) m.dispose();
    this._idmaskMats = [];
    // _idmaskEdgeMat is NOT disposed here — it is one shared material reused
    // across renders, like the x-ray pair, and only dispose() owns it. The
    // edge geometries belong to the app-wide cache and are never ours.
    // The geometries are the LIVE model's — shared by reference, never ours to
    // dispose. Only the wrapper meshes and materials belong to this scene.
    this._idmaskScene?.clear();
    this._idmaskScene = null;
  }
}

// ─── Pure helpers ───────────────────────────────────────────────────────

/**
 * Output pixel size for a VERTICAL resolution and an aspect (width / height).
 *
 * `size` is the HEIGHT, not the long edge (changed 2026-09-14). The long-edge
 * reading made the guaranteed resolution depend on the lens: at the default 4:3
 * a "1024" capture was 1024x768, so the floor that is supposed to guarantee a
 * readable frame delivered 768 lines. Height is the dimension the floor is
 * about, so height is what the number names — 1024 at 4:3 is 1365x1024, at 1:1
 * it is 1024x1024, and a portrait lens gets 1024 lines too instead of fewer.
 */
export function frameSize(size: number, aspect: number): { width: number; height: number } {
  const height = Math.max(1, Math.round(size));
  return { width: Math.max(1, Math.round(height * aspect)), height };
}

/** Requested channels, duplicates removed, order preserved. */
export function dedupeChannels(channels: readonly EyeChannel[]): EyeChannel[] {
  const seen = new Set<EyeChannel>();
  const out: EyeChannel[] = [];
  for (const c of channels) {
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

/**
 * Map flat idmask pixels back to group indices.
 *
 * Nearest palette entry rather than an exact match: the target is sRGB and the
 * readback rounds, so an exact comparison would drop pixels at random. The
 * accept radius is small compared to the golden-angle spacing between palette
 * entries, so a near miss is still unambiguous, and anything further away is
 * background.
 */
export function paletteToIds(pixels: Uint8Array, colors: readonly Color[]): Uint16Array {
  const n = pixels.length / 4;
  const out = new Uint16Array(n);
  // sRGB bytes, NOT `c.r*255`: a three `Color` holds its channels in the
  // LINEAR working space, while the readback of an sRGB render target is
  // gamma-encoded. Comparing the two matches nothing at all — every pixel
  // reads as background and the ID mask silently comes back empty.
  // `getHexString()` is defined to answer in sRGB, which is the space the
  // legend quotes too, so palette, legend and pixels all agree.
  const pal = colors.map((c) => {
    const hex = parseInt(c.getHexString(), 16);
    return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255] as const;
  });
  const cache = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r = pixels[o], g = pixels[o + 1], b = pixels[o + 2];
    const key = (r << 16) | (g << 8) | b;
    const hit = cache.get(key);
    if (hit !== undefined) { out[i] = hit; continue; }
    let best = IDMASK_NO_GROUP;
    let bestD = 24 * 24 * 3; // accept radius²; palette spacing is far wider
    for (let p = 0; p < pal.length; p++) {
      const dr = r - pal[p][0], dg = g - pal[p][1], db = b - pal[p][2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; best = p; }
    }
    cache.set(key, best);
    out[i] = best;
  }
  return out;
}

/** Force alpha to 255 — the xray overlay writes its own alpha, not coverage. */
function opaque(px: Uint8Array): Uint8Array {
  const out = new Uint8Array(px.length);
  out.set(px);
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  return out;
}

/** Top-down RGBA bytes → a canvas of that size. */
export function pixelsToCanvas(px: Uint8Array, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  img.data.set(px.subarray(0, w * h * 4));
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function cameraInfo(pose: AgentPose, cam: PerspectiveCamera | OrthographicCamera): EyeCameraInfo {
  const r3 = (n: number): number => +n.toFixed(3);
  const dist = Math.hypot(pose.px - pose.tx, pose.py - pose.ty, pose.pz - pose.tz);
  return {
    position: [r3(pose.px), r3(pose.py), r3(pose.pz)],
    target: [r3(pose.tx), r3(pose.ty), r3(pose.tz)],
    fov: pose.fov,
    aspect: +pose.aspect.toFixed(4),
    projection: pose.projection,
    near: r3(cam.near),
    far: r3(cam.far),
    ...(pose.projection === 'orthographic'
      ? { orthoHalfHeight: r3(dist * Math.tan((pose.fov * Math.PI) / 360)) }
      : {}),
  };
}

/**
 * Crop every channel to a world box's on-screen rect (+8 %), keeping the
 * per-pixel buffers in step with the images.
 *
 * A crop that lands off-screen or behind the camera falls back to the full
 * frame — the same defensive choice `captureFrameCanvas` makes, because a
 * zero-pixel image is a worse answer than a wide one.
 */
function cropResult(
  result: EyeRenderResult, box: Box3, camera: Camera, W: number, H: number,
): EyeRenderResult {
  if (box.isEmpty()) return result;
  const { min, max } = box;
  const v = new Vector3();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < 8; i++) {
    v.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z).project(camera);
    const px = (v.x * 0.5 + 0.5) * W;
    const py = (1 - (v.y * 0.5 + 0.5)) * H;
    minX = Math.min(minX, px); maxX = Math.max(maxX, px);
    minY = Math.min(minY, py); maxY = Math.max(maxY, py);
  }
  const pad = 0.08 * Math.max(maxX - minX, maxY - minY);
  const left = Math.max(0, Math.round(minX - pad));
  const top = Math.max(0, Math.round(minY - pad));
  const right = Math.min(W, Math.round(maxX + pad));
  const bottom = Math.min(H, Math.round(maxY + pad));
  const cw = right - left, chh = bottom - top;
  if (cw < 8 || chh < 8) return result;

  const channels = result.channels.map((c) => {
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = chh;
    canvas.getContext('2d')!.drawImage(c.canvas, left, top, cw, chh, 0, 0, cw, chh);
    const out: EyeChannelResult = { channel: c.channel, canvas, mime: c.mime };
    if (c.idBuffer) out.idBuffer = cropTyped(c.idBuffer, W, left, top, cw, chh, Uint16Array);
    return out;
  });
  return {
    ...result, width: cw, height: chh, channels,
    crop: { x: +(left / W).toFixed(4), y: +(top / H).toFixed(4), w: +(cw / W).toFixed(4), h: +(chh / H).toFixed(4) },
  };
}

function cropTyped<T extends Uint16Array>(
  src: T, srcW: number, left: number, top: number, w: number, h: number,
  Ctor: { new(n: number): T },
): T {
  const out = new Ctor(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out[y * w + x] = src[(top + y) * srcW + (left + x)];
  }
  return out;
}
