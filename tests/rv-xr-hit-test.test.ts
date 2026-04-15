// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, test, expect } from 'vitest';
import { Scene, Object3D } from 'three';
import { RVXRHitTester } from '../src/core/engine/rv-xr-hit-test';

describe('RVXRHitTester', () => {
  test('reticle starts invisible', () => {
    const scene = new Scene();
    const tester = new RVXRHitTester(scene);
    expect(tester.reticleMesh.visible).toBe(false);
    tester.dispose(scene);
  });

  test('reticle is added to scene', () => {
    const scene = new Scene();
    const childCount = scene.children.length;
    const tester = new RVXRHitTester(scene);
    expect(scene.children.length).toBe(childCount + 1);
    tester.dispose(scene);
  });

  test('reset clears hit test state', () => {
    const scene = new Scene();
    const tester = new RVXRHitTester(scene);
    tester.reset();
    expect(tester.reticleMesh.visible).toBe(false);
    tester.dispose(scene);
  });

  test('dispose removes reticle from scene', () => {
    const scene = new Scene();
    const childCount = scene.children.length;
    const tester = new RVXRHitTester(scene);
    expect(scene.children.length).toBe(childCount + 1);
    tester.dispose(scene);
    expect(scene.children.length).toBe(childCount);
  });

  test('placeModel returns false when reticle not visible', () => {
    const scene = new Scene();
    const tester = new RVXRHitTester(scene);
    const obj = new Object3D();
    expect(tester.placeModel(obj)).toBe(false);
    tester.dispose(scene);
  });
});
