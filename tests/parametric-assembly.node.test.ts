// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * parametric-assembly.node.test.ts — plan-650 phase 3: the assembly core
 * (duplicate · stretch · bend · place, nodes, components). Covers plan §9.3,
 * §9.3b (bend, F18) and §9.3a (aluminium profile, A6 automated).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Path,
  Shape,
  Vector3,
} from 'three';
import {
  assemble,
  bendGeometry,
  collectParts,
  partHashEntries,
  stretchGeometry,
  AssemblyError,
} from '../src/core/engine/rv-parametric-assembly';
import type { BuildPlan } from '../src/core/engine/rv-parametric-generator';
import { computePartsHash } from '../src/core/engine/rv-parametric-hash';

// ─── helpers ──────────────────────────────────────────────────────────────

function tris(g: BufferGeometry): Vector3[][] {
  const pos = g.getAttribute('position');
  const idx = g.getIndex();
  const n = idx ? idx.count : pos.count;
  const out: Vector3[][] = [];
  for (let i = 0; i < n; i += 3) {
    out.push([0, 1, 2].map((j) => new Vector3().fromBufferAttribute(pos, idx ? idx.getX(i + j) : i + j)));
  }
  return out;
}

function faceNormal([a, b, c]: Vector3[]): Vector3 {
  return b.clone().sub(a).cross(c.clone().sub(a));
}

function volume(g: BufferGeometry): number {
  let v = 0;
  for (const [a, b, c] of tris(g)) v += a.dot(b.clone().cross(c)) / 6;
  return v;
}

function axisRange(g: BufferGeometry, k: 0 | 1 | 2): [number, number] {
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  return [bb.min.getComponent(k), bb.max.getComponent(k)];
}

/** Box spanning x ∈ [x0, x0 + len], centred in y/z. */
function boxAlongX(len: number, w: number, h: number, segs = 1, x0 = 0): BufferGeometry {
  return new BoxGeometry(len, w, h, segs, 1, 1).translate(x0 + len / 2, 0, 0);
}

/** 100 × 40 plate (x × y), 10 thick (z), with a Ø10 hole at x = 80. Closed, earcut caps. */
function plateWithHole(): BufferGeometry {
  const s = new Shape();
  s.moveTo(0, -20); s.lineTo(100, -20); s.lineTo(100, 20); s.lineTo(0, 20); s.lineTo(0, -20);
  const hole = new Path();
  hole.absarc(80, 0, 5, 0, Math.PI * 2, true);
  s.holes.push(hole);
  return new ExtrudeGeometry(s, { depth: 10, bevelEnabled: false, curveSegments: 32 });
}

function partsRoot(parts: Record<string, BufferGeometry>, colors: Record<string, number> = {}): Object3D {
  const root = new Group();
  root.name = '_Parts';
  for (const [name, geom] of Object.entries(parts)) {
    const part = new Group();
    part.name = name;
    const mesh = new Mesh(geom, new MeshStandardMaterial({ name: `${name}-mat`, color: colors[name] ?? 0x888888 }));
    mesh.name = `${name}-mesh`;
    part.add(mesh);
    root.add(part);
  }
  return root;
}

function plan(p: Partial<BuildPlan>): BuildPlan {
  return { instances: [], nodes: [], components: [], messages: [], ...p };
}

function meshesOf(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((o) => { if ((o as Mesh).isMesh) out.push(o as Mesh); });
  return out;
}

// ─── 9.3 stretch ──────────────────────────────────────────────────────────

describe('stretchGeometry (plane-cut shift)', () => {
  it('moves only vertices beyond the plane and lengthens the bounds by Δ', () => {
    const base = boxAlongX(100, 40, 40);
    const g = stretchGeometry(base, 'x', 50, 30);
    const before = base.getAttribute('position');
    const after = g.getAttribute('position');
    for (let i = 0; i < before.count; i++) {
      const x0 = before.getX(i);
      expect(after.getX(i)).toBe(x0 > 50 ? x0 + 30 : x0);
      expect(after.getY(i)).toBe(before.getY(i));
      expect(after.getZ(i)).toBe(before.getZ(i));
    }
    const [lo, hi] = axisRange(g, 0);
    expect(hi - lo).toBeCloseTo(130, 9);
    expect(base.getAttribute('position').getX(0)).not.toBe(Number.NaN); // base untouched (clone)
    expect(axisRange(base, 0)[1]).toBe(100);
  });

  it('volume = base + cross-section · Δ (triangulated box: diagonals cross the plane)', () => {
    const base = boxAlongX(100, 40, 40);
    expect(volume(stretchGeometry(base, 'x', 50, 30))).toBeCloseTo(100 * 40 * 40 + 40 * 40 * 30, 3);
  });

  it('keeps an end hole round (real profile part with earcut caps)', () => {
    const base = plateWithHole();
    const g = stretchGeometry(base, 'x', 50, 250);
    const pos = g.getAttribute('position');
    const hole: number[] = [];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      const r = Math.hypot(x - 330, y);
      if (r < 6) hole.push(r);
    }
    expect(hole.length).toBeGreaterThan(32);
    // Float32 positions at |x| ≈ 330 resolve ~3e-5 — the plan's ±1e-6 holds only in float64.
    for (const r of hole) expect(Math.abs(r - 5)).toBeLessThan(5e-5);
    expect(volume(g)).toBeCloseTo(volume(base) + 40 * 10 * 250, 1);
  });

  it('shortens down to just before the nearest moved vertex', () => {
    const base = boxAlongX(100, 40, 40);
    const g = stretchGeometry(base, 'x', 50, -49.5);
    expect(axisRange(g, 0)[1]).toBeCloseTo(50.5, 9);
    for (const t of tris(g)) expect(faceNormal(t).length()).toBeGreaterThan(0);
  });

  it('rejects shortening that reaches the nearest moved vertex', () => {
    const base = boxAlongX(100, 40, 40);
    try {
      stretchGeometry(base, 'x', 50, -50, 'Profile');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AssemblyError);
      expect((e as AssemblyError).code).toBe('stretch-plane-invalid');
      expect((e as AssemblyError).details.reason).toBe('shorten-overlap');
    }
  });

  it('rejects a plane that cuts an oblique face', () => {
    const base = new BoxGeometry(100, 40, 40).rotateZ(Math.PI / 6);
    try {
      stretchGeometry(base, 'x', 0, 10, 'Tilted');
      expect.unreachable();
    } catch (e) {
      expect((e as AssemblyError).code).toBe('stretch-plane-invalid');
      expect((e as AssemblyError).details.reason).toBe('crossing-triangle');
      expect(((e as AssemblyError).details.triangles as number[]).length).toBeGreaterThan(0);
    }
  });

  it('two stretches (x then y) leave no inverted triangle', () => {
    const base = new BoxGeometry(100, 60, 40, 2, 2, 2);
    const g = stretchGeometry(stretchGeometry(base, 'x', 0, 120), 'y', 0, 80);
    const t0 = tris(base), t1 = tris(g);
    expect(t1.length).toBe(t0.length);
    for (let i = 0; i < t0.length; i++) {
      const n0 = faceNormal(t0[i]), n1 = faceNormal(t1[i]);
      expect(n0.dot(n1)).toBeGreaterThan(0); // orientation (determinant sign) unchanged
    }
    expect(volume(g)).toBeCloseTo(220 * 140 * 40, 2);
  });
});

// ─── 9.3 assemble ─────────────────────────────────────────────────────────

describe('assemble (duplicate · stretch · place · nodes · components)', () => {
  const ML = 1000;
  const conveyorPlan = (ml: number): BuildPlan => {
    const n = Math.floor(ml / 100);
    return plan({
      instances: [
        { part: 'Profile', name: 'SideL', positionMm: [0, -220, 0], stretch: [{ axis: 'x', atMm: 50, byMm: ml - 100 }] },
        { part: 'Profile', name: 'SideR', positionMm: [0, 220, 0], stretch: [{ axis: 'x', atMm: 50, byMm: ml - 100 }] },
        ...Array.from({ length: n }, (_, i) => ({ part: 'Roller', positionMm: [50 + i * 100, 0, 30] as [number, number, number] })),
      ],
      nodes: [
        { name: 'Snap-X+-RM', positionMm: [ml, 0, 0] },
        { name: 'Snap-X--RM', positionMm: [0, 0, 0], rotationDeg: [0, 0, 180] },
        { name: 'Transport', positionMm: [ml / 2, 0, 50] },
      ],
      components: [{ node: 'Transport', type: 'TransportSurface', fields: { Radial: false } }],
    });
  };
  const root = (): Object3D => partsRoot({
    Profile: boxAlongX(100, 20, 60),
    Roller: new CylinderGeometry(25, 25, 420, 24),
  });

  it('rollers share ONE BufferGeometry; the stretched profile is derived once', () => {
    const parts = root();
    const res = assemble(parts, conveyorPlan(ML));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const baseRoller = (parts.getObjectByName('Roller-mesh') as Mesh).geometry;
    const rollers = res.root.children.filter((c) => c.name.startsWith('Roller_'));
    expect(rollers.length).toBe(10);
    for (const r of rollers) expect((r.children[0] as Mesh).geometry).toBe(baseRoller);
    const sideL = (res.root.getObjectByName('SideL')!.children[0] as Mesh).geometry;
    const sideR = (res.root.getObjectByName('SideR')!.children[0] as Mesh).geometry;
    expect(sideL).toBe(sideR); // same (part, stretch[]) → one derived geometry
    expect(res.ownedGeometries).toEqual([sideL]);
    expect(res.stats.derivedGeometries).toBe(1);
    expect(res.stats.distinctGeometries).toBe(2);
    expect(axisRange(sideL, 0)).toEqual([0, ML]);
  });

  it('places the snap node at the module end and the transport node at ML/2 (± 0.1 mm)', () => {
    for (const ml of [720, 2160, 4320]) {
      const res = assemble(root(), conveyorPlan(ml));
      if (!res.ok) throw new Error(res.error.message);
      const snap = res.root.getObjectByName('Snap-X+-RM')!;
      expect(Math.abs(snap.position.x - ml)).toBeLessThan(0.1);
      expect(Math.abs(res.root.getObjectByName('Transport')!.position.x - ml / 2)).toBeLessThan(0.1);
      const sideMesh = res.root.getObjectByName('SideL')!.children[0] as Mesh;
      expect(Math.abs(axisRange(sideMesh.geometry, 0)[1] - ml)).toBeLessThan(0.1);
    }
  });

  it('writes components as rv_extras on the named node', () => {
    const res = assemble(root(), conveyorPlan(ML));
    if (!res.ok) throw new Error(res.error.message);
    expect(res.root.getObjectByName('Transport')!.userData.realvirtual.TransportSurface).toEqual({ Radial: false });
  });

  it('copies the PartsRoot frame onto _Generated and scales plan mm by unitsPerMm', () => {
    const parts = partsRoot({ Profile: boxAlongX(100, 20, 60) });
    parts.rotation.x = -Math.PI / 2;
    parts.scale.setScalar(0.001);
    // Geometry under the part is in frame units (= mm here because the frame carries 0.001).
    const res = assemble(parts, plan({ instances: [{ part: 'Profile', positionMm: [10, 0, 0], stretch: [{ axis: 'x', atMm: 50, byMm: 900 }] }] }));
    if (!res.ok) throw new Error(res.error.message);
    expect(res.root.name).toBe('_Generated');
    expect(res.root.quaternion.equals(parts.quaternion)).toBe(true);
    expect(res.root.scale.x).toBe(0.001);
    const box = new Vector3();
    res.root.updateMatrixWorld(true);
    const m = meshesOf(res.root)[0];
    m.geometry.computeBoundingBox();
    m.geometry.boundingBox!.getSize(box);
    expect(box.x).toBeCloseTo(1000, 6);

    const scaled = partsRoot({ Profile: boxAlongX(0.1, 0.02, 0.06) }); // frame in metres
    const res2 = assemble(scaled, plan({ instances: [{ part: 'Profile', positionMm: [500, 0, 0], stretch: [{ axis: 'x', atMm: 50, byMm: 900 }] }] }), { unitsPerMm: 0.001 });
    if (!res2.ok) throw new Error(res2.error.message);
    const g2 = meshesOf(res2.root)[0];
    expect(axisRange(g2.geometry, 0)[1]).toBeCloseTo(1.0, 9);
    expect(g2.parent!.position.x).toBeCloseTo(0.5, 12);
  });

  it('is deterministic: the same plan gives bit-identical geometry', () => {
    const a = assemble(root(), conveyorPlan(1730));
    const b = assemble(root(), conveyorPlan(1730));
    if (!a.ok || !b.ok) throw new Error('assembly failed');
    const pa = a.ownedGeometries[0].getAttribute('position').array;
    const pb = b.ownedGeometries[0].getAttribute('position').array;
    expect(Array.from(pa)).toEqual(Array.from(pb));
  });

  it('reports errors instead of throwing (unknown part/node, duplicates, components, vertex budget)', () => {
    const cases: [BuildPlan, string, object?][] = [
      [plan({ instances: [{ part: 'Nope', positionMm: [0, 0, 0] }] }), 'unknown-part'],
      [plan({ instances: [{ part: 'Roller', name: 'A', positionMm: [0, 0, 0] }], nodes: [{ name: 'A', positionMm: [0, 0, 0] }] }), 'duplicate-name'],
      [plan({ components: [{ node: 'Ghost', type: 'TransportSurface', fields: {} }] }), 'unknown-node'],
      [plan({ nodes: [{ name: 'T', positionMm: [0, 0, 0] }], components: [{ node: 'T', type: 'NoSuchType', fields: {} }] }), 'component-invalid'],
      [plan({ nodes: [{ name: 'T', positionMm: [0, 0, 0] }], components: [{ node: 'T', type: 'TransportSurface', fields: { Bogus: 1 } }] }), 'component-invalid'],
      [plan({ nodes: [{ name: 'T', positionMm: [0, 0, 0] }], components: [{ node: 'T', type: 'PLCOutputBool', fields: {} }] }), 'component-invalid'],
      [plan({ nodes: [{ name: 'T', positionMm: [0, 0, 0] }], components: [{ node: 'T', type: 'ParametricComponent', fields: {} }] }), 'component-invalid'],
      [plan({ instances: [{ part: 'Roller', positionMm: [0, 0, 0] }, { part: 'Roller', positionMm: [0, 0, 0] }] }), 'limit-vertices', { maxVertices: 150 }],
      [plan({ instances: [{ part: 'Profile', positionMm: [0, 0, 0], stretch: [{ axis: 'x', atMm: 50, byMm: -60 }] }] }), 'stretch-plane-invalid'],
    ];
    for (const [p, code, opts] of cases) {
      const res = assemble(root(), p, opts);
      expect(res.ok, code).toBe(false);
      if (!res.ok) expect(res.error.code).toBe(code);
    }
  });

  it('rejects a signal-slot field of a known component type (plan-650 §2.5)', () => {
    const res = assemble(root(), plan({
      nodes: [{ name: 'D', positionMm: [0, 0, 0] }],
      components: [{ node: 'D', type: 'Drive_Simple', fields: { Forward: { type: 'ComponentReference', path: 'X' } } }],
    }));
    expect(!res.ok && res.error.code).toBe('component-invalid');
    expect(!res.ok && res.error.message).toMatch(/signal slot/);
  });
});

// ─── parts + PartsHash rows ───────────────────────────────────────────────

describe('collectParts / partHashEntries', () => {
  it('reports bounds in the part frame and vertex counts', () => {
    const parts = collectParts(partsRoot({ Profile: boxAlongX(100, 20, 60) }));
    expect(parts.map((p) => p.name)).toEqual(['Profile']);
    expect(parts[0].info.boundsMm).toEqual({ min: [0, -10, -30], max: [100, 10, 30] });
    expect(parts[0].info.vertexCount).toBe(24);
  });

  it('moving, recolouring or renaming a part changes PartsHash', async () => {
    const make = (): Object3D => partsRoot({ Profile: boxAlongX(100, 20, 60), Roller: new CylinderGeometry(25, 25, 420, 8) }, { Roller: 0x111111 });
    const hash = async (r: Object3D): Promise<string> => computePartsHash(await partHashEntries(collectParts(r)));
    const h0 = await hash(make());
    expect(await hash(make())).toBe(h0);
    const moved = make(); moved.getObjectByName('Roller')!.position.x = 1;
    expect(await hash(moved)).not.toBe(h0);
    const recol = make(); ((recol.getObjectByName('Roller-mesh') as Mesh).material as MeshStandardMaterial).color = new Color(0xffff00);
    expect(await hash(recol)).not.toBe(h0);
    const renamed = make(); renamed.getObjectByName('Roller')!.name = 'Roll';
    expect(await hash(renamed)).not.toBe(h0);
  });

  it('rejects duplicate part names', () => {
    const r = partsRoot({ A: boxAlongX(1, 1, 1) });
    const dup = r.children[0].clone(); r.add(dup);
    expect(() => collectParts(r)).toThrow(/duplicate/);
  });
});

// ─── 9.3b bend (F18) ──────────────────────────────────────────────────────

describe('bendGeometry (F18)', () => {
  const R = 500, W = 40, H = 30;
  const L = (Math.PI * R) / 2;

  /** Normals of all triangles whose three vertices have |x| < eps (start face) — before bending. */
  function faceNormals(g: BufferGeometry, pick: (v: Vector3) => boolean): Vector3[] {
    const out: Vector3[] = [];
    for (const t of tris(g)) if (t.every(pick)) out.push(faceNormal(t).normalize());
    return out;
  }

  it('bends a straight box of length πR/2 by 90°: end faces perpendicular, radii exact, no inversion', () => {
    const base = boxAlongX(L, W, H, 2);
    const g = bendGeometry(base, { axis: 'x', radiusMm: R, centerSide: '+' });
    // Centre of the arc at (0, R). Every vertex lies between the inner and outer radius.
    const pos = g.getAttribute('position');
    let rmin = Infinity, rmax = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i) - R);
      rmin = Math.min(rmin, r); rmax = Math.max(rmax, r);
    }
    expect(rmin).toBeCloseTo(R - W / 2, 3);
    expect(rmax).toBeCloseTo(R + W / 2, 3);
    // Cross-section (z) unchanged.
    expect(axisRange(g, 2)).toEqual([-H / 2, H / 2]);
    // Start face stays at x = 0 with normal −x; end face (θ = 90°) is perpendicular to it.
    const start = faceNormals(g, (v) => Math.abs(v.x) < 1e-4 && Math.abs(v.y) <= W / 2 + 1e-4);
    const end = faceNormals(g, (v) => Math.abs(v.y - R) < 1e-3);
    expect(start.length).toBeGreaterThan(0);
    expect(end.length).toBeGreaterThan(0);
    for (const s of start) for (const e of end) expect(Math.abs(s.dot(e))).toBeLessThan(1e-6);
    // No inverted triangles: geometric face normal agrees with the transformed vertex normals.
    const nrm = g.getAttribute('normal');
    for (let i = 0; i < pos.count; i += 3) {
      const t = [0, 1, 2].map((j) => new Vector3().fromBufferAttribute(pos, i + j));
      const fn = faceNormal(t);
      if (fn.length() < 1e-9) continue;
      const vn = new Vector3().fromBufferAttribute(nrm, i).add(new Vector3().fromBufferAttribute(nrm, i + 1)).add(new Vector3().fromBufferAttribute(nrm, i + 2));
      expect(fn.dot(vn)).toBeGreaterThan(0);
    }
    // Closed solid keeps a positive volume = (π/4)·((R+W/2)² − (R−W/2)²)·H (segment chords → slightly less).
    const exact = (Math.PI / 4) * ((R + W / 2) ** 2 - (R - W / 2) ** 2) * H;
    const v = volume(g);
    expect(v).toBeGreaterThan(0);
    expect(Math.abs(v - exact) / exact).toBeLessThan(1e-3);
  });

  it("centerSide '-' bends towards −transverse", () => {
    const g = bendGeometry(boxAlongX(L, W, H, 1), { axis: 'x', radiusMm: R, centerSide: '-' });
    const [ylo] = axisRange(g, 1);
    expect(ylo).toBeCloseTo(-R, 2); // the 90° end face lies on y = −R
  });

  it("pivot 'center' puts the arc centre at the origin, same shape (plan-650 Phase 6)", () => {
    for (const centerSide of ['+', '-'] as const) {
      const start = bendGeometry(boxAlongX(L, W, H, 1), { axis: 'x', radiusMm: R, centerSide });
      const center = bendGeometry(boxAlongX(L, W, H, 1), { axis: 'x', radiusMm: R, centerSide, pivot: 'center' });
      const ps = start.getAttribute('position');
      const pc = center.getAttribute('position');
      expect(pc.count).toBe(ps.count);
      const shift = centerSide === '+' ? R : -R;
      for (let i = 0; i < pc.count; i++) {
        expect(pc.getX(i)).toBeCloseTo(ps.getX(i), 6);
        expect(pc.getY(i)).toBeCloseTo(ps.getY(i) - shift, 3);
        const r = Math.hypot(pc.getX(i), pc.getY(i));
        expect(r).toBeGreaterThan(R - W / 2 - 1e-3);
        expect(r).toBeLessThan(R + W / 2 + 1e-3);
      }
    }
  });

  it('refines a coarse base (2 segments) to ≤ 2° per segment', () => {
    const g = bendGeometry(boxAlongX(L, W, H, 2), { axis: 'x', radiusMm: R, centerSide: '+' });
    const pos = g.getAttribute('position');
    const maxSpan = (2 * Math.PI) / 180 + 1e-9;
    for (let i = 0; i < pos.count; i += 3) {
      const ang = [0, 1, 2].map((j) => Math.atan2(pos.getX(i + j), R - pos.getY(i + j)));
      expect(Math.max(...ang) - Math.min(...ang)).toBeLessThanOrEqual(maxSpan);
    }
    // 90° / 2° = 45 slabs: the side walls alone need ≥ 45 × 2 triangles each.
    expect(pos.count / 3).toBeGreaterThanOrEqual(45 * 2 * 4);
  });

  it('stretch then bend on one instance; identical input → bit-identical geometry', () => {
    const p = (): Object3D => partsRoot({ Rail: boxAlongX(100, W, H, 1) });
    const planBent = plan({ instances: [{ part: 'Rail', positionMm: [0, 0, 0], stretch: [{ axis: 'x', atMm: 50, byMm: L - 100 }], bend: { axis: 'x', radiusMm: R, centerSide: '+' } }] });
    const a = assemble(p(), planBent);
    const b = assemble(p(), planBent);
    if (!a.ok || !b.ok) throw new Error('assembly failed');
    const ga = meshesOf(a.root)[0].geometry, gb = meshesOf(b.root)[0].geometry;
    expect(Array.from(ga.getAttribute('position').array)).toEqual(Array.from(gb.getAttribute('position').array));
    // Same as doing it by hand in the documented order.
    const manual = bendGeometry(stretchGeometry(boxAlongX(100, W, H, 1), 'x', 50, L - 100), { axis: 'x', radiusMm: R, centerSide: '+' });
    expect(Array.from(ga.getAttribute('position').array)).toEqual(Array.from(manual.getAttribute('position').array));
    // The stretched length became the 90° arc.
    const [ylo, yhi] = axisRange(ga, 1);
    expect(ylo).toBeCloseTo(-W / 2, 3);
    expect(yhi).toBeCloseTo(R, 2); // the 90° end face lies on y = R
  });

  it('rejects a radius inside the part and a refinement over the vertex budget', () => {
    expect(() => bendGeometry(boxAlongX(L, W, H), { axis: 'x', radiusMm: 10, centerSide: '+' })).toThrow(AssemblyError);
    const res = assemble(partsRoot({ Rail: boxAlongX(L, W, H) }), plan({ instances: [{ part: 'Rail', positionMm: [0, 0, 0], bend: { axis: 'x', radiusMm: R, centerSide: '+' } }] }), { maxVertices: 100 });
    expect(!res.ok && res.error.code).toBe('limit-vertices');
  });
});

// ─── 9.3a aluminium profile (A6) ──────────────────────────────────────────

describe('aluminium profile family (A6)', () => {
  /** 40 × 40 profile with a 8 mm groove in each side, extruded 100 mm along z. */
  function profile(): BufferGeometry {
    const s = new Shape();
    const pts: [number, number][] = [
      [-20, -20], [-4, -20], [-4, -16], [4, -16], [4, -20], [20, -20],
      [20, -4], [16, -4], [16, 4], [20, 4], [20, 20],
      [4, 20], [4, 16], [-4, 16], [-4, 20], [-20, 20],
      [-20, 4], [-16, 4], [-16, -4], [-20, -4],
    ];
    s.moveTo(...pts[0]);
    for (const p of pts.slice(1)) s.lineTo(...p);
    s.closePath();
    return new ExtrudeGeometry(s, { depth: 100, bevelEnabled: false });
  }
  // Rule: one stretch along z at 25 mm (plane near the start) → shortening must stay below 75 mm.
  const rule = (L: number): BuildPlan => plan({ instances: [{ part: 'Alu', positionMm: [0, 0, 0], stretch: [{ axis: 'z', atMm: 25, byMm: L - 100 }] }] });

  function section(g: BufferGeometry, z: number): string[] {
    const pos = g.getAttribute('position');
    const set = new Set<string>();
    for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getZ(i) - z) < 1e-6) set.add(`${pos.getX(i).toFixed(6)},${pos.getY(i).toFixed(6)}`);
    return [...set].sort();
  }

  for (const L of [50, 6000]) {
    it(`L = ${L}: exact length, groove section unchanged at both ends`, () => {
      const base = profile();
      const res = assemble(partsRoot({ Alu: base }), rule(L));
      if (!res.ok) throw new Error(res.error.message);
      const g = meshesOf(res.root)[0].geometry;
      const [lo, hi] = axisRange(g, 2);
      expect(lo).toBe(0);
      expect(hi).toBeCloseTo(L, 9);
      const ref = section(base, 0);
      expect(ref.length).toBe(20);
      expect(section(g, 0)).toEqual(ref);
      expect(section(g, hi)).toEqual(ref);
    });
  }
});


describe('parent', () => {
  const root = (): Object3D => partsRoot({ Axis: boxAlongX(100, 20, 20) });
  const chain = (hops: number): BuildPlan['nodes'] => Array.from({ length: hops + 1 }, (_, i) => ({
    name: `N${i}`, positionMm: [10, 0, 0] as [number, number, number], ...(i ? { parent: `N${i - 1}` } : {}),
  }));

  it('assembles a reverse-listed four-axis chain and components on child nodes', () => {
    const instances: BuildPlan['instances'] = Array.from({ length: 4 }, (_, i) => ({
      part: 'Axis', name: `Axis${i}`, positionMm: [10, 20, 30] as [number, number, number], ...(i ? { parent: `Axis${i - 1}` } : {}),
    })).reverse();
    const res = assemble(root(), plan({ instances, nodes: [{ name: 'Tip', parent: 'Axis3', positionMm: [5, 0, 0] }],
      components: [{ node: 'Tip', type: 'TransportSurface', fields: { Radial: false } }],
    }));
    if (!res.ok) throw new Error(res.error.message);
    expect(res.root.children.map(o => o.name)).toEqual(['Axis0']);
    for (let i = 1; i < 4; i++) {
      const child = res.root.getObjectByName(`Axis${i}`)!;
      const parent = res.root.getObjectByName(`Axis${i - 1}`)!;
      expect(child.parent).toBe(parent);
      expect(child.position.toArray()).toEqual([10, 20, 30]);
      const expected = child.position.clone().applyMatrix4(parent.matrixWorld);
      expect(child.getWorldPosition(new Vector3()).distanceTo(expected)).toBeLessThan(1e-9);
    }
    const tip = res.root.getObjectByName('Tip')!;
    expect(tip.parent).toBe(res.root.getObjectByName('Axis3'));
    expect(tip.userData.realvirtual).toMatchObject({ TransportSurface: { Radial: false } });
  });

  it('rotates child translations in the parent frame and preserves root order', () => {
    const res = assemble(root(), plan({
      instances: [{ part: 'Axis', name: 'Base', positionMm: [100, 0, 0], rotationDeg: [0, 0, 90] }],
      nodes: [{ name: 'Child', parent: 'Base', positionMm: [10, 0, 0] }, { name: 'Free', positionMm: [0, 0, 0] }],
    }));
    if (!res.ok) throw new Error(res.error.message);
    expect(res.root.children.map(o => o.name)).toEqual(['Base', 'Free']);
    const child = res.root.getObjectByName('Child')!;
    const expected = child.position.clone().applyMatrix4(child.parent!.matrixWorld);
    const world = child.getWorldPosition(new Vector3());
    expect(world.distanceTo(expected)).toBeLessThan(1e-9);
    expect(world.x).toBeCloseTo(100, 9);
    expect(world.y).toBeCloseTo(10, 9);
  });

  it('accepts 16 hops when assembled directly', () => {
    const res = assemble(root(), plan({ nodes: chain(16).reverse() }));
    if (!res.ok) throw new Error(res.error.message);
    expect(res.root.getObjectByName('N16')!.parent!.name).toBe('N15');
  });

  const negatives: [string, Partial<BuildPlan>, string][] = [
    ['unknown target', { nodes: [{ name: 'A', parent: 'Missing', positionMm: [0, 0, 0] }] }, 'unknown-parent'],
    ['default name', { instances: [{ part: 'Axis', positionMm: [0, 0, 0] }], nodes: [{ name: 'A', parent: 'Axis_1', positionMm: [0, 0, 0] }] }, 'unknown-parent'],
    ['self parent', { nodes: [{ name: 'A', parent: 'A', positionMm: [0, 0, 0] }] }, 'parent-cycle'],
    ['cycle', { nodes: [{ name: 'A', parent: 'B', positionMm: [0, 0, 0] }, { name: 'B', parent: 'A', positionMm: [0, 0, 0] }] }, 'parent-cycle'],
    ['17 hops', { nodes: chain(17) }, 'parent-depth'],
    ['duplicate name', { nodes: [{ name: 'Derived', parent: 'Missing', positionMm: [0, 0, 0] }] }, 'duplicate-name'],
  ];
  for (const [label, extra, code] of negatives) {
    it(`rejects ${label} and disposes every owned geometry`, () => {
      const parts = root();
      const base = (parts.getObjectByName('Axis-mesh') as Mesh).geometry;
      const disposed: BufferGeometry[] = [];
      const original = BufferGeometry.prototype.dispose;
      const spy = vi.spyOn(BufferGeometry.prototype, 'dispose').mockImplementation(function (this: BufferGeometry) {
        disposed.push(this);
        original.call(this);
      });
      try {
        const res = assemble(parts, plan({ ...extra, instances: [
          { part: 'Axis', name: 'Derived', positionMm: [0, 0, 0], stretch: [{ axis: 'x', atMm: 50, byMm: 20 }] },
          ...(extra.instances ?? []),
        ] }));
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error.code).toBe(code);
        // One intermediate clone and the final owned stretched geometry.
        expect(disposed).toHaveLength(2);
        expect(new Set(disposed).size).toBe(2);
        expect(disposed).not.toContain(base);
      } finally {
        spy.mockRestore();
      }
    });
  }
});
