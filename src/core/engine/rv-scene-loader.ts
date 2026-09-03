// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Scene, Object3D, Box3, BufferAttribute, Mesh, BufferGeometry, Material } from 'three';
import { RVDrive } from './rv-drive';
import { disposeModelSubtree } from './rv-dispose-subtree';
import { AABB } from './rv-aabb';
import { registerSignal, constructDrive, SIGNAL_TYPES, DRIVE_BEHAVIOR_MAP } from './rv-signal-construction';
import {
  gltfLoader, detectRenamedNodes, collectRenamedNodes, collectGltfNodeIndices, collectGltfNodeNames, type GltfParserLike,
} from './rv-glb-parse';
import { sanitizeLikeThree } from './rv-three-names';
import { classifyShadows } from './rv-mesh-classifier';
import {
  compose, hasReferences, collectGatedNodes, isFrameGated,
  type ComposeResult, type ComposedFrame, type GlbTemplateCache, type ReferenceResolver,
} from './rv-glb-compose';
import { createReferenceResolver } from './rv-glb-reference-resolver';
import { reportMissingReferences } from '../hmi/problems-store';
import type { OrphanedOverride } from './rv-asset-reference';
import { ROOT_SOURCE_KEY } from './rv-node-id';
import type { EventEmitter } from '../rv-events';
import type { ViewerEvents } from '../rv-viewer-events';
// Side-effect imports: trigger registerComponent() at module load
import './rv-transport-surface';
import './rv-sensor';
import './rv-source';
import './rv-sink';
import './rv-grip';
import './rv-grip-target';
import './rv-connect-signal';
import './rv-lamp';
import './rv-scene-button-base';
import './rv-scene-button-moveable';
import './rv-push-button3d';
import './rv-emergency-button3d';
import './rv-handle-switch3d';
import './rv-energy-chain';
import './rv-chain';
import './rv-safety-door';
import './rv-physics-zone';
import './rv-collision-role';
import './rv-machining-volume';
import './rv-machining-tool';
import './rv-web-sensor';
import './rv-web-diagnostics';
import './rv-web-error';
import './rv-web-visibility';
import './rv-custom-runtime-instruction';
import './rv-metadata';
import './rv-group-component';
// Agent memory (plan-394) — registers the 'NodeKnowledge' schema + capabilities
// but NO factory: the note is data on the node, never a live instance.
import './rv-node-knowledge';
import './rv-ik-target';
import './rv-ik-path';
import './rv-robot-ik';
// Path substrate (plan-268) — registers the 'Path' factory (rv_extras.Path → RVPath)
import './rv-path';
// Drive behavior — registers schema + badge capability for Drive_DestinationMotor
import './rv-drive-destination-motor';
// Pipeline components — class constructors also register capabilities + tooltip resolvers
import { RVPipe } from './rv-pipe';
import { RVTank } from './rv-tank';
import { RVPump } from './rv-pump';
import { RVProcessingUnit } from './rv-processing-unit';
import { applySchema, resolveComponentRefs, getRegisteredFactories, getSchemaDefaults, registerCapabilities, type RVComponent, type ComponentContext, type ComponentSchema } from './rv-component-registry';
import type { GizmoOverlayManager } from './rv-gizmo-manager';
import type { LampManager } from './rv-lamp-manager';
import type { SceneButtonManager } from './rv-scene-button-manager';
import type { EnergyChainManager } from './rv-energy-chain-manager';
import type { ChainManager } from './rv-chain-manager';
import type { MachiningManager } from './rv-machining-manager';
import type { CollisionRoleRegistrar } from './rv-collision-role';
// plan-404: the rigid-body mechanism manager is a PRIVATE implementation behind
// a public registry slot. Every ComponentContext built below reads it from the
// singleton rather than an option, so no construction path can miss it.
import { getKinematicManager } from './rv-kinematic-registry';
import {
  getActiveSignalReapplyRegistry,
  type SignalReapplyRegistry,
} from './rv-signal-reapply-registry';
import type { RVOutlineManager } from './rv-outline-manager';
import type { ErrorStore } from './rv-error-store';
import type { InstructionRuntimeStore } from './rv-instruction-runtime-store';
import { RVTransportManager } from './rv-transport-manager';
import { SignalStore } from './rv-signal-store';
import { RVDrivesPlayback, parseCompactRecording, parseScriptableObjectRecording, type CompactRecording } from './rv-drives-playback';
import { RVReplayRecording } from './rv-replay-recording';
import { RVLogicEngine } from './rv-logic-engine';
import { NodeRegistry, type ComponentRef } from './rv-node-registry';
import { GroupRegistry } from './rv-group-registry';
import { validateExtras, printParitySummary, resetParityValidator } from './rv-extras-validator';
import { parseActiveOnly, type ActiveOnly } from './rv-active-only';
import { debug, debugVerbose, logInfo } from './rv-debug';
import { createLoadProfiler } from './rv-load-profiler';
import { deduplicateMaterials, type DedupResult } from './rv-material-dedup';
import { applyUberMaterial, type UberResult } from './rv-uber-material';
import {
  buildBatchedScene,
  type SceneBatchResult,
  type StaticBatchBuildResult,
  type KinematicBatchResult,
} from './rv-batched-render';
import { BatchTable } from './rv-batch-table';
import { isStaticMeshMergingEnabled } from './rv-static-merge-flag';
import { isMetadataLoadingEnabled } from './rv-dev-load-flags';
import { freezeStaticMatrices } from './rv-freeze-static';
import { buildRaycastGeometries, type RaycastGeometrySet } from './rv-raycast-geometry';
import { isInstancePickEnabled } from './rv-instance-pick-flag';
import { ensureBVHPrototypePatches, type BVHBuildPort } from './rv-bvh-build-port';
import type { MeshMergePort } from './rv-mesh-merge-port';
import { attachAasLink, SEW_DRIVE_AAS, isDriveDatasheetNode } from '../../behaviors/_shared/aas-link';
import { markAasPending } from '../../plugins/aas-resolution';
import { applyOverlayToNode, type RVExtrasOverlay } from './rv-extras-overlay-store';
import { applyKinematicsSpec } from '../behavior-runtime';
import { scanLibraryComponent } from '../library-component-loader';
import { deepCloneJSON } from '../ops/rv-op-utils';
import {
  verifyRvSigBuffer,
  type SignatureState,
} from '../persistence/rv-sig-verify';

// The GLTFLoader singleton, `detectRenamedNodes` and `parseGlbSubtree` live in
// ./rv-glb-parse so the asset editor and layout planner can parse GLB bytes
// without pulling in this module's component side-effect graph. Re-exported
// here because `detectRenamedNodes` has always been part of this module's API.
export {
  detectRenamedNodes, collectRenamedNodes, collectGltfNodeIndices, collectGltfNodeNames, parseGlbSubtree, gltfLoader,
} from './rv-glb-parse';

// ─── Register capabilities for types without factories ────────────

// Pipeline Pipe/Tank/Pump capabilities are registered by the RVPipe/RVTank/RVPump
// class modules themselves (see rv-pipe.ts / rv-tank.ts / rv-pump.ts) via
// registerTooltipComponent(). ProcessingUnit stays here until it's promoted too.
registerCapabilities('ProcessingUnit', {
  hoverable: true,
  tooltipType: 'processing-unit',
  badgeColor: '#ef5350',
  hoverEnabledByDefault: true,
  hoverPriority: 10,
  pinPriority: 5,
});
// RuntimeMetadata/Metadata capabilities are registered by rv-metadata.ts (side-effect
// import above), like the other factory components.
// Note: AASLink capabilities are registered by aas-link-plugin.tsx (plugin side-effect).
// Model plugins load BEFORE loadGLB() so capabilities are available for BVH construction.

// Recorder types (visible in inspector but not hoverable)
registerCapabilities('DrivesRecorder', { badgeColor: '#7e57c2' });
registerCapabilities('ReplayRecording', { badgeColor: '#26a69a' });

// Structural types (hidden from inspector)
registerCapabilities('rigidbody', { inspectorVisible: false });
registerCapabilities('renderer', { inspectorVisible: false });
registerCapabilities('colliders', { inspectorVisible: false });
registerCapabilities('BoxCollider', { inspectorVisible: false });
// Group capabilities+schema are registered by rv-group-component.ts (side-effect import above)
// Kinematic is visible: authored in the asset editor (Kinematics window / auto-create
// on group assignment), so it must show up in the hierarchy and inspector.
registerCapabilities('Kinematic', { badgeColor: '#ce93d8' });
registerCapabilities('RuntimeUIWindow', { inspectorVisible: false });
registerCapabilities('RuntimeInteractable', { inspectorVisible: false });

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
  drives: RVDrive[];
  transportManager: RVTransportManager;
  signalStore: SignalStore;
  registry: NodeRegistry;
  playback: RVDrivesPlayback | null;
  replayRecordings: RVReplayRecording[];
  recorderSettings: RecorderSettings | null;
  logicEngine: RVLogicEngine | null;
  boundingBox: Box3;
  triangleCount: number;
  groups: GroupRegistry | null;
  /** Merged model-specific plugin configuration (modelname.json > GLB extras > settings.json). */
  modelConfig: ModelConfig;
  dedupResult: DedupResult | null;
  uberResult: UberResult | null;
  /** Static uber BatchedMesh build result (Phase 10c). */
  uberBatchResult: StaticBatchBuildResult | null;
  /** Textured static BatchedMesh build result (Phase 10d-tex). */
  texBatchResult: StaticBatchBuildResult | null;
  /** Per-drive kinematic BatchedMesh build result (Phase 10d). */
  kinBatchResult: KinematicBatchResult | null;
  /** Arena registry + source-mesh → instance map for the batched render path. */
  batchTable: BatchTable | null;
  pipelineNodes: { pipes: Object3D[]; tanks: Object3D[]; pumps: Object3D[]; processingUnits: Object3D[] };
  /** Group names that were re-parented under Kinematic nodes (for auto-exclude from overlay). */
  kinematicGroupNames: string[];
  /** Grouped BVH raycast geometries (static + per-Drive kinematic). */
  raycastGeometrySet: RaycastGeometrySet | null;
  /**
   * Combined duration of the static + kinematic uber merges (Phase 10c/10d)
   * in milliseconds (plan-274 F5). OPTIONAL so LoadResult mocks in tests stay
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

  // No mesh — use BoxCollider data from GLB extras
  // Legacy format: BoxCollider as top-level key
  const boxCollider = rv['BoxCollider'] as { center?: { x: number; y: number; z: number }; size?: { x: number; y: number; z: number } } | undefined;
  if (boxCollider?.center && boxCollider?.size) {
    validateExtras('BoxCollider', boxCollider as unknown as Record<string, unknown>);
    return AABB.fromBoxCollider(node, boxCollider.center, boxCollider.size);
  }

  // Current format: colliders array (Unity exports BoxCollider data here)
  const colliders = rv['colliders'] as Array<{ type?: string; center?: { x: number; y: number; z: number }; size?: { x: number; y: number; z: number } }> | undefined;
  if (colliders) {
    for (const col of colliders) {
      if ((col.type === 'Box' || col.type === 'BoxCollider') && col.center && col.size) {
        const bc = AABB.fromBoxCollider(node, col.center, col.size);
        debugVerbose('loader', `[AABB] ${node.name}: using BoxCollider halfSize=${bc.halfSize.toArray()}, center=${bc.center.toArray()}`);
        return bc;
      }
    }
  }

  // Last resort: return degenerate AABB
  return meshAABB;
}

// DRIVE_BEHAVIOR_MAP and SIGNAL_TYPES moved to ./rv-signal-construction.ts

export interface LoadGLBOptions {
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
  /** Optional gizmo manager — passed into ComponentContext so components (e.g. WebSensor) can create overlays. */
  gizmoManager?: GizmoOverlayManager;
  /** Optional viewer-owned manager for Lamp flashing. */
  lampManager?: LampManager;
  /** Optional viewer-owned manager for 3D scene buttons (plan-417). */
  sceneButtonManager?: SceneButtonManager;
  energyChainManager?: EnergyChainManager;
  /** plan-733 - so a Chain reaches the per-tick pose registry. */
  chainManager?: ChainManager;
  /** Optional viewer-owned CSG machining registry (plan-405) — passed into
   *  ComponentContext so `MachiningVolume` components can register themselves. */
  machiningManager?: MachiningManager;
  /** Optional viewer-owned collision registry (plan-394) — passed into
   *  ComponentContext so `CollisionRole` components can register their node. */
  collisionManager?: CollisionRoleRegistrar;
  /** Optional outline manager — passed into ComponentContext so components
   *  (CustomRuntimeInstruction) can drive the OutlinePass status outline. */
  outlineManager?: RVOutlineManager;
  /** Optional viewer-owned signal re-apply registry (plan-427) — passed into
   *  ComponentContext so wired input slots can be re-driven with the current
   *  signal level after reset/reconnect. Falls back to the module slot. */
  reapply?: SignalReapplyRegistry;
  /** Optional error registry — passed into ComponentContext so components (e.g. WebError) can report active errors. */
  errorStore?: ErrorStore;
  /** Optional runtime-instruction registry — passed into ComponentContext so
   *  components (e.g. CustomRuntimeInstruction) can push instruction cards. */
  instructionStore?: InstructionRuntimeStore;
  /** Optional viewer event bus — passed into ComponentContext for components
   *  that need to react to UI↔engine signals (e.g. RVSafetyDoor visibility toggle). */
  events?: EventEmitter<ViewerEvents>;
  /**
   * Optional rv-extras overlay applied during the main traversal — BEFORE
   * components read `userData.realvirtual`. This guarantees component
   * constructors see the overridden values directly, eliminating the race
   * window the post-load re-application path used to have.
   */
  overlay?: RVExtrasOverlay;
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
   * Test/diagnostic hook — invoked at the start of every BatchedMesh arena
   * build in Phase 10c/10d (gives tests a deterministic interleave point).
   */
  onArenaBuild?: () => void;
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
  /**
   * Reuse a parse-template cache across loads. Omit and the composition owns a
   * fresh one that is freed with the model — see `rv-glb-compose.ts` on why
   * cross-load sharing is opt-in.
   */
  composeCache?: GlbTemplateCache;
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
}

/**
 * Load and parse a GLTF/GLB file, add root to scene.
 * Returns the root Object3D and parser metadata for renamed-node detection.
 *
 * When `data` is supplied the bytes are parsed directly (no internal fetch) —
 * the caller already downloaded the GLB (e.g. main.ts streams it with progress,
 * a timeout and retries). This avoids the GLTFLoader re-fetching the file and,
 * crucially, avoids the blob-URL double-buffering that doubled peak memory and
 * caused out-of-memory blank scenes for large models on mobile.
 */
export async function loadAndPrepareGLTF(url: string, scene: Scene, data?: ArrayBuffer): Promise<PreparedGLTF> {
  debug('loader', `Loading ${url}...`);
  resetParityValidator(); // Clear any previous load's parity data
  const fetchBytes = async (): Promise<ArrayBuffer> => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`GLB fetch failed (${response.status} ${response.statusText}): ${url}`);
    return response.arrayBuffer();
  };
  const initialBuffer = data ?? await fetchBytes();
  // Every caller — main.ts, plugins, scene loader and asset editor — passes
  // through this raw-byte verification point. Large buffers make a transferable
  // worker round-trip; its detached-buffer failures get one geometry-only fetch.
  const verified = await verifyRvSigBuffer(initialBuffer, fetchBytes);
  // Self-contained GLB (textures + buffers embedded) → empty resource path is
  // correct; external-resource glTF is not produced by the Unity exporter.
  const gltf = await gltfLoader.parseAsync(verified.buffer, '');
  debug('loader', `GLTF parsed, adding to scene`);
  const root = gltf.scene;
  scene.add(root);

  const gltfParser = (gltf as unknown as { parser?: PreparedGLTF['gltfParser'] }).parser;
  return {
    root,
    gltfParser,
    signatureState: verified.state,
    signaturePresent: verified.signaturePresent,
    signerOrganization: verified.signerOrganization,
  };
}

/** Result of processMeshes — contains mesh stats and the drive node set. */
export interface MeshProcessResult {
  triangleCount: number;
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
  // static arena, which cannot move by construction. Symptom: a mechanism that
  // jogs perfectly in the asset editor while in every merged load — the F5 test
  // run, HMI, planner — the driven arms move and the rods and platform hang
  // frozen in mid-air. ("The asset editor is fine" because `preserveHierarchy`
  // skips the two MERGE passes — 10c/10d — so the static arena never claims the
  // links. It is emphatically NOT because the editor skips this classification:
  // the freeze below runs on EVERY load, in every mode. Reading that comment as
  // "the editor is exempt from load-time structure work" is what let the
  // kinematic re-parenting of Phase 8b stay ungated for so long; see plan-727
  // and `reclassifyKinematicGroupsDynamic`.)
  //
  // This mirrors MOVER_KEY in rv-freeze-static.ts, which already keeps
  // `Kinematic` subtrees matrix-dynamic; the two classifications disagreeing was
  // the bug.
  const driveNodeSet = new Set<Object3D>();
  const transportSurfaceNodeSet = new Set<Object3D>();

  // `Drive`/`Drive_*` (behaviours) and the rigid group `Kinematic`/`Kinematic_N`.
  // Deliberately NOT KinematicJoint / KinematicMechanism / KinematicTarget: those
  // are descriptive nodes, and anchoring meshes to them would mis-group whole
  // subtrees (a mechanism container is typically an ancestor of everything).
  const MOTION_KEY = /^Drive|^Kinematic(_\d+)?$/i;

  root.traverse((node: Object3D) => {
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv) return;
    for (const key in rv) {
      if (rv[key] && MOTION_KEY.test(key)) { driveNodeSet.add(node); break; }
    }
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

  // Shadow classification and triangle counting
  root.traverse((node: Object3D) => {
    if ((node as Mesh).isMesh) {
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
        // for CAD imports like Toray where every moving part is a single mesh).
        // Without the self-check that mesh gets matrixAutoUpdate=false and the
        // renderer never rebuilds its matrix from the quaternion applyToNode()
        // sets — so the drive reports running/rotating but the geometry never
        // visibly moves. A drive node is always dynamic.
        const underDrive = driveNodeSet.has(node) || isUnderDrive(node);
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

  return { triangleCount, driveNodeSet };
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
 * Apply Kinematic re-parenting after groups are built (Phase 8b).
 *
 * Mirrors C# Kinematic.Awake() behavior:
 * - IntegrateGroupEnable: re-parent group nodes under the Kinematic node
 * - KinematicParentEnable: re-parent the Kinematic node under a specified parent
 *
 * Uses attach() (not add()) to preserve world transforms.
 * After re-parenting, fixes Drive base transforms and matrixAutoUpdate on affected subtrees.
 *
 * Returns the list of kinematic group names for UI exclusion.
 *
 * `skipReparent` (plan-727) is the AUTHORING mode: both passes still resolve
 * names and `GroupNamePrefix` exactly as before — so `groupNames` (and with it
 * `GroupRegistry.isKinematic()`, which feeds the editor's group-assignment
 * menu) is populated identically — but nothing is attached and
 * `affectedSubtrees` comes back empty, which turns Phase 8c into a no-op by
 * itself. Name resolution and mutation share a loop, so this cannot be done by
 * gating the call site.
 */
export function applyKinematicParenting(
  kinematicNodes: KinematicNodeEntry[],
  groups: GroupRegistry | null,
  registry: NodeRegistry,
  root: Object3D,
  skipReparent = false,
): { groupNames: string[]; affectedSubtrees: Object3D[] } {
  if (kinematicNodes.length === 0) return { groupNames: [], affectedSubtrees: [] };

  const kinematicGroupNames: string[] = [];
  const affectedSubtrees: Object3D[] = [];
  // The nodes attach() actually MOVED — a strict subset of affectedSubtrees,
  // which also carries the kinematic node itself so registry paths of its new
  // children get recomputed. Only a moved node has a new local transform, and
  // only it may have its drive base re-cached (LOP-68).
  const reparentedRoots: Object3D[] = [];

  // Pass 1: IntegrateGroupEnable — re-parent group nodes under kinematic nodes
  for (const { node: kinNode, data } of kinematicNodes) {
    if (data['IntegrateGroupEnable'] !== true) continue;

    const groupName = data['GroupName'] as string ?? '';
    if (!groupName) continue;

    // Resolve GroupNamePrefix
    const prefixRef = data['GroupNamePrefix'] as { path?: string } | string | undefined;
    let resolvedName = groupName;
    if (prefixRef) {
      const prefixPath = typeof prefixRef === 'string' ? prefixRef : prefixRef.path;
      if (prefixPath) {
        const prefixNode = registry.getNode(prefixPath);
        if (prefixNode) {
          resolvedName = prefixNode.name + groupName;
        }
      }
    }

    // Get group from registry
    const groupInfo = groups?.get(resolvedName);
    if (!groupInfo) {
      debug('loader', `[Kinematic] ${kinNode.name}: group "${resolvedName}" not found, skipping`);
      continue;
    }

    const simplify = data['SimplifyHierarchy'] === true;
    const candidates = simplify
      ? groupInfo.nodes.filter(n => (n as Mesh).isMesh === true)
      : [...groupInfo.nodes];

    // Mirror C# GetAllWithGroup: only re-parent top-level group members.
    // Skip nodes whose ancestor is already in the same group (they'll
    // move naturally with their parent).
    const groupNodeSet = new Set(groupInfo.nodes);
    const nodesToReparent = candidates.filter(node => {
      let current = node.parent;
      while (current) {
        if (groupNodeSet.has(current)) return false;
        current = current.parent;
      }
      return true;
    });

    if (!skipReparent) {
      for (const groupNode of nodesToReparent) {
        kinNode.attach(groupNode);
        reparentedRoots.push(groupNode);
      }
      affectedSubtrees.push(kinNode);
    }

    // Outside the gate on purpose (plan-727 F9): the resolved name must flow in
    // BOTH modes so markAsKinematic()/isKinematic() behave identically.
    kinematicGroupNames.push(resolvedName);
    debug('loader',
      skipReparent
        ? `[Kinematic] ${kinNode.name}: authoring load — resolved group "${resolvedName}" ` +
          `(${nodesToReparent.length} node(s)), NOT re-parenting`
        : `[Kinematic] ${kinNode.name}: attached ${nodesToReparent.length} node(s) from group "${resolvedName}"` +
          (simplify ? ' (mesh-only)' : '')
    );
  }

  // Pass 2: KinematicParentEnable — re-parent kinematic node under specified parent
  for (const { node: kinNode, data } of kinematicNodes) {
    if (data['KinematicParentEnable'] !== true) continue;

    const parentRef = data['Parent'] as { path?: string } | string | undefined;
    const parentPath = typeof parentRef === 'string' ? parentRef : parentRef?.path;
    if (!parentPath) continue;

    const parentNode = registry.getNode(parentPath);
    if (!parentNode) {
      debug('loader', `[Kinematic] ${kinNode.name}: parent "${parentPath}" not found, skipping`);
      continue;
    }

    if (skipReparent) {
      debug('loader',
        `[Kinematic] ${kinNode.name}: authoring load — resolved parent "${parentNode.name}", NOT re-parenting`);
      continue;
    }

    parentNode.attach(kinNode);
    affectedSubtrees.push(kinNode);
    reparentedRoots.push(kinNode);
    debug('loader', `[Kinematic] ${kinNode.name}: re-parented under "${parentNode.name}"`);
  }

  // Pass 3: Fix matrixAutoUpdate and Drive base transforms on affected subtrees
  if (affectedSubtrees.length > 0) {
    // matrixAutoUpdate goes wide: Phase 2 may have cleared it anywhere under a
    // kinematic node, moved or not.
    for (const subtreeRoot of affectedSubtrees) {
      subtreeRoot.traverse((child: Object3D) => {
        child.matrixAutoUpdate = true;
      });
    }
    // Re-caching a drive's base transform goes NARROW: only nodes attach()
    // actually moved have a new local transform. Doing it for the kinematic
    // node's own drive — which never moved — bakes whatever displacement it
    // happens to carry into its base (LOP-68).
    for (const movedRoot of reparentedRoots) {
      movedRoot.traverse((child: Object3D) => {
        const childPath = registry.getPathForNode(child);
        if (!childPath) return;
        const components = registry.getComponentsAt(childPath);
        for (const [type, instance] of components) {
          if (type === 'Drive') {
            (instance as RVDrive).refreshBaseTransform();
          }
        }
      });
    }
    // Propagate world matrices after all re-parenting
    root.updateMatrixWorld(true);
    debug('loader', `[Kinematic] Fixed matrixAutoUpdate + drive base transforms on ${affectedSubtrees.length} subtree(s)`);
  }

  return { groupNames: kinematicGroupNames, affectedSubtrees };
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
 * Until plan-727 the only corrector was Pass 3 of `applyKinematicParenting()`,
 * which exists only where re-parenting actually happened. This asks the semantic
 * question instead — "is this mesh MOVED by a drive?" rather than "does it hang
 * under one?" — and therefore runs in ALL modes (root fix). In runtime loads it
 * is idempotent to Pass 3; in an authoring load it is the only corrector.
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
 * {@link traverseAndRegister} (loadGLB), {@link processExtras} (placed
 * subtrees) and {@link createRuntimeNode} (op-log `addNode`).
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
interface TraverseResult {
  drives: RVDrive[];
  pending: PendingComponent[];
  muTemplateNodes: Object3D[];
  groupNodes: { node: Object3D; key: string; data: Record<string, unknown> }[];
  kinematicNodes: KinematicNodeEntry[];
  recordingData: CompactRecording | null;
  recorderSettings: RecorderSettings | null;
  replayRecordingConfigs: { sequence: string; startOnSignal: ComponentRef | null; isReplayingSignal: ComponentRef | null; activeOnly: ActiveOnly }[];
  pipelineNodes: { pipes: Object3D[]; tanks: Object3D[]; pumps: Object3D[]; processingUnits: Object3D[] };
  /** Load-time metadata cost stats (DevTools): nodes carrying RuntimeMetadata
   *  extras (counted BEFORE the dev kill-switch strips them), and the number /
   *  total wall-clock cost of component AABB builds (`createAABBFromExtras`). */
  metadataStats: { metadataNodes: number; aabbCount: number; aabbBuildMs: number };
}

/**
 * Main traversal: register nodes, signals, drives, and components.
 * This is STEP 1 "Awake" — construct, applySchema, register ALL.
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
  const replayRecordingConfigs: TraverseResult['replayRecordingConfigs'] = [];

  // Pipeline nodes for tooltip hover
  const pipeNodes: Object3D[] = [];
  const tankNodes: Object3D[] = [];
  const pumpNodes: Object3D[] = [];
  const processingUnitNodes: Object3D[] = [];

  // Load-time metadata cost stats (DevTools "Picking & Highlight")
  const metadataStats = { metadataNodes: 0, aabbCount: 0, aabbBuildMs: 0 };

  root.traverse((node: Object3D) => {
    // Register ALL nodes in registry (Phase 1)
    const path = NodeRegistry.computeNodePath(node);
    registry.registerNode(path, node);

    // Apply rv-extras overlay BEFORE components read userData.realvirtual.
    // The overlay can introduce new component types on a node — so always run
    // this step regardless of whether the node already has rv-extras.
    if (overlay) applyOverlayToNode(node, path, overlay);

    // Drive datasheet (GLB-First, runs BEFORE the rv-extras guard so pure-geometry
    // nodes are covered, and BEFORE the raycast BVH so findContentAncestor makes
    // them interactive). Nodes whose name marks them as motor/drive GEOMETRY get
    // the standard SEW gearmotor AAS → the motor itself becomes a hover/click
    // datasheet target (highlight renders through walls via OutlinePass). Matches
    // "Motor"/"Antrieb" and library drive meshes (DriveMesh/DriveRotate/DriveRolls)
    // but NOT the Drive-Lin/Rot-* logic nodes, which contain the belt/transport.
    // attachAasLink no-ops on an authored AASLink; the guard on the AASLink block
    // below preserves this gated link from being overwritten as non-gated.
    if (isDriveDatasheetNode(node.name || '')) {
      attachAasLink(node, SEW_DRIVE_AAS.aasId, SEW_DRIVE_AAS.description);
    }

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

    // PLC Signals (registered first, before components that reference them)
    for (const sigType of SIGNAL_TYPES) {
      if (rv[sigType]) {
        const sigData = rv[sigType] as Record<string, unknown>;
        validateExtras(sigType, sigData);
        registerSignal(node, sigType, sigData, path, signalStore, registry, renamedNodes.get(node));
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
    // The `!_rvAasLink` guard skips a gated drive-datasheet link already attached
    // by name above, so its `gated` flag survives (authored links have no link yet).
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
        replayRecordingConfigs.push({ sequence, startOnSignal, isReplayingSignal, activeOnly: rrActiveOnly });
      }
    }
  });

  // Hide MU templates (before init — sources need them hidden)
  for (const muNode of muTemplateNodes) {
    muNode.visible = false;
    debug('loader', `MU template: ${muNode.name} (hidden)`);
  }

  return {
    drives,
    pending,
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
      // Drives have a config→runtime split (TargetSpeed/Direction → targetSpeed/
      // axis); re-derive them safely without re-caching the base transform.
      if (instance instanceof RVDrive) instance.reapplyConfig();
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

  // Original path = current path with every renamed ANCESTOR (and the node
  // itself) spelled the way the glTF file spelled it.
  //
  // `spell` picks which spelling a renamed segment contributes: the raw glTF
  // name, or the form Three.js sanitized it to. Un-renamed ancestors always
  // fall back to `current.name` in BOTH passes — they were never touched, so
  // there is nothing to spell differently.
  const computeOriginalPath = (node: Object3D, spell: (raw: string) => string): string => {
    const parts: string[] = [];
    let current: Object3D | null = node;
    while (current && current.parent) {
      const raw = renamedNodes.get(current);
      parts.unshift(raw !== undefined ? spell(raw) : current.name);
      current = current.parent;
      if (!current.parent) break;
    }
    return parts.join('/');
  };

  const asRaw = (raw: string): string => raw;

  // Topmost renamed nodes only: a renamed node below another renamed node is
  // reached by the ancestor's traversal anyway.
  const roots: Object3D[] = [];
  for (const obj of renamedNodes.keys()) {
    let ancestor: Object3D | null = obj.parent;
    let covered = false;
    while (ancestor) {
      if (renamedNodes.has(ancestor)) { covered = true; break; }
      ancestor = ancestor.parent;
    }
    if (!covered) roots.push(obj);
  }

  const visited = new Set<Object3D>();
  let nodeAliases = 0;
  let signalAliases = 0;
  let droppedAliases = 0;
  // Largest suffix bucket across the aliases we add — the cost signal for the
  // registry's O(bucket) suffix scan (plan-734 F8).
  const suffixCounts = new Map<string, number>();

  for (const root of roots) {
    root.traverse((node: Object3D) => {
      if (visited.has(node)) return;
      visited.add(node);

      const currentPath = NodeRegistry.computeNodePath(node);
      // Both historical spellings, de-duplicated: a segment without reserved
      // characters or whitespace spells the same either way, which is the
      // common case and must not cost a second registration.
      const origPaths = [...new Set([
        computeOriginalPath(node, asRaw),
        computeOriginalPath(node, sanitizeLikeThree),
      ])].filter((p) => p !== currentPath);
      if (origPaths.length === 0) return;

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
  }

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
  for (const { component, type, path } of pending) {
    // Isolate each component: a single component's resolve/init throwing must not
    // abort the whole model load (which would leave the scene/hierarchy unbuilt).
    try {
      resolveComponentRefs(component as unknown as Record<string, unknown>, context.registry);
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
      resolveComponentRefs(component as unknown as Record<string, unknown>, context.registry);
      const drive = component.DriveReference
        ?? component.drive
        ?? context.registry.findInParent<RVDrive>(component.node, 'Drive');
      if (drive) drive.isTransportSurface = true;
    } catch (error) {
      console.warn(`[loader] TransportSurface prepare failed for "${item.path}":`, error);
    }
  }
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
  /** plan-417 — so a runtime-placed scene button animates and is torn down. */
  sceneButtonManager?: SceneButtonManager;
  energyChainManager?: EnergyChainManager;
  /** plan-733 - so a Chain reaches the per-tick pose registry. */
  chainManager?: ChainManager;
  /** plan-405 — so a runtime-created `MachiningVolume` reaches the manager. */
  machiningManager?: MachiningManager;
  /** plan-394 — so a runtime-created `CollisionRole` reaches the manager. */
  collisionManager?: CollisionRoleRegistrar;
  outlineManager?: RVOutlineManager;
  /** plan-427 — so a runtime-created component's input slots take part in the
   *  post-reset / post-reconnect level re-apply. Falls back to the module slot. */
  reapply?: SignalReapplyRegistry;
  events?: EventEmitter<ViewerEvents>;
  errorStore?: ErrorStore;
  instructionStore?: InstructionRuntimeStore;
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
export function createRuntimeNode(deps: RuntimeNodeDeps, spec: RuntimeNodeSpec): Object3D | null {
  const parent = deps.registry.getNode(spec.parentPath);
  if (!parent) return null;

  const node = new Object3D();
  node.name = spec.name;
  node.position.fromArray(spec.position);
  node.quaternion.fromArray(spec.quaternion);
  node.scale.fromArray(spec.scale);
  node.userData.realvirtual = deepCloneJSON(spec.components);
  node.userData.__rvAdded = true;
  parent.add(node);
  node.updateMatrix();
  node.updateMatrixWorld(true);

  const path = NodeRegistry.computeNodePath(node);
  deps.registry.registerNode(path, node);

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
    constructed.push(inst);
  }

  const context: ComponentContext = {
    registry: deps.registry, signalStore: deps.signalStore, scene: deps.scene,
    transportManager: deps.transportManager, root: parent,
    gizmoManager: deps.gizmoManager, lampManager: deps.lampManager,
    sceneButtonManager: deps.sceneButtonManager,
    energyChainManager: deps.energyChainManager,
    chainManager: deps.chainManager,
    machiningManager: deps.machiningManager,
    collisionManager: deps.collisionManager,
    outlineManager: deps.outlineManager,
    reapply: deps.reapply ?? getActiveSignalReapplyRegistry() ?? undefined,
    events: deps.events, errorStore: deps.errorStore,
    instructionStore: deps.instructionStore,
    kinematicManager: getKinematicManager() ?? undefined,
  };
  for (const inst of constructed) {
    try {
      resolveComponentRefs(inst as unknown as Record<string, unknown>, deps.registry);
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
  if (!factory) return null;

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
    resolveComponentRefs(inst as unknown as Record<string, unknown>, deps.registry);
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
    sceneButtonManager: deps.sceneButtonManager,
    energyChainManager: deps.energyChainManager,
    chainManager: deps.chainManager,
    machiningManager: deps.machiningManager,
    collisionManager: deps.collisionManager,
    outlineManager: deps.outlineManager,
    reapply: deps.reapply ?? getActiveSignalReapplyRegistry() ?? undefined,
    events: deps.events, errorStore: deps.errorStore,
    instructionStore: deps.instructionStore,
    kinematicManager: getKinematicManager() ?? undefined,
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
    resolveComponentRefs(result.drive as unknown as Record<string, unknown>, deps.registry);
  } catch (e) {
    console.error(`[loader] runtime Drive ref resolution failed on "${node.name}":`, e);
  }
  // Behaviors authored in the same extras record (a paste / redo of a drive that
  // already carried one) go through loader STEP 2 verbatim.
  for (const pb of result.pendingBehaviors) {
    try {
      resolveComponentRefs(pb.component as unknown as Record<string, unknown>, deps.registry);
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
    resolveComponentRefs(inst as unknown as Record<string, unknown>, deps.registry);
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
 * Apply WebGPU compatibility fixes (missing UVs, indexed geometry conversion).
 */
export function applyWebGPUFixes(root: Object3D, isWebGPU: boolean): void {
  let uvFixCount = 0;
  let indexFixCount = 0;
  root.traverse((node: Object3D) => {
    if (!(node as Mesh).isMesh) return;
    const geo = (node as Mesh).geometry as BufferGeometry;

    if (!geo.attributes.uv && geo.attributes.position) {
      geo.setAttribute('uv', new BufferAttribute(
        new Float32Array(geo.attributes.position.count * 2), 2,
      ));
      uvFixCount++;
    }

    if (isWebGPU && geo.index) {
      const nonIndexed = geo.toNonIndexed();
      (node as Mesh).geometry = nonIndexed;
      geo.dispose();
      indexFixCount++;
    }
  });
  if (uvFixCount > 0 || indexFixCount > 0) {
    debug('loader', `Geometry fixes: ${uvFixCount} missing UVs` + (indexFixCount > 0 ? `, ${indexFixCount} indexed->non-indexed (WebGPU)` : ''));
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
   * Merged raycast geometries (Phase 13b, built with `deferBVH: true`).
   * Built FIRST — few in number, largest triangle counts, highest benefit —
   * and in indirect mode so their face-range tables stay valid.
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
        indirect: job.indirect,
        transferable: !sharedBuffer && options?.transferable !== false,
      });
    } catch (e) {
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
    const startAddr = registry.resolve(cfg.startOnSignal).signalAddress ?? null;
    const replayAddr = registry.resolve(cfg.isReplayingSignal).signalAddress ?? null;
    const rr = new RVReplayRecording(cfg.sequence, startAddr, replayAddr, playback, signalStore);
    rr.activeOnly = cfg.activeOnly;
    replayRecordings.push(rr);
    debug('loader',
      `ReplayRecording: "${cfg.sequence}" startSignal=${startAddr ?? 'none'} replayingSignal=${replayAddr ?? 'none'}`
    );
  }
  return replayRecordings;
}

/**
 * Build LogicStep engine from scene root.
 */
export function buildLogicEngine(
  root: Object3D,
  registry: NodeRegistry,
  signalStore: SignalStore,
): RVLogicEngine | null {
  const engine = RVLogicEngine.build(root, registry, signalStore);
  return engine.roots.length > 0 ? engine : null;
}

// ═══════════════════════════════════════════════════════════════════
// Sidecar JSON loader
// ═══════════════════════════════════════════════════════════════════

/**
 * Attempt to fetch a `<glb>.kin.json` sidecar next to the GLB URL.
 *
 * Returns the parsed KinematicsSpec on success, null on 404 (silent),
 * or null with a console warning on parse error.
 *
 * The URL transformation strips an optional `?query` part before swapping
 * the `.glb` extension so cache-busted GLB URLs still locate their sidecar.
 *
 * Exported for testing.
 */
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

export async function tryFetchSidecarSpec(glbUrl: string): Promise<import('../behavior-runtime').KinematicsSpec | null> {
  if (!glbUrl) return null;
  // `rvproject:` (a project document opened by path) is not fetchable — the
  // browser logs a loud error for the attempt before any catch runs.
  if (!isFetchableUrl(glbUrl)) return null;
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
      try {
        return await resp.text();
      } catch {
        return null;
      }
    })();
    _sidecarProbeCache.set(sidecarUrl, text);
  }

  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text) as import('../behavior-runtime').KinematicsSpec;
  } catch (e) {
    console.warn(`[sidecar] parse error for ${sidecarUrl}:`, e);
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
async function applyFrameSidecars(composition: ComposeResult): Promise<void> {
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
      debug('loader', `Sidecar applied to ${frame.assetId || frame.url}: drives=${report.applied.drives} `
        + `transports=${report.applied.transports} sensors=${report.applied.sensors}`);
    } finally {
      for (const { parent, child } of detached) parent.add(child);
    }
  }
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
 * Returns drives, transport manager, signal store, registry, playback, logic engine, and scene metrics.
 */
export async function loadGLB(url: string, scene: Scene, options?: LoadGLBOptions): Promise<LoadResult> {
  const prof = createLoadProfiler('loadGLB');

  const preserveHierarchy = options?.preserveHierarchy ?? false;

  // Phase 1: parse the GLB. Every model reaches the scene through these bytes —
  // non-GLB sources (STEP, USD) are converted to GLB at import time and cached,
  // so import and reload produce an identical tree (see rv-cad-glb-cache.ts).
  const {
    root,
    gltfParser,
    signatureState,
    signaturePresent,
    signerOrganization,
  } = await loadAndPrepareGLTF(url, scene, options?.data);
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
      resolve: options?.referenceResolver ?? createReferenceResolver(),
      cache: options?.composeCache,
      shouldAbort: options?.shouldAbort,
    });
    // Each referenced file's OWN sidecar, scoped to its own occurrence and
    // skipped for a signed file — the same rule the root just followed, applied
    // per source file instead of once globally.
    if (options?.loadKinematicsSidecar !== false) {
      await applyFrameSidecars(composition);
    }
    prof.mark('compose');
  }

  // Phase 2: Process meshes (shadow classification, triangle counting, drive/transport node sets)
  const { triangleCount, driveNodeSet } = processMeshes(root);
  prof.mark('processMeshes');

  // Composed subtrees carry their own rename stamps; merging them here is what
  // makes `registerNodeAliases` (Phase 6) cover referenced nodes too.
  for (const frame of composition?.frames ?? []) {
    for (const [node, orig] of frame.renamedNodes) renamedNodes.set(node, orig);
  }

  // Phase 4: Initialize core systems
  const registry = new NodeRegistry();
  registry.setGltfNodeIndices(gltfNodeIndices, gltfNodeNames);
  // One index map PER SOURCE FILE. Without the source key a writer would patch
  // `nodes[7]` of the root file with what belongs in `nodes[7]` of a referenced
  // one — and the `expectedNames` identity check would pass while doing it.
  for (const frame of composition?.frames ?? []) {
    registry.addGltfNodeSource(frame.sourceKey, frame.gltfNodeIndices, frame.gltfNodeNames);
    registry.registerNodeIdsForSubtree(frame.subtreeRoot, frame.occurrence);
  }
  const signalStore = new SignalStore();
  const manager = new RVTransportManager();
  manager.scene = scene;
  // WebGPU guard flag (plan-271 PR#0) — gates the GLSL-only MU dissolve/grow
  // effects the manager creates during simulation.
  manager.isWebGPU = options?.isWebGPU ?? false;
  manager.muComputeRenderer = options?.muComputeRenderer ?? null;

  // Phase 4c: Library-Component naming-convention scan — walks the entire
  // GLB tree and derives a spec from Drive-*/Transport-* names. No marker
  // required; the patterns are specific enough that false positives are
  // unlikely. Deep-merge preserves any manually-authored rv_extras (F13).
  // `hasLibraryMarker` is still available for diagnostics/logging.
  {
    const spec = scanLibraryComponent(root);
    if ((spec.drives?.length ?? 0) > 0 || (spec.transports?.length ?? 0) > 0 || (spec.sensors?.length ?? 0) > 0) {
      applyKinematicsSpec(root, spec);
      debug('loader', `Naming-convention scan: drives=${spec.drives!.length} transports=${spec.transports!.length} sensors=${spec.sensors!.length}`);
    }
  }

  // Phase 5: Main traversal — register nodes, signals, drives, components.
  // The optional overlay is applied per-node BEFORE component construction
  // so drives/sensors see the overridden field values directly.
  const traverseResult = traverseAndRegister(root, registry, signalStore, renamedNodes, options?.overlay);
  prof.mark('traverseAndRegister');

  // Phase 6: Register node aliases for renamed nodes
  const aliasStats = registerNodeAliases(renamedNodes, registry, signalStore);
  // Own marker (plan-734): the time used to fall into the NEXT phase's mark, so
  // a model whose CAD reused 40k names looked like a slow component init.
  prof.mark('registerNodeAliases');

  // Phase 6b: unresolved references become entries in the Problems panel
  // (plan-703 §2.8, F16). Here and not right after `compose` on purpose — the
  // registry only exists from Phase 4 on, and a problem that cannot name the
  // node it is about sends the user hunting through the hierarchy by eye.
  // Always called, including with an empty list: that is what retires the
  // entries of a reference the user has just repaired.
  reportMissingReferences((composition?.missing ?? []).map((m) => ({
    assetId: m.assetId,
    path: m.path,
    occurrence: m.occurrence,
    label: m.label,
    nodePath: registry.getPathForNode(m.referenceNode) ?? undefined,
  })));

  // Phase 7: Initialize components (Step 2 "Start"). ONE context, shared with
  // the Phase 8d onSceneReady pass below.
  const componentContext: ComponentContext = {
    registry, signalStore, scene, transportManager: manager, root,
    gizmoManager: options?.gizmoManager, lampManager: options?.lampManager,
    sceneButtonManager: options?.sceneButtonManager,
    energyChainManager: options?.energyChainManager, expectSceneReady: true,
    chainManager: options?.chainManager,
    // plan-733 R4 - the asset editor saves the tree it sees, so components that
    // materialise runtime geometry (RVChain element clones) must not build it.
    // Keyed to `preserveAuthoringHierarchy`, NOT `preserveHierarchy`: the latter
    // is a mesh-bake flag that `RVEmbedViewer` — a simulating PRODUCTION runtime
    // — also sets, and gating on it would silently leave every embedded chain
    // without its elements. Only the asset editor sets this one.
    authoring: options?.preserveAuthoringHierarchy === true,
    machiningManager: options?.machiningManager,
    collisionManager: options?.collisionManager,
    outlineManager: options?.outlineManager,
    reapply: options?.reapply ?? getActiveSignalReapplyRegistry() ?? undefined,
    events: options?.events,
    errorStore: options?.errorStore, instructionStore: options?.instructionStore,
    kinematicManager: getKinematicManager() ?? undefined,
  };
  prepareTransportSurfaces(traverseResult.pending, componentContext);

  // Phase 7 trust gate (plan-397 §2.9). Without composition this is the single
  // global flag it has always been. With composition it is PER FRAME: a signed
  // root must not lend its trust to an unsigned referenced file, or dropping a
  // GLB next to a signed scene would be a privilege escalation. Components from
  // an ungated frame still run — the gate is per subtree, not all-or-nothing.
  const gatedFrames = composition
    ? composition.frames.filter((f) => isFrameGated(f.effectiveState, signatureState, allowUntrustedLogic))
    : [];
  const gatedNodes = composition && gatedFrames.length > 0
    ? collectGatedNodes(composition, signatureState, allowUntrustedLogic)
    : null;
  const trusted = gatedNodes
    ? traverseResult.pending.filter((p) => !gatedNodes.has(p.component.node))
    : traverseResult.pending;
  if (!logicGated) initializeComponents(trusted, componentContext);
  if (gatedFrames.length > 0) {
    console.warn(
      `[loadGLB] ${gatedFrames.length} referenced asset(s) are less trusted than this scene — `
      + 'their logic is disabled. Assets: '
      + gatedFrames.map((f) => `${f.assetId || f.url} (${f.ownSignatureState})`).join(', '),
    );
  }
  prof.mark('initializeComponents');

  // Phase 8: Build groups
  const groups = buildGroups(traverseResult.groupNodes, registry);

  // Phase 8a: Reset all drives to their authored HOME pose before the kinematic
  // phases run. Mirrors Unity, where Kinematic.Awake() performs group parenting
  // BEFORE any Drive/behavior moves the node in Start()/FixedUpdate. In the web
  // loader, behavior init() (Drive_Cylinder, Drive_Gear, Drive_FollowPosition,
  // …) may already have called applyToNode() and moved a supporting axis off
  // home. If the kinematic re-parent (8b) attaches world-preserving group meshes
  // — or the kinematic merge (10d) bakes geometry into drive-local space — while
  // a parent drive is off home, the offset (= behavior stroke) is frozen in and
  // the pivot ends up next to the part instead of inside it. Snapshot the live
  // positions, drive everything to its base pose, run the kinematic phases
  // there, then restore after the merge (Phase 10d).
  //
  // Home is the AUTHORED BASE POSE, not `StartPosition`: `applyToNode()` adds
  // `Offset` at every position, so driving to StartPosition left an
  // Offset-carrying drive displaced by exactly that Offset — and the kinematic
  // phases then froze it in (LOP-68: the group member was attached against the
  // displaced parent, and Pass 3's refreshBaseTransform() baked the Offset into
  // the kinematic node's own basePosition, so Phase 10e applied it twice).
  // `applyBasePose()` restores the transform captured at initDrive(), which is
  // what the GLB was authored in and what Unity parents in.
  const driveHomeSnapshot = traverseResult.drives.map(d => ({ drive: d, pos: d.currentPosition }));
  for (const { drive } of driveHomeSnapshot) {
    drive.applyBasePose();
  }
  root.updateMatrixWorld(true);

  // Phase 8b: kinematic structure. In an authoring load (plan-727) both passes
  // still resolve names and prefixes, but nothing is moved — the GLB hierarchy
  // is never mutated, so a save/reload cycle is a fixpoint and the CAD
  // re-import keeps finding every node under its CAD root.
  const kinResult = applyKinematicParenting(
    traverseResult.kinematicNodes, groups, registry, root,
    options?.preserveAuthoringHierarchy === true,
  );
  const kinematicGroupNames = kinResult.groupNames;
  // Mark kinematic groups in registry and auto-exclude from overlay.
  // OUTSIDE any authoring gate: `isKinematic()` feeds the editor's group
  // assignment menu and must answer identically in both modes (plan-727 F9).
  if (groups && kinematicGroupNames.length > 0) {
    for (const name of kinematicGroupNames) {
      groups.markAsKinematic(name);
    }
  }

  // Phase 8a-bis: group-aware dynamic reclassification (plan-727 F8).
  // Placed AFTER 8b rather than after buildGroups() as the plan sketched: the
  // resolved (prefix-expanded) group names are produced by Pass 1 of
  // applyKinematicParenting, and duplicating that resolution would be the very
  // drift the prefix mechanism is fragile to. Position is behaviourally free —
  // the pass only ever sets matrixAutoUpdate to true — and running it after 8b
  // keeps the runtime path bit-identical to before (Pass 3 already covered it).
  reclassifyKinematicGroupsDynamic(kinematicGroupNames, groups);

  // Phase 8c: Recompute registry paths for re-parented subtrees + signal paths
  if (kinResult.affectedSubtrees.length > 0) {
    const { count, remap } = registry.recomputePathsForSubtrees(kinResult.affectedSubtrees);
    if (remap.size > 0) {
      signalStore.remapPaths(remap);
      // Keep the pre-reparent paths resolvable: references serialized in the
      // GLB (instruction targets, lazy path lookups) use the authoring
      // hierarchy, which Phase 8b just changed.
      for (const [oldPath, newPath] of remap) {
        const node = registry.getNode(newPath);
        if (node) registry.registerAlias(oldPath, node);
      }
    }
    debug('loader', `[Kinematic] Recomputed ${count} registry paths, ${remap.size} signal paths after re-parenting`);
  }

  // Phase 8d: Reconcile overlay overrides that the Phase-5 traverse could not
  // apply because the override's stored node-path didn't match the path used
  // during traversal. This happens when kinematic re-parenting (Phase 8b)
  // changes a node's path between traversal and the final registry — the
  // inspector edited (and stored the override under) the post-reparent path,
  // but the traverse applied overrides keyed by the pre-reparent path. It also
  // covers space/underscore/suffix/alias path differences. The registry is now
  // complete (paths recomputed in 8c), so resolve each override key against it
  // and apply anything that didn't land, re-syncing the live component.
  if (options?.overlay) reconcileOverlayOverrides(registry, options.overlay);

  // Phase 8d: Late-init pass — components opting into onSceneReady() now see
  // the final hierarchy (kinematic re-parenting complete). Used by gizmos that
  // need an accurate subtree AABB (e.g. RVSafetyDoor floor halo + label).
  if (!logicGated) runOnSceneReady(trusted, componentContext);
  prof.mark('buildGroups+kinematicParenting');

  // Phase 9: WebGPU compatibility fixes
  applyWebGPUFixes(root, options?.isWebGPU ?? false);

  // Phase 10: Material deduplication (must run before static merge)
  const dedupResult = deduplicateMaterials(root);
  prof.mark('deduplicateMaterials');

  // Phase 10b: Uber-material pass — collapse every untextured
  // MeshStandardMaterial onto a single shared reference with per-vertex
  // color + rmPacked attributes. Depends on Phase 10 having already
  // collapsed identical references. Mutates dedupResult.uniqueMaterials
  // (removes collapsed materials, adds the shared uber singleton).
  // Editor / STEP-inspection mode keeps the raw assembly: skip the uber bake so
  // sharedMaterial stays null, which in turn auto-skips the static + kinematic
  // merges below (Phase 10c/10d) — every part node stays visible & pickable.
  const uberResult: UberResult = preserveHierarchy
    ? { eligibleMaterialCount: 0, bakedMeshCount: 0, sharedMaterial: null, sharedGeometryReuses: 0, clonedGeometryCount: 0, disposedSourceGeometries: 0 }
    : applyUberMaterial(root, dedupResult.uniqueMaterials, options?.isWebGPU ?? false);
  prof.mark('applyUberMaterial');
  // Keep reported uniqueCount in sync with the post-uber state so the
  // DevTools panel and getRendererStats() reflect what's actually on the GPU.
  dedupResult.uniqueCount = dedupResult.uniqueMaterials.size;

  // The batch/merge phases 10c/10d are ASYNC. While they run, the render
  // loop keeps ticking with the scene in the Phase-8a HOME pose (restore
  // happens in 10e) — keep the root invisible from the start of 10c until
  // 10e completed so neither the wrong pose nor a stale double model is ever
  // visible (N5). Only touch roots that were visible.
  const shouldAbort = options?.shouldAbort ?? ((): boolean => false);
  // Static batching (10c + 10d-tex): all static geometry goes into BatchedMesh
  // arenas with PER-INSTANCE visibility (setVisibleAt via the
  // BatchVisibilityService) — no owner buckets, no chunk parenting. The
  // kinematic merge (10d) stays chunk-based: its chunks are parented under
  // the Drive nodes and move via parent-matrix propagation.
  const staticMergeEnabled = isStaticMeshMergingEnabled();
  const batchTable: BatchTable | null = preserveHierarchy || !staticMergeEnabled ? null : new BatchTable();
  const rootWasVisible = root.visible;
  if (batchTable && rootWasVisible) root.visible = false;

  // Stale-load cleanup (B3/F7): the superseding load's clearModel() sweep
  // cannot see this root (`_rvModelRoot` is tagged only after loadModel
  // resolves), so the aborted load tears itself down: remove the root and
  // free its GPU resources. Shared fixtures (`_rvShared`, e.g. the uber
  // material singleton) survive — mirrors clearModel().
  const abortLoad = (): never => {
    scene.remove(root);
    batchTable?.dispose();
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

  // Phase 10c/10d: Motion-blob batching — the scene is partitioned into ONE
  // static blob + one blob per Drive subtree; every blob collapses into an
  // uber arena (untextured) plus one arena per textured material. Static
  // arenas parent under the root; drive arenas parent under their Drive node
  // and move via parent-matrix propagation. Runs inside the home-pose window
  // (before 10e) so drive-local instance matrices bake against HOME
  // transforms. On failure sources keep rendering individually (B4 parity).
  const sceneBatchResult: SceneBatchResult | null = batchTable
    ? await buildBatchedScene(root, uberResult.sharedMaterial, driveNodeSet, batchTable, {
        shouldAbort,
        onArenaBuild: options?.onArenaBuild,
      })
    : null;
  const uberBatchResult = sceneBatchResult?.staticUber ?? null;
  const texBatchResult = sceneBatchResult?.staticTextured ?? null;
  const kinBatchResult = sceneBatchResult?.kinematic ?? null;
  prof.mark('buildBatchedScene');
  if (shouldAbort()) abortLoad();

  // Merge-duration hook (plan-274 F5): expose the batching time so the
  // before/after gain is measurable per load.
  const mergeMs = prof.getTimings()
    .filter((t) => t.phase === 'buildBatchedScene')
    .reduce((sum, t) => sum + t.ms, 0);

  // Phase 10e: Restore the drive positions that behavior init() applied before
  // the kinematic phases (see Phase 8a). Now that group meshes are attached and
  // merged relative to the HOME pivot, re-applying the live positions moves the
  // pivot AND its baked geometry together, so the offset stays zero.
  for (const { drive, pos } of driveHomeSnapshot) {
    drive.currentPosition = pos;
    drive.applyToNode();
  }
  root.updateMatrixWorld(true);

  // N5: reveal the root again — home-pose restore is complete.
  if (batchTable && rootWasVisible) root.visible = true;

  // Phase 11: Freeze static matrices — turn off matrixWorldAutoUpdate on every
  // node with no Drive/Kinematic/Grip/Transport/Source/Sink/MU/SceneButtonMoveable
  // in its up- or down-path, so Three.js skips the bulk of the scene graph in the per-frame
  // updateMatrixWorld recursion. MUST run here, after kinematic re-parenting
  // (Phase 8b) and the merges (Phase 10c/10d), so the parent chains driving the
  // mover closure are final. ~2x render-loop speedup on large static CAD scenes.
  // NOTE: running AFTER component construction (Phase 8) means this pass has the
  // last word on matrixWorldAutoUpdate — a component that thaws itself in init()
  // is overwritten here. Anything that moves must be a MOVER_KEY in
  // rv-freeze-static.ts (plan-417: SceneButtonMoveable learned that the hard way).
  // plan-727: kinematic group members are handed in explicitly. In a runtime
  // load they sit under the axis anyway and this changes nothing; in an
  // authoring load they are the only nodes the mover closure cannot see.
  const freezeResult = freezeStaticMatrices(
    root, collectKinematicGroupMembers(kinematicGroupNames, groups),
  );
  debug('loader', `[Freeze] static matrixWorldAutoUpdate=false on ${freezeResult.frozen}/${freezeResult.total} nodes (${freezeResult.dynamic} kept dynamic)`);

  // Phase 12: Bounding box (after merge — merged geometry changes bounds)
  //
  // NOT `Box3.setFromObject(root)`: it would count the BatchedMesh arenas built
  // in 10c/10d by their RAW geometry buffer, which holds the source vertices in
  // the source's own units and ignores the per-instance matrices that actually
  // place them. On a CAD import whose meshes carry scale 0.001 that buffer reads
  // ~1000x too large — measured on a Delta: arena bbox radius 313 m for a 0.6 m
  // arm, static arena 1095 m for a 1.5 m machine. Rendering stays correct (the
  // instance matrices are right), but this box feeds the initial camera fit and
  // the ground disc, so the floor grew to kilometres and the fit camera ended up
  // ~2.5 km outside the machine — the model looked like it had vanished.
  //
  // The still-present source meshes give the true bounds. Same rule as
  // RVViewer._computeContentBounds(); keep the two in step.
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

  // Phase 13b: Build grouped raycast geometries (static + per-Drive
  // kinematic). The geometry MERGE stays synchronous; the merged BVHs are
  // deferred into the async build (deferBVH → computeBVHAsync, indirect mode).
  //
  // Authoring loads (`preserveHierarchy`) SKIP the merged groups entirely:
  // the editor picks real meshes through the InstancePickIndex backend
  // (rv-instance-pick-index.ts, installed by RVViewer after this load) —
  // per-mesh local BVHs from the async build are its narrow phase, so a
  // merged world-space copy would only add rebuild cost on every edit.
  // Kill-switch: rv-instance-pick-flag.ts restores the legacy merged path.
  const raycastGeometrySet = preserveHierarchy && isInstancePickEnabled()
    ? null
    : buildRaycastGeometries(
      root, traverseResult.drives, registry, driveNodeSet, { deferBVH: true },
    );
  prof.mark('buildRaycastGeometries');

  // Phase 14: Build playback
  const playback = buildPlayback(traverseResult.recordingData, traverseResult.recorderSettings, registry);

  // Phase 15: Build replay recordings
  const replayRecordings = buildReplayRecordings(
    traverseResult.replayRecordingConfigs, playback, registry, signalStore,
  );

  // Phase 16: Build logic engine
  const logicEngine = buildLogicEngine(root, registry, signalStore);

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
    (logicEngine ? `logicSteps=${logicEngine.stats.totalSteps}, ` : '') +
    `${Math.round(triangleCount / 1000)}K triangles`
  );

  prof.mark('finalize');
  prof.report();

  return {
    root,
    drives: traverseResult.drives,
    transportManager: manager,
    signalStore,
    registry,
    playback,
    replayRecordings,
    recorderSettings: traverseResult.recorderSettings,
    logicEngine,
    boundingBox,
    triangleCount,
    groups,
    modelConfig: {},
    dedupResult,
    uberResult,
    uberBatchResult,
    texBatchResult,
    kinBatchResult,
    batchTable,
    pipelineNodes,
    kinematicGroupNames,
    raycastGeometrySet,
    mergeMs,
    metadataStats: {
      ...traverseResult.metadataStats,
      hoverableFaceRanges:
        (raycastGeometrySet?.staticGroup?.faceRanges.length ?? 0) +
        [...(raycastGeometrySet?.kinematicGroups.values() ?? [])]
          .reduce((n, g) => n + g.faceRanges.length, 0),
    },
    aliasStats,
    signatureState,
    signaturePresent,
    signerOrganization,
    logicGated,
    deferredLogic: logicGated
      ? { pending: trusted, context: componentContext }
      : null,
    composition,
    gatedFrames,
    orphanedOverrides: composition?.orphanedOverrides ?? [],
  };
}

// ═══════════════════════════════════════════════════════════════════
// processExtras — Runtime extras processing for dynamically added GLBs
// ═══════════════════════════════════════════════════════════════════

export interface ProcessExtrasResult {
  drives: RVDrive[];
  signalsRegistered: number;
  componentsCreated: number;
  deferredLogic: DeferredLogic | null;
}

export interface ProcessExtrasOptions {
  logicRunState?: 'active' | 'gated' | 'activating';
  /** plan-394 — so a placed asset's `CollisionRole` reaches the manager. */
  collisionManager?: CollisionRoleRegistrar;
  /** plan-405 — so a placed asset's `MachiningVolume` reaches the manager. */
  machiningManager?: MachiningManager;
  /** plan-733 - so a placed Chain reaches the per-tick pose registry. */
  chainManager?: ChainManager;
  /**
   * plan-727 — AUTHORING call: never mutate the subtree's hierarchy. Same
   * meaning as {@link LoadGLBOptions.preserveAuthoringHierarchy}, for the
   * second re-parenting site. Set by the asset editor's `_rebuildComponents()`
   * (rv-asset-executors.ts), which runs on every separateMesh/mergeMesh
   * undo/redo and would otherwise re-parent live during a normal editing
   * session. The Layout Planner's placement calls deliberately leave it unset.
   */
  preserveAuthoringHierarchy?: boolean;
}

/**
 * Process realvirtual extras on a subtree that was added at runtime.
 *
 * Reuses the same two-step model as loadGLB() but operates on EXISTING
 * runtime systems (NodeRegistry, SignalStore, TransportManager) instead
 * of creating new ones. Designed for Layout Planner placed objects.
 *
 * Handles groups only as far as Kinematic re-parenting needs them (the group
 * registry built here is local — placed-asset groups are not added to the
 * viewer-wide GroupRegistry).
 *
 * Renamed-node aliases ARE registered (plan-381 F5) — from the `_rvOrigName`
 * stamps the parse step left behind, since detecting them here is impossible
 * (no glTF parser, and the tree may be a clone).
 *
 * Skips: recordings, BVH, WebGPU fixes, shadow classification,
 *        triangle counting, parity validation,
 *        LogicSteps (callers merge them via `viewer.logicEngine.addSubtree()` —
 *        see `mergePlacedLogic()` in layout-planner/scene-mutations.ts).
 */
export function processExtras(
  root: Object3D,
  registry: NodeRegistry,
  signalStore: SignalStore,
  transportManager: RVTransportManager,
  scene: Scene,
  gizmoManager?: GizmoOverlayManager,
  events?: EventEmitter<ViewerEvents>,
  errorStore?: ErrorStore,
  instructionStore?: InstructionRuntimeStore,
  options?: ProcessExtrasOptions,
  outlineManager?: RVOutlineManager,
  lampManager?: LampManager,
  energyChainManager?: EnergyChainManager,
  sceneButtonManager?: SceneButtonManager,
): ProcessExtrasResult {
  const drives: RVDrive[] = [];
  const pending: PendingComponent[] = [];
  const groupNodes: { node: Object3D; key: string; data: Record<string, unknown> }[] = [];
  const kinematicNodes: KinematicNodeEntry[] = [];
  let signalsRegistered = 0;

  // ── STEP 1 "Awake": Traverse, construct, applySchema, register ──
  root.traverse((node: Object3D) => {
    // Skip Layout-Planner ghost / held-preview / drag-ghost clones. These are
    // pure-visual previews that may have copied a source's rv-extras via
    // Object3D.clone(); instantiating components on them would create recursive
    // Sources that spawn endlessly and nest under the source.
    if (node.userData?._isSourceGhost || node.userData?._isSourcePreview || node.userData?._isGhost) return;

    // Register node in registry
    const path = NodeRegistry.computeNodePath(node);
    registry.registerNode(path, node);

    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv) return;

    // plan-419: Unity `Web*` marker keys → canonical viewer keys, before the
    // auto-discovered-components loop below reads the extras.
    normalizeComponentKeys(rv);

    // ── PLC Signals ──
    for (const sigType of SIGNAL_TYPES) {
      if (rv[sigType]) {
        const sigData = rv[sigType] as Record<string, unknown>;
        if (registerSignal(node, sigType, sigData, path, signalStore, registry)) {
          signalsRegistered++;
        }
      }
    }

    // ── Drive ──
    if (rv['Drive']) {
      const driveData = rv['Drive'] as Record<string, unknown>;
      const driveResult = constructDrive(node, rv, driveData, path, registry, signalStore);
      if (driveResult) {
        drives.push(driveResult.drive);
        for (const pb of driveResult.pendingBehaviors) pending.push(pb);
      }
    }

    // ── Auto-discovered components ──
    for (const [type, factory] of getRegisteredFactories()) {
      if (!rv[type]) continue;
      const data = rv[type] as Record<string, unknown>;
      const aabb = factory.needsAABB ? createAABBFromExtras(node, rv) : null;
      const instance = factory.create(node, aabb);
      if (factory.beforeSchema) factory.beforeSchema(instance, data);
      applySchema(instance as unknown as Record<string, unknown>, factory.schema, data);
      if (factory.afterCreate) factory.afterCreate(instance, node);
      registry.register(type, path, instance);
      pending.push({ component: instance, type, path });
    }

    // ── Groups + Kinematic (collected for the STEP 3 re-parenting pass) ──
    for (const key of Object.keys(rv)) {
      if (key === 'Group' || /^Group_\d+$/.test(key)) {
        groupNodes.push({ node, key, data: rv[key] as Record<string, unknown> });
      }
    }
    if (rv['Kinematic']) {
      const kinData = rv['Kinematic'] as Record<string, unknown>;
      const integrateGroup = kinData['IntegrateGroupEnable'] === true;
      const kinParent = kinData['KinematicParentEnable'] === true;
      if (kinParent || (integrateGroup && kinData['GroupName'])) {
        kinematicNodes.push({ node, data: kinData });
      }
    }
  });

  // ── STEP 1b: alias paths for Three.js-deduped nodes (plan-381 F5) ──
  // Same position as loadGLB's Phase 6: after signals are registered, before
  // STEP 2 resolves component refs against them. The renamed set is rebuilt
  // from the `_rvOrigName` stamps the parse step left on the nodes, because a
  // placed subtree is a CLONE of a cached tree — the parser's Object3D-keyed
  // map cannot follow it here.
  registerNodeAliases(collectRenamedNodes(root), registry, signalStore);

  // ── STEP 2 "Start": resolveComponentRefs + init() ──
  // Thread gizmoManager + events so dynamically placed components (e.g. a
  // TransportSurface dropped in from the library) can create selection
  // overlays and subscribe to selection events, exactly like the main
  // loadGLB() path does via initializeComponents().
  const context: ComponentContext = {
    registry, signalStore, scene, transportManager, root,
    gizmoManager, lampManager, outlineManager, events, errorStore, instructionStore,
    energyChainManager, sceneButtonManager, expectSceneReady: true,
    chainManager: options?.chainManager,
    // plan-733 R4 — same authoring gate as loadGLB above; the asset editor's
    // `_rebuildComponents()` is the caller that sets it here.
    authoring: options?.preserveAuthoringHierarchy === true,
    machiningManager: options?.machiningManager,
    collisionManager: options?.collisionManager,
    kinematicManager: getKinematicManager() ?? undefined,
    // plan-427: the placement path has no viewer-owned option bag of its own —
    // it is called positionally from the Layout Planner and the asset editor —
    // so the module slot is the source here (see rv-signal-reapply-registry.ts).
    reapply: getActiveSignalReapplyRegistry() ?? undefined,
  };
  prepareTransportSurfaces(pending, context);
  const gated = options?.logicRunState !== undefined && options.logicRunState !== 'active';
  if (!gated) initializeComponents(pending, context);

  // ── STEP 3 "Kinematics": group-based re-parenting (Phase 8/8a–8c of
  // loadGLB, applied to the placed subtree). Without this, assets authored
  // with Kinematic components (IntegrateGroupEnable) keep their group members
  // in the static CAD tree — drives simulate but nothing moves visually.
  // Runs BEFORE the caller's raycast/BVH rebuild (registerPlaced →
  // rebuildGroupedBvh), so the moved meshes classify as per-drive kinematic
  // groups instead of static geometry.
  if (kinematicNodes.length > 0) {
    const groups = buildGroups(groupNodes, registry);

    // Phase 8a equivalent: behavior init() above may have moved supporting
    // axes off home; attach() must run at the authored HOME pose so pivots
    // stay inside their parts.
    const driveHomeSnapshot = drives.map(d => ({ drive: d, pos: d.currentPosition }));
    for (const { drive } of driveHomeSnapshot) {
      drive.currentPosition = drive.StartPosition;
      drive.applyToNode();
    }
    root.updateMatrixWorld(true);

    const kinResult = applyKinematicParenting(
      kinematicNodes, groups, registry, root,
      options?.preserveAuthoringHierarchy === true,
    );
    if (groups) {
      for (const name of kinResult.groupNames) groups.markAsKinematic(name);
    }

    // Phase 8a-bis equivalent (plan-727 F8): group members are dynamic because a
    // drive moves them, not because they hang under one. Monotone — only adds.
    reclassifyKinematicGroupsDynamic(kinResult.groupNames, groups);

    // Phase 8c equivalent: recompute registry paths for the moved subtrees,
    // remap signal paths, and alias the authoring-hierarchy paths so
    // GLB-serialized references (instruction targets, lazy lookups) resolve.
    if (kinResult.affectedSubtrees.length > 0) {
      const { count, remap } = registry.recomputePathsForSubtrees(kinResult.affectedSubtrees);
      if (remap.size > 0) {
        signalStore.remapPaths(remap);
        for (const [oldPath, newPath] of remap) {
          const moved = registry.getNode(newPath);
          if (moved) registry.registerAlias(oldPath, moved);
        }
      }
      debug('loader', `[Kinematic] processExtras: recomputed ${count} registry paths, ${remap.size} signal paths after re-parenting`);
    }

    // Phase 10e equivalent: restore the live drive positions. There is no
    // merge phase here — the caller re-scans the final hierarchy afterwards.
    for (const { drive, pos } of driveHomeSnapshot) {
      drive.currentPosition = pos;
      drive.applyToNode();
    }
    root.updateMatrixWorld(true);
  }

  // Dynamic placements initialize components before kinematic
  // re-parenting. Give hierarchy-dependent components the same late-init
  // contract as loadGLB() once their final subtree is available.
  if (!gated) runOnSceneReady(pending, context);

  // Rebuild signal index for O(1) lookup of newly added signals
  signalStore.buildIndex();

  return {
    drives,
    signalsRegistered,
    componentsCreated: pending.length,
    deferredLogic: gated ? { pending, context } : null,
  };
}

