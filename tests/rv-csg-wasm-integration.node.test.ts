// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-csg-wasm-integration.node.test.ts — plan-405 test 9.1.
 *
 * Loads the REAL `rv_csg.wasm` and verifies the contract the whole feature stands
 * on: the exports, the DOUBLE ABI gate (`rvc` + `rvw`), the complete allocator
 * addendum (16-byte alignment, alloc/free pairs, reuse after free, several grids
 * side by side, OOM and null-pointer behaviour), the view rebind after
 * `memory.grow`, and cross-language golden parity against the Rust host build.
 *
 * NODE test (`*.node.test.ts`, run by `npm run test:node`) — unlike the plan's
 * original file name it cannot be a browser test, because reading the artifact from
 * disk needs `node:fs`. Everything it asserts is environment-independent.
 *
 * The golden numbers are MACHINE-GENERATED, not hand-copied:
 *
 *     cd realvirtualReleaseDLLs/rv-csg
 *     cargo test --release golden_emit -- --nocapture      # writes goldens/rv-csg-goldens.json
 *     ./build.ps1 -Target wasm -DestDir <private>/src/machining
 *
 * The whole suite SKIPS when the artifact is absent (a public checkout has no
 * private repo, and a machine without a Rust toolchain cannot build it) — it never
 * fails for a missing file, and it never silently passes when the file IS there.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CsgKernel,
  RVC_ABI_VERSION,
  RVW_ABI_VERSION,
  SLOT_STRIDE_VERTS,
  TESSELLATE_BATCH,
  type CsgGridDesc,
  type CsgWasmExports,
} from '@rv-private/machining/rv-csg-kernel';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Both layouts: the worktree sibling and a plain checkout. */
const WASM_CANDIDATES = [
  resolve(HERE, '../../realvirtual-WebViewer-Private~/src/machining/rv_csg.wasm'),
  resolve(HERE, '../../realvirtual-web-pro/src/machining/rv_csg.wasm'),
];
/**
 * The Rust crate lives OUT of every repo, at `<WS>/game4automation/realvirtualReleaseDLLs`
 * (CLAUDE.md "Machine Layout"; `<WS>` = the directory carrying `.plastic`). `<WS>` differs
 * per machine AND this checkout may be a worktree, which lives at `<WS>/../rv-worktrees` —
 * a SIBLING of the workspace, not below it. A fixed hop count therefore cannot work.
 *
 * Resolution order: `RV_CSG_GOLDENS` → each ancestor of this file → each workspace
 * (`.plastic`) directly under one of those ancestors, which is what covers the worktree
 * case. All of it is best-effort: not finding the file skips the parity suite, it never
 * fails the run.
 */
const GOLDEN_SUFFIXES = [
  'realvirtualReleaseDLLs/rv-csg/goldens/rv-csg-goldens.json',
  'game4automation/realvirtualReleaseDLLs/rv-csg/goldens/rv-csg-goldens.json',
];

function findGoldens(): string | undefined {
  const fromEnv = process.env.RV_CSG_GOLDENS;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const hit = (base: string): string | undefined =>
    GOLDEN_SUFFIXES.map((s) => resolve(base, s)).find((p) => existsSync(p));

  const ancestors: string[] = [];
  for (let dir = HERE, i = 0; i < 12; i++) {
    ancestors.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  for (const dir of ancestors) {
    const direct = hit(dir);
    if (direct) return direct;
  }
  // Sideways: a Plastic workspace parked next to one of our ancestors (worktree layout).
  for (const dir of ancestors) {
    let children: string[];
    try {
      children = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => resolve(dir, e.name));
    } catch {
      continue;
    }
    for (const child of children) {
      if (!existsSync(resolve(child, '.plastic'))) continue;
      const found = hit(child);
      if (found) return found;
    }
  }
  return undefined;
}

const WASM_PATH = WASM_CANDIDATES.find((p) => existsSync(p));
const GOLDEN_PATH = findGoldens();

interface Goldens {
  abiVersion: number;
  grid: { res: [number, number, number]; sizeMm: [number, number, number] };
  solidBox: number;
  solidCylinderY: number;
  mcChunk0: [number, number];
  dcChunk0: [number, number];
  removedByShape: number[];
  solidByShape: number[];
  dirtyChunksByShape: number[];
  curvedSweepRemoved: number;
  curvedSweepSolid: number;
  twoSpheresRemoved: number;
  twoSpheresSolid: number;
}

/** Same lattice as the Rust golden harness (`wasm_goldens::golden_setup`). */
const RES = 32;
const SIZE = { x: 100, y: 60, z: 80 };
const VOXEL = { x: SIZE.x / (RES - 3), y: SIZE.y / (RES - 3), z: SIZE.z / (RES - 3) };
const ORIGIN = {
  x: -SIZE.x * 0.5 - VOXEL.x * 1.5,
  y: -SIZE.y * 0.5 - VOXEL.y * 1.5,
  z: -SIZE.z * 0.5 - VOXEL.z * 1.5,
};
const IDENT = { x: 0, y: 0, z: 0, w: 1 };

function boxDesc(overrides: Partial<CsgGridDesc> = {}): CsgGridDesc {
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

/** Grid-space position of a volume-local millimeter point. */
function gridPos(local: [number, number, number]): { x: number; y: number; z: number } {
  return { x: local[0] - ORIGIN.x, y: local[1] - ORIGIN.y, z: local[2] - ORIGIN.z };
}

function tool(
  posStart: { x: number; y: number; z: number },
  posEnd: { x: number; y: number; z: number },
  shape: number,
  radius: number,
  height: number,
  cornerRadius: number,
  coneRadiusTop: number,
  boundingRadius: number,
  substeps = 1,
  rotStart = IDENT,
  rotEnd = IDENT,
): Parameters<CsgKernel['subtract']>[1][number] {
  return {
    posStart, posEnd, rotStart, rotEnd, substeps,
    radius, height, cornerRadius, coneRadiusTop,
    shape, boundingRadius,
  };
}

const describeWasm = WASM_PATH ? describe : describe.skip;

if (!WASM_PATH) {
  // Make the reason visible in the run output — a silently skipped ABI suite is
  // exactly how a broken artifact reaches a release.
  console.warn(
    '[rv-csg] rv_csg.wasm not found — the real-WASM integration suite is SKIPPED.\n'
    + `  looked in:\n    ${WASM_CANDIDATES.join('\n    ')}\n`
    + '  build it with: realvirtualReleaseDLLs/rv-csg/build.ps1 -Target wasm',
  );
}

/**
 * `readFile` yields a Node Buffer, whose backing store TypeScript types as
 * `ArrayBufferLike` (it could be a SharedArrayBuffer). `WebAssembly.instantiate`
 * needs a real `BufferSource`; handing it the Buffer resolves the *Module*
 * overload instead and the result loses its `.instance`. Copying into a plain
 * ArrayBuffer settles both problems at the cost of one memcpy per test file.
 */
async function loadWasm(path: string): Promise<ArrayBuffer> {
  const buf = await readFile(path);
  const out = new ArrayBuffer(buf.byteLength);
  new Uint8Array(out).set(buf);
  return out;
}

describeWasm('rv_csg.wasm — ABI and allocator (plan-405 §9.1)', () => {
  let raw: CsgWasmExports;
  let bytes: ArrayBuffer;

  beforeAll(async () => {
    bytes = await loadWasm(WASM_PATH!);
    const source = await WebAssembly.instantiate(bytes, {});
    raw = source.instance.exports as unknown as CsgWasmExports;
  });

  it('exports all 7 rvc_* plus the 3 wasm-only rvw_* entry points', () => {
    for (const fn of [
      'rvc_abi_version', 'rvc_init_box', 'rvc_init_cylinder', 'rvc_voxelize_mesh',
      'rvc_subtract', 'rvc_count_solid', 'rvc_tessellate',
      'rvw_abi_version', 'rvw_alloc', 'rvw_free',
    ]) {
      expect(typeof (raw as unknown as Record<string, unknown>)[fn], fn).toBe('function');
    }
    expect(raw.memory).toBeInstanceOf(WebAssembly.Memory);
  });

  it('passes the DOUBLE ABI gate', () => {
    expect(raw.rvc_abi_version()).toBe(RVC_ABI_VERSION);
    expect(raw.rvw_abi_version()).toBe(RVW_ABI_VERSION);
  });

  it('returns 16-byte-aligned, non-overlapping blocks', () => {
    const sizes = [16, 100, 4096, 65_536];
    const ptrs = sizes.map((n) => raw.rvw_alloc(n));
    try {
      for (let i = 0; i < ptrs.length; i++) {
        expect(ptrs[i], `alloc(${sizes[i]})`).toBeGreaterThan(0);
        expect(ptrs[i] % 16, `alignment of alloc(${sizes[i]})`).toBe(0);
      }
      // No two live blocks may overlap.
      for (let i = 0; i < ptrs.length; i++) {
        for (let j = i + 1; j < ptrs.length; j++) {
          const a = { lo: ptrs[i], hi: ptrs[i] + sizes[i] };
          const b = { lo: ptrs[j], hi: ptrs[j] + sizes[j] };
          expect(a.lo >= b.hi || b.lo >= a.hi, `blocks ${i}/${j} overlap`).toBe(true);
        }
      }
    } finally {
      ptrs.forEach((p, i) => raw.rvw_free(p, sizes[i]));
    }
  });

  it('rejects non-positive sizes with the documented 0', () => {
    expect(raw.rvw_alloc(0)).toBe(0);
    expect(raw.rvw_alloc(-1)).toBe(0);
    // Freeing a null pointer (or zero bytes) must be a silent no-op — this is
    // what makes an idempotent destroyGrid safe.
    expect(() => raw.rvw_free(0, 0)).not.toThrow();
    expect(() => raw.rvw_free(0, 1024)).not.toThrow();
  });

  it('reuses freed memory instead of growing forever', () => {
    const size = 1 << 20;
    const first = raw.rvw_alloc(size);
    expect(first).toBeGreaterThan(0);
    raw.rvw_free(first, size);
    const second = raw.rvw_alloc(size);
    expect(second).toBe(first);
    raw.rvw_free(second, size);
  });

  it('returns 0 rather than trapping on an impossible allocation', () => {
    // 3 GiB exceeds the 32-bit address space of wasm32 linear memory.
    expect(raw.rvw_alloc(3 * 1024 * 1024 * 1024)).toBe(0);
    // The instance must still be usable afterwards.
    expect(raw.rvc_abi_version()).toBe(RVC_ABI_VERSION);
  });

  it('rebinds TypedArray views after memory.grow (silent-corruption guard)', async () => {
    const kernel = await CsgKernel.instantiate(bytes);

    const firstBuffer = kernel.exports.memory.buffer;
    const rebindsBefore = kernel.views.rebindCount;

    const probe = kernel.alloc(64);
    kernel.views.f32[probe >>> 2] = 1234.5;

    // Allocate until the memory really grows (the ArrayBuffer identity changes).
    const blocks: Array<[number, number]> = [];
    const chunk = 8 << 20;
    for (let i = 0; i < 64 && kernel.exports.memory.buffer === firstBuffer; i++) {
      blocks.push([kernel.alloc(chunk), chunk]);
    }
    expect(kernel.exports.memory.buffer).not.toBe(firstBuffer);
    expect(kernel.views.rebindCount).toBeGreaterThan(rebindsBefore);

    // The value written BEFORE the grow is still readable through the new view —
    // reading it through a stale view would return garbage or throw.
    expect(kernel.views.f32[probe >>> 2]).toBe(1234.5);

    for (const [ptr, size] of blocks) kernel.free(ptr, size);
    kernel.free(probe, 64);
    kernel.dispose();
  });

  it('keeps several grids alive side by side and frees each exactly once', async () => {
    const kernel = await CsgKernel.instantiate(bytes);
    const a = kernel.createGrid(boxDesc());
    const b = kernel.createGrid(boxDesc({ shape: 'Cylinder', cylinderAxis: 1 }));
    expect(a.id).not.toBe(b.id);
    expect(a.sdfPtr).not.toBe(b.sdfPtr);
    expect(a.sdfPtr % 16).toBe(0);
    expect(b.sdfPtr % 16).toBe(0);

    // Cutting one grid must not touch the other.
    const before = kernel.countSolid(b);
    kernel.subtract(a, [tool(gridPos([0, 0, 0]), gridPos([0, 0, 0]), 0, 12, 0, 0, 0, 12)]);
    expect(kernel.countSolid(b)).toBe(before);

    kernel.destroyGrid(a);
    kernel.destroyGrid(a); // idempotent
    expect(a.sdfPtr).toBe(0);
    expect(kernel.countSolid(b)).toBe(before);
    kernel.destroyGrid(b);
    kernel.dispose();
  });

  it('allocates the 16-slot tessellation scratch once and reports its size', async () => {
    const kernel = await CsgKernel.instantiate(bytes);
    const grid = kernel.createGrid(boxDesc());
    expect(kernel.scratchBytes).toBe(0);
    kernel.tessellate(grid, [0]);
    const afterFirst = kernel.scratchBytes;
    kernel.tessellate(grid, [1]);
    expect(kernel.scratchBytes).toBe(afterFirst);

    // 16 slots × 65536 verts × (pos 12 B + nrm 12 B + uv 8 B + idx 4 B) ≈ 36 MiB.
    const slotVerts = TESSELLATE_BATCH * SLOT_STRIDE_VERTS;
    expect(afterFirst).toBeGreaterThan(slotVerts * 36);
    expect(afterFirst).toBeLessThan(40 * 1024 * 1024);

    kernel.destroyGrid(grid);
    kernel.dispose();
  });

  it('rejects a tessellation batch larger than the slot count', async () => {
    const kernel = await CsgKernel.instantiate(bytes);
    const grid = kernel.createGrid(boxDesc());
    const tooMany = Array.from({ length: TESSELLATE_BATCH + 1 }, (_, i) => i % grid.chunkCount);
    expect(() => kernel.tessellate(grid, tooMany)).toThrow(/at most 16/);
    kernel.destroyGrid(grid);
    kernel.dispose();
  });
});

const describeGolden = WASM_PATH && GOLDEN_PATH ? describe : describe.skip;

if (WASM_PATH && !GOLDEN_PATH) {
  console.warn(
    '[rv-csg] goldens/rv-csg-goldens.json not found — cross-language parity is SKIPPED.\n'
    + '  generate it with: cargo test --release golden_emit -- --nocapture',
  );
}

describeGolden('rv_csg.wasm — cross-language golden parity (plan-405 §9.1/§9.6)', () => {
  let kernel: CsgKernel;
  let g: Goldens;

  beforeAll(async () => {
    kernel = await CsgKernel.instantiate(await loadWasm(WASM_PATH!));
    g = JSON.parse(await readFile(GOLDEN_PATH!, 'utf8')) as Goldens;
  });

  it('the goldens were generated for the same ABI and lattice', () => {
    expect(g.abiVersion).toBe(RVC_ABI_VERSION);
    expect(g.grid.res).toEqual([RES, RES, RES]);
    expect(g.grid.sizeMm).toEqual([SIZE.x, SIZE.y, SIZE.z]);
  });

  it('box stock matches the Rust solid count', () => {
    const grid = kernel.createGrid(boxDesc());
    expect(kernel.countSolid(grid)).toBe(g.solidBox);
    expect(grid.initialSolidVoxels).toBe(g.solidBox);
    kernel.destroyGrid(grid);
  });

  it('cylinder stock (axis Y) matches the Rust solid count', () => {
    const grid = kernel.createGrid(boxDesc({ shape: 'Cylinder', cylinderAxis: 1 }));
    expect(kernel.countSolid(grid)).toBe(g.solidCylinderY);
    kernel.destroyGrid(grid);
  });

  it('all five tool shapes remove exactly what the Rust build removes', () => {
    const cases: Array<[number, number, number, number, number, number]> = [
      [0, 12, 0, 0, 0, 12],
      [1, 8, 40, 0, 0, Math.sqrt(8 * 8 + 20 * 20)],
      [2, 8, 40, 0, 0, Math.sqrt(8 * 8 + 20 * 20)],
      [3, 12, 0, 3, 0, 12],
      [4, 10, 30, 0, 4, Math.sqrt(10 * 10 + 15 * 15)],
    ];
    const centre = gridPos([0, 0, 0]);
    const removed: number[] = [];
    const solid: number[] = [];
    for (const [shape, r, h, cr, ct, bound] of cases) {
      const grid = kernel.createGrid(boxDesc());
      removed.push(kernel.subtract(grid, [tool(centre, centre, shape, r, h, cr, ct, bound)]));
      solid.push(kernel.countSolid(grid));
      kernel.destroyGrid(grid);
    }
    expect(removed).toEqual(g.removedByShape);
    expect(solid).toEqual(g.solidByShape);
  });

  it('marching-cubes and dual-contouring produce the Rust vertex/index counts', () => {
    for (const [meshing, golden] of [
      ['MarchingCubes', g.mcChunk0], ['DualContouring', g.dcChunk0],
    ] as const) {
      const grid = kernel.createGrid(boxDesc({ meshing }));
      const [chunk] = kernel.tessellate(grid, [0]);
      expect([chunk.vertexCount, chunk.indexCount], meshing).toEqual(golden);
      expect(chunk.positions.length).toBe(chunk.vertexCount * 3);
      expect(chunk.indices.length).toBe(chunk.indexCount);
      kernel.destroyGrid(grid);
    }
    // The two modes must actually differ — otherwise the mode flag is ignored.
    expect(g.mcChunk0).not.toEqual(g.dcChunk0);
  });

  it('a curved rotating sweep matches the Rust reference', () => {
    const a = gridPos([-30, 0, -20]);
    const b = gridPos([0, 0, 20]);
    const c = gridPos([30, 0, -20]);
    const q = (deg: number): { x: number; y: number; z: number; w: number } => {
      const half = (deg * Math.PI) / 360;
      return { x: 0, y: 0, z: Math.sin(half), w: Math.cos(half) };
    };
    const radius = 6;
    const height = 40;
    const bound = Math.sqrt(radius * radius + (height / 2) * (height / 2));

    const grid = kernel.createGrid(boxDesc());
    let removed = 0;
    removed += kernel.subtract(grid, [
      tool(a, b, 1, radius, height, 0, 0, bound, 24, q(0), q(30)),
    ]);
    removed += kernel.subtract(grid, [
      tool(b, c, 1, radius, height, 0, 0, bound, 24, q(30), q(60)),
    ]);
    expect(removed).toBe(g.curvedSweepRemoved);
    expect(kernel.countSolid(grid)).toBe(g.curvedSweepSolid);
    kernel.destroyGrid(grid);
  });

  it('a coalesced two-segment job equals the two-tick sequence (R2-3)', () => {
    const a = gridPos([-30, 0, -20]);
    const b = gridPos([0, 0, 20]);
    const c = gridPos([30, 0, -20]);
    const q = (deg: number): { x: number; y: number; z: number; w: number } => {
      const half = (deg * Math.PI) / 360;
      return { x: 0, y: 0, z: Math.sin(half), w: Math.cos(half) };
    };
    const bound = Math.sqrt(6 * 6 + 20 * 20);

    const coalesced = kernel.createGrid(boxDesc());
    const removed = kernel.subtract(coalesced, [
      tool(a, b, 1, 6, 40, 0, 0, bound, 24, q(0), q(30)),
      tool(b, c, 1, 6, 40, 0, 0, bound, 24, q(30), q(60)),
    ]);
    expect(removed).toBe(g.curvedSweepRemoved);
    expect(kernel.countSolid(coalesced)).toBe(g.curvedSweepSolid);
    kernel.destroyGrid(coalesced);

    // Counter-proof: the chord must NOT reproduce it.
    const chord = kernel.createGrid(boxDesc());
    kernel.subtract(chord, [tool(a, c, 1, 6, 40, 0, 0, bound, 24, q(0), q(60))]);
    expect(kernel.countSolid(chord)).not.toBe(g.curvedSweepSolid);
    kernel.destroyGrid(chord);
  });

  it('two overlapping tools in one call match the Rust reference', () => {
    const grid = kernel.createGrid(boxDesc());
    const removed = kernel.subtract(grid, [
      tool(gridPos([-6, 0, 0]), gridPos([-6, 0, 0]), 0, 12, 0, 0, 0, 12),
      tool(gridPos([6, 0, 0]), gridPos([6, 0, 0]), 0, 12, 0, 0, 0, 12),
    ]);
    expect(removed).toBe(g.twoSpheresRemoved);
    expect(kernel.countSolid(grid)).toBe(g.twoSpheresSolid);
    kernel.destroyGrid(grid);
  });
});
