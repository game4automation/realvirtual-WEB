// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-scene-button-batch-exclusion.test.ts — plan-417 §9.4.
 *
 * The batching contract is the one failure mode that produces NO error: a cap
 * baked into a static arena simply stops moving and stops changing color, and
 * the click still "works". All three exclusion points therefore get a test,
 * plus the counter-assertion that the static button base stays a batch
 * candidate (excluding the whole subtree would cost draw calls for nothing).
 */

import { describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { bakeFateOf } from './helpers/bake-fate';
import { deduplicateMaterials } from '../src/core/engine/rv-material-dedup';
import { buildButtonScene, PATHS } from './scene-button-fixture';

function plainMesh(name: string, color = 0x808080): Mesh {
  const m = new Mesh(new BoxGeometry(), new MeshStandardMaterial({ color }));
  m.name = name;
  return m;
}

describe('SceneButton batching exclusion', () => {
  it('flags only the cap mesh, not the button base', () => {
    const h = buildButtonScene();
    const cap = h.cap(PATHS.pushCap).capMesh!;
    const base = h.base(PATHS.pushBase).node as Mesh;

    expect(cap.userData._rvSceneButtonMesh).toBe(true);
    expect(base.userData._rvSceneButtonMesh).toBeUndefined();
  });

  it('keeps the cap out of the bake chunks and stages the base', async () => {
    const h = buildButtonScene();
    const cap = h.cap(PATHS.pushCap).capMesh!;
    const base = h.base(PATHS.pushBase).node as Mesh;

    expect(await bakeFateOf(cap, h.root)).toBe('keep');
    expect(await bakeFateOf(base, h.root)).not.toBe('keep');
  });

  it('keeps a child mesh of a flagged cap as well (parent rule)', async () => {
    const h = buildButtonScene();
    const cap = h.cap(PATHS.pushCap).capMesh!;
    const child = plainMesh('CapDecal');
    cap.add(child);

    expect(await bakeFateOf(child, h.root)).toBe('keep');
  });

  it('keeps the cap material out of the dedup fingerprint map', () => {
    const h = buildButtonScene();
    const cap = h.cap(PATHS.pushCap).capMesh!;

    // A plain mesh with an identical material would normally donate its
    // instance to the cap. Give it the exact same values as the cap clone.
    const capMat = cap.material as MeshStandardMaterial;
    const twin = plainMesh('Twin');
    const twinMat = twin.material as MeshStandardMaterial;
    twinMat.color.copy(capMat.color);
    twinMat.emissive.copy(capMat.emissive);
    twinMat.metalness = capMat.metalness;
    twinMat.roughness = capMat.roughness;
    h.root.add(twin);

    deduplicateMaterials(h.root);

    // The cap keeps its instance-local clone; the twin is free to be deduped.
    expect(cap.material).toBe(capMat);
    expect(twin.material).not.toBe(capMat);
  });

  it('the flag disappears again on dispose so a reloaded model can bake the cap', async () => {
    const h = buildButtonScene();
    const capComponent = h.cap(PATHS.pushCap);
    const cap = capComponent.capMesh!;

    capComponent.dispose();
    expect(cap.userData._rvSceneButtonMesh).toBeUndefined();
    // Without the flag the cap follows its SceneButtonMoveable role (chunk).
    expect(await bakeFateOf(cap, h.root)).not.toBe('keep');
  });

  it('an unrelated mesh is unaffected by the exclusion', async () => {
    const root = new Object3D();
    const m = plainMesh('Plain');
    root.add(m);
    expect(await bakeFateOf(m, root)).toBe('static');
  });
});
