// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * GaussianSplatPlugin — Load and render 3D Gaussian Splatting files
 * (.splat, .ply, .ksplat) AND Point Cloud files (.ply, .pcd) in the
 * realvirtual WebViewer.
 *
 * Gaussian Splat mode: Uses @mkkellogg/gaussian-splats-3d with selfDrivenMode: false
 * so the library does NOT run its own requestAnimationFrame loop.
 *
 * Point Cloud mode: Uses Three.js built-in PLYLoader / PCDLoader to render
 * standard point clouds as THREE.Points with PointsMaterial.
 *
 * Auto-detection by file extension:
 * - .splat, .ksplat → Gaussian Splat
 * - .pcd → Point Cloud
 * - .ply → Gaussian Splat (override with mode: 'pointcloud' in config)
 *
 * Multi-instance API: Each splat placement gets its own GS3D.Viewer instance
 * and container Group. The planner calls loadSplat()/disposeSplat().
 *
 * Registration: viewer.registerLazy('gaussian-splat', ...)
 */

import { MathUtils, Group, Points, PointsMaterial, BufferGeometry, Color, Vector3, Quaternion, Matrix4, Ray, Sphere, Box3 } from 'three';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import { getAppConfig } from '../core/rv-app-config';
import { RVAssetBlobCache } from '../core/engine/rv-asset-blob-cache';
import type { SplatRaycastHit } from './layout-planner/gaussian-splat-plugin-type';

/**
 * Shared blob cache for Gaussian Splats / Point Clouds.
 *
 * In-memory + Cache API ⇒ network fetch happens once per URL per origin.
 * The expensive parse + GPU upload still runs per `addSplatScene` call —
 * the splat library doesn't expose a re-usable parsed mesh.
 */
const SPLAT_CACHE_BUCKET = 'rv-planner-splats';
const _splatBlobCache = new RVAssetBlobCache({ bucket: SPLAT_CACHE_BUCKET });

/**
 * Direct DOM loading overlay (bypasses React entirely).
 *
 * The React-based info-overlay-store relies on a commit + paint cycle that
 * never happens during splat loads — the GS3D library starts blocking the
 * main thread before any rAF callback fires. A plain `document.body.append`
 * shows up immediately on the next browser paint regardless of React state.
 */
let _domOverlay: HTMLDivElement | null = null;
let _domOverlayDepth = 0;
function showDomOverlay(message: string): void {
  _domOverlayDepth++;
  if (_domOverlay) {
    const label = _domOverlay.querySelector('.rv-splat-overlay-label');
    if (label) label.textContent = message;
    return;
  }
  const el = document.createElement('div');
  el.className = 'rv-splat-overlay';
  el.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:10001',
    'display:flex', 'align-items:center', 'justify-content:center',
    'background:rgba(0,0,0,0.45)', 'pointer-events:none',
    'font:500 14px system-ui,sans-serif',
  ].join(';');
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:14px;padding:14px 22px;
                background:rgba(20,20,20,0.9);color:#fff;border-radius:8px;
                box-shadow:0 8px 24px rgba(0,0,0,0.6);
                border:1px solid rgba(255,255,255,0.08);backdrop-filter:blur(calc(12px * var(--rv-ui-blur-scale, 1)));">
      <div style="width:22px;height:22px;border:3px solid rgba(255,255,255,0.2);
                  border-top-color:#fff;border-radius:50%;
                  animation:rv-splat-spin 0.8s linear infinite;"></div>
      <span class="rv-splat-overlay-label">${message}</span>
    </div>
    <style>@keyframes rv-splat-spin{to{transform:rotate(360deg)}}</style>
  `;
  document.body.appendChild(el);
  _domOverlay = el;
}
function hideDomOverlay(): void {
  _domOverlayDepth = Math.max(0, _domOverlayDepth - 1);
  if (_domOverlayDepth > 0) return;
  if (_domOverlay) {
    _domOverlay.remove();
    _domOverlay = null;
  }
}

// ── Config interface ──

export type SplatMode = 'auto' | 'splat' | 'pointcloud';

export interface GaussianSplatConfig {
  enabled?: boolean;
  url?: string;
  mode?: SplatMode;               // 'auto' detects by extension, 'splat' forces gaussian, 'pointcloud' forces points
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: number;
  opacity?: number;
  pointSize?: number;             // Point cloud: point size in world units (default 0.005, ~5mm)
  pointColor?: string;            // Point cloud: override color (hex string, e.g. '#ffffff')
  gpuAcceleratedSort?: boolean;
  compressionLevel?: number;
  progressiveLoad?: boolean;
}

// ── Multi-instance types ──

/** Each placed splat gets its own Viewer instance and container Group. */
interface SplatInstance {
  id: string;
  viewer: InstanceType<typeof import('@mkkellogg/gaussian-splats-3d').Viewer> | null;
  pointCloud: Points | null;
  container: Group;
  url: string;
  isPointCloud: boolean;
  /** Set once the shader has been patched for crop uniforms. */
  cropPatched: boolean;
  /** Pre-allocated uniform vectors so live edits are GC-free. */
  cropMin: Vector3;
  cropMax: Vector3;
}

// ── Plugin Class ──

export class GaussianSplatPlugin implements RVViewerPlugin {
  readonly id = 'gaussian-splat';
  readonly slots = [];

  private _viewer: RVViewer | null = null;
  _config: GaussianSplatConfig | null = null;
  private _isDisposed = false;
  private _instances: SplatInstance[] = [];
  private _savedAoMode: string | null = null;
  private _savedBloom: boolean | null = null;
  private _loading = false;
  private _loadedInfo = '';
  private _stateListeners = new Set<() => void>();
  /** Unsubscribe handle for the `layout-transform-update` listener — set
   *  in `onModelLoaded`, cleared in `onModelCleared` / `dispose`. */
  private _transformUnsub: (() => void) | null = null;

  // ── Lifecycle ──

  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    this._viewer = viewer;
    this._isDisposed = false;

    // Subscribe to layout-transform-update so we keep the splatMesh in
    // step with the Three.js container. Every emit-site that mutates a
    // layout object's transform (Gizmo drag, Inspector edit, Set-Position
    // dialog, restore) flows through this event, so the splat lib stays
    // synced no matter who moved the container.
    this._transformUnsub?.();
    this._transformUnsub = viewer.on('layout-transform-update', (data: unknown) => {
      const evt = data as { path: string };
      const node = viewer.registry?.getNode(evt.path);
      if (node) this.syncSplatTransform(node as Group);
    });

    // Read config: model-specific config takes priority over global settings.json
    const modelCfg = result.modelConfig?.pluginConfig?.['gaussian-splat'] as GaussianSplatConfig | undefined;
    const appCfg = getAppConfig().pluginConfig?.['gaussian-splat'] as GaussianSplatConfig | undefined;
    this._config = modelCfg ?? appCfg ?? null;

    if (!this._config?.enabled || !this._config.url) return;
    if (viewer.isWebGPU) {
      console.warn('[gaussian-splat] WebGPU not supported by splat library, skipping');
      return;
    }

    // Fire-and-forget load via the multi-instance API
    this.loadSplat(this._config.url).catch((e) => {
      console.error('[gaussian-splat] Load failed:', e);
    });
  }

  onRender(_dt: number): void {
    if (this._instances.length === 0) return;

    const renderer = this._viewer?.renderer as unknown as {
      setRenderTarget: (t: null) => void;
      autoClear: boolean;
    } | undefined;

    // One-shot diagnostic: dumps what the splat library's render path
    // can actually see in the host scene the first time it runs. Helps
    // diagnose "newly placed layout objects don't appear in front of
    // the splat" without guesswork — we look at viewer.scene.children
    // directly and check whether the layout-planner root (or the model
    // root containing placed clones) is visible & traversed.
    if (!this._sceneDiagnosticLogged && this._viewer) {
      this._sceneDiagnosticLogged = true;
      const scene = this._viewer.scene;
      const visibleChildren = scene.children.filter(c => c.visible);
      let opaqueMeshCount = 0;
      scene.traverse((n) => {
        const mesh = n as { isMesh?: boolean; visible: boolean; material?: { transparent?: boolean } };
        if (mesh.isMesh && mesh.visible && mesh.material && !mesh.material.transparent) opaqueMeshCount++;
      });
      console.log('[gaussian-splat] threeScene diagnostic:', {
        sceneChildren: scene.children.length,
        visibleDirectChildren: visibleChildren.length,
        opaqueMeshesInScene: opaqueMeshCount,
        directChildNames: scene.children.map(c => ({ name: c.name || c.type, visible: c.visible })),
      });
    }

    for (const inst of this._instances) {
      if (!inst.container.visible) continue;
      if (inst.isPointCloud) continue; // Point clouds render via standard Three.js pipeline

      if (inst.viewer && renderer) {
        renderer.setRenderTarget(null);
        const prevAutoClear = renderer.autoClear;
        renderer.autoClear = false;
        inst.viewer.update();
        inst.viewer.render();
        renderer.autoClear = prevAutoClear;
      }
    }

    this._viewer?.markRenderDirty();
  }

  /** Diagnostic guard so the log fires once per model load, not 60×/s. */
  private _sceneDiagnosticLogged = false;

  /**
   * Sync a container's current position + quaternion (and optionally scale)
   * onto the library's `splatMesh`. Driven from `layout-transform-update`
   * events emitted by the planner (Gizmo drag, Inspector edit, Set-Position
   * dialog, restore, …) — see `_installSplatTransformListener` in
   * `onModelLoaded`. Container.scale is intentionally NOT synced here so
   * that the dedicated axis-invert path through `setSplatScale` stays the
   * sole writer of scale (otherwise toggling Invert X/Y/Z would race with
   * the transform-sync and visually flicker).
   */
  syncSplatTransform(container: Group): void {
    const inst = this._instances.find(i => i.container === container);
    if (!inst || inst.isPointCloud) return;

    const splatViewer = inst.viewer as unknown as {
      splatMesh?: {
        position: { copy(v: { x: number; y: number; z: number }): void };
        quaternion: { copy(q: { x: number; y: number; z: number; w: number }): void };
        updateMatrix?: () => void;
        updateMatrixWorld?: (force?: boolean) => void;
      };
    } | null;
    const mesh = splatViewer?.splatMesh;
    if (!mesh) return;

    container.updateMatrixWorld(true);
    mesh.position.copy(container.position);
    mesh.quaternion.copy(container.quaternion);
    mesh.updateMatrix?.();
    mesh.updateMatrixWorld?.(true);
    this._viewer?.markRenderDirty();
  }

  /**
   * Raycast a world-space ray against every visible splat instance.
   *
   * Three.js' standard `Raycaster.intersectObjects()` cannot hit splats —
   * they're rendered as alpha-blended Gaussian ellipsoids with no
   * triangle geometry. We instead walk each splatMesh's octree (built by
   * the library at load time) and test individual splats as spheres
   * (using their averaged scale as radius). Same approach the library's
   * internal `Raycaster.intersectSplatMesh` uses with
   * `raycastAgainstTrueSplatEllipsoid = false`.
   *
   * **NOT suitable for precise measurement.** Sphere approximations have
   * cm-level depth jitter, and the "nearest splat by ray-depth" doesn't
   * coincide with the visually-perceived alpha-blended surface. The
   * measurement plugin therefore picks against meshes only (see
   * `measurement-plugin.tsx::_worldRaycast`). Use this API for coarse
   * highlighting / debug picking only. For sub-cm splat measurement the
   * correct path is a GPU depth-pre-pass with cumulative-alpha 0.5
   * (SuperSplat / 2DGS approach) — not yet implemented.
   *
   * Empty array if no splats are present, invisible, or missed.
   */
  raycastSplats(ray: Ray): readonly SplatRaycastHit[] {
    const allHits: SplatRaycastHit[] = [];
    for (const inst of this._instances) {
      if (!inst.container.visible) continue;
      if (inst.isPointCloud) continue;
      if (!inst.viewer) continue;

      const splatMesh = (inst.viewer as unknown as {
        splatMesh?: SplatMeshLike;
      }).splatMesh;
      if (!splatMesh) continue;

      castRayAtSplatMesh(splatMesh, ray, inst.container, inst.cropMin, inst.cropMax, allHits);
    }
    allHits.sort((a, b) => a.distance - b.distance);
    return allHits;
  }

  onModelCleared(): void {
    this._transformUnsub?.();
    this._transformUnsub = null;
    this._disposeAll();
  }

  dispose(): void {
    this._isDisposed = true;
    this._transformUnsub?.();
    this._transformUnsub = null;
    this._disposeAll();
  }

  // ── Loading state (for React subscription) ──

  get isLoading(): boolean { return this._loading; }
  get loadedInfo(): string { return this._loadedInfo; }

  subscribeState(cb: () => void): () => void {
    this._stateListeners.add(cb);
    return () => { this._stateListeners.delete(cb); };
  }

  private _notifyState(): void {
    this._stateListeners.forEach((cb) => cb());
  }

  // ── Public Multi-Instance API ──

  /** Number of active splat instances. */
  get instanceCount(): number { return this._instances.length; }

  /**
   * Load a splat file and return a container Group that can be transformed.
   * Each call creates a new GS3D.Viewer instance (multi-instance).
   */
  async loadSplat(url: string, fileExt?: string): Promise<Group> {
    if (!this._viewer) throw new Error('[gaussian-splat] Viewer not initialized');
    if (this._viewer.isWebGPU) {
      throw new Error('[gaussian-splat] WebGPU not supported by splat library');
    }

    // Disable post-processing on first splat instance
    if (this._instances.length === 0) {
      this._disablePostProcessing();
    }

    // Visible UX hint — splat parsing can hold the main thread for several
    // seconds on large captures, and the library's own UI is disabled
    // (`showLoadingUI: false`). Uses a direct DOM overlay rather than the
    // React-based info-overlay-store because GS3D's blocking work starts
    // before any React commit/paint cycle can fire on the next rAF.
    const fileName = url.split('/').pop() ?? 'splat';
    const ext = (fileExt ?? fileName.split('.').pop() ?? '').toLowerCase();
    const isPC = ext === 'pcd' || (ext === 'ply' && this._config?.mode === 'pointcloud');
    showDomOverlay(
      isPC ? `Loading point cloud (${fileName})…` : `Loading gaussian splat (${fileName})…`,
    );

    this._loading = true;
    this._loadedInfo = 'Loading gaussian splat...';
    this._notifyState();

    // Yield two animation frames so the browser paints our overlay before
    // GS3D's blocking parse + GPU upload starts.
    await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));

    const container = new Group();
    container.userData._rvExcludeFromRaycast = true;
    container.castShadow = false;
    container.receiveShadow = false;

    // Apply config transform for legacy single-splat path (first instance from config)
    if (this._instances.length === 0 && this._config) {
      if (this._config.position) {
        container.position.set(...this._config.position);
      }
      if (this._config.rotation) {
        const [x, y, z] = this._config.rotation;
        container.rotation.set(
          MathUtils.degToRad(x),
          MathUtils.degToRad(y),
          MathUtils.degToRad(z),
        );
      }
      if (this._config.scale) {
        container.scale.setScalar(this._config.scale);
      }
    }

    this._viewer.scene.add(container);

    const resolvedMode = this._resolveMode(url, fileExt);
    const isPointCloud = resolvedMode === 'pointcloud';

    // Crop defaults to "no clip" — a wide box that engulfs any realistic
    // capture. Patched into the shader on first setSplatCrop() call.
    const NO_CROP = 1e6;
    const instance: SplatInstance = {
      id: crypto.randomUUID(),
      viewer: null,
      pointCloud: null,
      container,
      url,
      isPointCloud,
      cropPatched: false,
      cropMin: new Vector3(-NO_CROP, -NO_CROP, -NO_CROP),
      cropMax: new Vector3(NO_CROP, NO_CROP, NO_CROP),
    };

    try {
      if (isPointCloud) {
        const pc = await this._loadPointCloudInto(url, container);
        instance.pointCloud = pc;
      } else {
        const splatViewer = await this._loadGaussianSplatViewer(url, fileExt);
        instance.viewer = splatViewer;
      }
    } catch (e) {
      // Cleanup on failure
      this._viewer.scene.remove(container);
      if (this._instances.length === 0) {
        this._restorePostProcessing();
      }
      this._loading = false;
      this._notifyState();
      hideDomOverlay();
      throw e;
    }

    this._instances.push(instance);

    this._loading = false;
    this._loadedInfo = isPointCloud ? 'Point cloud loaded' : 'Gaussian splat loaded';
    this._notifyState();
    this._viewer.markRenderDirty();
    hideDomOverlay();

    return container;
  }

  /**
   * Apply a per-axis scale to the splat instance attached to `container`.
   * The gaussian-splats-3d library renders through its own scene graph
   * (separate from `_viewer.scene`), so setting the Three.js container's
   * scale alone has no visual effect on the splat. We reach into the
   * library's `splatMesh` directly and mutate its scale + matrix world.
   *
   * Negative values mirror the splat — used by the Splat component's
   * Invert X/Y/Z controls. Also keeps the container's own scale in sync
   * so anything that queries it (e.g. hover overlays, bbox helpers) sees
   * the same numbers.
   *
   * Silently no-ops for unknown containers (e.g. if the container was
   * disposed concurrently) and for point-cloud instances (where the
   * geometry lives inside the container and standard Three.js scale
   * propagation works).
   */
  setSplatScale(container: Group, scale: readonly [number, number, number]): void {
    const inst = this._instances.find(i => i.container === container);
    if (!inst) return;

    // Mirror onto the Three.js container so user-facing readouts agree
    // with the rendered state.
    container.scale.set(scale[0], scale[1], scale[2]);
    container.updateMatrixWorld(true);

    // Point cloud case: the Three.js Points lives inside the container
    // already — container.scale propagates via the regular scene graph.
    if (inst.isPointCloud) {
      this._viewer?.markRenderDirty();
      return;
    }

    // Gaussian splat case: mutate the library's splatMesh directly.
    const splatViewer = inst.viewer as unknown as { splatMesh?: { scale: { set(x: number, y: number, z: number): void }; updateMatrix?: () => void; updateMatrixWorld?: (force?: boolean) => void } } | null;
    const mesh = splatViewer?.splatMesh;
    if (mesh) {
      mesh.scale.set(scale[0], scale[1], scale[2]);
      mesh.updateMatrix?.();
      mesh.updateMatrixWorld?.(true);
    }
    this._viewer?.markRenderDirty();
  }

  /**
   * Crop the splat to an axis-aligned box in the splat's local coordinate
   * frame. Splats whose centre falls outside [min, max] are culled in the
   * vertex shader (gl_Position pushed past the far plane → no fragment).
   *
   * On first call for a given instance we patch the library's ShaderMaterial:
   *   - inject `uniform vec3 uRVCropMin/uRVCropMax`
   *   - inject an early-out right after `vec3 splatCenter = …;`
   * Subsequent calls just update the uniform vectors — no shader recompile.
   *
   * Pass `±1e6` (or any wide range) to effectively disable cropping along
   * an axis. Point-cloud instances are no-ops (different render pipeline —
   * use Three.js clipping planes there if needed).
   */
  setSplatCrop(
    container: Group,
    box: { min: readonly [number, number, number]; max: readonly [number, number, number] },
  ): void {
    const inst = this._instances.find(i => i.container === container);
    if (!inst || inst.isPointCloud) return;

    inst.cropMin.set(box.min[0], box.min[1], box.min[2]);
    inst.cropMax.set(box.max[0], box.max[1], box.max[2]);

    const splatViewer = inst.viewer as unknown as {
      splatMesh?: {
        material?: {
          uniforms?: Record<string, { value: unknown }>;
          vertexShader: string;
          needsUpdate?: boolean;
          uniformsNeedUpdate?: boolean;
        };
      };
    } | null;
    const mesh = splatViewer?.splatMesh;
    const material = mesh?.material;
    if (!material) return;

    if (!inst.cropPatched) {
      // Inject uniforms declaration BEFORE main(). The library's vertex
      // shader has multiple `void main()` strings only when SH degrees are
      // included, but the splat one always lives in the SplatMaterial3D
      // base — we anchor on the `splatCenter` assignment which is unique.
      const splatCenterAnchor = 'vec3 splatCenter = uintBitsToFloat(uvec3(sampledCenterColor.gba));';
      const cropEarlyOut = `${splatCenterAnchor}
            // === realvirtual crop check (axis-aligned box, local space) ===
            if (splatCenter.x < uRVCropMin.x || splatCenter.x > uRVCropMax.x ||
                splatCenter.y < uRVCropMin.y || splatCenter.y > uRVCropMax.y ||
                splatCenter.z < uRVCropMin.z || splatCenter.z > uRVCropMax.z) {
                gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
                return;
            }`;

      const uniformDecl = `\nuniform vec3 uRVCropMin;\nuniform vec3 uRVCropMax;\n`;

      let patched = material.vertexShader;
      if (patched.includes(splatCenterAnchor)) {
        patched = patched.replace(splatCenterAnchor, cropEarlyOut);
      }
      // Inject the uniform declarations just before the splat's main(). The
      // last `void main` in the source string is the splat entry-point — SH
      // helper functions use `void` for their return type too but never as
      // `void main`. Splitting on the last occurrence is the safest anchor.
      const mainIdx = patched.lastIndexOf('void main');
      if (mainIdx >= 0) {
        patched = patched.slice(0, mainIdx) + uniformDecl + patched.slice(mainIdx);
      }

      material.vertexShader = patched;
      if (!material.uniforms) (material as { uniforms: Record<string, { value: unknown }> }).uniforms = {};
      material.uniforms!.uRVCropMin = { value: inst.cropMin };
      material.uniforms!.uRVCropMax = { value: inst.cropMax };
      material.needsUpdate = true;
      inst.cropPatched = true;
    } else {
      // Subsequent edits: uniform values share the same Vector3 reference
      // as inst.cropMin/Max (set above), so they're already up to date.
      // Three.js picks up changes on next draw — flag for safety on some drivers.
      material.uniformsNeedUpdate = true;
    }

    this._viewer?.markRenderDirty();
  }

  /**
   * Dispose a specific splat instance by its container Group reference.
   */
  disposeSplat(container: Group): void {
    const idx = this._instances.findIndex(inst => inst.container === container);
    if (idx === -1) return;

    const inst = this._instances[idx];
    this._disposeSplatInstance(inst);
    this._instances.splice(idx, 1);

    // Restore post-processing when last splat is removed
    if (this._instances.length === 0) {
      this._restorePostProcessing();
    }

    this._viewer?.markRenderDirty();
  }

  // ── Internal: Mode resolution ──

  private _resolveMode(url: string, fileExt?: string): 'splat' | 'pointcloud' {
    const mode = this._config?.mode ?? 'auto';
    if (mode === 'splat') return 'splat';
    if (mode === 'pointcloud') return 'pointcloud';
    const ext = fileExt || url.split('.').pop()?.toLowerCase() || '';
    if (ext === 'pcd') return 'pointcloud';
    if (ext === 'splat' || ext === 'ksplat') return 'splat';
    return 'splat';
  }

  // ── Internal: Gaussian Splat loading ──

  private async _loadGaussianSplatViewer(
    url: string,
    fileExt?: string,
  ): Promise<InstanceType<typeof import('@mkkellogg/gaussian-splats-3d').Viewer>> {
    const GS3D = await import('@mkkellogg/gaussian-splats-3d');
    if (this._isDisposed) throw new Error('Plugin disposed during load');

    const renderer = this._viewer!.renderer;
    const camera = this._viewer!.camera;

    const splatViewer = new GS3D.Viewer({
      selfDrivenMode: false,
      renderer: renderer,
      camera: camera,
      useBuiltInControls: false,
      gpuAcceleratedSort: false,
      inMemoryCompressionLevel: this._config?.compressionLevel ?? 2,
      freeIntermediateSplatData: true,
      sharedMemoryForWorkers: false,
      // Pass our host Three.js scene so the splat library can pre-render
      // opaque host meshes into the depth buffer before drawing splats.
      // This is THE official way to get host geometry to occlude splats
      // (README "Three.js Scene Integration"). Without it, splats render
      // on top of everything regardless of camera distance — the use case
      // here is "machine standing IN a scanned showroom", which needs the
      // splat treated as a backdrop respecting host depth.
      threeScene: this._viewer!.scene,
      // Required for our workflow: splat containers move/rotate at
      // runtime (planner placement, inspector edits), so the library
      // must NOT bake transforms into its splat data at load time.
      dynamicScene: true,
    });

    const ext = fileExt || url.split('.').pop()?.toLowerCase() || '';
    const FORMAT_MAP: Record<string, number> = { splat: 0, ksplat: 1, ply: 2, spz: 3 };
    const format = FORMAT_MAP[ext];

    const sceneOptions: Record<string, unknown> = {
      progressiveLoad: this._config?.progressiveLoad ?? false,
      showLoadingUI: false,
    };
    if (format !== undefined) {
      sceneOptions.format = format;
    }

    console.log(`[gaussian-splat] Loading (Viewer mode, selfDriven=false): ext=${ext}, format=${format}`);

    // Resolve through the blob cache so repeat placements / page reloads
    // skip the network fetch. `blob:` URLs pass through unchanged.
    const loadUrl = url.startsWith('blob:') || url.startsWith('data:')
      ? url
      : await _splatBlobCache.getObjectUrl(url);
    const revoke = loadUrl !== url;

    try {
      await splatViewer.addSplatScene(loadUrl, sceneOptions);
      console.log('[gaussian-splat] Gaussian splat loaded OK');
      // Depth integration with the host Three.js scene is now wired via
      // the library's `threeScene` constructor option (see below) — that
      // is the supported path; the splat material's library defaults
      // (`depthTest = true, depthWrite = false`) are correct as long as
      // the library can pre-render our scene into the depth buffer.
    } catch (e) {
      console.error('[gaussian-splat] addSplatScene FAILED:', e);
      throw e;
    } finally {
      if (revoke) URL.revokeObjectURL(loadUrl);
    }

    return splatViewer;
  }

  // ── Internal: Point Cloud loading ──

  private async _loadPointCloudInto(url: string, container: Group): Promise<Points> {
    let geometry: BufferGeometry;
    const ext = url.split('.').pop()?.toLowerCase() ?? '';

    // Route through the shared blob cache so reload / repeat placement skip
    // the network fetch. `blob:` / `data:` URLs pass through unchanged.
    const loadUrl = url.startsWith('blob:') || url.startsWith('data:')
      ? url
      : await _splatBlobCache.getObjectUrl(url);
    const revoke = loadUrl !== url;

    try {
      if (ext === 'pcd') {
        const { PCDLoader } = await import('three/addons/loaders/PCDLoader.js');
        const loader = new PCDLoader();
        const points = await loader.loadAsync(loadUrl);
        geometry = points.geometry;
      } else {
        const { PLYLoader } = await import('three/addons/loaders/PLYLoader.js');
        const loader = new PLYLoader();
        geometry = await loader.loadAsync(loadUrl);
      }
    } finally {
      if (revoke) URL.revokeObjectURL(loadUrl);
    }

    if (!geometry.attributes.normal) {
      geometry.computeVertexNormals();
    }

    const hasVertexColors = !!geometry.attributes.color;
    const material = new PointsMaterial({
      size: this._config?.pointSize ?? 0.005,
      vertexColors: hasVertexColors,
      color: this._config?.pointColor
        ? new Color(this._config.pointColor)
        : (hasVertexColors ? 0xffffff : 0x888888),
      sizeAttenuation: true,
      opacity: this._config?.opacity ?? 1.0,
      transparent: (this._config?.opacity ?? 1.0) < 1.0,
    });

    const pointCloud = new Points(geometry, material);
    pointCloud.castShadow = false;
    pointCloud.receiveShadow = false;
    container.add(pointCloud);

    const count = geometry.attributes.position.count;
    this._loadedInfo = `${(count / 1000).toFixed(0)}K points`;
    console.log(`[gaussian-splat] Point cloud loaded: ${count.toLocaleString()} points`);

    return pointCloud;
  }

  // ── Internal: Post-processing control ──

  private _disablePostProcessing(): void {
    if (!this._viewer) return;
    const v = this._viewer as unknown as { aoMode: string; bloomEnabled: boolean };
    this._savedAoMode = v.aoMode;
    this._savedBloom = v.bloomEnabled ?? false;
    v.aoMode = 'off';
    v.bloomEnabled = false;
    console.log('[gaussian-splat] Post-processing disabled (AO was:', this._savedAoMode, 'Bloom was:', this._savedBloom, ')');
  }

  private _restorePostProcessing(): void {
    if (!this._viewer || this._savedAoMode === null) return;
    const v = this._viewer as unknown as { aoMode: string; bloomEnabled: boolean };
    v.aoMode = this._savedAoMode;
    v.bloomEnabled = this._savedBloom ?? false;
    this._savedAoMode = null;
    this._savedBloom = null;
    console.log('[gaussian-splat] Post-processing restored');
  }

  // ── Internal: Disposal ──

  private _disposeSplatInstance(inst: SplatInstance): void {
    // Point cloud cleanup
    if (inst.pointCloud) {
      inst.pointCloud.geometry.dispose();
      (inst.pointCloud.material as PointsMaterial).dispose();
    }

    // Container cleanup
    if (inst.container.parent) {
      inst.container.parent.remove(inst.container);
    }

    // Gaussian splat viewer cleanup
    if (inst.viewer) {
      const sv = inst.viewer;
      inst.viewer = null;
      Promise.resolve(sv.dispose?.()).catch((e: unknown) => {
        console.warn('[gaussian-splat] dispose error:', e);
      });
    }
  }

  private _disposeAll(): void {
    for (const inst of this._instances) {
      this._disposeSplatInstance(inst);
    }
    const hadInstances = this._instances.length > 0;
    this._instances = [];
    if (hadInstances) {
      this._restorePostProcessing();
    }
    this._viewer?.markRenderDirty();
  }
}

// ─── Splat raycasting ──────────────────────────────────────────────────────
//
// Re-implementation of the gaussian-splats-3d library's internal Raycaster
// (`raycastAgainstTrueSplatEllipsoid = false` variant). The class is not in
// the library's public exports — we walk the octree ourselves via the
// public-ish methods on `splatMesh` (`getSplatTree`, `getSplatCenter`,
// `getSplatScaleAndRotation`, …). Sphere approximation is fast and gives a
// good enough hit for picking / measurement.

/** Structural shape of `splatMesh` we depend on for raycasting.
 *  Matches the gaussian-splats-3d library's internal Mesh subclass. */
interface SplatMeshLike {
  matrixWorld: Matrix4;
  dynamicMode?: boolean;
  splatRenderMode?: number;  // 0 = ThreeD, 1 = TwoD (library enum)
  getSplatTree(): SplatTreeLike | null | undefined;
  getSceneTransform(sceneIndex: number, out: Matrix4): void;
  getSceneIndexForSplat(splatIndex: number): number;
  getScene(sceneIndex: number): { visible: boolean };
  getSplatCenter(splatIndex: number, out: Vector3): void;
  getSplatScaleAndRotation(splatIndex: number, outScale: Vector3, outRot: Quaternion): void;
}
interface SplatTreeLike {
  subTrees: SubTreeLike[];
  splatMesh: SplatMeshLike;
}
interface SubTreeLike {
  rootNode: SplatTreeNode | null | undefined;
}
interface SplatTreeNode {
  boundingBox: Box3;
  data?: { indexes: number[] | Uint32Array };
  children?: SplatTreeNode[];
}

// Pre-allocated scratch — these are module-level singletons because
// raycasts are a click-driven (rare) event; threading is irrelevant on
// the main JS thread.
const _rcFromLocal = new Matrix4();
const _rcToLocal = new Matrix4();
const _rcSceneTransform = new Matrix4();
const _rcLocalRay = new Ray();
const _rcCenter = new Vector3();
const _rcScale = new Vector3();
const _rcRotation = new Quaternion();
const _rcSphere = new Sphere();
const _rcWorldHit = new Vector3();
const _rcDelta = new Vector3();
const SPLAT_SCALE_EPS = 1e-7;
const SPLAT_RENDER_MODE_3D = 0;

/**
 * Walk a single splatMesh and append all sphere-intersection hits to
 * `out`. Pre-transforms the ray into the mesh's local frame once, then
 * recurses into the octree. World-space `point` / `normal` / `distance`
 * are filled in at the end by projecting each splat's centre onto the
 * world ray — so the hit point is guaranteed to lie on the user's pick
 * ray (was previously a local-space perpendicular foot that could drift
 * off-ray under non-uniform scale) and `distance` is the true ray-depth
 * comparable to `Raycaster.intersectObjects()` distances.
 *
 * `cropMin` / `cropMax` are in the mesh's local frame and mirror the
 * vertex-shader cull — splats whose centre is outside the box are
 * skipped so they cannot be picked.
 */
function castRayAtSplatMesh(
  splatMesh: SplatMeshLike,
  worldRay: Ray,
  container: Group,
  cropMin: Vector3,
  cropMax: Vector3,
  out: SplatRaycastHit[],
): void {
  if (typeof splatMesh.getSplatTree !== 'function') {
    console.warn('[gaussian-splat] splatMesh.getSplatTree is not a function — library version mismatch?', splatMesh);
    return;
  }
  const splatTree = splatMesh.getSplatTree();
  if (!splatTree) {
    console.warn('[gaussian-splat] splatTree is null — splat not fully loaded yet?');
    return;
  }
  if (!splatTree.subTrees || splatTree.subTrees.length === 0) {
    console.warn('[gaussian-splat] splatTree.subTrees empty:', splatTree);
    return;
  }

  for (let s = 0; s < splatTree.subTrees.length; s++) {
    const subTree = splatTree.subTrees[s];

    _rcFromLocal.copy(splatMesh.matrixWorld);
    if (splatMesh.dynamicMode) {
      splatMesh.getSceneTransform(s, _rcSceneTransform);
      _rcFromLocal.multiply(_rcSceneTransform);
    }
    _rcToLocal.copy(_rcFromLocal).invert();

    // Transform the world ray into the mesh's local frame. Library uses
    // the same math here: project origin+direction through the inverse
    // matrix, then re-normalise the direction.
    _rcLocalRay.origin.copy(worldRay.origin).applyMatrix4(_rcToLocal);
    _rcLocalRay.direction.copy(worldRay.origin).add(worldRay.direction);
    _rcLocalRay.direction.applyMatrix4(_rcToLocal).sub(_rcLocalRay.origin).normalize();

    const subHits: { center: Vector3; splatIndex: number }[] = [];
    if (subTree.rootNode) {
      castRayAtSplatNode(_rcLocalRay, splatTree, subTree.rootNode, cropMin, cropMax, subHits);
    }

    // Project each splat centre onto the world ray. Two reasons for doing
    // this in world space rather than carrying a local-frame hit point
    // back through `_rcFromLocal`:
    //   1) The result is exactly on the world ray, even when the mesh has
    //      non-uniform scale (a local perpendicular foot won't transform
    //      to a world perpendicular foot).
    //   2) `distance` is the true ray-depth, so it can be compared with
    //      `Raycaster.intersectObjects()` distances when the measurement
    //      plugin merges splat hits with mesh hits.
    for (const hit of subHits) {
      const worldCenter = hit.center.applyMatrix4(_rcFromLocal);
      _rcDelta.copy(worldCenter).sub(worldRay.origin);
      const t = _rcDelta.dot(worldRay.direction);
      if (t <= 0) continue; // splat behind camera — skip
      const worldPoint = new Vector3()
        .copy(worldRay.origin)
        .addScaledVector(worldRay.direction, t);
      // Normal points from the on-ray hit point toward the splat centre.
      // Degenerate case (ray passes through centre, length ≈ 0): fall back
      // to the inverted ray direction so consumers still get a unit vector.
      const normal = worldCenter.clone().sub(worldPoint);
      if (normal.lengthSq() < 1e-12) {
        normal.copy(worldRay.direction).negate();
      } else {
        normal.normalize();
      }
      out.push({
        point: worldPoint,
        normal,
        distance: t,
        splatIndex: hit.splatIndex,
        container,
      });
    }
  }
}

/**
 * Recursive AABB-pruned octree walk testing each leaf splat as a sphere.
 * Collects only the (local-space) splat centre + index per hit; the
 * caller in `castRayAtSplatMesh` does the world-space projection so the
 * resulting hit point is guaranteed to lie on the original world ray.
 *
 * `cropMin` / `cropMax` are in the same local frame as the splat centres
 * and mirror the vertex-shader cull (`setSplatCrop`). Splats whose
 * centre is outside the crop box are skipped — they're not rendered, so
 * they must not be pickable either.
 */
function castRayAtSplatNode(
  ray: Ray,
  splatTree: SplatTreeLike,
  node: SplatTreeNode,
  cropMin: Vector3,
  cropMax: Vector3,
  out: { center: Vector3; splatIndex: number }[],
): void {
  if (!ray.intersectsBox(node.boundingBox)) return;

  if (node.data && node.data.indexes && node.data.indexes.length > 0) {
    const isThreeD = (splatTree.splatMesh.splatRenderMode ?? SPLAT_RENDER_MODE_3D) === SPLAT_RENDER_MODE_3D;
    for (let i = 0; i < node.data.indexes.length; i++) {
      const splatGlobalIndex = node.data.indexes[i];
      const splatSceneIndex = splatTree.splatMesh.getSceneIndexForSplat(splatGlobalIndex);
      const splatScene = splatTree.splatMesh.getScene(splatSceneIndex);
      if (!splatScene.visible) continue;

      splatTree.splatMesh.getSplatCenter(splatGlobalIndex, _rcCenter);

      // Crop check — mirror the vertex-shader cull from `setSplatCrop`.
      // A splat whose centre is outside [min, max] is rendered off-screen
      // (gl_Position = (0, 0, 2, 1)), so picking it would feel like a
      // ghost hit on geometry the user has explicitly hidden.
      if (_rcCenter.x < cropMin.x || _rcCenter.x > cropMax.x ||
          _rcCenter.y < cropMin.y || _rcCenter.y > cropMax.y ||
          _rcCenter.z < cropMin.z || _rcCenter.z > cropMax.z) continue;

      splatTree.splatMesh.getSplatScaleAndRotation(splatGlobalIndex, _rcScale, _rcRotation);
      // Skip degenerate splats — library checks the same thing.
      if (_rcScale.x <= SPLAT_SCALE_EPS || _rcScale.y <= SPLAT_SCALE_EPS) continue;
      if (isThreeD && _rcScale.z <= SPLAT_SCALE_EPS) continue;

      // Sphere radius = average scale on the relevant axes. Matches the
      // library's fast path for `raycastAgainstTrueSplatEllipsoid=false`.
      const radius = isThreeD
        ? (_rcScale.x + _rcScale.y + _rcScale.z) / 3
        : (_rcScale.x + _rcScale.y) / 2;
      _rcSphere.set(_rcCenter, radius);

      // Sphere-test in local space is fast and accurate enough as a
      // "is this splat within the ray's selection range?" gate. The real
      // hit point + distance are computed in world space by the caller.
      if (ray.intersectSphere(_rcSphere, _rcWorldHit)) {
        out.push({
          center: _rcCenter.clone(),
          splatIndex: splatGlobalIndex,
        });
      }
    }
  }

  if (node.children && node.children.length > 0) {
    for (const child of node.children) {
      castRayAtSplatNode(ray, splatTree, child, cropMin, cropMax, out);
    }
  }
}
