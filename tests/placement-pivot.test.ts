// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * placement-pivot — `pivotToFloorCenter` measures DETACHED (plan-757 Phase 2,
 * spike S2 finding 3 / review F12).
 *
 * The pivot shifts a root's direct children so the content's floor centre
 * lands on the root's origin. It measured the AABB in WORLD space and
 * neutralised only the root's OWN transform — so under a transformed ancestor
 * (a nested placement inside a placed asset at x = 10; a reference grafted by
 * `compose()` under a transformed CAD sub-assembly) the ancestor's offset was
 * measured into the pivot and the content landed at −10. Three cases pin the
 * fix: a transformed parent, a root whose matrix is frozen
 * (`matrixAutoUpdate = false`, stale matrix), and a compose-style graft under
 * a transformed parent. The measurement must depend on the CONTENT only.
 */
import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D, Vector3 } from 'three';
import { pivotToFloorCenter } from '../src/core/engine/rv-placement-pivot';

/** A 1×0.5×1 box whose AABB spans x 1.5…2.5, y 0…0.5 → floor centre (2, 0, 0). */
function offCentreContent(): Object3D[] {
  const body = new Mesh(new BoxGeometry(1, 0.5, 1), new MeshBasicMaterial());
  body.name = 'Body';
  body.position.set(2, 0.25, 0);
  const slide = new Object3D();
  slide.name = 'Slide';
  slide.position.set(2, 0.5, 0);
  return [body, slide];
}

function rootWithContent(): Group {
  const root = new Group();
  root.name = 'Cell';
  for (const c of offCentreContent()) root.add(c);
  return root;
}

describe('pivotToFloorCenter measures the content, not the ancestors (plan-757 F12)', () => {
  it('under a TRANSFORMED parent the shift is the content offset only, and the world pose of the root is untouched', () => {
    const parent = new Group();
    parent.position.set(10, 0, 0);
    parent.rotation.y = Math.PI / 2;
    const root = rootWithContent();
    root.position.set(3, 0, 0);
    parent.add(root);
    parent.updateMatrixWorld(true);
    const worldBefore = root.getWorldPosition(new Vector3());
    const index = parent.children.indexOf(root);

    pivotToFloorCenter(root);
    parent.updateMatrixWorld(true);

    // Content shifted by −(2, 0, 0): Body at (0, 0.25, 0), Slide at (0, 0.5, 0).
    expect(root.getObjectByName('Body')!.position.toArray().map((n) => +n.toFixed(6))).toEqual([0, 0.25, 0]);
    expect(root.getObjectByName('Slide')!.position.toArray().map((n) => +n.toFixed(6))).toEqual([0, 0.5, 0]);
    // The root itself did not move, and it is back in its place under its parent.
    expect(root.position.toArray()).toEqual([3, 0, 0]);
    expect(root.parent).toBe(parent);
    expect(parent.children.indexOf(root)).toBe(index);
    expect(root.getWorldPosition(new Vector3()).distanceTo(worldBefore)).toBeLessThan(1e-9);
  });

  it('a FROZEN root (matrixAutoUpdate = false, stale matrix) is measured through a fresh local matrix and gets its matrix back', () => {
    const root = rootWithContent();
    // The stale case: the matrix still carries a translation the pose no longer has.
    root.position.set(5, 0, 0);
    root.updateMatrix();
    root.matrixAutoUpdate = false;
    root.position.set(7, 0, 0);
    // (matrix says x = 5, position says x = 7 — a freeze that predates a move)

    pivotToFloorCenter(root);

    expect(root.getObjectByName('Body')!.position.toArray().map((n) => +n.toFixed(6))).toEqual([0, 0.25, 0]);
    expect(root.getObjectByName('Slide')!.position.toArray().map((n) => +n.toFixed(6))).toEqual([0, 0.5, 0]);
    // The pose is restored AND recomposed into the frozen matrix by hand — a
    // caller's `updateMatrixWorld(true)` would not recompose it.
    expect(root.position.x).toBe(7);
    expect(root.matrixAutoUpdate).toBe(false);
    expect(new Vector3().setFromMatrixPosition(root.matrix).x).toBe(7);
  });

  it('a compose-style graft (content cloned under a reference node under a transformed parent) pivots like a placement', () => {
    // What `compose()` does: reference node in the containing file, the
    // referenced asset's root grafted under it, the pivot applied to the
    // reference node (PlacementMeta rule). The containing sub-assembly sits
    // off-origin and rotated.
    const subAssembly = new Group();
    subAssembly.name = 'Station';
    subAssembly.position.set(-4, 1, 6);
    subAssembly.rotation.z = 0.3;
    const referenceNode = new Object3D();
    referenceNode.name = 'Cell_1';
    referenceNode.position.set(3, 0, 0);
    subAssembly.add(referenceNode);
    const graft = rootWithContent();
    referenceNode.add(graft);
    subAssembly.updateMatrixWorld(true);

    pivotToFloorCenter(referenceNode);
    referenceNode.updateMatrixWorld(true);

    // The graft (the ONE direct child) shifted by −(2, 0, 0); its own children untouched.
    expect(graft.position.toArray().map((n) => +n.toFixed(6))).toEqual([-2, 0, 0]);
    expect(graft.getObjectByName('Body')!.position.toArray()).toEqual([2, 0.25, 0]);
    expect(referenceNode.position.toArray()).toEqual([3, 0, 0]);
    // The content's floor centre now sits ON the reference node, in world space.
    const refWorld = referenceNode.getWorldPosition(new Vector3());
    const bodyWorld = graft.getObjectByName('Body')!.getWorldPosition(new Vector3());
    // Body centre is 0.25 above the floor centre along the (rotated) local Y.
    const up = new Vector3(0, 0.25, 0).applyQuaternion(subAssembly.quaternion);
    expect(bodyWorld.distanceTo(refWorld.clone().add(up))).toBeLessThan(1e-9);
  });
});
