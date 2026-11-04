// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { describe, expect, it, vi } from 'vitest';
import { MeshoptSimplifier } from 'meshoptimizer';
import { BoxGeometry, CylinderGeometry, SphereGeometry, PlaneGeometry, BufferGeometry, Matrix4, Shape, Path, ExtrudeGeometry } from 'three';
import { surface } from '../src/core/editor/rv-mesh-simplify-bvh';
import { classifyGeometry, detectContacts, eligibility, localErrorBound, maxWorldStretch, planContactTasks, prepareGeometry, simplifyGeometries, simplifyGeometry, verifyGeometry, worldStretchMax, type SimplifyInput, type EligibilityDescriptor, type GeometryInstance } from '../src/core/editor/rv-mesh-simplify';
const options = { errorMm: .5, lockBorder: true };
function mesh(g: BufferGeometry): SimplifyInput {
  return { positions: Float32Array.from(g.getAttribute('position').array), normals: g.hasAttribute('normal') ? Float32Array.from(g.getAttribute('normal').array) : undefined, uvs: g.hasAttribute('uv') ? Float32Array.from(g.getAttribute('uv').array) : undefined, index: g.index ? Uint32Array.from(g.index.array) : Uint32Array.from({ length: g.getAttribute('position').count }, (_, i) => i), worldStretchMax: 1 };
}
const instance = (geometryId: string, g: SimplifyInput, m = new Matrix4()): GeometryInstance => ({ geometryId, mesh: g, world: Float64Array.from(m.elements) });
function contains(g: SimplifyInput, p: number[]) { return [...new Set(g.index)].some(v => p.every((x, k) => g.positions[v * 3 + k] === x)); }
describe('plan-663 typed-array kernel (synthetic only)', () => {
  it.each([
    [{ materialCount: 2 }, 'multi-material'], [{ materialCount: 1, hasColor: true }, 'vertex-color'], [{ materialCount: 1, hasTangent: true }, 'tangent'],
    [{ materialCount: 1, hasUv1: true }, 'uv1'], [{ materialCount: 1, isInstanced: true }, 'instanced'], [{ materialCount: 1, isSkinned: true }, 'skinned'],
    [{ materialCount: 1, hasMorph: true }, 'morph'], [{ materialCount: 1, interleaved: true }, 'interleaved'], [{ materialCount: 1, nonTriangle: true }, 'non-triangle'],
  ] as [
    EligibilityDescriptor,
    string
  ][])('skips %j without touching input', async (d, reason) => {
    const g = mesh(new BoxGeometry()), copy = g.index.slice();
    const r = await simplifyGeometry(g, options, d);
    expect(eligibility(d)).toBe(reason);
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe(reason);
    expect(r.mesh).toBe(g);
    expect(g.index).toEqual(copy);
  });
  it('computes the largest singular value for nested non-uniform scales and shear', () => {
    const a = new Matrix4().makeScale(2, 3, 4);
    expect(worldStretchMax(a.elements)).toBeCloseTo(4, 12);
    const nested = a.clone().multiply(new Matrix4().makeRotationZ(.7)).multiply(new Matrix4().makeScale(4, 2, 1));
    const e = nested.elements, aa = e[0] ** 2 + e[1] ** 2, bb = e[4] ** 2 + e[5] ** 2, ab = e[0] * e[4] + e[1] * e[5];
    const expected = Math.sqrt((aa + bb + Math.sqrt((aa - bb) ** 2 + 4 * ab ** 2)) / 2);
    expect(worldStretchMax(e)).toBeCloseTo(expected, 12);
    expect(maxWorldStretch([a.elements, e])).toBeCloseTo(expected, 12);
    expect(localErrorBound(.5, expected)).toBeCloseTo(.0005 / expected, 14);
    expect(worldStretchMax([1, 0, 0, 0, 9, 0, 0, 0, 2])).toBe(9);
  });
  it.each(['cylinder', 'box'])('reduces %s while retaining hard-edge normal directions', async (kind) => {
    const g = mesh(kind === 'cylinder' ? new CylinderGeometry(.01, .01, .03, 128, 8) : new BoxGeometry(.02, .02, .02, 12, 12, 12));
    const r = await simplifyGeometry(g, options);
    expect(r.status).toBe('simplified');
    expect(r.mesh.index.length).toBeLessThan(g.index.length);
    expect(verifyGeometry(g, r.mesh, .5)).toBeNull();
    for (const v of new Set(r.mesh.index)) {
      const n = Array.from(r.mesh.normals!.subarray(v * 3, v * 3 + 3));
      const matching = [...new Set(g.index)].filter(w => [0, 1, 2].every(k => g.positions[w * 3 + k] === r.mesh.positions[v * 3 + k]));
      expect(matching.some(w => n.reduce((dot, x, k) => dot + x * g.normals![w * 3 + k], 0) > .999)).toBe(true);
    }
    // Cap and side normals remain perpendicular at the cylinder rim; box normals stay axial.
    if (kind === 'cylinder') {
      expect(Array.from(r.mesh.normals!).some(x => x === 1)).toBe(true);
      expect(Array.from(r.mesh.normals!).some(x => x === -1)).toBe(true);
    }
  });
  it('keeps every open-patch border vertex and stays within the world bound', async () => {
    const g = mesh(new PlaneGeometry(.1, .1, 24, 24));
    const border = [...new Set(g.index)].filter(v => Math.abs(g.positions[v * 3]) > .04999 || Math.abs(g.positions[v * 3 + 1]) > .04999);
    const r = await simplifyGeometry(g, options);
    expect(r.status).toBe('simplified');
    for (const v of border)
      expect(contains(r.mesh, Array.from(g.positions.subarray(v * 3, v * 3 + 3)))).toBe(true);
    expect(verifyGeometry(g, r.mesh, .5)).toBeNull();
  });
  it('compacts disjoint primitive ranges before welding or detecting contacts', () => {
    const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 10, 0, 0, 11, 0, 0, 10, 1, 0]);
    const a = { positions, index: Uint32Array.from([0, 1, 2]), worldStretchMax: 1 }, b = { ...a, index: Uint32Array.from([3, 4, 5]) };
    const prep = prepareGeometry(b);
    expect(prep.mesh.positions.length).toBe(9);
    expect(Array.from(prep.remap)).toEqual([-1, -1, -1, 0, 1, 2]);
    expect(planContactTasks([instance('a', a), instance('b', b)])).toHaveLength(0);
    const result = detectContacts({ p: instance('a', a), q: instance('b', b), relTransform: new Matrix4().elements, stretchQ: 1, worldSpace: false });
    expect(result.pLocks.length).toBe(0);
    expect(result.qLocks.length).toBe(0);
  });
  it('welds bit-identical attributes only, including signed zero', () => {
    const g = { positions: Float32Array.from([0, 0, 0, 0, 0, 0, -0, 0, 0]), index: Uint32Array.from([0, 1, 2]), worldStretchMax: 1 };
    expect(prepareGeometry(g).mesh.positions.length).toBe(6);
    expect(prepareGeometry({ ...g, normals: Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]) }).mesh.positions.length).toBe(9);
  });
  it('locks distant partner corners and preserves shared BVH index order', () => {
    const q = mesh(new PlaneGeometry(2, 2, 4, 4));
    const p = { positions: Float32Array.from([.11, .12, 0, .12, .12, 0, .11, .13, 0]), index: Uint32Array.from([0, 1, 2]), worldStretchMax: 1 };
    const saved = q.index.slice(), tasks = planContactTasks([instance('p', p), instance('q', q)]), task = tasks.find(t => t.p.geometryId === 'p')!;
    const r = detectContacts(task);
    expect(r.pLocks.length).toBe(3);
    expect(r.qLocks.length).toBeGreaterThanOrEqual(3);
    expect(r.probe.points.length).toBe(12);
    for (const v of r.qLocks)
      expect(Math.hypot(q.positions[v * 3] - .11, q.positions[v * 3 + 1] - .12)).toBeGreaterThan(.00005);
    expect(q.index).toEqual(saved);
  });
  it('deduplicates repeated relative transforms, but keeps non-uniform pairs in world space', () => {
    const g = mesh(new BoxGeometry(.01, .01, .01));
    const inst = [instance('a', g), instance('b', g), instance('a', g, new Matrix4().makeTranslation(1, 0, 0)), instance('b', g, new Matrix4().makeTranslation(1, 0, 0))];
    expect(planContactTasks(inst)).toHaveLength(2);
    const tasks = planContactTasks([instance('a', g, new Matrix4().makeScale(2, 1, 1)), instance('b', g)]);
    expect(tasks.every(t => t.worldSpace)).toBe(true);
    // Only the smaller box's corners lie on the wider box's surface.
    expect(tasks.some(t => detectContacts(t).pLocks.length > 0)).toBe(true);
  });
  it('keeps pin-in-bore contacts with different 128/96 tessellation', async () => {
    const pin = mesh(new CylinderGeometry(.01, .01, .02, 128, 2));
    // Closed annular extrusion, oriented along the same Y axis as the pin.
    const shape = new Shape(), hole = new Path();
    shape.absarc(0, 0, .015, 0, Math.PI * 2, false);
    hole.absarc(0, 0, .01, 0, Math.PI * 2, true);
    shape.holes.push(hole);
    const boreGeometry = new ExtrudeGeometry(shape, { depth: .02, bevelEnabled: false, curveSegments: 48, steps: 2 });
    boreGeometry.rotateX(Math.PI / 2);
    boreGeometry.translate(0, .01, 0);
    const bore = mesh(boreGeometry), inputs = [instance('pin', pin), instance('bore', bore)], tasks = planContactTasks(inputs);
    const locks = new Map(inputs.map(i => [i.geometryId, new Uint8Array(i.mesh.positions.length / 3)]));
    const probes = new Map<string, ReturnType<typeof detectContacts>['probe'][]>();
    for (const task of tasks) {
      const c = detectContacts(task);
      for (const v of c.pLocks)
        locks.get(task.p.geometryId)![v] = 1;
      for (const v of c.qLocks)
        locks.get(task.q.geometryId)![v] = 1;
      probes.set(task.q.geometryId, [...(probes.get(task.q.geometryId) ?? []), c.probe]);
    }
    expect([...locks.get('pin')!].filter(Boolean).length).toBeGreaterThan(128);
    const results = await simplifyGeometries(inputs.map(i => ({ geometryId: i.geometryId, input: i.mesh, locks: locks.get(i.geometryId), probes: probes.get(i.geometryId) })), options);
    for (const i of inputs) {
      const r = results.get(i.geometryId)!;
      expect(verifyGeometry(i.mesh, r.mesh, .5, probes.get(i.geometryId))).toBeNull();
      const before = surface(i.mesh.positions, i.mesh.index), after = surface(r.mesh.positions, r.mesh.index);
      let deltaMm = 0;
      for (const probe of probes.get(i.geometryId)!)
        for (let k = 0; k < probe.points.length; k += 3) {
          const p = probe.points;
          deltaMm = Math.max(deltaMm, Math.abs(before(p[k], p[k + 1], p[k + 2]).distance - after(p[k], p[k + 1], p[k + 2]).distance) * 1000);
        }
      expect(deltaMm).toBeLessThanOrEqual(.01);
    }
  });
  it('classifies small, barely reducible and dense smooth geometries', async () => {
    expect(await classifyGeometry(mesh(new BoxGeometry()), .5)).toBe('small');
    expect(await classifyGeometry(mesh(new SphereGeometry(10, 24, 16)), .00001)).toBe('barely-reducible');
    expect(await classifyGeometry(mesh(new SphereGeometry(.01, 64, 32)), .5)).toBe('reducible');
  });
  it('interns one result per geometry id', async () => {
    const g = mesh(new BoxGeometry(.01, .01, .01, 8, 8, 8)), job = { geometryId: 'shared', input: g };
    const r = await simplifyGeometries([job, job], options);
    expect(r.size).toBe(1);
    expect(r.get('shared')!.status).toBe('simplified');
  });
  it('keeps an unreducible input and rejects excess deviation/contact drift', async () => {
    const g = mesh(new BoxGeometry(.01, .01, .01));
    expect((await simplifyGeometry(g, options)).status).toBe('kept');
    const moved = { ...g, positions: g.positions.map(x => x + .01) };
    expect(verifyGeometry(g, moved, .5)).toBe('deviation');
    const slight = { ...g, positions: g.positions.map(x => x + .00002) };
    expect(verifyGeometry(g, slight, .5, [{ points: Float64Array.from([.005, 0, 0]), stretch: 1 }])).toBe('contact');
  });
  it('halves the internal bound on failure and keeps the original after five attempts', async () => {
    const g = mesh(new BoxGeometry(.01, .01, .01));
    await MeshoptSimplifier.ready;
    // Deliberately broken candidate exercises the verifier, rather than mocking it.
    const spy = vi.spyOn(MeshoptSimplifier, 'simplifyWithAttributes').mockReturnValue([new Uint32Array(0), 0]);
    try {
      const r = await simplifyGeometry(g, options);
      expect(r.status).toBe('kept');
      expect(r.reason).toBe('deviation');
      expect(r.mesh).toBe(g);
      expect(r.attempts).toBe(5);
      expect(spy.mock.calls.map(call => call[8])).toEqual([.0005, .00025, .000125, .0000625, .00003125]);
    }
    finally {
      spy.mockRestore();
    }
  });
});
