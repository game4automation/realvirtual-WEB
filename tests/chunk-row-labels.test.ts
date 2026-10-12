// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-505 §9.1 — chunk row labels: "kind + size", never a boundary or file name.
 *
 * Real chunks come from a destructive `bake()` of a synthetic master tree
 * (`bake-fixture.ts`), so the labels read the very `chunkMetaOf` entries the
 * viewer reads.
 */

import { describe, it, expect } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, MeshStandardMaterial, type Object3D } from 'three';
import '../src/core/engine/rv-scene-loader';
import { RVUberMaterial, isUberMaterial } from '../src/core/engine/rv-uber-material';
import { RV_PARTITION_KEY, chunkMetaOf, type BakedAsset, type BakedChunk } from '../src/core/engine/rv-bake-chunk';
import {
  chunkInfoOf,
  chunkRowLabel,
  foldRowLabel,
  formatCountFull,
  formatTrisCompact,
} from '../src/core/hmi/chunk-row-labels';
import { bakeTree, group, makeTexture, texturedMesh, uberMesh } from './fixtures/bake-fixture';

const uber = new RVUberMaterial(false);

function partition<T extends Object3D>(node: T, ...labels: string[]): T {
  node.userData[RV_PARTITION_KEY] = labels;
  return node;
}

/**
 * A chunk mesh whose bake meta is registered by hand — the bake only makes
 * non-uber chunks for textured materials, so an untextured colour material
 * (a foreign master, a future bake role) is covered this way.
 */
function fakeChunkMesh(material: MeshStandardMaterial): Mesh {
  const mesh = new Mesh(new BoxGeometry(), material);
  mesh.userData._rvBakeChunk = true;
  const chunk = {
    key: 'tex:fake', partition: '', partitionLabels: [], geometry: mesh.geometry, material,
    templateMesh: mesh, groupObject: null, ownerPath: null, owner: group('Owner'),
    triangles: 12, pick: { segmentCount: 1 }, blocks: true,
  } as unknown as BakedChunk;
  chunkMetaOf.set(mesh.geometry, { chunk, asset: {} as BakedAsset });
  return mesh;
}

function meshOf(chunk: BakedChunk): Mesh {
  expect(chunk.templateMesh, chunk.key).toBeTruthy();
  return chunk.templateMesh!;
}

/** Root `name` ▸ two uber boxes + one textured "Brushed Steel" box. */
async function bakeMixed(name = 'DemoRealvirtualWeb.glb'): Promise<{ asset: BakedAsset; root: Object3D }> {
  const root = group(name);
  root.add(uberMesh(uber, 'a', [0, 0, 0]));
  root.add(uberMesh(uber, 'b', [2, 0, 0]));
  const steel = new MeshStandardMaterial({ map: makeTexture(), color: 0x8a8f94 });
  steel.name = 'Brushed Steel';
  root.add(texturedMesh('t', steel, [4, 0, 0]));
  const asset = await bakeTree(root, { uber, destructive: true });
  return { asset, root };
}

describe('chunk row labels (plan-505 §9.1)', () => {
  it('formats compact triangle counts', () => {
    expect(formatTrisCompact(12)).toBe('12');
    expect(formatTrisCompact(84213)).toBe('84.2k');
    expect(formatTrisCompact(12000)).toBe('12k');
    expect(formatTrisCompact(1234567)).toBe('1.2M');
  });

  it('formats full counts with grouping', () => {
    expect(formatCountFull(84213)).toBe('84,213');
    expect(formatCountFull(12)).toBe('12');
  });

  it('labels an uber chunk as Merged and a textured chunk by material name', async () => {
    const { asset } = await bakeMixed();
    const merged = asset.chunks.find((c) => isUberMaterial(c.material))!;
    const textured = asset.chunks.find((c) => !isUberMaterial(c.material))!;
    expect(merged).toBeDefined();
    expect(textured).toBeDefined();
    expect(chunkRowLabel(meshOf(merged))).toBe(`Merged · ${formatTrisCompact(merged.triangles)} tris`);
    expect(chunkRowLabel(meshOf(textured))).toMatch(/^Brushed Steel · \d+ tris$/);
  });

  it('never contains the boundary or file name, and leaves the chunk key untouched', async () => {
    const { asset, root } = await bakeMixed('SecretCustomerFile.glb');
    for (const chunk of asset.chunks) {
      const mesh = meshOf(chunk);
      expect(chunkRowLabel(mesh)).not.toContain(root.name);
      expect(chunkRowLabel(mesh)).not.toContain('SecretCustomerFile');
      // `Mesh.name` is the chunk key — an identity, not presentation.
      expect(mesh.name).toBe(chunk.key);
    }
  });

  it('prefixes the partition labels', async () => {
    const root = group('Asset');
    root.add(partition(uberMesh(uber, 'inA', [0, 0, 0]), 'MC01.13'));
    root.add(partition(uberMesh(uber, 'inAB', [2, 0, 0]), 'A', 'B'));
    const asset = await bakeTree(root, { uber, destructive: true });
    const byPartition = new Map(asset.chunks.map((c) => [c.partition, c]));
    expect(chunkRowLabel(meshOf(byPartition.get('MC01.13')!))).toMatch(/^MC01\.13 · Merged · \d+ tris$/);
    expect(chunkRowLabel(meshOf(byPartition.get('A|B')!))).toMatch(/^A, B · Merged · \d+ tris$/);
  });

  it('falls back to "Chunk · N tris" for a chunk mesh without bake meta', () => {
    const chunk = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    chunk.userData._rvBakeChunk = true;
    expect(chunkRowLabel(chunk)).toBe('Chunk · 12 tris');
    const info = chunkInfoOf(chunk);
    expect(info.kind).toBe('unknown');
    expect(info.triangles).toBe(12);
    expect(info.segments).toBeNull();
    expect(info.owner).toBeNull();
  });

  it('chunkInfoOf reads the bake meta: owner, segments, no swatch for merged or texture-mapped chunks', async () => {
    const { asset } = await bakeMixed();
    const merged = asset.chunks.find((c) => isUberMaterial(c.material))!;
    const textured = asset.chunks.find((c) => !isUberMaterial(c.material))!;
    const mi = chunkInfoOf(meshOf(merged));
    expect(mi.kind).toBe('merged');
    expect(mi.swatchHex).toBeNull();
    expect(mi.segments).toBe(merged.pick.segmentCount);
    expect(mi.owner).toBe(merged.owner);
    expect(mi.triangles).toBe(merged.triangles);
    const ti = chunkInfoOf(meshOf(textured));
    expect(ti.kind).toBe('textured');
    expect(ti.materialName).toBe('Brushed Steel');
    // Its colour is a tint over the texture map — a swatch would mislead.
    expect(ti.swatchHex).toBeNull();
  });

  it('shows a swatch only for an untextured colour material (sRGB hex)', () => {
    const withMap = new MeshStandardMaterial({ map: makeTexture(), color: 0xffffff });
    const plain = new MeshStandardMaterial({ color: 0x8a8f94 });
    expect(chunkInfoOf(fakeChunkMesh(withMap)).swatchHex).toBeNull();
    expect(chunkInfoOf(fakeChunkMesh(plain)).swatchHex).toBe('#8a8f94');
  });

  it('foldRowLabel pluralises', () => {
    expect(foldRowLabel(1, 12)).toBe('Geometry · 1 chunk · 12 tris');
    expect(foldRowLabel(20, 1234567)).toBe('Geometry · 20 chunks · 1.2M tris');
  });
});

describe('isUberMaterial (plan-505 F10)', () => {
  it('is true for the uber instance and false for a plain standard material', () => {
    expect(isUberMaterial(uber)).toBe(true);
    expect(isUberMaterial(new MeshStandardMaterial())).toBe(false);
    expect(isUberMaterial(null)).toBe(false);
  });

  it('accepts either marker (TSL twin carries both, a renamed copy one)', () => {
    const byName = new MeshStandardMaterial();
    byName.name = '__rvUberMaterial';
    expect(isUberMaterial(byName)).toBe(true);
    const byFlag = new MeshStandardMaterial();
    byFlag.userData._rvShared = true;
    expect(isUberMaterial(byFlag)).toBe(true);
  });
});
