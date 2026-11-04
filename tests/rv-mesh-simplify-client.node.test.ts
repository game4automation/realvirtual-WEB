// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { BoxGeometry, BufferGeometry, Matrix4, PlaneGeometry, SphereGeometry } from 'three';
import * as workerModule from '../src/core/editor/rv-mesh-simplify-worker';
import type { MeshSimplifyCommand, MeshSimplifyWorkerRequest, MeshSimplifyWorkerResponse } from '../src/core/editor/rv-mesh-simplify-worker';
import {
  createInlineMeshSimplifyPort, isMeshSimplifyAbort, MeshSimplifyAbortError, MeshSimplifyWorkerError,
  RVMeshSimplifyClient, type MeshSimplifyPort, type MeshSimplifyProgress, type SimplifyRequest,
} from '../src/core/editor/rv-mesh-simplify-client';
import type { SimplifyInput } from '../src/core/editor/rv-mesh-simplify';

function input(geometry: BufferGeometry): SimplifyInput {
  return {
    positions: Float32Array.from(geometry.getAttribute('position').array),
    normals: geometry.hasAttribute('normal') ? Float32Array.from(geometry.getAttribute('normal').array) : undefined,
    uvs: geometry.hasAttribute('uv') ? Float32Array.from(geometry.getAttribute('uv').array) : undefined,
    index: geometry.index ? Uint32Array.from(geometry.index.array) :
      Uint32Array.from({ length: geometry.getAttribute('position').count }, (_, i) => i),
    worldStretchMax: 1,
  };
}
const world = (x = 0) => new Matrix4().makeTranslation(x, 0, 0).elements;

function request(): SimplifyRequest {
  const small: SimplifyInput = {
    positions: Float32Array.from([.001, .002, .00001, .002, .002, .00001, .001, .003, .00001]),
    index: Uint32Array.from([0, 1, 2]), worldStretchMax: 1,
  };
  return {
    geometries: [
      { id: 'patch', input: input(new PlaneGeometry(.04, .04, 20, 20)), descriptor: { materialCount: 1 } },
      { id: 'small', input: small, descriptor: { materialCount: 1 } },
      { id: 'skip', input: input(new BoxGeometry(.01, .01, .01)), descriptor: { materialCount: 2 } },
      { id: 'sphere', input: input(new SphereGeometry(.01, 32, 16)), descriptor: { materialCount: 1 } },
      { id: 'coarse', input: input(new SphereGeometry(10, 24, 16)), descriptor: { materialCount: 1 } },
    ],
    instances: [
      { geometryId: 'patch', world: world() }, { geometryId: 'patch', world: world(10) },
      { geometryId: 'small', world: world() }, { geometryId: 'skip', world: world(20) },
      { geometryId: 'sphere', world: world(30) }, { geometryId: 'coarse', world: world(100) },
    ],
    options: { errorMm: .5, lockBorder: true },
  };
}

function largeRequest(): SimplifyRequest {
  return {
    geometries: [{ id: 'grid', input: input(new PlaneGeometry(1, 1, 160, 160)), descriptor: { materialCount: 1 } }],
    instances: [{ geometryId: 'grid', world: world() }],
    options: { errorMm: .5, lockBorder: true },
  };
}

/** Independent serial message queue per fake worker, including structured clone and
 * output transfer semantics. Holding a reply deliberately permits delivery after terminate.
 */
class FakePort implements MeshSimplifyPort {
  readonly kind = 'worker' as const;
  readonly messages: MeshSimplifyWorkerRequest[] = [];
  readonly loadBuffers: ArrayBufferLike[] = [];
  readonly transfers: Transferable[][] = [];
  terminated = 0;
  private onReply: (reply: MeshSimplifyWorkerResponse) => void = () => {};
  private onFailure: (error: unknown) => void = () => {};
  private readonly handler = workerModule.createMeshSimplifyHandler();
  private queue = Promise.resolve();
  private held: (() => void)[] = [];
  private resolveHeld!: () => void;
  readonly whenHeld = new Promise<void>(resolve => { this.resolveHeld = resolve; });

  constructor(private hold?: MeshSimplifyCommand, private crash?: MeshSimplifyCommand) {}

  onMessage(callback: (reply: MeshSimplifyWorkerResponse) => void): void { this.onReply = callback; }
  onError(callback: (error: unknown) => void): void { this.onFailure = callback; }
  terminate(): void { this.terminated++; }
  release(): void { for (const send of this.held.splice(0)) send(); }

  postMessage(message: MeshSimplifyWorkerRequest, transfer: Transferable[] = []): void {
    this.transfers.push(transfer);
    if (message.command === 'load' && message.payload.geometries.length) {
      this.loadBuffers.push(message.payload.geometries[0].input.positions.buffer);
    }
    const copy = structuredClone(message, { transfer });
    this.messages.push(copy);
    this.queue = this.queue.then(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      if (this.terminated) return;
      if (message.command === this.crash) { this.onFailure(new Error('Synthetic worker crash')); return; }
      const result = await this.handler(copy);
      const reply = structuredClone(result.response, { transfer: result.transfer });
      const send = () => this.onReply(reply);
      if (message.command === this.hold) {
        this.held.push(send);
        this.resolveHeld();
      } else send();
    }).catch(error => this.onFailure(error));
  }
}

const clients: RVMeshSimplifyClient[] = [];
function client(options: ConstructorParameters<typeof RVMeshSimplifyClient>[0]): RVMeshSimplifyClient {
  const value = new RVMeshSimplifyClient(options);
  clients.push(value);
  return value;
}
afterEach(() => {
  for (const c of clients.splice(0)) c.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('plan-663 mesh simplification pool', () => {
  it('matches inline bit-for-bit across three independent worker queues, with drawn reporting and monotonic progress', async () => {
    const req = request();
    const before = structuredClone(req);
    const ports: FakePort[] = [];
    const pooled = client({ poolSize: 3, createPort: () => { const p = new FakePort(); ports.push(p); return p; } });
    const inline = client({ createPort: createInlineMeshSimplifyPort });
    const updates: MeshSimplifyProgress[] = [];
    const a = await pooled.simplify(req, p => updates.push(p));
    const b = await inline.simplify(req);
    expect(a.results).toEqual(b.results);
    for (const [id, result] of a.results) {
      const other = b.results.get(id)!;
      for (const key of ['positions', 'normals', 'uvs', 'index'] as const) {
        const x = result.mesh[key], y = other.mesh[key];
        if (x && y) expect(new Uint8Array(x.buffer, x.byteOffset, x.byteLength)).toEqual(new Uint8Array(y.buffer, y.byteOffset, y.byteLength));
      }
    }
    expect({ ...a.report, ms: undefined }).toEqual({ ...b.report, ms: undefined });
    expect(a.report.trianglesBefore).toBe(req.instances.reduce((sum, i) => sum + req.geometries.find(g => g.id === i.geometryId)!.input.index.length / 3, 0));
    expect(a.report.trianglesAfter).toBe(req.instances.reduce((sum, i) => sum + a.results.get(i.geometryId)!.mesh.index.length / 3, 0));
    expect(a.report.trianglesAfter).toBeLessThan(a.report.trianglesBefore);
    expect(a.report.perClass.small.count).toBe(1);
    expect(a.report.perClass.reducible.count).toBeGreaterThanOrEqual(1);
    expect(a.report.perClass['barely-reducible'].count).toBeGreaterThanOrEqual(1);
    expect(a.report.skipped).toEqual({ count: 1, reasons: { 'multi-material': 1 } });
    expect(a.report.contactTasks).toBe(2); // Small partner is retained in both directions.
    expect(a.results.get('small')!.reason).toBe('small');
    expect(a.results.get('small')!.mesh).toBe(req.geometries[1].input);
    expect(a.results.get('skip')!.mesh).toBe(req.geometries[2].input);
    expect(req).toEqual(before);
    expect(updates[0].fraction).toBe(0);
    expect(updates.at(-1)!.fraction).toBe(1);
    expect(updates.every((p, i) => !i || p.fraction >= updates[i - 1].fraction)).toBe(true);
    expect(Object.values(a.report.ms).every(ms => ms >= 0)).toBe(true);
    expect(ports.flatMap(p => p.messages).filter(m => m.command === 'simplify')).toHaveLength(3);
    expect(ports.every(p => p.transfers.every(list => list.length === 0))).toBe(true);
  });

  it('starts lazily, reuses the pool, and defaults to hardware concurrency minus one', async () => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 3 });
    const ports: FakePort[] = [];
    const createPort = vi.fn(() => { const p = new FakePort(); ports.push(p); return p; });
    const c = client({ createPort });
    expect(createPort).not.toHaveBeenCalled();
    const empty = { geometries: [], instances: [], options: request().options };
    await c.simplify(empty);
    await c.simplify(empty);
    expect(createPort).toHaveBeenCalledTimes(2);
    expect(ports.every(p => p.terminated === 0)).toBe(true);
    c.dispose();
    expect(ports.every(p => p.terminated === 1)).toBe(true);
    await expect(c.simplify(empty)).rejects.toBeInstanceOf(MeshSimplifyAbortError);
  });

  it('claims the largest Q group first and keeps each Q group on one worker', async () => {
    const req = request();
    req.geometries = req.geometries.slice(0, 2);
    req.geometries.push({ ...req.geometries[1], id: 'small-2' });
    req.instances = [
      { geometryId: 'patch', world: world() },
      { geometryId: 'small', world: world() },
      { geometryId: 'small-2', world: world() },
    ];
    const ports: FakePort[] = [];
    const sent: { port: number; q: string }[] = [];
    const c = client({ poolSize: 2, createPort: () => {
      const p = new FakePort();
      const port = ports.length;
      const post = p.postMessage.bind(p);
      p.postMessage = (message, transfer) => {
        if (message.command === 'contact') sent.push({ port, q: message.payload.task.q.geometryId });
        post(message, transfer);
      };
      ports.push(p);
      return p;
    } });
    const outcome = await c.simplify(req);
    expect(outcome.report.contactTasks).toBe(4);
    expect(sent[0].q).toBe('patch');
    for (const q of new Set(sent.map(s => s.q))) {
      expect(new Set(sent.filter(s => s.q === q).map(s => s.port)).size).toBe(1);
    }
    for (let port = 0; port < ports.length; port++) {
      const groups = sent.filter(s => s.port === port).map(s => s.q);
      const transitions = groups.filter((q, i) => !i || groups[i - 1] !== q);
      expect(new Set(transitions).size).toBe(transitions.length);
    }
  });

  it('reports overlapping non-triangle geometry as skipped without constructing a triangle BVH for it', async () => {
    const req = request();
    req.geometries = req.geometries.slice(0, 2);
    req.geometries[1] = {
      ...req.geometries[1],
      input: { ...req.geometries[1].input, index: Uint32Array.from([0, 1]) },
      descriptor: { materialCount: 1, nonTriangle: true },
    };
    req.instances = [{ geometryId: 'patch', world: world() }, { geometryId: 'small', world: world() }];
    const c = client({ poolSize: 1, createPort: () => new FakePort() });
    const outcome = await c.simplify(req);
    expect(outcome.results.get('small')).toMatchObject({ status: 'skipped', reason: 'non-triangle' });
    expect(outcome.report.contactTasks).toBe(0);
    expect(outcome.report.trianglesBefore).toBe(req.geometries[0].input.index.length / 3);
    expect(outcome.results.get('patch')!.status).toBe('simplified');
  });

  it('terminates a partially created pool before falling back inline', async () => {
    const port = new FakePort();
    let created = 0;
    const c = client({ poolSize: 2, createPort: () => {
      if (created++) throw new Error('Second worker could not be constructed');
      return port;
    } });
    const outcome = await c.simplify(request());
    expect(port.terminated).toBe(1);
    expect(outcome.results.get('patch')!.status).toBe('simplified');
  });

  it('cancel rejects immediately, drops late replies and restarts with fresh ports', async () => {
    const old = new FakePort('simplify');
    const fresh = new FakePort('simplify');
    const factory = vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(fresh);
    const c = client({ poolSize: 1, createPort: factory });
    const first = c.simplify(request());
    const rejected = expect(first).rejects.toBeInstanceOf(MeshSimplifyAbortError);
    await old.whenHeld;
    c.cancel();
    await rejected;
    expect(old.terminated).toBe(1);
    const second = c.simplify(request());
    let resolved = false;
    void second.then(() => { resolved = true; });
    await fresh.whenHeld;
    old.release();
    await Promise.resolve();
    expect(resolved).toBe(false);
    // Release all subsequent simplify responses too.
    fresh.release();
    const timer = setInterval(() => fresh.release(), 1);
    try { expect((await second).results.size).toBe(5); } finally { clearInterval(timer); }
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('supersedes the older request with an abort error while the new one resolves', async () => {
    const old = new FakePort('classify');
    let count = 0;
    const c = client({ poolSize: 1, createPort: () => count++ ? new FakePort() : old });
    const first = c.simplify(request()).catch(error => error);
    await old.whenHeld;
    const second = c.simplify(request());
    expect(isMeshSimplifyAbort(await first)).toBe(true);
    old.release();
    expect((await second).results.size).toBe(5);
    expect(old.terminated).toBe(1);
  });

  it.each(['construct', 'crash'] as const)('rejects >50,000 unique triangles on %s failure without creating an inline handler', async failure => {
    const spy = vi.spyOn(workerModule, 'createMeshSimplifyHandler');
    const c = client({ poolSize: 1, createPort: () => {
      if (failure === 'construct') throw new Error('Synthetic construction failure');
      return new FakePort(undefined, 'classify');
    } });
    await expect(c.simplify(largeRequest())).rejects.toThrow(MeshSimplifyWorkerError);
    expect(spy).toHaveBeenCalledTimes(failure === 'construct' ? 0 : 1);
  });

  it.each(['construct', 'crash'] as const)('restarts a small request inline on %s failure', async failure => {
    const ports: FakePort[] = [];
    const c = client({ poolSize: 2, createPort: () => {
      if (failure === 'construct') return null;
      const p = new FakePort(undefined, 'simplify'); ports.push(p); return p;
    } });
    const updates: MeshSimplifyProgress[] = [];
    const result = await c.simplify(request(), p => updates.push(p));
    expect(result.results.get('patch')!.status).toBe('simplified');
    expect(ports.every(p => p.terminated === 1)).toBe(true);
    expect(updates.every((p, i) => !i || p.fraction >= updates[i - 1].fraction)).toBe(true);
  });

  it('never reuses a small inline fallback pool for a subsequent large input', async () => {
    const c = client({ poolSize: 1, createPort: () => null });
    await c.simplify(request());
    const spy = vi.spyOn(workerModule, 'createMeshSimplifyHandler');
    await expect(c.simplify(largeRequest())).rejects.toThrow(/50,000/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('dispose terminates an active pool and ignores a later reply', async () => {
    const port = new FakePort('classify');
    const c = client({ poolSize: 1, createPort: () => port });
    const result = c.simplify(request()).catch(error => error);
    await port.whenHeld;
    c.dispose();
    expect(isMeshSimplifyAbort(await result)).toBe(true);
    port.release();
    c.dispose();
    expect(port.terminated).toBe(1);
  });

  it.each([false, true])('loads isolated copies, SAB sharing=%s, without detaching caller buffers', async shared => {
    vi.stubGlobal('crossOriginIsolated', shared);
    const req = request();
    const ports: FakePort[] = [];
    const c = client({ poolSize: 2, createPort: () => { const p = new FakePort(); ports.push(p); return p; } });
    const size = req.geometries[0].input.positions.byteLength;
    await c.simplify(req);
    expect(req.geometries[0].input.positions.byteLength).toBe(size);
    const loads = ports.map(p => p.messages.find(m => m.command === 'load' && m.payload.geometries.length)!) as
      Extract<MeshSimplifyWorkerRequest, { command: 'load' }>[];
    if (shared) {
      expect(ports[0].loadBuffers[0]).toBeInstanceOf(SharedArrayBuffer);
      expect(ports[0].loadBuffers[0]).toBe(ports[1].loadBuffers[0]);
      expect(ports[0].loadBuffers[0]).not.toBe(req.geometries[0].input.positions.buffer);
    } else {
      const a = loads[0].payload.geometries[0].input.positions;
      const b = loads[1].payload.geometries[0].input.positions;
      expect(a.buffer).not.toBe(b.buffer);
      expect(a.buffer).not.toBe(req.geometries[0].input.positions.buffer);
    }
  });

  it('cancellation from a progress listener cannot resolve or start another phase', async () => {
    const ports: FakePort[] = [];
    const c = client({ poolSize: 1, createPort: () => { const p = new FakePort(); ports.push(p); return p; } });
    await expect(c.simplify(request(), p => { if (p.phase === 'classify') c.cancel(); })).rejects.toBeInstanceOf(MeshSimplifyAbortError);
    expect(ports[0].terminated).toBe(1);
    expect(ports[0].messages.some(m => m.command === 'plan')).toBe(false);
  });

  it('worker transfers kept results without detaching the loaded geometry', async () => {
    const handle = workerModule.createMeshSimplifyHandler();
    const geometry = request().geometries[1];
    await handle({ id: 1, epoch: 1, command: 'load', payload: { geometries: [geometry] } });
    const reply = await handle({ id: 2, epoch: 1, command: 'simplify', payload: {
      geometryId: geometry.id, options: request().options,
      locks: new Uint8Array(geometry.input.positions.length / 3), probes: [],
    } });
    expect(reply.response.ok).toBe(true);
    structuredClone(reply.response, { transfer: reply.transfer });
    expect(geometry.input.positions.byteLength).toBeGreaterThan(0);
    const later = await handle({ id: 3, epoch: 1, command: 'classify', payload: { geometryId: geometry.id, errorMm: .5 } });
    expect(later.response).toMatchObject({ ok: true, value: { classification: 'small' } });
    const stale = await handle({ id: 4, epoch: 0, command: 'classify', payload: { geometryId: geometry.id, errorMm: .5 } });
    expect(stale.response).toMatchObject({ ok: false, error: 'Stale mesh simplification worker epoch' });
  });

  it('keeps kernel/meshoptimizer out of static client imports and workers out of their own entry', () => {
    const source = readFileSync(new URL('../src/core/editor/rv-mesh-simplify-client.ts', import.meta.url), 'utf8');
    const imports = source.match(/import\s+(?!type\b)[\s\S]*?\sfrom\s*['"][^'"]+['"]/g) ?? [];
    expect(imports.some(s => /from\s*['"](?:meshoptimizer|\.\/rv-mesh-simplify(?:-worker)?)['"]/.test(s))).toBe(false);
    expect(source).not.toMatch(/\bimport\s*['"](?:meshoptimizer|\.\/rv-mesh-simplify(?:-worker)?)['"]/);
    expect(source).toContain("new Worker(new URL('./rv-mesh-simplify-worker.ts', import.meta.url), { type: 'module' })");
    const worker = readFileSync(new URL('../src/core/editor/rv-mesh-simplify-worker.ts', import.meta.url), 'utf8');
    expect(worker).not.toContain('new Worker(');
  });
});
