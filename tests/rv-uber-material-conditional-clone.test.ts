// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for plan-153 — conditional geometry clone in applyUberMaterial.
 *
 * When every uber-eligible user of a shared BufferGeometry would bake to
 * the same color+rmPacked output, the bake runs once in-place and every
 * user keeps the same geometry reference. Only genuine material conflicts
 * fall back to per-mesh cloning. See:
 *   .docs/planfeature/plan-153-webviewer-mesh-dedup-source-dispose.md
 */

import { describe, it, expect } from 'vitest';
import {
  BoxGeometry,
  Group,
  Material,
  Mesh,
  MeshStandardMaterial,
  Texture,
} from 'three';
import { applyUberMaterial } from '../src/core/engine/rv-uber-material';

describe('applyUberMaterial conditional clone (plan-153)', () => {
  it('9.1 shares geometry when all uber-eligible users have the same material', () => {
    const sharedGeo = new BoxGeometry(1, 1, 1);
    const mat = new MeshStandardMaterial({ color: 0xff0000 });
    const meshA = new Mesh(sharedGeo, mat);
    const meshB = new Mesh(sharedGeo, mat);
    const root = new Group();
    root.add(meshA, meshB);

    const uniqueMats = new Set<Material>([mat]);
    applyUberMaterial(root, uniqueMats);

    // Both meshes keep the SAME geometry instance (no clone).
    expect(meshA.geometry).toBe(meshB.geometry);
    expect(meshA.geometry).toBe(sharedGeo);

    // In-place bake marker set.
    expect(meshA.geometry.userData._rvUberBaked).toBe(true);

    // Baked attributes present on the shared geometry.
    expect(meshA.geometry.attributes.color).toBeDefined();
    expect(meshA.geometry.attributes.rmPacked).toBeDefined();
  });

  it('9.2 clones geometry when eligible users have different materials', () => {
    const sharedGeo = new BoxGeometry(1, 1, 1);
    const matRed = new MeshStandardMaterial({ color: 0xff0000 });
    const matGreen = new MeshStandardMaterial({ color: 0x00ff00 });
    const meshA = new Mesh(sharedGeo, matRed);
    const meshB = new Mesh(sharedGeo, matGreen);
    const root = new Group();
    root.add(meshA, meshB);

    applyUberMaterial(root, new Set<Material>([matRed, matGreen]));

    // Conflict → each mesh receives its own cloned geometry.
    expect(meshA.geometry).not.toBe(meshB.geometry);
    expect(meshA.geometry).not.toBe(sharedGeo);
    expect(meshB.geometry).not.toBe(sharedGeo);
  });

  it('9.3 does not double-bake shared geometry when multiple meshes use it', () => {
    const sharedGeo = new BoxGeometry(1, 1, 1);
    const mat = new MeshStandardMaterial({ color: 0xff0000 });
    const meshA = new Mesh(sharedGeo, mat);
    const meshB = new Mesh(sharedGeo, mat);
    const meshC = new Mesh(sharedGeo, mat);
    const root = new Group();
    root.add(meshA, meshB, meshC);

    applyUberMaterial(root, new Set<Material>([mat]));

    // All three meshes share the same (in-place baked) geometry instance.
    expect(meshA.geometry).toBe(sharedGeo);
    expect(meshB.geometry).toBe(sharedGeo);
    expect(meshC.geometry).toBe(sharedGeo);

    // Color attribute exists exactly once with vertex-count entries —
    // not doubled/tripled by repeated bakes.
    const colorAttr = sharedGeo.attributes.color;
    const posAttr = sharedGeo.attributes.position;
    expect(colorAttr).toBeDefined();
    expect(colorAttr.count).toBe(posAttr.count);
  });

  it('9.4 non-eligible co-user does not break sharing between eligible users', () => {
    const sharedGeo = new BoxGeometry(1, 1, 1);
    const matSolid = new MeshStandardMaterial({ color: 0xff0000 });
    // Textured (non-eligible) material — keeps its own material after the pass.
    const matTextured = new MeshStandardMaterial({ color: 0xffffff });
    matTextured.map = new Texture();

    const meshA = new Mesh(sharedGeo, matSolid);
    const meshB = new Mesh(sharedGeo, matSolid);
    const meshNonEligible = new Mesh(sharedGeo, matTextured);
    const root = new Group();
    root.add(meshA, meshB, meshNonEligible);

    applyUberMaterial(root, new Set<Material>([matSolid, matTextured]));

    // meshA and meshB still share the geometry (and sharedGeo itself).
    expect(meshA.geometry).toBe(meshB.geometry);
    expect(meshA.geometry).toBe(sharedGeo);

    // Non-eligible mesh keeps its own textured material untouched.
    expect(meshNonEligible.material).toBe(matTextured);
  });
});
