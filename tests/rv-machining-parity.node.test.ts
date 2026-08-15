// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-machining-parity.node.test.ts — plan-405 test 9.6.
 *
 * Geometric / semantic parity with the Unity behaviour, run against the REAL
 * `rv_csg.wasm` (the same kernel the Unity DLL is built from, so equality here IS
 * cross-engine equality):
 *
 *   - rotated sweep (quaternion slerp path) cuts more than the two end poses alone,
 *   - multi-tool subtraction follows the LIST ORDER,
 *   - border chunks of a non-multiple-of-16 lattice tessellate at partial size,
 *   - MarchingCubes and DualContouring disagree on the same grid (the mode is live),
 *   - "spindle off" (no job submitted) leaves the grid untouched,
 *   - substep degradation above the segment cap keeps the path, only its density.
 *
 * NODE test — the artifact is read from disk. SKIPS cleanly when it is absent.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CsgKernel, type CsgGridDesc, type CsgToolSegment } from '@rv-private/machining/rv-csg-kernel';
import { CsgWorkerBody, degradeSubsteps, MAX_SEGMENTS_PER_JOB } from '@rv-private/machining/rv-csg-worker-body';

const HERE = dirname(fileURLToPath(import.meta.url));
const WASM_CANDIDATES = [
  resolve(HERE, '../../realvirtual-WebViewer-Private~/src/machining/rv_csg.wasm'),
  resolve(HERE, '../../realvirtual-web-pro/src/machining/rv_csg.wasm'),
];
const WASM_PATH = WASM_CANDIDATES.find((p) => existsSync(p));

const RES = 32;
const SIZE = { x: 100, y: 60, z: 80 };
const VOXEL = { x: SIZE.x / (RES - 3), y: SIZE.y / (RES - 3), z: SIZE.z / (RES - 3) };
const ORIGIN = {
  x: -SIZE.x * 0.5 - VOXEL.x * 1.5,
  y: -SIZE.y * 0.5 - VOXEL.y * 1.5,
  z: -SIZE.z * 0.5 - VOXEL.z * 1.5,
};
const IDENT = { x: 0, y: 0, z: 0, w: 1 };

function desc(overrides: Partial<CsgGridDesc> = {}): CsgGridDesc {
  return {
    resolution: { x: RES, y: RES, z: RES },
    sizeMm: SIZE,
    shape: 'Box',
    cylinderAxis: 0,
    meshing: 'MarchingCubes',
    creaseAngleDeg: 0,
    ...overrides,
  };
}

function gridPos(local: [number, number, number]): { x: number; y: number; z: number } {
  return { x: local[0] - ORIGIN.x, y: local[1] - ORIGIN.y, z: local[2] - ORIGIN.z };
}

function qz(deg: number): { x: number; y: number; z: number; w: number } {
  const half = (deg * Math.PI) / 360;
  return { x: 0, y: 0, z: Math.sin(half), w: Math.cos(half) };
}

function seg(overrides: Partial<CsgToolSegment> & Pick<CsgToolSegment, 'posStart' | 'posEnd'>): CsgToolSegment {
  return {
    rotStart: IDENT,
    rotEnd: IDENT,
    substeps: 16,
    radius: 6,
    height: 40,
    cornerRadius: 0,
    coneRadiusTop: 0,
    shape: 1,
    boundingRadius: Math.sqrt(6 * 6 + 20 * 20),
    ...overrides,
  };
}

const d = WASM_PATH ? describe : describe.skip;

if (!WASM_PATH) {
  console.warn('[rv-csg] rv_csg.wasm not found — the machining parity suite is SKIPPED.');
}

/** Copy into a plain ArrayBuffer — see the note in the integration test. */
async function loadWasm(path: string): Promise<ArrayBuffer> {
  const buf = await readFile(path);
  const out = new ArrayBuffer(buf.byteLength);
  new Uint8Array(out).set(buf);
  return out;
}

d('machining parity against the real kernel (plan-405 §9.6)', () => {
  let kernel: CsgKernel;

  beforeAll(async () => {
    kernel = await CsgKernel.instantiate(await loadWasm(WASM_PATH!));
  });

  it('a rotated sweep removes more than its two end poses', () => {
    const a = gridPos([-25, 0, 0]);
    const b = gridPos([25, 0, 0]);

    // (1) swept, with rotation
    const swept = kernel.createGrid(desc());
    const sweptRemoved = kernel.subtract(swept, [
      seg({ posStart: a, posEnd: b, rotStart: qz(0), rotEnd: qz(75), substeps: 32 }),
    ]);

    // (2) the two end poses only — what a viewer without sweeping would cut
    const stamped = kernel.createGrid(desc());
    let stampedRemoved = kernel.subtract(stamped, [
      seg({ posStart: a, posEnd: a, rotStart: qz(0), rotEnd: qz(0), substeps: 1 }),
    ]);
    stampedRemoved += kernel.subtract(stamped, [
      seg({ posStart: b, posEnd: b, rotStart: qz(75), rotEnd: qz(75), substeps: 1 }),
    ]);

    expect(sweptRemoved).toBeGreaterThan(stampedRemoved);
    expect(kernel.countSolid(swept)).toBeLessThan(kernel.countSolid(stamped));

    kernel.destroyGrid(swept);
    kernel.destroyGrid(stamped);
  });

  it('subtraction is sequential in tool-list order', () => {
    const p1 = gridPos([-5, 0, 0]);
    const p2 = gridPos([5, 0, 0]);
    const sphere = (p: { x: number; y: number; z: number }): CsgToolSegment => seg({
      posStart: p, posEnd: p, shape: 0, radius: 14, height: 0, boundingRadius: 14, substeps: 1,
    });

    // Both orders reach the same final material (subtraction is commutative as a
    // SET operation) ...
    const ab = kernel.createGrid(desc());
    const removedAB = kernel.subtract(ab, [sphere(p1), sphere(p2)]);
    const ba = kernel.createGrid(desc());
    const removedBA = kernel.subtract(ba, [sphere(p2), sphere(p1)]);
    expect(kernel.countSolid(ab)).toBe(kernel.countSolid(ba));
    // ... and the removal COUNT is the flip count, which is order-independent
    // precisely because the kernel applies the tools one after another against
    // the already-updated grid (a parallel union would double-count the overlap).
    expect(removedAB).toBe(removedBA);
    const solidBefore = ab.initialSolidVoxels;
    expect(kernel.countSolid(ab)).toBe(solidBefore - removedAB);

    kernel.destroyGrid(ab);
    kernel.destroyGrid(ba);
  });

  it('border chunks of a non-multiple-of-16 lattice tessellate at partial size', () => {
    // 40³ → chunk lattice 3³, and the last chunk of each axis is only 8 voxels.
    const grid = kernel.createGrid(desc({ resolution: { x: 40, y: 40, z: 40 } }));
    expect(grid.chunkResolution).toEqual({ x: 3, y: 3, z: 3 });
    expect(grid.chunkCount).toBe(27);

    const all = Array.from({ length: 27 }, (_, i) => i);
    const results = [
      ...kernel.tessellate(grid, all.slice(0, 16)),
      ...kernel.tessellate(grid, all.slice(16)),
    ];
    expect(results).toHaveLength(27);
    // Every reported count is consistent with its buffers — a border chunk that
    // read past the lattice would blow the vertex count or produce NaNs.
    for (const c of results) {
      expect(c.positions.length).toBe(c.vertexCount * 3);
      expect(c.indices.length).toBe(c.indexCount);
      for (const v of c.positions) expect(Number.isFinite(v)).toBe(true);
      for (const i of c.indices) expect(i).toBeLessThan(c.vertexCount);
    }
    // The stock surface must produce SOME geometry.
    expect(results.reduce((n, c) => n + c.vertexCount, 0)).toBeGreaterThan(0);
    kernel.destroyGrid(grid);
  });

  it('MarchingCubes and DualContouring disagree on the same grid', () => {
    const cut = (meshing: 'MarchingCubes' | 'DualContouring'): number => {
      const grid = kernel.createGrid(desc({ meshing }));
      kernel.subtract(grid, [seg({
        posStart: gridPos([0, 0, 0]), posEnd: gridPos([0, 0, 0]),
        shape: 0, radius: 12, height: 0, boundingRadius: 12, substeps: 1,
      })]);
      const chunks: number[] = [];
      kernel.drainDirtyChunks(grid, chunks);
      const total = kernel.tessellate(grid, chunks.slice(0, 16))
        .reduce((n, c) => n + c.vertexCount, 0);
      kernel.destroyGrid(grid);
      return total;
    };
    const mc = cut('MarchingCubes');
    const dc = cut('DualContouring');
    expect(mc).toBeGreaterThan(0);
    expect(dc).toBeGreaterThan(0);
    expect(mc).not.toBe(dc);
  });

  it('an empty job (spindle off) leaves the grid byte-identical', () => {
    const grid = kernel.createGrid(desc());
    const before = kernel.countSolid(grid);
    expect(kernel.subtract(grid, [])).toBe(0);
    expect(kernel.countSolid(grid)).toBe(before);
    // ... and marks nothing dirty, so no chunk is needlessly re-tessellated.
    const drained: number[] = [];
    kernel.drainDirtyChunks(grid, drained); // the initial full-build flags
    const after: number[] = [];
    kernel.subtract(grid, []);
    expect(kernel.drainDirtyChunks(grid, after)).toBe(0);
    kernel.destroyGrid(grid);
  });

  it('substep degradation above the cap keeps the swept path recognisable', () => {
    // A long polyline that trips the cap: the degraded job must still remove the
    // large majority of what the full-density job removes.
    const points: Array<{ x: number; y: number; z: number }> = [];
    const n = MAX_SEGMENTS_PER_JOB * 2;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      points.push(gridPos([-40 + 80 * t, 0, 20 * Math.sin(t * Math.PI * 2)]));
    }
    const full: CsgToolSegment[] = [];
    for (let i = 1; i < points.length; i++) {
      full.push(seg({ posStart: points[i - 1], posEnd: points[i], substeps: 16 }));
    }
    const degraded = degradeSubsteps(full);
    expect(degraded).toHaveLength(full.length);
    expect(degraded[0].substeps).toBeLessThan(full[0].substeps);

    const a = kernel.createGrid(desc());
    const removedFull = kernel.subtract(a, full);
    const b = kernel.createGrid(desc());
    const removedDegraded = kernel.subtract(b, degraded);

    expect(removedDegraded).toBeGreaterThan(removedFull * 0.9);
    expect(removedDegraded).toBeLessThanOrEqual(removedFull);
    kernel.destroyGrid(a);
    kernel.destroyGrid(b);
  });

  it('the worker body drives the real kernel end to end', () => {
    const messages: unknown[] = [];
    let next: (() => void) | null = null;
    const body = new CsgWorkerBody(
      kernel,
      (m) => messages.push(m),
      (run) => { next = run; },
    );
    body.handle({ t: 'createGrid', rid: 1, desc: desc() });
    const drain = (): void => {
      let turns = 0;
      while (next && turns++ < 500) {
        const run = next;
        next = null;
        run();
      }
    };
    drain();

    const created = messages.find((m) => (m as { t: string }).t === 'gridCreated') as
      { grid: { id: number } } | undefined;
    expect(created).toBeDefined();
    const gridId = created!.grid.id;

    const centre = gridPos([0, 0, 0]);
    body.handle({
      t: 'subtract', gridId, gen: 0, seq: 1,
      segments: [seg({
        posStart: centre, posEnd: centre, shape: 0,
        radius: 12, height: 0, boundingRadius: 12, substeps: 1,
      })],
    });
    drain();

    const acks = messages.filter((m) => (m as { t: string }).t === 'ack') as Array<{
      seq: number; removedVoxels: number; pendingJobs: number; pendingChunks: number;
    }>;
    expect(acks.some((a) => a.seq === 1 && a.removedVoxels > 0)).toBe(true);
    // The last ack is the idle ack — MachiningActive must be able to fall again.
    expect(acks[acks.length - 1].seq).toBe(-1);
    expect(acks[acks.length - 1].pendingChunks).toBe(0);

    const chunkBatches = messages.filter((m) => (m as { t: string }).t === 'chunks');
    expect(chunkBatches.length).toBeGreaterThan(0);

    body.handle({ t: 'destroyGrid', rid: 2, gridId });
    expect(body.gridCount).toBe(0);
  });
});
