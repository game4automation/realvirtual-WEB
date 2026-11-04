// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2016 Phase 3, test 9.3 — `TransportGuided` (port of Unity TransportGuided +
 * GuideCircle/GuideLine).
 *
 * Loaded through the shipping bake (`loadBakedGLB`) with real Drives and Unity-
 * convention extras, like the blow-moulding line's inlet curve (R = 1.27 m, Angle = -90°):
 *
 *   Cell (web coordinates, Y up)
 *    ├─ Part1  TransportSurface + Drive  x ∈ [0, 1], carries towards -X (Unity +X)
 *    ├─ Curve  TransportGuided + Drive(Virtual) at the origin, start tangent -X
 *    │         Unity centre (0,0,-sign(Angle)·R) = (0,0,+R) → web (0,0,+R) (X mirrored)
 *    │         end point web (-R, 0, +R), end tangent +Z
 *    ├─ Part3  TransportSurface + Drive  x = -R, z ∈ [R, R+1], carries towards +Z
 *    ├─ Part   MU template (far below)
 *    └─ Src    Source { ThisObjectAsMU: Part }
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Box3, BoxGeometry, Mesh, MeshBasicMaterial, Quaternion, Scene, Vector3 } from 'three';
import { loadBakedGLB } from './helpers/load-baked-glb';
import { clearAllProblems } from '../src/core/hmi/problems-store';
import { node, sceneToGlb } from './helpers/migrate-769-fixtures';
import { RVTransportGuided } from '../src/core/engine/rv-transport-guided';
import { isKnownComponentType } from '../src/core/engine/rv-extras-validator';
import type { RVMovingUnit, InstancedMovingUnit } from '../src/core/engine/rv-mu';
import type { RVTransportManager } from '../src/core/engine/rv-transport-manager';

const R = 1.27;
const V = 250; // mm/s
const DT = 1 / 60;

interface Opts {
  /** Uniform scale of the Curve node (scaled placement). */
  curveScale?: number;
  part1?: boolean;
  part3?: boolean;
  circular?: boolean;
  srcAt?: [number, number, number];
}

function belt(name: string, size: [number, number, number], center: [number, number, number], unityDir: { x: number; y: number; z: number }): Mesh {
  const m = new Mesh(new BoxGeometry(...size), new MeshBasicMaterial());
  m.name = name;
  m.position.set(...center);
  m.userData.realvirtual = {
    TransportSurface: { TransportDirection: unityDir, AnimateSurface: false },
    Drive: { Direction: 'LinearX', TargetSpeed: V, JogForward: true },
  };
  return m;
}

async function build(o: Opts): Promise<ArrayBuffer> {
  const scene = new Scene();
  scene.name = 'Cell';
  if (o.part1 !== false) scene.add(belt('Part1', [1, 0.05, 0.5], [0.5, -0.025, 0], { x: 1, y: 0, z: 0 }));
  const curve = node('Curve', {
    Drive: { Direction: 'Virtual', TargetSpeed: V, JogForward: true },
    TransportGuided: {
      Circular: o.circular ?? true, Length: 1, Radius: R, Angle: -90, Height: 0.2, Width: 0.5,
      ColliderBorderX: 0.2, ColliderBorderZ: 0.3, DistanceCollider: 0.005,
      UseStandardLayer: true, ShowGizmos: true,
    },
  });
  if (o.curveScale) curve.scale.setScalar(o.curveScale);
  scene.add(curve);
  if (o.part3 !== false) {
    if (o.circular === false) scene.add(belt('Part3', [1, 0.05, 0.5], [-1.5, -0.025, 0], { x: 1, y: 0, z: 0 }));
    else scene.add(belt('Part3', [0.5, 0.05, 1], [-R, -0.025, R + 0.5], { x: 0, y: 0, z: 1 }));
  }
  const part = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial());
  part.name = 'Part';
  part.position.set(5, -5, 5);
  part.userData.realvirtual = { MU: {}, GuidedMU: { RaycastLength: 0.5, DebugMode: true } };
  scene.add(part);
  const src = node('Src', { Source: { ThisObjectAsMU: 'Part', AutomaticGeneration: false, GenerateMU: true } });
  src.position.set(...(o.srcAt ?? [0.6, 0.05, 0]));
  scene.add(src);
  return sceneToGlb(scene);
}

type MU = RVMovingUnit | InstancedMovingUnit;

async function load(o: Opts) {
  const result = await loadBakedGLB('transport-guided.glb', new Scene(), { data: (await build(o)).slice(0), loadKinematicsSidecar: false });
  const tmgr = result.transportManager as RVTransportManager;
  const curve = tmgr.surfaces.find((s) => s.node.name === 'Curve') as RVTransportGuided;
  // One fixed step = drives, then transport (the viewer's tick order).
  const step = { surfaces: tmgr.surfaces, update(dt: number) { for (const d of result.drives) d.update(dt); tmgr.update(dt); } };
  step.update(DT);
  const mu = tmgr.mus[0] as MU;
  return { result, tm: step, curve, mu };
}

function worldPos(mu: MU): Vector3 {
  if (mu.isInstanced) return mu.getPosition().clone();
  const n = (mu as RVMovingUnit).node;
  n.updateWorldMatrix(true, false);
  return n.getWorldPosition(new Vector3());
}
function worldQuat(mu: MU): Quaternion {
  if (mu.isInstanced) return mu.getQuaternion().clone();
  const n = (mu as RVMovingUnit).node;
  n.updateWorldMatrix(true, false);
  return n.getWorldQuaternion(new Quaternion());
}
/** Puts an MU at a world position. */
function teleport(mu: MU, p: Vector3): void {
  if (mu.isInstanced) { mu.setPosition(p); mu.updateAABB(); return; }
  const n = (mu as RVMovingUnit).node;
  const q = p.clone();
  n.parent?.updateWorldMatrix(true, false);
  if (n.parent) n.parent.worldToLocal(q);
  mu.setPosition(q);
  n.updateMatrixWorld(true);
  mu.updateAABB();
}
/** Yaw of the MU's +Z axis in the XZ plane (rad, +Y rotation positive). */
function yaw(mu: MU): number {
  const f = new Vector3(0, 0, 1).applyQuaternion(worldQuat(mu));
  return Math.atan2(-f.z, f.x);
}
const centre = new Vector3(0, 0, R); // web centre for Angle = -90
const radius = (p: Vector3) => Math.hypot(p.x - centre.x, p.z - centre.z);
/** Guide angle along the arc (rad) for Angle = -90 in web coordinates. */
const phiOf = (p: Vector3) => Math.atan2(-p.x, -(p.z - R));

afterEach(() => clearAllProblems());

describe('plan-2016 Phase 3 — TransportGuided', () => {
  it('is a known, registered transport surface; GuidedMU / GuideCircle are known markers', async () => {
    const { tm, curve } = await load({ part1: false, srcAt: [0, 0.05, 0] });
    expect(curve).toBeInstanceOf(RVTransportGuided);
    expect(tm.surfaces).toContain(curve);
    expect(curve.Circular).toBe(true);
    expect(curve.Radius).toBeCloseTo(R, 6);
    expect(curve.Angle).toBe(-90);
    expect(curve.drive, 'the Drive on the same node feeds the speed').toBeTruthy();
    expect(curve.speed).toBeCloseTo(V, 6);
    for (const t of ['TransportGuided', 'GuidedMU', 'GuideCircle', 'GuideLine']) expect(isKnownComponentType(t), t).toBe(true);
    // Contact box = Unity's generated collider (x mirrored): x ∈ [-(R+0.2), 0], z ∈ [-0.3, R], y ∈ [-0.2, 0].
    curve.updateAABB();
    expect(curve.aabb.min.x).toBeCloseTo(-(R + 0.2), 4);
    expect(curve.aabb.max.x).toBeCloseTo(0, 4);
    expect(curve.aabb.min.z).toBeCloseTo(-0.3, 4);
    expect(curve.aabb.max.z).toBeCloseTo(R, 4);
    expect(curve.aabb.max.y).toBeCloseTo(0, 4);
    expect(curve.aabb.min.y).toBeCloseTo(-0.2, 4);
  });

  it('centre and turning sense follow Unity (GuideCircle:89) with X mirrored', () => {
    const g = new RVTransportGuided(node('G'), { useNodeLocalFrame() { return this; } } as never);
    g.Circular = true; g.Radius = R; g.Angle = -90;
    const p = new Vector3();
    expect(g.pointAt(0, p).length()).toBeLessThan(1e-12);
    g.pointAt(Math.PI / 2, p);
    expect(p.x).toBeCloseTo(-R, 9); // Unity (+R, 0, +R) → web (-R, 0, +R)
    expect(p.z).toBeCloseTo(R, 9);
    const t = g.tangentAt(Math.PI / 2, new Vector3());
    expect(t.x).toBeCloseTo(0, 9);
    expect(t.z).toBeCloseTo(1, 9);
    // Positive angle bends the other way: centre (0, 0, -R), end (-R, 0, -R).
    g.Angle = 90;
    g.pointAt(Math.PI / 2, p);
    expect(p.x).toBeCloseTo(-R, 9);
    expect(p.z).toBeCloseTo(-R, 9);
  });

  it('runs the arc with the linear Drive speed: start → end in arc length / v (±2 mm, ±1 frame), on the radius', async () => {
    const { tm, curve, mu } = await load({ part1: false, srcAt: [0, 0.05, 0] });
    teleport(mu, new Vector3(0, 0.05, 0));
    const arc = R * Math.PI / 2;
    const ticks = Math.round(arc / (V / 1000) / DT); // 7.98 s → 479 ticks
    let maxRadiusErr = 0;
    let atEndTick = -1;
    for (let i = 1; i <= ticks + 3; i++) {
      tm.update(DT);
      const p = worldPos(mu);
      if (mu.currentSurface === curve && phiOf(p) < Math.PI / 2 - 1e-9) maxRadiusErr = Math.max(maxRadiusErr, Math.abs(radius(p) - R));
      if (atEndTick < 0 && phiOf(p) >= Math.PI / 2 - 1e-9) atEndTick = i;
      if (i === Math.round(ticks / 2)) {
        // Halfway: 45° along the arc, both web coordinates on the mirrored side.
        expect(phiOf(p)).toBeCloseTo(Math.PI / 4, 2);
        expect(p.x).toBeLessThan(0);
        expect(p.z).toBeGreaterThan(0);
      }
    }
    expect(maxRadiusErr).toBeLessThan(1e-4);
    expect(Math.abs(atEndTick - ticks)).toBeLessThanOrEqual(1);
  });

  it('advances exactly v·dt of arc length per tick and turns the MU with the tangent', async () => {
    const { tm, mu } = await load({ part1: false, srcAt: [0, 0.05, 0] });
    teleport(mu, new Vector3(0, 0.05, 0));
    tm.update(DT);
    const y0 = yaw(mu);
    const phi0 = phiOf(worldPos(mu));
    for (let i = 0; i < 120; i++) tm.update(DT);
    const phi1 = phiOf(worldPos(mu));
    expect((phi1 - phi0) * R).toBeCloseTo(120 * DT * V / 1000, 5);
    // The MU yaw turned by the same angle as the tangent (Angle < 0 → +Y rotation in web).
    let dy = yaw(mu) - y0;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    expect(dy).toBeCloseTo(phi1 - phi0, 4);
  });

  it('guides a laterally offset MU onto the radius (Unity GetClosestPoint)', async () => {
    const { tm, curve, mu } = await load({ part1: false, srcAt: [0, 0.05, 0] });
    // 30° along the arc but 0.12 m outside the radius.
    const phi = Math.PI / 6;
    const r = R + 0.12;
    teleport(mu, new Vector3(-r * Math.sin(phi), 0.05, R - r * Math.cos(phi)));
    tm.update(DT);
    expect(mu.currentSurface).toBe(curve);
    const p = worldPos(mu);
    expect(Math.abs(radius(p) - R)).toBeLessThan(1e-6);
    expect(phiOf(p)).toBeCloseTo(phi + (DT * V / 1000) / R, 6);
    expect(p.y).toBeCloseTo(0.05, 6); // height is kept
  });

  it('reverse drive runs the arc backwards', async () => {
    const { tm, curve, mu } = await load({ part1: false, srcAt: [0, 0.05, 0] });
    const phi = Math.PI / 4;
    teleport(mu, new Vector3(-R * Math.sin(phi), 0.05, R - R * Math.cos(phi)));
    curve.drive!.jogForward = false;
    curve.drive!.jogBackward = true;
    tm.update(DT); // drive picks up the backward jog
    const a = phiOf(worldPos(mu));
    for (let i = 0; i < 60; i++) tm.update(DT);
    const b = phiOf(worldPos(mu));
    expect(curve.speed).toBeCloseTo(-V, 6);
    expect(b).toBeLessThan(a);
    expect((a - b) * R).toBeCloseTo(60 * DT * V / 1000, 4);
    expect(Math.abs(radius(worldPos(mu)) - R)).toBeLessThan(1e-6);
  });

  it('hands over Part1 → Curve → Part3 and leaves the arc along the end tangent', async () => {
    const { tm, mu } = await load({});
    const yaw0 = yaw(mu);
    const owners: string[] = [];
    // Part1 (0.6 m) + arc (2.0 m) + 0.6 m on Part3 at 0.25 m/s ≈ 12.8 s.
    for (let i = 0; i < Math.round(13 / DT); i++) {
      tm.update(DT);
      const o = mu.currentSurface?.node.name ?? '-';
      if (owners[owners.length - 1] !== o) owners.push(o);
    }
    expect(owners).toEqual(['Part1', 'Curve', 'Part3']);
    const p = worldPos(mu);
    expect(p.x).toBeCloseTo(-R, 3); // on Part3's centre line (±0.5 mm)
    expect(p.z).toBeGreaterThan(R + 0.3);
    // Turned by 90° in total (from -X to +Z): +90° about +Y in web coordinates.
    let dy = yaw(mu) - yaw0;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    expect(dy).toBeCloseTo(Math.PI / 2, 3);
  });

  it('straight guide (!Circular): moves along local -X (Unity +X) at v and removes the lateral offset', async () => {
    const { tm, curve, mu } = await load({ part1: false, circular: false, srcAt: [0, 0.05, 0] });
    expect(curve.Circular).toBe(false);
    teleport(mu, new Vector3(-0.1, 0.05, 0.07));
    tm.update(DT);
    let p = worldPos(mu);
    expect(p.z).toBeCloseTo(0, 6);
    for (let i = 0; i < 120; i++) tm.update(DT);
    p = worldPos(mu);
    expect(p.x).toBeCloseTo(-0.1 - 121 * DT * V / 1000, 5);
    expect(p.z).toBeCloseTo(0, 6);
    curve.updateAABB();
    expect(curve.aabb.min.x).toBeCloseTo(-1, 4);
    expect(curve.aabb.max.x).toBeCloseTo(0, 4);
    expect(curve.aabb.max.z - curve.aabb.min.z).toBeCloseTo(0.5, 4);
  });

  it('scaled placement: the Drive speed stays a WORLD speed (no faster transport)', async () => {
    const { tm, mu } = await load({ part1: false, curveScale: 2, srcAt: [0, 0.05, 0] });
    teleport(mu, new Vector3(0, 0.05, 0));
    tm.update(DT);
    const Rw = 2 * R; // world radius; centre web (0, 0, +Rw)
    const phiW = (p: Vector3) => Math.atan2(-p.x, -(p.z - Rw));
    const a = phiW(worldPos(mu));
    for (let i = 0; i < 120; i++) tm.update(DT);
    const p = worldPos(mu);
    expect((phiW(p) - a) * Rw).toBeCloseTo(120 * DT * V / 1000, 4);
    expect(Math.hypot(p.x, p.z - Rw)).toBeCloseTo(Rw, 4);
  });

  it('reapplyConfig rebuilds the contact box and the chord after a parameter edit', async () => {
    const { curve } = await load({ part1: false, srcAt: [0, 0.05, 0] });
    curve.Radius = 2;
    curve.reapplyConfig();
    expect(curve.aabb.min.x).toBeCloseTo(-(2 + 0.2), 4);
    expect(curve.aabb.max.z).toBeCloseTo(2, 4);
    curve.Circular = false;
    curve.Length = 3;
    curve.reapplyConfig();
    expect(curve.aabb.min.x).toBeCloseTo(-3, 4);
    expect(curve.aabb.max.z - curve.aabb.min.z).toBeCloseTo(0.5, 4);
    expect(curve.getWorldDirection().x).toBeCloseTo(-1, 6);
  });

  it('arcs beyond 180 degrees are followed over the whole span (up to +-360)', () => {
    const g = new RVTransportGuided(node('G'), { useNodeLocalFrame() { return this; } } as never);
    g.Circular = true; g.Radius = 1; g.Angle = -270;
    const p = new Vector3();
    for (const deg of [30, 170, 200, 260]) {
      const phi = deg * Math.PI / 180;
      g.pointAt(phi, p);
      expect(g.closestAngle(p.x, p.z)).toBeCloseTo(phi, 9);
    }
    // Crossing 180 degrees at constant arc speed.
    g.pointAt(Math.PI - 0.05, p);
    const st = g.advanceLocal(p.x, p.z, 0.1);
    expect(st.phiTo).toBeCloseTo(Math.PI + 0.05, 9);
    // In the 270..360 gap a point snaps to the nearer end.
    g.pointAt(2 * Math.PI - 0.1, p);
    expect(g.closestAngle(p.x, p.z)).toBe(0);
    g.pointAt(1.5 * Math.PI + 0.1, p);
    expect(g.closestAngle(p.x, p.z)).toBeCloseTo(1.5 * Math.PI, 9);
    // The contact box covers the second half circle too.
    const box = (g as unknown as { computeContactLocalBox(): Box3 }).computeContactLocalBox();
    expect(box.max.x).toBeCloseTo(1 + g.ColliderBorderX, 9);
    expect(box.min.x).toBeCloseTo(-1 - g.ColliderBorderX, 9);
  });
});
