// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-653 T1/T2 — AABBs of nodes whose world transform carries a SCALE.
 *
 * SolidCraft-synced bodies arrive with world quaternion −90° about X and world
 * scale 0.001 (geometry in mm, local Z up). A node-local `localCenter` (mm) used
 * to be rotated but never scaled, so the world centre landed ~720 m off and a
 * transport surface / sensor on such a node never met an MU.
 *
 * T1: scaled + rotated node → world min/max equal the mesh's world bounds (±1 mm).
 * T2: unit scale is BIT-identical to the pre-fix result; a mirrored node (−1) is correct.
 */

import { describe, it, expect } from 'vitest';
import {
  Object3D, Mesh, BoxGeometry, MeshBasicMaterial, Box3, Vector3, Quaternion, Matrix4, MathUtils,
} from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';

const MM = 0.001;
const TOL = 0.001; // ± 1 mm in metres

function stubContext(): ComponentContext {
  return {
    registry: { findInParent: () => null } as unknown as ComponentContext['registry'],
    signalStore: null as unknown as ComponentContext['signalStore'],
    scene: null as unknown as ComponentContext['scene'],
    transportManager: { surfaces: [] } as unknown as ComponentContext['transportManager'],
    root: new Object3D(),
  };
}

/** A SolidCraft-like body: quaternion −90° X, scale 0.001, mesh 0..1440 × 0..1440 × 748..750 mm. */
function makeSolidCraftNode(): { root: Object3D; node: Object3D } {
  const root = new Object3D();
  const node = new Object3D();
  node.name = 'RM8320_Curve';
  node.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
  node.scale.setScalar(MM);
  const geo = new BoxGeometry(1440, 1440, 2);
  geo.translate(720, 720, 749);
  node.add(new Mesh(geo, new MeshBasicMaterial()));
  root.add(node);
  root.updateMatrixWorld(true);
  return { root, node };
}

function worldBounds(node: Object3D): Box3 {
  node.updateMatrixWorld(true);
  return new Box3().setFromObject(node);
}

function expectBoxClose(aabb: AABB, box: Box3, tol = TOL): void {
  for (const k of ['x', 'y', 'z'] as const) {
    expect(Math.abs(aabb.min[k] - box.min[k]), `min.${k}`).toBeLessThanOrEqual(tol);
    expect(Math.abs(aabb.max[k] - box.max[k]), `max.${k}`).toBeLessThanOrEqual(tol);
  }
}

describe('plan-653 T1 — AABB on a scaled, rotated (Z-up mm) node', () => {
  it('fromNode: the construction-time centre is the world centre of the mesh', () => {
    const { node } = makeSolidCraftNode();
    const aabb = AABB.fromNode(node);
    expectBoxClose(aabb, worldBounds(node));
    expect(aabb.min.x).toBeCloseTo(0, 3);
    expect(aabb.min.y).toBeCloseTo(0.748, 3);
    expect(aabb.min.z).toBeCloseTo(-1.44, 3);
    expect(aabb.max.x).toBeCloseTo(1.44, 3);
    expect(aabb.max.y).toBeCloseTo(0.75, 3);
    expect(aabb.max.z).toBeCloseTo(0, 3);
  });

  it('node-local frame: update() follows a later parent move incl. the node scale', () => {
    const { root, node } = makeSolidCraftNode();
    const aabb = AABB.fromNode(node).useNodeLocalFrame();
    root.position.set(3, 0.2, -1);
    root.updateMatrixWorld(true);
    aabb.update();
    expectBoxClose(aabb, worldBounds(node));
  });

  it('transport surface footprint = mesh world bounds (min ≈ (0, 0.748, −1.44), max ≈ (1.44, 0.75, 0))', () => {
    const { node } = makeSolidCraftNode();
    const surface = new RVTransportSurface(node, AABB.fromNode(node));
    surface.init(stubContext());
    surface.updateAABB();
    expectBoxClose(surface.aabb, worldBounds(node));
    expect(surface.aabb.halfSize.x).toBeCloseTo(0.72, 4);
    expect(surface.aabb.halfSize.y).toBeCloseTo(0.001, 4);
    expect(surface.aabb.halfSize.z).toBeCloseTo(0.72, 4);
  });

  it('transport surface footprint follows a later parent rotation on the scaled node', () => {
    const { root, node } = makeSolidCraftNode();
    const surface = new RVTransportSurface(node, AABB.fromNode(node));
    surface.init(stubContext());
    root.rotation.y = MathUtils.degToRad(30);
    root.updateMatrixWorld(true);
    surface.updateAABB();
    expectBoxClose(surface.aabb, worldBounds(node));
  });

  it('non-uniform scale: footprint = mesh world bounds', () => {
    const { node } = makeSolidCraftNode();
    node.scale.set(MM * 2, MM, MM * 0.5);
    node.updateMatrixWorld(true);
    const surface = new RVTransportSurface(node, AABB.fromNode(node));
    surface.init(stubContext());
    surface.updateAABB();
    expectBoxClose(surface.aabb, worldBounds(node));
  });
});

describe('plan-653 T2 — unit scale unchanged, mirrored scale correct', () => {
  /** Unit-scale node rotated about two axes with an OFF-CENTRE mesh. */
  function makeRotatedUnitNode(): { root: Object3D; node: Object3D } {
    const root = new Object3D();
    root.position.set(1.2, 0.3, -0.4);
    root.rotation.set(MathUtils.degToRad(12), MathUtils.degToRad(37), 0);
    const node = new Object3D();
    node.position.set(0.5, 0, 0.25);
    node.rotation.y = MathUtils.degToRad(-21);
    const geo = new BoxGeometry(0.6, 0.1, 2.0);
    geo.translate(0.3, 0.05, 0.9);
    node.add(new Mesh(geo, new MeshBasicMaterial()));
    root.add(node);
    root.updateMatrixWorld(true);
    return { root, node };
  }

  /** The pre-plan-653 `AABB.update()` formula, reproduced verbatim. */
  function legacyCenter(node: Object3D, localCenter: Vector3): Vector3 {
    const c = new Vector3();
    node.getWorldPosition(c);
    const q = new Quaternion();
    node.getWorldQuaternion(q);
    return c.add(localCenter.clone().applyQuaternion(q));
  }

  /** The pre-plan-653 `RVTransportSurface.updateAABB()` half-size formula, verbatim. */
  function legacySurfaceHalf(node: Object3D, h: Vector3): Vector3 {
    const q = new Quaternion();
    node.getWorldQuaternion(q);
    const e = new Matrix4().makeRotationFromQuaternion(q).elements;
    return new Vector3(
      Math.abs(e[0]) * h.x + Math.abs(e[4]) * h.y + Math.abs(e[8]) * h.z,
      Math.abs(e[1]) * h.x + Math.abs(e[5]) * h.y + Math.abs(e[9]) * h.z,
      Math.abs(e[2]) * h.x + Math.abs(e[6]) * h.y + Math.abs(e[10]) * h.z,
    );
  }

  it('node-local frame on a unit-scale node is bit-identical to the legacy update()', () => {
    const { root, node } = makeRotatedUnitNode();
    const plain = AABB.fromNode(node);
    const framed = AABB.fromNode(node).useNodeLocalFrame();
    root.rotation.y += MathUtils.degToRad(64);
    root.updateMatrixWorld(true);
    plain.update();
    framed.update();
    expect(framed.center.toArray()).toEqual(plain.center.toArray());
    expect(framed.min.toArray()).toEqual(plain.min.toArray());
    expect(framed.max.toArray()).toEqual(plain.max.toArray());
    expect(framed.center.toArray()).toEqual(legacyCenter(node, framed.localCenter).toArray());
  });

  it('transport surface on a unit-scale node: half-size and centre bit-identical to the legacy formula', () => {
    const { root, node } = makeRotatedUnitNode();
    const surface = new RVTransportSurface(node, AABB.fromNode(node));
    surface.init(stubContext());
    // Recover the captured local half-extents from a pose where world == local axes.
    root.rotation.set(0, 0, 0);
    node.rotation.set(0, 0, 0);
    root.updateMatrixWorld(true);
    surface.updateAABB();
    const localHalf = surface.aabb.halfSize.clone();
    root.rotation.set(MathUtils.degToRad(12), MathUtils.degToRad(101), 0);
    node.rotation.y = MathUtils.degToRad(-21);
    root.updateMatrixWorld(true);
    surface.updateAABB();
    expect(surface.aabb.halfSize.toArray()).toEqual(legacySurfaceHalf(node, localHalf).toArray());
    expect(surface.aabb.center.toArray()).toEqual(legacyCenter(node, surface.aabb.localCenter).toArray());
  });

  it('mirrored node (scale x = −1): node-local frame centre equals the mesh world bounds', () => {
    const { node } = makeRotatedUnitNode();
    node.scale.set(-1, 1, 1);
    node.updateMatrixWorld(true);
    const aabb = AABB.fromNode(node).useNodeLocalFrame();
    aabb.update();
    expectBoxClose(aabb, worldBounds(node), 1e-6);
  });

  it('mirrored node: transport surface footprint equals the mesh world bounds', () => {
    const { node } = makeRotatedUnitNode();
    node.scale.set(-1, 1, 1);
    node.updateMatrixWorld(true);
    const surface = new RVTransportSurface(node, AABB.fromNode(node));
    surface.init(stubContext());
    surface.updateAABB();
    expectBoxClose(surface.aabb, worldBounds(node), 1e-6);
  });

  it('an AABB WITHOUT the node-local opt-in keeps the legacy rotation-only semantics (MU contract)', () => {
    // MU half-sizes / centres are stored in WORLD units of the rotation frame
    // (rv-mu-collider-bounds `computeMUColliderFrameBox`): scaling them again
    // would double-scale. A plain fromHalfSize AABB must therefore NOT scale.
    const node = new Object3D();
    node.scale.setScalar(MM);
    node.updateMatrixWorld(true);
    const aabb = AABB.fromHalfSize(node, new Vector3(0.1, 0.1, 0.1), new Vector3(0, 0.1, 0));
    aabb.update();
    expect(aabb.center.y).toBeCloseTo(0.1, 12);
    expect(aabb.halfSize.x).toBe(0.1);
  });
});
