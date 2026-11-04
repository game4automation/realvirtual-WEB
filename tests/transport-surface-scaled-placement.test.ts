// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-653 fix-up (2026-10-21) — surface height of a SolidCraft curve placed in
 * the layout planner.
 *
 * Live acceptance: `web_layout_place(..., onto=<curve>)` reported
 * `surfaceHeight: 0.9837` for one placement of the curve and the correct 0.75
 * for the other. Cause: the curve was SELECTED — `RVTransportSurface` parents its
 * selection gizmo (outline + 0.5 m arrow) under the surface node, built in the
 * node's local XZ plane. On a SolidCraft body (local Z up, mm) that arrow stands
 * upright along the transport axis and its tip reaches ≈ 0.234 m above the belt;
 * `transportSurfaceTop` unioned it as geometry. The rotation was a coincidence.
 *
 * Scene graph like the planner builds it:
 *   placement root (planner transform) → asset root (bbox recentring)
 *   → Transport_1 → ConveyorSurface (−90° X, scale 0.001, quarter annulus mm)
 */

import { describe, it, expect } from 'vitest';
import {
  Object3D, Mesh, MeshBasicMaterial, Scene, Vector3, Box3, Shape, ExtrudeGeometry,
} from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { computeSubtreeAABB } from '../src/core/engine/rv-traverse-utils';
import { transportSurfaceTop } from '../src/plugins/layout-planner/planner-commands';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';

const MM = 0.001;
const TOL = 0.001; // 1 mm

function stubContext(): ComponentContext {
  return {
    registry: { findInParent: () => null } as unknown as ComponentContext['registry'],
    signalStore: null as unknown as ComponentContext['signalStore'],
    scene: null as unknown as ComponentContext['scene'],
    transportManager: { surfaces: [] } as unknown as ComponentContext['transportManager'],
    root: new Object3D(),
  };
}

/** Quarter annulus in local mm: radius 400..1440 in the XY quadrant, z 748..750. */
function quarterAnnulus(): ExtrudeGeometry {
  const r0 = 400, R = 1440;
  const s = new Shape();
  s.moveTo(r0, 0);
  s.lineTo(R, 0);
  s.absarc(0, 0, R, 0, Math.PI / 2, false);
  s.lineTo(0, r0);
  s.absarc(0, 0, r0, Math.PI / 2, 0, true);
  const g = new ExtrudeGeometry(s, { depth: 2, bevelEnabled: false, curveSegments: 24 });
  g.translate(0, 0, 748);
  return g;
}

interface Built { scene: Scene; placement: Object3D; node: Object3D; mesh: Mesh; surface: RVTransportSurface }

function build(rotYDeg: number, pos = new Vector3()): Built {
  const scene = new Scene();
  const placement = new Object3D();
  placement.name = 'TestSolidCraft';
  placement.position.copy(pos);
  placement.rotation.y = rotYDeg * Math.PI / 180;
  const asset = new Object3D();
  asset.name = 'SolidCraft_RM8320_Kurve_BF620_90';
  // Library recentring: the world footprint x 0..1.44, z −1.44..0 → centred.
  asset.position.set(-0.72, 0, 0.72);
  const group = new Object3D();
  group.name = 'Transport_1';
  const node = new Object3D();
  node.name = 'ConveyorSurface';
  node.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
  node.scale.setScalar(MM);
  node.userData.realvirtual = { TransportSurface: { Radial: true } };
  const mesh = new Mesh(quarterAnnulus(), new MeshBasicMaterial());
  node.add(mesh);
  group.add(node);
  asset.add(group);
  placement.add(asset);
  scene.add(placement);
  scene.updateMatrixWorld(true);

  const surface = new RVTransportSurface(node, AABB.fromNode(node));
  surface.Radial = true;
  surface.TransportDirection.set(0, 0, 1);
  surface.init(stubContext());
  return { scene, placement, node, mesh, surface };
}

function meshWorldBounds(mesh: Mesh): Box3 {
  mesh.updateWorldMatrix(true, false);
  return new Box3().setFromObject(mesh, true);
}

function expectAabbMatchesMesh(b: Built): void {
  const w = meshWorldBounds(b.mesh);
  const a = b.surface.aabb;
  expect(a.max.y).toBeCloseTo(0.75, 3);
  expect(Math.abs(a.max.y - 0.75)).toBeLessThan(TOL);
  expect(Math.abs(a.min.x - w.min.x)).toBeLessThan(TOL);
  expect(Math.abs(a.max.x - w.max.x)).toBeLessThan(TOL);
  expect(Math.abs(a.min.z - w.min.z)).toBeLessThan(TOL);
  expect(Math.abs(a.max.z - w.max.z)).toBeLessThan(TOL);
}

/** Shows the real selection gizmo (no GizmoOverlayManager in a unit test). */
function select(surface: RVTransportSurface): void {
  const s = surface as unknown as { _selGizmoMgr: unknown; _showSelectionGizmo(): void };
  s._selGizmoMgr = {};
  s._showSelectionGizmo();
}

/** The surface's selection overlay (private fields, tests only). */
const view = (s: unknown): { _selArrow: unknown } => s as { _selArrow: unknown };

describe('plan-653 fix-up — scaled SolidCraft surface under a planner placement', () => {
  for (const rot of [0, 90, 180, 270]) {
    it(`surface AABB = mesh world bounds, top 0.75 m, placement rotated ${rot}°`, () => {
      const b = build(rot, new Vector3(-1.436, 0, 0));
      b.surface.updateAABB();
      expectAabbMatchesMesh(b);
    });

    it(`surface AABB follows a placement moved/rotated AFTER construction (start ${rot}°)`, () => {
      const b = build(rot);
      b.placement.position.set(2.5, 0, -1.25);
      b.placement.rotation.y = (rot + 90) * Math.PI / 180;
      b.scene.updateMatrixWorld(true);
      b.surface.updateAABB();
      expectAabbMatchesMesh(b);
    });

    it(`transportSurfaceTop reports 0.75 m, placement rotated ${rot}°`, () => {
      const b = build(rot);
      const top = transportSurfaceTop(b.placement);
      expect(top.source).toBe('TransportSurface');
      expect(Math.abs(top.y - 0.75)).toBeLessThan(TOL);
    });

    it(`transportSurfaceTop ignores the selection gizmo of a selected surface (${rot}°)`, () => {
      const b = build(rot);
      const before = transportSurfaceTop(b.placement);
      select(b.surface);
      b.scene.updateMatrixWorld(true);
      // The gizmo IS under the surface node. Until plan-655 F7 it stood upright
      // on this Z-up body and lifted a naive subtree box (surfaceHeight 0.9837
      // live); since F7 it lies flat on the top face, so even a naive box stays
      // at the belt top (the arrow sits a hair above it)…
      expect(view(b.surface)._selArrow).not.toBeNull();
      expect(computeSubtreeAABB(b.node, new Box3()).box.max.y).toBeLessThan(0.76);
      // …and the planner's surface top and centre ignore the overlay anyway.
      const top = transportSurfaceTop(b.placement);
      expect(top.source).toBe('TransportSurface');
      expect(Math.abs(top.y - 0.75)).toBeLessThan(TOL);
      expect(top.x).toBeCloseTo(before.x, 4);
      expect(top.z).toBeCloseTo(before.z, 4);
      b.surface.dispose();
    });
  }
});
