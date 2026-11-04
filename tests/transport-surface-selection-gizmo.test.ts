// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-655 F7 — TransportSurface selection gizmo: "up" from the world, radial
 * surfaces as a ring sector with an arc arrow in the transport direction.
 */
import { describe, it, expect } from 'vitest';
import {
  Box3, BoxGeometry, BufferGeometry, Float32BufferAttribute, LineSegments, Mesh, Object3D,
  Quaternion, RingGeometry, Vector3,
} from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { buildArcArrowGeometry, canonicalAngle, gizmoBasis, radialSector } from '../src/core/engine/rv-transport-gizmo-geometry';

interface GizmoView {
  _selGizmoMgr: unknown;
  _selTopSurface: LineSegments | null;
  _selArrow: Mesh | null;
  _showSelectionGizmo(): void;
  _hideSelectionGizmo(): void;
}
const view = (s: RVTransportSurface): GizmoView => s as unknown as GizmoView;

function surfaceOn(node: Object3D, dir: Vector3, radial = false, speed = 0, target = 100): RVTransportSurface {
  node.updateMatrixWorld(true);
  const s = new RVTransportSurface(node, AABB.fromHalfSize(node, new Vector3(0.5, 0.05, 0.5)));
  s.TransportDirection.copy(dir);
  s.Radial = radial;
  s.reapplyConfig();
  s.initTransport();
  s.drive = { currentSpeed: speed, TargetSpeed: target, name: 'd' } as never;
  view(s)._selGizmoMgr = {}; // non-null: the gizmo only needs the manager to exist
  return s;
}

function worldBox(o: Object3D): Box3 {
  o.updateMatrixWorld(true);
  return new Box3().setFromObject(o);
}

/** World-space vertices of an overlay mesh / line. */
function worldVerts(o: Mesh | LineSegments): Vector3[] {
  o.updateMatrixWorld(true);
  const pos = o.geometry.getAttribute('position');
  const out: Vector3[] = [];
  for (let i = 0; i < pos.count; i++) out.push(new Vector3().fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld));
  return out;
}

/** A quarter-ring mesh in the node's local frame: XZ plane (Y up) or XY plane (Z up). */
function quarterRingMesh(rIn: number, rOut: number, start: number, len: number, zUp: boolean, segs = 16): Mesh {
  const g = new BufferGeometry();
  const p: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = start + (len * i) / segs;
    for (const r of [rIn, rOut]) {
      const a = r * Math.cos(t);
      const b = r * Math.sin(t);
      if (zUp) p.push(a, b, 0); else p.push(a, 0, -b);
    }
  }
  g.setAttribute('position', new Float32BufferAttribute(p, 3));
  return new Mesh(g);
}

describe('plan-655 F7 — basis from world up', () => {
  it('Y-up node → identity frame (classic gizmo unchanged)', () => {
    const b = gizmoBasis(new Quaternion());
    expect(b.n.toArray()).toEqual([0, 1, 0]);
    expect(b.u.toArray()).toEqual([1, 0, 0]);
    expect(b.quat.equals(new Quaternion())).toBe(true);
  });

  it('Z-up node (SolidCraft, rotated −90° about X) → n = local +Z', () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
    const b = gizmoBasis(q);
    expect(b.n.toArray()).toEqual([0, 0, 1]);
  });
});

describe('plan-655 F7 — linear gizmo', () => {
  it('Y-up: outline at the top face, horizontal; arrow 0.5 m along the world transport direction', () => {
    const root = new Object3D();
    const node = new Object3D();
    root.add(node);
    node.add(new Mesh(new BoxGeometry(2, 0.1, 0.6)));
    const s = surfaceOn(node, new Vector3(1, 0, 0));
    view(s)._showSelectionGizmo();
    const outline = view(s)._selTopSurface!;
    const arrow = view(s)._selArrow!;
    expect(outline.position.x).toBe(0);
    expect(outline.position.y).toBeCloseTo(0.05, 6);
    expect(outline.position.z).toBe(0);
    expect(outline.quaternion.equals(new Quaternion())).toBe(true);
    const ob = worldBox(outline);
    expect(ob.max.y - ob.min.y).toBeLessThan(1e-6);
    expect(ob.max.x - ob.min.x).toBeCloseTo(2, 5);
    const ab = worldBox(arrow);
    // 0.5 m arrow (the rounded tip trims a few millimetres off the extent).
    expect(ab.max.x - ab.min.x).toBeGreaterThan(0.47);
    expect(ab.max.x - ab.min.x).toBeLessThanOrEqual(0.5 + 1e-6);
  });

  it('Z-up / mm (SolidCraft body): outline is horizontal in the world, arrow is 0.5 m', () => {
    const root = new Object3D();
    const node = new Object3D();
    node.scale.setScalar(0.001);
    node.rotation.x = -Math.PI / 2; // local Z → world Y
    root.add(node);
    node.add(new Mesh(new BoxGeometry(2000, 600, 100))); // x, y in the plane, z = height
    node.updateMatrixWorld(true);
    const s = surfaceOn(node, new Vector3(1, 0, 0));
    view(s)._showSelectionGizmo();
    const ob = worldBox(view(s)._selTopSurface!);
    expect(ob.max.y - ob.min.y).toBeLessThan(1e-6);
    expect(ob.max.y).toBeCloseTo(0.05, 6);       // top face (50 mm)
    expect(ob.max.x - ob.min.x).toBeCloseTo(2, 4);
    expect(ob.max.z - ob.min.z).toBeCloseTo(0.6, 4);
    const ab = worldBox(view(s)._selArrow!);
    expect(ab.max.x - ab.min.x).toBeGreaterThan(0.47);
    expect(ab.max.x - ab.min.x).toBeLessThanOrEqual(0.5 + 1e-6);
    expect(ab.max.y - ab.min.y).toBeLessThan(1e-3); // lies flat
  });
});

describe('plan-655 F7 — radial gizmo', () => {
  /** Angle of the arrow tip (the vertex at exactly rMid) seen around the node origin, world XZ. */
  function tipWorldAngle(s: RVTransportSurface, node: Object3D, rMid: number, scale = 1): number {
    const o = node.getWorldPosition(new Vector3());
    const verts = worldVerts(view(s)._selArrow!);
    const tip = verts.find((v) => Math.abs(Math.hypot(v.x - o.x, v.z - o.z) - rMid * scale) < 1e-4)!;
    expect(tip).toBeDefined();
    return Math.atan2(tip.z - o.z, tip.x - o.x);
  }

  it('90° sector (Y-up): ring sector 0..90° ± 1°, arc arrow points where the surface transports', () => {
    const node = new Object3D();
    node.add(quarterRingMesh(0.8, 1.42, 0, Math.PI / 2, false));
    const s = surfaceOn(node, new Vector3(0, 1, 0), true, 0, 100);
    view(s)._showSelectionGizmo();
    const outline = view(s)._selTopSurface!;
    expect(outline.geometry.type).toBe('EdgesGeometry');
    const verts = worldVerts(outline);
    const angles = verts.map((v) => canonicalAngle(v.x, v.z) * 180 / Math.PI);
    expect(Math.min(...angles)).toBeGreaterThan(-1);
    expect(Math.max(...angles)).toBeLessThan(91);
    expect(Math.max(...angles)).toBeGreaterThan(89);
    // The surface moves a point at r around +Y by +angle for positive speed:
    // tangent = axis × r. Tip must lie on the side the motion goes.
    const mid = Math.PI / 4;
    const midPoint = new Vector3(1.1 * Math.cos(mid), 0, -1.1 * Math.sin(mid));
    const tangent = new Vector3(0, 1, 0).cross(midPoint).normalize();
    const tipA = tipWorldAngle(s, node, 1.11);
    const tipPoint = new Vector3(Math.cos(tipA), 0, Math.sin(tipA));
    expect(tipPoint.dot(tangent)).toBeGreaterThan(0.1);
  });

  it('negative speed / negative axis reverse the arc arrow', () => {
    const mk = (axisY: number, target: number): number => {
      const node = new Object3D();
      node.add(quarterRingMesh(0.8, 1.42, 0, Math.PI / 2, false));
      const s = surfaceOn(node, new Vector3(0, axisY, 0), true, 0, target);
      view(s)._showSelectionGizmo();
      return tipWorldAngle(s, node, 1.11);
    };
    const a = mk(1, 100);
    expect(mk(1, -100)).not.toBeCloseTo(a, 2);
    expect(mk(-1, 100)).toBeCloseTo(mk(1, -100), 5);
  });

  it('wraps across 0° (sector −45..45°)', () => {
    const r = radialSector(Array.from({ length: 19 }, (_, i) => {
      const t = (-45 + 5 * i) * Math.PI / 180;
      return [Math.cos(t), -Math.sin(t)] as [number, number];
    }));
    expect(r!.full).toBe(false);
    expect(r!.thetaLength * 180 / Math.PI).toBeCloseTo(90, 3);
    expect(r!.thetaStart * 180 / Math.PI).toBeCloseTo(-45, 3);
  });

  it('a coarse full ring (32 segments) is a ring; a real 90° sector is not (SOL R2-2)', () => {
    const ring = radialSector(Array.from({ length: 32 }, (_, i) => {
      const t = (i * 2 * Math.PI) / 32;
      return [Math.cos(t), Math.sin(t)] as [number, number];
    }));
    expect(ring!.full).toBe(true);
    const sector = radialSector(Array.from({ length: 9 }, (_, i) => {
      const t = (i * Math.PI) / 16;
      return [Math.cos(t), Math.sin(t)] as [number, number];
    }));
    expect(sector!.full).toBe(false);
  });

  it('Z-up / mm curve: the sector lies flat in the world', () => {
    const node = new Object3D();
    node.scale.setScalar(0.001);
    node.rotation.x = -Math.PI / 2;
    node.add(quarterRingMesh(800, 1420, 0, Math.PI / 2, true));
    node.updateMatrixWorld(true);
    const s = surfaceOn(node, new Vector3(0, 0, 1), true, 0, 100);
    view(s)._showSelectionGizmo();
    const ob = worldBox(view(s)._selTopSurface!);
    expect(ob.max.y - ob.min.y).toBeLessThan(1e-6);
    expect(Math.max(ob.max.x - ob.min.x, ob.max.z - ob.min.z)).toBeCloseTo(1.42, 2);
  });

  it('a nested surface below a radial surface does not widen its sector', () => {
    const node = new Object3D();
    node.name = 'Curve';
    node.add(quarterRingMesh(0.8, 1.42, 0, Math.PI / 2, false));
    const nested = new Object3D();
    nested.name = 'Nested';
    nested.add(quarterRingMesh(0.2, 0.5, 0, 2 * Math.PI, false, 32)); // a full turntable ring
    node.add(nested);
    const s = surfaceOn(node, new Vector3(0, 1, 0), true);
    (s as unknown as { _selRegistry: unknown })._selRegistry = {
      getPathForNode: (n: Object3D) => n.name,
      getByPath: (type: string, p: string) => (type === 'TransportSurface' && p === 'Nested' ? {} : null),
    };
    view(s)._showSelectionGizmo();
    const angles = worldVerts(view(s)._selTopSurface!).map((v) => canonicalAngle(v.x, v.z) * 180 / Math.PI);
    expect(Math.max(...angles) - Math.min(...angles)).toBeLessThan(91);
  });

  it('repeated select / hide leaves no overlay behind', () => {
    const node = new Object3D();
    node.add(quarterRingMesh(0.8, 1.42, 0, Math.PI / 2, false));
    const s = surfaceOn(node, new Vector3(0, 1, 0), true);
    const before = node.children.length;
    for (let i = 0; i < 3; i++) view(s)._showSelectionGizmo();
    expect(node.children.length).toBe(before + 2);
    view(s)._hideSelectionGizmo();
    expect(node.children.length).toBe(before);
    expect(view(s)._selArrow).toBeNull();
  });

  it('buildArcArrowGeometry puts its tip at thetaTo on rMid', () => {
    const g = buildArcArrowGeometry(1, 0.05, 0.12, 0, Math.PI / 2);
    const pos = g.getAttribute('position');
    let found = false;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i); const z = pos.getZ(i);
      if (Math.abs(Math.hypot(x, z) - 1) < 1e-6 && Math.abs(canonicalAngle(x, z) - Math.PI / 2) < 1e-6) found = true;
    }
    expect(found).toBe(true);
    void RingGeometry;
  });
});
