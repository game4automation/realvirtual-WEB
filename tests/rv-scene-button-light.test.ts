// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-scene-button-light.test.ts — plan-417 §9.3.
 *
 * The button light is SYNTHESIZED (plan-417 §2.8): the demo GLB ships only the
 * "On" materials, so the lit/unlit pair is cloned once at bind time and differs
 * only in emissive. Two things must hold and are easy to break silently:
 * equal base/active material names mean "no light at all" (nothing may be
 * cloned or swapped), and `dispose()` must put the authored material back
 * before the viewer's material teardown frees it.
 */

import { describe, expect, it } from 'vitest';
import { Mesh, MeshStandardMaterial } from 'three';
import { buildButtonScene, PATHS } from './scene-button-fixture';

function capMesh(cap: { capMesh?: Mesh }): Mesh {
  const mesh = cap.capMesh;
  if (!mesh) throw new Error('cap mesh not bound');
  return mesh;
}

function emissiveHex(mesh: Mesh): number {
  return (mesh.material as MeshStandardMaterial).emissive.getHex();
}

describe('SceneButton light', () => {
  it('clones a lit/unlit pair once and starts unlit (Unity Awake → LightOff)', () => {
    const h = buildButtonScene();
    const cap = h.cap(PATHS.pushCap);
    const mesh = capMesh(cap);

    expect(cap.lightCapable).toBe(true);
    expect(cap.isLit).toBe(false);
    expect(emissiveHex(mesh)).toBe(0x000000);

    const unlit = mesh.material;
    cap.setLight(true);
    const lit = mesh.material;
    expect(lit).not.toBe(unlit);
    expect(emissiveHex(mesh)).not.toBe(0x000000);

    // Toggling back reuses the SAME two clones — no allocation per click.
    cap.setLight(false);
    expect(mesh.material).toBe(unlit);
    cap.setLight(true);
    expect(mesh.material).toBe(lit);
  });

  it('has no light when baseMaterial and activeMaterial are the same asset', () => {
    const h = buildButtonScene();
    // Emergency head and handle lever are both PlasticRed / PlasticRed.
    for (const path of [PATHS.emergencyNode, PATHS.handleCap]) {
      const cap = h.cap(path);
      const mesh = capMesh(cap);
      const authored = mesh.material;

      expect(cap.lightCapable).toBe(false);
      cap.setLight(true);
      expect(cap.isLit).toBe(false);
      expect(mesh.material).toBe(authored);   // untouched, not even cloned
    }
  });

  it('autoLight follows the button state when no lightSignal is wired', () => {
    const h = buildButtonScene({ withLightSignal: false });
    const base = h.base(PATHS.pushBase);
    const cap = h.cap(PATHS.pushCap);
    expect(base.autoLight).toBe(true);

    base.onClick();
    expect(cap.isLit).toBe(true);

    // Momentary release turns it off again.
    for (let i = 0; i < 30; i++) h.sceneButtonManager.update(0.02);
    expect(base.active).toBe(false);
    expect(cap.isLit).toBe(false);
  });

  it('lightSignal drives the light and takes it away from the button state', () => {
    const h = buildButtonScene();
    const base = h.base(PATHS.pushBase);
    const cap = h.cap(PATHS.pushCap);
    expect(base.autoLight).toBe(false);

    // Pressing the button must NOT light it — the PLC owns the lamp.
    base.onClick();
    expect(cap.isLit).toBe(false);

    const light = h.signalStore.nameForPath(PATHS.automaticLightSignal)!;
    h.signalStore.set(light, true);
    expect(cap.isLit).toBe(true);
    h.signalStore.set(light, false);
    expect(cap.isLit).toBe(false);
  });

  it('dispose restores the authored material and drops the mesh flag', () => {
    const h = buildButtonScene();
    const cap = h.cap(PATHS.pushCap);
    const mesh = capMesh(cap);

    cap.setLight(true);
    const litClone = mesh.material as MeshStandardMaterial;
    expect(mesh.userData._rvSceneButtonMesh).toBe(true);

    cap.dispose();
    const restored = mesh.material as MeshStandardMaterial;
    expect(mesh.userData._rvSceneButtonMesh).toBeUndefined();
    expect(restored).not.toBe(litClone);
    // The authored demo material is unlit-black; the disposed clones are gone.
    expect(restored.emissive.getHex()).toBe(0x000000);

    // A late setLight() on a disposed cap must not resurrect a clone.
    cap.setLight(true);
    expect(mesh.material).toBe(restored);
  });

  it('the manager clear() disposes every cap before a material teardown', () => {
    const h = buildButtonScene();
    const mesh = capMesh(h.cap(PATHS.pushCap));
    const handleMesh = capMesh(h.cap(PATHS.handleCap));

    h.sceneButtonManager.clear();
    expect(h.sceneButtonManager.size).toBe(0);
    expect(mesh.userData._rvSceneButtonMesh).toBeUndefined();
    expect(handleMesh.userData._rvSceneButtonMesh).toBeUndefined();
  });
});
