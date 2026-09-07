// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-460 §9.4 — `RibbonRoller.SpinMode: Texture`.
 *
 * A follower may fake its rotation by scrolling the mantle map instead of
 * turning the node. Two things make that safe rather than clever, and both are
 * asserted here: the effective mode is decided PER TICK (a roller that gains a
 * drive goes back to turning, immediately), and the material and map are CLONED
 * per roller, so two rollers sharing a deduped material scroll independently.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  BufferAttribute, BufferGeometry, DataTexture, Mesh, MeshStandardMaterial, Object3D, RGBAFormat,
} from 'three';
import type { Material, Texture } from 'three';
import { ribbonHarness, type RollerSpec } from './ribbon-fixture';
import { freezeStaticMatrices } from '../src/core/engine/rv-freeze-static';
import { isBatchSafe } from '../src/core/engine/rv-batched-render';
import { deduplicateMaterials } from '../src/core/engine/rv-material-dedup';
import { MM_TO_METERS } from '../src/core/engine/rv-constants';
import type { RVRibbonRoller } from '../src/core/engine/rv-ribbon-roller';

const DT = 1 / 60;

/** A 2x2 texture, so a material carries a real `map` to clone. */
function tex(): DataTexture {
  const t = new DataTexture(new Uint8Array(2 * 2 * 4).fill(200), 2, 2, RGBAFormat);
  t.needsUpdate = true;
  return t;
}

/** A box mesh of the given half-extent, with a mapped material. */
function mappedMesh(name: string, halfMm: number, material?: MeshStandardMaterial): Mesh {
  const r = halfMm / MM_TO_METERS;
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array([
    -r, -r, -r, r, -r, -r, r, r, -r,
    -r, -r, r, r, -r, r, r, r, r,
  ]), 3));
  const mesh = new Mesh(geo, material ?? new MeshStandardMaterial({ map: tex() }));
  mesh.name = name;
  return mesh;
}

/** Unwinder — idler(Texture) — nip(D) — rewinder. */
function line(idlerExtras: Record<string, unknown> = {}): RollerSpec[] {
  return [
    { name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 400, winder: true },
    { name: 'Idler', xMm: 1200, yMm: 400, radiusMm: 60, extras: { SpinMode: 'Texture', ...idlerExtras } },
    { name: 'Nip', xMm: 2400, yMm: 400, radiusMm: 80, driven: true },
    { name: 'Rewinder', xMm: 3600, yMm: 0, radiusMm: 100, winder: true },
  ];
}

/** Give the fixture's idler node a mapped mantle mesh BEFORE the path is built. */
function withMantle(h: ReturnType<typeof ribbonHarness>, name = 'Idler', material?: MeshStandardMaterial): Mesh {
  const node = h.nodes.get(name)!;
  const mantle = mappedMesh(`${name}_Mantle`, 60, material);
  node.add(mantle);
  h.scene.updateMatrixWorld(true);
  return mantle;
}

function mapOf(mesh: Mesh): Texture {
  return (mesh.material as MeshStandardMaterial).map!;
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

describe('SpinMode Texture', () => {
  it('leaves the node quaternion untouched and advances map.offset.x by v / (2 pi r) * dt', () => {
    const h = ribbonHarness(line());
    const mantle = withMantle(h);
    const path = h.buildPath();
    const idler = path.rollers[1] as unknown as RVRibbonRoller;
    const quatBefore = idler.node.quaternion.clone();

    h.drive.jog(1000);
    h.step(DT);

    expect(idler.isTextureSpinning).toBe(true);
    expect(idler.angle).toBe(0);
    expect(idler.node.quaternion.equals(quatBefore)).toBe(true);
    // du = v / (2 pi r) * dt, and the web runs towards +u.
    const expected = (1000 / (2 * Math.PI * 60)) * DT;
    expect(mapOf(mantle).offset.x).toBeCloseTo(expected, 9);

    // ...and it wraps into [0,1) rather than drifting off into float noise.
    for (let i = 0; i < 600; i++) h.step(DT);
    const u = mapOf(mantle).offset.x;
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThan(1);
  });

  it('scrolls backwards when the web runs backwards', () => {
    const h = ribbonHarness(line());
    const mantle = withMantle(h);
    h.buildPath();
    h.drive.jog(-1000);
    h.step(DT);
    // Wrapped into [0,1), so a backwards step lands just below 1.
    expect(mapOf(mantle).offset.x).toBeCloseTo(1 - (1000 / (2 * Math.PI * 60)) * DT, 9);
  });

  it('on a DRIVEN roller it warns and falls back to Transform; the drive keeps turning the node', () => {
    // SpinMode Texture on the nip, which carries the drive.
    const h = ribbonHarness([
      { name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 400, winder: true },
      { name: 'Idler', xMm: 1200, yMm: 400, radiusMm: 60 },
      { name: 'Nip', xMm: 2400, yMm: 400, radiusMm: 80, driven: true, extras: { SpinMode: 'Texture' } },
      { name: 'Rewinder', xMm: 3600, yMm: 0, radiusMm: 100, winder: true },
    ]);
    const mantle = withMantle(h, 'Nip');
    const path = h.buildPath();
    const nip = path.rollers[2] as unknown as RVRibbonRoller;

    h.drive.jog(1000);
    h.step(DT);
    expect(nip.isTextureSpinning).toBe(false);
    expect(mapOf(mantle).offset.x).toBe(0);
    expect(nip.isDriven).toBe(true);
    expect(warn.mock.calls.flat().join(' ')).toContain('SpinMode Texture but carries a Drive');

    // Once, not per tick.
    const before = warn.mock.calls.length;
    for (let i = 0; i < 5; i++) h.step(DT);
    expect(warn.mock.calls.slice(before).flat().join(' ')).not.toContain('SpinMode Texture but carries');
  });

  it('adding a Drive switches a Texture follower to Transform and removing it switches back', () => {
    const h = ribbonHarness(line());
    const mantle = withMantle(h);
    const path = h.buildPath();
    const idler = path.rollers[1] as unknown as RVRibbonRoller;
    const authored = idler.node.quaternion.clone();

    h.drive.jog(1000);
    h.step(DT);
    expect(idler.isTextureSpinning).toBe(true);
    expect(mapOf(mantle).offset.x).toBeGreaterThan(0);

    // -> Transform: the offsets go back to 0 and the node starts turning.
    h.addDrive('Idler');
    h.drive.jogRoller('Idler', 1000);
    h.step(DT);
    expect(idler.isTextureSpinning).toBe(false);
    expect(mapOf(mantle).offset.x).toBe(0);
    expect(idler.isDriven).toBe(true);

    // -> Texture again: the node returns to the authored pose and scrolling resumes.
    h.removeDrive('Idler');
    h.step(DT);
    expect(idler.isTextureSpinning).toBe(true);
    expect(idler.node.quaternion.equals(authored)).toBe(true);
    expect(mapOf(mantle).offset.x).toBeGreaterThan(0);

    // The clones were made once and are disposed once.
    const maps = [...idler.spinMaps];
    expect(maps).toHaveLength(1);
    const disposals = maps.map((m) => vi.spyOn(m, 'dispose'));
    idler.dispose();
    for (const spy of disposals) expect(spy).toHaveBeenCalledTimes(1);
    // ...and the authored material is back on the mesh.
    expect(mantle.material).not.toBe(undefined);
  });

  it('two Texture rollers sharing a deduped material get independent clones', () => {
    const shared = new MeshStandardMaterial({ map: tex() });
    const h = ribbonHarness([
      { name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 400, winder: true },
      { name: 'Idler_A', xMm: 1000, yMm: 400, radiusMm: 60, extras: { SpinMode: 'Texture' } },
      { name: 'Idler_B', xMm: 1800, yMm: 400, radiusMm: 60, extras: { SpinMode: 'Texture' } },
      { name: 'Nip', xMm: 2600, yMm: 400, radiusMm: 80, driven: true },
      { name: 'Rewinder', xMm: 3600, yMm: 0, radiusMm: 100, winder: true },
    ]);
    const a = withMantle(h, 'Idler_A', shared);
    const b = withMantle(h, 'Idler_B', shared);
    expect(a.material).toBe(b.material);
    h.buildPath();

    h.drive.jog(1000);
    h.step(DT);
    // Different material instances, different textures — but the SAME image, so
    // the clones cost one GPU upload between them.
    expect(a.material).not.toBe(b.material);
    expect(mapOf(a)).not.toBe(mapOf(b));
    expect(mapOf(a).image).toBe(mapOf(b).image);
    expect(mapOf(a).offset.x).toBeGreaterThan(0);
    expect(mapOf(b).offset.x).toBeGreaterThan(0);
  });

  it('a Texture mantle is kept out of the material dedup pass', () => {
    const h = ribbonHarness(line());
    const mantle = withMantle(h);
    // A second, unrelated mesh with an identical material: without the exception
    // the dedup pass would hand ONE instance to both, and the frame would scroll.
    const twin = mappedMesh('Frame', 60);
    (twin.material as MeshStandardMaterial).map = mapOf(mantle);
    h.root.add(twin);
    h.buildPath();

    const before = mantle.material;
    deduplicateMaterials(h.root);
    expect(mantle.material).toBe(before);
    expect(twin.material).not.toBe(mantle.material);
  });

  it('Texture rollers are static for freeze-static but still excluded from batching', () => {
    const root = new Object3D();
    root.name = 'Root';
    const make = (name: string, spinMode?: string): Mesh => {
      const node = new Object3D();
      node.name = name;
      node.userData.realvirtual = { RibbonRoller: spinMode ? { SpinMode: spinMode } : {} };
      const mesh = mappedMesh(`${name}_Mesh`, 60);
      node.add(mesh);
      root.add(node);
      return mesh;
    };
    const texture = make('Texture', 'Texture');
    const transform = make('Transform', 'Transform');
    const absent = make('Default');
    root.updateMatrixWorld(true);

    freezeStaticMatrices(root);
    expect(texture.matrixWorldAutoUpdate).toBe(false);
    // Transform and a MISSING SpinMode both keep the plan-459 behaviour.
    expect(transform.matrixWorldAutoUpdate).toBe(true);
    expect(absent.matrixWorldAutoUpdate).toBe(true);

    // Static, but still not batchable: a BatchedMesh arena shares one material
    // and has no per-instance UV offset.
    for (const mesh of [texture, transform, absent]) {
      expect(isBatchSafe(mesh, root)).toBe(false);
    }
  });

  it('only the MANTLE scrolls: a mapped mantle plus two mapped face discs leaves the faces still', () => {
    const h = ribbonHarness(line());
    const node = h.nodes.get('Idler')!;
    const faces = new Object3D();
    faces.name = 'Faces';
    const faceA = mappedMesh('Face_A', 10);
    const faceB = mappedMesh('Face_B', 10);
    faces.add(faceA, faceB);
    node.add(faces);
    const mantle = withMantle(h);   // the biggest mapped mesh outside `Faces`
    h.buildPath();

    h.drive.jog(1000);
    for (let i = 0; i < 10; i++) h.step(DT);

    expect(mapOf(mantle).offset.x).toBeGreaterThan(0);
    expect(mapOf(faceA).offset.x).toBe(0);
    expect(mapOf(faceB).offset.x).toBe(0);
  });

  it('an explicit MantleMesh wins over the automatic choice', () => {
    // Point MantleMesh at the SMALL mesh; the size heuristic would pick the big one.
    const h = ribbonHarness(line({
      MantleMesh: { type: 'ComponentReference', path: 'Root/Idler/Idler_Small', componentType: 'UnityEngine.Transform' },
    }));
    const node = h.nodes.get('Idler')!;
    const big = mappedMesh('Idler_Big', 60);
    const small = mappedMesh('Idler_Small', 5);
    node.add(big, small);
    h.registry.registerNode('Root/Idler/Idler_Small', small);
    h.scene.updateMatrixWorld(true);

    h.buildPath();
    h.drive.jog(1000);
    h.step(DT);

    expect(mapOf(small).offset.x).toBeGreaterThan(0);
    expect(mapOf(big).offset.x).toBe(0);
  });

  it('a Texture roller without any mapped mesh warns once and simply does not spin', () => {
    const h = ribbonHarness(line());
    const path = h.buildPath();       // no mantle added at all
    const idler = path.rollers[1] as unknown as RVRibbonRoller;
    h.drive.jog(1000);
    for (let i = 0; i < 5; i++) h.step(DT);
    expect(idler.spinMaps).toHaveLength(0);
    expect(idler.angle).toBe(0);
    const hits = warn.mock.calls.flat().filter((m: unknown) => String(m).includes('no mantle mesh with a'));
    expect(hits).toHaveLength(1);
  });

  it('reset clears the scroll offsets and dispose releases the cloned material and map', () => {
    const h = ribbonHarness(line());
    const mantle = withMantle(h);
    const path = h.buildPath();
    const idler = path.rollers[1] as unknown as RVRibbonRoller;
    const authoredMaterial = mantle.material as Material;

    h.drive.jog(1000);
    for (let i = 0; i < 10; i++) h.step(DT);
    const clone = mantle.material as MeshStandardMaterial;
    expect(clone).not.toBe(authoredMaterial);
    expect(mapOf(mantle).offset.x).toBeGreaterThan(0);

    h.ribbonManager.resetAll();
    expect(mapOf(mantle).offset.x).toBe(0);

    const mapDispose = vi.spyOn(clone.map!, 'dispose');
    const materialDispose = vi.spyOn(clone, 'dispose');
    idler.dispose();
    expect(mapDispose).toHaveBeenCalled();
    expect(materialDispose).toHaveBeenCalled();
    // The authored material is handed back to the mesh, not left dangling.
    expect(mantle.material).toBe(authoredMaterial);
  });
});
