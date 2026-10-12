// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * parity-harness — plan-757 Phase 0.
 *
 * The same GLB bytes go through the two runtime pipelines and come back as
 * comparable pictures:
 *
 *   loadAsMainModel(host, bytes)        viewer.loadModel(data) → loadGLB
 *                                       (prepare hooks, survival, dedup+uber,
 *                                       destructive bake, instantiateTemplate,
 *                                       initSubtree, freeze)
 *   loadAsSinglePlacement(host, bytes)  an EMPTY layout document with ONE
 *                                       AssetReference + PlacementMeta at the
 *                                       origin → the viewer's real
 *                                       `PlacementInstancer` + `ModelCache`
 *                                       (`_decode`, `_bake`, `materialize`,
 *                                       `integratePlacedContent`)
 *
 * Both join on `whenSceneReady()` (the scene-ready contract, plan-753) AND on
 * the WebComponentPlugin's `whenWired()`: script wiring is asynchronous (the
 * QuickJS host loads lazily on the first scripted model), so `webComponents.wired`
 * and the `<node>.Error` signals only exist once that promise has settled —
 * joined, never slept for.
 *
 * `snapshot()` is STRUCTURE, `snapshotAfter(n)` is BEHAVIOUR after n fixed
 * steps through `RVViewer._tickOnce` (the production `fixedUpdate` path), and
 * `pickAt()` is one ray in asset space. Every key is ASSET-RELATIVE (root = ''),
 * chunk keys carry a material signature instead of `tex:<uuid>`, and the
 * children of the instance root are reported in the asset frame (the
 * placement pivot is subtracted and reported ONCE, see `rootChildren`).
 *
 * The harness never decides what is allowed to differ — `diffSnapshots` tags
 * the diffs, `tests/parity-allow-list.ts` says which tags are declared.
 */
import { Group, Object3D, Vector3, type Material, type Mesh, type Quaternion } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RVViewer } from '../../src/core/rv-viewer';
import type { RVViewerPlugin } from '../../src/core/rv-plugin';
import { objectToGlb, sceneMirroringLoad } from '../../src/core/import/rv-import-object';
import { ModelCache } from '../../src/core/engine/rv-model-cache';
import { gltfLoader } from '../../src/core/engine/rv-glb-parse';
import { createPickBuildPort } from '../../src/core/engine/rv-pick-build-port';
import { setAssetReference, setPlacementMeta } from '../../src/core/engine/rv-asset-reference';
import { setNodeId } from '../../src/core/engine/rv-node-id';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { SNAP_NAME } from '../../src/core/engine/rv-bake-pipeline';
import { RV_DRIVE_HOME_KEY, RV_SENSOR_BEAM_KEY } from '../../src/core/engine/rv-pre-bake-keys';
import { RV_BAKE_CHUNK_KEY, type PlacementInstance } from '../../src/core/engine/rv-bake-registry';
import { RV_PARTITION_KEY, type BakedAsset } from '../../src/core/engine/rv-bake-chunk';
import { RVUberMaterial, applyUberMaterial } from '../../src/core/engine/rv-uber-material';
import { deduplicateMaterials } from '../../src/core/engine/rv-material-dedup';
import type { RVDrive } from '../../src/core/engine/rv-drive';
import type { RVSensor } from '../../src/core/engine/rv-sensor';
import type { RVTransportSurface } from '../../src/core/engine/rv-transport-surface';
import {
  RVDriveTo, RVLogicStep, RVParallelContainer, RVSerialContainer, StepState,
} from '../../src/core/engine/rv-logic-step';
import { createTestViewer, type TestViewerHandle } from './create-test-viewer';
import { WebComponentPlugin } from '../../src/plugins/web-component-plugin';
import { bakeTree } from '../fixtures/bake-fixture';

// ─── Types ──────────────────────────────────────────────────────────────

export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];
export type LoadKind = 'main' | 'placement';

export interface ParityHost {
  viewer: RVViewer;
  handle: TestViewerHandle;
  /** Plugin `bakeClaims()` for the NEXT load (D5: the loader asks, the cache never does). */
  setClaims(claims: ReadonlyArray<{ path: string; role: 'merge' | 'chunk' }>): void;
  dispose(): void;
}

export interface LoadedAsset {
  kind: LoadKind;
  viewer: RVViewer;
  /** The asset root in the scene: the template root (main) or the placement root. */
  assetRoot: Object3D;
  /** Registry path of `assetRoot` (`Arburg` / `Layout/Arburg_1`). */
  rootPath: string;
  instance: PlacementInstance | null;
  baked: BakedAsset | null;
  /** Shift `materialize()`'s `pivotToFloorCenter` applied to the root's children (asset → instance frame). */
  pivotOffset: Vec3;
  /** Whether every direct child of the root carries the SAME shift. */
  pivotUniform: boolean;
  /** Asset-relative paths the host's claim plugin asked the loader to keep. */
  claimedPaths: ReadonlySet<string>;
  release(): void;
}

export interface NodeInfo {
  parent: string | null;
  position: Vec3;
  quaternion: Vec4;
  scale: Vec3;
  visible: boolean;
  matrixAutoUpdate: boolean;
  matrixWorldAutoUpdate: boolean;
  isMesh: boolean;
  registered: boolean;
  components: string[];
  extras: string[];
  partition: string[] | null;
  synthetic: boolean;
}

export interface MoverInfo {
  owner: string;
  partition: string;
  material: string;
  triangles: number;
  parent: string | null;
}

export interface ParitySnapshot {
  root: { name: string };
  rootChildren: { pivotOffset: Vec3; names: string[] };
  nodes: Record<string, NodeInfo>;
  aliases: string[];
  /**
   * The root is left out of the matrix counts: its flags are the PLACEMENT's
   * (a placement root is moved by the planner, a main-model root is static) —
   * the address of the asset, not its content. `matrixWorldAutoUpdate` is not
   * counted at all: it is the ONE declared per-node asymmetry
   * (`placement-world-matrix-live`) and reported per node instead.
   */
  counts: {
    nodes: number;
    matrixAutoUpdateTrue: number;
    matrixAutoUpdateFalse: number;
    chunkMeshes: number;
    keepMeshes: number;
  };
  driveHome: Record<string, { stamp: { p: Vec3; q: Vec4 } | null; base: Vec3; baseQ: Vec4 }>;
  movers: Record<string, MoverInfo>;
  groups: Record<string, string[]>;
  sensors: Record<string, {
    UseRaycast: boolean; AutoRay: boolean; direction: Vec3; lengthMm: number; originOffset: Vec3; halfSize: Vec3;
    beamStamp: { originOffset: Vec3; direction: Vec3; lengthMm: number } | null;
  }>;
  transports: Record<string, { direction: Vec3; halfSize: Vec3; drive: string | null; speed: number }>;
  snapPorts: string[];
  webComponents: { authored: number; wired: number };
  logic: Record<string, { type: string; childCount: number; driveTarget?: string | null }>;
  signals: Record<string, { name: string; type: string | undefined; value: boolean | number | undefined }>;
  gated: { logicGated: boolean; deferredPaths: string[] };
  /** Non-comparable bookkeeping the differ reads for tagging (`frozenWorldNodes`: informational, see `counts`). */
  meta: { kind: LoadKind; claimedPaths: string[]; pivotUniform: boolean; frozenWorldNodes: number };
}

export interface BehaviourSnapshot {
  drives: Record<string, number>;
  driveNodes: Record<string, Vec3>;
  steps: Record<string, { state: StepState; currentIndex?: number; completedCycles?: number }>;
  signals: Record<string, boolean | number | undefined>;
}

export interface ParityDiff {
  dimension: keyof Omit<ParitySnapshot, 'meta'> | 'behaviour';
  key: string;
  main: unknown;
  placement: unknown;
  tags: string[];
}

// ─── Host ───────────────────────────────────────────────────────────────

let seq = 0;

/** Pause reason the host holds for its whole life (see `createParityHost`). */
export const PARITY_PAUSE_REASON = 'parity-harness';

/**
 * Extras keys that ARE the placement (its address in the document), never asset
 * content: the reference node carries them, the file's root cannot. Stripped from
 * the root node's `extras` so the two roots compare as the same asset.
 */
const PLACEMENT_MARKER_KEYS: ReadonlySet<string> = new Set(['AssetReference', 'PlacementMeta', 'NodeId', 'LayoutObject', 'AssetOverrides']);

/** A real `RVViewer` (WebGL, headless) with the placement cache on the inline pick port. */
export async function createParityHost(): Promise<ParityHost> {
  const handle = await createTestViewer('webgl');
  const viewer = handle.viewer;
  let claims: Array<{ path: string; role: 'merge' | 'chunk' }> = [];
  const claimPlugin: RVViewerPlugin = {
    id: 'parity-claims',
    bakeClaims: () => claims.map((c) => ({ ...c })),
  };
  viewer.use(claimPlugin);
  // plan-757 §2.8: the `webComponents` dimension compares `authored` vs
  // `wired` — blind without the plugin (main.ts installs it; the test viewer
  // does not). Scripts allowed: the SAME session-wide rule on both paths.
  viewer.use(new WebComponentPlugin({ allowScripts: true }));
  // The viewer's own SimulationLoop ticks between every `await` of a load;
  // `snapshotAfter()` must be the ONLY thing that advances time. `_tickOnce`
  // bypasses the loop, so a paused runtime still steps deterministically.
  viewer.setSimulationPaused(PARITY_PAUSE_REASON, true);
  // The REAL engine loader; a `blob:` reference url passes straight through
  // the cache to it (rv-model-cache.ts `_decode`). Inline pick port: the bake
  // AWAITS its pick structures, and a test must not depend on worker slots.
  viewer.placements.setModelCache(new ModelCache(gltfLoader as unknown as GLTFLoader, {
    uber: () => viewer.placementUberMaterial,
    isWebGPU: () => viewer.isWebGPU,
    pickPort: () => createPickBuildPort({ createWorker: () => null }),
  }));
  return {
    viewer,
    handle,
    setClaims(next) { claims = next.map((c) => ({ ...c })); },
    dispose() { handle.dispose(); },
  };
}

/**
 * The second join of every load (see the header): `snapshot()` reads
 * `webComponents.wired` from the plugin's instances and the `<node>.Error`
 * signals from the store, and both only exist once the plugin's asynchronous
 * wiring has settled. Its own promise, not a sleep — a load without scripts
 * resolves immediately.
 */
async function whenWebComponentsWired(viewer: RVViewer): Promise<void> {
  await viewer.getPlugin<WebComponentPlugin>('web-component')?.whenWired();
}

/** GLB bytes of a fixture tree — the root becomes the file's scene (plan-752 F4). */
export async function fixtureBytes(root: Group): Promise<ArrayBuffer> {
  return objectToGlb(sceneMirroringLoad(root));
}

// ─── The two loads ──────────────────────────────────────────────────────

export interface LoadOptions {
  /** Claims for the loader (main model only, D5) — asset-root-inclusive paths
   *  as the pre-bake registry spells them (`Conveyor/Label`). */
  claims?: ReadonlyArray<{ path: string; role: 'merge' | 'chunk' }>;
}

function claimedRelPaths(claims: ReadonlyArray<{ path: string }> | undefined, rootName: string): Set<string> {
  const out = new Set<string>();
  for (const c of claims ?? []) {
    const p = c.path;
    out.add(p.startsWith(rootName + '/') ? p.slice(rootName.length + 1) : p);
  }
  return out;
}

/** Path 1 — the main document: `viewer.loadModel(url, { data })`. */
export async function loadAsMainModel(host: ParityHost, bytes: ArrayBuffer, opts?: LoadOptions): Promise<LoadedAsset> {
  const { viewer } = host;
  host.setClaims(opts?.claims ?? []);
  const result = await viewer.loadModel(`parity-main-${++seq}.glb`, { data: bytes.slice(0) });
  await viewer.whenSceneReady();
  await whenWebComponentsWired(viewer);
  const assetRoot = result.root;
  const rootPath = viewer.registry?.getPathForNode(assetRoot) ?? NodeRegistry.computeNodePath(assetRoot);
  const instance = result.bakeInstance ?? viewer.bakeRegistry.instanceOf(assetRoot);
  return {
    kind: 'main',
    viewer,
    assetRoot,
    rootPath,
    instance,
    baked: result.bakedAsset ?? instance?.baked ?? null,
    pivotOffset: [0, 0, 0],
    pivotUniform: true,
    claimedPaths: claimedRelPaths(opts?.claims, assetRoot.name),
    release() { host.setClaims([]); },
  };
}

export interface PlacementOptions extends LoadOptions {
  /** Name of the reference node in the layout document. Default `<rootName>_1`
   *  — a planner placement gets a unique name, never the asset's. */
  placedName?: string;
  /** Rewrite the layout DOCUMENT's bytes before the load (e.g. stamp a signature — the trust-gate tests). */
  documentBytes?: (bytes: ArrayBuffer) => ArrayBuffer | Promise<ArrayBuffer>;
}

/**
 * Path 2 — one placement: an empty layout document whose single node is an
 * `AssetReference` (+ `PlacementMeta`) to a `blob:` url of `bytes`, at the
 * origin. The viewer defers it (`deferPlacements`), `PlacementInstancer`
 * decodes + bakes it through the host's `ModelCache` and `registerMaterializedPlacement`
 * brings it to life. Joined on `whenSceneReady()`.
 */
export async function loadAsSinglePlacement(
  host: ParityHost,
  bytes: ArrayBuffer,
  rootName: string,
  opts?: PlacementOptions,
): Promise<LoadedAsset> {
  const [one] = await loadAsPlacements(host, bytes, rootName, 1, opts);
  return one;
}

/**
 * Path 2, N times: one layout document with `count` reference nodes to the
 * SAME asset (`<rootName>_1 … <rootName>_N`, spaced 5 m along X), all sharing
 * one `BakedAsset`. The ambiguous-suffix case of plan-757 F7: every instance
 * carries the same authored paths, and a root-prefixed reference (`Arburg/Kine`)
 * must bind inside ITS instance. Returned in placement order.
 */
export async function loadAsPlacements(
  host: ParityHost,
  bytes: ArrayBuffer,
  rootName: string,
  count: number,
  opts?: PlacementOptions,
): Promise<LoadedAsset[]> {
  const { viewer } = host;
  host.setClaims(opts?.claims ?? []);
  const n = ++seq;
  const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'model/gltf-binary' }));
  const layout = new Group();
  layout.name = 'Layout';
  const refNames: string[] = [];
  for (let i = 1; i <= count; i++) {
    const ref = new Object3D();
    ref.name = count === 1 && opts?.placedName ? opts.placedName : `${rootName}_${i}`;
    ref.position.set((i - 1) * 5, 0, 0);
    setNodeId(ref, `nid-parity-${n}-${i}`);
    setAssetReference(ref, { assetId: `cat:parity-${n}`, path: blobUrl });
    setPlacementMeta(ref, {});
    layout.add(ref);
    refNames.push(ref.name);
  }
  let docBytes = await objectToGlb(sceneMirroringLoad(layout));
  if (opts?.documentBytes) docBytes = await opts.documentBytes(docBytes);

  let placedRoots: Object3D[] = [];
  const off = viewer.on('layout-content-added', (data: unknown) => {
    const root = (data as { root?: Object3D } | undefined)?.root;
    if (root && !placedRoots.includes(root)) placedRoots.push(root);
  });
  try {
    const result = await viewer.loadModel(`parity-layout-${n}.glb`, { data: docBytes });
    await viewer.whenSceneReady();
    await whenWebComponentsWired(viewer);
    // plan-757 Phase 2 (spike S2): a reference INSIDE a placed asset is a
    // placement too and announces itself the same way — only the document's
    // own reference nodes (direct children of the layout root) are counted here.
    placedRoots = placedRoots.filter((r) => r.parent === result.root);
  } finally {
    off();
  }
  if (placedRoots.length !== count) {
    URL.revokeObjectURL(blobUrl);
    throw new Error(`[parity-harness] ${placedRoots.length} of ${count} placement(s) of "${rootName}" materialised (progress: ${JSON.stringify(viewer.placements.progress)})`);
  }
  // Document order, not materialisation order.
  placedRoots.sort((a, b) => refNames.indexOf(a.name) - refNames.indexOf(b.name));
  let released = 0;
  return placedRoots.map((assetRoot): LoadedAsset => {
    const instance = viewer.bakeRegistry.instanceOf(assetRoot);
    const rootPath = viewer.registry?.getPathForNode(assetRoot) ?? NodeRegistry.computeNodePath(assetRoot);
    const { offset, uniform } = measurePivot(instance);
    return {
      kind: 'placement',
      viewer,
      assetRoot,
      rootPath,
      instance,
      baked: instance?.baked ?? null,
      pivotOffset: offset,
      pivotUniform: uniform,
      claimedPaths: claimedRelPaths(opts?.claims, rootName),
      release() {
        // The blob url belongs to the document; the last release lets it go.
        if (++released === count) { URL.revokeObjectURL(blobUrl); host.setClaims([]); }
      },
    };
  });
}

/** The shift `pivotToFloorCenter` applied: instance child minus template child, per direct child. */
function measurePivot(instance: PlacementInstance | null): { offset: Vec3; uniform: boolean } {
  if (!instance) return { offset: [0, 0, 0], uniform: true };
  const master = instance.baked.template;
  let first: Vector3 | null = null;
  let uniform = true;
  for (const [template, node] of instance.nodeOf) {
    if (template === master || template.parent !== master) continue;
    const delta = node.position.clone().sub(template.position);
    if (!first) first = delta;
    else if (first.distanceTo(delta) > 1e-6) uniform = false;
  }
  const v = first ?? new Vector3();
  return { offset: r3(v), uniform };
}

// ─── Snapshot helpers ───────────────────────────────────────────────────

const R = 1e4;
const round = (x: number): number => Math.round(x * R) / R + 0; // +0 kills -0

export function r3(v: { x: number; y: number; z: number }): Vec3 {
  return [round(v.x), round(v.y), round(v.z)];
}
function r4(q: Quaternion): Vec4 {
  return [round(q.x), round(q.y), round(q.z), round(q.w)];
}

/** Asset-relative scene-graph path of `node` under `root` ('' for the root, null when outside). */
export function relPathOf(node: Object3D, root: Object3D): string | null {
  const parts: string[] = [];
  for (let cur: Object3D | null = node; cur; cur = cur.parent) {
    if (cur === root) return parts.join('/');
    parts.unshift(cur.name);
  }
  return null;
}

function relRegistryPath(path: string | null | undefined, rootPath: string): string | null {
  if (path === null || path === undefined) return null;
  if (path === rootPath) return '';
  if (path.startsWith(rootPath + '/')) return path.slice(rootPath.length + 1);
  return null;
}

function materialSig(m: Material | Material[] | undefined): string {
  if (!m) return 'none';
  if (Array.isArray(m)) return '[' + m.map((x) => materialSig(x)).join(',') + ']';
  if (m instanceof RVUberMaterial) return 'uber';
  const std = m as Material & { color?: { getHexString(): string }; map?: unknown };
  return `${m.type}:${std.color?.getHexString?.() ?? '-'}:${std.map ? 'tex' : 'notex'}:${m.transparent ? 't' : 'o'}`;
}

/** `tex:<uuid>` → `tex:<material signature>` (plan-757 R10). */
function normaliseChunkKey(key: string, material: Material): string {
  return key.replace(/tex:[0-9a-fA-F-]{36}/g, () => 'tex:' + materialSig(material));
}

const isChunkMesh = (o: Object3D): boolean => o.userData?.[RV_BAKE_CHUNK_KEY] === true;

function extrasKeys(o: Object3D): string[] {
  const rv = o.userData?.realvirtual as Record<string, unknown> | undefined;
  return rv && typeof rv === 'object' ? Object.keys(rv).sort() : [];
}

/** The `Drive` pre-bake hook's home stamp (plan-754 D18), rounded, or null. */
function driveHomeStampOf(o: Object3D): { p: Vec3; q: Vec4 } | null {
  const home = o.userData?.[RV_DRIVE_HOME_KEY] as { p?: number[]; q?: number[] } | undefined;
  return home && Array.isArray(home.p) && Array.isArray(home.q)
    ? { p: r3({ x: home.p[0], y: home.p[1], z: home.p[2] }), q: [round(home.q[0]), round(home.q[1]), round(home.q[2]), round(home.q[3])] }
    : null;
}

/** The `Sensor` pre-bake hook's beam stamp, rounded, or null. */
function sensorBeamStampOf(o: Object3D): { originOffset: Vec3; direction: Vec3; lengthMm: number } | null {
  const beam = o.userData?.[RV_SENSOR_BEAM_KEY] as { originOffset?: number[]; direction?: { x: number; y: number; z: number }; lengthMm?: number } | undefined;
  return beam && Array.isArray(beam.originOffset) && beam.direction
    ? { originOffset: r3({ x: beam.originOffset[0], y: beam.originOffset[1], z: beam.originOffset[2] }), direction: r3(beam.direction), lengthMm: round(beam.lengthMm ?? 0) }
    : null;
}

function isRootChild(node: Object3D, root: Object3D): boolean {
  return node.parent === root;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [round(a[0] - b[0]), round(a[1] - b[1]), round(a[2] - b[2])];
}

// ─── snapshot() — structure ─────────────────────────────────────────────

export function snapshot(loaded: LoadedAsset): ParitySnapshot {
  const { viewer, assetRoot, rootPath, instance, pivotOffset } = loaded;
  const registry = viewer.registry;
  const signalStore = viewer.signalStore;
  assetRoot.updateMatrixWorld(true);

  const nodes: Record<string, NodeInfo> = {};
  const rootChildNames: string[] = [];
  const snapPorts: string[] = [];
  let authoredWebComponents = 0;
  const counts = { nodes: 0, matrixAutoUpdateTrue: 0, matrixAutoUpdateFalse: 0, chunkMeshes: 0, keepMeshes: 0 };
  let frozenWorldNodes = 0;

  assetRoot.traverse((o) => {
    if (isChunkMesh(o)) { counts.chunkMeshes++; return; }
    const rel = relPathOf(o, assetRoot);
    if (rel === null) return;
    // A plugin-claimed node exists on one path only (D5); the declared asymmetry
    // is reported in `nodes`, so the derived counts leave it out. The root's own
    // flags are the placement's, not the asset's (see `counts`).
    if (!loaded.claimedPaths.has(rel)) {
      counts.nodes++;
      if (o !== assetRoot) {
        if (o.matrixAutoUpdate) counts.matrixAutoUpdateTrue++; else counts.matrixAutoUpdateFalse++;
        if (!o.matrixWorldAutoUpdate) frozenWorldNodes++;
      }
    }
    if (o !== assetRoot && SNAP_NAME.test(o.name)) snapPorts.push(rel);
    if (o !== assetRoot && isRootChild(o, assetRoot)) rootChildNames.push(o.name);
    // plan-757 Phase 2 (F5): `LayoutObject` is the RUNTIME stamp of a planner
    // record's root, never asset content — a document-level reference carries
    // it, the same node as a NESTED reference inside a placement does not
    // (content, `_layoutNestedOf`). Stripped on every node, like the placement
    // markers on the root.
    const ex = o === assetRoot ? extrasKeys(o).filter((k) => !PLACEMENT_MARKER_KEYS.has(k)) : extrasKeys(o).filter((k) => k !== 'LayoutObject');
    if (ex.includes('WebComponent')) authoredWebComponents++;
    const path = registry?.getPathForNode(o) ?? null;
    const partition = o.userData?.[RV_PARTITION_KEY] as string[] | undefined;
    const pos = o === assetRoot ? [0, 0, 0] as Vec3 : r3(o.position);
    nodes[rel] = {
      parent: o === assetRoot ? null : relPathOf(o.parent!, assetRoot),
      position: isRootChild(o, assetRoot) ? sub(pos, pivotOffset) : pos,
      quaternion: o === assetRoot ? [0, 0, 0, 1] : r4(o.quaternion),
      scale: o === assetRoot ? [1, 1, 1] : r3(o.scale),
      visible: o.visible,
      // The root's matrix flags belong to the placement (movable) / the load
      // (static main root) — reported as a constant so only the ASSET's nodes compare.
      matrixAutoUpdate: o === assetRoot ? true : o.matrixAutoUpdate,
      matrixWorldAutoUpdate: o === assetRoot ? true : o.matrixWorldAutoUpdate,
      isMesh: (o as Mesh).isMesh === true,
      registered: path !== null,
      components: path && registry ? [...registry.getComponentTypes(path)].sort() : [],
      extras: ex,
      partition: Array.isArray(partition) ? [...partition] : null,
      synthetic: o.userData?._rvSynthetic === true,
    };
  });

  // Aliases: registry paths that are not the node's canonical path.
  const aliases: string[] = [];
  registry?.forEachNode((path, node) => {
    if (registry.getPathForNode(node) === path) return;
    if (relPathOf(node, assetRoot) === null) return;
    aliases.push(relRegistryPath(path, rootPath) ?? '?' + path);
  });
  aliases.sort();

  // Components by type, under the root.
  const driveHome: ParitySnapshot['driveHome'] = {};
  const sensors: ParitySnapshot['sensors'] = {};
  const transports: ParitySnapshot['transports'] = {};
  registry?.forEachNode((path, node) => {
    if (registry.getPathForNode(node) !== path) return;
    const rel = relRegistryPath(path, rootPath);
    if (rel === null) return;
    for (const [type, inst] of registry.getComponentsAt(path)) {
      if (type === 'Drive') {
        const d = inst as RVDrive;
        const base = r3(d.getHomeLocalPosition());
        const stamp = driveHomeStampOf(node);
        driveHome[rel] = {
          // Root children are reported in the ASSET frame: the pivot shifted
          // both the node and — plan-757 §2.4 / R11 — its home stamp.
          stamp: stamp && isRootChild(node, assetRoot) ? { p: sub(stamp.p, pivotOffset), q: stamp.q } : stamp,
          base: isRootChild(node, assetRoot) ? sub(base, pivotOffset) : base,
          baseQ: r4(d.getHomeLocalQuaternion()),
        };
      } else if (type === 'Sensor') {
        const s = inst as RVSensor;
        // `rayOriginOffset` is private on purpose; the snapshot reads it as data.
        const originOffset = (s as unknown as { rayOriginOffset?: Vector3 }).rayOriginOffset;
        sensors[rel] = {
          UseRaycast: s.UseRaycast,
          AutoRay: s.AutoRay,
          direction: r3(s.RayCastDirection),
          lengthMm: round(s.RayCastLength),
          originOffset: originOffset ? r3(originOffset) : [0, 0, 0],
          halfSize: r3(s.aabb.halfSize),
          beamStamp: sensorBeamStampOf(node),
        };
      } else if (type === 'TransportSurface') {
        const t = inst as RVTransportSurface;
        transports[rel] = {
          direction: r3(t.rawLocalDir),
          halfSize: r3(t.aabb.halfSize),
          drive: t.drive ? relRegistryPath(registry.getPathForNode(t.drive.node), rootPath) : null,
          speed: round(t.speed),
        };
      }
    }
  });

  // Movers: one entry per chunk mesh of the instance, keyed by the normalised chunk key.
  const movers: Record<string, MoverInfo> = {};
  if (instance) {
    counts.keepMeshes = instance.keep.length;
    const seen = new Map<string, number>();
    for (const mesh of instance.chunks) {
      const chunk = instance.chunkOf.get(mesh);
      if (!chunk) continue;
      let key = normaliseChunkKey(chunk.key, chunk.material);
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      if (n > 1) key += `#${n}`;
      movers[key] = {
        owner: chunk.ownerPath ?? '',
        partition: chunk.partition,
        material: materialSig(chunk.material),
        triangles: chunk.triangles,
        parent: mesh.parent ? relPathOf(mesh.parent, assetRoot) : null,
      };
    }
  }

  // Groups: the viewer's registry, members under the root only.
  const groups: Record<string, string[]> = {};
  for (const g of viewer.groups?.getAll() ?? []) {
    const members = g.nodes.map((n) => relPathOf(n, assetRoot)).filter((p): p is string => p !== null).sort();
    if (members.length > 0) groups[g.name] = members;
  }

  // Logic: every engine root under the asset, walked recursively.
  const logic: ParitySnapshot['logic'] = {};
  const visitStep = (step: RVLogicStep): void => {
    const rel = relRegistryPath(step.hierarchyPath, rootPath);
    if (rel === null) return;
    const entry: ParitySnapshot['logic'][string] = { type: step.constructor.name, childCount: 0 };
    if (step instanceof RVSerialContainer || step instanceof RVParallelContainer) {
      entry.childCount = step.children.length;
      for (const c of step.children) visitStep(c);
    }
    if (step instanceof RVDriveTo) {
      entry.driveTarget = step.drive ? relRegistryPath(registry?.getPathForNode(step.drive.node), rootPath) ?? '<outside>' : null;
    }
    logic[rel] = entry;
  };
  for (const root of viewer.logicEngine?.roots ?? []) visitStep(root);

  // Signals under the root.
  const signals: ParitySnapshot['signals'] = {};
  if (signalStore) {
    for (const [path, name] of signalStore.getAllPaths()) {
      const rel = relRegistryPath(path, rootPath);
      if (rel === null) continue;
      signals[rel] = { name, type: signalStore.getType(name), value: signalStore.get(name) };
    }
  }

  // Script instances whose node sits under THIS asset root — the main model's
  // and a placement's are counted on the same viewer, never each other's.
  const scriptInstances = (viewer.getPlugin('web-component') as { instances?: Array<{ node: Object3D }> } | undefined)?.instances ?? [];
  let wired = 0;
  for (const inst of scriptInstances) {
    for (let cur: Object3D | null = inst.node; cur; cur = cur.parent) if (cur === assetRoot) { wired++; break; }
  }
  const lastLoad = viewer.lastLoadResult;
  const deferredPaths = loaded.kind === 'main' && lastLoad?.deferredLogic
    ? lastLoad.deferredLogic.pending.map((p) => relRegistryPath(registry?.getPathForNode(p.component.node), rootPath) ?? '?').sort()
    : [];

  return {
    root: { name: assetRoot.name },
    rootChildren: { pivotOffset: [...pivotOffset], names: rootChildNames.sort() },
    nodes,
    aliases,
    counts,
    driveHome,
    movers,
    groups,
    sensors,
    transports,
    snapPorts: snapPorts.sort(),
    webComponents: { authored: authoredWebComponents, wired },
    logic,
    signals,
    gated: { logicGated: loaded.kind === 'main' ? lastLoad?.logicGated ?? false : false, deferredPaths },
    meta: { kind: loaded.kind, claimedPaths: [...loaded.claimedPaths].sort(), pivotUniform: loaded.pivotUniform, frozenWorldNodes },
  };
}

// ─── snapshotAfter(n) — behaviour ───────────────────────────────────────

export const FIXED_DT = 1 / 60;

/** Step the production `fixedUpdate` path `n` times and read what moved. */
export function snapshotAfter(loaded: LoadedAsset, n: number, dt = FIXED_DT): BehaviourSnapshot {
  const { viewer, assetRoot, rootPath, pivotOffset } = loaded;
  for (let i = 0; i < n; i++) viewer._tickOnce(dt);
  assetRoot.updateMatrixWorld(true);
  const registry = viewer.registry;
  const drives: Record<string, number> = {};
  const driveNodes: Record<string, Vec3> = {};
  for (const d of viewer.drives) {
    const rel = relRegistryPath(registry?.getPathForNode(d.node), rootPath);
    if (rel === null) continue;
    drives[rel] = round(d.currentPosition);
    const pos = r3(d.node.position);
    driveNodes[rel] = isRootChild(d.node, assetRoot) ? sub(pos, pivotOffset) : pos;
  }
  const steps: BehaviourSnapshot['steps'] = {};
  const visit = (step: RVLogicStep): void => {
    const rel = relRegistryPath(step.hierarchyPath, rootPath);
    if (rel !== null) {
      const e: BehaviourSnapshot['steps'][string] = { state: step.state };
      if (step instanceof RVSerialContainer) { e.currentIndex = step.currentIndex; e.completedCycles = step.completedCycles; }
      steps[rel] = e;
    }
    if (step instanceof RVSerialContainer || step instanceof RVParallelContainer) for (const c of step.children) visit(c);
  };
  for (const root of viewer.logicEngine?.roots ?? []) visit(root);
  const signals: BehaviourSnapshot['signals'] = {};
  if (viewer.signalStore) {
    for (const [path, name] of viewer.signalStore.getAllPaths()) {
      const rel = relRegistryPath(path, rootPath);
      if (rel !== null) signals[rel] = viewer.signalStore.get(name);
    }
  }
  return { drives, driveNodes, steps, signals };
}

// ─── pickAt() — one ray in asset space ──────────────────────────────────

/**
 * Cast `ray` (asset frame: root at the origin, un-pivoted) and return the
 * asset-relative path the raycast manager resolves it to — `null` for no hit
 * or a blocked hit. The placement pivot is added to the origin, so the same
 * asset-space ray aims at the same triangles on both paths.
 */
export function pickAt(loaded: LoadedAsset, ray: { origin: Vec3; direction: Vec3 }): string | null {
  const rm = loaded.viewer.raycastManager;
  if (!rm) return null;
  loaded.assetRoot.updateMatrixWorld(true);
  const [px, py, pz] = loaded.pivotOffset;
  const origin = new Vector3(ray.origin[0] + px, ray.origin[1] + py, ray.origin[2] + pz);
  const hit = rm.raycastRay(origin, new Vector3(...ray.direction));
  if (!hit) return null;
  return relRegistryPath(hit.path, loaded.rootPath) ?? '<outside>' + hit.path;
}

// ─── diffSnapshots() ────────────────────────────────────────────────────

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function diffRecord(
  dimension: ParityDiff['dimension'],
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  out: ParityDiff[],
  tag: (key: string) => string[] = () => [],
): void {
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)]).values()) {
    if (key in a && key in b && same(a[key], b[key])) continue;
    out.push({ dimension, key, main: a[key], placement: b[key], tags: tag(key) });
  }
}

function diffList(
  dimension: ParityDiff['dimension'], a: string[], b: string[], out: ParityDiff[],
  tag: (key: string) => string[] = () => [],
): void {
  const sa = new Set(a); const sb = new Set(b);
  for (const k of sa) if (!sb.has(k)) out.push({ dimension, key: k, main: true, placement: undefined, tags: tag(k) });
  for (const k of sb) if (!sa.has(k)) out.push({ dimension, key: k, main: undefined, placement: true, tags: tag(k) });
}

/** Every difference between two structure snapshots, tagged for the allow-list. */
export function diffSnapshots(main: ParitySnapshot, placement: ParitySnapshot): ParityDiff[] {
  const out: ParityDiff[] = [];
  const claimed = new Set(main.meta.claimedPaths);
  if (main.root.name !== placement.root.name) {
    out.push({ dimension: 'root', key: 'name', main: main.root.name, placement: placement.root.name, tags: ['instance-root-name'] });
  }
  if (!same(main.rootChildren.pivotOffset, placement.rootChildren.pivotOffset)) {
    out.push({
      dimension: 'rootChildren', key: 'pivotOffset',
      main: main.rootChildren.pivotOffset, placement: placement.rootChildren.pivotOffset,
      tags: [placement.meta.pivotUniform && main.meta.pivotUniform ? 'uniform-pivot-offset' : 'non-uniform-pivot-offset'],
    });
  }
  diffList('rootChildren', main.rootChildren.names, placement.rootChildren.names, out, (key) => (claimed.has(key) ? ['plugin-claim'] : []));
  // Nodes: a node whose ONLY difference is `matrixWorldAutoUpdate` is the
  // declared world-live asymmetry of a movable placement root (tagged, so the
  // allow-list can explain it); anything else about the node is a plain diff.
  for (const key of new Set([...Object.keys(main.nodes), ...Object.keys(placement.nodes)]).values()) {
    const a = main.nodes[key];
    const b = placement.nodes[key];
    if (a && b && same(a, b)) continue;
    const tags: string[] = claimed.has(key) ? ['plugin-claim'] : [];
    if (a && b && same({ ...a, matrixWorldAutoUpdate: null }, { ...b, matrixWorldAutoUpdate: null })) tags.push('placement-world-live');
    out.push({ dimension: 'nodes', key, main: a, placement: b, tags });
  }
  diffList('aliases', main.aliases, placement.aliases, out);
  diffRecord('counts', main.counts, placement.counts, out);
  diffRecord('driveHome', main.driveHome, placement.driveHome, out);
  diffRecord('movers', main.movers, placement.movers, out);
  diffRecord('groups', main.groups, placement.groups, out);
  diffRecord('sensors', main.sensors, placement.sensors, out);
  diffRecord('transports', main.transports, placement.transports, out);
  diffList('snapPorts', main.snapPorts, placement.snapPorts, out);
  diffRecord('webComponents', main.webComponents, placement.webComponents, out);
  diffRecord('logic', main.logic, placement.logic, out);
  diffRecord('signals', main.signals, placement.signals, out);
  diffRecord('gated', main.gated, placement.gated, out);
  return out;
}

/** Every difference between two behaviour snapshots (never allow-listed). */
export function diffBehaviour(main: BehaviourSnapshot, placement: BehaviourSnapshot): ParityDiff[] {
  const out: ParityDiff[] = [];
  diffRecord('behaviour', main.drives, placement.drives, out);
  diffRecord('behaviour', main.driveNodes, placement.driveNodes, out);
  diffRecord('behaviour', main.steps, placement.steps, out);
  diffRecord('behaviour', main.signals, placement.signals, out);
  return out;
}

/** The diffs of ONE dimension — what a per-dimension `it` asserts on. */
export function diffsOf(diffs: readonly ParityDiff[], dimension: ParityDiff['dimension']): ParityDiff[] {
  return diffs.filter((d) => d.dimension === dimension);
}

/** Short, stable rendering for assertion messages. */
export function describeDiffs(diffs: readonly ParityDiff[]): string {
  return diffs.map((d) => `${d.dimension}:${d.key} main=${JSON.stringify(d.main)} placement=${JSON.stringify(d.placement)}${d.tags.length ? ' [' + d.tags.join(',') + ']' : ''}`).join('\n');
}

// ─── D6 — dedup effect on the chunk count ───────────────────────────────

export interface DedupMeasurement {
  withDedup: { chunks: number; materialsBefore: number; materialsAfter: number };
  withoutDedup: { chunks: number; materials: number };
}

async function treeFromBytes(bytes: ArrayBuffer): Promise<Group> {
  const gltf = await gltfLoader.parseAsync(bytes.slice(0), '');
  return gltf.scene as Group;
}

function allMaterials(root: Object3D): Set<Material> {
  const set = new Set<Material>();
  root.traverse((o) => {
    const m = (o as Mesh).material as Material | Material[] | undefined;
    if (!m) return;
    if (Array.isArray(m)) for (const x of m) set.add(x); else set.add(m);
  });
  return set;
}

/**
 * Bake the same bytes twice — once through `deduplicateMaterials` → uber, once
 * uber only — and count chunks (plan-757 D6, measured before the material
 * phase moves inside `prepareAndBake`).
 */
export async function measureDedupEffect(bytes: ArrayBuffer): Promise<DedupMeasurement> {
  const withRoot = await treeFromBytes(bytes);
  const dedup = deduplicateMaterials(withRoot);
  const uberA = new RVUberMaterial(false);
  const resA = applyUberMaterial(withRoot, dedup.uniqueMaterials, false, uberA);
  const bakedA = await bakeTree(withRoot, { destructive: true, uber: resA.sharedMaterial ?? uberA });
  const withDedup = { chunks: bakedA.chunks.length, materialsBefore: dedup.originalCount, materialsAfter: dedup.uniqueMaterials.size };
  bakedA.dispose();

  const withoutRoot = await treeFromBytes(bytes);
  const mats = allMaterials(withoutRoot);
  const uberB = new RVUberMaterial(false);
  const resB = applyUberMaterial(withoutRoot, mats, false, uberB);
  const bakedB = await bakeTree(withoutRoot, { destructive: true, uber: resB.sharedMaterial ?? uberB });
  const withoutDedup = { chunks: bakedB.chunks.length, materials: mats.size };
  bakedB.dispose();
  return { withDedup, withoutDedup };
}
