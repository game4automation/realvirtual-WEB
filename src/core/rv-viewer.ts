// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { readLocalStorage } from './rv-safe-storage';

import { BlockageWatch } from './diagnostics/rv-blockage-watch';
import { clearBlockageProblems } from './hmi/problems-store';
import { getDefaultMovementAuthority } from './engine/rv-movement-authority';
import type { WaitRegistry } from './diagnostics/rv-wait-registry';
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

import { ProgressWiring } from './diagnostics/rv-progress-wiring';
import { behaviorWaitSource, clearBehaviorWaitSources } from './diagnostics/rv-behavior-wait-sources';
import { BudgetResolver } from './diagnostics/rv-blockage-budget';
import type { ProgressLedger } from './diagnostics/rv-progress-ledger';
import { getDefaultAgvFleet } from './engine/rv-agv-fleet';
import { resetLayerNames } from './engine/rv-layers';
import { installRollerSpin, type RollerSpinHost } from './engine/rv-roller-spin';
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
  type Material,
  type Camera,
  MeshStandardMaterial,
  NoToneMapping,
  CanvasTexture,
  Texture,
  Matrix4,
  Frustum,
  Plane,
  Quaternion,
} from 'three';
import type { Renderer } from 'three/webgpu';
import { preloadTslMaterials, createMaterialContext, getTslMaterials, type RendererKind } from './engine/materials/material-factory';
import type { TslPostPipeline } from './engine/materials/rv-post-processing-tsl';
import type { RenderStrategy, RenderStrategyContext, ViewportRect } from './engine/rv-render-strategy';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  applyNavigationSettingsToControls,
  configureOrbitControls,
} from './engine/rv-orbit-controls-config';
import type { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import type { AOMode } from './hmi/visual-settings-store';
import { PostProcessingManager, PP_SCALE, type PostProcessingHost } from './rv-post-processing';
import {
  createFrameStats, resetFrameStats, addDelta, finalizeFrameStats, drawCallsOf,
  instrumentComposerPasses, instrumentShadowMap, instrumentTslPasses, withActiveBucket,
  countRenderTargets, setActiveFrameStats,
  type FrameStats, type RenderInfoLike, type ShadowMapLike,
} from './engine/rv-frame-stats';
import { RVToonMaterialManager } from './rv-toon-materials';
import { RVWireframeView } from './rv-wireframe-view';
import { createGroundFade, drawCheckerPattern } from './engine/rv-ground-plane';
import {
  createGroundReflector, adaptWebGLReflector, groundReflectorConstants, bookReflectionPass,
  type GroundReflector,
} from './engine/rv-ground-reflector';
import type { ToneMappingType, ShadowQuality, ProjectionType, VisualSettings } from './hmi/visual-settings-store';
import {
  loadVisualSettings,
  saveVisualSettings,
  getSourceMarkersVisible,
  setSourceMarkersVisible as setSourceMarkersVisibleStore,
  subscribeSourceMarkersVisible,
  getVanishMUs,
  setVanishMUs as setVanishMUsStore,
  subscribeVanishMUs,
  isFpsCap,
  fpsCapToFrameInterval,
  type FpsCap,
} from './hmi/visual-settings-store';
import { CameraManager, DAMPING_REFERENCE_HZ, timeScaledDampingFactor, type ViewportOffset, type CameraFollowOwner } from './rv-camera-manager';
import { scaleSimDt } from './engine/rv-speed-override';
import { UserActivity, bindViewportGestureActivity } from './rv-user-activity';
import type { FollowSource } from './engine/rv-follow-source';
import { invalidateNodeShadowBindings, VisualSettingsManager } from './rv-visual-settings-manager';
import {
  getRenderMode, isRenderModeAvailable, DEFAULT_RENDER_MODE,
  type RenderMode, type RenderModeContext,
} from './rv-render-modes';
import { getRaytracedBackend, type RaytracedDeviceLimits } from './engine/rv-raytraced-hook';
import { RaytracedModeController, type RaytracedStatus } from './engine/rv-raytraced-host';
import { setRenderMode } from './hmi/render-mode-controller';
import Stats from 'stats-gl';

import { EventEmitter } from './rv-events';
import { bumpModelCatalog } from './rv-model-catalog';
import { debug, logInfo } from './engine/rv-debug';
import { createLoadProfiler } from './engine/rv-load-profiler';
import { newNodeId } from './engine/rv-node-id';
import { identityIdOf } from './engine/rv-decode-identity';
import { uuidV5, RV_NODE_ID_NAMESPACE } from './engine/rv-node-id-seed.mjs';
import { loadModelSettingsConfig } from './hmi/rv-settings-bundle';
import { DRAG_THRESHOLD_PX, DEFAULT_DPR_CAP, NO_AO_LAYER } from './engine/rv-constants';
import {
  loadGLB,
  computeBVHAsync,
  createRuntimeNode,
  removeRuntimeNode,
  removeAuthoredSubtree,
  disposeLoadedSubtree,
  initializeComponents,
  runOnSceneReady,
  LoadAbortedError,
  classifyPreplacedMUs,
  type DeferredLogic,
  type LoadResult,
  type RuntimeNodeSpec,
} from './engine/rv-scene-loader';
import { disposeModelSubtree } from './engine/rv-dispose-subtree';
import {
  applyBaselinePlacementEdits,
  isEmptyBaselinePlacementEdits,
  type BaselinePlacementEdits,
} from './engine/rv-baseline-placement-edits';
import { createUberMaterial, type RVUberMaterial } from './engine/rv-uber-material';
import { createBVHPort, type BVHBuildPort } from './engine/rv-bvh-build-port';
import { disposeSharedPickBuildPort } from './engine/rv-pick-build-port';
import type { RVExtrasOverlay } from './engine/rv-extras-overlay-store';
import type { RvScene } from './hmi/scene/rv-scene-types';
import type { PlacementsSnapshot } from './rv-shared-types';
import type { MultiuserSnapshot } from '../plugins/multiuser-plugin';
import type { McpBridgeSnapshot } from '../plugins/mcp-bridge-plugin';
import { InstancePickIndex } from './engine/rv-instance-pick-index';
import type { EditorArenaManager } from './editor/rv-editor-arena';
import { PickMetrics, type PickMetricsSnapshot } from './engine/rv-pick-metrics';
import {
  loadModelJsonConfig,
  extractGlbPluginConfig,
  mergeModelConfig,
  type ModelConfig,
} from './engine/rv-model-config';
import { collectStateSnapshot, type StateSnapshot } from './engine/rv-state-snapshot';
import { installInvariants, invariantsOnRenderedFrame } from './engine/rv-invariants';
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
import { RibbonEditorPreview } from './engine/rv-ribbon-editor-preview';
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
import { setChunkBoundsSource, clearChunkBoundsSource } from './engine/rv-traverse-utils';
import { showStatusOutline, hideStatusOutline } from './engine/rv-status-outline';
import { RVOutlineManager, type OutlineStyle } from './engine/rv-outline-manager';
import { RaycastManager, type ObjectHoverData, type ObjectUnhoverData, type ObjectClickData, type HoverableType, type SurfaceHit } from './engine/rv-raycast-manager';
import { NavigationController } from './engine/rv-navigation-controller';
import {
  SceneScale, bindSceneScaleEvents, computeContentBoundsInto, computeMovingBoundsInto, type SceneScaleEventSource,
  type SceneScaleSnapshot,
} from './engine/rv-scene-scale';
import {
  groundSquareSize, shadowCameraFor, GROUND_SQUARE_DEFAULT, type ShadowCameraFit,
} from './engine/rv-scale-constants';
import { fitFloor } from './engine/rv-navigation-math';
import type { RVDrive } from './engine/rv-drive';
import { resetSmoothMotionDegradation } from './engine/rv-smooth-motion-port';
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
import { AxisDiagnosticsManager } from './engine/rv-axis-diagnostics';
import { clearMjcfProblems } from './engine/rv-mjcf-problems';
import { WebLabelManager } from './engine/rv-web-label-manager';
import { SceneButtonManager } from './engine/rv-scene-button-manager';
import { RVCollisionManager } from './engine/rv-collision-manager';
import { RVDropManager } from './engine/rv-drop-manager';
import {
  SignalReapplyRegistry,
  setActiveSignalReapplyRegistry,
  getActiveSignalReapplyRegistry,
} from './engine/rv-signal-reapply-registry';
import { StatsRegistry, ScopedStatsRegistry, setActiveStatsRegistry, getActiveStatsRegistry } from './stats/rv-stats-registry';
import { EnergyChainManager } from './engine/rv-energy-chain-manager';
import { ChainManager } from './engine/rv-chain-manager';
import { RibbonManager } from './engine/rv-ribbon-manager';
import { MachiningManager } from './engine/rv-machining-manager';
import {
  registerOverlayProducer, resetOverlayProducers,
  isOverlayVisible, subscribeOverlayVisibility,
} from './overlay-visibility-store';
import { SignalBindingManager } from './engine/rv-signal-binding-manager';
// plan-386 F17 — load provenance. Re-exported below so existing importers of
// the viewer keep finding the type where they expect it.
import { withLoadTrust, TRUSTED_LOAD, type LoadTrustContext } from './rv-load-trust';
import type { ModelLoadSource } from './engine/rv-script-trust';
export { TRUSTED_LOAD, type LoadTrustContext } from './rv-load-trust';
// plan-423 F6 — the PERSISTENT counterpart of the load-time trust context.
import {
  LOCAL_PROVENANCE, setModelProvenance, type ModelProvenance,
} from './rv-model-provenance';
export { LOCAL_PROVENANCE, type ModelProvenance } from './rv-model-provenance';
import {
  resetSlotAuthority,
  setAuthorityRanking,
  liveControlledCount,
  type AuthorityRanking,
} from './engine/rv-slot-authority';
import type { SignalWriteGateMode } from './engine/rv-signal-store';
import { ErrorStore } from './engine/rv-error-store';
import { InstructionRuntimeStore } from './engine/rv-instruction-runtime-store';
import { ComponentEventDispatcher } from './engine/rv-component-event-dispatcher';
import { GroupRegistry } from './engine/rv-group-registry';
import { EntityPool, type EntityPoolOptions } from './engine/rv-entity-pool';
import { AutoFilterRegistry } from './engine/rv-auto-filter-registry';
import {
  ISOLATE_FOCUS_LAYER,
  HIGHLIGHT_OVERLAY_LAYER,
  AGENT_EYE_LAYER,
  disableOverlayLayers,
  setOverlayLayersOnly,
} from './engine/rv-group-registry';
import {
  detectActiveGPU, enumerateOtherAdapters, isSameAsActive,
  analyzeGPU,
  type GPUInfo, type GPUAnalysis,
} from './engine/rv-gpu-info';
import { registerFilterSubscriber, loadSearchSettings, isTypeEnabled } from './hmi/search-settings-store';
import { getPickableTypes, getTypesWhere, getRegisteredCapabilities, getCapabilities } from './engine/rv-component-registry';
import { BakeRegistry, pickMemoryStats, type PickMemoryStats } from './engine/rv-bake-registry';
import { collectDeferredPlacements, type PlacementInstancer } from './engine/rv-placement-instancer';
import { createViewerPlacementInstancer, mergePlacedLogic, disposePlacedRoot } from './engine/rv-placement-integrate';
import { getDefaultPathNetwork } from './engine/rv-path-network';
import { markDeferredPlacement, canonicalizeAssetOverridesIn } from './engine/rv-asset-reference';
import {
  generatedOwnerOf,
  type StructuralPlacementSpec,
  type ReplaceRuntimeSubtreeResult,
} from './engine/rv-structural-derived';
import { buildInitContext, type InitContextBase, type InitSubsystems } from './engine/rv-init-context';
import {
  clearBakeFailedProblems, clearLogicGatedProblems, clearNestedReferenceProblems, clearOverrideOrphanedProblems,
  clearPluginClaimProblems, clearReferenceAuditProblems, reportReferenceAudit, setProblemsDocument,
  reportKinematicMembersInPlacedContent,
  clearReferenceMigrationProblems, clearIkProblems,
  clearSignalNameCollisionProblems, clearInstanceSignalCollisionProblems, clearUnresolvedInstructionTargetProblems,
} from './hmi/problems-store';
import { resetPathIdCollisions } from './engine/rv-path';
import {
  auditKinematicGroupsInPlacedContent, auditReferences, fieldHoldsReference, type ReferenceAuditResult,
} from './engine/rv-reference-audit';
import { SceneLoadGate, whenSceneReady, installPlacementsRefit, installPlacementsSimHold } from './engine/rv-scene-ready';
import { PathTopologyCheck } from './connect/path-topology-check';
import type { RVPath } from './engine/rv-path';
import { PickBackend } from './engine/rv-pick-backend';
import type { RVViewerPlugin } from './rv-plugin';
import type { ViewerEvents } from './rv-viewer-events';
import type { ViewerHost } from './engine/rv-viewer-host';
import { UIPluginRegistry } from './rv-ui-registry';
import { LeftPanelManager } from './hmi/left-panel-manager';
import { SelectionManager, keyEventBelongsToViewer } from './engine/rv-selection-manager';
import type { RVHighlightPolicy } from './engine/rv-highlight-policy';
import { ContextMenuStore } from './hmi/context-menu-store';
import type { ContextMenuTarget } from './hmi/context-menu-store';
import type { SelectionSnapshot } from './engine/rv-selection-manager';
import { isMobileDevice } from '../hooks/use-mobile-layout';
import { resetDynamicContexts, setContext } from './hmi/ui-context-store';
import { ConnectionModeController, type ConnectionStartMode } from './engine/rv-connection-mode';
import { WebOperatorPanelHost } from './engine/rv-web-operator-panel';
import { OperatorPanelController } from './hmi/operator-devices/operator-panel-model';
import { createRecordingHmiApi, type RecordingHmiApi } from './engine/rv-recording-hmi';
import { SignalUsageService, installCoreSignalUsageProviders } from './engine/rv-signal-usage-index';
import { getActiveEditTarget } from './hmi/rv-edit-target';
import { disposeAgentEyeMonitor } from './hmi/agent-eye-monitor-store';
import { isPluginOverrideProtected } from './plugin-overrides/rv-plugin-override-store';
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
import { onTrafficRegistriesReset, resetTrafficRegistries } from './engine/rv-traffic-registries';
import {
  resetMergeEntryCheckStats, resetAgvFleetStepDiagnostics, suspendContinuousAgvs, activateContinuousAgvs,
} from '../behaviors/Agv';
import { ContinuousRunner } from './material-flow/continuous-runner';
import { isDesRestoring } from './material-flow/des-restore-guard';
import { DesSnapshotBlockers } from './material-flow/des-snapshot-blockers';
import { SimulationKernel } from './material-flow/simulation-kernel';
import { StatisticsManager } from './material-flow/rv-statistics-manager';
// Plan 194 P5 — the DES runner factory is INJECTED, never imported concretely.
// plan-652 Phase 3: not even statically any more. The on-demand DES feature
// (`features/des.body`) hands it over through `setDesRunnerFactory()`; the
// fallback `loadDesRunnerFactory()` imports `plugins/des/register-des-runner`
// dynamically (plan-680: DES is core code, the same module in every build).
import type { DesRunnerFactory } from './material-flow/simulation-kernel';
import {
  setDeferredComponentHandler, clearDeferredComponentHandler, type DeferredComponentHandler,
} from './engine/rv-component-types';
import { FeatureLoader, featureChunkBytes, ensureFeatureIfDeclared } from './rv-feature-loader';
import { defineSignalConnectorFeature } from '../features/signal-connector.register';
import { memoizeAsync, type MemoizedAsync } from './rv-memoize-async';
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

/**
 * plan-516 sim start of the pre-placed MUs: register them (and resolve their
 * collider loads) with the transport manager — only with the logic active,
 * only in continuous mode (DES activation is plan-519) and never in a
 * multiuser client session (the plugin sets `preplacedActivationBlocked`).
 * Idempotent — the manager ignores a second call while they are active.
 * Defensive about its host: the reset and gate paths are also pinned on
 * narrow fake viewers whose transport manager is a two-method mock.
 */
function activatePreplacedMUs(
  tm: RVTransportManager | null | undefined,
  logicRunState: LogicRunState | undefined,
  mode: string,
): void {
  if (!tm || logicRunState !== 'active' || mode !== 'continuous') return;
  const activate = (tm as Partial<RVTransportManager>).activatePreplaced;
  if (typeof activate === 'function') activate.call(tm);
}

/**
 * plan-538 F6 — re-initialise the sensor / zone feedback from the PLANT state
 * right after a simulation reset, BEFORE the LogicSteps restart: the reset put
 * the pre-placed MUs back and cleared every occupancy flag, and without this
 * pass a sensor under a pre-placed MU would only report it after the first
 * transport tick — one tick after a restarted step already read "free".
 * Detection only: no MU moves, no source spawns, no sink consumes. Sensors run
 * the brute-force overlap (exact, independent of the MU grid the reset
 * cleared); zones evaluate their activation and Detect against all live MUs.
 * Defensive about its host — the reset is also pinned on narrow fakes.
 */
function refreshPlantFeedback(tm: RVTransportManager | null | undefined): void {
  if (!tm) return;
  const mus = (tm as Partial<RVTransportManager>).mus;
  if (!Array.isArray(mus)) return;
  const sensors = (tm as Partial<RVTransportManager>).sensors ?? [];
  const physicsManaged = (tm as Partial<RVTransportManager>).physicsManagedSensors ?? null;
  for (const sensor of sensors) {
    if (physicsManaged !== null && physicsManaged.has(sensor)) continue;
    if (typeof sensor.checkOverlap !== 'function') continue;
    sensor.loadRoots = mus;
    sensor.updateAABB();
    sensor.checkOverlap(mus);
  }
  const zones = (tm as Partial<RVTransportManager>).zones;
  if (zones && zones.size > 0) {
    // All live MUs as candidates — the MU grid is empty after the reset.
    const host = Object.create(tm) as RVTransportManager;
    host.zoneCandidates = () => mus;
    for (const zone of zones) {
      if (!zone.isOwner) continue;
      zone.updateBounds();
      zone.updateActivation();
      zone.evaluateDetect(host);
    }
  }
}

/** A fat-line material whose pixel resolution a video capture pins (plan-537 F11). */
interface CaptureLineMaterial {
  mat: Material & { resolution: Vector2 };
  /** Resolution before the capture, restored by endCapture(). */
  w: number;
  h: number;
}

/**
 * State of a running video capture (plan-537) — the session lock AND the
 * snapshot of everything beginCapture() changed, restored by endCapture().
 */
interface CaptureState {
  outputWidth: number;
  outputHeight: number;
  /**
   * plan-557 F2c: the height (px) WebLabel screen sizes are computed against; null = the
   * output height (the video contract). A viewport still passes the on-screen equivalent.
   */
  labelReferenceHeight: number | null;
  renderWidth: number;
  renderHeight: number;
  supersample: number;
  /** Render-time delta handed to render-time ticks for the current render. */
  frameDt: number;
  /** Deterministic render clock (s) — replaces performance.now() in render(). */
  clockSec: number;
  /** Set by clearModel()/dispose(): the capture must stop between frames. */
  abortReason: string | null;
  disposed: boolean;
  /** A window resize arrived during the capture — replayed by endCapture(). */
  resizePending: boolean;
  loopWasRunning: boolean;
  dpr: number;
  composerDpr: number | null;
  cssWidth: number;
  cssHeight: number;
  perspAspect: number;
  camera: PerspectiveCamera | OrthographicCamera;
  camPos: Vector3;
  camQuat: Quaternion;
  camUp: Vector3;
  camZoom: number;
  camNear: number;
  camFar: number;
  camFov: number;
  orthoFrustum: [number, number, number, number] | null;
  controlsTarget: Vector3;
  controlsEnabled: boolean;
  controlsDamping: boolean;
  selection: string[];
  raycastEnabled: boolean | null;
  pointerEvents: string;
  /** selection, hover, chain, status, flash — in that order. */
  outlineStyles: OutlineStyle[];
  toonThickness: number;
  ppScale: number;
  shadowMapSize: number;
  shadowChanged: boolean;
  lineMats: CaptureLineMaterial[];
}

// ─── WebGPU boot limits (plan-762 F14) ─────────────────────────────────────

/** The four device limits an internal build requests from the adapter (spike 0.f). */
export const WEBGPU_REQUIRED_LIMIT_NAMES = [
  'maxStorageBufferBindingSize',
  'maxBufferSize',
  'maxStorageBuffersPerShaderStage',
  'maxComputeWorkgroupStorageSize',
] as const;

/** The adapter options three r185 `WebGPUBackend.init` requests with (xr off at init). */
export const WEBGPU_ADAPTER_OPTIONS: GPURequestAdapterOptions & { featureLevel: string; xrCompatible: boolean } = {
  powerPreference: undefined,
  featureLevel: 'compatibility',
  xrCompatible: false,
};

export interface WebGPURendererBootOptions<R> {
  /** Request the adapter limits (internal build AND the real WebGPU backend). */
  internal: boolean;
  /** `navigator.gpu` (injected for tests). */
  gpu: Pick<GPU, 'requestAdapter'> | undefined;
  /** Construct a renderer; `extra.requiredLimits` is set only on the limits attempt. */
  create(extra: { requiredLimits?: Record<string, number> }): R & { init(): Promise<unknown>; dispose(): void };
  /** Defaults to `console.warn`. */
  warn?(message: string, err: unknown): void;
}

/**
 * Construct and `init()` a WebGPURenderer. In an internal build the four
 * {@link WEBGPU_REQUIRED_LIMIT_NAMES} are read from an adapter requested with
 * {@link WEBGPU_ADAPTER_OPTIONS} and passed as `requiredLimits`; when that
 * `init()` fails the renderer is disposed and ONE retry without limits follows
 * (visible warning). Without `internal` it is the plain construction. Throws
 * when the last attempt fails — the caller then takes its WebGL fallback.
 */
export async function initWebGPURendererWithLimits<R>(opts: WebGPURendererBootOptions<R>): Promise<R> {
  const warn = opts.warn ?? ((m: string, e: unknown) => console.warn(m, e));
  let requiredLimits: Record<string, number> | undefined;
  if (opts.internal && opts.gpu) {
    try {
      const adapter = await opts.gpu.requestAdapter(WEBGPU_ADAPTER_OPTIONS as GPURequestAdapterOptions);
      if (adapter) {
        requiredLimits = {};
        for (const name of WEBGPU_REQUIRED_LIMIT_NAMES) {
          const v = (adapter.limits as unknown as Record<string, unknown>)[name];
          if (typeof v === 'number') requiredLimits[name] = v;
        }
      }
    } catch (err) {
      warn('[RVViewer] WebGPU adapter limits unavailable — creating the renderer without requiredLimits:', err);
      requiredLimits = undefined;
    }
  }
  const first = opts.create(requiredLimits ? { requiredLimits } : {});
  try {
    await first.init();
    return first;
  } catch (err) {
    first.dispose();
    if (!requiredLimits) throw err;
    warn('[RVViewer] WebGPU init() with the adapter limits failed — retrying once without requiredLimits (the ray traced mode may not fit its buffers):', err);
  }
  const second = opts.create({});
  try {
    await second.init();
  } catch (err) {
    second.dispose();
    throw err;
  }
  return second;
}

/** The on-demand features every viewer declares (embed included): core components that load lazily. */
function withCoreFeatures(features: FeatureLoader): FeatureLoader {
  // plan-2227: the SignalConnector (component, kernel, network) loads with the first model that has one.
  defineSignalConnectorFeature(features);
  return features;
}

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

  private performanceStats!: Stats;
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

  /**
   * Baked-placement registry (plan-753 Phase 3): planner placements are
   * instances of a `BakedAsset` — chunk meshes with shared geometry, logic
   * nodes, keep clones. The viewer only OWNS the registry and wires it into
   * the pick backend and the highlight manager; the planner drives it
   * (`instantiate` / `release`). Loaded models keep the old pipeline until
   * Phase 4 (§2.4 coexistence).
   */
  readonly bakeRegistry: BakeRegistry = new BakeRegistry();

  /**
   * THE placement primitive (plan-753 structure hardening): asset key →
   * shared `BakedAsset` → instance under a placement root. Viewer-owned so a
   * layout document loads as shared instances with or without the planner
   * plugin; owns the document-scoped `ModelCache`. Every planner entry (drop,
   * snap, duplicate, draft swap, restore, reload) goes through it.
   */
  readonly placements: PlacementInstancer = createViewerPlacementInstancer(this);

  /** @internal Loads in flight — one half of {@link whenSceneReady}. */
  readonly sceneLoadGate = new SceneLoadGate();

  /**
   * Load-time successor check of the path network (plan-633 F8): after the
   * scene is ready it compares the authored `successors` with the path ends
   * and reports `path-successor-mismatch` / `path-end-near-miss` to the
   * Problems panel. Mode-independent; installed in the constructor.
   */
  readonly pathTopologyCheck: PathTopologyCheck = new PathTopologyCheck({
    on: (event, cb) => (this.on as unknown as (e: string, c: (d: unknown) => void) => () => void).call(this, event, cb),
    whenSceneReady: () => this.whenSceneReady(),
    sceneLoadGate: this.sceneLoadGate,
    nodePathOfPath: (pathId) =>
      this.registry?.getAll<{ path?: { id: string } | null }>('Path')
        .find((e) => e.instance.path?.id === pathId)?.path ?? null,
    // One map per check run instead of a scan per finding (plan-644). First
    // entry wins, like `find()` above.
    nodePathsOfPaths: () => {
      const out = new Map<string, string>();
      for (const e of this.registry?.getAll<{ path?: { id: string } | null }>('Path') ?? []) {
        const id = e.instance.path?.id;
        if (id !== undefined && !out.has(id) && e.path) out.set(id, e.path);
      }
      return out;
    },
    // The model's own paths — the shared default network can still hold paths of
    // an earlier model (path components are not disposed on a model switch).
    scenePaths: () => {
      const out: RVPath[] = [];
      for (const e of this.registry?.getAll<{ path?: RVPath | null }>('Path') ?? []) {
        if (e.instance.path) out.push(e.instance.path);
      }
      return out;
    },
  });
  private _uninstallPathTopologyCheck: (() => void) | null = null;

  /**
   * THE join point "the scene is complete": no load in flight AND every placed
   * reference of the document materialised (`placements.state === 'idle'`).
   * `model-loaded` fires BEFORE that — the references of a layout document
   * arrive seconds later. Follows a document change; never rejects. The event
   * form is `placements-materialized` (once per load). See `rv-scene-ready.ts`.
   */
  whenSceneReady(): Promise<void> {
    return whenSceneReady(this);
  }

  /**
   * Resolves when the CURRENT document's own LogicSteps are built (plan-769
   * Phase 6, D20) — the moment `viewer.logicEngine` holds the document's roots.
   *
   * They are not built at `model-loaded` / `'model-logic-activated'` when the
   * document places references: a step resolves its targets when it is built,
   * so it waits for the placements (see `_attachMainLogic`). The promise
   * resolves at once for a document that places nothing (already built before
   * `onModelLoaded`), on this load's settle otherwise, and — for a document
   * held by the trust gate — when `activateGatedLogic()` built them. Already
   * built → resolves at once.
   *
   * Ordering: it is resolved at the very point the steps are merged, inside
   * this load's `'placements-materialized'`, so a continuation awaiting it runs
   * BEFORE any `whenSceneReady()` continuation of the same settle.
   *
   * Per load, never rejects: a load superseded by a newer one or a
   * `clearModel()` resolves the pending promise of the old load WITHOUT its
   * steps being built — callers guard with their own load generation. A gated
   * document that is never activated keeps it pending until activation or the
   * next load / clear. Before the first load it is pending as well.
   */
  whenModelLogicBuilt(): Promise<void> {
    if (this._mainLogicBuiltLoad === this._loadGeneration) return Promise.resolve();
    const waiter = this._mainLogicWaiter;
    if (waiter && waiter.load === this._loadGeneration) return waiter.promise;
    // Defensive: a waiter of an older generation is released (clearModel normally did).
    waiter?.resolve();
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    this._mainLogicWaiter = { load: this._loadGeneration, promise, resolve };
    return promise;
  }

  // --- Outline system (post-process OutlinePass; OutlinePass on WebGL, TSL outline nodes on WebGPU) ---
  /** Plugin-driven OutlinePass wrapper. `available` is false on WebGPU. */
  readonly outlineManager: RVOutlineManager;

  // --- Generic gizmo overlay system (always available) ---
  /** Central 3D-overlay/gizmo system. Used by WebSensor and other components. */
  readonly gizmoManager: GizmoOverlayManager;
  /** Viewer-owned registry for Lamp lifecycle and fixed-update flashing. */
  readonly lampManager: LampManager;
  /** Following-error / overload diagnostics of the dynamic axes and grip loads
   *  (plan-673 Phase 4). Ticked at the end of the drive stage; publishes its
   *  signals as ONE `setMany` batch per fixed step. */
  readonly axisDiagnostics: AxisDiagnosticsManager;
  /** Viewer-owned registry for WebLabel components (plan-529): screen size,
   *  distance fade and the `labels` overlay toggle — ticked in the RENDER path,
   *  independent of the simulation — plus the label link clicks. */
  readonly webLabelManager: WebLabelManager;
  /** Viewer-owned registry for the 3D scene-button family (plan-417): press /
   *  turn animation, momentary release timers and the component lifecycle. */
  readonly sceneButtonManager: SceneButtonManager;
  /** Viewer-owned registry for EnergyChain rigs and their per-frame bone update. */
  readonly energyChainManager: EnergyChainManager;
  /** Viewer-owned registry for Chain components and their per-tick element poses
   *  (plan-733). Ticked from CoreSubsystems.visuals() AFTER the drive stage and
   *  re-posed from resetSimulation() AFTER the drive resets. */
  readonly chainManager: ChainManager;
  /** Viewer-owned registry for RibbonPath components and their per-tick web
   *  advance (plan-459). Ticked from CoreSubsystems.visuals() AFTER the drive
   *  stage — which is also what makes the winder-master speed source a plain
   *  read rather than a drive behaviour — and reset from resetSimulation()
   *  AFTER the drive resets. */
  readonly ribbonManager: RibbonManager;
  readonly ribbonEditorPreview: RibbonEditorPreview;
  /** Viewer-owned registry for CSG machining volumes and their per-tick cut +
   *  chunk-mesh apply (plan-405). Survives model loads; `clear()` on every
   *  model switch destroys the worker-side grids and the chunk geometries,
   *  `dispose()` terminates the worker. */
  readonly machiningManager: MachiningManager;
  /** Viewer-owned collision registry + per-tick check (plan-394). Survives model
   *  loads; `clear()` on every model switch drops registry, highlight, signals
   *  and an open modal. */
  readonly collisionManager: RVCollisionManager;
  /** Viewer-owned unsupported-part detection (plan-2022). Survives model loads;
   *  `clear()` on every model switch drops the registry, the outline, the
   *  signals and every published card. Detection uses schema defaults without an
   *  authored component; Settings can disable it (plan-2022 E5). */
  readonly dropManager: RVDropManager;

  /**
   * Viewer-owned registry of wired component input slots (plan-427).
   *
   * The SignalStore is edge-driven, a PLC is level-based. After
   * `resetSimulation()` — which deliberately leaves signals untouched — and
   * after a (re)connect, `reapplyAll()` drives every registered slot once with
   * the value CURRENTLY in the store, so a level held `true` across the reset
   * takes effect again. Survives model loads; `clear()` on every model switch.
   */
  readonly signalReapply = new SignalReapplyRegistry();
  /** Statistics sections contributed by this viewer's features and components. */
  readonly stats = new StatsRegistry();
  /** Sections contributed through ComponentContext.statsRegistry, emptied by clearModel. */
  readonly componentStats = new ScopedStatsRegistry(this.stats);

  // --- Planner Signal Linking (gated by RVViewerOptions.plannerSignalLinking) ---
  /** Binding/override engine that links placed Planner elements to live CONNECT
   *  signals. `null` when the feature flag is off (no manager, no guards).
   *  (Re)built per model load once signalStore + registry exist. */
  signalBindingManager: SignalBindingManager | null = null;
  /** Cached feature-flag from RVViewerOptions. */
  private readonly _plannerSignalLinking: boolean = false;

  // --- Load trust (plan-386 F17) ---
  /** Trust context of the load currently in flight. See {@link loadTrust}. */
  private _loadTrust: LoadTrustContext = TRUSTED_LOAD;
  /** The slot `withLoadTrust` installs into and restores. */
  private readonly _trustSlot = {
    get: (): LoadTrustContext => this._loadTrust,
    set: (next: LoadTrustContext): void => { this._loadTrust = next; },
  };
  /** Provenance of the model ON SCREEN. See {@link modelProvenance}. */
  private _modelProvenance: ModelProvenance = LOCAL_PROVENANCE;
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
  /**
   * Placement roots whose LogicSteps the trust gate holds back (plan-757 F6):
   * their components sit in `_deferredLogic`, their logic subtree is merged
   * only if the user releases the gate (`activateGatedLogic`).
   */
  private readonly _heldPlacementLogicRoots: Object3D[] = [];

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
    ensureDiscrete: async () => {
      await ensureFeatureIfDeclared(this, 'des', 'command:sim.discrete');
      if (!this._getKernel()?.hasDesRunner()) await this.loadDesRunnerFactory();
    },
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
  /**
   * Scale-adaptive navigation (plan-515): the ONLY mouse / wheel / touch path —
   * zoom toward the surface under the cursor (canvas centre with
   * `wheelZoomToCursor = false`), orbit about controls.target (the surface point
   * under the cursor with `navigateAroundCursorPoint`), trackpad orbit, dynamic near/far.
   * Null only after `dispose()`.
   */
  navController: NavigationController | null = null;
  /** Content bounds / scale of the scene (plan-515 §2.3) — near/far, zoom caps. */
  sceneScale!: SceneScale;
  /**
   * The viewer container as keyboard scope (plan-515 R3-2): F / Shift+F /
   * Escape of the SelectionManager are handled for key events inside it.
   */
  keyboardScope: HTMLElement | null = null;
  /** The main viewer also takes keys from outside every viewer (HMI, body). */
  readonly keyboardScopeIsPrimary = true;
  private _sceneScaleOff: (() => void) | null = null;
  /** Document capture listener: Escape exits a selection isolate (scoped, R3-2). */
  private _isolateEscapeHandler: ((e: KeyboardEvent) => void) | null = null;
  /**
   * When the user last used THIS viewer's viewport (plan-520) — fed only by real
   * input (controls gesture, canvas pointerdown / wheel, keys in the viewer's
   * keyboard scope). The MCP "Follow agent" feedback moves the camera only while
   * it reports idle.
   */
  readonly userActivity = new UserActivity();
  /** Unbinds the controls-'start' → userActivity wiring (plan-520). */
  private _gestureActivityOff: (() => void) | null = null;
  /** Document capture listener: a key in the viewer's scope counts as user input (plan-520). */
  private _activityKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  /** Document `visibilitychange` listener (long-press cancel); removed in dispose(). */
  private _visibilityHandler: (() => void) | null = null;
  /** Aborts every canvas listener (their closures capture the viewer); run in dispose(). */
  private readonly _domAbort = new AbortController();
  /** Removes the XR session listeners (they capture the viewer); run in dispose(). */
  private _xrOff: (() => void) | null = null;
  /** Per-mesh two-level pick backend — installed on every load that did NOT
   *  bake (authoring loads; a document that draws nothing). Membership is
   *  maintained by the asset-op executors via {@link instancePickIndex}. */
  private _instancePickIndex: InstancePickIndex | null = null;
  /**
   * The asset editor's batched display (plan-766 Phase 2): BatchedMesh arenas
   * that draw the authored meshes while the sources stay in the tree with
   * `layers.mask = 0`. Installed and disposed by the asset-editor plugin;
   * `null` everywhere else, and every viewer seam is an optional call on it,
   * so without a manager the viewer behaves exactly as before.
   */
  editorArena: EditorArenaManager | null = null;
  /** The baked-chunk backend of the current load (plan-756); reports its mode. */
  private _pickBackend: PickBackend | null = null;

  /** The editor instance pick index (null outside authoring loads). */
  get instancePickIndex(): InstancePickIndex | null {
    return this._instancePickIndex;
  }
  transportManager: RVTransportManager | null = null;
  private _progressWiring: ProgressWiring | null = null;
  blockageBudgets: BudgetResolver | null = null;
  /** Subsystems without a DES snapshot participant register here; this viewer's DES runner refuses to snapshot while one is active (plan-2059 O7). */
  readonly snapshotBlockers = new DesSnapshotBlockers();
  readonly blockageWatch = new BlockageWatch(() => {
    const ledger = this.progressLedger, registry = this.waitRegistry, budgets = this.blockageBudgets;
    return ledger && registry && budgets ? { ledger, registry, budgets, now: this.simTime } : null;
  });
  /** Model progress accounting for diagnostics; owned and reset by the viewer. */
  get waitRegistry(): WaitRegistry | null { return this._progressWiring?.waitRegistry ?? null; }
  get progressWiring(): ProgressWiring | null { return this._progressWiring; }
  get progressLedger(): ProgressLedger | null { return this._progressWiring?.ledger ?? null; }

  /**
   * Load-generation guard (plan-240 F9). Incremented at the START of every
   * `loadModel()` and in `clearModel()`. The asynchronous BVH build captures
   * the value at kickoff and aborts its WHOLE remaining sequence — discarding
   * any in-flight result — as soon as the generation moves on, so it never
   * writes a `boundsTree` onto a disposed/stale geometry.
   */
  private _loadGeneration = 0;
  /**
   * The `_loadGeneration` whose `placements-materialized` (not aborted) has
   * fired — "this load's scene is complete" for a LATE logic attach
   * (`activateGatedLogic` → `_attachMainLogic`, plan-769 Phase 6).
   */
  private _placementsSettledLoad = -1;
  /** The `_loadGeneration` whose own LogicSteps `_attachMainLogic` built ({@link whenModelLogicBuilt}). */
  private _mainLogicBuiltLoad = -1;
  /** The pending {@link whenModelLogicBuilt} promise of one load generation, or null. */
  private _mainLogicWaiter: { load: number; promise: Promise<void>; resolve: () => void } | null = null;
  /** Reused async BVH build port (ONE worker across model loads, plan-240).
   *  Created lazily on the first build; disposed only in `dispose()` —
   *  clearModel() keeps it alive for the next load. */
  private _bvhPort: BVHBuildPort | null = null;
  /** The running async BVH build of the last load (incl. its two-frame delay), or null. */
  private _bvhBuildRun: Promise<void> | null = null;

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
  /** Cached: only plugins with onBeforeFrame, sorted by order. */
  private _beforeFramePlugins: RVViewerPlugin[] = [];
  private readonly _beforeFrameCallbacks: Array<(dtSeconds: number, nowMs: number) => void> = [];
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
      get snapshotBlockers() { return viewer.snapshotBlockers; },
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
      get axisDiagnostics() { return viewer.axisDiagnostics; },
      get sceneButtonManager() { return viewer.sceneButtonManager; },
      get energyChainManager() { return viewer.energyChainManager; },
      get chainManager() { return viewer.chainManager; },
      get ribbonManager() { return viewer.ribbonManager; },
      get machiningManager() { return viewer.machiningManager; },
      get collisionManager() { return viewer.collisionManager; },
      // No dropManager here on purpose: unlike the collision check it has no
      // update step of its own — it rides inside the transport manager's MU
      // pass (plan-2022), so CoreSubsystems has nothing to call.
      markRenderDirty: () => viewer.markRenderDirty(),
      markShadowsDirty: () => viewer.markShadowsDirty(),
    }))(this);
  /** IDs of plugins that have been disabled via disablePlugin(). */
  private _disabledIds = new Set<string>();
  /** Session-scoped user overrides that mode reconciliation must not undo. */
  private _userDisabledIds = new Set<string>();
  /**
   * The persisted INTENT to keep a plugin switched off (plan-435 §2.9),
   * deliberately independent of the plugin registry.
   *
   * `setPluginUserEnabled()` returns immediately for an unknown ID, but plenty
   * of plugins are only registered while the model loads (`resolvePlugin`), or
   * even after it (`DebugEndpointPlugin`, `McpBridgePlugin`). Holding the
   * intent here means it survives "that ID does not exist yet" and is applied
   * the moment the plugin shows up in {@link use}.
   */
  private _persistedUserDisabled = new Set<string>();
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
  /** Raw load URL of the main document (the content-ledger key of its bytes, plan-2059). */
  private _mainDocumentLoadUrl: string | null = null;
  /** Main document byte-ledger key (never a placement URL) — also for a document that draws nothing (a pure layout). */
  get mainDocumentKey(): string | null { return this._lastLoadResult?.bakedAsset?.assetId ?? this._mainDocumentLoadUrl; }
  /** Lazy plugin factories: ID → async import factory (code-split by Vite). */
  private _lazyFactories = new Map<string, () => Promise<{ default: unknown }>>();
  /** Shared in-flight resolution per lazy id (plan-652): parallel callers get ONE instance, a failure is retried. */
  private _lazyResolutions = new Map<string, MemoizedAsync<RVViewerPlugin | null>>();
  /**
   * On-demand feature activation (plan-652): startup features are recorded here,
   * lazy ones (editor, DES, …) are declared by their stub and activated by a trigger.
   */
  /** The DES runner factory (plan-652 Phase 3) — `null` until the DES feature hands it over. */
  private _desRunnerFactory: DesRunnerFactory = null;
  /** One shared dynamic import of the runner module (fallback, see {@link loadDesRunnerFactory}). */
  private _desRunnerImport: MemoizedAsync<boolean> | null = null;
  /** This viewer's safety-net handler (plan-652), cleared on dispose. */
  private _deferredComponentHandler: DeferredComponentHandler | null = null;
  readonly features: FeatureLoader = withCoreFeatures(new FeatureLoader(this, {
    showHint: (message) => { void import('./hmi/info-overlay-store').then((m) => m.showInfoOverlay(message, { showSpinner: true })); },
    hideHint: () => { void import('./hmi/info-overlay-store').then((m) => m.hideInfoOverlay()); },
    bytesOf: (id) => featureChunkBytes(id),
  }));
  /** URL of the currently loaded model (for reloadModel). */
  private _currentModelUrl: string | null = null;
  /** Where the current model's bytes came from (see {@link currentModelSource}). */
  private _currentModelSource: ModelLoadSource | null = null;
  /** Original model URL set by main.ts before loadModel (survives blob URL override). */
  pendingModelUrl: string | null = null;
  /** True while OrbitControls is actively rotating/panning/pinching. */
  private _isOrbiting = false;
  /** Pointer position at pointerdown — used for drag-distance threshold. */
  private _pointerDownPos: { x: number; y: number } | null = null;
  /** `performance.now()` of the last left pointerdown (plan-529 long-press guard). */
  private _pointerDownTime = 0;
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

  /*
   * `availablePublishedScenes` used to sit here (removed in plan-731 2.3).
   *
   * It carried the `scenes/index.json` catalogue from boot to the SceneStore
   * constructor, and by naming a `PublishedSceneEntry` on the viewer facade it
   * declared the second document identity space as part of the public API.
   * Examples are `documents[]` rows now, read from the project store where
   * every other document is read.
   */

  /** UI plugin registry for React slot rendering. */
  readonly uiRegistry = new UIPluginRegistry();

  /**
   * plan-539 F15 — Simulation / PLC mode of the loaded model (`ConnectionMode`
   * component). Applied at load before the logic starts; switched by the
   * toggle next to the simulation controls and `web_sim_mode`; a live
   * interface connection overrides it. `StartMode` changes are written into
   * the active document so the next save keeps them.
   */
  readonly connectionMode: ConnectionModeController = new ConnectionModeController(
    ((viewer: RVViewer) => ({
      get connectionState() { return viewer.connectionState; },
      setConnectionState: (s: 'Connected' | 'Disconnected') => viewer.setConnectionState(s),
      // plan-539 F15b: an interface takeover switches the logic at once, so the
      // virtual PLC's deactivation runs BEFORE the interface's batch lands.
      syncLogicConnection: () => viewer.logicEngine?.setConnected(viewer.connectionState === 'Connected'),
    }))(this),
    (nodePath: string, value: ConnectionStartMode, prev: ConnectionStartMode): boolean => {
      const target = getActiveEditTarget();
      if (!target.available) return false;
      target.setField(nodePath, 'ConnectionMode', 'StartMode', value, prev);
      return target.persistsTo !== 'none';
    },
  );

  /**
   * Operator panels carried by the model (plan-543): one window per
   * `WebOperatorPanel` component of the main model and its placements. Rebuilt
   * on model load, reconciled when placements come or go and when a component
   * is added, edited or removed (editor / MCP) — the overlay that draws the
   * windows is loaded the first time a model has one.
   */
  readonly webOperatorPanels: WebOperatorPanelHost = new WebOperatorPanelHost(
    ((viewer: RVViewer) => ({
      get registry() { return viewer.registry; },
      get signalStore() { return viewer.signalStore; },
      get connectionMode() { return viewer.connectionMode; },
      // plan-673: whether code that could still register signals is on its
      // way. A panel whose config names a lazy feature's signals is
      // "starting up" while this is true and only misconfigured once it is
      // false — the one thing that tells the two apart without a clock.
      featureActivity: {
        get pending() { return viewer.features.hasActivationsInFlight(); },
        subscribe: (cb: () => void) => viewer.features.subscribe(cb),
      },
    }))(this),
  );
  private _operatorPanelUi: Promise<void> | null = null;

  /**
   * Signal cross-reference list (plan-566): where each signal is used —
   * component fields, logic steps, ST programs, operator panels, bindings and
   * CONNECT bridges. Built lazily by the first reader after an invalidation;
   * the events wired in the constructor only mark it stale, never rebuild it.
   */
  readonly signalUsage: SignalUsageService = new SignalUsageService();

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
    if (plugin.onBeforeFrame) insertSorted(this._beforeFramePlugins, plugin);
    if (plugin.onRender) insertSorted(this._renderPlugins, plugin);
    this._invalidatePluginSnapshots();

    this._recomputePhysicsPluginActive();

    // Auto-register UI slot entries if the plugin provides them
    if (plugin.slots && plugin.slots.length > 0) {
      this.uiRegistry.register(plugin);
    }

    // A persisted override for a LATE-registered plugin (plan-435 §2.9) is
    // applied here — BEFORE the retroactive delivery below, so the plugin
    // never builds anything up just to have it torn down again.
    if (this._persistedUserDisabled.has(plugin.id) && plugin.core !== true) {
      this.setPluginUserEnabled(plugin.id, false);
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
   * Does a plugin take part in the CURRENT workspace mode? Thin wrapper around
   * `pluginParticipatesInMode` — which already handles the boot null-mode
   * correctly: `core` and shared (`modes === undefined`) plugins participate,
   * mode-scoped ones do not (rv-mode-manager.ts). Deliberately NOT guarded by
   * an extra `activeMode !== null`: that guard is what used to strand a
   * shared/core plugin in `_disabledIds` forever when it was toggled during
   * boot, because `computeModePluginSets` never lists shared/core plugins and
   * therefore never heals them (plan-435 §2.3).
   */
  private _shouldParticipate(plugin: RVViewerPlugin): boolean {
    return pluginParticipatesInMode(plugin, this.modes.activeMode);
  }

  /**
   * Apply a user override for a plugin, with a real retroactive teardown
   * (plan-435). Switching OFF removes what the plugin has already built;
   * switching ON restores it symmetrically, including its UI slot positions.
   *
   * The teardown lives HERE and nowhere else. `disablePlugin()` /
   * `enablePlugin()` stay untouched on purpose — they are also the mode
   * system's reconcile path, and anchoring a teardown there would fire it on
   * every workspace mode switch (plan-435 §2.2).
   *
   * OFF: mode-deactivate hook → `onDeactivate` (or, as a fallback, a single
   * `onModelCleared` when the plugin actually holds the current model) →
   * disable → unregister UI slots → event.
   *
   * ON: re-register UI slots → (only when the plugin participates in the
   * active mode) enable, which replays a missed `onModelLoaded` by itself →
   * `onActivate`, or as a fallback a replay of the current model → mode
   * activate hook → event.
   *
   * The plugin instance itself is never disposed and keeps its own state.
   */
  setPluginUserEnabled(id: string, enabled: boolean): void {
    const plugin = this._plugins.find((candidate) => candidate.id === id);
    if (!plugin) return;
    const hasSlots = plugin.slots !== undefined && plugin.slots.length > 0;

    if (!enabled) {
      if (this._userDisabledIds.has(id)) return;
      this._userDisabledIds.add(id);
      // Keep the persisted intent in step. `core` plugins are never persisted:
      // a reload must not be able to boot into a crippled viewer.
      if (plugin.core !== true) this._persistedUserDisabled.add(id);
      const activeMode = this.modes.activeMode;
      if (activeMode !== null && pluginParticipatesInMode(plugin, activeMode)) {
        callPlugin(plugin, 'onModeDeactivate', activeMode, this);
      }
      // Retroactive teardown. A present `onDeactivate` wins outright; only
      // without it does the model-cleared fallback run, and only when this
      // plugin actually received the current model. `_modelLoadedIds` is
      // cleared ONLY on that fallback branch — see the invariants on
      // RVViewerPlugin.onDeactivate.
      if (plugin.onDeactivate) {
        callPlugin(plugin, 'onDeactivate', this);
      } else if (this._modelLoadedIds.has(id)) {
        callPlugin(plugin, 'onModelCleared', this);
        this._modelLoadedIds.delete(id);
      }
      this.disablePlugin(id);
      if (hasSlots) this.uiRegistry.unregister(id);
      this.emit('plugins-changed', { kind: 'user-disabled', id });
      return;
    }

    if (!this._userDisabledIds.delete(id)) return;
    this._persistedUserDisabled.delete(id);
    // Slots come back BEFORE the lifecycle so an activate hook already sees
    // its own UI. `register()` is idempotent and restores the slot position.
    if (hasSlots) this.uiRegistry.register(plugin);
    if (this._shouldParticipate(plugin)) {
      this.enablePlugin(id);
      if (plugin.onActivate) {
        callPlugin(plugin, 'onActivate', this);
      } else if (
        this._lastLoadResult
        && !this._modelLoadedIds.has(id)
        && this._isPluginEligibleForCurrentModel(plugin)
      ) {
        // Fallback restore — but never hand a plugin a model that model's
        // own `rv_plugins` list excludes.
        this._deliverModelLoaded(plugin, this._lastLoadResult);
      }
      const activeMode = this.modes.activeMode;
      if (activeMode !== null && pluginParticipatesInMode(plugin, activeMode)) {
        callPlugin(plugin, 'onModeActivate', activeMode, this);
      }
    }
    this.emit('plugins-changed', { kind: 'user-enabled', id });
  }

  /** Clear all session-scoped user overrides and restore mode-driven state. */
  clearPluginUserOverrides(): void {
    for (const id of [...this._userDisabledIds]) {
      this.setPluginUserEnabled(id, true);
    }
    this._persistedUserDisabled.clear();
  }

  /**
   * Apply persisted user overrides (plan-435 §2.9). Call once at boot, after
   * the last `use()` and BEFORE `loadModel()` — then a switched-off plugin
   * never receives an `onModelLoaded` it would only have to undo.
   *
   * Two safety nets, applied here as well as when saving: `core: true` plugins
   * and protected IDs are skipped even if the storage claims otherwise, so a
   * hand-edited or stale record cannot lock the user out of their own viewer.
   *
   * IDs that are not registered yet are remembered, not dropped — {@link use}
   * applies them the moment the plugin appears.
   */
  applyPersistedPluginOverrides(ids: Iterable<string>): void {
    for (const id of ids) {
      if (isPluginOverrideProtected(id)) continue;
      const plugin = this._plugins.find((candidate) => candidate.id === id);
      if (plugin?.core === true) continue;
      this._persistedUserDisabled.add(id);
      if (plugin) this.setPluginUserEnabled(id, false);
    }
  }

  /**
   * The IDs to persist: the current user overrides minus everything that must
   * never survive a reload (`core: true`, protected). Counterpart to
   * {@link applyPersistedPluginOverrides}.
   */
  getPersistedPluginOverrideIds(): string[] {
    const ids: string[] = [];
    for (const id of this._userDisabledIds) {
      if (isPluginOverrideProtected(id)) continue;
      if (this._plugins.find((candidate) => candidate.id === id)?.core === true) continue;
      ids.push(id);
    }
    return ids;
  }

  /** Type-safe plugin lookup by ID. */
  getPlugin<T extends RVViewerPlugin>(id: string): T | undefined {
    return this._plugins.find((p) => p.id === id) as T | undefined;
  }

  /**
   * plan-754 D17: every registered plugin's `bakeClaims()`, collected right
   * before the model bake. Disabled plugins count too — a claim only keeps a
   * node, and the plugin may be enabled later without a reload. Isolated per
   * plugin like every other callback; malformed entries are dropped.
   *
   * `complete` is what stops a silent D17 hole: model plugins are registered
   * DEFERRED while the layout planner is active, so in that state nothing here
   * can be asked and the honest answer is "not checked", not "zero unresolved"
   * (plan-754 Phase 1c). It rides on to the removal report rather than forcing
   * an early registration, which would re-introduce the register→unregister
   * flash of the model HMI that the deferral exists to avoid.
   */
  private _collectBakeClaims(): {
    claims: Array<{ path: string; role: 'merge' | 'chunk'; pluginId: string }>;
    complete: boolean;
  } {
    const claims: Array<{ path: string; role: 'merge' | 'chunk'; pluginId: string }> = [];
    for (const p of this._plugins) {
      if (!p.bakeClaims) continue;
      try {
        for (const c of p.bakeClaims() ?? []) {
          if (c && typeof c.path === 'string' && c.path && (c.role === 'merge' || c.role === 'chunk')) {
            claims.push({ path: c.path, role: c.role, pluginId: p.id });
          }
        }
      } catch (e) {
        console.error(`[RVViewer] plugin '${p.id}' bakeClaims() failed:`, e);
      }
    }
    const set = { claims, complete: !(this.modelPluginManager?.hasDeferredModelPlugins() ?? false) };
    this._lastBakeClaims = set.claims;
    return set;
  }

  /** The claims collected for the CURRENT document's bake (plan-757 §2.6 reads them per placement). */
  private _lastBakeClaims: ReadonlyArray<{ path: string; role: 'merge' | 'chunk'; pluginId: string }> = [];

  /**
   * plan-757 §2.6 / D5: the plugin bake claims collected for the document
   * being shown. A claim is a MAIN-MODEL input; `integratePlacedContent` reads
   * this list to report a claim that lies inside a placement as
   * `plugin-claim-not-applicable` instead of silently keeping nothing.
   */
  get collectedBakeClaims(): ReadonlyArray<{ path: string; role: 'merge' | 'chunk'; pluginId: string }> {
    return this._lastBakeClaims;
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
    this._beforeFramePlugins = this._beforeFramePlugins.filter(p => p.id !== id);
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
    if (plugin.onBeforeFrame) insertSorted(this._beforeFramePlugins, plugin);
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
    this._beforeFramePlugins = this._beforeFramePlugins.filter(p => p.id !== id);
    this._renderPlugins = this._renderPlugins.filter(p => p.id !== id);
    this._invalidatePluginSnapshots();
    this._disabledIds.delete(id);
    this._userDisabledIds.delete(id);
    // Also drop the PERSISTED intent (plan-435): an explicit unregistration is
    // a deliberate act, and a re-registered plugin must not silently come back
    // switched off. Without this, `removePlugin()` + `use()` would resurrect
    // the override that `_userDisabledIds.delete` above just cleared.
    this._persistedUserDisabled.delete(id);
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
    this._lazyResolutions.delete(id);
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

    // 2. Lazy built-in? One shared resolution per id (memoizeAsync): two parallel
    //    callers must not instantiate the plugin twice; a failed import is retried next time.
    const factory = this._lazyFactories.get(id);
    if (factory) {
      let resolution = this._lazyResolutions.get(id);
      if (!resolution) {
        resolution = memoizeAsync(async () => {
          const mod = await factory();
          const PluginOrInstance = mod.default;
          const plugin = typeof PluginOrInstance === 'function'
            ? new (PluginOrInstance as new () => RVViewerPlugin)()
            : PluginOrInstance as RVViewerPlugin;
          if (!plugin || !plugin.id) throw new Error(`lazy plugin '${id}' has no default export with an id`);
          const already = this._plugins.find(p => p.id === plugin.id);
          if (already) return already;
          this.use(plugin, 'core');
          return plugin;
        });
        this._lazyResolutions.set(id, resolution);
      }
      try {
        return await resolution();
      } catch (e) {
        console.warn(`[RVViewer] Failed to load lazy plugin '${id}':`, e);
        return null;
      }
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
    // The exclusive group is every pickable type with a filter label (plan-753
    // §2.3: the old `exclusiveHoverGroup` flag is gone, `ui.filter` is the
    // membership test) — the same set the filter dropdown and the visibility
    // auto-filters show, so "hover only Drives" and "isolate Drives" agree.
    const group = getTypesWhere((c) => c.pick !== 'none' && c.ui.filter !== null);
    if (mode) {
      // Enable only the requested type, disable all others in the exclusive group
      for (const type of group) {
        this.raycastManager.enableHoverType(type, type === mode);
      }
    } else {
      // Default: all exclusive-group types hoverable
      for (const type of group) {
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
  }

  /**
   * The session's ONE shared uber material (plan-752 S2).
   *
   * Every bake site collapses onto this reference: the document load
   * (`applyUberMaterial` in `loadGLB`) and the layout planner's ModelCache,
   * which bakes an asset's master tree once at decode so that every placement
   * of it lands in the SAME uber arena the reload path builds.
   *
   * Deliberately a session singleton, not a per-model one: it carries an
   * `onBeforeCompile` patch, and two textually identical patches on two
   * material instances confuse the three.js program cache (three.js#19377).
   * It is marked `userData._rvShared`, so `clearModel()` leaves it alone.
   */
  ensureUberMaterial(): RVUberMaterial {
    if (!this._uberMaterial) this._uberMaterial = createUberMaterial(this.isWebGPU);
    return this._uberMaterial;
  }

  /**
   * The uber material a PLACEMENT may bake onto, or null when this session's
   * model does not use the uber path at all.
   *
   * plan-774 F2: an editor / STEP-inspection load (`preserveHierarchy`) keeps
   * raw per-part materials on its OWN content, but its references are
   * placements baked exactly like in the HMI — onto this same material, so the
   * chunks (and the `BakedAsset`) are the HMI's. The load answers it with
   * `placementUberAllowed`; older results fall back to the main model's mode.
   */
  get placementUberMaterial(): RVUberMaterial | null {
    // The load's MODE answers (`placementBakeAllowed`), never the in-place
    // bake: a deferred layout (plan-753) has no mesh of its own, so its
    // `bakedAsset` is null — yet its placements must bake onto this material
    // or each becomes `tex:<uuid>` chunks. Before the first load the bake is
    // the only runtime there is (plan-757 Phase 3 commit B), so the answer is
    // the session material.
    if (this._lastLoadResult) {
      const r = this._lastLoadResult;
      return (r.placementUberAllowed ?? r.placementBakeAllowed ?? !!r.bakedAsset) ? this.ensureUberMaterial() : null;
    }
    return this.ensureUberMaterial();
  }

  /**
   * Mark the render pass as dirty so the next frame renders.
   * Call from plugins that need continuous rendering (e.g. FPV movement).
   */
  markRenderDirty(): void {
    this._renderDirty = true;
  }

  /**
   * Install (or remove with `null`) the render strategy that replaces the main
   * scene pass with N views into canvas rectangles (plan-2215, see
   * `engine/rv-render-strategy.ts`). Exactly one owner: installing a second
   * strategy while another one is set returns false and changes nothing.
   * Removing is idempotent. Without a strategy the render path is unchanged.
   */
  setRenderStrategy(strategy: RenderStrategy | null): boolean {
    if (strategy && this._renderStrategy && this._renderStrategy !== strategy) return false;
    if (strategy === this._renderStrategy) return true;
    if (this._renderStrategy) this._removeRenderStrategy();
    this._renderStrategy = strategy;
    if (strategy) {
      if (strategy.canvasSize) this._sizeBeforeStrategy = (this.renderer as unknown as WebGLRenderer).getSize(new Vector2());
      this._applyStrategyPixelRatio(strategy);
      // Resize also renders. Let the owner finish activation before that callback can fail.
      if (strategy.canvasSize) queueMicrotask(() => {
        if (this._renderStrategy === strategy) this.resizeHandler?.();
      });
    }
    this._renderDirty = true;
    return true;
  }

  /**
   * Hold the strategy's fixed pixel ratio (`RenderStrategy.pixelRatio`). The DPR
   * in effect before is remembered once; a DPR someone else set meanwhile (the
   * render-resolution setting) becomes the one restored on removal.
   */
  private _applyStrategyPixelRatio(strategy: RenderStrategy): void {
    const size = strategy.canvasSize;
    if (size) this.renderer.setSize(size.width, size.height, false);
    const dpr = strategy.pixelRatio;
    if (dpr === undefined) return;
    const gl = this.renderer as unknown as WebGLRenderer;
    const current = gl.getPixelRatio();
    if (current === dpr) {
      if (this._dprBeforeStrategy === null) this._dprBeforeStrategy = current;
      return;
    }
    this._dprBeforeStrategy = current;
    // setPixelRatio resizes the drawing buffer at the unchanged CSS size.
    gl.setPixelRatio(dpr);
  }

  /**
   * Remove the installed strategy and give back the pixel ratio it held. Inside
   * `render()` (`inRender`, the failure path) the resize pass that follows is
   * deferred — the resize handler renders itself.
   */
  private _removeRenderStrategy(inRender = false): void {
    this._renderStrategy = null;
    const dpr = this._dprBeforeStrategy;
    const size = this._sizeBeforeStrategy;
    this._sizeBeforeStrategy = null;
    this._dprBeforeStrategy = null;
    if (dpr === null && !size) return;
    const gl = this.renderer as unknown as WebGLRenderer;
    const dprChanged = dpr !== null && gl.getPixelRatio() !== dpr;
    if (!dprChanged && !size) return;
    if (dprChanged) gl.setPixelRatio(dpr!);
    if (size) gl.setSize(size.x, size.y, false);
    // The regular resize path re-sizes everything that follows the drawing buffer.
    this._renderDirty = true;
    if (!this.resizeHandler) return;
    if (inRender) queueMicrotask(() => this.resizeHandler?.());
    else this.resizeHandler();
  }

  /** The installed render strategy, or null. */
  get renderStrategy(): RenderStrategy | null { return this._renderStrategy; }

  /**
   * True while a render strategy draws the frames. Plugins that draw into the
   * back buffer themselves (`onRender`) ask {@link strategyFrame} instead — it
   * also knows the mono capture frames.
   */
  get renderStrategyActive(): boolean {
    return this._renderStrategy !== null && this._renderStrategy.active;
  }

  /**
   * True while a pointer pick from screen coordinates is invalid: a render
   * strategy draws views whose cameras differ from `viewer.camera`, so a ray
   * from `viewer.camera` through the pointer would hit the wrong object. Every
   * pointer handler that raycasts with `viewer.camera` from client coordinates
   * asks THIS getter, skips its pick and aborts a running gesture (plan-2215 2.6).
   * Captures do not change it (they bypass the strategy for one frame only).
   */
  get pointerPickBlocked(): boolean {
    return this.renderStrategyActive;
  }

  /**
   * True while the back buffer holds a frame a render strategy drew — the
   * current frame, or the last rendered one on a tick without a main render.
   * False for every mono frame, including screenshots and video captures,
   * which bypass the strategy. Plugins that draw into the back buffer with the
   * navigation camera (`onRender`) skip their pass exactly then (plan-2215).
   */
  get strategyFrame(): boolean {
    return this._strategyFrame;
  }

  /**
   * Run an extra off-screen render outside the main pass (e.g. from a plugin's
   * `onRender`). For the duration of `fn` the ground reflector is hidden (its
   * `onBeforeRender` would re-render the whole scene), the global section
   * clipping (`renderer.clippingPlanes`) and XR are disabled, and
   * `scene.matrixWorldAutoUpdate` stays off — the world matrices are walked at
   * most once per frame (the main pass already did it when it ran). Everything,
   * including the active render target and `autoClear`, is restored in a
   * `finally`, also when `fn` throws (the error propagates).
   *
   * Returns `false` without running `fn` while a video capture is running
   * (the capture owns the frame) and under a WebGPURenderer (`fn` receives a
   * classic `WebGLRenderer`). The draw calls of the pass are booked in the
   * frame stats of the calling context (`plugins` for `onRender`).
   */
  renderAuxiliaryPass(fn: (renderer: WebGLRenderer, scene: Scene) => void): boolean {
    if (this._capture || this.isWebGPU) return false;
    const renderer = this.renderer as unknown as WebGLRenderer;
    if (!renderer || typeof renderer.setRenderTarget !== 'function') return false;
    const scene = this.scene;
    const reflector = this._groundReflector?.mesh ?? null;
    const prevReflectorVisible = reflector ? reflector.visible : false;
    const prevClippingPlanes = renderer.clippingPlanes;
    const prevLocalClipping = renderer.localClippingEnabled;
    const xr = renderer.xr as { enabled: boolean } | undefined;
    const prevXr = xr ? xr.enabled : false;
    const prevMatrixAuto = scene.matrixWorldAutoUpdate;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    try {
      // One walk per frame: only when the main pass did not do it this frame.
      if (!this._auxMatricesFresh) {
        scene.updateMatrixWorld();
        this._auxMatricesFresh = true;
      }
      if (reflector) reflector.visible = false;
      renderer.clippingPlanes = RVViewer._NO_CLIPPING_PLANES;
      if (xr) xr.enabled = false;
      scene.matrixWorldAutoUpdate = false;
      fn(renderer, scene);
    } finally {
      if (reflector) reflector.visible = prevReflectorVisible;
      renderer.clippingPlanes = prevClippingPlanes;
      renderer.localClippingEnabled = prevLocalClipping;
      if (xr) xr.enabled = prevXr;
      scene.matrixWorldAutoUpdate = prevMatrixAuto;
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAutoClear;
    }
    return true;
  }
  /** Shared empty clipping-plane list for {@link renderAuxiliaryPass} (never mutated). */
  private static readonly _NO_CLIPPING_PLANES: Plane[] = [];
  /** True once the scene's world matrices were walked in the current frame
   *  (main pass or a previous auxiliary pass); reset at the top of `render()`. */
  private _auxMatricesFresh = false;

  /** Create a component node at runtime (op-log `addNode`). Returns false if the
   *  scene isn't loaded or the parent is missing. */
  createComponentNode(spec: RuntimeNodeSpec, nodeId?: string): boolean {
    return this._createRuntimeNode(spec, nodeId) !== null;
  }

  /** {@link createComponentNode} returning the node itself (plan-681 `replaceRuntimeSubtree`). */
  private _createRuntimeNode(spec: RuntimeNodeSpec, nodeId?: string): Object3D | null {
    if (!this.registry || !this.signalStore || !this.transportManager) return null;
    // plan-769 Phase 2: `nodeId` = the node's runtime identity from its op's id map.
    return createRuntimeNode({
      registry: this.registry, signalStore: this.signalStore, scene: this.scene,
      transportManager: this.transportManager, gizmoManager: this.gizmoManager,
      lampManager: this.lampManager, sceneButtonManager: this.sceneButtonManager,
      webLabelManager: this.webLabelManager,
      energyChainManager: this.energyChainManager,
      chainManager: this.chainManager,
      ribbonManager: this.ribbonManager,
      machiningManager: this.machiningManager,
      collisionManager: this.collisionManager,
      dropManager: this.dropManager,
      errorStore: this.errorStore,
      instructionStore: this.instructionStore, outlineManager: this.outlineManager,
      highlighter: this.highlighter,
      reapply: this.signalReapply,
    }, spec, nodeId);
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
   * checker `repeat` keeps one square = `_groundSquareSize` (scale-derived,
   * plan-515 F10: 1-2-5 series ≈ min(0.5 m, maxDim / 10), 0.5 m without
   * content — independent of the authoring floor extent), and the reflector
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

    this._applyCheckerRepeat();

    // Keep the reflection mirror locked to the checker disc (same scale and
    // X/Z position; stays a hair below to avoid z-fighting).
    if (this._groundReflector) {
      this._groundReflector.mesh.scale.set(groundSize / 200, groundSize / 200, 1);
      this._groundReflector.mesh.position.set(center.x, -0.002, center.z);
    }

    this._renderDirty = true;
  }

  /** Metres per ground checker square (plan-515 F10; see {@link groundSquareSize}). */
  private _groundSquareSize = GROUND_SQUARE_DEFAULT;

  /** Metres per ground checker square — derived from the scene scale (plan-515 F10). */
  get groundSquareSize(): number { return this._groundSquareSize; }

  /** Checker texture repeat so one square is `_groundSquareSize` on the current disc. */
  private _applyCheckerRepeat(): void {
    if (!this._groundMesh) return;
    const TILES_PER_REPEAT = 8;  // tiles baked into the checker texture
    const metersPerRepeat = TILES_PER_REPEAT * this._groundSquareSize;
    const groundSize = this._groundMesh.scale.x * 200;
    const checkerMap = ((this._groundMesh as Mesh).material as MeshStandardMaterial).map;
    if (checkerMap) {
      checkerMap.repeat.set(groundSize / metersPerRepeat, groundSize / metersPerRepeat);
    }
  }

  /**
   * Scene scale changed (plan-515 F10): new checker square and — for content —
   * a shadow camera fitted to the new bounds. Runs inside `SceneScale.get()`
   * (frame loop), so only cheap writes + dirty flags.
   */
  private _onSceneScaleChanged(s: SceneScaleSnapshot): void {
    const square = groundSquareSize(s);
    if (square !== this._groundSquareSize) {
      this._groundSquareSize = square;
      this._applyCheckerRepeat();
      this._renderDirty = true;
    }
    // An empty scene keeps the shadow fit loadModel gave it (15 m playground).
    if (!s.empty) this._fitShadowCameraToScale(s.center, s.maxDim);
  }

  /** Reused record of {@link shadowCameraFor}. */
  private readonly _shadowFit: ShadowCameraFit = { pad: 0, near: 0, far: 0, sunDist: 0 };

  /**
   * Fit the directional light's shadow camera to content of `maxDim` around
   * `center` (plan-515 F10): pad = max(1.2·maxDim, 0.05), near =
   * max(maxDim/1000, 1e-4), far = max(4·maxDim, 0.5), sun 2·maxDim away.
   * Light direction matches the Unity realvirtual Sun prefab: euler
   * (72.82, -150.577, -106.188) → FROM direction (0.145, 0.955, -0.257).
   */
  private _fitShadowCameraToScale(center: Vector3, maxDim: number): void {
    const fit = shadowCameraFor(maxDim, this._shadowFit);
    this._shadowPadMax = fit.pad;
    this.dirLight.position.set(
      center.x + 0.145 * fit.sunDist,
      center.y + 0.955 * fit.sunDist,
      center.z + -0.257 * fit.sunDist,
    );
    this.dirLight.target.position.copy(center);
    this.dirLight.target.updateMatrixWorld();
    const sc = this.dirLight.shadow.camera;
    sc.left = -fit.pad;
    sc.right = fit.pad;
    sc.top = fit.pad;
    sc.bottom = -fit.pad;
    sc.near = fit.near;
    sc.far = fit.far;
    sc.updateProjectionMatrix();
    this._shadowsDirty = true;
  }

  /**
   * Registers the operator-window overlay (plan-543) once, the first time a
   * model carries a `WebOperatorPanel`. Dynamic import: the viewer core stays
   * React-free, a model without a panel never loads it.
   */
  private _ensureOperatorPanelUi(): void {
    if (this._operatorPanelUi) return;
    this._operatorPanelUi = import('./hmi/operator-devices/WebOperatorPanelHost')
      .then((m) => { this.uiRegistry.register(m.WEB_OPERATOR_PANEL_UI); })
      .catch((e) => {
        this._operatorPanelUi = null;
        console.warn('[RVViewer] operator panel overlay failed to load:', e);
      });
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
    // NOT `Box3.setFromObject`: that counts BatchedMesh arenas by their raw
    // buffer bbox (see _computeContentBounds).
    const box = this._computeContentBounds(this.currentModel);
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

  /**
   * The USER's ground setting (Visual tab, stored visual settings). No-op if ground was disabled
   * at construction. Whether the floor is actually drawn also depends on {@link suppressGround} —
   * see {@link groundVisible}.
   */
  get groundEnabled(): boolean {
    return this._groundMesh ? this._groundUserEnabled : false;
  }
  set groundEnabled(v: boolean) {
    if (!this._groundMesh) return;
    this._groundUserEnabled = v;
    this._syncGroundVisibility();
  }

  /** Whether the ground plane is drawn right now: user setting AND no plugin suppressing it. */
  get groundVisible(): boolean {
    return this._groundMesh?.visible ?? false;
  }

  /**
   * Hide the viewer's ground plane (and its mirror) on behalf of `owner`, independent of the
   * user's setting — for a model that brings its own floor (an aerial plate, a hall floor) where
   * the viewer's plane only z-fights with it. Re-applying the visual settings cannot undo it, the
   * user's setting is left untouched, and the floor returns once every owner has released it.
   * Owners are counted by name, so a plugin calls `suppressGround(name, false)` on dispose.
   */
  suppressGround(owner: string, on: boolean): void {
    if (on) this._groundSuppressors.add(owner);
    else this._groundSuppressors.delete(owner);
    this._syncGroundVisibility();
  }

  /** The one place ground + mirror visibility is decided (user setting, reflections, suppressors). */
  private _syncGroundVisibility(): void {
    const suppressed = this._groundSuppressors.size > 0;
    let changed = false;
    if (this._groundMesh) {
      const v = this._groundUserEnabled && !suppressed;
      if (this._groundMesh.visible !== v) { this._groundMesh.visible = v; changed = true; }
    }
    if (this._groundReflector) {
      const v = this._reflectionEnabled && !suppressed;
      if (this._groundReflector.mesh.visible !== v) { this._groundReflector.mesh.visible = v; changed = true; }
    }
    if (changed) this._renderDirty = true;
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
    if (this._reflectionEnabled === v) return;
    // Remembered even before a mirror exists: on the WebGPURenderer paths the
    // TSL mirror arrives after the settings were applied (plan-763).
    this._reflectionEnabled = v;
    if (!this._groundReflector) return;
    this._syncGroundVisibility();
    if (v) {
      // Push current strength/blur to the reflector on enable. The strength/blur
      // setters early-return when their value equals the field default, so this
      // guarantees the reflector matches viewer state even when it was never
      // changed away from the default.
      this._groundReflector.setStrength(this._reflectionStrength);
      this._groundReflector.setBlur(this._reflectionBlur);
    }
    this.applyReflectionBlend();
    this._renderDirty = true;
  }

  /** Register a mirror (either implementation) under the checker plane. */
  private _installGroundReflector(reflector: GroundReflector): void {
    const mesh = reflector.mesh;
    mesh.position.y = -0.002; // a hair below the checker to avoid z-fighting
    mesh.userData._rvGroundReflector = true;
    if (this._groundMesh) {
      mesh.scale.copy(this._groundMesh.scale);
      mesh.position.set(this._groundMesh.position.x, -0.002, this._groundMesh.position.z);
    }
    this.scene.add(mesh);
    this.sceneFixtures.add(mesh);
    this._groundReflector = reflector;
    if (this._reflectionEnabled) {
      mesh.visible = this._groundSuppressors.size === 0;
      reflector.setStrength(this._reflectionStrength);
      reflector.setBlur(this._reflectionBlur);
      this.applyReflectionBlend();
      this._renderDirty = true;
    }
  }

  /**
   * WebGPURenderer paths: create the TSL floor mirror once the TSL module is
   * loaded (the pre-warm runs after `create()`), then never again. Called from
   * the render loop; a no-op on WebGL, without a ground plane, or once done.
   */
  private _ensureGroundReflectorTsl(): void {
    if (this._groundReflector || !this.isWebGPU || !this._groundMesh) return;
    const tsl = getTslMaterials();
    if (!tsl) return;
    const info = this.renderer as unknown as { info: unknown };
    this._installGroundReflector(tsl.createGroundReflectorTsl(this._groundMesh, groundReflectorConstants(), {
      wrapPass: (run) => bookReflectionPass(info, run),
    }));
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
    if (this._groundReflector) this._groundReflector.setStrength(clamped);
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
    if (this._groundReflector) this._groundReflector.setBlur(clamped);
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
  cancelCameraAnimation(tag?: string): void {
    // No tag = cancel any animation (historical); a tag cancels only its own flight (plan-520).
    this._cameraManager.cancelCameraAnimation(tag);
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
   *    (e.g. conveyors re-assert `Run = true`). Then the LogicSteps restart
   *    (`logicEngine.start()`, every root from its first step — the same as
   *    after a load), so a sequence keeps running after the reset.
   *
   * Intentionally leaves untouched:
   * - **Signals** are NOT blanket-reset: that would fight Live mode (Unity / PLC
   *   stream) where the next tick overwrites them anyway. Instead each component
   *   re-establishes only the signals it OWNS in its `onReset` / `onStart`
   *   handler (e.g. a conveyor zeroes `PartCount`, re-asserts `Run`).
   * - **Pause state**: untouched. Reset can be invoked while paused or running.
   *
   * plan-538 F6 — the I/O contract, in this order:
   * 1. the outputs owned by the logic roots that are active for the current
   *    connection state go back to their GLB start value
   *    (`logicEngine.resetOwnedOutputs()`);
   * 2. component feedback is re-initialised from the plant state — sensors and
   *    zones right after the pre-placed MUs are back ({@link refreshPlantFeedback}),
   *    cylinders in their `simulation-start` handler;
   * 3. externally controlled signals (bound, forced, remote-owned) are never
   *    written by any of this;
   * 4. then the roots start, each only when active for the connection state.
   */
  resetSimulation(): void {
    // plan-681 §2.3: inside a structural transaction the reset is withheld and
    // performed ONCE by the close of the outermost transaction (the path-verb
    // resets of plan-453/628 end up here too).
    if (this._structuralEditHolds()) { this._seResetOwed = true; this.structuralEditStats.heldResets++; return; }
    // ── Phase 1: RESET ──────────────────────────────────────────────────────
    // Notify components FIRST so behavior FSMs / counters / bookkeeping are
    // restored before the engine drops the live MUs they may reference.
    this.emit('simulation-reset');

    this._simTime = 0; // Plan 201 (E2): restart the sim clock
    this.blockageWatch.reset(true);
    this._progressWiring?.reset();

    // Drives back to their authored start pose (position/speed/jog/running).
    // Conveyor (transport-surface) drives keep their belt jog so belts resume
    // running like a freshly-loaded scene — see RVDrive.reset().
    for (const drive of this.drives) drive.reset();

    // plan-733 F4: chain element poses follow the drives, so this MUST run after
    // the loop above. Deliberately not hooked to 'simulation-reset' — that event
    // is emitted at the top of this method, BEFORE the drives are reset, so a
    // chain reacting to it would re-pose from the stale drive position and stay
    // visibly offset until the next movement.
    this.chainManager.resetAll();
    // plan-459 F7: the web follows the drives for the same reason the chain
    // does — wound lengths, roll radii, roller angles and the texture offset are
    // all derived from drive state, so this must run after the loop above and
    // never from the 'simulation-reset' event.
    this.ribbonManager.resetAll();

    // Engine-level clear: live MUs, sensor occupancy, sources, grips, counters,
    // plus per-surface texture/transform accumulators.
    if (this.transportManager) this.transportManager.reset();
    if (this.logicEngine) {
      this.logicEngine.reset();
      // plan-538 F6 (1): root-owned outputs back to their GLB start values.
      this.logicEngine.resetOwnedOutputs?.();
    }
    // Plan 194 P1 (K3): also reset the kernel's active executor so the DES
    // runner clears its own state. No-op for the continuous runner beyond the
    // transportManager.reset() above (same target).
    this._kernel?.activeExecutor.reset();
    // plan-516 F4: the resets above put every pre-placed MU (and its loads) back
    // on its authored pose and parent WITHOUT activating it — they serve model
    // unload and mode switches too. The simulation reset is the one caller that
    // re-registers them, after the executor reset so nothing clears them again.
    // (A free function, not the private method: the reset is also pinned on
    // narrow fake viewers.)
    activatePreplacedMUs(this.transportManager, this.logicRunState, this._kernel?.mode ?? 'continuous');
    // plan-538 F6 (2): sensor / zone feedback from the plant state before the
    // logic restarts (cylinders re-initialise in their simulation-start handler).
    refreshPlantFeedback(this.transportManager);

    // ── Phase 2: RESETSTAT ──────────────────────────────────────────────────
    this.statisticsManager.resetAll(); // Plan 201: reset accumulators (registrations persist)
    this.emit('simulation-resetstat');

    // ── Phase 3: START ──────────────────────────────────────────────────────
    this.emit('simulation-start');

    // plan-502 (user decision 2026-09-26): restart the LogicSteps the reset
    // above put to Idle — every root from its first step, exactly as after a
    // load, so a demo sequence keeps running instead of staying dead until a
    // reload. After the start subscribers (components are in their start state
    // before the first step writes a signal), before the re-apply (live levels
    // still win). Only an engine that already ran: a reset must never start
    // logic a signature gate still holds.
    // plan-538 F1b: each root only when it is active for the current connection
    // state (`connectionState` is absent on the narrow fakes this is pinned on).
    if (this.logicEngine?.isStarted) {
      const state = (this as { connectionState?: 'Connected' | 'Disconnected' }).connectionState;
      this.logicEngine.start(state === undefined ? undefined : state === 'Connected');
    }

    // plan-427: put the PLC's CURRENT signal levels back onto the freshly reset
    // components. `drive.reset()` above wiped jog flags and speeds back to the
    // authored defaults, but the store is edge-driven — a level that was
    // already `true` before the reset would never fire again and the plant
    // would stay dead. Runs LAST on purpose: behaviors re-assert their own
    // levels inside the `simulation-start` handlers above, and where the two
    // overlap the live signal must win ("live signals always override local").
    this.signalReapply.reapplyAll();

    // plan-539 F8c: the reset moved drive nodes to their start pose, but a
    // carrying surface below a static (matrixAutoUpdate=false) baked node keeps
    // its stale world matrix until the next full scene update. Its first tick
    // would then read the reset jump as platform motion and carry the freshly
    // restored MUs by it (Lift01 reset mid-travel: a pallet floating 350 mm up).
    // One forced world-matrix update makes the post-reset baseline current.
    (this as { scene?: { updateMatrixWorld(force?: boolean): void } }).scene?.updateMatrixWorld(true);
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
   * Plan 632 — monotonic count of fixed steps (incremented once per
   * `fixedUpdate`, catch-up steps of one render frame included; never reset).
   * The continuous Agv fleet keys its shared per-step clock advance on it
   * (`BindContextHost.fixedStepCount`).
   */
  get fixedStepCount(): number {
    return this.simTickCount;
  }

  /**
   * Plan 194 P1 — lazily build (or return) the unified SimulationKernel,
   * reusing the viewer's EXISTING transportManager + behaviors. Returns null
   * when no transportManager/model is loaded yet.
   */
  /**
   * plan-516 sim start of the pre-placed MUs: register them (and resolve their
   * collider loads) with the transport manager — only with the logic active,
   * only in continuous mode (DES activation is plan-519) and never in a
   * multiuser client session (the plugin sets `preplacedActivationBlocked`).
   * Idempotent — the manager ignores a second call while they are active.
   */
  private _activatePreplacedMUs(): void {
    activatePreplacedMUs(this.transportManager, this.logicRunState, this._kernel?.mode ?? 'continuous');
  }

  /**
   * Hands the DES runner factory to the simulation (plan-652 Phase 3). Called by the
   * on-demand DES feature's body; a kernel that already exists gets it at once, a
   * later one is built with it. Idempotent.
   */
  setDesRunnerFactory(factory: DesRunnerFactory): void {
    if (this._desRunnerFactory === factory) return;
    this._desRunnerFactory = factory;
    this._kernel?.registerDesRunnerFactory(factory);
  }

  /**
   * Imports the DES runner module and registers its factory; resolves `true` when a
   * runner is available. A lazy fallback for callers that need a runner without
   * the feature activation (test viewers); the on-demand DES feature does not
   * need it. Dynamic on purpose: no DES code in the entry chunk (plan-652).
   */
  loadDesRunnerFactory(): Promise<boolean> {
    if (this._desRunnerFactory) return Promise.resolve(true);
    this._desRunnerImport ??= memoizeAsync(async () => {
      const mod = await import('../plugins/des/register-des-runner');
      this.setDesRunnerFactory(mod.createDesRunner);
      return this._desRunnerFactory !== null;
    });
    return this._desRunnerImport();
  }

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
    // plan-648 §2.4: the continuous kernel hands the vehicle ids over through the
    // Agv behaviour (the core does not import behaviours — the viewer wires them).
    runner.setTrafficHooks({ suspend: suspendContinuousAgvs, activate: activateContinuousAgvs });
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
      topology: {
        root: this.scene,
        host: this as unknown as BindContextHost,
        // plan-645 L4: the DES runner rebinds on its next start when this moved on.
        sceneGeneration: () => this._sceneGeneration,
      },
      // P5 wires the actual material-flow definitions in play; continuous
      // discovery already binds them via the BehaviorManager today.
      defs: [],
      // DES factory is `null` until the DES feature hands it over →
      // hasDesRunner() is false → the DES toggle stays hidden (P6).
      desRunnerFactory: this._desRunnerFactory,
      // Phase B: the DES runner composes the same CoreSubsystems pipeline so
      // drives/logic/visuals keep ticking at 60 Hz while the event queue runs.
      core: this._coreSubsystems,
      // Plan 194 P6: re-render the Sim mode-toggle UI on a successful switch.
      onModeChanged: (mode) => {
        // Reset-on-Switch dropped every MU of the outgoing executor: the progress sampler
        // and the blockage watch start over too, exactly as on resetSimulation(). Without
        // this the sampler kept the old MUs until its next sample, and a DES snapshot taken
        // right after continuous → DES threw "diag.blockage: sampled MU has no stable DES id".
        this.blockageWatch.reset(true);
        this._progressWiring?.reset();
        // plan-516: back in continuous mode is a sim start for the pre-placed
        // MUs (the switch's clearMUs put them back static).
        if (mode === 'continuous') this._activatePreplacedMUs();
        this.emit('simulation-mode-changed', { mode });
      },
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
    // …and once more when the references of a layout document have arrived:
    // they materialise AFTER `scene-loaded` (plan-753), so the bind above saw
    // none of their DES components. A plain reset() would NOT rediscover them
    // (the runner discovers only while it has no instances); `rebindScene()`
    // drops the scene-discovered instances and binds the scene anew
    // (plan-612 CP1d-b). The user's reset button stays `reset()`.
    // plan-645 L4: every placed / removed layout content moves the scene
    // generation on - also while a load materialises and in continuous mode (c7:
    // the next DES start then rebinds). `placements-materialized` rebinds a DES
    // run only when the runner has not served the current generation yet, so a
    // repeated completion event rebinds once and an aborted load not at all.
    //
    // plan-687: `placements-materialized` fires ONCE PER LOAD (`sealLoad` →
    // `_loadOpen`), so layout content that lands AFTER the load while the
    // instancer materialises — a runtime placement via `materializeDeferred`
    // (MCP, plugin), the nested references of a planner drop — would raise the
    // generation and never be bound until the next reset (681 spike, A4).
    // Such a skip therefore records a DEBT (`_desRebindDue`) that the
    // instancer's transition to `idle` redeems through the SAME coalescing
    // funnel. Order inside `_notifyIdle` (rv-placement-instancer.ts): first
    // `_publishState()` (→ `placements-state-changed`, which only SCHEDULES a
    // microtask), then `_settleIfIdle()` (→ `placements-materialized`, which
    // rebinds synchronously and cancels the job) — so a load binds once, and
    // even if that order ever changed the `served >= target` check keeps it at
    // one. Rebinds can be withheld (plan-681 `structuralEdit`) at all THREE
    // places a rebind can originate: this handler, the scheduling in
    // `_scheduleDesRebind` and the scheduled microtask — each turns a withheld
    // rebind into the one debt, which `_takeDesRebindDue()` hands over.
    // Registered ONCE per viewer (a kernel is built per model; the handlers read `_kernel`).
    if (!this._desSceneGenWired) {
    this._desSceneGenWired = true;
    this.on('placements-materialized', (info) => {
      if (info.aborted || info.materialized <= 0) return;
      const k = this._kernel;
      if (k?.mode !== 'des') return;
      // plan-687 (a): withheld → the debt, redeemed by the transaction's close.
      if (this._desRebindHeld()) { this._desRebindDue = true; return; }
      const served = desBoundSceneGeneration(k);
      // NOTE: the exact spelling of the next line is pinned by
      // `tests/scene-ready-contract.test.ts` ("source pins"). A debt that
      // survives here is harmless — every delivery re-checks `served >= target`.
      if (served !== null && served === this._sceneGeneration) return;
      this._desRebindDue = false;
      this._cancelDesRebind();
      k.rebindScene();
    });
    // plan-645 L5 (ii): a planner drop / delete in DES -> ONE coalesced rebind
    // (during a load the settle above covers it).
    const onLayoutContent = (): void => {
      this._sceneGeneration++;
      // plan-687: owed until the instancer is idle — during a LOAD the settle
      // above redeems it, after the load the idle listener below does.
      if (this.placements.state === 'materializing') { this._desRebindDue = true; return; }
      this._scheduleDesRebind();
    };
    this.on('layout-content-added', onLayoutContent);
    this.on('layout-content-removed', onLayoutContent);
    // plan-687: redeem the debt when the instancer falls idle again.
    this.on('placements-state-changed', ({ state }) => {
      if (state !== 'idle' || !this._desRebindDue) return;
      // Withheld (plan-681): leave the debt standing — the close takes it over.
      if (this._desRebindHeld()) return;
      this._desRebindDue = false;
      // `total === 0` = the document was dropped (`clearDocument` zeroes the
      // counters before this idle): the debt belonged to a scene that is gone.
      // Same reading as `installPlacementsSimHold` (rv-scene-ready.ts).
      if (this.placements.progress.total === 0) return;
      this._scheduleDesRebind();
    });
    // plan-687 (F5, belt and braces): a kernel built after `model-cleared` must
    // not inherit an old debt or job — `_scheduleDesRebind` checks the kernel
    // identity anyway, this drops the state outright.
    this.on('model-cleared', () => { this._desRebindDue = false; this._cancelDesRebind(); });
    }
    return this._kernel;
  }

  // ─── DES scene generation (plan-645 L4 / L5) ──────────────────────
  private _sceneGeneration = 0;
  private _desSceneGenWired = false;
  private _desRebindPending: { kernel: SimulationKernel; target: number } | null = null;
  /**
   * plan-687: a rebind is OWED — layout content changed while the placement
   * instancer materialised, or while rebinds were withheld. Redeemed at the
   * next `idle` of the instancer (when not withheld), or taken over by the
   * close of a plan-681 `structuralEdit` via {@link _takeDesRebindDue}.
   */
  private _desRebindDue = false;

  /**
   * plan-687 → plan-681: true while a structural transaction withholds rebinds.
   * Constant `false` until plan-681 Phase 3 replaces the body with its depth
   * counter — ONE predicate for all three origins of a rebind, so 681 does not
   * have to find them again.
   */
  private _desRebindHeld(): boolean { return this._structuralEditHolds(); }

  /**
   * True while a structural transaction is open ON THE CURRENT DOCUMENT. A
   * transaction left open on a replaced document (its owner still awaiting)
   * holds nothing of the new one — neither its rebinds nor its resets (Codex
   * review #2).
   */
  private _structuralEditHolds(): boolean {
    const doc = this._seDocument;
    return this._seDepth > 0 && !!doc && doc.load === this._loadGeneration && doc.model === this.currentModel;
  }

  /**
   * plan-687 → plan-681: read-and-clear the owed rebind, cancelling a waiting
   * job (which the caller then owns). Nothing in plan-687 calls this but the
   * tests; plan-681 calls it when opening and when closing the outermost
   * `structuralEdit` and settles it against its own "rebind due" so the
   * transaction performs EXACTLY one.
   */
  private _takeDesRebindDue(): boolean {
    const due = this._desRebindDue || this._desRebindPending !== null;
    this._desRebindDue = false;
    this._cancelDesRebind();
    return due;
  }

  /** Scene generation of the material-flow content (plan-645 L4; diagnostics / tests). */
  get sceneGeneration(): number { return this._sceneGeneration; }

  // ─── Structural transaction (plan-681 §2.3) ───────────────────────
  //
  // A plant that changes its STRUCTURE (the PalletYard size) does it in one
  // transaction: placements are added and removed, the generated path graph is
  // replaced, and only when everything is in place does the simulation restart
  // ONCE. While the transaction is open it withholds every automatic restart:
  // the plan-645 auto-rebind (all three origins funnel through
  // `_desRebindHeld()`), and `resetSimulation()` itself — which is where the
  // path-verb resets end up too. Closing the outermost transaction performs
  // exactly one `resetSimulation()` (with a raised scene generation when content
  // or paths changed, so the DES runner rebinds exactly once). Spike 2026-10-25
  // (plan-681 §Spike-Ergebnis): S2/S4 — one rebind, no `bound` before the close.

  /** Depth of open {@link structuralEdit} calls (nestable). */
  private _seDepth = 0;
  /** A rebind is owed when the outermost transaction closes. */
  private _seRebindOwed = false;
  /** A `resetSimulation()` was withheld. */
  private _seResetOwed = false;
  /** The document the outermost transaction was opened on — no flush onto another one. */
  private _seDocument: { load: number; model: Object3D | null; generation: number } | null = null;
  /** The path objects at the opening — register/unregister of the network notify nobody. */
  private _sePathsAtOpen: readonly RVPath[] | null = null;
  /** Diagnostics: what transactions withheld and flushed (tests, `web_status`). */
  readonly structuralEditStats = { opened: 0, heldResets: 0, flushes: 0, flushedRebinds: 0, droppedOnDocumentChange: 0 };

  /** True while a {@link structuralEdit} transaction is open. */
  get inStructuralEdit(): boolean { return this._seDepth > 0; }

  /**
   * Run `fn` as ONE structural change (plan-681 §2.3). Nestable; only the
   * outermost close flushes. Withholds the plan-645 auto-rebind and every
   * `resetSimulation()` while open; on the close of the outermost transaction —
   * also when `fn` throws — follows at most ONE `resetSimulation()`, preceded by
   * a raised scene generation when placements or paths changed. Bound to the
   * document it was opened on: when that document was replaced meanwhile,
   * nothing is flushed (the new load binds itself). A withholding mechanism,
   * not an undo — a thrown `fn` leaves whatever it already changed (the owner
   * restores its previous structure INSIDE the transaction, plan-681 A3).
   */
  async structuralEdit<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this._seDepth === 0) {
      // Rebind race (Gate-R1 #3): a rebind already scheduled or owed before the
      // opening is taken over here and performed by the close.
      this._seRebindOwed = this._takeDesRebindDue();
      this._seResetOwed = false;
      this._seDocument = { load: this._loadGeneration, model: this.currentModel, generation: this._sceneGeneration };
      this._sePathsAtOpen = getDefaultPathNetwork().all().slice();
      this.structuralEditStats.opened++;
    }
    this._seDepth++;
    try {
      return await fn();
    } finally {
      this._seDepth--;
      if (this._seDepth === 0) this._closeStructuralEdit();
    }
  }

  /** The close of the outermost transaction: settle the debts, then at most one reset. */
  private _closeStructuralEdit(): void {
    const doc = this._seDocument;
    const before = this._sePathsAtOpen;
    this._seDocument = null;
    this._sePathsAtOpen = null;
    const reset = this._seResetOwed;
    const owed = this._seRebindOwed;
    this._seRebindOwed = false;
    this._seResetOwed = false;
    const sameDocument = !!doc && doc.load === this._loadGeneration && doc.model === this.currentModel;
    // Another document: its own load binds itself, and a rebind debt that arose
    // meanwhile is THAT document's — left standing, never consumed here (Codex
    // review #2: the old close must not swallow the new document's rebind).
    if (!sameDocument) { this.structuralEditStats.droppedOnDocumentChange++; return; }
    // Content placed / removed in the transaction moved the generation — in any
    // kernel mode (Codex review #4: `_scheduleDesRebind` records no debt outside DES).
    let rebind = this._takeDesRebindDue() || owed || this._sceneGeneration !== doc.generation;
    if (!rebind && before) {
      const now = getDefaultPathNetwork().all();
      if (now.length !== before.length || now.some((p, i) => p !== before[i])) rebind = true;
    }
    if (!rebind && !reset) return;
    this.structuralEditStats.flushes++;
    if (rebind) {
      // The DES runner's start() sees a generation it has not served → exactly
      // one rebindScene (one `reset` + one `bound`). Continuous: one reset.
      this._sceneGeneration++;
      this.structuralEditStats.flushedRebinds++;
    }
    this.resetSimulation();
  }

  /**
   * Replace the nodes marked `Generated.owner === owner` (plan-681 §2.2 step 2,
   * A2) by runtime nodes built from `specs`, in order (a spec's `parentPath` may
   * name a node an earlier spec created). Only inside {@link structuralEdit} —
   * outside it throws `structural-edit-required`. No op log, no undo, never
   * saved: the document keeps its source nodes.
   *
   * - `under` scopes the search (default: the whole model); unmarked nodes —
   *   blocks an author placed next to the generated ones — stay where they are.
   * - Every created node carries `Generated: { owner }`, so the next call finds it.
   * - A marked subtree with an UNMARKED authored descendant (an author's node
   *   hung below a generated one) is refused BEFORE anything is removed
   *   (`structural-unmarked-descendant: <path>`) — never silently deleted.
   * - Removal goes through the one primitive `disposeLoadedSubtree` (shared with
   *   plan-628 8.7); the path graph is resolved again afterwards.
   */
  replaceRuntimeSubtree(owner: string, specs: readonly RuntimeNodeSpec[], opts?: { under?: string }): ReplaceRuntimeSubtreeResult {
    if (!this._structuralEditHolds()) throw new Error('structural-edit-required');
    const registry = this.registry;
    const model = this.currentModel;
    if (!registry || !model) throw new Error('structural-no-scene');
    const scope = opts?.under ? registry.getNode(opts.under) : model;
    if (!scope) throw new Error(`structural-scope-missing: ${opts?.under}`);
    const tops: Object3D[] = [];
    const walk = (n: Object3D): void => {
      for (const c of n.children) {
        if (generatedOwnerOf(c) === owner) tops.push(c); else walk(c);
      }
    };
    walk(scope);
    for (const top of tops) {
      top.traverse((d) => {
        if (d === top || generatedOwnerOf(d) === owner) return;
        const rv = d.userData?.realvirtual as Record<string, unknown> | undefined;
        if (rv && typeof rv === 'object' && Object.keys(rv).length > 0) {
          throw new Error(`structural-unmarked-descendant: ${registry.getPathForNode(d) ?? d.name}`);
        }
      });
    }
    for (const top of tops) disposeLoadedSubtree(registry, top);
    const created: Object3D[] = [];
    const failed: string[] = [];
    // Rebuilt components need stable identities (including their DES RNG streams).
    // Keep runtime seeds separate from authored paths and reserve surviving ids.
    const usedIds = new Set<string>();
    model.traverse(n => { const id = identityIdOf(n); if (id) usedIds.add(id); });
    const runtimeNamespace = uuidV5(RV_NODE_ID_NAMESPACE, 'runtime-subtree');
    for (const spec of specs) {
      const key = JSON.stringify([owner, spec.parentPath, spec.name]);
      // An explicit spec.nodeId (e.g. PalletYard 'palletyard-downtime-<name>') wins; otherwise a
      // deterministic uuidV5 seed of owner/parent/name. Both are stable across rebuilds.
      let id = spec.nodeId ?? '';
      if (!id) {
        let suffix = 0;
        id = uuidV5(runtimeNamespace, key);
        while (usedIds.has(id)) id = uuidV5(runtimeNamespace, JSON.stringify([key, ++suffix]));
      }
      usedIds.add(id);
      const node = this._createRuntimeNode({
        ...spec,
        components: { ...spec.components, Generated: { owner } },
      }, id);
      if (node) created.push(node); else failed.push(`${spec.parentPath}/${spec.name}`);
    }
    getDefaultPathNetwork().resolveGraph();
    if (tops.length > 0 || created.length > 0) this._seRebindOwed = true;
    this.markRenderDirty();
    return { removed: tops.length, created: created.length, failed, nodes: created };
  }

  /**
   * Placements inside a structural transaction (plan-681 §2.2 step 3, §2.3):
   * `place` puts an empty reference node under `parentPath` and materialises it
   * through the viewer's instancer (the same path a loaded reference takes),
   * resolving with the node once the instancer is idle — success is checked by
   * the OWNER per id (`placements.instanceOf(node)`), never from the counters
   * (A1). `removePlacement` is the core clean-up of a placement root
   * ({@link disposePlacedRoot}) — no planner needed. Both only inside
   * {@link structuralEdit} (else `structural-edit-required`).
   */
  readonly structural = {
    place: (spec: StructuralPlacementSpec): Promise<Object3D> => {
      if (!this._structuralEditHolds()) return Promise.reject(new Error('structural-edit-required'));
      const parent = this.registry?.getNode(spec.parentPath) ?? null;
      if (!parent) return Promise.reject(new Error(`structural-parent-missing: ${spec.parentPath}`));
      const node = new Object3D();
      node.name = spec.name;
      node.position.fromArray(spec.position);
      node.quaternion.fromArray(spec.quaternion);
      if (spec.scale) node.scale.fromArray(spec.scale);
      const rv: Record<string, unknown> = {
        ...(spec.extras ? JSON.parse(JSON.stringify(spec.extras)) as Record<string, unknown> : {}),
        NodeId: spec.nodeId,
        AssetReference: { assetId: spec.assetRef.assetId, path: spec.assetRef.path },
      };
      canonicalizeAssetOverridesIn(rv);
      node.userData.realvirtual = rv;
      parent.add(node);
      node.updateMatrixWorld(true);
      markDeferredPlacement(node, spec.nodeId, spec.assetRef.path);
      this.placements.materializeDeferred(collectDeferredPlacements(node));
      return this.placements.whenMaterialized().then(() => node);
    },
    removePlacement: (root: Object3D): void => {
      if (!this._structuralEditHolds()) throw new Error('structural-edit-required');
      disposePlacedRoot(this, root);
      this.markRenderDirty();
    },
  };

  /**
   * Coalesce layout changes in DES into ONE rebind (plan-645 L5). Flushed after
   * the synchronous burst (microtask — works while the sim is paused, too). At
   * the flush the job is dropped unless: same kernel, mode `des`, the runner has
   * not served the target generation yet, and no snapshot restore runs.
   * Semantics like an explicit `rebindScene()`: FastForward stops, the run
   * restarts at t = 0 (same as the path verbs of plan-453).
   */
  private _scheduleDesRebind(): void {
    const k = this._kernel;
    if (!k || k.mode !== 'des') return;
    // plan-687 (b): withheld → no job at all, the debt carries the intent.
    if (this._desRebindHeld()) { this._desRebindDue = true; return; }
    const target = this._sceneGeneration;
    if (this._desRebindPending) { this._desRebindPending.target = target; return; }
    const job = { kernel: k, target };
    this._desRebindPending = job;
    queueMicrotask(() => {
      if (this._desRebindPending !== job) return;
      // plan-687 (c): withheld since the job was scheduled, or a
      // materialisation started in the same synchronous block (binding now
      // would bind an interim scene and need a second rebind at the idle) →
      // the debt waits for the idle / the transaction's close.
      if (this._desRebindHeld() || this.placements.state === 'materializing') {
        this._desRebindPending = null;
        this._desRebindDue = true;
        return;
      }
      this._desRebindPending = null;
      if (this._kernel !== job.kernel || job.kernel.mode !== 'des' || isDesRestoring()) return;
      const served = desBoundSceneGeneration(job.kernel);
      if (served !== null && served >= job.target) return;
      this._desRebindDue = false;
      job.kernel.rebindScene();
    });
  }

  private _cancelDesRebind(): void {
    this._desRebindPending = null;
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

  // #region DriveLifecycle
  // ─── Drive lifecycle primitive (plan-411 Phase 1) ─────────────────────────
  //
  // `drives` is the SIM-LOOP tick list (CoreSubsystems.drives iterates it every
  // fixed step). A drive created at runtime — the asset editor's `addComponent
  // Drive` — is useless until it is IN this array, and a removed one must leave
  // it again or it keeps ticking as a ghost (and reappears twice on redo).
  //
  // Membership therefore has exactly ONE mutation point for the runtime path:
  // these two methods. They keep the registry-independent derived state
  // (`filteredDrives`) consistent and announce the change, so the consumers
  // that hold their own view of the collection can re-derive it. The BULK model
  // load stays as it is (`this.drives = result.drives` + `model-loaded`) — it
  // replaces the whole array once and every consumer already handles that event.

  /** Add a drive to the sim-loop tick list. Idempotent: a drive already in the
   *  list is not added twice (redo after undo must not duplicate it).
   *  @returns true when the collection actually changed. */
  addDrive(drive: RVDrive): boolean {
    if (this.drives.includes(drive)) return false;
    this.drives.push(drive);
    this._onDrivesChanged(drive, null);
    return true;
  }

  /** Remove a drive from the sim-loop tick list. No-op when it is not a member.
   *  @returns true when the collection actually changed. */
  removeDrive(drive: RVDrive): boolean {
    const index = this.drives.indexOf(drive);
    if (index < 0) return false;
    this.drives.splice(index, 1);
    // Editor delete / undo of an add: the drive leaves the scene here and
    // clearModel() will never see it again, so its solver context is freed now.
    drive.dispose();
    if (this.focusedDrive === drive) this.clearFocus();
    this._onDrivesChanged(null, drive);
    return true;
  }

  /** Re-derive the filtered subset and announce the collection change. */
  private _onDrivesChanged(added: RVDrive | null, removed: RVDrive | null): void {
    // `filteredDrives` is derived from `drives`; a removed drive must not stay
    // in it (it would keep a disposed instance alive in the drive chart).
    if (this._filteredDrives.length > 0) {
      this._filteredDrives = this._filteredDrives.filter((d) => this.drives.includes(d));
    }
    this.emit('drives-changed', { drives: this.drives, added, removed });
    this.markRenderDirty();
  }
  // #endregion DriveLifecycle

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
  loadModelWithProgress: ((url: string, options?: {
    overlay?: RVExtrasOverlay;
    /** Stable identity of the model these bytes ARE — see {@link loadModel}. */
    identityUrl?: string;
    /** Bytes the caller already holds; `url` is then only their name. */
    data?: ArrayBuffer;
    /** The scene carries edits — see {@link loadModel}. */
    editedScene?: boolean;
    /** plan-769 Phase 7 — see {@link loadModel}. */
    baselinePlacements?: BaselinePlacementEdits;
  }) => Promise<ModelLoadOutcome>) | null = null;

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

  // --- Post-processing (composer on WebGL, TSL pipeline on WebGPU) ---
  // All composer / GTAO / N8AO / Bloom / desat / isolate-overlay state now
  // lives in `_postProcessing` (see PostProcessingManager). The viewer keeps
  // proxy getters/setters below so the 71 external consumers of RVViewer
  // continue to work unchanged. `_composer` and `_ensureComposer` stay as
  // accessors here too because RVOutlineManager talks to them directly
  // (matches the OutlineHostViewer interface contract).
  private _postProcessing!: PostProcessingManager;
  /** @internal — exposed to RVOutlineManager so it can insert OutlinePass. */
  get _composer(): EffectComposer | null { return this._postProcessing.composer; }

  // --- Toon (cel) render mode ---
  // Owns the Std→Toon material swap and the screen-space Sobel outline. Inert
  // unless the active render mode is 'toon'. See RVToonMaterialManager.
  private _toon!: RVToonMaterialManager;

  // --- Wireframe view (asset editor) ---
  // An in-memory view toggle, never persisted and never part of the render
  // mode. It draws only while editor mode is active. See RVWireframeView.
  private readonly _wireframeView = new RVWireframeView();
  private _wireframeOn = false;
  /** True while the toggle is on AND editor mode is active (what the frame reads). */
  private _wireframeApplied = false;
  /** What shadows / AO / reflection were before the view switched them off. */
  private _wireframeSaved: { shadow: boolean; ao: AOMode; reflection: boolean } | null = null;
  private readonly _isSceneFixture = (node: Object3D): boolean => this.sceneFixtures.has(node);

  /** Diagnostic GPU info — populated synchronously at construction with the
   *  active adapter, then asynchronously merged with high-perf / low-power
   *  probes a tick later (best-effort, see rv-gpu-info.ts). Read via
   *  `getGPUInfo()`; consumers poll. */
  private _gpuInfo: GPUInfo | null = null;

  private constructor(
    container: HTMLElement,
    renderer: Renderer,
    options: RVViewerOptions = {},
  ) {
    super();

    // plan-647 D1: the Agv diagnostics belong to the traffic world but live in
    // the behaviour, which the engine must not import — register them with the
    // one reset point (a Set: several viewers register once).
    onTrafficRegistriesReset(resetMergeEntryCheckStats);
    onTrafficRegistriesReset(resetAgvFleetStepDiagnostics);

    // plan-652 Phase 3: synchronous component builds report a type of a not-yet-active
    // on-demand feature (DES) here. Module-global — the last viewer created owns it.
    this._deferredComponentHandler = this.features.deferredComponentHandler();
    setDeferredComponentHandler(this._deferredComponentHandler);

    // plan-539 F15: the Simulation / PLC toggle next to the simulation controls
    // (Viewer + Commissioning workspaces). Loaded lazily so the engine stays
    // free of React; the slot appears once the module is in.
    void import('./hmi/ConnectionModeToggle').then(({ CONNECTION_MODE_UI }) => {
      this.uiRegistry.register(CONNECTION_MODE_UI);
    }).catch((e) => console.warn('[RVViewer] Simulation / PLC toggle unavailable:', e));

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
    this.highlighter.setChunkSource(this.bakeRegistry);
    // plan-756 F6: the same registry answers BOUNDS for a node whose triangles
    // were merged into an ancestor's chunk (camera focus, isolate, node bounds,
    // selection gizmos) — without it such a node reports a 0.1 m cube.
    setChunkBoundsSource(this.bakeRegistry);
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
      // plan-763 Phase 4: wrap the TSL pipeline's pass nodes for the per-pass
      // frame stats at the end of every graph build.
      onTslPassesBuilt(passes) {
        instrumentTslPasses(passes, ppSelf.renderer.info as unknown as RenderInfoLike, ppSelf._frame);
      },
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
    // Ray traced render mode lifecycle (plan-762 F7). The backend is built on a
    // complete scene only: `model-cleared` drops it (the mode stays), the next
    // `placements-materialized` — not `model-loaded`, which fires while the
    // placements still arrive — builds it again.
    this._raytraced = this._createRaytracedController();
    this.on('model-cleared', () => this._raytraced.onModelCleared());
    this.on('placements-materialized', () => this._raytraced.onSceneReady());
    // A model loaded while toon mode is already active must be converted (its
    // materials swapped to the banded toon material) once it is fully built.
    this.on('model-loaded', () => {
      if (this._toon.isActive && this.currentModel) this._toon.convert(this.currentModel);
    });
    // plan-543: operator panels carried by the model (WebOperatorPanel).
    this.on('model-loaded', () => this.webOperatorPanels.reset());
    this.on('layout-content-added', () => this.webOperatorPanels.requestRescan());
    this.on('layout-content-removed', () => this.webOperatorPanels.requestRescan());
    this.on('component-field-changed', (e) => {
      if (e.componentType.startsWith('WebOperatorPanel')) this.webOperatorPanels.requestRescan();
    });
    this.webOperatorPanels.subscribe(() => {
      if (this.webOperatorPanels.entries.length > 0) this._ensureOperatorPanelUi();
    });
    // plan-566: the signal usage index is invalidated (never rebuilt) by every
    // structural change; the next reader rebuilds it once.
    installCoreSignalUsageProviders(this.signalUsage, this);
    // plan-675 Phase 3: animated roller mantles — bound per placement / main model,
    // released with the bake registry instance.
    installRollerSpin(this as unknown as RollerSpinHost);
    const invalidateUsages = (): void => this.signalUsage.invalidate();
    this.on('model-loaded', invalidateUsages);
    this.on('placements-materialized', invalidateUsages);
    this.on('layout-content-added', invalidateUsages);
    this.on('layout-content-removed', invalidateUsages);
    // plan-769 F13 / §2.3 rule 3: `occurrence-registered` — a placement's content
    // (ids registered before its init, components built) is announced; references
    // waiting for it resolve now. The orphan verdict falls once no placement is
    // pending any more (`placements-materialized` with pending 0).
    this.on('layout-content-added', () => { this.registry?.flushPendingRefs(); });
    this.on('placements-materialized', (info) => {
      if (this.placements.progress.pending === 0) this.registry?.settlePendingRefs();
      // plan-769 Phase 6: a non-aborted settle belongs to the current load.
      if (!info.aborted) this._placementsSettledLoad = this._loadGeneration;
    });
    this.on('editor-structure-changed', invalidateUsages);
    this.on('component-field-changed', invalidateUsages);
    this.on('component-reloaded', invalidateUsages);
    this.on('model-cleared', () => this.signalUsage.clear());
    this.webOperatorPanels.subscribe(invalidateUsages);
    // plan-610 F9: stored node references → Problems (unresolved / rescued).
    this._installReferenceAudit();
    // plan-774 F6: a written document is no longer what the cache baked from it
    // — its decoded master and bakes (kept ones included) are retired, so a
    // Back after a descend-save, or the next placement, bakes the new bytes.
    this.on('document-saved', ({ documentId, relPath }) => {
      this.placements.invalidateDocument({ documentId, relPath });
    });
    // plan-633 F8: path successors vs. path ends → Problems, after whenSceneReady().
    this._uninstallPathTopologyCheck = this.pathTopologyCheck.install();
    // Grow the checker floor to keep placed / dragged layout content on a
    // visible disc. Both events parent their objects under the model root, so
    // a re-fit (grow-only, coalesced to one per frame) tracks the live bounds.
    this.on('layout-transform-update', () => this._queueGroundFit());
    this.on('layout-drag-end', () => this._queueGroundFit());
    // Reloaded references arrive after `model-loaded` (plan-753): grow the disc
    // to the complete layout and re-frame it when the camera was left alone.
    // The drives of those references joined the tick list one placement at a
    // time, unannounced — ONE `drives-changed` now re-sorts Gear/CAM order,
    // re-seeds the recorder and refreshes the React drive list.
    this.on('placements-materialized', (info) => {
      if (info.materialized === 0) return;
      this._queueGroundFit();
      this._onDrivesChanged(null, null);
    });
    installPlacementsRefit(this);
    installPlacementsSimHold(this, logInfo);
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
    this.axisDiagnostics = new AxisDiagnosticsManager(() => this.signalStore);
    this.webLabelManager = new WebLabelManager();
    {
      // plan-529 SOL R2-2: a Plate link is occluded by the first OPAQUE surface
      // under the pointer — a stateless query on raycastSurface (the normal pick
      // yields no distance and null for an owner-less opaque chunk).
      const surfaceHit: SurfaceHit = { point: new Vector3(), distance: 0, blocked: false, path: null };
      const labelViewer = this;
      const LABEL_PIN_DOWN = new Vector3(0, -1, 0);
      const pinHit = { point: new Vector3(), distance: 0 };
      this.webLabelManager.bindHost({
        getCamera: () => labelViewer.camera,
        getCanvas: () => labelViewer.renderer.domElement as HTMLCanvasElement,
        occlusion: (x, y) => {
          const rm = labelViewer.raycastManager;
          if (!rm) return Infinity;
          return rm.raycastSurface(x, y, surfaceHit) ? surfaceHit.distance : Infinity;
        },
        // Labels are pick targets of their node: hover = hover the object,
        // click = select it (the RaycastManager is created later; resolve lazily).
        pick: {
          addAuxRaycastTarget: (mesh, owner, opts) => labelViewer.raycastManager?.addAuxRaycastTarget(mesh, owner, opts),
          removeAuxRaycastTarget: (mesh) => labelViewer.raycastManager?.removeAuxRaycastTarget(mesh),
        },
        // Hover / selection feedback on the label: border + pin in the
        // highlight channel's colour. The pin cast asks the same surface query
        // the navigation uses, straight down, and accepts only a hit on the
        // label's own node (self or descendant).
        emphasis: {
          getHoveredNode: () => labelViewer.raycastManager?.hoveredNode ?? null,
          isSelected: (node) => labelViewer.selectionManager.isNodeSelected(node),
          colors: () => ({
            hover: labelViewer.highlighter.getHoverStyle().edgeColor,
            selection: labelViewer.highlighter.getSelectionStyle().edgeColor,
          }),
          castDown: (origin, node, out) => {
            const rm = labelViewer.raycastManager;
            if (!rm) return false;
            // ANY hit on the node along the way counts, not only the first
            // surface — the pin reaches the object past whatever is in between.
            if (!rm.raycastNodeAlong(origin, LABEL_PIN_DOWN, node, pinHit)) return false;
            out.copy(pinHit.point);
            return true;
          },
          getScene: () => labelViewer.scene,
        },
      });
    }
    this.sceneButtonManager = new SceneButtonManager();
    this.energyChainManager = new EnergyChainManager();
    this.chainManager = new ChainManager();
    this.ribbonManager = new RibbonManager(this.errorStore);
    const thisViewer = this;
    this.ribbonEditorPreview = new RibbonEditorPreview({
      ribbonManager: this.ribbonManager,
      get activeMode() { return thisViewer.modes.activeMode; },
      get camera() { return thisViewer.camera; },
      markRenderDirty: () => this.markRenderDirty(),
      markShadowsDirty: () => this.markShadowsDirty(),
    });
    // plan-459 F8: winder feedback (diameter, wound length, empty, full) goes
    // through ONE viewer-owned writer identity, like every other component that
    // drives PLC inputs.
    this.ribbonManager.setSignalWriter((address, value) => {
      this.signalStore?.setByPath(address, value);
    });
    this.on('mode-changed', (event) => this.ribbonEditorPreview.onModeChanged(event));
    this.on('component-field-changed', () => this.ribbonEditorPreview.notifyDefinitionChanged());
    this.on('layout-drag-tick', () => this.ribbonEditorPreview.notifyDefinitionChanged());
    this.on('editor-structure-changed', () => this.ribbonEditorPreview.notifyDefinitionChanged(true));
    this.machiningManager = new MachiningManager();
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
    // plan-2022: an unsupported part gets the SAME warning-orange status
    // silhouette as a collision — it is the same statement to the user ("look
    // here, something is wrong") and the card says which. Same style means the
    // claim register unions the two instead of one erasing the other (Phase 0).
    this.dropManager = new RVDropManager();
    this.dropManager.setHighlightHost({
      showDrops: (roots) => showStatusOutline(this, roots, 0xffa726,
        { ownerKey: 'drop', pulsePeriod: 0.6 }),
      hideDrops: () => hideStatusOutline(this, 'drop'),
    });
    // plan-409: machining reports which cutter is legitimately inside which
    // workpiece, so that pair goes quiet while the spindle runs — and only that
    // pair. Wired here, in the constructor, because both managers live for the
    // whole viewer; a model change clears the associations, not the wiring.
    this.machiningManager.setCollisionBridge(this.collisionManager);
    // plan-427: publish the re-apply registry for the ComponentContext
    // producers that are called positionally from outside the viewer
    // (`processExtras` — Layout Planner, asset editor). Same module-slot
    // rationale as `setKinematicManager`; cleared in dispose().
    setActiveSignalReapplyRegistry(this.signalReapply);
    setActiveStatsRegistry(this.componentStats);
    // Second re-apply trigger (the first is `resetSimulation()`): once an
    // interface has COMMITTED its first incoming snapshot after a (re)connect,
    // push those levels onto the components. Anchored on the commit and not on
    // `'connection-state-changed'` — that fires before signal discovery, so a
    // re-apply there would write pre-disconnect values back onto the plant.
    this.on('interface-signals-synced', () => { this.signalReapply.reapplyAll(); });
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
    // The AI agent's camera-body gizmo (plan-740 D-A4). Only the two VIEWPORT
    // cameras enable it — the AO clone, the analyzer and the agent's own
    // offscreen camera all drop it again through disableOverlayLayers, so the
    // agent never photographs its own eye.
    this.perspCamera.layers.enable(AGENT_EYE_LAYER);

    const frustumHalf = 5;
    this.orthoCamera = new OrthographicCamera(
      -frustumHalf * aspect, frustumHalf * aspect, frustumHalf, -frustumHalf, 0.01, 1000,
    );
    this.orthoCamera.position.set(3, 2.5, 4);
    this.orthoCamera.lookAt(0, 0.5, 0);
    this.orthoCamera.layers.enable(HIGHLIGHT_OVERLAY_LAYER);
    this.orthoCamera.layers.enable(NO_AO_LAYER);
    this.orthoCamera.layers.enable(AGENT_EYE_LAYER);

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

      // Optional floor reflection. On WebGL a Reflector mirror sits just
      // beneath the checker plane; it stays hidden until reflectionEnabled is
      // set. Sized/positioned in lockstep with the checker in loadModel(). On
      // the WebGPURenderer paths the TSL mirror is created lazily by
      // `_ensureGroundReflectorTsl()` once the TSL module is loaded (plan-763).
      const reflector = createGroundReflector(this.isWebGPU, ground);
      if (reflector) this._installGroundReflector(adaptWebGLReflector(reflector));
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
      { signal: this._domAbort.signal },
    );
    renderer.domElement.addEventListener(
      'webglcontextrestored',
      () => {
        console.warn('[RVViewer] WebGL context restored');
        this._renderDirty = true;
        this._shadowsDirty = true;
        this.emit('renderer-context-restored', undefined);
      },
      { signal: this._domAbort.signal },
    );
    // --- WebGPU device loss (plan-762 F7) — the real device only (webgpu-gl has none).
    if (this.hasCompute) {
      const device = (renderer as unknown as { backend?: { device?: GPUDevice } }).backend?.device;
      device?.lost.then((info) => this._onWebGPUDeviceLost(info)).catch(() => {});
    }

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
      // Budget adapts to current dampingFactor (defined per 60 Hz frame) and is
      // held in SECONDS (plan-568), capped at 5 s — identical at any frame rate.
      this._dampingSecondsRemaining = Math.min(
        Math.ceil(Math.log(0.01) / Math.log(1 - this.controls.dampingFactor)),
        300,
      ) / DAMPING_REFERENCE_HZ;
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
      if (!this._hasStaticCaster()) {
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
    this._cameraManager.onFollowModeChanged = (mode) => {
      this.emit('camera-mode-changed', { mode: mode === 'off' ? null : mode });
    };

    // plan-520: a real gesture marks user activity and cancels a running
    // MCP "Follow agent" flight (only that one — bookmarks keep flying).
    this._gestureActivityOff = bindViewportGestureActivity(this.controls, this._cameraManager, this.userActivity);

    // --- Canvas events ---
    this._bindCanvasEvents(renderer.domElement);

    // --- Scale-adaptive navigation (plan-515) ---
    // SceneScale: the one source of the content bounds. A full walk only after
    // one of the content events (or a stop/reset of the simulation); while the
    // simulation runs, a throttled grow-only recompute of the moving subtrees.
    this.sceneScale = new SceneScale({
      computeContentBounds: (out) => { computeContentBoundsInto(this.scene, out); },
      computeMovingBounds: (out) => this._computeMovingBounds(out),
    });
    const scaleEvents: SceneScaleEventSource = {
      on: (event, cb) => this.on(event as 'model-loaded', cb as () => void),
    };
    const offScale = bindSceneScaleEvents(this.sceneScale, scaleEvents);
    const offReset = this.on('simulation-reset', () => this.sceneScale.invalidate());
    // Scale-derived constants (plan-515 F10): ground checker + shadow camera.
    const offDerived = this.sceneScale.onChange((snap) => this._onSceneScaleChanged(snap));
    this._sceneScaleOff = () => { offScale(); offReset(); offDerived(); };
    this.navController = new NavigationController({
      canvas: renderer.domElement,
      captureTarget: container,
      getCamera: () => this._activeCamera,
      controls: this.controls,
      getPicker: () => this.raycastManager,
      camera: this._cameraManager,
      getSceneScale: () => this.sceneScale.get(),
      markDirty: () => { this._renderDirty = true; },
      onUserInput: () => this.userActivity.markUserInput(),
      // Far plane must reach the floor disc's rim, or zooming in clips it to a hard line.
      getMinFar: (cam) => {
        const g = this._groundMesh;
        if (!g || !g.visible) return 0;
        const dx = cam.x - g.position.x, dz = cam.z - g.position.z;
        return (Math.sqrt(dx * dx + dz * dz + cam.y * cam.y) + g.scale.x * 100) * 1.05;
      },
    });

    // Keyboard scope (plan-515 R3-2): the container is focusable, takes focus
    // on a canvas press and after every load (unless the user is typing
    // somewhere), so F / Escape reach this viewer exactly as before.
    this.keyboardScope = container;
    if (!container.hasAttribute('tabindex')) container.tabIndex = 0;
    if (!container.style.outline) container.style.outline = 'none';
    renderer.domElement.addEventListener('pointerdown', () => {
      try { container.focus({ preventScroll: true }); } catch { /* detached */ }
    }, { signal: this._domAbort.signal });
    this.on('model-loaded', () => {
      const active = document.activeElement;
      if (active && active !== document.body && active !== container && !container.contains(active)) return;
      try { container.focus({ preventScroll: true }); } catch { /* detached */ }
    });

    // --- XR (only for WebGL backend) ---
    this._setupXR(renderer, container);

    // --- Stats-gl ---
    this._setupStats(renderer);

    // --- Simulation Loop ---
    this.loop = new SimulationLoop(renderer);
    this.loop.onFixedUpdate = (dt: number) => this.fixedUpdate(dt);
    this.loop.onRender = () => this.render();
    // plan-568: the frame-rate cap never applies while an XR session presents
    // (the compositor needs every frame) or while a video capture runs.
    this.loop.shouldThrottle = () =>
      !this._capture && !(this.renderer as unknown as WebGLRenderer).xr?.isPresenting;
    this.loop.start();

    // Runtime attachment follows the workspace mode: modes registered with
    // `runtime: 'detached'` (e.g. the asset editor) switch time integration
    // fully off. Subscribed AFTER the ModeManager commit ('mode-changed'), so
    // plugin onModeDeactivate hooks still ran with a live runtime.
    this.on('mode-changed', ({ to }) => {
      // Safety net, NOT the normal path (plan-410 F6): an editor test run is
      // ended by the editor's async exit guard before the switch is allowed to
      // proceed. Guard-free switches (boot, lock(), programmatic setMode) skip
      // that, and a still-attached test owner would make the descriptor
      // derivation below a no-op. Attach hygiene only — the scene/document
      // restore belongs to the editor's own deactivate path.
      if (this.runtime.isEditorTestActive) {
        console.warn('[RVViewer] mode change with an active editor test run — ending it');
        this.runtime.endEditorTest();
      }
      this.runtime._setAttached(this.modes.descriptor(to)?.runtime !== 'detached');
      // The wireframe view is editor-only: it stops drawing on the way out and
      // comes back with the toggle's state on the way in.
      this._syncWireframe();
      // A mode switch rebuilds the visuals — re-push the collision status
      // outline so an active collision keeps its emphasis across the switch
      // (plan-394 F15).
      this.collisionManager.reapplyHighlight();
      this.dropManager.reapplyHighlight();
    });

    // --- Resize (ResizeObserver on container — handles soft keyboard, orientation) ---
    if (autoResize) {
      this.resizeHandler = () => {
        // plan-537 F2c: a video capture owns the drawing-buffer size. A window
        // resize meanwhile is queued and replayed by endCapture().
        if (this._capture) { this._capture.resizePending = true; return; }
        const w = this._renderStrategy?.canvasSize?.width ?? (container.clientWidth || window.innerWidth);
        const h = this._renderStrategy?.canvasSize?.height ?? (container.clientHeight || window.innerHeight);
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
        // Ray traced history follows the drawing buffer (plan-762; 0×0 ignored).
        const pr = this.renderer.getPixelRatio();
        this._raytraced.resize(Math.floor(w * pr), Math.floor(h * pr));
        // plan-2215: the render strategy follows the canvas (its views are derived per frame).
        if (this._renderStrategy?.onResize) {
          try { this._renderStrategy.onResize(w, h); } catch (err) {
            console.error('[RVViewer] render strategy onResize threw:', err);
          }
        }
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

    // plan-600: the DEV-only invariant layer, wired to its FOUR checkpoints
    // (model-loaded, mode-changing, mode-changed, model-cleared) plus
    // `placements-materialized` for the load-bound I3/I5 baseline. The guard is
    // what makes the layer tree-shakable: a production build drops this call,
    // and with it the only reference to the module.
    if (import.meta.env.DEV) installInvariants(this);
  }

  // ─── Post-Processing Pipeline (composer on WebGL, TSL pipeline on WebGPU) ─────────────────────────
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
   * Pre-compiles every scene material in parallel (KHR_parallel_shader_compile) and
   * resolves once all programs are linked, so the first frame of a new model does
   * not stall on synchronous program links.
   *
   * Two things make the pre-compile actually count:
   * - It compiles against the render target the frame will draw into. Three keys a
   *   program on the bound target (screen = output colour space + tone mapping,
   *   any offscreen target = linear, no tone mapping — WebGLPrograms.getParameters).
   *   With the composer active the scene pass and the ground mirror both draw into
   *   offscreen targets, so a compile against the screen built variants no frame used.
   * - No frame renders while the programs link (`_compileRenderHold`); one frame in
   *   that window would wait on every pending link synchronously.
   */
  private async _precompileModelShaders(): Promise<void> {
    if (!('compileAsync' in this.renderer)) return;
    const gl = this.renderer as unknown as WebGLRenderer;
    const offscreen = this._useComposer ? this._postProcessing.composer?.readBuffer ?? null : null;
    this._compileRenderHold++;
    // plan-774: three's own readiness poll (`compileAsync` → `checkMaterialsReady`)
    // reads `currentProgram.isReady()` of every material it compiled. Once a
    // superseding `clearModel()` disposed one — the raw per-part materials of an
    // authoring load; a runtime load only shares the never-disposed uber
    // material — that throws inside its `setTimeout` (an uncaught TypeError) and
    // the promise NEVER settles: the overtaken load never reached its abort
    // check and kept `sceneLoadGate` "loading" forever, so every later
    // `whenSceneReady()` (the editor's authoring join included) hung. On WebGL
    // the poll is therefore ours (a disposed material counts as done, a document
    // change ends it); any other renderer keeps `compileAsync`, and the clear
    // releases its wait.
    const generation = this._loadGeneration;
    const compile = (): Promise<unknown> => (typeof gl.compile === 'function' && 'properties' in gl && 'extensions' in gl)
      ? compileAsyncTolerant(gl, this.scene, this.camera, () => this._loadGeneration !== generation)
      : this.renderer.compileAsync(this.scene, this.camera, this.scene);
    try {
      let pending: Promise<unknown>;
      if (offscreen && typeof gl.getRenderTarget === 'function') {
        // compile() creates the programs synchronously; the target only has to
        // be bound for that call, the readiness poll is target-free.
        const prevTarget = gl.getRenderTarget();
        gl.setRenderTarget(offscreen);
        try {
          pending = compile();
        } finally {
          gl.setRenderTarget(prevTarget);
        }
      } else {
        pending = compile();
      }
      let release!: () => void;
      const released = new Promise<void>((r) => { release = r; });
      this._compileReleases.add(release);
      try {
        await Promise.race([pending, released]);
      } finally {
        this._compileReleases.delete(release);
      }
    } catch { /* non-critical — the first frame compiles whatever is missing */ } finally {
      this._compileRenderHold--;
      this._renderDirty = true;
    }
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
    this._wireframeView.setClippingPlanes(planes);
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

    // Per-pass accounting (rv-frame-stats.ts): the dim backdrop (pass 1) is
    // `scene`, the overlay quad + focus + overlay-layers passes are `post`.
    // The composer passes are wrapped when the backdrop goes through the
    // composer, so pass 1 is measured as a delta around the whole branch and
    // the wrapped passes' own deltas are undone by that delta being the sum.
    const frameInfo = this.renderer.info as unknown as RenderInfoLike;
    const frame = this._frame;
    const isoC0 = drawCallsOf(frameInfo), isoT0 = frameInfo.render.triangles;

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
      instrumentComposerPasses(composer.passes, frameInfo, frame, [gtaoPass, n8]);
      composer.render();
    } else {
      gl.render(this.scene, camera);
    }
    // Pass 1 done. In the composer branch the wrapped passes already booked
    // their share (scene / ao / outline / post); in the direct branches the
    // whole delta is the scene render.
    if (!this._useComposer || desaturate) addDelta(frame.scene, frameInfo, isoC0, isoT0);
    const isoC1 = drawCallsOf(frameInfo), isoT1 = frameInfo.render.triangles;

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
      addDelta(frame.post, frameInfo, isoC1, isoT1);
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
      const forceWebGL = kind === 'webgpu-gl';
      try {
        // plan-762 F14: internal builds ask the real device for the adapter's
        // storage limits (the ray traced buffers exceed the 128 MiB default);
        // community / customer builds take the define-dead branch unchanged.
        renderer = await initWebGPURendererWithLimits({
          internal: kind === 'webgpu' && __RV_INTERNAL__,
          gpu: typeof navigator !== 'undefined' ? navigator.gpu : undefined,
          create: (extra) => new WebGPURenderer({
            antialias: options?.antialias ?? false,
            alpha: true,
            stencil: true,
            forceWebGL,
            ...extra,
          } as any) as unknown as Renderer,
        });
      } catch (err) {
        console.warn(`[RVViewer] WebGPURenderer init() failed (${kind}), falling back to classic WebGL:`, err);
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
   * Hold the logic of a placement whose OWN signature gates it (plan-757 F6,
   * D8) — whatever the document's state: the components are constructed but
   * neither `init()` nor `onSceneReady()` ran, and the LogicStep subtree is
   * not in the engine. Released together with the document's deferred logic
   * by {@link activateGatedLogic}; dropped with the model otherwise.
   */
  holdPlacementLogic(deferred: DeferredLogic, root: Object3D): void {
    this._deferredLogic.push(deferred);
    this._heldPlacementLogicRoots.push(root);
  }

  /**
   * The user's persisted release for THIS model (`isSignatureUnlocked`) — what
   * the loader is told as `allowUntrustedLogic`, exposed so a placement's trust
   * gate weighs the same decision (plan-757 F6).
   */
  get allowUntrustedLogic(): boolean {
    return isSignatureUnlocked(this._signatureModelName);
  }

  /**
   * The viewer-owned subsystems components register with — ONE bag, spread
   * into the loader options and into {@link initContext} (plan-757 F4). A new
   * subsystem is one field in `InitSubsystems` and one line here.
   */
  initSubsystems(): InitSubsystems {
    return {
      gizmoManager: this.gizmoManager,
      lampManager: this.lampManager,
      webLabelManager: this.webLabelManager,
      outlineManager: this.outlineManager,
      energyChainManager: this.energyChainManager,
      sceneButtonManager: this.sceneButtonManager,
      chainManager: this.chainManager,
      ribbonManager: this.ribbonManager,
      machiningManager: this.machiningManager,
      collisionManager: this.collisionManager,
      dropManager: this.dropManager,
      events: this,
      errorStore: this.errorStore,
      instructionStore: this.instructionStore,
      highlighter: this.highlighter,
      reapply: this.signalReapply,
    };
  }

  /**
   * The init context of THIS session (plan-757 F4): the free `buildInitContext`
   * over the loaded runtime systems and {@link initSubsystems}. `null` before a
   * model is loaded. Every runtime init of a subtree — a placement, an
   * editor-rebuilt subtree — starts from it and adds only per-source data.
   */
  initContext(): InitContextBase | null {
    if (!this.registry || !this.signalStore || !this.transportManager) return null;
    return buildInitContext({
      registry: this.registry,
      signalStore: this.signalStore,
      transportManager: this.transportManager,
      scene: this.scene,
      ...this.initSubsystems(),
    });
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
    // plan-516 F1: only now do the sources know their templates — classify the
    // main model's MUs (idempotent; the load skipped it while gated).
    if (result.preplacedClassification?.enabled && result.transportManager) {
      classifyPreplacedMUs(result.root, result.transportManager, result.preplacedClassification.excluded);
    }

    this._attachLogicSystems(result);
    if (generation !== this._loadGeneration) return false;
    // plan-757 F6: the placements the gate held — their components were
    // initialised with the deferred logic above, their LogicSteps join now.
    // (`?? []`: the activation lifecycle is also pinned on a bare fake viewer.)
    const held = (this._heldPlacementLogicRoots ?? []).splice(0);
    for (const root of held) mergePlacedLogic(this, root);
    this.logicRunState = 'active';
    // plan-516: sim start of the pre-placed MUs classified above.
    activatePreplacedMUs(this.transportManager, this.logicRunState, this._kernel?.mode ?? 'continuous');
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
    // The document's drives first; drives a PLACEMENT added while the document
    // was gated (integratePlacedContent pushes them at materialisation) stay in
    // the tick list — the user's release must not silence them (plan-757 F6).
    const placed = (this.drives ?? []).filter((d) => !result.drives.includes(d));
    this.drives = placed.length > 0 ? [...result.drives, ...placed] : result.drives;
    this.transportManager = result.transportManager;
    this.playback = result.playback;
    this.replayRecordings = result.replayRecordings;
    // `this.logicEngine` is null here on a load; on a late activation
    // `mergePlacedLogic` may already have created the mid-session engine for a
    // placement while the document was gated (plan-757 F6). That engine stays —
    // the document's own steps join it below (`_attachMainLogic`).
    this.ikPaths = result.registry.getAll<RVIKPath>('IKPath').map((record) => record.instance);
    this._kernel = null;

    // plan-386 F17: signal binding wires model slots to LIVE external signals.
    // Foreign content must not get that wiring handed to it automatically.
    if (this._plannerSignalLinking && this._loadTrust.trusted
      && !this.signalBindingManager && this.signalStore && this.registry) {
      this.signalBindingManager = new SignalBindingManager(this.signalStore, this.registry);
    }
    // plan-539 F15: the model's Simulation / PLC start mode decides the
    // connection state BEFORE the first start (a live interface keeps it
    // connected; no component → the viewer default).
    // (`?.`: the load path is also pinned on narrow fakes without a controller.)
    (this as { connectionMode?: ConnectionModeController }).connectionMode
      ?.attach(ConnectionModeController.find(result.registry), ConnectionModeController.outputNames(result.registry));
    // plan-538 F1b: the connection state is known before the first start, so a
    // document loaded while a PLC is already connected never starts (or writes
    // from) a `Disconnected` root.
    if (this.logicEngine) this.logicEngine.start(this.connectionState === 'Connected');
    this._attachMainLogic(result);
    if (this.playback && (result.recorderSettings?.playOnStart ?? false)) this.playback.play();
  }

  /**
   * plan-769 Phase 6 (D20): the document's OWN LogicSteps, built ONCE against
   * the complete scene, through the function a placement uses
   * (`mergePlacedLogic` — engine created lazily, started with the current
   * connection state, roots added after the start run at once).
   *
   * A step resolves its targets when it is built, so it must not be built
   * before the content it names exists: a `LogicStep_DriveTo` addressed
   * `<p>#<id>` into a placed asset found nothing at `loadGLB` time and ran with
   * `drive = null`. Hence the moment:
   *  - the document places nothing → now (still before `onModelLoaded` and
   *    `'model-loaded'`, exactly where the engine always appeared);
   *  - it does → on THIS load's `'placements-materialized'` (emitted before
   *    any `whenMaterialized()` / `whenSceneReady()` continuation runs, so a
   *    caller awaiting the scene sees the steps). Until then the simulation is
   *    held anyway (`installPlacementsSimHold`) — only resolution moved.
   * A late activation (`activateGatedLogic`) takes the same rule: at once
   * when this load's placements already settled, else on the settle. An
   * overtaken load (newer load, `clearModel`) attaches nothing. Placement
   * content is not part of this merge — each placement brings its own logic
   * (merged or held by the trust gate, `RVLogicEngine.addSubtree` skips
   * placement roots). No rebuild on later layout changes (D21). The moment
   * is public as {@link whenModelLogicBuilt}, released right after the merge.
   */
  private _attachMainLogic(result: LoadResult): void {
    // Complete = this load's settle already fired (a late activation), or
    // nothing is materialising and nothing is left to queue: the core queues the
    // deferred references only after `onModelLoaded`, so on the load path the
    // marks still in the tree are the placements to come (`?.`: the load path is
    // also pinned on narrow fakes without an instancer).
    const settled = this._placementsSettledLoad === this._loadGeneration;
    const placesNothing = (this.placements?.state ?? 'idle') === 'idle'
      && collectDeferredPlacements(result.root).length === 0;
    // Built → release `whenModelLogicBuilt()` synchronously, right here: its
    // continuations are queued before any `whenSceneReady()` continuation of
    // the same settle. Inline on purpose (narrow fakes borrow this method alone).
    const built = (): void => {
      mergePlacedLogic(this, result.root);
      this._mainLogicBuiltLoad = this._loadGeneration;
      const waiter = this._mainLogicWaiter;
      this._mainLogicWaiter = null;
      waiter?.resolve();
    };
    if (settled || placesNothing) {
      built();
      return;
    }
    const generation = this._loadGeneration;
    const off = this.on('placements-materialized', (info) => {
      off();
      if (info.aborted || generation !== this._loadGeneration) return;
      built();
    });
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
   * Trust context of the load currently in flight (plan-386 F17).
   *
   * Valid from the first line of `loadModel`/`loadScene` up to and including
   * plugin `onModelLoaded` dispatch, then restored in a `finally` — on the
   * error path too, so a failed foreign load cannot leave the viewer marked
   * untrusted for the next, legitimate one (§9.2 `trust_ContextResetAfterFailure`,
   * `trust_NormalLoadAfterShareIsTrusted`).
   *
   * Reads `{ trusted: true }` whenever no load is running, which is what makes
   * every existing caller and every explicit user action behave exactly as
   * before.
   */
  get loadTrust(): LoadTrustContext {
    return this._loadTrust;
  }

  /**
   * Provenance of the model currently on screen (plan-423 F6).
   *
   * Unlike {@link loadTrust}, which is a LOAD-TIME context and reads
   * `{ trusted: true }` again the moment the load returns, this survives until
   * the next load. It is what the commissioning trust banner and its revocation
   * read — and the only thing they may read, because a banner asking about a
   * load that has already finished cannot use a value that has already been
   * restored (review finding SOL-R1 F1).
   *
   * Lifecycle: `clearModel()` resets it to {@link LOCAL_PROVENANCE} — which
   * every load runs first, so a FAILED load leaves "no foreign model on screen"
   * rather than the previous model's record. A successful load adopts
   * `options.provenance` at the very end, guarded by the load generation so a
   * superseded load cannot publish over its successor.
   */
  get modelProvenance(): ModelProvenance {
    return this._modelProvenance;
  }

  /** Publish provenance to the field, the React store and the event bus at once. */
  private _setModelProvenance(next: ModelProvenance): void {
    if (this._modelProvenance === next) return;
    this._modelProvenance = next;
    setModelProvenance(next);
    this.emit('model-provenance-changed', { provenance: next });
  }

  /**
   * Load a GLB model and start all simulation systems.
   *
   * @param url      GLB URL (file, blob:, or empty-glb URL)
   * @param options  Optional load options (e.g. an rv-extras overlay applied during traversal).
   *
   * `options.trust` marks the bytes as foreign (plan-386 F17). This thin
   * wrapper exists only to install and unconditionally restore that context
   * around the real load — putting the `try`/`finally` here rather than around
   * the 400-line body keeps the reset impossible to fall out of.
   */
  async loadModel(url: string, options?: {
    overlay?: RVExtrasOverlay;
    data?: ArrayBuffer;
    preserveHierarchy?: boolean;
    /**
     * plan-727 — AUTHORING load: never mutate the GLB node hierarchy (skips
     * kinematic re-parenting). See LoadGLBOptions.preserveAuthoringHierarchy.
     * Deliberately separate from `preserveHierarchy`, the MESH-BAKE flag
     * (editor / STEP-inspection loads keep every source mesh). The embed
     * facade (`rv-embed-viewer.ts`) sets neither: it is a simulating
     * production runtime on the same recipe as this viewer (plan-757).
     */
    preserveAuthoringHierarchy?: boolean;
    /** Stable local filename or URL-derived identity for signature unlock persistence. */
    modelName?: string;
    /** Provenance of these bytes. Defaults to trusted — see {@link LoadTrustContext}. */
    trust?: LoadTrustContext;
    /**
     * The scene this load materialises carries edits (`loadScene`: any op —
     * placements added/moved/removed, nodes, overrides). Can only REMOVE script
     * trust (`rv-script-trust.ts`), never grant it.
     */
    editedScene?: boolean;
    /**
     * Identity + trust state to publish as {@link modelProvenance} once the
     * load succeeds (plan-423 F6). Defaults to {@link LOCAL_PROVENANCE}.
     *
     * A load OPTION rather than a setter the caller pokes before/after: only
     * the share boot knows the identity, and only the load knows whether it was
     * superseded. Passing it through means the two facts meet at the one place
     * that can honour both.
     */
    provenance?: ModelProvenance;
    /**
     * The URL these bytes are the model OF, when `url` is only where they came
     * from. A resumed scene body is a `blob:` object URL with a random UUID —
     * a source of bytes, never an identity. Everything keyed by "which model is
     * this" (model plugins, camera presets, the model selector, `?option=`)
     * keys off this instead, or a drafted scene reloads as an unknown model and
     * loses its whole plugin pack.
     */
    identityUrl?: string;
    /**
     * plan-774 F6 — release the previous document with its baked placement
     * assets KEPT for this load (`clearModel({ keepBaked })`); what this load
     * does not claim is retired once its placements settled (an empty
     * document therefore ends the window at once). Default TRUE — any load →
     * the next load of the session; `false` retires every bake at the clear,
     * as a direct `clearModel()` does.
     */
    keepBaked?: boolean;
    /** plan-774 F6 — INTERNAL, with `keepBaked`: a descend; see `PlacementInstancer.clearDocument`. */
    holdKept?: boolean;
    /**
     * plan-769 Phase 7 (D23) — moves / removals of placements THIS file holds,
     * by placement id (`materialise().baselinePlacementTransforms` /
     * `removedPlacementIds`). Applied to the loaded tree before any plugin's
     * `onModelLoaded`, so the planner adopts the moved state and never the
     * removed one. `loadScene` passes it for a replayed draft tail.
     */
    baselinePlacements?: BaselinePlacementEdits;
  }): Promise<LoadResult> {
    // Tracked for `whenSceneReady()`; the trust rule stays the one line below.
    return this.sceneLoadGate.track(this._loadModelTrusted(url, options));
  }

  private async _loadModelTrusted(url: string, options?: Parameters<RVViewer['loadModel']>[1]): Promise<LoadResult> {
    // The generation THIS load runs under, written by `_loadModelInner` right
    // after its `clearModel` (-1 = it failed before getting that far).
    const ticket = { generation: -1 };
    try {
      return await withLoadTrust(this._trustSlot, options?.trust, () => this._loadModelInner(url, options, ticket));
    } catch (e) {
      // plan-774 review fix E7: a load that FAILS (bad bytes, a bake error) never
      // seals, so the kept window its `clearModel` opened would keep the
      // previous document's bakes in memory until some later load settled. It
      // ends here — only while this load is still the latest one: a superseded
      // load (`LoadAbortedError`, or a newer load already running) must not
      // close the window the NEWER load's clear opened.
      if (!(e instanceof LoadAbortedError) && ticket.generation === this._loadGeneration) {
        this.placements.endKeptWindow();
      }
      throw e;
    }
  }

  private async _loadModelInner(url: string, options?: {
    overlay?: RVExtrasOverlay;
    data?: ArrayBuffer;
    preserveHierarchy?: boolean;
    preserveAuthoringHierarchy?: boolean;
    modelName?: string;
    trust?: LoadTrustContext;
    provenance?: ModelProvenance;
    identityUrl?: string;
    editedScene?: boolean;
    keepBaked?: boolean;
    holdKept?: boolean;
    baselinePlacements?: BaselinePlacementEdits;
  }, ticket?: { generation: number }): Promise<LoadResult> {
    // No trust carried over from the previous load — whatever happens below,
    // the source facts are this load's or none (rv-script-trust.ts).
    this._currentModelSource = null;
    // Load-generation guard (plan-240 F9) — any BVH build still running for a
    // previous model aborts on its next generation check. The async merge
    // phases of loadGLB (plan-274 B3/F7) capture the same snapshot via
    // `shouldAbort` below: a newer load/clear makes the stale loadGLB dispose
    // its constructed chunks + root and reject with LoadAbortedError.
    this._loadGeneration++;
    // plan-774 F6 (Phase 3 deviation, measured): every load keeps the previous
    // document's bakes for ITSELF — a planner ↔ editor switch, an undo, a
    // re-open of the same document re-instantiate instead of re-baking; what
    // this load does not claim is retired when its placements settle.
    this.clearModel({ keepBaked: options?.keepBaked ?? true, holdKept: options?.holdKept === true });
    // Snapshot AFTER clearModel() — it bumps the generation once more; the
    // snapshot must reflect the generation THIS load runs under.
    const loadGeneration = this._loadGeneration;
    if (ticket) ticket.generation = loadGeneration;
    /**
     * Latest-wins guard (plan-442 F1/F3). Called after EVERY `await` in this
     * method, so a run that has been overtaken cannot write another viewer-
     * global, register another pick structure or emit another event.
     *
     * It throws the load path's EXISTING cancellation contract rather than
     * returning a sentinel: `loadGLB`'s own `shouldAbort` path already rejects
     * stale runs with `LoadAbortedError`, and callers already have to treat
     * that as a cancellation rather than a failure.
     *
     * An integer compare — free in the non-overlapping case, which is every
     * ordinary model switch.
     */
    const abortIfSuperseded = (): void => {
      if (this._loadGeneration !== loadGeneration) throw new LoadAbortedError(url);
    };
    // `url` is where the bytes come from; `identityUrl` is what they ARE. They
    // differ exactly when a scene resumes from a stored body — see the option's
    // docs. Only `loadGLB` below gets the raw `url`.
    const identity = options?.identityUrl ?? url;
    this._currentModelUrl = identity;
    // Where the bytes really came from — read by the WebComponent trust rule
    // (rv-script-trust.ts). Only a provenance token the fetch boundary recorded
    // on EXACTLY the parsed buffer counts; a caller cannot name a source. The
    // loader selects the final bytes (its own fetch for a URL load, a signature
    // recovery's replacement), so `sourceUrl` is null until `loadGLB` reports
    // the token of the bytes it actually parsed — published right after it.
    this._currentModelSource = Object.freeze({
      sourceUrl: null,
      identityUrl: identity,
      hasOverlay: !!options?.overlay && Object.keys(options.overlay.nodes ?? {}).length > 0,
      hasPlacementEdits: options?.editedScene === true
        || (!!options?.baselinePlacements && !isEmptyBaselinePlacementEdits(options.baselinePlacements)),
      authoring: options?.preserveHierarchy === true || options?.preserveAuthoringHierarchy === true,
      untrusted: options?.trust?.trusted === false,
      hasSidecar: false,
    });
    setProblemsDocument(identity);
    // plan-757 Phase 2 (F13): the document is the first link of every nesting
    // chain — a placed asset that references the document it sits in is a
    // cycle, not an infinite descent. Spelled in the instancer's ONE key
    // derivation, so it matches a nested reference's key whatever its form.
    this.placements.setDocumentKey(this.placements.keyOf({ catalogId: '', glbUrl: identity }));
    this._signatureModelName = resolveModelName(options?.modelName ?? identity);

    // --- Pre-load phase: load model plugins BEFORE GLB so they can register capabilities ---
    // Capabilities must be registered before the bake in loadGLB() (roles).
    // External plugin bundles (./project-plugin.js, ./models/<name>/model-plugin.js) are
    // an opt-in feature for deploys that ship standalone plugin bundles alongside the viewer.
    // Gated on appConfig.externalPlugins to avoid two 404s per model load on every other deploy
    // where no such bundle exists. The Vite-bundled ModelPluginManager below is the default path.
    if (getAppConfig().externalPlugins) {
      const modelBaseName = identity.replace(/^.*\//, '').replace(/\.glb$/i, '');
      const tryPreloadPlugin = async (pluginUrl: string): Promise<void> => {
        try {
          const resp = await fetch(pluginUrl, { method: 'HEAD' });
          if (!resp.ok) return;
          const mod = await import(/* @vite-ignore */ pluginUrl);
          if (typeof mod.default === 'function') mod.default(this);
        } catch { /* skip silently */ }
      };
      await tryPreloadPlugin('./project-plugin.js');
      abortIfSuperseded();
      await tryPreloadPlugin(`./models/${modelBaseName}/model-plugin.js`);
      abortIfSuperseded();
    }
    if (this.modelPluginManager) {
      // A hook that hangs here is the widest pre-load window there is: a newer
      // load can run its whole clearModel + parse while this one waits. Whatever
      // side effects the hook already had are the newer load's problem to
      // overwrite; what must not happen is this run carrying on afterwards.
      await this.modelPluginManager.onModelLoading(identity, this);
      abortIfSuperseded();
    }

    // Wait for any load gate (e.g. login) before heavy GLB parsing
    if (this.loadGate) {
      await this.loadGate;
      abortIfSuperseded();
    }

    // After the plugin pre-load above, so a module registered there is asked.
    const bakeClaimSet = this._collectBakeClaims();

    this._mainDocumentLoadUrl = url;
    const result = await loadGLB(url, this.scene, {
      isWebGPU: this.isWebGPU,
      // ONE uber material per session, owned here (plan-752 S2): the loader
      // and the layout planner's ModelCache must bake onto the same reference
      // or a dropped asset and a reloaded one land in different arenas.
      sharedUber: this.ensureUberMaterial(),
      muComputeRenderer: this._muComputeRenderer(),
      // plan-757 F4: the ONE subsystem bag — the same one `initContext()`
      // hands to every placement and editor-rebuilt subtree.
      ...this.initSubsystems(),
      overlay: options?.overlay,
      // plan-652 Phase 3: DES (and any `component:` feature) is active before the build.
      features: this.features,
      data: options?.data,
      preserveHierarchy: options?.preserveHierarchy,
      preserveAuthoringHierarchy: options?.preserveAuthoringHierarchy,
      allowUntrustedLogic: isSignatureUnlocked(this._signatureModelName),
      // Async batch phases — stale-load abort (plan-274 pattern).
      shouldAbort: () => this._loadGeneration !== loadGeneration,
      // Loader bake (plan-753 Phase 4a): the model is instantiated in place
      // through the session registry — same pick backend as the placements.
      bakeRegistry: this.bakeRegistry,
      // plan-754 D17: nodes the (already pre-loaded) plugins need at runtime,
      // plus whether they could be asked at all (deferred model plugins).
      bakeClaims: bakeClaimSet.claims,
      bakeClaimsComplete: bakeClaimSet.complete,
      // Reload = shared instances (plan-753): saved placements are NOT composed
      // + baked in place — `this.placements` instantiates each from the asset's
      // shared BakedAsset after the load, with or without the planner plugin.
      // plan-774 F2: editor / authoring loads too — the open document stays
      // unbaked (`preserveHierarchy`), its references are placements like in
      // the HMI; the editor joins them through `loadAuthoringModel`.
      deferPlacements: true,
    });

    /**
     * The duplicate-root guard for the window between `loadGLB` returning and
     * the root being adopted (plan-442 F1).
     *
     * In that window the root is parented but NOT yet tagged `_rvModelRoot` and
     * NOT yet `currentModel`, so a newer load's `clearModel()` sweep cannot see
     * it — this run has to take it out itself. Detaching comes first and
     * disposal second on purpose: while the subtree is still parented, ANY
     * other run's `renderer.compileAsync(this.scene, …)` walks it, and one with
     * freed buffers takes the renderer down with it.
     */
    const abortIfSupersededBeforeAdoption = (): void => {
      if (this._loadGeneration === loadGeneration) return;
      this.scene.remove(result.root);
      // The loser's in-place bake is this result's own (it never became
      // `_lastLoadResult`): release the instance (chunk meshes leave, sources
      // unmask) and retire the asset so its chunk geometries are freed HERE —
      // the subtree dispose below skips them by the `chunkMetaOf` guard.
      if (result.bakeInstance) this.bakeRegistry.release(result.bakeInstance);
      if (result.bakedAsset) {
        result.bakedAsset.retired = true;
        if (result.bakedAsset.instances === 0) result.bakedAsset.dispose();
      }
      disposeModelSubtree(result.root);
      throw new LoadAbortedError(url);
    };
    // Checked BEFORE the compile below, not only before the adoption: compiling
    // is minutes of pointless GPU work for a load nobody will see, and it is
    // exactly what would drag a concurrently-disposed sibling subtree into the
    // renderer.
    abortIfSupersededBeforeAdoption();
    // The final source facts (rv-script-trust.ts): the token of the bytes the
    // loader parsed, and whether a `.kin.json` sidecar changed the document.
    if (this._currentModelSource) {
      this._currentModelSource = Object.freeze({
        ...this._currentModelSource,
        sourceUrl: result.modelSourceUrl ?? null,
        hasSidecar: result.sidecarModified === true,
      });
    }

    // Profile the expensive post-loadGLB steps separately (gated on ?debug=perf).
    const prof = createLoadProfiler('loadModel');
    prof.mark('loadGLB');

    await this._precompileModelShaders();
    prof.mark('compileAsync');

    // The last moment the root is still nobody's: overtaken DURING the compile
    // above, and the two lines below would hand the scene a second model that
    // draws on top of the one the user is actually looking at. That is what put
    // 87 meshes into the scene twice, with parts of the machine invisible.
    abortIfSupersededBeforeAdoption();
    // GLB root is reported deterministically by loadGLB (LoadResult.root) —
    // no diffing scene.children. The `_rvModelRoot` userData tag stays as
    // defence-in-depth so clearModel's tag-sweep can recover from any
    // historic stray that might still be tagged from prior buggy sessions.
    this.currentModel = result.root;
    this.currentModel.userData._rvModelRoot = true;
    // plan-769 Phase 7 (D23): a replayed tail's moves / removals of placements
    // this file holds — on the still-empty reference nodes, before any plugin
    // (planner adoption) or the core instancer sees them.
    if (options?.baselinePlacements && !isEmptyBaselinePlacementEdits(options.baselinePlacements)) {
      applyBaselinePlacementEdits(result.root, result.registry, options.baselinePlacements);
    }
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
    this.blockageBudgets = new BudgetResolver({
      nodeForUnit: id => getDefaultAgvFleet().get(id)?.node
        ?? result.registry.getNode(id.replace(/^des:/, '').replace(/:(surface|sink)$/, '')),
      budgetNodes: () => {
        const nodes: Object3D[] = [];
        this.scene.traverse(node => { if (node.userData.realvirtual?.BlockageBudget) nodes.push(node); });
        return nodes;
      },
      readSignal: (ref, node) => {
        const resolved = result.registry.resolve(ref as Parameters<typeof result.registry.resolve>[0], undefined, node as Object3D);
        return resolved?.signalAddress ? result.signalStore.getBoolByPath(resolved.signalAddress) : false;
      },
      writeSignal: (ref, node, value, now) => {
        const resolved = result.registry.resolve(ref as Parameters<typeof result.registry.resolve>[0], undefined, node as Object3D);
        if (resolved?.signalAddress) result.signalStore.setByPath(resolved.signalAddress, value, now,
          { writerId: 'diagnostics:blockage', writerKind: 'component' });
      },
    });
    this._progressWiring = new ProgressWiring({
      onSample: () => this.blockageWatch.sample(),
      expectFlow: this.blockageBudgets.expectFlow,
      authority: () => getDefaultMovementAuthority(this._kernel?.mode === 'des' ? 'des' : 'continuous'),
      clock: { now: () => this.simTime },
      fleet: { all: () => getDefaultAgvFleet().all() },
      transport: result.transportManager,
      running: () => this.logicRunState === 'active',
    });
    this._progressWiring.waitRegistry.addSource(behaviorWaitSource(this, () => this._kernel?.mode ?? 'continuous'));
    this.statisticsManager.clear(); // Plan 201: drop prior model's registrations (components re-register on bind)
    // Plan 194 P1: invalidate the unified kernel so it rebuilds against the new
    // transportManager on the next tick.
    this._kernel = null;
    this.signalStore = result.signalStore;
    // MachiningVolume reads SignalSpindleOn/SignalReset and writes
    // SignalMachiningActive through this host (plan-405 §2.5).
    this.machiningManager.setSignalHost(result.signalStore);
    this.signalStore.signalWriteGate = this._signalWriteGate;
    // plan-394: (re)wire the collision manager to THIS model — its signals and
    // its MU spawn/remove stream. Reporting goes through the live card store;
    // there is no modal round-trip anymore.
    this.collisionManager.attachSignals(this.signalStore);
    this.collisionManager.invalidate();
    if (result.transportManager) result.transportManager.muLifecycleHook = this.collisionManager;
    // plan-2022: (re)wire the drop detection to THIS model. The transport
    // manager is both the tick host and the source of the two facts the stage
    // needs — the vertical reach a surface may bridge, and the GripTargets.
    this.dropManager.attachSignals(this.signalStore);
    // The support-ray host is wired below, right after `raycastManager` is created: it is
    // still null (or the previous model's, already disposed) at this point.
    if (result.transportManager) {
      this.dropManager.setTransportHost(result.transportManager);
      result.transportManager.dropHook = this.dropManager;
    }
    this.playback = null;
    this.replayRecordings = [];
    this.logicEngine = null;
    this.registry = result.registry;
    // Planner Signal Linking: (re)build the binding manager against the fresh
    // signalStore + registry. Gated by the feature flag — null otherwise so no
    // override path, badge, or guard ever runs.
    // plan-386 F17 — see the sibling guard in _attachLogicSystems. The dispose()
    // still runs unconditionally: the PREVIOUS model's manager must go away
    // whatever the new model's provenance is.
    if (this._plannerSignalLinking && this.logicRunState === 'active') {
      this.signalBindingManager?.dispose();
      this.signalBindingManager = this._loadTrust.trusted
        ? new SignalBindingManager(this.signalStore, this.registry)
        : null;
    }
    // Collect robot IK paths (replay engine) from the registry for per-frame ticking.
    this.ikPaths = [];
    this.groups = result.groups;
    this.suppressGround('model', result.renderHints?.suppressGround === true);
    if (this.logicRunState === 'active') {
      this._attachLogicSystems(result);
      // plan-516: sim start of the pre-placed MUs the loader classified.
      this._activatePreplacedMUs();
    }

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
      if (caps.ui.filter) {
        registerFilterSubscriber({ id: type, label: caps.ui.filter, componentType: type });
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
    // The manager is rebuilt per model load — carry the wireframe pick rule over.
    this.raycastManager.setWirePickMode(this._wireframeApplied);
    // plan-529: the linked-label pointer cursor survives a part un-hover.
    this.raycastManager.cursorOverride = () => (this.webLabelManager.hoveringLink ? 'pointer' : null);
    // plan-2215 2.6: no hover / pointer pick while a render strategy draws other cameras.
    this.raycastManager.pickBlocked = () => this.pointerPickBlocked;
    // Baked placements and the baked model pick through their chunk meshes, with
    // realvirtual's own pick structure as the narrow phase (plan-756). Coexists
    // with the editor instance backend: it answers only for registry meshes and
    // passes everything else through.
    this._pickBackend = new PickBackend(this.bakeRegistry);
    this.raycastManager.addBackend(this._pickBackend);
    // plan-2022: the unsupported-part detection casts its support ray through this manager.
    this.dropManager.setProbeHost(this.raycastManager);
    if (!this._pickBackend.usesStructure) {
      console.warn('[RVViewer] pick structure OFF (rv-webviewer-pick-structure = 0): baked chunks are picked by the linear segment walk');
    }
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

    // Pick geometry (plan-753 Phase 4): MU pools are the manager's own
    // instanced targets on every load; the model itself picks either through
    // the chunk pick structures of the bake (PickBackend above) or — when the
    // load did not bake — through the per-mesh instance pick index.
    this.raycastManager.setInstancedMeshes(this._collectInstancedMeshes());
    if (result.bakedAsset) {
      // Baked load: a node's segment interval highlights through `chunk-outline` /
      // `chunk-overlay`; keep meshes run on the source meshes.
      this._instancePickIndex = null;
      debug('loader', `[LoaderBake] ${result.bakedAsset.chunks.length} chunks, ${result.bakedAsset.keep.length} keep, `
        + `${result.bakedAsset.triangles} triangles`);
    } else {
      // Authoring load (preserveHierarchy) or a document that draws nothing —
      // there is no other unbaked load (plan-757 Phase 3; a failed bake is a
      // load error): install the two-level instance pick backend. Real meshes ARE
      // the pick geometry (per-mesh local BVHs from the async build below are
      // the narrow phase); membership is maintained incrementally by the
      // asset-op executors, so NO full rebuild exists. Highlights run on real
      // meshes (OutlinePass / overlay pairs).
      const index = new InstancePickIndex(result.registry);
      index.addSubtree(result.root);
      this._instancePickIndex = index;
      this.raycastManager.setBackend(index);
      debug('loader', `[InstancePickIndex] editor pick backend: ${index.size} meshes`);
    }

    // Gizmos created during loadGLB (e.g. WebSensor outlines) were instantiated
    // before raycastManager existed. Register them AFTER the target list is
    // installed so they survive the rebuild `setInstancedMeshes` triggers.
    this.gizmoManager.refreshAuxRaycastTargets();
    // Same for the WebLabel visuals (pick targets of their node): their
    // registration ran against the PREVIOUS raycast manager, or none at all.
    this.webLabelManager.refreshPickTargets();

    // Async BVH build (plan-240): loadGLB deferred the per-mesh BVH
    // construction of Phase 13. Baked chunks are NOT part of it — they carry
    // their own pick structure and are skipped (plan-756). Kick off ONE
    // sequential background build;
    // `model-loaded` below does NOT wait for it — until completion, per-mesh
    // raycasts (collision, transport, instance pick) run through the native
    // three.js fallback.
    this._startAsyncBvhBuild(result);

    // Enable hover for EVERY pickable type (plan-753 §2.3): `pick:'select'` /
    // `pick:'action'` IS the declaration that the type is hoverable, so the
    // old separate `hoverEnabledByDefault` opt-in — which silently rejected
    // hits on types that forgot to set it — no longer exists. The gate is
    // snapshotted here, at model load; `setExclusiveHoverMode` narrows it.
    for (const type of getPickableTypes()) {
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

    // Fit directional light shadow camera to model (scale-derived, plan-515
    // F10; refitted on every later SceneScale change — placements, moving
    // content — through _onSceneScaleChanged).
    this._fitShadowCameraToScale(center, maxDim);

    // --- Auto-load model sidecar settings (first visit only) ---
    // --- Load and merge model-specific plugin configuration ---
    const [modelJsonConfig, glbConfig] = await Promise.all([
      loadModelJsonConfig(url).catch(() => ({} as ModelConfig)),
      Promise.resolve(extractGlbPluginConfig(this.scene)),
      loadModelSettingsConfig(url),
    ]);
    // From here on the root IS tagged, so a newer load's clearModel sweep has
    // already taken it away — nothing left to dispose, only writes to stop.
    abortIfSuperseded();
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

    // Mode-scoped plugins outside the active mode (including the null "no mode"
    // boot window BEFORE main.ts applies the workspace mode) must not receive
    // onModelLoaded. Selective rv_plugins eligibility is enforced before a
    // plugin is recorded as having missed the lifecycle callback.
    await this._notifyPluginsModelLoaded(result);
    abortIfSuperseded();
    // Deferred placements nobody claimed in `onModelLoaded` (no planner):
    // the core materialises them — one bake per asset, smaller assets first.
    // Fire-and-forget; `placements.whenMaterialized()` is the join point.
    this.placements.materializeDeferred(collectDeferredPlacements(result.root));

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
    // plan-423 F6: adopt the load's provenance now that it has actually
    // arrived. Generation-guarded — a load overtaken by a newer one must not
    // publish its own origin over the model the user is now looking at.
    if (this._loadGeneration === loadGeneration) {
      this._setModelProvenance(options?.provenance ?? LOCAL_PROVENANCE);
    }
    this.emit('model-loaded', { result });
    // Every deferred placement of this load is queued by now (planner in
    // `onModelLoaded`, the core right above): the instancer owes exactly one
    // `placements-materialized` from here — at once for a document without any.
    this.placements.sealLoad();
    this._publishSignatureUiState();
    this.emit('signature-state-changed', {
      signatureState: this._signatureState,
      logicRunState: this.logicRunState,
    });
    if (this.logicRunState === 'active') {
      this.emit('model-logic-activated', { result });
    }
    // Plugins and model-loaded listeners re-bind model materials after the first
    // pre-compile (section clipping planes, toon conversion) — each such binding is
    // a new program variant. Link those in parallel as well, before the model's first
    // frame draws; programs that are already linked are reused, not rebuilt.
    await this._precompileModelShaders();
    prof.mark('compileAfterPlugins');
    // Wait for any deferred async loading work registered by subsystems
    // and plugins (env-map IBL, deferred asset prefetch, …) so the caller's
    // `await viewer.loadModel(...)` only resolves once the scene is fully
    // ready to be revealed.
    await this.whenLoadingIdle();
    // Last window: a load started during the drain owns the scene now, so this
    // result no longer describes what is on screen — do not hand it back as if
    // it did (plan-442 F3).
    abortIfSuperseded();
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
    // Instance-pick loads raycast the per-mesh geometries through the native
    // O(triangles) fallback until the async build lands — surface that window
    // in DevTools as the pending count (upper bound — shared geometries dedup
    // inside computeBVHAsync). A baked load has nothing pending: its chunk pick
    // structures existed before the scene was shown (plan-756 F1).
    this._pickMetrics.setBvhPending(this._instancePickIndex ? this._instancePickIndex.size : 0);

    const run = (async () => {
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
        });
        if (!completed || this._loadGeneration !== generation) return;

        this._pickMetrics.setBvhPending(0);
        // The collision bodies were built while the trees were still pending —
        // every mesh looked tree-less, so every body latched `aabbOnly` and a
        // workpiece INSIDE a machine reported a permanent AABB collision
        // (2026-09-02, /demo: Turbine in the CNC). Rebuild against the finished
        // trees; the rebuild is lazy and costs one tick.
        this.collisionManager.invalidate();
        this._renderDirty = true;
        this.emit('raycast-ready', undefined);
      } catch (e) {
        console.warn('[viewer] async BVH build failed:', e);
      }
    })();
    this._bvhBuildRun = run;
    void run.finally(() => { if (this._bvhBuildRun === run) this._bvhBuildRun = null; });
  }

  /**
   * Resolves when no asynchronous BVH build is pending or running (plan-550).
   * During a worker build a mesh's position/index buffers are transferred and
   * therefore unreadable; a consumer that copies CPU geometry (the cinematic
   * scene copy) waits for this first. Bounded by `timeoutMs` — a hidden tab
   * may never fire the two animation frames the build starts after.
   */
  async whenBvhIdle(timeoutMs = 30_000): Promise<void> {
    const idle = (async () => {
      if (this._bvhBuildRun) await this._bvhBuildRun;
      await this._bvhPort?.whenIdle?.();
    })();
    let timer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([idle, new Promise<void>((r) => { timer = setTimeout(r, timeoutMs); })]);
    if (timer) clearTimeout(timer);
  }

  /**
   * Count the model roots parented to the scene, and warn in dev when there is
   * more than one (plan-442 F4).
   *
   * A second `_rvModelRoot` child is never legitimate: it means a superseded
   * load left its subtree behind, and the symptom the user sees is doubled
   * geometry with parts of it z-fighting itself into invisibility. Cheap
   * enough to call at the end of a mode activation — it walks
   * `scene.children`, not the model — and deliberately NOT wired into the
   * frame loop.
   *
   * @param context Where the check ran, for the log line.
   * @returns the number of model roots currently in the scene.
   */
  checkSingleModelRoot(context: string): number {
    let count = 0;
    for (const child of this.scene.children) {
      if (child.userData?._rvModelRoot) count++;
    }
    if (count > 1 && import.meta.env.DEV) {
      debug('loader', `[viewer] ${count} model roots in the scene after ${context} — `
        + 'a superseded load left its subtree behind (plan-442).');
    }
    return count;
  }

  // ─── Reference audit (plan-610 F9) ──────────────────────────────────

  /** Pending coalesced audit (see {@link _scheduleReferenceAudit}). */
  private _referenceAuditTimer: ReturnType<typeof setTimeout> | null = null;
  /** The last audit result — diagnostics and tests. */
  private _lastReferenceAudit: ReferenceAuditResult | null = null;

  /**
   * Audit every stored node reference of the open document NOW and replace the
   * `reference-unresolved` / `reference-rescued` Problems entries with what it
   * found (plan-610 F9). One registry walk, quiet resolution, no frame-loop work.
   * Cancels a pending coalesced run. Returns `null` without a model.
   */
  auditReferences(): ReferenceAuditResult | null {
    this._cancelReferenceAudit();
    if (!this.registry || !this.currentModel) {
      this._lastReferenceAudit = null;
      clearReferenceAuditProblems();
      return null;
    }
    let result: ReferenceAuditResult;
    try {
      result = auditReferences(this.registry);
    } catch (e) {
      // An audit must never take a load or an edit down with it.
      console.warn('[viewer] reference audit failed:', e);
      return null;
    }
    this._lastReferenceAudit = result;
    reportReferenceAudit(result.findings);
    // plan-774 F7: a Kinematic of the open document whose group reaches into
    // placed content (the placements merge their groups in by name) — same
    // triggers as the reference audit: load, every placement settle, structural edits.
    try {
      reportKinematicMembersInPlacedContent(auditKinematicGroupsInPlacedContent(this.registry, this.groups));
    } catch (e) {
      console.warn('[viewer] kinematic placed-content audit failed:', e);
    }
    return result;
  }

  /** The result of the most recent {@link auditReferences} run (`null` = none for this document). */
  get lastReferenceAudit(): ReferenceAuditResult | null {
    return this._lastReferenceAudit;
  }

  /**
   * Run a pending coalesced audit at once (tests, MCP). Returns its result, or
   * `null` when nothing was pending.
   */
  flushReferenceAudit(): ReferenceAuditResult | null {
    return this._referenceAuditTimer !== null ? this.auditReferences() : null;
  }

  /**
   * Coalesce edits into ONE audit: everything that happens within the current
   * macrotask (a composite and its notifications, an undo, a whole history
   * replay chained through microtasks) is audited once, right after.
   */
  private _scheduleReferenceAudit(): void {
    if (this._referenceAuditTimer !== null) return;
    this._referenceAuditTimer = setTimeout(() => {
      this._referenceAuditTimer = null;
      this.auditReferences();
    }, 0);
  }

  private _cancelReferenceAudit(): void {
    if (this._referenceAuditTimer === null) return;
    clearTimeout(this._referenceAuditTimer);
    this._referenceAuditTimer = null;
  }

  /**
   * When the audit runs:
   *  - the main model is complete (`model-loaded` — viewer, asset-editor open and
   *    recompose all load through `loadModel`);
   *  - the placements of the load settled (`placements-materialized` — a placement
   *    never passes `model-loaded`, it arrives later);
   *  - layout content came or went OUTSIDE a load (planner drop / delete): while the
   *    instancer still materialises, the settle above covers it — no walk per placement;
   *  - after every structural asset-editor op, forward or inverse (undo / redo /
   *    draft replay all emit `editor-structure-changed`), coalesced;
   *  - after a field edit that holds a reference (fixing a path in the Inspector).
   */
  private _installReferenceAudit(): void {
    this.on('model-loaded', () => { this.auditReferences(); });
    this.on('placements-materialized', (info) => {
      if (!info.aborted) this.auditReferences();
    });
    const onLayoutContent = (): void => {
      if (this.placements.state === 'materializing') return;
      this._scheduleReferenceAudit();
    };
    this.on('layout-content-added', onLayoutContent);
    this.on('layout-content-removed', onLayoutContent);
    this.on('editor-structure-changed', () => this._scheduleReferenceAudit());
    this.on('component-field-changed', (e) => {
      const node = this.registry?.getNode(e.nodePath);
      const extras = node?.userData?.realvirtual as Record<string, unknown> | undefined;
      // Also when the field held a FINDING before (a path cleared to empty is no
      // reference any more, and its entry must still go).
      const hadFinding = this._lastReferenceAudit?.findings.some(
        (f) => f.referrerPath === e.nodePath && f.componentType === e.componentType && f.field === e.fieldName,
      ) ?? false;
      if (hadFinding || fieldHoldsReference(extras, e.componentType, e.fieldName)) this._scheduleReferenceAudit();
    });
    this.on('model-cleared', () => {
      this._cancelReferenceAudit();
      this._lastReferenceAudit = null;
    });
  }

  /**
   * Every model root currently parented to the scene. Normally this is just
   * `this.currentModel`, but a `_rvModelRoot`-tagged orphan can remain if a
   * previous switch tracked the wrong child as currentModel (see snapshot logic
   * in loadModel) — `clearModel` sweeps all of them.
   */
  private _modelRootsOnScene(): Set<Object3D> {
    const roots = new Set<Object3D>();
    if (this.currentModel) roots.add(this.currentModel);
    for (const child of this.scene.children) {
      if (child.userData?._rvModelRoot) roots.add(child);
    }
    return roots;
  }

  /**
   * Remove the current model and reset all simulation state.
   *
   * `opts.keepBaked` (plan-774 F6 — `loadModel` passes it, true unless told
   * otherwise): the placement instances are released as always, but their
   * BAKED assets stay in the cache for the next load (`PlacementInstancer
   * .clearDocument`). A direct call without it retires every bake.
   */
  clearModel(opts?: { keepBaked?: boolean; holdKept?: boolean }): void {
    clearBehaviorWaitSources(this);
    this.blockageWatch.reset();
    clearBlockageProblems();
    this.suppressGround('model', false);
    this._progressWiring?.dispose();
    this._progressWiring = null;
    this.blockageBudgets = null;
    // plan-537 F2b: a model change ends a running video capture (the engine
    // checks this reason between frames and restores the viewer).
    if (this._capture && !this._capture.abortReason) this._capture.abortReason = 'the model was changed during the capture';
    this.ribbonEditorPreview.onModelCleared();
    // Load-generation guard (plan-240 F9) — abort any BVH build still running
    // against the model being torn down (its geometries get disposed below).
    this._loadGeneration++;
    // plan-774: an overtaken load waiting on its shader precompile must reach
    // its abort check — the compile can never finish once its materials go.
    if (this._compileReleases.size > 0) {
      const releases = [...this._compileReleases];
      this._compileReleases.clear();
      for (const r of releases) r();
    }
    // plan-769 Phase 6: the old load's `whenModelLogicBuilt()` must not dangle —
    // released without its steps (callers guard with their own generation).
    const logicWaiter = this._mainLogicWaiter;
    this._mainLogicWaiter = null;
    logicWaiter?.resolve();
    this.logicRunState = 'active';
    this._signatureState = 'none';
    this._signatureModelName = '';
    this._signatureSignerOrganization = undefined;
    this._deferredLogic.length = 0;
    this._heldPlacementLogicRoots.length = 0;
    clearLogicGatedProblems();
    // plan-757 F9 / §2.6: per-document, like the gated-logic entries.
    clearOverrideOrphanedProblems();
    clearPluginClaimProblems();
    // plan-2016 Codex review: the Unity layer table belongs to the scene — the
    // next model registers its own (rv-layers.ts), masks rebuild by revision.
    resetLayerNames();
    // plan-757 Phase 2: refused nested references, the placement cap and
    // failed placement registrations are per-document as well.
    clearNestedReferenceProblems();
    // plan-757 Phase 3 commit A: a failed bake is a load error of the document
    // that failed; the next load starts with a clean slate.
    clearBakeFailedProblems();
    // plan-610 F9: the reference audit is about the document being dropped.
    this._cancelReferenceAudit();
    clearReferenceAuditProblems();
    // plan-769 Phase 0a (F16): instruction targets are checked per model — the
    // previous model's misses must not survive the switch.
    clearUnresolvedInstructionTargetProblems();
    // plan-769 Phase 1a (F4): the migration findings belong to the dropped document,
    // and a reference still waiting for one of its placements never resolves (F13).
    clearReferenceMigrationProblems();
    // The robot-IK diagnosis describes the rigs of the document being dropped —
    // a robot of the previous model must not keep an entry next to the next one.
    clearIkProblems();
    // plan-673 Phase 4: the physics document's findings, the axis-role audit
    // and the live overload / slip reports all describe the model being
    // dropped - and the next load has to re-audit, not inherit.
    this.axisDiagnostics.clear();
    clearMjcfProblems();
    this.registry?.dropPendingRefs('unloaded');
    this._lastBakeClaims = [];
    resetSignatureUiState();
    // plan-423 F6: nothing foreign is on screen once the model is gone. Doing
    // it HERE covers the failure path too — every load calls clearModel() first
    // and only republishes at the end, so a load that throws cannot leave the
    // previous model's trust record advertised for a scene that is no longer there.
    this._setModelProvenance(LOCAL_PROVENANCE);

    // plan-516 F4: hand every pre-placed MU (a sink may have detached it, a grip
    // may hold it, it may ride on a spawned carrier) back to the model tree on
    // its authored pose BEFORE anything is released — the model sweep below
    // must find and free it, and nothing may activate it again.
    this.transportManager?.restorePreplaced(false);

    // plan-2212 review #2: the open DES run is archived while every plugin
    // still holds its state (Model-Scripts and their KPI rows) - the kernel
    // dispose below would archive it only after the plugins cleared them.
    this._kernel?.archiveActiveRun();
    // Plugin lifecycle: clear exactly the plugins that received this model,
    // including plugins disabled since their onModelLoaded delivery.
    this._notifyPluginsModelCleared();
    // Placement bakes are DOCUMENT-scoped (plan-752 S1 / plan-753 F11): abandon
    // the materialisation queue, release core-owned instances, retire the bakes
    // — or keep them for the next load (plan-774 F6, the authoring join).
    // Every instance placed in the dropped model roots is released by this
    // call, host-registered ones (the planner's records) included: keep means
    // the ASSETS, never the instances of the previous document.
    this.placements.clearDocument({
      keepBaked: opts?.keepBaked === true,
      holdKept: opts?.holdKept === true,
      documentRoots: this._modelRootsOnScene(),
    });

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

    // Baked load (plan-753 Phase 4): release the in-place instance (chunk
    // meshes leave the tree, sources unmask) and retire the asset — the
    // loader owns it, there is no ModelCache to retire it; the chunk
    // geometries are guarded against the subtree dispose below by
    // `chunkMetaOf` and freed here at refcount 0.
    const bakeInstance = this._lastLoadResult?.bakeInstance;
    if (bakeInstance) this.bakeRegistry.release(bakeInstance);
    const bakedAsset = this._lastLoadResult?.bakedAsset;
    if (bakedAsset) {
      bakedAsset.retired = true;
      if (bakedAsset.instances === 0) bakedAsset.dispose();
    }
    this._lastLoadResult = null;
    this._mainDocumentLoadUrl = null;
    this._missedModelLoad.clear();

    this.selectionManager.clear();
    this.selectionManager.dispose();

    if (this.raycastManager) {
      this.energyChainManager.setRaycastHost(null);
      this.dropManager.setProbeHost(null);
      this.raycastManager.dispose();
      this.raycastManager = null;
    }
    this._instancePickIndex?.clear();
    this._instancePickIndex = null;
    // plan-766 F9: the editor arenas die with the model (source layers back,
    // arena-owned GPU resources freed, scene sink released).
    this.editorArena?.dispose();
    this.editorArena = null;

    // Drop the source-markers subscription before nulling out the transport
    // manager — otherwise future settings-store toggles would try to iterate
    // a stale source list.
    this._sourceMarkersUnsub?.();
    this._sourceMarkersUnsub = null;
    this._vanishMUsUnsub?.();
    this._vanishMUsUnsub = null;

    // plan-647 R3-1: tear the kernel down FIRST — a running DES FastForward
    // drain continues after its `yieldToBrowser()` and would keep driving the
    // old model (its own DES-manager queue is not part of the traffic
    // registries). `dispose()` cancels it synchronously, before anything below
    // tears the scene apart. The behaviour teardown that `model-cleared`
    // triggers later is no double teardown: the runners' dispose does not
    // unbind behaviours.
    this._kernel?.dispose();

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

    // Sweeping every model root on the scene (not only currentModel) ensures
    // we never end up with two scenes drawing simultaneously.
    const modelRootsToClear = this._modelRootsOnScene();

    // Toon mode swaps every mesh's material to a MeshToonMaterial. Restore the
    // original PBR materials BEFORE disposal so the MeshStandardMaterial-typed
    // teardown below frees them + their textures. Keeps toon active — the next
    // load re-converts via the `model-loaded` subscription.
    if (this._toon.isActive) this._toon.onModelClearing(modelRootsToClear);

    // plan-394 F12: drop the collision registry, highlight, signals and any
    // published cards BEFORE the geometry teardown.
    this.collisionManager.clear();
    // plan-2022: same timing and the same reason for the drop detection.
    this.dropManager.clear();
    // plan-427: drop every re-apply slot BEFORE the components behind them are
    // torn down, so a later reset/reconnect can never call a setter that closes
    // over a disposed instance.
    this.signalReapply.clear();
    // Ordinary components are not disposed on model switches, so drop their sections here.
    this.componentStats.clear();
    // Restore Lamp-owned material clones before the generic material teardown.
    this.lampManager.clear();
    // plan-529: dispose every WebLabel visual (canvas textures, plate geometry)
    // BEFORE the generic geometry teardown walks the model tree.
    this.webLabelManager.clear();
    // plan-543: the operator windows of the model's WebOperatorPanels go with it.
    this.webOperatorPanels.clear();
    // Same for the scene-button caps: dispose restores their authored material
    // and drops the lit/unlit clone pair BEFORE those originals are freed.
    this.sceneButtonManager.clear();
    // Same for EnergyChain rigs: dispose restores the original meshes and drops
    // the skinned sidecars BEFORE their shared geometry/materials are freed.
    this.energyChainManager.clear();
    // Same for Chain elements: dispose removes the runtime clones BEFORE the
    // shared template geometry/materials they reference are freed.
    this.chainManager.clear();
    // Same for the web: dispose drops the generated band geometry, the cloned
    // band texture and the procedural rolls BEFORE the generic geometry
    // teardown below frees what they reference.
    this.ribbonManager.clear();
    this.ribbonManager.setSignalWriter((address, value) => {
      this.signalStore?.setByPath(address, value);
    });
    // plan-405: destroy the worker-side SDF grids (frees their WASM linear
    // memory and unsubscribes every grid-bound listener) and dispose the chunk
    // geometries — BEFORE the generic geometry teardown below, which would
    // otherwise walk a subtree whose buffers the worker still writes into.
    this.machiningManager.clear();

    // After material deduplication, multiple meshes share the same material
    // instance. Use a Set to avoid disposing the same material/texture twice
    // across all roots being torn down in this pass.
    // ONE dedup set across all roots of this pass — deduplicated materials are
    // shared between them (plan-442: the traversal itself is the shared
    // primitive, the texture slots below are this caller's own teardown).
    const disposedMaterials = new Set<Material>();
    for (const root of modelRootsToClear) {
      this.scene.remove(root);
      disposeModelSubtree(root, {
        disposedMaterials,
        onMaterial: (material) => {
          const m = material as MeshStandardMaterial;
          m.map?.dispose();
          m.normalMap?.dispose();
          m.roughnessMap?.dispose();
          m.aoMap?.dispose();
          m.emissiveMap?.dispose();
          m.metalnessMap?.dispose();
          m.alphaMap?.dispose();
          m.envMap?.dispose();
        },
      });
    }
    this.currentModel = null;
    // plan-281 F12 / Finding #3: a smooth drive holds a context in the solver's
    // WASM linear memory. Dropping the JavaScript reference does NOT free it, so
    // every model switch would leak one context per smooth drive. clearModel()
    // is the only place that sees the whole population, so it is the place that
    // frees them. `dispose()` is idempotent and a no-op for non-smooth drives.
    for (const drive of this.drives) drive.dispose();
    this.drives = [];
    // Re-arm the once-per-model smooth-motion degradation warning.
    resetSmoothMotionDegradation();
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
    // plan-647 D1 (LOP #214): empty the AGV traffic registries — LAST, after
    // `model-cleared`. The emit runs the behaviour teardowns synchronously
    // (Agv: fleet unregister, authority unregister, zone releaseAll, spacing)
    // against still-filled registries; this reset then drops what no teardown
    // owned (paths — there is no general component dispose here — zones with
    // their declarations, docks, waiters, the clock). Fleet subscribers stay.
    resetTrafficRegistries();
    // plan-559 2b: the collision warnings are per model, not only per document
    // KEY — a reload of the SAME document (no key change) must not keep the old
    // model's entries once the collision is gone. Path ids also drop their
    // claimant bookkeeping (path components get no dispose here). After the
    // emit, so nothing in the teardown can re-report.
    clearSignalNameCollisionProblems();
    clearInstanceSignalCollisionProblems();
    resetPathIdCollisions();
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

  /** Source facts of the current (or loading) model — input of the script trust rule.
   *  Frozen: a consumer cannot rewrite what the trust rule reads. */
  get currentModelSource(): ModelLoadSource | null {
    return this._currentModelSource;
  }

  /**
   * Result of the last successful model load, or null.
   *
   * Read-only exposure of what the viewer already keeps for retroactive
   * `onModelLoaded` delivery. The scene write path needs one thing out of it —
   * the composition frames, which are the only record of which reference node
   * owns which grafted subtree, and therefore the only way a bake can route an
   * override to the right file (plan-397 §2.6).
   */
  get lastLoadResult(): LoadResult | null {
    return this._lastLoadResult;
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
   * imports into its document, and "open a GLB as the scene" is the model
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
  async loadScene(
    scene: RvScene,
    trust?: LoadTrustContext,
    opts?: { identityUrl?: string; data?: ArrayBuffer },
  ): Promise<void> {
    // Tracked for `whenSceneReady()`; the trust rule stays the one line below.
    return this.sceneLoadGate.track(this._loadSceneTrusted(scene, trust, opts));
  }

  private _loadSceneTrusted(
    scene: RvScene,
    trust?: LoadTrustContext,
    opts?: { identityUrl?: string; data?: ArrayBuffer },
  ): Promise<void> {
    return withLoadTrust(this._trustSlot, trust, () => this._loadSceneInner(scene, trust, opts));
  }

  private async _loadSceneInner(
    scene: RvScene,
    trust?: LoadTrustContext,
    opts?: { identityUrl?: string; data?: ArrayBuffer },
  ): Promise<void> {
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
    } else if (scene.base.kind === 'scene-glb') {
      // Never reached in normal operation, and deliberately loud rather than
      // guessed. A `scene-glb` base names a scene ID, not a URL: resolving it
      // means asking the storage layer for bytes, which depends on whether a
      // project is open. `SceneStore._loadIntoWorkspace` does that and hands
      // this method a scene whose base is already a resolvable `builtin`.
      // Inventing a URL here would put the knowledge of where scene bodies
      // live into the viewer, which is exactly what phase 6 kept out of it.
      throw new Error(
        'loadScene received an unresolved scene-glb base — resolve it through SceneStore first.',
      );
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
    // An untrusted scene load bypasses the main.ts progress hull on purpose:
    // that hull writes LS_KEY_MODEL and calls sceneStore.markGlbActive(), both
    // of which are exactly the receiver-side side effects F7 forbids.
    // `opts.identityUrl` is set when SceneStore resolved the body from storage
    // and `url` above is the resulting blob: — the workspace still knows which
    // model this is, and that knowledge must not stop here (see loadModel).
    // `opts.data` is set when SceneStore already holds the bytes and `url` is
    // only the name of the thing they ARE (plan-709 §2.5) — a self-contained
    // project asset, whose sentinel `rvproject:` URL is not fetchable and must
    // not be fetched. Handing the bytes down is what makes the object URL that
    // used to stand in for them unnecessary.
    const identityUrl = opts?.identityUrl;
    const data = opts?.data;
    // Any edit in the op log (added/moved/removed placements, nodes, overrides,
    // camera…) makes this a modified document for the script trust rule.
    const editedScene = scene.edits.ops.length > 0;
    // plan-769 Phase 7 (D23): moves / removals of placements the base file
    // holds (no `addPlacement` in the tail) — applied INSIDE the load, before
    // the planner adopts the placements (see `loadModel`).
    const baseline: BaselinePlacementEdits = {
      transforms: materialised.baselinePlacementTransforms,
      removed: materialised.removedPlacementIds,
    };
    const baselinePlacements = isEmptyBaselinePlacementEdits(baseline) ? undefined : baseline;
    if (this.loadModelWithProgress && (trust?.trusted ?? true)) {
      await this.loadModelWithProgress(url, {
        overlay,
        ...(identityUrl ? { identityUrl } : {}),
        ...(data ? { data } : {}),
        ...(editedScene ? { editedScene } : {}),
        ...(baselinePlacements ? { baselinePlacements } : {}),
      });
    } else {
      await this.loadModel(url, {
        overlay,
        ...(identityUrl ? { identityUrl } : {}),
        ...(data ? { data } : {}),
        ...(editedScene ? { editedScene } : {}),
        ...(trust ? { trust } : {}),
        ...(baselinePlacements ? { baselinePlacements } : {}),
      });
    }

    // Latest-wins for the phases BELOW (plan-442 F3). The `await` above only
    // covers overtaking up to its own resolution; everything from here on is
    // scene mutation that a newer load must not see. Capturing the generation
    // AFTER the load is what makes this run's own bump irrelevant — only a
    // LATER load moves it again.
    const sceneGeneration = this._loadGeneration;
    const abortIfSuperseded = (): void => {
      if (this._loadGeneration !== sceneGeneration) throw new LoadAbortedError(url);
    };

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
      abortIfSuperseded();
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

    // Phase 4b-removals (plan-628 8.7) — authored nodes removed persistently,
    // BEFORE the added nodes (an added node may reuse a removed name).
    if (this.registry && (materialised.removedNodes?.length ?? 0) > 0) {
      for (const p of materialised.removedNodes!) removeAuthoredSubtree(this.registry, p);
    }

    // Phase 4c — op-created nodes (e.g. inserted IK waypoints). Create them, then
    // re-resolve IK paths so their target lists pick up the new nodes (they didn't
    // exist when IKPath.init() ran during loadGLB).
    if (materialised.addedNodes.length > 0) {
      // plan-769 Phase 2: the id its `addNode` op minted (an op recorded before
      // plan-769 carries none — that node gets a fresh one for this session).
      for (const added of materialised.addedNodes) this.createComponentNode(added.spec, added.idMap?.node ?? newNodeId());
      this.rebuildIKPaths();
    }

    // Phase 4d — persisted node transforms (dragged IK waypoints on base-GLB
    // nodes; op-created nodes already carry theirs in the spec). Frozen-safe:
    // applyLocalPose rebuilds the local TRS from the baked matrices first.
    if (materialised.nodeTransforms.length > 0) {
      const { applyLocalPose } = await import('./engine/rv-node-transform');
      abortIfSuperseded();
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
    abortIfSuperseded();

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
    this._currentModelSource = null;
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
    this._coreSubsystems.dispose();
    if (this._deferredComponentHandler) {
      clearDeferredComponentHandler(this._deferredComponentHandler);
      this._deferredComponentHandler = null;
    }
    // plan-537 F2b: a running video capture must not restart the loop on a
    // disposed viewer — mark it so endCapture() only releases the lock.
    if (this._capture) {
      this._capture.disposed = true;
      this._capture.abortReason ??= 'the viewer was disposed during the capture';
    }
    // plan-2212 review #2: archive the open DES run while the plugins still
    // hold what it reads (script KPI rows) - they are disposed right below.
    this._kernel?.archiveActiveRun();
    // Plugin lifecycle: dispose (before everything else)
    for (const p of this._plugins) {
      callPlugin(p, 'dispose');
    }
    this.loop.stop();
    // Ray traced backend (plan-762 F7) before the pipeline and the renderer go.
    this._raytraced.dispose();
    // Tear down any active non-Three render backend (closes the WebRTC
    // PeerConnection / streaming instance) before the rest of teardown.
    this._renderBackends.dispose();
    this.clearModel();
    this._uninstallPathTopologyCheck?.();
    this._uninstallPathTopologyCheck = null;
    this.webOperatorPanels.dispose();
    this.signalUsage.dispose();
    // After the plugins released their placements (plan-753 F11).
    this.placements.dispose();
    // The highlighter subscribes to the module-level overlay-visibility store; without this
    // its closure (and through it the whole bake registry and every geometry buffer) outlived
    // the viewer in that store's listener set (plan-2059 O5: ~300 MB of ArrayBuffers per AGVDemo cycle).
    this.highlighter.dispose();
    // Final overlay-visibility teardown (plan-250): drop the GizmoManager's
    // store subscription (per-model dispose deliberately keeps it alive).
    this.gizmoManager.destroy();
    this.collisionManager.dispose();
    this.dropManager.dispose();
    // plan-427: release the module slot so a disposed viewer's registry can
    // never be handed to a later `processExtras` call. clearModel() above
    // already emptied it.
    if (getActiveSignalReapplyRegistry() === this.signalReapply) {
      setActiveSignalReapplyRegistry(null);
    }
    if (getActiveStatsRegistry() === this.componentStats) {
      setActiveStatsRegistry(null);
    }
    // Terminates the machining worker + frees the WASM instance. clearModel()
    // above already dropped the grids; this is the final teardown.
    this.machiningManager.dispose();
    // BVH build port lives across model loads (one reused worker) — only the
    // final viewer teardown terminates it.
    this._bvhPort?.dispose();
    this._bvhPort = null;
    // Same rule for the shared pick-build pool (plan-756 P3): it lives across
    // model loads and belongs to the session, so only the final teardown
    // terminates its workers.
    disposeSharedPickBuildPort();
    // Release the session's thumbnail object URLs (plan-776 F8). Lazy: the
    // store is only in memory if a card ever showed a saved preview.
    void import('./thumbnails/rv-thumbnail-url-store')
      .then((m) => m.clearThumbnailUrls())
      .catch(() => { /* nothing was ever resolved */ });
    // Free toon gradient / gbuffer RT / normal + Sobel materials. clearModel
    // (above) has already restored originals onto any meshes.
    this._toon.dispose();
    this._wireframeView.dispose();
    // Composer RTs + TSL post pipeline / desat blit (plan-271 Phase 3).
    this._postProcessing.dispose();
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.navController?.dispose();
    this._renderStrategy = null;
    this._strategyContext = null;
    this.navController = null;
    this._sceneScaleOff?.();
    this._sceneScaleOff = null;
    this._gestureActivityOff?.();
    this._gestureActivityOff = null;
    if (this._activityKeyHandler) {
      document.removeEventListener('keydown', this._activityKeyHandler, true);
      this._activityKeyHandler = null;
    }
    if (this._isolateEscapeHandler) {
      document.removeEventListener('keydown', this._isolateEscapeHandler, true);
      this._isolateEscapeHandler = null;
    }
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
    this._xrOff?.();
    this._xrOff = null;
    this._domAbort.abort();
    // The module-level chunk-bounds source points at this viewer's bake registry.
    clearChunkBoundsSource(this.bakeRegistry);
    this.controls.dispose();
    this.renderer.dispose();
    // Agent Eye Monitor (plan-481 D-A10): kill the pending macrotask, invalidate
    // every capture still queued and revoke every live object URL. Owned here and
    // NOT by the panel, which unmounts long before the viewer does.
    disposeAgentEyeMonitor();
    if (this.statsReady) {
      this.performanceStats.dispose();
      this.performanceStats.dom.remove();
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

    // plan-515 F2: 1 mm floor (was 10 cm) — a 5 mm part fills the view.
    const maxDim = fitFloor(Math.max(size.x, size.y, size.z));
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
  fitToNodes(nodes: Object3D[], offset?: ViewportOffset, opts?: { minDistance?: number; easing?: import('./rv-camera-manager').CameraEasing; duration?: number; tag?: string }): void {
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
    // plan-515 F2: 1 mm floor (was 10 cm). Opt-in `minDistance` callers keep theirs.
    const maxDim = fitFloor(Math.max(size.x, size.y, size.z));
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
    this.animateCameraTo(endPos, center, opts?.duration ?? 0.6, opts?.easing ?? 'easeOut', opts?.tag);
  }

  /** World bounds of the given nodes (baked nodes resolve through their chunk segments). */
  computeNodeBounds(nodes: Object3D[]): Box3 {
    return this._cameraManager.computeNodeBounds(nodes);
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
  isolateNodes(nodes: Object3D[], frame = true): void {
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
    // plan-766 F11: `.visible` written without an op.
    this.editorArena?.bumpVisibility();
    // `frame=false` keeps the DIMMING (shared document state, plan-740 D-U3)
    // but leaves the viewport where it is — the agent frames its own camera
    // instead, so `web_view_isolate` no longer drags a watching human's view.
    if (frame) this.fitToNodes(nodes);
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
    this.editorArena?.bumpVisibility();
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

    const maxDim = fitFloor(Math.max(size.x, size.y, size.z)); // plan-515 F2: 1 mm floor
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
   *
   * `root` narrows the walk to one subtree (the model root, for the ground
   * fit); it defaults to the whole scene. Everything else stays in this ONE
   * place (`computeContentBoundsInto`, shared with the embed), because a second
   * hand-rolled `Box3.setFromObject` is exactly how the ground disc and the
   * camera framing drifted apart: on a CAD import whose sources are scaled
   * 0.001, an arena's raw buffer bbox reads ~1000x too large, which grew the
   * floor to kilometres and threw the fit camera far outside the machine.
   */
  private _computeContentBounds(root?: Object3D): Box3 {
    // plan-515 Phase 1b: the walk itself is shared with the embed facade.
    return computeContentBoundsInto(root ?? this.scene, new Box3());
  }

  /**
   * Bounds of the content that moves while the simulation runs (plan-515
   * R3-1): the subtrees of the outermost drives (nested drives are inside
   * them) and every MU. Throttled by SceneScale (<= every 500 ms), so this may
   * allocate. Returns false when nothing moves.
   */
  private _computeMovingBounds(out: Box3): boolean {
    return computeMovingBoundsInto(
      this.drives, this.transportManager?.mus, (roots) => this._cameraManager.computeNodeBounds(roots), out,
    );
  }

  /** True while the simulation advances (runtime attached, not paused, a model loaded). */
  private _isSimulationAdvancing(): boolean {
    return !!this.currentModel && this.runtime.isAttached && !this.runtime.isPaused;
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
      // This entry point adds meshes into a LIVE, rendering scene. The worker
      // route detaches position/index buffers during a build; a first GPU
      // upload inside that window leaves the mesh permanently invisible
      // ("Insufficient buffer size" GL spam). Inline builds never detach.
      transferable: false,
    }).then((completed) => {
      if (completed && this._loadGeneration === generation) this.markRenderDirty();
    }).catch((e) => {
      console.warn('[viewer] async BVH build for imported subtree failed:', e);
    });
  }

  /**
   * Collect all InstancedMesh objects that serve as MU pools.
   * These are included in the raycast target list alongside the BVH meshes.
   */
  /**
   * Re-collect the MU instance pools as pick targets.
   *
   * The list is built once per model load. A plugin that creates MU pools later — or whose pool
   * swaps its `InstancedMesh` when it grows — calls this afterwards, or its instances can neither
   * be hovered nor selected (a customer SPI vehicle project, 2026-10-31).
   */
  refreshInstancedPickTargets(): void {
    this.raycastManager?.setInstancedMeshes(this._collectInstancedMeshes());
  }

  /** Returns the group registry, creating it when the loaded scene has no authored groups. */
  ensureGroups(): GroupRegistry {
    return this.groups ??= new GroupRegistry();
  }

  /** Creates an instanced pool for externally posed entities. */
  createEntityPool(options: EntityPoolOptions): EntityPool {
    return new EntityPool(this, options);
  }

  /** Registers a callback that runs before each frame's render decision. */
  onBeforeFrame(callback: (dtSeconds: number, nowMs: number) => void): () => void {
    this._beforeFrameCallbacks.push(callback);
    return () => {
      const index = this._beforeFrameCallbacks.indexOf(callback);
      if (index >= 0) this._beforeFrameCallbacks.splice(index, 1);
    };
  }

  private _collectInstancedMeshes(): import('three').InstancedMesh[] {
    const result: import('three').InstancedMesh[] = [];
    this.scene.traverse((node) => {
      if (node.userData?._muPool && (node as import('three').InstancedMesh).isInstancedMesh) {
        result.push(node as import('three').InstancedMesh);
      }
    });
    return result;
  }

  /**
   * The AI agent's own camera body (plan-740), or undefined when the
   * `agent-eye` plugin is not loaded — which is the case in the embed viewer,
   * since it loads no plugins at all.
   *
   * Resolved through the plugin rather than owned here: the viewer knows
   * nothing about the agent's pose, and every mutation of it goes through the
   * MCP tools or the plugin's attach handling.
   */
  get agentEye(): import('./engine/rv-agent-eye').AgentEye | undefined {
    return this.getPlugin<{ id: string; eye?: import('./engine/rv-agent-eye').AgentEye }>('agent-eye')?.eye;
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
  /**
   * True when the loaded model has a static shadow caster that covers the
   * whole scene at once — a baked chunk (plan-753) — which switches the
   * shadow camera to full-scene mode.
   */
  private _hasStaticCaster(): boolean {
    return (this._lastLoadResult?.bakedAsset?.chunks.length ?? 0) > 0;
  }

  private _fitShadowToView(): void {
    if (!this.dirLight.parent || !this.renderer.shadowMap.enabled) return;

    if (this._hasStaticCaster()) {
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
    // An explicit mode write supersedes a gated mode still waiting for its
    // backend registration (plan-762 F3).
    this._pendingRenderMode = null;
    const prevMode = this._visualSettings.lightingMode;
    // 0. Ray traced lifecycle (plan-762 F7): leaving drops the backend (epoch
    //    bump — a pending setup is discarded) BEFORE the new lighting applies.
    if (prevMode === 'raytraced' && mode !== 'raytraced') {
      this._raytraced.exit();
      this._syncRaytracedGroundDepth(false);
    }
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
    // 4. Entering ray traced starts the (async) backend build. Until it is
    //    ready the frame is the Shaded path without shadows / AO (F7).
    if (mode === 'raytraced') void this._raytraced.enter();
    this.emit('render-mode-changed', { mode });
  }

  // ─── Ray traced render mode (plan-762) ───────────────────────────────

  /** Viewer-side lifecycle of the ray traced mode (backend, epoch, host). */
  private _raytraced!: RaytracedModeController;
  /** True while the ray traced backend's `frame()` runs inside the render loop. */
  private _rtInFrame = false;
  /** A `requestRender()` from inside `frame()` — re-armed after the loop clears the dirty flag (F11). */
  private _rtRenderAgain = false;
  /** Status text of the ray traced mode while its structure builds (null = none). */
  private _raytracedStatusText: string | null = null;

  /** `web_status.raytraced` (F12): backend stats + phase; `active: false` without a backend. */
  get raytracedStats(): RaytracedStatus { return this._raytraced.stats(); }

  /**
   * plan-762 (Phase 3 live check): the ground fade disc is transparent with depthWrite off, so it
   * never reached the G-buffer depth, read as sky and received no traced shadow / AO. While the
   * ray traced composite runs it writes depth (the composite fades it back out by the MRT diffuse
   * alpha = the fade); otherwise the default (off) is restored.
   */
  private _syncRaytracedGroundDepth(on: boolean): void {
    const m = this._groundMesh?.material as Material | undefined;
    if (!m || m.depthWrite === on) return;
    m.depthWrite = on;
    m.needsUpdate = true;
  }

  /** The ray traced status line ("Building ray tracing structure…") or null. */
  get raytracedStatusText(): string | null { return this._raytracedStatusText; }

  /** Device limits of the real WebGPU device (null on webgl / webgpu-gl). */
  get webgpuDeviceLimits(): RaytracedDeviceLimits | null {
    const device = (this.renderer as unknown as { backend?: { device?: { limits?: GPUSupportedLimits } } }).backend?.device;
    const l = device?.limits;
    if (!this.hasCompute || !l) return null;
    return {
      maxStorageBufferBindingSize: l.maxStorageBufferBindingSize,
      maxBufferSize: l.maxBufferSize,
      maxStorageBuffersPerShaderStage: l.maxStorageBuffersPerShaderStage,
      maxComputeWorkgroupStorageSize: l.maxComputeWorkgroupStorageSize,
    };
  }

  private _createRaytracedController(): RaytracedModeController {
    return new RaytracedModeController({
      factory: () => getRaytracedBackend(),
      ensurePipeline: () => this._postProcessing.ensureTslPost(),
      pipeline: () => this._postProcessing.tslPost,
      isModeActive: () => this.renderMode === 'raytraced',
      sceneReady: () => this.currentModel !== null && !this.sceneLoadGate.loading && this.placements.state === 'idle',
      whenSceneReady: () => this.whenSceneReady(),
      fallbackToDefault: () => setRenderMode(this, 'default'),
      requestRender: () => {
        this._renderDirty = true;
        if (this._rtInFrame) this._rtRenderAgain = true;
      },
      status: (text) => {
        this._raytracedStatusText = text;
        if (text) logInfo(text);
      },
      subscribe: (event, cb) => {
        if (event === 'topology') {
          // Placed content arriving / leaving. The backend additionally polls
          // its own cheap per-frame signals (pool counts, plan-762 F8).
          const offAdded = this.on('layout-content-added', () => cb());
          const offGroups = this.on('groups-changed', (e) => { if (e.source === 'placement') cb(); });
          return () => { offAdded(); offGroups(); };
        }
        if (event === 'model-cleared') return this.on('model-cleared', () => cb());
        if (event === 'placements-materialized') return this.on('placements-materialized', () => cb());
        return () => {};
      },
      scene: {
        renderer: this.renderer,
        scene: this.scene,
        camera: () => this.camera,
        modelRoot: () => this.currentModel,
        environment: () => ({
          hdrUrl: this._visualSettings.environmentHdrUrl,
          rotation: this.scene.environmentRotation,
          intensity: this.scene.environment ? this.scene.environmentIntensity : 0,
        }),
        groundPlane: () => {
          const g = this._groundMesh;
          if (!g || !g.visible) return null;
          const mat = g.material as MeshStandardMaterial;
          return {
            x: g.position.x, y: g.position.y, z: g.position.z,
            // The fade disc is a 200 × 200 plane scaled per model (_updateGroundPlane).
            extent: g.scale.x * 200,
            color: mat.color ?? this._groundColor,
          };
        },
        deviceLimits: () => this.webgpuDeviceLimits,
      },
    });
  }

  /**
   * WebGPU `device.lost` (plan-762 F7): a `destroyed` loss is our own
   * `renderer.dispose()`; anything else means the shared renderer is dead —
   * emit the context-lost event (reload hint, like `webglcontextlost`) and
   * drop the ray traced backend quietly.
   */
  private _onWebGPUDeviceLost(info: { reason?: string | null; message?: string }): void {
    if (info.reason === 'destroyed') return;
    console.error('[RVViewer] WebGPU device lost:', info.message ?? info.reason ?? 'unknown reason');
    this._raytraced.onDeviceLost();
    this.emit('renderer-context-lost', undefined);
  }

  /**
   * The render-mode gate context of this viewer (plan-762 F2/F18). Read LIVE on
   * every access — `hasCompute` from the instance (a test may override it with
   * `Object.defineProperty`), `backendRegistered` from the ray traced hook. The
   * UI, `view.renderMode` and the MCP tools resolve modes only through
   * `availableRenderModes` / `resolveRenderMode` with this context.
   */
  get renderModeContext(): RenderModeContext {
    return { hasCompute: this.hasCompute === true, backendRegistered: getRaytracedBackend() !== null };
  }

  /**
   * A gated mode requested at load time (persisted / URL) on a WebGPU viewer
   * before the private plugins registered its backend — rendered as the default
   * mode until {@link resolvePendingRenderMode} decides. `null` = nothing pending.
   */
  private _pendingRenderMode: RenderMode | null = null;

  /**
   * Resolve a gated render mode left pending by {@link applyVisualSettings}
   * (plan-762 F3). `main.ts` calls this once, right after
   * `registerPrivatePlugins`: when the mode's backend is registered now, the
   * mode is entered; otherwise the viewer stays on the default mode and the
   * persisted value is corrected. No-op when nothing is pending.
   */
  resolvePendingRenderMode(): void {
    const pending = this._pendingRenderMode;
    if (!pending) return;
    this._pendingRenderMode = null;
    if (isRenderModeAvailable(pending, this.renderModeContext)) {
      setRenderMode(this, pending);
      return;
    }
    this._correctPersistedRenderMode(pending);
  }

  /**
   * Map a requested mode through the registry gate for a load-time apply
   * (plan-762 F3). Available → itself. Gated, compute present but no backend
   * registered yet → pending (default rendered, store untouched). Otherwise →
   * the default mode, and the persisted value is corrected at once.
   */
  private _resolveLoadRenderMode(requested: RenderMode): RenderMode {
    const ctx = this.renderModeContext;
    if (isRenderModeAvailable(requested, ctx)) {
      this._pendingRenderMode = null;
      return requested;
    }
    if (getRenderMode(requested).requires === 'compute' && ctx.hasCompute && !ctx.backendRegistered) {
      this._pendingRenderMode = requested;
      return DEFAULT_RENDER_MODE;
    }
    this._pendingRenderMode = null;
    this._correctPersistedRenderMode(requested);
    return DEFAULT_RENDER_MODE;
  }

  /** Rewrite a persisted unavailable `renderMode` to the default (only if it is still the stored value). */
  private _correctPersistedRenderMode(unavailable: RenderMode): void {
    const stored = loadVisualSettings();
    if (stored.renderMode !== unavailable) return;
    saveVisualSettings({ ...stored, renderMode: DEFAULT_RENDER_MODE });
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

  // ─── Wireframe view (asset editor) ─────────────────────────────────────

  /**
   * The editor's wireframe view toggle: the document's meshes are drawn as
   * uniform unlit lines, on top of whatever render mode is active. In-memory
   * only (off after a reload) and effective only in editor mode — see
   * {@link wireframeActive}.
   */
  get wireframe(): boolean { return this._wireframeOn; }
  set wireframe(on: boolean) {
    if (this._wireframeOn === on) return;
    this._wireframeOn = on;
    this._syncWireframe();
    this.emit('wireframe-changed', { on });
  }

  /** True while the wireframe view is actually drawn (toggle on + editor mode). */
  get wireframeActive(): boolean { return this._wireframeApplied; }

  /** Bring the applied state in line with toggle + mode. Idempotent. */
  private _syncWireframe(): void {
    const apply = this._wireframeOn && this.modes.activeMode === 'editor';
    if (apply === this._wireframeApplied) return;
    this._wireframeApplied = apply;
    this._toon.setSuppressed(apply);
    // Hover / selection highlight the wires themselves instead of fill + edges.
    this.highlighter.setWireframeMode(apply);
    this.selectionManager.refreshHighlight();
    // ...and picking follows the wires, not the (undrawn) front surface.
    this.raycastManager?.setWirePickMode(apply);
    if (!apply && this._wireframeSaved) {
      const saved = this._wireframeSaved;
      this._wireframeSaved = null;
      if (saved.shadow) this.shadowEnabled = true;
      if (saved.ao !== 'off') this.aoMode = saved.ao;
      if (saved.reflection) this.reflectionEnabled = true;
    }
    this.markShadowsDirty();
    this._renderDirty = true;
  }

  /**
   * Shadows, ambient occlusion and the floor reflection are computed from the
   * full surfaces — under a model made of lines they read as a bug. Checked per
   * rendered frame (three getters) instead of once at toggle time, because a
   * render-mode switch or a settings apply turns them back on from the
   * persisted values; whatever comes back is remembered for the restore.
   */
  private _suppressWireframeEnvironment(): void {
    const saved = (this._wireframeSaved ??= { shadow: false, ao: 'off', reflection: false });
    if (this.shadowEnabled) { saved.shadow = true; this.shadowEnabled = false; }
    if (this.aoMode !== 'off') { saved.ao = this.aoMode; this.aoMode = 'off'; }
    if (this.reflectionEnabled) { saved.reflection = true; this.reflectionEnabled = false; }
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
  applyVisualSettings(requestedSettings: import('./hmi/visual-settings-store').VisualSettings): void {
    // plan-762 F3: the registry gate for a load-time / URL / preset mode. A
    // gated mode the viewer cannot offer renders as the default mode (and is
    // either corrected in the store or left pending for its backend).
    const effectiveMode = this._resolveLoadRenderMode(requestedSettings.renderMode);
    const settings = effectiveMode === requestedSettings.renderMode
      ? requestedSettings
      : { ...requestedSettings, renderMode: effectiveMode };
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

    // 7b. Render resolution (plan-591 F2/F11). `maxDpr` used to be missing from
    //     this batch, so a preset switch left the resolution at whatever the
    //     previous one had set — only the boot path and the Visual tab's slider
    //     ever applied it, and "Max Quality" would have stayed soft. The
    //     renderer's pixel ratio is also the one input of the composer's
    //     buffers, and a composer that already exists keeps its own ratio: so
    //     the post manager has to follow, or the beauty pass turns sharp while
    //     the AO/bloom buffers stay coarse. `syncPixelRatio` creates no
    //     composer and is a no-op on WebGPU (which never has one).
    this.maxDpr = settings.maxDpr ?? 1.5;
    this._postProcessing.syncPixelRatio();

    // 8. SSAO — only when the mode supports it
    this.aoMode = caps.ambientOcclusion ? (settings.aoMode ?? 'gtao') : 'off';
    this.ssaoIntensity = settings.ssaoIntensity ?? 1.0;
    this.ssaoRadius = settings.ssaoRadius ?? 0.15;

    // 9. Bloom — only when the mode supports it
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
    // Mouse-wheel zoom anchor: cursor (default) or canvas centre; orbit / pan
    // anchor: controls.target (default) or the surface point under the cursor.
    if (this.navController) {
      this.navController.wheelZoomToCursor = settings.wheelZoomToCursor ?? true;
      this.navController.navigateAroundCursorPoint = settings.navigateAroundCursorPoint ?? false;
    }

    // 12. Drive axis gizmo overlay (plan-249)
    this.showDriveAxisGizmo = settings.showDriveAxisGizmo ?? true;

    // 13. Render frame-rate limit (plan-568) — not a preset field, so a preset
    //     switch re-applies the user's stored value unchanged.
    this.fpsCap = settings.fpsCap ?? 0;
  }

  // ─── Individual Rendering Settings (pure-delegation proxies) ───────────

  /** @deprecated Use `viewer.visualSettings.effectiveDpr` instead. Will be removed in v2.0. */
  get effectiveDpr(): number { return this._visualSettings.effectiveDpr; }

  /** @deprecated Use `viewer.visualSettings.maxDpr` instead. Will be removed in v2.0. */
  set maxDpr(cap: number) { this._visualSettings.maxDpr = cap; }

  /**
   * Render frame-rate limit (plan-568): 0 = Off, 30 or 60 frames per second.
   * Only the render dispatch is limited — the simulation integrates every
   * frame unchanged. Never applied while an XR session presents or a video
   * capture runs, and suppressed during perf measurements. An unsupported
   * value falls back to Off.
   */
  get fpsCap(): FpsCap { return this._fpsCap; }
  set fpsCap(cap: FpsCap) {
    const v: FpsCap = isFpsCap(cap) ? cap : 0;
    this._fpsCap = v;
    this.loop.minFrameInterval = fpsCapToFrameInterval(v);
  }

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
   * Ambient-occlusion backend: 'off' | 'gtao' | 'n8ao'. Composer passes on WebGL, the TSL GTAO node
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

  /** Whether bloom (glow on bright areas) is enabled — both renderers (plan-763). */
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
  get showStats(): boolean { return this.statsReady && this.performanceStats.dom.style.display !== 'none'; }
  set showStats(v: boolean) { if (this.statsReady) this.performanceStats.dom.style.display = v ? '' : 'none'; }

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

  /**
   * plan-756 memory gate for the MAIN MODEL (`web_status.bake`): pick-structure
   * bytes, CSR node-table bytes / rows, segments, clusters, the geometry bytes
   * they accelerate and the resulting percentage. `null` when nothing is baked.
   *
   * Deliberately the loaded model's own `BakedAsset`, not the registry: the
   * registry's `stats()` also counts planner placements (they share the
   * viewer's registry), and the 5 % gate is read per model.
   */
  getMainModelPickStats(): (PickMemoryStats & { pickMode: 'structure' | 'linear' }) | null {
    const baked = this._lastLoadResult?.bakedAsset ?? null;
    if (!baked) return null;
    // `pickMode` (plan-757 Phase 3 commit B): `linear` = the structure-free
    // walk is on for every chunk (`rv-webviewer-pick-structure` = 0).
    const pickMode = this._pickBackend?.usesStructure === false ? 'linear' : 'structure';
    return { ...pickMemoryStats([baked]), pickMode };
  }

  /** Load-time metadata/interaction stats of the current model (or null). */
  getMetadataLoadStats(): { metadataNodes: number; aabbCount: number; aabbBuildMs: number; hoverableFaceRanges: number } | null {
    return this._lastLoadResult?.metadataStats ?? null;
  }

  /**
   * Get renderer performance info (triangles, draw calls, etc.).
   *
   * `drawCalls` / `triangles` are the main SCENE pass of the last rendered
   * frame — what "draw calls" means to anyone reading the number. The full
   * per-pass split (shadow, AO, outline, post, overlay, plugins, total) is
   * `frame`, which is the viewer's live accounting object (reference-stable,
   * mutated in place each rendered frame — copy it if you need to keep it).
   */
  getRendererInfo(): {
    /** Scene-pass triangles of the last rendered frame (NOT the load-time model count — see `lastLoadResult.triangleCount`). */
    triangles: number;
    /** Scene-pass draw calls of the last rendered frame. */
    drawCalls: number;
    /** Per-pass accounting of the last rendered frame (rv-frame-stats.ts). */
    frame: FrameStats;
    /** GPU-resident BufferGeometry objects (`info.memory.geometries`). */
    geometries: number;
    /** GPU-resident textures INCLUDING render-target textures (`info.memory.textures`). */
    textures: number;
    /** Render targets owned by the composer, its passes and the shadow map — explains part of `textures`. */
    renderTargets: number;
    programs: number;
    /** Mesh nodes of the loaded model (counted at load, 0 when nothing is loaded). */
    meshCount: number;
    /** Live baked instances of the viewer's registry (plan-753 Phase 3): the
     *  in-place baked model AND the planner placements, which share this
     *  registry. Carries the plan-756 memory-gate numbers (pick structure +
     *  CSR node table against the chunk geometry bytes). */
    bake: ReturnType<BakeRegistry['stats']>;
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
    /** Loader bake of the current model (plan-753 Phase 4): chunks / keep
     *  meshes / triangles of the in-place `BakedAsset`, 0 when not baked. */
    loaderBake: { chunks: number; keep: number; triangles: number; sources: number };
  } {
    const info = this.renderer.info;
    const dedup = this._lastLoadResult?.dedupResult;
    const uber = this._lastLoadResult?.uberResult;
    const baked = this._lastLoadResult?.bakedAsset ?? null;
    const composer = this._postProcessing.composer;
    return {
      // triangles / drawCalls are the SCENE pass of the last complete frame
      // (see _frame). Reading info.render directly would give the sum over
      // every pass — shadow, AO, outline, bloom, overlay, plugins.
      triangles: this._frame.scene.triangles,
      drawCalls: this._frame.scene.calls,
      frame: this._frame,
      geometries: (info as unknown as { memory?: { geometries?: number } }).memory?.geometries ?? 0,
      textures: (info as unknown as { memory?: { textures?: number } }).memory?.textures ?? 0,
      renderTargets: countRenderTargets(composer, this.dirLight?.shadow?.map ?? null, this._groundReflector?.renderTargets() ?? []),
      programs: (info as unknown as { programs?: unknown[] }).programs?.length ?? 0,
      meshCount: this._lastLoadResult?.meshCount ?? 0,
      bake: this.bakeRegistry.stats(),
      materialsOriginal: dedup?.originalCount ?? 0,
      materialsUnique: dedup?.uniqueCount ?? 0,
      uberBakedMeshCount: uber?.bakedMeshCount ?? 0,
      uberSharedGeometryReuses: uber?.sharedGeometryReuses ?? 0,
      uberClonedGeometryCount: uber?.clonedGeometryCount ?? 0,
      uberDisposedSourceGeometries: uber?.disposedSourceGeometries ?? 0,
      loaderBake: {
        chunks: baked?.chunks.length ?? 0,
        keep: baked?.keep.length ?? 0,
        triangles: baked?.triangles ?? 0,
        sources: baked ? baked.chunks.reduce((n, c) => n + c.pick.segmentCount, 0) : 0,
      },
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
   * @param tag       Optional owner tag; `cancelCameraAnimation(tag)` cancels only this flight.
   * @param updateEndpoint Refresh a moving destination on each animation tick.
   */
  animateCameraTo(position: Vector3, target: Vector3, duration = 0.6, easing: import('./rv-camera-manager').CameraEasing = 'easeOut', tag?: string, updateEndpoint?: (position: Vector3, target: Vector3) => void): void {
    this._cameraManager.animateCameraTo(position, target, duration, easing, tag, updateEndpoint);
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

  /**
   * Start orbit-follow of a moving target (keeps relative offset). Orbit stays
   * live: a right-drag / one-finger drag of the NavigationController turns
   * about the carried target (plan-515 Phase 2), the wheel and pinch zoom, a
   * pan is inert. A drag 'start' still lets an agent-eye follow let go first.
   */
  startCameraFollow(src: FollowSource, owner: CameraFollowOwner = 'selection'): void {
    this._cameraManager.startFollow(src, owner);
    this.markRenderDirty();
  }

  /** Start sit-on: ride the target's pose with free mouse look (perspective only). */
  startCameraSitOn(src: FollowSource, seat?: Vector3, owner: CameraFollowOwner = 'selection'): void {
    this._cameraManager.startSitOn(src, seat, owner);
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

  /** Owner and source of the active follow, or null when inactive. */
  get cameraFollowOwner(): CameraFollowOwner | null { return this._cameraManager.followOwner; }
  get cameraFollowSource(): FollowSource | null { return this._cameraManager.followSource; }

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
   *  Wraps multiple property writes that previously went directly to `viewer.controls.X = val`.
   *  `wheelZoomToCursor` switches the mouse-wheel zoom anchor of the NavigationController
   *  (true = cursor, the default; false = canvas centre); `navigateAroundCursorPoint`
   *  switches the orbit / pan anchor (false = controls.target, the default; true = the
   *  surface point under the cursor). */
  setControlsConfig(cfg: Partial<{ rotateSpeed: number; panSpeed: number; zoomSpeed: number; dampingFactor: number; enabled: boolean; wheelZoomToCursor: boolean; navigateAroundCursorPoint: boolean }>): void {
    this._controls.setConfig(cfg);
  }

  /** Toggle verbose renderer-info logging. Used by DevTools panel.
   *  Replaces direct `viewer.rendererInfoLogging = v` writes. */
  setDebugLogging(enabled: boolean): void {
    this.rendererInfoLogging = enabled;
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private lastHoveredDrive: RVDrive | null = null;
  /** Node of the last emitted 'object-hover' — a changed node emits even when the pointer stood still. */
  private lastEmittedHoverNode: import('three').Object3D | null = null;
  private lastHoverClientX = 0;
  private lastHoverClientY = 0;
  private lastRenderTime = 0;
  /** Shadow map dirty flag — when false, shadow pass is skipped entirely. */
  private _shadowsDirty = true;
  /** The session's shared uber material — see {@link ensureUberMaterial}.
   *  Survives `clearModel()` on purpose (plan-752 S2). */
  private _uberMaterial: RVUberMaterial | null = null;
  /** Max shadow padding from model load (scene-wide coverage). */
  private _shadowPadMax = 100;
  /** Render dirty flag — when false, renderer.render() is skipped (Phase 4: render-on-demand). */
  private _renderDirty = true;
  /** The installed render strategy (plan-2215) — null = the unchanged mono path. */
  private _renderStrategy: RenderStrategy | null = null;
  /** Set by renderFrameForCapture(): this frame renders mono even with a strategy. */
  private _strategyBypass = false;
  /** The current strategy frame already rendered the shadow map. */
  private _strategyShadowDone = false;
  /** The back buffer holds a frame a render strategy drew (see {@link strategyFrame}). */
  private _strategyFrame = false;
  /** The pixel ratio before the installed strategy fixed its own (`RenderStrategy.pixelRatio`). */
  private _dprBeforeStrategy: number | null = null;
  private _sizeBeforeStrategy: Vector2 | null = null;
  /** Canvas size scratch for the strategy path (no allocation per frame). */
  private readonly _strategySize = new Vector2();
  /** The reused strategy context (fields refreshed per frame). */
  private _strategyContext: { -readonly [K in keyof RenderStrategyContext]: RenderStrategyContext[K] } | null = null;
  /** Open shader pre-compiles ({@link _precompileModelShaders}). While > 0, `render()` draws
   *  nothing — a frame drawn mid-compile would link every pending program synchronously. */
  private _compileRenderHold = 0;
  /** plan-774: resolvers of the precompile waits a `clearModel()` releases (see `_precompileModelShaders`). */
  private readonly _compileReleases = new Set<() => void>();
  /** Consecutive main-render failures — see {@link _recoverFromRenderException}. */
  private _renderFailStreak = 0;
  /** The last render()'s main pass threw (plan-537 F2d, read by renderFrameForCapture). */
  private _lastRenderFailed = false;
  /** Running video capture (plan-537) — null when live. See beginCapture(). */
  private _capture: CaptureState | null = null;
  /**
   * Per-pass draw-call / triangle accounting of the most recent rendered
   * frame (rv-frame-stats.ts). Mutated in place during `render()` — never
   * reallocated, so `getRendererInfo().frame` is reference-stable — and left
   * untouched on frames the render-on-demand gate skips, so the 200ms
   * DevTools poll always sees the last COMPLETE frame.
   */
  private readonly _frame: FrameStats = createFrameStats();
  /** Seconds of render time remaining for damping decay after the last user
   *  input (Phase 4). Time-based (plan-568) so the decay window is the same at
   *  30, 60 or 144 rendered frames per second. */
  private _dampingSecondsRemaining = 0;
  /** Render frame-rate limit (plan-568), see {@link fpsCap}. */
  private _fpsCap: FpsCap = 0;
  /** Reference to the ground plane mesh (if created). */
  private _groundMesh: Mesh | null = null;
  /** The user's ground setting — see {@link groundEnabled}. */
  private _groundUserEnabled = true;
  /** Owners currently hiding the ground — see {@link suppressGround}. */
  private readonly _groundSuppressors = new Set<string>();
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
  /** Optional floor reflection mirror — the WebGL `Reflector` adapter, or the
   *  TSL mirror created lazily once the TSL module is loaded (plan-763). Null
   *  without a ground plane. */
  private _groundReflector: GroundReflector | null = null;
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
    this._simTime += scaleSimDt(dt);

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
    this._progressWiring?.fixedStep();

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
   *
   * `camera` defaults to the navigation camera; a render strategy passes the
   * camera of each of its views (plan-2215), so overlays sit where that view
   * draws the scene. Under an active scissor only that rectangle's depth clears.
   */
  private _renderOverlayLayers(camera: Camera = this.camera): void {
    const gl = this.renderer as unknown as WebGLRenderer;
    const prevAutoClear = gl.autoClear;
    const prevLayerMask = camera.layers.mask;
    gl.autoClear = false;
    const savedBg = this.scene.background;
    this.scene.background = null;
    try {
      setOverlayLayersOnly(camera);
      gl.clearDepth();
      gl.render(this.scene, camera);
    } finally {
      this.scene.background = savedBg;
      camera.layers.mask = prevLayerMask;
      gl.autoClear = prevAutoClear;
    }
  }

  /** `RenderStrategyContext.renderViewport` — scene pass + overlay pass into one rectangle. */
  private _renderStrategyViewport(rect: Readonly<ViewportRect>, camera: Camera): void {
    const gl = this.renderer as unknown as WebGLRenderer;
    gl.setViewport(rect.x, rect.y, rect.w, rect.h);
    gl.setScissor(rect.x, rect.y, rect.w, rect.h);
    gl.setScissorTest(true);
    // Shadows once per frame: only the first view of the frame may update the map.
    if (this._strategyShadowDone) (gl.shadowMap as unknown as { needsUpdate: boolean }).needsUpdate = false;
    const prevMask = camera.layers.mask;
    disableOverlayLayers(camera);
    try {
      gl.render(this.scene, camera);
    } finally {
      camera.layers.mask = prevMask;
      this._strategyShadowDone = true;
    }
    this._renderOverlayLayers(camera);
  }

  /**
   * The strategy branch of `render()`. Returns true when the strategy drew the
   * frame (its overlay passes included). On a throw the strategy is removed,
   * the frame renders mono, then `onFailed` runs exactly once (also when the
   * mono fallback throws — that throw reaches render()'s recovery) — returns
   * false, so the generic overlay pass completes the mono frame. The render
   * target bound at entry is restored before viewport and scissor.
   */
  private _renderWithStrategy(strategy: RenderStrategy, frameDt: number): boolean {
    const gl = this.renderer as unknown as WebGLRenderer;
    gl.getSize(this._strategySize);
    // The render-resolution setting may have changed the DPR meanwhile — the strategy's wins.
    if ((strategy.pixelRatio !== undefined && gl.getPixelRatio() !== strategy.pixelRatio)
      || (strategy.canvasSize && (this._strategySize.x !== strategy.canvasSize.width
        || this._strategySize.y !== strategy.canvasSize.height))) {
      this._applyStrategyPixelRatio(strategy);
      gl.getSize(this._strategySize);
    }
    let ctx = this._strategyContext;
    if (!ctx) {
      ctx = {
        renderer: gl,
        scene: this.scene,
        monoCamera: this.camera,
        canvasWidth: 0,
        canvasHeight: 0,
        frameDt: 0,
        renderViewport: (rect, camera) => this._renderStrategyViewport(rect, camera),
        renderOverlayLayers: (camera) => this._renderOverlayLayers(camera),
      };
      this._strategyContext = ctx;
    }
    ctx.renderer = gl;
    ctx.scene = this.scene;
    ctx.monoCamera = this.camera;
    ctx.canvasWidth = this._strategySize.x;
    ctx.canvasHeight = this._strategySize.y;
    ctx.frameDt = frameDt;
    this._strategyShadowDone = false;
    // The target the frame started on (the back buffer, or whatever the caller bound):
    // a strategy that binds its own target and throws must not leave it bound.
    const prevTarget = gl.getRenderTarget();
    const prevCubeFace = gl.getActiveCubeFace();
    const prevMipLevel = gl.getActiveMipmapLevel();
    let failure: unknown = null;
    let failed = false;
    try {
      strategy.renderFrame(ctx);
    } catch (err) {
      failed = true;
      failure = err;
    } finally {
      // Target first: setRenderTarget re-applies the stored viewport, which is reset right after.
      if (gl.getRenderTarget() !== prevTarget || gl.getActiveCubeFace() !== prevCubeFace
        || gl.getActiveMipmapLevel() !== prevMipLevel) {
        gl.setRenderTarget(prevTarget, prevCubeFace, prevMipLevel);
      }
      gl.setScissorTest(false);
      gl.setScissor(0, 0, this._strategySize.x, this._strategySize.y);
      gl.setViewport(0, 0, this._strategySize.x, this._strategySize.y);
    }
    if (!failed) return true;
    console.error('[RVViewer] render strategy failed — removed, rendering mono:', failure);
    if (this._renderStrategy === strategy) this._removeRenderStrategy(true);
    try {
      // The mono frame: the plain path (the generic overlay pass follows in render()).
      // A throw here propagates to render()'s recovery — onFailed still runs exactly once.
      disableOverlayLayers(this.camera);
      this.renderer.render(this.scene, this.camera);
    } finally {
      try {
        strategy.onFailed(failure);
      } catch (err) {
        console.error('[RVViewer] render strategy onFailed threw:', err);
      }
    }
    return false;
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
   *
   * Returns false when the frame's main render pass threw (the viewer's
   * self-healing recovery ran, but the drawing buffer holds a broken frame) or
   * when the Three render path is paused — plan-537 F2d: a video capture
   * aborts instead of encoding it.
   */
  renderFrameForCapture(): boolean {
    if (!this._renderBackends.shouldRenderThree()) return false;
    this._renderDirty = true;
    this._lastRenderFailed = false;
    // Captures stay mono (plan-2215): a render strategy is bypassed for this
    // frame, and the next live frame redraws the strategy's views.
    this._strategyBypass = true;
    try {
      this.render();
    } finally {
      this._strategyBypass = false;
      if (this._renderStrategy) this._renderDirty = true;
    }
    return !this._lastRenderFailed;
  }

  // ─── Video capture hooks (plan-537) ───────────────────────────────────
  //
  // Internal API for `rv-video-capture.ts`. A capture stops the live loop,
  // owns size, DPR, camera and render-time clock, steps the simulation through
  // the production fixed tick and renders frame by frame. Everything it changes
  // is saved by beginCapture() and restored by endCapture() — callers MUST
  // pair them in try/finally.

  /**
   * Record a deterministic MP4 of the loaded model (plan-537) — the entry the
   * CLI (`npm run record`) drives through `page.evaluate`. Lazy-imports the
   * capture engine and the muxer, so neither costs the normal viewer anything.
   */
  async recordVideo(
    options: import('./engine/rv-video-capture').VideoRecordOptions,
  ): Promise<import('./engine/rv-video-capture').VideoRecordResult> {
    const { recordVideo } = await import('./engine/rv-video-capture');
    return recordVideo(this, options);
  }

  /**
   * Encode a sequence of image frames into an MP4 in the browser (plan-550) —
   * the CLI muxes the PNG frames of a cinematic recording through this.
   * Lazy-imports the capture engine and the muxer like {@link recordVideo}.
   */
  async muxVideoFrames(
    options: import('./engine/rv-video-capture').MuxFramesOptions,
  ): Promise<import('./engine/rv-video-capture').MuxFramesResult> {
    const { muxVideoFrames } = await import('./engine/rv-video-capture');
    return muxVideoFrames(options);
  }

  /**
   * One image of the 3D scene (plan-557 `captureStill`) — the entry the CLI's `--still` drives
   * (plan-556 F5b: with `resetSimulation` + `steps` the image shows a defined sim state, so the
   * lazy import cannot change it). The dialog calls `captureStill` directly (no await before the
   * take-over).
   */
  async captureStill(
    options: import('./engine/rv-video-capture').StillCaptureOptions,
  ): Promise<import('./engine/rv-video-capture').StillCaptureResult> {
    const { captureStill } = await import('./engine/rv-video-capture');
    return captureStill(this, options);
  }

  private _recordingHmi: RecordingHmiApi | null = null;

  /**
   * The recording HMI (plan-556): recording UI context, HMI settle per frame, the 3D underlay and
   * the layer mode — driven by the CLI (`npm run record -- --hmi …`) and the record dialog's tab
   * capture. See `engine/rv-recording-hmi.ts`.
   */
  get recordingHmi(): RecordingHmiApi {
    if (!this._recordingHmi) {
      this._recordingHmi = createRecordingHmiApi({
        leftPanelManager: this.leftPanelManager,
        webOperatorPanels: this.webOperatorPanels,
        // Operator panels registered as plugins (OperatorPanelPlugin): a controller + a window slot.
        operatorPanelPluginIds: () => this._plugins
          .filter((p) => (p as { controller?: unknown }).controller instanceof OperatorPanelController)
          .map((p) => p.id),
      });
    }
    return this._recordingHmi;
  }

  /**
   * The comparable state of this viewer (plan-600 F5). THE one collector, so a
   * golden pulled from Playwright (`page.evaluate`) and one pulled from a
   * vitest test are the same projection — see `rv-state-snapshot.ts`.
   */
  collectStateSnapshot(): StateSnapshot {
    return collectStateSnapshot(this);
  }

  /** True while a video capture owns the viewer (the session lock, F2b). */
  get isCapturing(): boolean { return this._capture !== null; }

  /** Why the running capture must stop (model change, dispose), else null. */
  get captureAbortReason(): string | null { return this._capture?.abortReason ?? null; }

  /** Sizes of the render pass during the running capture (output × supersample). */
  get captureRenderSize(): { width: number; height: number } | null {
    const c = this._capture;
    return c ? { width: c.renderWidth, height: c.renderHeight } : null;
  }

  /** GPU limits the capture caps its supersampled render size against (F11). */
  getCaptureGpuLimits(): { maxTextureSize: number; maxRenderbufferSize: number; maxViewportWidth: number; maxViewportHeight: number } {
    const gl = (this.renderer as unknown as WebGLRenderer).getContext?.() as WebGL2RenderingContext | undefined;
    if (!gl || typeof gl.getParameter !== 'function') {
      return { maxTextureSize: 4096, maxRenderbufferSize: 4096, maxViewportWidth: 4096, maxViewportHeight: 4096 };
    }
    const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | number[] | null;
    return {
      maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096,
      maxRenderbufferSize: Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)) || 4096,
      maxViewportWidth: vp ? Number(vp[0]) : 4096,
      maxViewportHeight: vp ? Number(vp[1]) : 4096,
    };
  }

  /**
   * Preflight of the supported capture states (plan-537 F1b). Returns the
   * reason a capture cannot start, or null. Never changes the viewer.
   */
  capturePreflight(): string | null {
    if (this._capture) return 'A video capture is already running on this viewer.';
    if (this.isWebGPU) return 'Video capture needs the WebGL renderer (WebGPU is not supported in v1).';
    if (!this._renderBackends.shouldRenderThree()) return 'The Three.js render path is paused (another render backend is active).';
    if ((this.renderer as unknown as WebGLRenderer).xr?.isPresenting) return 'Video capture is not possible during an XR session.';
    if (!this.currentModel) return 'No model is loaded.';
    if (this.logicRunState !== 'active') return 'The model logic is not active (signature gate) — the simulation cannot run.';
    if (!this.runtime.isAttached) return 'The simulation runtime is detached (editor mode) — switch to a simulating mode first.';
    if (this._kernel?.mode === 'des') return 'Video capture supports the continuous simulation only (DES mode is active).';
    if (this.transportManager?.preplacedActivationBlocked) return 'This viewer follows a multiuser session — record on the host instead.';
    if (liveControlledCount() > 0) return 'Signals are live-controlled by an interface — video capture needs the local simulation.';
    return null;
  }

  /**
   * Take over the viewer for a video capture (plan-537 F2/F2b/F2c/F5b/F11):
   * stop the live loop, force DPR 1, size every target to `width × height ×
   * supersample`, suspend wall-clock effects (selection, hover, ping/flash,
   * pulsing outlines), take the camera, scale pixel-based sizes by the
   * supersample factor and optionally raise AO/bloom and shadow resolution.
   * Throws if the preflight fails; everything is restored by {@link endCapture}.
   */
  beginCapture(opts: {
    width: number;
    height: number;
    supersample?: number;
    frameDt: number;
    fullResPost?: boolean;
    shadowMapSize?: number | null;
    /** plan-557 F2c: WebLabel reference height (px); absent / null = the output height. */
    labelReferenceHeight?: number | null;
  }): void {
    const reason = this.capturePreflight();
    if (reason) throw new Error(reason);
    const ss = Math.max(1, Math.floor(opts.supersample ?? 1));
    const rw = opts.width * ss;
    const rh = opts.height * ss;
    const gl = this.renderer as unknown as WebGLRenderer;
    const canvas = gl.domElement;
    const size = gl.getSize(new Vector2());
    const cam = this._activeCamera;
    const persp = cam as PerspectiveCamera;
    const ortho = cam as OrthographicCamera;
    const composer = this._postProcessing.composer as unknown as { _pixelRatio?: number; setPixelRatio?(r: number): void } | null;

    const outline = this.outlineManager;
    const outlineStyles: OutlineStyle[] = [
      { ...outline.getStyle() }, { ...outline.getHoverStyle() }, { ...outline.getChainStyle() },
      { ...outline.getStatusStyle() }, { ...outline.getFlashStyle() },
    ];
    const toon = this._toon;
    const lineMats: CaptureLineMaterial[] = [];
    this.scene.traverse((o) => {
      const mat = (o as Mesh).material as Material | Material[] | undefined;
      if (!mat) return;
      for (const m of Array.isArray(mat) ? mat : [mat]) {
        const lm = m as Material & { isLineMaterial?: boolean; resolution?: Vector2 };
        if (lm.isLineMaterial && lm.resolution && !lineMats.some((e) => e.mat === lm)) {
          lineMats.push({ mat: lm as CaptureLineMaterial['mat'], w: lm.resolution.x, h: lm.resolution.y });
        }
      }
    });

    const state: CaptureState = {
      outputWidth: opts.width,
      outputHeight: opts.height,
      labelReferenceHeight: typeof opts.labelReferenceHeight === 'number' && opts.labelReferenceHeight > 0 ? opts.labelReferenceHeight : null,
      renderWidth: rw,
      renderHeight: rh,
      supersample: ss,
      frameDt: opts.frameDt,
      clockSec: 0,
      abortReason: null,
      disposed: false,
      resizePending: false,
      loopWasRunning: (this.loop as unknown as { running?: boolean }).running === true,
      dpr: gl.getPixelRatio(),
      composerDpr: composer?._pixelRatio ?? null,
      cssWidth: size.x,
      cssHeight: size.y,
      perspAspect: this.perspCamera.aspect,
      camera: cam,
      camPos: cam.position.clone(),
      camQuat: cam.quaternion.clone(),
      camUp: cam.up.clone(),
      camZoom: cam.zoom,
      camNear: cam.near,
      camFar: cam.far,
      camFov: persp.isPerspectiveCamera ? persp.fov : 0,
      orthoFrustum: ortho.isOrthographicCamera ? [ortho.left, ortho.right, ortho.top, ortho.bottom] : null,
      controlsTarget: this.controls.target.clone(),
      controlsEnabled: this.controls.enabled,
      controlsDamping: this.controls.enableDamping,
      selection: [...this.selectionManager.selectedPaths],
      raycastEnabled: this.raycastManager?.enabled ?? null,
      pointerEvents: canvas.style.pointerEvents,
      outlineStyles,
      toonThickness: toon.outlineThickness,
      ppScale: this._postProcessing.bufferScale,
      shadowMapSize: this.dirLight.shadow.mapSize.x,
      shadowChanged: false,
      lineMats,
    };
    this._capture = state;

    // Loop + clock: the capture drives every frame from here on (F9 — no rAF).
    this.loop.stop();
    this.lastRenderTime = 0;
    // Scene-scale bounds tick starts fresh on the capture clock (determinism).
    this.sceneScale.tick(0, false);

    // Suspend wall-clock effects (F1): selection + hover + ping/flash cleared,
    // pulsing outlines frozen, input off.
    if (state.selection.length > 0) this.selectionManager.clear();
    this.highlighter.clear();
    this.highlighter.clearPing();
    this.highlighter.clearFlash();
    this.raycastManager?.setEnabled(false);
    canvas.style.pointerEvents = 'none';
    this.controls.enabled = false;
    this.controls.enableDamping = false;
    this._dampingSecondsRemaining = 0;

    // Pixel-based sizes scale with the supersample factor (Phase 1 audit list).
    outline.setStyle({ pulsePeriod: 0, edgeThickness: outlineStyles[0].edgeThickness * ss });
    outline.setHoverStyle({ pulsePeriod: 0, edgeThickness: outlineStyles[1].edgeThickness * ss });
    outline.setChainStyle({ pulsePeriod: 0, edgeThickness: outlineStyles[2].edgeThickness * ss });
    outline.setStatusStyle({ pulsePeriod: 0, edgeThickness: outlineStyles[3].edgeThickness * ss });
    outline.setFlashStyle({ pulsePeriod: 0, edgeThickness: outlineStyles[4].edgeThickness * ss });
    if (ss !== 1) {
      toon.setOutline(toon.outlineAmount, state.toonThickness * ss, toon.outlineThreshold, toon.outlineColorHex, toon.outlineDistance);
    }

    // Size (F2c): DPR 1, every target at the render size, camera aspect.
    gl.setPixelRatio(1);
    composer?.setPixelRatio?.(1);
    this._applyCaptureSize(rw, rh, opts.width / opts.height);
    if (opts.fullResPost) this._postProcessing.applyHalfRes(1);
    const shadowSize = opts.shadowMapSize ?? 0;
    if (shadowSize > 0 && this.dirLight.castShadow && shadowSize !== state.shadowMapSize) {
      this._setShadowMapSize(shadowSize);
      state.shadowChanged = true;
    }
    this._shadowsDirty = true;
    this._renderDirty = true;
  }

  /** Advance the simulation by `steps` production fixed ticks of 1/60 s (F2e). */
  captureStep(steps: number, fixedDt = 1 / 60): void {
    if (!this._capture) throw new Error('captureStep() outside a capture');
    for (let k = 0; k < steps; k++) this.fixedUpdate(fixedDt);
  }

  /**
   * Place the capture camera (F5b): position, look-at target, optional fov
   * (perspective). Matrices are updated here; no controls / damping involved.
   */
  setCaptureCameraPose(position: Vector3, target: Vector3, fov?: number | null): void {
    const c = this._capture;
    if (!c) throw new Error('setCaptureCameraPose() outside a capture');
    const cam = this._activeCamera;
    cam.position.copy(position);
    cam.up.copy(c.camUp);
    this.controls.target.copy(target);
    cam.lookAt(target);
    const persp = cam as PerspectiveCamera;
    if (persp.isPerspectiveCamera && fov != null && Number.isFinite(fov) && fov > 0 && persp.fov !== fov) {
      persp.fov = fov;
      persp.updateProjectionMatrix();
    }
    cam.updateMatrixWorld(true);
    // The camera moved: a view-fitted shadow camera must re-fit (same rule as
    // the OrbitControls 'change' handler).
    if (!this._hasStaticCaster()) this._shadowsDirty = true;
    this._renderDirty = true;
  }

  /**
   * Render one capture frame at capture time `timeSec` (F1/F2d). `frameDt` is
   * the render-time delta handed to render-time ticks (1/fps for the first
   * sub-render of a frame, 0 for further jittered sub-renders). `jitterX/Y`
   * shift the projection by a sub-pixel offset of the RENDER grid (F11 `max`).
   * Returns false when the frame failed — the caller aborts.
   */
  captureRenderFrame(timeSec: number, frameDt: number, jitterX = 0, jitterY = 0): boolean {
    const c = this._capture;
    if (!c) throw new Error('captureRenderFrame() outside a capture');
    c.clockSec = timeSec;
    c.frameDt = frameDt;
    // Fat lines: `linewidth` is in pixels of `resolution`. Pinning resolution
    // to the OUTPUT size keeps their width identical after the downscale (a
    // plugin may have reset it from the canvas CSS size meanwhile).
    for (let i = 0; i < c.lineMats.length; i++) c.lineMats[i].mat.resolution.set(c.outputWidth, c.outputHeight);
    const cam = this._activeCamera;
    const jittered = jitterX !== 0 || jitterY !== 0;
    if (jittered) cam.setViewOffset(c.renderWidth, c.renderHeight, jitterX, jitterY, c.renderWidth, c.renderHeight);
    try {
      return this.renderFrameForCapture();
    } finally {
      if (jittered) cam.clearViewOffset();
    }
  }

  /**
   * Hand the viewer back after a capture — ALWAYS called (finally), also after
   * an error or abort. Restores everything {@link beginCapture} saved and
   * restarts the loop only if it was running before (F2b).
   */
  endCapture(): void {
    const c = this._capture;
    if (!c) return;
    this._capture = null;
    if (c.disposed) return; // a disposed viewer only releases the lock
    const gl = this.renderer as unknown as WebGLRenderer;
    const canvas = gl.domElement;

    // Pixel sizes, post scale, shadow map.
    const outline = this.outlineManager;
    outline.setStyle(c.outlineStyles[0]);
    outline.setHoverStyle(c.outlineStyles[1]);
    outline.setChainStyle(c.outlineStyles[2]);
    outline.setStatusStyle(c.outlineStyles[3]);
    outline.setFlashStyle(c.outlineStyles[4]);
    const toon = this._toon;
    if (toon.outlineThickness !== c.toonThickness) {
      toon.setOutline(toon.outlineAmount, c.toonThickness, toon.outlineThreshold, toon.outlineColorHex, toon.outlineDistance);
    }
    for (const e of c.lineMats) e.mat.resolution.set(e.w, e.h);
    this._postProcessing.applyHalfRes(c.ppScale > 0 ? c.ppScale : PP_SCALE);
    if (c.shadowChanged) this._setShadowMapSize(c.shadowMapSize);

    // Camera.
    const cam = c.camera;
    cam.clearViewOffset();
    cam.position.copy(c.camPos);
    cam.quaternion.copy(c.camQuat);
    cam.up.copy(c.camUp);
    cam.zoom = c.camZoom;
    cam.near = c.camNear;
    cam.far = c.camFar;
    const persp = cam as PerspectiveCamera;
    if (persp.isPerspectiveCamera) persp.fov = c.camFov;
    this.controls.target.copy(c.controlsTarget);
    this.controls.enableDamping = c.controlsDamping;
    this.controls.enabled = c.controlsEnabled;

    // Size + DPR (F2c): a resize queued during the capture is replayed through
    // the regular handler; otherwise the saved size comes back.
    gl.setPixelRatio(c.dpr);
    const composer = this._postProcessing.composer as unknown as { setPixelRatio?(r: number): void } | null;
    composer?.setPixelRatio?.(c.composerDpr ?? c.dpr);
    this._applyCaptureSize(c.cssWidth, c.cssHeight, c.perspAspect);
    const ortho = cam as OrthographicCamera;
    if (ortho.isOrthographicCamera && c.orthoFrustum) {
      [ortho.left, ortho.right, ortho.top, ortho.bottom] = c.orthoFrustum;
    }
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);

    // Input + selection.
    canvas.style.pointerEvents = c.pointerEvents;
    if (c.raycastEnabled !== null) this.raycastManager?.setEnabled(c.raycastEnabled);
    if (c.selection.length > 0) this.selectionManager.selectPaths(c.selection);

    this.lastRenderTime = 0;
    this._shadowsDirty = true;
    this._renderDirty = true;
    if (c.resizePending && this.resizeHandler) this.resizeHandler();
    if (c.loopWasRunning) this.loop.start();
  }

  /** Size renderer, post-processing, outline and toon targets together, set aspect. */
  private _applyCaptureSize(w: number, h: number, aspect: number): void {
    this.perspCamera.aspect = aspect;
    this.perspCamera.updateProjectionMatrix();
    this._cameraManager.syncOrthoFrustum();
    this.renderer.setSize(w, h, false);
    this._postProcessing.setSize(w, h);
    this.outlineManager.setSize(w, h);
    this._toon.setSize(w, h);
  }

  /** Change the directional shadow-map resolution (old map disposed, re-rendered). */
  private _setShadowMapSize(size: number): void {
    const shadow = this.dirLight.shadow;
    if (this.isWebGPU) invalidateNodeShadowBindings(this.renderer, this.dirLight, size); // plan-767 run 4
    shadow.mapSize.set(size, size);
    // WebGL re-creates a nulled map on the next shadow pass. The WebGPURenderer
    // OWNS `shadow.map` (its ShadowNode sets it once and resizes it on a
    // mapSize change, ShadowNode.js:585/704); disposing it there destroys a
    // texture the node keeps binding — every later submit is rejected and the
    // canvas stays grey (plan-763).
    if (shadow.map && !this.isWebGPU) {
      shadow.map.dispose();
      shadow.map = null as unknown as typeof shadow.map;
    }
    shadow.camera.updateProjectionMatrix();
    this._shadowsDirty = true;
    this._renderDirty = true;
  }

  /**
   * Keep the viewer alive when a render pass throws mid-frame. The aborted
   * frame stops at the crashing object, so everything sorted after it is
   * missing from the presented image — repeated crashes look like "parts of
   * the model disappeared" and, once the loop dies, a frozen/blank viewport.
   *
   * Known signature: `… toArray is not a function` from three's
   * PureArrayUniform.setValueV4fArray — a material's `clippingPlanes`
   * uniform received the raw Plane[] instead of the projected Float32Array
   * (race between the Section tool's plane attach and the material's
   * program/uniform rebuild; seen on GLB assets whose materials carry
   * section planes at load, delta-robot bug #10). Self-heal: force a
   * program + clipping-uniform rebuild on every material that carries
   * section planes; if the crash persists, strip the planes entirely —
   * losing the section cut beats a dead viewport.
   *
   * Returns true when the frame is worth retrying on the next tick.
   */
  private _recoverFromRenderException(err: unknown): boolean {
    this._renderFailStreak++;
    const msg = String((err as Error | undefined)?.message ?? err);
    const isClippingUniformCrash = msg.includes('toArray is not a function');
    if (this._renderFailStreak <= 3 || this._renderFailStreak % 300 === 0) {
      console.error(
        `[RVViewer] render pass failed (streak ${this._renderFailStreak})`
        + (isClippingUniformCrash ? ' — clipping-uniform corruption, self-healing' : ''),
        err,
      );
    }
    // The frame aborted mid-pass: bound program / blend / depth state can be
    // stale. Reset three's GL state cache so the next frame starts clean.
    (this.renderer as unknown as WebGLRenderer).state?.reset?.();

    if (isClippingUniformCrash) {
      const strip = this._renderFailStreak >= 3;
      this.scene.traverse((o) => {
        const mat = (o as Mesh).material as
          | { clippingPlanes?: Plane[] | null; needsUpdate: boolean }
          | { clippingPlanes?: Plane[] | null; needsUpdate: boolean }[]
          | undefined;
        if (!mat) return;
        for (const m of Array.isArray(mat) ? mat : [mat]) {
          if (m.clippingPlanes && m.clippingPlanes.length > 0) {
            if (strip) m.clippingPlanes = null;
            m.needsUpdate = true; // rebuild program, re-wire the clipping uniform
          }
        }
      });
      // Aux gbuffer / outline / AO override materials mirror the planes.
      if (strip) this.setSectionClippingPlanes(null);
      return this._renderFailStreak <= 6; // a few healed retries, then give up
    }
    // Unknown crash: retry once (transient), then wait for the next
    // invalidation instead of burning a crash loop.
    return this._renderFailStreak <= 1;
  }

  /**
   * `controls.update()` with a frame-time-scaled damping factor (plan-568):
   * OrbitControls applies its `dampingFactor` once per call, so at 30 rendered
   * frames per second the glide would last twice as long. The configured
   * factor is restored right after the update.
   */
  private _updateControlsTimeBased(frameDt: number): void {
    const c = this.controls;
    if (!c.enableDamping) { c.update(); return; }
    const base = c.dampingFactor;
    c.dampingFactor = timeScaledDampingFactor(base, frameDt);
    try { c.update(); } finally { c.dampingFactor = base; }
  }

  private render(): void {
    // Render-pause / non-Three backend (plan-256): skip ALL Three GPU work and
    // the per-frame plugin `onRender` dispatch below. This is the render-loop
    // side of the backend switch — `fixedUpdate` (drives, sensors, logic) and
    // the WS signal-flush run in the SEPARATE `onFixedUpdate` loop callback and
    // are unaffected, so live HMI values keep updating over the Omniverse
    // stream. Also centrally neutralises the interactive 3D plugins.
    if (!this._renderBackends.shouldRenderThree()) return;
    // Shader pre-compile in flight: skip the frame, `_renderDirty` stays set so the
    // first frame after the compile draws.
    if (this._compileRenderHold > 0) return;

    // A new frame: world matrices are stale until the main pass (or the first
    // auxiliary pass, see renderAuxiliaryPass) walks them.
    this._auxMatricesFresh = false;
    if (this.statsReady) this.performanceStats.begin();
    // plan-537 F1: ONE source for the render-time clock. Live = wall clock;
    // during a video capture = the deterministic capture clock (sim time since
    // the capture began, advanced by exactly 1/fps per encoded frame).
    const capture = this._capture;
    let now: number;
    let frameDt: number;
    if (capture) {
      now = capture.clockSec;
      frameDt = capture.frameDt;
    } else {
      now = performance.now() / 1000;
      frameDt = this.lastRenderTime > 0 ? Math.min(now - this.lastRenderTime, 0.1) : 0.016;
    }
    this.lastRenderTime = now;
    this.ribbonEditorPreview.onRender(frameDt);

    // FPS counter (updated every 500ms)
    this.fpsFrameCount++;
    this.fpsAccumTime += frameDt;
    if (this.fpsAccumTime >= 0.5) {
      this.currentFps = Math.round(this.fpsFrameCount / this.fpsAccumTime);
      this.currentFrameTime = +(this.fpsAccumTime / this.fpsFrameCount * 1000).toFixed(1);
      this.fpsFrameCount = 0;
      this.fpsAccumTime = 0;
    }

    const nowMs = now * 1000;
    for (const plugin of this._beforeFramePlugins) {
      try { plugin.onBeforeFrame!(frameDt, nowMs); } catch (error) {
        console.error(`[RVViewer] Plugin '${plugin.id}' onBeforeFrame error:`, error);
      }
    }
    for (const callback of this._beforeFrameCallbacks) {
      try { callback(frameDt, nowMs); } catch (error) {
        console.error('[RVViewer] onBeforeFrame callback error:', error);
      }
    }
    if (capture) {
      // plan-537 F5b: the capture owns the camera — camera / projection
      // animations, follow, navigation inertia, damping and OrbitControls are
      // SUSPENDED (not re-timed) and resume where they were after the capture.
      // The scene-scale bounds tick runs on the capture clock with the
      // simulation counted as advancing (the capture steps it).
      this.sceneScale.tick(nowMs, true);
    } else {
      this._cameraManager.tickCameraAnimation(frameDt);
      // Camera animation keeps render dirty
      if (this._cameraManager.isCameraAnimating) this._renderDirty = true;
      // plan-515: moving-content bounds while the simulation runs (throttled,
      // grow-only), then the accumulated wheel (one pick per frame) + dynamic
      // near/far, BEFORE the projection animation reads its endpoint matrices.
      this.sceneScale.tick(nowMs, this._isSimulationAdvancing());
      this.navController?.tick(nowMs);
      // Projection animation: lerps the active camera's projection matrix in
      // place, so the renderer needs to redraw every frame for the duration.
      this._cameraManager.tickProjectionAnimation(frameDt);
      if (this._cameraManager.isProjectionAnimating) this._renderDirty = true;
      // Follow / Sit-On tracking — MUST run before controls.update() so the
      // carried orbit target / camera pose isn't overwritten (sets _renderDirty
      // while a mode is active).
      this._cameraManager.tickFollow(frameDt);
      // Damping: keep rendering for the decay window after last user input
      // (seconds of render time, plan-568 — independent of the frame rate).
      if (this._dampingSecondsRemaining > 0) {
        this._dampingSecondsRemaining -= frameDt;
        this._renderDirty = true;
      }
      if (this.controls.enabled) this._updateControlsTimeBased(frameDt);
    }
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
    // plan-529 SOL R2-1: WebLabel screen size / fade / toggle run HERE — in the
    // render path, after the camera update and before the render-dirty
    // evaluation — every frame, whether the simulation runs, is paused or the
    // editor is open. A change marks the frame dirty.
    // plan-537 F2c: during a capture the label screen size is relative to the
    // OUTPUT height (the canvas CSS height is the window's, not the video's).
    if (capture) {
      if (this.webLabelManager.update(this.camera, capture.labelReferenceHeight ?? capture.outputHeight)) this._renderDirty = true;
    } else if (this.webLabelManager.tick()) this._renderDirty = true;

    // A pending shadow-dirty flag MUST trigger a render, otherwise the
    // flag would be consumed below without the shadow map ever being
    // regenerated (shadowMap.render only runs inside renderer.render).
    if (this._shadowsDirty) this._renderDirty = true;

    // XR sessions MUST render every frame — the compositor needs a submitted
    // frame each animation tick or the passthrough/scene will freeze.
    const glXR = (this.renderer as unknown as WebGLRenderer).xr;
    if (glXR?.isPresenting) this._renderDirty = true;

    if (this._wireframeApplied) this._suppressWireframeEnvironment();

    // Render-on-demand: skip expensive GPU render when scene is static
    const didMainRender = this._renderDirty;
    const isXRPresentingNow = (this.renderer as unknown as WebGLRenderer).xr?.isPresenting;
    const isolateActiveNow = this.groups?.isIsolateActive || this.autoFilters?.isIsolateActive;
    // Set by the TSL post branch: the pipeline composited the overlay layers
    // in-graph, so the post-plugin overlay pass below must NOT run. Under the
    // WebGPURenderer a `renderer.render()` after `RenderPipeline.render()`
    // goes through three's frame-buffer target and its output blit replaces
    // the finished frame with that target's stale content (grey screen).
    let overlayComposited = false;
    // plan-2215: a render strategy drew the frame (its overlay passes included).
    let strategyRendered = false;
    if (this._renderDirty) {
      // Shadow dirty flag handling lives INSIDE the render block so a
      // pending shadow update isn't silently cleared on a skipped frame.
      if (this._shadowsDirty) {
        this._fitShadowToView();
      }
      (this.renderer.shadowMap as unknown as { needsUpdate: boolean }).needsUpdate = this._shadowsDirty;
      this._shadowsDirty = false;

      // Manually reset per-frame counters (autoReset was disabled during
      // renderer setup) so the per-pass deltas below (rv-frame-stats.ts)
      // measure THIS frame only.
      (this.renderer.info as unknown as { reset(): void }).reset();
      const frameInfo = this.renderer.info as unknown as RenderInfoLike;
      const frame = this._frame;
      resetFrameStats(frame);
      // The ground reflector's onBeforeRender books its mirror renders into
      // whichever frame is active here (it cannot reach the viewer).
      setActiveFrameStats(frame);
      // Idempotent (marker on the shadow-map object): the shadow pass is a
      // nested render — booked to `shadow`, taken out of the running pass.
      instrumentShadowMap((this.renderer as unknown as { shadowMap?: ShadowMapLike }).shadowMap, frameInfo, frame);
      // Save and restore camera layer mask / autoClear across the render
      // branch so an exception in any pass can't corrupt global renderer
      // state for subsequent frames. autoClear is WebGL-specific, so cast
      // for the getter/setter.
      const prevLayerMask = this.camera.layers.mask;
      const glForClearState = this.renderer as unknown as WebGLRenderer;
      const prevAutoClear = glForClearState.autoClear;
      let renderFailed = false;
      let retryRender = false;
      const __frameT0 = performance.now();
      // ONE world-matrix walk per frame. `renderer.render` walks
      // `scene.updateMatrixWorld()` on every call — scene pass, AO gbuffer, both
      // reflector mirrors, shadow — and nothing moves between the passes of one
      // frame. On a large model that walk was the frame (profile 2026-09-17).
      const prevSceneMatrixAuto = this.scene.matrixWorldAutoUpdate;
      this.scene.updateMatrixWorld();
      this._auxMatricesFresh = true;
      this.scene.matrixWorldAutoUpdate = false;
      // plan-766 §2.1 pre-frame seam: editor arenas sync instance matrices and
      // visibility against the fresh world matrices, once per frame, BEFORE the
      // first pass (plugin onRender runs after the main render — too late).
      this.editorArena?.beforeFrame();
      // Wireframe view: line material on for exactly this frame's passes (the
      // overlay pass below runs after the restore, with its own materials).
      // The floor is hidden for the same passes — per frame, so the persisted
      // ground setting (`groundEnabled`) never sees the wireframe view.
      const wireGround = this._wireframeApplied && this._groundMesh?.visible ? this._groundMesh : null;
      if (wireGround) wireGround.visible = false;
      // plan-766 F10: the wireframe draws the SOURCE meshes — editor arenas go
      // into capture mode for exactly this frame (swapOut leaves it).
      if (this._wireframeApplied) {
        this._wireframeView.swapIn(this.currentModel, this._isSceneFixture, this.editorArena);
      }
      try {
        // XR sessions must always go through the direct renderer path —
        // EffectComposer renders to its own offscreen render targets, and
        // the multi-pass isolate mode clears/overlays in ways that break
        // the XR compositor. Passthrough camera would still show, but no
        // 3D content lands in the XR framebuffer → invisible scene.
        const xrPresenting = (this.renderer as unknown as WebGLRenderer).xr?.isPresenting;
        if (xrPresenting) {
          const c0 = drawCallsOf(frameInfo), t0 = frameInfo.render.triangles;
          this.renderer.render(this.scene, this.camera);
          addDelta(frame.scene, frameInfo, c0, t0);
        } else if (
          this._renderStrategy !== null && !capture && !this._strategyBypass && this._renderStrategy.active
        ) {
          // plan-2215 render strategy (stereo, wall): N views into canvas
          // rectangles, each with its own camera and overlay pass. Isolate,
          // composer and TSL post are skipped; captures stay mono.
          const c0 = drawCallsOf(frameInfo), t0 = frameInfo.render.triangles;
          strategyRendered = this._renderWithStrategy(this._renderStrategy, frameDt);
          addDelta(frame.scene, frameInfo, c0, t0);
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
          // Per-pass accounting: wrap any not-yet-wrapped pass (OutlinePass /
          // N8AO / sobel arrive after composer construction). The toon
          // prepass above is unwrapped on purpose and lands in `other`.
          instrumentComposerPasses(composer.passes, frameInfo, frame, [gtaoPass, n8cam]);
          composer.render();
        } else if (this._postProcessing.useTslPost) {
          // TSL node post-processing (plan-271 Phase 3) — WebGPURenderer
          // paths. RenderPipeline.render() REPLACES renderer.render(): the
          // scene pass + effect graph (AO / outlines / saturation) render
          // internally and the final quad lands in the default framebuffer.
          // Overlay layers stay excluded here and render in the post-plugin
          // overlay pass below — same contract as the composer branch.
          disableOverlayLayers(this.camera);
          // The pipeline's pass nodes are instrumented at build time
          // (`instrumentTslPasses` via the host hook) and book themselves into
          // scene / ao / outline / post / overlay, subtracting from the host
          // bucket — so the whole pipeline is booked as `post` here and what
          // stays in `post` is the output quad plus bloom.
          this._ensureGroundReflectorTsl();
          // Ray traced mode (plan-762 F17): the kernel runs exactly when this
          // branch renders, BEFORE the scene pass (it reads the previous
          // pass's G-buffer + matrices, spike 0.c). Isolate / XR never get
          // here; wireframe and video capture show the raster output through
          // the composite (mix 0, no rebuild) and pause the kernel — the
          // history is kept.
          this._syncRaytracedGroundDepth(this._raytraced.ready);
          let rtDispatched = false;
          if (this._raytraced.ready) {
            const paused = this._wireframeApplied || this._capture !== null;
            this._postProcessing.tslPost?.setRaytracedMix(paused ? 0 : 1);
            if (!paused) {
              this._rtInFrame = true;
              try {
                this._raytraced.frame();
                rtDispatched = true;
              } finally {
                this._rtInFrame = false;
              }
            }
          }
          const c0 = drawCallsOf(frameInfo), t0 = frameInfo.render.triangles;
          overlayComposited = withActiveBucket('post', () =>
            this._postProcessing.renderTslPost(this.scene, this.camera));
          addDelta(frame.post, frameInfo, c0, t0);
          // plan-767 F3 / M3: sync the trace transforms + BVH to the state just
          // drawn, so BVH(t) pairs with G-buffer(t) at the next dispatch.
          if (rtDispatched) {
            this._rtInFrame = true;
            try {
              this._raytraced.afterRender();
            } finally {
              this._rtInFrame = false;
            }
          }
        } else {
          // Non-composer path — render scene without overlay layers so the
          // post-plugin overlay pass below can draw them on top of the
          // splat plugin's output (same reason as the composer branch).
          disableOverlayLayers(this.camera);
          const c0 = drawCallsOf(frameInfo), t0 = frameInfo.render.triangles;
          this.renderer.render(this.scene, this.camera);
          addDelta(frame.scene, frameInfo, c0, t0);
        }
      } catch (err) {
        // three re-arms setAnimationLoop only AFTER the callback returns —
        // an uncaught exception here would kill the loop for good (frozen
        // or blank viewport). Recover instead of rethrowing.
        renderFailed = true;
        // plan-537 F2d: renderFrameForCapture() reports this frame as failed.
        this._lastRenderFailed = true;
        retryRender = this._recoverFromRenderException(err);
      } finally {
        this._wireframeView.swapOut();
        if (wireGround) wireGround.visible = true;
        this.scene.matrixWorldAutoUpdate = prevSceneMatrixAuto;
        this.camera.layers.mask = prevLayerMask;
        glForClearState.autoClear = prevAutoClear;
        // A failed render leaves no complete frame to book into — detach
        // now so nothing that renders during recovery lands in the stats.
        if (renderFailed) setActiveFrameStats(null);
      }
      {
        // Slow-frame ring (measurement aid): every GPU-submit frame that took
        // more than 100 ms of main-thread time, with the draw-call count
        // submitted so far (all passes up to here).
        const __ms = performance.now() - __frameT0;
        if (__ms > 100) {
          const self = this as unknown as { __rvSlowFrames?: Array<{ start: number; ms: number; drawCalls: number; triangles: number }> };
          (self.__rvSlowFrames ??= []).push({ start: Math.round(__frameT0), ms: Math.round(__ms), drawCalls: drawCallsOf(frameInfo), triangles: frameInfo.render.triangles });
          if (self.__rvSlowFrames.length > 64) self.__rvSlowFrames.shift();
        }
      }
      this._renderDirty = renderFailed ? retryRender : false;
      if (!renderFailed) this._renderFailStreak = 0;
      // The ray traced backend asked for another frame while converging
      // (F11) — its request came before the flag was cleared above.
      if (this._rtRenderAgain) {
        this._rtRenderAgain = false;
        this._renderDirty = true;
      }
    }

    // plan-2215: what the back buffer holds for the plugin passes below — a strategy
    // frame, or a mono frame (plain path, capture, strategy failure). Kept on a tick
    // without a main render: the buffer still shows the last frame.
    if (didMainRender) this._strategyFrame = strategyRendered;

    // ── Plugins Render ──
    // Plugin renders are attributed to the frame only when a main render
    // happened this tick — otherwise the counters belong to a frame that was
    // already closed and the last complete frame stays untouched.
    const pluginInfo = this.renderer.info as unknown as RenderInfoLike;
    const pluginC0 = drawCallsOf(pluginInfo), pluginT0 = pluginInfo.render.triangles;
    for (const p of this._renderPlugins) {
      callPlugin(p, 'onRender', frameDt);
    }
    if (didMainRender) addDelta(this._frame.plugins, pluginInfo, pluginC0, pluginT0);

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
    // untouched); the TSL post pipeline already composited the overlays
    // (`overlayComposited` — a render here would wipe the WebGPU canvas).
    if (didMainRender && !isolateActiveNow && !isXRPresentingNow && !overlayComposited && !strategyRendered) {
      const c0 = drawCallsOf(pluginInfo), t0 = pluginInfo.render.triangles;
      this._renderOverlayLayers();
      addDelta(this._frame.overlay, pluginInfo, c0, t0);
    }
    // Close the frame's per-pass accounting: total, scene − shadow, remainder.
    // Then DETACH: renders outside the loop (web_status' drawTest probe,
    // thumbnail / agent-eye offscreen captures, web_screenshot) fire the
    // reflector's onBeforeRender and the shadow-map wrapper too; with the
    // frame still active they would book into the last closed frame and
    // subtract from `scene` (reflection > total, negative scene).
    if (didMainRender) {
      finalizeFrameStats(this._frame, pluginInfo);
      setActiveFrameStats(null);
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
      // The frame-paced ray (plan-756 F7) resolves a frame AFTER the pointermove, so a hover can
      // change while the pointer is already still: without the node check it was never announced
      // (tooltips stayed empty until the next >4px move, plan-2030 F1).
      const nodeChanged = hoveredNode !== this.lastEmittedHoverNode;
      if (driveChanged || movedEnough || nodeChanged) {
        this.lastEmittedHoverNode = hoveredNode;
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

    if (this.statsReady) { this.performanceStats.end(); this.performanceStats.update(); }

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

    // plan-600: DEV-only invariant drain. This is the END of a frame that was
    // ACTUALLY rendered (every skip path above returned early), which is the
    // join point the deferred invariants I3/I5 are contractually executed at
    // (plan 2.6). It is not a checking frame hook: with no reservation filed it
    // is one array-length test and allocates nothing.
    if (import.meta.env.DEV) invariantsOnRenderedFrame();
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
      const byStorage = readLocalStorage('rv-mu-compute') === '1';
      return byQuery || byStorage ? this.renderer : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The click of the viewer, given an already resolved pick (plan-2215 Phase 7).
   *
   * Extracted unchanged from the canvas `pointerup` handler, which calls it with
   * the hit of `raycastForRVNodeDetailed`; the flystick bridge calls it with the
   * hit of `raycastManager.raycastRay`. In this order: an open drive / sensor
   * chart filters on the HOVERED node; a `pick:'action'` component fires its
   * click (`object-clicked`) and is never selected; otherwise the node is
   * selected (`shiftKey` toggles) and `object-clicked` is emitted; `null` clears
   * the selection and the focus. `clientX/clientY` are the screen position of a
   * pointer click — a WebLabel there also frames the node; a ray click has none.
   */
  clickFromHit(
    hit: { path: string; hitPoint?: [number, number, number] } | null,
    modifiers: { shiftKey?: boolean; clientX?: number; clientY?: number } = {},
  ): void {
    // Normal selection: route through SelectionManager.
    const hitPath = hit?.path ?? null;
    const hitPoint = hit?.hitPoint;
    const hitNode: Object3D | null = hitPath && this.registry ? this.registry.getNode(hitPath) ?? null : null;

    // Chart filter from the hit: a ray click never sets hoveredNode.
    if (this._clickChartMode(hitPath && hitNode ? { node: hitNode, path: hitPath } : null)) return;

    if (hitPath && hitNode) {
      // `pick:'action'` (plan-753 Decision 7): the click fires the
      // component (`object-clicked` → ComponentEventDispatcher → onClick)
      // and never selects the node.
      const isAction = (this.registry?.getComponentTypes(hitPath) ?? [])
        .some((t) => getCapabilities(t).pick === 'action');
      if (isAction) {
        this.emit('object-clicked', { path: hitPath, node: hitNode, hitPoint });
        return;
      }
      if (modifiers.shiftKey) {
        this.selectionManager.toggle(hitPath, hitPoint);
      } else {
        this.selectionManager.select(hitPath, hitPoint);
        // A click on a WebLabel selects AND frames the object it names (the
        // label is an aux pick target of its node, so the hit resolved to it).
        if (modifiers.clientX !== undefined && modifiers.clientY !== undefined
          && this.webLabelManager.labelAt(modifiers.clientX, modifiers.clientY)) this.fitToNodes([hitNode]);
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
  }

  /** Chart filter click on the HOVERED node; true = the click was consumed. */
  private _clickChartMode(target?: { node: Object3D; path: string } | null): boolean {
    // undefined = canvas hover; else the given hit (null = none).
    const rm = this.raycastManager;
    const t = target ? this.registry?.getComponentTypes(target.path) ?? [] : [];
    const hoveredNode = target === undefined ? rm?.hoveredNode ?? null : target?.node ?? null;
    const hoveredType = target === undefined ? rm?.hoveredNodeType ?? null
      : t.includes('Drive') ? 'Drive' : t.includes('Sensor') ? 'Sensor' : null;
    const hoveredDrive = (hoveredNode && hoveredType === 'Drive')
      ? this.registry?.findInParent<RVDrive>(hoveredNode, 'Drive') ?? null
      : null;

    // Drive chart special mode: filter drives on click
    if (hoveredDrive && this.driveChartOpen) {
      this.filterDrives(hoveredDrive.name);
      return true;
    }

    // Sensor chart special mode: filter sensors on click
    if (hoveredNode && hoveredType === 'Sensor' && this.sensorChartOpen) {
      const path = this.registry?.getPathForNode(hoveredNode);
      if (path) {
        this.filterNodes(hoveredNode.name);
        this.emit('object-clicked', { path, node: hoveredNode });
      }
      return true;
    }
    return false;
  }

  /** Bind all canvas event listeners. Called ONCE in the constructor. */
  private _bindCanvasEvents(canvas: HTMLCanvasElement): void {
    // Wheel, trackpad (two-finger orbit, ctrl+wheel pinch), right-drag orbit,
    // middle-drag pan and touch belong to the NavigationController (plan-515) —
    // the ONLY navigation input path; see the constructor.

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
    /** Touch long-press delay (the context-menu timer below uses the same 500 ms). */
    const LONG_PRESS_MS = 500;
    canvas.addEventListener('pointerdown', (e) => {
      // plan-520: a press on the canvas is viewport use (HMI panels are not).
      this.userActivity.markUserInput();
      // Left button: track for click selection
      if (e.button === 0) {
        this._pointerDownPos = { x: e.clientX, y: e.clientY };
        this._pointerDownTime = performance.now();
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
        }, LONG_PRESS_MS);
      }
    }, { signal: this._domAbort.signal });
    canvas.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !this._pointerDownPos) return;
      const dx = e.clientX - this._pointerDownPos.x;
      const dy = e.clientY - this._pointerDownPos.y;
      this._pointerDownPos = null;
      if (dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) return;
      // plan-2215: a render strategy draws views the navigation camera does not
      // match — a pointer pick would hit the wrong object. Clicks pick nothing then.
      if (this.pointerPickBlocked) return;
      // plan-529: a linked WebLabel under the pointer takes the click FIRST —
      // after the drag threshold, and after the transform gizmo / marquee had
      // their chance to consume the gesture (both stop propagation before this
      // bubble-phase listener). Opens synchronously (popup blockers) and never
      // depends on logicRunState. A long press (touch context menu) never opens.
      const heldMs = performance.now() - this._pointerDownTime;
      const isLongPress = e.pointerType !== 'mouse' && heldMs >= LONG_PRESS_MS;
      if (!isLongPress && this.webLabelManager.tryOpenLink(e.clientX, e.clientY)) return;
      // Note: _isOrbiting is NOT checked here — the NavigationController
      // dispatches 'start' on a right / middle / touch pointerdown (setting
      // _isOrbiting=true) and its 'end' only on pointerup. The drag-threshold
      // check above is sufficient to distinguish taps from orbits.

      // plan-2215 Phase 7: the click logic itself is `clickFromHit` — the SAME
      // code a flystick ray calls. The chart modes are asked first, exactly as
      // before the extract, so a chart-filter click casts no pick ray.
      if (this._clickChartMode()) return;

      // Resolve via the SAME pipeline hover uses (raycastForRVNodeDetailed →
      // _resolveHit → findContentAncestor owner), so what you hover is exactly
      // what you select — no per-type special-case (e.g. the old Drive walk-up).
      const detailed = this.raycastManager?.raycastForRVNodeDetailed(e);
      const hitPath = detailed?.path ?? this._raycastForRVNode(e);
      this.clickFromHit(hitPath ? { path: hitPath, hitPoint: detailed?.hitPoint } : null,
        { shiftKey: e.shiftKey, clientX: e.clientX, clientY: e.clientY });
    }, { signal: this._domAbort.signal });

    // Double-click: emit object-focus for camera zoom
    canvas.addEventListener('dblclick', (e) => {
      if (this.pointerPickBlocked) return;
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
    }, { signal: this._domAbort.signal });

    // Escape: exit a selection isolate first (before the SelectionManager's
    // bubble-phase Escape handler on the keyboard scope would clear the
    // selection). Registered on `document` in the CAPTURE phase (so it runs
    // first) and stops propagation only while isolate is active, so a plain
    // Escape without isolate still clears the selection. Scoped like F
    // (plan-515 R3-2, Phase 1b): only key events that belong to THIS viewer —
    // inside its keyboard scope, or outside every viewer scope for the
    // primary viewer; an Escape inside an embed never reaches it.
    this._isolateEscapeHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (!this._selectionIsolateActive) return;
      if (!keyEventBelongsToViewer(e, this.keyboardScope, this.keyboardScopeIsPrimary)) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      this.exitIsolate();
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener('keydown', this._isolateEscapeHandler, true);

    // plan-520: a key that belongs to this viewer's keyboard scope is viewport
    // use. Typing into an HMI field (Inspector, Settings) is not — the user may
    // edit there while the camera follows the AI agent.
    this._activityKeyHandler = (e: KeyboardEvent) => {
      if (!keyEventBelongsToViewer(e, this.keyboardScope, this.keyboardScopeIsPrimary)) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
      // The primary viewer also owns keys outside every viewer scope — count only
      // those with no focused HMI element (body), not keys inside a panel.
      const scope = this.keyboardScope;
      if (scope && t && t !== document.body && t !== document.documentElement && !scope.contains(t)) return;
      this.userActivity.markUserInput();
    };
    document.addEventListener('keydown', this._activityKeyHandler, true);

    // F / Shift+F (frame selection / whole scene) and Escape are owned by the
    // SelectionManager on this viewer's keyboard scope (plan-515 F1, R3-2) —
    // exactly one handler; the kinematic-group expansion lives there too.

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
      // plan-2215: no pick (and no context menu on a picked node) while a strategy draws.
      if (this.pointerPickBlocked) return;

      // FPV guard: don't open context menu when FPV plugin is active
      const fpvPlugin = this.getPlugin('fpv') as { active?: boolean } | undefined;
      if (fpvPlugin?.active) return;

      this._openContextMenuFromEvent(e);
    }, { signal: this._domAbort.signal });

    // plan-529 SOL R2-4: pointer cursor over a LINKED WebLabel. It takes
    // priority over the raycast manager's cursor (see `cursorOverride` there);
    // otherwise the raycast manager keeps control. No work without links.
    canvas.addEventListener('pointermove', (e) => {
      const labels = this.webLabelManager;
      if (e.pointerType !== 'mouse' || e.buttons !== 0) return;
      if (labels.linkedCount === 0 && !labels.hoveringLink) return;
      if (this.pointerPickBlocked) return;
      const over = labels.isLinkAt(e.clientX, e.clientY);
      if (over) {
        labels.hoveringLink = true;
        canvas.style.cursor = 'pointer';
      } else if (labels.hoveringLink) {
        labels.hoveringLink = false;
        canvas.style.cursor = this.raycastManager?.hoveredNode ? 'pointer' : '';
      }
    }, { signal: this._domAbort.signal });

    // ── Long-press cancellation ──────────────────────────────────────
    canvas.addEventListener('pointermove', (e) => {
      if (this._longPressTimer && this._longPressPos) {
        const dx = e.clientX - this._longPressPos.x;
        const dy = e.clientY - this._longPressPos.y;
        if (dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) {
          this._cancelLongPress();
        }
      }
    }, { signal: this._domAbort.signal });
    canvas.addEventListener('pointerup', () => {
      this._cancelLongPress();
    }, { signal: this._domAbort.signal });
    canvas.addEventListener('pointercancel', () => {
      this._cancelLongPress();
    }, { signal: this._domAbort.signal });
    canvas.addEventListener('touchcancel', () => {
      this._cancelLongPress();
    }, { signal: this._domAbort.signal });
    // Named + removed in dispose(): an anonymous document listener holds the whole viewer
    // (bake registry, geometry buffers) for the life of the page after every model switch.
    this._visibilityHandler = () => {
      if (document.hidden) this._cancelLongPress();
    };
    document.addEventListener('visibilitychange', this._visibilityHandler);
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
    if (this.pointerPickBlocked) return;
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

    const onSessionStart = () => {
      this._savedBackground = this.scene.background as Color | null;
      this._savedShadowState = this.renderer.shadowMap.enabled;
      this.renderer.shadowMap.enabled = false;
      this.controls.enabled = false;
      if (this.resizeHandler) window.removeEventListener('resize', this.resizeHandler);
      if (this.resizeObserver) this.resizeObserver.disconnect();
      this.emit('xr-session-start', undefined as void);
    };
    const onSessionEnd = () => {
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
    };
    glRenderer.xr.addEventListener('sessionstart', onSessionStart);
    glRenderer.xr.addEventListener('sessionend', onSessionEnd);
    // Three keeps the renderer alive through every shared material's 'dispose' listener, so
    // these closures (which capture the viewer) must be unhooked in dispose().
    this._xrOff = () => {
      glRenderer.xr.removeEventListener('sessionstart', onSessionStart);
      glRenderer.xr.removeEventListener('sessionend', onSessionEnd);
    };
  }

  /** Initialize stats-gl with fallback for WebGPU incompatibility. */
  private _setupStats(renderer: Renderer): void {
    this.performanceStats = new Stats({
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
    this.performanceStats.dom.style.position = 'absolute';
    this.performanceStats.dom.style.bottom = '12px';
    this.performanceStats.dom.style.left = '12px';
    this.performanceStats.dom.style.display = 'none';
    document.body.appendChild(this.performanceStats.dom);
    try {
      this.performanceStats.init(renderer as unknown as WebGLRenderer);
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

/** The scene generation the active DES runner last bound, or null (no runner / older runner). */
function desBoundSceneGeneration(k: SimulationKernel): number | null {
  const exec = k.activeExecutor as unknown as { boundSceneGeneration?: number | null };
  return typeof exec.boundSceneGeneration === 'number' ? exec.boundSceneGeneration : null;
}

/**
 * plan-774: `WebGLRenderer.compileAsync` with a readiness poll that survives
 * a material disposed while it links (three's own poll throws on the missing
 * `currentProgram` and never settles) and ends when `cancelled()` turns true.
 * Same structure as three's: `compile()` creates the programs synchronously,
 * then `KHR_parallel_shader_compile` (or a 10 ms grace) is polled.
 */
function compileAsyncTolerant(
  gl: WebGLRenderer,
  scene: Object3D,
  camera: Camera,
  cancelled: () => boolean,
): Promise<void> {
  const materials = gl.compile(scene, camera, scene as Scene) as Set<Material>;
  const props = (gl as unknown as { properties: { get(m: Material): { currentProgram?: { isReady(): boolean } } } }).properties;
  const ext = (gl as unknown as { extensions: { get(name: string): unknown } }).extensions;
  return new Promise<void>((resolve) => {
    const check = (): void => {
      if (cancelled()) { resolve(); return; }
      for (const material of [...materials]) {
        const program = props.get(material).currentProgram;
        // No program any more = the material was disposed: nothing to wait for.
        if (!program || program.isReady()) materials.delete(material);
      }
      if (materials.size === 0) { resolve(); return; }
      setTimeout(check, 10);
    };
    if (ext.get('KHR_parallel_shader_compile') !== null) check();
    else setTimeout(check, 10);
  });
}
