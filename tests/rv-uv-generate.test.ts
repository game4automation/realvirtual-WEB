// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-675 §9.1 — rv-uv-generate: projections, seam, physical scale.
 */
import { describe, it, expect } from 'vitest';
import { BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, Vector3 } from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { generateUVs, hashPhase01, uvSkipReason } from '../src/core/editor/rv-uv-generate';

function stripUV(g: BufferGeometry): BufferGeometry {
  g.deleteAttribute('uv');
  return g;
}

function tris(g: BufferGeometry): number[][] {
  const idx = g.getIndex();
  const count = idx ? idx.count : g.getAttribute('position').count;
  const out: number[][] = [];
  for (let i = 0; i + 2 < count; i += 3) out.push([0, 1, 2].map((k) => (idx ? idx.getX(i + k) : i + k)));
  return out;
}

describe('plan-675 §9.1 rv-uv-generate', () => {
  it('cylindrical on a cone roller (25 → 43.5 mm, 610 mm, authored in mm, world scale 0.001): u in revolutions, v in metres, seam without backward triangles', () => {
    // Axis along Y; open-ended so only the mantle counts.
    const g = stripUV(new CylinderGeometry(43.5, 25, 610, 48, 4, true));
    const before = g.getAttribute('position').count;
    const r = generateUVs(g, 'auto', new Vector3(0.001, 0.001, 0.001));
    expect(r.mode).toBe('cylindrical');
    expect(r.shapeClass).toBe('cylinder-like');
    expect(Math.abs(r.axis![1])).toBeCloseTo(1, 3);
    const uv = r.geometry.getAttribute('uv');
    expect(uv.itemSize).toBe(2);
    expect(uv.array).toBeInstanceOf(Float32Array);
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (let i = 0; i < uv.count; i++) {
      uMin = Math.min(uMin, uv.getX(i)); uMax = Math.max(uMax, uv.getX(i));
      vMin = Math.min(vMin, uv.getY(i)); vMax = Math.max(vMax, uv.getY(i));
    }
    expect(uMin).toBeGreaterThanOrEqual(-1e-6);
    expect(uMax).toBeLessThanOrEqual(1 + 0.5 + 1e-6); // seam duplicates carry u + 1 (only below 0.5 before the shift)
    expect(vMax - vMin).toBeCloseTo(0.61, 4);
    for (const t of tris(r.geometry)) {
      const us = t.map((i) => uv.getX(i));
      expect(Math.max(...us) - Math.min(...us)).toBeLessThan(0.5);
    }
    // Mean radius in mm, from the metric vertices.
    expect(r.radiusMm!).toBeGreaterThan(25);
    expect(r.radiusMm!).toBeLessThan(43.5);
    // Appended, never reordered: the first `before` positions are the originals.
    const p0 = g.getAttribute('position');
    const p1 = r.geometry.getAttribute('position');
    expect(p1.count).toBe(before + r.addedVertices);
    for (let i = 0; i < before; i++) expect(p1.getX(i)).toBe(p0.getX(i));
    // The input is untouched.
    expect(g.getAttribute('uv')).toBeUndefined();
  });

  it('a seam-straddling geometry duplicates vertices and re-points only those corners', () => {
    // Merged cylinder: seam vertices shared → duplicates must be appended.
    const g = mergeVertices(stripUV(new CylinderGeometry(1, 1, 4, 16, 1, true)).deleteAttribute('normal') as BufferGeometry);
    const r = generateUVs(g, 'cylindrical');
    expect(r.addedVertices).toBeGreaterThan(0);
    const uv = r.geometry.getAttribute('uv');
    for (const t of tris(r.geometry)) {
      const us = t.map((i) => uv.getX(i));
      expect(Math.max(...us) - Math.min(...us)).toBeLessThan(0.5);
    }
  });

  it('planar on a plate: metres along the two largest axes, world scale applied', () => {
    const g = stripUV(new BoxGeometry(2000, 20, 1000)); // mm
    const r = generateUVs(g, 'auto', new Vector3(0.001, 0.001, 0.001));
    expect(r.shapeClass).toBe('plate-like');
    expect(r.mode).toBe('planar');
    const uv = r.geometry.getAttribute('uv');
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (let i = 0; i < uv.count; i++) {
      uMin = Math.min(uMin, uv.getX(i)); uMax = Math.max(uMax, uv.getX(i));
      vMin = Math.min(vMin, uv.getY(i)); vMax = Math.max(vMax, uv.getY(i));
    }
    expect(uMax - uMin).toBeCloseTo(2, 4);
    expect(vMax - vMin).toBeCloseTo(1, 4);
  });

  it('non-uniform scale is metric per axis', () => {
    const g = stripUV(new BoxGeometry(1, 0.02, 1));
    const r = generateUVs(g, 'planar', new Vector3(3, 1, 1));
    const uv = r.geometry.getAttribute('uv');
    let uMax = 0;
    for (let i = 0; i < uv.count; i++) uMax = Math.max(uMax, Math.abs(uv.getX(i)));
    expect(uMax).toBeCloseTo(1.5, 4); // half of 3 m along the scaled X axis
  });

  it('box on a shared-vertex cube duplicates edge vertices; groups and extra attributes survive', () => {
    const cube = mergeVertices(stripUV(new BoxGeometry(1, 1, 1)).deleteAttribute('normal') as BufferGeometry);
    const colors = new Float32Array(cube.getAttribute('position').count * 3).fill(0.5);
    cube.setAttribute('color', new BufferAttribute(colors, 3));
    cube.addGroup(0, 18, 0);
    cube.addGroup(18, 18, 1);
    const r = generateUVs(cube, 'box');
    expect(r.mode).toBe('box');
    expect(r.addedVertices).toBeGreaterThan(0);
    expect(r.geometry.groups).toEqual(cube.groups);
    const col = r.geometry.getAttribute('color');
    expect(col.count).toBe(r.geometry.getAttribute('position').count);
    expect(col.getX(col.count - 1)).toBeCloseTo(0.5);
    // Each triangle is projected on one plane: its uvs span at most the face size.
    const uv = r.geometry.getAttribute('uv');
    for (const t of tris(r.geometry)) {
      const us = t.map((i) => uv.getX(i));
      const vs = t.map((i) => uv.getY(i));
      expect(Math.max(...us) - Math.min(...us)).toBeLessThanOrEqual(1 + 1e-6);
      expect(Math.max(...vs) - Math.min(...vs)).toBeLessThanOrEqual(1 + 1e-6);
      expect(Math.max(...us) - Math.min(...us) + Math.max(...vs) - Math.min(...vs)).toBeGreaterThan(0.5);
    }
  });

  it('skips morph-target and skinned geometry', () => {
    const g = new BoxGeometry(1, 1, 1);
    g.morphAttributes.position = [g.getAttribute('position').clone() as BufferAttribute];
    expect(uvSkipReason(g)).toBe('morph-targets');
    const s = new BoxGeometry(1, 1, 1);
    s.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(s.getAttribute('position').count * 4), 4));
    expect(uvSkipReason(s)).toBe('skinned');
    expect(uvSkipReason(new BoxGeometry(1, 1, 1))).toBeNull();
  });

  describe('per-node start phase (phaseSeed, fix 2026-10-24)', () => {
    const roller = (): BufferGeometry =>
      mergeVertices(stripUV(new CylinderGeometry(25, 25, 610, 32, 1, true)).deleteAttribute('normal') as BufferGeometry);
    const us = (g: BufferGeometry): number[] => {
      const uv = g.getAttribute('uv');
      return Array.from({ length: uv.count }, (_, i) => uv.getX(i));
    };
    const scale = new Vector3(0.001, 0.001, 0.001);

    it('hashPhase01 is deterministic and in [0, 1)', () => {
      expect(hashPhase01('Curve/Rollers/Roller_3')).toBe(hashPhase01('Curve/Rollers/Roller_3'));
      expect(hashPhase01('')).toBeCloseTo(0x811c9dc5 / 4294967296, 12);
      for (const s of ['a', 'b', 'Roller', 'Roller_1', 'Roller_2', 'X/Y_z']) {
        const h = hashPhase01(s);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThan(1);
      }
      expect(hashPhase01('Roller_1')).not.toBe(hashPhase01('Roller_2'));
    });

    it('(a) the same seed gives identical UVs', () => {
      const g = roller();
      const a = generateUVs(g, 'cylindrical', scale, { phaseSeed: 'Curve/Roller_7' });
      const b = generateUVs(g, 'cylindrical', scale, { phaseSeed: 'Curve/Roller_7' });
      expect(Array.from(b.geometry.getAttribute('uv').array)).toEqual(Array.from(a.geometry.getAttribute('uv').array));
      expect(a.phase).toBe(hashPhase01('Curve/Roller_7'));
    });

    it('(b) two names shift the mean u by their hash difference (mod 1); v is untouched', () => {
      const g = roller();
      const A = 'Curve/Rollers/Roller_1', B = 'Curve/Rollers/Roller_2';
      const ra = generateUVs(g, 'cylindrical', scale, { phaseSeed: A });
      const rb = generateUVs(g, 'cylindrical', scale, { phaseSeed: B });
      const ua = us(ra.geometry), ub = us(rb.geometry);
      expect(ub.length).toBe(ua.length);
      const mean = (x: number[]): number => x.reduce((acc, v) => acc + v, 0) / x.length;
      const d = mean(ub) - mean(ua);
      const expected = hashPhase01(B) - hashPhase01(A);
      expect(Math.abs(expected)).toBeGreaterThan(1e-3);
      const mod1 = (x: number): number => ((x % 1) + 1) % 1;
      const err = mod1(d - expected);
      expect(Math.min(err, 1 - err)).toBeLessThan(1e-5);
      // A constant per-vertex shift, not only on average.
      for (let i = 0; i < ua.length; i++) expect(ub[i] - ua[i]).toBeCloseTo(expected, 5);
      const va = ra.geometry.getAttribute('uv'), vb = rb.geometry.getAttribute('uv');
      for (let i = 0; i < va.count; i++) expect(vb.getY(i)).toBe(va.getY(i));
    });

    it('(c) without a seed nothing shifts; planar and box ignore the seed', () => {
      const g = roller();
      const plain = generateUVs(g, 'cylindrical', scale);
      expect(plain.phase).toBeUndefined();
      const seeded = generateUVs(g, 'cylindrical', scale, { phaseSeed: 'X' });
      const up = us(plain.geometry), uq = us(seeded.geometry);
      for (let i = 0; i < up.length; i++) expect(uq[i] - up[i]).toBeCloseTo(hashPhase01('X'), 5);
      const plate = stripUV(new BoxGeometry(2000, 20, 1000));
      for (const m of ['planar', 'box'] as const) {
        const a = generateUVs(plate, m, scale);
        const b = generateUVs(plate, m, scale, { phaseSeed: 'X' });
        expect(Array.from(b.geometry.getAttribute('uv').array)).toEqual(Array.from(a.geometry.getAttribute('uv').array));
        expect(b.phase).toBeUndefined();
      }
    });

    it('(d) the seam stays without backward triangles for any phase', () => {
      const g = roller();
      for (const seed of ['Roller_1', 'Roller_2', 'Roller_3', 'Roller_40', 'Curve/Rollers/Roller_83']) {
        const r = generateUVs(g, 'cylindrical', scale, { phaseSeed: seed });
        expect(r.addedVertices).toBeGreaterThan(0);
        const uv = r.geometry.getAttribute('uv');
        for (const t of tris(r.geometry)) {
          const u = t.map((i) => uv.getX(i));
          expect(Math.max(...u) - Math.min(...u)).toBeLessThan(0.5);
        }
      }
    });
  });

  it('the demo-curve budget: 83 roller-sized bodies in well under 200 ms', () => {
    const bodies = Array.from({ length: 83 }, () => stripUV(new CylinderGeometry(43.5, 25, 610, 48, 2, false)));
    const t0 = performance.now();
    for (const b of bodies) generateUVs(b, 'auto', new Vector3(0.001, 0.001, 0.001));
    const ms = performance.now() - t0;
    console.log(`[plan-675 §9.1] 83 bodies: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(200);
  });
});
