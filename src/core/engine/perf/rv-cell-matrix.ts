// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-cell-matrix.ts — the cell-matrix benchmark generator (plan-492).
 *
 * DEV-ONLY. Builds N customer-shaped cells — a lane of `k` chain conveyors from
 * the pallet-handling library plus one six-axis Fanuc CRX-10iA/L beside it — on
 * the **production placement path**, so a measurement taken on it prices what a
 * customer layout actually costs: a destructive bake per asset, chunk meshes,
 * BVH, the shadow pass, and the per-placement runtime registration.
 *
 * Why not the existing scale matrix (plan-465/469/473): `rv-synthetic-line.ts`
 * draws robots as box primitives and conveyors as `InstancedMesh` visuals,
 * BOTH of them around the bake. Those numbers cannot answer "what does one more
 * placement cost" or "what would chunk instancing across placements save",
 * which are the questions the optimisation plans need answered.
 *
 * Hard contracts this file keeps (contract-bake-picking.md §1.5, §2.3):
 *  - Placement = `PlacementInstancer.resolveBaked` + `materialize`. This module
 *    never calls `BakeRegistry.instantiate()` — a source guard in
 *    `tests/placement-instancer.test.ts` enforces it for `src/core/engine/perf/**`.
 *  - Chunk geometry is never disposed, never re-indexed, never re-parented and
 *    never hidden through `drawRange` — only through `.visible`.
 *
 * Three things here are NOT obvious and each has a test:
 *
 * 1. **`materialize()` hands back geometry and markers, nothing else**
 *    (rv-placement-instancer.ts §"Materialise"). Parenting, the unique name and
 *    every runtime registration are the caller's. The build therefore runs
 *    `createRoot → attach → name → position → materialize →
 *    integratePlacedContent` per placement, exactly the order
 *    `registerMaterializedPlacement` uses for a deferred layout document.
 *
 * 2. **Lane geometry comes from the snap ports, not from the catalog name.**
 *    `ChainConveyor-2m.glb` has a root offset of `[-3.03, 0, 1.43]` and −90°
 *    about Y, and the placement pivot shifts its content again — so `z = j·2 m`
 *    puts the lane nowhere near itself. The ports `Snap-ZN-convchain` /
 *    `Snap-ZP-convchain` survive the bake as logic nodes and are measured ON
 *    THE FIRST MATERIALISED INSTANCE; every further conveyor is a multiple of
 *    the resulting port-to-port step, so conveyor `j`'s ZN port lands on
 *    conveyor `j−1`'s ZP port by construction.
 *
 * 3. **Component references of the robot are placement-scoped before init.**
 *    The asset's internal `MasterDrive` refs read `FanucCRX-10iA-L/…`;
 *    `resolveComponentRefs()` resolves without a scope, so with 16 placements
 *    the suffix match is ambiguous and a finger gear would bind to a foreign
 *    gripper. The build rewrites the asset-root prefix onto the placement's own
 *    node path before `integratePlacedContent` constructs the components.
 */

import { Box3, Group, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { PlacementInstancer, PlacementRef } from '../rv-placement-instancer';
import type { BakedAsset } from '../rv-bake-chunk';
import type { RVDrive } from '../rv-drive';
import type { RVErraticDriver } from '../rv-erratic';
import type { RVSensor } from '../rv-sensor';
import type { RVTransportSurface } from '../rv-transport-surface';
import { NodeRegistry } from '../rv-node-registry';
import type { RVTransportManager } from '../rv-transport-manager';
import { removeSensorsFrom } from '../rv-sensor-registration';
import { integratePlacedContent, canIntegratePlacedContent } from '../rv-placement-integrate';
import { getBakeTimings } from '../rv-bake-timings';

/**
 * What the generator needs from the viewer — structural, because
 * `src/core/engine/**` must not import `rv-viewer` (the engine layer is
 * cycle-free; `tests/engine-no-viewer-import.node.test.ts` enforces it).
 * `CellMatrixHost` satisfies this shape as it stands.
 */
export interface CellMatrixHost {
  readonly scene: Object3D;
  readonly currentModelRoot: Object3D | null;
  readonly placements: PlacementInstancer;
  registry: NodeRegistry | null;
  transportManager: RVTransportManager | null;
  drives: RVDrive[];
  frameSceneContent?(animate?: boolean): void;
  markRenderDirty?(): void;
  markShadowsDirty?(): void;
}

/** The viewer type the placement-integration helpers take; reached only through
 *  a cast, so this module keeps no import of `rv-viewer` (see above). */
type IntegrationHost = Parameters<typeof integratePlacedContent>[0];

// ─── Public types ────────────────────────────────────────────────────────

/** Which parts of the matrix move. `sparse` runs every `sparseEvery`-th robot. */
export type CellMotion = 'none' | 'conveyor' | 'robot' | 'all' | 'sparse';

export const CELL_MOTIONS: readonly CellMotion[] = ['none', 'conveyor', 'robot', 'all', 'sparse'];

/** The one name the matrix root carries in the document. */
export const CELL_MATRIX_ROOT_NAME = 'CellMatrix';

/**
 * Identity of the robot asset: the benchmark's OWN copy of the library robot,
 * `public/perf/Robots/FanucCRX-10iA-L-erratic.glb` (`scripts/build-perf-robot-asset.mjs`),
 * with `Drive_ErraticPosition` on A1..A6. Since 2026-10-25 the library robot
 * itself carries a RobotIK rig and a demo IKPath instead of the sweep (Thomas);
 * this copy is not in the library catalog, so the id is never resolved through it
 * — the url below always wins (`PlacementInstancer.sourceOf`).
 */
export const DEFAULT_ROBOT_ASSET = 'perf-fanuccrx-10ia-l-erratic';
/** Catalog id of the lane conveyor. */
export const DEFAULT_CONVEYOR_ASSET = 'pallethandling-chainconveyor-2m';
/** Bundled library paths. `rebaseLocalLibraryUrl` re-roots them onto the
 *  deploy's BASE_URL, so one constant works in dev, in a build and in a test. */
export const DEFAULT_CONVEYOR_URL = 'library/PalletHandling/ChainConveyor-2m.glb';
/** The benchmark robot is not a library path, so `rebaseLocalLibraryUrl` leaves it
 *  alone — it is rooted onto BASE_URL here instead, for the same three contexts. */
export const DEFAULT_ROBOT_URL = `${import.meta.env?.BASE_URL ?? '/'}perf/Robots/FanucCRX-10iA-L-erratic.glb`;
/** Node name of the robot asset root — the prefix its internal refs carry. */
export const ROBOT_ASSET_ROOT = 'FanucCRX-10iA-L';

export interface CellMatrixConfig {
  /** N lanes, ≥ 1. */
  cells: number;
  /** k conveyors per lane, ≥ 1. */
  conveyorsPerLane: number;
  /** Catalog id of the conveyor asset. */
  conveyorAsset: string;
  /** Catalog id of the robot asset. */
  robotAsset: string;
  /** GLB url of the conveyor asset. Wins over the catalog id, so a benchmark
   *  run does not depend on which library sources happen to be registered. */
  conveyorUrl?: string;
  /** GLB url of the robot asset. */
  robotUrl?: string;
  /** Lane pitch in metres, across the conveying direction. */
  laneSpacingM: number;
  motion: CellMotion;
  /** `sparse` keeps every n-th robot moving. */
  sparseEvery: number;
  /** Fit the camera onto the finished matrix. Default true. */
  frameCamera?: boolean;
}

export const DEFAULT_CELL_MATRIX_CONFIG: CellMatrixConfig = {
  cells: 4,
  conveyorsPerLane: 3,
  conveyorAsset: DEFAULT_CONVEYOR_ASSET,
  robotAsset: DEFAULT_ROBOT_ASSET,
  conveyorUrl: DEFAULT_CONVEYOR_URL,
  robotUrl: DEFAULT_ROBOT_URL,
  laneSpacingM: 4,
  motion: 'none',
  sparseEvery: 10,
  frameCamera: true,
};

/** Everything a run reports. Written into `__PERF_RESULTS__.cellMatrix`. */
export interface CellMatrixStats {
  cells: number;
  conveyorsPerLane: number;
  /** cells × (k + 1). */
  placements: number;
  /** Distinct assets baked — must equal the number of distinct catalog ids. */
  bakes: number;
  /** First `resolveBaked` → last placement registered. */
  materializeMs: number;
  /** Kept at 0 since plan-756 step 1d: `bake()` resolving IS the readiness, so
   *  there is nothing left to wait for after materialisation. */
  bvhWaitMs: number;
  /** Every chunk carries a pick structure — false would mean a chunk was
   *  published without one, which `bake()` makes impossible (plan F1). */
  pickOk: boolean;
  /** Sensors of this matrix still ticking in the transport manager — gate: 0. */
  activeSensors: number;
  /** Per-asset bake wall time from the bake ring (`getBakeTimings()`). */
  bakeMs: Record<string, number>;
  /** Per-asset PICK-structure phase time from the bake ring (plan-756). */
  pickMs: Record<string, number>;
  chunks: number;
  chunkMeshes: number;
  keepMeshes: number;
  drawCallsEstimate: number;
  /** Scene-walk counters over the matrix roots (NOT the loader's freezeResult,
   *  which describes the empty document this is built into). */
  total: number;
  dynamic: number;
  frozen: number;
  drives: number;
  erraticDrivers: number;
  transportSurfaces: number;
  motion: CellMotion;
  movingRobots: number;
  movingConveyors: number;
}

// ─── Per-viewer state ────────────────────────────────────────────────────

interface LaneHandle {
  group: Group;
  conveyors: Object3D[];
  robot: Object3D;
}

interface CellMatrixState {
  root: Group;
  cfg: CellMatrixConfig;
  lanes: LaneHandle[];
  /** Placement roots in build order — conveyors and robots together. */
  roots: Object3D[];
  baked: BakedAsset[];
  /** Erratic drivers per lane, in axis order. */
  robotDrivers: Array<Array<{ driver: RVErraticDriver; drive: RVDrive }>>;
  conveyorDrives: RVDrive[];
  /** EVERY drive the placements produced — the robot's gripper drives carry no
   *  erratic behavior and belong to neither motion list, but they are still the
   *  matrix's to give back (found by the rebuild-leak test, plan-492 R3). */
  allDrives: RVDrive[];
  surfaces: RVTransportSurface[];
  sensorsRemoved: number;
  stats: CellMatrixStats;
  /** Bumped by `disposeCellMatrix`; an in-flight build writes nothing after. */
  generation: number;
}

const _states = new WeakMap<CellMatrixHost, CellMatrixState>();
/** Build generation per viewer — survives a state that was never published. */
const _generations = new WeakMap<CellMatrixHost, number>();

function nextGeneration(viewer: CellMatrixHost): number {
  const next = (_generations.get(viewer) ?? 0) + 1;
  _generations.set(viewer, next);
  return next;
}

/** The live matrix of a viewer, or null. */
export function getCellMatrix(viewer: CellMatrixHost): { root: Object3D; stats: CellMatrixStats } | null {
  const state = _states.get(viewer);
  return state ? { root: state.root, stats: state.stats } : null;
}

// ─── Build ───────────────────────────────────────────────────────────────

/**
 * Build `cfg.cells` lanes into the OPEN document. Never calls `loadModel` —
 * that starts with `clearModel()` and would unload the very plugin driving the
 * build (rv-viewer.ts, rv-model-plugin-manager.ts).
 *
 * Idempotent per viewer: an existing matrix is disposed first.
 */
export async function buildCellMatrix(
  viewer: CellMatrixHost,
  partial: Partial<CellMatrixConfig> = {},
): Promise<CellMatrixStats> {
  const cfg: CellMatrixConfig = { ...DEFAULT_CELL_MATRIX_CONFIG, ...partial };
  if (!Number.isFinite(cfg.cells) || cfg.cells < 1) throw new Error(`[cell-matrix] cells must be >= 1, got ${cfg.cells}`);
  if (!Number.isFinite(cfg.conveyorsPerLane) || cfg.conveyorsPerLane < 1) {
    throw new Error(`[cell-matrix] conveyorsPerLane must be >= 1, got ${cfg.conveyorsPerLane}`);
  }
  if (!CELL_MOTIONS.includes(cfg.motion)) throw new Error(`[cell-matrix] unknown motion "${cfg.motion}"`);

  disposeCellMatrix(viewer);
  const generation = nextGeneration(viewer);

  const t0 = performance.now();
  const convRef: PlacementRef = { catalogId: cfg.conveyorAsset, glbUrl: cfg.conveyorUrl };
  const robotRef: PlacementRef = { catalogId: cfg.robotAsset, glbUrl: cfg.robotUrl };
  // One bake per asset: `ModelCache.getOrLoadBaked` deduplicates, so every
  // occurrence below joins the same `BakedAsset`.
  const [convBaked, robotBaked] = await Promise.all([
    viewer.placements.resolveBaked(convRef),
    viewer.placements.resolveBaked(robotRef),
  ]);
  if (generation !== _generations.get(viewer)) {
    throw new Error('[cell-matrix] build superseded while the assets were baking');
  }

  const document = viewer.currentModelRoot ?? viewer.scene;
  const root = new Group();
  root.name = CELL_MATRIX_ROOT_NAME;
  document.add(root);

  const state: CellMatrixState = {
    root,
    cfg,
    lanes: [],
    roots: [],
    baked: [convBaked, robotBaked],
    robotDrivers: [],
    conveyorDrives: [],
    allDrives: [],
    surfaces: [],
    sensorsRemoved: 0,
    stats: emptyStats(cfg),
    generation,
  };

  // ── 1. Lane step + cross direction, measured on a real instance ──────
  //
  // The first conveyor is materialised at the lane origin; its own snap ports
  // then say how long a conveyor is and which way it conveys, in the frame
  // every later placement uses.
  const lane0 = new Group();
  lane0.name = 'Lane0';
  root.add(lane0);
  const probe = placeOne(viewer, state, lane0, convBaked, cfg.conveyorAsset, 'Conv0', new Vector3());
  const ports = measurePorts(probe);
  const step = ports.step;
  // Across the lane, in the ground plane: rotate the conveying direction by 90°.
  const cross = new Vector3(step.z, 0, -step.x).normalize();
  if (cross.lengthSq() < 1e-9) cross.set(0, 0, 1);

  // ── 2. Every lane ────────────────────────────────────────────────────
  const robotOffset = cross.clone().multiplyScalar(cfg.laneSpacingM * 0.45);
  for (let i = 0; i < cfg.cells; i++) {
    const laneGroup = i === 0 ? lane0 : new Group();
    if (i > 0) {
      laneGroup.name = `Lane${i}`;
      root.add(laneGroup); // at the origin — offset applied after materialisation
    }
    const conveyors: Object3D[] = i === 0 ? [probe] : [];
    for (let j = i === 0 ? 1 : 0; j < cfg.conveyorsPerLane; j++) {
      const pos = step.clone().multiplyScalar(j);
      conveyors.push(placeOne(viewer, state, laneGroup, convBaked, cfg.conveyorAsset, `Conv${j}`, pos));
    }
    // Beside the middle conveyor — the robot keeps its own base origin
    // (pivot: false, plan-238 recommendation for multi-part assemblies).
    const robotPos = step.clone().multiplyScalar((cfg.conveyorsPerLane - 1) / 2).add(robotOffset);
    const robot = placeOne(viewer, state, laneGroup, robotBaked, cfg.robotAsset, 'Robot', robotPos, false);
    state.lanes.push({ group: laneGroup as Group, conveyors, robot });
  }
  // Now that nothing is being pivoted any more, spread the lanes.
  state.lanes.forEach((lane, i) => { lane.group.position.copy(cross).multiplyScalar(i * cfg.laneSpacingM); });
  refreshWorldMatrices(root);
  state.stats.materializeMs = performance.now() - t0;

  // ── 3. Runtime + motion, BEFORE anything is awaited ──────────────────
  //
  // The viewer's simulation loop keeps ticking between the awaits below, so a
  // matrix whose motion mode is applied only at the very end would have swept
  // its first lanes for as long as the last lane took to bake — and `none`
  // would not mean "never moved". The idle axes are parked at zero once, here,
  // so a build is reproducible; a LATER `setCellMotion` deliberately holds the
  // pose instead (plan-492 F3).
  collectRuntime(viewer, state);
  _states.set(viewer, state);
  setCellMotion(viewer, cfg.motion);
  resetAxesToZero(state);

  // ── 4. Sensors off ───────────────────────────────────────────────────
  // `RVSensor` has no enabled flag and the manager ticks every registered
  // instance (AABB + overlap), so "conveying line without sensors" means
  // taking them out of the manager list and releasing their visualisation.
  state.sensorsRemoved = deactivateSensorsUnder(viewer, root);

  // ── 5. Pick structures — already complete (plan-756 F1); assert, do not wait.
  state.stats.bvhWaitMs = 0;
  state.stats.pickOk = state.baked.every((b) => b.chunks.every((c) => c.pick !== undefined));

  if (generation !== _generations.get(viewer)) {
    // A dispose overtook the build — the roots are already gone.
    throw new Error('[cell-matrix] build superseded while the bake was running');
  }

  // ── 6. Camera ────────────────────────────────────────────────────────
  refreshWorldMatrices(root);
  viewer.transportManager?.notifyTopologyChanged?.();
  // Again, and this time last: the fixed loop kept running through the BVH
  // wait above, which takes as long as the machine takes. A build hands back a
  // matrix at the zero pose, always.
  resetAxesToZero(state);
  if (cfg.frameCamera !== false) viewer.frameSceneContent?.(false);

  refreshStats(viewer, state);
  return state.stats;
}

/** One placement: fresh root → attach → name → position → materialize → integrate. */
function placeOne(
  viewer: CellMatrixHost,
  state: CellMatrixState,
  parent: Object3D,
  baked: BakedAsset,
  catalogId: string,
  name: string,
  position: Vector3,
  pivot = true,
): Object3D {
  const root = viewer.placements.createRoot(baked);
  root.name = name;
  parent.add(root);
  const id = `cellmatrix:${parent.name}/${name}`;
  viewer.placements.materialize(root, baked, { id, label: name, catalogId, pivot });

  // Placement-scoped component references (R4) — BEFORE the components are
  // constructed. `resolveComponentRefs()` resolves without a scope, so an
  // asset-internal `FanucCRX-10iA-L/Gripper/…` path would suffix-match across
  // all placements once there is more than one.
  rescopeComponentRefs(root, NodeRegistry.computeNodePath(root), baked.identity);

  const host = viewer as unknown as IntegrationHost;
  if (canIntegratePlacedContent(host)) integratePlacedContent(host, root);

  // Position LAST. `materialize()` runs `pivotToFloorCenter()`, which
  // neutralises the placement root's own transform but reads WORLD bounds —
  // so any offset already sitting in the parent chain is measured as part of
  // the content and shifted straight back out again (lane 1 ended up on lane 0,
  // caught by cell-matrix-lane-geometry.test.ts). Every placement is therefore
  // materialised at the origin, and the lane offsets are applied afterwards.
  root.position.copy(position);
  state.roots.push(root);
  return root;
}

/**
 * Rewrite every `ComponentReference.path` inside the placement subtree from its
 * asset-root prefix onto `placementPath`.
 *
 * Safe to mutate: `BakeRegistry` deep-copies `userData` per instance
 * (`cloneLogicNode`), so the shared template is untouched.
 *
 * plan-769 Phase 1b (§2.4): only for a LEGACY asset. An asset whose decode built an
 * identity record (`identity`, migrated) resolves every stored reference by its
 * file-relative address inside the placement's own occurrence — no cross-placement
 * suffix match can happen, and rewriting the path would turn a file reference
 * into a web-written one (the old guessing chain). Address-form refs carry no
 * `path` and are never touched.
 */
export function rescopeComponentRefs(
  root: Object3D,
  placementPath: string,
  identity?: { readonly migrated: boolean } | null,
): number {
  if (!placementPath) return 0;
  if (identity?.migrated) return 0;
  let rewritten = 0;
  const assetRoot = (root.userData._originalName as string | undefined) ?? root.name;
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const obj = value as Record<string, unknown>;
    if (obj.type === 'ComponentReference' && typeof obj.path === 'string') {
      const path = obj.path;
      // The prefix a library asset's internal reference carries is its OWN
      // root name — which after placement is the placement root's name, not
      // the asset's. Match both so the asset can be renamed without breaking.
      for (const prefix of refPrefixes(path)) {
        if (path === prefix || path.startsWith(`${prefix}/`)) {
          obj.path = placementPath + path.slice(prefix.length);
          rewritten++;
          break;
        }
      }
      return;
    }
    if (Array.isArray(value)) { for (const v of value) visit(v); return; }
    for (const v of Object.values(obj)) visit(v);
  };
  const refPrefixes = (path: string): string[] => [ROBOT_ASSET_ROOT, assetRoot, path.split('/')[0]];
  root.traverse((node) => {
    const rv = node.userData?.realvirtual;
    if (rv && typeof rv === 'object') visit(rv);
  });
  return rewritten;
}

/**
 * Port-to-port step of a materialised conveyor, in its placement root's frame.
 *
 * Both ports are logic nodes of the bake, so they exist in every instance. Their
 * positions are read through the instance — the asset's root offset, its −90°
 * rotation and the placement pivot are all already folded in.
 */
export function measurePorts(conveyorRoot: Object3D): { zn: Vector3; zp: Vector3; step: Vector3 } {
  const zn = findByNamePart(conveyorRoot, 'Snap-ZN');
  const zp = findByNamePart(conveyorRoot, 'Snap-ZP');
  if (!zn || !zp) {
    throw new Error(
      '[cell-matrix] the conveyor asset has no Snap-ZN-*/Snap-ZP-* ports — '
      + 'lane geometry cannot be derived (do NOT fall back to a length guess)',
    );
  }
  conveyorRoot.updateMatrixWorld(true);
  const local = (node: Object3D): Vector3 => conveyorRoot.worldToLocal(node.getWorldPosition(new Vector3()));
  const pZn = local(zn);
  const pZp = local(zp);
  return { zn: pZn, zp: pZp, step: pZp.clone().sub(pZn) };
}

/**
 * Recompute `matrixWorld` for `root` and everything under it, IGNORING the
 * freeze flags.
 *
 * `updateMatrixWorld()` skips a subtree whose `matrixWorldAutoUpdate` is false —
 * which is exactly what the loader's freeze pass leaves behind on static
 * placement content. That is right for the render loop (a frozen node does not
 * move) and wrong straight after a build, where the node was frozen before its
 * lane had been positioned. Build-time only; the flags themselves are untouched.
 */
function refreshWorldMatrices(root: Object3D): void {
  root.updateWorldMatrix(true, false);
  const walk = (node: Object3D): void => {
    for (const child of node.children) {
      if (child.matrixAutoUpdate) child.updateMatrix();
      child.matrixWorld.multiplyMatrices(node.matrixWorld, child.matrix);
      child.matrixWorldNeedsUpdate = false;
      walk(child);
    }
  };
  walk(root);
}

function findByNamePart(root: Object3D, part: string): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((n) => { if (!found && n.name.startsWith(part)) found = n; });
  return found;
}

// ─── Sensors ─────────────────────────────────────────────────────────────

/**
 * Take every sensor under `root` out of the transport manager and release its
 * visualisation. Returns how many were removed.
 *
 * Deliberately NOT a flag on `RVSensor`: the manager's tick walks its own list
 * (`tm.sensors`), so a flag would still pay the loop, and the list is the thing
 * the gate counts.
 */
export function deactivateSensorsUnder(viewer: CellMatrixHost, root: Object3D): number {
  const tm = viewer.transportManager;
  if (!tm) return 0;
  const mine: RVSensor[] = tm.sensors.filter((s) => isUnder(s.node, root));
  if (mine.length === 0) return 0;
  const set = new Set<RVSensor>(mine);
  removeSensorsFrom(tm, (s) => set.has(s));
  for (const sensor of mine) sensor.dispose();
  tm.notifyTopologyChanged?.();
  return mine.length;
}

function isUnder(node: Object3D | null | undefined, ancestor: Object3D): boolean {
  for (let cur: Object3D | null | undefined = node; cur; cur = cur.parent) if (cur === ancestor) return true;
  return false;
}

// ─── Runtime collection ──────────────────────────────────────────────────

function collectRuntime(viewer: CellMatrixHost, state: CellMatrixState): void {
  const registry = viewer.registry;
  state.robotDrivers = state.lanes.map(() => []);
  state.conveyorDrives = [];
  state.allDrives = [];
  state.surfaces = [];
  if (!registry) return;

  const laneOf = new Map<Object3D, number>();
  state.lanes.forEach((lane, i) => laneOf.set(lane.group, i));
  const laneIndexOf = (node: Object3D): number => {
    for (let cur: Object3D | null = node; cur; cur = cur.parent) {
      const i = laneOf.get(cur);
      if (i !== undefined) return i;
    }
    return -1;
  };

  for (const { instance } of registry.getAll<RVErraticDriver>('Drive_ErraticPosition')) {
    const node = instance?.node;
    if (!node || !isUnder(node, state.root) || !instance.drive) continue;
    const i = laneIndexOf(node);
    if (i >= 0) state.robotDrivers[i].push({ driver: instance, drive: instance.drive });
  }
  const robotRoots = new Set(state.lanes.map((l) => l.robot));
  for (const { instance } of registry.getAll<RVDrive>('Drive')) {
    const node = instance?.node;
    if (!node || !isUnder(node, state.root)) continue;
    // The robot axes are driven by their erratic behaviors, the conveyors by
    // jog — the split is by placement, not by drive kind.
    state.allDrives.push(instance);
    let onRobot = false;
    for (const r of robotRoots) if (isUnder(node, r)) { onRobot = true; break; }
    if (!onRobot) state.conveyorDrives.push(instance);
  }
  for (const { instance } of registry.getAll<RVTransportSurface>('TransportSurface')) {
    const node = (instance as unknown as { node?: Object3D })?.node;
    if (node && isUnder(node, state.root)) state.surfaces.push(instance);
  }
}

// ─── Motion ──────────────────────────────────────────────────────────────

/**
 * Switch what moves, without a rebuild and without signals.
 *
 * `SignalEnable` is deliberately unused: it binds only in `init()` and, when
 * false, drives the axis back to zero (rv-erratic.ts) — a "stopped" robot would
 * fold itself up instead of holding its pose. Stopping means detaching the
 * behavior and `drive.stop()`; resuming re-attaches it and calls `resume()`, so
 * the behavior picks a fresh target instead of waiting for an arrival at a
 * target the stop made unreachable (plan-492 R1).
 */
export function setCellMotion(viewer: CellMatrixHost, mode: CellMotion): void {
  const state = _states.get(viewer);
  if (!state) throw new Error('[cell-matrix] setCellMotion() without a built matrix');
  if (!CELL_MOTIONS.includes(mode)) throw new Error(`[cell-matrix] unknown motion "${mode}"`);

  const robotsMove = mode === 'robot' || mode === 'all' || mode === 'sparse';
  const conveyorsMove = mode === 'conveyor' || mode === 'all';
  const every = Math.max(1, state.cfg.sparseEvery);

  let movingRobots = 0;
  state.robotDrivers.forEach((axes, lane) => {
    const on = robotsMove && (mode !== 'sparse' || lane % every === 0);
    if (on) movingRobots++;
    for (const { driver, drive } of axes) {
      const list = drive.driveBehaviors as unknown as RVErraticDriver[];
      const at = list.indexOf(driver);
      if (on) {
        driver.resume();
        if (at < 0) list.push(driver);
      } else if (at >= 0) {
        list.splice(at, 1);
        drive.stop(); // the pose stays where it is — no return to zero
      }
    }
  });

  for (const drive of state.conveyorDrives) {
    // `JogForward` is the AUTHORED flag; the update loop reads the runtime
    // `jogForward`, which is only seeded from it on init/reset (rv-drive.ts).
    // Writing both is what the drive's own `applyFieldEdit('JogForward')` does.
    drive.JogForward = conveyorsMove;
    (drive as unknown as { jogForward: boolean }).jogForward = conveyorsMove;
    if (conveyorsMove) {
      if (drive.targetSpeed <= 0) drive.targetSpeed = drive.TargetSpeed;
    } else {
      drive.stop();
    }
  }

  state.cfg.motion = mode;
  state.stats.motion = mode;
  state.stats.movingRobots = movingRobots;
  state.stats.movingConveyors = conveyorsMove ? state.conveyorDrives.length : 0;
  viewer.markRenderDirty?.();
}

/**
 * Put EVERY axis back at zero — build-time only.
 *
 * Between `materialize()` of the first lane and the end of the build the
 * viewer's fixed loop keeps ticking, so the axes of the early lanes sweep for
 * as long as the late lanes take to bake — a wall-clock duration that depends
 * on the network, the cache and the machine. Without this reset two builds of
 * the same configuration would start from different poses and the "same
 * parameters, same motion" guarantee would be a coin toss.
 *
 * The runtime `setCellMotion` deliberately does NOT do this: a robot stopped
 * mid-stroke has to hold its pose (plan-492 F3).
 */
function resetAxesToZero(state: CellMatrixState): void {
  for (const axes of state.robotDrivers) {
    for (const { driver, drive } of axes) {
      drive.stop();
      drive.currentPosition = 0;
      drive.applyToNode?.();
      driver.resume();
    }
  }
}

// ─── Stats ───────────────────────────────────────────────────────────────

function emptyStats(cfg: CellMatrixConfig): CellMatrixStats {
  return {
    cells: cfg.cells,
    conveyorsPerLane: cfg.conveyorsPerLane,
    placements: 0,
    bakes: 0,
    materializeMs: 0,
    bvhWaitMs: 0,
    pickOk: false,
    activeSensors: 0,
    bakeMs: {},
    pickMs: {},
    chunks: 0,
    chunkMeshes: 0,
    keepMeshes: 0,
    drawCallsEstimate: 0,
    total: 0,
    dynamic: 0,
    frozen: 0,
    drives: 0,
    erraticDrivers: 0,
    transportSurfaces: 0,
    motion: cfg.motion,
    movingRobots: 0,
    movingConveyors: 0,
  };
}

/** Re-read every counter of the live matrix. Cheap enough for a 2 Hz HMI tick. */
export function cellMatrixStats(viewer: CellMatrixHost): CellMatrixStats | null {
  const state = _states.get(viewer);
  if (!state) return null;
  refreshStats(viewer, state);
  return state.stats;
}

function refreshStats(viewer: CellMatrixHost, state: CellMatrixState): void {
  const s = state.stats;
  s.placements = state.roots.length;
  s.bakes = new Set(state.baked.map((b) => b.assetId)).size;

  const reg = viewer.placements.bakeRegistry.stats();
  s.chunks = reg.chunks;
  s.chunkMeshes = reg.chunkMeshes;
  s.keepMeshes = reg.keepMeshes;
  s.drawCallsEstimate = reg.drawCalls;

  // The loader's `freezeResult` describes the EMPTY document this was built
  // into, so the counters come from a walk over the matrix itself.
  let total = 0; let dynamic = 0;
  state.root.traverse((n) => { total++; if (n.matrixWorldAutoUpdate) dynamic++; });
  s.total = total;
  s.dynamic = dynamic;
  s.frozen = total - dynamic;

  s.drives = state.conveyorDrives.length + state.robotDrivers.reduce((a, l) => a + l.length, 0);
  s.erraticDrivers = state.robotDrivers.reduce((a, l) => a + l.length, 0);
  s.transportSurfaces = state.surfaces.length;

  const tm = viewer.transportManager;
  s.activeSensors = tm ? tm.sensors.filter((x) => isUnder(x.node, state.root)).length : 0;

  applyBakeTimings(s, state);
}

function applyBakeTimings(s: CellMatrixStats, state: CellMatrixState): void {
  const ids = new Set(state.baked.map((b) => b.assetId));
  for (const t of getBakeTimings()) {
    if (!ids.has(t.assetId)) continue;
    s.bakeMs[t.assetId] = t.totalMs;
    s.pickMs[t.assetId] = t.phases.find((p) => p.phase === 'pick')?.ms ?? 0;
  }
}

// ─── Teardown ────────────────────────────────────────────────────────────

/**
 * Give everything back: runtime registrations first, then the placement
 * instances, then the nodes (plan-492 R3).
 *
 * `PlacementInstancer.release()` only gives the chunk geometry back — the
 * drives, sensors, transport surfaces and registry paths a placement produced
 * are the caller's, exactly as they were on the way in. A rebuild that skipped
 * this would leak a full runtime per cell while `BakeRegistry.stats().instances`
 * still read 0. Modelled on the planner's `scene-mutations.ts` teardown, minus
 * everything that is planner bookkeeping.
 */
export function disposeCellMatrix(viewer: CellMatrixHost): void {
  const state = _states.get(viewer);
  if (!state) return;
  _states.delete(viewer);
  nextGeneration(viewer);

  const tm = viewer.transportManager;
  const registry = viewer.registry;

  // Behaviors first, while the drives are still live.
  for (const axes of state.robotDrivers) {
    for (const { driver, drive } of axes) {
      const list = drive.driveBehaviors as unknown as RVErraticDriver[];
      const at = list.indexOf(driver);
      if (at >= 0) list.splice(at, 1);
    }
  }

  if (tm) {
    const surfaceSet = new Set(state.surfaces);
    tm.surfaces = tm.surfaces.filter((s) => !surfaceSet.has(s));
    removeSensorsFrom(tm, (s) => isUnder(s.node, state.root));
    tm.sources = tm.sources.filter((s) => !isUnder((s as unknown as { node?: Object3D }).node, state.root));
    tm.sinks = tm.sinks.filter((s) => !isUnder((s as unknown as { node?: Object3D }).node, state.root));
    for (const surface of state.surfaces) (surface as unknown as { dispose?(): void }).dispose?.();
  }

  const drives = new Set<RVDrive>(state.allDrives);
  for (const d of state.conveyorDrives) drives.add(d);
  for (const axes of state.robotDrivers) for (const { drive } of axes) drives.add(drive);
  for (let i = viewer.drives.length - 1; i >= 0; i--) {
    if (drives.has(viewer.drives[i])) viewer.drives.splice(i, 1);
  }
  for (const drive of drives) drive.dispose?.();

  // Registry BEFORE the release: `release()` detaches the instantiated nodes,
  // and `unregisterSubtree` walks the live graph — unregistering afterwards
  // would only reach what is left, leaving the rest addressable forever.
  registry?.unregisterSubtree(state.root);

  // Placement instances — chunk geometry back to the shared asset, never disposed.
  for (const root of state.roots) viewer.placements.release(root);

  state.root.parent?.remove(state.root);
  tm?.notifyTopologyChanged?.();
  viewer.markShadowsDirty?.();
  viewer.markRenderDirty?.();
}

// ─── Bounds helper (tests: every placement inside the camera frustum) ────

/** World bounds over every placement root of the live matrix. */
export function cellMatrixBounds(viewer: CellMatrixHost): Box3 | null {
  const state = _states.get(viewer);
  if (!state) return null;
  const box = new Box3();
  refreshWorldMatrices(state.root);
  box.setFromObject(state.root);
  return box.isEmpty() ? null : box;
}
