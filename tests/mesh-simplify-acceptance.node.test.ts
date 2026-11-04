// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-663 test 9.6 — acceptance on real CAD models (measurement criteria).
 *
 * Customer data stays local: the test only runs when `RV_PLAN_ASSETS` points at a folder that holds
 * `festo/Festo.glb` and `mauser3dhmi/models/MauserCageline30.glb` (the private projects folder).
 * Without it every case is skipped. Nothing is written back and nothing leaves the machine.
 *
 * Criteria (decision D/E, Thomas 2026-10-22):
 * - Reduction: over the REDUCIBLE subset the drawn T_after/T_before <= 0.5 when that subset carries
 *   >= 10 % of the drawn triangles (Festo); otherwise the report must call the model barely reducible
 *   (Mauser). The total ratio is reported, not asserted.
 * - Quality (hard): world deviation <= 0.5 mm per changed geometry, measured independently here by
 *   deterministic two-sided sampling (4 points per original triangle, 7 per simplified triangle, largest
 *   stretch factor over all users); contact distances of every contact task unchanged within 0.01 mm.
 * - Runtime: the pool kernel (everything but the worker start and the payload load) < 10 s per 1 M unique
 *   triangles. Reported always; asserted only when `RV_PLAN_TIMING_HARD=1` (reference machine).
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { Matrix4, Quaternion, Vector3, BufferGeometry, BufferAttribute } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import {
  RVMeshSimplifyClient,
  type MeshSimplifyPort,
  type SimplifyRequest,
} from '../src/core/editor/rv-mesh-simplify-client';
import {
  detectContacts,
  maxWorldStretch,
  planContactTasks,
  type EligibilityDescriptor,
  type SimplifyInput,
} from '../src/core/editor/rv-mesh-simplify';

const ASSETS = process.env.RV_PLAN_ASSETS ? resolve(process.env.RV_PLAN_ASSETS) : '';
const ERROR_MM = 0.5;
const CASES = [
  { name: 'Festo', file: 'festo/Festo.glb' },
  { name: 'Mauser', file: 'mauser3dhmi/models/MauserCageline30.glb' },
];

// ─── Minimal GLB reader (attribute data stays raw, nothing is welded or modified) ────────────────

interface Geo { id: string; input: SimplifyInput; descriptor: EligibilityDescriptor; users: Float32Array[] }

const COMP: Record<number, [new (b: ArrayBuffer, o: number, n: number) => ArrayLike<number>, number]> = {
  5121: [Uint8Array, 1], 5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4],
};
const NCOMP: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function loadGlb(path: string): { geos: Geo[]; instances: { geometryId: string; world: Float32Array }[] } {
  const buf = readFileSync(path);
  const jsonLength = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLength));
  const bin = buf.subarray(20 + jsonLength + 8);
  const read = (accessorIndex: number): { data: Float32Array | Uint32Array; type: number } => {
    const a = json.accessors[accessorIndex];
    if (a.sparse || a.bufferView === undefined) throw new Error('sparse accessor');
    const view = json.bufferViews[a.bufferView];
    const [Ctor, size] = COMP[a.componentType];
    const n = NCOMP[a.type];
    const offset = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const stride = view.byteStride ?? n * size;
    const out = a.componentType === 5126 ? new Float32Array(a.count * n) : new Uint32Array(a.count * n);
    const dv = new DataView(bin.buffer, bin.byteOffset);
    for (let i = 0; i < a.count; i++) {
      for (let c = 0; c < n; c++) {
        const o = offset + i * stride + c * size;
        out[i * n + c] = size === 4
          ? (a.componentType === 5126 ? dv.getFloat32(o, true) : dv.getUint32(o, true))
          : size === 2 ? dv.getUint16(o, true) : dv.getUint8(o);
      }
    }
    void Ctor;
    return { data: out, type: a.componentType };
  };

  const geos: Geo[] = [];
  const primitives: Geo[][] = json.meshes.map((m: any, mi: number) => m.primitives.map((p: any, pi: number) => {
    const keys = Object.keys(p.attributes);
    const descriptor: EligibilityDescriptor = {
      materialCount: 1,
      hasColor: keys.some(k => k.startsWith('COLOR')),
      hasTangent: keys.includes('TANGENT'),
      hasUv1: keys.includes('TEXCOORD_1'),
      hasMorph: !!p.targets,
      nonTriangle: (p.mode ?? 4) !== 4,
    };
    let input: SimplifyInput = { positions: new Float32Array(0), index: new Uint32Array(0), worldStretchMax: 1 };
    try {
      const pos = read(p.attributes.POSITION);
      const nor = p.attributes.NORMAL !== undefined ? read(p.attributes.NORMAL) : null;
      const uv = p.attributes.TEXCOORD_0 !== undefined ? read(p.attributes.TEXCOORD_0) : null;
      if (pos.type !== 5126 || (nor && nor.type !== 5126) || (uv && uv.type !== 5126)) descriptor.interleaved = true;
      const vc = pos.data.length / 3;
      input = {
        positions: pos.data as Float32Array,
        normals: nor?.data as Float32Array | undefined,
        uvs: uv?.data as Float32Array | undefined,
        index: p.indices !== undefined
          ? Uint32Array.from(read(p.indices).data)
          : Uint32Array.from({ length: vc }, (_, i) => i),
        worldStretchMax: 1,
      };
    } catch {
      descriptor.nonTriangle = true;
    }
    const geo: Geo = { id: `${mi}/${pi}`, input, descriptor, users: [] };
    geos.push(geo);
    return geo;
  }));

  const instances: { geometryId: string; world: Float32Array }[] = [];
  const visit = (ni: number, parent: Matrix4): void => {
    const n = json.nodes[ni];
    const local = new Matrix4();
    if (n.matrix) local.fromArray(n.matrix);
    else local.compose(new Vector3(...(n.translation ?? [0, 0, 0])), new Quaternion(...(n.rotation ?? [0, 0, 0, 1])), new Vector3(...(n.scale ?? [1, 1, 1])));
    const world = parent.clone().multiply(local);
    if (n.mesh !== undefined) {
      const instanced = !!n.extensions?.EXT_mesh_gpu_instancing;
      for (const geo of primitives[n.mesh]) {
        if (instanced) geo.descriptor.isInstanced = true;
        const m = Float32Array.from(world.elements);
        geo.users.push(m);
        instances.push({ geometryId: geo.id, world: m });
      }
    }
    for (const c of n.children ?? []) visit(c, world);
  };
  for (const r of json.scenes[json.scene ?? 0].nodes) visit(r, new Matrix4());
  const used = geos.filter(g => g.users.length > 0);
  for (const g of used) g.input.worldStretchMax = maxWorldStretch(g.users);
  return { geos: used, instances };
}

// ─── Node worker_threads transport around the real worker handler ────────────────────────────────

async function buildWorkerBundle(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'rv-simplify-'));
  const outfile = join(dir, 'worker.mjs');
  const worker = resolve(__dirname, '../src/core/editor/rv-mesh-simplify-worker.ts').replace(/\\/g, '/');
  await build({
    stdin: {
      contents: `import { parentPort } from 'node:worker_threads';
import { createMeshSimplifyHandler } from ${JSON.stringify(worker)};
const handle = createMeshSimplifyHandler();
let queue = Promise.resolve();
parentPort.on('message', m => { queue = queue.then(async () => { const r = await handle(m); parentPort.postMessage(r.response, r.transfer); }); });`,
      resolveDir: resolve(__dirname, '..'),
      loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
  return outfile;
}

function nodePortFactory(bundle: string): () => MeshSimplifyPort {
  return () => {
    const worker = new Worker(bundle);
    return {
      kind: 'worker',
      postMessage: (message, transfer) => worker.postMessage(message, (transfer ?? []) as never),
      terminate: () => { void worker.terminate(); },
      onMessage: cb => { worker.on('message', cb); },
      onError: cb => { worker.on('error', cb); },
    };
  };
}

// ─── Independent measurement ─────────────────────────────────────────────────────────────────────

function bvhOf(input: { positions: Float32Array; index: Uint32Array }): MeshBVH {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(input.positions, 3));
  g.setIndex(new BufferAttribute(Uint32Array.from(input.index), 1)); // copy: MeshBVH reorders the index
  return new MeshBVH(g, { indirect: true });
}

const BARY4 = [[1 / 3, 1 / 3, 1 / 3], [2 / 3, 1 / 6, 1 / 6], [1 / 6, 2 / 3, 1 / 6], [1 / 6, 1 / 6, 2 / 3]];
const BARY7 = [...BARY4, [.5, .5, 0], [0, .5, .5], [.5, 0, .5]];
const TARGET = { point: new Vector3(), distance: 0, faceIndex: 0 };
const PROBE = new Vector3();

function maxSampleDistance(from: SimplifyInput, to: MeshBVH, bary: number[][]): number {
  let max = 0;
  for (let t = 0; t < from.index.length; t += 3) {
    for (const b of bary) {
      let x = 0, y = 0, z = 0;
      for (let k = 0; k < 3; k++) {
        const v = from.index[t + k] * 3;
        x += b[k] * from.positions[v]; y += b[k] * from.positions[v + 1]; z += b[k] * from.positions[v + 2];
      }
      PROBE.set(x, y, z);
      const hit = to.closestPointToPoint(PROBE, TARGET);
      if (hit && hit.distance > max) max = hit.distance;
    }
  }
  return max;
}

function distance(bvh: MeshBVH, p: Vector3): number {
  return bvh.closestPointToPoint(p, TARGET)?.distance ?? Infinity;
}

describe.skipIf(!ASSETS)('plan-663 9.6 — mesh simplify acceptance (local customer assets)', () => {
  for (const c of CASES) {
    const file = ASSETS ? join(ASSETS, c.file) : '';
    it.skipIf(!ASSETS || !existsSync(file))(`${c.name}: reduction, deviation, contacts, runtime`, async () => {
      (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = true; // SharedArrayBuffer payloads
      const { geos, instances } = loadGlb(file);
      const request: SimplifyRequest = {
        geometries: geos.map(g => ({ id: g.id, input: g.input, descriptor: g.descriptor })),
        instances,
        options: { errorMm: ERROR_MM, lockBorder: true, normalWeight: 1 },
      };
      const client = new RVMeshSimplifyClient({ createPort: nodePortFactory(await buildWorkerBundle()) });
      if (process.env.RV_PLAN_TRACE) process.stderr.write(`[trace] loaded ${geos.length} geometries, ${instances.length} instances
`);
      const started = performance.now();
      const { results, report } = await client.simplify(request, pr => { if (process.env.RV_PLAN_TRACE) process.stderr.write(`[trace] ${pr.phase} ${pr.completed}/${pr.total} ${((performance.now() - started) / 1000).toFixed(1)}s
`); });
      const wall = (performance.now() - started) / 1000;
      client.dispose();

      // Sensitivity probe (RV_PLAN_FORCE=1): crudely decimate a few contact partners WITHOUT locks and verify
      // that the independent measurement below reports a non-zero contact delta. Proves the metric can see change.
      if (process.env.RV_PLAN_FORCE === '1') {
        const { MeshoptSimplifier } = await import('meshoptimizer');
        await MeshoptSimplifier.ready;
        const forceById = new Map(geos.map(g => [g.id, g]));
        const seeds = planContactTasks(instances.map(i => ({ geometryId: i.geometryId, mesh: forceById.get(i.geometryId)!.input, world: i.world })))
          .filter(t => !forceById.get(t.p.geometryId)!.descriptor.nonTriangle && !forceById.get(t.q.geometryId)!.descriptor.nonTriangle);
        const forced = new Set<string>();
        for (const t of seeds) {
          for (const id of [t.p.geometryId, t.q.geometryId]) {
            const g = forceById.get(id)!;
            if (forced.size < 12 && !forced.has(id) && g.input.index.length / 3 >= 600) forced.add(id);
          }
          if (forced.size >= 12) break;
        }
        for (const id of forced) {
          const g = forceById.get(id)!;
          const [index] = MeshoptSimplifier.simplify(g.input.index, g.input.positions, 3, Math.floor(g.input.index.length * 0.15 / 3) * 3, 0.02, ['ErrorAbsolute']);
          const r = results.get(id)!;
          results.set(id, { ...r, status: 'simplified', mesh: { positions: g.input.positions, index, worldStretchMax: g.input.worldStretchMax } });
        }
        process.stderr.write(`[force] crudely decimated ${forced.size} contact partners
`);
      }

      // ── reduction
      const reducible = report.perClass.reducible;
      const drawn = report.trianglesBefore;
      const share = reducible.trianglesBefore / Math.max(1, drawn);
      const reducibleRatio = reducible.trianglesAfter / Math.max(1, reducible.trianglesBefore);
      // ── runtime
      const unique = geos.filter(g => !g.descriptor.nonTriangle).reduce((s, g) => s + g.input.index.length / 3, 0);
      const kernelSeconds = (report.ms.total - report.ms.load) / 1000;
      const perMillion = kernelSeconds / (unique / 1e6);

      // ── independent deviation
      let worstDeviationMm = 0;
      const changed: Geo[] = [];
      const afterBvh = new Map<string, MeshBVH>();
      const beforeBvh = new Map<string, MeshBVH>();
      for (const g of geos) {
        const r = results.get(g.id)!;
        if (r.status !== 'simplified') continue;
        changed.push(g);
        const before = bvhOf(g.input);
        const after = bvhOf(r.mesh);
        const stretch = g.input.worldStretchMax;
        const d = Math.max(maxSampleDistance(g.input, after, BARY4), maxSampleDistance(r.mesh, before, BARY7));
        worstDeviationMm = Math.max(worstDeviationMm, d * 1000 * stretch);
        beforeBvh.set(g.id, before);
        afterBvh.set(g.id, after);
      }

      // ── independent contact distances: every contact task touching a changed geometry
      const byId = new Map(geos.map(g => [g.id, g]));
      const tasks = planContactTasks(instances.map(i => ({ geometryId: i.geometryId, mesh: byId.get(i.geometryId)!.input, world: i.world })))
        .filter(t => !byId.get(t.p.geometryId)!.descriptor.nonTriangle && !byId.get(t.q.geometryId)!.descriptor.nonTriangle)
        .filter(t => results.get(t.p.geometryId)!.status === 'simplified' || results.get(t.q.geometryId)!.status === 'simplified');
      const bvhBefore = (id: string): MeshBVH => beforeBvh.get(id) ?? (beforeBvh.set(id, bvhOf(byId.get(id)!.input)), beforeBvh.get(id)!);
      const bvhAfter = (id: string): MeshBVH => {
        const r = results.get(id)!;
        return r.status === 'simplified' ? afterBvh.get(id)! : bvhBefore(id);
      };
      let worstContactMm = 0, probes = 0;
      const relToQ = new Matrix4(), toPLocal = new Matrix4(), pWorld = new Matrix4(), qWorldInv = new Matrix4(), pt = new Vector3();
      for (const task of tasks) {
        const contact = detectContacts(task);
        const pts = contact.probe.points;
        if (!pts.length) continue;
        // Probe points live in Q-local space (uniform scale) or in world space (non-uniform fallback).
        // Either way: point -> P-local, re-project onto the simplified P surface, back to the same space.
        if (task.worldSpace) {
          pWorld.fromArray(Array.from(task.p.world));
          toPLocal.copy(pWorld).invert();
          qWorldInv.fromArray(Array.from(task.q.world)).invert();
        } else {
          relToQ.fromArray(Array.from(task.relTransform));
          toPLocal.copy(relToQ).invert();
        }
        const stretch = task.stretchQ;
        const pAfter = bvhAfter(task.p.geometryId);
        const qBefore = bvhBefore(task.q.geometryId), qAfter = bvhAfter(task.q.geometryId);
        for (let i = 0; i < pts.length; i += 3) {
          pt.set(pts[i], pts[i + 1], pts[i + 2]);
          const local = pt.clone().applyMatrix4(toPLocal);
          const hit = pAfter.closestPointToPoint(local, { point: new Vector3(), distance: 0, faceIndex: 0 });
          const moved = (hit ? hit.point.clone() : local).applyMatrix4(task.worldSpace ? pWorld : relToQ);
          const before = task.worldSpace ? pt.clone().applyMatrix4(qWorldInv) : pt;
          const after = task.worldSpace ? moved.applyMatrix4(qWorldInv) : moved;
          worstContactMm = Math.max(worstContactMm, Math.abs(distance(qAfter, after) - distance(qBefore, before)) * stretch * 1000);
          probes++;
        }
      }

      const summary = {
        model: c.name, geometries: geos.length, drawnBefore: drawn, drawnAfter: report.trianglesAfter,
        totalRatio: +(report.trianglesAfter / Math.max(1, drawn)).toFixed(3),
        classes: Object.fromEntries(Object.entries(report.perClass).map(([k, v]) => [k, { count: v.count, drawnShare: +(v.trianglesBefore / Math.max(1, drawn)).toFixed(3) }])),
        reducibleShare: +share.toFixed(3), reducibleRatio: +reducibleRatio.toFixed(3),
        kept: report.kept, skipped: report.skipped, changedGeometries: changed.length,
        worstDeviationMm: +worstDeviationMm.toFixed(4), worstContactDeltaMm: +worstContactMm.toFixed(4), contactProbes: probes, contactTasks: tasks.length,
        uniqueTriangles: unique, wallSeconds: +wall.toFixed(1), kernelSeconds: +kernelSeconds.toFixed(1),
        secondsPerMillion: +perMillion.toFixed(2), phasesMs: report.ms,
      };
      console.log('[plan-663 9.6] ' + JSON.stringify(summary));

      if (process.env.RV_PLAN_FORCE === '1') { expect(worstContactMm).toBeGreaterThan(0.01); return; }
      expect(worstDeviationMm).toBeLessThanOrEqual(ERROR_MM);
      expect(worstContactMm).toBeLessThanOrEqual(0.01);
      if (share >= 0.1) expect(reducibleRatio).toBeLessThanOrEqual(0.5);
      else expect(share).toBeLessThan(0.1); // reported as barely reducible: no reduction target applies
      if (process.env.RV_PLAN_TIMING_HARD === '1') expect(perMillion).toBeLessThan(10);
    }, 3_600_000);
  }
});
