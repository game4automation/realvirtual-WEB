// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { expect, it, vi } from 'vitest';
import { BoxGeometry, Matrix4, Triangle, Vector3 } from 'three';
import { createMeshSimplifyHandler } from '../src/core/editor/rv-mesh-simplify-worker';
import type { MeshSimplifyWorkerRequest, MeshSimplifyContactTask } from '../src/core/editor/rv-mesh-simplify-worker';
import { detectContacts, simplifyGeometry } from '../src/core/editor/rv-mesh-simplify';
import * as kernel from '../src/core/editor/rv-mesh-simplify';
import type { ContactTask, SimplifyInput } from '../src/core/editor/rv-mesh-simplify';

it('keeps empty partners from introducing NaNs into the box sweep', () => {
  const source = new BoxGeometry(.01, .01, .01);
  const mesh: SimplifyInput = { positions: Float32Array.from(source.attributes.position.array),
    index: Uint32Array.from(source.index!.array), worldStretchMax: 1 };
  const world = new Matrix4().elements;
  const tasks = kernel.planContactTasks([
    { geometryId: 'a', mesh, world },
    { geometryId: 'empty', mesh: { ...mesh, index: new Uint32Array() }, world },
    { geometryId: 'b', mesh, world },
  ]);
  expect(tasks).toHaveLength(2);
  expect(tasks.every(t => t.p.geometryId !== 'empty' && t.q.geometryId !== 'empty')).toBe(true);
});

it('reuses worker preparation/classification and matches the standalone pure result', async () => {
  const source = new BoxGeometry(.01, .01, .01, 8, 8, 8);
  const input: SimplifyInput = { positions: Float32Array.from(source.attributes.position.array),
    normals: Float32Array.from(source.attributes.normal.array), index: Uint32Array.from(source.index!.array), worldStretchMax: 1 };
  const options = { errorMm: .5, lockBorder: true }, descriptor = { materialCount: 1 };
  const expected = await simplifyGeometry(input, options, descriptor);
  const prepare = vi.spyOn(kernel, 'prepareGeometry'), classify = vi.spyOn(kernel, 'classifyPreparedGeometry');
  try {
    const handle = createMeshSimplifyHandler();
    await handle({ epoch: 1, id: 1, command: 'load', payload: { geometries: [{ id: 'box', input, descriptor }] } });
    await handle({ epoch: 1, id: 2, command: 'classify', payload: { geometryId: 'box', errorMm: .5 } });
    const reply = await handle({ epoch: 1, id: 3, command: 'simplify', payload: {
      geometryId: 'box', options, locks: new Uint8Array(input.positions.length / 3), probes: [],
    } });
    expect(reply.response.ok).toBe(true);
    if (reply.response.ok) expect(reply.response.value).toEqual(expected);
    expect(prepare).toHaveBeenCalledTimes(1); expect(classify).toHaveBeenCalledTimes(1);
    await handle({ epoch: 2, id: 4, command: 'load', payload: { geometries: [{ id: 'box', input, descriptor }] } });
    await handle({ epoch: 2, id: 5, command: 'classify', payload: { geometryId: 'box', errorMm: .5 } });
    expect(prepare).toHaveBeenCalledTimes(2); expect(classify).toHaveBeenCalledTimes(2);
  } finally { prepare.mockRestore(); classify.mockRestore(); }
});

it('matches a tiny allocation-heavy exhaustive contact reference', () => {
  const mesh = (positions: number[]): SimplifyInput => ({ positions: new Float32Array(positions), index: new Uint32Array([0, 1, 2]), worldStretchMax: 1 });
  const p = mesh([.002, .002, 0, .003, .002, 0, .002, .003, 0]);
  const q = mesh([0, 0, 0, .02, 0, 0, 0, .02, 0]);
  const world = new Matrix4().elements;
  const task: ContactTask = { p: { geometryId: 'p', mesh: p, world }, q: { geometryId: 'q', mesh: q, world }, relTransform: world, stretchQ: 1, worldSpace: false };
  const pLocks = new Set<number>(), qLocks = new Set<number>();
  const points: number[][] = Array.from(new Set(p.index), v => Array.from(p.positions.slice(v * 3, v * 3 + 3)));
  const touch = (point: number[]) => {
    let distance = Infinity, face = -1;
    for (let t = 0; t < q.index.length; t += 3) {
      const tri = new Triangle(...[0, 1, 2].map(k => new Vector3().fromArray(q.positions, q.index[t + k] * 3)) as [Vector3, Vector3, Vector3]);
      const v = new Vector3(...point as [number, number, number]);
      const d = tri.closestPointToPoint(v, new Vector3()).distanceTo(v);
      if (d < distance) { distance = d; face = t; }
    }
    if (distance > .00005) return false;
    for (let k = 0; k < 3; k++) qLocks.add(q.index[face + k]);
    return true;
  };
  points.forEach((v, i) => { if (touch(v)) pLocks.add(i); });
  if (pLocks.size === 3) touch([0, 1, 2].map(k => points.reduce((s, p) => s + p[k] / 3, 0)));
  const result = detectContacts(task);
  expect([...result.pLocks].sort()).toEqual([...pLocks].sort());
  expect([...result.qLocks].sort()).toEqual([...qLocks].sort());
});

it('plans and detects contacts for 400 synthetic touching 2028-triangle boxes under a loose bound', async () => {
  const handle = createMeshSimplifyHandler();
  let id = 0;
  const call = async (command: string, payload: unknown): Promise<any> => {
    const { response } = await handle({ epoch: 1, id: ++id, command, payload } as MeshSimplifyWorkerRequest);
    if (!response.ok) throw new Error(response.error);
    return response.value;
  };
  const geometry = new BoxGeometry(.01, .01, .01, 13, 13, 13);
  const geometries = Array.from({ length: 400 }, (_, i) => ({ id: String(i), descriptor: { materialCount: 1 }, input: {
    positions: Float32Array.from(geometry.attributes.position.array), normals: Float32Array.from(geometry.attributes.normal.array),
    index: Uint32Array.from(geometry.index!.array), worldStretchMax: 1,
  } }));
  const instances = geometries.map((g, i) => ({ geometryId: g.id, world: new Matrix4().makeTranslation((i % 20) * .01, Math.floor(i / 20) * .01, 0).elements }));
  await call('load', { geometries });
  let start = performance.now();
  for (const g of geometries) await call('classify', { geometryId: g.id, errorMm: .5 });
  const classifyMs = performance.now() - start;
  start = performance.now();
  const tasks: MeshSimplifyContactTask[] = await call('plan', { instances, activeIds: geometries.map(g => g.id) });
  const planMs = performance.now() - start;
  let locks = 0;
  for (const task of tasks) {
    const result = await call('contact', { task });
    locks += result.pLocks.length + result.qLocks.length;
  }
  const contactMs = performance.now() - start - planMs;
  start = performance.now();
  for (const g of geometries.slice(0, 40)) await call('simplify', { geometryId: g.id, options: { errorMm: .5, lockBorder: true }, locks: new Uint8Array(g.input.positions.length / 3), probes: [] });
  const simplifyMs = performance.now() - start;
  console.log(JSON.stringify({ classifyMs, planMs, contactMs, simplify40Ms: simplifyMs, tasks: tasks.length, locks }));
  expect(tasks.length).toBeGreaterThan(1000);
  // Frozen pre-optimisation result for this fixture; the small case above also
  // compares the actual vertex-id sets against exhaustive triangle distances.
  expect(locks).toBe(849775);
  expect(planMs + contactMs).toBeLessThan(20_000);
}, 120_000);
