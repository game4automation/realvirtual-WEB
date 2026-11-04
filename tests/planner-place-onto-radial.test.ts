// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-675 §9.10 (D4) — `layout.place onto=<curve>` rests the part on the mid
 * radius at the middle of the arc, turned tangentially; a straight conveyor
 * puts it on the belt's centre line (not the placement's bounds centre).
 */
import { describe, it, expect } from 'vitest';
import { BoxGeometry, Group, Mesh, Object3D, RingGeometry, Vector3 } from 'three';
import { transportSurfaceTop } from '../src/plugins/layout-planner/planner-commands';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { AABB } from '../src/core/engine/rv-aabb';

const R_IN = 0.82, R_OUT = 1.44, R_MID = (R_IN + R_OUT) / 2, TOP = 0.75;

function curvePlacement(yawDeg: number, at = new Vector3(2, 0, -1)): { root: Group; surface: RVTransportSurface } {
  const root = new Group(); root.name = 'Curve';
  root.position.copy(at); root.rotation.y = yawDeg * Math.PI / 180;
  const node = new Object3D(); node.name = 'ConveyorSurface';
  node.position.y = TOP;
  node.userData.realvirtual = { TransportSurface: { Radial: true } };
  // Quarter annulus, canonical angle 0..−90° (+X towards +Z), belt top at the node plane.
  const ring = new RingGeometry(R_IN, R_OUT, 24, 1, -Math.PI / 2, Math.PI / 2);
  ring.rotateX(-Math.PI / 2);
  node.add(new Mesh(ring));
  root.add(node);
  // A side frame that sticks out, so the bounds centre is NOT the arc middle.
  const frame = new Mesh(new BoxGeometry(0.2, 0.8, 0.2)); frame.position.set(-0.6, 0.4, -0.6);
  root.add(frame);
  root.updateMatrixWorld(true);
  const s = new RVTransportSurface(node, AABB.fromNode(node));
  s.TransportDirection.set(0, 1, 0); s.Radial = true; s.reapplyConfig(); s.initTransport();
  return { root, surface: s };
}

describe('plan-675 §9.10 place onto a radial surface', () => {
  for (const yaw of [0, 90, -45]) {
    it(`curve placed at yaw ${yaw}°: point on r_mid at the arc middle, height = belt top, yaw tangential`, () => {
      const { root, surface } = curvePlacement(yaw);
      const r = transportSurfaceTop(root, (n) => (n === surface.node ? surface : null));
      expect(r.source).toBe('TransportSurface radial');
      const pivot = surface.node.getWorldPosition(new Vector3());
      const d = new Vector3(r.x - pivot.x, 0, r.z - pivot.z);
      expect(d.length()).toBeCloseTo(R_MID, 3);
      expect(r.y).toBeCloseTo(TOP, 3);
      // Arc middle: 45° between the two end radii (+X and +Z in the curve frame).
      const mid = new Vector3(Math.cos(Math.PI / 4), 0, Math.sin(Math.PI / 4)).applyAxisAngle(new Vector3(0, 1, 0), yaw * Math.PI / 180);
      expect(d.clone().normalize().dot(mid)).toBeCloseTo(1, 4);
      // The part's +X (after the yaw) is perpendicular to the radius.
      const x = new Vector3(1, 0, 0).applyAxisAngle(new Vector3(0, 1, 0), r.ry! * Math.PI / 180);
      expect(Math.abs(x.dot(d.normalize()))).toBeLessThan(1e-3);
    });
  }

  it('without a component lookup it falls back to the straight rule (no rotation)', () => {
    const { root } = curvePlacement(0);
    const r = transportSurfaceTop(root);
    expect(r.ry).toBeUndefined();
    expect(r.source).toBe('TransportSurface');
  });

  it('straight conveyor: centre line of the belt, not of the placement bounds', () => {
    const root = new Group();
    const belt = new Object3D(); belt.userData.realvirtual = { TransportSurface: {} };
    const m = new Mesh(new BoxGeometry(2, 0.02, 0.6)); m.position.set(1, 0.75, 0);
    belt.add(m); root.add(belt);
    const box = new Mesh(new BoxGeometry(0.4, 0.4, 0.4)); box.position.set(2.5, 0.2, 1); // drive box on one side
    root.add(box);
    const r = transportSurfaceTop(root);
    expect(r.x).toBeCloseTo(1, 4);
    expect(r.z).toBeCloseTo(0, 4);
    expect(r.y).toBeCloseTo(0.76, 4);
  });
});
