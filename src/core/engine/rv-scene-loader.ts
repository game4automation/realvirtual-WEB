// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { getActiveStatsRegistry } from '../stats/rv-stats-registry';
import { collectComponentTypes, noteDeferredComponentType, noteDeferredComponentTypes } from './rv-component-types';
import { Scene, Object3D, Box3, Vector3, BufferAttribute, Mesh, BufferGeometry, Material } from 'three';
import { RVDrive } from './rv-drive';
import { disposeModelSubtree } from './rv-dispose-subtree';
import { AABB } from './rv-aabb';
import { getColliderExtrasFrom } from './rv-collider-extras';
import { registerSignal, constructDrive, SIGNAL_TYPES, DRIVE_BEHAVIOR_MAP } from './rv-signal-construction';
import {
  gltfLoader, detectRenamedNodes, collectRenamedNodes, collectGltfNodeIndices, collectGltfNodeNames, type GltfParserLike,
} from './rv-glb-parse';
import { forEachNodeAlias } from './rv-node-aliases';
import { classifyShadows } from './rv-mesh-classifier';
import {
  compose, hasReferences, collectGatedNodes, isFrameGated,
  type ComposeResult, type ComposedFrame, type DeferredReference, type GlbTemplateCache, type ReferenceResolver,
} from './rv-glb-compose';
import { createReferenceResolver } from './rv-glb-reference-resolver';
import type { DocumentScope } from '../library/library-origin';
import {
  reportBakeFailed, reportIdVersionNewer, reportMissingReferences, reportOverrideOrphaned, reportOverrideTransformsDropped, reportReferenceMigrationProblems,
  reportReferenceContentDiscarded,
} from '../hmi/problems-store';
import { reportLoadMemoryBudget } from './rv-load-memory-budget';
import type { OrphanedOverride } from './rv-asset-reference';
import { ROOT_OCCURRENCE, ROOT_SOURCE_KEY } from './rv-node-id';
import { ID_VERSION_CURRENT, getDecodeIdentity, isIdVersionNewer } from './rv-decode-identity';
import { storedReferenceValue } from './rv-node-path-rewrite.mjs';
import { assignRuntimeIdentity } from './rv-subtree-instantiate';
import type { EventEmitter } from '../rv-events';
import type { ViewerEvents } from '../rv-viewer-events';
// Side-effect imports: trigger registerComponent() at module load
import './rv-transport-surface';
// plan-2016 Phase 3 - TransportGuided (guided arc/line conveyor) self-registers on import.
import './rv-transport-guided';
import './rv-sensor';
// plan-664 Phase 2 - Rangefinder / LaserScanner / RayTarget self-register on import.
import './rv-rangefinder';
import './rv-laser-scanner';
import './rv-ray-target';
import './rv-source';
import { isLayoutPlacementRoot, resolveSpawnParent } from './rv-source';
import { RVMovingUnit } from './rv-mu';
import { computeMUColliderFrameBox, isMUNode } from './rv-mu-collider-bounds';
import { readLoadSeatDepth } from './rv-mu-load';
import './rv-sink';
import './rv-grip';
import './rv-grip-target';
import './rv-connect-signal';
// plan-2227: SignalConnector loads on demand (src/features/signal-connector.register.ts).
import './rv-lamp';
import './rv-sound';
import './rv-scene-button-base';
import './rv-scene-button-moveable';
import './rv-push-button3d';
import './rv-emergency-button3d';
import './rv-handle-switch3d';
import './rv-energy-chain';
import './rv-chain';
// plan-459 - RibbonRoller / RibbonWinder / RibbonPath self-register on import.
import './rv-ribbon-roller';
import './rv-ribbon-winder';
import './rv-ribbon-dancer';
import './rv-ribbon-path';
import './rv-safety-door';
import './rv-physics-zone';
import './rv-physics-zone2d';
import './rv-mujoco-region';
import './rv-dynamic-axis';
import './rv-contact-geometry';
import './rv-free-body';
import './rv-grip-load';
import './rv-locomotion-policy-component';
import './rv-collision-role';
import './rv-drop-detection';
import './rv-transport-stopper';
import './rv-zone';
import './rv-machining-volume';
import './rv-machining-tool';
import './rv-web-sensor';
import './rv-web-label';
import './rv-fmu';
import { FMU_TYPE } from './rv-fmu-constants';
import './rv-web-diagnostics';
import './rv-web-error';
import './rv-web-visibility';
import './rv-custom-runtime-instruction';
import './rv-metadata';
// plan-650 Phase 1 — 'ParametricComponent' capabilities (authorable, claims its node); no factory yet.
import './rv-parametric-component';
import './rv-group-component';
import './rv-mu-switcher';
import './rv-mu-pusher';
import { applyAuthoredInactive } from './rv-authored-inactive';
// plan-522 — web-only maintenance procedure schemas (+ DriveTo/SetSignalBool authorable).
import './rv-maintenance-components';
// Agent memory (plan-394) — registers the 'NodeKnowledge' schema + capabilities
// but NO factory: the note is data on the node, never a live instance.
import './rv-node-knowledge';
import './rv-ik-target';
import './rv-ik-path';
import './rv-robot-ik';
// Path substrate (plan-268) — registers the 'Path' factory (rv_extras.Path → RVPath)
import './rv-path';
// plan-628 Phase 2 — 'PathBlock' schema + capabilities (WEB-only path-network block, no factory).
import { PATH_BLOCK_TYPE, PATH_NETWORK_NODE } from './rv-path-block';
// plan-559 Phase 2a — 'InstanceScope' marker (signal scope of an embedded copy)
import './rv-instance-scope-component';
// plan-559 Phase 3 — fleet scene schemas (Fleet, TransferStation, Charger, WaitPoint,
// ForkliftProfile, BatteryProfile): data only, no factory, no material-flow kind
import '../fleet/scene/fleet-components';
// Drive behavior — registers schema + badge capability for Drive_DestinationMotor
import './rv-drive-destination-motor';
// Drive add-on (not a Drive_* behavior) — registers the 'DrivePulseEncoder' factory
import './rv-drive-pulse-encoder';
// plan-525: BoxCollider is an authorable component. Imported AFTER the other
// component modules so it registers late (a node's primary instance stays its
// real component; RVBoxCollider.init() also hands the slot on).
import './rv-box-collider';
// Pipeline components — class constructors also register capabilities + tooltip resolvers
import { RVPipe } from './rv-pipe';
import { RVTank } from './rv-tank';
import { RVPump } from './rv-pump';
import { RVProcessingUnit } from './rv-processing-unit';
import { applySchema, resolveComponentRefs, getRegisteredFactories, getSchemaDefaults, registerCapabilities, type RVComponent, type ComponentContext, type ComponentSchema } from './rv-component-registry';
import type { GizmoOverlayManager } from './rv-gizmo-manager';
import type { LampManager } from './rv-lamp-manager';
import type { WebLabelManager } from './rv-web-label-manager';
import type { SceneButtonManager } from './rv-scene-button-manager';
import type { EnergyChainManager } from './rv-energy-chain-manager';
import type { ChainManager } from './rv-chain-manager';
import type { RibbonManager } from './rv-ribbon-manager';
import type { MachiningManager } from './rv-machining-manager';
import type { CollisionRoleRegistrar } from './rv-collision-role';
import type { DropDetectionRegistrar } from './rv-drop-detection';
// plan-404: the rigid-body mechanism manager is a PRIVATE implementation behind
// a public registry slot. Every ComponentContext built below reads it from the
// singleton rather than an option, so no construction path can miss it.
import { getKinematicManager, type KinematicManagerLike } from './rv-kinematic-registry';
import {
  getActiveSignalReapplyRegistry,
  type SignalReapplyRegistry,
} from './rv-signal-reapply-registry';
import type { RVOutlineManager } from './rv-outline-manager';
import type { ErrorStore } from './rv-error-store';
import type { RVHighlightManager } from './rv-highlight-manager';
import type { InstructionRuntimeStore } from './rv-instruction-runtime-store';
import { RVTransportManager } from './rv-transport-manager';
import { SignalStore } from './rv-signal-store';
import { RVDrivesPlayback, parseCompactRecording, parseScriptableObjectRecording, type CompactRecording } from './rv-drives-playback';
import { RVReplayRecording } from './rv-replay-recording';
import { NodeRegistry, type ComponentRef } from './rv-node-registry';
import { GroupRegistry } from './rv-group-registry';
import { validateExtras, printParitySummary, resetParityValidator } from './rv-extras-validator';
import { binaryResources, parseGlbCollectingResources } from './rv-binary-resources';
import { parseActiveOnly, type ActiveOnly } from './rv-active-only';
import { debug, debugVerbose, logInfo, logWarn } from './rv-debug';
import { createLoadProfiler } from './rv-load-profiler';
import { deduplicateMaterials, type DedupResult } from './rv-material-dedup';
import { applyUberMaterial, createUberMaterial, type RVUberMaterial, type UberResult } from './rv-uber-material';
import { registerBuiltInPreBakeHooks } from './rv-pre-bake-hooks';
import { isMetadataLoadingEnabled } from './rv-dev-load-flags';
import { freezeStaticMatrices } from './rv-freeze-static';
import { assertBakeAllowed, BakeAbortedError } from './rv-bake-pipeline';
import { prepareAndBake, preparedMaterialsOf, stripPersistedSensorViz } from './rv-prepare-and-bake';
import { buildInitContext, subsystemsOf, type InitContextBase, type InitSubsystems } from './rv-init-context';
import type { BakeClaim } from './rv-bake-survival';
import type { BakedAsset } from './rv-bake-chunk';
import { RV_BAKE_CHUNK_KEY, type BakeRegistry, type PlacementInstance } from './rv-bake-registry';
import { getPlacementMeta, markDeferredPlacement, recordAuthoredLayoutObject } from './rv-asset-reference';
import { ensureBVHPrototypePatches, type BVHBuildPort } from './rv-bvh-build-port';
import type { PickBuildPort } from './rv-pick-build-port';
import type { MeshMergePort } from './rv-mesh-merge-port';
import { markAasPending } from '../../plugins/aas-resolution-mark';
import { applyOverlayToNode, type RVExtrasOverlay } from './rv-extras-overlay-store';
import { applyKinematicsSpec } from '../behavior-runtime';
import { fetchedUrlOf, parsedBufferSourceUrl, readTrackedBody, sidecarChangedDocument } from './rv-script-trust';
import { applyNamingScan } from './rv-naming-scan';
import { deepCloneJSON } from '../ops/rv-op-utils';
import {
  verifyRvSigBuffer,
  type SignatureState,
} from '../persistence/rv-sig-verify';
import { recordDocumentBytes } from './rv-model-content-ledger';

// The GLTFLoader singleton, `detectRenamedNodes` and `parseGlbSubtree` live in
// ./rv-glb-parse so the asset editor and layout planner can parse GLB bytes
// without pulling in this module's component side-effect graph. Re-exported
// here because `detectRenamedNodes` has always been part of this module's API.
export {
  detectRenamedNodes, collectRenamedNodes, collectGltfNodeIndices, collectGltfNodeNames, parseGlbSubtree, gltfLoader,
} from './rv-glb-parse';

// ─── Register capabilities for types without factories ────────────

// Pipeline Pipe/Tank/Pump and ProcessingUnit capabilities are registered by their
// class modules themselves (rv-pipe.ts / rv-tank.ts / rv-pump.ts / rv-processing-unit.ts)
// via registerTooltipComponent() — a second registration here overwrote the class's
// filter / category.
// RuntimeMetadata/Metadata capabilities are registered by rv-metadata.ts (side-effect
// import above), like the other factory components.
// Note: AASLink capabilities are registered by aas-link-plugin.tsx (plugin side-effect).
// Model plugins load BEFORE loadGLB() so capabilities are available for BVH construction.

// Recorder types (visible in inspector but not hoverable)
registerCapabilities('DrivesRecorder', { ui: { badge: '#7e57c2' } });
registerCapabilities('ReplayRecording', { ui: { badge: '#26a69a' } });

// Structural types (hidden from inspector).
// plan-755 D7: `claimsNode: false` — a Unity export marker holds no node through
// a destructive bake. This used to be inferred from `ui.hidden && bake ===
// 'merge'`; it is explicit now and the set is frozen in
// tests/bake-claims-node.test.ts (a NEW hidden marker must opt in there).
registerCapabilities('rigidbody', { claimsNode: false, ui: { hidden: true } });
registerCapabilities('renderer', { claimsNode: false, ui: { hidden: true } });
registerCapabilities('colliders', { claimsNode: false, ui: { hidden: true } });
// BoxCollider: registered by rv-box-collider.ts (plan-525 — authorable, still
// `claimsNode: false`; side-effect import above).
// MeshCollider is a `colliders[]` ENTRY type, not a top-level extras key, but it
// is registered so `isKnownComponentType('MeshCollider')` reports it as known —
// the physics side consumes it for convex-hull kinematic bodies (plan-467 F2).
registerCapabilities('MeshCollider', { claimsNode: false, ui: { hidden: true } });
// Group capabilities+schema are registered by rv-group-component.ts (side-effect import above)
// Kinematic is visible: authored in the asset editor (Kinematics window / auto-create
// on group assignment), so it must show up in the hierarchy and inspector.
registerCapabilities('Kinematic', { bake: 'chunk', ui: { badge: '#ce93d8' } });
// plan-754 D18: the structural passes the destructive pipeline runs BEFORE the
// bake (drive home pose, kinematic re-parenting, sensor beam, …). Installed
// here, next to the other capability registrations, so every entry point that
// can reach a bake has them.
registerBuiltInPreBakeHooks();
// Bake roles for extras keys that have no component module of their own
// (plan-753 §2.3). Both are pure markers: hidden from the inspector exactly as
// they were while unregistered ("unknown type" = hidden), but they must carry a
// role because `freezeStaticMatrices` / the batcher now ask the registry
// instead of a hard-coded key list:
//   PlacementMeta — a planner placement moves and is deleted as ONE unit
//                   (plan-397 phase 6), so its whole subtree is a mover.
//   Cam           — the cam disc rotates as one unit: a mover, 'chunk' in the
//                   bake (plan-753 F6).
registerCapabilities('PlacementMeta', { bake: 'chunk', ui: { hidden: true } });
// plan-757 Phase 2 (F15): a reference node is an EMPTY survivor of the recipe —
// `AssetReference` claims its node (the survival default for an unregistered
// key, made explicit here so no later registration can silently drop it), and
// the instancer turns every clone of it into a placement of its own
// (`rv-placement-instancer.ts`, "a reference is a placement, always"). Hidden
// from the inspector exactly as it was while unregistered.
registerCapabilities('AssetReference', { claimsNode: true, ui: { hidden: true } });
registerCapabilities('Cam', { bake: 'chunk', ui: { hidden: true } });
registerCapabilities('RuntimeUIWindow', { claimsNode: false, ui: { hidden: true } });
registerCapabilities('RuntimeInteractable', { claimsNode: false, ui: { hidden: true } });

export interface RecorderSettings {
  playOnStart: boolean;
  replayStartFrame: number;
  replayEndFrame: number;
  loop: boolean;
  activeOnly: ActiveOnly;
}

import type { ModelConfig } from './rv-model-config';
import { isFetchableUrl } from './rv-model-config';

/**
 * What `registerNodeAliases` did during a load (plan-734 F8).
 *
 * Alias registration is the one load phase whose cost scales with how badly the
 * source CAD reused names — 43k deduplicated nodes in a customer model are not
 * unusual — and until now it reported a single line with two numbers and no
 * timing, so it was impossible to say whether it mattered. `droppedAliases` is
 * the correctness signal of the three: it counts alias paths that were thrown
 * away because something already occupied the path.
 */
export interface AliasStats {
  nodeAliases: number;
  signalAliases: number;
  /** Alias registrations `registerAlias` silently discarded (path already taken). */
  droppedAliases: number;
  /** The alias leaf name claimed most often — the registry's worst suffix scan. */
  largestSuffixBucket: { suffix: string; count: number };
  ms: number;
}

export interface LoadResult {
  /** The GLB root Object3D added to `scene` by `loadGLB`. Lets the caller
   *  track the new model deterministically without diffing `scene.children`
   *  before/after the load (which is fragile when overlays/gizmos attach
   *  directly to the scene). */
  root: Object3D;
  /** Viewer render hints authored in glTF scene extras. */
  renderHints?: { suppressGround: boolean };
  drives: RVDrive[];
  transportManager: RVTransportManager;
  signalStore: SignalStore;
  registry: NodeRegistry;
  playback: RVDrivesPlayback | null;
  replayRecordings: RVReplayRecording[];
  recorderSettings: RecorderSettings | null;
  // No `logicEngine` (plan-769 Phase 6, D20): the loader builds no logic. The
  // main model's LogicSteps are built ONCE against the complete scene — after
  // its placements materialised — by the viewer through `mergePlacedLogic()`,
  // the same function a placement uses.
  boundingBox: Box3;
  triangleCount: number;
  /** Mesh nodes in the loaded tree, counted by `processMeshes()` before any
   *  merge pass. OPTIONAL so LoadResult mocks in tests stay robust. */
  meshCount?: number;
  groups: GroupRegistry | null;
  /** Merged model-specific plugin configuration (modelname.json > GLB extras > settings.json). */
  modelConfig: ModelConfig;
  dedupResult: DedupResult | null;
  uberResult: UberResult | null;
  pipelineNodes: { pipes: Object3D[]; tanks: Object3D[]; pumps: Object3D[]; processingUnits: Object3D[] };
  /** Group names that were re-parented under Kinematic nodes (for auto-exclude from overlay). */
  kinematicGroupNames: string[];
  /** The subset of `kinematicGroupNames` a DRIVE actually moves — the only ones
   *  the Groups panel auto-excludes (see {@link resolveDrivenKinematicGroupNames}). */
  drivenKinematicGroupNames: string[];
  /**
   * The loaded model baked into chunks (plan-753 Phase 4): one `BakedAsset`
   * over the model root, instantiated IN PLACE through `options.bakeRegistry`
   * — the model stays the source hierarchy, chunk meshes hang under root /
   * mover nodes, sources are masked. `null` on an authoring load
   * (`preserveHierarchy`), with static merging switched off, without a
   * registry, or when the bake failed (the sources render unbatched and the
   * viewer installs the per-mesh instance pick index). OPTIONAL so LoadResult
   * mocks in tests stay robust.
   */
  bakedAsset?: BakedAsset | null;
  /** The in-place registry instance of `bakedAsset` (released by `clearModel`). */
  bakeInstance?: PlacementInstance | null;
  /**
   * Whether this load's MODE bakes (plan-753): not an authoring load
   * (`preserveHierarchy`) and a bake registry present. It is
   * the loader-bake condition WITHOUT the mesh-count guard — a layout document
   * whose every placement was deferred has no mesh of its own (so
   * `bakedAsset === null`) yet still answers true, and the planner bakes its
   * placements onto the session's uber material exactly as a live drop does.
   * OPTIONAL so LoadResult mocks in tests stay robust.
   */
  placementBakeAllowed?: boolean;
  /**
   * plan-774 F2: whether this load's PLACEMENTS bake onto the session's uber
   * material — true whenever a bake registry is present, authoring loads
   * included. The asset editor's own content stays unbaked
   * ({@link placementBakeAllowed} false), but its references are placements
   * baked exactly like in the HMI (same chunks, one shared `BakedAsset`).
   * OPTIONAL so LoadResult mocks in tests stay robust.
   */
  placementUberAllowed?: boolean;
  /**
   * plan-516: whether the MU nodes of this load are subject to pre-placed MU
   * classification (not an authoring load), and the nodes that never
   * initialise (less-trusted referenced frames) whose MUs stay hidden. A
   * logic-gated load classifies at the gate release with these. OPTIONAL so
   * LoadResult mocks in tests stay robust.
   */
  preplacedClassification?: { enabled: boolean; excluded: ReadonlySet<Object3D> | null };
  /**
   * Duration of the loader bake (Phase 10c) in milliseconds (plan-274 F5). OPTIONAL so LoadResult mocks in tests stay
   * robust (N4); undefined when the profiler didn't record the merge phases.
   */
  mergeMs?: number;
  /**
   * Load-time metadata/interaction cost stats (DevTools "Picking & Highlight").
   * OPTIONAL so LoadResult mocks in tests stay robust. `hoverableFaceRanges` is
   * the total face-range count across the static + kinematic pick groups.
   */
  metadataStats?: {
    metadataNodes: number;
    aabbCount: number;
    aabbBuildMs: number;
    hoverableFaceRanges: number;
  };
  /**
   * Node/signal path aliases published for Three.js-deduplicated nodes
   * (plan-734 F8). OPTIONAL so LoadResult mocks in tests stay robust.
   */
  aliasStats?: AliasStats;
  /** rv_sig verification result obtained from the raw GLB before GLTF parsing. */
  signatureState: SignatureState;
  /** True whenever the normative default-scene extras contained rv_sig. */
  signaturePresent: boolean;
  /** Display-only organization from a root-signed customer key. */
  signerOrganization?: string;
  /**
   * Script-trust provenance (rv-script-trust.ts): the final URL the fetch
   * boundary recorded for EXACTLY the buffer that was parsed — the original
   * bytes, or a signature-recovery replacement's own token — else null.
   * OPTIONAL so LoadResult mocks in tests stay robust.
   */
  modelSourceUrl?: string | null;
  /** A `.kin.json` sidecar (root or composed frame) changed the document's extras. */
  sidecarModified?: boolean;
  /** True while component Start/onSceneReady and all logic ticks are deferred. */
  logicGated: boolean;
  /** Deferred Start/onSceneReady payload retained for one late activation. */
  deferredLogic: DeferredLogic | null;
  /**
   * Composition outcome when the model referenced other GLBs (plan-397 Phase 3).
   * `null` for the overwhelming majority of models, which reference nothing —
   * composition is then skipped entirely rather than run over an empty set.
   */
  composition: ComposeResult | null;
  /**
   * Referenced occurrences whose logic was NOT initialized because their file is
   * less trusted than the root (§2.9). Empty unless `composition` is set.
   */
  gatedFrames: ComposedFrame[];
  /** Overrides from the composition whose target node no longer exists (F9). */
  orphanedOverrides: OrphanedOverride[];
  /**
   * Planner placement roots composition left EMPTY (plan-753, `deferPlacements`):
   * each carries a deferred mark (`getDeferredPlacement`) and waits for the
   * layout planner to instantiate the asset's shared `BakedAsset` under it.
   * Empty unless the caller asked for deferral.
   */
  deferredPlacements: DeferredReference[];
}

/**
 * Create an AABB from BoxCollider data in GLB extras, or fallback to mesh bounds.
 * C# source: Unity built-in BoxCollider (center, size fields)
 */
function createAABBFromExtras(node: Object3D, rv: Record<string, unknown>): AABB {
  // Prefer mesh-based AABB when the node has visible geometry (TransportSurface, Sensor).
  // Only fall back to BoxCollider data for meshless nodes (e.g. Sink trigger colliders).
  const meshAABB = AABB.fromNode(node);
  if (meshAABB.halfSize.lengthSq() > 0) {
    return meshAABB;
  }

  debugVerbose('loader', `[AABB] ${node.name}: meshAABB halfSize=${meshAABB.halfSize.toArray()}, lengthSq=${meshAABB.halfSize.lengthSq()}`);

  // No mesh — use collider data from GLB extras. `getColliderExtrasFrom`
  // (plan-467 Phase 1) is the ONE parser for both shapes: the legacy top-level
  // `BoxCollider` key first, then the `colliders[]` entries in export order —
  // exactly the precedence this function always applied. Box behaviour is
  // unchanged; MeshCollider entries carry no AABB of their own and are skipped
  // here (the physics side reads them for convex hulls, F2).
  const boxCollider = rv['BoxCollider'] as Record<string, unknown> | undefined;
  if (boxCollider) validateExtras('BoxCollider', boxCollider);
  for (const col of getColliderExtrasFrom(rv)) {
    if (col.kind !== 'box') continue;
    const bc = AABB.fromBoxCollider(node, col.center, col.size);
    debugVerbose('loader', `[AABB] ${node.name}: using BoxCollider halfSize=${bc.halfSize.toArray()}, center=${bc.center.toArray()}`);
    return bc;
  }

  // Last resort: return degenerate AABB
  return meshAABB;
}

// DRIVE_BEHAVIOR_MAP and SIGNAL_TYPES moved to ./rv-signal-construction.ts

/**
 * The viewer-owned subsystems (`gizmoManager`, `lampManager`, …, `reapply`)
 * come from {@link InitSubsystems} — ONE list, shared with `buildInitContext`
 * (plan-757 F4), so a subsystem cannot be on the loader's list and missing
 * from a placement's.
 */
export interface LoadGLBOptions extends InitSubsystems {
  /** When true, apply WebGPU-specific geometry fixes (e.g., Uint16 index conversion). Default: false.
   *  Semantics (plan-271): feed this from `viewer.isWebGPU`, which is true for
   *  BOTH WebGPURenderer variants ('webgpu' AND 'webgpu-gl' / forceWebGL) —
   *  i.e. the needsTSL derivation, NOT the real-backend check. */
  isWebGPU?: boolean;
  /** plan-271 Phase 4 SPIKE: the real-backend WebGPURenderer instance when the
   *  MU compute-transform path is opted in (`viewer.hasCompute` AND the
   *  explicit `?mucompute=1` / localStorage flag). Routed to
   *  `RVTransportManager.muComputeRenderer` — same route as `isWebGPU`.
   *  undefined = CPU instance-matrix path (unchanged default). */
  muComputeRenderer?: unknown;
  /**
   * The session's shared uber material (plan-752 S2).
   *
   * Feed this from `RVViewer.ensureUberMaterial()`. The loader is NOT the
   * owner of that material any more: the layout planner's ModelCache bakes
   * placement masters onto the very same reference, and two instances would
   * mean two arena buckets for identical geometry. Omitted (tests, embedders)
   * the loader mints its own, exactly as before.
   */
  sharedUber?: RVUberMaterial | null;
  /**
   * Optional rv-extras overlay applied during the main traversal — BEFORE
   * components read `userData.realvirtual`. This guarantees component
   * constructors see the overridden values directly, eliminating the race
   * window the post-load re-application path used to have.
   */
  overlay?: RVExtrasOverlay;
  /**
   * plan-652 Phase 3: on-demand features activated by the component types of this
   * model (`component:<type>`, DES). Awaited after the naming scan, before any
   * component is built. Omitted (tests, embedders): no activation, as before.
   */
  features?: {
    ensureForComponentTypes(types: Iterable<string>): Promise<void>;
    /** The `component:` trigger types still waiting — the prescan collects only those. */
    pendingComponentTriggerTypes?(): ReadonlySet<string>;
  };
  /**
   * Pre-downloaded GLB bytes. When provided, the loader parses these directly
   * instead of fetching `url` itself — used by the progress/retry-aware download
   * path in main.ts. Omit to let the loader fetch the URL (direct callers/tests).
   */
  data?: ArrayBuffer;
  /**
   * When true, skip the uber-material bake and the static/kinematic mesh merges
   * (Phase 10b/10c/10d) so the full assembly hierarchy stays intact: every node
   * remains visible, individually pickable, and keeps its original material.
   * Material dedup (hierarchy-safe) and BVH (needed for picking) still run.
   * Example caller: the Editor mode asset base (`_loadBase`), which authors
   * individual nodes — the static uber merge would swallow them into a
   * mega-mesh, making eye toggles and gizmo transforms visually dead.
   */
  preserveHierarchy?: boolean;
  /**
   * plan-727 — AUTHORING load: never mutate the GLB node hierarchy.
   * Skips kinematic re-parenting (Phase 8b) so the CAD tree survives
   * save/reload and CAD re-import keeps matching. Without it, every editor
   * reload moves group members under their Kinematic node and the next save
   * bakes that restructuring permanently into the GLB — after which
   * `relativePathMap()` in rv-cadlink-reimport.ts no longer traverses them and
   * they vanish from the re-import SILENTLY, components and all.
   *
   * Deliberately SEPARATE from `preserveHierarchy`: that flag is about mesh
   * baking and pickability, and `RVEmbedViewer` (a simulating production
   * runtime, src/embed/rv-embed-viewer.ts:291) sets it while still requiring
   * the re-parenting — gating Phase 8b on it would freeze embed kinematics
   * with no error and no log. Only the asset editor sets this one.
   */
  preserveAuthoringHierarchy?: boolean;
  /**
   * Abort predicate (plan-274 B3/F7) — checked after every await of the async
   * merge phases (10c/10d). RVViewer.loadModel() passes a load-generation
   * snapshot comparison; when it returns true the load is stale (clearModel /
   * a newer loadModel ran): constructed merge chunks are disposed, the root
   * is removed from the scene and loadGLB rejects with {@link LoadAbortedError}.
   */
  shouldAbort?: () => boolean;
  /**
   * The session's `BakeRegistry` (plan-753 Phase 4). With it — and no
   * `preserveHierarchy`, and static merging on — the loader bakes the model
   * into chunks (Phase 10c) and instantiates them in place. Without a
   * registry nothing is baked: the sources render individually and the
   * viewer picks them through the instance pick index.
   */
  bakeRegistry?: BakeRegistry;
  /** Pick-structure build port for the loader bake (plan-756; test seam:
   *  `createPickBuildPort({ createWorker: () => null })`). */
  bakePickPort?: PickBuildPort;
  /**
   * Nodes model plugins claim before the bake (plan-754 D17,
   * `RVViewerPlugin.bakeClaims`), collected by the viewer. Fed into the
   * survival model next to the reference tags; an unresolved path is reported
   * in the removal report, never thrown.
   */
  bakeClaims?: ReadonlyArray<BakeClaim>;
  /**
   * Whether {@link bakeClaims} is the COMPLETE claim set (default `true`).
   *
   * `false` says the plugins that would declare claims had not loaded when the
   * bake ran — model plugins are deferred while the layout planner is active —
   * so the removal report must report "not checked" instead of a clean zero
   * (`BakeRemovalReport.claimsComplete`).
   */
  bakeClaimsComplete?: boolean;
  /** A persisted per-model user decision may permit invalid/unverifiable logic. */
  allowUntrustedLogic?: boolean;
  /**
   * Whether to request and apply the optional `<glb>.kin.json` companion.
   * Defaults to true. Self-contained delivery surfaces such as rv-embed set
   * this to false so a missing optional sidecar does not create customer-page
   * 404s. The main viewer keeps the existing default behavior.
   */
  loadKinematicsSidecar?: boolean;
  /**
   * Content hash of the root GLB, when the caller already has it.
   *
   * Only used to DERIVE `NodeId`s for the root file's own nodes, which in turn
   * gives its reference nodes stable occurrence segments. Omitting it costs
   * nothing for a file that carries authored ids and falls back to per-file
   * ordinals for one that does not — it is never worth hashing 35 MB here just
   * in case.
   */
  sourceSha256?: string;
  /**
   * How an `AssetReference` becomes bytes (plan-397 Phase 3). Defaults to the
   * library-registry + relative-path resolver. Tests inject their own so a
   * composition can be exercised without a network.
   */
  referenceResolver?: ReferenceResolver;
  /** plan-780 R1: the loaded document's project; composition resolves its references there. Null = open project. */
  documentScope?: DocumentScope;
  /**
   * Reuse a parse-template cache across loads. Omit and the composition owns a
   * fresh one that is freed with the model — see `rv-glb-compose.ts` on why
   * cross-load sharing is opt-in.
   */
  composeCache?: GlbTemplateCache;
  /**
   * Reload = Planner-Instanzen (plan-753). When true, composition does NOT
   * graft the referenced asset under a planner placement root
   * (`PlacementMeta` + `AssetReference`): the root stays an empty, marked node
   * and the layout planner instantiates the asset's shared `BakedAsset` under
   * it after the load — one bake per asset, chunk geometry and BVH shared with
   * every live placement of the same asset, no CAD hierarchy of the occurrence
   * in the scene graph. Hand-authored references (no `PlacementMeta`) and
   * everything else compose as before. The caller must guarantee a planner
   * will pick the roots up (`RVViewer` always sets it: its `PlacementInstancer`
   * materialises what no planner adopted). Since plan-757 Phase 2 every
   * non-embedded reference is deferred, and since plan-774 authoring loads
   * (`preserveHierarchy` / `preserveAuthoringHierarchy`) are no exception.
   */
  deferPlacements?: boolean;
}

/**
 * Thrown by loadGLB when `options.shouldAbort` reports a stale load during
 * the async merge phases (plan-274 B3/F7). The superseding load owns the
 * scene at that point; callers awaiting the STALE load must treat this as
 * a cancellation, not a failure.
 */
export class LoadAbortedError extends Error {
  constructor(url: string) {
    super(`loadGLB aborted (superseded): ${url}`);
    this.name = 'LoadAbortedError';
  }
}

/**
 * plan-774 F11: detach whatever a file stored UNDER a deferred reference node
 * and report it as `reference-content-discarded`.
 *
 * A deferred reference node is filled by the `PlacementInstancer` from the
 * referenced asset; stored children — an old double-graft, a hand edit — would
 * otherwise be shown (and on a runtime load: baked) next to the placed
 * instance. They are parse output of THIS load that was never rendered, so
 * detaching is enough: no GPU resource exists yet, and their materials and
 * textures may be shared with the rest of the parsed file, so nothing is
 * disposed here. Returns the number of direct children removed.
 */
export function discardStoredReferenceContent(referenceNode: Object3D): number {
  const count = referenceNode.children.length;
  if (count === 0) return 0;
  for (const child of [...referenceNode.children]) referenceNode.remove(child);
  reportReferenceContentDiscarded({
    nodePath: NodeRegistry.computeNodePath(referenceNode) || referenceNode.name,
    label: referenceNode.name || '(unnamed)',
    count,
  });
  return count;
}

/**
 * Thrown by loadGLB when the destructive bake fails for a reason that is NOT
 * an abort (plan-757 mental model 6 / D7, Phase 3 commit A). There is no
 * unbaked runtime to fall back to: the load rejects, the Problems panel
 * carries a `bake-failed` entry naming the asset and the cause, and the
 * caller shows its load error. A superseded load is `LoadAbortedError`
 * instead — an abort is never a failure.
 */
export class BakeFailedError extends Error {
  /** The thrown error's message — what the Problems entry shows. */
  readonly reason: string;
  /** The error the bake threw. */
  readonly inner: unknown;
  constructor(url: string, inner: unknown) {
    const reason = inner instanceof Error ? inner.message : String(inner);
    super(`Bake failed: ${url} — ${reason}`);
    this.name = 'BakeFailedError';
    this.reason = reason;
    this.inner = inner;
  }
}

/** Pending component awaiting resolveComponentRefs + init() in Step 2 */
export interface PendingComponent {
  component: RVComponent;
  type: string;
  path: string;
}

export interface DeferredLogic {
  pending: PendingComponent[];
  context: ComponentContext;
}

// ═══════════════════════════════════════════════════════════════════
// Phase Functions — extracted from loadGLB() for readability
// ═══════════════════════════════════════════════════════════════════

/** Parsed GLTF data with the root scene node and parser metadata. */
export interface PreparedGLTF {
  root: Object3D;
  gltfParser: GltfParserLike | undefined;
  signatureState: SignatureState;
  signaturePresent: boolean;
  signerOrganization?: string;
  /** Provenance token of the parsed buffer ({@link LoadResult.modelSourceUrl}). */
  sourceUrl: string | null;
}

/**
 * Load and parse a GLTF/GLB file and park the root under an UNRENDERED staging
 * parent. `loadGLB` moves it into `scene` once every load phase has finished
 *: the render loop keeps ticking during the async phases,
 * and `renderer.render` walks `scene.updateMatrixWorld()` over every node
 * regardless of `visible` — on an unfrozen 70k-node CAD tree that cost ~30 s of
 * a load of the large CAD line. The staging parent (not a bare detached root) keeps
 * `NodeRegistry.computeNodePath` identical: it stops at the parentless top node.
 * Returns the root Object3D and parser metadata for renamed-node detection.
 *
 * When `data` is supplied the bytes are parsed directly (no internal fetch) —
 * the caller already downloaded the GLB (e.g. main.ts streams it with progress,
 * a timeout and retries). This avoids the GLTFLoader re-fetching the file and,
 * crucially, avoids the blob-URL double-buffering that doubled peak memory and
 * caused out-of-memory blank scenes for large models on mobile.
 */
/** Binary-resource document id of the current main load (plan-498). */
let _mainResourceDocumentId: string | null = null;

/** Binary-resource document id of a main-model load (plan-498). */
export function mainDocumentIdOf(url: string): string {
  return `glb:${url}`;
}

export async function loadAndPrepareGLTF(url: string, _scene: Scene, data?: ArrayBuffer): Promise<PreparedGLTF> {
  debug('loader', `Loading ${url}...`);
  resetParityValidator(); // Clear any previous load's parity data
  // Every fetch here goes through the script-trust fetch boundary
  // (rv-script-trust.ts): the body buffer is tokened with the final,
  // non-redirected Response.url — a URL load of a bundled demo GLB carries the
  // same provenance as main.ts' streamed `data` load.
  const fetchBytes = async (): Promise<ArrayBuffer> => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`GLB fetch failed (${response.status} ${response.statusText}): ${url}`);
    return readTrackedBody(response, { stream: false });
  };
  const initialBuffer = data ?? await fetchBytes();
  // Read BEFORE verification: a large signed buffer is transferred to the
  // signature worker and comes back as a new ArrayBuffer object.
  const initialSourceUrl = fetchedUrlOf(initialBuffer);
  // Will this fit? Filed as a Problems entry BEFORE the parse, so a tab that
  // dies in the bake has already said why (rv-load-memory-budget.ts).
  reportLoadMemoryBudget(url, initialBuffer.byteLength);
  // Every caller — main.ts, plugins, scene loader and asset editor — passes
  // through this raw-byte verification point. Large buffers make a transferable
  // worker round-trip; its detached-buffer failures get one geometry-only fetch.
  const verified = await verifyRvSigBuffer(initialBuffer, fetchBytes);
  // Provenance follows the bytes the parser reads (rv-script-trust.ts).
  const sourceUrl = parsedBufferSourceUrl(initialSourceUrl, verified);
  // plan-2059: the strict DES fingerprint hashes the exact bytes the parser
  // reads — taken AFTER verification (the only step that may transfer the
  // buffer to a worker), never awaited, so the load is not delayed.
  void recordDocumentBytes(url, verified.buffer);
  // Self-contained GLB (textures + buffers embedded) → empty resource path is
  // correct; external-resource glTF is not produced by the Unity exporter.
  // THE parse wrapper (plan-498): embedded FMU packages go into the binary
  // resource store under this load's document id; the previous main load's
  // packages are released (one main model at a time).
  const documentId = mainDocumentIdOf(url);
  if (_mainResourceDocumentId && _mainResourceDocumentId !== documentId) {
    binaryResources.releaseDocument(_mainResourceDocumentId);
  }
  _mainResourceDocumentId = documentId;
  const gltf = await parseGlbCollectingResources(verified.buffer, documentId, gltfLoader);
  debug('loader', `GLTF parsed, staging root outside the rendered scene`);
  const root = gltf.scene;
  // Corrupt vertex data never leaves the parser: every load path (HMI,
  // placements, embed, asset editor) starts here.
  dropNonFiniteGeometry(root);
  const staging = new Object3D();
  staging.name = '_rvLoadStaging';
  staging.add(root);

  const gltfParser = (gltf as unknown as { parser?: PreparedGLTF['gltfParser'] }).parser;
  return {
    root,
    gltfParser,
    signatureState: verified.state,
    signaturePresent: verified.signaturePresent,
    signerOrganization: verified.signerOrganization,
    sourceUrl,
  };
}

/** What {@link dropNonFiniteGeometry} did to one load. */
export interface NonFiniteGeometryReport {
  /** Meshes whose position data held NaN / Infinity, by node name. */
  dropped: string[];
}

/**
 * Remove every mesh whose POSITION data is not finite — before anything reads
 * bounds from it.
 *
 * A CAD conversion can leave a primitive of pure NaN vertices behind (the pick-and-place cell
 * cell's `E06780344_AF0_1`: 5220 NaN vertices, accessor min/max `null`). The
 * old in-place pipeline tolerated it because the part was its own mesh and its
 * NaN bounds happened to stay out of the framing path. The destructive bake
 * merges the part into the root's static chunk, ONE `expandByPoint(NaN)` makes
 * the whole chunk's bounds NaN, `frameSceneContent()` frames NaN bounds, and the
 * camera, the ground disc, the reflector and the sun all land at NaN — an empty
 * grey viewport with a healthy scene graph behind it (2026-09-24).
 *
 * Runs on every parse — HMI, planner placements, embed and the asset editor —
 * so no consumer ever sees the data. A bare CAD part (no extras, no children)
 * is removed outright; a mesh that other things hang off keeps its node and
 * loses only the geometry (an empty position attribute is what the bake and
 * `Box3.setFromObject` both treat as "nothing here").
 */
export function dropNonFiniteGeometry(root: Object3D): NonFiniteGeometryReport {
  const dropped: string[] = [];
  const victims: Mesh[] = [];
  root.traverse((node: Object3D) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    const pos = mesh.geometry?.getAttribute('position');
    if (!pos) return;
    const arr = pos.array as ArrayLike<number>;
    for (let i = 0; i < arr.length; i++) {
      if (!Number.isFinite(arr[i])) { victims.push(mesh); break; }
    }
  });
  for (const mesh of victims) {
    dropped.push(mesh.name || '(unnamed)');
    const bare = mesh.children.length === 0 && !mesh.userData?.realvirtual;
    mesh.geometry.dispose();
    if (bare && mesh.parent) {
      mesh.removeFromParent();
      continue;
    }
    const empty = new BufferGeometry();
    empty.setAttribute('position', new BufferAttribute(new Float32Array(0), 3));
    empty.setIndex([]);
    mesh.geometry = empty;
  }
  if (dropped.length > 0) {
    logWarn(`[loader] ${dropped.length} mesh(es) with non-finite vertex data dropped (corrupt CAD export): ${dropped.slice(0, 8).join(', ')}${dropped.length > 8 ? ', …' : ''}`);
  }
  return { dropped };
}

/** Result of processMeshes — contains mesh stats and the drive node set. */
export interface MeshProcessResult {
  triangleCount: number;
  /** Mesh nodes seen in the traversal (before any merge pass). */
  meshCount: number;
  driveNodeSet: Set<Object3D>;
}

/**
 * Pre-scan for MOTION/TransportSurface nodes and classify meshes:
 * shadow casting, matrixAutoUpdate, triangle counting.
 *
 * CRITICAL: Returns driveNodeSet — it MUST be passed to subsequent functions
 * so moving meshes are NOT incorrectly set to matrixAutoUpdate = false.
 */
export function processMeshes(root: Object3D): MeshProcessResult {
  let triangleCount = 0;
  let meshCount = 0;
  let noShadowCount = 0;

  // Pre-scan: motion/TransportSurface node sets for shadow classification
  // Collect the motion node set for static/dynamic classification (Phase 1.3)
  // We need a two-step approach: first find all movers, then classify meshes
  //
  // `Kinematic` counts as a mover, not just `Drive`. A KinematicMechanism moves
  // its PASSIVE links — a Delta's six rods and its platform — by writing their
  // node transforms every tick, and those links carry `Kinematic` (a rigid
  // group) with no Drive of their own. Classifying them as static froze them
  // twice over: `matrixAutoUpdate = false` below meant the solver's writes never
  // reached matrixWorld, and `driveAnchor()` put them in the root-parented
  // static chunk, which cannot move by construction. Symptom: a mechanism that
  // jogs perfectly in the asset editor while in every merged load — the F5 test
  // run, HMI, planner — the driven arms move and the rods and platform hang
  // frozen in mid-air. ("The asset editor is fine" because `preserveHierarchy`
  // skips the bake — 10c — so the static chunk never claims the
  // links. It is emphatically NOT because the editor skips this classification:
  // the freeze below runs on EVERY load, in every mode. Reading that comment as
  // "the editor is exempt from load-time structure work" is what let the
  // kinematic re-parenting of Phase 8b stay ungated for so long; see plan-727
  // and `reclassifyKinematicGroupsDynamic`.)
  //
  // This mirrors the mover roles of rv-freeze-static.ts, which already keep
  // `Kinematic` subtrees matrix-dynamic; the two classifications disagreeing was
  // the bug.
  const driveNodeSet = new Set<Object3D>();
  const transportSurfaceNodeSet = new Set<Object3D>();

  // `Drive`/`Drive_*` (behaviours) and the rigid group `Kinematic`/`Kinematic_N`.
  // Deliberately NOT KinematicJoint / KinematicMechanism / KinematicTarget: those
  // are descriptive nodes, and anchoring meshes to them would mis-group whole
  // subtrees (a mechanism container is typically an ancestor of everything).
  const MOTION_KEY = /^Drive|^Kinematic(_\d+)?$/i;

  // Web handling (plan-459/460) moves nodes WITHOUT a Drive: `RVRibbonPath`
  // writes the quaternion of every FOLLOWER roller, `RVRibbonDancer` writes a
  // position and `RVRibbonWinder` a scale, all of them straight onto the node.
  // Classified as static below they get `matrixAutoUpdate = false`, those writes
  // never reach `matrixWorld`, and only the DRIVEN rollers of a slitter appear
  // to turn while every idler, dancer and roll stands frozen. Same reasoning
  // (and the same exception) as `isMoverNode` in `rv-freeze-static.ts`, whose
  // freeze is the second half of the same bug.
  const WEB_MOTION_KEY = /^Ribbon(Path|Roller|Winder|Dancer)/i;
  // A `RibbonRoller` with `SpinMode: Texture` deliberately does NOT move — it
  // scrolls its mantle map and leaves the node pose alone — so it may stay
  // static, exactly as `rv-freeze-static.ts` decides. `RibbonDancer` TRANSLATES,
  // so the exception is carried by the anchored `RibbonRoller` prefix rather
  // than a loose `Ribbon` one.
  const RIBBON_ROLLER_KEY = /^RibbonRoller/i;

  // plan-673: MuJoCo deep physics moves nodes WITHOUT a Drive too. The mirror
  // writes `node.position`/`node.quaternion` of every `FreeBody` from qpos each
  // tick, and `Movable` is the same claim for a user drag. Classified as static
  // below they get `matrixAutoUpdate = false`, those writes never reach
  // `matrixWorld`, and the obstacle cubes of the walker demo stand frozen on
  // their authored pose while the physics and the collision are perfectly fine
  // — the robot walks through the PICTURE of the cube. Measured on the live
  // demo, `obs_cube_s2` over 40.8 s: qpos +506.0 mm, node `position` +506.0 mm,
  // drawn chunk `matrixWorld` 0.0000 mm; the same write with
  // `matrixAutoUpdate = true` moved the chunk by the full amount.
  //
  // READ THIS AS A LIST THAT GROWS, not as three special cases. Every entry
  // below was added by the SAME bug reported a third, fourth and fifth time:
  // `Kinematic` (plan-727, passive links), `Ribbon*` (plan-459/460, idlers and
  // dancers), now `FreeBody`/`Movable` (plan-673, physics bodies). The rule
  // behind all of them: ANY component that writes a node's local pose at
  // runtime must appear here, because a static classification silently
  // disconnects `position`/`quaternion` from what is drawn, and no error is
  // reported anywhere. When you add the next such component, add it here in the
  // same breath — and prefer the structural guarantee: `freezeStaticMatrices`
  // (rv-freeze-static.ts) now FORCES `matrixAutoUpdate = true` on every local
  // mover it knows from the bake roles, which is the net that catches the entry
  // somebody forgets to add here.
  const PHYSICS_MOTION_KEY = /^(FreeBody|Movable)$/i;

  // One set for every component that writes its own node pose but is not a
  // Drive. Deliberately SEPARATE from `driveNodeSet`: that set is also the
  // bake's mover split and the `driveAnchor()` grouping, while these types
  // already carry their own `keep`/`chunk` bake role (`bakeRoleOf`,
  // rv-component-registry.ts). Only the `matrixAutoUpdate` question is
  // answered here.
  const poseWriteNodeSet = new Set<Object3D>();

  root.traverse((node: Object3D) => {
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv) return;
    // ONE pass over the component keys, answering both questions. Two loops
    // read more clearly and cost a second walk of every node's component map on
    // every load of every document — the overwhelming majority of which carry no
    // web at all — so the two `break`s become two flags instead.
    let isDriveNode = false;
    let isPoseWriteNode = false;
    for (const key in rv) {
      if (!rv[key]) continue;
      if (!isDriveNode && MOTION_KEY.test(key)) isDriveNode = true;
      if (!isPoseWriteNode && WEB_MOTION_KEY.test(key)
        && !(RIBBON_ROLLER_KEY.test(key) && (rv[key] as { SpinMode?: unknown }).SpinMode === 'Texture')) {
        isPoseWriteNode = true;
      }
      if (!isPoseWriteNode && PHYSICS_MOTION_KEY.test(key)) isPoseWriteNode = true;
      if (isDriveNode && isPoseWriteNode) break;
    }
    if (isDriveNode) driveNodeSet.add(node);
    if (isPoseWriteNode) poseWriteNodeSet.add(node);
    if (rv['TransportSurface']) transportSurfaceNodeSet.add(node);
  });

  function isUnderDrive(node: Object3D): boolean {
    // Include the node itself: a Drive can be authored directly on a Mesh.
    // Starting at parent incorrectly froze such meshes as static.
    let current: Object3D | null = node;
    while (current) {
      if (driveNodeSet.has(current)) return true;
      current = current.parent;
    }
    return false;
  }

  function isUnderTransportSurface(node: Object3D): boolean {
    let current: Object3D | null = node;
    while (current) {
      if (transportSurfaceNodeSet.has(current)) return true;
      current = current.parent;
    }
    return false;
  }

  /**
   * True when the node itself, or an ancestor, is posed by a non-Drive
   * component that writes its local transform at runtime (web handling,
   * MuJoCo `FreeBody`, `Movable`).
   *
   * The empty-set early-out is not micro-optimisation: this is asked for EVERY
   * mesh that is not already under a drive — which in an ordinary factory
   * document is nearly all of them — and without it every one of those meshes
   * walks its whole ancestor chain to the root to learn that a document with
   * none of those components in it has none of them in it. The set is built one
   * traverse earlier, so the answer is already known before the walk starts.
   */
  function isUnderPoseWrite(node: Object3D): boolean {
    if (poseWriteNodeSet.size === 0) return false;
    let current: Object3D | null = node;
    while (current) {
      if (poseWriteNodeSet.has(current)) return true;
      current = current.parent;
    }
    return false;
  }

  // Shadow classification and triangle counting
  root.traverse((node: Object3D) => {
    if ((node as Mesh).isMesh) {
      meshCount++;
      const mesh = node as Mesh;
      const shouldCast = classifyShadows(mesh);
      if (!shouldCast) {
        const mat = mesh.material as { transparent?: boolean; alphaTest?: number; opacity?: number } | undefined;
        noShadowCount++;
        debugVerbose('loader', `No shadow: ${node.name} (transparent=${mat?.transparent}, alphaTest=${mat?.alphaTest}, opacity=${mat?.opacity})`);
        mesh.castShadow = false;
      } else {
        // Opaque meshes ALL cast shadows. Plan-094 originally disabled
        // castShadow on static meshes to skip per-mesh shadow-pass draws,
        // but that meant users saw no shadows from walls, frames, fixtures,
        // and factory structure. With the uber merge collapsing bulk
        // untextured statics into one draw, the remaining per-mesh cost is
        // only paid by textured static meshes — and only when the shadow
        // map actually rebuilds (i.e. when a drive moves; `_shadowsDirty`
        // keeps the map cached while everything is idle).
        mesh.castShadow = true;
        // `isUnderDrive` walks the PARENT chain, so it misses the case where the
        // Drive sits directly ON a mesh node (the mesh IS the drive node — common
        // for CAD imports like a CAD-import showcase model where every moving part is a single mesh).
        // Without the self-check that mesh gets matrixAutoUpdate=false and the
        // renderer never rebuilds its matrix from the quaternion applyToNode()
        // sets — so the drive reports running/rotating but the geometry never
        // visibly moves. A drive node is always dynamic.
        const underDrive = driveNodeSet.has(node) || isUnderDrive(node) || isUnderPoseWrite(node);
        const underTS = isUnderTransportSurface(node);
        const isStatic = !underDrive || underTS;
        if (isStatic) {
          mesh.matrixAutoUpdate = false; // static: never moves
        }
      }
      mesh.receiveShadow = true;
    }
    const geo = (node as Mesh).geometry as BufferGeometry | undefined;
    if (geo) {
      if (geo.index) {
        triangleCount += geo.index.count / 3;
      } else if (geo.attributes?.position) {
        triangleCount += geo.attributes.position.count / 3;
      }
    }
  });

  if (noShadowCount > 0) {
    debug('loader', `Shadow classification: ${noShadowCount} mesh(es) excluded (transparent / alpha-tested) — ?debug=loader,verbose lists them`);
  }

  return { triangleCount, meshCount, driveNodeSet };
}

/** Kinematic node data collected during traversal. */
export interface KinematicNodeEntry {
  node: Object3D;
  data: Record<string, unknown>;
}

/**
 * Build GroupRegistry from collected group nodes.
 */
export function buildGroups(
  groupNodes: { node: Object3D; key: string; data: Record<string, unknown> }[],
  registry: NodeRegistry,
): GroupRegistry | null {
  if (groupNodes.length === 0) return null;

  const groups = new GroupRegistry();
  for (const { node, data } of groupNodes) {
    if (data['_enabled'] === false) continue;
    const groupName = data['GroupName'] as string | undefined;
    if (!groupName) continue;
    const prefix = data['GroupNamePrefix'] as string | undefined;
    let resolvedName = groupName;
    if (prefix) {
      const prefixNode = registry.getNode(prefix);
      if (prefixNode) {
        resolvedName = prefixNode.name + groupName;
      }
    }
    groups.register(resolvedName, node);
  }
  const groupNames = groups.getGroupNames();
  debug('loader', `Groups: ${groups.groupCount} groups [${groupNames.join(', ')}]`);
  return groups;
}

/**
 * Resolve the kinematic GROUP NAMES of a subtree (the `IntegrateGroupEnable`
 * half of Unity's `Kinematic.Awake()`), for `GroupRegistry.markAsKinematic()`
 * and the editor's group-assignment menu (plan-727 F9). `GroupNamePrefix`
 * resolves to the prefix NODE's name — the same rule the `Kinematic` pre-bake
 * hook applies (`rv-pre-bake-hooks.ts`).
 *
 * Names only — nothing is moved here. The re-parenting itself (group members
 * under the axis, `KinematicParentEnable` axes under their parent) happens
 * ONCE, in `prepare` of the ONE recipe (`prepareAndBake` → `runPreBakeHooks`,
 * plan-754/757), before any component exists; the init runs on a template that
 * already has the final hierarchy. plan-757 Phase 3 commit B deleted the
 * runtime re-parent passes this function used to carry (`applyKinematicParenting`),
 * so an init that does NOT bake — the asset editor, a test session, a load
 * without a bake registry — sees the AUTHORED tree, which is exactly what the
 * plan-727 invariant demands of it.
 */
export function resolveKinematicGroupNames(
  kinematicNodes: KinematicNodeEntry[],
  groups: GroupRegistry | null,
  registry: NodeRegistry,
): string[] {
  const kinematicGroupNames: string[] = [];
  for (const { node: kinNode, data } of kinematicNodes) {
    if (data['IntegrateGroupEnable'] !== true) continue;

    const groupName = data['GroupName'] as string ?? '';
    if (!groupName) continue;

    const prefixRef = data['GroupNamePrefix'] as { path?: string } | string | undefined;
    let resolvedName = groupName;
    if (prefixRef) {
      const prefixPath = typeof prefixRef === 'string' ? prefixRef : prefixRef.path;
      if (prefixPath) {
        const prefixNode = registry.getNode(prefixPath);
        if (prefixNode) resolvedName = prefixNode.name + groupName;
      }
    }

    if (!groups?.get(resolvedName)) {
      debug('loader', `[Kinematic] ${kinNode.name}: group "${resolvedName}" not found, skipping`);
      continue;
    }
    kinematicGroupNames.push(resolvedName);
  }
  return kinematicGroupNames;
}

/**
 * The kinematic group names a DRIVE actually moves — the ones that are
 * structure, not a user-facing visibility group.
 *
 * A `Kinematic` with `IntegrateGroupEnable` and no drive anywhere above it is
 * just a rigid group: the pick-and-place cell's `Cover` node integrates the enclosure
 * cover so it can be shown and hidden as one thing, and hiding THAT from the
 * Groups panel (which auto-excludes every kinematic group, and persists the
 * exclusion) took the one group the operator wants away (2026-09-24). Moved
 * means: a `Drive`/`Drive_*` on the kinematic node or an ancestor, or — for an
 * axis that is not physically under its parent yet (authoring load) — a
 * `KinematicParentEnable` parent that is moved.
 */
export function resolveDrivenKinematicGroupNames(
  kinematicNodes: KinematicNodeEntry[],
  groups: GroupRegistry | null,
  registry: NodeRegistry,
): string[] {
  const driven = new Set<string>();
  for (const entry of kinematicNodes) {
    if (!isKinematicNodeDriven(entry, kinematicNodes, registry, new Set())) continue;
    for (const name of resolveKinematicGroupNames([entry], groups, registry)) driven.add(name);
  }
  return [...driven];
}

function hasDriveOnOrAbove(node: Object3D): boolean {
  let cur: Object3D | null = node;
  while (cur) {
    const rv = cur.userData?.realvirtual as Record<string, unknown> | undefined;
    if (rv && Object.keys(rv).some(k => /^Drive/.test(k))) return true;
    cur = cur.parent;
  }
  return false;
}

function isKinematicNodeDriven(
  entry: KinematicNodeEntry,
  all: KinematicNodeEntry[],
  registry: NodeRegistry,
  seen: Set<Object3D>,
): boolean {
  if (seen.has(entry.node)) return false;
  seen.add(entry.node);
  if (hasDriveOnOrAbove(entry.node)) return true;
  if (entry.data['KinematicParentEnable'] !== true) return false;
  // plan-769 Phase 3: `Parent` in any stored form (a web-saved file holds an address).
  const stored = storedReferenceValue(entry.data['Parent']);
  const parent = stored === null ? null
    : typeof stored === 'string' ? registry.getNode(stored) : registry.storedNode(entry.node, stored);
  if (!parent) return false;
  if (hasDriveOnOrAbove(parent)) return true;
  const parentEntry = all.find(e => e.node === parent);
  return parentEntry ? isKinematicNodeDriven(parentEntry, all, registry, seen) : false;
}

/**
 * Phase 8a-bis (plan-727): group-aware dynamic reclassification.
 *
 * `processMeshes()` classifies a mesh as static by walking the PHYSICAL parent
 * chain (`isUnderDrive`). A kinematic group member carries only `Group`, not
 * `Kinematic`, so without re-parenting the driven axis is not one of its
 * ancestors and the mesh is frozen with `matrixAutoUpdate = false` — after
 * which three.js never rebuilds its matrix from the quaternion a drive writes,
 * and the drive "runs" while the geometry stands still (the failure the comment
 * above `processMeshes`'s isStatic branch describes verbatim).
 *
 * Until plan-727 the only corrector was the runtime re-parent pass of the
 * init (deleted with plan-757 Phase 3 commit B), which existed only where
 * re-parenting actually happened. This asks the semantic question instead —
 * "is this mesh MOVED by a drive?" rather than "does it hang under one?" — and
 * therefore runs in ALL modes (root fix). On a baked template the members
 * already sit under the axis (the `Kinematic` hook moved them) and this is a
 * no-op; in an authoring load it is the only corrector.
 *
 * It is deliberately NOT in `processMeshes()`: groups (and with them
 * `GroupNamePrefix`, which needs `registry.getNode()`) are resolved only much
 * later in the phase order, so a classification there would either miss
 * prefixed groups entirely or match the wrong instance by raw name.
 *
 * MONOTONE: only ever sets `matrixAutoUpdate = true`, never `false` — it can
 * only add dynamic nodes, never take one away.
 */
export function reclassifyKinematicGroupsDynamic(
  groupNames: readonly string[],
  groups: GroupRegistry | null,
): void {
  for (const member of collectKinematicGroupMembers(groupNames, groups)) {
    member.traverse((n: Object3D) => { n.matrixAutoUpdate = true; });
  }
}

/**
 * The member nodes of the given (already resolved) kinematic group names.
 *
 * These are the nodes a drive moves WITHOUT owning them in the node tree — the
 * exact set every physical-parent-chain classification gets wrong once the
 * authoring load stops re-parenting (plan-727). Used by the `matrixAutoUpdate`
 * reclassification above and, for the same reason, by the Phase-11
 * `matrixWorldAutoUpdate` freeze.
 */
export function collectKinematicGroupMembers(
  groupNames: readonly string[],
  groups: GroupRegistry | null,
): Object3D[] {
  if (!groups || groupNames.length === 0) return [];
  const out: Object3D[] = [];
  for (const name of groupNames) {
    const info = groups.get(name);
    if (!info) continue;
    out.push(...info.nodes);
  }
  return out;
}

// ─── Unity marker key normalization (plan-419) ──────────────────────────

/**
 * Unity `Web*` marker keys → their canonical viewer component key.
 *
 * `WebCollisionRole` is the Unity-side marker (CLAUDE.md § "Web* naming
 * convention") that makes a collision role authorable in the Unity scene, so it
 * survives every re-export instead of having to be patched back into the GLB by
 * hand. The exporter keys rv_extras by the C# `type.Name`, and a C# class
 * `CollisionRole` could not carry a field of the same name (CS0542) — hence the
 * `Web` prefix on the class and the canonical name on the field.
 *
 * ONE entry today, deliberately not a general alias system (plan-419
 * Alternative 1): a second `registerComponent` factory for the alias would
 * construct a SECOND `RVCollisionRole` on the same node — the factory loops run
 * every matching factory — with an order-dependent winner.
 */
const COMPONENT_KEY_ALIASES: ReadonlyArray<readonly [alias: string, canonical: string]> = [
  ['WebCollisionRole', 'CollisionRole'],
];

/**
 * Rewrite Unity marker keys in an rv_extras object to their canonical viewer
 * keys, IN PLACE, BEFORE any factory loop reads it (plan-419 F3).
 *
 * Contract:
 * - alias only        → renamed to the canonical key (the alias is removed, so
 *                       exactly one factory matches and exactly one instance
 *                       exists; a viewer-side re-export then writes the
 *                       canonical, web-native key)
 * - canonical present → the alias is left untouched and IGNORED. `CollisionRole`
 *                       (web-native authoring / rv-extras overlay) wins
 *                       deterministically, and since no factory is registered
 *                       for the alias it stays inert.
 * - no alias          → no-op (the hot path: one `in` check per node)
 *
 * "Canonical present" tolerates a `null`/`undefined` value as absent, matching
 * the factory loops' own truthiness test — otherwise an empty canonical stamp
 * would suppress the alias AND build nothing.
 *
 * Must be called from EVERY construction path that reads rv_extras:
 * {@link traverseAndRegister} (the one traversal behind {@link initSubtree})
 * and {@link createRuntimeNode} (op-log `addNode`).
 * {@link constructComponentOnNode} deliberately does NOT call it — see the note
 * on that function.
 */
export function normalizeComponentKeys(rv: Record<string, unknown> | null | undefined): void {
  if (!rv) return;
  for (const [alias, canonical] of COMPONENT_KEY_ALIASES) {
    const aliasData = rv[alias];
    if (aliasData === undefined || aliasData === null) continue;
    const canonicalData = rv[canonical];
    if (canonicalData !== undefined && canonicalData !== null) continue;
    rv[canonical] = aliasData;
    delete rv[alias];
  }
}

/** Collected data from the main traversal step. */
export interface TraverseResult {
  drives: RVDrive[];
  pending: PendingComponent[];
  /** PLC signals `registerSignal` accepted (unknown signal types are skipped). */
  signalsRegistered: number;
  muTemplateNodes: Object3D[];
  groupNodes: { node: Object3D; key: string; data: Record<string, unknown> }[];
  kinematicNodes: KinematicNodeEntry[];
  recordingData: CompactRecording | null;
  recorderSettings: RecorderSettings | null;
  replayRecordingConfigs: { node?: Object3D; sequence: string; startOnSignal: ComponentRef | null; isReplayingSignal: ComponentRef | null; activeOnly: ActiveOnly }[];
  pipelineNodes: { pipes: Object3D[]; tanks: Object3D[]; pumps: Object3D[]; processingUnits: Object3D[] };
  /** Load-time metadata cost stats (DevTools): nodes carrying RuntimeMetadata
   *  extras (counted BEFORE the dev kill-switch strips them), and the number /
   *  total wall-clock cost of component AABB builds (`createAABBFromExtras`). */
  metadataStats: { metadataNodes: number; aabbCount: number; aabbBuildMs: number };
}

/**
 * The ONE traversal (plan-754 F13/D19): register nodes, signals, drives and
 * components of `root`. STEP 1 "Awake" — construct, applySchema, register ALL.
 *
 * Every entry point reaches it through {@link initSubtree}: the main model, a
 * layout placement, an editor-rebuilt subtree. There is no leaner variant any
 * more — validation, the overlay, renamed-node signal names, MU templates,
 * pipeline components, AASLinks and the recordings run for all of them, because
 * a problem is a problem wherever the subtree came from.
 */
export function traverseAndRegister(
  root: Object3D,
  registry: NodeRegistry,
  signalStore: SignalStore,
  renamedNodes: Map<Object3D, string>,
  overlay?: RVExtrasOverlay,
): TraverseResult {
  const drives: RVDrive[] = [];
  const pending: PendingComponent[] = [];
  const muTemplateNodes: Object3D[] = [];
  const groupNodes: { node: Object3D; key: string; data: Record<string, unknown> }[] = [];
  const kinematicNodes: KinematicNodeEntry[] = [];
  let recordingData: CompactRecording | null = null;
  let recorderSettings: RecorderSettings | null = null;
  let signalsRegistered = 0;
  const replayRecordingConfigs: TraverseResult['replayRecordingConfigs'] = [];

  // Pipeline nodes for tooltip hover
  const pipeNodes: Object3D[] = [];
  const tankNodes: Object3D[] = [];
  const pumpNodes: Object3D[] = [];
  const processingUnitNodes: Object3D[] = [];

  // Load-time metadata cost stats (DevTools "Picking & Highlight")
  const metadataStats = { metadataNodes: 0, aabbCount: 0, aabbBuildMs: 0 };

  root.traverse((node: Object3D) => {
    // plan-754: a destructive bake places its chunk meshes BEFORE this traverse
    // (the in-place bake added them after it, which is why they never needed a
    // guard). They are render artefacts, not document nodes: registering them
    // would give every mover a phantom child path like `Axis1/mover:Axis1` and
    // put it in front of every path consumer, the hierarchy included.
    if (node.userData?.[RV_BAKE_CHUNK_KEY]) return;

    // Skip Layout-Planner ghost / held-preview / drag-ghost clones. These are
    // pure-visual previews that may have copied a source's rv-extras via
    // Object3D.clone(); instantiating components on them would create recursive
    // Sources that spawn endlessly and nest under the source. A main-model load
    // never carries them, so folding the guard in here (plan-754 F13) costs one
    // property read and removes the last reason for a second traversal.
    if (node.userData?._isSourceGhost || node.userData?._isSourcePreview || node.userData?._isGhost) return;

    // Register ALL nodes in registry (Phase 1)
    const path = NodeRegistry.computeNodePath(node);
    registry.registerNode(path, node);

    // Apply rv-extras overlay BEFORE components read userData.realvirtual.
    // The overlay can introduce new component types on a node — so always run
    // this step regardless of whether the node already has rv-extras.
    if (overlay) applyOverlayToNode(node, path, overlay);

    // AAS links come ONLY from authored data (the `AASLink` extras below, or the
    // overlay above) — a node's name never attaches one. The former name rule
    // (/motor|antrieb/i, /^drive/i → SEW KA47 demo shell) put a demo datasheet
    // on customer motors and was removed.

    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv) return;

    // plan-419: Unity `Web*` marker keys → canonical viewer keys. Runs AFTER
    // the overlay (an overlay-authored `CollisionRole` must win) and BEFORE any
    // consumer, so the factory loop below sees exactly one key.
    normalizeComponentKeys(rv);

    // Counted before the kill-switch strip so the stat reflects what the GLB
    // carries in both modes (enabled = built, disabled = would be built).
    if (rv['RuntimeMetadata']) metadataStats.metadataNodes++;

    // Dev kill-switch (Settings → Dev Tools): strip the Runtime* interaction
    // extras BEFORE any consumer reads them, so the model loads exactly as if
    // they were never authored — no component instances, no hover/select
    // promotion, no hierarchy badges, no tooltip/inspector entries. Perf
    // diagnosis for metadata-heavy models.
    if (!isMetadataLoadingEnabled()) {
      delete rv['RuntimeMetadata'];
      delete rv['RuntimeInteractable'];
      delete rv['RuntimeUIWindow'];
    }

    // Authored hidden flag (editor eye toggle, persisted as rv.Hidden because
    // glTF has no node visibility). Re-apply to `.visible` so hidden nodes stay
    // hidden across GLB save/load round-trips. Pick paths key on rv.Hidden
    // (raycast BVH) — this only restores the render state.
    if (rv['Hidden'] === true) {
      node.visible = false;
    }
    // plan-2016 S5: Unity `activeSelf: false` — hidden at load, flagged for MU clones.
    applyAuthoredInactive(node);

    // PLC Signals (registered first, before components that reference them)
    for (const sigType of SIGNAL_TYPES) {
      if (rv[sigType]) {
        const sigData = rv[sigType] as Record<string, unknown>;
        validateExtras(sigType, sigData);
        if (registerSignal(node, sigType, sigData, path, signalStore, registry, renamedNodes.get(node))) {
          signalsRegistered++;
        }
      }
    }

    // Drive (special case: inline construction, behaviors, initDrive)
    if (rv['Drive']) {
      const driveData = rv['Drive'] as Record<string, unknown>;
      validateExtras('Drive', driveData);

      const driveResult = constructDrive(
        node, rv, driveData, path, registry, signalStore,
        (bKey, bExtras) => { validateExtras(bKey, bExtras); },
      );
      if (driveResult) {
        const { drive, pendingBehaviors, behaviors } = driveResult;
        drives.push(drive);
        for (const pb of pendingBehaviors) pending.push(pb);

        debug('loader',
          `Drive: ${node.name} [${drive.Direction}${drive.ReverseDirection ? ' REV' : ''}]` +
          ` path="${path}"` +
          (drive.UseLimits ? ` limits=[${drive.LowerLimit}, ${drive.UpperLimit}]` : '') +
          ` speed=${drive.TargetSpeed}` +
          (behaviors.length > 0 ? ` behaviors=[${behaviors.join(',')}]` : '')
        );
      }
    }

    // Auto-discovered components (via registered factories). Runtime*
    // interaction extras were already stripped above when the dev
    // kill-switch is off.
    for (const [type, factory] of getRegisteredFactories()) {
      if (!rv[type]) continue;
      const data = rv[type] as Record<string, unknown>;
      validateExtras(type, data);
      let aabb: AABB | null = null;
      if (factory.needsAABB) {
        const aabbStart = performance.now();
        aabb = createAABBFromExtras(node, rv);
        metadataStats.aabbBuildMs += performance.now() - aabbStart;
        metadataStats.aabbCount++;
      }
      const instance = factory.create(node, aabb);
      if (factory.beforeSchema) factory.beforeSchema(instance, data);
      applySchema(instance as unknown as Record<string, unknown>, factory.schema, data);
      if (factory.afterCreate) factory.afterCreate(instance, node);
      registry.register(type, path, instance);
      pending.push({ component: instance, type, path });
    }

    // MU templates
    if (rv['MU']) {
      validateExtras('MU', rv['MU'] as Record<string, unknown>);
      muTemplateNodes.push(node);
    }

    // Group components (Group, Group_1, Group_2, ...)
    for (const key of Object.keys(rv)) {
      if (key === 'Group' || /^Group_\d+$/.test(key)) {
        const gData = rv[key] as Record<string, unknown>;
        validateExtras('Group', gData);
        groupNodes.push({ node, key, data: gData });
      }
    }

    // Kinematic components — collect for post-group re-parenting
    if (rv['Kinematic']) {
      const kinData = rv['Kinematic'] as Record<string, unknown>;
      const integrateGroup = kinData['IntegrateGroupEnable'] === true;
      const kinParent = kinData['KinematicParentEnable'] === true;
      if (integrateGroup || kinParent) {
        const groupName = kinData['GroupName'] as string | undefined;
        // Guard: skip if IntegrateGroupEnable but GroupName is falsy
        if (kinParent || (integrateGroup && groupName)) {
          kinematicNodes.push({ node, data: kinData });
        }
      }
    }

    // DrivesRecording / DrivesRecorder / ReplayRecording (special cases)
    // Pipeline components (Pipe, ResourceTank, Pump) — construct as RVComponent classes.
    // Each class validates extras, applies schema, attaches itself to
    // node.userData._rvComponentInstance, and syncs the legacy _rvPipe/_rvTank/_rvPump
    // userData view so downstream consumers (rv-pipe-flow, rv-tank-fill)
    // continue to work unchanged.
    if (rv['Pipe']) {
      new RVPipe(node, rv['Pipe'] as Record<string, unknown>);
      pipeNodes.push(node);
      registry.register('Pipe', path, node);
    }
    if (rv['ResourceTank']) {
      new RVTank(node, rv['ResourceTank'] as Record<string, unknown>);
      tankNodes.push(node);
      registry.register('Tank', path, node);
    }
    if (rv['Pump']) {
      new RVPump(node, rv['Pump'] as Record<string, unknown>);
      pumpNodes.push(node);
      registry.register('Pump', path, node);
    }
    if (rv['ProcessingUnit']) {
      new RVProcessingUnit(node, rv['ProcessingUnit'] as Record<string, unknown>);
      processingUnitNodes.push(node);
      registry.register('ProcessingUnit', path, node);
    }

    // RuntimeMetadata is handled by the RVMetadata factory component (rv-metadata.ts),
    // discovered via the registered-factories loop above.

    // AASLink — Asset Administration Shell link.
    // Can coexist with Drive/Pipe/etc. — only sets _rvType if no other type is present.
    // The `!_rvAasLink` guard keeps a re-traversal idempotent: a node that already
    // carries its link (and resolution mark) is not reset to 'pending'.
    if (rv['AASLink'] && !node.userData._rvAasLink) {
      const aas = rv['AASLink'] as Record<string, unknown>;
      validateExtras('AASLink', aas);
      node.userData._rvAasLink = {
        aasId: (aas['AASId'] as string) ?? '',
        description: (aas['Description'] as string) ?? '',
        serverUrl: (aas['ServerUrl'] as string) ?? '',
      };
      // Mark unresolved until the AASX index answered (see aas-resolution.ts).
      markAasPending(node);
      if (!node.userData._rvType) {
        node.userData._rvType = 'AASLink';
      }
    }

    // Check for DrivesRecording (compact format or ScriptableObject inline)
    if (rv['DrivesRecording_compact'] && !recordingData) {
      recordingData = parseCompactRecording(rv['DrivesRecording_compact'] as Record<string, unknown>);
    }
    if (rv['DrivesRecorder']) {
      const recorderData = rv['DrivesRecorder'] as Record<string, unknown>;
      validateExtras('DrivesRecorder', recorderData);
      recorderSettings = {
        playOnStart: (recorderData['PlayOnStart'] as boolean) ?? true,
        replayStartFrame: (recorderData['ReplayStartFrame'] as number) ?? 0,
        replayEndFrame: (recorderData['ReplayEndFrame'] as number) ?? 0,
        loop: (recorderData['Loop'] as boolean) ?? false,
        activeOnly: parseActiveOnly(recorderData),
      };
      debug('loader', `DrivesRecorder: PlayOnStart=${recorderSettings.playOnStart} (raw=${recorderData['PlayOnStart']}), ` +
        `Loop=${recorderSettings.loop}, ReplayFrames=[${recorderSettings.replayStartFrame}..${recorderSettings.replayEndFrame}]`);
      if (!recordingData) {
        const recRef = recorderData['DrivesRecording'] as Record<string, unknown> | undefined;
        if (recRef && recRef['type'] === 'ScriptableObject') {
          recordingData = parseScriptableObjectRecording(recRef);
        }
      }
    }
    for (const key of Object.keys(rv)) {
      if (key === 'ReplayRecording' || key.match(/^ReplayRecording_\d+$/)) {
        const rrData = rv[key] as Record<string, unknown>;
        validateExtras('ReplayRecording', rrData);
        const sequence = (rrData['Sequence'] as string) ?? '';
        const startOnSignal = (rrData['StartOnSignal'] as ComponentRef) ?? null;
        const isReplayingSignal = (rrData['IsReplayingSignal'] as ComponentRef) ?? null;
        const rrActiveOnly = parseActiveOnly(rrData);
        replayRecordingConfigs.push({ node, sequence, startOnSignal, isReplayingSignal, activeOnly: rrActiveOnly });
      }
    }
  });

  // Hide MU templates (before init — sources need them hidden). A pre-placed
  // MU (plan-516) is revealed again by `classifyPreplacedMUs` once the sources
  // resolved their templates; its authored visibility is kept for that.
  for (const muNode of muTemplateNodes) {
    if (!authoredMUVisibility.has(muNode)) authoredMUVisibility.set(muNode, muNode.visible);
    muNode.visible = false;
    debug('loader', `MU template: ${muNode.name} (hidden)`);
  }

  return {
    drives,
    pending,
    signalsRegistered,
    muTemplateNodes,
    groupNodes,
    kinematicNodes,
    recordingData,
    recorderSettings,
    replayRecordingConfigs,
    pipelineNodes: { pipes: pipeNodes, tanks: tankNodes, pumps: pumpNodes, processingUnits: processingUnitNodes },
    metadataStats,
  };
}

// ─── Pre-placed MUs (plan-516) ──────────────────────────────────────────

/** Authored `visible` of every MU node the traversal hid (template or not). */
const authoredMUVisibility = new WeakMap<Object3D, boolean>();

/**
 * Classify the MU nodes of the MAIN MODEL (plan-516 F1): an MU is a Source
 * TEMPLATE when a registered Source references it — as its own node or as its
 * resolved `ThisObjectAsMU` template — or references one of its ancestors;
 * every other MU is PRE-PLACED. Pre-placed MUs become visible again (the
 * traversal hid every MU), get a snapshot of their authored pose and a
 * collider-sized {@link RVMovingUnit}, and are handed to the transport manager
 * — which registers them for simulation only at sim start
 * (`activatePreplaced`).
 *
 * MUST run after the sources' `init()` (their `muTemplate` is resolved there),
 * so a logic-gated load calls it at the gate release, not at load.
 * Idempotent: an MU node already registered is skipped, so a second call
 * (gate release after a partial classification) registers nothing twice.
 *
 * Not for planner placements (their subtree roots are skipped — placements
 * keep the template semantics, plan-519) and not for authoring loads (the
 * caller does not call it there). `excluded` are nodes whose components never
 * initialise (a less-trusted referenced frame): their sources are unknown, so
 * their MUs stay hidden.
 *
 * @returns the MUs classified by THIS call.
 */
export function classifyPreplacedMUs(
  root: Object3D,
  transportManager: RVTransportManager,
  excluded?: ReadonlySet<Object3D> | null,
): RVMovingUnit[] {
  const referenced = new Set<Object3D>();
  for (const source of transportManager.sources) {
    referenced.add(source.node);
    if (source.muTemplate) referenced.add(source.muTemplate);
  }
  const found: Object3D[] = [];
  const visit = (node: Object3D, underTemplate: boolean): void => {
    const ud = node.userData;
    if (node !== root && (isLayoutPlacementRoot(node) || ud?._layoutObject === true)) return;
    if (ud?._isSourceGhost || ud?._isGhostOverlay || ud?._isSourcePreview) return;
    const template = underTemplate || referenced.has(node);
    if (!template && isMUNode(node) && !excluded?.has(node) && !transportManager.isPreplacedNode(node)) {
      found.push(node);
    }
    for (const child of node.children) visit(child, template);
  };
  visit(root, false);

  root.updateMatrixWorld(true);
  const box = new Box3();
  const created: RVMovingUnit[] = [];
  for (const node of found) {
    const visible = authoredMUVisibility.get(node) ?? true;
    node.visible = visible;
    const parent = node.parent;
    if (!parent) continue;
    computeMUColliderFrameBox(node, box);
    const half = box.isEmpty() ? undefined : box.getSize(new Vector3()).multiplyScalar(0.5);
    const center = box.isEmpty() ? undefined : box.getCenter(new Vector3());
    const mu = new RVMovingUnit(node, '', half, center);
    mu.preplaced = true;
    // plan-2016 S5 Codex fix: sensors detect a pre-placed MU's ACTIVE colliders
    // too (triggers included), like a spawned one.
    mu.refreshDetectionShape();
    mu.loadSeatDepth = readLoadSeatDepth(node); // plan-577 F2 (re-read at every activation)
    mu.snapshot = {
      parent,
      position: node.position.clone(),
      quaternion: node.quaternion.clone(),
      scale: node.scale.clone(),
      visible,
    };
    transportManager.registerPreplaced(mu, resolveSpawnParent(root, node));
    created.push(mu);
    debug('loader', `MU pre-placed: ${node.name}`);
  }
  return created;
}

/**
 * Reconcile overlay overrides that the Phase-5 traverse could not apply because
 * the override's stored node-path differs from the path the node had during
 * traversal — chiefly when kinematic re-parenting (Phase 8b) moves a node and
 * changes its path, but also for space/underscore/suffix/alias differences.
 *
 * Runs after the registry is final (Phase 8c). For each override node-path it
 * resolves the node through the registry (which normalizes + suffix/alias
 * matches), then applies the override. `applyOverlayToNode` is idempotent and
 * returns whether anything changed — overrides already applied during traversal
 * (exact path match) report no change and are skipped. Only genuinely-missed
 * overrides trigger a re-sync of the live component so runtime reflects the
 * override (e.g. a drive's targetSpeed), without re-caching the base transform.
 */
export function reconcileOverlayOverrides(
  registry: NodeRegistry,
  overlay: RVExtrasOverlay,
): void {
  for (const nodePath of Object.keys(overlay.nodes)) {
    const node = registry.getNode(nodePath);
    if (!node) continue;
    const changed = applyOverlayToNode(node, nodePath, overlay);
    if (!changed) continue; // already applied during traversal (exact match)

    // Push the now-applied userData values into each live component instance.
    const fields = overlay.nodes[nodePath];
    const rv = node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
    for (const componentType of Object.keys(fields)) {
      const instance = registry.getByPath<RVComponent>(componentType, nodePath);
      if (!instance) continue;
      const data = rv?.[componentType] ?? {};
      const schema = getRegisteredFactories().get(componentType)?.schema
        ?? (instance.constructor as { schema?: ComponentSchema }).schema;
      if (schema) applySchema(instance as unknown as Record<string, unknown>, schema, data);
      // Drives re-derive their config->runtime split; drive behaviors refresh reset baselines.
      if (instance instanceof RVDrive || componentType.startsWith('Drive_')) instance.reapplyConfig?.();
    }
    debug('loader', `[overlay] reconciled missed override at "${nodePath}"`);
  }
}

/**
 * Register alias paths for nodes renamed by Three.js dedup.
 * Must happen AFTER Step 1 (signals registered) and BEFORE Step 2 (refs resolved).
 *
 * Aliases cover the renamed node AND ITS WHOLE SUBTREE (plan-381 F5). Three.js
 * dedups names file-globally, so two `Pusher` nodes in different branches leave
 * one of them as `Pusher_1` — an exported reference to
 * `Kinematics_MC07/Pusher/vertical` then resolves against nothing, because the
 * old implementation aliased only the renamed node itself and the suffix
 * fallback matches on the LEAF (`vertical`), never on the broken middle
 * segment. Every descendant therefore gets its own pre-dedup path alias.
 *
 * Cost control: the renamed set is reduced to its TOPMOST members first, then
 * each of those subtrees is walked exactly once behind a shared visited set —
 * nested renames cannot make this quadratic.
 *
 * The walk and the spelling rules live in {@link forEachNodeAlias}
 * (rv-node-aliases.ts); this function is the RUNTIME consumer of it, adding the
 * SignalStore aliases and the load diagnostics. The destructive pipeline's
 * `prepare` registry is the other consumer (plan-754 Phase 1c) and MUST see the
 * identical spellings — hence one walk, two callers.
 *
 * BOTH spellings are published (plan-734 F3). `renamedNodes` now carries the
 * RAW glTF name, so the reconstructed path is the one the file authored — but
 * already-delivered content, exported overlays and internal callers may address
 * the SANITIZED spelling that this function used to be the only source of.
 * Registering both costs one extra Map entry per affected node and removes a
 * whole class of "resolves on my machine" differences.
 *
 * @returns Counters for the load diagnosis (plan-734 F8). `droppedAliases`
 *   matters more than it looks: {@link NodeRegistry.registerAlias} gives up
 *   silently when the path is already taken, and publishing two spellings
 *   doubles the surface for that — a dropped alias that shadows a real node is
 *   otherwise completely invisible.
 */
export function registerNodeAliases(
  renamedNodes: Map<Object3D, string>,
  registry: NodeRegistry,
  signalStore: SignalStore,
): AliasStats {
  const t0 = performance.now();
  const empty = (): AliasStats => ({
    nodeAliases: 0,
    signalAliases: 0,
    droppedAliases: 0,
    largestSuffixBucket: { suffix: '', count: 0 },
    ms: performance.now() - t0,
  });
  if (renamedNodes.size === 0) return empty();

  let nodeAliases = 0;
  let signalAliases = 0;
  let droppedAliases = 0;
  // Largest suffix bucket across the aliases we add — the cost signal for the
  // registry's O(bucket) suffix scan (plan-734 F8).
  const suffixCounts = new Map<string, number>();

  // The walk itself lives in rv-node-aliases.ts — `prepare` needs the exact
  // same spellings, and a second copy of it is the defect plan-754 Phase 1c
  // had to fix (see that module's header).
  forEachNodeAlias(renamedNodes, (node, currentPath, origPaths) => {
    for (const origPath of origPaths) {
      // registerAlias() gives up when the path is already claimed — count
      // that, because a dropped alias shadowing a live node is otherwise
      // completely invisible.
      if (!registry.registerAlias(origPath, node)) { droppedAliases++; continue; }
      nodeAliases++;
      const suffix = origPath.slice(origPath.lastIndexOf('/') + 1);
      suffixCounts.set(suffix, (suffixCounts.get(suffix) ?? 0) + 1);
      debugVerbose('loader', `Node alias: "${origPath}" → "${currentPath}"`);
    }

    // Signal alias — exact lookup only. `nameForPath()` would suffix-scan and
    // negative-cache once per plain geometry node in the subtree; a signal's
    // canonical registration path is by definition an exact hit.
    const sigName = signalStore.exactNameForPath(currentPath);
    if (sigName === undefined) return;
    for (const origPath of origPaths) {
      // ADDITIVE alias (plan-381 F11): `register()` would repoint the canonical
      // name→path mapping at this historical spelling.
      if (signalStore.registerPathAlias(sigName, origPath)) {
        signalAliases++;
        debugVerbose('loader', `Signal alias: "${origPath}" → signal "${sigName}"`);
      }
    }
  });

  let largestSuffixBucket = { suffix: '', count: 0 };
  for (const [suffix, count] of suffixCounts) {
    if (count > largestSuffixBucket.count) largestSuffixBucket = { suffix, count };
  }

  const stats: AliasStats = {
    nodeAliases, signalAliases, droppedAliases, largestSuffixBucket,
    ms: performance.now() - t0,
  };

  if (nodeAliases > 0) {
    debug('loader',
      `Aliases registered: ${nodeAliases} node path(s), ${signalAliases} signal path(s), `
      + `${droppedAliases} dropped (path already taken); largest suffix bucket `
      + `"${largestSuffixBucket.suffix}" ×${largestSuffixBucket.count}; `
      + `${stats.ms.toFixed(1)} ms — ?debug=loader,verbose lists them`);
  }
  return stats;
}

/**
 * STEP 2 "Start": resolve component refs and call init() on all pending components.
 * The caller builds ONE {@link ComponentContext} (loadGLB shares it with
 * {@link runOnSceneReady}) — adding a context member no longer means growing
 * two 10-parameter signatures in lockstep.
 */
export function initializeComponents(
  pending: PendingComponent[],
  context: ComponentContext,
): { initialized: number; failed: number } {
  let initialized = 0;
  let failed = 0;
  // Fmu first: its init() creates the signal leaves other references resolve to.
  const ordered = [...pending.filter((p) => p.type === FMU_TYPE), ...pending.filter((p) => p.type !== FMU_TYPE)];
  for (const { component, type, path } of ordered) {
    // Isolate each component: a single component's resolve/init throwing must not
    // abort the whole model load (which would leave the scene/hierarchy unbuilt).
    try {
      resolveComponentRefs(component as unknown as Record<string, unknown>, context.registry, context.root);
      component.init(context);
      if (!context.registry.getByPath(type, path)) {
        context.registry.register(type, path, component);
      }
      initialized++;
    } catch (e) {
      failed++;
      console.error(`[loader] component init failed for "${component.node?.name}":`, e);
    }
  }
  return { initialized, failed };
}

/**
 * Late-init pass: invokes `onSceneReady()` on every pending component that
 * implements it. Called by the scene loader AFTER kinematic re-parenting
 * (Phase 8b), so components that need the final child hierarchy (e.g. for
 * AABB-driven gizmos like RVSafetyDoor) see the reparented meshes.
 */
export function runOnSceneReady(
  pending: PendingComponent[],
  context: ComponentContext,
): { initialized: number; failed: number } {
  let initialized = 0;
  let failed = 0;
  for (const { component } of pending) {
    if (typeof component.onSceneReady === 'function') {
      // Isolate each component: a single onSceneReady throwing must not abort the
      // late-init pass for every following component (this loop is otherwise not
      // try/catch-wrapped, unlike initializeComponents).
      try {
        component.onSceneReady(context);
        initialized++;
      } catch (e) {
        failed++;
        console.error(`[loader] component onSceneReady failed for "${component.node?.name}":`, e);
      }
    }
  }
  return { initialized, failed };
}

/**
 * Mark TransportSurface drives before kinematic parenting/batching without
 * installing subscriptions or registering transport runtime behavior.
 */
export function prepareTransportSurfaces(
  pending: PendingComponent[],
  context: ComponentContext,
): void {
  for (const item of pending) {
    if (item.type !== 'TransportSurface') continue;
    try {
      const component = item.component as RVComponent & {
        DriveReference?: RVDrive;
        drive?: RVDrive | null;
      };
      resolveComponentRefs(component as unknown as Record<string, unknown>, context.registry, context.root);
      const drive = component.DriveReference
        ?? component.drive
        ?? context.registry.findInParent<RVDrive>(component.node, 'Drive');
      if (drive) drive.isTransportSurface = true;
    } catch (error) {
      console.warn(`[loader] TransportSurface prepare failed for "${item.path}":`, error);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// initSubtree — THE one init (plan-754 F13 / D19)
// ═══════════════════════════════════════════════════════════════════

/** Phases {@link initSubtree} reports through {@link SubtreeInitContext.mark}. */
export type SubtreeInitPhase =
  | 'traverseAndRegister'
  | 'registerNodeAliases'
  | 'initializeComponents'
  | 'kinematics';

/** An alias entry the place step hands to the init — asset-relative path → INSTANCE node. */
export interface SubtreeAlias {
  /** Asset-relative (root = `''`), see `BakedAlias`. */
  path: string;
  node: Object3D;
  /** Authored path of a re-parented subtree: also a prefix alias (plan-610 Phase 5c, `BakedAlias.subtree`). */
  subtree?: true;
}

/**
 * Everything {@link initSubtree} needs: the shared half comes from ONE builder
 * ({@link buildInitContext}, plan-757 F4), the fields below are PER SOURCE —
 * what the caller knows about this subtree and nobody else does.
 */
export interface SubtreeInitContext extends InitContextBase {
  /**
   * glTF name-dedup map (`node → original name`). `loadGLB` has the parser's
   * map; every other entry derives it from the `_rvOrigName` stamps the parse
   * step left behind, because a placed subtree is a CLONE and the
   * Object3D-keyed map cannot follow it.
   */
  renamedNodes?: Map<Object3D, string>;

  /**
   * AUTHORING (plan-727): the asset editor saves the tree it sees, so
   * components that materialise runtime geometry must not build it
   * (`ComponentContext.authoring`). The init never moves a node in ANY mode
   * since plan-757 Phase 3 commit B — re-parenting is the `Kinematic` pre-bake
   * hook's job — so this flag no longer gates a kinematic pass.
   */
  preserveAuthoringHierarchy?: boolean;
  /**
   * Untrusted logic: components are constructed and registered, but neither
   * `init()` nor `onSceneReady()` runs. The caller gets them back as
   * {@link SubtreeInitResult.deferredLogic} and activates them later.
   */
  logicGated?: boolean;
  /**
   * plan-397 per-frame trust gate: components on these nodes are constructed but
   * never initialised, and stay out of the deferred-logic hand-over.
   */
  gatedNodes?: Set<Object3D> | null;

  /**
   * plan-757 D4: the baked asset's path aliases, resolved to THIS instance's
   * nodes (`PlacementInstance.aliases`) — the historical spellings of renamed
   * nodes and the AUTHORED path of every subtree a pre-bake hook re-parented.
   * Registered prefixed with the subtree root's registry path, so a reference
   * serialized against the authoring hierarchy resolves for the main model and
   * for every placement alike.
   */
  aliases?: ReadonlyArray<SubtreeAlias>;
  /**
   * plan-757 F7: further names the subtree root is known by — the baked
   * template's name for a placement whose reference node the planner renamed
   * (`Arburg_1` places `Arburg`). Registered as the root's reference scope
   * together with its current and its glTF-authored name, so a root-prefixed
   * reference (`Arburg/Kine`) resolves inside the instance.
   */
  assetRootNames?: ReadonlyArray<string | undefined | null>;

  /** Per-phase timing hook (load profiler / `web_layout_timings`). */
  mark?: (phase: SubtreeInitPhase) => void;
}

/** What {@link initSubtree} produces. A superset of {@link ProcessExtrasResult}. */
export interface SubtreeInitResult {
  drives: RVDrive[];
  /** Every constructed component, gated ones included. */
  pending: PendingComponent[];
  /** The components that were (or will be) initialised — `pending` minus gated. */
  trusted: PendingComponent[];
  signalsRegistered: number;
  componentsCreated: number;
  deferredLogic: DeferredLogic | null;
  /** The ONE context the init and late-init passes shared. */
  context: ComponentContext;
  muTemplateNodes: Object3D[];
  groups: GroupRegistry | null;
  kinematicGroupNames: string[];
  drivenKinematicGroupNames: string[];
  recordingData: CompactRecording | null;
  recorderSettings: RecorderSettings | null;
  replayRecordingConfigs: TraverseResult['replayRecordingConfigs'];
  pipelineNodes: TraverseResult['pipelineNodes'];
  metadataStats: TraverseResult['metadataStats'];
  aliasStats: AliasStats;
}

/**
 * Bring a subtree to life — the ONE init of plan-754 (F13, D19).
 *
 * `load → prepare → bake → drop → place → init`: this is step 6, and it is the
 * same function for the main model, a layout placement, an editor-rebuilt
 * subtree and a re-registration. Before plan-754 there were two — the rich
 * `traverseAndRegister`/`initializeComponents`/`runOnSceneReady` sequence for
 * the main model and a leaner `processExtras` that validated nothing — and the
 * difference was silent: a placement whose extras were malformed said so
 * nowhere. Now a problem is a problem wherever the subtree came from.
 *
 * Order (load-bearing):
 *   1. traverse + register (signals, drives, components, groups, kinematics)
 *   2. renamed-node aliases — before refs resolve against them
 *   3. TransportSurface pre-pass (marks drives before the kinematic names)
 *   4. `init()` on every trusted component
 *   5. kinematic group names + dynamic reclassification, overlay reconcile
 *   6. `onSceneReady()` — components that need the FINAL hierarchy
 *
 * The hierarchy the init sees IS the final one: re-parenting and the home-pose
 * stamp happen in `prepare` of the recipe, before the bake (plan-754 D18); the
 * init never moves a node and never drives an axis to home (plan-757 Phase 3
 * commit B deleted the `'bracket'` / `'defer'` home-pose modes with the runtime
 * re-parent passes they protected).
 *
 * What it deliberately does NOT do (the caller's job, and different per entry):
 * LogicStep engines, BVH, WebGPU fixes, bounds, shadow classification, the bake.
 */
export function initSubtree(
  subtreeRoot: Object3D,
  ctx: SubtreeInitContext,
): SubtreeInitResult {
  const { registry, signalStore, scene } = ctx;
  const mark = ctx.mark;

  // ── 1. Traverse: construct, applySchema, register ──
  const renamedNodes = ctx.renamedNodes ?? collectRenamedNodes(subtreeRoot);
  const traversed = traverseAndRegister(subtreeRoot, registry, signalStore, renamedNodes, ctx.overlay);
  mark?.('traverseAndRegister');

  // ── 2. Aliases for glTF-deduplicated names (plan-381 F5) ──
  // After signals are registered, before STEP 2 resolves refs against them.
  const aliasStats = registerNodeAliases(renamedNodes, registry, signalStore);
  // ── 2b. The baked asset's own alias table (plan-757 D4): asset-relative
  // paths, prefixed with this subtree's registry path. The template arrived
  // with the FINAL hierarchy, so the canonical paths are already registered
  // and `registerAlias` refuses a spelling a live node owns.
  if (ctx.aliases && ctx.aliases.length > 0) {
    const rootPath = registry.getPathForNode(subtreeRoot) ?? NodeRegistry.computeNodePath(subtreeRoot);
    // A root with an EMPTY name that still has a parent (the unnamed glTF scene
    // under the staging holder) has two spellings for one asset-relative path:
    // `rel` — how the scoped resolver joins `''` + rel — and `/rel` — how
    // `computeNodePath` spells every canonical path below it. Both are
    // registered, or a lookup in canonical form (`/OldParent/Part/Tip`, built
    // from a canonical sibling path) misses the prefix alias (plan-610 Phase 5c).
    const unnamedParented = rootPath === '' && subtreeRoot.parent !== null;
    for (const { path, node, subtree } of ctx.aliases) {
      if (path === '') continue;
      const spellings = rootPath !== '' ? [`${rootPath}/${path}`] : unnamedParented ? [path, `/${path}`] : [path];
      for (const full of spellings) {
        registry.registerAlias(full, node);
        // plan-610 Phase 5c: a path INTO the moved subtree resolves under its new place.
        if (subtree) registry.registerPrefixAlias(full, node);
      }
    }
  }
  // ── 2c. The subtree root is a REFERENCE SCOPE (plan-757 F7): every
  // ComponentReference below it is read relative to it by the ONE resolver —
  // as written, then with one of these root names stripped. Registered before
  // STEP 2 resolves the first reference.
  registry.registerScopeNames(subtreeRoot, [renamedNodes.get(subtreeRoot), ...(ctx.assetRootNames ?? [])]);
  mark?.('registerNodeAliases');

  // ── 3. ONE ComponentContext, shared by init() and onSceneReady() ──
  const context: ComponentContext = {
    registry, signalStore, scene, transportManager: ctx.transportManager, root: subtreeRoot,
    gizmoManager: ctx.gizmoManager,
    lampManager: ctx.lampManager,
    webLabelManager: ctx.webLabelManager,
    outlineManager: ctx.outlineManager,
    energyChainManager: ctx.energyChainManager,
    sceneButtonManager: ctx.sceneButtonManager,
    chainManager: ctx.chainManager,
    ribbonManager: ctx.ribbonManager,
    machiningManager: ctx.machiningManager,
    collisionManager: ctx.collisionManager,
    dropManager: ctx.dropManager,
    events: ctx.events,
    errorStore: ctx.errorStore,
    instructionStore: ctx.instructionStore,
    highlighter: ctx.highlighter,
    expectSceneReady: true,
    // plan-733 R4 — the asset editor saves the tree it sees, so components that
    // materialise runtime geometry (RVChain element clones) must not build it.
    authoring: ctx.preserveAuthoringHierarchy === true,
    // Read from the singleton at EVERY construction site, never threaded as an
    // option — threading is exactly what gets forgotten on the runtime paths
    // (mechanism-lifecycle T15 counts the sites).
    kinematicManager: getKinematicManager() ?? undefined,
    statsRegistry: getActiveStatsRegistry() ?? undefined,
    // plan-427 — the placement entries are called positionally and own no
    // option bag, so the module slot is the source there.
    reapply: ctx.reapply ?? getActiveSignalReapplyRegistry() ?? undefined,
  };

  const gatedNodes = ctx.gatedNodes;
  const trusted = gatedNodes
    ? traversed.pending.filter((p) => !gatedNodes.has(p.component.node))
    : traversed.pending;

  // ── 4. init(): TransportSurface pre-pass, then every trusted component ──
  prepareTransportSurfaces(traversed.pending, context);
  const logicGated = ctx.logicGated === true;
  if (!logicGated) initializeComponents(trusted, context);
  mark?.('initializeComponents');

  // ── 5. Kinematics: group names, dynamic reclassification ──
  const groups = buildGroups(traversed.groupNodes, registry);

  // `init()` above may have moved anything — `onSceneReady()` below must not
  // read a stale matrixWorld.
  subtreeRoot.updateMatrixWorld(true);

  // Names only: the hierarchy is final (the `Kinematic` hook re-parented on
  // `tmp` before the bake; an authoring load keeps the authored tree, plan-727).
  // The resolved names feed the Groups panel and the editor's group-assignment
  // menu, identically in every mode (plan-727 F9).
  const kinematicGroupNames = resolveKinematicGroupNames(traversed.kinematicNodes, groups, registry);
  const drivenKinematicGroupNames = resolveDrivenKinematicGroupNames(traversed.kinematicNodes, groups, registry);
  if (groups) {
    for (const name of kinematicGroupNames) groups.markAsKinematic(name);
  }
  // plan-727 F8: group members are dynamic because a drive moves them, not
  // because they hang under one. Monotone — only adds.
  reclassifyKinematicGroupsDynamic(kinematicGroupNames, groups);

  // (plan-754 re-aliased the pre-bake re-parenting here; since plan-757 those
  // authored paths travel on the `BakedAsset` and were registered in step 2b.)

  // Overlay overrides the traverse could not apply because the override's stored
  // path differs from the path the node had during traversal (an authored path
  // that a pre-bake hook re-parented, reachable through the aliases of 2b). The
  // registry is final now.
  if (ctx.overlay) reconcileOverlayOverrides(registry, ctx.overlay);

  // ── 6. Late init: components that need the FINAL hierarchy ──
  if (!logicGated) runOnSceneReady(trusted, context);
  mark?.('kinematics');

  // Newly registered signals become O(1)-resolvable.
  signalStore.buildIndex();

  return {
    drives: traversed.drives,
    pending: traversed.pending,
    trusted,
    signalsRegistered: traversed.signalsRegistered,
    componentsCreated: traversed.pending.length,
    deferredLogic: logicGated ? { pending: trusted, context } : null,
    context,
    muTemplateNodes: traversed.muTemplateNodes,
    groups,
    kinematicGroupNames,
    drivenKinematicGroupNames,
    recordingData: traversed.recordingData,
    recorderSettings: traversed.recorderSettings,
    replayRecordingConfigs: traversed.replayRecordingConfigs,
    pipelineNodes: traversed.pipelineNodes,
    metadataStats: traversed.metadataStats,
    aliasStats,
  };
}

// ─── Runtime node creation (op-log `addNode`) ───────────────────────────

/**
 * The sim-loop drive collection, as the runtime construction path needs it
 * (plan-411 Phase 1). `RVViewer` implements it; a test can pass a two-line fake.
 *
 * Why this is threaded through instead of reaching for the viewer: a drive that
 * is only in the NodeRegistry is invisible to the simulation — `CoreSubsystems`
 * ticks `RVViewer.drives`, and nothing else. Registry registration and tick-list
 * membership must therefore happen together, which is what the Drive branch of
 * {@link constructComponentOnNode} does.
 */
export interface DriveLifecycleHost {
  readonly drives: RVDrive[];
  /** Add to the tick list. Idempotent; returns true when it changed. */
  addDrive(drive: RVDrive): boolean;
  /** Remove from the tick list. Returns true when it changed. */
  removeDrive(drive: RVDrive): boolean;
}

/** Subsystems needed to construct + init a component node at runtime. */
export interface RuntimeNodeDeps {
  registry: NodeRegistry;
  signalStore: SignalStore;
  scene: Scene;
  transportManager: RVTransportManager;
  gizmoManager?: GizmoOverlayManager;
  lampManager?: LampManager;
  /** plan-529 — so a runtime-created WebLabel reaches the label pass. */
  webLabelManager?: WebLabelManager;
  /** plan-417 — so a runtime-placed scene button animates and is torn down. */
  sceneButtonManager?: SceneButtonManager;
  energyChainManager?: EnergyChainManager;
  /** plan-733 - so a Chain reaches the per-tick pose registry. */
  chainManager?: ChainManager;
  /** plan-459 - so a RibbonPath reaches the per-tick web registry. */
  ribbonManager?: RibbonManager;
  /** plan-405 — so a runtime-created `MachiningVolume` reaches the manager. */
  machiningManager?: MachiningManager;
  /** plan-394 — so a runtime-created `CollisionRole` reaches the manager. */
  collisionManager?: CollisionRoleRegistrar;
  /**
   * Optional viewer-owned drop-detection registry (plan-2022). The one
   * `DropDetection` component of the scene registers its configuration here;
   * every other component ignores it. Absent (or no component) = the detection
   * is off and no existing model changes behaviour.
   */
  dropManager?: DropDetectionRegistrar;
  outlineManager?: RVOutlineManager;
  /** plan-427 — so a runtime-created component's input slots take part in the
   *  post-reset / post-reconnect level re-apply. Falls back to the module slot. */
  reapply?: SignalReapplyRegistry;
  events?: EventEmitter<ViewerEvents>;
  errorStore?: ErrorStore;
  instructionStore?: InstructionRuntimeStore;
  /** So a runtime-created `WebError` marks its node through the highlight
   *  pipeline (red X-ray overlay + alarm flash) like a loaded one. */
  highlighter?: RVHighlightManager;
  /** plan-411 — so a runtime-created `Drive` reaches the sim-loop tick list.
   *  Absent (legacy callers / path-waypoint creation): the Drive branch of
   *  {@link constructComponentOnNode} refuses rather than building a drive that
   *  would never tick. */
  driveHost?: DriveLifecycleHost;
}

/** A node to create at runtime: transform + `userData.realvirtual` content. */
export interface RuntimeNodeSpec {
  parentPath: string;
  name: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
  components: Record<string, Record<string, unknown>>;
  /** Stable NodeId for a node that is rebuilt again and again (e.g. one per generated vehicle).
   *  Without it every rebuild mints a fresh id, which changes anything keyed by node address. */
  nodeId?: string;
}

/**
 * Create, register, construct and init a single component node at runtime — the
 * op-log `addNode` path (e.g. an inserted IK path waypoint). Mirrors the loader's
 * STEP 1 (construct + applySchema + register) and STEP 2 (resolveComponentRefs +
 * init) for one node. Factory-based components only — Drive and signals are NOT
 * constructed here (path waypoints don't need them). Returns the node, or null
 * if the parent is missing. The node is tagged `userData.__rvAdded` so
 * removeRuntimeNode only ever removes op-created nodes, never original GLB nodes.
 */
export function createRuntimeNode(deps: RuntimeNodeDeps, spec: RuntimeNodeSpec, nodeId?: string): Object3D | null {
  const parent = deps.registry.getNode(spec.parentPath);
  if (!parent) return null;

  const node = new Object3D();
  node.name = spec.name;
  node.position.fromArray(spec.position);
  node.quaternion.fromArray(spec.quaternion);
  node.scale.fromArray(spec.scale);
  node.userData.realvirtual = deepCloneJSON(spec.components);
  node.userData.__rvAdded = true;
  // plan-769 Phase 2 (F11): an op-created node's identity (the op's id map) —
  // runtime only, and set BEFORE the init so its own stored references are read
  // relative to it.
  if (nodeId) assignRuntimeIdentity(node, nodeId);
  parent.add(node);
  node.updateMatrix();
  node.updateMatrixWorld(true);

  const path = NodeRegistry.computeNodePath(node);
  deps.registry.registerNode(path, node);
  deps.registry.registerSubtreeIds?.(node);

  const rv = node.userData.realvirtual as Record<string, unknown>;
  // plan-419: same Unity marker-key normalization as the load-time traverse,
  // before the factory loop below reads the extras.
  normalizeComponentKeys(rv);
  // Same dev kill-switch as the load-time traverse: strip Runtime*
  // interaction extras before any consumer reads them.
  if (!isMetadataLoadingEnabled()) {
    delete rv['RuntimeMetadata'];
    delete rv['RuntimeInteractable'];
    delete rv['RuntimeUIWindow'];
  }
  const constructed: RVComponent[] = [];
  for (const [type, factory] of getRegisteredFactories()) {
    const data = rv[type] as Record<string, unknown> | undefined;
    if (!data) continue;
    const aabb = factory.needsAABB ? createAABBFromExtras(node, rv) : null;
    const inst = factory.create(node, aabb);
    if (factory.beforeSchema) factory.beforeSchema(inst, data);
    applySchema(inst as unknown as Record<string, unknown>, factory.schema, data);
    if (factory.afterCreate) factory.afterCreate(inst, node);
    deps.registry.register(type, path, inst);
    // Fmu first (see initializeComponents).
    if (type === FMU_TYPE) constructed.unshift(inst); else constructed.push(inst);
  }

  const context: ComponentContext = {
    registry: deps.registry, signalStore: deps.signalStore, scene: deps.scene,
    transportManager: deps.transportManager, root: parent,
    gizmoManager: deps.gizmoManager, lampManager: deps.lampManager,
    webLabelManager: deps.webLabelManager,
    sceneButtonManager: deps.sceneButtonManager,
    energyChainManager: deps.energyChainManager,
    chainManager: deps.chainManager,
    ribbonManager: deps.ribbonManager,
    machiningManager: deps.machiningManager,
    collisionManager: deps.collisionManager,
    dropManager: deps.dropManager,
    outlineManager: deps.outlineManager,
    reapply: deps.reapply ?? getActiveSignalReapplyRegistry() ?? undefined,
    events: deps.events, errorStore: deps.errorStore,
    instructionStore: deps.instructionStore,
    highlighter: deps.highlighter,
    kinematicManager: getKinematicManager() ?? undefined,
    statsRegistry: getActiveStatsRegistry() ?? undefined,
  };
  for (const inst of constructed) {
    try {
      resolveComponentRefs(inst as unknown as Record<string, unknown>, deps.registry, node);
      inst.init?.(context);
    } catch (e) {
      console.error(`[loader] runtime node init failed for "${node.name}":`, e);
    }
  }
  return node;
}

/**
 * Construct, register and init ONE factory-based component on an EXISTING
 * node at runtime — the asset editor's `addComponent` path. Mirrors the
 * per-factory block of {@link createRuntimeNode} (STEP 1 construct +
 * applySchema + register, STEP 2 resolveComponentRefs + init) for a single
 * component. `componentType` may carry a `_N` dedup suffix (`Drive_1`) — the
 * factory is resolved from the base type, registration uses the suffixed key
 * (matching the loader's convention so field edits resolve the instance).
 * The caller has already written `data` into `userData.realvirtual[componentType]`.
 * Returns the instance, or null when no factory is registered for the type.
 *
 * CANONICAL EDITOR-ONLY PATH — no {@link normalizeComponentKeys} call here, and
 * that is a verified property, not an omission (plan-419 Phase 2). Every caller
 * supplies a canonical, registered component type:
 *  - `RVAssetExecutors._addComponentWithFields()` is the ONLY production caller.
 *    It runs the op-log `addComponent` / undo-of-`removeComponent` ops, whose
 *    `componentType` is produced by `RVAssetDocument.addComponent()` from a
 *    `baseType` its own callers hard-code (`Kinematic`, `Drive`, `Drive_Simple`,
 *    LogicStep/signal types, mechanism `baseType`s) or, on the MCP route
 *    (`web_editor_add_component`), reject unless the type is in
 *    `getTypesWithCapability('authorable')` — i.e. a REGISTERED factory type.
 *  - Undo of `removeComponent` replays a key that came out of a node's live
 *    rv_extras, which the load paths above have already normalized.
 * A Unity marker key is by construction never registered and never authorable,
 * so it cannot reach here; normalizing would be dead code that only widened the
 * editor's accepted type surface.
 */
export function constructComponentOnNode(
  deps: RuntimeNodeDeps,
  node: Object3D,
  componentType: string,
  data: Record<string, unknown>,
): RVComponent | null {
  const baseType = componentType.replace(/_\d+$/, '');

  // Drive and drive behaviors are the only components WITHOUT a ComponentFactory
  // — their construction carries the behavior-selection and signal-provisioning
  // logic of `constructDrive()`. Two separate cases, deliberately (plan-411 §2.1):
  // a Drive is created, a behavior is ATTACHED to an existing Drive.
  if (baseType === 'Drive') return constructDriveOnNode(deps, node, componentType, data);
  if (DRIVE_BEHAVIOR_MAP[baseType]) {
    return attachDriveBehaviorOnNode(deps, node, componentType, baseType, data);
  }

  const factory = getRegisteredFactories().get(baseType);
  if (!factory) {
    // plan-652 Phase 3: a type of a not-yet-active on-demand feature (DES) is built
    // once the feature is active — if the node still carries it then.
    noteDeferredComponentType(baseType, 'constructComponentOnNode', () => {
      const rvNow = node.userData?.realvirtual as Record<string, unknown> | undefined;
      if (rvNow && componentType in rvNow && getRegisteredFactories().has(baseType)) {
        constructComponentOnNode(deps, node, componentType, data);
      }
    });
    return null;
  }

  const path = NodeRegistry.computeNodePath(node);
  const rv = (node.userData.realvirtual ?? {}) as Record<string, unknown>;
  const aabb = factory.needsAABB ? createAABBFromExtras(node, rv) : null;
  const inst = factory.create(node, aabb);
  if (factory.beforeSchema) factory.beforeSchema(inst, data);
  applySchema(inst as unknown as Record<string, unknown>, factory.schema, data);
  if (factory.afterCreate) factory.afterCreate(inst, node);
  deps.registry.register(componentType, path, inst);

  const context = runtimeComponentContext(deps, node);
  try {
    resolveComponentRefs(inst as unknown as Record<string, unknown>, deps.registry, node);
    inst.init?.(context);
  } catch (e) {
    console.error(`[loader] runtime component init failed for ${componentType} on "${node.name}":`, e);
  }
  return inst;
}

/** The `ComponentContext` the runtime construction paths hand to `init()`. */
function runtimeComponentContext(deps: RuntimeNodeDeps, root: Object3D): ComponentContext {
  return {
    registry: deps.registry, signalStore: deps.signalStore, scene: deps.scene,
    transportManager: deps.transportManager, root,
    gizmoManager: deps.gizmoManager, lampManager: deps.lampManager,
    webLabelManager: deps.webLabelManager,
    sceneButtonManager: deps.sceneButtonManager,
    energyChainManager: deps.energyChainManager,
    chainManager: deps.chainManager,
    ribbonManager: deps.ribbonManager,
    machiningManager: deps.machiningManager,
    collisionManager: deps.collisionManager,
    dropManager: deps.dropManager,
    outlineManager: deps.outlineManager,
    reapply: deps.reapply ?? getActiveSignalReapplyRegistry() ?? undefined,
    events: deps.events, errorStore: deps.errorStore,
    instructionStore: deps.instructionStore,
    highlighter: deps.highlighter,
    kinematicManager: getKinematicManager() ?? undefined,
    statsRegistry: getActiveStatsRegistry() ?? undefined,
  };
}

/**
 * Report a refused runtime construction (plan-411 Phase 1). There is no generic
 * "findings" store in the public repo — the mechanism findings list is
 * mechanism-scoped — so the finding travels as a typed viewer event plus a
 * console error, and the CALLER rolls back the extras stamp. What must never
 * happen is the silent half-state: extras written, no instance, no word.
 */
function refuseConstruction(
  deps: RuntimeNodeDeps, nodePath: string, componentType: string, reason: string,
): null {
  console.error(`[loader] cannot add "${componentType}" at "${nodePath}": ${reason}`);
  deps.events?.emit('component-construction-failed', { nodePath, componentType, reason });
  return null;
}

/**
 * Runtime `addComponent Drive` — construct a real `RVDrive` through the SAME
 * `constructDrive()` the loader uses, then put it in the sim-loop tick list.
 *
 * Idempotent: a node already carrying a registered Drive returns that instance
 * (redo after undo must not produce a second drive at one node).
 */
function constructDriveOnNode(
  deps: RuntimeNodeDeps,
  node: Object3D,
  componentType: string,
  data: Record<string, unknown>,
): RVComponent | null {
  const path = NodeRegistry.computeNodePath(node);
  const existing = deps.registry.getByPath<RVDrive>('Drive', path);
  if (existing) return existing;

  if (!deps.driveHost) {
    return refuseConstruction(deps, path, componentType,
      'no drive lifecycle host — a drive built here would never be ticked');
  }

  // A Drive without `Direction` yields null from constructDrive(). The editor's
  // `addComponent` legitimately starts from an empty field set, so the schema
  // defaults are seeded first — the same values the inspector would show.
  const driveData: Record<string, unknown> = { ...getSchemaDefaults('Drive'), ...data };
  const rv = (node.userData.realvirtual ?? {}) as Record<string, unknown>;
  // Keep the stamp and the instance in step: the caller wrote `data`, we
  // construct from the defaulted record.
  rv[componentType] = driveData;
  node.userData.realvirtual = rv;

  const result = constructDrive(node, rv, driveData, path, deps.registry, deps.signalStore);
  if (!result) {
    return refuseConstruction(deps, path, componentType,
      `Drive has no usable Direction ("${String(driveData['Direction'])}")`);
  }

  const context = runtimeComponentContext(deps, node);
  try {
    resolveComponentRefs(result.drive as unknown as Record<string, unknown>, deps.registry, node);
  } catch (e) {
    console.error(`[loader] runtime Drive ref resolution failed on "${node.name}":`, e);
  }
  // Behaviors authored in the same extras record (a paste / redo of a drive that
  // already carried one) go through loader STEP 2 verbatim.
  for (const pb of result.pendingBehaviors) {
    try {
      resolveComponentRefs(pb.component as unknown as Record<string, unknown>, deps.registry, node);
      pb.component.init?.(context);
    } catch (e) {
      console.error(`[loader] runtime drive behavior init failed for ${pb.type} on "${node.name}":`, e);
    }
  }
  deps.signalStore.buildIndex();

  // ATOMIC with the registry registration constructDrive() just did: from here
  // on the drive is both resolvable and ticking.
  deps.driveHost.addDrive(result.drive);
  return result.drive;
}

/**
 * Runtime `addComponent Drive_<Behavior>` — a separate ATTACH case.
 *
 * Rules (plan-411 §2.1 / T1b):
 *  - No parent Drive at the node ⇒ refused. Silently creating one would invent
 *    a machine axis the user never asked for.
 *  - The same behavior type already registered ⇒ idempotent, returns it.
 *  - Another Drive_* behavior already active ⇒ refused. Exactly one behavior is
 *    active per drive (the loader's rule); a duplicate `_N` key would otherwise
 *    tick a second, invisible model.
 */
function attachDriveBehaviorOnNode(
  deps: RuntimeNodeDeps,
  node: Object3D,
  componentType: string,
  baseType: string,
  data: Record<string, unknown>,
): RVComponent | null {
  const path = NodeRegistry.computeNodePath(node);

  const existing = deps.registry.getByPath<RVComponent>(componentType, path);
  if (existing) return existing;

  const drive = deps.registry.getByPath<RVDrive>('Drive', path);
  if (!drive) {
    return refuseConstruction(deps, path, componentType,
      'the node carries no Drive — add a Drive first');
  }

  const active = drive.Behaviors[0];
  if (active && active !== componentType) {
    return refuseConstruction(deps, path, componentType,
      `"${active}" is already the active behavior of this drive`);
  }

  const entry = DRIVE_BEHAVIOR_MAP[baseType];
  const inst = new entry.ctor(node);
  const record = { ...getSchemaDefaults(baseType), ...data };
  applySchema(inst as unknown as Record<string, unknown>, entry.schema, record);

  const rv = (node.userData.realvirtual ?? {}) as Record<string, unknown>;
  rv[componentType] = record;
  node.userData.realvirtual = rv;

  deps.registry.register(componentType, path, inst);
  drive.Behaviors = [componentType];
  drive.BehaviorExtras = { ...drive.BehaviorExtras, [componentType]: record };

  const context = runtimeComponentContext(deps, node);
  try {
    resolveComponentRefs(inst as unknown as Record<string, unknown>, deps.registry, node);
    inst.init?.(context);
  } catch (e) {
    console.error(`[loader] runtime drive behavior init failed for ${componentType} on "${node.name}":`, e);
  }
  deps.signalStore.buildIndex();
  return inst;
}

/**
 * Inverse of the Drive / drive-behavior branches of {@link constructComponentOnNode}
 * (plan-411 Phase 1): take the component off the node so nothing keeps ticking.
 *
 * Returns true when this function owned the removal — the caller then skips its
 * generic dispose/unregister path. A Drive removal takes its behavior with it:
 * a behavior without its drive is inert metadata, and leaving it registered
 * would make a later re-add look like a duplicate.
 */
export function removeDriveComponentFromNode(
  deps: Pick<RuntimeNodeDeps, 'registry'> & { driveHost?: DriveLifecycleHost },
  nodePath: string,
  componentType: string,
): boolean {
  const baseType = componentType.replace(/_\d+$/, '');
  const registry = deps.registry;

  const disposeAndUnregister = (type: string, instance: unknown): void => {
    try { (instance as { dispose?: () => void }).dispose?.(); }
    catch (e) { console.warn(`[loader] dispose failed for ${type} at "${nodePath}":`, e); }
    registry.unregisterComponent(type, nodePath);
  };

  if (baseType === 'Drive') {
    const drive = registry.getByPath<RVDrive>('Drive', nodePath);
    if (!drive) return false;
    // Behaviors first — their dispose() detaches from the drive it is holding.
    for (const [type, instance] of registry.getComponentsAt(nodePath)) {
      if (type === 'Drive') continue;
      if (!DRIVE_BEHAVIOR_MAP[type.replace(/_\d+$/, '')]) continue;
      disposeAndUnregister(type, instance);
    }
    drive.Behaviors = [];
    drive.BehaviorExtras = {};
    deps.driveHost?.removeDrive(drive);
    disposeAndUnregister(componentType === 'Drive' ? 'Drive' : componentType, drive);
    return true;
  }

  if (DRIVE_BEHAVIOR_MAP[baseType]) {
    const instance = registry.getByPath<RVComponent>(componentType, nodePath);
    if (!instance) return false;
    disposeAndUnregister(componentType, instance);
    const drive = registry.getByPath<RVDrive>('Drive', nodePath);
    if (drive) {
      drive.Behaviors = drive.Behaviors.filter((b) => b !== componentType);
      const next = { ...drive.BehaviorExtras };
      delete next[componentType];
      drive.BehaviorExtras = next;
    }
    return true;
  }

  return false;
}

/** Remove an op-created node (inverse of addNode). No-op on original GLB nodes
 *  (only nodes tagged `__rvAdded` are removed) so a stray removeNode can never
 *  delete real scene geometry. */
export function removeRuntimeNode(registry: NodeRegistry, nodePath: string): void {
  const node = registry.getNode(nodePath);
  if (!node || !node.userData?.['__rvAdded']) return;
  disposeLoadedSubtree(registry, node);
}

// ─── Persisted removal of AUTHORED nodes (plan-628 8.7 / E36) ─────────────
//
// `removeRuntimeNode` refuses every node the file brought (no `__rvAdded`) —
// the protection that keeps a stray `removeNode` from deleting real geometry.
// A few authored nodes must nevertheless be deletable by the user and stay
// deleted across save → reload. That is ONE core, used by the scene executor
// (`removeNode` with `authored: true`), by the load/draft replay (category
// `removedNodes` of `materialise()`) and by the GLB bake (the node is dropped
// from the re-exported file). Which nodes qualify is decided by exactly one
// predicate, {@link isAuthoredRemovalEligible}; every other authored node keeps
// the old protection.

/**
 * May this AUTHORED node be removed persistently? THE eligibility rule of
 * {@link removeAuthoredSubtree}, shared by executor, load replay and bake.
 *
 * plan-628 policy: a node INSIDE the `PathNetwork` subtree that carries a
 * `PathBlock` or a `Path` component (a building block and its paths, or a
 * block-free path under `PathNetwork`). plan-681 may widen this to every
 * `rv_extras.Path` node (drop the ancestor test) with its own tests — nothing
 * else in the removal core depends on the policy.
 */
export function isAuthoredRemovalEligible(node: Object3D): boolean {
  const rv = (node.userData as { realvirtual?: Record<string, unknown> } | undefined)?.realvirtual;
  if (!rv || typeof rv !== 'object') return false;
  if (!rv[PATH_BLOCK_TYPE] && !rv['Path']) return false;
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (cur.name === PATH_NETWORK_NODE) return true;
  }
  return false;
}

/** True when `root` and every node below it pass {@link isAuthoredRemovalEligible}. */
export function isAuthoredSubtreeRemovable(root: Object3D): boolean {
  let ok = true;
  root.traverse((n) => { if (ok && !isAuthoredRemovalEligible(n)) ok = false; });
  return ok;
}

/**
 * Remove the subtree at `nodePath` even when it came from the file — but only
 * when the whole subtree is eligible ({@link isAuthoredSubtreeRemovable}). An
 * op-created node (`__rvAdded`) is removed like {@link removeRuntimeNode} does.
 * Returns true when something was removed; an ineligible or missing node is a
 * no-op (false), never an exception.
 */
export function removeAuthoredSubtree(registry: NodeRegistry, nodePath: string): boolean {
  const node = registry.getNode(nodePath);
  if (!node) return false;
  if (!node.userData?.['__rvAdded'] && !isAuthoredSubtreeRemovable(node)) return false;
  disposeLoadedSubtree(registry, node);
  return true;
}

/**
 * The removal PRIMITIVE without any policy: dispose the subtree's components
 * while their paths still resolve, unregister it and detach it from its parent.
 * {@link removeAuthoredSubtree} and {@link removeRuntimeNode} gate it; plan-681
 * (graph rebuild of generated, loaded paths) calls it under its own rule.
 * Callers own the eligibility decision — this function deletes whatever it gets.
 */
export function disposeLoadedSubtree(registry: NodeRegistry, node: Object3D): void {
  disposeComponentsInSubtree(registry, node);
  registry.unregisterSubtree(node);
  node.parent?.remove(node);
}

/** Dispose registered components while their nodes and paths are still resolvable. */
export function disposeComponentsInSubtree(registry: NodeRegistry, root: Object3D): Set<unknown> {
  const disposed = new Set<unknown>();
  root.traverse((node) => {
    const path = registry.getPathForNode(node);
    if (!path) return;
    for (const [, component] of registry.getComponentsAt(path)) {
      if (disposed.has(component)) continue;
      disposed.add(component);
      const disposable = component as { dispose?: () => void };
      try {
        disposable.dispose?.();
      } catch (error) {
        console.warn(`[loader] component dispose failed at "${path}":`, error);
      }
    }
  });
  return disposed;
}

/**
 * Apply renderer compatibility fixes to the loaded geometry: a zero UV set for
 * meshes without one (node materials sample `uv` unconditionally).
 *
 * The former WebGPU "indexed → non-indexed" conversion is gone on purpose:
 * three r185's WebGPU backend renders indexed geometry correctly, and the
 * conversion ran AFTER the bake, stripping the index the pick structure and
 * the highlight proxies address triangles through (`intersectStructure` and
 * `keepStructure` return null for an index-less geometry, a range proxy
 * shares the chunk's index) — under WebGPU nothing could be hovered or
 * selected. A chunk's index is data after the bake (contract-bake-picking.md
 * § 1.5); nothing may replace it.
 *
 * The UV fix is WebGPU-ONLY. Under WebGL a missing `uv` attribute is simply an
 * unbound vertex input (three's `MeshStandardMaterial` without a map never
 * reads it, and a mapped material samples the attribute's default), while the
 * zero-filled arrays cost 8 bytes per vertex of JS heap AND of VRAM on every
 * baked chunk — 92 MiB on the large CAD line (2026-10-19, 7.5 M triangles), on
 * exactly the machines where the load already runs out of memory.
 */
export function applyWebGPUFixes(root: Object3D, isWebGPU: boolean): void {
  if (!isWebGPU) return;
  let uvFixCount = 0;
  root.traverse((node: Object3D) => {
    if (!(node as Mesh).isMesh) return;
    const geo = (node as Mesh).geometry as BufferGeometry;

    if (!geo.attributes.uv && geo.attributes.position) {
      geo.setAttribute('uv', new BufferAttribute(
        new Float32Array(geo.attributes.position.count * 2), 2,
      ));
      uvFixCount++;
    }
  });
  if (uvFixCount > 0) {
    debug('loader', `Geometry fixes: ${uvFixCount} missing UVs`);
  }
}

/** Options for computeBVHAsync. */
export interface ComputeBVHAsyncOptions {
  /**
   * Abort predicate — checked before every build AND again before every
   * `boundsTree` assignment (load-generation guard, plan-240 F9). Returning
   * true aborts the WHOLE remaining sequence; the in-flight result is
   * discarded (never written to a stale/disposed geometry).
   */
  shouldAbort?: () => boolean;
  /**
   * Geometries whose BVH must be built in INDIRECT mode (the index buffer is
   * the address space of the tree — chunk windows, planner pick bundles).
   * Built FIRST — few in number, largest triangle counts, highest benefit.
   */
  indirectGeometries?: BufferGeometry[];
  /**
   * When false, no build may take the worker's transfer route. The worker
   * DETACHES the geometry's position/index buffers for the duration of a
   * build; if the renderer's FIRST upload of a mesh lands inside that window
   * (a subtree imported into a live, rendering scene), the GPU keeps a
   * zero-size buffer while the draw still uses the attribute's count —
   * `GL_INVALID_OPERATION: glDrawElements: Insufficient buffer size`, and the
   * part stays invisible until the next full load. Callers that add meshes
   * to an ALREADY-RENDERING scene must pass false; the initial load path may
   * keep the worker (its first frame renders after the load completes).
   */
  transferable?: boolean;
}

/**
 * Build all BVHs for a loaded model asynchronously through a BVHBuildPort
 * (plan-240, Baustein 3). Replaces the awaited `computeBVH()` call in the
 * load pipeline:
 *
 *   1. The merged raycast geometries (`indirectGeometries`) are built first
 *      in indirect mode (face-range tables depend on the original index
 *      ordering), then the per-mesh geometries in traversal order — the same
 *      target set and skip logic (`_rvSkipBVH`) as `computeBVH()`.
 *   2. Geometries are deduplicated (shared geometry — e.g. MU clones — is
 *      built once) and each tree is assigned to `geometry.boundsTree` only
 *      after re-checking `shouldAbort()`.
 *   3. Geometries whose underlying ArrayBuffer is shared with another job are
 *      flagged `transferable: false` so the worker port never detaches a
 *      sibling geometry's views.
 *
 * Returns true when the full sequence completed, false when aborted.
 */
export async function computeBVHAsync(
  root: Object3D,
  port: BVHBuildPort,
  options?: ComputeBVHAsyncOptions,
): Promise<boolean> {
  const shouldAbort = options?.shouldAbort ?? ((): boolean => false);
  try {
    await ensureBVHPrototypePatches();
  } catch (e) {
    console.warn('[computeBVHAsync] BVH setup failed (three-mesh-bvh):', e);
    return false;
  }

  // Job list: merged (indirect) geometries first, then per-mesh geometries.
  const seen = new Set<BufferGeometry>();
  const jobs: { geometry: BufferGeometry; indirect: boolean }[] = [];
  for (const geo of options?.indirectGeometries ?? []) {
    if (seen.has(geo) || geo.boundsTree) continue;
    seen.add(geo);
    jobs.push({ geometry: geo, indirect: true });
  }
  root.traverse((node: Object3D) => {
    if (!(node as Mesh).isMesh) return;
    const geo = (node as Mesh).geometry as BufferGeometry | undefined;
    if (!geo) return;
    if (node.userData?._rvSkipBVH) return;
    // A baked chunk is never given a tree here: it has its own pick structure
    // (plan-756), and a non-indirect MeshBVH would REORDER the index that
    // structure's segments address (§2.4a.10). Nothing builds one on a chunk —
    // collision reads the pick structure (plan-781).
    if (node.userData?._rvBakeChunk) return;
    if (seen.has(geo) || geo.boundsTree) return;
    seen.add(geo);
    jobs.push({ geometry: geo, indirect: false });
  });

  // Count ArrayBuffer usage across the job list — a buffer referenced by more
  // than one attribute/geometry must never be transferred to the worker.
  const bufferOf = (arr: ArrayLike<number>): ArrayBufferLike =>
    (arr as unknown as { buffer: ArrayBufferLike }).buffer;
  const bufferUse = new Map<ArrayBufferLike, number>();
  for (const job of jobs) {
    const pos = job.geometry.getAttribute('position');
    if (pos) bufferUse.set(bufferOf(pos.array), (bufferUse.get(bufferOf(pos.array)) ?? 0) + 1);
    const idx = job.geometry.index;
    if (idx) bufferUse.set(bufferOf(idx.array), (bufferUse.get(bufferOf(idx.array)) ?? 0) + 1);
  }

  let built = 0;
  for (const job of jobs) {
    if (shouldAbort()) return false;
    let bvh: unknown;
    try {
      const pos = job.geometry.getAttribute('position');
      const idx = job.geometry.index;
      const sharedBuffer =
        (pos != null && (bufferUse.get(bufferOf(pos.array)) ?? 0) > 1) ||
        (idx != null && (bufferUse.get(bufferOf(idx.array)) ?? 0) > 1);
      bvh = await port.generate(job.geometry, {
        shouldAbort,
        indirect: job.indirect,
        transferable: !sharedBuffer && options?.transferable !== false,
      });
    } catch (e) {
      if (shouldAbort()) return false;
      console.warn('[computeBVHAsync] BVH build failed for a geometry — skipping:', e);
      continue;
    }
    // Load-generation guard: never write to a geometry of a stale load.
    if (shouldAbort()) return false;
    job.geometry.boundsTree = bvh as BufferGeometry['boundsTree'];
    built++;
  }
  debug('loader', `BVH built asynchronously for ${built} geometries (${options?.indirectGeometries?.length ?? 0} merged)`);
  return true;
}

/**
 * Build DrivesPlayback from recording data and recorder settings.
 */
export function buildPlayback(
  recordingData: CompactRecording | null,
  recorderSettings: RecorderSettings | null,
  registry: NodeRegistry,
): RVDrivesPlayback | null {
  if (!recordingData) return null;

  try {
    const playback = new RVDrivesPlayback(recordingData, registry, {
      loop: recorderSettings?.loop ?? false,
    });
    playback.activeOnly = recorderSettings?.activeOnly ?? 'Always';
    debug('loader',
      `DrivesPlayback: ${recordingData.numberFrames} frames, ${recordingData.driveCount} drives, ` +
      `dt=${recordingData.fixedDeltaTime}s loop=${recorderSettings?.loop ?? false}` +
      (recordingData.sequences ? ` sequences=[${recordingData.sequences.map(s => s.name).join(',')}]` : '')
    );
    return playback;
  } catch (e) {
    console.warn(`  DrivesPlayback failed: ${e}`);
    return null;
  }
}

/**
 * Build ReplayRecording instances from configs.
 */
export function buildReplayRecordings(
  configs: TraverseResult['replayRecordingConfigs'],
  playback: RVDrivesPlayback | null,
  registry: NodeRegistry,
  signalStore: SignalStore,
): RVReplayRecording[] {
  if (!playback || configs.length === 0) return [];

  const replayRecordings: RVReplayRecording[] = [];
  for (const cfg of configs) {
    const startAddr = registry.resolve(cfg.startOnSignal, null, cfg.node ?? null).signalAddress ?? null;
    const replayAddr = registry.resolve(cfg.isReplayingSignal, null, cfg.node ?? null).signalAddress ?? null;
    const rr = new RVReplayRecording(cfg.sequence, startAddr, replayAddr, playback, signalStore);
    rr.activeOnly = cfg.activeOnly;
    replayRecordings.push(rr);
    debug('loader',
      `ReplayRecording: "${cfg.sequence}" startSignal=${startAddr ?? 'none'} replayingSignal=${replayAddr ?? 'none'}`
    );
  }
  return replayRecordings;
}

// ═══════════════════════════════════════════════════════════════════
// Sidecar JSON loader
// ═══════════════════════════════════════════════════════════════════

/**
 * Session cache of sidecar probe results, keyed by sidecar URL.
 *
 * Negative results included: a layout that places the same library item five
 * times used to probe the same absent `.kin.json` five times per load — five
 * red 404 lines in every visitor's console. Positive entries hold the raw
 * TEXT and are re-parsed per consumer, so no caller can mutate another's spec.
 */
const _sidecarProbeCache = new Map<string, string | null>();

/** Test seam: forget all cached sidecar probe results. */
export function resetSidecarProbeCache(): void {
  _sidecarProbeCache.clear();
}

/**
 * Attempt to fetch a `<glb>.kin.json` sidecar next to the GLB URL — the ONE
 * sidecar probe of the runtime: the root file (`loadGLB`), every composed
 * frame (`applyFrameSidecars`) and every placed asset (`ModelCache._decode`)
 * go through here, so "absent" means the same thing on every path.
 *
 * Returns the parsed KinematicsSpec on success and null for an ABSENT sidecar
 * — silently: a `blob:` / `data:` url (bytes handed in, no adjacent file), a
 * non-`.glb` url, a network error, a non-2xx answer, an empty body, and an
 * HTML answer. The HTML case is the everyday one: a dev server's SPA fallback
 * and most static hosts answer a missing path with `200 index.html`, and an
 * asset without a sidecar must not put a line into the console for that.
 * Only a body that IS a document but not valid JSON — a real sidecar with a
 * syntax error — warns, once per url (the failure is then negative-cached).
 *
 * The URL transformation strips an optional `?query` part before swapping
 * the `.glb` extension so cache-busted GLB URLs still locate their sidecar.
 *
 * Exported for testing.
 */
export async function tryFetchSidecarSpec(glbUrl: string): Promise<import('../behavior-runtime').KinematicsSpec | null> {
  if (!glbUrl) return null;
  // `rvproject:` (a project document opened by path) is not fetchable — the
  // browser logs a loud error for the attempt before any catch runs.
  if (!isFetchableUrl(glbUrl)) return null;
  // A blob: / data: url is bytes handed in, not a file next to other files.
  if (/^(blob|data):/i.test(glbUrl)) return null;
  const [base, query] = glbUrl.split('?', 2);
  if (!/\.glb$/i.test(base)) return null;
  const sidecarUrl = base.replace(/\.glb$/i, '.kin.json') + (query ? `?${query}` : '');

  let text: string | null;
  if (_sidecarProbeCache.has(sidecarUrl)) {
    text = _sidecarProbeCache.get(sidecarUrl) ?? null;
  } else {
    text = await (async () => {
      let resp: Response;
      try {
        resp = await fetch(sidecarUrl);
      } catch {
        return null; // network error — silent
      }
      if (!resp.ok) return null; // 404 / 403 — silent
      // 200 + HTML is a missing file with a friendly face (SPA fallback,
      // static-host error page) — absent, not a parse error.
      if (/text\/html/i.test(resp.headers.get('content-type') ?? '')) return null;
      let body: string;
      try {
        body = await resp.text();
      } catch {
        return null;
      }
      const trimmed = body.trim();
      if (!trimmed) return null;
      if (trimmed.startsWith('<')) return null; // HTML without an honest content-type
      return body;
    })();
    _sidecarProbeCache.set(sidecarUrl, text);
  }

  if (!text) return null;
  try {
    return JSON.parse(text) as import('../behavior-runtime').KinematicsSpec;
  } catch (e) {
    console.warn(`[sidecar] parse error for ${sidecarUrl}:`, e);
    _sidecarProbeCache.set(sidecarUrl, null); // warn once, then it is absent
    return null;
  }
}

/**
 * Apply each composed occurrence's OWN `<glb>.kin.json` sidecar (plan-397 §2.9).
 *
 * Two rules, both per source file rather than once globally:
 *
 *  - A **signed** referenced file gets no sidecar. It declares itself
 *    self-contained, and an adjacent JSON that could rewrite its kinematics
 *    would make the signature meaningless.
 *  - A sidecar is applied to **its own occurrence only**, with any deeper
 *    occurrences temporarily detached. Node lookup is by name, so leaving them
 *    attached would let one file's sidecar reconfigure another's nodes — the
 *    same escalation the per-frame trust chain exists to prevent.
 */
async function applyFrameSidecars(composition: ComposeResult): Promise<boolean> {
  let modified = false;
  for (const frame of composition.frames) {
    if (frame.signaturePresent) {
      debug('loader', `Signed referenced asset is self-contained: no sidecar for ${frame.assetId || frame.url}`);
      continue;
    }
    const spec = await tryFetchSidecarSpec(frame.url).catch((e) => {
      console.warn(`[loadGLB] sidecar load failed for ${frame.url}:`, e);
      return null;
    });
    if (!spec) continue;

    const nested = composition.frames.filter(
      (f) => f !== frame && f.subtreeRoot.parent && isDescendantOf(f.subtreeRoot, frame.subtreeRoot),
    );
    const detached = nested.map((f) => ({ parent: f.subtreeRoot.parent!, child: f.subtreeRoot }));
    for (const { parent, child } of detached) parent.remove(child);
    try {
      const report = applyKinematicsSpec(frame.subtreeRoot, spec);
      if (sidecarChangedDocument(report)) modified = true;
      debug('loader', `Sidecar applied to ${frame.assetId || frame.url}: drives=${report.applied.drives} `
        + `transports=${report.applied.transports} sensors=${report.applied.sensors}`);
    } finally {
      for (const { parent, child } of detached) parent.add(child);
    }
  }
  return modified;
}

/** Is `node` anywhere below `ancestor`? */
function isDescendantOf(node: Object3D, ancestor: Object3D): boolean {
  let current: Object3D | null = node.parent;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════
// loadGLB — Orchestrator calling phase functions
// ═══════════════════════════════════════════════════════════════════

/**
 * Load a GLB file and extract all realvirtual components.
 *
 * Two-step model (like Unity Awake/Start):
 *   Step 1 "Awake": traverse, construct, applySchema, register ALL
 *   Step 2 "Start": resolveComponentRefs + init() ALL
 *
 * Returns drives, transport manager, signal store, registry, playback and scene
 * metrics. No logic engine: LogicSteps are built by the caller once the scene is
 * complete (plan-769 Phase 6 — `RVViewer` / the embed facade via `mergePlacedLogic`).
 */
export async function loadGLB(url: string, scene: Scene, options?: LoadGLBOptions): Promise<LoadResult> {
  const prof = createLoadProfiler('loadGLB');

  const preserveHierarchy = options?.preserveHierarchy ?? false;

  // Phase 1: parse the GLB. Every model reaches the scene through these bytes —
  // non-GLB sources (STEP, USD) are converted to GLB at import time and cached,
  // so import and reload produce an identical tree (see rv-cad-glb-cache.ts).
  const {
    root: parsedRoot,
    gltfParser,
    signatureState,
    signaturePresent,
    signerOrganization,
    sourceUrl: modelSourceUrl,
  } = await loadAndPrepareGLTF(url, scene, options?.data);
  let sidecarModified = false;
  // `root` is the graph every later phase works on. On the DESTRUCTIVE pipeline
  // (plan-754 D3b) the parse result is only `tmp`: after prepare + bake it is
  // replaced by the template the bake built, and everything from the registry
  // onwards runs on that. On every other path the two are the same object.
  let root = parsedRoot;
  const renderHints = applyRenderHints(parsedRoot);
  const staging = parsedRoot.parent;
  const allowUntrustedLogic = options?.allowUntrustedLogic ?? false;
  const logicGated =
    (signatureState === 'invalid' || signatureState === 'unverifiable')
    && !allowUntrustedLogic;
  prof.mark('gltf-parse');

  // Phase 1a: Detect renamed nodes (Three.js dedup) and capture the parser's
  // index map. MOVED AHEAD of the tree phases (plan-397): composition needs the
  // root file's index map to derive its NodeIds, and the parser is dropped right
  // after the parse. Nothing between here and the old position looked at names
  // or indices, so the move is behaviour-neutral for a model without references.
  //
  // The map's two consumers: `rv-scene-settings-into-model.ts` uses the indices
  // to patch `nodes[i].extras` and the raw names to prove the bytes it
  // re-fetched are still the ones those indices describe.
  const renamedNodes = detectRenamedNodes(gltfParser);
  const gltfNodeIndices = collectGltfNodeIndices(gltfParser);
  const gltfNodeNames = collectGltfNodeNames(gltfParser);

  // Phase 1b: the ROOT file's `<glb>.kin.json` sidecar — applied here, on the
  // un-composed tree, precisely so it can only ever configure the root file's
  // own nodes. Applied after composition it would resolve node names into
  // referenced subtrees and let an unsigned scene reach into a signed asset
  // (§2.9). Spec goes in before component construction so factories see it.
  {
    const sidecarSpec = signaturePresent || options?.loadKinematicsSidecar === false
      ? null
      : await tryFetchSidecarSpec(url).catch((e) => {
          console.warn(`[loadGLB] sidecar load failed for ${url}:`, e);
          return null;
        });
    if (sidecarSpec) {
      const report = applyKinematicsSpec(root, sidecarSpec);
      if (sidecarChangedDocument(report)) sidecarModified = true;
      debug('loader', `Sidecar applied: drives=${report.applied.drives} transports=${report.applied.transports} sensors=${report.applied.sensors}`);
    } else if (signaturePresent) {
      debug('loader', 'Signed model is self-contained: .kin.json sidecar was not applied');
    } else if (options?.loadKinematicsSidecar === false) {
      debug('loader', 'Self-contained load: .kin.json sidecar request disabled');
    }
  }

  // Phase 1.5: COMPOSITION (plan-397). Referenced GLBs are resolved into ONE
  // tree HERE — before processMeshes, the naming scan and the traverse — so a
  // referenced subtree goes through every phase the root file goes through
  // (F15). Skipped outright when the model references nothing, which is every
  // model in the existing corpus.
  let composition: ComposeResult | null = null;
  if (hasReferences(root)) {
    composition = await compose(root, {
      baseUrl: url,
      sha256: options?.sourceSha256,
      gltfNodeIndices,
      signatureState,
      signaturePresent,
      scope: options?.documentScope ?? null,
      resolve: options?.referenceResolver ?? createReferenceResolver(),
      cache: options?.composeCache,
      shouldAbort: options?.shouldAbort,
      // plan-757 Phase 2 (mental model 3/4): a reference IS a placement, always.
      // Every non-embedded reference — planner placement (`PlacementMeta`) or
      // hand-authored (`AssetReference` alone) — stays an EMPTY reference node,
      // survives the bake (`AssetReference` claims its node, F15) and is
      // materialised by the viewer's `PlacementInstancer` through the same
      // `ModelCache` recipe as every other placement; a reference inside a
      // placed asset is queued by the instancer itself. The main model is the
      // placement at the origin that is not cloned.
      // plan-774 F2: AUTHORING loads as well (the asset editor, its reprojection,
      // descend and Back — `preserveHierarchy` + `preserveAuthoringHierarchy`).
      // The document they open stays unbaked (`destructivePipeline` below); its
      // references are placements exactly like in the HMI (nested-prefab model).
      // Only a direct `loadGLB` WITHOUT `deferPlacements` still grafts — the
      // tests that pin `compose()` itself.
      // An `embedded` reference is not a reference any more (the flat export
      // inlined its subtree) and is never deferred.
      deferReference: options?.deferPlacements
        ? (_node, ref) => !ref.embedded
        : undefined,
    });
    for (const d of composition.deferred) {
      // plan-774 F11: a deferred reference node is filled by the instancer. A
      // file that already stores content under it (an old double-graft, a hand
      // edit) would show that content twice — it is detached here, BEFORE the
      // naming scan, the bake and the materialisation, and reported.
      discardStoredReferenceContent(d.referenceNode);
      // plan-774 F5: what the FILE says about `LayoutObject`, before the
      // instancer stamps its runtime marker on the node.
      recordAuthoredLayoutObject(d.referenceNode);
      markDeferredPlacement(d.referenceNode, d.occurrence, d.resolvedPath);
    }
    // Each referenced file's OWN sidecar, scoped to its own occurrence and
    // skipped for a signed file — the same rule the root just followed, applied
    // per source file instead of once globally.
    if (options?.loadKinematicsSidecar !== false) {
      if (await applyFrameSidecars(composition)) sidecarModified = true;
    }
    prof.mark('compose');
  }

  // Phase 2: Process meshes (shadow classification, triangle counting, drive/transport node sets)
  const { triangleCount, meshCount, driveNodeSet } = processMeshes(root);
  prof.mark('processMeshes');

  // Composed subtrees carry their own rename stamps; merging them here is what
  // makes `registerNodeAliases` (Phase 6) cover referenced nodes too.
  for (const frame of composition?.frames ?? []) {
    for (const [node, orig] of frame.renamedNodes) renamedNodes.set(node, orig);
  }

  // Phase 4a (plan-754 D3b): the naming-convention scan. Extras in, extras out,
  // no registry needed — which is why it can serve BOTH pipelines from here:
  // `prepare` below needs the derived Drive/Transport/Sensor extras before the
  // survival model and the pre-bake hooks read them, and the in-place pipeline
  // sees exactly what it saw at its old position (nothing between then and now
  // touched extras). `hasLibraryMarker` is still available for diagnostics.
  // THE one implementation (plan-582 Phase 2, `rv-naming-scan.ts`). It must stay
  // HERE and not only in the recipe: `prepareAndBake` runs only on the
  // destructive path, so for an authoring load (`preserveHierarchy` — the asset
  // editor), a load without a `BakeRegistry`, a model that draws nothing or a
  // composition that GRAFTED a frame, this call is the ONLY scan.
  // Legacy sensor viz, every load path, before the scan (see the function).
  stripPersistedSensorViz(root);
  applyNamingScan(root);

  // plan-652 Phase 3 (§2.4.3): activate the on-demand features this model's
  // component types need (DES) BEFORE anything is built — construction below is
  // synchronous. Here, because this point lies on EVERY load path (destructive,
  // authoring, no registry, no geometry). A failure or an abort discards the load
  // (the scene is untouched, a retry works); an activated feature stays active.
  if (options?.features) {
    const scanStart = performance.now();
    const types = collectComponentTypes(root, options.overlay, options.features.pendingComponentTriggerTypes?.() ?? null);
    try { performance.measure('rv:feature.prescan', { start: scanStart, end: performance.now() }); } catch { /* diagnostics */ }
    try {
      await options.features.ensureForComponentTypes(types);
      if (options.shouldAbort?.()) throw new LoadAbortedError(url);
    } catch (e) {
      parsedRoot.removeFromParent();
      composition?.dispose();
      disposeModelSubtree(parsedRoot);
      throw e;
    }
  }

  // ═══ plan-754 Phase 1a: prepare → bake → drop → place ═══════════════
  //
  // The DESTRUCTIVE pipeline. Everything below this block ("init") then runs on
  // the TEMPLATE the bake built, which is why no component is ever bound to a
  // node the bake removes and the registry never holds a doomed node.
  //
  // Not taken (`tmp` is placed as-is and initialised, steps 1 → 5 → 6) when:
  // the load is an AUTHORING load (`preserveHierarchy` — the asset editor,
  // its own flag, never a runtime switch), there is no `BakeRegistry`, the
  // model draws nothing, or the composition GRAFTED at least one frame. There
  // is no runtime override any more (plan-757 Phase 3 commit B): a stored
  // `rv-webviewer-static-merge` value is ignored.
  //
  // plan-757 Phase 2 / plan-774 F2: a viewer load (runtime AND authoring)
  // defers EVERY non-embedded reference (above), so its composition has frames
  // only for `embedded` references or a direct `loadGLB` without
  // `deferPlacements`. The authoring load stays excluded here on its own flag
  // (`preserveHierarchy`: the open document is authored, never baked); a
  // grafted composition is excluded for the three reasons plan-754 found (six `tmp`-keyed collections
  // to remap; frame roots, missing nodes and placeholders without a survival
  // reason of their own; a grafted subtree SHARING geometry and materials with
  // the `GlbTemplateCache` entry that owns their disposal, which `dropTmp` would
  // free from under the next recompose). None of them applies to a composition
  // that only DEFERRED: a deferred reference node is empty, survives as a
  // claimed node (F15), its mark travels in `userData` onto the template, and
  // the instancer materialises into the TEMPLATE node after the bake. So a main
  // model with references bakes like one without — a layout document with
  // geometry of its own shows chunk meshes, and its references are placements.
  const destructivePipeline = !preserveHierarchy
    && !!options?.bakeRegistry
    && meshCount > 0 && triangleCount > 0
    && (composition?.frames.length ?? 0) === 0;
  let bakedAsset: BakedAsset | null = null;
  let bakeInstance: PlacementInstance | null = null;
  let destructiveBaked = false;
  // Material phases of the recipe's `prepare` — reused verbatim by the Phase
  // 10/10b slots below instead of re-running them on the template.
  let earlyDedupResult: DedupResult | null = null;
  let earlyUberResult: UberResult | null = null;

  if (destructivePipeline) {
    try {
      assertBakeAllowed({ preserveHierarchy });
      // ── prepare (step 2) → bake (step 3) → drop (step 4): THE recipe
      // (plan-757 D1, rv-prepare-and-bake.ts) — the same function
      // `ModelCache._bake` runs for every planner placement. What is specific
      // to the main model goes in as context: the parser's renamed-node map,
      // the signature verdict, the plugin claims (D5) and the glTF index remap.
      bakedAsset = await prepareAndBake(root, {
        assetId: url,
        renamedNodes,
        signatureState,
        // A caller without a session material (tests, embedders) gets one
        // minted here, exactly as `applyUberMaterial` used to mint it.
        uber: options?.sharedUber ?? createUberMaterial(options?.isWebGPU ?? false),
        isWebGPU: options?.isWebGPU ?? false,
        pickPort: options?.bakePickPort,
        isEpochCurrent: () => !(options?.shouldAbort?.() ?? false),
        forceSplit: (node) => !!getPlacementMeta(node),
        claims: { list: options?.bakeClaims ?? [], complete: options?.bakeClaimsComplete ?? true },
        // plan-769 Phase 1b: the Kinematic hook and survival read stored references
        // by the file's verdict — the one `registerDocument` below hands the registry.
        identity: getDecodeIdentity(parsedRoot),
        onTemplateBuilt: (nodeOf) => {
          // The glTF index map is keyed by `tmp` nodes — re-point it, for TWO
          // reasons. Correctness: Phase 4 hands it to the registry, which
          // answers "which `nodes[i]` is this node" for the extras writer
          // (`rv-scene-settings-into-model.ts`) — keyed on `tmp` it would
          // answer for nothing that exists. Memory: the registry keeps it for
          // the whole session, so every dropped node would stay reachable and
          // the prune would free no heap at all (plan-754 §2.6 / R7).
          const remappedIndices = new Map<Object3D, number>();
          for (const [node, index] of gltfNodeIndices) {
            const template = nodeOf.get(node);
            if (template) remappedIndices.set(template, index);
          }
          gltfNodeIndices.clear();
          for (const [node, index] of remappedIndices) gltfNodeIndices.set(node, index);
        },
      });
      const materials = preparedMaterialsOf(bakedAsset.template);
      earlyDedupResult = materials?.dedup ?? null;
      earlyUberResult = materials?.uber ?? null;
      prof.mark('bake');

      // ── place (step 5): the template IS the instance. It takes `tmp`'s place
      // under the unrendered staging parent, so `computeNodePath` keeps
      // producing exactly the paths it produced before (it stops at the
      // parentless top node), and `tmp`'s remaining shells become unreachable.
      root = bakedAsset.template;
      staging?.add(root);
      parsedRoot.removeFromParent();
      parsedRoot.children.length = 0;
      bakeInstance = options!.bakeRegistry!.instantiateTemplate(bakedAsset);
      destructiveBaked = true;
      debug('loader', `[Destructive bake] ${bakedAsset.chunks.length} chunk(s), ${bakedAsset.keep.length} keep mesh(es), ${bakedAsset.logicNodes.length} logic node(s), ${bakedAsset.aliases.length} alias(es)`);
    } catch (e) {
      if (e instanceof LoadAbortedError) throw e;
      // Either way below the load is over: tear the (possibly prepared) `tmp`
      // down here, the way `abortLoad` does for a later abort. A template that
      // was already placed (a failure AFTER the bake resolved) leaves the
      // staging parent with it; retiring the asset frees its chunk geometry.
      const teardown = (): void => {
        if (root !== parsedRoot) root.removeFromParent();
        if (bakeInstance) options!.bakeRegistry!.release(bakeInstance);
        if (bakedAsset) { bakedAsset.retired = true; if (bakedAsset.instances === 0) bakedAsset.dispose(); }
        parsedRoot.removeFromParent();
        composition?.dispose();
        disposeModelSubtree(parsedRoot);
      };
      if (e instanceof BakeAbortedError) {
        // An ABORT is never a load error (plan-757 F10 / R12): the load was
        // superseded while the bake ran. Report the cancellation the caller
        // already expects — no Problems entry.
        teardown();
        throw new LoadAbortedError(url);
      }
      // A bake ERROR is a visible load error (plan-757 mental model 6 / D7,
      // Phase 3): the Problems panel names the asset and the cause, and the
      // load REJECTS — `main.ts` shows its loading error, a placement's
      // instancer its placeholder. There is no unbaked tree to fall back to
      // and no runtime override (commit B); the only rollback is a deploy
      // revert. (A pick structure that could not be built is NOT a bake
      // error: that chunk is published segment-only, rv-bake-pipeline.ts.)
      const failure = new BakeFailedError(url, e);
      reportBakeFailed({ assetId: url, message: failure.reason });
      console.error(`[loadGLB] ${failure.message}`, e);
      teardown();
      throw failure;
    }
  }

  // Phase 4: Initialize core systems
  const registry = new NodeRegistry();
  registry.setGltfNodeIndices(gltfNodeIndices, gltfNodeNames);
  // One index map PER SOURCE FILE. Without the source key a writer would patch
  // `nodes[7]` of the root file with what belongs in `nodes[7]` of a referenced
  // one — and the `expectedNames` identity check would pass while doing it.
  for (const frame of composition?.frames ?? []) {
    registry.addGltfNodeSource(frame.sourceKey, frame.gltfNodeIndices, frame.gltfNodeNames);
    // plan-769 F5: the grafted clone is the frame's CONTENT — registered under its
    // occurrence, nested reference nodes included but not their content.
    registry.registerOccurrence(frame.referenceNode, frame.occurrence, {
      identity: frame.identity ?? null, contentRoot: frame.subtreeRoot,
    });
  }
  // plan-769 F5 (Phase 1a): the main model's OWN nodes under occurrence '' —
  // BETWEEN the bake and `initSubtree`, because `resolveComponentRefs` runs inside
  // the init and reads stored references by address first (F6). Stops at
  // reference nodes: a reference node is this file's, its content is not.
  const mainIdentity = getDecodeIdentity(parsedRoot);
  registry.registerDocument(root, ROOT_OCCURRENCE, mainIdentity);
  const signalStore = new SignalStore();
  const manager = new RVTransportManager();
  manager.scene = scene;
  // WebGPU guard flag (plan-271 PR#0) — gates the GLSL-only MU dissolve/grow
  // effects the manager creates during simulation.
  manager.isWebGPU = options?.isWebGPU ?? false;
  manager.muComputeRenderer = options?.muComputeRenderer ?? null;

  // Phase 4c: the naming-convention scan moved UP to Phase 4a (plan-754) — it
  // needs no registry and `prepare` needs its output, so it now runs once,
  // before the destructive branch, for both pipelines.

  // Phase 7 trust gate (plan-397 §2.9). Without composition this is the single
  // global flag it has always been. With composition it is PER FRAME: a signed
  // root must not lend its trust to an unsigned referenced file, or dropping a
  // GLB next to a signed scene would be a privilege escalation. Components from
  // an ungated frame still run — the gate is per subtree, not all-or-nothing.
  // Computed BEFORE the init because `initSubtree` needs the gated set; it
  // depends on the composition only, never on the traversal.
  const gatedFrames = composition
    ? composition.frames.filter((f) => isFrameGated(f.effectiveState, signatureState, allowUntrustedLogic))
    : [];
  const gatedNodes = composition && gatedFrames.length > 0
    ? collectGatedNodes(composition, signatureState, allowUntrustedLogic)
    : null;

  // Phases 5-8d: THE one init (plan-754 F13/D19). Traverse + register, renamed-
  // node aliases, component `init()`, the kinematic group names, the overlay
  // reconcile and the `onSceneReady()` late init — the same function, in the
  // same order, that a layout placement and an editor-rebuilt subtree run
  // through `processExtras`. The hierarchy is final before it starts: the
  // `Kinematic` hook re-parented on `tmp` and the `Drive` hook stamped the
  // authored home, both in `prepare` (plan-754 D18); `initDrive()` reads the
  // stamp. Nothing here moves a node or drives an axis to home (plan-757
  // Phase 3 commit B).
  // The shared half of the context comes from THE builder (plan-757 F4) —
  // the same one `RVViewer.initContext()` wraps for a placement and the embed
  // facade calls with its own dependencies. Everything after it is per-source.
  const initResult = initSubtree(root, {
    ...buildInitContext({
      registry, signalStore, transportManager: manager, scene,
      overlay: options?.overlay,
      ...subsystemsOf(options),
    }),
    renamedNodes,
    // plan-733 R4 - the asset editor saves the tree it sees, so components that
    // materialise runtime geometry (RVChain element clones) must not build it.
    // Keyed to `preserveAuthoringHierarchy`, NOT `preserveHierarchy`: the latter
    // is a mesh-bake flag that `RVEmbedViewer` — a simulating PRODUCTION runtime
    // — also sets, and gating on it would silently leave every embedded chain
    // without its elements. Only the asset editor sets this one.
    //
    //
    // A baked load is NOT an authoring load: the flag is the editor's alone.
    // (plan-754 used to fold `destructiveBaked` in here to skip the runtime
    // re-parent pass; that pass is gone, plan-757 Phase 3 commit B.)
    preserveAuthoringHierarchy: options?.preserveAuthoringHierarchy === true,
    logicGated,
    gatedNodes,
    // plan-757 D4: the asset's alias table, resolved to the identity instance.
    aliases: bakeInstance?.aliases,
    mark: (phase) => prof.mark(phase),
  });
  // plan-516 F1: MU nodes no Source references are PRE-PLACED — visible, and
  // simulated from sim start on. Only the main model of a runtime load (never
  // the asset editor); a logic-gated load classifies at the gate release, when
  // its sources have resolved their templates.
  const preplacedClassification = {
    enabled: options?.preserveAuthoringHierarchy !== true,
    excluded: gatedNodes ?? null,
  };
  if (preplacedClassification.enabled && !logicGated) {
    classifyPreplacedMUs(root, manager, preplacedClassification.excluded);
  }
  const traverseResult = initResult;
  const componentContext = initResult.context;
  const trusted = initResult.trusted;
  const aliasStats = initResult.aliasStats;
  const groups = initResult.groups;
  const kinematicGroupNames = initResult.kinematicGroupNames;

  if (gatedFrames.length > 0) {
    console.warn(
      `[loadGLB] ${gatedFrames.length} referenced asset(s) are less trusted than this scene — `
      + 'their logic is disabled. Assets: '
      + gatedFrames.map((f) => `${f.assetId || f.url} (${f.ownSignatureState})`).join(', '),
    );
  }

  // Phase 6b: unresolved references become entries in the Problems panel
  // (plan-703 §2.8, F16). Here and not right after `compose` on purpose — the
  // registry only exists from Phase 4 on, and a problem that cannot name the
  // node it is about sends the user hunting through the hierarchy by eye.
  // plan-754: moved BEHIND the init (it used to sit between the aliases and the
  // component construction) — nothing in between reads the Problems panel, and
  // the registry it resolves against is only more complete afterwards.
  // Always called, including with an empty list: that is what retires the
  // entries of a reference the user has just repaired.
  // plan-769 F4: what the migration on load found (ambiguous / legacy spelling /
  // generated target) — the main model and every composed frame.
  reportReferenceMigrationProblems(registry.identityProblemsOf(ROOT_OCCURRENCE));
  for (const frame of composition?.frames ?? []) reportReferenceMigrationProblems(registry.identityProblemsOf(frame.occurrence));
  // plan-769 9.19: a file written by a NEWER viewer is read as it is (not migrated) — say so.
  for (const occ of [ROOT_OCCURRENCE, ...(composition?.frames ?? []).map((f) => f.occurrence)]) {
    const fileIdentity = registry.identityOfOccurrence(occ);
    if (fileIdentity && isIdVersionNewer(fileIdentity)) {
      reportIdVersionNewer({
        file: fileIdentity.fileKey || url, idVersion: fileIdentity.idVersion!, supported: ID_VERSION_CURRENT,
      });
    }
  }
  reportMissingReferences((composition?.missing ?? []).map((m) => ({
    assetId: m.assetId,
    path: m.path,
    occurrence: m.occurrence,
    label: m.label,
    nodePath: registry.getPathForNode(m.referenceNode) ?? undefined,
  })));
  // plan-757 F9: an override whose target is gone is a problem wherever it was
  // applied — the composed (grafted) frame here, the placement instance in
  // `BakeRegistry.applyOverrides`. Same code, same panel; cleared per document.
  // plan-757 Phase 2b: the problem names the REFERENCE NODE by its registry
  // path (the frame whose occurrence the orphan carries), so the user can jump
  // to it; the occurrence chain stays the fallback for a frame the registry
  // does not know. Runtime loads defer every reference, so these come only from
  // authoring loads — runtime orphans are reported by the instance's
  // `applyOverrides` with the placement's path.
  for (const o of composition?.orphanedOverrides ?? []) {
    const frame = composition?.frames.find((f) => f.occurrence === o.occurrence);
    const framePath = frame ? registry.getPathForNode(frame.referenceNode) : null;
    reportOverrideOrphaned({
      nodePath: framePath || o.occurrence,
      label: frame?.referenceNode.name || o.occurrence.split('/').pop() || o.assetId,
      assetId: o.assetId,
      addressing: o.addressing, key: o.key, componentTypes: o.componentTypes,
    });
  }
  // plan-769 F14: an old file's part moves inside a referenced asset are not applied.
  for (const d of composition?.droppedTransforms ?? []) {
    const frame = composition?.frames.find((f) => f.occurrence === d.occurrence);
    const framePath = frame ? registry.getPathForNode(frame.referenceNode) : null;
    reportOverrideTransformsDropped({
      nodePath: framePath || d.occurrence,
      label: frame?.referenceNode.name || d.occurrence.split('/').pop() || d.assetId,
      assetId: d.assetId,
      count: d.count,
    });
  }

  // Phase 9: WebGPU compatibility fixes
  applyWebGPUFixes(root, options?.isWebGPU ?? false);

  // Phase 10: Material deduplication (must run before static merge).
  // plan-754: on the destructive pipeline both material phases already ran, on
  // `tmp`, in `prepare` — the bake buckets by material, so they HAVE to precede
  // it. Re-running them on the template would walk the chunk meshes and try to
  // collapse the uber singleton onto itself.
  const dedupResult = destructiveBaked && earlyDedupResult
    ? earlyDedupResult
    : deduplicateMaterials(root);
  prof.mark('deduplicateMaterials');

  // Phase 10b: Uber-material pass — collapse every untextured
  // MeshStandardMaterial onto a single shared reference with per-vertex
  // color + rmPacked attributes. Depends on Phase 10 having already
  // collapsed identical references. Mutates dedupResult.uniqueMaterials
  // (removes collapsed materials, adds the shared uber singleton).
  // Editor / STEP-inspection mode keeps the raw assembly: skip the uber bake so
  // sharedMaterial stays null, which in turn auto-skips the static + kinematic
  // merges below (Phase 10c/10d) — every part node stays visible & pickable.
  const uberResult: UberResult = destructiveBaked && earlyUberResult
    ? earlyUberResult
    : preserveHierarchy
      ? { eligibleMaterialCount: 0, bakedMeshCount: 0, sharedMaterial: null, sharedGeometryReuses: 0, clonedGeometryCount: 0, disposedSourceGeometries: 0 }
      : applyUberMaterial(
        root, dedupResult.uniqueMaterials, options?.isWebGPU ?? false, options?.sharedUber ?? null,
      );
  prof.mark('applyUberMaterial');
  // Keep reported uniqueCount in sync with the post-uber state so the
  // DevTools panel and getRendererStats() reflect what's actually on the GPU.
  dedupResult.uniqueCount = dedupResult.uniqueMaterials.size;

  // The bake (Phase 10c) is ASYNC. While it runs, the render loop keeps
  // ticking with the scene in the Phase-8a HOME pose (restore happens in
  // 10e) — keep the root invisible from the start of 10c until 10e completed
  // so neither the wrong pose nor a stale double model is ever visible (N5).
  // Only touch roots that were visible.
  const shouldAbort = options?.shouldAbort ?? ((): boolean => false);
  // plan-753 Phase 4: the bake is the only batching path. Authoring loads
  // never bake (§9.12 guard) and a missing registry leaves the sources
  // rendering individually — the viewer then picks them through the instance
  // pick index. No runtime override exists (plan-757 Phase 3 commit B).
  // `meshCount > 0`: a layout document whose every placement was deferred has
  // no mesh of its own — baking it would only publish an empty in-place
  // instance that shows up as a phantom in the bake statistics.
  const placementBakeAllowed = !preserveHierarchy && !!options?.bakeRegistry;

  // Stale-load cleanup (B3/F7): the superseding load's clearModel() sweep
  // cannot see this root (`_rvModelRoot` is tagged only after loadModel
  // resolves), so the aborted load tears itself down: remove the root and
  // free its GPU resources. Shared fixtures (`_rvShared`, e.g. the uber
  // material singleton) survive — mirrors clearModel().
  const abortLoad = (): never => {
    root.removeFromParent();
    if (bakeInstance) options!.bakeRegistry!.release(bakeInstance);
    if (bakedAsset) { bakedAsset.retired = true; if (bakedAsset.instances === 0) bakedAsset.dispose(); }
    // Composed occurrences SHARE their geometry and materials with the parse
    // templates in the compose cache. Detaching them first — and letting the
    // cache free those resources itself — is what keeps the sweep below from
    // disposing a buffer another occurrence (or a later load) still renders.
    composition?.dispose();
    // The shared traversal primitive (plan-442). The two lines above are this
    // caller's OWN teardown and stay here for exactly that reason.
    disposeModelSubtree(root);
    throw new LoadAbortedError(url);
  };

  // (plan-753 had a Phase 10c here: bake the model root and instantiate the
  // result IN PLACE — sources masked, hierarchy untouched. The destructive
  // pipeline bakes much earlier, in `prepare` above, because it has to run
  // before component construction. plan-754 Phase 1c deleted the in-place
  // half, plan-757 Phase 3 the unbaked runtime: a bake that FAILS is a load
  // error, and there is no override that skips it.)
  if (shouldAbort()) abortLoad();

  // Merge-duration hook (plan-274 F5): expose the bake time so the
  // before/after gain is measurable per load.
  const mergeMs = prof.getTimings()
    .filter((t) => t.phase === 'bake')
    .reduce((sum, t) => sum + t.ms, 0);

  // (Phase 10e — the `'defer'` home-pose restore of the in-place bake — went
  // with plan-757 Phase 3 commit B. The world-matrix refresh stays:
  // `onSceneReady()` may have moved something.)
  root.updateMatrixWorld(true);

  // Phase 11: Freeze static matrices — turn off matrixWorldAutoUpdate on every
  // node with no Drive/Kinematic/Grip/Transport/Source/Sink/MU/SceneButtonMoveable
  // in its up- or down-path, so Three.js skips the bulk of the scene graph in the per-frame
  // updateMatrixWorld recursion. MUST run here, after kinematic re-parenting
  // (Phase 8b) and the bake (Phase 10c), so the parent chains driving the
  // mover closure are final. ~2x render-loop speedup on large static CAD scenes.
  // NOTE: running AFTER component construction (Phase 8) means this pass has the
  // last word on matrixWorldAutoUpdate — a component that thaws itself in init()
  // is overwritten here. Anything that moves must be a mover (bake role) in
  // rv-freeze-static.ts (plan-417: SceneButtonMoveable learned that the hard way).
  // plan-727: kinematic group members are handed in explicitly. In a runtime
  // load they sit under the axis anyway and this changes nothing; in an
  // authoring load they are the only nodes the mover closure cannot see.
  const freezeResult = freezeStaticMatrices(
    root, collectKinematicGroupMembers(kinematicGroupNames, groups),
    { extraMoversReparented: !preserveHierarchy && options?.preserveAuthoringHierarchy !== true },
  );
  debug('loader', `[Freeze] static matrixWorldAutoUpdate=false on ${freezeResult.frozen}/${freezeResult.total} nodes (${freezeResult.dynamic} kept dynamic)`);

  // (plan-753 had a Phase 11b here: ghost-detach every inert static subtree of
  // an in-place bake. The destructive bake removed the need for it — the inert
  // subtrees do not exist any more — and plan-754 Phase 1c deleted it.)

  // Phase 12: Bounding box (after merge — merged geometry changes bounds)
  //
  // NOT `Box3.setFromObject(root)`: with the old BatchedMesh arenas it counted
  // their RAW geometry buffer (source vertices in the source's own units,
  // per-instance matrices ignored) and read ~1000x too large on a CAD import
  // with scale 0.001 — measured on a Delta: arena bbox radius 313 m for a 0.6 m
  // arm; the floor grew to kilometres and the fit camera ended up ~2.5 km
  // outside the machine. The bake's chunks are world-baked, but the rule stays:
  // the box feeds the initial camera fit and the ground disc.
  //
  // Whatever meshes the tree holds at this point give the true bounds: the
  // still-present sources on the unbaked/in-place path, the chunk and keep
  // meshes after a destructive bake (plan-754) — the merged sources are gone by
  // then and their triangles sit in the chunks, world-baked, so the union is
  // the same box either way. Same rule as RVViewer._computeContentBounds();
  // keep the two in step.
  const boundingBox = new Box3();
  {
    const tmpBox = new Box3();
    root.traverse((obj) => {
      const mesh = obj as Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      if ((mesh as unknown as { isBatchedMesh?: boolean }).isBatchedMesh) return;
      mesh.updateWorldMatrix(true, false);
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      if (!mesh.geometry.boundingBox) return;
      tmpBox.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
      boundingBox.union(tmpBox);
    });
  }
  prof.mark('boundingBox');

  // Phase 13: three-mesh-bvh prototype patches only (computeBoundsTree /
  // disposeBoundsTree / acceleratedRaycast). The BVH trees themselves are
  // built ASYNCHRONOUSLY after the load (plan-240): RVViewer.loadModel()
  // starts computeBVHAsync() once the model is wired up — `model-loaded` no
  // longer waits for the BVH. Until each tree is assigned,
  // `acceleratedRaycast` falls back to the native three.js raycast.
  try {
    await ensureBVHPrototypePatches();
  } catch (e) {
    console.warn('[loadGLB] BVH setup failed (three-mesh-bvh):', e);
  }
  prof.mark('bvh-setup');

  // Pick geometry: a baked load picks through the chunks' own pick structures,
  // which the bake built and which are complete before this point (plan-756 F1:
  // `PickBackend` → `resolveHit` → the segment's owner node). Every other load
  // picks real meshes through the InstancePickIndex backend
  // (rv-instance-pick-index.ts, installed by RVViewer after this load) with
  // the per-mesh local BVHs of the async build as its narrow phase. There is
  // no merged pick geometry any more.

  // Phase 14: Build playback
  const playback = buildPlayback(traverseResult.recordingData, traverseResult.recorderSettings, registry);

  // Phase 15: Build replay recordings
  const replayRecordings = buildReplayRecordings(
    traverseResult.replayRecordingConfigs, playback, registry, signalStore,
  );

  // Phase 16 (LogicSteps) is not the loader's any more (plan-769 Phase 6, D20):
  // a step resolves its targets once, when it is built, and a target inside a
  // placement does not exist yet at this point. The viewer builds the main
  // model's steps after the scene is complete (`mergePlacedLogic`).

  // Phase 17: Finalize
  printParitySummary();
  signalStore.buildIndex();

  const pipelineNodes = traverseResult.pipelineNodes;
  const { pipes: pipeNodes, tanks: tankNodes, pumps: pumpNodes, processingUnits: processingUnitNodes } = pipelineNodes;
  if (pipeNodes.length + tankNodes.length + pumpNodes.length + processingUnitNodes.length > 0) {
    debug('loader',
      `Pipeline: ${pipeNodes.length} pipes, ${tankNodes.length} tanks, ` +
      `${pumpNodes.length} pumps, ${processingUnitNodes.length} processing units`
    );
  }

  const regSize = registry.size;
  const stats = manager.stats;
  logInfo(
    `GLB loaded: ${traverseResult.drives.length} drives, ${stats.surfaces} surfaces, ` +
    `${stats.sensors} sensors, ${stats.sources} sources, ${stats.sinks} sinks, ` +
    `${signalStore.size} signals, ` +
    `registry: ${regSize.nodes} nodes, ${regSize.components} components [${regSize.types.join(',')}], ` +
    (playback ? `recording=${playback.totalFrames}f, ` : '') +
    `${Math.round(triangleCount / 1000)}K triangles`
  );

  prof.mark('finalize');
  prof.report();

  // Every phase is done (baked, frozen, bounds known): only now does the model
  // enter the rendered scene — see loadAndPrepareGLTF.
  scene.add(root);

  return {
    root,
    renderHints,
    drives: traverseResult.drives,
    transportManager: manager,
    signalStore,
    registry,
    playback,
    replayRecordings,
    recorderSettings: traverseResult.recorderSettings,
    boundingBox,
    triangleCount,
    meshCount,
    groups,
    modelConfig: {},
    dedupResult,
    uberResult,
    pipelineNodes,
    kinematicGroupNames,
    drivenKinematicGroupNames: initResult.drivenKinematicGroupNames,
    bakedAsset,
    bakeInstance,
    placementBakeAllowed,
    placementUberAllowed: !!options?.bakeRegistry,
    preplacedClassification,
    mergeMs,
    metadataStats: {
      ...traverseResult.metadataStats,
      hoverableFaceRanges: bakedAsset
        ? bakedAsset.chunks.reduce((n, c) => n + c.pick.segmentCount, 0)
        : 0,
    },
    aliasStats,
    signatureState,
    signaturePresent,
    signerOrganization,
    modelSourceUrl,
    sidecarModified,
    logicGated,
    deferredLogic: logicGated
      ? { pending: trusted, context: componentContext }
      : null,
    composition,
    gatedFrames,
    orphanedOverrides: composition?.orphanedOverrides ?? [],
    deferredPlacements: composition?.deferred ?? [],
  };
}

/** Applies glTF render hints that must survive material baking. */
export function applyRenderHints(root: Object3D): { suppressGround: boolean } {
  const suppressGround = readHint(root.userData, 'SuppressGround') === true;
  const visit = (node: Object3D, inherited: { factor: number; units: number } | null): void => {
    const nodeBias = parseDepthBias(readHint(node.userData, 'DepthBias')) ?? inherited;
    const mesh = node as Mesh;
    if (mesh.isMesh) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        const bias = parseDepthBias(readHint(material.userData, 'DepthBias')) ?? nodeBias;
        if (!bias) continue;
        material.polygonOffset = true;
        material.polygonOffsetFactor = bias.factor;
        material.polygonOffsetUnits = bias.units;
        material.needsUpdate = true;
      }
    }
    for (const child of node.children) visit(child, nodeBias);
  };
  visit(root, null);
  return { suppressGround };
}

function readHint(data: Record<string, unknown> | undefined, key: string): unknown {
  if (!data) return undefined;
  if (`realvirtual.${key}` in data) return data[`realvirtual.${key}`];
  const realvirtual = data.realvirtual;
  return realvirtual && typeof realvirtual === 'object'
    ? (realvirtual as Record<string, unknown>)[key]
    : undefined;
}

function parseDepthBias(value: unknown): { factor: number; units: number } | null {
  if (typeof value === 'number' && Number.isFinite(value)) return { factor: 0, units: value };
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const factor = typeof record.factor === 'number' && Number.isFinite(record.factor) ? record.factor : 0;
  const units = typeof record.units === 'number' && Number.isFinite(record.units) ? record.units : 0;
  return { factor, units };
}

// ═══════════════════════════════════════════════════════════════════
// processExtras — Runtime extras processing for dynamically added GLBs
// ═══════════════════════════════════════════════════════════════════

export interface ProcessExtrasResult {
  drives: RVDrive[];
  signalsRegistered: number;
  componentsCreated: number;
  deferredLogic: DeferredLogic | null;
  /** The LOCAL group registry of the subtree — the caller merges it into the viewer's (plan-757). */
  groups: GroupRegistry | null;
  /** Group names a `Kinematic` integrates — the freeze pass and the Groups panel need them. */
  kinematicGroupNames: string[];
  /** Those of them a drive moves — what the Groups panel auto-excludes. */
  drivenKinematicGroupNames: string[];
}

/** Per-source data of a {@link processExtras} call — everything the shared init context does NOT know. */
export interface ProcessExtrasOptions {
  /** The document's logic state; anything but `'active'` gates the subtree. */
  logicRunState?: 'active' | 'gated' | 'activating';
  /** Explicit gate (plan-757 F6: the placed asset's OWN trust verdict). ORed with `logicRunState`. */
  logicGated?: boolean;
  /**
   * plan-727 — AUTHORING call. Same meaning as
   * {@link LoadGLBOptions.preserveAuthoringHierarchy}: set by the asset
   * editor's `_rebuildComponents()` (rv-asset-executors.ts), which runs on
   * every separateMesh/mergeMesh undo/redo. The init never re-parents in any
   * mode (plan-757 Phase 3 commit B); the flag now only tells components that
   * they run in the editor (`ComponentContext.authoring`).
   */
  preserveAuthoringHierarchy?: boolean;
  /** The baked asset's alias table for this instance (plan-757 D4). */
  aliases?: ReadonlyArray<SubtreeAlias>;
  /** Further names of the subtree root for the reference scope (plan-757 F7) — see {@link SubtreeInitContext.assetRootNames}. */
  assetRootNames?: ReadonlyArray<string | undefined | null>;
  /** Per-phase timing hook. */
  mark?: (phase: SubtreeInitPhase) => void;
}

/**
 * Process realvirtual extras on a subtree that was added at runtime — the
 * thin facade of {@link initSubtree} for the Layout Planner and the asset
 * editor: ONE shared context from {@link buildInitContext} (plan-757 F4) plus
 * the per-source options.
 *
 * plan-754 F13/D19: this used to be a SECOND, leaner init that validated
 * nothing. It is now a thin wrapper — the subtree runs the same traversal,
 * the same validation and the same init order as the main model, on the
 * EXISTING runtime systems (NodeRegistry, SignalStore, TransportManager)
 * instead of fresh ones. New code should call {@link initSubtree} directly.
 *
 * Groups: `initSubtree` builds a LOCAL GroupRegistry from what the subtree
 * carries; it is RETURNED (`groups`) so the caller can merge it into the
 * viewer-wide registry — `integratePlacedContent` does (plan-757: a group is
 * a NAME, global to the viewer).
 *
 * Renamed-node aliases ARE registered (plan-381 F5) — from the `_rvOrigName`
 * stamps the parse step left behind, since detecting them here is impossible
 * (no glTF parser, and the tree may be a clone).
 *
 * Still the caller's job: BVH, WebGPU fixes, shadow classification, triangle
 * counting, the bake, the static freeze, and LogicSteps (merged via
 * `viewer.logicEngine.addSubtree()` — see `mergePlacedLogic()`).
 */
export function processExtras(
  root: Object3D,
  base: InitContextBase,
  options?: ProcessExtrasOptions,
): ProcessExtrasResult {
  // plan-652 Phase 3 safety net: this entry is synchronous and cannot wait for an
  // on-demand feature — the async entries (loadGLB, the placement instancer) do.
  noteDeferredComponentTypes(root, 'processExtras');
  const result = initSubtree(root, {
    ...base,
    preserveAuthoringHierarchy: options?.preserveAuthoringHierarchy === true,
    logicGated: options?.logicGated === true
      || (options?.logicRunState !== undefined && options.logicRunState !== 'active'),
    aliases: options?.aliases,
    assetRootNames: options?.assetRootNames,
    mark: options?.mark,
  });
  return {
    drives: result.drives,
    signalsRegistered: result.signalsRegistered,
    componentsCreated: result.componentsCreated,
    deferredLogic: result.deferredLogic,
    groups: result.groups,
    kinematicGroupNames: result.kinematicGroupNames,
    drivenKinematicGroupNames: result.drivenKinematicGroupNames,
  };
}

