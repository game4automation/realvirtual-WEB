// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-scene-button-manager.test.ts — plan-417 §9.5.
 *
 * The manager owns the only per-frame work of the feature, so it has to be
 * honest about two things: `update()` must report `changed` correctly (the
 * viewer renders on demand — a wrong `false` freezes the animation mid-press),
 * and an idle button must fall OUT of the tick set instead of burning a slot
 * every frame.
 *
 * Plus the RENDER truth (plan-417 follow-up): asserting `position` / `rotation`
 * only proves the logical pose. The loader freezes static meshes
 * (`matrixAutoUpdate = false`), and on a frozen node a written pose never
 * reaches `matrix` — the signal toggles but the lever never visibly moves. The
 * matrix assertions below are the ones that catch that.
 */

import { describe, expect, it } from 'vitest';
import { Matrix4, Quaternion, Vector3, type Mesh } from 'three';
import { SceneButtonManager } from '../src/core/engine/rv-scene-button-manager';
import { buildButtonScene, PATHS } from './scene-button-fixture';

/** Run `seconds` of simulated time and report whether anything ever changed. */
function run(manager: SceneButtonManager, seconds: number, step = 1 / 60): boolean {
  let changed = false;
  for (let t = 0; t < seconds - 1e-9; t += step) {
    if (manager.update(step)) changed = true;
  }
  return changed;
}

/** True when `mesh.matrix` really is compose(position, quaternion, scale). */
function matrixInSync(mesh: Mesh): boolean {
  const expected = new Matrix4().compose(mesh.position, mesh.quaternion, mesh.scale);
  return expected.elements.every((v, i) => Math.abs(v - mesh.matrix.elements[i]) < 1e-9);
}

describe('SceneButtonManager', () => {
  it('registers every scene-button member of the model', () => {
    const h = buildButtonScene();
    // 3 wrappers + 3 bases + 3 caps.
    expect(h.sceneButtonManager.size).toBe(9);
  });

  it('is idle until something has to move', () => {
    const h = buildButtonScene();
    // The activeOnStart handle switch settles first.
    run(h.sceneButtonManager, 2);
    expect(h.sceneButtonManager.activeSize).toBe(0);
    expect(h.sceneButtonManager.update(1 / 60)).toBe(false);
  });

  it('lerps the cap towards the press offset and stops when it arrives', () => {
    const h = buildButtonScene();
    run(h.sceneButtonManager, 2);                       // settle
    const cap = h.cap(PATHS.pushCap);
    const startZ = cap.capMesh!.position.z;

    h.base(PATHS.pushBase).onClick();
    expect(h.sceneButtonManager.activeSize).toBeGreaterThan(0);

    // A single small step must move it a little, not all the way.
    expect(h.sceneButtonManager.update(1 / 60)).toBe(true);
    const afterOneStep = cap.currentOffset;
    expect(afterOneStep).not.toBe(0);

    // ... and within the 0.3 s hold time it converges on
    // activeOffset + hoverOffset (Unity ToggleClick calls Click() then Hover()).
    run(h.sceneButtonManager, 0.25);
    expect(cap.currentOffset).toBeCloseTo(cap.activeOffset + cap.hoverOffset, 6);
    expect(cap.capMesh!.position.z).toBeCloseTo(startZ + cap.currentOffset, 6);

    // After the momentary release the cap returns to the hover-only offset and
    // the manager goes idle again — no permanent per-frame cost.
    run(h.sceneButtonManager, 2);
    expect(cap.currentOffset).toBeCloseTo(cap.hoverOffset, 6);
    expect(h.sceneButtonManager.activeSize).toBe(0);
  });

  it('rotates instead of translating when angularMovement is set', () => {
    const h = buildButtonScene();
    const cap = h.cap(PATHS.handleCap);
    expect(cap.angularMovement).toBe(true);

    run(h.sceneButtonManager, 3);
    // activeOnStart latched the switch: 90° active + mirrored -5° hover... the
    // self-click uses release(), so it settles on the plain active offset.
    expect(cap.currentOffset).toBeCloseTo(90, 4);
    expect(cap.capMesh!.position.toArray()).toEqual([0, 0, 0]);   // never translated

    // Rotation is around the NEGATED glTF axis (improper Unity basis change).
    const expected = new Quaternion().setFromAxisAngle(
      new Vector3(-0, 0, 1).normalize().negate(),
      (90 * Math.PI) / 180,
    );
    expect(cap.capMesh!.quaternion.angleTo(expected)).toBeLessThan(1e-6);
  });

  it('un-freezes the cap so the pressed pose reaches the rendered matrix', () => {
    const h = buildButtonScene();
    const cap = h.cap(PATHS.pushCap);
    const mesh = cap.capMesh!;

    run(h.sceneButtonManager, 2);                       // settle
    h.scene.updateMatrixWorld();
    const before = mesh.matrixWorld.clone();

    h.base(PATHS.pushBase).onClick();
    run(h.sceneButtonManager, 0.25);
    // Exactly what WebGLRenderer.render() does before drawing.
    h.scene.updateMatrixWorld();

    expect(cap.currentOffset).not.toBe(0);              // logical pose moved …
    expect(mesh.matrixWorld.equals(before)).toBe(false); // … and so did the drawn one
    expect(matrixInSync(mesh)).toBe(true);
    const drawn = new Vector3().setFromMatrixPosition(mesh.matrixWorld);
    expect(drawn.z).toBeCloseTo(cap.currentOffset, 6);
  });

  it('un-freezes the rotating handle cap as well (90° lever must be visible)', () => {
    const h = buildButtonScene();
    const cap = h.cap(PATHS.handleCap);
    const mesh = cap.capMesh!;

    h.scene.updateMatrixWorld();
    const before = mesh.matrixWorld.clone();

    run(h.sceneButtonManager, 3);                       // activeOnStart latches 90°
    h.scene.updateMatrixWorld();

    expect(cap.currentOffset).toBeCloseTo(90, 4);
    expect(mesh.matrixWorld.equals(before)).toBe(false);
    expect(matrixInSync(mesh)).toBe(true);
    const drawn = new Quaternion().setFromRotationMatrix(mesh.matrixWorld);
    expect(drawn.angleTo(mesh.quaternion)).toBeLessThan(1e-6);
    expect(drawn.angleTo(new Quaternion())).toBeCloseTo(Math.PI / 2, 4);
  });

  it('dispose() hands the cap back to the static pipeline as it found it', () => {
    const h = buildButtonScene();
    const cap = h.cap(PATHS.pushCap);
    const mesh = cap.capMesh!;
    expect(mesh.matrixAutoUpdate).toBe(true);           // un-frozen while alive

    cap.dispose();
    expect(mesh.matrixAutoUpdate).toBe(false);          // frozen again on teardown
  });

  it('leaves an already-dynamic cap alone on dispose', () => {
    const h = buildButtonScene({ frozenStatics: false });
    const cap = h.cap(PATHS.pushCap);
    const mesh = cap.capMesh!;
    expect(mesh.matrixAutoUpdate).toBe(true);

    cap.dispose();
    expect(mesh.matrixAutoUpdate).toBe(true);
  });

  it('setActive(false) takes a member out of the tick set without unregistering', () => {
    const manager = new SceneButtonManager();
    let ticks = 0;
    const member = { updateButton: () => { ticks++; return false; } };

    manager.register(member);
    manager.setActive(member, true);
    manager.update(0.1);
    expect(ticks).toBe(1);

    manager.setActive(member, false);
    manager.update(0.1);
    expect(ticks).toBe(1);
    expect(manager.size).toBe(1);
  });

  it('clear() disposes every member exactly once, even when dispose unregisters', () => {
    const manager = new SceneButtonManager();
    const disposed: string[] = [];
    const a = { dispose: () => { disposed.push('a'); manager.unregister(a); } };
    const b = { dispose: () => { disposed.push('b'); manager.unregister(b); } };
    manager.register(a);
    manager.register(b);

    manager.clear();
    expect(disposed.sort()).toEqual(['a', 'b']);
    expect(manager.size).toBe(0);
    expect(manager.activeSize).toBe(0);
  });
});
