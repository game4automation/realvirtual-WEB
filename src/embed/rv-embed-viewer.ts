// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Lightweight production facade over the real WebViewer engine subsystems.
 *
 * The facade intentionally excludes RVViewer, plugins, React/MUI, industrial
 * interfaces, editor tooling, post-processing, WebGPU and stats. It owns one
 * scene, renderer and fixed-step pipeline and is terminal after dispose().
 */

import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  Material,
  Mesh,
  type Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Texture,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  disposeComponentsInSubtree,
  loadGLB,
  type LoadResult,
} from '../core/engine/rv-scene-loader';
import { SimulationLoop } from '../core/engine/rv-simulation-loop';
import { CoreSubsystems } from '../core/engine/rv-core-subsystems';
import { ContinuousRunner } from '../core/material-flow/continuous-runner';
import { CameraManager, type ViewerCameraState } from '../core/rv-camera-manager';
import type { SignalStore } from '../core/engine/rv-signal-store';
import type { RVIKPath } from '../core/engine/rv-ik-path';
import { configureOrbitControls } from '../core/engine/rv-orbit-controls-config';
import { resetEmbedEngineRegistries } from './rv-embed-registry-reset';
import {
  RVEmbedDirector,
  type RVEmbedDirectorApi,
  type RVEmbedDirectorCameraAction,
  type RVEmbedDirectorCameraPose,
  type RVEmbedDirectorEvents,
  type RVEmbedDirectorScript,
} from './rv-embed-director';

export type RVEmbedSignalValue = boolean | number;

export interface RVEmbedCameraPose {
  position: readonly [number, number, number];
  target: readonly [number, number, number];
}

export interface RVEmbedCameraFocusOptions {
  /** Extra framing multiplier. Values above 1 leave more space around the node. */
  padding?: number;
  /** Camera transition duration in milliseconds. Zero applies immediately. */
  durationMs?: number;
}

export interface RVEmbedSignalsApi {
  subscribe(name: string, callback: (value: RVEmbedSignalValue) => void): () => void;
  write(name: string, value: RVEmbedSignalValue): void;
}

export interface RVEmbedCameraApi {
  focus(nodePath: string, options?: RVEmbedCameraFocusOptions): void;
  tween(pose: RVEmbedCameraPose, durationMs: number): void;
}

export interface RVEmbedNodeTransformState {
  nodePath: string;
  position: readonly [number, number];
  transform: readonly [number, number, number];
}

export interface RVEmbedOptions {
  /** Canvas to render into. When omitted, a detached canvas is created. */
  canvas?: HTMLCanvasElement;
  /** Device-pixel-ratio cap. Default 1.5. */
  dprCap?: number;
  /** Background CSS color. null means transparent. Default '#1a1d21'. */
  background?: string | null;
  /** Render width when the canvas has no layout width. */
  width?: number;
  /** Render height when the canvas has no layout height. */
  height?: number;
  /** Named director script stored in the loaded GLB's rv_extras. */
  director?: string | null;
  /** Embed-element event bridge for director steps, errors and visual state. */
  directorEvents?: RVEmbedDirectorEvents;
  /** Shared embed lifecycle signal. Aborting it disposes this viewer. */
  signal?: AbortSignal;
}

/** Result of controlled renderer rehydration. */
export interface RehydrateResult {
  /** Milliseconds from renderer creation through the first rendered frame. */
  firstFrameMs: number;
}

interface SignalSubscription {
  name: string;
  callback: (value: RVEmbedSignalValue) => void;
  unsubscribe: (() => void) | null;
}

class RVEmbedSignals implements RVEmbedSignalsApi {
  private store: SignalStore | null = null;
  private readonly subscriptions = new Set<SignalSubscription>();
  private disposed = false;

  constructor(signal: AbortSignal) {
    signal.addEventListener('abort', () => this.dispose(), { once: true });
  }

  attach(store: SignalStore | null): void {
    if (this.store === store || this.disposed) return;
    for (const subscription of this.subscriptions) {
      subscription.unsubscribe?.();
      subscription.unsubscribe = null;
    }
    this.store = store;
    if (!store) return;
    for (const subscription of this.subscriptions) {
      subscription.unsubscribe = store.subscribe(subscription.name, subscription.callback);
    }
  }

  subscribe(name: string, callback: (value: RVEmbedSignalValue) => void): () => void {
    if (this.disposed) throw new Error('RVEmbedViewer is disposed');
    const subscription: SignalSubscription = {
      name,
      callback,
      unsubscribe: this.store?.subscribe(name, callback) ?? null,
    };
    this.subscriptions.add(subscription);
    return () => {
      if (!this.subscriptions.delete(subscription)) return;
      subscription.unsubscribe?.();
      subscription.unsubscribe = null;
    };
  }

  write(name: string, value: RVEmbedSignalValue): void {
    if (this.disposed) throw new Error('RVEmbedViewer is disposed');
    if (!this.store) throw new Error('RVEmbedViewer has no loaded signal store');
    this.store.set(name, value);
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.subscriptions) subscription.unsubscribe?.();
    this.subscriptions.clear();
    this.store = null;
  }
}

export class RVEmbedViewer {
  readonly scene = new Scene();
  renderer: WebGLRenderer;
  controls: OrbitControls;
  cameraManager: CameraManager;
  loop: SimulationLoop;
  readonly signals: RVEmbedSignalsApi;
  readonly camera: RVEmbedCameraApi;
  readonly director: RVEmbedDirectorApi;

  private readonly sceneCamera: PerspectiveCamera;
  private readonly cameraState: ViewerCameraState;
  private readonly lifecycleSignal: AbortSignal;
  private readonly ownAbortController: AbortController | null;
  private readonly signalApi: RVEmbedSignals;
  private result: LoadResult | null = null;
  private ikPaths: RVIKPath[] = [];
  private readonly core: CoreSubsystems;
  private runner: ContinuousRunner | null = null;
  private dprCap: number;
  private width: number;
  private height: number;
  private background: string | null;
  private loadGeneration = 0;
  private disposed = false;
  private loopRunning = false;
  private contextSuspended = false;
  private resumeAfterContextRestore = false;
  private readonly suspendedPauseReasons = new Set<string>();
  private scrollPerformanceMode = false;
  private renderFrameInterval = 0;
  private renderAccumulator = 0;
  private appliedPixelRatio = 0;
  private tickCount = 0;
  private directorName: string | null;
  private readonly directorEvents: RVEmbedDirectorEvents | undefined;
  private readonly directorController: RVEmbedDirector;
  private readonly directorProjectionPoint = new Vector3();
  private readonly dragProjectionPoint = new Vector3();
  private readonly dragLocalPoint = new Vector3();

  constructor(options: RVEmbedOptions = {}) {
    this.dprCap = normalizeDprCap(options.dprCap);
    this.width = normalizeDimension(options.width ?? options.canvas?.width, 640);
    this.height = normalizeDimension(options.height ?? options.canvas?.height, 400);
    this.background = options.background === undefined ? '#1a1d21' : options.background;
    this.directorName = options.director ?? null;
    this.directorEvents = options.directorEvents;
    this.ownAbortController = options.signal ? null : new AbortController();
    this.lifecycleSignal = options.signal ?? this.ownAbortController!.signal;

    this.renderer = this.createRenderer(options.canvas);
    this.sceneCamera = new PerspectiveCamera(50, this.width / this.height, 0.01, 5000);
    this.sceneCamera.position.set(3, 2, 3);
    this.controls = this.createControls();

    this.cameraState = {
      perspCamera: this.sceneCamera,
      orthoCamera: new OrthographicCamera(-1, 1, 1, -1, 0.01, 5000),
      _activeCamera: this.sceneCamera,
      controls: this.controls,
      renderer: this.renderer,
      _renderDirty: true,
      leftPanelManager: {},
      getPlugin: () => undefined,
    } as unknown as ViewerCameraState;
    this.cameraManager = new CameraManager(this.cameraState);

    const ambient = new AmbientLight(0xffffff, 0.7);
    const sun = new DirectionalLight(0xffffff, 1.4);
    sun.position.set(5, 10, 4);
    this.scene.add(ambient, sun);

    this.loop = this.createLoop();
    this.signalApi = new RVEmbedSignals(this.lifecycleSignal);
    this.signals = this.signalApi;
    this.camera = {
      focus: (nodePath, focusOptions) => this.focusCamera(nodePath, focusOptions),
      tween: (pose, durationMs) => this.tweenCamera(pose, durationMs),
    };
    this.directorController = new RVEmbedDirector({
      signal: this.lifecycleSignal,
      resolveNode: (path) => this.result?.registry.getNode(path) ?? null,
      resolveCamera: (action) => this.resolveDirectorCamera(action),
      getCameraPose: () => this.getDirectorCameraPose(),
      setCameraPose: (pose) => this.setDirectorCameraPose(pose),
      projectNode: (node) => this.projectDirectorNode(node),
      writeSignal: (name, value) => this.signalApi.write(name, value),
      events: this.directorEvents,
    });
    this.director = this.directorController;

    const viewer = this;
    this.core = new CoreSubsystems({
      get isConnected() { return false; },
      get playback() { return viewer.result?.playback ?? null; },
      get logicEngine() { return viewer.result?.logicEngine ?? null; },
      get ikPaths() { return viewer.ikPaths; },
      get replayRecordings() { return viewer.result?.replayRecordings ?? []; },
      get drives() { return viewer.result?.drives ?? []; },
      get transportManager() { return viewer.result?.transportManager ?? null; },
      tankFillManager: null,
      pipeFlowManager: null,
      lampManager: null,
      energyChainManager: null,
      // The embed runtime has no highlight system and no HMI shell, so a
      // collision report would have nowhere to go (plan-394).
      collisionManager: null,
      gizmoManager: { tick: (_elapsedMs: number) => false },
      markRenderDirty: () => {},
      markShadowsDirty: () => {},
    });

    this.lifecycleSignal.addEventListener('abort', () => this.dispose(), { once: true });
  }

  /** Load or replace a GLB through the production component pipeline. */
  async loadModel(url: string, data?: ArrayBuffer): Promise<LoadResult> {
    this.assertUsable();
    const generation = ++this.loadGeneration;
    this.clearModel();
    resetEmbedEngineRegistries();

    const result = await loadGLB(url, this.scene, {
      data,
      preserveHierarchy: true,
      allowUntrustedLogic: true,
      loadKinematicsSidecar: false,
      shouldAbort: () => (
        this.disposed
        || this.lifecycleSignal.aborted
        || generation !== this.loadGeneration
      ),
    });

    if (this.disposed || this.lifecycleSignal.aborted || generation !== this.loadGeneration) {
      this.disposeLoadResult(result);
      throw new DOMException('RVEmbedViewer load aborted', 'AbortError');
    }

    this.result = result;
    this.ikPaths = result.registry.getAll<RVIKPath>('IKPath').map((entry) => entry.instance);
    this.runner = new ContinuousRunner(
      result.transportManager,
      { tick: () => {} },
      this.core,
    );
    this.signalApi.attach(result.signalStore);
    this.fitCamera();
    this.renderOnce();
    this.runNamedDirector();
    return result;
  }

  /** Raw loaded store for diagnostics/tests. Public consumers use signals. */
  get signalStore(): SignalStore | null {
    return this.result?.signalStore ?? null;
  }

  /** Last production loader result, or null before/after a model load. */
  get loadResult(): LoadResult | null {
    return this.result;
  }

  /** Named GLB director selected by the element's director attribute. */
  get namedDirector(): string | null {
    return this.directorName;
  }

  setDirector(name: string | null): void {
    this.director.stop();
    this.directorName = name;
    this.runNamedDirector();
  }

  /** Snap an active director tween and stop choreography before user control. */
  takeOver(): void {
    this.directorController.takeover();
  }

  /**
   * Move a loaded node in the camera plane from a screen-space pointer delta.
   * The write targets the real Object3D local transform used by the engine.
   */
  dragNodeByScreenDelta(
    nodePath: string,
    deltaX: number,
    deltaY: number,
  ): RVEmbedNodeTransformState | null {
    this.assertUsable();
    const node = this.result?.registry.getNode(nodePath);
    if (!node) return null;

    this.sceneCamera.updateMatrixWorld(true);
    node.updateWorldMatrix(true, false);
    const projected = node.getWorldPosition(this.dragProjectionPoint).project(this.sceneCamera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    const width = rect.width || this.width;
    const height = rect.height || this.height;
    projected.x += (2 * finiteDelta(deltaX)) / width;
    projected.y -= (2 * finiteDelta(deltaY)) / height;
    projected.unproject(this.sceneCamera);

    this.dragLocalPoint.copy(projected);
    if (node.parent) {
      node.parent.updateWorldMatrix(true, false);
      node.parent.worldToLocal(this.dragLocalPoint);
    }
    node.position.copy(this.dragLocalPoint);
    node.updateMatrixWorld(true);
    return this.nodeTransformState(nodePath, node);
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get isPlaying(): boolean {
    return this.loopRunning && !this.loop.isPaused;
  }

  get isContextSuspended(): boolean {
    return this.contextSuspended;
  }

  /** Fixed-step count for diagnostics and lifecycle verification. */
  get fixedTickCount(): number {
    return this.tickCount;
  }

  /** Start rendering/integration and release an explicit user pause. */
  play(): void {
    this.assertUsable();
    this.setPaused('embed-user', false);
    this.setPaused('reduced-motion', false);
    if (this.contextSuspended) {
      this.resumeAfterContextRestore = true;
      return;
    }
    this.startLoop();
  }

  /** Pause fixed-step integration while rendering remains interactive. */
  pause(): void {
    if (this.disposed) return;
    this.setPaused('embed-user', true);
  }

  /** Backward-compatible alias for AP1 consumers. */
  resume(): void {
    this.play();
  }

  /** Apply or release a stable lifecycle pause reason. */
  setPaused(reason: string, paused: boolean): void {
    if (this.disposed) return;
    if (this.contextSuspended) {
      if (paused) this.suspendedPauseReasons.add(reason);
      else this.suspendedPauseReasons.delete(reason);
    }
    this.loop.setPaused(reason, paused);
  }

  /**
   * Advance simulation and render manually (tests/measurements, no RAF).
   *
   * Pass `{ render: false }` to advance the simulation WITHOUT drawing a frame.
   * That matters for long headless runs: under SwiftShader a forced
   * `renderer.render()` returns in ~0.25 ms but leaves work that is only
   * settled when the context is destroyed, so `dispose()` later pays ~72 ms per
   * rendered frame — 1200 stepped frames turn into ~90 s of teardown. A test
   * that asserts on simulation state (drives, sensors, MUs) and not on pixels
   * should step render-free and draw once at the end.
   */
  step(dt: number, options?: { render?: boolean }): void {
    this.assertUsable();
    this.fixedUpdate(dt);
    if (options?.render === false) return;
    this.render(dt, true);
  }

  /** Update render size and perspective aspect. */
  resize(width: number, height: number): void {
    if (this.disposed || this.contextSuspended) return;
    this.width = normalizeDimension(width, this.width);
    this.height = normalizeDimension(height, this.height);
    this.renderer.setSize(this.width, this.height, false);
    this.sceneCamera.aspect = this.width / this.height;
    this.sceneCamera.updateProjectionMatrix();
  }

  setDprCap(cap: number): void {
    this.dprCap = normalizeDprCap(cap);
    if (!this.disposed && !this.contextSuspended) this.applyPixelRatio();
  }

  /**
   * Reduce render work while the host page scrolls. State transitions apply
   * pixel ratio once; repeated scroll events do not reset renderer state.
   */
  setScrollPerformanceMode(active: boolean): void {
    if (this.disposed || this.scrollPerformanceMode === active) return;
    this.scrollPerformanceMode = active;
    this.renderFrameInterval = active ? 1 / 30 : 0;
    this.renderAccumulator = 0;
    if (!this.contextSuspended) this.applyPixelRatio();
  }

  setBackground(background: string | null): void {
    this.background = background;
    if (!this.disposed && !this.contextSuspended) this.applyBackground(this.renderer);
  }

  /** Capture the currently rendered scene for the manager's suspended poster. */
  captureFrame(): string | null {
    if (this.disposed || this.contextSuspended) return null;
    try {
      this.renderOnce();
      return this.renderer.domElement.toDataURL('image/webp', 0.82);
    } catch {
      return null;
    }
  }

  /** Reset shared engine registries when simulation ownership changes. */
  resetSharedRegistries(): void {
    if (!this.disposed) resetEmbedEngineRegistries();
  }

  /**
   * Controlled renderer release primitive used by the AP2d vignette manager.
   */
  suspendContext(): void {
    if (this.disposed || this.contextSuspended) return;
    this.contextSuspended = true;
    this.resumeAfterContextRestore = this.loopRunning;
    this.loop.setPaused('offscreen', true);
    this.suspendedPauseReasons.clear();
    for (const reason of this.loop.pauseReasons) this.suspendedPauseReasons.add(reason);
    this.stopLoop();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  /** Recreate renderer/controls after suspendContext and render one frame. */
  resumeContext(canvas?: HTMLCanvasElement, background?: string | null): RehydrateResult {
    this.assertUsable();
    if (!this.contextSuspended) return { firstFrameMs: 0 };
    if (background !== undefined) this.background = background;
    const startedAt = performance.now();
    this.renderer = this.createRenderer(canvas);
    this.controls = this.createControls();
    this.cameraState.controls = this.controls;
    this.cameraState.renderer = this.renderer as never;
    this.loop = this.createLoop();
    for (const reason of this.suspendedPauseReasons) this.loop.setPaused(reason, true);
    this.contextSuspended = false;
    this.renderOnce();
    const firstFrameMs = performance.now() - startedAt;
    this.loop.setPaused('offscreen', false);
    if (this.resumeAfterContextRestore) this.startLoop();
    this.resumeAfterContextRestore = false;
    this.suspendedPauseReasons.clear();
    return { firstFrameMs };
  }

  /** Full terminal teardown. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loadGeneration++;
    this.ownAbortController?.abort();
    this.director.stop();
    this.stopLoop();
    this.cameraManager.cancelCameraAnimation();
    this.controls.dispose();
    if (!this.contextSuspended) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
    }
    this.clearModel();
    this.scene.clear();
    resetEmbedEngineRegistries();
  }

  private createLoop(): SimulationLoop {
    const loop = new SimulationLoop(this.renderer);
    loop.onFixedUpdate = (dt) => this.fixedUpdate(dt);
    loop.onRender = (frameTime) => this.render(frameTime);
    return loop;
  }

  private createRenderer(canvas?: HTMLCanvasElement): WebGLRenderer {
    const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.appliedPixelRatio = this.effectivePixelRatio();
    renderer.setPixelRatio(this.appliedPixelRatio);
    renderer.setSize(this.width, this.height, false);
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    this.applyBackground(renderer);
    return renderer;
  }

  private createControls(): OrbitControls {
    const controls = new OrbitControls(this.sceneCamera, this.renderer.domElement);
    configureOrbitControls(controls);
    controls.update();
    return controls;
  }

  private applyBackground(renderer: WebGLRenderer): void {
    if (this.background === null) renderer.setClearColor(0x000000, 0);
    else renderer.setClearColor(new Color(this.background), 1);
  }

  private effectivePixelRatio(): number {
    const devicePixelRatio = globalThis.devicePixelRatio ?? 1;
    const scrollCap = this.scrollPerformanceMode ? 1 : this.dprCap;
    return Math.min(devicePixelRatio, this.dprCap, scrollCap);
  }

  private applyPixelRatio(): void {
    const pixelRatio = this.effectivePixelRatio();
    if (Math.abs(pixelRatio - this.appliedPixelRatio) < 1e-6) return;
    this.appliedPixelRatio = pixelRatio;
    this.renderer.setPixelRatio(pixelRatio);
  }

  private startLoop(): void {
    if (this.loopRunning) return;
    this.loop.start();
    this.loopRunning = true;
  }

  private stopLoop(): void {
    this.loop.stop();
    this.loopRunning = false;
  }

  private fixedUpdate(dt: number): void {
    if (this.loop.isPaused) return;
    this.tickCount++;
    // SimulationLoop normally suppresses fixed updates while paused. Keep the
    // explicit guard above for manual step() calls used by diagnostics/tests.
    this.directorController.tick(dt);
    if (!this.runner) return;
    this.runner.earlyTick(dt);
    this.runner.tick(dt);
    this.runner.lateTick(dt);
  }

  private render(frameTime: number, force = false): void {
    if (this.disposed || this.contextSuspended) return;
    if (!force && this.renderFrameInterval > 0) {
      this.renderAccumulator += Math.max(0, frameTime);
      if (this.renderAccumulator + Number.EPSILON < this.renderFrameInterval) return;
      this.renderAccumulator %= this.renderFrameInterval;
    } else if (force) {
      this.renderAccumulator = 0;
    }
    this.controls.update();
    this.cameraManager.tickCameraAnimation(frameTime);
    this.renderer.render(this.scene, this.sceneCamera);
  }

  private renderOnce(): void {
    this.render(0, true);
  }

  private fitCamera(): void {
    const box = this.result?.boundingBox;
    if (!box || box.isEmpty()) return;
    const startPose = this.result ? findStartCameraPose(this.result.root) : null;
    if (!startPose) {
      this.applyCameraBounds(box, 1.08, 0);
      return;
    }

    // Preserve the author-selected viewing direction and target, but derive
    // distance from the real motif bounds and current aspect. A fixed authored
    // distance cannot frame both narrow cards and wide website vignettes.
    const target = new Vector3(...startPose.target);
    const direction = new Vector3(...startPose.position).sub(target);
    this.setDirectorCameraPose(this.cameraPoseForBounds(box, 1.08, target, direction));
  }

  private focusCamera(nodePath: string, options: RVEmbedCameraFocusOptions = {}): void {
    this.assertUsable();
    const node = this.result?.registry.getNode(nodePath);
    if (!node) throw new Error(`RVEmbedViewer camera.focus: node not found: ${nodePath}`);
    const box = this.cameraManager.computeNodeBounds([node]);
    if (box.isEmpty()) throw new Error(`RVEmbedViewer camera.focus: node has no render bounds: ${nodePath}`);
    this.applyCameraBounds(
      box,
      Number.isFinite(options.padding) ? Math.max(0.1, options.padding as number) : 1.2,
      Number.isFinite(options.durationMs) ? Math.max(0, options.durationMs as number) : 600,
    );
  }

  private applyCameraBounds(box: Box3, padding: number, durationMs: number): void {
    const pose = this.cameraPoseForBounds(box, padding);
    const position = new Vector3(...pose.position);
    const center = new Vector3(...pose.target);
    if (durationMs > 0) {
      this.cameraManager.animateCameraTo(position, center, durationMs / 1000, 'easeInOut');
    } else {
      this.setDirectorCameraPose(pose);
    }
  }

  private tweenCamera(pose: RVEmbedCameraPose, durationMs: number): void {
    this.assertUsable();
    const position = new Vector3(...pose.position);
    const target = new Vector3(...pose.target);
    const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
    if (duration === 0) {
      this.sceneCamera.position.copy(position);
      this.controls.target.copy(target);
      this.controls.update();
      return;
    }
    this.cameraManager.animateCameraTo(position, target, duration / 1000, 'easeInOut');
  }

  private resolveDirectorCamera(
    action: RVEmbedDirectorCameraAction,
  ): RVEmbedDirectorCameraPose | null {
    this.cameraManager.cancelCameraAnimation();
    if (typeof action === 'string') {
      const preset = this.result
        ? findNamedDirectorValue(this.result.root, action, ['Cameras', 'cameras'])
        : null;
      const presetPose = parseDirectorCameraPose(preset);
      if (presetPose) return presetPose;
      const node = this.result?.registry.getNode(action);
      return node ? this.cameraPoseForNode(node, 1.2) : null;
    }
    if ('focus' in action) {
      const node = this.result?.registry.getNode(action.focus);
      return node
        ? this.cameraPoseForNode(
            node,
            Number.isFinite(action.padding) ? Math.max(0.1, action.padding as number) : 1.2,
          )
        : null;
    }
    return parseDirectorCameraPose(action);
  }

  private cameraPoseForNode(node: Object3D, padding: number): RVEmbedDirectorCameraPose | null {
    const box = this.cameraManager.computeNodeBounds([node]);
    return box.isEmpty() ? null : this.cameraPoseForBounds(box, padding);
  }

  private cameraPoseForBounds(
    box: Box3,
    padding: number,
    targetOverride?: Vector3,
    directionOverride?: Vector3,
  ): RVEmbedDirectorCameraPose {
    const target = targetOverride?.clone() ?? box.getCenter(new Vector3());
    const outward = directionOverride?.clone()
      ?? this.sceneCamera.position.clone().sub(this.controls.target);
    if (outward.lengthSq() < 1e-8) outward.set(0.7, 0.5, 0.7);
    outward.normalize();

    const forward = outward.clone().negate();
    const cameraUp = this.sceneCamera.up.clone().normalize();
    const right = new Vector3().crossVectors(forward, cameraUp);
    if (right.lengthSq() < 1e-8) right.crossVectors(forward, new Vector3(0, 0, 1));
    right.normalize();
    const up = new Vector3().crossVectors(right, forward).normalize();
    const tanVertical = Math.tan((this.sceneCamera.fov * Math.PI / 180) / 2);
    const tanHorizontal = tanVertical * Math.max(this.sceneCamera.aspect, 0.001);
    const margin = Math.max(0.1, padding);
    let distance = this.sceneCamera.near;

    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          const relative = new Vector3(x, y, z).sub(target);
          const forwardOffset = relative.dot(forward);
          distance = Math.max(
            distance,
            Math.abs(relative.dot(right)) * margin / tanHorizontal - forwardOffset,
            Math.abs(relative.dot(up)) * margin / tanVertical - forwardOffset,
            this.sceneCamera.near - forwardOffset,
          );
        }
      }
    }

    const position = target.clone().addScaledVector(outward, distance);
    return {
      position: [position.x, position.y, position.z],
      target: [target.x, target.y, target.z],
    };
  }

  private getDirectorCameraPose(): RVEmbedDirectorCameraPose {
    return {
      position: [
        this.sceneCamera.position.x,
        this.sceneCamera.position.y,
        this.sceneCamera.position.z,
      ],
      target: [
        this.controls.target.x,
        this.controls.target.y,
        this.controls.target.z,
      ],
    };
  }

  private setDirectorCameraPose(pose: RVEmbedDirectorCameraPose): void {
    this.cameraManager.cancelCameraAnimation();
    this.sceneCamera.position.set(...pose.position);
    this.controls.target.set(...pose.target);
    this.controls.update();
  }

  private projectDirectorNode(node: Object3D): readonly [number, number] {
    const point = node.getWorldPosition(this.directorProjectionPoint).project(this.sceneCamera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    const width = rect.width || this.width;
    const height = rect.height || this.height;
    return [
      (point.x * 0.5 + 0.5) * width,
      (-point.y * 0.5 + 0.5) * height,
    ];
  }

  private nodeTransformState(nodePath: string, node: Object3D): RVEmbedNodeTransformState {
    return {
      nodePath,
      position: this.projectDirectorNode(node),
      transform: [node.position.x, node.position.y, node.position.z],
    };
  }

  private runNamedDirector(): void {
    if (!this.result || !this.directorName || this.disposed) return;
    const script = findNamedDirectorValue(
      this.result.root,
      this.directorName,
      ['Scripts', 'scripts', 'Directors', 'directors'],
    );
    if (script) {
      this.director.run(script as RVEmbedDirectorScript);
      return;
    }
    const error = new Error(`RVEmbedDirector script not found in rv_extras: ${this.directorName}`);
    this.directorEvents?.error?.({
      error,
      message: error.message,
      recoverable: false,
      step: { loop: false },
      index: -1,
      iteration: 0,
    });
  }

  private clearModel(): void {
    const current = this.result;
    this.signalApi?.attach(null);
    this.runner = null;
    this.ikPaths = [];
    this.result = null;
    if (!current) return;
    this.disposeLoadResult(current);
  }

  private disposeLoadResult(loadResult: LoadResult): void {
    try { loadResult.playback?.stop(); } catch { /* continue teardown */ }
    try { loadResult.logicEngine?.reset(); } catch { /* continue teardown */ }
    try { loadResult.transportManager.reset(); } catch { /* continue teardown */ }
    disposeComponentsInSubtree(loadResult.registry, loadResult.root);
    loadResult.registry.clear();
    loadResult.signalStore.clear();
    loadResult.root.parent?.remove(loadResult.root);
    disposeObjectResources(loadResult.root);
  }

  private assertUsable(): void {
    if (this.disposed || this.lifecycleSignal.aborted) {
      throw new Error('RVEmbedViewer is disposed');
    }
  }
}

function normalizeDprCap(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) > 0 ? value as number : 1.5;
}

function normalizeDimension(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.round(value as number) : fallback;
}

function finiteDelta(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function disposeObjectResources(root: LoadResult['root']): void {
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const meshMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of meshMaterials) {
      if (!material) continue;
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof Texture) textures.add(value);
      }
    }
  });
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}

function findNamedDirectorValue(
  root: Object3D,
  name: string,
  collectionKeys: readonly string[],
): unknown {
  let found: unknown;
  root.traverse((node) => {
    if (found !== undefined) return;
    const rv = node.userData?.realvirtual;
    if (!isRecord(rv)) return;
    for (const directorKey of ['Director', 'director', 'DirectorScripts', 'directorScripts']) {
      const director = rv[directorKey];
      if (!isRecord(director)) continue;
      for (const collectionKey of collectionKeys) {
        const collection = director[collectionKey];
        const value = findNamedValue(collection, name);
        if (value !== undefined) {
          found = value;
          return;
        }
      }
      const direct = findNamedValue(director, name);
      if (direct !== undefined) {
        found = direct;
        return;
      }
    }
  });
  return found;
}

function findNamedValue(container: unknown, name: string): unknown {
  if (isRecord(container) && name in container) return container[name];
  if (!Array.isArray(container)) return undefined;
  const entry = container.find((candidate) => (
    isRecord(candidate)
    && (candidate.name === name || candidate.Name === name)
  ));
  if (!isRecord(entry)) return undefined;
  return entry.steps ?? entry.Steps ?? entry.script ?? entry.Script;
}

function parseDirectorCameraPose(value: unknown): RVEmbedDirectorCameraPose | null {
  if (!isRecord(value)) return null;
  const position = parseDirectorVector3(value.position ?? value.Position);
  const target = parseDirectorVector3(value.target ?? value.Target);
  return position && target ? { position, target } : null;
}

function findStartCameraPose(root: Object3D): RVEmbedDirectorCameraPose | null {
  let found: RVEmbedDirectorCameraPose | null = null;
  root.traverse((node) => {
    if (found) return;
    const rv = node.userData?.realvirtual;
    if (!isRecord(rv)) return;
    const component = rv.StartCameraPosition;
    if (!isRecord(component) || component._enabled === false) return;
    found = parseDirectorCameraPose(component);
  });
  return found;
}

function parseDirectorVector3(value: unknown): readonly [number, number, number] | null {
  if (
    Array.isArray(value)
    && value.length === 3
    && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  ) {
    return [value[0], value[1], value[2]];
  }
  if (
    isRecord(value)
    && [value.x, value.y, value.z].every((entry) => (
      typeof entry === 'number' && Number.isFinite(entry)
    ))
  ) {
    return [value.x as number, value.y as number, value.z as number];
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
