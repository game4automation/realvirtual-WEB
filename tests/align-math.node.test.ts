// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Planner Align tool maths (plan-779): corner snap in screen space, the
 * axis-masked world delta and the conversion into the record parent's frame.
 */

import { describe, it, expect } from 'vitest';
import { Matrix4, Object3D, OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import {
  pickNearestCorner,
  computeAlignDelta,
  translateInParentFrame,
} from '../src/plugins/layout-planner/align/align-math';

const RECT = { left: 0, top: 0, width: 200, height: 200 };

function perspCam(): PerspectiveCamera {
  const cam = new PerspectiveCamera(60, 1, 0.1, 100);
  cam.position.set(0, 0, 5);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  return cam;
}

/** Screen position of a world point (same mapping as pickNearestCorner). */
function toPx(p: Vector3, cam: PerspectiveCamera | OrthographicCamera, rect = RECT): { x: number; y: number } {
  const n = p.clone().project(cam);
  return { x: rect.left + (n.x + 1) * 0.5 * rect.width, y: rect.top + (1 - n.y) * 0.5 * rect.height };
}

const tri = (): [Vector3, Vector3, Vector3] => [new Vector3(-1, -1, 0), new Vector3(1, -1, 0), new Vector3(0, 1, 0)];

describe('pickNearestCorner', () => {
  it('picks the corner with the smallest pixel distance within 12 px', () => {
    const cam = perspCam();
    const t = tri();
    const p = toPx(t[1], cam);
    expect(pickNearestCorner(t, { x: p.x + 5, y: p.y - 3 }, cam, RECT)).toBe(1);
  });

  it('returns -1 when no corner lies within 12 px', () => {
    const cam = perspCam();
    const t = tri();
    const p = toPx(t[1], cam);
    expect(pickNearestCorner(t, { x: p.x + 20, y: p.y }, cam, RECT)).toBe(-1);
  });

  it('ignores corners behind the camera', () => {
    const cam = perspCam();
    const t: [Vector3, Vector3, Vector3] = [new Vector3(0, 0, 10), new Vector3(1, -1, 0), new Vector3(0, 1, 0)];
    // A point behind the camera projects to a mirrored screen position; aim at it.
    const mirrored = toPx(t[0], cam);
    expect(pickNearestCorner(t, mirrored, cam, RECT)).toBe(-1);
  });

  it('respects the canvas offset (rect.left/top)', () => {
    const cam = perspCam();
    const rect = { left: 300, top: 50, width: 200, height: 200 };
    const t = tri();
    const p = toPx(t[2], cam, rect);
    expect(pickNearestCorner(t, p, cam, rect)).toBe(2);
    expect(pickNearestCorner(t, toPx(t[2], cam), cam, rect)).toBe(-1);
  });

  it('works with an orthographic camera', () => {
    const cam = new OrthographicCamera(-3, 3, 3, -3, 0.1, 100);
    cam.position.set(0, 0, 5);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    const t = tri();
    expect(pickNearestCorner(t, toPx(t[0], cam), cam, RECT)).toBe(0);
  });
});

describe('computeAlignDelta', () => {
  const a = { x: 1, y: 0, z: 2 };
  const b = { x: 4, y: 1.5, z: -1 };
  const zero = { x: 0, y: 0, z: 0 };

  it('X+Z active, no offset: moves A corner onto B corner in X/Z, Y untouched', () => {
    const d = computeAlignDelta(a, b, { x: true, y: false, z: true }, zero, new Vector3());
    expect(d.x).toBeCloseTo(3);
    expect(d.y).toBe(0);
    expect(d.z).toBeCloseTo(-3);
  });

  it('applies the mm offset only on active axes', () => {
    const d = computeAlignDelta(a, b, { x: true, y: false, z: false }, { x: 250, y: 999, z: 999 }, new Vector3());
    expect(d.x).toBeCloseTo(3.25);
    expect(d.y).toBe(0);
    expect(d.z).toBe(0);
  });

  it('all axes off gives a zero delta', () => {
    const d = computeAlignDelta(a, b, { x: false, y: false, z: false }, zero, new Vector3());
    expect(d.lengthSq()).toBe(0);
  });

  it('non-finite offsets count as 0', () => {
    const d = computeAlignDelta(a, b, { x: true, y: true, z: true }, { x: NaN, y: Infinity, z: -Infinity }, new Vector3());
    expect(d.x).toBeCloseTo(3);
    expect(d.y).toBeCloseTo(1.5);
    expect(d.z).toBeCloseTo(-3);
  });

  it('is idempotent: after applying the delta a second call yields zero', () => {
    const axes = { x: true, y: true, z: true };
    const off = { x: 10, y: -20, z: 30 };
    const d = computeAlignDelta(a, b, axes, off, new Vector3());
    const moved = { x: a.x + d.x, y: a.y + d.y, z: a.z + d.z };
    const d2 = computeAlignDelta(moved, b, axes, off, new Vector3());
    expect(d2.length()).toBeLessThan(1e-12);
  });
});

describe('translateInParentFrame', () => {
  it('identity parent: position + delta', () => {
    const r = translateInParentFrame({ x: 1, y: 2, z: 3 }, new Matrix4(), { x: 0.5, y: 0, z: -1 });
    expect(r[0]).toBeCloseTo(1.5);
    expect(r[1]).toBeCloseTo(2);
    expect(r[2]).toBeCloseTo(2);
  });

  it('rotated + translated parent: lands the child at rootWorld + delta in world space', () => {
    const parent = new Object3D();
    parent.position.set(10, 0, -4);
    parent.rotation.set(0, Math.PI / 3, 0);
    const child = new Object3D();
    child.position.set(2, 0, 1);
    parent.add(child);
    parent.updateMatrixWorld(true);
    const rootWorld = child.getWorldPosition(new Vector3());
    const delta = new Vector3(0.7, 0, -1.3);
    const local = translateInParentFrame(rootWorld, parent.matrixWorld, delta);
    child.position.set(local[0], local[1], local[2]);
    parent.updateMatrixWorld(true);
    const after = child.getWorldPosition(new Vector3());
    expect(after.distanceTo(rootWorld.clone().add(delta))).toBeLessThan(1e-9);
  });

  it('scaled / mirrored parent', () => {
    const parent = new Object3D();
    parent.scale.set(-2, 1, 0.5);
    const child = new Object3D();
    child.position.set(1, 1, 1);
    parent.add(child);
    parent.updateMatrixWorld(true);
    const rootWorld = child.getWorldPosition(new Vector3());
    const delta = new Vector3(1, 2, 3);
    const local = translateInParentFrame(rootWorld, parent.matrixWorld, delta);
    child.position.set(local[0], local[1], local[2]);
    parent.updateMatrixWorld(true);
    expect(child.getWorldPosition(new Vector3()).distanceTo(rootWorld.clone().add(delta))).toBeLessThan(1e-9);
  });

  it('record parent differs from the current parent (multi-select pivot): computes in the record parent', () => {
    const layoutRoot = new Object3D();
    layoutRoot.position.set(5, 0, 0);
    layoutRoot.rotation.set(0, Math.PI / 2, 0);
    const pivot = new Object3D();
    pivot.position.set(1, 0, 1);
    layoutRoot.add(pivot);
    const node = new Object3D();
    layoutRoot.add(node);
    node.position.set(2, 0, 0);
    layoutRoot.updateMatrixWorld(true);
    pivot.attach(node); // pivot holds the node, world transform kept
    layoutRoot.updateMatrixWorld(true);
    const rootWorld = node.getWorldPosition(new Vector3());
    const delta = new Vector3(0, 0, 1);
    const local = translateInParentFrame(rootWorld, layoutRoot.matrixWorld, delta);
    // Apply as the planner does: re-park under the record parent, set, re-attach.
    layoutRoot.attach(node);
    node.position.set(local[0], local[1], local[2]);
    pivot.attach(node);
    layoutRoot.updateMatrixWorld(true);
    expect(node.getWorldPosition(new Vector3()).distanceTo(rootWorld.clone().add(delta))).toBeLessThan(1e-9);
  });
});
