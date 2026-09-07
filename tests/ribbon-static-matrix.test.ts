// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-460 follow-up — a PASSIVE web node must move even when it was classified
 * as static geometry.
 *
 * The bug this file pins down: every roller of the demo slitter kept its numbers
 * moving (`angle` climbed, the dancer's `positionMm` travelled, the winder's
 * radius grew) while only the DRIVEN rollers visibly turned. `processMeshes()`
 * gave every mesh without a `Drive`/`Kinematic` ancestor `matrixAutoUpdate =
 * false`, and Three.js then never rebuilds the local matrix from the quaternion,
 * position or scale the web components write — so `matrixWorld` never changed.
 *
 * Both halves of the fix are asserted:
 *
 *  1. the components write their own `updateMatrix()`, so a node that IS frozen
 *     still reaches `matrixWorld` (the defensive half, independent of how the
 *     loader classified it); and
 *  2. `processMeshes()` no longer freezes a web node in the first place, with
 *     the one exception `rv-freeze-static.ts` already makes: a `RibbonRoller`
 *     with `SpinMode: Texture` deliberately does not move.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { BufferAttribute, BufferGeometry, Matrix4, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { ribbonHarness, type RollerSpec } from './ribbon-fixture';
import { processMeshes } from '../src/core/engine/rv-scene-loader';
import type { RVRibbonWinder } from '../src/core/engine/rv-ribbon-winder';

const DT = 1 / 60;

/** Unwinder — idler (follower) — nip (driven) — dancer — rewinder. */
const LINE: RollerSpec[] = [
  { name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 400, winder: true },
  { name: 'Idler', xMm: 1200, yMm: 400, radiusMm: 60 },
  { name: 'Nip', xMm: 2400, yMm: 400, radiusMm: 80, driven: true },
  { name: 'Dancer', xMm: 3000, yMm: 300, radiusMm: 50, dancer: true },
  { name: 'Rewinder', xMm: 3600, yMm: 0, radiusMm: 100, winder: true, driven: true },
];

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

/** Freeze `node` exactly as `processMeshes` used to: no automatic local matrix. */
function freezeLocalMatrix(node: Object3D): Matrix4 {
  node.matrixAutoUpdate = false;
  node.updateMatrix();
  node.updateMatrixWorld(true);
  return node.matrixWorld.clone();
}

/** True when the two matrices differ in any element. */
function changed(a: Matrix4, b: Matrix4): boolean {
  for (let i = 0; i < 16; i++) if (Math.abs(a.elements[i] - b.elements[i]) > 1e-9) return true;
  return false;
}

describe('web components move a node with matrixAutoUpdate = false', () => {
  it('a FOLLOWER roller reaches matrixWorld after a few ticks', () => {
    const h = ribbonHarness(LINE);
    h.buildPath();
    const idler = h.nodes.get('Idler')!;
    const before = freezeLocalMatrix(idler);

    h.drive.jog(500);
    for (let i = 0; i < 10; i++) h.step(DT);
    h.scene.updateMatrixWorld(true);

    // The angle moved — and so did the geometry, which is the whole point.
    expect(h.roller('Idler').angle).not.toBe(0);
    expect(changed(before, idler.matrixWorld)).toBe(true);
  });

  it('a DANCER carriage reaches matrixWorld after a few ticks', () => {
    const h = ribbonHarness(LINE);
    h.buildPath();
    const node = h.nodes.get('Dancer')!;
    // The rewinder is the only driven roller downstream, so the two sections run
    // at different speeds and the carriage travels.
    h.drive.jog(500);
    h.drive.jogRoller('Rewinder', 200);
    h.step(DT);
    h.scene.updateMatrixWorld(true);
    const before = freezeLocalMatrix(node);

    for (let i = 0; i < 20; i++) h.step(DT);
    h.scene.updateMatrixWorld(true);

    expect(h.dancer('Dancer').positionMm).not.toBe(0);
    expect(changed(before, node.matrixWorld)).toBe(true);
  });

  it('a WINDER roll scale reaches matrixWorld after a few ticks', () => {
    const h = ribbonHarness(LINE);
    h.buildPath();
    const roll = h.nodes.get('Rewinder')!.getObjectByName('Roll')!;
    const before = freezeLocalMatrix(roll);

    h.drive.jog(1000);
    for (let i = 0; i < 30; i++) h.step(DT);
    h.scene.updateMatrixWorld(true);

    const winder = h.roller('Rewinder') as unknown as RVRibbonWinder;
    expect(winder.woundLengthMm).toBeGreaterThan(0);
    expect(changed(before, roll.matrixWorld)).toBe(true);
  });
});

// ── processMeshes classification ─────────────────────────────────────────

/** A one-triangle mesh named `name`, carrying `extras` as rv_extras. */
function extrasMesh(name: string, extras: Record<string, unknown>): Mesh {
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  const mesh = new Mesh(geo, new MeshStandardMaterial());
  mesh.name = name;
  mesh.userData.realvirtual = extras;
  return mesh;
}

describe('processMeshes keeps web meshes matrix-dynamic', () => {
  it('a RibbonRoller / RibbonDancer / RibbonWinder mesh without a Drive stays matrixAutoUpdate = true', () => {
    const root = new Object3D();
    root.name = 'Root';
    const roller = extrasMesh('Idler', { RibbonRoller: { RadiusMm: 60, Axis: 'X' } });
    const dancer = extrasMesh('Dancer', { RibbonDancer: { RadiusMm: 50, Axis: 'X', TravelAxis: 'Y' } });
    const winder = extrasMesh('Rewinder', { RibbonWinder: { RadiusMm: 90, Axis: 'X' } });
    const plain = extrasMesh('Frame', {});
    root.add(roller, dancer, winder, plain);

    processMeshes(root);

    expect(roller.matrixAutoUpdate).toBe(true);
    expect(dancer.matrixAutoUpdate).toBe(true);
    expect(winder.matrixAutoUpdate).toBe(true);
    // The control: an ordinary mesh is still frozen, or the pass would be a no-op.
    expect(plain.matrixAutoUpdate).toBe(false);
  });

  it('a mesh UNDER a web node is dynamic too, and a SpinMode: Texture roller may stay static', () => {
    const root = new Object3D();
    root.name = 'Root';

    const winder = new Object3D();
    winder.name = 'Unwinder';
    winder.userData.realvirtual = { RibbonWinder: { RadiusMm: 400, Axis: 'X' } };
    const roll = extrasMesh('Roll', {});
    winder.add(roll);
    root.add(winder);

    // The one web node that legitimately never moves: it scrolls its mantle map.
    const textureRoller = extrasMesh('Idler_02', { RibbonRoller: { RadiusMm: 120, Axis: 'X', SpinMode: 'Texture' } });
    root.add(textureRoller);

    processMeshes(root);

    expect(roll.matrixAutoUpdate).toBe(true);
    expect(textureRoller.matrixAutoUpdate).toBe(false);
  });
});
