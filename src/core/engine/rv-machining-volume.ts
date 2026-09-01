// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-machining-volume.ts — the `MachiningVolume` component (plan-405).
 *
 * Port of `MachiningVolume.cs`: an SDF voxel grid that represents the workpiece
 * material. Tools listed here subtract material from it every fixed tick
 * (`result = max(workpiece, -sweptTool)`), and the changed 16³ chunks are
 * re-tessellated into per-chunk meshes.
 *
 * Division of labour (differs from Unity, on purpose):
 * - The GRID and all compute live in the private worker + `rv_csg.wasm`. This
 *   component never touches an SDF value; it sends tool poses and receives
 *   finished chunk geometry.
 * - This component owns the RENDER side: a `CsgChunks` child holding one
 *   `Mesh` per non-empty chunk, plus the visibility swap of the authored
 *   workpiece mesh.
 * - {@link MachiningManager} owns the per-tick driving and the provider.
 *
 * Three properties of this file are load-bearing and easy to break:
 *
 * 1. **Chunk geometry is allocated in ACTUAL size with 1.5× headroom**, never
 *    at the worst case. A worst-case allocation would be 64 chunks ×
 *    (65536 verts × 32 B + 4 B/index) ≈ 144 MiB *per 64³ volume*. Instead each
 *    chunk grows on demand and only the overflowing chunk is reallocated (old
 *    geometry disposed, `DynamicDrawUsage` + `setDrawRange` for the rest).
 * 2. **Every chunk owns its own attribute buffers.** Sharing them between
 *    chunks would turn a single `dispose()` into a dangling-GPU-buffer hazard
 *    for its neighbours.
 * 3. **The whole subtree is excluded from arena batching** via
 *    `EXCLUDED_SUBTREE_KEYS` in `rv-batched-render.ts` — the batcher bakes the
 *    HOME pose once, which would freeze the workpiece at its uncut state.
 *
 * Coordinate spaces: the kernel works in GRID space millimeters
 * (`grid = local_mm - gridOrigin_mm`), exactly as the native ABI does. Three.js
 * geometry is written back in volume-local METERS. Everything is derived from
 * the WEB-space matrices of the loaded GLB, so the Unity→glTF X flip needs no
 * special handling: volume, tools and stock all live in the same flipped frame
 * and the analytic tool SDFs are symmetric about their own axis.
 */

import {
  Box3, BufferAttribute, BufferGeometry, DynamicDrawUsage, Mesh, MeshStandardMaterial, Object3D, Vector3,
} from 'three';
import type { Material } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import { registerComponent, setComponentInstance, loadSchemaFromSpec } from './rv-component-registry';
import type { CollisionRoleRegistrar, StockBoundsSource } from './rv-collision-role';
import { MM_TO_METERS } from './rv-constants';
import {
  MACHINING_CHUNK_SIZE,
  type MachiningChunkMesh,
  type MachiningGridDesc,
  type MachiningGridHandle,
  type MachiningMeshingMode,
  type MachiningStockShape,
} from './rv-machining-registry';
import type { MachiningManager } from './rv-machining-manager';
import { RVMachiningTool } from './rv-machining-tool';

// ─── Enum helpers ───────────────────────────────────────────────────────

const STOCK_SHAPES: readonly MachiningStockShape[] = ['Box', 'Cylinder', 'Mesh'];
const MESHING_MODES: readonly MachiningMeshingMode[] = ['MarchingCubes', 'DualContouring'];
const CYLINDER_AXES = ['X', 'Y', 'Z'] as const;

export type MachiningCylinderAxis = (typeof CYLINDER_AXES)[number];

function toStockShape(v: unknown): MachiningStockShape {
  return typeof v === 'string' && (STOCK_SHAPES as readonly string[]).includes(v)
    ? (v as MachiningStockShape) : 'Box';
}

function toMeshingMode(v: unknown): MachiningMeshingMode {
  return typeof v === 'string' && (MESHING_MODES as readonly string[]).includes(v)
    ? (v as MachiningMeshingMode) : 'MarchingCubes';
}

function toCylinderAxis(v: unknown): MachiningCylinderAxis {
  return typeof v === 'string' && (CYLINDER_AXES as readonly string[]).includes(v)
    ? (v as MachiningCylinderAxis) : 'X';
}

/** Numeric axis value for the kernel (`rvc_init_cylinder`): 0 = X, 1 = Y, 2 = Z. */
export function cylinderAxisValue(axis: MachiningCylinderAxis): 0 | 1 | 2 {
  return axis === 'X' ? 0 : axis === 'Y' ? 1 : 2;
}

/** Growth factor applied when a chunk buffer has to be (re-)allocated. */
export const CHUNK_CAPACITY_HEADROOM = 1.5;

// ─── Chunk render slot ──────────────────────────────────────────────────

interface ChunkSlot {
  mesh: Mesh;
  geometry: BufferGeometry;
  /** Vertices the current attribute buffers can hold. */
  capacityVerts: number;
  /** Indices the current index buffer can hold. */
  capacityIndices: number;
}

// ─── Component ──────────────────────────────────────────────────────────

/** The `MachiningVolume` component. */
export class RVMachiningVolume implements RVComponent, StockBoundsSource {
  static readonly schema: ComponentSchema = loadSchemaFromSpec('MachiningVolume');

  readonly node: Object3D;
  isOwner = true;

  // ── Schema-populated (PascalCase/camelCase exactly as in C#) ─────────
  /** Voxel lattice resolution, incl. one padding voxel per side. */
  gridResolution = new Vector3(64, 64, 64);
  /** Workpiece size in mm. */
  workpieceSize = new Vector3(200, 100, 200);
  /** Stock shape. Read-only for the same reason as `MachiningTool.Shape`
   *  (the bare field name `Shape` is shared across components). */
  Shape: MachiningStockShape = 'Box';
  CylinderAxis: MachiningCylinderAxis = 'X';
  /** Resolved tool references, IN ORDER (the subtraction order matters). */
  Tools: unknown[] = [];
  /** Optional group name; tools carrying it are discovered additionally. */
  ToolGroup = '';
  SweepToolMotion = true;
  MaxSweepSubsteps = 16;
  Meshing: MachiningMeshingMode = 'MarchingCubes';
  /** Hard-edge threshold in degrees; <= 0 disables crease splitting. */
  CreaseAngle = 35;
  GenerateUVs = true;
  /** Seconds between statistics refreshes. */
  StatisticsInterval = 0.25;
  /** Unity-only in v1 — no Rapier collider rebuild happens in the browser. */
  UpdateCollider = false;

  // Signal slots (resolved to signal NAMES by the loader).
  SignalSpindleOn: string | null = null;
  SignalReset: string | null = null;
  SignalMachiningActive: string | null = null;

  // ── Runtime status (mirrors the Unity Inspector read-outs) ───────────
  MaterialRemainingPercent = 100;
  VoxelsModified = 0;
  IsInitialized = false;
  /** Chunks the worker still has to tessellate (from the last ack). */
  PendingChunkCount = 0;
  /** Jobs the worker still has to process (from the last ack). */
  PendingJobCount = 0;

  // ── Internals ────────────────────────────────────────────────────────
  private _ctx: ComponentContext | null = null;
  private _manager: MachiningManager | null = null;
  private _chunkRoot: Object3D | null = null;
  private _slots: Array<ChunkSlot | null> = [];
  private _material: Material | Material[] | null = null;
  /** Set only when the chunk material was rebuilt here and must be disposed. */
  private _ownedMaterial: MeshStandardMaterial | null = null;
  /** Authored meshes hidden while the machined chunks are shown. */
  private readonly _hiddenOriginals: Mesh[] = [];
  /** The volume node itself when it carries authored geometry — layer-masked
   *  rather than hidden, with the original mask kept for `teardownRender()`. */
  private readonly _maskedOriginals: Array<{ mesh: Mesh; mask: number }> = [];
  private _grid: MachiningGridHandle | null = null;
  /** Resolved tool components in subtraction order (explicit list first). */
  private readonly _tools: RVMachiningTool[] = [];
  /** Collision seam (plan-409 F4) — null when no collision manager exists. */
  private _collision: CollisionRoleRegistrar | null = null;
  /** Cached stock extent in LOCAL meters; rebuilt on attach/teardown only. */
  private _stockBoundsLocal: Box3 | null = null;
  private _stockBoundsDirty = true;

  constructor(node: Object3D) {
    this.node = node;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  init(ctx: ComponentContext): void {
    this._ctx = ctx;
    this.Shape = toStockShape(this.Shape);
    this.Meshing = toMeshingMode(this.Meshing);
    this.CylinderAxis = toCylinderAxis(this.CylinderAxis);
    this.gridResolution = sanitizeResolution(this.gridResolution);
    this.workpieceSize = sanitizeSize(this.workpieceSize);
    this._stockBoundsDirty = true;
    // plan-409 F4: announce ourselves as the live extent of whatever collision
    // body owns this node, BEFORE any grid exists — `getStockBoundsLocal()`
    // answers `null` until then, so the authored meshes keep speaking.
    this._collision = ctx.collisionManager ?? null;
    this._collision?.registerStockBounds?.(this);
  }

  /**
   * Second pass — runs AFTER the Kinematic re-parenting so tool nodes sit in
   * their final hierarchy position. Tool discovery and the grid request both
   * belong here, not in `init()`.
   */
  onSceneReady(ctx: ComponentContext): void {
    this._ctx = ctx;
    this.resolveTools();
    this._manager = ctx.machiningManager ?? null;
    this._manager?.register(this);
  }

  dispose(): void {
    this._manager?.unregister(this);
    this._manager = null;
    this.teardownRender();
    this._collision?.unregisterStockBounds?.(this);
    this._collision = null;
    this._tools.length = 0;
    this._ctx = null;
  }

  // ── Tool discovery (F7) ──────────────────────────────────────────────

  /**
   * Resolves the ORDERED `Tools` list plus the optional `ToolGroup` scan.
   *
   * The wire format is pinned by the Unity export test `TestGlbMachiningExport`
   * (plan-430 F2): a JSON array in LIST order whose entries are
   * `ComponentReference` objects (path + componentType + componentIndex), with
   * dropped/out-of-hierarchy references kept as POSITIONAL nulls. By the time
   * this method runs, `resolveComponentRefs()` has already turned each entry
   * into one of exactly three shapes — a registered component instance
   * (`RVMachiningTool`), a resolved `Object3D` node, or the raw path string
   * when resolution failed — so the three branches below are the resolver's
   * contract, not leftover tolerance for an unverified exporter. Order is
   * preserved throughout, because the subtraction result depends on it.
   */
  resolveTools(): void {
    this._tools.length = 0;
    const registry = this._ctx?.registry;
    const seen = new Set<RVMachiningTool>();

    const push = (tool: RVMachiningTool | null | undefined): void => {
      if (!tool || seen.has(tool)) return;
      seen.add(tool);
      this._tools.push(tool);
    };

    for (const entry of this.Tools ?? []) {
      push(this.toolFromRef(entry));
    }

    // ToolGroup scan — additional, never replacing the explicit list.
    const group = (this.ToolGroup ?? '').trim();
    if (group && registry) {
      for (const { instance } of registry.getAll<RVMachiningTool>('MachiningTool')) {
        if (!(instance instanceof RVMachiningTool)) continue;
        if (nodeHasGroup(instance.node, group, registry)) push(instance);
      }
    }
  }

  /** Best-effort resolution of one `Tools` entry into its component. */
  private toolFromRef(entry: unknown): RVMachiningTool | null {
    if (!entry) return null;
    if (entry instanceof RVMachiningTool) return entry;

    const registry = this._ctx?.registry;
    // Resolved node reference (the expected shape for a Unity Transform/
    // component reference that the loader could resolve).
    if (typeof entry === 'object' && (entry as Object3D).isObject3D) {
      const node = entry as Object3D;
      const inst = node.userData?._rvComponentInstance;
      if (inst instanceof RVMachiningTool) return inst;
      const path = registry?.getPathForNode(node);
      if (path && registry) {
        for (const [type, i] of registry.getComponentsAt(path)) {
          if (type === 'MachiningTool' && i instanceof RVMachiningTool) return i;
        }
      }
      return null;
    }
    // Unresolved path string (the loader's fallback for a componentRefArray).
    if (typeof entry === 'string' && registry) {
      const node = registry.getNode(entry);
      const inst = node?.userData?._rvComponentInstance;
      if (inst instanceof RVMachiningTool) return inst;
      for (const [type, i] of registry.getComponentsAt(entry)) {
        if (type === 'MachiningTool' && i instanceof RVMachiningTool) return i;
      }
    }
    return null;
  }

  /** Tools in subtraction order — read by the manager every tick. */
  get tools(): readonly RVMachiningTool[] {
    return this._tools;
  }

  // ── Grid description ─────────────────────────────────────────────────

  /**
   * Builds the {@link MachiningGridDesc} for this workpiece. `Shape === 'Mesh'`
   * uses the node's OWN render geometry (WYSIWYG) — the Unity `StockMesh`
   * reference is blocked by the serializer and is a documented v1 gap.
   */
  buildGridDesc(): MachiningGridDesc {
    const desc: MachiningGridDesc = {
      resolution: { x: this.gridResolution.x, y: this.gridResolution.y, z: this.gridResolution.z },
      sizeMm: { x: this.workpieceSize.x, y: this.workpieceSize.y, z: this.workpieceSize.z },
      shape: this.Shape,
      cylinderAxis: cylinderAxisValue(this.CylinderAxis),
      meshing: this.Meshing,
      creaseAngleDeg: this.CreaseAngle,
    };
    if (this.Shape !== 'Mesh') return desc;

    const stock = this.collectStockGeometry();
    if (!stock) {
      // Parity with the C# warning path: fall back to Box stock rather than
      // failing the whole volume.
      console.warn(
        `[machining] "${this.node.name}" has Shape=Mesh but no usable render geometry — falling back to Box stock.`,
      );
      desc.shape = 'Box';
      return desc;
    }
    desc.meshVerticesMm = stock.vertices;
    desc.meshTriangles = stock.triangles;
    desc.meshBoundsMinMm = stock.boundsMinMm;
    desc.meshBoundsSizeMm = stock.boundsSizeMm;
    return desc;
  }

  /**
   * Flattens the node's own meshes into ONE volume-local millimeter triangle
   * soup. Non-indexed geometry gets a synthetic index list; sub-meshes are
   * concatenated with rebased indices.
   */
  private collectStockGeometry(): {
    vertices: Float32Array; triangles: Int32Array;
    boundsMinMm: { x: number; y: number; z: number };
    boundsSizeMm: { x: number; y: number; z: number };
  } | null {
    const meshes = this.ownMeshes();
    if (meshes.length === 0) return null;

    const positions: number[] = [];
    const indices: number[] = [];
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const v = new Vector3();

    this.node.updateWorldMatrix(true, false);
    for (const mesh of meshes) {
      const pos = mesh.geometry?.getAttribute('position');
      if (!pos) continue;
      const base = positions.length / 3;
      mesh.updateWorldMatrix(true, false);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos as BufferAttribute, i);
        if (mesh !== this.node) {
          // Bring child geometry into the volume's own local frame.
          mesh.localToWorld(v);
          this.node.worldToLocal(v);
        }
        const x = v.x * MM_TO_METERS;
        const y = v.y * MM_TO_METERS;
        const z = v.z * MM_TO_METERS;
        positions.push(x, y, z);
        if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
        if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
        if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
      }
      const idx = mesh.geometry.getIndex();
      if (idx) {
        for (let i = 0; i < idx.count; i++) indices.push(base + idx.getX(i));
      } else {
        for (let i = 0; i < pos.count; i++) indices.push(base + i);
      }
    }

    // The kernel rejects degenerate input (< 4 verts / < 12 indices) with -2.
    if (positions.length < 12 || indices.length < 12) return null;

    return {
      vertices: new Float32Array(positions),
      triangles: new Int32Array(indices),
      boundsMinMm: { x: min[0], y: min[1], z: min[2] },
      boundsSizeMm: { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] },
    };
  }

  /** Authored meshes belonging to this volume (excluding the chunk root). */
  private ownMeshes(): Mesh[] {
    const out: Mesh[] = [];
    this.node.traverse((child) => {
      if (this._chunkRoot && (child === this._chunkRoot || isDescendantOf(child, this._chunkRoot))) return;
      const mesh = child as Mesh;
      if (mesh.isMesh && mesh.geometry) out.push(mesh);
    });
    return out;
  }

  // ── Render side ──────────────────────────────────────────────────────

  /**
   * Called by the manager once the worker reported the grid. Hides the
   * authored workpiece mesh and prepares the (still empty) chunk slots.
   */
  attachGrid(grid: MachiningGridHandle): void {
    this._grid = grid;
    this.IsInitialized = true;
    this.MaterialRemainingPercent = 100;
    this.VoxelsModified = 0;
    // plan-409 F4 — from this line on the authored workpiece is hidden and
    // `getStockBoundsLocal()` starts answering. The bodies are rebuilt so the
    // stock provider is picked up even if it was registered after the last one.
    this._stockBoundsDirty = true;
    this._collision?.invalidate();

    if (!this._chunkRoot) {
      // Capture the workpiece material BEFORE hiding the originals.
      const originals = this.ownMeshes();
      this._material = this.chunkMaterialFrom(originals[0] ?? null);
      for (const mesh of originals) {
        if (!mesh.visible) continue;
        if (mesh === this.node) {
          // The chunk root is added as a CHILD of this node, and three.js
          // visibility is hierarchical — `visible = false` here would take the
          // chunks down with it and leave the workpiece invisible for good.
          // Clearing the layer mask drops the authored geometry from rendering
          // and raycasting without touching the children, which carry their own.
          this._maskedOriginals.push({ mesh, mask: mesh.layers.mask });
          mesh.layers.mask = 0;
          continue;
        }
        mesh.visible = false;
        this._hiddenOriginals.push(mesh);
      }
      const root = new Object3D();
      root.name = 'CsgChunks';
      root.userData._rvMachiningChunks = true;
      this.node.add(root);
      this._chunkRoot = root;
    }
    if (this._slots.length !== grid.chunkCount) {
      this.disposeSlots();
      this._slots = new Array<ChunkSlot | null>(grid.chunkCount).fill(null);
    }
  }

  /**
   * The material the chunk meshes render with, derived from the authored
   * workpiece mesh.
   *
   * The authored mesh may already have been swapped onto the shared uber
   * material (`rv-uber-material.ts`), which reads base color, roughness and
   * metalness from the per-vertex `color`/`rmPacked` attributes the bake wrote
   * into ITS geometry. Chunk geometry comes from the CSG kernel and carries no
   * such attributes, so handing the uber material straight through renders every
   * chunk black. Un-baking those two attributes back into a plain standard
   * material is the one place that knows both sides — and it costs a single
   * material for the volume's whole lifetime.
   */
  private chunkMaterialFrom(mesh: Mesh | null): Material | Material[] | null {
    const mat = mesh?.material ?? null;
    if (!mesh || !mat || Array.isArray(mat)) return mat;
    if (mesh.userData?._rvUberBaked !== true) return mat;

    const unbaked = new MeshStandardMaterial();
    if (mat instanceof MeshStandardMaterial) unbaked.copy(mat);
    unbaked.name = `${mesh.name || 'Workpiece'}_csg`;
    unbaked.vertexColors = false;

    const color = mesh.geometry.getAttribute('color');
    if (color && color.count > 0) {
      // Uint8-normalized linear RGB, uniform across the mesh — vertex 0 is it.
      unbaked.color.setRGB(color.getX(0), color.getY(0), color.getZ(0));
    }
    const rm = mesh.geometry.getAttribute('rmPacked');
    if (rm && rm.count > 0) {
      unbaked.roughness = rm.getX(0);
      unbaked.metalness = rm.getY(0);
    }
    this._ownedMaterial = unbaked;
    return unbaked;
  }

  /** The grid handle, or null while no grid exists. */
  get grid(): MachiningGridHandle | null {
    return this._grid;
  }

  // ── Stock extent for collision detection (plan-409 F4) ───────────────

  /**
   * IMPLEMENTS StockBoundsSource::getStockBoundsLocal
   *
   * The stock domain as a box in THIS NODE'S OWN LOCAL SPACE, in three.js units
   * (meters). The caller multiplies it by `node.matrixWorld`, which is what
   * keeps it correct under rotation and non-uniform scale — the box is never
   * pre-transformed here.
   *
   * `null` while no grid is attached: the authored workpiece mesh is visible
   * then and represents the material itself, with full triangle precision. From
   * `attachGrid()` to `teardownRender()` the authored mesh is HIDDEN and the
   * chunk meshes that replace it are excluded from every collision body — this
   * box is the only thing left standing in for the workpiece.
   *
   * Two deliberate properties:
   *
   * - **It is the full stock, and it does not shrink as material is removed.**
   *   Following the machined surface would mean re-deriving a box from the chunk
   *   meshes every tick. For crash monitoring the conservative direction is the
   *   safe one: a cutter that has entered the *original* stock envelope is
   *   reported unless its machining association mutes it.
   * - **It includes the grid padding**, i.e. it is the LATTICE extent, not the
   *   nominal workpiece size. That is the region the kernel can hold material
   *   in, and it is the region the chunk meshes are drawn in.
   */
  getStockBoundsLocal(): Box3 | null {
    if (!this.IsInitialized) return null;
    if (this._stockBoundsDirty) {
      this._stockBoundsDirty = false;
      this._stockBoundsLocal = this.computeStockBoundsLocal();
    }
    return this._stockBoundsLocal;
  }

  /**
   * Shape-aware derivation of the LATTICE extent from the authored
   * configuration, mirroring `CsgKernel.computeGeometry`:
   * `voxel = domain / (res - 3)`, origin at `domainMin - 1.5·voxel`.
   *
   * Derived from the configuration rather than read off the grid handle, so
   * there is exactly ONE code path — a box that only existed once a handle
   * happened to be attached would be a second, rarely-exercised behaviour.
   * `sanitizeResolution()` clamps the resolution to the same 4..256 range the
   * kernel does, so the two arrive at identical numbers.
   *
   * The padding is applied symmetrically (1.5 voxels on both sides). The true
   * lattice ends half a voxel earlier on the max side; erring outward is the
   * safe direction for crash monitoring.
   */
  private computeStockBoundsLocal(): Box3 {
    const domain = this.stockDomainMm();
    const res = this.gridResolution;
    const vx = domain.sizeX / Math.max(1, res.x - 3);
    const vy = domain.sizeY / Math.max(1, res.y - 3);
    const vz = domain.sizeZ / Math.max(1, res.z - 3);
    return boxFromMm(
      domain.minX - 1.5 * vx, domain.minY - 1.5 * vy, domain.minZ - 1.5 * vz,
      domain.minX + domain.sizeX + 1.5 * vx,
      domain.minY + domain.sizeY + 1.5 * vy,
      domain.minZ + domain.sizeZ + 1.5 * vz,
    );
  }

  /**
   * The stock DOMAIN in volume-local millimeters, before grid padding.
   *
   * `Box` and `Cylinder` share the domain box `workpieceSize` centered on the
   * node: the cylinder is inscribed in it, so the box bounds it correctly
   * without depending on the kernel's radius convention.
   *
   * `Mesh` takes the AABB of the node's own render geometry — and falls back to
   * the `Box` domain when there is none, which is exactly what
   * {@link buildGridDesc} does in that case (it warns and switches the desc to
   * `Box`). Anything else would hand back a box that does not describe the
   * material the kernel actually built.
   */
  private stockDomainMm(): {
    minX: number; minY: number; minZ: number;
    sizeX: number; sizeY: number; sizeZ: number;
  } {
    const boxDomain = (): {
      minX: number; minY: number; minZ: number;
      sizeX: number; sizeY: number; sizeZ: number;
    } => {
      const s = this.workpieceSize;
      return {
        minX: -s.x * 0.5, minY: -s.y * 0.5, minZ: -s.z * 0.5,
        sizeX: s.x, sizeY: s.y, sizeZ: s.z,
      };
    };
    if (this.Shape !== 'Mesh') return boxDomain();
    const local = this.authoredMeshBoundsLocal();
    if (!local) return boxDomain();
    return {
      minX: local.min.x * MM_TO_METERS,
      minY: local.min.y * MM_TO_METERS,
      minZ: local.min.z * MM_TO_METERS,
      sizeX: (local.max.x - local.min.x) * MM_TO_METERS,
      sizeY: (local.max.y - local.min.y) * MM_TO_METERS,
      sizeZ: (local.max.z - local.min.z) * MM_TO_METERS,
    };
  }

  /**
   * AABB of the node's own (authored) meshes in volume-local METERS.
   * Uses the cached `geometry.boundingBox` per mesh rather than the full
   * triangle soup of `collectStockGeometry()` — a box is all that is needed.
   */
  private authoredMeshBoundsLocal(): Box3 | null {
    const meshes = this.ownMeshes();
    if (meshes.length === 0) return null;
    const out = new Box3();
    const scratch = new Box3();
    this.node.updateWorldMatrix(true, false);
    const toLocal = this.node.matrixWorld.clone().invert();
    for (const mesh of meshes) {
      const geo = mesh.geometry;
      if (!geo) continue;
      if (!geo.boundingBox) geo.computeBoundingBox();
      if (!geo.boundingBox) continue;
      mesh.updateWorldMatrix(true, false);
      scratch.copy(geo.boundingBox).applyMatrix4(mesh.matrixWorld).applyMatrix4(toLocal);
      out.union(scratch);
    }
    return out.isEmpty() ? null : out;
  }

  /** Chunk container (null before the first grid). Test/diagnostics hook. */
  get chunkRoot(): Object3D | null {
    return this._chunkRoot;
  }

  /** Live chunk meshes (diagnostics/tests). */
  get chunkMeshCount(): number {
    let n = 0;
    for (const s of this._slots) if (s) n++;
    return n;
  }

  /**
   * Uploads one tessellated chunk. Returns true when anything visible changed
   * (the manager turns that into render + shadow dirty).
   */
  applyChunk(chunk: MachiningChunkMesh): boolean {
    const grid = this._grid;
    if (!grid) return false;
    if (chunk.chunkIndex < 0 || chunk.chunkIndex >= this._slots.length) return false;

    const existing = this._slots[chunk.chunkIndex];

    // Empty chunk: keep the slot but hide it (no geometry churn while a cut
    // sweeps back and forth across a chunk boundary).
    if (chunk.vertexCount === 0 || chunk.indexCount === 0) {
      if (!existing) return false;
      if (!existing.mesh.visible) return false;
      existing.mesh.visible = false;
      existing.geometry.setDrawRange(0, 0);
      return true;
    }

    const slot = this.ensureSlotCapacity(chunk, existing);
    const geo = slot.geometry;

    const posAttr = geo.getAttribute('position') as BufferAttribute;
    const nrmAttr = geo.getAttribute('normal') as BufferAttribute;
    const uvAttr = geo.getAttribute('uv') as BufferAttribute | undefined;
    const idxAttr = geo.getIndex() as BufferAttribute;

    // Both sides must still own their buffers, and the check must run BEFORE
    // the position loop: indexed writes into a detached view are silent no-ops
    // per spec, so a late check would let half-written chunks through and only
    // the final `.set()` would throw (debug-025). A detached side names the
    // culprit here instead of surfacing as a bare V8 TypeError.
    const detachedSide = firstDetachedSide(chunk, posAttr, nrmAttr, uvAttr, idxAttr);
    if (detachedSide) {
      console.error(
        `[machining] "${this.node.name}" chunk ${chunk.chunkIndex} dropped — ${detachedSide} `
        + 'buffer is detached (something transferred it away); see docs/debug/debug-025.',
      );
      return false;
    }

    // Grid-space mm → volume-local meters (parity with CsgMeshBuilder).
    const posArr = posAttr.array as Float32Array;
    const ox = grid.gridOriginMm.x;
    const oy = grid.gridOriginMm.y;
    const oz = grid.gridOriginMm.z;
    const src = chunk.positions;
    for (let i = 0, n = chunk.vertexCount * 3; i < n; i += 3) {
      posArr[i] = (src[i] + ox) / MM_TO_METERS;
      posArr[i + 1] = (src[i + 1] + oy) / MM_TO_METERS;
      posArr[i + 2] = (src[i + 2] + oz) / MM_TO_METERS;
    }
    (nrmAttr.array as Float32Array).set(chunk.normals.subarray(0, chunk.vertexCount * 3));
    if (uvAttr) (uvAttr.array as Float32Array).set(chunk.uvs.subarray(0, chunk.vertexCount * 2));
    (idxAttr.array as Uint32Array).set(chunk.indices.subarray(0, chunk.indexCount));

    posAttr.needsUpdate = true;
    nrmAttr.needsUpdate = true;
    if (uvAttr) uvAttr.needsUpdate = true;
    idxAttr.needsUpdate = true;

    geo.setDrawRange(0, chunk.indexCount);
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    slot.mesh.visible = true;
    return true;
  }

  /**
   * Returns a slot whose buffers hold `chunk`, reallocating (and disposing the
   * old geometry) ONLY when the incoming counts overflow. New capacity is
   * `count × 1.5`, so a growing cut re-allocates O(log n) times, not per tick.
   */
  private ensureSlotCapacity(chunk: MachiningChunkMesh, existing: ChunkSlot | null): ChunkSlot {
    if (existing
      && existing.capacityVerts >= chunk.vertexCount
      && existing.capacityIndices >= chunk.indexCount) {
      return existing;
    }

    const capVerts = Math.max(
      Math.ceil(chunk.vertexCount * CHUNK_CAPACITY_HEADROOM),
      existing?.capacityVerts ?? 0,
      1,
    );
    const capIdx = Math.max(
      Math.ceil(chunk.indexCount * CHUNK_CAPACITY_HEADROOM),
      existing?.capacityIndices ?? 0,
      3,
    );

    const geo = new BufferGeometry();
    const position = new BufferAttribute(new Float32Array(capVerts * 3), 3);
    const normal = new BufferAttribute(new Float32Array(capVerts * 3), 3);
    const index = new BufferAttribute(new Uint32Array(capIdx), 1);
    position.setUsage(DynamicDrawUsage);
    normal.setUsage(DynamicDrawUsage);
    index.setUsage(DynamicDrawUsage);
    geo.setAttribute('position', position);
    geo.setAttribute('normal', normal);
    if (this.GenerateUVs) {
      const uv = new BufferAttribute(new Float32Array(capVerts * 2), 2);
      uv.setUsage(DynamicDrawUsage);
      geo.setAttribute('uv', uv);
    }
    geo.setIndex(index);

    let mesh = existing?.mesh;
    if (mesh) {
      // Reallocation of an existing chunk: swap the geometry, dispose the old
      // one exactly once. The Mesh object (and its material binding) survives.
      existing!.geometry.dispose();
      mesh.geometry = geo;
    } else {
      mesh = new Mesh(geo, this._material ?? undefined);
      mesh.name = `Chunk_${chunk.chunkIndex}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData._rvMachiningChunk = chunk.chunkIndex;
      // The BVH worker TRANSFERS position/index buffers for the duration of a
      // build — a geometry rewritten every tick must never enter that path
      // (detached-target crash, debug-025), and a boundsTree on it would be
      // stale from the next tick anyway.
      mesh.userData._rvSkipBVH = true;
      this._chunkRoot?.add(mesh);
    }

    const slot: ChunkSlot = { mesh, geometry: geo, capacityVerts: capVerts, capacityIndices: capIdx };
    this._slots[chunk.chunkIndex] = slot;
    return slot;
  }

  /** Hides every chunk (used by the reset barrier before the rebuild lands). */
  hideAllChunks(): void {
    for (const slot of this._slots) {
      if (!slot) continue;
      slot.mesh.visible = false;
      slot.geometry.setDrawRange(0, 0);
    }
  }

  /** Disposes every chunk geometry exactly once and drops the chunk root. */
  teardownRender(): void {
    this.disposeSlots();
    if (this._chunkRoot) {
      this._chunkRoot.removeFromParent();
      this._chunkRoot = null;
    }
    for (const mesh of this._hiddenOriginals) mesh.visible = true;
    this._hiddenOriginals.length = 0;
    for (const entry of this._maskedOriginals) entry.mesh.layers.mask = entry.mask;
    this._maskedOriginals.length = 0;
    this._material = null;
    this._ownedMaterial?.dispose();
    this._ownedMaterial = null;
    this._grid = null;
    this.IsInitialized = false;
    this.PendingChunkCount = 0;
    this.PendingJobCount = 0;
    // plan-409 F4 — the authored meshes are visible again (and back in the
    // body, with their BVHs), so the stock box must stop standing in for them.
    // `getStockBoundsLocal()` returns null from here, which alone is enough:
    // the collision manager reads it per tick. The invalidate() is for the
    // meshes themselves, whose `boundsTree`s restore triangle precision.
    this._stockBoundsLocal = null;
    this._stockBoundsDirty = true;
    this._collision?.invalidate();
  }

  private disposeSlots(): void {
    for (let i = 0; i < this._slots.length; i++) {
      const slot = this._slots[i];
      if (!slot) continue;
      slot.mesh.removeFromParent();
      slot.geometry.dispose();
      this._slots[i] = null;
    }
    this._slots.length = 0;
  }

  // ── Inspector integration ────────────────────────────────────────────

  getLiveState(): Record<string, unknown> {
    return {
      MaterialRemainingPercent: round2(this.MaterialRemainingPercent),
      VoxelsModified: this.VoxelsModified,
      IsInitialized: this.IsInitialized,
      PendingChunkCount: this.PendingChunkCount,
    };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Box from volume-local MILLIMETERS into the local METERS the scene uses. */
function boxFromMm(
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
): Box3 {
  const k = 1 / MM_TO_METERS;
  return new Box3(
    new Vector3(minX * k, minY * k, minZ * k),
    new Vector3(maxX * k, maxY * k, maxZ * k),
  );
}

/** `ArrayBuffer.prototype.detached` is ES2024 — fall back to the length. */
function isDetached(buf: ArrayBufferLike): boolean {
  const detached = (buf as { detached?: boolean }).detached;
  return detached === true || (detached === undefined && buf.byteLength === 0);
}

/**
 * Names the first detached buffer among a chunk upload's sources and targets,
 * or null when all are intact. Target buffers can detach when another
 * subsystem transfers them to a worker (the BVH build port moves position +
 * index for the duration of a build, debug-025); sources only if something
 * re-transfers a received batch.
 */
function firstDetachedSide(
  chunk: MachiningChunkMesh,
  posAttr: BufferAttribute,
  nrmAttr: BufferAttribute,
  uvAttr: BufferAttribute | undefined,
  idxAttr: BufferAttribute,
): string | null {
  if (isDetached(chunk.positions.buffer)) return 'source position';
  if (isDetached(chunk.normals.buffer)) return 'source normal';
  if (isDetached(chunk.uvs.buffer)) return 'source uv';
  if (isDetached(chunk.indices.buffer)) return 'source index';
  if (isDetached((posAttr.array as Float32Array).buffer)) return 'target position';
  if (isDetached((nrmAttr.array as Float32Array).buffer)) return 'target normal';
  if (uvAttr && isDetached((uvAttr.array as Float32Array).buffer)) return 'target uv';
  if (isDetached((idxAttr.array as Uint32Array).buffer)) return 'target index';
  return null;
}

function isDescendantOf(node: Object3D, ancestor: Object3D): boolean {
  let p: Object3D | null = node.parent;
  while (p) {
    if (p === ancestor) return true;
    p = p.parent;
  }
  return false;
}

/**
 * Clamps the authored grid resolution. `>= 4` keeps at least two interior
 * voxels next to the padding layer (parity with `MachiningVolume.Start`), and
 * the upper bound guards against an authoring typo turning into a
 * multi-gigabyte allocation request (256³ × 4 B = 64 MiB is already the
 * documented ceiling on the Unity side).
 */
function sanitizeResolution(v: Vector3): Vector3 {
  const clamp = (n: number): number => {
    const i = Math.round(Number.isFinite(n) ? n : 64);
    return Math.min(256, Math.max(4, i));
  };
  return new Vector3(clamp(v?.x ?? 64), clamp(v?.y ?? 64), clamp(v?.z ?? 64));
}

/** Clamps the workpiece size to >= 1 mm per axis (parity with the C# guard). */
function sanitizeSize(v: Vector3): Vector3 {
  const clamp = (n: number): number => (Number.isFinite(n) ? Math.max(1, Math.abs(n)) : 1);
  return new Vector3(clamp(v?.x ?? 200), clamp(v?.y ?? 100), clamp(v?.z ?? 200));
}

/**
 * True when the node carries a `Group` / `Group_N` extras entry resolving to
 * `groupName`. Reads the raw rv_extras instead of the GroupRegistry, which is
 * owned by the viewer and not reachable from a component context. Mirrors the
 * prefix resolution of `buildGroups()`.
 */
function nodeHasGroup(
  node: Object3D,
  groupName: string,
  registry: { getNode(path: string): Object3D | null },
): boolean {
  const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
  if (!rv) return false;
  for (const key of Object.keys(rv)) {
    if (key !== 'Group' && !/^Group_\d+$/.test(key)) continue;
    const data = rv[key] as Record<string, unknown> | undefined;
    if (!data || data['_enabled'] === false) continue;
    const name = data['GroupName'];
    if (typeof name !== 'string' || !name) continue;
    const prefix = data['GroupNamePrefix'];
    let resolved = name;
    if (typeof prefix === 'string' && prefix) {
      const prefixNode = registry.getNode(prefix);
      if (prefixNode) resolved = prefixNode.name + name;
    }
    if (resolved === groupName) return true;
  }
  return false;
}

/** Chunk lattice resolution for a grid resolution (ceil division by 16). */
export function chunkResolutionFor(res: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const c = MACHINING_CHUNK_SIZE;
  return {
    x: Math.ceil(res.x / c),
    y: Math.ceil(res.y / c),
    z: Math.ceil(res.z / c),
  };
}

// ─── Self-register ──────────────────────────────────────────────────────

registerComponent({
  type: 'MachiningVolume',
  displayName: 'Machining Volume',
  schema: RVMachiningVolume.schema,
  capabilities: {
    authorable: true,
    hoverable: true,
    selectable: true,
    badgeColor: '#26a69a',
    filterLabel: 'Machining Volumes',
  },
  create: (node) => new RVMachiningVolume(node),
  afterCreate: (inst, node) => setComponentInstance(node, inst),
});
