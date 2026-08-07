// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mu-compute-tsl — WebGPU compute kernel for MU instance transforms
 * (plan-271 Phase 4 SPIKE).
 *
 * Replaces the CPU `Matrix4.compose` loop of `MUInstancePool.updateInstanceMatrix()`
 * with a TSL compute kernel: the pool's parallel CPU arrays (positions vec3,
 * quaternions vec4) are uploaded into storage buffers and the per-instance
 * mat4 is composed ON the GPU, written directly into a
 * `StorageInstancedBufferAttribute` that is bound as `mesh.instanceMatrix`.
 *
 * Why this approach (and not a node-material position path): three r185's
 * instancing node (`nodes/accessors/Instance.js`) natively reads a
 * `StorageInstancedBufferAttribute` instanceMatrix via
 * `storage(attr, 'mat4', count)` — so the compute OUTPUT **is** the regular
 * `instanceMatrix` attribute. Everything downstream that works on
 * `instanceMatrix` (renderer instancing, frustum culling via the pool's
 * CPU-computed bounding sphere, `getMatrixAt`-based raycasting after the
 * pool's lazy CPU re-sync) stays on its existing contract. A custom
 * `positionNode` instance path would bypass `instanceMatrix` entirely and
 * break the raycast/bounding-sphere CPU path.
 *
 * WGSL vec3 trap (verified in three 0.185.1 `WebGPUAttributeUtils`): storage
 * buffers with `itemSize === 3` are padded to vec4 on upload and the
 * attribute is MUTATED (itemSize→4, new array). To keep `writeFrom()` in
 * control of the layout, the position/quaternion input buffers are allocated
 * as vec4 (itemSize 4) from the start; positions are re-strided 3→4 on write.
 *
 * Dispose contract (plan-271 review finding 14): unlike the pool's
 * geometry/material (template-shared, never disposed by the pool), the
 * storage buffers here are POOL-SPECIFIC GPU resources. `ensureCapacity()`
 * explicitly destroys the replaced buffers via `backend.destroyAttribute()`
 * (the `_grow()` "drop the arrays" pattern does NOT free GPU buffers), and
 * `dispose()` destroys the current set + detaches from the mesh.
 *
 * Compute requires the REAL WebGPU backend (`viewer.hasCompute`) — there is
 * no WebGL2 fallback for `compute()`. Callers gate on that flag; this module
 * never checks it itself.
 *
 * Import hygiene: only 'three/webgpu' / 'three/tsl'; loaded exclusively via
 * the dynamic import in material-factory.ts (pre-warm).
 */

import { StorageInstancedBufferAttribute } from 'three/webgpu';
import { Fn, If, float, instanceIndex, mat4, storage, uniform, vec4 } from 'three/tsl';

// ─── Duck-typed views (no 'three' import allowed in this module) ─────────

/** The renderer bits the compute path needs (real-backend WebGPURenderer). */
interface ComputeRendererLike {
  compute(node: object): void;
  getArrayBufferAsync?(attribute: object): Promise<ArrayBuffer>;
  backend?: { destroyAttribute?: (attribute: object) => void };
}

interface MaterialLike { needsUpdate: boolean }

/** The InstancedMesh surface used by `computeAndApply` (from the app's
 *  'three' instance — duck-typed on purpose, no instanceof across bundles). */
interface InstancedMeshLike {
  instanceMatrix: { array: Float32Array | number[] };
  material: MaterialLike | MaterialLike[] | null;
}

/** Marker stamped on the attributes this module creates, so re-attach after
 *  `ensureCapacity()` never mistakes one of our own (already GPU-destroyed)
 *  buffers for the mesh's original attribute. */
interface OwnedAttr extends StorageInstancedBufferAttribute {
  __rvMuCompute?: boolean;
}

export interface MuComputeTransforms {
  /** Current storage-buffer capacity (instances). */
  readonly capacity: number;
  /** The mat4 output attribute — becomes `mesh.instanceMatrix` on attach.
   *  Exposed for tests/readback; treat as opaque elsewhere. */
  readonly matrixAttribute: object & { array: Float32Array };
  /** Grow the storage buffers to hold at least `n` instances. Re-binds the
   *  kernel and EXPLICITLY destroys the replaced GPU buffers. No-op when the
   *  current capacity already suffices. */
  ensureCapacity(n: number): void;
  /** Upload the pool's CPU truth (positions stride 3, quaternions stride 4)
   *  for the first `activeCount` instances into the input storage buffers. */
  writeFrom(positions: Float32Array, quaternions: Float32Array, activeCount: number): void;
  /** Bind the output attribute as `mesh.instanceMatrix` (once / after growth)
   *  and dispatch the compose kernel. Synchronous submit — WebGPU queue order
   *  guarantees the matrices are ready before this frame's render pass. */
  computeAndApply(renderer: unknown, mesh: unknown): void;
  /** Detach from the mesh (restores its original instanceMatrix attribute)
   *  and destroy all GPU buffers + the kernel. Idempotent. */
  dispose(): void;
}

class MuComputeTransformsImpl implements MuComputeTransforms {
  private _capacity = 0;
  private _posAttr!: OwnedAttr;   // vec4 per instance (xyz + pad)
  private _quatAttr!: OwnedAttr;  // vec4 per instance
  private _matAttr!: OwnedAttr;   // mat4 per instance (16 floats)
  private _kernel: object | null = null;
  /** Active-instance guard uniform — reused across capacity re-binds. */
  private readonly _uActive = uniform(0, 'uint');
  private _renderer: ComputeRendererLike | null = null;
  /** Attributes replaced before a renderer was known — destroyed on first
   *  computeAndApply (they may still have been uploaded by a prior frame). */
  private readonly _pendingDestroy: object[] = [];
  private _attachedMesh: InstancedMeshLike | null = null;
  private _origAttr: InstancedMeshLike['instanceMatrix'] | null = null;
  private _disposed = false;

  get capacity(): number {
    return this._capacity;
  }

  get matrixAttribute(): object & { array: Float32Array } {
    return this._matAttr as unknown as object & { array: Float32Array };
  }

  ensureCapacity(n: number): void {
    if (this._disposed) return;
    if (n <= this._capacity && this._matAttr) return;
    const cap = Math.max(n, 1);

    const oldPos = this._posAttr;
    const oldQuat = this._quatAttr;
    const oldMat = this._matAttr;
    const oldKernel = this._kernel;

    this._posAttr = this._own(new StorageInstancedBufferAttribute(cap, 4));
    this._quatAttr = this._own(new StorageInstancedBufferAttribute(cap, 4));
    this._matAttr = this._own(new StorageInstancedBufferAttribute(cap, 16));

    // Keep the CPU mirror of already-composed matrices (raycast continuity —
    // the pool re-syncs lazily from its truth arrays anyway).
    if (oldMat) {
      (this._matAttr.array as Float32Array).set(oldMat.array as Float32Array);
    }

    this._buildKernel(cap);
    this._capacity = cap;

    // Explicit GPU dispose of the REPLACED buffers (plan-271 finding 14) —
    // dropping the JS references alone would leak the GPUBuffers until GC.
    if (oldPos) this._destroyAttr(oldPos);
    if (oldQuat) this._destroyAttr(oldQuat);
    if (oldMat) this._destroyAttr(oldMat);
    (oldKernel as { dispose?: () => void } | null)?.dispose?.();
  }

  writeFrom(positions: Float32Array, quaternions: Float32Array, activeCount: number): void {
    if (this._disposed) return;
    const n = Math.min(activeCount, this._capacity);
    const pos = this._posAttr.array as Float32Array;
    // Re-stride 3 → 4 (WGSL vec4 layout, see module doc).
    for (let i = 0; i < n; i++) {
      pos[i * 4] = positions[i * 3];
      pos[i * 4 + 1] = positions[i * 3 + 1];
      pos[i * 4 + 2] = positions[i * 3 + 2];
    }
    (this._quatAttr.array as Float32Array).set(quaternions.subarray(0, n * 4));

    this._posAttr.clearUpdateRanges();
    this._posAttr.addUpdateRange(0, n * 4);
    this._posAttr.needsUpdate = true;
    this._quatAttr.clearUpdateRanges();
    this._quatAttr.addUpdateRange(0, n * 4);
    this._quatAttr.needsUpdate = true;

    (this._uActive as unknown as { value: number }).value = n;
  }

  computeAndApply(renderer: unknown, mesh: unknown): void {
    if (this._disposed || !this._kernel) return;
    const r = renderer as ComputeRendererLike;
    this._renderer = r;

    if (this._pendingDestroy.length > 0 && r.backend?.destroyAttribute) {
      for (const attr of this._pendingDestroy) r.backend.destroyAttribute(attr);
      this._pendingDestroy.length = 0;
    }

    this._attach(mesh as InstancedMeshLike);
    r.compute(this._kernel);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._detach();
    if (this._posAttr) this._destroyAttr(this._posAttr);
    if (this._quatAttr) this._destroyAttr(this._quatAttr);
    if (this._matAttr) this._destroyAttr(this._matAttr);
    // Anything still pending (replaced pre-renderer) can only be flushed if a
    // renderer was ever seen; otherwise the buffers never reached the GPU.
    if (this._renderer?.backend?.destroyAttribute) {
      for (const attr of this._pendingDestroy) this._renderer.backend.destroyAttribute(attr);
    }
    this._pendingDestroy.length = 0;
    (this._kernel as { dispose?: () => void } | null)?.dispose?.();
    this._kernel = null;
    this._capacity = 0;
  }

  // ── internals ───────────────────────────────────────────────────────

  private _own(attr: StorageInstancedBufferAttribute): OwnedAttr {
    (attr as OwnedAttr).__rvMuCompute = true;
    return attr as OwnedAttr;
  }

  private _destroyAttr(attr: object): void {
    if (this._renderer?.backend?.destroyAttribute) {
      this._renderer.backend.destroyAttribute(attr);
    } else {
      this._pendingDestroy.push(attr);
    }
  }

  /** Bind `matrixAttribute` as the mesh's instanceMatrix. Idempotent; safe to
   *  call every frame. On a NEW mesh (pool `_grow()` swap) it re-binds and
   *  remembers that mesh's original attribute for `dispose()` restore. */
  private _attach(mesh: InstancedMeshLike): void {
    const current = mesh.instanceMatrix as unknown as OwnedAttr;
    if (this._attachedMesh === mesh && current === this._matAttr) return;

    if (current.__rvMuCompute !== true) {
      // Mesh still carries its original (regular) attribute — remember it for
      // restore and seed our CPU mirror from it (spawn-time matrices).
      this._origAttr = mesh.instanceMatrix;
      const src = current.array as Float32Array;
      const dst = this._matAttr.array as Float32Array;
      dst.set(src.length <= dst.length ? src : src.subarray(0, dst.length));
    }
    mesh.instanceMatrix = this._matAttr as unknown as InstancedMeshLike['instanceMatrix'];
    this._bumpMaterial(mesh);
    this._attachedMesh = mesh;
  }

  private _detach(): void {
    const mesh = this._attachedMesh;
    if (mesh && this._origAttr
      && (mesh.instanceMatrix as unknown as OwnedAttr).__rvMuCompute === true) {
      // Hand the freshest CPU mirror back so the restored attribute is not
      // frozen at spawn time (the pool's CPU path recomposes on next tick).
      const src = this._matAttr?.array as Float32Array | undefined;
      const dst = this._origAttr.array as Float32Array;
      if (src) dst.set(src.length <= dst.length ? src : src.subarray(0, dst.length));
      mesh.instanceMatrix = this._origAttr;
      this._bumpMaterial(mesh);
    }
    this._attachedMesh = null;
    this._origAttr = null;
  }

  /** Force a node/pipeline rebuild after swapping the instanceMatrix
   *  attribute KIND (regular ↔ storage) — the instancing node chooses its
   *  read path at build time (Instance.js). */
  private _bumpMaterial(mesh: InstancedMeshLike): void {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (m) m.needsUpdate = true;
    }
  }

  private _buildKernel(cap: number): void {
    const posBuf = storage(this._posAttr, 'vec4', cap);
    const quatBuf = storage(this._quatAttr, 'vec4', cap);
    const matBuf = storage(this._matAttr, 'mat4', cap);
    const uActive = this._uActive;

    // GPU pendant of Matrix4.compose(position, quaternion, scale=1) —
    // column-major, columns as vec4s (te[0..3] | te[4..7] | te[8..11] | t).
    this._kernel = Fn(() => {
      If(instanceIndex.lessThan(uActive), () => {
        const p = posBuf.element(instanceIndex).toVar();
        const q = quatBuf.element(instanceIndex).toVar();
        const x = q.x; const y = q.y; const z = q.z; const w = q.w;
        const x2 = x.add(x).toVar();
        const y2 = y.add(y).toVar();
        const z2 = z.add(z).toVar();
        const xx = x.mul(x2).toVar();
        const xy = x.mul(y2).toVar();
        const xz = x.mul(z2).toVar();
        const yy = y.mul(y2).toVar();
        const yz = y.mul(z2).toVar();
        const zz = z.mul(z2).toVar();
        const wx = w.mul(x2).toVar();
        const wy = w.mul(y2).toVar();
        const wz = w.mul(z2).toVar();
        const one = float(1);
        matBuf.element(instanceIndex).assign(mat4(
          vec4(one.sub(yy.add(zz)), xy.add(wz), xz.sub(wy), 0),
          vec4(xy.sub(wz), one.sub(xx.add(zz)), yz.add(wx), 0),
          vec4(xz.add(wy), yz.sub(wx), one.sub(xx.add(yy)), 0),
          vec4(p.xyz, 1),
        ));
      });
    })().compute(cap);
  }
}

/** Create a per-pool compute-transform handle (plan-271 Phase 4 spike). */
export function createMuComputeTransforms(initialCapacity = 128): MuComputeTransforms {
  const t = new MuComputeTransformsImpl();
  t.ensureCapacity(initialCapacity);
  return t;
}

/** Test/bench helper: read the composed matrices back from the GPU.
 *  NEVER call this in the frame path — readback stalls the pipeline. */
export async function readMuComputeMatricesAsync(
  renderer: unknown,
  transforms: MuComputeTransforms,
  count: number,
): Promise<Float32Array> {
  const r = renderer as ComputeRendererLike;
  if (typeof r.getArrayBufferAsync !== 'function') {
    throw new Error('[rv-mu-compute-tsl] renderer.getArrayBufferAsync unavailable (real WebGPU backend required)');
  }
  const ab = await r.getArrayBufferAsync(transforms.matrixAttribute);
  return new Float32Array(ab).subarray(0, count * 16);
}
