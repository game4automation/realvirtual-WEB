// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-machining-volume.test.ts — plan-405 test 9.4.
 *
 * The component itself: rv_extras parsing (every field, both enums, defaults and
 * clamps), ORDERED tool resolution plus the additional `ToolGroup` scan, and the
 * chunk render path — actual-size allocation with 1.5× headroom, reallocation ONLY
 * on overflow (disposing the old geometry exactly once), and the F10 fallback where
 * the authored workpiece mesh simply stays visible.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BufferAttribute, BufferGeometry, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { applySchema, type ComponentContext } from '../src/core/engine/rv-component-registry';
import { isBatchSafe } from '../src/core/engine/rv-batched-render';
import {
  CHUNK_CAPACITY_HEADROOM,
  RVMachiningVolume,
  chunkResolutionFor,
  cylinderAxisValue,
} from '../src/core/engine/rv-machining-volume';
import { RVMachiningTool, machiningToolShapeValue } from '../src/core/engine/rv-machining-tool';
import type { MachiningChunkMesh, MachiningGridHandle } from '../src/core/engine/rv-machining-registry';

// ─── Fixtures ───────────────────────────────────────────────────────────

function makeContext(registry: NodeRegistry): ComponentContext {
  return {
    registry,
    scene: new Scene(),
    signalStore: {} as ComponentContext['signalStore'],
    transportManager: {} as ComponentContext['transportManager'],
    root: new Object3D(),
  } as ComponentContext;
}

/** Builds a node with one visible box-ish mesh under it. */
function makeWorkpieceNode(name = 'Workpiece'): { node: Object3D; mesh: Mesh } {
  const node = new Object3D();
  node.name = name;
  const geo = new BufferGeometry();
  // A minimal closed-ish soup: 4 verts, 4 triangles (tetrahedron).
  geo.setAttribute('position', new BufferAttribute(new Float32Array([
    0, 0, 0, 0.1, 0, 0, 0, 0.1, 0, 0, 0, 0.1,
  ]), 3));
  geo.setIndex(new BufferAttribute(new Uint32Array([0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3]), 1));
  const mesh = new Mesh(geo, new MeshStandardMaterial());
  mesh.name = `${name}_mesh`;
  node.add(mesh);
  return { node, mesh };
}

function makeTool(registry: NodeRegistry, path: string, extras: Record<string, unknown> = {}): RVMachiningTool {
  const node = new Object3D();
  node.name = path.split('/').pop()!;
  const tool = new RVMachiningTool(node);
  applySchema(tool as unknown as Record<string, unknown>, RVMachiningTool.schema, extras);
  tool.init(makeContext(registry));
  registry.registerNode(path, node);
  registry.register('MachiningTool', path, tool);
  Object.defineProperty(node.userData, '_rvComponentInstance', {
    value: tool, writable: true, configurable: true, enumerable: false,
  });
  return tool;
}

function gridHandle(overrides: Partial<MachiningGridHandle> = {}): MachiningGridHandle {
  const resolution = { x: 32, y: 32, z: 32 };
  const chunkResolution = chunkResolutionFor(resolution);
  return {
    id: 1,
    resolution,
    chunkResolution,
    chunkCount: chunkResolution.x * chunkResolution.y * chunkResolution.z,
    voxelSizeMm: { x: 100 / 29, y: 60 / 29, z: 80 / 29 },
    gridOriginMm: { x: -55.17, y: -33.1, z: -44.14 },
    totalVoxels: 32 * 32 * 32,
    initialSolidVoxels: 20000,
    ...overrides,
  };
}

function chunkMesh(chunkIndex: number, vertexCount: number, indexCount: number): MachiningChunkMesh {
  return {
    chunkIndex,
    vertexCount,
    indexCount,
    positions: new Float32Array(vertexCount * 3).fill(1),
    normals: new Float32Array(vertexCount * 3).fill(0),
    uvs: new Float32Array(vertexCount * 2).fill(0.5),
    indices: Uint32Array.from({ length: indexCount }, (_, i) => i % Math.max(1, vertexCount)),
  };
}

// ─── Extras parsing ─────────────────────────────────────────────────────

describe('RVMachiningVolume — extras parsing (plan-405 §9.4)', () => {
  let registry: NodeRegistry;

  beforeEach(() => { registry = new NodeRegistry(); });

  it('applies every authored field', () => {
    const { node } = makeWorkpieceNode();
    const v = new RVMachiningVolume(node);
    applySchema(v as unknown as Record<string, unknown>, RVMachiningVolume.schema, {
      gridResolution: { x: 48, y: 96, z: 48 },
      workpieceSize: { x: 60, y: 200, z: 60 },
      Shape: 'Cylinder',
      CylinderAxis: 'Y',
      ToolGroup: 'Cutters',
      SweepToolMotion: false,
      MaxSweepSubsteps: 24,
      Meshing: 'DualContouring',
      CreaseAngle: 12,
      GenerateUVs: false,
      StatisticsInterval: 1.5,
    });
    v.init(makeContext(registry));

    expect(v.gridResolution.toArray()).toEqual([48, 96, 48]);
    expect(v.workpieceSize.toArray()).toEqual([60, 200, 60]);
    expect(v.Shape).toBe('Cylinder');
    expect(v.CylinderAxis).toBe('Y');
    expect(v.ToolGroup).toBe('Cutters');
    expect(v.SweepToolMotion).toBe(false);
    expect(v.MaxSweepSubsteps).toBe(24);
    expect(v.Meshing).toBe('DualContouring');
    expect(v.CreaseAngle).toBe(12);
    expect(v.GenerateUVs).toBe(false);
    expect(v.StatisticsInterval).toBe(1.5);
  });

  it('falls back to the C# defaults for an empty extras record', () => {
    const { node } = makeWorkpieceNode();
    const v = new RVMachiningVolume(node);
    applySchema(v as unknown as Record<string, unknown>, RVMachiningVolume.schema, {});
    v.init(makeContext(registry));

    expect(v.gridResolution.toArray()).toEqual([64, 64, 64]);
    expect(v.workpieceSize.toArray()).toEqual([200, 100, 200]);
    expect(v.Shape).toBe('Box');
    expect(v.CylinderAxis).toBe('X');
    expect(v.Meshing).toBe('MarchingCubes');
    expect(v.SweepToolMotion).toBe(true);
    expect(v.MaxSweepSubsteps).toBe(16);
    expect(v.GenerateUVs).toBe(true);
    expect(v.CreaseAngle).toBe(35);
    expect(v.StatisticsInterval).toBe(0.25);
  });

  it('rejects nonsense enums and clamps the lattice / size (parity with the C# guards)', () => {
    const { node } = makeWorkpieceNode();
    const v = new RVMachiningVolume(node);
    applySchema(v as unknown as Record<string, unknown>, RVMachiningVolume.schema, {
      gridResolution: { x: 1, y: 4096, z: 33.4 },
      workpieceSize: { x: 0, y: -50, z: 12 },
      Shape: 'Blob',
      CylinderAxis: 'Q',
      Meshing: 'Voronoi',
    });
    v.init(makeContext(registry));

    // >= 4 keeps two interior voxels next to the padding layer; the upper bound
    // stops an authoring typo from requesting gigabytes.
    expect(v.gridResolution.toArray()).toEqual([4, 256, 33]);
    expect(v.workpieceSize.toArray()).toEqual([1, 50, 12]);
    expect(v.Shape).toBe('Box');
    expect(v.CylinderAxis).toBe('X');
    expect(v.Meshing).toBe('MarchingCubes');
  });

  it('maps the cylinder axis to the kernel enum', () => {
    expect(cylinderAxisValue('X')).toBe(0);
    expect(cylinderAxisValue('Y')).toBe(1);
    expect(cylinderAxisValue('Z')).toBe(2);
  });

  it('builds a grid description that matches the authored stock', () => {
    const { node } = makeWorkpieceNode();
    const v = new RVMachiningVolume(node);
    applySchema(v as unknown as Record<string, unknown>, RVMachiningVolume.schema, {
      gridResolution: { x: 32, y: 32, z: 32 },
      workpieceSize: { x: 100, y: 60, z: 80 },
      Shape: 'Cylinder',
      CylinderAxis: 'Z',
      CreaseAngle: 0,
    });
    v.init(makeContext(registry));
    const desc = v.buildGridDesc();

    expect(desc).toMatchObject({
      resolution: { x: 32, y: 32, z: 32 },
      sizeMm: { x: 100, y: 60, z: 80 },
      shape: 'Cylinder',
      cylinderAxis: 2,
      meshing: 'MarchingCubes',
      creaseAngleDeg: 0,
    });
    expect(desc.meshVerticesMm).toBeUndefined();
  });

  it('Shape=Mesh voxelizes the node geometry and reports its bounds in mm', () => {
    const { node } = makeWorkpieceNode();
    const v = new RVMachiningVolume(node);
    applySchema(v as unknown as Record<string, unknown>, RVMachiningVolume.schema, { Shape: 'Mesh' });
    v.init(makeContext(registry));
    const desc = v.buildGridDesc();

    expect(desc.shape).toBe('Mesh');
    expect(desc.meshVerticesMm).toBeInstanceOf(Float32Array);
    expect(desc.meshTriangles).toBeInstanceOf(Int32Array);
    expect(desc.meshVerticesMm!.length).toBe(4 * 3);
    expect(desc.meshTriangles!.length).toBe(12);
    // 0.1 three.js units = 100 mm (float32 geometry, hence the tolerance).
    expect(desc.meshBoundsSizeMm!.x).toBeCloseTo(100, 4);
    expect(desc.meshBoundsSizeMm!.y).toBeCloseTo(100, 4);
    expect(desc.meshBoundsSizeMm!.z).toBeCloseTo(100, 4);
    expect(desc.meshBoundsMinMm).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('Shape=Mesh without usable geometry degrades to Box with one warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const node = new Object3D();
    node.name = 'Empty';
    const v = new RVMachiningVolume(node);
    applySchema(v as unknown as Record<string, unknown>, RVMachiningVolume.schema, { Shape: 'Mesh' });
    v.init(makeContext(registry));

    expect(v.buildGridDesc().shape).toBe('Box');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

// ─── Tool discovery ─────────────────────────────────────────────────────

describe('RVMachiningVolume — tool discovery (plan-405 F7, §9.4)', () => {
  let registry: NodeRegistry;

  beforeEach(() => { registry = new NodeRegistry(); });

  function volumeWith(extras: Record<string, unknown>): RVMachiningVolume {
    const { node } = makeWorkpieceNode();
    const v = new RVMachiningVolume(node);
    applySchema(v as unknown as Record<string, unknown>, RVMachiningVolume.schema, extras);
    const ctx = makeContext(registry);
    v.init(ctx);
    v.onSceneReady(ctx);
    return v;
  }

  it('keeps the authored Tools ORDER — the subtraction result depends on it', () => {
    const a = makeTool(registry, 'Machine/ToolA');
    const b = makeTool(registry, 'Machine/ToolB');
    const c = makeTool(registry, 'Machine/ToolC');

    const v = volumeWith({});
    // Resolved node references, in the authored order.
    v.Tools = [c.node, a.node, b.node];
    v.resolveTools();
    expect(v.tools).toEqual([c, a, b]);
  });

  it('accepts unresolved path strings as well (wire-format tolerance)', () => {
    const a = makeTool(registry, 'Machine/ToolA');
    const b = makeTool(registry, 'Machine/ToolB');
    const v = volumeWith({});
    v.Tools = ['Machine/ToolB', 'Machine/ToolA'];
    v.resolveTools();
    expect(v.tools).toEqual([b, a]);
  });

  it('ignores unresolvable entries instead of throwing', () => {
    const a = makeTool(registry, 'Machine/ToolA');
    const v = volumeWith({});
    v.Tools = [null, 'Machine/Missing', a.node, 42];
    v.resolveTools();
    expect(v.tools).toEqual([a]);
  });

  it('adds ToolGroup members after the explicit list, without duplicates', () => {
    const explicitTool = makeTool(registry, 'Machine/Explicit');
    const grouped = makeTool(registry, 'Machine/Grouped');
    grouped.node.userData.realvirtual = { Group: { GroupName: 'Cutters' } };
    // A tool that is BOTH listed and in the group must appear exactly once.
    const both = makeTool(registry, 'Machine/Both');
    both.node.userData.realvirtual = { Group_1: { GroupName: 'Cutters' } };
    makeTool(registry, 'Machine/Other').node.userData.realvirtual = {
      Group: { GroupName: 'SomethingElse' },
    };

    const v = volumeWith({ ToolGroup: 'Cutters' });
    v.Tools = [explicitTool.node, both.node];
    v.resolveTools();

    expect(v.tools.slice(0, 2)).toEqual([explicitTool, both]);
    expect(v.tools).toContain(grouped);
    expect(v.tools.filter((t) => t === both)).toHaveLength(1);
    expect(v.tools).toHaveLength(3);
  });

  it('honours a disabled Group entry', () => {
    const grouped = makeTool(registry, 'Machine/Grouped');
    grouped.node.userData.realvirtual = { Group: { GroupName: 'Cutters', _enabled: false } };
    const v = volumeWith({ ToolGroup: 'Cutters' });
    v.resolveTools();
    expect(v.tools).toHaveLength(0);
  });
});

// ─── Tool geometry parity ───────────────────────────────────────────────

describe('RVMachiningTool — derived geometry (plan-405 §9.4)', () => {
  const registry = new NodeRegistry();

  it('mirrors MachiningTool.cs radius / cone radius / bounding radius', () => {
    const tool = makeTool(registry, 'T/Cyl', {
      Shape: 'Cylinder', ToolDiameter: 16, ToolLength: 40, CornerRadius: 3, TaperAngleDeg: 30,
    });
    expect(tool.toolRadius).toBe(8);
    expect(tool.coneRadiusTop).toBeCloseTo(8 * Math.tan(Math.PI / 6), 10);
    // Corner distance sqrt(r² + (h/2)²) — NOT max(r, h/2): the AABB must stay
    // valid when the cutter is tilted.
    expect(tool.boundingRadius).toBeCloseTo(Math.sqrt(8 * 8 + 20 * 20), 10);
  });

  it('uses the plain radius for the rotationally symmetric shapes', () => {
    const sphere = makeTool(registry, 'T/Sphere', { Shape: 'Sphere', ToolDiameter: 24, ToolLength: 99 });
    expect(sphere.boundingRadius).toBe(12);
    const torus = makeTool(registry, 'T/Torus', { Shape: 'Torus', ToolDiameter: 24, ToolLength: 99 });
    expect(torus.boundingRadius).toBe(12);
  });

  it('maps shape names to the ABI integers', () => {
    expect(machiningToolShapeValue('Sphere')).toBe(0);
    expect(machiningToolShapeValue('Cylinder')).toBe(1);
    expect(machiningToolShapeValue('BallNose')).toBe(2);
    expect(machiningToolShapeValue('Torus')).toBe(3);
    expect(machiningToolShapeValue('ConicalEnd')).toBe(4);
  });

  it('falls back to Cylinder for an unknown shape', () => {
    const tool = makeTool(registry, 'T/Weird', { Shape: 'Chainsaw' });
    expect(tool.Shape).toBe('Cylinder');
  });
});

// ─── Chunk render path ──────────────────────────────────────────────────

describe('RVMachiningVolume — chunk geometry (plan-405 §9.4, R2 finding 2)', () => {
  let registry: NodeRegistry;

  beforeEach(() => { registry = new NodeRegistry(); });

  function readyVolume(): { volume: RVMachiningVolume; original: Mesh; node: Object3D } {
    const { node, mesh } = makeWorkpieceNode();
    const v = new RVMachiningVolume(node);
    applySchema(v as unknown as Record<string, unknown>, RVMachiningVolume.schema, {});
    const ctx = makeContext(registry);
    v.init(ctx);
    v.onSceneReady(ctx);
    v.attachGrid(gridHandle());
    return { volume: v, original: mesh, node };
  }

  it('hides the authored mesh once the grid exists and restores it on teardown', () => {
    const { volume, original } = readyVolume();
    expect(original.visible).toBe(false);
    expect(volume.chunkRoot).not.toBeNull();
    expect(volume.IsInitialized).toBe(true);

    volume.teardownRender();
    expect(original.visible).toBe(true);
    expect(volume.chunkRoot).toBeNull();
    expect(volume.IsInitialized).toBe(false);
  });

  it('leaves the authored mesh alone when no grid ever arrives (F10)', () => {
    const { node, mesh } = makeWorkpieceNode();
    const v = new RVMachiningVolume(node);
    applySchema(v as unknown as Record<string, unknown>, RVMachiningVolume.schema, {});
    const ctx = makeContext(registry);
    v.init(ctx);
    v.onSceneReady(ctx);

    expect(mesh.visible).toBe(true);
    expect(v.chunkRoot).toBeNull();
    expect(v.IsInitialized).toBe(false);
  });

  it('allocates chunk buffers at ACTUAL size with 1.5x headroom, not the worst case', () => {
    const { volume } = readyVolume();
    expect(volume.applyChunk(chunkMesh(0, 100, 150))).toBe(true);

    const mesh = volume.chunkRoot!.children[0] as Mesh;
    const pos = mesh.geometry.getAttribute('position');
    const idx = mesh.geometry.getIndex()!;

    expect(pos.count).toBe(Math.ceil(100 * CHUNK_CAPACITY_HEADROOM));
    expect(idx.count).toBe(Math.ceil(150 * CHUNK_CAPACITY_HEADROOM));
    // The DRAW range is the actual index count — the headroom is never rendered.
    expect(mesh.geometry.drawRange.count).toBe(150);
    // Worst-case would be 65536 verts per chunk; that is what this guards against.
    expect(pos.count).toBeLessThan(1000);
    expect(mesh.visible).toBe(true);
  });

  it('reuses the buffers while the counts fit and reallocates exactly once on overflow', () => {
    const { volume } = readyVolume();
    volume.applyChunk(chunkMesh(0, 100, 150));
    const mesh = volume.chunkRoot!.children[0] as Mesh;
    const firstGeometry = mesh.geometry;
    const disposeSpy = vi.spyOn(firstGeometry, 'dispose');

    // Still inside the headroom → same geometry object, no dispose.
    volume.applyChunk(chunkMesh(0, 140, 210));
    expect(mesh.geometry).toBe(firstGeometry);
    expect(disposeSpy).not.toHaveBeenCalled();
    expect(firstGeometry.drawRange.count).toBe(210);

    // Overflow → exactly one realloc, old geometry disposed exactly once.
    volume.applyChunk(chunkMesh(0, 500, 900));
    expect(mesh.geometry).not.toBe(firstGeometry);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(mesh.geometry.getAttribute('position').count)
      .toBe(Math.ceil(500 * CHUNK_CAPACITY_HEADROOM));
    // Still ONE mesh — a realloc must not spawn a second chunk object.
    expect(volume.chunkRoot!.children).toHaveLength(1);
    expect(volume.chunkMeshCount).toBe(1);
  });

  it('converts grid-space millimeters into volume-local meters', () => {
    const handle = gridHandle();
    const { volume } = readyVolume();
    volume.attachGrid(handle);

    const chunk = chunkMesh(0, 1, 3);
    chunk.positions.set([1000, 2000, 3000]);
    volume.applyChunk(chunk);

    const pos = (volume.chunkRoot!.children[0] as Mesh).geometry.getAttribute('position');
    expect(pos.getX(0)).toBeCloseTo((1000 + handle.gridOriginMm.x) / 1000, 6);
    expect(pos.getY(0)).toBeCloseTo((2000 + handle.gridOriginMm.y) / 1000, 6);
    expect(pos.getZ(0)).toBeCloseTo((3000 + handle.gridOriginMm.z) / 1000, 6);
  });

  it('hides an emptied chunk instead of churning its geometry', () => {
    const { volume } = readyVolume();
    volume.applyChunk(chunkMesh(0, 60, 90));
    const mesh = volume.chunkRoot!.children[0] as Mesh;
    const geometry = mesh.geometry;

    expect(volume.applyChunk(chunkMesh(0, 0, 0))).toBe(true);
    expect(mesh.visible).toBe(false);
    expect(mesh.geometry).toBe(geometry); // no dispose, no realloc
    // A second empty batch changes nothing and reports no visual change.
    expect(volume.applyChunk(chunkMesh(0, 0, 0))).toBe(false);
  });

  it('ignores a chunk index outside the grid', () => {
    const { volume } = readyVolume();
    expect(volume.applyChunk(chunkMesh(9999, 10, 12))).toBe(false);
    expect(volume.chunkMeshCount).toBe(0);
  });

  it('disposes every chunk geometry exactly once on teardown', () => {
    const { volume } = readyVolume();
    volume.applyChunk(chunkMesh(0, 30, 45));
    volume.applyChunk(chunkMesh(3, 30, 45));
    const geos = volume.chunkRoot!.children.map((c) => (c as Mesh).geometry);
    const spies = geos.map((g) => vi.spyOn(g, 'dispose'));
    expect(spies).toHaveLength(2);

    volume.teardownRender();
    volume.teardownRender(); // idempotent
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });

  it('omits the uv attribute when GenerateUVs is off', () => {
    const { node } = makeWorkpieceNode();
    const v = new RVMachiningVolume(node);
    applySchema(v as unknown as Record<string, unknown>, RVMachiningVolume.schema, { GenerateUVs: false });
    const ctx = makeContext(registry);
    v.init(ctx);
    v.onSceneReady(ctx);
    v.attachGrid(gridHandle());
    v.applyChunk(chunkMesh(0, 10, 12));
    const geo = (v.chunkRoot!.children[0] as Mesh).geometry;
    expect(geo.getAttribute('uv')).toBeUndefined();
    expect(geo.getAttribute('position')).toBeDefined();
  });

  /**
   * The one-word change in `EXCLUDED_SUBTREE_KEYS` is the entire protection
   * against a batched — and therefore permanently uncut — workpiece. The arena
   * bakes the HOME pose once, so a MachiningVolume that slipped into a batch
   * would still LOOK right on load and never change again: a silent failure that
   * no other test in this file would catch.
   */
  it('excludes the whole MachiningVolume subtree from arena batching (plan-405 §5.2)', () => {
    const root = new Object3D();
    const volumeNode = new Object3D();
    volumeNode.name = 'Workpiece';
    root.add(volumeNode);

    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
    const mesh = new Mesh(geo, new MeshStandardMaterial());
    volumeNode.add(mesh);

    // Control: without the marker the very same mesh IS batch-safe, so the
    // assertion below really is about the exclusion key and nothing else.
    expect(isBatchSafe(mesh, root)).toBe(true);

    volumeNode.userData.realvirtual = { MachiningVolume: { Shape: 'Box' } };
    expect(isBatchSafe(mesh, root)).toBe(false);

    // ... and it holds for a deeper descendant too (the chunk meshes live under
    // a `CsgChunks` child, one level below the marked node).
    const deep = new Object3D();
    volumeNode.add(deep);
    const chunkMeshObj = new Mesh(geo, new MeshStandardMaterial());
    deep.add(chunkMeshObj);
    expect(isBatchSafe(chunkMeshObj, root)).toBe(false);
  });

  it('reports live state for the inspector', () => {
    const { volume } = readyVolume();
    volume.MaterialRemainingPercent = 87.4567;
    volume.VoxelsModified = 1234;
    volume.PendingChunkCount = 3;
    expect(volume.getLiveState()).toEqual({
      MaterialRemainingPercent: 87.46,
      VoxelsModified: 1234,
      IsInitialized: true,
      PendingChunkCount: 3,
    });
  });
});
