// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Realistic scene ingredients for the synthetic perf line (plan-469 Phase 0d).
 *
 * DEV-ONLY, like everything else under `perf/`. Three things the primitive line
 * of plan-465 deliberately did NOT have, and which a customer scene always has:
 *
 * 1. **Real conveyor geometry** out of `public/library/PalletHandling/`
 *    instead of a belt that is an invisible `Object3D` with an AABB.
 * 2. **A real MU** (`CartonBox.glb`) instead of a `BoxGeometry`, so the
 *    instanced-vs-clone decision in `analyzeTemplate` is exercised by an asset
 *    that was authored in CAD rather than by a single-mesh primitive.
 * 3. **Robots** — six nested rotary `RVDrive`s each, moving incoherently — so
 *    the drive stage and the world-matrix fan-out carry a load that has nothing
 *    to do with transport. That is the load the plan-469 attribution could not
 *    see before, because the synthetic line's only drives were belt frames whose
 *    drive is pinned by `isTransportSurface`.
 *
 * The robots deliberately do NOT touch the material flow: they stand off to the
 * side of the lanes, grip nothing and own no transport surface. Adding them
 * therefore changes the SCENE cost without changing the transport SEMANTICS,
 * which is the only way the difference between two stages is attributable.
 *
 * Determinism: every random draw comes from a seed derived from the line's own
 * `seed`, so the same configuration produces the same robot poses and the same
 * target sequence on every run.
 */

import {
  Box3, BoxGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial,
  Object3D, Quaternion, Vector3,
} from 'three';
import type { BufferGeometry, Material } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { gltfLoader } from '../rv-glb-parse';
import { RVDrive } from '../rv-drive';
import { DriveDirection } from '../rv-coordinate-utils';

/** Where the pallet-handling library lives, relative to the deploy root. */
const LIBRARY_DIR = 'library/PalletHandling/';

/** Conveyor pieces the library offers, longest first (greedy tiling). */
export const CONVEYOR_PIECES = ['RollConveyor-3m', 'RollConveyor-2m', 'RollConveyor-1m'] as const;
export const CARTON_BOX_ASSET = 'CartonBox';
/** A loaded Euro pallet (1.2 x 0.8 m, 0.32 m tall, 808 triangles, 2 meshes). */
export const EUROPALLET_ASSET = 'EuropalletLoaded';

/** The MU shapes a synthetic line can carry. `primitive` is the plan-465 box. */
export type SyntheticMuAsset = 'primitive' | 'cartonbox' | 'pallet';

/** Library GLB behind each non-primitive MU asset. */
export const MU_LIBRARY_ASSETS: Record<Exclude<SyntheticMuAsset, 'primitive'>, string> = {
  cartonbox: CARTON_BOX_ASSET,
  pallet: EUROPALLET_ASSET,
};

/**
 * Length along the belt and gap that make sense for each MU asset, in mm. The
 * template builder scales the asset's long axis to the configured length, so a
 * pallet asked to be 200 mm long would be a 200 mm pallet — the Perf Line
 * document and the runner defaults read these instead of guessing.
 */
export const MU_ASSET_PITCH_MM: Record<SyntheticMuAsset, { lengthMm: number; gapMm: number }> = {
  primitive: { lengthMm: 200, gapMm: 100 },
  cartonbox: { lengthMm: 200, gapMm: 100 },
  pallet: { lengthMm: 1200, gapMm: 300 },
};

/**
 * Loaded GLB roots, keyed by asset name. Module-level: an asset is parsed once
 * per page and reused by every build/dispose cycle (a 15 MB re-parse per cell
 * would dominate the fill phase and would be charged to the measurement).
 */
const assetCache = new Map<string, Object3D>();

function assetUrl(name: string): string {
  const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env;
  const base = env?.BASE_URL ?? '/';
  return `${base}${LIBRARY_DIR}${name}.glb`;
}

/**
 * Load the assets a configuration needs into the module cache.
 *
 * Separate from the builder on purpose: `buildSyntheticLine` is synchronous (the
 * plugin, the tests and the runner all rely on that), and a network fetch inside
 * it would make the whole harness async for the benefit of one option.
 */
export async function preloadSyntheticAssets(names: readonly string[]): Promise<void> {
  await Promise.all(names.map(async (name) => {
    if (assetCache.has(name)) return;
    const gltf = await gltfLoader.loadAsync(assetUrl(name));
    gltf.scene.updateMatrixWorld(true);
    assetCache.set(name, gltf.scene);
  }));
}

/** The cached root, or `undefined` when {@link preloadSyntheticAssets} was skipped. */
export function cachedAsset(name: string): Object3D | undefined {
  return assetCache.get(name);
}

/** Test seam — install a parsed root without touching the network. */
export function setCachedAsset(name: string, root: Object3D): void {
  assetCache.set(name, root);
}

/** Test seam — drops the parsed GLBs so a suite cannot leak them between cases. */
export function clearSyntheticAssetCache(): void {
  assetCache.clear();
  for (const baked of bakedTemplates.values()) {
    baked.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh && mesh.geometry) mesh.geometry.dispose();
    });
  }
  bakedTemplates.clear();
}

// ── Conveyor geometry ────────────────────────────────────────────────────

/**
 * Width across the belt of `RollConveyor-*.glb` in metres (POSITION bounds of
 * `RollConveyor-1m.glb`: x in [-0.56, 0.56]). The synthetic line pitches its
 * lanes from the MU size, and with the plan-465 defaults that pitch is 0.6 m —
 * narrower than this asset, so neighbouring lanes drawn with library pieces
 * used to intersect (seen 2026-09-25). The line reads this constant to widen
 * the pitch for `geometry: 'library'`; the transport topology is unaffected.
 */
export const LIBRARY_CONVEYOR_WIDTH_M = 1.12;

/** One drawable piece of an asset, with its transform relative to the asset root. */
export interface AssetPart {
  geometry: BufferGeometry;
  material: Material | Material[];
  /** Matrix of the mesh relative to the asset root. */
  matrix: Matrix4;
}

/** Flatten an asset into its drawable parts (matrices relative to the root). */
export function extractAssetParts(root: Object3D): AssetPart[] {
  root.updateMatrixWorld(true);
  const inv = new Matrix4().copy(root.matrixWorld).invert();
  const parts: AssetPart[] = [];
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    parts.push({
      geometry: mesh.geometry,
      material: mesh.material,
      matrix: new Matrix4().multiplyMatrices(inv, mesh.matrixWorld),
    });
  });
  return parts;
}

/** Triangle count of one geometry. */
export function geometryTriangles(geometry: BufferGeometry): number {
  const index = geometry.getIndex();
  const count = index ? index.count : (geometry.getAttribute('position')?.count ?? 0);
  return Math.floor(count / 3);
}

/**
 * Rotate/translate an asset so its long axis lies along +X, its top face sits at
 * y = 0 and it is centred on the origin in X/Z. Everything downstream then
 * places pieces by their centre point, exactly like the primitive belts.
 */
export function alignmentMatrix(root: Object3D): Matrix4 {
  root.updateMatrixWorld(true);
  const box = new Box3().setFromObject(root);
  const size = box.getSize(new Vector3());
  const centre = box.getCenter(new Vector3());
  const rotate = size.z > size.x;
  const rot = new Matrix4();
  if (rotate) rot.makeRotationY(Math.PI / 2);
  // Centre first (in the asset's own frame), then rotate. Y is translated so the
  // asset's TOP lands on y = 0, i.e. on the belt plane the MUs ride.
  const centreThenTop = new Matrix4().makeTranslation(-centre.x, -box.max.y, -centre.z);
  return new Matrix4().multiplyMatrices(rot, centreThenTop);
}

/** Measured length (metres) of a cached conveyor asset along its long axis. */
export function assetLengthM(name: string): number {
  const root = assetCache.get(name);
  if (!root) return 0;
  root.updateMatrixWorld(true);
  const size = new Box3().setFromObject(root).getSize(new Vector3());
  return Math.max(size.x, size.z);
}

/** Longest library piece that is not longer than `lengthM` (nominal metres). */
export function pieceForLength(lengthM: number): string | null {
  const nominal = Math.round(lengthM);
  if (nominal >= 3) return 'RollConveyor-3m';
  if (nominal === 2) return 'RollConveyor-2m';
  if (nominal >= 1) return 'RollConveyor-1m';
  return null;
}

/**
 * Tile a segment of `lengthM` metres out of library pieces, returning the piece
 * lengths in order. Greedy longest-first; a remainder below 1 m is dropped
 * (a visual gap of < 1 m on a 5 m belt, against a mis-scaled conveyor).
 */
export function tileSegment(lengthM: number): number[] {
  const out: number[] = [];
  let left = lengthM;
  for (const len of [3, 2, 1]) {
    while (left >= len - 1e-6) { out.push(len); left -= len; }
  }
  return out;
}

/** Where one conveyor piece goes, in the line root's frame. */
export interface ConveyorPlacement {
  x: number;
  y: number;
  z: number;
  /** Nominal length in metres — selects the library variant. */
  lengthM: number;
  /** Lane direction is -X: the piece is turned 180 degrees about Y. */
  flipped: boolean;
}

export interface ConveyorVisualHandle {
  /** One InstancedMesh per (asset variant x asset part). */
  meshes: InstancedMesh[];
  placements: number;
  /** Draw calls the visuals add (one per InstancedMesh). */
  draws: number;
  /** Triangles the visuals add, summed over all instances. */
  triangles: number;
  /** How many plain `Mesh`es a `clone()` build would have produced instead. */
  clonedMeshesAvoided: number;
  dispose(): void;
}

/**
 * Build the conveyor visuals for a whole line as `InstancedMesh`es.
 *
 * WHY INSTANCED AND NOT `scene.clone()`:
 *
 * A 24 x 9 line is 216 copies of two or three identical library assets. Cloning
 * them would put ~216 x (parts per asset) `Mesh` objects into the scene, and the
 * run would then measure "someone shipped several thousand unbatched draw
 * calls" — a statement about an export mistake rather than about the transport
 * step this spike is attributing. A delivered realvirtual scene gets exactly
 * this case batched at EXPORT time through `EXT_mesh_gpu_instancing` (see
 * `doc-webviewer.md`), which arrives in the browser as `InstancedMesh`, so
 * instancing reproduces the shipped pipeline and cloning would not.
 *
 * The handle reports both numbers — the draws actually issued and the clone
 * count that was avoided — so the report can state the trade instead of hiding it.
 */
export function buildConveyorVisuals(
  parent: Object3D,
  placements: readonly ConveyorPlacement[],
): ConveyorVisualHandle {
  const byAsset = new Map<string, Matrix4[]>();
  const yAxis = new Vector3(0, 1, 0);
  const q = new Quaternion();
  const s = new Vector3(1, 1, 1);
  const pos = new Vector3();
  for (const p of placements) {
    const name = pieceForLength(p.lengthM);
    if (!name || !assetCache.has(name)) continue;
    let list = byAsset.get(name);
    if (!list) { list = []; byAsset.set(name, list); }
    pos.set(p.x, p.y, p.z);
    q.setFromAxisAngle(yAxis, p.flipped ? Math.PI : 0);
    list.push(new Matrix4().compose(pos, q, s));
  }

  const meshes: InstancedMesh[] = [];
  let draws = 0;
  let triangles = 0;
  let clonedMeshesAvoided = 0;
  const tmp = new Matrix4();
  for (const [name, mats] of byAsset) {
    const root = assetCache.get(name);
    if (!root) continue;
    const align = alignmentMatrix(root);
    const parts = extractAssetParts(root);
    clonedMeshesAvoided += parts.length * mats.length;
    for (const part of parts) {
      const inst = new InstancedMesh(part.geometry, part.material, mats.length);
      inst.name = `__rvConv_${name}`;
      inst.castShadow = true;
      inst.receiveShadow = true;
      for (let i = 0; i < mats.length; i++) {
        tmp.multiplyMatrices(mats[i], align).multiply(part.matrix);
        inst.setMatrixAt(i, tmp);
      }
      inst.instanceMatrix.needsUpdate = true;
      inst.computeBoundingSphere();
      parent.add(inst);
      meshes.push(inst);
      draws++;
      triangles += geometryTriangles(part.geometry) * mats.length;
    }
  }

  let disposed = false;
  return {
    meshes,
    placements: placements.length,
    draws,
    triangles,
    clonedMeshesAvoided,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const m of meshes) {
        m.parent?.remove(m);
        // Geometry and material belong to the CACHED asset and are shared by
        // every build; `InstancedMesh.dispose()` frees only the per-instance
        // matrix buffer, which is what this build owns.
        m.dispose();
      }
      meshes.length = 0;
    },
  };
}

// ── MU template from a library asset ─────────────────────────────────────

export interface MuTemplateInfo {
  node: Object3D;
  /** Number of `Mesh` descendants — `analyzeTemplate` instances only when 1. */
  meshCount: number;
  triangles: number;
  /**
   * Half-extents of the baked template in metres (x along the belt). The line
   * rides the MU with its underside on the belt top and sizes the sensor and
   * sink AABBs from this, instead of assuming a cube of `lengthMm` — a loaded
   * pallet is 1.2 m long and 0.32 m tall, and the cube assumption would float
   * it half a metre above the rollers.
   */
  halfExtents: Vector3;
}

/** Baked, re-centred templates, keyed by `<asset>@<lengthMm>`. */
const bakedTemplates = new Map<string, Object3D>();

/**
 * `mergeGeometries` refuses parts whose attribute sets differ, and CAD exports
 * do differ: the pallet's box carries a second UV set (`uv1`) its material never
 * reads, the pallet board does not. Drop every attribute that is not present on
 * ALL parts. The parts are the builder's own clones, and a material only reads
 * `uv1`/`uv2` for an aoMap / lightMap it would have to declare — none of the
 * library MU materials does, so nothing visible changes.
 */
function harmonizeAttributes(geometries: readonly BufferGeometry[]): void {
  const names = geometries.map((g) => new Set(Object.keys(g.attributes)));
  const common = new Set([...names[0]].filter((n) => names.every((s) => s.has(n))));
  for (const g of geometries) {
    for (const name of Object.keys(g.attributes)) {
      if (!common.has(name)) g.deleteAttribute(name);
    }
  }
}

/**
 * Turn a cached asset into an MU template that behaves exactly like the
 * primitive box: geometry centred on the node origin and scaled so its longest
 * axis is `lengthMm`.
 *
 * BOTH halves matter, and the second one was found the hard way. A library GLB
 * carries its geometry wherever CAD put it — `CartonBox.glb` sits about 1.7 m
 * from its own node origin. Simply cloning and scaling the node produces MUs
 * whose `templateLocalCenter` is that offset, so the transport manager places
 * every MU's AABB 1.7 m off the belt: `_pickDrivingSurface` finds no surface,
 * the MUs never move, no sensor ever triggers and the sink rate is exactly zero.
 * The line still "runs" and still reports numbers — which is precisely why the
 * offset is BAKED here instead of being carried as a local-centre offset.
 *
 * Baking means the transform is applied to CLONED geometry once per
 * `(asset, length)` pair; the per-lane templates are `clone()`s of that baked
 * node and share its buffers, so 24 lanes cost 24 node trees and one geometry.
 */
export function buildLibraryMuTemplate(assetName: string, lengthMm: number, name: string): MuTemplateInfo | null {
  const key = `${assetName}@${lengthMm}`;
  let baked = bakedTemplates.get(key);
  if (!baked) {
    const root = assetCache.get(assetName);
    if (!root) return null;
    root.updateMatrixWorld(true);
    const box = new Box3().setFromObject(root);
    const size = box.getSize(new Vector3());
    const centre = box.getCenter(new Vector3());
    // Put the asset's LONG horizontal axis along X (the lane's transport
    // direction) and scale so that axis measures `lengthMm`.
    //
    // Not "scale the longest of the three axes": the plan's capacity and
    // spawn-gate arithmetic is expressed in `muLengthMm` ALONG THE BELT, and the
    // source's spawn gate frees after one MU length at belt speed. Scaling
    // CartonBox by its longest axis left only 134 mm along X, the gate freed 33 %
    // early, and the line settled at 2 884 live MUs against S0's 2 592 — a 11 %
    // occupancy gap, which is more than the +-5 % the A/B comparison allows.
    const rotate = size.z > size.x;
    const alongX = (rotate ? size.z : size.x) || 1;
    const k = (lengthMm / 1000) / alongX;
    // asset world space -> centred -> long axis along X -> scaled
    const toTemplate = new Matrix4()
      .makeScale(k, k, k)
      .multiply(rotate ? new Matrix4().makeRotationY(Math.PI / 2) : new Matrix4())
      .multiply(new Matrix4().makeTranslation(-centre.x, -centre.y, -centre.z));
    const group = new Group();
    const m = new Matrix4();
    root.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      const geometry = mesh.geometry.clone();
      geometry.applyMatrix4(m.multiplyMatrices(toTemplate, mesh.matrixWorld));
      const flat = new Mesh(geometry, mesh.material);
      flat.name = mesh.name;
      group.add(flat);
    });
    // ONE mesh, always. `analyzeTemplate` (rv-mu.ts) instances a template only
    // when it is a single Mesh, and it accepts a material ARRAY — so a
    // multi-part asset (the loaded pallet is five meshes with two textured
    // materials) is merged into one geometry with one group per part, each
    // group keeping its own material. Nothing is lost: same triangles, same
    // materials, same textures; only the per-part node transforms go, and those
    // were baked into the vertices above anyway. Without this a pallet line
    // took the clone path — two draw calls plus two shadow draws PER PALLET —
    // and was CPU-bound at a few hundred pallets (2026-09-25).
    // Parts whose material is already an array cannot be regrouped and keep
    // the Group; so does a merge that fails on mismatched attribute sets.
    const parts = group.children as Mesh[];
    const mergeable = parts.length > 1 && parts.every((p) => !Array.isArray(p.material));
    if (mergeable) harmonizeAttributes(parts.map((p) => p.geometry));
    const merged = mergeable ? mergeGeometries(parts.map((p) => p.geometry), true) : null;
    if (parts.length === 1) {
      baked = parts[0];
    } else if (merged) {
      const mesh = new Mesh(merged, parts.map((p) => p.material as Material));
      mesh.name = root.name;
      for (const p of parts) p.geometry.dispose();
      baked = mesh;
    } else {
      baked = group;
    }
    baked.position.set(0, 0, 0);
    baked.updateMatrixWorld(true);
    bakedTemplates.set(key, baked);
  }

  const node = baked.clone(true);
  node.name = name;
  node.position.set(0, 0, 0);
  node.updateMatrixWorld(true);
  let meshCount = 0;
  let triangles = 0;
  node.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    meshCount++;
    triangles += geometryTriangles(mesh.geometry);
  });
  const halfExtents = new Box3().setFromObject(node).getSize(new Vector3()).multiplyScalar(0.5);
  return { node, meshCount, triangles, halfExtents };
}

// ── Robots ───────────────────────────────────────────────────────────────

/** One rotary axis of the synthetic robot. Proportions of a ~1.5 m-reach arm. */
interface AxisSpec {
  direction: DriveDirection;
  /** Offset of this axis from its parent axis along the parent's local Y, in metres. */
  offsetY: number;
  /** Link box half-extents in metres (x, y, z); the link is drawn ABOVE the axis. */
  link: [number, number, number];
  lower: number;
  upper: number;
  /** deg/s — deliberately different per axis so the arm never repeats a pose. */
  speed: number;
  accel: number;
}

const ROBOT_AXES: readonly AxisSpec[] = [
  { direction: DriveDirection.RotationY, offsetY: 0.00, link: [0.18, 0.15, 0.18], lower: -170, upper: 170, speed: 120, accel: 240 },
  { direction: DriveDirection.RotationZ, offsetY: 0.30, link: [0.10, 0.28, 0.10], lower: -90, upper: 90, speed: 95, accel: 190 },
  { direction: DriveDirection.RotationZ, offsetY: 0.55, link: [0.09, 0.23, 0.09], lower: -150, upper: 60, speed: 110, accel: 220 },
  { direction: DriveDirection.RotationY, offsetY: 0.45, link: [0.07, 0.10, 0.07], lower: -180, upper: 180, speed: 190, accel: 380 },
  { direction: DriveDirection.RotationZ, offsetY: 0.20, link: [0.06, 0.08, 0.06], lower: -120, upper: 120, speed: 175, accel: 350 },
  { direction: DriveDirection.RotationY, offsetY: 0.15, link: [0.05, 0.04, 0.05], lower: -180, upper: 180, speed: 250, accel: 500 },
];

export const ROBOT_AXIS_COUNT = ROBOT_AXES.length;

export interface RobotFarmHandle {
  root: Group;
  drives: RVDrive[];
  /** Link meshes drawn for the robots. Robots are NOT instanced: every link has
   *  its own pose every frame, which is exactly the cost being measured. */
  meshes: number;
  triangles: number;
  dispose(): void;
}

/**
 * Build `count` six-axis robots.
 *
 * `motion: 'erratic'` gives every axis its own deterministic target stream: when
 * an axis reaches its target it immediately draws the next one from its own
 * PRNG, so the axes never synchronise and the arm never settles. That is
 * intentional — a coherent, repeating cycle would let the drive stage warm into
 * a best case that no real cell has.
 */
export function buildRobotFarm(opts: {
  parent: Object3D;
  count: number;
  motion: 'static' | 'erratic';
  seed: number;
  /** Called for every created drive (the viewer's tick list). */
  registerDrive: (drive: RVDrive) => void;
  /** Robot `i` is put at `place(i, out)` in the parent's frame. */
  place: (index: number, out: Vector3) => Vector3;
}): RobotFarmHandle {
  const root = new Group();
  root.name = '__rvRobotFarm';
  opts.parent.add(root);

  // ONE geometry + ONE material for every link of every robot: the links differ
  // only in scale, and a unit box scaled per node is how a CAD-authored arm
  // arrives after import. Sharing them keeps the measurement about the TRANSFORM
  // fan-out rather than about several hundred buffer uploads.
  const linkGeometry = new BoxGeometry(1, 1, 1);
  const linkMaterial = new MeshStandardMaterial({ color: 0xf3a712, roughness: 0.5, metalness: 0.1 });

  const drives: RVDrive[] = [];
  const callbacks: { drive: RVDrive; cb: (d: RVDrive) => void }[] = [];
  const pos = new Vector3();
  let meshes = 0;

  for (let r = 0; r < opts.count; r++) {
    const base = new Group();
    base.name = `Robot${r}`;
    opts.place(r, pos);
    base.position.copy(pos);
    root.add(base);

    let parent: Object3D = base;
    for (let a = 0; a < ROBOT_AXES.length; a++) {
      const spec = ROBOT_AXES[a];
      const axisNode = new Object3D();
      axisNode.name = `Robot${r}/A${a + 1}`;
      axisNode.position.set(0, spec.offsetY, 0);
      parent.add(axisNode);

      const link = new Mesh(linkGeometry, linkMaterial);
      link.name = `Robot${r}/L${a + 1}`;
      link.scale.set(spec.link[0] * 2, spec.link[1] * 2, spec.link[2] * 2);
      link.position.set(0, spec.link[1], 0);
      link.castShadow = true;
      link.receiveShadow = true;
      axisNode.add(link);
      meshes++;

      axisNode.updateWorldMatrix(true, false);

      const drive = new RVDrive(axisNode);
      drive.Direction = spec.direction;
      drive.TargetSpeed = spec.speed;
      drive.Acceleration = spec.accel;
      drive.UseAcceleration = true;
      drive.UseLimits = true;
      drive.LowerLimit = spec.lower;
      drive.UpperLimit = spec.upper;
      drive.initDrive();
      drives.push(drive);
      opts.registerDrive(drive);

      if (opts.motion === 'erratic') {
        // Own PRNG per axis, seeded from (line seed, robot, axis) — the stream is
        // a pure function of the configuration, so two runs of the same cell see
        // the same poses at the same tick.
        let state = (opts.seed + r * 977 + a * 31) >>> 0;
        const next = (): number => {
          state = (state + 0x6d2b79f5) >>> 0;
          let t = state;
          t = Math.imul(t ^ (t >>> 15), t | 1);
          t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        const span = spec.upper - spec.lower;
        // Allocation-free: the closure owns two numbers, the callback allocates
        // nothing and runs once per drive per tick.
        const cb = (d: RVDrive): void => {
          if (d.isAtTarget) d.startMove(spec.lower + next() * span);
        };
        drive.addAfterUpdate(cb);
        callbacks.push({ drive, cb });
        drive.startMove(spec.lower + next() * span);
      }

      parent = axisNode;
    }
  }

  root.updateWorldMatrix(true, true);

  let disposed = false;
  return {
    root,
    drives,
    meshes,
    // A unit box is 12 triangles; the link count is the whole robot triangle cost.
    triangles: meshes * 12,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const { drive, cb } of callbacks) drive.removeAfterUpdate(cb);
      callbacks.length = 0;
      for (const drive of drives) { drive.stop(); drive.dispose(); }
      drives.length = 0;
      root.parent?.remove(root);
      linkGeometry.dispose();
      linkMaterial.dispose();
    },
  };
}
