// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-object-analyzer.ts — offscreen multi-view mosaic renderer for the
 * `web_screenshot_analyze` MCP tool.
 *
 * Renders the target from 4 perspective views as a 2×2 mosaic:
 * two CONTEXT tiles (live main scene — "far" frames the whole scene, "near"
 * frames the target with its surroundings) and two ISOLATED ¾ tiles
 * (front-top and back-bottom, only the cloned target subtree on a neutral
 * background, lit like the main scene — ThumbnailRenderer pattern).
 *
 * On context tiles the target is marked with a screen-space highlight
 * (Instrument Blue fill + edge outline) built from two mask passes over a
 * private render target: a VISIBLE mask (clones drawn against the live
 * scene's depth buffer — pixels where the target actually shows) and a FULL
 * silhouette mask (clones alone). Occluded parts get a dimmed "X-ray" fill
 * and edge, so buried objects stay locatable. No geometry-based edge
 * extraction (EdgesGeometry) and no interaction with the interactive
 * highlight manager — this is deliberately self-contained.
 *
 * All renders go to private WebGLRenderTargets with private cameras in ONE
 * synchronous pass, so the user's camera, controls, and scene state are
 * never touched and every tile shows the same simulation instant.
 *
 * Contracts honored (doc-render-picking.md §1.6): no live-scene mutation at
 * all — no `setVisibleAt`, no re-layering of batched sources, no visibility
 * writes (hence no `markShadowsDirty` needed). Isolation happens exclusively
 * in a private scene built from clones; `overrideMaterial` is only ever set
 * on that private scene. Clones SHARE geometry/materials with the live
 * scene, so they are only ever `remove()`d — never disposed. Renderer state
 * (target, clear alpha, autoClear) is saved and restored around the pass.
 */

import {
  AmbientLight,
  Box3,
  DirectionalLight,
  Group,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderTarget,
} from 'three';
import type { Camera, Mesh, Object3D, WebGLRenderer } from 'three';
import { disableOverlayLayers } from '../../core/engine/rv-group-registry';
import type { RVViewer } from '../../core/rv-viewer';
import {
  formatBoundsLabel,
  MARGIN_ISOLATED,
  MARGIN_NEAR,
  MIN_EXTENT_M,
  mosaicLayout,
  VIEW_DEFS,
  type MosaicCell,
  type Vec3Like,
  type ViewDef,
} from './rv-object-analyzer-math';

const FOV_DEG = 35;

/** Instrument Blue — the target highlight color on context tiles (DESIGN.md). */
const MARKER_COLOR = '#4fc3f7';
const MARKER_R = 79;
const MARKER_G = 195;
const MARKER_B = 247;

/** Highlight alphas (0..255): fill/edge, visible vs occluded ("X-ray"). */
const FILL_ALPHA_VISIBLE = 78;
const FILL_ALPHA_OCCLUDED = 38;
const EDGE_ALPHA_VISIBLE = 255;
const EDGE_ALPHA_OCCLUDED = 115;

/** Neutral mid-grey backdrop for isolated tiles — reads for dark AND light parts. */
const ISOLATED_BACKDROP = '#62686e';
const CONTEXT_BACKDROP = '#202020';

export interface AnalyzeOptions {
  includeChildren: boolean;
  tileSize: number;
  /** Header line 1 content (the resolved node paths, ellipsized when long). */
  pathsLabel: string;
}

export interface AnalyzeResult {
  canvas: HTMLCanvasElement;
  boundsM: Vec3Like;
  center: Vec3Like;
}

export class ObjectAnalyzer {
  private _viewer: RVViewer;
  /** Private render targets keyed by pixel size. */
  private _targets = new Map<number, WebGLRenderTarget>();
  /** Scratch canvas for ImageData → mosaic compositing (alpha-aware). */
  private _scratch: HTMLCanvasElement | null = null;
  /** Private isolated scene + light mirrors (ThumbnailRenderer pattern). */
  private _isoScene: Scene;
  private _ambient: AmbientLight;
  private _dir: DirectionalLight;
  /** Flat unlit mask material for the highlight passes. Pure magenta is the
   *  mask key in the readback; polygonOffset pulls the clones marginally
   *  towards the camera so they win the depth tie against their own batched
   *  twins in the live render. */
  private _maskMat = new MeshBasicMaterial({
    color: 0xff00ff,
    toneMapped: false,
    fog: false,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });

  // Pre-allocated temps (no GC in the render pass).
  private _tmpVec = new Vector3();
  private _corner = new Vector3();

  constructor(viewer: RVViewer) {
    this._viewer = viewer;
    this._isoScene = new Scene();
    this._isoScene.background = null;
    this._ambient = new AmbientLight(0xffffff, 0);
    this._dir = new DirectionalLight(0xffffff, 0);
    this._isoScene.add(this._ambient);
    this._isoScene.add(this._dir);
  }

  /**
   * Render the analysis mosaic for `nodes`. Fully synchronous — all renders,
   * readbacks, compositing and labeling happen in one call with no awaits.
   */
  analyze(nodes: Object3D[], opts: AnalyzeOptions): AnalyzeResult | { error: string } {
    // Caller guards `viewer.isWebGPU` — on the classic backend the renderer IS
    // a WebGLRenderer (readRenderTargetPixels etc.), the facade just types it
    // as the backend-neutral `Renderer`.
    const renderer = this._viewer.renderer as unknown as WebGLRenderer | null;
    const mainScene = this._viewer.scene;
    if (!renderer || !mainScene) return { error: 'Renderer not ready' };

    const targets = dedupeNested(nodes);
    const wrapper = this._buildIsolatedGroup(targets, opts.includeChildren);
    this._isoScene.add(wrapper);

    try {
      // Bounds from the isolated clones (world transforms are baked into the
      // wrapper), so context highlight + isolated framing use the SAME
      // filtered mesh set — includeChildren applies to both uniformly.
      wrapper.updateMatrixWorld(true);
      const targetBox = meshBounds(wrapper);
      if (targetBox.isEmpty()) return { error: 'No renderable mesh bounds for the given path(s)' };

      const center = targetBox.getCenter(new Vector3());
      const size = targetBox.getSize(new Vector3());
      const sceneBox = new Box3().setFromObject(mainScene);
      // Frame the "far" view on model content only — ground plane, sky and
      // helper geometry inflate the raw scene box and would shrink the model
      // to a speck. Model roots are tagged by the viewer on load.
      const contentBox = contentBounds(mainScene, sceneBox);

      this._syncLighting(mainScene);

      const layout = mosaicLayout(opts.tileSize);
      const mosaic = document.createElement('canvas');
      mosaic.width = layout.width;
      mosaic.height = layout.height;
      const ctx = mosaic.getContext('2d');
      if (!ctx) return { error: 'No 2D context' };

      ctx.fillStyle = CONTEXT_BACKDROP;
      ctx.fillRect(0, 0, layout.width, layout.height);
      this._drawHeader(ctx, layout.width, opts.pathsLabel, size, center, targets.length);

      const prevTarget = renderer.getRenderTarget();
      const prevClearAlpha = renderer.getClearAlpha();
      const prevAutoClear = renderer.autoClear;
      try {
        for (const cell of layout.cells) {
          let view = VIEW_DEFS.find((v) => v.name === cell.view)!;
          if (view.framing === 'near') {
            // The fixed ¾ angle can look straight into an occluder — probe
            // the four diagonal angles and take the one showing the target.
            view = { ...view, dir: this._pickNearDir(renderer, mainScene, view, center, size, sceneBox, contentBox) };
          }
          const camera = this._makeCamera(view, center, size, sceneBox, contentBox);
          if (cell.kind === 'isolated') {
            this._renderIsolatedCell(renderer, camera, cell, ctx);
          } else {
            this._renderContextCell(renderer, mainScene, camera, cell, ctx, center);
          }
          this._drawCellChrome(ctx, cell);
        }
      } finally {
        this._isoScene.overrideMaterial = null;
        renderer.autoClear = prevAutoClear;
        renderer.setClearAlpha(prevClearAlpha);
        renderer.setRenderTarget(prevTarget);
      }

      return {
        canvas: mosaic,
        boundsM: { x: size.x, y: size.y, z: size.z },
        center: { x: center.x, y: center.y, z: center.z },
      };
    } finally {
      // Clones share geometry/materials with the live scene — remove only,
      // NEVER disposeSubtree (it would destroy live GPU resources).
      this._isoScene.remove(wrapper);
    }
  }

  dispose(): void {
    for (const rt of this._targets.values()) rt.dispose();
    this._targets.clear();
    this._maskMat.dispose();
    this._isoScene.environment = null; // shared IBL — never owned
    this._scratch = null;
  }

  // ── Isolated scene ──

  /**
   * Clone each target under a wrapper Group with the source's world matrix
   * baked in (multiple targets keep their relative arrangement). Cloned
   * BatchedMesh arenas are dropped; all layers are normalized to 0, which
   * revives the mask-0 batched source meshes for individual rendering.
   */
  private _buildIsolatedGroup(targets: Object3D[], includeChildren: boolean): Group {
    const wrapper = new Group();
    for (const node of targets) {
      node.updateWorldMatrix(true, false);
      const clone = node.clone(true);
      clone.matrix.copy(node.matrixWorld);
      clone.matrix.decompose(clone.position, clone.quaternion, clone.scale);
      clone.visible = true;

      if (!includeChildren) {
        // Keep only the node itself + its DIRECT child meshes (depth ≤ 1).
        for (const child of [...clone.children]) {
          if ((child as Mesh).isMesh) child.clear();
          else clone.remove(child);
        }
      }

      // Drop cloned BatchedMesh arenas, normalize layers on the rest.
      const arenas: Object3D[] = [];
      clone.traverse((o) => {
        if (o.userData?._rvBatchedRender) arenas.push(o);
        else o.layers.set(0);
      });
      for (const arena of arenas) arena.removeFromParent();

      wrapper.add(clone);
    }
    return wrapper;
  }

  /** Mirror the main scene's IBL + ambient/directional lights (ThumbnailRenderer). */
  private _syncLighting(mainScene: Scene): void {
    this._isoScene.environment = mainScene.environment;
    this._isoScene.environmentIntensity = mainScene.environmentIntensity;

    let srcAmbient: AmbientLight | null = null;
    let srcDir: DirectionalLight | null = null;
    mainScene.traverse((o) => {
      if (!srcAmbient && (o as AmbientLight).isAmbientLight) srcAmbient = o as AmbientLight;
      if (!srcDir && (o as DirectionalLight).isDirectionalLight) srcDir = o as DirectionalLight;
    });
    if (srcAmbient) {
      this._ambient.color.copy((srcAmbient as AmbientLight).color);
      this._ambient.intensity = (srcAmbient as AmbientLight).intensity;
    } else this._ambient.intensity = 0;
    if (srcDir) {
      this._dir.color.copy((srcDir as DirectionalLight).color);
      this._dir.intensity = (srcDir as DirectionalLight).intensity;
      this._dir.position.copy((srcDir as DirectionalLight).position);
    } else this._dir.intensity = 0;
  }

  // ── Cameras ──

  /**
   * Per-view private perspective camera. Framing decides the standoff:
   * 'tight' → target fills the frame; 'near' → target ≈ 1/3 of the frame;
   * 'scene' → whole model content in frame (still looking at the target).
   */
  private _makeCamera(
    view: ViewDef,
    center: Vector3,
    size: Vector3,
    sceneBox: Box3,
    contentBox: Box3,
  ): Camera {
    const maxDim = Math.max(size.x, size.y, size.z, MIN_EXTENT_M);
    const dir = this._tmpVec.set(view.dir[0], view.dir[1], view.dir[2]);
    const halfRad = (FOV_DEG / 2) * (Math.PI / 180);

    // The far view aims at the CONTENT center and frames the whole model —
    // the highlight + crosshair mark the target inside it. Near/tight views
    // aim at the target itself.
    const aim = view.framing === 'scene' ? contentBox.getCenter(new Vector3()) : center;

    let standoff: number;
    if (view.framing === 'scene') {
      // Cover the content box's bounding sphere around the aim point.
      let cover = 0;
      for (let i = 0; i < 8; i++) {
        const cx = (i & 1 ? contentBox.max : contentBox.min).x - aim.x;
        const cy = (i & 2 ? contentBox.max : contentBox.min).y - aim.y;
        const cz = (i & 4 ? contentBox.max : contentBox.min).z - aim.z;
        cover = Math.max(cover, Math.hypot(cx, cy, cz));
      }
      standoff = (Math.max(cover, maxDim / 2) / Math.sin(halfRad)) * 1.02;
    } else {
      // Bounding-SPHERE radius (half diagonal) — maxDim/2 crops elongated
      // objects seen from a ¾ angle.
      const radius = Math.max(Math.hypot(size.x, size.y, size.z) / 2, MIN_EXTENT_M);
      const margin = view.framing === 'near' ? MARGIN_NEAR : MARGIN_ISOLATED;
      standoff = (radius / Math.sin(halfRad)) * margin;
    }
    standoff = Math.max(standoff, MIN_EXTENT_M);

    const near = Math.max(MIN_EXTENT_M, standoff * 0.005);
    const far =
      view.kind === 'context'
        ? this._farAcrossBox(aim, dir, standoff, sceneBox)
        : standoff + maxDim * 3;
    const camera = new PerspectiveCamera(FOV_DEG, 1, near, far);

    camera.position.set(
      aim.x + dir.x * standoff,
      aim.y + dir.y * standoff,
      aim.z + dir.z * standoff,
    );
    camera.up.set(view.up[0], view.up[1], view.up[2]);
    camera.lookAt(aim);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);

    if (view.kind === 'context') {
      camera.layers.enableAll();
      disableOverlayLayers(camera);
    }
    return camera;
  }

  /** Far-plane distance covering `box` as seen from the camera position. */
  private _farAcrossBox(center: Vector3, dir: Vector3, standoff: number, box: Box3): number {
    // Camera at center + dir·standoff looking along -dir; the farthest scene
    // corner along the view direction sets the far plane.
    const camX = center.x + dir.x * standoff;
    const camY = center.y + dir.y * standoff;
    const camZ = center.z + dir.z * standoff;
    let far = 0;
    for (let i = 0; i < 8; i++) {
      const cx = (i & 1 ? box.max : box.min).x - camX;
      const cy = (i & 2 ? box.max : box.min).y - camY;
      const cz = (i & 4 ? box.max : box.min).z - camZ;
      far = Math.max(far, -(cx * dir.x + cy * dir.y + cz * dir.z));
    }
    return Math.max(far + MIN_EXTENT_M, standoff + MIN_EXTENT_M);
  }

  // ── Tile rendering & compositing ──

  private _target(size: number): WebGLRenderTarget {
    let rt = this._targets.get(size);
    if (!rt) {
      rt = new WebGLRenderTarget(size, size);
      rt.texture.colorSpace = SRGBColorSpace;
      this._targets.set(size, rt);
    }
    return rt;
  }

  /** Read the RT back as a top-down RGBA byte array (WebGL rows are bottom-up). */
  private _readPixels(renderer: WebGLRenderer, rt: WebGLRenderTarget, size: number): Uint8Array {
    const px = new Uint8Array(size * size * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, size, size, px);
    const rowBytes = size * 4;
    const tmp = new Uint8Array(rowBytes);
    for (let y = 0; y < size >> 1; y++) {
      const a = y * rowBytes;
      const b = (size - 1 - y) * rowBytes;
      tmp.set(px.subarray(a, a + rowBytes));
      px.copyWithin(a, b, b + rowBytes);
      px.set(tmp, b);
    }
    return px;
  }

  /** Composite top-down RGBA pixels into the mosaic over a backdrop color. */
  private _blit(
    ctx: CanvasRenderingContext2D,
    cell: MosaicCell,
    pixels: Uint8Array,
    backdrop: string,
  ): void {
    const size = cell.size;
    const sctx = this._scratchCtx(size);
    const imageData = sctx.createImageData(size, size);
    imageData.data.set(pixels);
    sctx.putImageData(imageData, 0, 0);

    // Backdrop first, then alpha-composite (putImageData directly would drop
    // the backdrop and JPEG-encode transparent pixels as black).
    ctx.fillStyle = backdrop;
    ctx.fillRect(cell.x, cell.y, size, size);
    ctx.drawImage(this._scratch!, cell.x, cell.y);
  }

  private _scratchCtx(size: number): CanvasRenderingContext2D {
    if (!this._scratch) this._scratch = document.createElement('canvas');
    this._scratch.width = size;
    this._scratch.height = size;
    return this._scratch.getContext('2d')!;
  }

  /** Isolated tile: private clone scene, neutral mid-grey backdrop. */
  private _renderIsolatedCell(
    renderer: WebGLRenderer,
    camera: Camera,
    cell: MosaicCell,
    ctx: CanvasRenderingContext2D,
  ): void {
    const rt = this._target(cell.size);
    this._isoScene.overrideMaterial = null;
    renderer.autoClear = true;
    renderer.setRenderTarget(rt);
    renderer.setClearAlpha(0);
    renderer.clear();
    renderer.render(this._isoScene, camera);
    this._blit(ctx, cell, this._readPixels(renderer, rt, cell.size), ISOLATED_BACKDROP);
  }

  /**
   * The three highlight draws into one RT: (1) the live scene (color +
   * depth), (2) the clone wrapper flat-magenta WITHOUT clearing —
   * depth-tested against the live depth buffer, so only the VISIBLE part of
   * the target survives, (3) after a clear, the wrapper alone — the FULL
   * silhouette.
   */
  private _maskPasses(
    renderer: WebGLRenderer,
    mainScene: Scene,
    camera: Camera,
    size: number,
  ): { color: Uint8Array; visPix: Uint8Array; allPix: Uint8Array } {
    const rt = this._target(size);
    renderer.setRenderTarget(rt);
    renderer.setClearAlpha(0);

    renderer.autoClear = true;
    renderer.clear();
    renderer.render(mainScene, camera);
    const color = this._readPixels(renderer, rt, size);

    this._isoScene.overrideMaterial = this._maskMat;
    renderer.autoClear = false;
    renderer.render(this._isoScene, camera);
    const visPix = this._readPixels(renderer, rt, size);

    renderer.clear();
    renderer.render(this._isoScene, camera);
    const allPix = this._readPixels(renderer, rt, size);
    this._isoScene.overrideMaterial = null;
    renderer.autoClear = true;

    return { color, visPix, allPix };
  }

  /** Probe the four diagonal ¾ angles at low resolution and pick the one
   *  where the target is most visible. The default (front-right) wins ties
   *  so results stay stable across calls. */
  private _pickNearDir(
    renderer: WebGLRenderer,
    mainScene: Scene,
    baseView: ViewDef,
    center: Vector3,
    size: Vector3,
    sceneBox: Box3,
    contentBox: Box3,
  ): readonly [number, number, number] {
    const PROBE = 128;
    const candidates = NEAR_CANDIDATES;
    const scores: number[] = [];
    for (const cand of candidates) {
      const cam = this._makeCamera({ ...baseView, dir: cand }, center, size, sceneBox, contentBox);
      const { visPix, allPix } = this._maskPasses(renderer, mainScene, cam, PROBE);
      let vis = 0;
      let all = 0;
      for (let i = 0; i < PROBE * PROBE; i++) {
        const o = i * 4;
        if (allPix[o + 3] >= 128) all++;
        if (visPix[o] >= 250 && visPix[o + 1] <= 5 && visPix[o + 2] >= 250 && visPix[o + 3] >= 128) vis++;
      }
      scores.push(all > 0 ? vis / all : 0);
    }
    let best = 0;
    for (let i = 1; i < scores.length; i++) {
      if (scores[i] > scores[best] + 0.03) best = i;
    }
    return candidates[best];
  }

  /** Context tile: live-scene render plus the screen-space target highlight. */
  private _renderContextCell(
    renderer: WebGLRenderer,
    mainScene: Scene,
    camera: Camera,
    cell: MosaicCell,
    ctx: CanvasRenderingContext2D,
    targetCenter: Vector3,
  ): void {
    const { color, visPix, allPix } = this._maskPasses(renderer, mainScene, camera, cell.size);
    this._blit(ctx, cell, color, CONTEXT_BACKDROP);
    const silhouettePx = this._compositeHighlight(ctx, cell, visPix, allPix);
    // A near-invisible highlight (tiny or fully buried target) gets a ring
    // so the location still jumps out.
    const tiny = silhouettePx < cell.size * cell.size * 0.003;
    this._drawCenterMarker(ctx, camera, targetCenter, cell, tiny);
  }

  /** Build the fill+edge highlight overlay from the two mask readbacks.
   *  Returns the silhouette pixel count. */
  private _compositeHighlight(
    ctx: CanvasRenderingContext2D,
    cell: MosaicCell,
    visPix: Uint8Array,
    allPix: Uint8Array,
  ): number {
    const size = cell.size;
    const n = size * size;
    // Silhouette = any coverage in the clone-only pass; visible = the exact
    // magenta mask key survived the live depth test.
    const all = new Uint8Array(n);
    const vis = new Uint8Array(n);
    let silhouettePx = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (allPix[o + 3] >= 128) {
        all[i] = 1;
        silhouettePx++;
      }
      if (visPix[o] >= 250 && visPix[o + 1] <= 5 && visPix[o + 2] >= 250 && visPix[o + 3] >= 128) {
        vis[i] = 1;
      }
    }

    const sctx = this._scratchCtx(size);
    const overlay = sctx.createImageData(size, size);
    const data = overlay.data;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const inMask = all[i] === 1;
        // 2px edge: inner boundary pixels of the mask plus their outer
        // neighbors — crisp at any mesh density (no geometry edges).
        const l = x > 0 ? all[i - 1] : 0;
        const r = x < size - 1 ? all[i + 1] : 0;
        const u = y > 0 ? all[i - size] : 0;
        const d = y < size - 1 ? all[i + size] : 0;
        const boundary = inMask ? l + r + u + d < 4 : l + r + u + d > 0;

        let alpha = 0;
        let visible = vis[i] === 1;
        if (boundary) {
          if (!inMask) {
            // Outer edge pixel — take visibility from the adjacent mask pixel.
            visible =
              (x > 0 && vis[i - 1] === 1) ||
              (x < size - 1 && vis[i + 1] === 1) ||
              (y > 0 && vis[i - size] === 1) ||
              (y < size - 1 && vis[i + size] === 1);
          }
          alpha = visible ? EDGE_ALPHA_VISIBLE : EDGE_ALPHA_OCCLUDED;
        } else if (inMask) {
          alpha = visible ? FILL_ALPHA_VISIBLE : FILL_ALPHA_OCCLUDED;
        }
        if (alpha > 0) {
          const o = i * 4;
          data[o] = MARKER_R;
          data[o + 1] = MARKER_G;
          data[o + 2] = MARKER_B;
          data[o + 3] = alpha;
        }
      }
    }
    sctx.putImageData(overlay, 0, 0);
    ctx.drawImage(this._scratch!, cell.x, cell.y);
    return silhouettePx;
  }

  /** Small crosshair at the projected target center (context tiles); adds a
   *  ring when the highlight itself is too small to spot. */
  private _drawCenterMarker(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    center: Vector3,
    cell: MosaicCell,
    ring: boolean,
  ): void {
    this._corner.copy(center).project(camera); // world → NDC
    if (this._corner.z > 1) return; // behind the camera
    const cx = cell.x + (this._corner.x * 0.5 + 0.5) * cell.size;
    const cy = cell.y + (1 - (this._corner.y * 0.5 + 0.5)) * cell.size;
    if (cx < cell.x || cx > cell.x + cell.size || cy < cell.y || cy > cell.y + cell.size) return;

    const r = 6;
    ctx.strokeStyle = MARKER_COLOR;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
    ctx.stroke();
    if (ring) {
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 18, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /** Tile border + label (burst-montage style backing rect). */
  private _drawCellChrome(ctx: CanvasRenderingContext2D, cell: MosaicCell): void {
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 1;
    ctx.strokeRect(cell.x + 0.5, cell.y + 0.5, cell.size - 1, cell.size - 1);

    ctx.font = '600 14px system-ui, sans-serif';
    const tw = ctx.measureText(cell.label).width;
    const lx = cell.x + 4, ly = cell.y + cell.size - 24;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(lx, ly, tw + 10, 20);
    ctx.fillStyle = '#fff';
    ctx.fillText(cell.label, lx + 5, ly + 15);
  }

  private _drawHeader(
    ctx: CanvasRenderingContext2D,
    width: number,
    pathsLabel: string,
    size: Vec3Like,
    center: Vec3Like,
    count: number,
  ): void {
    ctx.fillStyle = '#fff';
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.fillText(ellipsize(ctx, `web_screenshot_analyze — ${pathsLabel}`, width - 16), 8, 18);
    ctx.fillStyle = '#9adcff';
    ctx.font = '13px ui-monospace, monospace';
    ctx.fillText(ellipsize(ctx, formatBoundsLabel(size, center, count), width - 16), 8, 38);
  }
}

// ── Module helpers ──

const normDir = (v: readonly [number, number, number]): readonly [number, number, number] => {
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len] as const;
};

/** Candidate ¾ angles for the near context view — front/back × right/left,
 *  all from above. Order = preference on ties (front-right first, matching
 *  the default isolated view). */
const NEAR_CANDIDATES: readonly (readonly [number, number, number])[] = [
  normDir([1, 0.7, 1]),
  normDir([-1, 0.7, 1]),
  normDir([1, 0.7, -1]),
  normDir([-1, 0.7, -1]),
];

/** Union of world-space mesh bounds over a subtree (mirrors computeNodeBounds). */
function meshBounds(root: Object3D): Box3 {
  const box = new Box3();
  const mb = new Box3();
  root.traverse((child) => {
    const m = child as Mesh;
    if (m.isMesh && m.geometry) {
      m.geometry.computeBoundingBox();
      if (m.geometry.boundingBox) {
        mb.copy(m.geometry.boundingBox);
        mb.applyMatrix4(m.matrixWorld);
        box.union(mb);
      }
    }
  });
  return box;
}

/** Union of the `_rvModelRoot`-tagged roots' bounds (loaded model + planner-
 *  placed assets). Falls back to `sceneBox` when nothing is tagged. */
function contentBounds(mainScene: Scene, sceneBox: Box3): Box3 {
  const box = new Box3();
  const tmp = new Box3();
  for (const child of mainScene.children) {
    if (child.userData?._rvModelRoot) {
      tmp.setFromObject(child);
      if (!tmp.isEmpty()) box.union(tmp);
    }
  }
  return box.isEmpty() ? sceneBox : box;
}

/** Drop nodes that are descendants of another node in the set. */
function dedupeNested(nodes: Object3D[]): Object3D[] {
  const set = new Set(nodes);
  return nodes.filter((node) => {
    for (let p = node.parent; p; p = p.parent) {
      if (set.has(p)) return false;
    }
    return true;
  });
}

/** Trim a string with a trailing ellipsis so it fits `maxWidth` pixels. */
function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) {
    t = t.slice(0, -1);
  }
  return `${t}…`;
}
