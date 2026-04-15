// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Scene, Object3D, Box3, BufferAttribute, Mesh, BufferGeometry } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RVDrive } from './rv-drive';
import { RVErraticDriver } from './rv-erratic';
import { RVDriveSimple } from './rv-drive-simple';
import { RVDriveCylinder } from './rv-drive-cylinder';
import { AABB } from './rv-aabb';
// Side-effect imports: trigger registerComponent() at module load
import './rv-transport-surface';
import './rv-sensor';
import './rv-source';
import './rv-sink';
import './rv-grip';
import './rv-grip-target';
import './rv-connect-signal';
import { applySchema, resolveComponentRefs, getRegisteredFactories, registerCapabilities, type RVComponent, type ComponentContext, type ComponentSchema } from './rv-component-registry';
import { RVTransportManager } from './rv-transport-manager';
import { SignalStore } from './rv-signal-store';
import { RVDrivesPlayback, parseCompactRecording, parseScriptableObjectRecording, type CompactRecording } from './rv-drives-playback';
import { RVReplayRecording } from './rv-replay-recording';
import { RVLogicEngine } from './rv-logic-engine';
import { NodeRegistry, type ComponentRef } from './rv-node-registry';
import { GroupRegistry } from './rv-group-registry';
import { validateExtras, printParitySummary, resetParityValidator } from './rv-extras-validator';
import { parseActiveOnly, type ActiveOnly } from './rv-active-only';
import { debug, logInfo } from './rv-debug';
import { deduplicateMaterials, type DedupResult } from './rv-material-dedup';
import { applyUberMaterial, type UberResult } from './rv-uber-material';
import { mergeStaticUberMeshes, type StaticUberMergeResult } from './rv-static-merge-uber';
import { mergeKinematicGroupMeshes, type KinematicMergeResult } from './rv-kinematic-merge-uber';
import { mergeStaticGeometries, type StaticMergeResult } from './rv-static-merge';
import { buildRaycastGeometries, type RaycastGeometrySet } from './rv-raycast-geometry';

// Singleton loader instances
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');

const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);

// ─── Register capabilities for types without factories ────────────

// Pipeline types (no factory, just userData._rvType)
registerCapabilities('Pipe', {
  hoverable: true,
  tooltipType: 'pipe',
  badgeColor: '#26c6da',
  hoverEnabledByDefault: true,
  hoverPriority: 10,
  pinPriority: 5,
});
registerCapabilities('Tank', {
  hoverable: true,
  tooltipType: 'tank',
  badgeColor: '#42a5f5',
  hoverEnabledByDefault: true,
  hoverPriority: 10,
  pinPriority: 5,
});
registerCapabilities('Pump', {
  hoverable: true,
  tooltipType: 'pump',
  badgeColor: '#7e57c2',
  hoverEnabledByDefault: true,
  hoverPriority: 10,
  pinPriority: 5,
});
registerCapabilities('ProcessingUnit', {
  hoverable: true,
  tooltipType: 'processing-unit',
  badgeColor: '#ef5350',
  hoverEnabledByDefault: true,
  hoverPriority: 10,
  pinPriority: 5,
});
registerCapabilities('Metadata', {
  hoverable: true,
  tooltipType: 'metadata',
  badgeColor: '#ffb74d',
  filterLabel: 'Metadata',
  hoverEnabledByDefault: true,
  hoverPriority: 8,
  pinPriority: 3,
});
// Note: AASLink capabilities are registered by aas-link-plugin.tsx (plugin side-effect).
// Model plugins load BEFORE loadGLB() so capabilities are available for BVH construction.
registerCapabilities('RuntimeMetadata', {
  badgeColor: '#ffb74d',
});

// Recorder types (visible in inspector but not hoverable)
registerCapabilities('DrivesRecorder', { badgeColor: '#7e57c2' });
registerCapabilities('ReplayRecording', { badgeColor: '#26a69a' });

// Structural types (hidden from inspector)
registerCapabilities('rigidbody', { inspectorVisible: false });
registerCapabilities('renderer', { inspectorVisible: false });
registerCapabilities('colliders', { inspectorVisible: false });
registerCapabilities('BoxCollider', { inspectorVisible: false });
registerCapabilities('Group', { inspectorVisible: false });
registerCapabilities('Kinematic', { inspectorVisible: false });
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

export interface LoadResult {
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
  uberMergeResult: StaticUberMergeResult | null;
  kinematicMergeResult: KinematicMergeResult | null;
  mergeResult: StaticMergeResult | null;
  pipelineNodes: { pipes: Object3D[]; tanks: Object3D[]; pumps: Object3D[]; processingUnits: Object3D[] };
  metadataNodes: Object3D[];
  /** Group names that were re-parented under Kinematic nodes (for auto-exclude from overlay). */
  kinematicGroupNames: string[];
  /** Grouped BVH raycast geometries (static + per-Drive kinematic). */
  raycastGeometrySet: RaycastGeometrySet | null;
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

  debug('loader', `[AABB] ${node.name}: meshAABB halfSize=${meshAABB.halfSize.toArray()}, lengthSq=${meshAABB.halfSize.lengthSq()}`);

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
        debug('loader', `[AABB] ${node.name}: using BoxCollider halfSize=${bc.halfSize.toArray()}, center=${bc.center.toArray()}`);
        return bc;
      }
    }
  }

  // Last resort: return degenerate AABB
  return meshAABB;
}

/** Map of known drive behavior types → class + schema for data-driven instantiation */
const DRIVE_BEHAVIOR_MAP: Record<string, { ctor: new (n: Object3D) => RVComponent; schema: ComponentSchema }> = {
  Drive_ErraticPosition: { ctor: RVErraticDriver, schema: RVErraticDriver.schema },
  Drive_Simple: { ctor: RVDriveSimple, schema: RVDriveSimple.schema },
  Drive_Cylinder: { ctor: RVDriveCylinder, schema: RVDriveCylinder.schema },
};

/** Signal type names recognized from GLB extras */
const SIGNAL_TYPES = ['PLCOutputBool', 'PLCInputBool', 'PLCOutputFloat', 'PLCInputFloat', 'PLCOutputInt', 'PLCInputInt'];

export interface LoadGLBOptions {
  /** When true, apply WebGPU-specific geometry fixes (e.g., Uint16 index conversion). Default: false */
  isWebGPU?: boolean;
}

/** Pending component awaiting resolveComponentRefs + init() in Step 2 */
interface PendingComponent {
  component: RVComponent;
  type: string;
  path: string;
}

// ═══════════════════════════════════════════════════════════════════
// Phase Functions — extracted from loadGLB() for readability
// ═══════════════════════════════════════════════════════════════════

/** Parsed GLTF data with the root scene node and parser metadata. */
interface PreparedGLTF {
  root: Object3D;
  gltfParser: {
    associations?: Map<Object3D, { nodes?: number }>;
    json?: { nodes?: { name?: string }[] };
  } | undefined;
}

/**
 * Load and parse a GLTF/GLB file, add root to scene.
 * Returns the root Object3D and parser metadata for renamed-node detection.
 */
export async function loadAndPrepareGLTF(url: string, scene: Scene): Promise<PreparedGLTF> {
  debug('loader', `Loading ${url}...`);
  resetParityValidator(); // Clear any previous load's parity data
  const gltf = await gltfLoader.loadAsync(url);
  debug('loader', `GLTF parsed, adding to scene`);
  const root = gltf.scene;
  scene.add(root);

  const gltfParser = (gltf as unknown as { parser?: PreparedGLTF['gltfParser'] }).parser;
  return { root, gltfParser };
}

/** Result of processMeshes — contains mesh stats and drive/transport node sets. */
export interface MeshProcessResult {
  triangleCount: number;
  driveNodeSet: Set<Object3D>;
  transportSurfaceNodeSet: Set<Object3D>;
}

/**
 * Pre-scan for Drive/TransportSurface nodes and classify meshes:
 * shadow casting, matrixAutoUpdate, triangle counting.
 *
 * CRITICAL: Returns driveNodeSet and transportSurfaceNodeSet — these MUST be
 * passed to subsequent functions so drive meshes are NOT incorrectly set to
 * matrixAutoUpdate = false.
 */
export function processMeshes(root: Object3D): MeshProcessResult {
  let triangleCount = 0;

  // Pre-scan: Drive/TransportSurface node sets for shadow classification
  // Collect drive node set for static/dynamic classification (Phase 1.3)
  // We need a two-step approach: first find all drives, then classify meshes

  // Pipeline nodes for tooltip hover
  const pipeNodes: Object3D[] = [];
  const tankNodes: Object3D[] = [];
  const pumpNodes: Object3D[] = [];
  const processingUnitNodes: Object3D[] = [];

  // Collect drive node set for static/dynamic classification (Phase 1.3)
  // We need a two-step approach: first find all drives, then classify meshes
  const driveNodeSet = new Set<Object3D>();
  const transportSurfaceNodeSet = new Set<Object3D>();

  root.traverse((node: Object3D) => {
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv) return;
    if (rv['Drive']) driveNodeSet.add(node);
    if (rv['TransportSurface']) transportSurfaceNodeSet.add(node);
  });

  function isUnderDrive(node: Object3D): boolean {
    let current: Object3D | null = node.parent;
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
      const mat = mesh.material as { transparent?: boolean; alphaTest?: number; opacity?: number; alphaMap?: unknown; map?: { format?: number } } | undefined;
      const hasAlpha = mat && (
        mat.transparent === true ||
        (mat.alphaTest ?? 0) > 0 ||
        mat.alphaMap != null ||
        (mat.opacity ?? 1) < 1
      );
      if (hasAlpha) {
        debug('loader', `No shadow: ${node.name} (transparent=${mat?.transparent}, alphaTest=${mat?.alphaTest}, opacity=${mat?.opacity})`);
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
        const underDrive = isUnderDrive(node);
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

  return { triangleCount, driveNodeSet, transportSurfaceNodeSet };
}

/** Result of registerSignals — renamed node map for alias registration. */
export interface SignalRegistrationResult {
  renamedNodes: Map<Object3D, string>;
}

/**
 * Detect Three.js name deduplication and build renamed-node map.
 * Does NOT register signals — that happens during the main traverse.
 */
export function detectRenamedNodes(gltfParser: PreparedGLTF['gltfParser']): Map<Object3D, string> {
  const renamedNodes = new Map<Object3D, string>();
  if (gltfParser?.associations && gltfParser?.json?.nodes) {
    for (const [obj, ref] of gltfParser.associations) {
      if (ref.nodes !== undefined && ref.nodes < gltfParser.json.nodes.length) {
        const origName = gltfParser.json.nodes[ref.nodes].name ?? '';
        // Three.js sanitizes spaces → underscores before dedup
        const sanitized = origName.replace(/\s/g, '_');
        if (sanitized && obj.name !== sanitized) {
          renamedNodes.set(obj, sanitized);
        }
      }
    }
    if (renamedNodes.size > 0) {
      debug('loader', `${renamedNodes.size} node(s) renamed by Three.js (name dedup)`);
    }
  }
  return renamedNodes;
}

/** Kinematic node data collected during traversal. */
export interface KinematicNodeEntry {
  node: Object3D;
  data: Record<string, unknown>;
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
  metadataNodes: Object3D[];
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

  // Metadata nodes for tooltip hover
  const metadataNodes: Object3D[] = [];

  root.traverse((node: Object3D) => {
    // Register ALL nodes in registry (Phase 1)
    const path = NodeRegistry.computeNodePath(node);
    registry.registerNode(path, node);

    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv) return;

    // PLC Signals (registered first, before components that reference them)
    for (const sigType of SIGNAL_TYPES) {
      if (rv[sigType]) {
        const sigData = rv[sigType] as Record<string, unknown>;
        validateExtras(sigType, sigData);
        const status = sigData['Status'] as { Value?: boolean | number } | undefined;
        const signalName = (sigData['Name'] as string) || renamedNodes.get(node) || node.name;
        if (sigType.includes('Bool')) {
          signalStore.register(signalName, path, status?.Value as boolean ?? false);
        } else if (sigType.includes('Float')) {
          signalStore.register(signalName, path, status?.Value as number ?? 0);
        } else if (sigType.includes('Int')) {
          signalStore.register(signalName, path, status?.Value as number ?? 0);
        }
        registry.register(sigType, path, { address: path, signalName });
      }
    }

    // Drive (special case: inline construction, behaviors, initDrive)
    if (rv['Drive']) {
      const driveData = rv['Drive'] as Record<string, unknown>;
      validateExtras('Drive', driveData);

      const dirStr = driveData['Direction'] as string | undefined;
      if (dirStr) {
        const drive = new RVDrive(node);
        applySchema(drive as unknown as Record<string, unknown>, RVDrive.schema, driveData);

        // Collect DriveBehaviours
        const behaviors: string[] = [];
        const behaviorExtras: Record<string, Record<string, unknown>> = {};
        for (const key of Object.keys(rv)) {
          if (key !== 'Drive' && key.startsWith('Drive_')) {
            behaviors.push(key);
            const bExtras = rv[key] as Record<string, unknown>;
            behaviorExtras[key] = bExtras;
            validateExtras(key, bExtras);
          }
        }
        drive.Behaviors = behaviors;
        drive.BehaviorExtras = behaviorExtras;
        drive.initDrive();

        drives.push(drive);
        registry.register('Drive', path, drive);
        node.userData._rvType = 'Drive';

        // Instantiate recognized drive behaviors via data-driven map
        for (const bName of behaviors) {
          const entry = DRIVE_BEHAVIOR_MAP[bName];
          if (entry) {
            const inst = new entry.ctor(node);
            applySchema(inst as unknown as Record<string, unknown>, entry.schema, behaviorExtras[bName] ?? {});
            pending.push({ component: inst, type: bName, path });
          }
        }

        debug('loader',
          `Drive: ${node.name} [${drive.Direction}${drive.ReverseDirection ? ' REV' : ''}]` +
          ` path="${path}"` +
          (drive.UseLimits ? ` limits=[${drive.LowerLimit}, ${drive.UpperLimit}]` : '') +
          ` speed=${drive.TargetSpeed}` +
          (behaviors.length > 0 ? ` behaviors=[${behaviors.join(',')}]` : '')
        );
      }
    }

    // Auto-discovered components (via registered factories)
    for (const [type, factory] of getRegisteredFactories()) {
      if (!rv[type]) continue;
      const data = rv[type] as Record<string, unknown>;
      validateExtras(type, data);
      const aabb = factory.needsAABB ? createAABBFromExtras(node, rv) : null;
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
    // Collect Pipeline nodes (Pipe, ResourceTank, Pump, ProcessingUnit)
    if (rv['Pipe']) {
      validateExtras('Pipe', rv['Pipe'] as Record<string, unknown>);
      node.userData._rvType = 'Pipe';
      const pd = rv['Pipe'] as Record<string, unknown>;
      const sourceRef = pd['source'] as { path?: string } | undefined;
      const destRef = pd['destination'] as { path?: string } | undefined;
      node.userData._rvPipe = {
        resourceName: pd['resourceName'] as string ?? '',
        flowRate: pd['flowRate'] as number ?? 0,
        sourcePath: sourceRef?.path ?? null,
        destinationPath: destRef?.path ?? null,
        uvDirection: pd['uvDirection'] as number ?? 1,
      };
      pipeNodes.push(node);
      registry.register('Pipe', path, node);
    }
    if (rv['ResourceTank']) {
      validateExtras('ResourceTank', rv['ResourceTank'] as Record<string, unknown>);
      const td = rv['ResourceTank'] as Record<string, unknown>;
      node.userData._rvType = 'Tank';
      node.userData._rvTank = {
        resourceName: td['resourceName'] as string ?? '',
        capacity: td['capacity'] as number ?? 0,
        amount: td['amount'] as number ?? 0,
        pressure: td['pressure'] as number ?? 0,
        temperature: td['temperature'] as number ?? 0,
      };
      tankNodes.push(node);
      registry.register('Tank', path, node);
    }
    if (rv['Pump']) {
      validateExtras('Pump', rv['Pump'] as Record<string, unknown>);
      node.userData._rvType = 'Pump';
      const pumpData = rv['Pump'] as Record<string, unknown>;
      const pipeRef = pumpData['pipe'] as { path?: string } | undefined;
      node.userData._rvPump = {
        flowRate: pumpData['flowRate'] as number ?? 0,
        pipePath: pipeRef?.path ?? null,
      };
      pumpNodes.push(node);
      registry.register('Pump', path, node);
    }
    if (rv['ProcessingUnit']) {
      validateExtras('ProcessingUnit', rv['ProcessingUnit'] as Record<string, unknown>);
      node.userData._rvType = 'ProcessingUnit';
      const puData = rv['ProcessingUnit'] as Record<string, unknown>;
      const connRefs = puData['connections'] as Array<{ path?: string }> | undefined;
      node.userData._rvProcessingUnit = {
        connectionPaths: connRefs?.map(r => r?.path ?? null).filter(Boolean) ?? [],
      };
      processingUnitNodes.push(node);
      registry.register('ProcessingUnit', path, node);
    }

    // RuntimeMetadata — tooltip content for interactive objects.
    // Can coexist with Drive/Pipe/Tank/etc. — only sets _rvType if no other type is present.
    if (rv['RuntimeMetadata']) {
      const md = rv['RuntimeMetadata'] as Record<string, unknown>;
      validateExtras('RuntimeMetadata', md);
      node.userData._rvMetadata = { content: (md['content'] as string) ?? '' };
      if (!node.userData._rvType) {
        // Standalone metadata node — set type and register for raycast
        node.userData._rvType = 'Metadata';
        metadataNodes.push(node);
      }
      registry.register('Metadata', path, node);
    }

    // AASLink — Asset Administration Shell link.
    // Can coexist with Drive/Pipe/etc. — only sets _rvType if no other type is present.
    if (rv['AASLink']) {
      const aas = rv['AASLink'] as Record<string, unknown>;
      validateExtras('AASLink', aas);
      node.userData._rvAasLink = {
        aasId: (aas['AASId'] as string) ?? '',
        description: (aas['Description'] as string) ?? '',
        serverUrl: (aas['ServerUrl'] as string) ?? '',
      };
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
    metadataNodes,
  };
}

/**
 * Register alias paths for nodes renamed by Three.js dedup.
 * Must happen AFTER Step 1 (signals registered) and BEFORE Step 2 (refs resolved).
 */
export function registerNodeAliases(
  renamedNodes: Map<Object3D, string>,
  registry: NodeRegistry,
  signalStore: SignalStore,
): void {
  if (renamedNodes.size === 0) return;

  const computeOriginalPath = (node: Object3D): string => {
    const parts: string[] = [];
    let current: Object3D | null = node;
    while (current && current.parent) {
      parts.unshift(renamedNodes.get(current) ?? current.name);
      current = current.parent;
      if (!current.parent) break;
    }
    return parts.join('/');
  };

  for (const [obj, origName] of renamedNodes) {
    const origPath = computeOriginalPath(obj);
    const currentPath = NodeRegistry.computeNodePath(obj);
    if (origPath !== currentPath) {
      registry.registerAlias(origPath, obj);
      // Also register signal path alias if this node has a signal
      const sigName = signalStore.nameForPath(currentPath);
      if (sigName !== undefined) {
        signalStore.register(sigName, origPath, signalStore.get(sigName) ?? false);
        debug('loader', `Signal alias: "${origPath}" → signal "${sigName}" (renamed "${origName}" → "${obj.name}")`);
      }
      debug('loader', `Node alias: "${origPath}" → "${currentPath}" (renamed "${origName}" → "${obj.name}")`);
    }
  }
}

/**
 * STEP 2 "Start": resolve component refs and call init() on all pending components.
 */
export function initializeComponents(
  pending: PendingComponent[],
  registry: NodeRegistry,
  signalStore: SignalStore,
  scene: Scene,
  transportManager: RVTransportManager,
  root: Object3D,
): void {
  const context: ComponentContext = { registry, signalStore, scene, transportManager, root };
  for (const { component } of pending) {
    resolveComponentRefs(component as unknown as Record<string, unknown>, registry);
    component.init(context);
  }
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
 */
export function applyKinematicParenting(
  kinematicNodes: KinematicNodeEntry[],
  groups: GroupRegistry | null,
  registry: NodeRegistry,
  root: Object3D,
): { groupNames: string[]; affectedSubtrees: Object3D[] } {
  if (kinematicNodes.length === 0) return { groupNames: [], affectedSubtrees: [] };

  const kinematicGroupNames: string[] = [];
  const affectedSubtrees: Object3D[] = [];

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

    for (const groupNode of nodesToReparent) {
      kinNode.attach(groupNode);
    }

    kinematicGroupNames.push(resolvedName);
    affectedSubtrees.push(kinNode);
    debug('loader',
      `[Kinematic] ${kinNode.name}: attached ${nodesToReparent.length} node(s) from group "${resolvedName}"` +
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

    parentNode.attach(kinNode);
    affectedSubtrees.push(kinNode);
    debug('loader', `[Kinematic] ${kinNode.name}: re-parented under "${parentNode.name}"`);
  }

  // Pass 3: Fix matrixAutoUpdate and Drive base transforms on affected subtrees
  if (affectedSubtrees.length > 0) {
    for (const subtreeRoot of affectedSubtrees) {
      subtreeRoot.traverse((child: Object3D) => {
        // Re-enable matrixAutoUpdate (Phase 2 may have set it to false on static meshes)
        child.matrixAutoUpdate = true;
        // Refresh Drive base transforms
        const childPath = registry.getPathForNode(child);
        if (childPath) {
          const components = registry.getComponentsAt(childPath);
          for (const [type, instance] of components) {
            if (type === 'Drive') {
              (instance as RVDrive).refreshBaseTransform();
            }
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

/**
 * Compute BVH for fast raycasting on all meshes.
 */
export async function computeBVH(root: Object3D): Promise<void> {
  // Compute BVH (Bounding Volume Hierarchy) for fast raycasting
  try {
    const { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } = await import('three-mesh-bvh');
    BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
    BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
    Mesh.prototype.raycast = acceleratedRaycast;
    let bvhCount = 0;
    root.traverse((node: Object3D) => {
      if ((node as Mesh).isMesh && (node as Mesh).geometry) {
        // Skip meshes that explicitly opt out (e.g. the static-uber merged
        // mesh — it has `raycast = () => {}` so the BVH would never be queried).
        if (node.userData?._rvSkipBVH) return;
        (node as Mesh).geometry.computeBoundsTree();
        bvhCount++;
      }
    });
    debug('loader', `BVH computed for ${bvhCount} meshes`);
  } catch (e) {
    console.warn('[loadGLB] BVH computation failed (three-mesh-bvh):', e);
  }
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
  // Phase 1: Load and parse GLTF
  const { root, gltfParser } = await loadAndPrepareGLTF(url, scene);

  // Phase 2: Process meshes (shadow classification, triangle counting, drive/transport node sets)
  const { triangleCount, driveNodeSet, transportSurfaceNodeSet } = processMeshes(root);

  // Phase 3: Detect renamed nodes (Three.js dedup)
  const renamedNodes = detectRenamedNodes(gltfParser);

  // Phase 4: Initialize core systems
  const registry = new NodeRegistry();
  const signalStore = new SignalStore();
  const manager = new RVTransportManager();
  manager.scene = scene;

  // Phase 5: Main traversal — register nodes, signals, drives, components
  const traverseResult = traverseAndRegister(root, registry, signalStore, renamedNodes);

  // Phase 6: Register node aliases for renamed nodes
  registerNodeAliases(renamedNodes, registry, signalStore);

  // Phase 7: Initialize components (Step 2 "Start")
  initializeComponents(traverseResult.pending, registry, signalStore, scene, manager, root);

  // Phase 8: Build groups
  const groups = buildGroups(traverseResult.groupNodes, registry);

  // Phase 8b: Apply Kinematic re-parenting (after groups, before bounding box)
  const kinResult = applyKinematicParenting(
    traverseResult.kinematicNodes, groups, registry, root,
  );
  const kinematicGroupNames = kinResult.groupNames;
  // Mark kinematic groups in registry and auto-exclude from overlay
  if (groups && kinematicGroupNames.length > 0) {
    for (const name of kinematicGroupNames) {
      groups.markAsKinematic(name);
    }
  }

  // Phase 8c: Recompute registry paths for re-parented subtrees + signal paths
  if (kinResult.affectedSubtrees.length > 0) {
    const { count, remap } = registry.recomputePathsForSubtrees(kinResult.affectedSubtrees);
    if (remap.size > 0) {
      signalStore.remapPaths(remap);
    }
    debug('loader', `[Kinematic] Recomputed ${count} registry paths, ${remap.size} signal paths after re-parenting`);
  }

  // Phase 9: WebGPU compatibility fixes
  applyWebGPUFixes(root, options?.isWebGPU ?? false);

  // Phase 10: Material deduplication (must run before static merge)
  const dedupResult = deduplicateMaterials(root);

  // Phase 10b: Uber-material pass — collapse every untextured
  // MeshStandardMaterial onto a single shared reference with per-vertex
  // color + rmPacked attributes. Depends on Phase 10 having already
  // collapsed identical references. Mutates dedupResult.uniqueMaterials
  // (removes collapsed materials, adds the shared uber singleton).
  const uberResult = applyUberMaterial(root, dedupResult.uniqueMaterials);
  // Keep reported uniqueCount in sync with the post-uber state so the
  // DevTools panel and getRendererStats() reflect what's actually on the GPU.
  dedupResult.uniqueCount = dedupResult.uniqueMaterials.size;

  // Phase 10c: Static batching fast path — merge every static uber-baked
  // mesh into a single draw call. Only runs when the uber pass actually
  // baked something (otherwise there's nothing to merge).
  const uberMergeResult: StaticUberMergeResult = uberResult.sharedMaterial
    ? mergeStaticUberMeshes(root, uberResult.sharedMaterial)
    : { originalCount: 0, mergedCount: 0, totalVertices: 0 };

  // Phase 10d: Kinematic group merge — merge dynamic uber-baked meshes
  // per Drive subtree. Runs after static merge (which only handles
  // matrixAutoUpdate=false meshes). Processes bottom-up so nested Drive
  // chains are handled correctly.
  const kinematicMergeResult: KinematicMergeResult | null = uberResult.sharedMaterial
    ? mergeKinematicGroupMeshes(
        root,
        traverseResult.drives,
        driveNodeSet,
        uberResult.sharedMaterial,
      )
    : null;

  // Phase 11: General-purpose static geometry merge — DISABLED (Phase 4
  // scope; the uber fast path above already handles the common case).
  const mergeResult = { originalCount: 0, mergedCount: 0 };

  // Phase 12: Bounding box (after merge — merged geometry changes bounds)
  const boundingBox = new Box3().setFromObject(root);

  // Phase 13: BVH for fast raycasting (per-mesh, still needed by annotation/FPV plugins)
  await computeBVH(root);

  // Phase 13b: Build grouped raycast geometries (static + per-Drive kinematic)
  const raycastGeometrySet = buildRaycastGeometries(
    root, traverseResult.drives, registry, driveNodeSet,
  );

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

  return {
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
    uberMergeResult,
    kinematicMergeResult,
    mergeResult,
    pipelineNodes,
    metadataNodes: traverseResult.metadataNodes,
    kinematicGroupNames,
    raycastGeometrySet,
  };
}

// ═══════════════════════════════════════════════════════════════════
// processExtras — Runtime extras processing for dynamically added GLBs
// ═══════════════════════════════════════════════════════════════════

export interface ProcessExtrasResult {
  drives: RVDrive[];
  signalsRegistered: number;
  componentsCreated: number;
}

/**
 * Process realvirtual extras on a subtree that was added at runtime.
 *
 * Reuses the same two-step model as loadGLB() but operates on EXISTING
 * runtime systems (NodeRegistry, SignalStore, TransportManager) instead
 * of creating new ones. Designed for Layout Planner placed objects.
 *
 * Skips: recordings, BVH, WebGPU fixes, shadow classification, groups,
 *        triangle counting, parity validation, renamed-node alias detection.
 */
export function processExtras(
  root: Object3D,
  registry: NodeRegistry,
  signalStore: SignalStore,
  transportManager: RVTransportManager,
  scene: Scene,
): ProcessExtrasResult {
  const drives: RVDrive[] = [];
  const pending: PendingComponent[] = [];
  let signalsRegistered = 0;

  // ── STEP 1 "Awake": Traverse, construct, applySchema, register ──
  root.traverse((node: Object3D) => {
    // Register node in registry
    const path = NodeRegistry.computeNodePath(node);
    registry.registerNode(path, node);

    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv) return;

    // ── PLC Signals ──
    for (const sigType of SIGNAL_TYPES) {
      if (rv[sigType]) {
        const sigData = rv[sigType] as Record<string, unknown>;
        const status = sigData['Status'] as { Value?: boolean | number } | undefined;
        const signalName = (sigData['Name'] as string) || node.name;
        if (sigType.includes('Bool')) {
          signalStore.register(signalName, path, status?.Value as boolean ?? false);
        } else if (sigType.includes('Float') || sigType.includes('Int')) {
          signalStore.register(signalName, path, status?.Value as number ?? 0);
        }
        registry.register(sigType, path, { address: path, signalName });
        signalsRegistered++;
      }
    }

    // ── Drive ──
    if (rv['Drive']) {
      const driveData = rv['Drive'] as Record<string, unknown>;
      const dirStr = driveData['Direction'] as string | undefined;
      if (dirStr) {
        const drive = new RVDrive(node);
        applySchema(drive as unknown as Record<string, unknown>, RVDrive.schema, driveData);

        const behaviors: string[] = [];
        const behaviorExtras: Record<string, Record<string, unknown>> = {};
        for (const key of Object.keys(rv)) {
          if (key !== 'Drive' && key.startsWith('Drive_')) {
            behaviors.push(key);
            behaviorExtras[key] = rv[key] as Record<string, unknown>;
          }
        }
        drive.Behaviors = behaviors;
        drive.BehaviorExtras = behaviorExtras;
        drive.initDrive();

        drives.push(drive);
        registry.register('Drive', path, drive);
        node.userData._rvType = 'Drive';

        for (const bName of behaviors) {
          const entry = DRIVE_BEHAVIOR_MAP[bName];
          if (entry) {
            const inst = new entry.ctor(node);
            applySchema(inst as unknown as Record<string, unknown>, entry.schema, behaviorExtras[bName] ?? {});
            pending.push({ component: inst, type: bName, path });
          }
        }
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
  });

  // ── STEP 2 "Start": resolveComponentRefs + init() ──
  const context: ComponentContext = { registry, signalStore, scene, transportManager, root };
  for (const { component } of pending) {
    resolveComponentRefs(component as unknown as Record<string, unknown>, registry);
    component.init(context);
  }

  // Rebuild signal index for O(1) lookup of newly added signals
  signalStore.buildIndex();

  return { drives, signalsRegistered, componentsCreated: pending.length };
}

