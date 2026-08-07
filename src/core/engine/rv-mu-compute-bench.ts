// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mu-compute-bench — dev-only benchmark hook for the plan-271 Phase 4
 * MU compute-transform SPIKE.
 *
 * Installed ONLY from the `import.meta.env.DEV` block in main.ts (dead-code
 * eliminated from production builds). Exposes
 *
 *   window.__rvMuComputeBench(counts?: number[], frames?: number)
 *
 * which, per instance count, drives a synthetic `MUInstancePool` (own
 * InstancedMesh in the live scene, positions jittered every frame) for
 * ~`frames` rAF frames — once on the CPU compose path and once on the GPU
 * compute path — and reports:
 *
 *   - msPerFrame:  average rAF-to-rAF frame time (end-to-end incl. render;
 *                  vsync-capped until the scene becomes GPU/CPU bound)
 *   - updateMs:    average CPU time spent INSIDE `updateInstanceMatrix()`
 *                  (compose loop vs. writeFrom + compute dispatch)
 *
 * Run it via `scripts/mu-compute-bench.mjs` (headed Chromium, real GPU) —
 * headless SwiftShader numbers say nothing about the threshold curve.
 */

import { BoxGeometry, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import type { Scene } from 'three';
import { MUInstancePool } from './rv-mu';
import { createMaterialContext, preloadTslMaterials, type RendererKind } from './materials/material-factory';

/** Duck-typed viewer surface — engine/ files never import rv-viewer
 *  (plan-182 import-topology rule, enforced by
 *  tests/engine-no-viewer-import.node.test.ts). */
interface ViewerLike {
  scene: Scene;
  renderer: unknown;
  rendererKind: RendererKind;
  hasCompute: boolean;
}

export interface MuComputeBenchRow {
  count: number;
  cpuMsPerFrame: number;
  cpuUpdateMs: number;
  computeMsPerFrame: number | null;
  computeUpdateMs: number | null;
}

interface BenchResult { msPerFrame: number; updateMs: number }

const WARMUP_FRAMES = 20;

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

/** O(n) per-frame mutation — identical work for both modes so the measured
 *  difference is the matrix path only. */
function jitter(pool: MUInstancePool, frame: number): void {
  const pos = pool.positions;
  const n = pool.activeCount;
  const phase = frame * 0.05;
  for (let i = 0; i < n; i++) {
    pos[i * 3 + 1] += Math.sin(phase + i) * 0.0005;
  }
}

async function runBench(
  viewer: ViewerLike,
  count: number,
  frames: number,
  computeRenderer: unknown,
): Promise<BenchResult> {
  const geometry = new BoxGeometry(0.05, 0.05, 0.05);
  const material = new MeshStandardMaterial({ color: 0x8899aa, roughness: 0.6 });
  const pool = new MUInstancePool(
    geometry,
    material,
    `__muComputeBench_${count}_${computeRenderer ? 'gpu' : 'cpu'}`,
    new Vector3(0.025, 0.025, 0.025),
    undefined,
    count,
  );
  pool.instancedMesh.castShadow = false;
  pool.instancedMesh.receiveShadow = false;
  viewer.scene.add(pool.instancedMesh);

  const p = new Vector3();
  const q = new Quaternion();
  for (let i = 0; i < count; i++) {
    p.set((Math.random() - 0.5) * 10, Math.random() * 3, (Math.random() - 0.5) * 10);
    const a = Math.random() * Math.PI;
    q.set(0, Math.sin(a), 0, Math.cos(a)).normalize();
    pool.spawn(p, q, `bench${i}`, '__muComputeBench');
  }

  try {
    for (let f = 0; f < WARMUP_FRAMES; f++) {
      jitter(pool, f);
      pool.markDirty();
      pool.updateInstanceMatrix(computeRenderer);
      await nextFrame();
    }

    let updateMs = 0;
    const t0 = performance.now();
    for (let f = 0; f < frames; f++) {
      jitter(pool, WARMUP_FRAMES + f);
      pool.markDirty();
      const u0 = performance.now();
      pool.updateInstanceMatrix(computeRenderer);
      updateMs += performance.now() - u0;
      await nextFrame();
    }
    const total = performance.now() - t0;
    return { msPerFrame: total / frames, updateMs: updateMs / frames };
  } finally {
    viewer.scene.remove(pool.instancedMesh);
    pool.dispose(); // also disposes the pool-specific compute storage buffers
    geometry.dispose();
    material.dispose();
  }
}

/** Install the `window.__rvMuComputeBench` hook (dev-only, see module doc). */
export function installMuComputeBench(viewer: ViewerLike): void {
  const hook = async (
    counts: number[] = [128, 512, 2000, 10000, 50000],
    frames = 200,
  ): Promise<MuComputeBenchRow[]> => {
    if (viewer.hasCompute) {
      // Make sure the rv-mu-compute-tsl module is pre-warmed (no-op when the
      // viewer already ran the standard TSL pre-warm).
      await preloadTslMaterials(createMaterialContext(viewer.rendererKind, viewer.hasCompute));
    } else {
      console.warn('[__rvMuComputeBench] No real WebGPU backend (hasCompute=false) — compute rows will be null.');
    }

    const rows: MuComputeBenchRow[] = [];
    for (const count of counts) {
      const cpu = await runBench(viewer, count, frames, undefined);
      const gpu = viewer.hasCompute
        ? await runBench(viewer, count, frames, viewer.renderer)
        : null;
      const row: MuComputeBenchRow = {
        count,
        cpuMsPerFrame: +cpu.msPerFrame.toFixed(3),
        cpuUpdateMs: +cpu.updateMs.toFixed(3),
        computeMsPerFrame: gpu ? +gpu.msPerFrame.toFixed(3) : null,
        computeUpdateMs: gpu ? +gpu.updateMs.toFixed(3) : null,
      };
      rows.push(row);
      console.log(`[__rvMuComputeBench] n=${count}: cpu ${row.cpuMsPerFrame} ms/frame (update ${row.cpuUpdateMs} ms) | compute ${row.computeMsPerFrame ?? '-'} ms/frame (update ${row.computeUpdateMs ?? '-'} ms)`);
    }
    console.table(rows);
    return rows;
  };

  (window as unknown as { __rvMuComputeBench?: typeof hook }).__rvMuComputeBench = hook;
}
