// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-754 §9.16 — `drop tmp`: what the template references stays alive,
 * everything only the temporary graph held is freed.
 *
 * The sharp edges this pins, all of them named in §5 and in the memory notes:
 *  - a keep mesh is MOVED, so its geometry and material are alive afterwards
 *    (the Lamp still swaps its material);
 *  - chunk geometry is brand new and registered in `chunkMetaOf`, so the sweep
 *    must never touch it;
 *  - a Sprite's geometry is a module-scope SINGLETON shared app-wide — the
 *    sweep only ever looks at `isMesh` nodes;
 *  - a geometry shared between a dropped node and a kept one is NOT disposed.
 */
import { describe, it, expect } from 'vitest';
import {
  BoxGeometry, BufferGeometry, DataTexture, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  RGBAFormat, Sprite, SpriteMaterial, Texture,
} from 'three';
import { bake, bakeDropStats } from '../src/core/engine/rv-bake-pipeline';
import { chunkMetaOf } from '../src/core/engine/rv-bake-chunk';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
// Side effect: registers every component's capabilities (Lamp = `keep`, Drive =
// `chunk`), which is what the classification reads.
import '../src/core/engine/rv-scene-loader';

/** `dispose()` is not observable on a geometry or texture — watch the event. */
function watchDispose(resource: BufferGeometry | Texture): { disposed: boolean } {
  const state = { disposed: false };
  (resource as BufferGeometry).addEventListener('dispose', () => { state.disposed = true; });
  return state;
}

function box(name: string, x: number, extras?: Record<string, unknown>): Mesh {
  const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0x334455 }));
  m.name = name;
  m.position.x = x;
  if (extras) m.userData.realvirtual = extras;
  return m;
}

async function bakeTree(root: Group): Promise<Awaited<ReturnType<typeof bake>>> {
  root.updateMatrixWorld(true);
  const asset = await bake(root, {
    assetId: 'drop-test',
    destructive: true,
    
    pickPort: createPickBuildPort({ createWorker: () => null }),
  });
  return asset;
}

describe('destructive bake drops tmp (plan-754 §9.16)', () => {
  it('keeps what the template references and frees what only tmp held', async () => {
    const root = new Group();
    root.name = 'Asset';
    const plain = box('Plain', 0);
    const lamp = box('Beacon', 3, { Lamp: { OnColor: { r: 1, g: 0, b: 0, a: 1 } } });
    root.add(plain, lamp);

    const plainGeo = watchDispose(plain.geometry);
    const lampGeo = watchDispose(lamp.geometry);
    const lampMaterial = lamp.material as MeshStandardMaterial;

    const asset = await bakeTree(root);

    // The keep mesh moved into the template, geometry + material intact.
    expect(asset.keep.map((k) => k.mesh)).toContain(lamp);
    expect(lamp.parent).toBeTruthy();
    expect(lampGeo.disposed).toBe(false);
    expect(lamp.material).toBe(lampMaterial);
    expect(lamp.geometry.getAttribute('position').count).toBeGreaterThan(0);

    // The merged mesh's own geometry is gone; its triangles live in the chunk.
    expect(plainGeo.disposed).toBe(true);
    expect(asset.chunks.length).toBeGreaterThan(0);
    for (const c of asset.chunks) {
      expect(chunkMetaOf.has(c.geometry)).toBe(true);
      expect(c.geometry.getAttribute('position').count).toBeGreaterThan(0);
      expect(c.templateMesh).toBeTruthy();
      expect(c.templateMesh!.parent).toBeTruthy();
    }
  });

  it('a Sprite keeps the shared singleton geometry the sweep must never touch', async () => {
    const root = new Group();
    root.name = 'Asset';
    root.add(box('Plain', 0));
    const sprite = new Sprite(new SpriteMaterial({ color: 0xffffff }));
    sprite.name = 'Marker';
    root.add(sprite);
    const spriteGeo = watchDispose(sprite.geometry);

    const asset = await bakeTree(root);

    // Non-`Mesh` drawables are `keep` — the sprite itself travels into the
    // template — and the sweep never even looks at its geometry.
    expect(asset.keep.map((k) => k.mesh as unknown)).toContain(sprite);
    expect(spriteGeo.disposed).toBe(false);
  });

  it('geometry shared between a dropped and a kept mesh survives', async () => {
    const shared = new BoxGeometry(1, 1, 1);
    const sharedWatch = watchDispose(shared);
    const root = new Group();
    root.name = 'Asset';
    const merged = new Mesh(shared, new MeshStandardMaterial());
    merged.name = 'Merged';
    // `keep` through an authored bake role — the D7 fallback route.
    const kept = new Mesh(shared, new MeshBasicMaterial());
    kept.name = 'Kept';
    kept.position.x = 4;
    kept.userData.realvirtual = { BakeRole: 'keep' };
    root.add(merged, kept);

    const asset = await bakeTree(root);

    expect(asset.keep.map((k) => k.mesh)).toContain(kept);
    expect(sharedWatch.disposed).toBe(false);
    expect(kept.geometry).toBe(shared);
  });

  it('frees the textures of a dropped material and keeps the ones the template needs', async () => {
    const root = new Group();
    root.name = 'Asset';

    // A textured material the template does NOT inherit. A material that ends
    // up as a chunk's material is retained by construction (the chunk draws
    // with it), so the case that actually frees one is a mesh the bake stages
    // NOWHERE — here the degenerate CAD mesh, which is "neither chunk nor
    // keep". `Material.dispose()` alone would leave its texture behind.
    const droppedTex = new DataTexture(new Uint8Array([9, 9, 9, 255]), 1, 1, RGBAFormat);
    const ghost = new Mesh(new BufferGeometry(), new MeshStandardMaterial({ map: droppedTex }));
    ghost.name = 'DegenerateCadMesh';
    // A KEEP mesh whose own material carries a second texture: reachable from
    // the template, so it must survive…
    const sharedTex = new DataTexture(new Uint8Array([1, 2, 3, 255]), 1, 1, RGBAFormat);
    const kept = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ map: sharedTex }));
    kept.name = 'Kept';
    kept.position.x = 4;
    kept.userData.realvirtual = { BakeRole: 'keep' };
    // …even though a DROPPED material references it too.
    const ghost2 = new Mesh(new BufferGeometry(), new MeshStandardMaterial({ map: sharedTex }));
    ghost2.name = 'DegenerateCadMesh2';
    // Something real to bake, so the asset is not empty.
    root.add(box('Merged', 0), ghost, kept, ghost2);

    const droppedWatch = watchDispose(droppedTex);
    const sharedWatch = watchDispose(sharedTex);

    const asset = await bakeTree(root);

    expect(asset.keep.map((k) => k.mesh)).toContain(kept);
    expect(droppedWatch.disposed).toBe(true);
    expect(sharedWatch.disposed).toBe(false);
    expect((kept.material as MeshStandardMaterial).map).toBe(sharedTex);

    const stats = bakeDropStats[bakeDropStats.length - 1];
    expect(stats.assetId).toBe('drop-test');
    expect(stats.textures).toBe(1);
  });

  it('closes an ImageBitmap source rather than leaving the decoded pixels behind', async () => {
    if (typeof createImageBitmap !== 'function') return; // not a browser run
    const canvas = document.createElement('canvas');
    canvas.width = 2; canvas.height = 2;
    const bitmap = await createImageBitmap(canvas);
    const tex = new Texture(bitmap as unknown as HTMLImageElement);
    tex.needsUpdate = true;

    const root = new Group();
    root.name = 'Asset';
    const ghost = new Mesh(new BufferGeometry(), new MeshStandardMaterial({ map: tex }));
    ghost.name = 'DegenerateCadMesh';
    root.add(box('Merged', 0), ghost);

    await bakeTree(root);

    // `close()` zeroes the bitmap's dimensions — the one observable proof that
    // the decoded pixels (which live outside the JS heap) were handed back.
    expect(bitmap.width).toBe(0);
    expect(bakeDropStats[bakeDropStats.length - 1].images).toBe(1);
  });

  it('the template carries only plain-data userData (JSON round-trip safe)', async () => {
    const root = new Group();
    root.name = 'Asset';
    const axis = new Group();
    axis.name = 'Axis';
    axis.userData.realvirtual = { Drive: { Direction: 'LinearY', TargetSpeed: 120 } };
    axis.add(box('Arm', 2));
    root.add(axis);

    const asset = await bakeTree(root);
    let checked = 0;
    asset.template.traverse((n) => {
      expect(() => JSON.stringify(n.userData)).not.toThrow();
      checked++;
    });
    expect(checked).toBeGreaterThan(1);
    const templateAxis = asset.logicNodes.find((l) => l.template.name === 'Axis')!.template;
    expect(templateAxis.userData.realvirtual.Drive.TargetSpeed).toBe(120);
    expect(templateAxis).not.toBe(axis);
  });
});
