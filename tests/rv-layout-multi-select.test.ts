// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for MultiSelectPivot — extracted multi-selection pivot logic.
 */

import { describe, it, expect, vi } from 'vitest';
import { Group, Object3D, Scene, MathUtils, Vector3 } from 'three';
import { MultiSelectPivot } from '../src/plugins/layout-planner/multi-select-pivot';

// ─── Minimal mock deps ──────────────────────────────────────────────

function createMockFloorGizmo() {
  return {
    attach: vi.fn(),
    detach: vi.fn(),
    setTranslationSnap: vi.fn(),
    setRotationSnap: vi.fn(),
  };
}

function createDeps(overrides: Partial<any> = {}) {
  const scene = new Scene();
  const idByObject = new WeakMap<Object3D, string>();
  const store = {
    updateTransform: vi.fn(),
    autoSave: vi.fn(),
  };
  const tc = createMockFloorGizmo();
  const viewer = {} as any;

  return {
    deps: {
      scene,
      store: store as any,
      transformControls: tc as any,
      viewer,
      idByObject,
      ...overrides,
    },
    mocks: { store, tc, idByObject, scene },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('MultiSelectPivot', () => {

  it('should detach gizmo when no objects selected', () => {
    const { deps, mocks } = createDeps();
    const pivot = new MultiSelectPivot(deps);

    pivot.syncToSelection([], false, 500, 15);

    expect(mocks.tc.detach).toHaveBeenCalled();
    expect(pivot.isActive).toBe(false);
  });

  it('should attach gizmo directly for single selection', () => {
    const { deps, mocks } = createDeps();
    const pivot = new MultiSelectPivot(deps);
    const obj = new Object3D();
    obj.userData._layoutId = 'a';
    mocks.scene.add(obj);

    pivot.syncToSelection([obj], false, 500, 15);

    expect(mocks.tc.attach).toHaveBeenCalledWith(obj);
    expect(pivot.isActive).toBe(false); // no pivot group for single
  });

  it('should build centroid pivot for multi-selection', () => {
    const { deps, mocks } = createDeps();
    const pivot = new MultiSelectPivot(deps);
    const objA = new Object3D(); objA.name = 'A'; objA.userData._layoutId = 'a';
    const objB = new Object3D(); objB.name = 'B'; objB.userData._layoutId = 'b';
    objA.position.set(2, 0, 0);
    objB.position.set(4, 0, 0);
    mocks.scene.add(objA, objB);

    pivot.syncToSelection([objA, objB], false, 500, 15);

    expect(pivot.isActive).toBe(true);
    expect(pivot.memberCount).toBe(2);
    // Gizmo attached to the pivot group (not individual objects)
    expect(mocks.tc.attach).toHaveBeenCalled();
    const attachedTarget = mocks.tc.attach.mock.calls[0][0];
    expect(attachedTarget.name).toBe('_layoutSelectionPivot');
  });

  it('should write correct world-space positions to store after pivot drag', () => {
    const { deps, mocks } = createDeps();
    const pivot = new MultiSelectPivot(deps);

    // Set up two objects at known positions
    const objA = new Object3D(); objA.name = 'A'; objA.userData._layoutId = 'a';
    const objB = new Object3D(); objB.name = 'B'; objB.userData._layoutId = 'b';
    objA.position.set(1, 0, 0);
    objB.position.set(3, 0, 0);
    mocks.scene.add(objA, objB);
    mocks.idByObject.set(objA, 'id-a');
    mocks.idByObject.set(objB, 'id-b');

    // Build pivot
    pivot.syncToSelection([objA, objB], false, 500, 15);
    // Selection alone keeps members under their own parent (hierarchy rows stay)
    expect(objA.parent).toBe(mocks.scene);

    // Simulate a drag: drag start parks members, then move the pivot 2m on X
    pivot.parkMembers();
    const pivotGroup = mocks.tc.attach.mock.calls[0][0] as Group;
    pivotGroup.position.x += 2;
    pivotGroup.updateMatrixWorld(true);

    // Flush transforms (simulating drag end)
    pivot.writeTransformsOnDragEnd();

    // Verify store received the correct positions
    expect(mocks.store.updateTransform).toHaveBeenCalledTimes(2);

    // After re-attaching to original parent (scene), the objects should
    // have their world positions reflected in local space (parent = scene root)
    const calls = mocks.store.updateTransform.mock.calls;
    const posA = calls.find((c: any) => c[0] === 'id-a')?.[1];
    const posB = calls.find((c: any) => c[0] === 'id-b')?.[1];

    expect(posA).toBeDefined();
    expect(posB).toBeDefined();
    // objA started at x=1, pivot moved +2, so new x should be ~3
    expect(posA![0]).toBeCloseTo(3, 1);
    // objB started at x=3, pivot moved +2, so new x should be ~5
    expect(posB![0]).toBeCloseTo(5, 1);
  });

  it('should call writeTransformsOnDragEnd synchronously before tearDown (contract)', () => {
    const { deps, mocks } = createDeps();
    const pivot = new MultiSelectPivot(deps);

    const objA = new Object3D(); objA.name = 'A'; objA.userData._layoutId = 'a';
    const objB = new Object3D(); objB.name = 'B'; objB.userData._layoutId = 'b';
    objA.position.set(1, 0, 0);
    objB.position.set(3, 0, 0);
    mocks.scene.add(objA, objB);
    mocks.idByObject.set(objA, 'id-a');
    mocks.idByObject.set(objB, 'id-b');

    pivot.syncToSelection([objA, objB], false, 500, 15);
    expect(pivot.isActive).toBe(true);

    // Critical contract: flush THEN tearDown, synchronously
    const callOrder: string[] = [];
    const origUpdateTransform = mocks.store.updateTransform;
    mocks.store.updateTransform = vi.fn((...args: any[]) => {
      callOrder.push('flush');
      origUpdateTransform(...args);
    });

    pivot.writeTransformsOnDragEnd();
    callOrder.push('tearDown');
    pivot.tearDown();

    // Verify ordering: all flushes happen before tearDown
    const tearDownIdx = callOrder.indexOf('tearDown');
    const lastFlushIdx = callOrder.lastIndexOf('flush');
    expect(lastFlushIdx).toBeLessThan(tearDownIdx);
    expect(pivot.isActive).toBe(false);
    expect(pivot.memberCount).toBe(0);
  });

  it('should set snap when grid is enabled', () => {
    const { deps, mocks } = createDeps();
    const pivot = new MultiSelectPivot(deps);
    const obj = new Object3D();
    obj.userData._layoutId = 'a';
    mocks.scene.add(obj);

    pivot.syncToSelection([obj], true, 500, 15);

    expect(mocks.tc.setTranslationSnap).toHaveBeenCalledWith(0.5); // 500mm / 1000
    expect(mocks.tc.setRotationSnap).toHaveBeenCalledWith(MathUtils.degToRad(15));
  });

  it('should clear snap when grid is disabled', () => {
    const { deps, mocks } = createDeps();
    const pivot = new MultiSelectPivot(deps);
    const obj = new Object3D();
    obj.userData._layoutId = 'a';
    mocks.scene.add(obj);

    pivot.syncToSelection([obj], false, 500, 15);

    expect(mocks.tc.setTranslationSnap).toHaveBeenCalledWith(null);
    expect(mocks.tc.setRotationSnap).toHaveBeenCalledWith(null);
  });

  it('should restore members to original parents on tearDown', () => {
    const { deps, mocks } = createDeps();
    const pivot = new MultiSelectPivot(deps);

    const parent = new Group(); parent.name = 'parent';
    mocks.scene.add(parent);
    const objA = new Object3D(); objA.name = 'A'; objA.userData._layoutId = 'a';
    parent.add(objA);

    pivot.syncToSelection([objA], false, 500, 15);
    // For single-select no pivot is built — test with 2 objects
    const objB = new Object3D(); objB.name = 'B'; objB.userData._layoutId = 'b';
    parent.add(objB);

    pivot.syncToSelection([objA, objB], false, 500, 15);
    expect(pivot.isActive).toBe(true);

    pivot.tearDown();

    // Members should be back under their original parent
    expect(objA.parent).toBe(parent);
    expect(objB.parent).toBe(parent);
    expect(pivot.isActive).toBe(false);
  });
});
