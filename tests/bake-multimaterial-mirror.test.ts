// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-753 §9.3 — the RollConveyor-2m fixture, multi-material split, mirror.
 *
 * Real file (`public/library/PalletHandling/RollConveyor-2m.glb`, dumped with
 * a glTF JSON walk on 2026-09-16): 8 glTF nodes with meshes — DriveMesh (1
 * primitive), Transport-Z/Roll ×2 (1 each), Base/T1 (5 primitives, 5
 * materials), Base/T2 (4), Sensor/Light (4), Sensor/Reflector (3), Sensor/Ray
 * (1, scaled 1.0875 × 0.005 × 0.005). No textures at all; four materials carry
 * emissive extensions. GLTFLoader turns every multi-primitive node into a Group
 * with one Mesh per primitive (`T1_0` … `T1_4`), so three.js sees 20 meshes.
 * Nothing in the file carries rv extras — Drive / TransportSurface / Sensor come
 * from the naming scan (`Transport-Z`, `Sensor`), which is exactly why the bake
 * runs that scan on the master first (plan-753 §5.3).
 *
 * Expected after uber bake + naming scan:
 *   - `static`                     — DriveMesh + Base/* + Sensor/Light|Reflector (uber-eligible materials)
 *   - `tex:<uuid>`                 — one per NON-eligible material (emissive) used under the root
 *   - `mover:Transport-Z`          — both rolls (3800 triangles)
 *   - keep                         — `Sensor/Ray` (marker mesh)
 *   - T1 (tagged pickable here) has ONE window per chunk it appears in, the
 *     windows sum to T1's triangles; chunk + keep triangles == source triangles.
 *
 * Plus two synthetic cases: a multi-material mesh whose groups go to two
 * chunks (one entry per chunk), and a negatively scaled sub-mesh whose winding
 * is flipped so every face still points outward.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Vector3, type BufferGeometry, type Material,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import '../src/core/engine/rv-scene-loader';
import { registerCapabilities } from '../src/core/engine/rv-component-registry';
import { segmentRange } from '../src/core/engine/rv-pick-structure';
import { RVUberMaterial, applyUberMaterial, isUberEligible } from '../src/core/engine/rv-uber-material';
import { unwrapGltfRoot } from '../src/core/engine/rv-gltf-unwrap';
import { applyNamingScanToMaster } from '../src/plugins/layout-planner/model-cache';
import {
  bakeTree, chunkKeys, chunkByKey, group, uberMesh, withComponent, sourceTriangles, bakedTriangles, trianglesOf, makeTexture,
} from './fixtures/bake-fixture';

registerCapabilities('TestPick', { pick: 'select' });

const GLB_URL = '/library/PalletHandling/RollConveyor-2m.glb';

async function glbAvailable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    // The dev server answers unknown paths with the SPA fallback (200 text/html).
    return res.ok && /gltf-binary|octet-stream/i.test(res.headers.get('content-type') ?? '');
  } catch {
    return false;
  }
}
const AVAILABLE = await glbAvailable(GLB_URL);

function meshesOf(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((o) => { if ((o as Mesh).isMesh) out.push(o as Mesh); });
  return out;
}

function pathOf(node: Object3D, root: Object3D): string {
  const parts: string[] = [];
  for (let n: Object3D | null = node; n && n !== root; n = n.parent) parts.unshift(n.name);
  return parts.join('/');
}

describe.skipIf(!AVAILABLE)('bake() — RollConveyor-2m fixture (plan-753 §9.3)', () => {
  let root: Group;
  const uber = new RVUberMaterial(false);

  beforeAll(async () => {
    const gltf = await new GLTFLoader().loadAsync(GLB_URL);
    root = unwrapGltfRoot(gltf.scene as Group);
    // Same preparation the ModelCache performs on a master.
    const materials = new Set<Material>();
    for (const m of meshesOf(root)) if (!Array.isArray(m.material)) materials.add(m.material);
    applyUberMaterial(root, materials, false, uber);
    applyNamingScanToMaster(root);
  });

  it('is the file this test was written against (20 meshes, naming-scan roles)', () => {
    const meshes = meshesOf(root);
    expect(root.name).toBe('RollConveyor-2m');
    expect(meshes).toHaveLength(20);
    const tz = root.getObjectByName('Transport-Z')!;
    expect(tz.userData.realvirtual?.TransportSurface).toBeTruthy();
    expect(tz.userData.realvirtual?.Drive).toBeTruthy();
    expect(root.getObjectByName('Sensor')!.userData.realvirtual?.Sensor).toBeTruthy();
    expect(root.getObjectByName('T1')!.children).toHaveLength(5);
  });

  it('produces static + one chunk per emissive material + the Transport-Z mover, keeps the Ray', async () => {
    const t1 = root.getObjectByName('T1')!;
    withComponent(t1, 'TestPick');
    const asset = await bakeTree(root, { uber, assetId: 'RollConveyor-2m' });

    // Expected keys from the real tree: bucket per (mover context, material).
    const expected = new Set<string>();
    const tz = root.getObjectByName('Transport-Z')!;
    const sensor = root.getObjectByName('Sensor')!;
    let keepTris = 0;
    for (const m of meshesOf(root)) {
      const underTz = pathOf(m, root).startsWith('Transport-Z/');
      if (sensor.getObjectById(m.id) && /^Ray/.test(m.name)) { keepTris += trianglesOf(m.geometry); continue; }
      const mat = m.material as Material;
      const isUber = mat === uber;
      expect(isUber, `${m.name}: eligible materials must have been collapsed onto the uber singleton`)
        .toBe(isUberEligible(mat) || mat === uber);
      const prefix = underTz ? 'mover:' + pathOf(tz, root) : '';
      expected.add(isUber ? (prefix || 'static') : (prefix ? prefix + '|' : '') + 'tex:' + mat.uuid);
    }
    expect(chunkKeys(asset)).toEqual([...expected].sort());
    // Diagnostic for the plan report: the real chunk structure of the fixture.
    console.info('[bake-test] RollConveyor-2m chunks: ' + asset.chunks
      .map((c) => `${c.key} segments=${c.pick.segmentCount} tris=${c.triangles} verts=${c.geometry.getAttribute('position').count} mat=${(c.material as { name?: string }).name || 'uber'}`)
      .join(' | ') + ` | keep=${asset.keep.map((k) => k.path).join(',')} | logic=${asset.logicNodes.map((l) => l.path).join(',')}`);
    expect(chunkKeys(asset)).toContain('static');
    expect(chunkKeys(asset)).toContain('mover:Transport-Z');
    // Emissive materials (KHR_materials_emissive_strength) are not uber-eligible → own chunks.
    expect(chunkKeys(asset).filter((k) => k.startsWith('tex:')).length).toBeGreaterThan(0);

    // Rolls: 2 × 1900 triangles in the Transport-Z frame.
    const mover = chunkByKey(asset, 'mover:Transport-Z');
    expect(mover.triangles).toBe(3800);
    expect(mover.owner).toBe(tz);
    expect([...mover.pick.segNode]).toEqual(new Array(mover.pick.segmentCount).fill(asset.nodeTable.ordinalOf.get(tz)));

    // keep: only the Ray marker; the sensor housing merged.
    expect(asset.keep.map((k) => k.path)).toEqual(['Sensor/Ray']);
    expect(bakedTriangles(asset)).toBe(sourceTriangles(root));
    expect(bakedTriangles(asset) - keepTris).toBe(asset.triangles);

    // T1 (five sub-meshes): at most ONE range per chunk (plan-756 Q7), and the
    // ranges of its subtree sum to its triangles.
    const t1Tris = t1.children.reduce((s, c) => s + trianglesOf((c as Mesh).geometry), 0);
    const t1Ordinal = asset.nodeTable.ordinalOf.get(t1)!;
    const table = asset.nodeTable;
    let ranged = 0;
    const chunksSeen = new Set<number>();
    for (let r = table.rowStart[t1Ordinal]; r < table.rowStart[t1Ordinal + 1]; r++) {
      expect(chunksSeen.has(table.rowChunk[r])).toBe(false);
      chunksSeen.add(table.rowChunk[r]);
      const chunk = table.chunks[table.rowChunk[r]];
      ranged += segmentRange(chunk.pick, table.rowFirstSeg[r], table.rowLastSeg[r])!.indexCount / 3;
    }
    expect(ranged).toBe(t1Tris);
    // DriveMesh (`Drive-*` naming does NOT match `DriveMesh`) is static geometry.
    const staticChunk = chunkByKey(asset, 'static');
    expect(staticChunk.triangles).toBeGreaterThanOrEqual(4268);
    expect(staticChunk.geometry.index!.array).toBeInstanceOf(Uint32Array);

    // Logic nodes: EXACTLY the mover, the sensor and both snap points — the
    // `renderer` export markers on every mesh node do not qualify.
    const logic = asset.logicNodes.map((l) => l.path);
    expect(logic.sort()).toEqual(['Sensor', 'Snap-ZN-convroll', 'Snap-ZP-convroll', 'Transport-Z']);
    // Every chunk carries its own pick structure the moment `bake()` resolved
    // (plan-756 F1 — this used to assert a three-mesh-bvh `boundsTree`).
    for (const c of asset.chunks) expect(c.pick.segmentCount, c.key).toBeGreaterThan(0);
  });
});

describe('bake() — multi-material split and mirror (synthetic)', () => {
  const uber = new RVUberMaterial(false);

  it('applyUberMaterial bakes per group and bake() splits the mesh across two chunks with one entry each', async () => {
    const root = group('Asset');
    const node = withComponent(group('Part'), 'TestPick');
    const geo = new BoxGeometry(1, 1, 1);
    geo.clearGroups();
    geo.addGroup(0, 18, 0);   // 6 faces → red, uber-eligible
    geo.addGroup(18, 18, 1);  // 6 faces → textured
    const red = new MeshStandardMaterial({ color: 0xff0000, roughness: 1, metalness: 0 });
    const tex = new MeshStandardMaterial({ map: makeTexture() });
    const mesh = new Mesh(geo, [red, tex]);
    mesh.name = 'multi';
    node.add(mesh);
    root.add(node, uberMesh(uber, 'frame', [5, 0, 0]));

    const result = applyUberMaterial(root, new Set<Material>([red, tex]), false, uber);
    expect(result.bakedMeshCount).toBe(1);
    const mats = mesh.material as Material[];
    expect(mats[0]).toBe(uber);
    expect(mats[1]).toBe(tex);
    const color = mesh.geometry.getAttribute('color');
    const index = mesh.geometry.index!;
    // Group 0 vertices are red, group 1 vertices stay default white.
    expect(Math.round(color.getX(index.getX(0)) * 255)).toBe(255);
    expect(Math.round(color.getY(index.getX(0)) * 255)).toBe(0);
    expect(Math.round(color.getY(index.getX(18)) * 255)).toBe(255);

    const asset = await bakeTree(root, { uber });
    expect(chunkKeys(asset)).toEqual(['static', 'tex:' + tex.uuid].sort());
    const staticChunk = chunkByKey(asset, 'static');
    const texChunk = chunkByKey(asset, 'tex:' + tex.uuid);
    expect(texChunk.triangles).toBe(6);
    expect(staticChunk.triangles).toBe(6 + 12);
    expect(texChunk.material).toBe(tex);
    // One CSR row (= one range) per chunk for the node.
    const table2 = asset.nodeTable;
    const nodeOrdinal = table2.ordinalOf.get(node)!;
    const rows = [];
    for (let r = table2.rowStart[nodeOrdinal]; r < table2.rowStart[nodeOrdinal + 1]; r++) rows.push(r);
    expect(rows).toHaveLength(2);
    const staticRow = rows.find((r) => table2.chunks[table2.rowChunk[r]] === staticChunk)!;
    const texRow = rows.find((r) => table2.chunks[table2.rowChunk[r]] === texChunk)!;
    expect(staticRow).toBeDefined();
    expect(texRow).toBeDefined();
    expect(segmentRange(staticChunk.pick, table2.rowFirstSeg[staticRow], table2.rowLastSeg[staticRow])!.indexCount).toBe(18);
    // The textured chunk keeps the material's own layout (uv survives).
    expect(texChunk.geometry.getAttribute('uv')).toBeDefined();
    // Only the six referenced vertices of the group were staged, not the whole box.
    expect(texChunk.geometry.getAttribute('position').count).toBeLessThan(24);
    expect(bakedTriangles(asset)).toBe(sourceTriangles(root));
  });

  it('flips the winding of a negatively scaled sub-mesh so every face points outward', async () => {
    const root = group('Asset');
    const a = uberMesh(uber, 'plain', [0, 0, 0]);
    const b = uberMesh(uber, 'mirrored', [4, 0, 0]);
    b.scale.set(-1, 1, 1);
    root.add(a, b);

    const asset = await bakeTree(root, { uber });
    const g: BufferGeometry = chunkByKey(asset, 'static').geometry;
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const idx = g.index!;
    const pa = new Vector3(), pb = new Vector3(), pc = new Vector3(), e1 = new Vector3(), e2 = new Vector3(), n = new Vector3();
    let mirroredFaces = 0;
    for (let f = 0; f < idx.count / 3; f++) {
      const i0 = idx.getX(f * 3), i1 = idx.getX(f * 3 + 1), i2 = idx.getX(f * 3 + 2);
      pa.fromBufferAttribute(pos, i0); pb.fromBufferAttribute(pos, i1); pc.fromBufferAttribute(pos, i2);
      e1.subVectors(pb, pa); e2.subVectors(pc, pa);
      const geometric = n.crossVectors(e1, e2);
      const shading = new Vector3().fromBufferAttribute(nor, i0)
        .add(new Vector3().fromBufferAttribute(nor, i1))
        .add(new Vector3().fromBufferAttribute(nor, i2));
      expect(geometric.dot(shading), `face ${f} (x≈${pa.x.toFixed(1)})`).toBeGreaterThan(0);
      if (pa.x > 2) mirroredFaces++;
    }
    expect(mirroredFaces).toBe(12);
    // Mirrored normals point outward from the mirrored box's centre (x=4).
    for (let v = 0; v < pos.count; v++) {
      if (pos.getX(v) < 2) continue;
      const outward = new Vector3(pos.getX(v) - 4, pos.getY(v), pos.getZ(v));
      expect(outward.dot(new Vector3().fromBufferAttribute(nor, v))).toBeGreaterThan(0);
    }
  });
});
