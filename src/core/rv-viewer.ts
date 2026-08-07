// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVViewer — Public facade for the realvirtual Web Viewer core.
 *
 * Single entry point that owns the Three.js scene, simulation loop, and all
 * core subsystems. Framework-agnostic: no React, no MUI. Custom UIs bind
 * to this class via events and direct property access.
 *
 * Usage:
 *   const viewer = new RVViewer(document.getElementById('app'));
 *   await viewer.loadModel('./models/demo.glb');
 *   viewer.signalStore?.subscribe('ConveyorStart', console.log);
 *   viewer.on('object-hover', (data) => console.log(data?.path));
 */

import {
  Scene,
  PerspectiveCamera,
  OrthographicCamera,
  WebGLRenderer,
  AmbientLight,
  DirectionalLight,
  Color,
  Vector2,
  Vector3,
  Box3,
  Object3D,
  Mesh,
  MeshStandardMaterial,
  NoToneMapping,
  CanvasTexture,
  Spherical,
  Texture,
  Matrix4,
  Frustum,
  Plane,
} from 'three';
import type { Renderer } from 'three/webgpu';
import { preloadTslMaterials, createMaterialContext, type RendererKind } from './engine/materials/material-factory';
import type { TslPostPipeline } from './engine/materials/rv-post-processing-tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  applyNavigationSettingsToControls,
  configureOrbitControls,
} from './engine/rv-orbit-controls-config';
import type { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import type { AOMode } from './hmi/visual-settings-store';
import { PostProcessingManager, type PostProcessingHost } from './rv-post-processing';
import { RVToonMaterialManager } from './rv-toon-materials';
import { ThumbnailService } from './thumbnails/thumbnail-service';
import { createGroundFade, drawCheckerPattern } from './engine/rv-ground-plane';
import { createGroundReflector, setReflectorStrength, setReflectorBlur } from './engine/rv-ground-reflector';
import type { Reflector } from 'three/addons/objects/Reflector.js';
import type { ToneMappingType, ShadowQuality, ProjectionType, VisualSettings } from './hmi/visual-settings-store';
import {
  loadVisualSettings,
  getSourceMarkersVisible,
  setSourceMarkersVisible as setSourceMarkersVisibleStore,
  subscribeSourceMarkersVisible,
  getVanishMUs,
  setVanishMUs as setVanishMUsStore,
  subscribeVanishMUs,
} from './hmi/visual-settings-store';
import { CameraManager, type ViewportOffset } from './rv-camera-manager';
import type { FollowSource } from './engine/rv-follow-source';
import { VisualSettingsManager } from './rv-visual-settings-manager';
import { getRenderMode, type RenderMode } from './rv-render-modes';
import Stats from 'stats-gl';

import { EventEmitter } from './rv-events';
import { bumpModelCatalog } from './rv-model-catalog';
import { debug, logInfo } from './engine/rv-debug';
import { createLoadProfiler } from './engine/rv-load-profiler';
import { loadModelSettingsConfig } from './hmi/rv-settings-bundle';
import { DRAG_THRESHOLD_PX, DEFAULT_DPR_CAP, NO_AO_LAYER } from './engine/rv-constants';
import {
  loadGLB,
  computeBVHAsync,
  createRuntimeNode,
  removeRuntimeNode,
  initializeComponents,
  runOnSceneReady,
  type DeferredLogic,
  type LoadResult,
  type RuntimeNodeSpec,
} from './engine/rv-scene-loader';
import { BatchVisibilityService } from './engine/rv-batch-visibility';
import { createBVHPort, type BVHBuildPort } from './engine/rv-bvh-build-port';
import type { RVExtrasOverlay } from './engine/rv-extras-overlay-store';
import type { RvScene } from './hmi/scene/rv-scene-types';
import type { PublishedSceneEntry } from './hmi/scene/rv-published-scenes';
import type { PlacementsSnapshot } from './rv-shared-types';
import type { MultiuserSnapshot } from '../plugins/multiuser-plugin';
import type { McpBridgeSnapshot } from '../plugins/mcp-bridge-plugin';
import { buildRaycastGeometries, collectPendingBVHGeometries, disposeRaycastGeometries, refitRaycastGroupsForSubtrees, type RaycastGeometrySet } from './engine/rv-raycast-geometry';
import { InstancePickIndex } from './engine/rv-instance-pick-index';
import { ProxyOverlayProvider } from './engine/rv-highlight-proxy';
import { PickMetrics, type PickMetricsSnapshot } from './engine/rv-pick-metrics';
import {
  loadModelJsonConfig,
  extractGlbPluginConfig,
  mergeModelConfig,
  type ModelConfig,
} from './engine/rv-model-config';
import { loadExternalPlugin } from './engine/rv-plugin-loader';
import { importProviderRegistry, type ImportProviderRegistry } from './import/rv-import-provider';
import { importObject as importObjectSink, type ImportObjectOptions, type ImportObjectOutcome } from './import/rv-import-object';
import type { ImportResultItem } from './import/rv-import-provider';
import { resolveModelName, type ModelPluginManager } from './rv-model-plugin-manager';
import {
  isSignatureUnlocked,
  persistSignatureUnlock,
  resetSignatureUiState,
  setSignatureUiState,
} from './rv-sig-store';
import type { SignatureState } from './persistence/rv-sig-verify';
import { SimulationLoop } from './engine/rv-simulation-loop';
import {
  RenderBackendController,
  pushRenderBackendDriveValue,
  readDriveBridgeValue,
  type RenderBackendId,
  type RenderBackendStatus,
  type RenderBackendFactory,
  type RenderBackendDriveBridgeConfig,
} from './render-backend/rv-render-backend';
import { SimulationRuntime } from './engine/rv-simulation-runtime';
import { CoreSubsystems } from './engine/rv-core-subsystems';
import { RVHighlightManager } from './engine/rv-highlight-manager';
import { showStatusOutline, hideStatusOutline } from './engine/rv-status-outline';
import { RVOutlineManager } from './engine/rv-outline-manager';
import { RaycastManager, type ObjectHoverData, type ObjectUnhoverData, type ObjectClickData, type HoverableType } from './engine/rv-raycast-manager';
import type { RVDrive } from './engine/rv-drive';
import type { RVTransportManager } from './engine/rv-transport-manager';
import type { SignalStore } from './engine/rv-signal-store';
import type { RVDrivesPlayback } from './engine/rv-drives-playback';
import type { RVReplayRecording } from './engine/rv-replay-recording';
import type { RVLogicEngine } from './engine/rv-logic-engine';
import type { RVIKPath } from './engine/rv-ik-path';
import type { NodeRegistry, NodeSearchResult } from './engine/rv-node-registry';
import { TankFillManager } from './engine/rv-tank-fill';
import { PipeFlowManager } from './engine/rv-pipe-flow';
import { GizmoOverlayManager } from './engine/rv-gizmo-manager';
import { LampManager } from './engine/rv-lamp-manager';
import { RVCollisionManager } from './engine/rv-collision-manager';
import { EnergyChainManager } from './engine/rv-energy-chain-manager';
import {
  registerOverlayProducer, resetOverlayProducers,
  isOverlayVisible, subscribeOverlayVisibility,
} from './overlay-visibility-store';
import { SignalBindingManager } from './engine/rv-signal-binding-manager';
import {
  resetSlotAuthority,
  setAuthorityRanking,
  type AuthorityRanking,
} from './engine/rv-slot-authority';
import type { SignalWriteGateMode } from './engine/rv-signal-store';
import { ErrorStore } from './engine/rv-error-store';
import { InstructionRuntimeStore } from './engine/rv-instruction-runtime-store';
import { ComponentEventDispatcher } from './engine/rv-component-event-dispatcher';
import type { GroupRegistry } from './engine/rv-group-registry';
import { AutoFilterRegistry } from './engine/rv-auto-filter-registry';
import {
  ISOLATE_FOCUS_LAYER,
  HIGHLIGHT_OVERLAY_LAYER,
  disableOverlayLayers,
  setOverlayLayersOnly,
} from './engine/rv-group-registry';
import {
  detectActiveGPU, enumerateOtherAdapters, isSameAsActive,
  analyzeGPU,
  type GPUInfo, type GPUAnalysis,
} from './engine/rv-gpu-info';
import { registerFilterSubscriber, loadSearchSettings, isTypeEnabled } from './hmi/search-settings-store';
import { getTypesWithCapability, getRegisteredCapabilities } from './engine/rv-component-registry';
import type { RVViewerPlugin } from './rv-plugin';
import type { ViewerEvents } from './rv-viewer-events';
import type { ViewerHost } from './engine/rv-viewer-host';
import { UIPluginRegistry } from './rv-ui-registry';
import { LeftPanelManager } from './hmi/left-panel-manager';
import { SelectionManager } from './engine/rv-selection-manager';
import type { RVHighlightPolicy } from './engine/rv-highlight-policy';
import { ContextMenuStore } from './hmi/context-menu-store';
import type { ContextMenuTarget } from './hmi/context-menu-store';
import type { SelectionSnapshot } from './engine/rv-selection-manager';
import { isMobileDevice } from '../hooks/use-mobile-layout';
import { resetDynamicContexts, setContext } from './hmi/ui-context-store';
import { ModeManager, computeModePluginSets, modeContext, pluginParticipatesInMode } from './rv-mode-manager';
import type { ModeId, ModeHost, ModePluginSets } from './rv-mode-manager';
import { getAppConfig } from './rv-app-config';
import { PluginContextImpl } from './rv-plugin-context';
import { SceneFacadeImpl } from './facades/scene-facade';
import { CameraFacadeImpl } from './facades/camera-facade';
import { ControlsFacadeImpl } from './facades/controls-facade';
import { SimLoopFacadeImpl } from './facades/sim-loop-facade';
import { TickStage } from './rv-tick-stages';
import { BehaviorManager } from './behaviors';
import { ContinuousRunner } from './material-flow/continuous-runner';
import { SimulationKernel } from './material-flow/simulation-kernel';
import { StatisticsManager } from './material-flow/rv-statistics-manager';
// Plan 194 P5 — the DES runner factory is INJECTED, never imported concretely:
// `@rv-private/plugins/des/register-des-runner` resolves to the private factory
// when the private folder is present, and to the public stub (`createDesRunner
// = null`) otherwise. So `hasDesRunner()` is true only in the private build and
// the public build stays continuous-only with no private import leaked.
import { createDesRunner } from '@rv-private/plugins/des/register-des-runner';
import {
  applyKinematicsSpec,
  createBindContext,
  type KinematicsSpec,
  type KinematizeReport,
  type RVBindContext,
  type BindContextHost,
} from './behavior-runtime';

export { applyNavigationSettingsToControls } from './engine/rv-orbit-controls-config';

// Base scene-background grayscale (0x9a9a9a / 255 ≈ 0.604). Multiplied by
// backgroundBrightness so brightness=1 reproduces the original default color.
const BG_BASE_SCALAR = 0x9a / 255;

// ─── Ground fade geometry ────────────────────────────────────────────────
// The floor is a square plane carrying a CIRCULAR alpha map: opaque disc in
// the middle, linear radial fade to transparent at the inscribed-circle edge.
//
// Both the plane SIZE and the alpha-map opaque/fade split are keyed off these
// constants (expressed as multiples of the model's half-extent in X/Z) so the
// two always stay in sync — change one number and the disc layout updates.
//   - FLOOR_FADE_START: world radius where the fade starts (opaque inside).
//   - FLOOR_FADE_END:   world radius where the fade reaches zero alpha.
// A long, gentle fade reads better than a hard cut — hence END >> START.
const FLOOR_FADE_START_RATIO = 1.5;  // × model max half-extent
const FLOOR_FADE_END_RATIO   = 6.0;  // × model max half-extent (fade length = 4.5×)

// Minimum floor full-extent (metres) for AUTHORING contexts (empty scene /
// layout planner). Keeps a freshly-emptied scene or a layout that only holds a
// few small parts from sitting on a tiny checker disc. Matches the synthesized
// empty-playground extent (see loadModel's empty-bbox branch) so an empty
// workspace and one holding a single small part read at the same scale.
// NOT applied to plain model loads — those keep an exact model fit so existing
// demo-scene framing is unchanged.
const MIN_AUTHORING_GROUND_EXTENT = 15;

// ─── Plugin Error Isolation ──────────────────────────────────────────────

/**
 * Call a plugin method with error isolation. If the method doesn't exist
 * or throws, the error is logged with the plugin's ID and swallowed.
 * Exported for unit testing — only used internally by RVViewer.
 */
export function callPlugin(
  plugin: RVViewerPlugin,
  method: string,
  ...args: unknown[]
): void {
  const fn = (plugin as unknown as Record<string, unknown>)[method];
  if (typeof fn !== 'function') return;
  try {
    fn.apply(plugin, args);
  } catch (e) {
    console.error(`[RVViewer] Plugin '${plugin.id}' ${method} error:`, e);
  }
}

// ─── Public Types ───────────────────────────────────────────────────────

// Re-export ViewportOffset from CameraManager (public API backward compat)
export type { ViewportOffset } from './rv-camera-manager';

// Re-export extracted subsystems for backwards compatibility (plan-177 phase 7)
export { PostProcessingManager } from './rv-post-processing';
export type { PostProcessingHost } from './rv-post-processing';
export { createGroundFade, drawCheckerPattern } from './engine/rv-ground-plane';

/** @deprecated Import from './rv-viewer-events' directly. Re-exported here for
 *  backward compatibility with existing hooks; will be removed in a future major. */
export type { ViewerEvents } from './rv-viewer-events';

// SceneSource (discriminated union of GLB vs. Layout) was retired in favour of
// the unified `RvScene` model. The viewer now only deals with `RvScene`
// records — see `src/core/hmi/scene/rv-scene-types.ts`. Translation between
// any external API shapes and `RvScene` happens in `SceneStore`.

// Re-export so embedders can type `RVViewerOptions.renderer` without reaching
// into the engine/materials folder (plan-271).
export type { RendererKind } from './engine/materials/material-factory';

/** Classification of the registration site that contributed a plugin. */
export type PluginOrigin = 'core' | 'commercial' | 'internal' | 'project' | 'unknown';

export interface RVViewerOptions {
  /**
   * Renderer selection (plan-271):
   *  - 'webgl'    — classic WebGLRenderer (default, production path)
   *  - 'webgpu'   — real WebGPU backend (falls back to WebGL if unavailable)
   *  - 'webgpu-gl'— WebGPURenderer({ forceWebGL: true }): TSL on a WebGL2
   *                 context (internal test path, needs NO WebGPU adapter)
   * Takes precedence over the deprecated `useWebGPU` alias.
   */
  renderer?: RendererKind;
  /** @deprecated Use `renderer: 'webgpu'` instead (`useWebGPU: true` ≙ `renderer: 'webgpu'`). */
  useWebGPU?: boolean;
  /** Show checkerboard ground plane. Default: true */
  ground?: boolean;
  /** Auto-resize on window resize. Default: true */
  autoResize?: boolean;
  /** Enable native MSAA antialiasing (constructor-only, requires page reload to change). Default: false */
  antialias?: boolean;
  /** Enable Signal Linking (bind component signal slots to live realvirtual
   *  CONNECT signals or internal model signals → live override). Despite the
   *  historical name, since plan-325 this flag gates signal linking for ALL
   *  components (inline inspector rows + badge popover), not just Planner
   *  elements. When false/unset, no SignalBindingManager is created, no badges,
   *  no guards active → identical legacy behavior. The structural decoupling of
   *  the authority service from this flag belongs to plan-320 Phase 2.
   *  Default: false */
  plannerSignalLinking?: boolean;
  /**
   * Remote-vs-force ranking (plan-320 Phase 3). 'strict' (default) lets an
   * active remote session owner override operator forces
   * (`remote > forced > bound > component`); 'legacy' restores the
   * pre-plan-320 `forced > remote` behavior as a pure rollback lever.
   */
  authorityRanking?: AuthorityRanking;
  /**
   * Slot write gate (plan-320 Phase 4). Default 'shadow': authority conflicts
   * are only recorded (`SignalStore.getWriteConflicts()`), nothing is
   * rejected. 'enforce' is prepared but not part of the plan-320 rollout.
   */
  signalWriteGate?: SignalWriteGateMode;
}

/** Success/failure contract for model loaders that surface errors without throwing. */
export type ModelLoadOutcome =
  | { ok: true }
  | { ok: false; error: string };

// ─── RVViewer ───────────────────────────────────────────────────────────

// Compile-time assertion: RVViewer must satisfy ViewerHost contract.
// Phase 2 of plan-182. If this fails, RVViewer broke the contract used by
// engine/rv-component-event-dispatcher and engine/rv-selection-manager.
type _RVViewer_satisfies_ViewerHost = RVViewer extends ViewerHost ? true : false;
const _rvViewerHostCheck: _RVViewer_satisfies_ViewerHost = true;
void _rvViewerHostCheck;  // suppress unused-warning

export type LogicRunState = 'active' | 'gated' | 'activating';

export class RVViewer extends EventEmitter<ViewerEvents> {
  // --- Three.js context (read-only for custom UIs) ---
  /**
   * @deprecated Phase 4b of plan-182: prefer typed helpers like `viewer.eachNode(fn)`
   * or `viewer.projectToScreen(node)` over direct `viewer.scene` access. Only ~15
   * core plugins (WebXR, layout-planner, annotation, fpv, etc.) have a legitimate
   * reason to use the raw Scene — those are whitelisted in plan-182 section 2.7.2.
   */
  readonly scene: Scene;
  private perspCamera!: PerspectiveCamera;
  private orthoCamera!: OrthographicCamera;
  private _activeCamera!: PerspectiveCamera | OrthographicCamera;
  /**
   * @deprecated Phase 4b of plan-182: prefer `viewer.getCameraState()` for reads,
   * `viewer.animateCameraTo()` for navigation. Direct camera access is only for
   * plugins handling custom view modes (FPV, WebXR, multiuser sync).
   */
  get camera(): PerspectiveCamera | OrthographicCamera { return this._activeCamera; }
  /**
   * @deprecated Phase 4b of plan-182: renderer access is only for plugins needing
   * `renderer.domElement` for raycasting/event-listeners (annotation, measurement,
   * fpv). Most HMI code should not access this directly.
   */
  readonly renderer: Renderer;
  /**
   * @deprecated Phase 4b of plan-182: prefer `viewer.setControlsConfig({...})` for
   * Settings-panel writes. Direct control access is only for plugins managing
   * drag-mode conflicts (layout-planner, annotation, measurement).
   */
  readonly controls: OrbitControls;
  readonly loop: SimulationLoop;

  /**
   * Optional swappable 3D render backend (plan-256). Default `three`; an
   * internal-tier Omniverse RTX-stream backend can take over the 3D pixels
   * while HMI/SignalStore/adapters stay identical. Owns the `renderPaused`
   * flag consulted by `render()` — pausing the Three renderer NEVER touches
   * the simulation loop or the signal flush (render-pause ≠ sim-pause).
   */
  private readonly _renderBackends = new RenderBackendController();

  // Omniverse connection config (opaque bag forwarded to the private backend
  // factory) + drive-bridge push config (plan-256). Both DEV/internal only.
  private _omniverseBackendConfig: Record<string, unknown> = {};
  private _omniverseDriveBridge: RenderBackendDriveBridgeConfig = { enabled: false };

  private stats!: Stats;
  private statsReady = false;
  /** Which renderer create() actually constructed (plan-271): 'webgl'
   *  (classic WebGLRenderer), 'webgpu-gl' (WebGPURenderer with forceWebGL —
   *  WebGL2 backend), or 'webgpu' (real WebGPU backend). */
  readonly rendererKind: RendererKind;
  /** True for BOTH WebGPURenderer variants ('webgpu-gl' AND 'webgpu'), i.e.
   *  "not the classic WebGLRenderer". Derived as `rendererKind !== 'webgl'`
   *  (plan-271 review finding 1) — NOT the real backend! All GLSL /
   *  onBeforeCompile / composer / XR / reflector code paths must be off when
   *  this is true. For compute()/diagnostics use `hasCompute`. */
  readonly isWebGPU: boolean;
  /** True ONLY when the real WebGPU backend is active (former _detectWebGPU()
   *  semantics) — the gate for TSL compute() and GPU diagnostics. */
  readonly hasCompute: boolean;

  /** Whether native MSAA antialiasing is active (set at renderer creation, cannot change at runtime). */
  private _antialiasActive = false;
  /** Whether native MSAA antialiasing is active on the current renderer. */
  get antialiasActive(): boolean { return this._antialiasActive; }

  // --- Delegated Managers (internal implementation detail) ---
  /** @internal Camera projection, animation, and viewport offset logic. */
  private _cameraManager!: CameraManager;
  /** @internal Lighting, tone mapping, shadows, DPR settings. */
  private _visualSettings!: VisualSettingsManager;

  // --- Highlight system (always available) ---
  readonly highlighter: RVHighlightManager;

  // --- Outline system (post-process OutlinePass; WebGL only) ---
  /** Plugin-driven OutlinePass wrapper. `available` is false on WebGPU. */
  readonly outlineManager: RVOutlineManager;

  // --- Generic gizmo overlay system (always available) ---
  /** Central 3D-overlay/gizmo system. Used by WebSensor and other components. */
  readonly gizmoManager: GizmoOverlayManager;
  /** Viewer-owned registry for Lamp lifecycle and fixed-update flashing. */
  readonly lampManager: LampManager;
  /** Viewer-owned registry for EnergyChain rigs and their per-frame bone update. */
  readonly energyChainManager: EnergyChainManager;
  /** Viewer-owned collision registry + per-tick check (plan-394). Survives model
   *  loads; `clear()` on every model switch drops registry, highlight, signals
   *  and an open modal. */
  readonly collisionManager: RVCollisionManager;

  // --- Planner Signal Linking (gated by RVViewerOptions.plannerSignalLinking) ---
  /** Binding/override engine that links placed Planner elements to live CONNECT
   *  signals. `null` when the feature flag is off (no manager, no guards).
   *  (Re)built per model load once signalStore + registry exist. */
  signalBindingManager: SignalBindingManager | null = null;
  /** Cached feature-flag from RVViewerOptions. */
  private readonly _plannerSignalLinking: boolean = false;
  /** Write-gate mode applied to every per-model SignalStore (plan-320 Phase 4). */
  private _signalWriteGate: SignalWriteGateMode = 'shadow';

  // --- Error/alarm registry (always available) ---
  /** Central error registry — single source of truth for active errors.
   *  Singleton that survives model loads; emptied on model switch by the
   *  web-error plugin's onModelCleared hook. Used by WebError + error panel. */
  readonly errorStore: ErrorStore = new ErrorStore();

  // --- Runtime-instruction registry (always available) ---
  /** Central runtime-instruction registry — single source of truth for active
   *  CustomRuntimeInstruction cards. Singleton that survives model loads; emptied
   *  on model switch by the instruction panel plugin's onModelCleared hook. */
  readonly instructionStore: InstructionRuntimeStore = new InstructionRuntimeStore();

  // --- Component event dispatcher (routes viewer events → per-component callbacks) ---
  /** Dispatches object-hover/clicked/selection-changed to RVComponent.onHover/onClick/onSelect. */
  componentEventDispatcher: ComponentEventDispatcher | null = null;

  /** Single source of truth for whether model-authored logic may execute. */
  logicRunState: LogicRunState = 'active';
  private _signatureState: SignatureState = 'none';
  private _signatureModelName = '';
  private _signatureSignerOrganization: string | undefined;
  private _deferredLogic: DeferredLogic[] = [];

  // --- Simulation Runtime + Connection State ---
  /**
   * Unified simulation-runtime facade — the single owner of "is simulation
   * time integrating at all, and under which execution mode". Fronts the
   * loop's pause reasons, the kernel's continuous/discrete executor mode, and
   * the global connection state. Workspace modes registered with
   * `runtime: 'detached'` (e.g. the asset editor) fully detach time
   * integration (see `'runtime-attach-changed'`); the viewer wires that
   * transition on `'mode-changed'` in the constructor.
   */
  readonly runtime: SimulationRuntime = new SimulationRuntime({
    getLoop: () => this.loop,
    getKernel: () => this._getKernel(),
    emit: (event, data) => { this.emit(event, data); },
  });

  /** Current connection state ('Connected' or 'Disconnected'). */
  get connectionState(): 'Connected' | 'Disconnected' { return this.runtime.connectionState; }

  /**
   * Set the global connection state. Notifies all plugins and emits
   * 'connection-state-changed' event. Subsystems are guarded in fixedUpdate().
   * State lives on the SimulationRuntime; orchestration stays here.
   */
  setConnectionState(state: 'Connected' | 'Disconnected'): void {
    const previous = this.runtime.connectionState;
    if (!this.runtime._setConnectionState(state)) return;

    // Notify plugins (skip disabled)
    for (const p of this._plugins) {
      if (this._disabledIds.has(p.id)) continue;
      callPlugin(p, 'onConnectionStateChanged', state, this);
    }

    this.emit('connection-state-changed', { state, previous });
  }

  // ─── Render Backend (plan-256) ───────────────────────────────────────
  //
  // Optional swappable 3D render backend. `three` (default) uses the Three.js
  // pipeline below unchanged; a non-Three backend (Omniverse RTX stream,
  // internal tier) provides the 3D pixels while HMI/SignalStore/adapters stay
  // identical. CRITICAL: pausing the Three renderer must NOT stop the sim loop
  // or the WS signal-flush — see rv-render-backend.ts header.

  /** Currently active 3D render backend (`three` | `omniverse`). */
  get renderBackend(): RenderBackendId { return this._renderBackends.backend; }

  /** Status of the active non-Three backend (`idle` while Three is active). */
  get renderBackendStatus(): RenderBackendStatus { return this._renderBackends.status; }

  /** Human-readable detail for the current render-backend status (progress/error line). */
  get renderBackendStatusDetail(): string { return this._renderBackends.statusDetail; }

  /**
   * Pause ONLY the Three renderer: `render()` skips its `renderer.render(...)`
   * calls and the WebGL canvas is hidden. The simulation loop, `fixedUpdate`,
   * SignalStore and all adapters keep running unchanged — this is deliberately
   * separate from the sim-pause mechanisms (`isSimulationPaused()` etc.).
   */
  pauseRendering(): void {
    this._renderBackends.pauseRendering();
    this._syncCanvasVisibility();
  }

  /** Resume the Three renderer previously paused by {@link pauseRendering}. */
  resumeRendering(): void {
    this._renderBackends.resumeRendering();
    this._syncCanvasVisibility();
    this._renderDirty = true;
  }

  /**
   * Register a factory for a non-Three render backend. Called from the private
   * internal tier (internal-plugins.ts) behind `__RV_INTERNAL__`; the public
   * build has no factories, so `setRenderBackend('omniverse')` rejects.
   */
  registerRenderBackendFactory(id: RenderBackendId, factory: RenderBackendFactory): void {
    this._renderBackends.registerFactory(id, factory);
  }

  /** Whether a backend is available (`three` always; others once registered). */
  hasRenderBackend(id: RenderBackendId): boolean {
    return this._renderBackends.hasBackend(id);
  }

  /**
   * Switch the active 3D render backend. Switching to a non-Three backend
   * pauses the Three renderer (canvas hidden, GPU render skipped), mounts the
   * backend overlay into the viewer container, and neutralises the interactive
   * 3D plugins (central `onRender`-skip + canvas hide, plus the explicit
   * `onRenderBackendChanged` plugin hook). The simulation keeps running.
   */
  async setRenderBackend(id: RenderBackendId): Promise<void> {
    const domEl = this.renderer.domElement as HTMLElement;
    const container = (domEl.parentElement ?? domEl) as HTMLElement;
    await this._renderBackends.setBackend(id, container);
    this._syncCanvasVisibility();
    this._renderDirty = true;

    // Explicit per-plugin signal on top of the central neutralisation.
    for (const p of this._plugins) {
      if (this._disabledIds.has(p.id)) continue;
      callPlugin(p, 'onRenderBackendChanged', id, this);
    }

    // "Weg A" (plan-256): switching to a streamed backend exports the CURRENTLY
    // loaded scene to it — the GLB stays SSOT, the backend projects it (Kit:
    // GLB→USD via asset_converter). Fire-and-forget; status is surfaced via the
    // render-backend status/detail.
    if (id === 'omniverse') void this._exportCurrentSceneToBackend();
  }

  /** Send the current model's GLB URL to the active backend's `loadGlb` (if any). */
  private async _exportCurrentSceneToBackend(): Promise<void> {
    const backend = this._renderBackends.active;
    if (!backend?.loadGlb) return;
    const url = this._currentModelUrl;
    if (!url) return;
    // The render side fetches the GLB by URL, so it must be an absolute http(s)
    // URL — a blob:/data: URL is browser-only and cannot be exported (yet).
    let abs: string;
    try { abs = new URL(url, window.location.href).href; } catch { return; }
    if (abs.startsWith('blob:') || abs.startsWith('data:')) {
      console.warn('[rv-viewer] current model is a local blob/data URL — cannot export to Omniverse (needs a fetchable http URL)');
      return;
    }
    try {
      await backend.loadGlb(abs, { addLights: true });
    } catch (e) {
      console.warn('[rv-viewer] Omniverse scene export failed:', e);
    }
  }

  /** Subscribe to render-backend switches. Returns an unsubscribe function. */
  onRenderBackendChange(cb: (b: RenderBackendId) => void): () => void {
    return this._renderBackends.onBackendChange(cb);
  }

  /** Subscribe to render-backend status changes. Returns an unsubscribe function. */
  onRenderBackendStatusChange(cb: (s: RenderBackendStatus) => void): () => void {
    return this._renderBackends.onStatusChange(cb);
  }

  /** Show/hide the WebGL canvas to match the current render-pause state. */
  private _syncCanvasVisibility(): void {
    const canvas = this.renderer.domElement as HTMLElement;
    canvas.style.display = this._renderBackends.shouldRenderThree() ? 'block' : 'none';
  }

  /**
   * Opaque connection config forwarded to the (private) Omniverse backend
   * factory at construction time (signalingPort, mediaServer, resolution, drive
   * defaults, …). Edits apply on the NEXT `setRenderBackend('omniverse')`.
   * Internal tier only; ignored when no omniverse factory is registered.
   */
  get omniverseBackendConfig(): Record<string, unknown> { return this._omniverseBackendConfig; }

  /** Merge fields into the Omniverse backend connection config. */
  setOmniverseBackendConfig(cfg: Record<string, unknown>): void {
    this._omniverseBackendConfig = { ...this._omniverseBackendConfig, ...cfg };
  }

  /** Per-tick WEB→backend drive-bridge config (plan-256). */
  get omniverseDriveBridge(): RenderBackendDriveBridgeConfig { return this._omniverseDriveBridge; }

  /** Merge fields into the drive-bridge config (source signal/drive, payload opts). */
  setOmniverseDriveBridge(cfg: Partial<RenderBackendDriveBridgeConfig>): void {
    this._omniverseDriveBridge = { ...this._omniverseDriveBridge, ...cfg };
  }

  /**
   * Additive per-tick push (plan-256): while a non-Three backend is active,
   * mirror one local value (first Drive's `currentPosition`, or a configured
   * signal) to the streamed 3D prim via the backend's `sendDriveValue`. The
   * Three path and the signal flush are untouched; the backend dirty-guards.
   */
  private _pushRenderBackendDriveValue(): void {
    // Fast-path: nothing to do while Three is active (avoids per-tick work).
    if (this._renderBackends.backend === 'three') return;
    const cfg = this._omniverseDriveBridge;
    pushRenderBackendDriveValue(
      this._renderBackends,
      cfg,
      () => readDriveBridgeValue(cfg, this.drives, this.signalStore),
    );
  }

  // --- Simulation state (populated after loadModel) ---
  signalStore: SignalStore | null = null;
  registry: NodeRegistry | null = null;
  drives: RVDrive[] = [];
  /** Robot IK paths (replay engine) — ticked before the drive loop each fixed step. */
  ikPaths: RVIKPath[] = [];
  /** Unified raycast manager (replaces the old driveHover). */
  raycastManager: RaycastManager | null = null;
  /** §4.2 zero-copy drawRange highlight proxies over the merged pick geometry.
   *  Lifetime is coupled to the RaycastGeometrySet it serves — replaced on
   *  every grouped-BVH (re)build, disposed in clearModel(). */
  private _highlightProxyProvider: ProxyOverlayProvider | null = null;

  /** Editor-mode two-level pick backend (null when the merged groups are
   *  active). Membership is maintained by the asset-op executors via
   *  {@link instancePickIndex}. */
  private _instancePickIndex: InstancePickIndex | null = null;

  /** The editor instance pick index (null outside authoring loads). */
  get instancePickIndex(): InstancePickIndex | null {
    return this._instancePickIndex;
  }
  transportManager: RVTransportManager | null = null;

  /**
   * Load-generation guard (plan-240 F9). Incremented at the START of every
   * `loadModel()` and in `clearModel()`. The asynchronous BVH build captures
   * the value at kickoff and aborts its WHOLE remaining sequence — discarding
   * any in-flight result — as soon as the generation moves on, so it never
   * writes a `boundsTree` onto a disposed/stale geometry.
   */
  private _loadGeneration = 0;
  /** Reused async BVH build port (ONE worker across model loads, plan-240).
   *  Created lazily on the first build; disposed only in `dispose()` —
   *  clearModel() keeps it alive for the next load. */
  private _bvhPort: BVHBuildPort | null = null;

  /**
   * Plan 201 — shared per-component statistics registry. Components register
   * their `StateStatistics` here (keyed by node path); the DES + continuous paths
   * feed the SAME registry so a single source backs all stats UI. Always present;
   * `clear()`ed on model unload, `resetAll()`ed on `resetSimulation()`.
   */
  readonly statisticsManager = new StatisticsManager();
  logicEngine: RVLogicEngine | null = null;
  tankFillManager: TankFillManager | null = null;
  pipeFlowManager: PipeFlowManager | null = null;
  playback: RVDrivesPlayback | null = null;
  groups: GroupRegistry | null = null;
  autoFilters: AutoFilterRegistry | null = null;

  /** True while a selection-driven isolate (context menu) owns the external isolate channel. */
  private _selectionIsolateActive = false;
  /** Prior `.visible` state of the isolated roots, restored on exit. */
  private _selectionIsolatePriorVis: { node: Object3D; visible: boolean }[] = [];

  /**
   * @deprecated Use `viewer.raycastManager` instead. This getter returns
   * an adapter that delegates to RaycastManager for backward compatibility.
   */
  get driveHover(): {
    enabled: boolean;
    hoveredDrive: RVDrive | null;
    pointerClientX: number;
    pointerClientY: number;
    lastRayOrigin: Vector3 | null;
    lastRayDirection: Vector3 | null;
    setDriveTargets(drives: RVDrive[]): void;
    updateFromXRController(origin: Vector3, direction: Vector3): void;
    dispose(): void;
  } | null {
    if (!this.raycastManager) return null;
    const rm = this.raycastManager;
    const self = this;
    return {
      get enabled() { return rm.enabled; },
      set enabled(v: boolean) { rm.setEnabled(v); },
      get hoveredDrive() {
        if (!rm.hoveredNode || rm.hoveredNodeType !== 'Drive') return null;
        return self.registry?.findInParent<RVDrive>(rm.hoveredNode, 'Drive') ?? null;
      },
      get pointerClientX() { return rm.pointerClientX; },
      get pointerClientY() { return rm.pointerClientY; },
      get lastRayOrigin() { return rm.lastRayOrigin; },
      get lastRayDirection() { return rm.lastRayDirection; },
      setDriveTargets(_drives: RVDrive[]) {
        // No-op: grouped BVH raycast geometry replaces per-target registration
      },
      updateFromXRController(origin: Vector3, direction: Vector3) {
        rm.updateFromXRController(origin, direction);
      },
      dispose() {
        rm.dispose();
      },
    };
  }

  // --- Plugin System ---

  /** All registered core plugins. */
  private _plugins: RVViewerPlugin[] = [];
  /** Registration-site metadata, intentionally separate from plugin classes. */
  private _pluginOrigins = new Map<string, PluginOrigin>();
  /** Scoped fallback used while delegated plugin modules call use(). */
  private _defaultPluginOrigin: PluginOrigin | undefined;
  /** Cached: only plugins with onFixedUpdatePre, sorted by order. */
  private _prePlugins: RVViewerPlugin[] = [];
  /** Cached: only plugins with onFixedUpdatePost, sorted by order. */
  private _postPlugins: RVViewerPlugin[] = [];
  /** Lazily rebuilt defensive snapshots of _pre/_postPlugins — invalidated on
   *  register/enable/disable/remove so fixedUpdate never allocates per tick. */
  private _prePluginsSnapshot: readonly RVViewerPlugin[] | null = null;
  private _postPluginsSnapshot: readonly RVViewerPlugin[] | null = null;
  /** Cached: only plugins with onRender, sorted by order. */
  private _renderPlugins: RVViewerPlugin[] = [];
  /** Flag: a plugin handles transport (kinematic transportManager.update is skipped). */
  private _physicsPluginActive = false;

  /**
   * Plan 194 P1 — unified SimulationKernel. Built lazily on first tick after a
   * model loads; null before that (the viewer then drives the CoreSubsystems
   * pipeline directly). The kernel reuses the viewer's EXISTING
   * transportManager + behaviors — it does NOT relocate ownership or
   * re-instantiate them. The legacy `VITE_UNIFIED_SIM` opt-out was removed in
   * the runtime unification (Phase B): the kernel path is now the only path.
   */
  private _kernel: SimulationKernel | null = null;

  /**
   * Phase B (runtime unification) — the per-tick core subsystem pipeline
   * (playback/logic/IK/replay, drive loop + dirty flags, texture/tank/gizmo/
   * pipe visuals) extracted from fixedUpdate. Driven by the SimulationExecutors
   * via `earlyTick`/`tick`; every host field is read lazily so model-load
   * reassignments of the underlying managers/arrays are always visible.
   */
  private readonly _coreSubsystems: CoreSubsystems = ((viewer: RVViewer) =>
    new CoreSubsystems({
      get isConnected() { return viewer.runtime.connectionState === 'Connected'; },
      get playback() { return viewer.playback; },
      get logicEngine() { return viewer.logicEngine; },
      get ikPaths() { return viewer.ikPaths; },
      get replayRecordings() { return viewer.replayRecordings; },
      get drives() { return viewer.drives; },
      get transportManager() { return viewer.transportManager; },
      get tankFillManager() { return viewer.tankFillManager; },
      get pipeFlowManager() { return viewer.pipeFlowManager; },
      get gizmoManager() { return viewer.gizmoManager; },
      get lampManager() { return viewer.lampManager; },
      get energyChainManager() { return viewer.energyChainManager; },
      get collisionManager() { return viewer.collisionManager; },
      markRenderDirty: () => viewer.markRenderDirty(),
      markShadowsDirty: () => viewer.markShadowsDirty(),
    }))(this);
  /** IDs of plugins that have been disabled via disablePlugin(). */
  private _disabledIds = new Set<string>();
  /** Session-scoped user overrides that mode reconciliation must not undo. */
  private _userDisabledIds = new Set<string>();
  /**
   * IDs of plugins that were disabled when a model loaded and therefore MISSED
   * their `onModelLoaded` call. `enablePlugin()` replays `_lastLoadResult` to
   * them exactly once, then clears the entry. See plan-198 (mode system).
   */
  private _missedModelLoad = new Set<string>();
  /** Plugins that actually received onModelLoaded for the current model. */
  private _modelLoadedIds = new Set<string>();
  /** Last successful load result (for retroactive onModelLoaded). */
  private _lastLoadResult: LoadResult | null = null;
  /** Lazy plugin factories: ID → async import factory (code-split by Vite). */
  private _lazyFactories = new Map<string, () => Promise<{ default: unknown }>>();
  /** URL of the currently loaded model (for reloadModel). */
  private _currentModelUrl: string | null = null;
  /** Original model URL set by main.ts before loadModel (survives blob URL override). */
  pendingModelUrl: string | null = null;
  /** True while OrbitControls is actively rotating/panning/pinching. */
  private _isOrbiting = false;
  /** Pointer position at pointerdown — used for drag-distance threshold. */
  private _pointerDownPos: { x: number; y: number } | null = null;
  /** Right-button pointer position at pointerdown — used for context menu drag guard. */
  private _rightDownPos: { x: number; y: number } | null = null;
  /** Long-press timer ID for touch context menu. */
  private _longPressTimer: ReturnType<typeof setTimeout> | null = null;
  /** Stored position at touch start for long-press context menu. */
  private _longPressPos: { x: number; y: number } | null = null;

  /** Available model entries for the model selector UI. */
  availableModels: Array<{ url: string; label: string }> = [];


  /**
   * Replace the model catalogue and tell everything that renders it (plan-365).
   *
   * Assigning `availableModels` directly is not enough once the list can change
   * after boot: `SceneStore` *copies* it and only re-reads on `refreshGlbList()`,
   * and the login gate's picker memoises on the stable viewer reference, so
   * neither of them would ever see the new entry. Everything that changes the
   * catalogue at runtime goes through here.
   */
  setAvailableModels(models: Array<{ url: string; label: string }>): void {
    this.availableModels = models;
    bumpModelCatalog();
    // Typed through the declared event rather than as a bare literal: `emit` has
    // an untyped `(event: string, data?: unknown)` overload that would otherwise
    // swallow a mistyped payload silently. Annotating it here keeps the check at
    // the emit site without touching the shared EventEmitter signatures.
    const payload: ViewerEvents['models-changed'] = { models };
    this.emit('models-changed', payload);
  }

  /** Read-only "Example" scenes of the DemoRealvirtual project (Examples section). */

  availablePublishedScenes: PublishedSceneEntry[] = [];

  /** UI plugin registry for React slot rendering. */
  readonly uiRegistry = new UIPluginRegistry();

  /**
   * Workspace mode manager (plan-198) — Blender-style HMI / DES / Planner modes.
   * Switching a mode enables/disables the participating plugins and swaps the
   * `mode:<id>` UI context. The host adapter wires the manager to this viewer's
   * plugin system; all calls are lazy so constructing it here (before plugins
   * register) is safe.
   */
  readonly modes: ModeManager = new ModeManager({
    viewer: this,
    pluginsForMode: (from, to) => this.pluginsForMode(from, to),
    enablePlugin: (id) => this.enablePlugin(id),
    disablePlugin: (id) => this.disablePlugin(id),
    callPlugin: (p, method, ...args) => callPlugin(p, method, ...args),
    setContext: (ctx, active) => setContext(ctx, active),
    emit: (event, data) => { this.emit(event, data); },
  } satisfies ModeHost);

  /** Centralized left-panel coordination (mutual exclusion, ButtonPanel offset). */
  readonly leftPanelManager = new LeftPanelManager();

  /** Central selection state (multi-select, Escape-to-deselect, selection highlights). */
  readonly selectionManager = new SelectionManager();

  /** Mode-driven highlight profile policy (constructed in main.ts after mode
   *  registration; null in headless/embedded hosts that skip it). */
  highlightPolicy: RVHighlightPolicy | null = null;

  /** Pending async work that must complete before `loadModel` / `loadScene`
   *  resolves to the caller. Drained via {@link whenLoadingIdle}; populated
   *  via {@link trackLoadingWork} by subsystems and plugins that kick off
   *  deferred async tasks during a load (env-map IBL generation, placement
   *  spawn, asset prefetch). Centralising the wait means the loading
   *  overlay stays up until the scene is fully ready to be revealed — no
   *  unlit-first-frame, no late lighting / placement pop-in. */
  private _loadingTasks: Promise<unknown>[] = [];

  /**
   * Register an async task that must complete before the next `loadModel`
   * or `loadScene` resolves to its caller. The task's resolution value is
   * ignored and rejections are swallowed (`Promise.allSettled`), so a slow
   * HDRI failing won't deadlock the loading overlay.
   *
   * Safe to call at any time:
   *   - viewer construction (env-map starts loading there);
   *   - inside `onModelLoaded` (plugins doing post-load async work);
   *   - inside another already-tracked task (cascades are awaited too —
   *     `whenLoadingIdle` drains in batches until the queue is empty).
   *
   * When no `loadModel`/`loadScene` is in flight, resolved tasks just sit
   * in the queue harmlessly until the next drain.
   */
  trackLoadingWork(p: Promise<unknown>): void {
    this._loadingTasks.push(p);
  }

  /**
   * Resolve when every currently-registered loading task has settled. Drains
   * in batches so tasks queued by other tasks (cascades) are awaited too.
   * Idempotent when the queue is empty.
   */
  async whenLoadingIdle(): Promise<void> {
    while (this._loadingTasks.length > 0) {
      const batch = this._loadingTasks.splice(0);
      await Promise.allSettled(batch);
    }
  }

  /** Plugin-extensible context menu (right-click / long-press). */
  readonly contextMenu = new ContextMenuStore();

  /**
   * BehaviorManager — owns all auto-discovered `src/behaviors/*.ts` modules.
   * On every `model-loaded` event, matching behaviors are invoked with a
   * fresh RVBindContext; on `model-cleared` all hooks/subscriptions made
   * during the bind are disposed.
   */
  readonly behaviors = new BehaviorManager();
  /** @internal — dispose function returned by `behaviors.attach()`. */
  private _behaviorsDetach: (() => void) | null = null;

  /**
   * Register a plugin. Sorted into cached lifecycle lists.
   * If the plugin has `slots`, its UI entries are auto-registered into the HMI.
   * Duplicate IDs are rejected with a warning. Chainable.
   */
  use(plugin: RVViewerPlugin, origin?: PluginOrigin): this {
    if (this._plugins.some((p) => p.id === plugin.id)) {
      console.warn(`[RVViewer] Plugin '${plugin.id}' already registered`);
      return this;
    }
    this._plugins.push(plugin);
    const effectiveOrigin = origin ?? this._defaultPluginOrigin;
    if (effectiveOrigin !== undefined) this._pluginOrigins.set(plugin.id, effectiveOrigin);

    // Phase 4a of plan-182: Plugins können init?(viewer, context) implementieren um
    // den schmalen PluginContext statt vollem RVViewer zu erhalten. Optional & try/catch.
    if (typeof plugin.init === 'function') {
      try {
        plugin.init(this, this._pluginContext.forPlugin(plugin.id));
      } catch (e) {
        console.error(`[RVViewer] Plugin '${plugin.id}' init error:`, e);
      }
    }

    // Insert into cached lists sorted by order
    const insertSorted = (list: RVViewerPlugin[], p: RVViewerPlugin) => {
      list.push(p);
      list.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    };
    if (plugin.onFixedUpdatePre) insertSorted(this._prePlugins, plugin);
    if (plugin.onFixedUpdatePost) insertSorted(this._postPlugins, plugin);
    if (plugin.onRender) insertSorted(this._renderPlugins, plugin);
    this._invalidatePluginSnapshots();

    this._recomputePhysicsPluginActive();

    // Auto-register UI slot entries if the plugin provides them
    if (plugin.slots && plugin.slots.length > 0) {
      this.uiRegistry.register(plugin);
    }

    // Retroactive: if model already loaded, call onModelLoaded immediately (skip
    // disabled and mode-scoped plugins outside their mode — the mode transition
    // replays the missed call via enablePlugin()).
    if (this._lastLoadResult && plugin.onModelLoaded && this._isPluginEligibleForCurrentModel(plugin)) {
      if (this._disabledIds.has(plugin.id) || !pluginParticipatesInMode(plugin, this.modes.activeMode)) {
        this._missedModelLoad.add(plugin.id);
      } else {
        this._deliverModelLoaded(plugin, this._lastLoadResult);
      }
    }
    this.emit('plugins-changed', { kind: 'registered', id: plugin.id });
    return this;
  }

  /**
   * Run synchronous delegated registration with a fallback origin. Explicit
   * origins passed to {@link use} always win; nested scopes restore correctly.
   */
  withDefaultOrigin<T>(origin: PluginOrigin, fn: () => T): T {
    const previous = this._defaultPluginOrigin;
    this._defaultPluginOrigin = origin;
    try {
      return fn();
    } finally {
      this._defaultPluginOrigin = previous;
    }
  }

  /** Defensive read-only snapshot of the current plugin registry. */
  getPlugins(): readonly RVViewerPlugin[] {
    return this._plugins.slice();
  }

  /** Registration-site origin, or `unknown` for untagged/unknown IDs. */
  getPluginOrigin(id: string): PluginOrigin {
    return this._pluginOrigins.get(id) ?? 'unknown';
  }

  /** Whether a plugin ID is currently disabled. */
  isPluginDisabled(id: string): boolean {
    return this._disabledIds.has(id);
  }

  /** Whether the user explicitly disabled a plugin for this viewer session. */
  isPluginUserDisabled(id: string): boolean {
    return this._userDisabledIds.has(id);
  }

  /** Defensive snapshot of the current session-scoped user overrides. */
  getPluginUserDisabledIds(): ReadonlySet<string> {
    return new Set(this._userDisabledIds);
  }

  /**
   * Apply a session-scoped user override without unloading plugin resources or
   * UI slots. Mode hooks only run when the plugin participates in an active
   * workspace; the callback lists are disabled even during the boot null-mode.
   */
  setPluginUserEnabled(id: string, enabled: boolean): void {
    const plugin = this._plugins.find((candidate) => candidate.id === id);
    if (!plugin) return;

    if (!enabled) {
      if (this._userDisabledIds.has(id)) return;
      this._userDisabledIds.add(id);
      const activeMode = this.modes.activeMode;
      if (activeMode !== null && pluginParticipatesInMode(plugin, activeMode)) {
        callPlugin(plugin, 'onModeDeactivate', activeMode, this);
      }
      this.disablePlugin(id);
      this.emit('plugins-changed', { kind: 'user-disabled', id });
      return;
    }

    if (!this._userDisabledIds.delete(id)) return;
    const activeMode = this.modes.activeMode;
    if (activeMode !== null && pluginParticipatesInMode(plugin, activeMode)) {
      this.enablePlugin(id);
      callPlugin(plugin, 'onModeActivate', activeMode, this);
    }
    this.emit('plugins-changed', { kind: 'user-enabled', id });
  }

  /** Clear all session-scoped user overrides and restore mode-driven state. */
  clearPluginUserOverrides(): void {
    for (const id of [...this._userDisabledIds]) {
      this.setPluginUserEnabled(id, true);
    }
  }

  /** Type-safe plugin lookup by ID. */
  getPlugin<T extends RVViewerPlugin>(id: string): T | undefined {
    return this._plugins.find((p) => p.id === id) as T | undefined;
  }

  /**
   * Disable a plugin by ID. The plugin is removed from the cached pre/post/render
   * arrays and skipped in onModelLoaded and onConnectionStateChanged. A plugin
   * that received the current model still receives onModelCleared for cleanup.
   * The plugin remains in _plugins so dispose() still runs (prevents memory leaks).
   */
  disablePlugin(id: string): void {
    if (this._disabledIds.has(id)) return;
    this._prePlugins = this._prePlugins.filter(p => p.id !== id);
    this._postPlugins = this._postPlugins.filter(p => p.id !== id);
    this._renderPlugins = this._renderPlugins.filter(p => p.id !== id);
    this._invalidatePluginSnapshots();
    this._disabledIds.add(id);
    this._recomputePhysicsPluginActive();
    this.emit('plugins-changed', { kind: 'disabled', id });
  }

  /**
   * Re-enable a plugin previously disabled via {@link disablePlugin}. Symmetric
   * counterpart to disablePlugin: re-inserts the plugin into the cached
   * pre/post/render lists (sorted by order), restores the physics flag, and
   * removes it from the disabled set.
   *
   * If the plugin MISSED an `onModelLoaded` while it was disabled (a model
   * loaded during that window), its `onModelLoaded` is replayed exactly once
   * with the current `_lastLoadResult` — so a plugin enabled by a mode switch
   * after the model is already loaded initializes correctly. No-op if the
   * plugin is not currently disabled. See plan-198 (mode system).
   */
  enablePlugin(id: string): void {
    if (!this._disabledIds.has(id)) return;
    this._disabledIds.delete(id);
    const plugin = this._plugins.find(p => p.id === id);
    if (!plugin) return;

    const insertSorted = (list: RVViewerPlugin[], p: RVViewerPlugin) => {
      if (list.includes(p)) return; // defensive — avoid duplicates
      list.push(p);
      list.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    };
    if (plugin.onFixedUpdatePre) insertSorted(this._prePlugins, plugin);
    if (plugin.onFixedUpdatePost) insertSorted(this._postPlugins, plugin);
    if (plugin.onRender) insertSorted(this._renderPlugins, plugin);
    this._invalidatePluginSnapshots();
    this._recomputePhysicsPluginActive();

    // Replay a missed onModelLoaded exactly once (mode-driven re-activation).
    if (this._missedModelLoad.delete(id) && this._lastLoadResult) {
      this._deliverModelLoaded(plugin, this._lastLoadResult);
    }
    this.emit('plugins-changed', { kind: 'enabled', id });
  }

  /**
   * @internal — Compute the plugin sets for a `from → to` mode transition.
   * Driven by the {@link ModeManager} host adapter. `enable`/`disable` reconcile
   * the actual active state (`_disabledIds`) against the target mode;
   * `activateHooks`/`deactivateHooks` fire on the participation transition.
   * Shared (`modes` undefined) and `core` plugins participate in every mode, so
   * they never appear in any set — the backward-compat guarantee.
   */
  pluginsForMode(from: ModeId | null, to: ModeId): ModePluginSets {
    return computeModePluginSets(
      this._plugins,
      (id) => this._disabledIds.has(id),
      from,
      to,
      (id) => this._userDisabledIds.has(id),
    );
  }

  /**
   * Fully remove a non-core plugin: dispose, remove from all arrays,
   * unregister UI slots and context menu entries.
   * Core plugins (core: true) cannot be removed — use disablePlugin() instead.
   */
  removePlugin(id: string): boolean {
    const idx = this._plugins.findIndex(p => p.id === id);
    if (idx < 0) return false;
    const plugin = this._plugins[idx];
    if (plugin.core) {
      console.warn(`[RVViewer] Cannot remove core plugin '${id}' — use disablePlugin() instead`);
      return false;
    }
    if (plugin.dispose) {
      try { plugin.dispose(); } catch (e) {
        console.error(`[RVViewer] Plugin '${id}' dispose error:`, e);
      }
    }
    this._plugins.splice(idx, 1);
    this._prePlugins = this._prePlugins.filter(p => p.id !== id);
    this._postPlugins = this._postPlugins.filter(p => p.id !== id);
    this._renderPlugins = this._renderPlugins.filter(p => p.id !== id);
    this._invalidatePluginSnapshots();
    this._disabledIds.delete(id);
    this._userDisabledIds.delete(id);
    this._missedModelLoad.delete(id);
    this._modelLoadedIds.delete(id);
    this._pluginOrigins.delete(id);
    this.uiRegistry.unregister(id);
    this.contextMenu.unregister(id);
    // Re-evaluate physics plugin state
    this._recomputePhysicsPluginActive();
    this.emit('plugins-changed', { kind: 'removed', id });
    return true;
  }

  private _recomputePhysicsPluginActive(): void {
    this._physicsPluginActive = this._plugins.some(
      (plugin) => plugin.handlesTransport && !this._disabledIds.has(plugin.id),
    );
  }

  private _isPluginEligibleForCurrentModel(plugin: RVViewerPlugin): boolean {
    const declared = this._lastLoadResult?.modelConfig?.plugins;
    return declared === undefined || plugin.core === true || declared.includes(plugin.id);
  }

  private _deliverModelLoaded(plugin: RVViewerPlugin, result: LoadResult): void {
    if (!plugin.onModelLoaded || this._modelLoadedIds.has(plugin.id)) return;
    callPlugin(plugin, 'onModelLoaded', result, this);
    this._modelLoadedIds.add(plugin.id);
  }

  private async _notifyPluginsModelLoaded(result: LoadResult): Promise<void> {
    const declared = result.modelConfig.plugins;
    const outsideMode = (plugin: RVViewerPlugin): boolean =>
      !pluginParticipatesInMode(plugin, this.modes.activeMode);

    if (declared === undefined) {
      for (const plugin of this._plugins) {
        if (this._disabledIds.has(plugin.id) || outsideMode(plugin)) {
          this._missedModelLoad.add(plugin.id);
          continue;
        }
        this._deliverModelLoaded(plugin, result);
      }
      return;
    }

    for (const plugin of this._plugins) {
      const eligible = plugin.core === true || declared.includes(plugin.id);
      if (!eligible) continue;
      if (this._disabledIds.has(plugin.id) || outsideMode(plugin)) {
        this._missedModelLoad.add(plugin.id);
        continue;
      }
      this._deliverModelLoaded(plugin, result);
    }

    for (const id of declared) {
      if (this._plugins.some((plugin) => plugin.id === id)) continue;
      const plugin = await this.resolvePlugin(id);
      if (plugin && (this._disabledIds.has(plugin.id) || outsideMode(plugin))) {
        this._missedModelLoad.add(plugin.id);
        continue;
      }
      if (plugin) this._deliverModelLoaded(plugin, result);
    }
  }

  private _notifyPluginsModelCleared(): void {
    for (const plugin of this._plugins) {
      if (!this._modelLoadedIds.has(plugin.id)) continue;
      callPlugin(plugin, 'onModelCleared', this);
    }
    this._modelLoadedIds.clear();
  }

  /** Model plugin manager — handles per-model plugin loading/unloading. */
  modelPluginManager: ModelPluginManager | null = null;

  // ─── Sub-Facaden (Phase 4a of plan-182) ────────────────────────────────
  // Instanziiert am Ende des Constructors, niemals null während Viewer-Lifetime.
  // Plugins greifen über this._pluginContext.scene/.camera/etc. zu (NICHT direkt!).
  /** @internal */ _scene!: SceneFacadeImpl;
  /** @internal */ _camera!: CameraFacadeImpl;
  /** @internal */ _controls!: ControlsFacadeImpl;
  /** @internal */ _simLoop!: SimLoopFacadeImpl;
  // _transport ist lazy in PluginContextImpl gecacht — kein Feld auf RVViewer.

  // PluginContext-Instanz — wird in use() an Plugins via init?() durchgereicht.
  /** @internal */ _pluginContext!: PluginContextImpl;

  /**
   * Register a lazy plugin factory. The factory is only called when a model
   * actually requests the plugin (via rv_plugins / modelname.json).
   * Vite automatically code-splits lazy factories into separate chunks.
   */
  registerLazy(id: string, factory: () => Promise<{ default: unknown }>): this {
    this._lazyFactories.set(id, factory);
    return this;
  }

  /**
   * Resolve a plugin by ID through the three-level resolution chain:
   *   1. Already registered (via `use()`)  → return existing
   *   2. Lazy built-in (via `registerLazy()`) → import chunk, instantiate, register
   *   3. External plugin (`models/plugins/{id}.js`) → dynamic import, register
   *   4. Not found → return null (no crash)
   */
  async resolvePlugin(id: string): Promise<RVViewerPlugin | null> {
    // 1. Already registered?
    const existing = this._plugins.find(p => p.id === id);
    if (existing) return existing;

    // 2. Lazy built-in?
    const factory = this._lazyFactories.get(id);
    if (factory) {
      try {
        const mod = await factory();
        const PluginOrInstance = mod.default;
        const plugin = typeof PluginOrInstance === 'function'
          ? new (PluginOrInstance as new () => RVViewerPlugin)()
          : PluginOrInstance as RVViewerPlugin;
        if (plugin && plugin.id) {
          this.use(plugin, 'core');
          return plugin;
        }
      } catch (e) {
        console.warn(`[RVViewer] Failed to load lazy plugin '${id}':`, e);
      }
      return null;
    }

    // 3. External plugin?
    const baseUrl = this._currentModelUrl
      ? this._currentModelUrl.substring(0, this._currentModelUrl.lastIndexOf('/'))
      : '.';
    // loadExternalPlugin returns PluginLoadable (plan-182 Phase 2 — avoids rv-viewer.ts
    // cycle). External plugins are RVViewerPlugin by convention; cast is safe here.
    const loadedPlugin = await loadExternalPlugin(id, baseUrl);
    if (loadedPlugin) {
      const plugin = loadedPlugin as RVViewerPlugin;
      this.use(plugin, 'project');
      return plugin;
    }

    // 4. Not found
    console.warn(`[RVViewer] Plugin '${id}' not found (not registered, no lazy factory, no external)`);
    return null;
  }

  // ─── Exclusive Hover Mode ──────────────────────────────────────────

  /** The currently active exclusive hover mode (only this type is hoverable). null = all types. */
  private _exclusiveHoverMode: HoverableType | null = null;
  get exclusiveHoverMode(): HoverableType | null { return this._exclusiveHoverMode; }

  /**
   * Set an exclusive hover mode — only the specified type will be hoverable.
   * Pass null to restore default behavior (all registered types hoverable).
   * Any existing exclusive mode is automatically deactivated.
   */
  setExclusiveHoverMode(mode: HoverableType | null): void {
    if (mode === this._exclusiveHoverMode) return;
    this._exclusiveHoverMode = mode;

    if (!this.raycastManager) return;
    if (mode) {
      // Enable only the requested type, disable all others in the exclusive group
      for (const type of getTypesWithCapability('exclusiveHoverGroup')) {
        this.raycastManager.enableHoverType(type, type === mode);
      }
    } else {
      // Default: all exclusive-group types hoverable
      for (const type of getTypesWithCapability('exclusiveHoverGroup')) {
        this.raycastManager.enableHoverType(type, true);
      }
    }
    this.emit('exclusive-hover-mode', { mode });
  }

  // ─── Chart overlays (mutually exclusive) ──────────────────────────
  //
  // ONE field encodes which exclusive chart overlay is open — the toggles
  // below can never leave two "exclusive" overlays open at once, and adding a
  // third chart means adding a value, not editing every existing toggle.

  /** Which exclusive chart overlay is open (null = none). */
  private _activeChart: 'drive' | 'sensor' | null = null;

  /** Whether the drive chart overlay is open. */
  get driveChartOpen(): boolean { return this._activeChart === 'drive'; }

  /** Whether the sensor chart overlay is open. */
  get sensorChartOpen(): boolean { return this._activeChart === 'sensor'; }

  /** Toggle the drive chart overlay. Exclusive with other chart modes. */
  toggleDriveChart(forceOpen?: boolean): void {
    const open = forceOpen ?? this._activeChart !== 'drive';
    if (open) {
      // Close other exclusive modes
      if (this._activeChart === 'sensor') {
        this.emit('sensor-chart-toggle', { open: false });
      }
      this._activeChart = 'drive';
      this.setExclusiveHoverMode('Drive');
      // Isolate drives — dims non-drive geometry
      this.autoFilters?.isolate('Drive', { dimOpacity: 0.55, dimDesaturate: true });
      this.markShadowsDirty();
    } else {
      if (this._activeChart === 'drive') this._activeChart = null;
      this.setExclusiveHoverMode(null);
      this.autoFilters?.showAll();
      this.markShadowsDirty();
    }
    this.emit('drive-chart-toggle', { open: this._activeChart === 'drive' });
  }

  /** Toggle the sensor chart overlay. Exclusive with other chart modes. */
  toggleSensorChart(forceOpen?: boolean): void {
    const open = forceOpen ?? this._activeChart !== 'sensor';
    if (open) {
      // Close other exclusive modes
      if (this._activeChart === 'drive') {
        this.emit('drive-chart-toggle', { open: false });
      }
      this._activeChart = 'sensor';
      this.setExclusiveHoverMode('Sensor');
      const sensors = this.transportManager?.sensors ?? [];
      const nodes = sensors.map((s) => s.node);
      if (nodes.length > 0) {
        this.highlighter.highlightMultiple(nodes, { includeSensorViz: true });
        this.fitToNodes(nodes);
      }
    } else {
      if (this._activeChart === 'sensor') this._activeChart = null;
      this.setExclusiveHoverMode(null);
      this.highlighter.clear();
    }
    this.emit('sensor-chart-toggle', { open: this._activeChart === 'sensor' });
  }

  /** Whether the groups overlay is open. */
  private _groupsOverlayOpen = false;
  get groupsOverlayOpen(): boolean { return this._groupsOverlayOpen; }

  /** Toggle the groups overlay panel. */
  toggleGroupsOverlay(forceOpen?: boolean): void {
    this._groupsOverlayOpen = forceOpen ?? !this._groupsOverlayOpen;
    this.emit('groups-overlay-toggle', { open: this._groupsOverlayOpen });
  }

  /**
   * Mark shadows as dirty — call after visibility changes (e.g. group toggle)
   * so the shadow map is re-rendered on the next frame.
   */
  markShadowsDirty(): void {
    this._shadowsDirty = true;
    this._renderDirty = true;
    // Visibility toggles route through here (Groups window, auto-filters,
    // display panel) — keep the BatchedMesh per-instance visibility in sync.
    this._batchVisibility?.markDirty();
  }

  /** Per-instance visibility sync for the BatchedMesh render path (null when
   *  the current model has no batches). Mutators of model-node `.visible`
   *  should call `markShadowsDirty()` or emit 'node-visibility-changed'. */
  get batchVisibility(): BatchVisibilityService | null {
    return this._batchVisibility;
  }

  /**
   * Mark the render pass as dirty so the next frame renders.
   * Call from plugins that need continuous rendering (e.g. FPV movement).
   */
  markRenderDirty(): void {
    this._renderDirty = true;
  }

  /** Create a component node at runtime (op-log `addNode`). Returns false if the
   *  scene isn't loaded or the parent is missing. */
  createComponentNode(spec: RuntimeNodeSpec): boolean {
    if (!this.registry || !this.signalStore || !this.transportManager) return false;
    return !!createRuntimeNode({
      registry: this.registry, signalStore: this.signalStore, scene: this.scene,
      transportManager: this.transportManager, gizmoManager: this.gizmoManager,
      lampManager: this.lampManager, energyChainManager: this.energyChainManager,
      collisionManager: this.collisionManager,
      errorStore: this.errorStore,
      instructionStore: this.instructionStore, outlineManager: this.outlineManager,
    }, spec);
  }

  /** Remove an op-created node (op-log `removeNode` / inverse of addNode). */
  removeComponentNode(nodePath: string): void {
    if (this.registry) removeRuntimeNode(this.registry, nodePath);
  }

  /** Re-resolve every IKPath's target list — call after op-created target nodes
   *  are added/removed so the runtime path picks them up (they don't exist when
   *  the IKPath first init()s during loadGLB). */
  rebuildIKPaths(): void {
    const reg = this.registry;
    if (!reg) return;
    for (const { instance } of reg.getAll<{ rebuildTargets?: (r: typeof reg) => void }>('IKPath')) {
      instance.rebuildTargets?.(reg);
    }
  }

  /** The ground plane mesh, or null if ground was disabled. */
  get groundMesh(): Mesh | null {
    return this._groundMesh;
  }

  /**
   * Resize + reposition the checker floor disc (and its reflection mirror) to a
   * given centre and full extent. The 200×200 fade plane is scaled so its
   * inscribed-circle radius equals FLOOR_FADE_END_RATIO × half-extent, the
   * checker `repeat` is kept at a constant 0.5 m per square, and the reflector
   * tracks the same scale/position. Single source of truth for floor sizing —
   * called from loadModel (exact model fit), loadEmptyScene (playground), and
   * the layout-content grow pass.
   *
   * @param center World-space centre; only X/Z are used (floor stays at y=0).
   * @param fullExtent Floor full extent in metres (max of width/depth).
   */
  private _updateGroundPlane(center: Vector3, fullExtent: number): void {
    if (!this._groundMesh) return;
    const groundSize = fullExtent * FLOOR_FADE_END_RATIO;
    this._groundMesh.scale.set(groundSize / 200, groundSize / 200, 1);
    this._groundMesh.position.set(center.x, 0, center.z);

    // Update checker texture repeat so each square is always 0.5 m.
    const SQUARE_SIZE = 0.5;     // metres per checker square
    const TILES_PER_REPEAT = 8;  // tiles baked into the checker texture
    const metersPerRepeat = TILES_PER_REPEAT * SQUARE_SIZE; // 4 m
    const checkerMap = ((this._groundMesh as Mesh).material as MeshStandardMaterial).map;
    if (checkerMap) {
      checkerMap.repeat.set(groundSize / metersPerRepeat, groundSize / metersPerRepeat);
    }

    // Keep the reflection mirror locked to the checker disc (same scale and
    // X/Z position; stays a hair below to avoid z-fighting).
    if (this._groundReflector) {
      this._groundReflector.scale.set(groundSize / 200, groundSize / 200, 1);
      this._groundReflector.position.set(center.x, -0.002, center.z);
    }

    this._renderDirty = true;
  }

  /** Coalesce flag so a burst of layout-transform events (e.g. a gizmo drag,
   *  which fires once per frame) triggers at most one floor re-fit per frame. */
  private _groundFitQueued = false;

  /** Queue a floor re-fit on the next animation frame (debounces drag bursts). */
  private _queueGroundFit(): void {
    if (this._groundFitQueued) return;
    this._groundFitQueued = true;
    requestAnimationFrame(() => {
      this._groundFitQueued = false;
      this._fitGroundToContent();
    });
  }

  /**
   * Grow the checker floor so it keeps the current authoring content (model
   * root + placed layout objects, which parent under it) on a visible disc.
   *
   * GROW-ONLY: the floor is only ever enlarged here, never shrunk. That keeps
   * a small inspector nudge or a single placement from collapsing the floor of
   * an existing scene, while still expanding it when a part is dragged or
   * placed beyond the current disc. The baseline size is owned by loadModel /
   * loadEmptyScene; this pass only reacts to subsequent layout edits.
   */
  private _fitGroundToContent(): void {
    if (!this._groundMesh || !this.currentModel) return;
    const box = new Box3().setFromObject(this.currentModel);
    const center = new Vector3();
    let fullExtent: number;
    if (box.isEmpty()) {
      center.set(0, 0, 0);
      fullExtent = MIN_AUTHORING_GROUND_EXTENT;
    } else {
      const size = new Vector3();
      box.getCenter(center);
      box.getSize(size);
      fullExtent = Math.max(size.x, size.z, MIN_AUTHORING_GROUND_EXTENT);
    }
    // Only apply when it would actually enlarge the disc (grow-only). Compare
    // against the live scale (groundSize = scale.x × 200) with a small epsilon
    // so floating-point equality doesn't churn the texture repeat each frame.
    const currentGroundSize = this._groundMesh.scale.x * 200;
    const desiredGroundSize = fullExtent * FLOOR_FADE_END_RATIO;
    if (desiredGroundSize <= currentGroundSize * 1.001) return;
    this._updateGroundPlane(center, fullExtent);
  }

  /** Whether the ground/floor plane is visible. No-op if ground was disabled at construction. */
  get groundEnabled(): boolean {
    return this._groundMesh?.visible ?? false;
  }
  set groundEnabled(v: boolean) {
    if (!this._groundMesh) return;
    if (this._groundMesh.visible === v) return;
    this._groundMesh.visible = v;
    this._renderDirty = true;
  }

  /** Whether the drive axis gizmo overlay is shown on selected Drive nodes
   *  (plan-249). Read per frame by DriveAxisGizmoPlugin, which rebuilds/clears
   *  the current selection's gizmos on change. */
  private _showDriveAxisGizmo = true;
  get showDriveAxisGizmo(): boolean {
    return this._showDriveAxisGizmo;
  }
  set showDriveAxisGizmo(v: boolean) {
    if (this._showDriveAxisGizmo === v) return;
    this._showDriveAxisGizmo = v;
    this._renderDirty = true;
  }

  /**
   * Floor brightness multiplier (0 = black, 1 = default, 2 = double).
   * Combined with `groundColor` in the material tint:
   *     mat.color = groundColor × groundBrightness   (component-wise)
   * so a white ground at brightness 1 reproduces the original look, and a
   * green ground at brightness 1 reads as the green hue at full intensity.
   */
  get groundBrightness(): number {
    return this._groundBrightness;
  }
  set groundBrightness(v: number) {
    const clamped = Math.max(0, Math.min(2, v));
    if (this._groundBrightness === clamped) return;
    this._groundBrightness = clamped;
    this.applyGroundTint();
  }

  /**
   * Floor base color as `#rrggbb` hex. Combined with `groundBrightness` in the
   * material tint (color × brightness). Default '#ffffff' (white) so brightness
   * acts as a uniform gray scaler exactly as before.
   */
  get groundColor(): string {
    return '#' + this._groundColor.getHexString();
  }
  set groundColor(hex: string) {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
    const next = new Color(hex);
    if (this._groundColor.equals(next)) return;
    this._groundColor.copy(next);
    this.applyGroundTint();
  }

  /** Recompute the ground material color from the stored base color and
   *  brightness. Called whenever either input changes. */
  private applyGroundTint(): void {
    if (!this._groundMesh) return;
    const mat = this._groundMesh.material as MeshStandardMaterial;
    if (!mat.color) return;
    mat.color
      .copy(this._groundColor)
      .multiplyScalar(this._groundBrightness);
    this._renderDirty = true;
  }

  /**
   * Scene background brightness multiplier (0 = black, 1 = default gray, 2 = white).
   * Scales the base 0x9a9a9a gray uniformly so brightness=1 reproduces the original look.
   */
  get backgroundBrightness(): number {
    return this._backgroundBrightness;
  }
  set backgroundBrightness(v: number) {
    const clamped = Math.max(0, Math.min(2, v));
    if (this._backgroundBrightness === clamped) return;
    this._backgroundBrightness = clamped;
    const bg = this.scene.background;
    if (bg && (bg as Color).isColor) {
      (bg as Color).setScalar(Math.min(1, BG_BASE_SCALAR * clamped));
      this._renderDirty = true;
    }
  }

  /**
   * Floor checker pattern contrast multiplier (0 = flat midgray, 1 = default, 2 = doubled spread).
   * Regenerates the checker CanvasTexture in place.
   */
  get checkerContrast(): number {
    return this._checkerContrast;
  }
  set checkerContrast(v: number) {
    const clamped = Math.max(0, Math.min(2, v));
    if (this._checkerContrast === clamped) return;
    this._checkerContrast = clamped;
    if (!this._groundMesh || !this._checkerCanvas) return;
    drawCheckerPattern(this._checkerCanvas, clamped);
    const mat = this._groundMesh.material as MeshStandardMaterial;
    if (mat.map) {
      (mat.map as CanvasTexture).needsUpdate = true;
      this._renderDirty = true;
    }
  }

  /**
   * Whether the optional floor reflection is active. No-op when there is no
   * reflector (WebGPU backend or ground disabled at construction). When on, the
   * checker floor is made partly transparent so the mirror beneath reads
   * through — see {@link applyReflectionBlend}.
   */
  get reflectionEnabled(): boolean {
    return this._reflectionEnabled && !!this._groundReflector;
  }
  set reflectionEnabled(v: boolean) {
    if (!this._groundReflector) return;
    if (this._reflectionEnabled === v) return;
    this._reflectionEnabled = v;
    this._groundReflector.visible = v;
    if (v) {
      // Push current strength/blur to the reflector on enable. The strength/blur
      // setters early-return when their value equals the field default, so this
      // guarantees the reflector matches viewer state even when it was never
      // changed away from the default.
      setReflectorStrength(this._groundReflector, this._reflectionStrength);
      setReflectorBlur(this._groundReflector, this._reflectionBlur);
    }
    this.applyReflectionBlend();
    this._renderDirty = true;
  }

  /**
   * Floor reflection strength (0 = none, 1 = full mirror). Drives both the
   * mirror's reflection brightness and how transparent the checker floor
   * becomes, so the two move together with no muddy dark-mirror artifact.
   */
  get reflectionStrength(): number {
    return this._reflectionStrength;
  }
  set reflectionStrength(v: number) {
    const clamped = Math.max(0, Math.min(1, v));
    if (this._reflectionStrength === clamped) return;
    this._reflectionStrength = clamped;
    if (this._groundReflector) setReflectorStrength(this._groundReflector, clamped);
    this.applyReflectionBlend();
    this._renderDirty = true;
  }

  /**
   * Floor reflection blur / gloss (0 = sharp mirror, 1 = soft frosted gloss).
   * Softens the reflection with a separable Gaussian; 0 skips the blur passes.
   */
  get reflectionBlur(): number {
    return this._reflectionBlur;
  }
  set reflectionBlur(v: number) {
    const clamped = Math.max(0, Math.min(1, v));
    if (this._reflectionBlur === clamped) return;
    this._reflectionBlur = clamped;
    if (this._groundReflector) setReflectorBlur(this._groundReflector, clamped);
    this._renderDirty = true;
  }

  /** Apply the reflection blend to the checker floor: when reflection is on,
   *  lower the checker opacity proportionally to strength so the mirror shows
   *  through; when off, restore full opacity. */
  private applyReflectionBlend(): void {
    if (!this._groundMesh) return;
    const mat = this._groundMesh.material as MeshStandardMaterial;
    mat.opacity = this._reflectionEnabled
      ? Math.max(0.4, 1 - 0.6 * this._reflectionStrength)
      : 1;
    mat.needsUpdate = true;
    this._renderDirty = true;
  }


  /**
   * Cancel any in-progress camera animation immediately.
   * Used by FPV to prevent the animation overwriting the camera position.
   */
  cancelCameraAnimation(): void {
    this._cameraManager.cancelCameraAnimation();
  }

  // ─── Shared View Mode ────────────────────────────────────────────

  /** Whether shared view mode is active (camera controlled by remote operator). */
  private _sharedViewActive = false;
  get sharedViewActive(): boolean { return this._sharedViewActive; }

  /**
   * Enable or disable shared view mode — used by multiuser shared view.
   * When active: controls disabled, raycast disabled, _isOrbiting cleared.
   * When inactive: controls and raycast re-enabled.
   *
   * Rejects toggle if FPV or XR is active (returns false).
   * ALWAYS use this method instead of writing controls.enabled directly.
   *
   * @returns true if the toggle was applied, false if rejected.
   */
  setSharedViewMode(active: boolean): boolean {
    // Check FPV conflict
    const fpv = this.getPlugin<{ id: string; toggle(): void }>('fpv');
    if (active && fpv && (this as unknown as { _fpvActive?: boolean })._fpvActive) return false;

    // Check XR conflict
    const xr = this.getPlugin('webxr') as { isPresenting?: boolean } | undefined;
    if (active && xr?.isPresenting) return false;

    this._sharedViewActive = active;
    this.controls.enabled = !active;
    this._isOrbiting = false;
    this.raycastManager?.setEnabled(!active);
    this.controls.update();
    this._renderDirty = true;
    return true;
  }

  // ─── Simulation Pause ────────────────────────────────────────────

  /**
   * Pause or resume the fixed-timestep simulation with a named reason.
   *
   * Multiple reasons can hold a pause simultaneously (AR placement, layout edit,
   * shared-view session, user-initiated pause button, layout-planner drag, etc.).
   * The simulation resumes only after every reason has released its hold.
   *
   * Rendering is unaffected — onRender still fires each frame, so the 3D view,
   * highlights, gizmos, and camera passthrough stay live. Only `onFixedUpdate`
   * is skipped, which freezes drives, transport surfaces, sensors, logic steps,
   * physics, sources, and sinks.
   *
   * Plugins can subscribe to `'simulation-pause-changed'` to react to transitions
   * (e.g. disconnect WebSocket commands, stop signal polling, dim the scene).
   *
   * @param reason  Short, stable identifier per caller — e.g. `'ar-placement'`,
   *                `'layout-edit'`, `'user'`, `'shared-view'`. Same reason can be
   *                set/cleared multiple times; only the set state matters.
   * @param paused  `true` to request pause, `false` to release this reason.
   */
  setSimulationPaused(reason: string, paused: boolean): void {
    const changed = this.runtime.setPaused(reason, paused);
    if (changed) {
      this._emitPauseChanged(reason);
    }
  }

  // ─── Source Floor-Marker Visibility (plan-181) ─────────────────────
  //
  // Toggles the always-visible floor ring + label sprite under each
  // `RVSource`. Visibility-only (no rebuild) so the toggle is cheap and
  // safe to flip from the settings UI on every interaction.

  /** Unsubscribe handle for the source-markers reactive store. */
  private _sourceMarkersUnsub: (() => void) | null = null;

  /** Unsubscribe handle for the vanish-MUs reactive store. */
  private _vanishMUsUnsub: (() => void) | null = null;

  /**
   * Show or hide the floor markers under every Source in the current
   * scene. Persists the choice to localStorage via the
   * `'rv-source-markers-visible'` key.
   *
   * Idempotent — calling with the same value as already stored is a no-op
   * from the user's perspective (the reactive subscriber would not fire).
   * For consistency this method always re-applies the visibility to every
   * source's marker, even when the persisted value didn't change, so a
   * just-loaded scene picks up the current state immediately.
   */
  setSourceMarkersVisible(visible: boolean): void {
    setSourceMarkersVisibleStore(visible);
    this._applySourceMarkersVisible(visible);
  }

  /** Walk every source in the current transport manager and apply the flag.
   *  AND-gated with the 'markers' overlay category (plan-250): the user's
   *  source-marker setting is the fine control, the category is the overriding
   *  master switch. */
  private _applySourceMarkersVisible(visible: boolean): void {
    const tm = this.transportManager;
    if (!tm) return;
    const eff = visible && isOverlayVisible('markers');
    for (const source of tm.sources) {
      source.setMarkerVisible?.(eff);
    }
  }

  /**
   * Wire the reactive `'rv-source-markers-visible'` store to the loaded
   * scene's Sources. Called once after the scene loads so the initial
   * value is applied AND subsequent settings-panel changes propagate
   * without callers having to wire it themselves.
   *
   * Safe to call multiple times — re-subscribing replaces the prior
   * handle.
   */
  private _installSourceMarkersBinding(): void {
    this._sourceMarkersUnsub?.();
    // Apply current value once so freshly-loaded sources reflect the
    // persisted setting.
    this._applySourceMarkersVisible(getSourceMarkersVisible());
    this._sourceMarkersUnsub = subscribeSourceMarkersVisible(() => {
      this._applySourceMarkersVisible(getSourceMarkersVisible());
    });
    // Re-apply when the 'markers' overlay category is toggled (plan-250).
    const offOverlay = subscribeOverlayVisibility(() => {
      this._applySourceMarkersVisible(getSourceMarkersVisible());
    });
    const prevUnsub = this._sourceMarkersUnsub;
    this._sourceMarkersUnsub = () => { prevUnsub(); offOverlay(); };
  }

  // ─── Vanish MUs at end of line ─────────────────────────────────────
  //
  // When ON, an MU that leaves all transport surfaces (ran off the end of the
  // line, no successor belt) is deleted after a short delay. Toggled from the
  // Layout-Planner toolbar; the flag lives on the transport manager.

  /**
   * Enable/disable end-of-line MU vanishing. Persists to localStorage and
   * pushes the flag onto the live transport manager.
   */
  setVanishMUs(enabled: boolean): void {
    setVanishMUsStore(enabled);
    this._applyVanishMUs(enabled);
  }

  /** Push the vanish flag onto the current transport manager (no-op if none). */
  private _applyVanishMUs(enabled: boolean): void {
    if (this.transportManager) this.transportManager.vanishMUsAtEndOfLine = enabled;
  }

  /**
   * Wire the reactive vanish-MUs store to the loaded scene's transport manager.
   * Called once after a model loads so the persisted value is applied to the
   * fresh manager and later toggles propagate without callers wiring it.
   * Safe to call multiple times — re-subscribing replaces the prior handle.
   */
  private _installVanishMUsBinding(): void {
    this._vanishMUsUnsub?.();
    this._applyVanishMUs(getVanishMUs());
    this._vanishMUsUnsub = subscribeVanishMUs(() => {
      this._applyVanishMUs(getVanishMUs());
    });
  }

  /**
   * Force-clear pause reasons. Intended as a last-resort dev/debug escape
   * when a plugin leaked its pause-reason (e.g. crashed before `dispose()`
   * could release it). Logs a warning so leaks are observable in production.
   *
   * @param reason  If provided, only that reason is removed. If omitted,
   *                ALL active pause reasons are cleared.
   */
  clearPauseReasons(reason?: string): void {
    if (!this.runtime.pauseReasons.length) return;
    if (reason !== undefined) {
      if (!this.runtime.pauseReasons.includes(reason)) return;
      console.warn(`[SimControl] Force-clearing pause reason: '${reason}'`);
      const changed = this.runtime.setPaused(reason, false);
      if (changed) this._emitPauseChanged(reason);
      return;
    }
    const snapshot = [...this.runtime.pauseReasons];
    console.warn(`[SimControl] Force-clearing pause reasons: ${snapshot.join(', ')}`);
    let lastChanged = false;
    let lastReason = '';
    for (const r of snapshot) {
      lastChanged = this.runtime.setPaused(r, false) || lastChanged;
      lastReason = r;
    }
    if (lastChanged) this._emitPauseChanged(lastReason);
  }

  /**
   * Re-entrancy-guarded emit for `'simulation-pause-changed'`. If a subscriber
   * synchronously calls `setSimulationPaused` from inside the handler, the
   * nested emission is suppressed to avoid event-driven feedback loops.
   * (The pause-set itself is still updated — only the recursive event is skipped.)
   */
  private _emittingPauseChanged = false;
  private _emitPauseChanged(reason: string): void {
    if (this._emittingPauseChanged) return;
    this._emittingPauseChanged = true;
    try {
      this.emit('simulation-pause-changed', {
        paused: this.runtime.isPaused,
        reasons: this.runtime.pauseReasons,
        reason,
      });
    } finally {
      this._emittingPauseChanged = false;
    }
  }

  /** True if any reason is currently holding the simulation paused. */
  get isSimulationPaused(): boolean { return this.runtime.isPaused; }

  /** Snapshot of active pause reasons (for diagnostics / UI badges). */
  get simulationPauseReasons(): readonly string[] { return this.runtime.pauseReasons; }

  /**
   * Reset the running model to its freshly-loaded "start" state — like a reload,
   * but without re-fetching/re-parsing the GLB. Every component restores its
   * internal variables and state to the start.
   *
   * Three phases, surfaced as events so components (and plugins) can react:
   *
   * 1. **`'simulation-reset'`** — components restore their internal state to the
   *    start: behaviors (Conveyor / Turntable / ChainTransfer) reset their FSM,
   *    part counters, timers and routing bookkeeping; drives snap back to their
   *    authored `StartPosition` (`RVDrive.reset()`); conveyor belt textures
   *    rewind. Then the engine-level state is cleared: live MUs, sensor
   *    occupancy, sources, grips and counters (`transportManager.reset()`),
   *    LogicSteps to `Idle` (`logicEngine.reset()`), and the active DES executor.
   * 2. **`'simulation-resetstat'`** — statistics accumulators are cleared
   *    (registrations persist). Also fired standalone for DES stat-only resets.
   * 3. **`'simulation-start'`** — components (re)start from the clean state
   *    (e.g. conveyors re-assert `Run = true`).
   *
   * Intentionally leaves untouched:
   * - **Signals** are NOT blanket-reset: that would fight Live mode (Unity / PLC
   *   stream) where the next tick overwrites them anyway. Instead each component
   *   re-establishes only the signals it OWNS in its `onReset` / `onStart`
   *   handler (e.g. a conveyor zeroes `PartCount`, re-asserts `Run`).
   * - **Pause state**: untouched. Reset can be invoked while paused or running.
   */
  resetSimulation(): void {
    // ── Phase 1: RESET ──────────────────────────────────────────────────────
    // Notify components FIRST so behavior FSMs / counters / bookkeeping are
    // restored before the engine drops the live MUs they may reference.
    this.emit('simulation-reset');

    this._simTime = 0; // Plan 201 (E2): restart the sim clock

    // Drives back to their authored start pose (position/speed/jog/running).
    // Conveyor (transport-surface) drives keep their belt jog so belts resume
    // running like a freshly-loaded scene — see RVDrive.reset().
    for (const drive of this.drives) drive.reset();

    // Engine-level clear: live MUs, sensor occupancy, sources, grips, counters,
    // plus per-surface texture/transform accumulators.
    if (this.transportManager) this.transportManager.reset();
    if (this.logicEngine) this.logicEngine.reset();
    // Plan 194 P1 (K3): also reset the kernel's active executor so the DES
    // runner clears its own state. No-op for the continuous runner beyond the
    // transportManager.reset() above (same target).
    this._kernel?.activeExecutor.reset();

    // ── Phase 2: RESETSTAT ──────────────────────────────────────────────────
    this.statisticsManager.resetAll(); // Plan 201: reset accumulators (registrations persist)
    this.emit('simulation-resetstat');

    // ── Phase 3: START ──────────────────────────────────────────────────────
    this.emit('simulation-start');
  }

  /**
   * Plan 194 P6 — public accessor for the unified SimulationKernel.
   *
   * Returns the active kernel, building it on demand once a model is loaded
   * (so the Sim mode-toggle UI can read mode / `hasDesRunner()` even before
   * the first fixed tick). Returns `null` when no model is loaded yet — the
   * toggle then renders nothing. The UI imports only this + the public kernel
   * facade (never the private `DESRunner`, Plan 194 V7).
   */
  get simulationKernel(): SimulationKernel | null {
    return this._getKernel();
  }

  /**
   * Plan 201 (E2) — the single authoritative simulation clock in seconds.
   * Continuous path: accumulated `dt` per fixed step. Unified DES mode: the DES
   * executor's event time (so time jumps are reflected). This is the clock every
   * component's `StateStatistics` reads (`clockFn = () => viewer.simTime`).
   */
  get simTime(): number {
    const des = this._kernel?.desControl();
    if (des) return des.simTime;
    return this._simTime;
  }

  /**
   * Plan 194 P1 — lazily build (or return) the unified SimulationKernel,
   * reusing the viewer's EXISTING transportManager + behaviors. Returns null
   * when no transportManager/model is loaded yet.
   */
  private _getKernel(): SimulationKernel | null {
    if (!this.transportManager || !this.currentModel) return null;
    if (this._kernel) return this._kernel;
    // Phase B: the runner composes the CoreSubsystems pipeline (drive loop +
    // visuals) around the transport→behaviours pair, and evaluates the
    // physics-plugin transport bypass per tick via the gate.
    const runner = new ContinuousRunner(
      this.transportManager,
      this.behaviors,
      this._coreSubsystems,
      () => !this._physicsPluginActive,
    );
    this._kernel = new SimulationKernel({
      continuousRunner: runner,
      // Pass the viewer as the bind-context host so the DESRunner can discover
      // and bind placed material-flow components on start() (Plan 194 P5b).
      // Root is the WHOLE scene (not just currentModel): Planner-placed
      // LayoutObjects live under `_layoutRoot`, a sibling of currentModel, so the
      // DES scene-binding traversal must cover the full scene to find them. The
      // bind pass filters on the `LayoutObject` marker, so fixtures (lights,
      // ground, gizmos) are ignored. `scene` is also a stable reference across
      // model switches (currentModel is reassigned on load).
      topology: { root: this.scene, host: this as unknown as BindContextHost },
      // P5 wires the actual material-flow definitions in play; continuous
      // discovery already binds them via the BehaviorManager today.
      defs: [],
      // DES factory defaults to the stub (`null` in the public build) →
      // hasDesRunner() is false → the DES toggle stays hidden (P6).
      desRunnerFactory: createDesRunner,
      // Phase B: the DES runner composes the same CoreSubsystems pipeline so
      // drives/logic/visuals keep ticking at 60 Hz while the event queue runs.
      core: this._coreSubsystems,
      // Plan 194 P6: re-render the Sim mode-toggle UI on a successful switch.
      onModeChanged: (mode) => this.emit('simulation-mode-changed', { mode }),
    });
    // Re-bind the DES executor once a scene is fully loaded. The initial DES
    // bind (on setMode('des')) can run BEFORE the async planner placements
    // exist (boot-into-DES via ?mode=des): `scene-loaded` fires after Phase 4
    // (planner.applyPlacements), so a reset here re-discovers the now-placed
    // LayoutObjects. No-op outside DES mode; harmless on a fresh scene in DES
    // (clearMUs + re-bind). Registered once — `_kernel` is cached above.
    this.on('scene-loaded', () => {
      if (this._kernel?.mode === 'des') this._kernel.reset();
    });
    return this._kernel;
  }

  // #region NodeFilter
  // ─── Unified Node Filter ──────────────────────────────────────────
  //
  // Marked as a region rather than extracted to a separate service because
  // `filterNodes()` calls `this.emit()` which requires a circular reference
  // back to the viewer. See plan-177 section 2.4 (DESCOPED NodeFilterService)
  // for the rationale.

  private static readonly MAX_HIGHLIGHT_RESULTS = 20;

  /** Current drive search filter string (derived from node filter). */
  private _driveFilter = '';
  get driveFilter(): string { return this._driveFilter; }

  /** Drives matching the current filter (all drives if filter is empty). */
  private _filteredDrives: RVDrive[] = [];
  get filteredDrives(): RVDrive[] { return this._filteredDrives.length > 0 || this._driveFilter ? this._filteredDrives : this.drives; }

  /** Current node search filter string. */
  private _nodeFilter = '';
  get nodeFilter(): string { return this._nodeFilter; }

  /** Nodes matching the current filter. */
  private _filteredNodes: NodeSearchResult[] = [];
  get filteredNodes(): NodeSearchResult[] { return this._filteredNodes; }

  /** Unified search: filters ALL registered nodes. Subscribers extract their subset via events. */
  filterNodes(term: string): void {
    this._nodeFilter = term;
    this._driveFilter = term;

    if (!term.trim()) {
      this._filteredNodes = [];
      this._filteredDrives = [];
      // Restore chart-specific highlights if chart is open
      if (this.driveChartOpen) {
        const nodes = this.drives.map((d) => d.node);
        if (nodes.length > 0) this.highlighter.highlightMultiple(nodes);
      } else if (this.sensorChartOpen) {
        const sensors = this.transportManager?.sensors ?? [];
        const nodes = sensors.map((s) => s.node);
        if (nodes.length > 0) this.highlighter.highlightMultiple(nodes, { includeSensorViz: true });
      } else {
        this.highlighter.clear();
      }
      this.emit('node-filter', { filter: '', filteredNodes: [], tooMany: false });
      this.emit('drive-filter', { filter: '', filteredDrives: [] });
      return;
    }

    const allResults = this.registry?.search(term) ?? [];
    // Apply subscriber type filter from settings
    const settings = loadSearchSettings();
    const results = allResults.filter(r => isTypeEnabled(settings, r.types));
    this._filteredNodes = results;
    const tooMany = results.length >= RVViewer.MAX_HIGHLIGHT_RESULTS;

    // Highlight matching nodes (only if below threshold and highlight enabled)
    if (settings.highlightEnabled && !tooMany && results.length > 0) {
      const nodes = results.map(r => r.node);
      this.highlighter.highlightMultiple(nodes);
    } else {
      this.highlighter.clear();
    }

    // Derive drive-filter from node-filter (backwards compat)
    this._filteredDrives = this.drives.filter((d) =>
      results.some((r) => r.node === d.node)
    );

    this.emit('node-filter', { filter: term, filteredNodes: results, tooMany });
    this.emit('drive-filter', { filter: term, filteredDrives: this._filteredDrives });
  }

  /** Backwards-compatible wrapper. Delegates to filterNodes(). */
  filterDrives(term: string): void {
    this.filterNodes(term);
  }
  // #endregion NodeFilter

  /** Drive pinned by a card click (shown in tooltip until cleared). */
  focusedDrive: RVDrive | null = null;
  focusedNode: Object3D | null = null;

  // --- Dev Tools stats (polled by React DevToolsTab) ---
  /** Current FPS (updated every 500ms). */
  currentFps = 0;
  /** Current frame time in ms (updated every 500ms). */
  currentFrameTime = 0;
  /** Info from the last GLB load. */
  lastLoadInfo: { glbSize: string; loadTime: string } | null = null;

  /** Pick-path timing sink (raycast/resolve/highlight), polled by DevTools. */
  private readonly _pickMetrics = new PickMetrics();

  /** Load model with progress overlay (set by main.ts bootstrap).
   *  The optional `options.overlay` is forwarded to `loadModel` so the
   *  rv-extras overlay is applied during traversal (no race window).
   */
  /** Typed result returned by the host's progress-aware model loader. */
  loadModelWithProgress: ((url: string, options?: { overlay?: RVExtrasOverlay }) => Promise<ModelLoadOutcome>) | null = null;

  /**
   * Optional gate promise that must resolve before model loading begins.
   * Set by plugins like LoginGatePlugin to defer heavy loading until the
   * user has authenticated — avoids main-thread contention that causes
   * laggy login UI.
   */
  loadGate: Promise<void> | null = null;

  // --- XR state ---
  private _savedBackground: Color | null = null;
  private _savedShadowState = true;

  // --- Internal ---
  private replayRecordings: RVReplayRecording[] = [];
  private currentModel: Object3D | null = null;
  private sceneFixtures = new Set<Object3D>();
  private resizeHandler: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private simTickCount = 0;
  /**
   * Plan 201 (E2) — single authoritative simulation clock in seconds. Advanced
   * by `dt` each fixed step in the continuous path; in unified DES mode the
   * `simTime` getter returns the DES executor's event time instead. Reset to 0
   * on model load / clear / resetSimulation. Injected into every component's
   * `StateStatistics` (`clockFn = () => viewer.simTime`).
   */
  private _simTime = 0;
  private fpsFrameCount = 0;
  private fpsAccumTime = 0;
  private rendererInfoFrameCount = 0;
  private _lastGeoCount = 0;
  private _lastTexCount = 0;
  private ambientLight!: AmbientLight;
  private dirLight!: DirectionalLight;

  // --- Post-processing (WebGL only) ---
  // All composer / GTAO / N8AO / Bloom / desat / isolate-overlay state now
  // lives in `_postProcessing` (see PostProcessingManager). The viewer keeps
  // proxy getters/setters below so the 71 external consumers of RVViewer
  // continue to work unchanged. `_composer` and `_ensureComposer` stay as
  // accessors here too because RVOutlineManager talks to them directly
  // (matches the OutlineHostViewer interface contract).
  private _postProcessing!: PostProcessingManager;
  /** @internal — exposed to RVOutlineManager so it can insert OutlinePass. */
  get _composer(): EffectComposer | null { return this._postProcessing.composer; }

  /**
   * Viewer-owned library preview generator (plan-372 §2.7).
   *
   * Survives plugin teardown and is available with no plugin loaded. On a
   * WebGPU viewer the service reports `isAvailable === false` and resolves
   * every request with `null` — thumbnails need the classic WebGLRenderer.
   */
  get thumbnails(): ThumbnailService {
    if (!this._thumbnails) {
      this._thumbnails = new ThumbnailService({
        renderer: this.renderer as unknown as WebGLRenderer,
        scene: this.scene,
        isWebGPU: this.isWebGPU,
      });
    }
    return this._thumbnails;
  }

  // --- Toon (cel) render mode ---
  // Owns the Std→Toon material swap and the screen-space Sobel outline. Inert
  // unless the active render mode is 'toon'. See RVToonMaterialManager.
  private _toon!: RVToonMaterialManager;

  /** Diagnostic GPU info — populated synchronously at construction with the
   *  active adapter, then asynchronously merged with high-perf / low-power
   *  probes a tick later (best-effort, see rv-gpu-info.ts). Read via
   *  `getGPUInfo()`; consumers poll. */
  private _gpuInfo: GPUInfo | null = null;

  // --- Library preview thumbnails (plan-372 §2.7) ---
  // Owned by the viewer, not by the Layout Planner: the Projects dashboard
  // needs previews while the planner plugin may not be loaded at all. Built
  // lazily because most sessions never open a library, and on a WebGPU viewer
  // it is permanently inert (see ThumbnailService).
  private _thumbnails: ThumbnailService | null = null;

  private constructor(
    container: HTMLElement,
    renderer: Renderer,
    options: RVViewerOptions = {},
  ) {
    super();

    const showGround = options.ground ?? true;
    const autoResize = options.autoResize ?? true;

    // --- Renderer (already configured by create/_configureAndCreate) ---
    this.renderer = renderer;
    // Kind is derived from the renderer instance itself (single source of
    // truth — also covers the init()-failure fallback path in create()):
    // classic WebGLRenderer → 'webgl'; WebGPURenderer with a real WebGPU
    // backend → 'webgpu'; WebGPURenderer with forceWebGL → 'webgpu-gl'.
    this.hasCompute = this._detectWebGPU(renderer);
    this.rendererKind = ('isWebGPURenderer' in renderer)
      ? (this.hasCompute ? 'webgpu' : 'webgpu-gl')
      : 'webgl';
    // Semantics change (plan-271 review finding 1): isWebGPU means "any
    // WebGPURenderer" — under 'webgpu-gl' it MUST be true so all GLSL-only
    // consumers (composer/outline/AO, XR, splats, reflector, ground fade,
    // scene-loader fixes) keep skipping their WebGL-only paths.
    this.isWebGPU = this.rendererKind !== 'webgl';
    this._antialiasActive = options.antialias ?? false;
    this._plannerSignalLinking = options.plannerSignalLinking ?? false;
    // plan-320: authority ranking is module-level service config (survives
    // model switches); the write-gate mode is applied per-model store in
    // loadModel() (each load creates a fresh SignalStore).
    setAuthorityRanking(options.authorityRanking ?? 'strict');
    this._signalWriteGate = options.signalWriteGate ?? 'shadow';

    // --- GPU diagnostics ---
    // Sync detection first so `getGPUInfo()` returns a usable object
    // immediately (UI doesn't have to wait for the async probe). Then
    // kick off the optional adapter enumeration in the background;
    // when it resolves, merge non-duplicate entries onto _gpuInfo so
    // the next DevToolsTab poll picks them up.
    // Diagnostics follow the REAL backend (hasCompute), not the isWebGPU
    // derivation: under 'webgpu-gl' the pixels come from a WebGL2 context.
    this._gpuInfo = {
      backend: this.hasCompute ? 'webgpu' : 'webgl',
      active: detectActiveGPU(renderer, this.hasCompute ? 'webgpu' : 'webgl'),
    };
    void enumerateOtherAdapters().then((adapters) => {
      if (!this._gpuInfo) return;
      const active = this._gpuInfo.active;
      const highPerf = !isSameAsActive(adapters.highPerf, active) ? adapters.highPerf : undefined;
      const lowPower = !isSameAsActive(adapters.lowPower, active) ? adapters.lowPower : undefined;
      // Skip lowPower if it's identical to highPerf — single useful entry.
      const lowDiffersFromHigh = lowPower && highPerf
        && (lowPower.device.toLowerCase() !== highPerf.device.toLowerCase());
      this._gpuInfo = {
        ...this._gpuInfo,
        highPerf,
        lowPower: lowDiffersFromHigh ? lowPower : undefined,
      };
    });

    // --- Scene ---
    this.scene = new Scene();
    // Default background = 0x9a9a9a gray (scalar 0.604) scaled by backgroundBrightness.
    this.scene.background = new Color().setScalar(BG_BASE_SCALAR * this._backgroundBrightness);
    this.highlighter = new RVHighlightManager(this.scene);
    this.highlighter.setMetrics(this._pickMetrics);
    this.outlineManager = new RVOutlineManager(this);
    // --- Post-processing manager (constructed early so the OutlineManager,
    // which talks to `_composer` / `_ensureComposer()` via the host, sees a
    // backing manager whenever it eventually calls in). The host shape is
    // satisfied by `this` via the proxy getters below.
    const ppSelf = this;
    const ppHost: PostProcessingHost = {
      get renderer() { return ppSelf.renderer; },
      get scene() { return ppSelf.scene; },
      get camera() { return ppSelf.camera; },
      get isWebGPU() { return ppSelf.isWebGPU; },
      get antialiasActive() { return ppSelf._antialiasActive; },
      get outlineHasOutlines() { return ppSelf.outlineManager.hasOutlines; },
      get toonPassActive() { return ppSelf._toon?.passActive ?? false; },
      markRenderDirty() { ppSelf._renderDirty = true; },
    };
    this._postProcessing = new PostProcessingManager(ppHost);
    // Toon material/outline manager. Shares the composer + render-dirty plumbing
    // with the outline manager (same host shape), so its Sobel pass slots into
    // the composer the same way OutlinePass does.
    this._toon = new RVToonMaterialManager({
      get scene() { return ppSelf.scene; },
      get camera() { return ppSelf.camera; },
      get renderer() { return ppSelf.renderer; },
      get isWebGPU() { return ppSelf.isWebGPU; },
      get sceneFixtures() { return ppSelf.sceneFixtures; },
      get groundMesh() { return ppSelf._groundMesh; },
      get antialiasActive() { return ppSelf._antialiasActive; },
      _ensureComposer() { ppSelf._ensureComposer(); },
      get _composer() { return ppSelf._composer; },
      _ensureTslPost() { return ppSelf._postProcessing.ensureTslPost(); },
      markRenderDirty() { ppSelf._renderDirty = true; },
    });
    // A model loaded while toon mode is already active must be converted (its
    // materials swapped to the banded toon material) once it is fully built.
    this.on('model-loaded', () => {
      if (this._toon.isActive && this.currentModel) this._toon.convert(this.currentModel);
    });
    // Grow the checker floor to keep placed / dragged layout content on a
    // visible disc. Both events parent their objects under the model root, so
    // a re-fit (grow-only, coalesced to one per frame) tracks the live bounds.
    this.on('layout-transform-update', () => this._queueGroundFit());
    this.on('layout-drag-end', () => this._queueGroundFit());
    // Route standard hover/selection through the OutlinePass so they render
    // as a true silhouette (matching the layout planner look). Each channel
    // (hover / selection) keeps its own color, derived from the active
    // HighlightStyle's edgeColor — preserving the existing orange/cyan
    // palette while replacing the per-mesh overlay+edge meshes.
    this.highlighter.setOutlineManager(this.outlineManager);
    // Lazy getter for raycastManager: it's created later (loadGLB time), so a closure
    // is needed instead of passing the value directly. Once available, every gizmo
    // automatically participates in raycasting (hover/click resolves to owner node).
    this.gizmoManager = new GizmoOverlayManager(this.scene, () => this.raycastManager);
    this.lampManager = new LampManager();
    this.energyChainManager = new EnergyChainManager();
    // plan-394: collided bodies get the OutlinePass STATUS outline — the same
    // pulsing severity silhouette the error-message system uses (user decision
    // 2026-08-07), persistent while the pair is latched and independent of the
    // user's selection. Color = the warning-severity orange of the collision
    // cards (SEVERITY_COLORS.warning).
    this.collisionManager = new RVCollisionManager();
    this.collisionManager.setHighlightHost({
      showCollision: (roots) => showStatusOutline(this, roots, 0xffa726,
        { ownerKey: 'collision', pulsePeriod: 0.6 }),
      hideCollision: () => hideStatusOutline(this, 'collision'),
    });
    // Ping pulses render as mesh-glow-hull gizmos (same visual as the
    // CustomRuntimeInstruction highlight).
    this.highlighter.setGizmoManager(this.gizmoManager);

    // --- Camera ---
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    const aspect = w / h;
    this.perspCamera = new PerspectiveCamera(45, aspect, 0.01, 1000);
    this.perspCamera.position.set(3, 2.5, 4);
    this.perspCamera.lookAt(0, 0.5, 0);
    // Enable highlight-overlay layer so hover/select wireframes render in
    // normal mode. The 3-pass isolate renderer manages this layer per-pass.
    this.perspCamera.layers.enable(HIGHLIGHT_OVERLAY_LAYER);
    // Enable NO_AO so the RenderPass draws NO_AO-tagged UI (ghost, grid, glow
    // gizmos) normally. The AO clone camera turns this layer back OFF so those
    // objects never enter the GTAO/N8AO gbuffer.
    this.perspCamera.layers.enable(NO_AO_LAYER);

    const frustumHalf = 5;
    this.orthoCamera = new OrthographicCamera(
      -frustumHalf * aspect, frustumHalf * aspect, frustumHalf, -frustumHalf, 0.01, 1000,
    );
    this.orthoCamera.position.set(3, 2.5, 4);
    this.orthoCamera.lookAt(0, 0.5, 0);
    this.orthoCamera.layers.enable(HIGHLIGHT_OVERLAY_LAYER);
    this.orthoCamera.layers.enable(NO_AO_LAYER);

    this._activeCamera = this.perspCamera;

    // --- Lighting ---
    this.ambientLight = new AmbientLight(0xffffff, 1.8);
    this.scene.add(this.ambientLight);
    this.sceneFixtures.add(this.ambientLight);

    this.dirLight = new DirectionalLight(0xffffff, 1.5);
    // Match Unity realvirtual Sun prefab: euler (72.82, -150.577, -106.188)
    // Light FROM direction in Three.js: (0.145, 0.955, -0.257)
    this.dirLight.position.set(1.45, 9.55, -2.57);
    this.dirLight.castShadow = false;
    this.dirLight.shadow.mapSize.set(1024, 1024);
    this.dirLight.shadow.camera.near = 0.1;
    this.dirLight.shadow.camera.far = 50;
    this.dirLight.shadow.camera.left = -15;
    this.dirLight.shadow.camera.right = 15;
    this.dirLight.shadow.camera.top = 15;
    this.dirLight.shadow.camera.bottom = -15;
    this.dirLight.shadow.bias = -0.0005;
    this.dirLight.shadow.normalBias = 0.02;
    this.dirLight.shadow.intensity = 0.5;
    this.dirLight.shadow.radius = 2;

    // --- Delegated Managers ---
    // VisualSettingsManager reads/writes shared state on `this` (the facade).
    // We pass a thin object whose property accessors proxy back to the viewer.
    const self = this;
    this._visualSettings = new VisualSettingsManager({
      scene: this.scene,
      renderer: this.renderer,
      get isWebGPU() { return self.isWebGPU; },
      ambientLight: this.ambientLight,
      dirLight: this.dirLight,
      sceneFixtures: this.sceneFixtures,
      get _shadowsDirty() { return self._shadowsDirty; },
      set _shadowsDirty(v: boolean) { self._shadowsDirty = v; },
      get _renderDirty() { return self._renderDirty; },
      set _renderDirty(v: boolean) { self._renderDirty = v; },
      // Lets the env-map (IBL) load participate in loadModel's idle-drain
      // so the scene isn't revealed unlit.
      trackLoadingWork: (p) => self.trackLoadingWork(p),
    });

    // --- Ground ---
    if (showGround) {
      const { mesh: ground, canvas } = createGroundFade(this._checkerContrast, this.isWebGPU);
      ground.visible = true;
      ground.userData._rvGroundPlane = true;
      this.scene.add(ground);
      this.sceneFixtures.add(ground);
      this._groundMesh = ground;
      this._checkerCanvas = canvas;

      // Optional floor reflection (WebGL-only). A Reflector mirror sits just
      // beneath the checker plane; it stays hidden until reflectionEnabled is
      // set. Sized/positioned in lockstep with the checker in loadModel().
      const reflector = createGroundReflector(this.isWebGPU, ground);
      if (reflector) {
        reflector.position.y = -0.002; // a hair below the checker to avoid z-fighting
        reflector.userData._rvGroundReflector = true;
        this.scene.add(reflector);
        this.sceneFixtures.add(reflector);
        this._groundReflector = reflector;
      }
    }

    // --- Renderer-dependent init ---
    renderer.domElement.style.touchAction = 'none';
    // The canvas always fills its container via CSS (100%/100%); the drawing-buffer
    // resolution is updated separately by setSize(w, h, false) on resize. Letting CSS
    // own the display size means the canvas element keeps covering the full viewport
    // during a resize even before the buffer catches up — so the grey page background
    // (body { background:#9a9a9a }) can never show through a one-frame size gap.
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    container.appendChild(renderer.domElement);

    // --- WebGL context loss (mobile robustness) ---
    // Mobile GPUs drop the drawing context under memory pressure or when the tab
    // sits backgrounded. Without preventDefault the canvas stays permanently
    // blank (an "empty scene" with no error). Calling preventDefault lets the
    // browser attempt to restore the context; the emitted events let the UI show
    // a message and offer a reload.
    renderer.domElement.addEventListener(
      'webglcontextlost',
      (e) => {
        e.preventDefault();
        console.error('[RVViewer] WebGL context lost');
        this.emit('renderer-context-lost', undefined);
      },
      false,
    );
    renderer.domElement.addEventListener(
      'webglcontextrestored',
      () => {
        console.warn('[RVViewer] WebGL context restored');
        this._renderDirty = true;
        this._shadowsDirty = true;
        this.emit('renderer-context-restored', undefined);
      },
      false,
    );

    // --- Controls ---
    this.controls = new OrbitControls(this._activeCamera, renderer.domElement);
    // Dolly toward the cursor instead of the static orbit target. Without this,
    // OrbitControls' wheel-dolly scales distance to `target` by a fixed factor
    // per notch — asymptotic to the target, so close-up zoom in large scenes
    // (e.g. Gaussian Splat showrooms) feels frozen.
    this.controls.target.set(0, 0.5, 0);
    // Apply navigation-sensitivity settings (rotate/pan/zoom/damping) from store.
    const navSettings = loadVisualSettings();
    configureOrbitControls(this.controls, navSettings);
    this.controls.update();

    // Track orbit/pan/pinch gesture state to suppress selection & hover highlighting
    this.controls.addEventListener('start', () => {
      this._isOrbiting = true;
      if (this.raycastManager) this.raycastManager.setEnabled(false);
      this._cancelLongPress();
    });
    this.controls.addEventListener('end', () => {
      this._isOrbiting = false;
      if (this.raycastManager) this.raycastManager.setEnabled(true);
      // Keep rendering long enough for damping decay to fall below 1% velocity.
      // Budget adapts to current dampingFactor; capped at 300 frames (~5 s @ 60 fps).
      this._dampingFramesRemaining = Math.min(
        Math.ceil(Math.log(0.01) / Math.log(1 - this.controls.dampingFactor)),
        300,
      );
    });
    // Mark render dirty on any controls change (orbit, pan, zoom). Shadow
    // dirty is more nuanced: in the legacy tight-fit mode the shadow camera
    // adapts to the view frustum so every camera change needs a re-fit, but
    // once the uber-merge creates a static shadow caster we switch to a
    // full-scene shadow camera (see `_fitShadowToView`). That camera is
    // fixed at scene center with `_shadowPadMax` bounds and is completely
    // independent of where the user is currently looking, so rotation /
    // pan / zoom produce an identical shadow map — re-rendering it every
    // frame during interaction would literally double triangle throughput.
    this.controls.addEventListener('change', () => {
      this._renderDirty = true;
      const hasStaticUberCaster = (this._lastLoadResult?.uberBatchResult?.instanceCount ?? 0) > 0;
      if (!hasStaticUberCaster) {
        this._shadowsDirty = true;
      }
    });

    // Engine components (WebVisibility, …) announce runtime `.visible`
    // mutations on model nodes here — sync batch instances + shadow map.
    this.on('node-visibility-changed', () => this.markShadowsDirty());

    // CameraManager — uses proxy state to read/write shared fields on the facade.
    this._cameraManager = new CameraManager({
      perspCamera: this.perspCamera,
      orthoCamera: this.orthoCamera,
      get _activeCamera() { return self._activeCamera; },
      set _activeCamera(v) { self._activeCamera = v; },
      controls: this.controls,
      renderer: this.renderer,
      get _renderDirty() { return self._renderDirty; },
      set _renderDirty(v: boolean) { self._renderDirty = v; },
      leftPanelManager: this.leftPanelManager,
      getPlugin: <T>(id: string) => this.getPlugin(id) as T | undefined,
    });

    // --- Canvas events ---
    this._bindCanvasEvents(renderer.domElement);

    // --- XR (only for WebGL backend) ---
    this._setupXR(renderer, container);

    // --- Stats-gl ---
    this._setupStats(renderer);

    // --- Simulation Loop ---
    this.loop = new SimulationLoop(renderer);
    this.loop.onFixedUpdate = (dt: number) => this.fixedUpdate(dt);
    this.loop.onRender = () => this.render();
    this.loop.start();

    // Runtime attachment follows the workspace mode: modes registered with
    // `runtime: 'detached'` (e.g. the asset editor) switch time integration
    // fully off. Subscribed AFTER the ModeManager commit ('mode-changed'), so
    // plugin onModeDeactivate hooks still ran with a live runtime.
    this.on('mode-changed', ({ to }) => {
      this.runtime._setAttached(this.modes.descriptor(to)?.runtime !== 'detached');
      // A mode switch rebuilds the visuals — re-push the collision status
      // outline so an active collision keeps its emphasis across the switch
      // (plan-394 F15).
      this.collisionManager.reapplyHighlight();
    });

    // --- Resize (ResizeObserver on container — handles soft keyboard, orientation) ---
    if (autoResize) {
      this.resizeHandler = () => {
        const w = container.clientWidth || window.innerWidth;
        const h = container.clientHeight || window.innerHeight;
        const aspect = w / h;
        this.perspCamera.aspect = aspect;
        this.perspCamera.updateProjectionMatrix();
        // Keep ortho frustum in sync (canonical math lives in the CameraManager;
        // it reads perspCamera.aspect, which was just updated above).
        this._cameraManager.syncOrthoFrustum();
        // updateStyle:false — CSS owns the display size (100%/100%), we only
        // resize the drawing buffer. This keeps the canvas covering the viewport
        // during the resize and avoids fighting the CSS with inline px.
        this.renderer.setSize(w, h, false);
        this._postProcessing.setSize(w, h);
        // OutlinePass renders at full resolution — keep it in sync with the canvas.
        this.outlineManager.setSize(w, h);
        // Toon Sobel outline gbuffer also renders at full resolution.
        this._toon.setSize(w, h);
        // Render-on-demand: setSize reallocates (and clears) the drawing buffer
        // and the composer's render targets. Without an immediate redraw the
        // cleared buffer reaches the screen for a frame (grey flash) — or persists
        // until the next dirty event if the scene is static ("rendered grey").
        // Repaint synchronously, in this same frame, before the browser composites.
        this._renderDirty = true;
        this.render();
      };
      // Run synchronously in the ResizeObserver delivery (after layout, before
      // paint) rather than deferring a frame — the buffer then tracks the
      // container in the same frame it changes, with no one-frame grey gap.
      // Safe from the "ResizeObserver loop" warning: we resize the canvas (a
      // child) and the composer, never the observed `container` itself.
      this.resizeObserver = new ResizeObserver(() => this.resizeHandler!());
      this.resizeObserver.observe(container);
      // Fallback for browsers without ResizeObserver on window events
      window.addEventListener('resize', this.resizeHandler);
    }

    logInfo(`realvirtual WEB — Ready (${this.hasCompute ? 'WebGPU' : this.isWebGPU ? 'WebGPU (GL backend)' : 'WebGL'})`);

    // ─── Sub-Facaden (Phase 4a of plan-182) ────────────────────────────
    // Initialized last: all managers (controls, camera, scene) are ready.
    // Plugins reach these via this._pluginContext — not via direct field access.
    this._scene    = new SceneFacadeImpl(this);
    this._camera   = new CameraFacadeImpl(this);
    this._controls = new ControlsFacadeImpl(this);
    this._simLoop  = new SimLoopFacadeImpl(this);
    this._pluginContext = new PluginContextImpl(this);

    // Planner Signal Linking: resolve live bindings in TickStage.PRE — AFTER the
    // interface WS flush (legacy onFixedUpdatePre plugins run before PRE-tick
    // callbacks) and BEFORE drive physics (TickStage.SIM). order 50 keeps it
    // early within PRE. No-op when the feature flag is off (manager stays null).
    if (this._plannerSignalLinking) {
      this._simLoop.onTick(TickStage.PRE, (dt) => this.signalBindingManager?.tick(dt), 50);
    }

    // ─── Behavior auto-discovery hook ───────────────────────────────────
    // Attach the BehaviorManager so it listens for model-loaded /
    // model-cleared and dispatches all matching behaviors registered via
    // `registerAllBehaviors(viewer.behaviors)`. Per-context cleanup is
    // centrally guaranteed on model-cleared.
    this._behaviorsDetach = this.behaviors.attach(
      this as unknown as BindContextHost,
      () => this.currentModel,
      () => this._currentModelUrl,
    );
  }

  // ─── Post-Processing Pipeline (WebGL only) ─────────────────────────
  // The composer + GTAO/N8AO/Bloom/desat/isolate-overlay resources are
  // owned by `_postProcessing` (see PostProcessingManager). The methods
  // and getters below are thin delegations preserved for backwards
  // compatibility with RVOutlineManager and the viewer's own render path.

  /** Whether any post-processing effect is active (determines composer vs
   *  direct render). Always false while a WebXR session is presenting and
   *  always false on WebGPU — see {@link PostProcessingManager.useComposer}. */
  private get _useComposer(): boolean {
    return this._postProcessing.useComposer;
  }

  /**
   * Lazily create the EffectComposer with all post-processing passes.
   * @internal — also called by RVOutlineManager when outlines turn on.
   */
  _ensureComposer(): void {
    this._postProcessing.ensureComposer();
  }

  /**
   * Mirrors the Section tool's stable plane array to WebGL post-processing
   * override materials. The beauty pass receives the planes per model
   * material; GTAO and outline passes need this explicit companion binding.
   */
  setSectionClippingPlanes(planes: Plane[] | null): void {
    this._postProcessing.setClippingPlanes(planes);
    this._toon.setClippingPlanes(planes);
    this.outlineManager.setClippingPlanes(planes);
  }

  /**
   * Lazily create the TSL node-post pipeline (WebGPURenderer paths only —
   * plan-271 Phase 3). Mirrors `_ensureComposer()` for the TSL stack.
   * @internal — also called by RVOutlineManager / the toon manager via their
   * host interfaces. Returns null on classic WebGL or when the TSL module
   * pre-warm has not completed.
   */
  _ensureTslPost(): TslPostPipeline | null {
    return this._postProcessing.ensureTslPost();
  }

  /**
   * Three-pass render used when GroupRegistry.isIsolateActive is true:
   *   1. Dim backdrop — everything except the focus layer, through composer if enabled.
   *   2. Semi-transparent white overlay drawn over the dim frame.
   *   3. Focus group drawn crisply on top of the overlay.
   *
   * Caller (render()) saves and restores camera.layers.mask / renderer.autoClear
   * in a try/finally so exceptions can't corrupt global state. The composer,
   * desat, and isolate-overlay resources are all owned by _postProcessing.
   */
  private _renderIsolateMode(): void {
    this._postProcessing.ensureIsolateOverlay();
    // Re-tag isolated subtrees so dynamically added descendants (spawned MUs,
    // gripper pickups, async-loaded geometry, etc.) inherit ISOLATE_FOCUS_LAYER
    // and render in pass 3 instead of being washed by the dim overlay.
    this.groups?.refreshIsolateLayer();
    this.autoFilters?.refreshIsolateLayer();
    const camera = this.camera;
    // Cast to WebGLRenderer for autoClear / clearDepth typings. The running
    // instance is actually three/webgpu Renderer in forceWebGL mode — see
    // Background.js in the three/webgpu source for the clear gate.
    const gl = this.renderer as unknown as WebGLRenderer;

    // Check if desaturation is requested by any active isolate caller.
    const desaturate =
      this.autoFilters?.dimDesaturate ||
      !!(this.groups as { dimDesaturate?: boolean } | null)?.dimDesaturate;

    // Restrict shadow map to focus-layer objects only so dimmed objects
    // don't cast shadows onto the ground plane.
    const savedShadowLayers = this.dirLight.shadow.camera.layers.mask;
    this.dirLight.shadow.camera.layers.set(ISOLATE_FOCUS_LAYER);

    // ── Pass 1: Dim backdrop ──
    // enableAll + disable focus = "everything but focus", mutation-safe for
    // dynamically spawned nodes (MUs, tank fills, pipe-flow rings) which
    // default to layer 0 only. Also exclude overlay layers (highlight wires
    // and measurement markers/labels) so they don't render dim here — both
    // are re-rendered crisply in pass 4 above the AO/composer output.
    // Excluding MEASUREMENT_LAYER also prevents the label sprite from
    // contaminating the GTAO/N8AO depth sample → halo artifacts.
    camera.layers.enableAll();
    camera.layers.disable(ISOLATE_FOCUS_LAYER);
    disableOverlayLayers(camera);

    if (desaturate && this.isWebGPU) {
      // TSL desaturation blit (plan-271 Phase 3): the classic path's raw
      // ShaderMaterial below cannot run under WebGPURenderer — the shared
      // Rec601 saturation node grades the backdrop instead. Same three-step
      // dance: render backdrop to RT, blit desaturated, focus group on top.
      const blit = this._postProcessing.ensureDesatBlitTsl();
      if (blit) {
        blit.setSize(gl.domElement.width, gl.domElement.height);

        // Remove environment map during backdrop render (see WebGL branch).
        const savedEnv = this.scene.environment;
        this.scene.environment = null;

        // Custom-shim Renderer types setRenderTarget(target: unknown) — no
        // WebGLRenderTarget cast needed for the WebGPU RenderTarget.
        this.renderer.setRenderTarget(blit.renderTarget);
        gl.clear(true, true, false);
        gl.render(this.scene, camera);
        this.renderer.setRenderTarget(null);

        this.scene.environment = savedEnv;

        // saturation=0 → full grayscale (parity with the WebGL blit).
        blit.saturation.value = 0.0;
        gl.clear(true, true, false);
        blit.blit(this.renderer);
      } else {
        // TSL module pre-warm failed — dim backdrop without desaturation.
        gl.render(this.scene, camera);
      }
    } else if (desaturate) {
      // Render backdrop to offscreen RT, then blit desaturated to screen.
      this._postProcessing.ensureDesatPass();
      const rt = this._postProcessing.desatRT!;
      const w = gl.domElement.width;
      const h = gl.domElement.height;
      if (rt.width !== w || rt.height !== h) rt.setSize(w, h);

      // Remove environment map during backdrop render so metallic surfaces
      // don't show specular reflections (they'd appear as bright white spots
      // even after desaturation). Restored before Pass 3 (focus group).
      const savedEnv = this.scene.environment;
      this.scene.environment = null;

      // Render the full-color backdrop (everything except focus layer) into the RT.
      gl.setRenderTarget(rt);
      gl.clear(true, true, false);
      gl.render(this.scene, camera);
      gl.setRenderTarget(null);

      // Restore environment map for the focus group render (Pass 3).
      this.scene.environment = savedEnv;

      // Blit the RT to the default framebuffer through a desaturation shader.
      // saturation=0 → full grayscale; the focus group (Pass 3) renders in
      // full color on top afterwards.
      const desatMat = this._postProcessing.desatMat!;
      desatMat.uniforms.tDiffuse.value = rt.texture;
      desatMat.uniforms.saturation.value = 0.0;
      gl.clear(true, true, false);
      gl.render(this._postProcessing.desatScene!, this._postProcessing.desatCam!);
    } else if (this._useComposer) {
      // AO clone excludes NO_AO_LAYER (mirrors pass-1's reduced mask); RenderPass
      // keeps the real camera so NO_AO UI still draws in the dim backdrop.
      const aoCam = this._postProcessing.syncAoCamera(camera);
      const gtaoPass = this._postProcessing.gtaoPass;
      if (gtaoPass) gtaoPass.camera = aoCam;
      const n8 = this._postProcessing.n8aoPass as (Pass & { camera?: PerspectiveCamera | OrthographicCamera }) | null;
      if (n8) n8.camera = aoCam;
      const composer = this._postProcessing.composer!;
      const renderPass = composer.passes[0] as RenderPass;
      if (renderPass) renderPass.camera = camera;
      composer.render();
    } else {
      gl.render(this.scene, camera);
    }

    // CRITICAL: three/webgpu Background.js:44 sets `forceClear = true` when
    // `scene.background` is a Color, which BYPASSES `autoClear` and wipes
    // the framebuffer on every render call. For the remaining passes we
    // must disable both autoClear AND temporarily null the scene background,
    // then restore both afterwards.
    gl.autoClear = false;
    const savedBackground = this.scene.background;
    this.scene.background = null;
    // Sync overlay tint to the scene background color (Color → use as-is,
    // Texture/CubeTexture/null → fall back to the renderer clear color so
    // the fade still matches the visible sky).
    const overlayMat = this._postProcessing.isolateOverlayMat;
    if (overlayMat) {
      if (savedBackground && (savedBackground as Color).isColor) {
        overlayMat.color.copy(savedBackground as Color);
      } else {
        gl.getClearColor(overlayMat.color);
      }
      // Allow the active isolate caller to override the dim-opacity.
      // autoFilters takes precedence over groups; both fall back to the default 0.9.
      const override =
        this.autoFilters?.dimOpacity ??
        (this.groups as { dimOpacity?: number | null } | null)?.dimOpacity ??
        null;
      overlayMat.opacity = override ?? 0.9;
    }
    try {
      // ── Pass 2: Semi-transparent fullscreen overlay ──
      // Direct render — do NOT route through composer, the composer already
      // wrote its final color to the default framebuffer.
      gl.clearDepth();
      gl.render(this._postProcessing.isolateOverlayScene!, this._postProcessing.isolateOverlayCam!);

      // ── Pass 3: Focus group on top ──
      gl.clearDepth();
      camera.layers.set(ISOLATE_FOCUS_LAYER);
      gl.render(this.scene, camera);

      // ── Pass 4: Overlays on top of everything ──
      // Hover/select wireframes (HIGHLIGHT_OVERLAY_LAYER) and measurement
      // markers/lines/labels (MEASUREMENT_LAYER) — both have depthTest:false
      // and renderOrder>=11. Combined into a single overlay pass: the depth
      // clear keeps them visible regardless of pass-3 z-state, and rendering
      // here (after composer/desat) ensures AO never sees their depth and
      // never darkens their color.
      gl.clearDepth();
      setOverlayLayersOnly(camera);
      gl.render(this.scene, camera);
    } finally {
      this.scene.background = savedBackground;
      this.dirLight.shadow.camera.layers.mask = savedShadowLayers;
    }
  }

  // ─── Static Factory ──────────────────────────────────────────────────

  /**
   * Create a viewer instance. Always use this instead of `new RVViewer()`.
   * Three renderer paths (plan-271), default is the classic WebGLRenderer:
   *  - 'webgl' (default): classic WebGLRenderer — the proven production path.
   *  - 'webgpu': real WebGPU backend; requires `navigator.gpu`, falls back to
   *    classic WebGL when unavailable or when `init()` fails.
   *  - 'webgpu-gl': WebGPURenderer({ forceWebGL: true }) — TSL/NodeMaterial on
   *    a WebGL2 context (internal test path). Deliberately NO `navigator.gpu`
   *    check here: forceWebGL needs no WebGPU adapter (review finding 4).
   *    Falls back to the classic WebGLRenderer when `init()` fails.
   * `options.useWebGPU: true` is kept as a deprecated alias for
   * `renderer: 'webgpu'`.
   */
  static async create(
    container: HTMLElement,
    options?: RVViewerOptions,
  ): Promise<RVViewer> {
    const isTouchDevice = isMobileDevice();

    let kind: RendererKind = options?.renderer ?? (options?.useWebGPU ? 'webgpu' : 'webgl');
    if (kind === 'webgpu' && !navigator.gpu) {
      console.warn('[RVViewer] WebGPU not available, falling back to WebGL');
      kind = 'webgl';
    }

    let renderer: Renderer | undefined;

    if (kind === 'webgpu' || kind === 'webgpu-gl') {
      // WebGPURenderer (real backend or forceWebGL) — needs async init()
      const { WebGPURenderer } = await import('three/webgpu');
      const gpuRenderer = new WebGPURenderer({
        antialias: options?.antialias ?? false,
        alpha: true,
        stencil: true,
        forceWebGL: kind === 'webgpu-gl',
      } as any);
      try {
        await gpuRenderer.init();
        renderer = gpuRenderer;
      } catch (err) {
        console.warn(`[RVViewer] WebGPURenderer init() failed (${kind}), falling back to classic WebGL:`, err);
        gpuRenderer.dispose();
        kind = 'webgl';
        // fall through to classic WebGL path below
      }
    }

    if (!renderer) {
      // Standard WebGL: use the proven WebGLRenderer (no init needed)
      renderer = new WebGLRenderer({ antialias: options?.antialias ?? false, alpha: true, stencil: true, powerPreference: 'high-performance' }) as unknown as Renderer;
    }

    const viewer = RVViewer._configureAndCreate(renderer, container, isTouchDevice, options);

    // TSL pre-warm (plan-271 review finding 2): the material factory stays
    // synchronous, so the TSL modules must be cached BEFORE the first
    // loadModel() traverses the GLB. No-op under classic WebGL; never throws
    // (a failed preload leaves the F4 guard fallbacks active).
    if (viewer.isWebGPU) {
      await preloadTslMaterials(createMaterialContext(viewer.rendererKind, viewer.hasCompute));
    }

    return viewer;
  }

  /** Shared renderer config — called by create() and fallback path. */
  private static _configureAndCreate(
    renderer: Renderer,
    container: HTMLElement,
    _isTouchDevice: boolean,
    options?: RVViewerOptions,
  ): RVViewer {
    renderer.setSize(
      container.clientWidth || window.innerWidth,
      container.clientHeight || window.innerHeight,
    );
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, DEFAULT_DPR_CAP));
    renderer.shadowMap.enabled = false;
    (renderer.shadowMap as unknown as { autoUpdate: boolean }).autoUpdate = false;
    renderer.toneMapping = NoToneMapping;
    // Disable the auto-reset of renderer.info.render so we can accumulate
    // stats across multiple passes in a single frame (composer passes,
    // shadow map, etc.). Without this, the stats we read in getRendererInfo()
    // reflect only the LAST pass — typically a 1-triangle fullscreen
    // post-processing blit — and look completely wrong.
    (renderer.info as unknown as { autoReset: boolean }).autoReset = false;

    return new RVViewer(container, renderer, options ?? {});
  }

  // ─── Behaviors / Kinematics low-level binding ─────────────────────────

  /**
   * Apply a KinematicsSpec or a bind-callback to the given root subtree.
   *
   * Two forms:
   *   1. `viewer.bind(root, spec)` — applies the spec directly via
   *      {@link applyKinematicsSpec}.
   *   2. `viewer.bind(root, (rv) => { ... })` — runs the callback against a
   *      fresh RVBindContext, accumulates a spec from the calls, and
   *      applies it. Subscriptions (`onFixedUpdate`, `signals.on`,
   *      contextMenu) are NOT auto-disposed in this low-level entry; the
   *      caller may dispose them by listening to `model-cleared`. For
   *      Behavior-files use the BehaviorManager — it disposes for you.
   */
  bind(
    root: Object3D,
    specOrCb: KinematicsSpec | ((rv: RVBindContext) => void),
    opts?: { strict?: boolean; overwrite?: boolean },
  ): KinematizeReport {
    if (typeof specOrCb === 'function') {
      const accum: KinematicsSpec = {};
      const { ctx } = createBindContext(root, this as unknown as BindContextHost, accum);
      specOrCb(ctx);
      const merged: KinematicsSpec = {
        ...accum,
        strict: opts?.strict ?? accum.strict,
        overwrite: opts?.overwrite ?? accum.overwrite,
      };
      return applyKinematicsSpec(root, merged);
    }
    const merged: KinematicsSpec = {
      ...specOrCb,
      strict: opts?.strict ?? specOrCb.strict,
      overwrite: opts?.overwrite ?? specOrCb.overwrite,
    };
    return applyKinematicsSpec(root, merged);
  }

  // ─── Model Management ─────────────────────────────────────────────────

  /** Current raw rv_sig verification result for the loaded model. */
  getSignatureState(): SignatureState {
    return this._signatureState;
  }

  /** Append components created while a signed model remains gated. */
  registerDeferredLogic(deferred: DeferredLogic): void {
    if (this.logicRunState === 'active') {
      initializeComponents(deferred.pending, deferred.context);
      runOnSceneReady(deferred.pending, deferred.context);
      return;
    }
    this._deferredLogic.push(deferred);
  }

  /**
   * One-shot late Start/onSceneReady transition for invalid or unverifiable
   * signed models. Parallel callers are rejected by the activating CAS state.
   */
  async activateGatedLogic(): Promise<boolean> {
    if (this.logicRunState !== 'gated') return false;
    const generation = this._loadGeneration;
    const result = this._lastLoadResult;
    if (!result) return false;

    this.logicRunState = 'activating';
    this._publishSignatureUiState();
    this.emit('signature-state-changed', {
      signatureState: this._signatureState,
      logicRunState: this.logicRunState,
    });

    const deferred = this._deferredLogic.splice(0);
    for (const item of deferred) {
      initializeComponents(item.pending, item.context);
      if (generation !== this._loadGeneration) return false;
      runOnSceneReady(item.pending, item.context);
      if (generation !== this._loadGeneration) return false;
    }

    this._attachLogicSystems(result);
    if (generation !== this._loadGeneration) return false;
    this.logicRunState = 'active';
    persistSignatureUnlock(this._signatureModelName);
    this._publishSignatureUiState();
    this.emit('model-logic-activated', { result });
    this.emit('signature-state-changed', {
      signatureState: this._signatureState,
      logicRunState: this.logicRunState,
    });
    return true;
  }

  private _attachLogicSystems(result: LoadResult): void {
    this.drives = result.drives;
    this.transportManager = result.transportManager;
    this.playback = result.playback;
    this.replayRecordings = result.replayRecordings;
    this.logicEngine = result.logicEngine;
    this.ikPaths = result.registry.getAll<RVIKPath>('IKPath').map((record) => record.instance);
    this._kernel = null;

    if (this._plannerSignalLinking && !this.signalBindingManager && this.signalStore && this.registry) {
      this.signalBindingManager = new SignalBindingManager(this.signalStore, this.registry);
    }
    if (this.logicEngine) this.logicEngine.start();
    if (this.playback && (result.recorderSettings?.playOnStart ?? false)) this.playback.play();
  }

  private _publishSignatureUiState(): void {
    setSignatureUiState({
      signatureState: this._signatureState,
      logicRunState: this.logicRunState,
      modelName: this._signatureModelName,
      signerOrganization: this._signatureSignerOrganization,
      viewer: this,
    });
  }

  /**
   * Load a GLB model and start all simulation systems.
   *
   * @param url      GLB URL (file, blob:, or empty-glb URL)
   * @param options  Optional load options (e.g. an rv-extras overlay applied during traversal).
   */
  async loadModel(url: string, options?: {
    overlay?: RVExtrasOverlay;
    data?: ArrayBuffer;
    preserveHierarchy?: boolean;
    /** Stable local filename or URL-derived identity for signature unlock persistence. */
    modelName?: string;
  }): Promise<LoadResult> {
    // Load-generation guard (plan-240 F9) — any BVH build still running for a
    // previous model aborts on its next generation check. The async merge
    // phases of loadGLB (plan-274 B3/F7) capture the same snapshot via
    // `shouldAbort` below: a newer load/clear makes the stale loadGLB dispose
    // its constructed chunks + root and reject with LoadAbortedError.
    this._loadGeneration++;
    this.clearModel();
    // Snapshot AFTER clearModel() — it bumps the generation once more; the
    // snapshot must reflect the generation THIS load runs under.
    const loadGeneration = this._loadGeneration;
    this._currentModelUrl = url;
    this._signatureModelName = resolveModelName(options?.modelName ?? url);

    // --- Pre-load phase: load model plugins BEFORE GLB so they can register capabilities ---
    // Capabilities must be registered before buildRaycastGeometries() in loadGLB().
    // External plugin bundles (./project-plugin.js, ./models/<name>/model-plugin.js) are
    // an opt-in feature for deploys that ship standalone plugin bundles alongside the viewer.
    // Gated on appConfig.externalPlugins to avoid two 404s per model load on every other deploy
    // where no such bundle exists. The Vite-bundled ModelPluginManager below is the default path.
    if (getAppConfig().externalPlugins) {
      const modelBaseName = url.replace(/^.*\//, '').replace(/\.glb$/i, '');
      const tryPreloadPlugin = async (pluginUrl: string): Promise<void> => {
        try {
          const resp = await fetch(pluginUrl, { method: 'HEAD' });
          if (!resp.ok) return;
          const mod = await import(/* @vite-ignore */ pluginUrl);
          if (typeof mod.default === 'function') mod.default(this);
        } catch { /* skip silently */ }
      };
      await tryPreloadPlugin('./project-plugin.js');
      await tryPreloadPlugin(`./models/${modelBaseName}/model-plugin.js`);
    }
    if (this.modelPluginManager) {
      await this.modelPluginManager.onModelLoading(url, this);
    }

    // Wait for any load gate (e.g. login) before heavy GLB parsing
    if (this.loadGate) await this.loadGate;

    const result = await loadGLB(url, this.scene, {
      isWebGPU: this.isWebGPU,
      muComputeRenderer: this._muComputeRenderer(),
      gizmoManager: this.gizmoManager,
      lampManager: this.lampManager,
      energyChainManager: this.energyChainManager,
      collisionManager: this.collisionManager,
      outlineManager: this.outlineManager,
      errorStore: this.errorStore,
      instructionStore: this.instructionStore,
      events: this,
      overlay: options?.overlay,
      data: options?.data,
      preserveHierarchy: options?.preserveHierarchy,
      allowUntrustedLogic: isSignatureUnlocked(this._signatureModelName),
      // Async batch phases — stale-load abort (plan-274 pattern).
      shouldAbort: () => this._loadGeneration !== loadGeneration,
    });

    // Profile the expensive post-loadGLB steps separately (gated on ?debug=perf).
    const prof = createLoadProfiler('loadModel');
    prof.mark('loadGLB');

    // Pre-compile shaders to avoid first-frame stutter (available on WebGPURenderer)
    if ('compileAsync' in this.renderer) {
      try {
        await this.renderer.compileAsync(this.scene, this.camera, this.scene);
      } catch { /* non-critical */ }
    }
    prof.mark('compileAsync');

    // GLB root is reported deterministically by loadGLB (LoadResult.root) —
    // no diffing scene.children. The `_rvModelRoot` userData tag stays as
    // defence-in-depth so clearModel's tag-sweep can recover from any
    // historic stray that might still be tagged from prior buggy sessions.
    this.currentModel = result.root;
    this.currentModel.userData._rvModelRoot = true;
    this._signatureState = result.signatureState;
    this._signatureSignerOrganization = result.signerOrganization;
    this.logicRunState = result.logicGated ? 'gated' : 'active';
    this._deferredLogic = result.deferredLogic ? [result.deferredLogic] : [];
    this.drives = [];
    // Keep the manager available for geometry/HMI inspection. The central tick
    // gate prevents it from executing until _attachLogicSystems().
    this.transportManager = result.transportManager;
    // Bridge end-of-line vanish to snap connectivity: a connected outgoing snap
    // (e.g. a conveyor → rotated turntable) must never let its MUs vanish even
    // when geometry no longer overlaps. Structural snap-registry access keeps the
    // engine free of any snap-plugin dependency; queried lazily so it always sees
    // the current pairings. The asset root is the topmost `_layoutObject`
    // ancestor — exactly the registry `ownerRoot` set at placement time.
    if (this.transportManager) {
      type SnapLike = { flow?: string; pairedSnapId?: string; ownerRoot: Object3D };
      type SnapRegLike = {
        getByOwnerRoot(r: Object3D): readonly SnapLike[];
        getById(id: string): SnapLike | undefined;
      };
      this.transportManager.isOutputConnected = (surface) => {
        const reg = this.getPlugin<RVViewerPlugin & { getRegistry?(): SnapRegLike | undefined }>(
          'snap-point')?.getRegistry?.();
        if (!reg) return false;
        let root: Object3D | null = null;
        for (let cur: Object3D | null = surface.node; cur; cur = cur.parent) {
          if (cur.userData?._layoutObject === true) root = cur;
        }
        if (!root) return false;
        for (const sp of reg.getByOwnerRoot(root)) {
          if (sp.flow !== 'out' || !sp.pairedSnapId) continue;
          const partner = reg.getById(sp.pairedSnapId);
          if (partner && partner.ownerRoot !== root) return true;
        }
        return false;
      };
    }
    this._simTime = 0; // Plan 201 (E2): fresh sim clock for the new model
    this.statisticsManager.clear(); // Plan 201: drop prior model's registrations (components re-register on bind)
    // Plan 194 P1: invalidate the unified kernel so it rebuilds against the new
    // transportManager on the next tick.
    this._kernel = null;
    this.signalStore = result.signalStore;
    this.signalStore.signalWriteGate = this._signalWriteGate;
    // plan-394: (re)wire the collision manager to THIS model — its signals and
    // its MU spawn/remove stream. Reporting goes through the live card store;
    // there is no modal round-trip anymore.
    this.collisionManager.attachSignals(this.signalStore);
    this.collisionManager.invalidate();
    if (result.transportManager) result.transportManager.muLifecycleHook = this.collisionManager;
    this.playback = null;
    this.replayRecordings = [];
    this.logicEngine = null;
    this.registry = result.registry;
    // Planner Signal Linking: (re)build the binding manager against the fresh
    // signalStore + registry. Gated by the feature flag — null otherwise so no
    // override path, badge, or guard ever runs.
    if (this._plannerSignalLinking && this.logicRunState === 'active') {
      this.signalBindingManager?.dispose();
      this.signalBindingManager = new SignalBindingManager(this.signalStore, this.registry);
    }
    // Collect robot IK paths (replay engine) from the registry for per-frame ticking.
    this.ikPaths = [];
    this.groups = result.groups;
    if (this.logicRunState === 'active') this._attachLogicSystems(result);

    // Wire the source-floor-marker visibility flag (plan-181) — applies the
    // persisted value to all freshly-loaded Sources AND subscribes to future
    // settings-panel toggles. Idempotent across re-loads.
    this._installSourceMarkersBinding();

    // Wire the end-of-line vanish-MUs flag onto the fresh transport manager
    // (applies the persisted value + subscribes to toolbar toggles).
    this._installVanishMUsBinding();

    // Component event dispatcher — routes viewer events (object-hover, object-clicked,
    // selection-changed) to per-component onHover/onClick/onSelect callbacks.
    // Must be created after registry is available.
    if (this.componentEventDispatcher) {
      this.componentEventDispatcher.dispose();
    }
    this.componentEventDispatcher = new ComponentEventDispatcher(this, result.registry);

    // Build auto-filter groups from component capabilities
    this.autoFilters = new AutoFilterRegistry();
    this.autoFilters.build(result.registry);

    // Selection manager — init after registry is available
    this.selectionManager.init(this);

    // Register core "Focus" + "Isolate" context menu items (available for all nodes)
    this.contextMenu.register({
      pluginId: '_core',
      items: [
        {
          id: '_core.focus',
          label: 'Focus',
          order: 1,
          shortcut: 'F',
          action: (target) => {
            this.fitToNodes([target.node]);
            this.selectionManager.select(target.path);
          },
        },
        {
          id: '_core.isolate',
          label: () => (this._selectionIsolateActive ? 'Exit Isolate' : 'Isolate'),
          order: 2,
          // Editor mode has its own selection-centric menu — hide Isolate there
          condition: () => this.modes.activeMode !== 'editor',
          action: (target) => {
            if (this._selectionIsolateActive) {
              this.exitIsolate();
              return;
            }
            // If the right-clicked node is part of the current selection, isolate
            // the whole selection; otherwise isolate just that node (and select it).
            const snap = this.selectionManager.getSnapshot();
            let roots: Object3D[] = [];
            if (snap.selectedPaths.includes(target.path) && this.registry) {
              for (const p of snap.selectedPaths) {
                const n = this.registry.getNode(p);
                if (n) roots.push(n);
              }
            } else {
              roots = [target.node];
              this.selectionManager.select(target.path);
            }
            this.isolateNodes(roots);
          },
        },
      ],
    });

    // Register filter subscribers from capabilities registry
    for (const [type, caps] of getRegisteredCapabilities()) {
      if (caps.filterLabel) {
        registerFilterSubscriber({ id: type, label: caps.filterLabel, componentType: type });
      }
    }

    // Unified raycast manager with grouped BVH. Pass a getter (not the
    // current camera reference) so the raycaster always uses the active
    // camera even after a perspective ↔ orthographic swap. A captured
    // reference would go stale at the moment of the swap and produce
    // wrong rays in the new projection mode.
    this.raycastManager = new RaycastManager(
      this.renderer, () => this.camera, this.scene,
      result.registry, this.highlighter, this,
    );
    this._pickMetrics.reset();
    this.raycastManager.setMetrics(this._pickMetrics);
    // EnergyChain rigs are excluded from the pick BVH by contract (a SkinnedMesh
    // never enters it), so their invisible envelope hulls are the ONLY way they
    // become clickable. The raycast manager only exists from here on.
    this.energyChainManager.setRaycastHost(this.raycastManager);

    // Install central isolation gate — single invariant across all isolate
    // providers (GroupRegistry, AutoFilterRegistry, external/plugin isolates).
    // Stacks atop any plugin-specific allow filter.
    this.raycastManager.setIsolationGate((node) => {
      if (this.groups?.isIsolateActive && !this.groups.isInIsolatedSubtree(node)) return false;
      if (this.autoFilters?.isIsolateActive && !this.autoFilters.isInIsolatedSubtree(node)) return false;
      return true;
    });

    // Provide grouped raycast geometry (built during scene loading)
    if (result.raycastGeometrySet) {
      const muMeshes = this._collectInstancedMeshes();
      this.raycastManager.setRaycastGeometry(result.raycastGeometrySet, muMeshes);
      this._installHighlightProxyProvider(result.raycastGeometrySet);
      this._instancePickIndex = null;
    } else {
      // Authoring load (preserveHierarchy): the loader skipped the merged
      // groups — install the two-level instance pick backend instead. Real
      // meshes ARE the pick geometry (per-mesh local BVHs from the async
      // build below are the narrow phase); membership is maintained
      // incrementally by the asset-op executors, so NO full rebuild exists
      // in editor mode. No proxy provider either — editor highlights run on
      // real meshes (OutlinePass / legacy overlay pairs).
      const index = new InstancePickIndex(result.registry);
      index.addSubtree(result.root);
      this._instancePickIndex = index;
      this.raycastManager.setBackend(index);
      debug('loader', `[InstancePickIndex] editor pick backend: ${index.size} meshes`);
    }

    // Gizmos created during loadGLB (e.g. WebSensor outlines) were instantiated
    // before raycastManager existed. Register them AFTER setRaycastGeometry so
    // they survive the rebuild that setRaycastGeometry triggers.
    this.gizmoManager.refreshAuxRaycastTargets();

    // Async BVH build (plan-240): loadGLB deferred ALL BVH construction (per-mesh
    // Phase 13 AND the merged raycast geometries of Phase 13b). Kick off ONE
    // sequential background build — merged geometries first (few, huge, highest
    // benefit), then per-mesh. `model-loaded` below does NOT wait for it; until
    // completion, hover/click raycasts run through the native three.js fallback.
    this._startAsyncBvhBuild(result);

    // Enable hover types based on capabilities registry (hoverEnabledByDefault)
    const hoverDefaults = getTypesWithCapability('hoverEnabledByDefault');
    for (const type of hoverDefaults) {
      this.raycastManager.enableHoverType(type, true);
    }
    const pl = result.pipelineNodes;

    // Tank fill visualization (3D liquid level)
    if (pl.tanks.length > 0) {
      this.tankFillManager = new TankFillManager(pl.tanks, this.renderer as unknown as { localClippingEnabled?: boolean });
      if (this.tankFillManager.update()) {
        this._renderDirty = true;
      }
    }

    // Pipe flow visualization (animated rings)
    if (pl.pipes.length > 0) {
      this.pipeFlowManager = new PipeFlowManager(pl.pipes, this.isWebGPU);
    }

    // Resize ground plane to fit model bounds + margin
    const center = new Vector3();
    const size = new Vector3();
    if (result.boundingBox.isEmpty()) {
      // Empty / mesh-less GLB (e.g. the synthesized empty scene from
      // empty-glb.ts). Box3.getCenter/getSize on an empty box returns
      // ±Infinity, which would put the camera + orbit target at infinity
      // and lock OrbitControls. Synthesize a 15 m playground bbox so the
      // ground fade and camera framing land at a workable scale for an
      // empty workspace (drives the ground size below via FLOOR_FADE_*
      // and the initial camera distance further down).
      center.set(0, 0, 0);
      size.set(15, 1, 15);
    } else {
      result.boundingBox.getCenter(center);
      result.boundingBox.getSize(size);
    }

    // Plain model load: fit the floor exactly to the model footprint (no
    // authoring minimum) so existing demo-scene framing is unchanged.
    this._updateGroundPlane(center, Math.max(size.x, size.z));

    // Fit camera to model

    const maxDim = Math.max(size.x, size.y, size.z);
    // For an empty base (synthesized 15 m playground bbox above) the user
    // is authoring at workspace scale — frame the camera close to a 5 m
    // working area so the initial view matches what the user is about to
    // build, not the full 15 m ground extent. Shadow / sun fit below still
    // uses `maxDim` so coverage extends across the whole ground.
    const cameraFitDim = result.boundingBox.isEmpty() ? 5 : maxDim;
    const dist = this._cameraManager.fitDistance(cameraFitDim, 1.5);

    this.camera.position.set(center.x + dist * 0.7, center.y + dist * 0.5, center.z + dist * 0.7);
    this.controls.target.copy(center);
    this.controls.update();

    // Fit directional light shadow camera to model
    // Light direction matches Unity realvirtual Sun prefab: euler (72.82, -150.577, -106.188)
    // Light FROM direction in Three.js: (0.145, 0.955, -0.257)
    {
      this._shadowPadMax = Math.max(maxDim * 1.2, 5);
      const sunDist = maxDim * 2;
      this.dirLight.position.set(
        center.x + 0.145 * sunDist,
        center.y + 0.955 * sunDist,
        center.z + -0.257 * sunDist,
      );
      this.dirLight.target.position.copy(center);
      this.dirLight.shadow.camera.left = -this._shadowPadMax;
      this.dirLight.shadow.camera.right = this._shadowPadMax;
      this.dirLight.shadow.camera.top = this._shadowPadMax;
      this.dirLight.shadow.camera.bottom = -this._shadowPadMax;
      this.dirLight.shadow.camera.near = 0.1;
      this.dirLight.shadow.camera.far = Math.max(maxDim * 4, 50);
      this.dirLight.shadow.camera.updateProjectionMatrix();
    }

    // --- Auto-load model sidecar settings (first visit only) ---
    // --- Load and merge model-specific plugin configuration ---
    const [modelJsonConfig, glbConfig] = await Promise.all([
      loadModelJsonConfig(url).catch(() => ({} as ModelConfig)),
      Promise.resolve(extractGlbPluginConfig(this.scene)),
      loadModelSettingsConfig(url),
    ]);
    const settingsConfig: ModelConfig = {};
    const appConfig = getAppConfig();
    if (appConfig.plugins) settingsConfig.plugins = appConfig.plugins;
    if (appConfig.pluginConfig) settingsConfig.pluginConfig = appConfig.pluginConfig;

    result.modelConfig = mergeModelConfig(modelJsonConfig, glbConfig, settingsConfig);

    // Note: Project/model plugin loading (tryPreloadPlugin, modelPluginManager.onModelLoading)
    // was moved to the pre-load phase BEFORE loadGLB() so plugins can register capabilities
    // before BVH construction. See top of loadModel().

    // Plugin lifecycle: onModelLoaded (before event, with error isolation)
    // Activation mode depends on whether rv_plugins is declared anywhere.
    this._lastLoadResult = result;

    // Batched render path: per-instance visibility sync for the model's
    // BatchedMesh arenas (starts dirty — first rendered frame reconciles).
    this._batchVisibility = result.batchTable && result.batchTable.instanceCount > 0
      ? new BatchVisibilityService(result.root, result.batchTable)
      : null;
    this._batchVisSafetyCounter = 0;
    // Mode-scoped plugins outside the active mode (including the null "no mode"
    // boot window BEFORE main.ts applies the workspace mode) must not receive
    // onModelLoaded. Selective rv_plugins eligibility is enforced before a
    // plugin is recorded as having missed the lifecycle callback.
    await this._notifyPluginsModelLoaded(result);

    // Re-evaluate _physicsPluginActive — plugins may have changed handlesTransport in onModelLoaded
    this._recomputePhysicsPluginActive();
    prof.mark('onModelLoaded-plugins');

    // Ensure first frame renders fully (shadows + scene)
    this._shadowsDirty = true;
    this._renderDirty = true;

    // reverse-ref index is built lazily on first PropertyInspector access
    // (NodeRegistry.getReferencesTo), keeping it off the model-load critical path.

    logInfo(`Model loaded: ${this.drives.length} drives, ${this.signalStore?.size ?? 0} signals`);
    // Overlay-visibility (plan-250): mark categories present based on scene
    // content so the Display panel only lists what actually exists. Cleared
    // centrally in clearModel via reset. GizmoManager-backed categories
    // (status/signals/…) register themselves per handle; these are the
    // own-geometry producers that don't go through the GizmoManager.
    registerOverlayProducer('highlights'); // hover/selection highlight — any model
    if (this.drives.length > 0) registerOverlayProducer('gizmos'); // drive-axis gizmo
    if ((this.transportManager?.sources.length ?? 0) > 0) registerOverlayProducer('markers'); // source markers
    this.emit('model-loaded', { result });
    this._publishSignatureUiState();
    this.emit('signature-state-changed', {
      signatureState: this._signatureState,
      logicRunState: this.logicRunState,
    });
    if (this.logicRunState === 'active') {
      this.emit('model-logic-activated', { result });
    }
    // Wait for any deferred async loading work registered by subsystems
    // and plugins (env-map IBL, deferred asset prefetch, …) so the caller's
    // `await viewer.loadModel(...)` only resolves once the scene is fully
    // ready to be revealed.
    await this.whenLoadingIdle();
    prof.mark('whenLoadingIdle');
    prof.report();
    return result;
  }

  /**
   * Start the asynchronous BVH build for a freshly loaded model (plan-240).
   * Fire-and-forget: never throws into the load path. The build
   *   1. waits two animation frames so the renderer uploads the fresh vertex
   *      buffers BEFORE the worker path transfers (temporarily detaches) them,
   *   2. builds the merged raycast geometries (indirect mode) first, then the
   *      per-mesh BVHs — all sequentially through ONE reused port/worker,
   *   3. aborts silently when the load generation moves on (new load / clear),
   *   4. emits 'raycast-ready' + flags a re-render on completion.
   */
  private _startAsyncBvhBuild(result: LoadResult): void {
    const generation = this._loadGeneration;
    const root = result.root;
    const indirectGeometries = result.raycastGeometrySet
      ? collectPendingBVHGeometries(result.raycastGeometrySet)
      : [];
    // Merged pick geometries without a BVH raycast via the native O(triangles)
    // fallback until the async build lands — surface that window in DevTools.
    // Editor instance-pick loads have NO merged geometries; there the pending
    // count is the per-mesh builds the backend's narrow phase waits for
    // (upper bound — shared geometries dedup inside computeBVHAsync).
    this._pickMetrics.setBvhPending(
      this._instancePickIndex ? this._instancePickIndex.size : indirectGeometries.length,
    );

    void (async () => {
      try {
        // Two rAFs ≈ one rendered frame with the new model — visible meshes
        // have their attribute buffers on the GPU before any worker transfer.
        if (typeof requestAnimationFrame !== 'undefined') {
          await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
        }
        if (this._loadGeneration !== generation) return;

        this._bvhPort ??= createBVHPort();
        const completed = await computeBVHAsync(root, this._bvhPort, {
          shouldAbort: () => this._loadGeneration !== generation,
          indirectGeometries,
        });
        if (!completed || this._loadGeneration !== generation) return;

        this._pickMetrics.setBvhPending(0);
        this._renderDirty = true;
        this.emit('raycast-ready', undefined);
      } catch (e) {
        console.warn('[viewer] async BVH build failed:', e);
      }
    })();
  }

  /** Remove the current model and reset all simulation state. */
  clearModel(): void {
    // Load-generation guard (plan-240 F9) — abort any BVH build still running
    // against the model being torn down (its geometries get disposed below).
    this._loadGeneration++;
    this.logicRunState = 'active';
    this._signatureState = 'none';
    this._signatureModelName = '';
    this._signatureSignerOrganization = undefined;
    this._deferredLogic.length = 0;
    resetSignatureUiState();

    // Plugin lifecycle: clear exactly the plugins that received this model,
    // including plugins disabled since their onModelLoaded delivery.
    this._notifyPluginsModelCleared();

    // Close context menu to prevent stale target references
    this.contextMenu.close();

    // Safety net: clear all dynamic UI contexts, preserve initial ones from
    // config. The active workspace-mode context (plan-198) is app-level state
    // that MUST survive a model switch — otherwise the mode-gated UI (planner
    // panel/tools, DES panel) disappears when loading another scene. Keep it.
    const initialCtxs = getAppConfig().ui?.initialContexts;
    const keepCtxs = Array.isArray(initialCtxs) ? [...initialCtxs] : [];
    if (this.modes.activeMode) keepCtxs.push(modeContext(this.modes.activeMode));
    resetDynamicContexts(keepCtxs);

    // Batched render path: dispose the arenas (frees arena geometry +
    // matrices/indirect textures) BEFORE the scene traverse below — the
    // batches are children of the model root but their geometry is not
    // per-child, so the generic traverse-dispose would miss the textures.
    this._lastLoadResult?.batchTable?.dispose();
    this._batchVisibility = null;

    this._lastLoadResult = null;
    this._missedModelLoad.clear();

    this.selectionManager.clear();
    this.selectionManager.dispose();

    if (this.raycastManager) {
      this.energyChainManager.setRaycastHost(null);
      this.raycastManager.dispose();
      this.raycastManager = null;
    }
    this._instancePickIndex?.clear();
    this._instancePickIndex = null;

    // §4.2 proxy provider dies with its RaycastGeometrySet — the shared
    // position/index VBOs are freed by the model-root geometry disposal below.
    if (this._highlightProxyProvider) {
      this.highlighter.setProxyProvider(null);
      this._highlightProxyProvider.dispose();
      this._highlightProxyProvider = null;
    }

    // Drop the source-markers subscription before nulling out the transport
    // manager — otherwise future settings-store toggles would try to iterate
    // a stale source list.
    this._sourceMarkersUnsub?.();
    this._sourceMarkersUnsub = null;
    this._vanishMUsUnsub?.();
    this._vanishMUsUnsub = null;

    // IMPORTANT: Reset transport manager BEFORE scene traverse to remove
    // active MU nodes from scene tree. MU clones share geometry by reference
    // with templates — disposing geometry during traverse would corrupt shared buffers.
    if (this.transportManager) {
      this.transportManager.reset();
      this.transportManager = null;
    }
    this.statisticsManager.clear(); // Plan 201: drop all component stats registrations
    // Plan 194 P1: drop the unified kernel with the model it was built against.
    this._kernel = null;

    // Collect every model root currently parented to the scene. Normally this
    // is just `this.currentModel`, but a `_rvModelRoot`-tagged orphan can
    // remain if a previous switch tracked the wrong child as currentModel
    // (see snapshot logic in loadModel). Sweeping all of them here ensures
    // we never end up with two scenes drawing simultaneously.
    const modelRootsToClear = new Set<Object3D>();
    if (this.currentModel) modelRootsToClear.add(this.currentModel);
    for (const child of this.scene.children) {
      if (child.userData?._rvModelRoot) modelRootsToClear.add(child);
    }

    // Toon mode swaps every mesh's material to a MeshToonMaterial. Restore the
    // original PBR materials BEFORE disposal so the MeshStandardMaterial-typed
    // teardown below frees them + their textures. Keeps toon active — the next
    // load re-converts via the `model-loaded` subscription.
    if (this._toon.isActive) this._toon.onModelClearing(modelRootsToClear);

    // plan-394 F12: drop the collision registry, highlight, signals and any
    // published cards BEFORE the geometry teardown.
    this.collisionManager.clear();
    // Restore Lamp-owned material clones before the generic material teardown.
    this.lampManager.clear();
    // Same for EnergyChain rigs: dispose restores the original meshes and drops
    // the skinned sidecars BEFORE their shared geometry/materials are freed.
    this.energyChainManager.clear();

    // After material deduplication, multiple meshes share the same material
    // instance. Use a Set to avoid disposing the same material/texture twice
    // across all roots being torn down in this pass.
    const disposedMaterials = new Set<MeshStandardMaterial>();
    for (const root of modelRootsToClear) {
      this.scene.remove(root);
      root.traverse((node) => {
        const mesh = node as {
          geometry?: { dispose(): void; disposeBoundsTree?: () => void };
          material?: (MeshStandardMaterial & { dispose(): void }) | (MeshStandardMaterial & { dispose(): void })[];
        };
        if (mesh.geometry) {
          // Free the three-mesh-bvh tree explicitly — geometry.dispose() only
          // releases GPU buffers, the CPU-side BVH would otherwise linger as
          // long as anything still references the geometry object.
          mesh.geometry.disposeBoundsTree?.();
          mesh.geometry.dispose();
        }
        if (mesh.material) {
          const disposeMat = (m: MeshStandardMaterial & { dispose(): void }) => {
            if (disposedMaterials.has(m)) return;
            disposedMaterials.add(m);
            // Shared fixtures (e.g. RVUberMaterial singleton) survive clearModel —
            // they outlive individual model loads and are reused on the next load.
            if (m.userData?._rvShared) return;
            m.map?.dispose();
            m.normalMap?.dispose();
            m.roughnessMap?.dispose();
            m.aoMap?.dispose();
            m.emissiveMap?.dispose();
            m.metalnessMap?.dispose();
            m.alphaMap?.dispose();
            m.envMap?.dispose();
            m.dispose();
          };
          if (Array.isArray(mesh.material)) mesh.material.forEach(disposeMat);
          else disposeMat(mesh.material);
        }
      });
    }
    this.currentModel = null;
    this.drives = [];
    this.ikPaths = [];
    if (this.playback) {
      this.playback.stop();
      this.playback = null;
    }
    this.replayRecordings = [];
    if (this.logicEngine) {
      this.logicEngine.reset();
      this.logicEngine = null;
    }
    if (this.tankFillManager) {
      this.tankFillManager.dispose();
      this.tankFillManager = null;
    }
    if (this.pipeFlowManager) {
      this.pipeFlowManager.dispose();
      this.pipeFlowManager = null;
    }
    // Dispose gizmo entries & dispatcher before registry is cleared
    this.gizmoManager.dispose();
    if (this.componentEventDispatcher) {
      this.componentEventDispatcher.dispose();
      this.componentEventDispatcher = null;
    }
    // Tear down Planner Signal Linking bindings before the store/registry go.
    if (this.signalBindingManager) {
      this.signalBindingManager.dispose();
      this.signalBindingManager = null;
    }
    // Slot-authority service reset (plan-320 Phase 2) — UNCONDITIONAL and
    // independent of the plannerSignalLinking/logicRunState gating above: the
    // viewer is the state owner and every model switch (clearModel runs at the
    // head of loadModel too) must drop claims, slot↔channel indexes, the
    // live-control gate and raised liveControlled instance flags. Do NOT move
    // this behind a feature flag (review finding: the template registries'
    // resets were never called from src/ at all).
    resetSlotAuthority();
    this.signalStore = null;
    this.registry = null;
    // Clear any active selection isolate before tearing down the group registry.
    this.exitIsolate();
    if (this.groups) {
      this.groups.clear();
      this.groups = null;
    }
    if (this.autoFilters) {
      this.autoFilters.clear();
      this.autoFilters = null;
    }
    // Reset dirty flags for next model load
    this._shadowsDirty = true;
    this._renderDirty = true;
    // Overlay-visibility (plan-250): zero all producer refcounts before the
    // next model's producers register. Safety net so a producer that misses
    // its unregister cannot leave a "ghost" category in the Display panel.
    resetOverlayProducers();
    this.emit('model-cleared');
  }

  /** Root Object3D of the currently loaded model (null if none). The asset
   *  editor treats this as the asset root it authors into. */
  get currentModelRoot(): Object3D | null {
    return this.currentModel;
  }

  /** URL of the currently loaded model (null if no model loaded). */
  get currentModelUrl(): string | null {
    return this._currentModelUrl;
  }

  /** Override the stored model URL (e.g. to replace blob: URL with original for display). */
  set currentModelUrl(url: string | null) {
    this._currentModelUrl = url;
  }

  // ─── Unified CAD import facade (plan-238) ─────────────────────────────

  /**
   * The global import provider registry (GLB file, STEP, Asset Manager,
   * Onshape …). Providers register themselves from core or `@rv-private`.
   */
  get importProviders(): ImportProviderRegistry {
    return importProviderRegistry;
  }

  /**
   * ADDITIVE import sink (plan-238 §2.2): place resolved import items into
   * the CURRENT scene via the layout planner (op log, undo/redo, autosave).
   * Never calls `loadModel`/`clearModel`. There is no replace sink — editor mode
   * imports into its asset document, and "open a GLB as the scene" is the model
   * picker's job.
   */
  importObject(
    items: ImportResultItem | ImportResultItem[],
    options?: ImportObjectOptions,
  ): Promise<ImportObjectOutcome> {
    return importObjectSink(this, items, options);
  }

  // ─── Scene loading (unified RvScene) ──────────────────────────────────

  /** Active scene record set by `loadScene()`. Read by the Scene window. */
  private _currentScene: RvScene | null = null;

  /** Read the currently loaded scene record, or null if none. */
  get currentScene(): RvScene | null {
    return this._currentScene;
  }

  /** Override the active scene record (used by main.ts after a side-channel
   *  load and by SceneStore once a save bumps modifiedAt). */
  set currentScene(s: RvScene | null) {
    this._currentScene = s;
  }

  /**
   * Load a unified Scene record — base GLB plus optional overlay, planner
   * placements, and camera preset.
   *
   * Apply order (deterministic):
   *   1. Resolve base URL (built-in / empty)
   *   2. Clear any planner placements from the previous scene
   *   3. loadGLB with `overlay` applied during traversal
   *   4. apply planner placements (if any)
   *   5. emit('scene-loaded')
   *
   * The camera preset (scene.cameraStart) is consumed by the camera-startpos
   * plugin, which subscribes to `scene-loaded`.
   * The BVH rebuild (after placements) is wired in PR 4.
   */
  async loadScene(scene: RvScene): Promise<void> {
    // Phase 0 — materialise edits (ops → overlay + placements + cameraStart).
    // The op log is the canonical store; existing engine subsystems
    // (rv-scene-loader.loadGLB, planner.applyPlacements, camera-startpos)
    // still consume their familiar shapes — materialise() bridges between
    // the two.
    const matMod = await import('./hmi/scene/rv-scene-edits');
    const materialised = matMod.materialise(scene.edits.ops);

    // Phase 1 — resolve base URL
    let url: string;
    if (scene.base.kind === 'empty') {
      const emptyGlb = await import('./hmi/scene/empty-glb');
      url = emptyGlb.getEmptyGlbUrl();
    } else {
      url = scene.base.url;
    }

    // Stash the active scene BEFORE loadModel so plugin onModelLoaded handlers
    // (e.g. the camera-startpos plugin) can prefer per-scene presets over the
    // per-base/legacy localStorage default. clearModel fires onModelCleared
    // first; that path doesn't read currentScene so the early stash is safe.
    this._currentScene = scene;

    // Phase 2 — clear previous planner placements + sweep any orphans
    // (defensive — see planner.sweepOrphanLayoutObjects).
    const planner = this.getPlugin<RVViewerPlugin & {
      clearLayout?: () => void;
      applyPlacements?: (snap: PlacementsSnapshot) => Promise<void>;
      ensureAttached?: (viewer: RVViewer) => void;
      sweepOrphanLayoutObjects?: () => void;
      setLayoutFloorVisible?: (visible: boolean) => void;
    }>('layout-planner');
    planner?.clearLayout?.();
    planner?.sweepOrphanLayoutObjects?.();

    // Phase 3 — loadGLB. Overlay is applied during traversal so component
    // constructors see overridden field values directly (no race window).
    const overlay = Object.keys(materialised.overlay.nodes).length > 0
      ? materialised.overlay
      : undefined;
    if (this.loadModelWithProgress) {
      await this.loadModelWithProgress(url, { overlay });
    } else {
      await this.loadModel(url, { overlay });
    }

    // Phase 4 — planner placements
    if (materialised.placements.length > 0) {
      if (!planner?.applyPlacements) {
        throw new Error('Scene has placements but Layout Planner plugin is not registered');
      }
      planner.ensureAttached?.(this);
      await planner.applyPlacements({
        placements: materialised.placements,
        catalogUrls: scene.edits.settings.catalogUrls,
        gridSizeMm: scene.edits.settings.gridSizeMm,
      });
    }

    // Phase 4b — keep the planner's authoring floor (`_layoutFloor`) hidden.
    // Both built-in and empty bases already render a floor: built-ins use
    // their own GLB ground, and empty bases use the viewer's `_groundMesh`
    // (the checker fade, deliberately sized to a 30 m playground when the
    // bbox is empty — see resize logic above loadModel). Showing the planner
    // floor on top would double up with either, producing the "duplicate
    // floor on reload" / "extra floor on empty scenes" symptoms.
    //
    // For empty bases we still call ensureAttached so the planner is wired
    // (raycast targets, ghost root) before any subsequent placement op runs.
    if (scene.base.kind === 'empty') {
      planner?.ensureAttached?.(this);
    }
    // applyPlacements() above unconditionally toggles the floor based on its
    // snapshot's `hasContent` — overrule it here so the visibility tracks
    // intent rather than placement count.
    planner?.setLayoutFloorVisible?.(false);

    // Phase 4c — op-created nodes (e.g. inserted IK waypoints). Create them, then
    // re-resolve IK paths so their target lists pick up the new nodes (they didn't
    // exist when IKPath.init() ran during loadGLB).
    if (materialised.addedNodes.length > 0) {
      for (const added of materialised.addedNodes) this.createComponentNode(added.spec);
      this.rebuildIKPaths();
    }

    // Phase 4d — persisted node transforms (dragged IK waypoints on base-GLB
    // nodes; op-created nodes already carry theirs in the spec). Frozen-safe:
    // applyLocalPose rebuilds the local TRS from the baked matrices first.
    if (materialised.nodeTransforms.length > 0) {
      const { applyLocalPose } = await import('./engine/rv-node-transform');
      for (const t of materialised.nodeTransforms) {
        const node = this.registry?.getNode(t.nodePath);
        if (node) applyLocalPose(node, t.position, t.quaternion);
      }
    }

    // Phase 5 — drain again. loadModel already awaited whenLoadingIdle, but
    // applyPlacements above and any onModelLoaded handlers may have queued
    // additional cascading work after that point. Cheap when the queue is
    // empty; ensures `scene-loaded` only fires once the scene is fully ready.
    await this.whenLoadingIdle();

    // Camera: the camera-startpos plugin already applied any preset during
    // onModelLoaded (per-scene op → user override → GLB author default). When
    // there is NO preset, loadModel's inline fit only saw the base GLB bounds —
    // for planner/published scenes the placements were added in Phase 4 above,
    // so frame the full assembled content now. Skipped when a preset positioned
    // the camera, or when FPV owns it.
    const camStart = this.getPlugin<RVViewerPlugin & { resolvePreset?: (v: RVViewer) => unknown }>('camera-startpos');
    const hasCameraPreset = !!camStart?.resolvePreset?.(this);
    const fpv = this.getPlugin<RVViewerPlugin & { isActive?: boolean }>('fpv');
    if (!hasCameraPreset && fpv?.isActive !== true) {
      this.frameSceneContent();
    }

    this.emit('scene-loaded', { scene });
  }

  /**
   * Tear down the current scene without loading a new one. Used when the
   * Scene window deletes the active scene and no fallback exists.
   */
  async loadEmptyScene(): Promise<void> {
    this.clearModel();
    this._currentModelUrl = null;
    this._currentScene = null;
    // Reset the checker floor to the standard authoring playground. clearModel
    // does NOT touch the ground — it is sized only in loadModel — so without
    // this the floor would keep the previous model's (often small) size and
    // look "too small" for the now-empty scene.
    this._updateGroundPlane(new Vector3(0, 0, 0), MIN_AUTHORING_GROUND_EXTENT);
    this.markRenderDirty();
  }

  /** Explicit override for projectAssetsPath (set by ModelPluginManager in dev mode). */
  private _projectAssetsPath: string | null = null;

  /** Base URL for project-specific assets (docs, AASX, logos, branding). Ends with '/'.
   *  Priority: explicit override > settings.json `projectAssetsPath` > BASE_URL. */
  get projectAssetsPath(): string {
    if (this._projectAssetsPath) return this._projectAssetsPath;
    const cfg = getAppConfig().projectAssetsPath;
    if (!cfg) return import.meta.env.BASE_URL;
    // Relative paths resolve against BASE_URL
    if (!cfg.startsWith('http') && !cfg.startsWith('/'))
      return `${import.meta.env.BASE_URL}${cfg}`;
    return cfg;
  }

  set projectAssetsPath(path: string | null) {
    this._projectAssetsPath = path;
  }

  /**
   * Reload the current model. Useful when physics settings change and
   * the world needs to be rebuilt from scratch.
   * Returns the LoadResult, or null if no model was loaded.
   */
  async reloadModel(): Promise<LoadResult | null> {
    if (!this._currentModelUrl) return null;
    const url = this._currentModelUrl;
    return this.loadModel(url);
  }

  /** Clean up all resources. */
  dispose(): void {
    // Plugin lifecycle: dispose (before everything else)
    for (const p of this._plugins) {
      callPlugin(p, 'dispose');
    }
    this.loop.stop();
    // Tear down any active non-Three render backend (closes the WebRTC
    // PeerConnection / streaming instance) before the rest of teardown.
    this._renderBackends.dispose();
    this.clearModel();
    // Final overlay-visibility teardown (plan-250): drop the GizmoManager's
    // store subscription (per-model dispose deliberately keeps it alive).
    this.gizmoManager.destroy();
    this.collisionManager.dispose();
    // BVH build port lives across model loads (one reused worker) — only the
    // final viewer teardown terminates it.
    this._bvhPort?.dispose();
    this._bvhPort = null;
    // Drop any queued preview jobs and free the offscreen render target.
    this._thumbnails?.dispose();
    this._thumbnails = null;
    // Free toon gradient / gbuffer RT / normal + Sobel materials. clearModel
    // (above) has already restored originals onto any meshes.
    this._toon.dispose();
    // Composer RTs + TSL post pipeline / desat blit (plan-271 Phase 3).
    this._postProcessing.dispose();
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.controls.dispose();
    this.renderer.dispose();
    if (this.statsReady) {
      this.stats.dispose();
      this.stats.dom.remove();
    }
    this.removeAllListeners();
  }

  // ─── Highlight & Focus ───────────────────────────────────────────────

  /**
   * Highlight a component by its hierarchy path (orange overlay).
   * @param tracked  If true, overlays follow moving parts each frame.
   */
  highlightByPath(path: string, tracked = false): void {
    const node = this.registry?.getNode(path);
    if (!node) return;
    // Detect if target is a sensor (include sensor viz in highlight)
    const isSensor = !!(node.userData?.realvirtual as Record<string, unknown> | undefined)?.['Sensor'];
    this.highlighter.highlight(node, tracked, { includeSensorViz: isSensor });
  }

  /** Remove the current highlight. */
  clearHighlight(): void {
    this.highlighter.clear();
  }

  /**
   * Scale factor applied to the camera distance so a centered object still
   * clears side panels (left/right) and top/bottom bars without moving the
   * orbit pivot. We pull the camera back symmetrically instead of shifting the
   * orbit target, which keeps the rotation pivot exactly on the bounding-box
   * center while leaving the framed object fully inside the visible viewport.
   */
  private _panelFitScale(offset?: ViewportOffset): number {
    if (!offset) return 1;
    const canvas = this.renderer.domElement;
    const canvasW = canvas.clientWidth || 1;
    const canvasH = canvas.clientHeight || 1;
    const lr = Math.max(offset.left ?? 0, offset.right ?? 0);
    const tb = Math.max(offset.top ?? 0, offset.bottom ?? 0);
    const wScale = canvasW / Math.max(canvasW - 2 * lr, 1);
    const hScale = canvasH / Math.max(canvasH - 2 * tb, 1);
    return Math.max(wScale, hScale, 1);
  }

  /** Smoothly orbit camera to focus on a component by hierarchy path. Also pins the drive tooltip if the target is a drive.
   *  @param offset  Optional pixel offsets for panels obscuring the viewport (the camera is pulled back to keep the
   *                 object clear of the panels; the orbit pivot stays on the bounding-box center). */
  focusByPath(path: string, offset?: ViewportOffset): void {
    const node = this.registry?.getNode(path);
    if (!node) return;

    // Pin drive tooltip if the focused node is (or belongs to) a drive
    const drive = this.registry!.findInParent<RVDrive>(node, 'Drive')
      ?? (this.registry!.getByPath<RVDrive>('Drive', path) || null);
    this.focusedDrive = drive;
    this.focusedNode = node;
    this.emit('object-focus', { path, node });

    const box = this._cameraManager.computeNodeBounds([node]);
    if (box.isEmpty()) return;

    const center = new Vector3();
    const size = new Vector3();
    box.getCenter(center);
    box.getSize(size);

    const maxDim = Math.max(size.x, size.y, size.z, 0.1);
    const effectiveOffset = offset ?? this.getCurrentViewportOffset();
    // Pull back symmetrically to clear panels — never shift the orbit pivot.
    const dist = this._cameraManager.fitDistance(maxDim, 2.5 * this._panelFitScale(effectiveOffset));

    // Keep current viewing direction — just move along it to frame the target.
    // The orbit target is the true bounding-box center, so rotation always
    // pivots around the geometric center of the selection.
    const dir = new Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    const endPos = center.clone().add(dir.multiplyScalar(dist));
    this.animateCameraTo(endPos, center);
  }

  /** Smoothly animate camera to frame all given nodes.
   *  @param offset  Optional pixel offsets for panels obscuring the viewport (shifts orbit target).
   *  @param opts    `minDistance` (scene units) floors the computed fit distance —
   *                 use it when framing potentially tiny objects so the camera
   *                 does not dive into the geometry (editor auto-assign focus). */
  fitToNodes(nodes: Object3D[], offset?: ViewportOffset, opts?: { minDistance?: number; easing?: import('./rv-camera-manager').CameraEasing; duration?: number }): void {
    if (nodes.length === 0) return;
    const box = this._cameraManager.computeNodeBounds(nodes);
    if (box.isEmpty()) return;

    const center = new Vector3();
    const size = new Vector3();
    box.getCenter(center);
    box.getSize(size);

    const effectiveOffset = offset ?? this.getCurrentViewportOffset();

    // Compute distance so the bounding box fits in the viewport, then pull back
    // symmetrically to clear any panels. The orbit pivot stays on the true
    // bounding-box center so rotation always pivots around the selection center.
    const maxDim = Math.max(size.x, size.y, size.z, 0.1);
    // Breathing room on top of the exact fit. Panels are cleared separately by
    // `_panelFitScale`, so this is purely framing padding — keep it modest so
    // "frame selected" (F / double-click) lands close, not far away.
    const margin = 1.25;
    // Fit vertically AND horizontally (aspect-corrected) — canonical math in
    // the CameraManager.
    const fitDist = this._cameraManager.fitDistanceBothAxes(maxDim, margin * this._panelFitScale(effectiveOffset));
    const dist = Math.max(fitDist, opts?.minDistance ?? 0);

    const dir = new Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    const endPos = center.clone().add(dir.multiplyScalar(dist));
    this.animateCameraTo(endPos, center, opts?.duration ?? 0.6, opts?.easing ?? 'easeOut');
  }

  /** True while a selection-driven isolate (context menu) is active. */
  get isSelectionIsolateActive(): boolean {
    return this._selectionIsolateActive;
  }

  /**
   * Isolate the given roots (and their whole subtree): only these stay bright,
   * everything else is dimmed and non-interactive. Uses the shared external
   * isolate channel of the GroupRegistry, so the renderer's 3-pass isolate
   * composition and the raycast isolation gate apply automatically. Frozen —
   * exit explicitly via {@link exitIsolate}. Children are covered implicitly
   * because the isolate tags entire subtrees.
   */
  isolateNodes(nodes: Object3D[]): void {
    if (!this.groups || nodes.length === 0) return;
    // Take over any prior isolate cleanly (docs browser, group/type isolate, or
    // a previous selection isolate) before installing the new roots.
    this.exitIsolate();
    this._selectionIsolatePriorVis = [];
    for (const n of nodes) {
      this._selectionIsolatePriorVis.push({ node: n, visible: n.visible });
      n.visible = true; // force-visible so a hidden root can still be isolated
    }
    this.groups.setExternalIsolated(nodes);
    this._selectionIsolateActive = true;
    this.fitToNodes(nodes);
    this.markShadowsDirty();
    this.markRenderDirty();
  }

  /** Exit a selection-driven isolate and restore the roots' prior visibility. */
  exitIsolate(): void {
    if (!this._selectionIsolateActive) return;
    this.groups?.setExternalIsolated(null);
    for (const { node, visible } of this._selectionIsolatePriorVis) node.visible = visible;
    this._selectionIsolatePriorVis = [];
    this._selectionIsolateActive = false;
    // markShadowsDirty: restored `.visible` must re-sync batch instances.
    this.markShadowsDirty();
  }

  /**
   * Frame the camera so the whole assembled scene content fits the viewport —
   * base model plus any planner placements. `loadModel`'s inline fit only sees
   * the base GLB bounds; for planner/published scenes the placements are added
   * afterwards (loadScene Phase 4), so without this the camera would frame the
   * (often empty) base, not the finished layout.
   *
   * Snaps instantly by default (used right after a scene loads, matching
   * loadModel's default iso framing); pass `animate=true` to tween instead.
   */
  frameSceneContent(animate = false): void {
    const box = this._computeContentBounds();
    if (box.isEmpty()) return;

    const center = new Vector3();
    const size = new Vector3();
    box.getCenter(center);
    box.getSize(size);

    const maxDim = Math.max(size.x, size.y, size.z, 0.1);
    const dist = this._cameraManager.fitDistance(maxDim, 1.5);

    if (animate) {
      const dir = new Vector3().subVectors(this.camera.position, this.controls.target).normalize();
      const endPos = center.clone().add(dir.multiplyScalar(dist));
      this.animateCameraTo(endPos, center);
      return;
    }

    // Same iso angle as loadModel's initial fit so the framing feels identical.
    this.camera.position.set(center.x + dist * 0.7, center.y + dist * 0.5, center.z + dist * 0.7);
    this.controls.target.copy(center);
    // Instant set: keep the ortho view scale in step with the new distance.
    this._cameraManager.syncOrthoFrustum();
    this.controls.update();
    this.markRenderDirty();
  }

  /**
   * Bounding box over visible scene content, excluding non-content scenery:
   * the ground fade disc, the reflection mirror, and the planner authoring
   * floor. Cameras and lights are skipped naturally (not meshes).
   */
  private _computeContentBounds(): Box3 {
    const box = new Box3();
    const tmp = new Box3();
    this.scene.traverse((obj) => {
      const m = obj as Mesh;
      if (!m.isMesh || !m.geometry || !m.visible) return;
      // BatchedMesh arenas: their geometry bbox ignores instance matrices —
      // the (still-visible, layer-masked) source meshes provide the correct
      // per-node bounds instead.
      if ((m as unknown as { isBatchedMesh?: boolean }).isBatchedMesh) return;
      const ud = m.userData;
      if (ud?._rvGroundPlane || ud?._rvGroundReflector || ud?._layoutFloor) return;
      m.updateWorldMatrix(true, false);
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      if (!m.geometry.boundingBox) return;
      tmp.copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld);
      box.union(tmp);
    });
    return box;
  }

  /** Clear pinned drive focus (e.g., user clicked canvas). */
  clearFocus(): void {
    if (this.focusedDrive || this.focusedNode) {
      this.focusedDrive = null;
      this.focusedNode = null;
      this.emit('object-blur', undefined);
    }
  }

  // ─── Scene Click → Hierarchy Selection ────────────────────────────────

  /**
   * Raycast from a mouse/pointer event using the grouped BVH system.
   * Returns the registry path or null.
   */
  private _raycastForRVNode(e: MouseEvent): string | null {
    return this.raycastManager?.raycastForRVNode(e) ?? null;
  }

  /**
   * Coalesce multiple BVH-rebuild requests into a single deferred pass. Used
   * by the planner after placement add/remove (and after batch operations
   * like applyPlacements) and by the asset editor for structural ops.
   *
   * Coalescing is a MACROTASK (setTimeout 0), not a microtask: an editor
   * transaction awaits each op sequentially, and a microtask fires BETWEEN
   * those awaits — a multi-select commit used to pay one full rebuild PER op.
   * All ops of one transaction resolve within the same macrotask turn, so a
   * timeout collapses them into exactly one rebuild.
   */
  private _bvhRebuildPending = false;
  /** Node paths with pending transform-refit (superseded by a full rebuild). */
  private readonly _bvhRefitPaths = new Set<string>();
  private _bvhRefitPending = false;

  rebuildGroupedBvh(): void {
    // Editor instance-pick backend active: merged groups don't exist and must
    // NOT be resurrected (duplicate pick targets). Membership is maintained
    // incrementally by the asset-op executors instead.
    if (this._instancePickIndex) return;
    if (this._bvhRebuildPending) return;
    if (!this.currentModel || !this.registry || !this.raycastManager) return;
    this._bvhRebuildPending = true;
    setTimeout(() => {
      this._bvhRebuildPending = false;
      // The full rebuild re-bakes every position — pending refits are covered.
      this._bvhRefitPaths.clear();
      if (!this.currentModel || !this.registry || !this.raycastManager) return;
      const driveNodeSet = new Set(this.drives.map(d => d.node));
      // Intentionally synchronous (no deferBVH): planner increments are small
      // compared to a full model load, and a sync rebuild keeps the placed
      // object immediately pickable (plan-240 defers only the load pipeline).
      const geo = buildRaycastGeometries(this.currentModel, this.drives, this.registry, driveNodeSet);
      const muMeshes = this._collectInstancedMeshes();
      // Retire the superseded set before the new one goes in — otherwise every
      // rebuild leaves its `__raycastBVH_*` meshes behind in the graph.
      this._retireRaycastGeometry();
      this.raycastManager.setRaycastGeometry(geo, muMeshes);
      this._installHighlightProxyProvider(geo);
    }, 0);
  }

  /**
   * Detach + dispose the `RaycastGeometrySet` currently installed on the
   * RaycastManager, so a rebuild replaces its predecessor instead of stacking
   * on top of it.
   *
   * `buildRaycastGeometries()` parents a FRESH `__raycastBVH_static` mesh under
   * the model root on every call (and one per Drive under its drive node), and
   * neither `setRaycastGeometry()` nor this rebuild path used to remove the
   * previous one: each cycle left an invisible corpse in the scene graph — 6 of
   * them measured after a PLMXML kinematics import, and the planner rebuilds
   * from three more call sites (plan-359 §2.2). Nothing ever mis-picked (the
   * corpses carry `_rvRaycastBVH`, so they are excluded from both re-merging and
   * the manager's target list), but the graph grew without bound and any
   * consumer that raycasts `scene.children` itself hits them.
   *
   * ORDER IS LOAD-BEARING (doc-render-picking.md §4.2): the highlight proxies
   * share the merged geometry's position/index attributes zero-copy and
   * `WebGLGeometries` does not refcount, so the provider must drop its
   * references BEFORE the geometry is disposed.
   */
  private _retireRaycastGeometry(): void {
    const previous = this.raycastManager?.raycastGeometry ?? null;
    if (!previous) return;
    if (this._highlightProxyProvider) {
      this.highlighter.setProxyProvider(null);
      this._highlightProxyProvider.dispose();
      this._highlightProxyProvider = null;
    }
    disposeRaycastGeometries(previous);
  }

  /**
   * Build local-space BVHs for freshly added editor meshes (CAD import into
   * the instance pick backend) — async through the shared worker port,
   * deduped by shared geometry, load-generation guarded. Until a tree lands,
   * the backend's narrow phase uses the native three.js fallback.
   *
   * `isAlive` is the PER-SUBTREE half of the abort condition, and it is not
   * optional bookkeeping: `_loadGeneration` only changes on a model load, so an
   * editor undo or a trash flush — which can dispose the very geometries this
   * build is about to write into — would otherwise go unnoticed and
   * `computeBVHAsync` would assign a `boundsTree` to a disposed geometry. The
   * predicate is re-checked before every assignment. Callers that hand out
   * geometry they do not own (e.g. a CAD import) can omit it.
   */
  buildMeshBvhsAsync(root: Object3D, isAlive?: () => boolean): void {
    const generation = this._loadGeneration;
    this._bvhPort ??= createBVHPort();
    void computeBVHAsync(root, this._bvhPort, {
      shouldAbort: () => this._loadGeneration !== generation || isAlive?.() === false,
    }).then((completed) => {
      if (completed && this._loadGeneration === generation) this.markRenderDirty();
    }).catch((e) => {
      console.warn('[viewer] async BVH build for imported subtree failed:', e);
    });
  }

  /**
   * Transform fast path: coalesce position re-bakes + BVH refits for moved
   * subtrees (editor `transformNode` ops) instead of a full grouped-BVH
   * rebuild — a full rebuild re-merges every mesh and rebuilds the highlight
   * edge arena (~400 ms on a mid-size CAD asset); the refit rewrites only the
   * moved vertex windows in place. Falls back to `rebuildGroupedBvh()` when a
   * group cannot be refit.
   */
  refitRaycastSubtrees(nodePaths: readonly string[]): void {
    if (!this.currentModel || !this.registry || !this.raycastManager) return;
    for (const p of nodePaths) this._bvhRefitPaths.add(p);
    if (this._bvhRefitPending) return;
    this._bvhRefitPending = true;
    setTimeout(() => {
      this._bvhRefitPending = false;
      // A pending full rebuild supersedes the refit (it clears the path set
      // itself when it runs first; guard for scheduling order anyway).
      if (this._bvhRebuildPending) { this._bvhRefitPaths.clear(); return; }
      const paths = [...this._bvhRefitPaths];
      this._bvhRefitPaths.clear();
      if (paths.length === 0) return;
      // Model cleared between scheduling and firing → nothing to refit.
      if (!this.currentModel) return;
      const set = this.raycastManager?.raycastGeometry;
      if (!set || !this.registry) return;
      const nodes: Object3D[] = [];
      for (const p of paths) {
        const n = this.registry.getNode(p);
        if (n) nodes.push(n);
      }
      if (nodes.length === 0) return;
      const ok = refitRaycastGroupsForSubtrees(set, nodes);
      if (!ok) this.rebuildGroupedBvh();
    }, 0);
  }

  /**
   * Install (or replace) the §4.2 proxy overlay provider for a freshly built
   * RaycastGeometrySet. The provider serves zero-copy drawRange highlight
   * proxies over the merged pick geometry; until its edge arenas finish
   * building (chunked, idle-time) the highlighter transparently keeps using
   * the legacy overlay path. The previous provider (if any) is disposed —
   * its proxies referenced the superseded geometry set.
   */
  private _installHighlightProxyProvider(set: RaycastGeometrySet): void {
    this._highlightProxyProvider?.dispose();
    this._highlightProxyProvider = null;
    if (!this.registry) return;
    const provider = new ProxyOverlayProvider(this.registry, set);
    this._highlightProxyProvider = provider;
    this.highlighter.setProxyProvider(provider);
    provider.startEdgeArenaBuild();
  }

  /**
   * Collect all InstancedMesh objects that serve as MU pools.
   * These are included in the raycast target list alongside the BVH meshes.
   */
  private _collectInstancedMeshes(): import('three').InstancedMesh[] {
    const result: import('three').InstancedMesh[] = [];
    this.scene.traverse((node) => {
      if (node.userData?._muPool && (node as import('three').InstancedMesh).isInstancedMesh) {
        result.push(node as import('three').InstancedMesh);
      }
    });
    return result;
  }

  // ─── Camera Settings (delegated to CameraManager) ───────────────────

  /** Field of view in degrees (perspective camera). */
  get fov(): number { return this._cameraManager.fov; }
  set fov(v: number) { this._cameraManager.fov = v; }

  /** Camera projection type. */
  get projection(): ProjectionType { return this._cameraManager.projection; }
  set projection(v: ProjectionType) { this._cameraManager.projection = v; }

  // ─── Visual Settings (delegated to VisualSettingsManager) ────────────

  /**
   * Fit the directional light shadow camera.
   *
   * Two modes:
   *   - **Tight-fit** (legacy): clip the shadow camera to the currently
   *     visible area around the orbit target for the best shadow map
   *     resolution. Safe only when every shadow caster is a moving drive
   *     child near the orbit target. Re-runs on every camera change.
   *   - **Full-scene** (used whenever a static uber-merged caster exists):
   *     the shadow camera was already set up at load time in `loadModel`
   *     — centered at the scene bbox center, with `_shadowPadMax` bounds
   *     big enough to cover the whole scene from any orbit target the
   *     user can reach. Rotation/pan/zoom do NOT change it, so this
   *     function is a no-op in full-scene mode. The controls-change
   *     handler skips `_shadowsDirty = true` for the same reason.
   */
  private _fitShadowToView(): void {
    if (!this.dirLight.parent || !this.renderer.shadowMap.enabled) return;

    const hasStaticUberCaster = (this._lastLoadResult?.uberBatchResult?.instanceCount ?? 0) > 0;
    if (hasStaticUberCaster) {
      // Full-scene mode: shadow camera was set up once in loadModel and
      // never needs to move. Don't touch `dirLight.target` here — doing so
      // would shift the shadow frustum when the orbit target moves, and
      // the shadow map would need a rebuild on every pan. Just flag the
      // map dirty (the caller only invokes us when _shadowsDirty was set,
      // i.e. on load / drive movement / MU spawn / shadow toggle).
      (this.renderer.shadowMap as unknown as { needsUpdate: boolean }).needsUpdate = true;
      return;
    }

    // Legacy tight-fit path: clip to the visible area at orbit distance
    const cam = this._activeCamera;
    const target = this.controls.target;
    const dist = cam.position.distanceTo(target);
    let visibleRadius: number;
    if ((cam as PerspectiveCamera).isPerspectiveCamera) {
      const fov = (cam as PerspectiveCamera).fov * Math.PI / 180;
      const halfH = dist * Math.tan(fov / 2);
      const aspect = (cam as PerspectiveCamera).aspect;
      visibleRadius = Math.sqrt(halfH * halfH + (halfH * aspect) * (halfH * aspect));
    } else {
      const oc = cam as OrthographicCamera;
      visibleRadius = Math.sqrt(
        Math.max(Math.abs(oc.left), Math.abs(oc.right)) ** 2 +
        Math.max(Math.abs(oc.top), Math.abs(oc.bottom)) ** 2,
      );
    }
    const pad = Math.min(visibleRadius * 1.3, this._shadowPadMax);

    const sc = this.dirLight.shadow.camera;
    sc.left = -pad;
    sc.right = pad;
    sc.top = pad;
    sc.bottom = -pad;

    // Re-center shadow camera target on orbit target
    this.dirLight.target.position.copy(target);
    this.dirLight.target.updateMatrixWorld();
    sc.updateProjectionMatrix();

    // Force shadow map re-render
    (this.renderer.shadowMap as unknown as { needsUpdate: boolean }).needsUpdate = true;
  }

  // ─── Visual Settings (pure-delegation proxies) ─────────────────────────
  //
  // The proxies below forward 1:1 to `_visualSettings` with no extra
  // side-effects. They are marked `@deprecated` to nudge new code toward
  // `viewer.visualSettings.*`; removal is planned for v2.0.

  /**
   * Active render mode ('simple' | 'default' | …) — the master rendering preset.
   *
   * Setting it applies the mode's lighting / environment / tone-mapping (via
   * VisualSettingsManager) AND gates the post-processing pipeline (ambient
   * occlusion, bloom, shadows) by the mode's capabilities. A mode that doesn't
   * support a feature forces it off, so e.g. 'simple' tears the composer down
   * entirely (direct render, zero post-processing cost). Switching to a mode
   * that supports those features restores the user's persisted global values.
   */
  get renderMode(): RenderMode { return this._visualSettings.lightingMode; }
  set renderMode(mode: RenderMode) {
    // 1. Lighting / environment / tone-mapping.
    this._visualSettings.lightingMode = mode;
    // 2. Capability-gated post-processing + shadows. Read persisted globals so
    //    a mode that supports the feature comes back with the user's values.
    const caps = getRenderMode(mode).capabilities;
    const s = loadVisualSettings();
    this.aoMode = caps.ambientOcclusion ? s.aoMode : 'off';
    this.bloomEnabled = caps.bloom ? s.bloomEnabled : false;
    if (!caps.shadows) this.shadowEnabled = false;
    // Floor reflection: off in modes that don't support it (toon); restore the
    // user's persisted preference when switching to a mode that does.
    this.reflectionEnabled = caps.reflection ? s.reflectionEnabled : false;
    // 3. Toon material swap + outline (entering / leaving toon). Runs AFTER the
    //    lighting mode is set so the toon materials compile against toon lights.
    this._applyToonForMode(mode);
    this.emit('render-mode-changed', { mode });
  }

  /**
   * Apply the active render mode to a subtree added AFTER the initial model load
   * (e.g. a library component dropped via the layout planner). Converts toon
   * materials when toon mode is active and recompiles the subtree's materials for
   * the current lighting mode, so the new geometry matches the rest of the scene
   * without requiring a manual render-mode toggle. Mirrors the `model-loaded`
   * toon hook used for full GLB loads. Idempotent (safe to call during load too).
   */
  applyRenderModeToSubtree(root: Object3D): void {
    if (this._toon.isActive) this._toon.convert(root); // idempotent (rv-toon-materials.ts:606)
    this._visualSettings.recompileMaterials(root); // scoped material shader recompile
    this._renderDirty = true;
  }

  /**
   * Enter or leave toon mode to match `mode`. Idempotent — only acts on an
   * actual transition. Toon swaps materials to a banded MeshToonMaterial, so it
   * needs the model root; `currentModel` may be null (mode chosen before a model
   * loads), in which case the `model-loaded` subscription converts on arrival.
   */
  private _applyToonForMode(mode: RenderMode): void {
    const wantToon = getRenderMode(mode).capabilities.toon;
    if (wantToon && !this._toon.isActive) this._toon.enable(this.currentModel);
    else if (!wantToon && this._toon.isActive) this._toon.disable(this.currentModel);
  }

  // ─── Toon (cel) render-mode settings ───────────────────────────────────

  /** Number of discrete diffuse bands (2–6). */
  get toonBands(): number { return this._toon.bands; }
  set toonBands(n: number) { this._toon.setGradient(n, this._toon.coolShadows); }

  /** Tint the dark bands slightly cool (blue) instead of just darker. */
  get toonCoolShadows(): boolean { return this._toon.coolShadows; }
  set toonCoolShadows(v: boolean) { this._toon.setGradient(this._toon.bands, v); }

  /** Metallic look strength (0 = off, 1 = fully recoloured metal surfaces). */
  get toonMetallic(): number { return this._toon.metallic; }
  set toonMetallic(v: number) { this._toon.setMetallic(v); }

  /** Metallic tint colour as #rrggbb hex (applied to metal surfaces, cel-banded). */
  get toonMetallicColor(): string { return this._toon.metallicColorHex; }
  set toonMetallicColor(v: string) { this._toon.setMetallicColor(v); }

  /** Albedo grade minimum brightness (0–1, remapped linearly). */
  get toonAlbedoMinBrightness(): number { return this._toon.albedoMinBrightness; }
  set toonAlbedoMinBrightness(v: number) {
    this._toon.setAlbedo(v, this._toon.albedoMaxBrightness, this._toon.albedoSaturation);
  }

  /** Albedo grade maximum brightness (0–1, remapped linearly). */
  get toonAlbedoMaxBrightness(): number { return this._toon.albedoMaxBrightness; }
  set toonAlbedoMaxBrightness(v: number) {
    this._toon.setAlbedo(this._toon.albedoMinBrightness, v, this._toon.albedoSaturation);
  }

  /** Albedo saturation (0 = greyscale, 1 = unchanged, 2 = boosted). */
  get toonAlbedoSaturation(): number { return this._toon.albedoSaturation; }
  set toonAlbedoSaturation(v: number) {
    this._toon.setAlbedo(this._toon.albedoMinBrightness, this._toon.albedoMaxBrightness, v);
  }

  /** Toon outline (edge) strength / opacity (0 = off, 1 = full). */
  get toonOutlineAmount(): number { return this._toon.outlineAmount; }
  set toonOutlineAmount(v: number) {
    this._toon.setOutline(v, this._toon.outlineThickness, this._toon.outlineThreshold, this._toon.outlineColorHex);
  }

  /** Toon outline thickness in pixels. */
  get toonOutlineThickness(): number { return this._toon.outlineThickness; }
  set toonOutlineThickness(v: number) {
    this._toon.setOutline(this._toon.outlineAmount, v, this._toon.outlineThreshold, this._toon.outlineColorHex);
  }

  /** Toon outline edge threshold (0 = sensitive, 1 = only strong edges). */
  get toonOutlineThreshold(): number { return this._toon.outlineThreshold; }
  set toonOutlineThreshold(v: number) {
    this._toon.setOutline(this._toon.outlineAmount, this._toon.outlineThickness, v, this._toon.outlineColorHex);
  }

  /** Toon outline max view distance in meters (0–100); edges fade out beyond it. */
  get toonOutlineDistance(): number { return this._toon.outlineDistance; }
  set toonOutlineDistance(v: number) {
    this._toon.setOutline(
      this._toon.outlineAmount,
      this._toon.outlineThickness,
      this._toon.outlineThreshold,
      this._toon.outlineColorHex,
      v,
    );
  }

  /** Toon outline: 2× supersample the depth/normal gbuffer (higher quality, heavier). */
  get toonOutlineSupersample(): boolean { return this._toon.outlineSupersample; }
  set toonOutlineSupersample(v: boolean) { this._toon.setSupersample(v); }

  /** Toon outline color as #rrggbb hex. */
  get toonOutlineColor(): string { return this._toon.outlineColorHex; }
  set toonOutlineColor(v: string) {
    this._toon.setOutline(this._toon.outlineAmount, this._toon.outlineThickness, this._toon.outlineThreshold, v);
  }

  /** @deprecated Use `viewer.renderMode` instead. Will be removed in v2.0. */
  get lightingMode(): RenderMode { return this.renderMode; }
  /** @deprecated Use `viewer.renderMode` instead. Will be removed in v2.0. */
  set lightingMode(mode: RenderMode) { this.renderMode = mode; }

  /** @deprecated Use `viewer.visualSettings.toneMapping` instead. Will be removed in v2.0. */
  get toneMapping(): ToneMappingType { return this._visualSettings.toneMapping; }
  /** @deprecated Use `viewer.visualSettings.toneMapping` instead. Will be removed in v2.0. */
  set toneMapping(v: ToneMappingType) { this._visualSettings.toneMapping = v; }

  /** @deprecated Use `viewer.visualSettings.toneMappingExposure` instead. Will be removed in v2.0. */
  get toneMappingExposure(): number { return this._visualSettings.toneMappingExposure; }
  /** @deprecated Use `viewer.visualSettings.toneMappingExposure` instead. Will be removed in v2.0. */
  set toneMappingExposure(v: number) { this._visualSettings.toneMappingExposure = v; }

  /** @deprecated Use `viewer.visualSettings.ambientColor` instead. Will be removed in v2.0. */
  get ambientColor(): string { return this._visualSettings.ambientColor; }
  /** @deprecated Use `viewer.visualSettings.ambientColor` instead. Will be removed in v2.0. */
  set ambientColor(hex: string) { this._visualSettings.ambientColor = hex; }

  /** @deprecated Use `viewer.visualSettings.ambientIntensity` instead. Will be removed in v2.0. */
  get ambientIntensity(): number { return this._visualSettings.ambientIntensity; }
  /** @deprecated Use `viewer.visualSettings.ambientIntensity` instead. Will be removed in v2.0. */
  set ambientIntensity(v: number) { this._visualSettings.ambientIntensity = v; }

  /** @deprecated Use `viewer.visualSettings.dirLightEnabled` instead. Will be removed in v2.0. */
  get dirLightEnabled(): boolean { return this._visualSettings.dirLightEnabled; }
  /** @deprecated Use `viewer.visualSettings.dirLightEnabled` instead. Will be removed in v2.0. */
  set dirLightEnabled(v: boolean) { this._visualSettings.dirLightEnabled = v; }

  /** @deprecated Use `viewer.visualSettings.dirLightColor` instead. Will be removed in v2.0. */
  get dirLightColor(): string { return this._visualSettings.dirLightColor; }
  /** @deprecated Use `viewer.visualSettings.dirLightColor` instead. Will be removed in v2.0. */
  set dirLightColor(hex: string) { this._visualSettings.dirLightColor = hex; }

  /** @deprecated Use `viewer.visualSettings.dirLightIntensity` instead. Will be removed in v2.0. */
  get dirLightIntensity(): number { return this._visualSettings.dirLightIntensity; }
  /** @deprecated Use `viewer.visualSettings.dirLightIntensity` instead. Will be removed in v2.0. */
  set dirLightIntensity(v: number) { this._visualSettings.dirLightIntensity = v; }

  /** @deprecated Use `viewer.visualSettings.shadowEnabled` instead. Will be removed in v2.0. */
  get shadowEnabled(): boolean { return this._visualSettings.shadowEnabled; }
  /** @deprecated Use `viewer.visualSettings.shadowEnabled` instead. Will be removed in v2.0. */
  set shadowEnabled(v: boolean) { this._visualSettings.shadowEnabled = v; }

  /** @deprecated Use `viewer.visualSettings.shadowIntensity` instead. Will be removed in v2.0. */
  get shadowIntensity(): number { return this._visualSettings.shadowIntensity; }
  /** @deprecated Use `viewer.visualSettings.shadowIntensity` instead. Will be removed in v2.0. */
  set shadowIntensity(v: number) { this._visualSettings.shadowIntensity = v; }

  /** @deprecated Use `viewer.visualSettings.shadowQuality` instead. Will be removed in v2.0. */
  get shadowQuality(): ShadowQuality { return this._visualSettings.shadowQuality; }
  /** @deprecated Use `viewer.visualSettings.shadowQuality` instead. Will be removed in v2.0. */
  set shadowQuality(v: ShadowQuality) { this._visualSettings.shadowQuality = v; }

  /** @deprecated Use `viewer.visualSettings.lightIntensity` instead. Will be removed in v2.0. */
  get lightIntensity(): number { return this._visualSettings.lightIntensity; }
  /** @deprecated Use `viewer.visualSettings.lightIntensity` instead. Will be removed in v2.0. */
  set lightIntensity(v: number) { this._visualSettings.lightIntensity = v; }

  /** Unlit-only HDRI reflections: assign the env map for metallic/glossy
   *  reflections while keeping the flat ambient look. No effect outside Unlit. */
  get unlitReflectionsEnabled(): boolean { return this._visualSettings.unlitReflectionsEnabled; }
  set unlitReflectionsEnabled(v: boolean) { this._visualSettings.unlitReflectionsEnabled = v; }
  /** Unlit reflection strength → scene.environmentIntensity (0–2). */
  get unlitReflectionsIntensity(): number { return this._visualSettings.unlitReflectionsIntensity; }
  set unlitReflectionsIntensity(v: number) { this._visualSettings.unlitReflectionsIntensity = v; }

  // ─── Individual Rendering Settings (delegated to VisualSettingsManager) ──

  /**
   * Apply a full set of visual settings in one batch.
   * Delegates to individual setters on VisualSettingsManager.
   */
  applyVisualSettings(settings: import('./hmi/visual-settings-store').VisualSettings): void {
    const ms = settings.modeSettings[settings.renderMode];
    // Capability gating — features the active render mode doesn't support are
    // forced off so the first frame (e.g. in 'simple') is already minimal.
    const caps = getRenderMode(settings.renderMode).capabilities;

    // 1. Direct properties
    this.toneMappingExposure = ms.toneMappingExposure;
    this.ambientColor = ms.ambientColor;
    this.dirLightColor = ms.dirLightColor;
    this.dirLightIntensity = ms.dirLightIntensity;
    this.shadowIntensity = ms.shadowIntensity;
    this.shadowRadius = settings.shadowRadius ?? 2;

    // 2. Shadow map size (before enabling shadows)
    this.shadowMapSize = settings.shadowMapSize ?? 1024;

    // 3. DirLight on/off (before shadows, since shadowEnabled checks dirLight.parent)
    this.dirLightEnabled = caps.directionalLight && ms.dirLightEnabled;

    // 4. Shadows
    this.shadowEnabled = caps.shadows && ms.shadowEnabled;

    // 5. Tone mapping + render mode (sets lighting/environment via the manager)
    this.toneMapping = ms.toneMapping;
    // Seed unlit-reflection config so the imminent lightingMode switch's
    // applyLightingMode assigns scene.environment when Unlit + reflections on.
    this._visualSettings.configureUnlitReflections(
      settings.envReflectionsEnabled ?? false,
      settings.envReflectionsIntensity ?? 0.3,
    );
    this._visualSettings.lightingMode = settings.renderMode;

    // 5b. Toon (cel) params. Configure gradient + metallic + outline first,
    //     then enter/leave toon so `enable` builds with the right values.
    this._toon.setGradient(settings.toonBands, settings.toonCoolShadows);
    this._toon.setMetallic(settings.toonMetallic);
    this._toon.setMetallicColor(settings.toonMetallicColor);
    this._toon.setAlbedo(
      settings.toonAlbedoMinBrightness,
      settings.toonAlbedoMaxBrightness,
      settings.toonAlbedoSaturation,
    );
    this._toon.setOutline(
      settings.toonOutlineAmount,
      settings.toonOutlineThickness,
      settings.toonOutlineThreshold,
      settings.toonOutlineColor,
      settings.toonOutlineDistance,
    );
    this._toon.setSupersample(settings.toonOutlineSupersample);
    this._applyToonForMode(settings.renderMode);
    this.emit('render-mode-changed', { mode: settings.renderMode });

    // 6. Light intensity (depends on render mode being set)
    this.lightIntensity = ms.lightIntensity;

    // 7. Camera
    this.fov = settings.fov;
    this.projection = settings.projection;

    // 8. SSAO (WebGL only) — only when the mode supports it
    this.aoMode = caps.ambientOcclusion ? (settings.aoMode ?? 'gtao') : 'off';
    this.ssaoIntensity = settings.ssaoIntensity ?? 1.0;
    this.ssaoRadius = settings.ssaoRadius ?? 0.15;

    // 9. Bloom (WebGL only) — only when the mode supports it
    this.bloomEnabled = caps.bloom ? (settings.bloomEnabled ?? true) : false;
    this.bloomIntensity = settings.bloomIntensity ?? 0.2;
    this.bloomThreshold = settings.bloomThreshold ?? 0.85;
    this.bloomRadius = settings.bloomRadius ?? 0.4;

    // 10. Ground / Floor
    this.groundEnabled = settings.groundEnabled ?? true;
    // Apply color BEFORE brightness so the brightness setter's combine math
    // sees the user's chosen base color instead of recomputing twice.
    this.groundColor = settings.groundColor ?? '#ffffff';
    this.groundBrightness = settings.groundBrightness ?? 1.0;
    this.backgroundBrightness = settings.backgroundBrightness ?? 1.0;
    this.checkerContrast = settings.checkerContrast ?? 1.0;
    // Strength/blur before enabled so the checker blend + mirror are configured
    // once with the right values when reflection is switched on.
    this.reflectionStrength = settings.reflectionStrength ?? 0.8;
    this.reflectionBlur = settings.reflectionBlur ?? 1.0;
    // Reflection only in modes that support it (off in toon).
    this.reflectionEnabled = caps.reflection ? (settings.reflectionEnabled ?? false) : false;

    // 11. Navigation sensitivity (OrbitControls)
    if (this.controls) {
      applyNavigationSettingsToControls(this.controls, settings);
    }

    // 12. Drive axis gizmo overlay (plan-249)
    this.showDriveAxisGizmo = settings.showDriveAxisGizmo ?? true;
  }

  // ─── Individual Rendering Settings (pure-delegation proxies) ───────────

  /** @deprecated Use `viewer.visualSettings.effectiveDpr` instead. Will be removed in v2.0. */
  get effectiveDpr(): number { return this._visualSettings.effectiveDpr; }

  /** @deprecated Use `viewer.visualSettings.maxDpr` instead. Will be removed in v2.0. */
  set maxDpr(cap: number) { this._visualSettings.maxDpr = cap; }

  /** @deprecated Use `viewer.visualSettings.shadowMapSize` instead. Will be removed in v2.0. */
  set shadowMapSize(size: number) { this._visualSettings.shadowMapSize = size; }

  /** @deprecated Use `viewer.visualSettings.shadowRadius` instead. Will be removed in v2.0. */
  set shadowRadius(radius: number) { this._visualSettings.shadowRadius = radius; }

  // #region VisualSettingsProxies — post-processing side-effect setters
  //
  // The proxies below delegate to PostProcessingManager — the source of
  // truth for all composer-related state since plan-177 phase 7b. They
  // retain the same names as the original RVViewer setters so the 71
  // external consumers continue to work unchanged. The side-effects
  // (composer lazily ensured, `_renderDirty` flag set, AO pass lazy-
  // imported) all happen inside the manager now, not here.
  //
  // NOTE: These are NOT pure delegations — they trigger composer creation
  // and other side-effects, so they are intentionally NOT marked
  // `@deprecated`. They remain the official API surface for these
  // properties until / unless a future refactor exposes
  // `viewer.postProcessing` directly.

  /**
   * Ambient-occlusion backend: 'off' | 'gtao' | 'n8ao'. WebGL only — a no-op
   * on WebGPU. Switching to 'n8ao' triggers a dynamic import of the `n8ao`
   * package; if the module isn't installed or fails to load, the mode
   * silently reverts to 'gtao' with a console warning so the UI stays honest.
   */
  get aoMode(): AOMode { return this._postProcessing.aoMode; }
  set aoMode(mode: AOMode) { this._postProcessing.aoMode = mode; }

  /**
   * Legacy back-compat: boolean toggle mapping onto `aoMode`.
   *   true  → aoMode = 'gtao' (current default)
   *   false → aoMode = 'off'
   * Prefer `aoMode` directly in new code.
   */
  get ssaoEnabled(): boolean { return this._postProcessing.ssaoEnabled; }
  set ssaoEnabled(v: boolean) { this._postProcessing.ssaoEnabled = v; }

  /** AO blend intensity (0 = invisible, 1 = full). Writes to whichever backend
   *  is currently active; non-active backend picks it up on next activation. */
  get ssaoIntensity(): number { return this._postProcessing.ssaoIntensity; }
  set ssaoIntensity(v: number) { this._postProcessing.ssaoIntensity = v; }

  /** AO sampling radius in world units (GTAO scale; N8AO radius is derived). */
  get ssaoRadius(): number { return this._postProcessing.ssaoRadius; }
  set ssaoRadius(v: number) { this._postProcessing.ssaoRadius = v; }

  /** Whether bloom (glow on bright areas) is enabled. WebGL only. */
  get bloomEnabled(): boolean { return this._postProcessing.bloomEnabled; }
  set bloomEnabled(v: boolean) { this._postProcessing.bloomEnabled = v; }

  /** Bloom glow intensity (0–2). */
  get bloomIntensity(): number { return this._postProcessing.bloomIntensity; }
  set bloomIntensity(v: number) { this._postProcessing.bloomIntensity = v; }

  /** Brightness threshold for bloom (0–1). */
  get bloomThreshold(): number { return this._postProcessing.bloomThreshold; }
  set bloomThreshold(v: number) { this._postProcessing.bloomThreshold = v; }

  /** Bloom spread radius (0–1). */
  get bloomRadius(): number { return this._postProcessing.bloomRadius; }
  set bloomRadius(v: number) { this._postProcessing.bloomRadius = v; }

  // #endregion VisualSettingsProxies

  // ─── Profiler Overlay ────────────────────────────────────────────────

  /** Show/hide the stats-gl FPS/CPU/GPU overlay. */
  get showStats(): boolean { return this.statsReady && this.stats.dom.style.display !== 'none'; }
  set showStats(v: boolean) { if (this.statsReady) this.stats.dom.style.display = v ? '' : 'none'; }

  /** Enable/disable periodic renderer.info console logging. */
  rendererInfoLogging = false;

  // ─── Renderer Info (for dev tools) ────────────────────────────────────

  /** Diagnostic GPU info for the DevTools panel. Returns the active GPU
   *  immediately and merges in optional high-perf / low-power adapter
   *  data once the async probe resolves (typically <1 frame). */
  getGPUInfo(): GPUInfo | null {
    return this._gpuInfo;
  }

  /** Performance-tier diagnosis derived from the active GPU and any
   *  available adapter probes. Recomputed each call so it reflects the
   *  latest probe result without needing an event subscription. */
  getGPUAnalysis(): GPUAnalysis | null {
    return this._gpuInfo ? analyzeGPU(this._gpuInfo) : null;
  }

  /** Pick-path timing snapshot (raycast split, hit resolve, highlight apply).
   *  Polled by the DevTools "Picking & Highlight" section. */
  getPickMetrics(): PickMetricsSnapshot {
    return this._pickMetrics.snapshot();
  }

  /** Load-time metadata/interaction stats of the current model (or null). */
  getMetadataLoadStats(): { metadataNodes: number; aabbCount: number; aabbBuildMs: number; hoverableFaceRanges: number } | null {
    return this._lastLoadResult?.metadataStats ?? null;
  }

  /** Get renderer performance info (triangles, draw calls, etc.). */
  getRendererInfo(): {
    triangles: number;
    drawCalls: number;
    geometries: number;
    textures: number;
    programs: number;
    /** Materials before dedup (from GLB) */
    materialsOriginal: number;
    /** Materials after dedup + uber-material pass (unique references still on meshes) */
    materialsUnique: number;
    /** Meshes baked onto the RVUberMaterial singleton (0 if uber pass was a no-op) */
    uberBakedMeshCount: number;
    /** Meshes that shared an already-baked BufferGeometry instead of cloning (plan-153) */
    uberSharedGeometryReuses: number;
    /** Meshes that had to clone their geometry because of a material conflict (plan-153) */
    uberClonedGeometryCount: number;
    /** Orphaned source BufferGeometries that Pass 3 disposed (plan-153) */
    uberDisposedSourceGeometries: number;
    /** Static uber meshes turned into batch instances (Phase 10c) */
    uberMergeOriginal: number;
    /** BatchedMesh arenas created by the uber batching pass (0 or 1) */
    uberMergeCreated: number;
    /** Drive blobs that produced at least one kinematic arena */
    kinGroupsMerged: number;
    /** Meshes turned into kinematic batch instances */
    kinSourceMeshes: number;
    /** Kinematic BatchedMesh arenas created (uber + textured, per drive) */
    kinChunksCreated: number;
    /** Textured static meshes turned into batch instances (Phase 10d-tex) */
    texMergeOriginal: number;
    /** BatchedMesh arenas created by the textured batching pass */
    texMergeCreated: number;
    /** Distinct material groups that batched (>= 2 meshes) */
    texMaterialGroups: number;
    /** Total BatchedMesh arenas (uber + textured) */
    batchCount: number;
    /** Total batch instances across all arenas */
    batchInstances: number;
    /** Unique geometries stored in the arenas (instancing dedup) */
    batchUniqueGeometries: number;
    /** Total arena vertex capacity */
    batchArenaVertices: number;
  } {
    const info = this.renderer.info;
    const dedup = this._lastLoadResult?.dedupResult;
    const uber = this._lastLoadResult?.uberResult;
    const uberBatch = this._lastLoadResult?.uberBatchResult;
    const texBatch = this._lastLoadResult?.texBatchResult;
    const kinBatch = this._lastLoadResult?.kinBatchResult;
    const batchStats = this._lastLoadResult?.batchTable?.stats();
    return {
      // triangles / drawCalls come from the snapshot taken right after
      // renderer.render() — see _lastFrameStats. Reading info.render
      // directly would race with post-processing passes or per-plugin
      // renders that mutate the counter.
      triangles: this._lastFrameStats.triangles,
      drawCalls: this._lastFrameStats.drawCalls,
      geometries: (info as unknown as { memory?: { geometries?: number } }).memory?.geometries ?? 0,
      textures: (info as unknown as { memory?: { textures?: number } }).memory?.textures ?? 0,
      programs: (info as unknown as { programs?: unknown[] }).programs?.length ?? 0,
      materialsOriginal: dedup?.originalCount ?? 0,
      materialsUnique: dedup?.uniqueCount ?? 0,
      uberBakedMeshCount: uber?.bakedMeshCount ?? 0,
      uberSharedGeometryReuses: uber?.sharedGeometryReuses ?? 0,
      uberClonedGeometryCount: uber?.clonedGeometryCount ?? 0,
      uberDisposedSourceGeometries: uber?.disposedSourceGeometries ?? 0,
      uberMergeOriginal: uberBatch?.instanceCount ?? 0,
      uberMergeCreated: uberBatch?.batchCount ?? 0,
      kinGroupsMerged: kinBatch?.driveGroups ?? 0,
      kinSourceMeshes: kinBatch?.instanceCount ?? 0,
      kinChunksCreated: kinBatch?.batchCount ?? 0,
      texMergeOriginal: texBatch?.instanceCount ?? 0,
      texMergeCreated: texBatch?.batchCount ?? 0,
      texMaterialGroups: texBatch?.batchCount ?? 0,
      batchCount: batchStats?.batches ?? 0,
      batchInstances: batchStats?.instances ?? 0,
      batchUniqueGeometries: batchStats?.uniqueGeometries ?? 0,
      batchArenaVertices: batchStats?.arenaVertices ?? 0,
    };
  }

  /**
   * Run a quick GPU benchmark: render N frames in a tight loop (no vsync),
   * return uncapped FPS and average frame time.
   */
  async runBenchmark(frames = 120): Promise<{ uncappedFps: number; avgFrameMs: number; headroom: number }> {
    // Force a GPU flush before starting
    this.renderer.render(this.scene, this.camera);
    const ctx = this.renderer.getContext();
    const isWebGL = 'finish' in ctx;
    if (isWebGL) (ctx as WebGL2RenderingContext).finish();

    const start = performance.now();
    for (let i = 0; i < frames; i++) {
      this.renderer.render(this.scene, this.camera);
    }
    if (isWebGL) (ctx as WebGL2RenderingContext).finish();
    const elapsed = performance.now() - start;

    const avgFrameMs = elapsed / frames;
    const uncappedFps = Math.round(1000 / avgFrameMs);
    // Headroom: how much faster than 60fps are we? e.g., 180fps = 3x headroom
    const headroom = Math.round((1000 / avgFrameMs) / 60 * 100);

    return { uncappedFps, avgFrameMs: +avgFrameMs.toFixed(2), headroom };
  }

  // ─── Viewport Offset (delegated to CameraManager) ──────────────────

  /** Compute current viewport offset from open panels (hierarchy, inspector, left panels).
   *  Returns undefined when no panels obscure the viewport.
   *  NOTE: Uses INSPECTOR_PANEL_WIDTH from layout-constants internally. */
  getCurrentViewportOffset(): ViewportOffset | undefined {
    return this._cameraManager.getCurrentViewportOffset();
  }

  // ─── Camera Animation (delegated to CameraManager) ─────────────────

  /**
   * Smoothly animate the camera to a new position and orbit target.
   * @param position  Target camera position.
   * @param target    Target orbit center.
   * @param duration  Animation duration in seconds (default 0.6).
   * @param easing    'easeOut' (default, snappy click response) or 'easeInOut'
   *                  (smooth start AND stop — scripted/agent flights).
   */
  animateCameraTo(position: Vector3, target: Vector3, duration = 0.6, easing: import('./rv-camera-manager').CameraEasing = 'easeOut'): void {
    this._cameraManager.animateCameraTo(position, target, duration, easing);
  }

  /** Whether a camera animation is currently in progress. */
  get isCameraAnimating(): boolean { return this._cameraManager.isCameraAnimating; }

  /**
   * Smoothly animate between perspective and orthographic projection.
   * Element-wise lerps between the two cameras' projection matrices, then
   * commits the actual camera swap at the end of the tween.
   */
  animateProjectionTo(v: ProjectionType, duration = 0.4): void {
    this._cameraManager.animateProjectionTo(v, duration);
  }

  /** Whether a projection animation is currently in progress. */
  get isProjectionAnimating(): boolean { return this._cameraManager.isProjectionAnimating; }

  // ─── Camera Follow / Sit-On (delegated to CameraManager) ───────────
  //
  // CameraManager is an internal implementation detail (no public getter); the
  // Follow/Sit-On modes are exposed through these facade methods, consistent
  // with animateCameraTo(). Each kicks markRenderDirty() so the first follow
  // tick runs even under render-on-demand (avoids a render-on-demand chicken/egg).

  /** Start orbit-follow of a moving target (keeps relative offset; orbit stays live). */
  startCameraFollow(src: FollowSource): void {
    this._cameraManager.startFollow(src);
    this.markRenderDirty();
  }

  /** Start sit-on: ride the target's pose with free mouse look (perspective only). */
  startCameraSitOn(src: FollowSource, seat?: Vector3): void {
    this._cameraManager.startSitOn(src, seat);
    this.markRenderDirty();
  }

  /** Leave follow/sit-on; `restore` animates back to the entry view. */
  stopCameraFollow(restore = true): void {
    this._cameraManager.stopFollowMode(restore);
    this.markRenderDirty();
  }

  /** Apply a Sit-On mouse-look delta (pixels). No-op outside Sit-On. */
  applyCameraLookDelta(dx: number, dy: number): void {
    this._cameraManager.applyLookDelta(dx, dy);
  }

  /** Current camera follow mode ('off' | 'follow' | 'siton'). */
  get cameraFollowMode(): 'off' | 'follow' | 'siton' { return this._cameraManager.followMode; }

  // ──── Helper Methods für HMI/Plugin-Konsumenten (Phase 4b of plan-182) ────
  //
  // Diese Methoden delegieren an die Sub-Facaden (_scene/_camera/_controls)
  // und sind die EMPFOHLENE API für HMI-Komponenten + neue Plugins.
  // Direkte Zugriffe wie `viewer.scene.traverse(...)` sind `@deprecated`.

  /** Iterate over all nodes in the loaded model. Delegates to SceneFacade. */
  eachNode(fn: (node: Object3D, path: string) => void): void {
    this._scene.eachNode(fn);
  }

  /** Project a node's world position to screen pixels. Returns null if camera/renderer
   *  absent or node behind camera. */
  projectToScreen(node: Object3D, out?: Vector2): Vector2 | null {
    return this._scene.projectToScreen(node, out);
  }

  /** Project an arbitrary world point to screen pixels. */
  projectPoint(point: Vector3, out?: Vector2): Vector2 | null {
    return this._scene.projectPoint(point, out);
  }

  /** Snapshot of current camera state (position, OrbitControls target, quaternion).
   *  Optional `out` parameter for GC-free hot paths in HMI useFrame hooks. */
  getCameraState(out?: { position: Vector3; target: Vector3 }) {
    return this._camera.getCameraState(out);
  }

  /** Apply a partial OrbitControls configuration. Used by Settings panels.
   *  Wraps multiple property writes that previously went directly to `viewer.controls.X = val`. */
  setControlsConfig(cfg: Partial<{ rotateSpeed: number; panSpeed: number; zoomSpeed: number; dampingFactor: number; enabled: boolean }>): void {
    this._controls.setConfig(cfg);
  }

  /** Toggle verbose renderer-info logging. Used by DevTools panel.
   *  Replaces direct `viewer.rendererInfoLogging = v` writes. */
  setDebugLogging(enabled: boolean): void {
    this.rendererInfoLogging = enabled;
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private lastHoveredDrive: RVDrive | null = null;
  private lastHoverClientX = 0;
  private lastHoverClientY = 0;
  private lastRenderTime = 0;
  /** Shadow map dirty flag — when false, shadow pass is skipped entirely. */
  private _shadowsDirty = true;
  /** BatchedMesh per-instance visibility sync (batched render path). */
  private _batchVisibility: BatchVisibilityService | null = null;
  /** Animation-frame counter for the periodic batch-visibility safety resync. */
  private _batchVisSafetyCounter = 0;
  /** Max shadow padding from model load (scene-wide coverage). */
  private _shadowPadMax = 100;
  /** Render dirty flag — when false, renderer.render() is skipped (Phase 4: render-on-demand). */
  private _renderDirty = true;
  /**
   * Snapshot of the most recent main-scene render's draw-call and triangle
   * counts. Captured immediately after `renderer.render()` / `composer.render()`
   * inside the dirty-flag block, so the 200ms DevTools polling read sees a
   * stable value rather than racing with post-render plugin passes or the
   * next frame's reset.
   */
  private _lastFrameStats = { drawCalls: 0, triangles: 0 };
  /** Frames remaining for damping after last user input (Phase 4). */
  private _dampingFramesRemaining = 0;
  /** Reference to the ground plane mesh (if created). */
  private _groundMesh: Mesh | null = null;
  /** Canvas backing the checker CanvasTexture — re-drawn when checkerContrast changes. */
  private _checkerCanvas: HTMLCanvasElement | null = null;
  /** Floor checker pattern contrast (0 = flat midgray, 1 = default, 2 = doubled). */
  private _checkerContrast = 1.0;
  /** Scene background brightness multiplier (0 = black, 1 = default, 2 = white). */
  private _backgroundBrightness = 1.0;
  /** Floor brightness multiplier (0 = black, 1 = default, 2 = double). Combined
   *  with `_groundColor` to compute the actual material tint. */
  private _groundBrightness = 1.0;
  /** Floor base color (default white). */
  private _groundColor = new Color(0xffffff);
  /** Optional floor reflection mirror (WebGL-only; null on WebGPU / no ground). */
  private _groundReflector: Reflector | null = null;
  /** Whether the floor reflection is currently enabled. */
  private _reflectionEnabled = false;
  /** Floor reflection strength (0 = none, 1 = full mirror). */
  private _reflectionStrength = 0.8;
  /** Floor reflection blur / gloss (0 = sharp mirror, 1 = soft frosted gloss). */
  private _reflectionBlur = 1.0;

  // Isolate-overlay and desaturation pass state now live in PostProcessingManager.

  private fixedUpdate(dt: number): void {
    // Signature provenance gate: do not advance simulation time or dispatch
    // ANY model logic stage until late activation has completed.
    if (this.logicRunState !== 'active') return;
    this.simTickCount++;
    // Plan 201 (E2): advance the continuous sim clock. In unified DES mode the
    // `simTime` getter overrides this with the executor's event time, so the
    // accumulation is harmless there.
    this._simTime += dt;

    // Phase B (runtime unification): the kernel-backed executor owns the core
    // subsystem pipeline once a model is loaded. Before that (`kernel` null)
    // the viewer drives the CoreSubsystems stages directly — same order, no
    // transport (there is none yet).
    const kernel = this._getKernel();

    // ── Early (pre-PRE): playback → LogicSteps → IK paths → replay ────────
    // Runs BEFORE interfaces flush incoming PLC signals (TickStage.PRE), so
    // these subsystems see last tick's signals — the historical order.
    if (kernel) {
      kernel.earlyTick(dt);
    } else {
      this._coreSubsystems.early(dt);
    }

    // ── TickStage.PRE ──────────────────────────────────────────────────────
    // 1. Legacy onFixedUpdatePre-Plugins (defensive snapshot — protects against
    //    a plugin that removes itself mid-iteration, e.g. via disablePlugin).
    for (const p of this._snapshotPrePlugins()) {
      callPlugin(p, 'onFixedUpdatePre', dt);
    }
    // 2. SimLoopFacade.onTick(PRE) callbacks — adapters flush incoming PLC signals here.
    this._runTickCallbacks(TickStage.PRE, dt);

    // ── TickStage.SIM (Core) ───────────────────────────────────────────────
    // Executor tick: drive loop (+ dirty flags + MU diff) → transport →
    // behaviour/material-flow fixedUpdate → visual managers (texture anims,
    // tank, gizmo, pipe). The physics-plugin transport bypass is evaluated per
    // tick inside the ContinuousRunner's gate (drives + visuals keep running).
    if (kernel) {
      kernel.tick(dt);
    } else {
      this._coreSubsystems.drives(dt);
      this._coreSubsystems.visuals(dt);
    }

    // 3. SimLoopFacade.onTick(SIM) callbacks — run AFTER all core SIM subsystems
    //    (Drive-Physics + Transport + TankFill + PipeFlow + Gizmo) have updated,
    //    so plugins reading drive positions or MU counts see the current-tick values.
    this._runTickCallbacks(TickStage.SIM, dt);

    // 3b. Late pass: DES tween render / consumed-visual sweep (continuous:
    // no-op). Pre-kernel (no model) the BehaviorManager fan-out keeps its
    // historical post-SIM slot — with no model there are no binds, so this is
    // a harmless no-op iteration.
    if (kernel) {
      kernel.lateTick(dt);
    } else {
      this.behaviors.tick(dt);
    }

    // ── TickStage.POST ─────────────────────────────────────────────────────
    // 4. Legacy onFixedUpdatePost-Plugins (defensive snapshot).
    for (const p of this._snapshotPostPlugins()) {
      callPlugin(p, 'onFixedUpdatePost', dt);
    }
    // 5. SimLoopFacade.onTick(POST) callbacks — recorders, stats, adapter readback.
    this._runTickCallbacks(TickStage.POST, dt);

    // 6. Render-backend drive bridge (plan-256) — additive, gated. Only when a
    //    non-Three backend is active: mirror the source value to the Omniverse
    //    prim. No effect on the Three path or the signal flush above.
    this._pushRenderBackendDriveValue();
  }

  // ─── Defensive Plugin Iteration (Phase 5 of plan-182) ────────────────────
  //
  // Snapshots protect against iterator-invalidation: a plugin that removes
  // itself during fixedUpdate() (via disablePlugin/removePlugin) would otherwise
  // mutate the array while we are iterating it. The snapshot is cached and only
  // rebuilt after a register/enable/disable/remove (which also invalidates it,
  // so the running iteration keeps its old copy) — no per-tick allocation.
  // Plugins registered mid-tick are still deferred to the next tick.

  /** @internal */
  _snapshotPrePlugins(): readonly RVViewerPlugin[] {
    if (!this._prePluginsSnapshot) this._prePluginsSnapshot = this._prePlugins.slice();
    return this._prePluginsSnapshot;
  }

  /** @internal */
  _snapshotPostPlugins(): readonly RVViewerPlugin[] {
    if (!this._postPluginsSnapshot) this._postPluginsSnapshot = this._postPlugins.slice();
    return this._postPluginsSnapshot;
  }

  /** Drop cached plugin snapshots after any pre/post list mutation. */
  private _invalidatePluginSnapshots(): void {
    this._prePluginsSnapshot = null;
    this._postPluginsSnapshot = null;
  }

  // ─── _runTickCallbacks — per-stage SimLoopFacade tick (Phase 5 of plan-182) ─

  /** Run all onTick callbacks for a given stage, with defensive snapshot.
   *  Each callback is wrapped in try/catch — one failing callback does not stop the others.
   *  @internal */
  private _runTickCallbacks(stage: TickStage, dt: number): void {
    // Defensive snapshot (cached in the facade, invalidated on (un)subscribe):
    // a callback may register/unregister callbacks during execution.
    const snapshot = this._simLoop._snapshotTicks(stage);
    if (snapshot.length === 0) return;
    for (const entry of snapshot) {
      try {
        entry.callback(dt);
      } catch (e) {
        console.error(`[RVViewer] onTick(${TickStage[stage]}) callback error:`, e);
      }
    }
  }

  // ─── _tickOnce — Synchronous tick for tests (Phase 5 of plan-182) ────────
  //
  // Calls the EXACT same code path as the production fixedUpdate(), so tests
  // can step the simulation deterministically without spinning up a real
  // SimulationLoop / requestAnimationFrame chain.
  //
  // Usage in tests: `(viewer as any)._tickOnce(0.016)`

  /** @internal */
  _tickOnce(dt: number): void {
    this.fixedUpdate(dt);
  }

  /**
   * Render the overlay-only layers (highlights + measurement markers, lines,
   * distance labels) on top of whatever is currently in the back buffer.
   *
   * Called AFTER the main scene render AND after `plugin.onRender` so the
   * gaussian-splat plugin's library render (which alpha-blends splat pixels
   * with `depthTest=true / depthWrite=false`) cannot overwrite overlays —
   * those visually disappeared into the splat backdrop otherwise even
   * though their materials use depthTest=false.
   *
   * Background-nulling guards three.js' Background.js which would call
   * `forceClear=true` and wipe the back buffer when scene.background is a
   * Color (mirrors the same dance _renderIsolateMode performs).
   */
  private _renderOverlayLayers(): void {
    const gl = this.renderer as unknown as WebGLRenderer;
    const prevAutoClear = gl.autoClear;
    const prevLayerMask = this.camera.layers.mask;
    gl.autoClear = false;
    const savedBg = this.scene.background;
    this.scene.background = null;
    try {
      setOverlayLayersOnly(this.camera);
      gl.clearDepth();
      gl.render(this.scene, this.camera);
    } finally {
      this.scene.background = savedBg;
      this.camera.layers.mask = prevLayerMask;
      gl.autoClear = prevAutoClear;
    }
  }

  /**
   * Render one full frame synchronously through the SAME path as the live
   * render loop — isolate 3-pass composite, EffectComposer/TSL post, plugin
   * onRender and the overlay pass all included.
   *
   * Used by the MCP screenshot capture (rv-frame-capture.ts): a raw
   * `renderer.render(scene, camera)` bypasses the isolate composition and
   * post-processing, so captures would not match what the user sees in the
   * viewport (e.g. an active isolate showed no dimming in screenshots).
   * The renderer has no preserveDrawingBuffer, so callers must read the
   * drawing buffer in the same tick after this returns.
   */
  renderFrameForCapture(): void {
    this._renderDirty = true;
    this.render();
  }

  private render(): void {
    // Render-pause / non-Three backend (plan-256): skip ALL Three GPU work and
    // the per-frame plugin `onRender` dispatch below. This is the render-loop
    // side of the backend switch — `fixedUpdate` (drives, sensors, logic) and
    // the WS signal-flush run in the SEPARATE `onFixedUpdate` loop callback and
    // are unaffected, so live HMI values keep updating over the Omniverse
    // stream. Also centrally neutralises the interactive 3D plugins.
    if (!this._renderBackends.shouldRenderThree()) return;

    if (this.statsReady) this.stats.begin();
    const now = performance.now() / 1000;
    const frameDt = this.lastRenderTime > 0 ? Math.min(now - this.lastRenderTime, 0.1) : 0.016;
    this.lastRenderTime = now;

    // FPS counter (updated every 500ms)
    this.fpsFrameCount++;
    this.fpsAccumTime += frameDt;
    if (this.fpsAccumTime >= 0.5) {
      this.currentFps = Math.round(this.fpsFrameCount / this.fpsAccumTime);
      this.currentFrameTime = +(this.fpsAccumTime / this.fpsFrameCount * 1000).toFixed(1);
      this.fpsFrameCount = 0;
      this.fpsAccumTime = 0;
    }

    this._cameraManager.tickCameraAnimation(frameDt);
    // Camera animation keeps render dirty
    if (this._cameraManager.isCameraAnimating) this._renderDirty = true;
    // Projection animation: lerps the active camera's projection matrix in
    // place, so the renderer needs to redraw every frame for the duration.
    this._cameraManager.tickProjectionAnimation(frameDt);
    if (this._cameraManager.isProjectionAnimating) this._renderDirty = true;
    // Follow / Sit-On tracking — MUST run before controls.update() so the
    // carried orbit target / camera pose isn't overwritten (sets _renderDirty
    // while a mode is active).
    this._cameraManager.tickFollow(frameDt);
    // Damping: keep rendering for N frames after last user input
    if (this._dampingFramesRemaining > 0) {
      this._dampingFramesRemaining--;
      this._renderDirty = true;
    }
    if (this.controls.enabled) this.controls.update();
    // Highlight tracked mode needs rendering when overlays move; a running
    // ping/flash pulse animates opacities and needs per-frame renders too.
    // Aux emphasis pairs are always tracked (planner ghost follows cursor).
    if (
      this.highlighter.isActive
      || this.highlighter.isSelectionActive
      || this.highlighter.isPingActive
      || this.highlighter.isAuxActive
      || this.highlighter.isFlashActive
    ) this._renderDirty = true;
    // A pulsing OutlinePass outline (severity pulse / instruction status
    // outline) animates from the wall clock — it only advances when frames
    // render, so keep rendering while one is active.
    if (this.outlineManager.hasPulsingOutlines) this._renderDirty = true;
    this.highlighter.update();

    // Batched render path: mirror node `.visible` into the arena instances
    // BEFORE any pass renders. Cheap when clean; an actual flip forces a
    // redraw + shadow rebuild. A periodic safety resync (every 60 animation
    // frames) catches mutators that bypassed markShadowsDirty /
    // 'node-visibility-changed' — setVisibleAt no-ops on unchanged values.
    if (this._batchVisibility) {
      const force = ++this._batchVisSafetyCounter >= 60;
      if (force) this._batchVisSafetyCounter = 0;
      const changed = force
        ? this._batchVisibility.forceReconcile()
        : this._batchVisibility.reconcile();
      if (changed > 0) {
        this._renderDirty = true;
        this._shadowsDirty = true;
      }
    }

    // A pending shadow-dirty flag MUST trigger a render, otherwise the
    // flag would be consumed below without the shadow map ever being
    // regenerated (shadowMap.render only runs inside renderer.render).
    if (this._shadowsDirty) this._renderDirty = true;

    // XR sessions MUST render every frame — the compositor needs a submitted
    // frame each animation tick or the passthrough/scene will freeze.
    const glXR = (this.renderer as unknown as WebGLRenderer).xr;
    if (glXR?.isPresenting) this._renderDirty = true;

    // Render-on-demand: skip expensive GPU render when scene is static
    const didMainRender = this._renderDirty;
    const isXRPresentingNow = (this.renderer as unknown as WebGLRenderer).xr?.isPresenting;
    const isolateActiveNow = this.groups?.isIsolateActive || this.autoFilters?.isIsolateActive;
    if (this._renderDirty) {
      // Shadow dirty flag handling lives INSIDE the render block so a
      // pending shadow update isn't silently cleared on a skipped frame.
      if (this._shadowsDirty) {
        this._fitShadowToView();
      }
      (this.renderer.shadowMap as unknown as { needsUpdate: boolean }).needsUpdate = this._shadowsDirty;
      this._shadowsDirty = false;

      // Manually reset per-frame counters (autoReset was disabled during
      // renderer setup) so the snapshot below reflects the total cost of
      // this frame's render path, summed across all passes.
      (this.renderer.info as unknown as { reset(): void }).reset();
      // Save and restore camera layer mask / autoClear across the render
      // branch so an exception in any pass can't corrupt global renderer
      // state for subsequent frames. autoClear is WebGL-specific, so cast
      // for the getter/setter.
      const prevLayerMask = this.camera.layers.mask;
      const glForClearState = this.renderer as unknown as WebGLRenderer;
      const prevAutoClear = glForClearState.autoClear;
      try {
        // XR sessions must always go through the direct renderer path —
        // EffectComposer renders to its own offscreen render targets, and
        // the multi-pass isolate mode clears/overlays in ways that break
        // the XR compositor. Passthrough camera would still show, but no
        // 3D content lands in the XR framebuffer → invisible scene.
        const xrPresenting = (this.renderer as unknown as WebGLRenderer).xr?.isPresenting;
        if (xrPresenting) {
          this.renderer.render(this.scene, this.camera);
        } else if (this.groups?.isIsolateActive || this.autoFilters?.isIsolateActive) {
          this._renderIsolateMode();
        } else if (this._useComposer) {
          const gtaoPass = this._postProcessing.gtaoPass;
          const n8cam = this._postProcessing.n8aoPass as (Pass & { camera?: PerspectiveCamera | OrthographicCamera }) | null;
          const composer = this._postProcessing.composer!;
          const renderPass = composer.passes[0] as RenderPass;
          if (renderPass) renderPass.camera = this.camera;
          // OutlinePass also caches a camera reference at construction —
          // re-bind to the live active camera so outlines stay aligned
          // with their objects after a projection swap.
          this.outlineManager.syncCamera();

          // Pull overlay layers OUT of the composer's main pass:
          //  (a) any depth accidentally written by a highlight wireframe or a
          //      measurement label sprite (SpriteMaterial defaults depthWrite=true
          //      even when transparent=true) would contaminate the GTAO/N8AO
          //      depth sample → halo artifacts around the overlay;
          //  (b) GTAO darkens the entire color buffer post-AO, so an overlay
          //      drawn over a cavity edge in pass 1 would visibly DIM. Rendering
          //      overlays AFTER the composer fixes both issues — same pattern
          //      as the isolation-mode pass 4.
          //  HIGHLIGHT_OVERLAY_LAYER (hover/select wireframes) and
          //  MEASUREMENT_LAYER (markers, lines, distance labels) are both
          //  semantically overlay (depthTest:false, renderOrder>=11) and share
          //  the same exclusion.
          //
          //  Overlay pass itself runs AFTER the plugin onRender loop below —
          //  otherwise the gaussian-splat plugin's render call (which alpha-
          //  blends splats over whatever is in the back buffer) would
          //  overwrite measurement lines / distance labels with splat pixels.
          disableOverlayLayers(this.camera);
          // AO passes render their own gbuffer with a CLONE of the camera that
          // additionally excludes NO_AO_LAYER, so NO_AO-tagged in-scene UI
          // (ghost, grid, glow gizmos) casts no ambient-occlusion halos. The
          // clone is synced AFTER disableOverlayLayers so it inherits the
          // already-reduced mask (overlay layers stay out of AO too). The
          // RenderPass keeps the real camera so all that UI still renders with
          // correct depth-occlusion and bloom.
          const aoCam = this._postProcessing.syncAoCamera(this.camera);
          if (gtaoPass) gtaoPass.camera = aoCam;
          if (n8cam) n8cam.camera = aoCam;
          // Toon outline: render the normal + depth gbuffer the Sobel pass
          // reads. Uses the AO clone camera so overlay + NO_AO-tagged UI
          // (gizmos, ghosts, grid) are excluded from the outline.
          if (this._toon.outlineActive) this._toon.renderPrepass(aoCam);
          composer.render();
        } else if (this._postProcessing.useTslPost) {
          // TSL node post-processing (plan-271 Phase 3) — WebGPURenderer
          // paths. RenderPipeline.render() REPLACES renderer.render(): the
          // scene pass + effect graph (AO / outlines / saturation) render
          // internally and the final quad lands in the default framebuffer.
          // Overlay layers stay excluded here and render in the post-plugin
          // overlay pass below — same contract as the composer branch.
          disableOverlayLayers(this.camera);
          this._postProcessing.renderTslPost(this.scene, this.camera);
        } else {
          // Non-composer path — render scene without overlay layers so the
          // post-plugin overlay pass below can draw them on top of the
          // splat plugin's output (same reason as the composer branch).
          disableOverlayLayers(this.camera);
          this.renderer.render(this.scene, this.camera);
        }
      } finally {
        this.camera.layers.mask = prevLayerMask;
        glForClearState.autoClear = prevAutoClear;
      }
      // Snapshot draw-call / triangle counts into a stable field so the
      // DevTools poller (200ms) sees the last complete frame's totals and
      // not whatever stale or partial values renderer.info holds later.
      const r = (this.renderer.info.render ?? { calls: 0, triangles: 0 }) as {
        calls: number; triangles: number;
      };
      this._lastFrameStats.drawCalls = r.calls;
      this._lastFrameStats.triangles = r.triangles;
      this._renderDirty = false;
    }

    // ── Plugins Render ──
    for (const p of this._renderPlugins) {
      callPlugin(p, 'onRender', frameDt);
    }

    // ── Overlay layers (post-plugins) ──
    //
    // Highlights + measurement markers/lines/labels render LAST, after any
    // plugin onRender has touched the back buffer. This is what guarantees
    // they survive the gaussian-splat plugin's render call (which alpha-
    // blends splats and would otherwise overwrite measurement pixels even
    // though the overlay materials use depthTest=false).
    //
    // Skipped while: nothing was rendered this frame (`!didMainRender` →
    // overlay would draw against a stale buffer); isolate mode (it manages
    // overlay rendering itself); XR (compositor needs the submitted frame
    // untouched).
    if (didMainRender && !isolateActiveNow && !isXRPresentingNow) {
      this._renderOverlayLayers();
    }

    // Emit object-hover + backward-compatible drive-hover events
    if (this.raycastManager) {
      const rm = this.raycastManager;
      const hoveredNode = rm.hoveredNode;
      const hoveredType = rm.hoveredNodeType;
      const hoveredPath = rm.hoveredNodePath;
      const cx = rm.pointerClientX;
      const cy = rm.pointerClientY;

      // Track changes to throttle 'object-hover' to relevant transitions.
      const hoveredDrive = (hoveredNode && hoveredType === 'Drive')
        ? this.registry?.findInParent<RVDrive>(hoveredNode, 'Drive') ?? null
        : null;
      const driveChanged = hoveredDrive !== this.lastHoveredDrive;
      const dx = cx - this.lastHoverClientX;
      const dy = cy - this.lastHoverClientY;
      const movedEnough = dx * dx + dy * dy > 16; // 4px threshold squared
      if (driveChanged || movedEnough) {
        this.lastHoveredDrive = hoveredDrive;
        this.lastHoverClientX = cx;
        this.lastHoverClientY = cy;

        if (hoveredNode && hoveredType && hoveredPath) {
          this.emit('object-hover', {
            node: hoveredNode,
            nodeType: hoveredType,
            nodePath: hoveredPath,
            pointer: { x: cx, y: cy },
            hitPoint: rm.hoveredHitPoint,
            mesh: hoveredNode,
          });
        } else {
          this.emit('object-hover', null);
        }
      }
    }

    if (this.statsReady) { this.stats.end(); this.stats.update(); }

    // --- Renderer.info periodic logging (every 5s at 60fps) ---
    if (this.rendererInfoLogging) {
      this.rendererInfoFrameCount++;
      if (this.rendererInfoFrameCount >= 300) {
        this.rendererInfoFrameCount = 0;
        const info = this.renderer.info;
        const mem = info.memory;
        const rnd = info.render;
        if (!mem || !rnd) return;
        const dedup = this._lastLoadResult?.dedupResult;
        debug('render',
          `DC: ${rnd.calls ?? 0} | Tris: ${rnd.triangles ?? 0} | ` +
          `Geo: ${mem.geometries ?? 0} | Tex: ${mem.textures ?? 0}` +
          (dedup ? ` | Mat: ${dedup.uniqueCount}/${dedup.originalCount}` : '')
        );
        if (this._lastGeoCount > 0 && (mem.geometries ?? 0) > this._lastGeoCount + 10) {
          console.warn(`[Perf] Geometry count growing: ${this._lastGeoCount} → ${mem.geometries}`);
        }
        if (this._lastTexCount > 0 && (mem.textures ?? 0) > this._lastTexCount + 5) {
          console.warn(`[Perf] Texture count growing: ${this._lastTexCount} → ${mem.textures}`);
        }
        this._lastGeoCount = mem.geometries ?? 0;
        this._lastTexCount = mem.textures ?? 0;
      }
    }
  }

  // ─── Extracted Helper Methods ────────────────────────────────────────

  /** Detect whether the real WebGPU backend is active (not forceWebGL). */
  private _detectWebGPU(renderer: Renderer): boolean {
    if (!('isWebGPURenderer' in renderer)) return false;
    const backend = (renderer as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend;
    return !!backend?.isWebGPUBackend;
  }

  /** plan-271 Phase 4 SPIKE opt-in: GPU compute for MU instance transforms.
   *  Hard AND — requires the REAL WebGPU backend (`hasCompute`) AND an
   *  explicit flag (`?mucompute=1` or localStorage 'rv-mu-compute' = '1').
   *  The compute path is NEVER on by default. Returns the renderer to route
   *  into `LoadGLBOptions.muComputeRenderer`, or undefined for the CPU path. */
  private _muComputeRenderer(): unknown {
    if (!this.hasCompute) return undefined;
    try {
      if (typeof window === 'undefined') return undefined;
      const byQuery = new URLSearchParams(window.location.search).get('mucompute') === '1';
      const byStorage = window.localStorage?.getItem('rv-mu-compute') === '1';
      return byQuery || byStorage ? this.renderer : undefined;
    } catch {
      return undefined;
    }
  }

  /** Bind all canvas event listeners. Called ONCE in the constructor. */
  private _bindCanvasEvents(canvas: HTMLCanvasElement): void {
    // Trackpad: two-finger drag rotates when no modifier, pinch (ctrl+wheel) zooms.
    canvas.addEventListener('wheel', (e) => {
      if (e.ctrlKey) return;
      if (e.deltaMode !== 0) return;
      const absDY = Math.abs(e.deltaY);
      if (absDY >= 50 && e.deltaX === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const azimuth = e.deltaX * 0.003;
      const polar = e.deltaY * 0.003;
      const spherical = new Spherical().setFromVector3(
        this.camera.position.clone().sub(this.controls.target),
      );
      spherical.theta += azimuth;
      spherical.phi = Math.max(0.01, Math.min(Math.PI - 0.01, spherical.phi + polar));
      const offset = new Vector3().setFromSpherical(spherical);
      this.camera.position.copy(this.controls.target).add(offset);
      this.camera.lookAt(this.controls.target);
      this.controls.update();
    }, { passive: false });

    // #region CanvasInput
    //
    // Canvas pointer / context-menu / long-press input handling. Marked as a
    // region instead of extracted to a separate class because the handlers
    // touch 22+ `this` members across multiple subsystems (raycastManager,
    // registry, drives, highlighter, selectionManager, controls, plus the
    // private long-press and pointer-down tracking fields above). See plan-
    // 177 section 2.4 (DESCOPED CanvasInputHandler) for the rationale.

    // Canvas click: record pointer start, then select on pointerup only if
    // the pointer didn't move (drag threshold).
    const DRAG_THRESHOLD = DRAG_THRESHOLD_PX;
    canvas.addEventListener('pointerdown', (e) => {
      // Left button: track for click selection
      if (e.button === 0) {
        this._pointerDownPos = { x: e.clientX, y: e.clientY };
      }
      // Right button: track for context menu drag guard
      if (e.button === 2) {
        this._rightDownPos = { x: e.clientX, y: e.clientY };
      }
      // Touch long-press: start timer for context menu
      if (e.pointerType !== 'mouse' && e.button === 0) {
        this._cancelLongPress();
        this._longPressPos = { x: e.clientX, y: e.clientY };
        this._longPressTimer = setTimeout(() => {
          this._handleLongPress(e);
        }, 500);
      }
    });
    canvas.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !this._pointerDownPos) return;
      const dx = e.clientX - this._pointerDownPos.x;
      const dy = e.clientY - this._pointerDownPos.y;
      this._pointerDownPos = null;
      if (dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) return;
      // Note: _isOrbiting is NOT checked here — OrbitControls dispatches 'start'
      // on every pointerdown (setting _isOrbiting=true), but its 'end' event only
      // fires in its own pointerup handler which is registered AFTER ours.  The
      // drag-threshold check above is sufficient to distinguish taps from orbits.

      const hoveredNode = this.raycastManager?.hoveredNode ?? null;
      const hoveredType = this.raycastManager?.hoveredNodeType ?? null;
      const hoveredDrive = (hoveredNode && hoveredType === 'Drive')
        ? this.registry?.findInParent<RVDrive>(hoveredNode, 'Drive') ?? null
        : null;

      // Drive chart special mode: filter drives on click
      if (hoveredDrive && this.driveChartOpen) {
        this.filterDrives(hoveredDrive.name);
        return;
      }

      // Sensor chart special mode: filter sensors on click
      if (hoveredNode && hoveredType === 'Sensor' && this.sensorChartOpen) {
        const path = this.registry?.getPathForNode(hoveredNode);
        if (path) {
          this.filterNodes(hoveredNode.name);
          this.emit('object-clicked', { path, node: hoveredNode });
        }
        return;
      }

      // Normal selection: route through SelectionManager.
      // Resolve via the SAME pipeline hover uses (raycastForRVNodeDetailed →
      // _resolveHit → findContentAncestor owner), so what you hover is exactly
      // what you select — no per-type special-case (e.g. the old Drive walk-up).
      let hitPath: string | null = null;
      let hitNode: Object3D | null = null;
      let hitPoint: [number, number, number] | undefined;

      const detailed = this.raycastManager?.raycastForRVNodeDetailed(e);
      hitPath = detailed?.path ?? this._raycastForRVNode(e);
      hitPoint = detailed?.hitPoint;
      hitNode = hitPath && this.registry ? this.registry.getNode(hitPath) ?? null : null;

      if (hitPath && hitNode) {
        if (e.shiftKey) {
          this.selectionManager.toggle(hitPath, hitPoint);
        } else {
          this.selectionManager.select(hitPath, hitPoint);
        }
        // Backward compat: emit object-clicked for existing listeners.
        // hitPoint lets click consumers tell WHERE on the object the click
        // landed (e.g. the snap-flip icon overlay distinguishes a click on its
        // sprite from a click on the object's geometry — both resolve to the
        // same placed root via the aux-target / ancestor-override resolution).
        this.emit('object-clicked', { path: hitPath, node: hitNode, hitPoint });
      } else {
        // Clicked empty space
        this.selectionManager.clear();
        this.clearFocus();
      }
    });

    // Double-click: emit object-focus for camera zoom
    canvas.addEventListener('dblclick', (e) => {
      const hitPath = this.raycastManager?.raycastForRVNode(e) ?? this._raycastForRVNode(e);
      if (hitPath && this.registry) {
        const node = this.registry.getNode(hitPath);
        if (node) {
          this.emit('object-focus', { path: hitPath, node });
          // On the compact (mobile) layout a double-click only opens the inspector
          // sheet — no camera zoom. Width gate kept in sync with MOBILE_BREAKPOINT
          // (use-mobile-layout.ts) without importing the React/MUI hook into core.
          if (window.innerWidth >= 900) this.fitToNodes([node]);
        }
      }
    });

    // Escape: exit a selection isolate first (before the SelectionManager's
    // bubble-phase Escape handler on `document` would clear the selection).
    // Registered in the capture phase and stops propagation only while isolate
    // is active, so a plain Escape without isolate still clears the selection.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!this._selectionIsolateActive) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      this.exitIsolate();
      e.preventDefault();
      e.stopPropagation();
    }, true);

    // F key: Frame Selected — fit camera to current selection.
    // Industry-standard 3D-tool shortcut (Blender, Unity, Maya all use F).
    // Skipped while typing in form fields. Mirrors a dblclick `object-focus`
    // for the primary selected node so plugins listening on object-focus
    // (e.g. the property inspector) get the same trigger as a double-click.
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyF') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const snap = this.selectionManager.getSnapshot();
      if (snap.selectedPaths.length === 0 || !this.registry) return;
      const nodes: Object3D[] = [];
      for (const p of snap.selectedPaths) {
        const n = this.registry.getNode(p);
        if (!n) continue;
        nodes.push(n);
        // A kinematic axis node is an empty (no geometry of its own) — frame
        // its whole collected group so F focuses the entire kinematic.
        const rv = (n.userData as Record<string, unknown> | undefined)?.['realvirtual'] as
          Record<string, unknown> | undefined;
        if (rv && this.groups) {
          for (const key of Object.keys(rv)) {
            if (!/^Kinematic(_\d+)?$/.test(key)) continue;
            const groupName = (rv[key] as Record<string, unknown> | undefined)?.['GroupName'];
            if (typeof groupName === 'string' && groupName) {
              nodes.push(...(this.groups.get(groupName)?.nodes ?? []));
            }
          }
        }
      }
      if (nodes.length === 0) return;
      e.preventDefault();
      const primary = snap.primaryPath ?? snap.selectedPaths[0];
      const primaryNode = this.registry.getNode(primary);
      // F frames the camera on the existing selection — it must NOT open/reveal
      // the hierarchy (the node is already selected). `openInspector: false`
      // tells the hierarchy listener to skip; other object-focus consumers run.
      if (primaryNode) this.emit('object-focus', { path: primary, node: primaryNode, openInspector: false });
      this.fitToNodes(nodes);
    });

    // ── Context Menu (right-click) ───────────────────────────────────
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault(); // Always suppress browser context menu on canvas

      // Drag-distance guard: if user right-dragged (orbit rotation), skip
      if (this._rightDownPos) {
        const dx = e.clientX - this._rightDownPos.x;
        const dy = e.clientY - this._rightDownPos.y;
        if (dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) {
          this._rightDownPos = null;
          return;
        }
      }
      this._rightDownPos = null;

      // FPV guard: don't open context menu when FPV plugin is active
      const fpvPlugin = this.getPlugin('fpv') as { active?: boolean } | undefined;
      if (fpvPlugin?.active) return;

      this._openContextMenuFromEvent(e);
    });

    // ── Long-press cancellation ──────────────────────────────────────
    canvas.addEventListener('pointermove', (e) => {
      if (this._longPressTimer && this._longPressPos) {
        const dx = e.clientX - this._longPressPos.x;
        const dy = e.clientY - this._longPressPos.y;
        if (dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) {
          this._cancelLongPress();
        }
      }
    });
    canvas.addEventListener('pointerup', () => {
      this._cancelLongPress();
    });
    canvas.addEventListener('pointercancel', () => {
      this._cancelLongPress();
    });
    canvas.addEventListener('touchcancel', () => {
      this._cancelLongPress();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this._cancelLongPress();
    });
  }

  // ─── Context Menu Helpers ───────────────────────────────────────────

  /** Cancel the long-press timer (touch context menu). */
  private _cancelLongPress(): void {
    if (this._longPressTimer) {
      clearTimeout(this._longPressTimer);
      this._longPressTimer = null;
    }
    this._longPressPos = null;
  }

  /** Handle long-press firing: raycast and open context menu. */
  private _handleLongPress(e: PointerEvent): void {
    this._longPressTimer = null;
    // _isOrbiting not checked: long-press timer is already cancelled by
    // pointermove beyond drag threshold (see listener above).

    // FPV guard
    const fpvPlugin = this.getPlugin('fpv') as { active?: boolean } | undefined;
    if (fpvPlugin?.active) return;

    // Use stored position for the raycast (finger may have moved slightly)
    const pos = this._longPressPos;
    if (!pos) return;

    // Create a synthetic mouse event at the stored position for raycast
    const syntheticEvent = { clientX: pos.x, clientY: pos.y } as MouseEvent;
    const detailed = this.raycastManager?.raycastForRVNodeDetailed(syntheticEvent);
    const path = detailed?.path ?? this._raycastForRVNode(syntheticEvent);
    if (!path) return;

    const node = this.registry?.getNode(path);
    if (!node) return;

    const target: ContextMenuTarget = {
      path,
      node,
      types: this.registry!.getComponentTypes(path),
      extras: (node.userData?.realvirtual ?? {}) as Record<string, unknown>,
      hitPoint: detailed?.hitPoint,
      hitNormal: detailed?.hitNormal,
    };

    if (this.raycastManager) {
      this.raycastManager.holdHover = true;
      const isLayout = !!(node.userData?.realvirtual as Record<string, unknown> | undefined)?.LayoutObject;
      this.highlighter.highlight(node, false, { includeChildDrives: isLayout });
    }
    this.contextMenu.open({ x: pos.x, y: pos.y }, target);
    navigator.vibrate?.(50);
    this._longPressPos = null;
  }

  /**
   * Raycast from a mouse event and open the context menu on the hit node.
   * Shared by the `contextmenu` event handler and long-press handler.
   */
  private _openContextMenuFromEvent(e: MouseEvent): void {
    const detailed = this.raycastManager?.raycastForRVNodeDetailed(e);
    const path = detailed?.path ?? this._raycastForRVNode(e);
    if (!path) return;

    const node = this.registry?.getNode(path);
    if (!node) return;

    const target: ContextMenuTarget = {
      path,
      node,
      types: this.registry!.getComponentTypes(path),
      extras: (node.userData?.realvirtual ?? {}) as Record<string, unknown>,
      hitPoint: detailed?.hitPoint,
      hitNormal: detailed?.hitNormal,
    };

    // Hold hover highlight while context menu is open.
    // OrbitControls fires 'start' on pointerdown (before contextmenu) which
    // disables the raycast manager and clears hover. Re-apply the highlight
    // here so the object stays highlighted while the menu is open.
    if (this.raycastManager) {
      this.raycastManager.holdHover = true;
      const isLayout = !!(node.userData?.realvirtual as Record<string, unknown> | undefined)?.LayoutObject;
      this.highlighter.highlight(node, false, { includeChildDrives: isLayout });
    }
    this.contextMenu.open({ x: e.clientX, y: e.clientY }, target);
    this.emit('context-menu-request', { pos: { x: e.clientX, y: e.clientY }, path, node });
  }
  // #endregion CanvasInput

  /** Set up XR if available (WebGPU real backend has no XR support). */
  private _setupXR(renderer: Renderer, container: HTMLElement): void {
    if (this.isWebGPU) return;
    const xr = (renderer as unknown as Record<string, unknown>).xr as Record<string, unknown> | undefined;
    if (!xr || typeof xr.addEventListener !== 'function') return;
    const glRenderer = renderer as unknown as WebGLRenderer;
    glRenderer.xr.enabled = true;

    glRenderer.xr.addEventListener('sessionstart', () => {
      this._savedBackground = this.scene.background as Color | null;
      this._savedShadowState = this.renderer.shadowMap.enabled;
      this.renderer.shadowMap.enabled = false;
      this.controls.enabled = false;
      if (this.resizeHandler) window.removeEventListener('resize', this.resizeHandler);
      if (this.resizeObserver) this.resizeObserver.disconnect();
      this.emit('xr-session-start', undefined as void);
    });
    glRenderer.xr.addEventListener('sessionend', () => {
      this.scene.background = this._savedBackground;
      this.renderer.shadowMap.enabled = this._savedShadowState;
      this.controls.reset();
      this.controls.enabled = true;
      if (this.resizeHandler) {
        window.addEventListener('resize', this.resizeHandler);
        this.resizeHandler();
      }
      if (this.resizeObserver) this.resizeObserver.observe(container);
      this.emit('xr-session-end', undefined as void);
    });
  }

  /** Initialize stats-gl with fallback for WebGPU incompatibility. */
  private _setupStats(renderer: Renderer): void {
    this.stats = new Stats({
      trackGPU: true,
      trackHz: true,
      trackCPT: false,
      logsPerSecond: 4,
      graphsPerSecond: 30,
      samplesLog: 40,
      samplesGraph: 10,
      precision: 2,
      minimal: false,
      horizontal: true,
    });
    this.stats.dom.style.position = 'absolute';
    this.stats.dom.style.bottom = '12px';
    this.stats.dom.style.left = '12px';
    this.stats.dom.style.display = 'none';
    document.body.appendChild(this.stats.dom);
    try {
      this.stats.init(renderer as unknown as WebGLRenderer);
      this.statsReady = true;
    } catch {
      console.warn('[RVViewer] stats-gl init failed — GPU profiling disabled');
      this.statsReady = false;
    }
  }

  // Ground plane factory (createGroundFade) and the checker pattern helper
  // (drawCheckerPattern) now live in `engine/rv-ground-plane.ts`. The
  // constants FLOOR_FADE_START_RATIO / FLOOR_FADE_END_RATIO are still
  // referenced inside loadModel() above for the dynamic ground scale.
}
