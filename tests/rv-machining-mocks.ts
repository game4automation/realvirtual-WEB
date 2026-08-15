// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-machining-mocks.ts — shared test doubles for the plan-405 machining suite.
 *
 * NOT a test file (no `describe`): it is imported by `rv-machining-worker.test.ts`
 * and `rv-machining-lifecycle.test.ts`, and importing a `*.test.ts` from another
 * test would register its suites twice.
 *
 * {@link VoxelMockKernel} is deliberately a REAL (if tiny) volumetric model rather
 * than a call recorder: it rasterizes each swept segment as a moving sphere into an
 * occupancy grid. That is what gives the coalescing test teeth — a chord A→C removes
 * a measurably different set of voxels than the two segments A→B→C, so a protocol
 * that collapsed the path would fail instead of silently passing.
 */

import type {
  CsgChunkMesh, CsgGrid, CsgGridDesc, CsgKernelLike, CsgToolSegment,
} from '@rv-private/machining/rv-csg-kernel';
import type { MachiningToolSegment } from '../src/core/engine/rv-machining-registry';

const CHUNK_SIZE = 16;

/** Mock grid: the occupancy bitmap plus the dirty flags, all in plain JS memory. */
export interface MockGrid extends CsgGrid {
  solid: Uint8Array;
  dirty: Uint8Array;
}

/**
 * Deterministic voxel kernel. Subtracting a segment clears every voxel whose center
 * lies inside the tool sphere at ANY of the sampled substep poses.
 */
export class VoxelMockKernel implements CsgKernelLike {
  private _nextId = 1;
  disposed = false;
  /** Every grid this kernel handed out, in creation order. */
  readonly grids: MockGrid[] = [];
  /** Every segment list handed to `subtract`, in order (protocol assertions). */
  readonly subtractCalls: CsgToolSegment[][] = [];
  /** Chunk index lists handed to `tessellate`, in order. */
  readonly tessellateCalls: number[][] = [];
  readonly destroyed: number[] = [];
  readonly resets: number[] = [];
  /** Set to make the next `subtract` throw (kernel-trap simulation). */
  throwOnNextSubtract: string | null = null;

  createGrid(desc: CsgGridDesc): CsgGrid {
    const res = desc.resolution;
    const chunkResolution = {
      x: Math.ceil(res.x / CHUNK_SIZE),
      y: Math.ceil(res.y / CHUNK_SIZE),
      z: Math.ceil(res.z / CHUNK_SIZE),
    };
    const chunkCount = chunkResolution.x * chunkResolution.y * chunkResolution.z;
    const totalVoxels = res.x * res.y * res.z;
    const voxelSizeMm = {
      x: desc.sizeMm.x / Math.max(1, res.x - 3),
      y: desc.sizeMm.y / Math.max(1, res.y - 3),
      z: desc.sizeMm.z / Math.max(1, res.z - 3),
    };
    const grid: MockGrid = {
      id: this._nextId++,
      resolution: { ...res },
      chunkResolution,
      chunkCount,
      totalVoxels,
      voxelSizeMm,
      gridOriginMm: {
        x: -desc.sizeMm.x * 0.5 - voxelSizeMm.x * 1.5,
        y: -desc.sizeMm.y * 0.5 - voxelSizeMm.y * 1.5,
        z: -desc.sizeMm.z * 0.5 - voxelSizeMm.z * 1.5,
      },
      meshing: desc.meshing,
      creaseEnabled: desc.creaseAngleDeg > 0,
      creaseCos: 1,
      initialSolidVoxels: totalVoxels,
      sdfPtr: 1,
      sdfBytes: totalVoxels * 4,
      dirtyPtr: 2,
      dirtyBytes: chunkCount,
      destroyed: false,
      desc,
      solid: new Uint8Array(totalVoxels).fill(1),
      dirty: new Uint8Array(chunkCount).fill(1),
    };
    this.grids.push(grid);
    return grid;
  }

  /** The grid with this id (tests). */
  grid(id: number): MockGrid {
    const g = this.grids.find((x) => x.id === id);
    if (!g) throw new Error(`mock kernel has no grid ${id}`);
    return g;
  }

  resetGrid(grid: CsgGrid): void {
    const g = grid as MockGrid;
    this.resets.push(g.id);
    g.solid.fill(1);
    g.dirty.fill(1);
    g.initialSolidVoxels = g.totalVoxels;
  }

  destroyGrid(grid: CsgGrid): void {
    if (grid.destroyed) return;
    grid.destroyed = true;
    this.destroyed.push(grid.id);
  }

  subtract(grid: CsgGrid, segments: CsgToolSegment[]): number {
    if (this.throwOnNextSubtract) {
      const msg = this.throwOnNextSubtract;
      this.throwOnNextSubtract = null;
      throw new Error(msg);
    }
    // Store a structural copy so later mutation by the caller cannot hide a bug.
    this.subtractCalls.push(segments.map((s) => ({ ...s })));

    const g = grid as MockGrid;
    const r = g.resolution;
    const v = g.voxelSizeMm;
    let removed = 0;
    for (const seg of segments) {
      const steps = Math.max(1, seg.substeps | 0);
      for (let s = 0; s < steps; s++) {
        const t = steps > 1 ? s / (steps - 1) : 1;
        const cx = seg.posStart.x + (seg.posEnd.x - seg.posStart.x) * t;
        const cy = seg.posStart.y + (seg.posEnd.y - seg.posStart.y) * t;
        const cz = seg.posStart.z + (seg.posEnd.z - seg.posStart.z) * t;
        const rad = seg.radius;
        const i0 = Math.max(0, Math.floor((cx - rad) / v.x));
        const i1 = Math.min(r.x - 1, Math.ceil((cx + rad) / v.x));
        const j0 = Math.max(0, Math.floor((cy - rad) / v.y));
        const j1 = Math.min(r.y - 1, Math.ceil((cy + rad) / v.y));
        const k0 = Math.max(0, Math.floor((cz - rad) / v.z));
        const k1 = Math.min(r.z - 1, Math.ceil((cz + rad) / v.z));
        for (let k = k0; k <= k1; k++) {
          for (let j = j0; j <= j1; j++) {
            for (let i = i0; i <= i1; i++) {
              const dx = i * v.x - cx;
              const dy = j * v.y - cy;
              const dz = k * v.z - cz;
              if (dx * dx + dy * dy + dz * dz > rad * rad) continue;
              const idx = i + j * r.x + k * r.x * r.y;
              if (g.solid[idx] === 0) continue;
              g.solid[idx] = 0;
              removed++;
              const ci = Math.floor(i / CHUNK_SIZE)
                + Math.floor(j / CHUNK_SIZE) * g.chunkResolution.x
                + Math.floor(k / CHUNK_SIZE) * g.chunkResolution.x * g.chunkResolution.y;
              g.dirty[ci] = 1;
            }
          }
        }
      }
    }
    return removed;
  }

  drainDirtyChunks(grid: CsgGrid, into: number[]): number {
    const g = grid as MockGrid;
    let n = 0;
    for (let i = 0; i < g.dirty.length; i++) {
      if (g.dirty[i] === 0) continue;
      g.dirty[i] = 0;
      into.push(i);
      n++;
    }
    return n;
  }

  tessellate(grid: CsgGrid, chunkIndices: number[]): CsgChunkMesh[] {
    this.tessellateCalls.push([...chunkIndices]);
    return chunkIndices.map((chunkIndex) => ({
      chunkIndex,
      vertexCount: 3,
      indexCount: 3,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
    }));
  }

  countSolid(grid: CsgGrid): number {
    const g = grid as MockGrid;
    let n = 0;
    for (let i = 0; i < g.solid.length; i++) if (g.solid[i]) n++;
    return n;
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** A 32³ box grid description used across the machining tests. */
export function mockGridDesc(overrides: Partial<CsgGridDesc> = {}): CsgGridDesc {
  return {
    resolution: { x: 32, y: 32, z: 32 },
    sizeMm: { x: 100, y: 60, z: 80 },
    shape: 'Box',
    cylinderAxis: 0,
    meshing: 'MarchingCubes',
    creaseAngleDeg: 35,
    ...overrides,
  };
}

const IDENT = { x: 0, y: 0, z: 0, w: 1 };

/**
 * Builds one swept segment between two grid-space points.
 *
 * Typed with the PUBLIC {@link MachiningToolSegment} (whose `shape` is the literal
 * ABI union, not a bare number) so the same value can be handed to the provider
 * contract AND to the kernel-level worker body without a cast.
 */
export function segment(
  from: [number, number, number],
  to: [number, number, number],
  opts: Partial<MachiningToolSegment> = {},
): MachiningToolSegment {
  return {
    posStart: { x: from[0], y: from[1], z: from[2] },
    posEnd: { x: to[0], y: to[1], z: to[2] },
    rotStart: IDENT,
    rotEnd: IDENT,
    substeps: 8,
    radius: 6,
    height: 30,
    cornerRadius: 0,
    coneRadiusTop: 0,
    shape: 1,
    boundingRadius: 16,
    ...opts,
  };
}
