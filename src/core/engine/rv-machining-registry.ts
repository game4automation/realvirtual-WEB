// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-machining-registry.ts — Public interface + registry for the optional CSG
 * material-removal (machining) provider (plan-405).
 *
 * The compute kernel (`rv_csg.wasm`, the same Rust crate that produces the
 * Unity `rv_csg.dll`) is a PRIVATE provider that registers here from the
 * private side. When absent — the default for every open-source / public
 * deployment, and for any browser without Web Worker support — the registry's
 * `provider` is `null`, `MachiningVolume` leaves the authored workpiece mesh
 * visible and nothing is machined (F10). No crash, no fallback compute: there
 * is exactly ONE compute path (the worker) by design, because a synchronous
 * main-thread fallback would blow the < 0.5 ms per-tick budget it is supposed
 * to protect.
 *
 * Contract rules (mirrors `rv-physics-registry.ts` / `rv-ik-solver.ts`):
 * - This module must never import Three.js, the WASM, or a URL. The types below
 *   are lean structural records so the public bundle grows by a few KB only and
 *   no artifact crosses the public/private seam.
 * - `register(provider | null)`; `null` returns to the strict no-op state.
 * - Providers carry their own `ready` / `failed` latches. `failed` is permanent:
 *   a WASM trap (there is no `catch_unwind` on wasm32) can leave the linear
 *   memory in an undefined state, so the only safe reaction is to stay off.
 *
 * All distances are MILLIMETERS in VOLUME-LOCAL space unless a field says
 * "grid space" — grid space is `local - gridOrigin`, i.e. grid point (0,0,0)
 * sits at coordinate 0. This is exactly the convention of the native ABI
 * (`realvirtualReleaseDLLs/rv-csg/ABI.md`), so the same numbers flow from
 * Unity, from the DLL and from the browser into the identical kernel code.
 */

// ─── Lean structural types (no Three.js in the provider contract) ──────────

/** Cartesian vector, millimeters unless stated otherwise. */
export interface MachiningVec3 { x: number; y: number; z: number }

/** Quaternion in Unity component order (x, y, z, w). */
export interface MachiningQuat { x: number; y: number; z: number; w: number }

/** Integer triple (grid resolution / chunk resolution). */
export interface MachiningInt3 { x: number; y: number; z: number }

/** Stock shape of the workpiece — the SDF material, not the display mesh. */
export type MachiningStockShape = 'Box' | 'Cylinder' | 'Mesh';

/** Surface extraction algorithm (parity with the C# `MeshingMode` enum). */
export type MachiningMeshingMode = 'MarchingCubes' | 'DualContouring';

/**
 * Tool shape, encoded as the integer the kernel expects. Parity with the C#
 * `ToolShape` enum — the numeric values are part of the ABI, do not reorder.
 */
export const TOOL_SHAPE = {
  Sphere: 0,
  Cylinder: 1,
  BallNose: 2,
  Torus: 3,
  ConicalEnd: 4,
} as const;

/** Numeric tool-shape value as passed to `rvc_subtract`. */
export type MachiningToolShape = (typeof TOOL_SHAPE)[keyof typeof TOOL_SHAPE];

// ─── Kernel constants shared by provider, worker and components ────────────

/** Edge length of one dirty/tessellation chunk in voxels (kernel constant). */
export const MACHINING_CHUNK_SIZE = 16;

/**
 * Chunks tessellated per kernel call = the per-frame rebuild budget. Parity
 * with `CsgKernel.TESSELLATE_BATCH` (Unity) so both sides drain a large reset
 * rebuild over the same number of frames.
 */
export const MACHINING_TESSELLATE_BATCH = 16;

/**
 * Maximum vertices per tessellation slot. Parity with
 * `CsgKernel.SLOT_STRIDE_VERTS` (16³ cubes × 15 verts = 61,440, rounded up).
 */
export const MACHINING_SLOT_STRIDE_VERTS = 65536;

/**
 * Maximum unacknowledged subtract jobs per grid. Beyond this the provider
 * rejects with `reason: 'backlog'` and the manager coalesces the rejected
 * tick's segments into the FRONT of the next job (see {@link SubtractJob}).
 */
export const MACHINING_MAX_PENDING_JOBS = 8;

/**
 * Hard cap on segments carried by ONE coalesced job. Up to this many segments
 * the coalescing is volume-equivalent to the un-coalesced tick sequence (every
 * intermediate pose survives as its own segment). Above the cap the worker
 * degrades deterministically by reducing per-segment substeps — lossy, and
 * documented as such.
 */
export const MACHINING_MAX_SEGMENTS_PER_JOB = 64;

// ─── Grid / job / ack payloads ─────────────────────────────────────────────

/** Everything the worker needs to build one SDF grid. */
export interface MachiningGridDesc {
  /** Voxel lattice resolution, including one padding voxel per side. */
  resolution: MachiningInt3;
  /** Workpiece size in mm (Box/Cylinder domain; ignored for a mesh stock). */
  sizeMm: MachiningVec3;
  shape: MachiningStockShape;
  /** Cylinder axis: 0 = X, 1 = Y, 2 = Z. */
  cylinderAxis: 0 | 1 | 2;
  /** `Shape === 'Mesh'`: xyz-interleaved vertices in volume-local mm. */
  meshVerticesMm?: Float32Array;
  /** `Shape === 'Mesh'`: triangle indices into `meshVerticesMm`. */
  meshTriangles?: Int32Array;
  /** `Shape === 'Mesh'`: AABB minimum of the stock geometry in local mm. */
  meshBoundsMinMm?: MachiningVec3;
  /** `Shape === 'Mesh'`: AABB size of the stock geometry in local mm. */
  meshBoundsSizeMm?: MachiningVec3;
  meshing: MachiningMeshingMode;
  /** Hard-edge threshold in degrees; <= 0 disables crease splitting. */
  creaseAngleDeg: number;
}

/**
 * Opaque grid handle plus the derived lattice geometry the renderer needs to
 * place the chunk meshes. The worker computes voxel size and origin with the
 * exact half-voxel offset of `MachiningVolume.InitializeGrid` so the web mesh
 * lands where Unity puts it.
 */
export interface MachiningGridHandle {
  /** Provider-unique id (also used to route acks/batches). */
  readonly id: number;
  readonly resolution: MachiningInt3;
  /** Chunk lattice = ceil(resolution / 16). */
  readonly chunkResolution: MachiningInt3;
  readonly chunkCount: number;
  readonly voxelSizeMm: MachiningVec3;
  /** Local-space position of grid point (0,0,0) in mm. */
  readonly gridOriginMm: MachiningVec3;
  readonly totalVoxels: number;
  /** Solid voxel count right after initialization (statistics baseline). */
  readonly initialSolidVoxels: number;
}

/**
 * ONE swept tool motion. A job's segments are applied in order as sequential
 * `rvc_subtract` tool entries — which is why a coalesced backlog keeps a
 * curved path curved: A→B→C stays two segments, it never collapses to the
 * chord A→C.
 *
 * Positions are in GRID SPACE millimeters, rotations are grid-local.
 */
export interface MachiningToolSegment {
  posStart: MachiningVec3;
  posEnd: MachiningVec3;
  rotStart: MachiningQuat;
  rotEnd: MachiningQuat;
  /** Poses sampled along the motion (>= 1; 1 = end pose only). */
  substeps: number;
  /** Tool radius in mm (half the diameter). */
  radius: number;
  /** Tool height/length in mm. */
  height: number;
  /** Corner radius in mm (Torus / BallNose). */
  cornerRadius: number;
  /** Radius at the shank end in mm (ConicalEnd). */
  coneRadiusTop: number;
  shape: MachiningToolShape;
  /** Bounding radius in mm — the worker derives the AABB from it. */
  boundingRadius: number;
}

/** One subtraction request: an ORDERED segment list (see the type above). */
export interface MachiningSubtractJob {
  segments: MachiningToolSegment[];
}

/** Outcome of {@link MachiningProvider.submitSubtract}. */
export type MachiningSubmitResult =
  | { accepted: true; seq: number }
  | { accepted: false; reason: 'backlog' | 'closed' };

/**
 * Worker acknowledgement. `pendingJobs`/`pendingChunks` are the MOMENTARY queue
 * depths after processing this job — `SignalMachiningActive` is derived from
 * them, never latched. The worker emits a final IDLE ack (`seq === -1`,
 * `removedVoxels === 0`, both depths 0) once both queues drain, so the signal
 * always falls again.
 */
export interface MachiningSubtractAck {
  /** Sequence number of the acknowledged job, or -1 for the idle ack. */
  seq: number;
  removedVoxels: number;
  pendingJobs: number;
  pendingChunks: number;
}

/** True for the synthetic idle ack the worker sends when both queues drain. */
export function isIdleAck(ack: MachiningSubtractAck): boolean {
  return ack.seq < 0;
}

/** One tessellated chunk, trimmed to its ACTUAL vertex/index counts. */
export interface MachiningChunkMesh {
  /** Linear chunk index: `cx + cy*chunkResX + cz*chunkResX*chunkResY`. */
  chunkIndex: number;
  vertexCount: number;
  indexCount: number;
  /** xyz-interleaved, GRID-space mm (`vertexCount * 3`). */
  positions: Float32Array;
  /** xyz-interleaved (`vertexCount * 3`). */
  normals: Float32Array;
  /** uv-interleaved (`vertexCount * 2`). */
  uvs: Float32Array;
  /** `indexCount` triangle indices. */
  indices: Uint32Array;
}

/** A batch of freshly tessellated chunks, transferred from the worker. */
export interface MachiningChunkMeshBatch {
  /** Grid epoch — bumped on every reset/destroy; stale batches are dropped. */
  epoch: number;
  chunks: MachiningChunkMesh[];
  /** Chunks still queued for tessellation after this batch. */
  pendingChunks: number;
}

/** Handle returned by the `on*` subscriptions. Calling it twice is a no-op. */
export type MachiningUnsubscribe = () => void;

// ─── Provider contract (implemented by the private rv-csg provider) ────────

/**
 * Implemented by the private machining provider (plan-405 §2.3).
 *
 * Lifecycle contract:
 * - `init()` is lazy and re-entrancy-safe (a pending promise is reused); it
 *   loads the WASM and starts the worker. A rejection means "not available".
 * - `failed` latches permanently after a worker/WASM error. Every call is a
 *   no-op afterwards (`submitSubtract` returns `{accepted:false,reason:'closed'}`).
 * - `destroyGrid` is IDEMPOTENT, aborts a pending `createGrid`/`resetGrid` of
 *   the same handle, frees the grid's linear memory exactly once and drops all
 *   grid-bound listeners. It is the only route by which grid memory is freed —
 *   `clearModel()` calls it for every grid.
 * - `resetGrid` is a BARRIER: queued jobs are discarded (sequence-range
 *   invalidation), and the promise resolves only after the worker confirms the
 *   re-initialized grid. A new epoch begins afterwards.
 * - `submitSubtract` is non-blocking and bounded: at most
 *   {@link MACHINING_MAX_PENDING_JOBS} unacknowledged jobs per grid.
 */
export interface MachiningProvider {
  /** True once `init()` completed and the worker + WASM are live. */
  readonly ready: boolean;
  /** Fail-off latch: true after a WASM trap / worker error — permanently off. */
  readonly failed: boolean;

  /** Load the WASM + start the worker. Re-entrancy-safe (promise reuse). */
  init(): Promise<void>;
  /** Terminate the worker and drop every grid. Safe while `init()` pends. */
  dispose(): void;

  /** Build an SDF grid in the worker (Box/Cylinder analytic, Mesh voxelized). */
  createGrid(desc: MachiningGridDesc): Promise<MachiningGridHandle>;
  /** Idempotent teardown: frees linear memory + removes all grid listeners. */
  destroyGrid(handle: MachiningGridHandle): Promise<void>;
  /** Reset barrier — resolves once the queue is drained and the grid re-inited. */
  resetGrid(handle: MachiningGridHandle): Promise<void>;

  /** Enqueue one ordered segment list. Never throws; may reject with 'backlog'. */
  submitSubtract(handle: MachiningGridHandle, job: MachiningSubtractJob): MachiningSubmitResult;

  /** Per-job acknowledgements incl. the idle ack. */
  onAck(handle: MachiningGridHandle, cb: (ack: MachiningSubtractAck) => void): MachiningUnsubscribe;
  /** Tessellated chunk batches (transferables, trimmed to actual size). */
  onChunkMeshes(handle: MachiningGridHandle, cb: (batch: MachiningChunkMeshBatch) => void): MachiningUnsubscribe;

  /** Fresh full-grid solid-voxel scan (statistics; throttled by the caller). */
  countSolid(handle: MachiningGridHandle): Promise<number>;
}

// ─── Registry singleton (IK-solver / physics pattern) ──────────────────────

class MachiningRegistry {
  private _provider: MachiningProvider | null = null;
  private _warned = false;

  /** Register the private machining provider. `null` unregisters (no-op state). */
  register(provider: MachiningProvider | null): void {
    this._provider = provider;
    this._warned = false;
  }

  /**
   * The active provider, or `null` when machining is unavailable. Returns
   * `null` as well when the provider has failed off or the kill-switch is set,
   * so callers only ever have to check for `null`.
   */
  get provider(): MachiningProvider | null {
    const p = this._provider;
    if (!p || p.failed) return null;
    if (!isMachiningWasmEnabled()) return null;
    return p;
  }

  /** The raw registration, ignoring kill-switch and fail-off (diagnostics). */
  get rawProvider(): MachiningProvider | null {
    return this._provider;
  }

  /** Drop the registered provider (embed instance disposal / tests). */
  clear(): void {
    this._provider = null;
    this._warned = false;
  }

  /**
   * Emits the single "machining unavailable" console warning of a session
   * (F10). Returns true the first time so the caller can attach detail.
   */
  warnUnavailableOnce(reason: string): boolean {
    if (this._warned) return false;
    this._warned = true;
    console.warn(
      `[machining] CSG material removal is unavailable (${reason}) — `
      + 'workpieces stay in their authored state.',
    );
    return true;
  }
}

/** Singleton machining provider registry. */
export const machiningRegistry = new MachiningRegistry();

// ─── Kill-switch (pattern: MESH_MERGE_WASM_FLAG_KEY) ───────────────────────

/** localStorage kill-switch. Default ON; 'off' / 'false' / '0' disable it. */
export const MACHINING_WASM_FLAG_KEY = 'rv.machining.wasm';

/** Deploy-wide gate, written once at boot from settings.json. Default allowed. */
export const machiningSettings = { enabled: true };

/** False when the `rv.machining.wasm` kill-switch disables the WASM path. */
export function isMachiningWasmFlagEnabled(): boolean {
  try {
    const v = typeof localStorage !== 'undefined'
      ? localStorage.getItem(MACHINING_WASM_FLAG_KEY)
      : null;
    if (v === 'off' || v === 'false' || v === '0') return false;
  } catch {
    /* storage unavailable (privacy mode) — default ON */
  }
  return true;
}

/** Effective gate: deploy setting AND localStorage kill-switch (both default ON). */
export function isMachiningWasmEnabled(): boolean {
  return machiningSettings.enabled !== false && isMachiningWasmFlagEnabled();
}

/** True when this runtime can host the machining worker at all (F10). */
export function isMachiningWorkerSupported(): boolean {
  return typeof Worker !== 'undefined';
}
