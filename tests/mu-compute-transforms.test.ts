// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * mu-compute-transforms.test.ts — plan-271 test 9.5 (integration, conditional).
 *
 * Validates the Phase-4 compute SPIKE: the GPU compose kernel in
 * rv-mu-compute-tsl.ts produces matrices identical to the CPU
 * `Matrix4.compose` path (tolerance 1e-5), `ensureCapacity()` growth re-binds
 * AND explicitly destroys the replaced storage buffers, and `dispose()`
 * detaches + frees everything (plan-271 review finding 14).
 *
 * Guard (plan-271 §9.5): `navigator.gpu` existing is NOT enough — the WebGPU
 * object can exist without a usable adapter. The suite skips unless
 * `requestAdapter()` returns non-null (headless CI skips; run locally on a
 * real GPU, e.g. `npx vitest run tests/mu-compute-transforms.test.ts
 * --browser.headless=false`).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  BoxGeometry, InstancedMesh, Matrix4, MeshStandardMaterial,
  Quaternion, Raycaster, Vector3,
} from 'three';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import {
  createMaterialContext, getTslMaterials, preloadTslMaterials,
  type TslMaterialsModule,
} from '../src/core/engine/materials/material-factory';
import { MUInstancePool } from '../src/core/engine/rv-mu';
import type { MuComputeTransforms } from '../src/core/engine/materials/rv-mu-compute-tsl';

const adapter = typeof navigator !== 'undefined' && navigator.gpu
  ? await navigator.gpu.requestAdapter()
  : null;

/** Duck-typed backend surface for the dispose spies. */
interface BackendLike { destroyAttribute?: (attr: object) => void }

/** CPU reference: Matrix4.compose over stride-3/stride-4 truth arrays. */
function cpuCompose(positions: Float32Array, quaternions: Float32Array, count: number): Float32Array {
  const out = new Float32Array(count * 16);
  const m = new Matrix4();
  const p = new Vector3();
  const q = new Quaternion();
  const one = new Vector3(1, 1, 1);
  for (let i = 0; i < count; i++) {
    p.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    q.set(quaternions[i * 4], quaternions[i * 4 + 1], quaternions[i * 4 + 2], quaternions[i * 4 + 3]);
    m.compose(p, q, one);
    m.toArray(out, i * 16);
  }
  return out;
}

function maxAbsDiff(a: Float32Array, b: Float32Array, len: number): number {
  let max = 0;
  for (let i = 0; i < len; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > max) max = d;
  }
  return max;
}

function fillRandom(positions: Float32Array, quaternions: Float32Array, count: number, seed = 42): void {
  // Tiny deterministic LCG — reproducible across runs.
  let s = seed;
  const rnd = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
  const q = new Quaternion();
  const axis = new Vector3();
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (rnd() - 0.5) * 20;
    positions[i * 3 + 1] = rnd() * 5;
    positions[i * 3 + 2] = (rnd() - 0.5) * 20;
    axis.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
    q.setFromAxisAngle(axis, rnd() * Math.PI * 2);
    quaternions[i * 4] = q.x;
    quaternions[i * 4 + 1] = q.y;
    quaternions[i * 4 + 2] = q.z;
    quaternions[i * 4 + 3] = q.w;
  }
}

describe.skipIf(!adapter)('MU compute transforms — plan-271 Phase 4 spike (test 9.5, real WebGPU)', () => {
  let handle: TestViewerHandle | null = null;
  let renderer: unknown;
  let tsl: TslMaterialsModule;
  let computeReady = false;

  beforeAll(async () => {
    handle = await createTestViewer('webgpu');
    renderer = handle.viewer.renderer;
    if (!handle.viewer.hasCompute) {
      console.warn('[mu-compute-transforms] adapter present but viewer.hasCompute=false — skipping suite bodies.');
      return;
    }
    await preloadTslMaterials(createMaterialContext(handle.viewer.rendererKind, handle.viewer.hasCompute));
    const mod = getTslMaterials();
    if (!mod) throw new Error('TSL pre-warm failed');
    tsl = mod;
    computeReady = true;
  }, 30_000);

  afterAll(() => {
    handle?.dispose();
  });

  it('GPU-composed matrices match the CPU path within 1e-5 for 1k instances', async (ctx) => {
    if (!computeReady) return ctx.skip();
    const n = 1000;
    const cap = 1024;
    const positions = new Float32Array(cap * 3);
    const quaternions = new Float32Array(cap * 4);
    fillRandom(positions, quaternions, n);
    const expected = cpuCompose(positions, quaternions, n);

    const geo = new BoxGeometry(0.1, 0.1, 0.1);
    const mat = new MeshStandardMaterial();
    const mesh = new InstancedMesh(geo, mat, cap);
    const compute = tsl.createMuComputeTransforms(cap);
    try {
      compute.writeFrom(positions, quaternions, n);
      compute.computeAndApply(renderer, mesh);
      const actual = await tsl.readMuComputeMatricesAsync(renderer, compute, n);

      expect(maxAbsDiff(actual, expected, n * 16)).toBeLessThan(1e-5);
      // The compute output IS the instanceMatrix (StorageInstancedBufferAttribute path).
      expect(mesh.instanceMatrix as unknown).toBe(compute.matrixAttribute);
    } finally {
      compute.dispose();
      geo.dispose();
      mat.dispose();
    }
  }, 30_000);

  it('ensureCapacity() growth re-binds and explicitly destroys the replaced GPU buffers', async (ctx) => {
    if (!computeReady) return ctx.skip();
    const backend = (renderer as { backend?: BackendLike }).backend;
    if (!backend?.destroyAttribute) throw new Error('WebGPU backend without destroyAttribute');
    const spy = vi.spyOn(backend, 'destroyAttribute');

    const geo = new BoxGeometry(0.1, 0.1, 0.1);
    const mat = new MeshStandardMaterial();
    const mesh = new InstancedMesh(geo, mat, 256);
    const compute = tsl.createMuComputeTransforms(64);
    try {
      const positions = new Float32Array(256 * 3);
      const quaternions = new Float32Array(256 * 4);
      fillRandom(positions, quaternions, 256, 7);

      // First dispatch at capacity 64 — renderer becomes known, buffers reach the GPU.
      compute.writeFrom(positions, quaternions, 64);
      compute.computeAndApply(renderer, mesh);
      const oldAttr = compute.matrixAttribute;
      spy.mockClear();

      // Grow: must re-bind (new attribute) AND destroy all three old buffers.
      compute.ensureCapacity(128);
      expect(compute.capacity).toBeGreaterThanOrEqual(128);
      expect(compute.matrixAttribute).not.toBe(oldAttr);
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3); // pos + quat + mat
      expect(spy.mock.calls.map((c) => c[0] as object)).toContain(oldAttr);

      // Still numerically correct after the re-bind.
      compute.writeFrom(positions, quaternions, 100);
      compute.computeAndApply(renderer, mesh);
      const actual = await tsl.readMuComputeMatricesAsync(renderer, compute, 100);
      const expected = cpuCompose(positions, quaternions, 100);
      expect(maxAbsDiff(actual, expected, 100 * 16)).toBeLessThan(1e-5);
    } finally {
      spy.mockRestore();
      compute.dispose();
      geo.dispose();
      mat.dispose();
    }
  }, 30_000);

  it('dispose() detaches from the mesh and destroys all GPU buffers (idempotent)', async (ctx) => {
    if (!computeReady) return ctx.skip();
    const backend = (renderer as { backend?: BackendLike }).backend!;
    const spy = vi.spyOn(backend, 'destroyAttribute');

    const geo = new BoxGeometry(0.1, 0.1, 0.1);
    const mat = new MeshStandardMaterial();
    const mesh = new InstancedMesh(geo, mat, 64);
    const originalAttr = mesh.instanceMatrix;
    const compute = tsl.createMuComputeTransforms(64);
    try {
      const positions = new Float32Array(64 * 3);
      const quaternions = new Float32Array(64 * 4);
      fillRandom(positions, quaternions, 64, 11);
      compute.writeFrom(positions, quaternions, 64);
      compute.computeAndApply(renderer, mesh);
      expect(mesh.instanceMatrix as unknown).toBe(compute.matrixAttribute);
      const matrixAttr = compute.matrixAttribute;
      spy.mockClear();

      compute.dispose();
      expect(mesh.instanceMatrix).toBe(originalAttr); // detached / restored
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(spy.mock.calls.map((c) => c[0] as object)).toContain(matrixAttr);

      compute.dispose(); // idempotent — must not throw
    } finally {
      spy.mockRestore();
      geo.dispose();
      mat.dispose();
    }
  }, 30_000);

  it('MUInstancePool.updateInstanceMatrix(renderer) uses the compute path and lazily re-syncs CPU matrices for raycast', async (ctx) => {
    if (!computeReady) return ctx.skip();
    const geo = new BoxGeometry(0.1, 0.1, 0.1);
    const mat = new MeshStandardMaterial();
    const pool = new MUInstancePool(geo, mat, 'computeTest', new Vector3(0.05, 0.05, 0.05), undefined, 16);
    try {
      const p = new Vector3();
      const q = new Quaternion();
      for (let i = 0; i < 8; i++) {
        p.set(1 + i, 2, 3);
        q.setFromAxisAngle(new Vector3(0, 1, 0), i * 0.3);
        pool.spawn(p, q, `mu${i}`, 'test');
      }
      pool.updateInstanceMatrix(renderer);

      const compute = (pool as unknown as { _compute: MuComputeTransforms | null })._compute;
      expect(compute).toBeTruthy();
      expect(pool.instancedMesh.instanceMatrix as unknown).toBe(compute!.matrixAttribute);

      // GPU matrices match a CPU compose over the pool's truth arrays.
      const actual = await tsl.readMuComputeMatricesAsync(renderer, compute!, 8);
      const expected = cpuCompose(pool.positions, pool.quaternions, 8);
      expect(maxAbsDiff(actual, expected, 8 * 16)).toBeLessThan(1e-5);

      // Move an MU: GPU updates, the CPU mirror stays stale until a raycast
      // touches the mesh — then the wrapper recomposes it from the truth arrays.
      const mu = pool.getMUAtSlot(0)!;
      mu.setPosition(new Vector3(50, 60, 70));
      pool.updateInstanceMatrix(renderer);

      const before = new Matrix4();
      pool.instancedMesh.getMatrixAt(0, before);
      expect(Math.abs(before.elements[12] - 50)).toBeGreaterThan(1); // stale mirror

      pool.instancedMesh.raycast(new Raycaster(), []); // triggers the lazy sync
      const after = new Matrix4();
      pool.instancedMesh.getMatrixAt(0, after);
      expect(after.elements[12]).toBeCloseTo(50, 4);
      expect(after.elements[13]).toBeCloseTo(60, 4);
      expect(after.elements[14]).toBeCloseTo(70, 4);
    } finally {
      pool.dispose();
      geo.dispose();
      mat.dispose();
    }
  }, 30_000);
});
