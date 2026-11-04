// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Persistent, cancellable worker pool for plan-663. Runtime kernel imports must
 * remain behind the worker/inline boundary; this module may be imported by HMI.
 */
import type { ContactProbe, ContactResult, GeometryClass, GeometryResult, SimplifyOptions } from './rv-mesh-simplify';
import type {
  MeshSimplifyCommand, MeshSimplifyCommands, MeshSimplifyContactTask, MeshSimplifyGeometry,
  MeshSimplifyInstance, MeshSimplifyReplies, MeshSimplifyWorkerRequest, MeshSimplifyWorkerResponse,
} from './rv-mesh-simplify-worker';

export interface SimplifyRequest {
  geometries: MeshSimplifyGeometry[];
  instances: MeshSimplifyInstance[];
  options: SimplifyOptions;
  /** Omitted = all. Other geometries are immutable contact partners, not report targets. */
  targetGeometryIds?: string[];
}

export interface SimplifyClassReport {
  /** Unique geometries, not instance count. */
  count: number;
  uniqueTriangles: number;
  /** Drawn triangles, including all users of each geometry. */
  trianglesBefore: number;
  trianglesAfter: number;
}

export interface SimplifyReport {
  trianglesBefore: number;
  trianglesAfter: number;
  perClass: Record<GeometryClass, SimplifyClassReport>;
  kept: number;
  skipped: { count: number; reasons: Record<string, number> };
  contactTasks: number;
  /** Wall time in ms; worker/WASM startup is excluded. Contact excludes lock merge. */
  ms: Record<'load' | 'classify' | 'plan' | 'contact' | 'merge' | 'simplify' | 'total', number>;
}

export interface SimplifyOutcome {
  results: Map<string, GeometryResult>;
  report: SimplifyReport;
}

export interface MeshSimplifyProgress {
  phase: 'load' | 'classify' | 'plan' | 'contact' | 'simplify' | 'done';
  completed: number;
  total: number;
  /** Monotonic 0..1, including when a small request restarts inline. */
  fraction: number;
}

export interface MeshSimplifyPort {
  /** Omit for a real worker or worker-like test transport. */
  kind?: 'worker' | 'inline';
  postMessage(message: MeshSimplifyWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
  onMessage(callback: (message: MeshSimplifyWorkerResponse) => void): void;
  onError(callback: (error: unknown) => void): void;
}

export interface MeshSimplifyClientOptions {
  poolSize?: number;
  createPort?: () => MeshSimplifyPort | null;
}

export class MeshSimplifyAbortError extends Error {
  constructor(message = 'Mesh simplification was aborted') {
    super(message);
    this.name = 'MeshSimplifyAbortError';
  }
}

export function isMeshSimplifyAbort(error: unknown): error is MeshSimplifyAbortError {
  return error instanceof MeshSimplifyAbortError;
}

export class MeshSimplifyWorkerError extends Error {
  constructor(message = 'Mesh simplification worker failed', options?: ErrorOptions) {
    super(message, options);
    this.name = 'MeshSimplifyWorkerError';
  }
}

interface PendingMessage {
  epoch: number;
  resolve(value: MeshSimplifyReplies[MeshSimplifyCommand]): void;
  reject(error: unknown): void;
}

interface Slot {
  port: MeshSimplifyPort;
  pending: Map<number, PendingMessage>;
  failed?: MeshSimplifyWorkerError;
}

const INLINE_LIMIT = 50_000;

export class RVMeshSimplifyClient {
  private readonly poolSize: number;
  private readonly createPort: () => MeshSimplifyPort | null;
  private slots: Slot[] = [];
  private epoch = 0;
  private nextMessageId = 1;
  private disposed = false;
  private active: { epoch: number; reject(error: unknown): void } | null = null;

  constructor(options: MeshSimplifyClientOptions = {}) {
    const concurrency = typeof navigator === 'undefined' ? 4 : (navigator.hardwareConcurrency ?? 4);
    this.poolSize = options.poolSize ?? Math.max(1, concurrency - 1);
    if (!Number.isInteger(this.poolSize) || this.poolSize < 1) throw new Error('poolSize must be a positive integer');
    this.createPort = options.createPort ?? defaultCreatePort;
  }

  simplify(request: SimplifyRequest, onProgress?: (progress: MeshSimplifyProgress) => void): Promise<SimplifyOutcome> {
    if (this.disposed) return Promise.reject(new MeshSimplifyAbortError('Mesh simplification client is disposed'));
    // Completed requests reuse their workers. Superseding in-flight WASM requires termination.
    if (this.active) this.cancel();
    const epoch = ++this.epoch;
    return new Promise((resolve, reject) => {
      this.active = { epoch, reject };
      void this.run(request, epoch, onProgress).then(outcome => {
        if (this.epoch !== epoch) return;
        this.active = null;
        resolve(outcome);
      }, error => {
        if (this.epoch !== epoch) return;
        this.active = null;
        this.stopPool(error);
        reject(error);
      });
    });
  }

  /** Terminate even idle workers. A later simplify() creates a fresh pool lazily. */
  cancel(): void {
    ++this.epoch;
    const active = this.active;
    this.active = null;
    const error = new MeshSimplifyAbortError();
    this.stopPool(error);
    active?.reject(error);
  }

  /** Terminal lifecycle operation; use cancel() when this client will be reused. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
  }

  private assertCurrent(epoch: number): void {
    if (epoch !== this.epoch || this.disposed) throw new MeshSimplifyAbortError();
  }

  private stopPool(error: unknown): void {
    const slots = this.slots;
    this.slots = [];
    for (const slot of slots) {
      // Also stop an old dynamic queue from posting its next job after a small
      // request has restarted inline within the same public epoch.
      slot.failed = new MeshSimplifyWorkerError('Mesh simplification port was terminated', { cause: error });
      for (const pending of slot.pending.values()) pending.reject(error);
      slot.pending.clear();
      try { slot.port.terminate(); } catch { /* Already crashed/terminated. */ }
    }
  }

  private attach(port: MeshSimplifyPort): Slot {
    const slot: Slot = { port, pending: new Map() };
    // Retain before installing callbacks so any setup failure terminates this port too.
    this.slots.push(slot);
    port.onMessage(message => {
      const pending = slot.pending.get(message.id);
      if (!pending || message.epoch !== pending.epoch || message.epoch !== this.epoch) return;
      slot.pending.delete(message.id);
      if (message.ok) pending.resolve(message.value);
      else pending.reject(new Error(message.error));
    });
    port.onError(cause => {
      slot.failed = new MeshSimplifyWorkerError('Mesh simplification worker crashed', { cause });
      for (const pending of slot.pending.values()) pending.reject(slot.failed);
      slot.pending.clear();
    });
    return slot;
  }

  private rpc<K extends MeshSimplifyCommand>(slot: Slot, epoch: number, command: K,
    payload: MeshSimplifyCommands[K]): Promise<MeshSimplifyReplies[K]> {
    this.assertCurrent(epoch);
    if (slot.failed) return Promise.reject(slot.failed);
    const id = this.nextMessageId++;
    return new Promise((resolve, reject) => {
      slot.pending.set(id, { epoch, resolve: value => resolve(value as MeshSimplifyReplies[K]), reject });
      try {
        // No input transfer list: structured clone per worker, or shared SAB storage.
        slot.port.postMessage({ epoch, id, command, payload } as MeshSimplifyWorkerRequest);
      } catch (cause) {
        slot.pending.delete(id);
        reject(new MeshSimplifyWorkerError('Could not send mesh simplification work', { cause }));
      }
    });
  }

  private async ensurePool(epoch: number, inline: boolean, large: boolean): Promise<Slot[]> {
    this.assertCurrent(epoch);
    if (this.slots.some(s => s.failed || (large && s.port.kind === 'inline'))) {
      this.stopPool(new MeshSimplifyWorkerError('Restarting unavailable mesh simplification workers'));
    }
    if (this.slots.length) return this.slots;
    try {
      for (let i = 0; i < (inline ? 1 : this.poolSize); i++) {
        const port = inline ? createInlineMeshSimplifyPort() : this.createPort();
        if (!port) throw new MeshSimplifyWorkerError('Web Workers are unavailable');
        this.attach(port);
        if (large && port.kind === 'inline') throw new MeshSimplifyWorkerError('Inline execution is disabled for large meshes');
        // An explicitly injected inline factory needs only one serial lane.
        if (port.kind === 'inline') break;
      }
      const slots = this.slots.slice();
      await Promise.all(slots.map(s => this.rpc(s, epoch, 'load', { geometries: [] })));
      this.assertCurrent(epoch);
      return slots;
    } catch (cause) {
      this.assertCurrent(epoch);
      throw cause instanceof MeshSimplifyWorkerError ? cause :
        new MeshSimplifyWorkerError('Could not initialize mesh simplification workers', { cause });
    }
  }

  private async run(request: SimplifyRequest, epoch: number,
    onProgress?: (progress: MeshSimplifyProgress) => void): Promise<SimplifyOutcome> {
    // The document layer interns by id. Reject ambiguity rather than silently picking
    // one of two different geometries with the same id.
    const ids = new Set<string>();
    for (const geometry of request.geometries) {
      if (ids.has(geometry.id)) throw new Error(`Duplicate geometry id: ${geometry.id}`);
      ids.add(geometry.id);
    }
    for (const instance of request.instances) {
      if (!ids.has(instance.geometryId)) throw new Error(`Unknown geometry id: ${instance.geometryId}`);
    }
    const large = request.geometries.reduce((sum, g) => sum + triangleCount(g), 0) > INLINE_LIMIT;
    let highWater = 0;
    const progress = (phase: MeshSimplifyProgress['phase'], completed: number, total: number, fraction: number) => {
      this.assertCurrent(epoch);
      highWater = Math.max(highWater, fraction);
      onProgress?.({ phase, completed, total, fraction: highWater });
      this.assertCurrent(epoch); // A progress listener may cancel or supersede synchronously.
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const slots = await this.ensurePool(epoch, attempt === 1, large);
        this.assertCurrent(epoch);
        return await this.execute(request, epoch, slots, progress);
      } catch (error) {
        this.assertCurrent(epoch);
        if (!(error instanceof MeshSimplifyWorkerError)) throw error;
        this.stopPool(error);
        if (large) throw new MeshSimplifyWorkerError(
          'Mesh simplification requires working Web Workers for more than 50,000 unique triangles; inline computation was not started.',
          { cause: error });
        if (attempt === 1) throw error;
      }
    }
    throw new MeshSimplifyWorkerError();
  }

  private async execute(request: SimplifyRequest, epoch: number, slots: Slot[],
    progress: (phase: MeshSimplifyProgress['phase'], completed: number, total: number, fraction: number) => void,
  ): Promise<SimplifyOutcome> {
    const start = performance.now();
    const ms: SimplifyReport['ms'] = { load: 0, classify: 0, plan: 0, contact: 0, merge: 0, simplify: 0, total: 0 };
    const geometries = packGeometries(request.geometries);
    const byId = new Map(geometries.map(g => [g.id, g]));
    const results = new Map<string, GeometryResult>();
    const classifications = new Map<string, MeshSimplifyReplies['classify']>();
    const owners = new Map<string, Slot>();
    const activeIds = new Set<string>();
    const targets = new Set(request.targetGeometryIds ?? geometries.map(g => g.id));

    progress('load', 0, slots.length, 0);
    await Promise.all(slots.map(s => this.rpc(s, epoch, 'load', { geometries })));
    ms.load = performance.now() - start;
    progress('load', slots.length, slots.length, .1);

    let phaseStart = performance.now();
    let completed = 0;
    await this.queue(slots, [...geometries].sort((a, b) => b.input.index.length - a.input.index.length), epoch, async (slot, g) => {
      const classification = await this.rpc(slot, epoch, 'classify', { geometryId: g.id, errorMm: request.options.errorMm });
      classifications.set(g.id, classification);
      owners.set(g.id, slot);
      if (targets.has(g.id) && !classification.skipReason && classification.classification !== 'small') activeIds.add(g.id);
      progress('classify', ++completed, geometries.length, .1 + .15 * completed / Math.max(1, geometries.length));
    });
    ms.classify = performance.now() - phaseStart;

    phaseStart = performance.now();
    const tasks = activeIds.size ? await this.rpc(slots[0], epoch, 'plan', {
      instances: request.instances, activeIds: [...activeIds],
    }) : [];
    ms.plan = performance.now() - phaseStart;
    progress('plan', tasks.length, tasks.length, .3);

    // Keep a complete Q group on one lane for its local BVH. Groups are dynamically
    // claimed, largest estimated work first; no static worker partition can strand work.
    const groups = new Map<string, { task: MeshSimplifyContactTask; index: number }[]>();
    tasks.forEach((task, index) => {
      const group = groups.get(task.q.geometryId) ?? [];
      group.push({ task, index });
      groups.set(task.q.geometryId, group);
    });
    const cost = (group: { task: MeshSimplifyContactTask }[]) => group.reduce((sum, { task }) =>
      sum + byId.get(task.p.geometryId)!.input.positions.length / 3 + byId.get(task.q.geometryId)!.input.index.length / 6, 0);
    const orderedGroups = [...groups.values()].sort((a, b) => cost(b) - cost(a));
    const contacts = new Array<ContactResult>(tasks.length);
    completed = 0;
    phaseStart = performance.now();
    await this.queue(slots, orderedGroups, epoch, async (slot, group) => {
      for (const { task, index } of group) {
        contacts[index] = await this.rpc(slot, epoch, 'contact', { task });
        progress('contact', ++completed, tasks.length, .3 + .35 * completed / Math.max(1, tasks.length));
      }
    });
    ms.contact = performance.now() - phaseStart;
    progress('contact', tasks.length, tasks.length, .65);

    phaseStart = performance.now();
    const locks = new Map<string, Uint8Array>();
    const probes = new Map<string, ContactProbe[]>();
    for (const id of activeIds) {
      locks.set(id, new Uint8Array(byId.get(id)!.input.positions.length / 3));
      probes.set(id, []);
    }
    // Merge in task order, never completion order: Float64 probe arrays and results
    // remain deterministic across worker counts, and no shared writes are required.
    tasks.forEach((task, index) => {
      const contact = contacts[index];
      const p = locks.get(task.p.geometryId), q = locks.get(task.q.geometryId);
      if (p) for (const v of contact.pLocks) p[v] = 1;
      if (q) for (const v of contact.qLocks) q[v] = 1;
      probes.get(task.q.geometryId)?.push(contact.probe);
    });
    ms.merge = performance.now() - phaseStart;

    // Small/unsupported parts are unchanged, but were still considered as partners
    // in BOTH contact directions whenever the other part is a simplification candidate.
    for (const g of request.geometries) {
      const c = classifications.get(g.id)!;
      if (!activeIds.has(g.id)) results.set(g.id, {
        status: c.skipReason ? 'skipped' : 'kept', reason: c.skipReason ?? (targets.has(g.id) ? 'small' : 'unselected'),
        classification: c.classification, mesh: g.input, attempts: 0,
      });
    }
    const jobs = geometries.filter(g => activeIds.has(g.id)).sort((a, b) => b.input.index.length - a.input.index.length);
    phaseStart = performance.now();
    completed = 0;
    // Keep preparation/probe state on its owner. Each lane processes its largest
    // remaining geometry first; classification assigned owners dynamically.
    await Promise.all(slots.map(slot => this.queue([slot], jobs.filter(g => owners.get(g.id) === slot), epoch, async (_, g) => {
      const result = await this.rpc(slot, epoch, 'simplify', {
        geometryId: g.id, options: request.options, locks: locks.get(g.id)!, probes: probes.get(g.id)!,
      });
      // Preserve the public unchanged-input identity contract after structured clone.
      if (result.status !== 'simplified') result.mesh = request.geometries.find(source => source.id === g.id)!.input;
      results.set(g.id, result);
      progress('simplify', ++completed, jobs.length, .65 + .34 * completed / Math.max(1, jobs.length));
    })));
    ms.simplify = performance.now() - phaseStart;
    ms.total = performance.now() - start;
    this.assertCurrent(epoch);
    const orderedResults = new Map(request.geometries.map(g => [g.id, results.get(g.id)!]));
    const report = buildReport(request, orderedResults, tasks.length, ms);
    progress('done', jobs.length, jobs.length, 1);
    return { results: orderedResults, report };
  }

  private async queue<T>(slots: Slot[], items: T[], epoch: number,
    work: (slot: Slot, item: T) => Promise<void>): Promise<void> {
    let next = 0;
    await Promise.all(slots.map(async slot => {
      while (next < items.length) {
        this.assertCurrent(epoch);
        const item = items[next++];
        await work(slot, item);
      }
    }));
    this.assertCurrent(epoch);
  }
}

function packGeometries(geometries: MeshSimplifyGeometry[]): MeshSimplifyGeometry[] {
  const shared = typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated === true;
  if (!shared) return geometries; // postMessage performs a structured clone per worker.
  function floats(source: Float32Array): Float32Array {
    const copy = new Float32Array(new SharedArrayBuffer(source.byteLength));
    copy.set(source);
    return copy;
  }
  return geometries.map(g => {
    const index = new Uint32Array(new SharedArrayBuffer(g.input.index.byteLength));
    index.set(g.input.index);
    return { ...g, input: { ...g.input, index, positions: floats(g.input.positions),
      normals: g.input.normals && floats(g.input.normals), uvs: g.input.uvs && floats(g.input.uvs) } };
  });
}

function buildReport(request: SimplifyRequest, results: Map<string, GeometryResult>,
  contactTasks: number, ms: SimplifyReport['ms']): SimplifyReport {
  const bucket = (): SimplifyClassReport => ({ count: 0, uniqueTriangles: 0, trianglesBefore: 0, trianglesAfter: 0 });
  const report: SimplifyReport = {
    trianglesBefore: 0, trianglesAfter: 0,
    perClass: { small: bucket(), 'barely-reducible': bucket(), reducible: bucket() },
    kept: 0, skipped: { count: 0, reasons: {} }, contactTasks, ms,
  };
  const users = new Map<string, number>();
  for (const instance of request.instances) users.set(instance.geometryId, (users.get(instance.geometryId) ?? 0) + 1);
  for (const g of request.geometries) {
    if (request.targetGeometryIds && !request.targetGeometryIds.includes(g.id)) continue;
    const result = results.get(g.id)!;
    const unique = triangleCount(g);
    const before = unique * (users.get(g.id) ?? 0);
    const after = (g.descriptor.nonTriangle ? 0 : result.mesh.index.length / 3) * (users.get(g.id) ?? 0);
    report.trianglesBefore += before;
    report.trianglesAfter += after;
    if (result.classification) {
      const c = report.perClass[result.classification];
      c.count++;
      c.uniqueTriangles += unique;
      c.trianglesBefore += before;
      c.trianglesAfter += after;
    }
    if (result.status === 'kept') report.kept++;
    if (result.status === 'skipped') {
      report.skipped.count++;
      report.skipped.reasons[result.reason] = (report.skipped.reasons[result.reason] ?? 0) + 1;
    }
  }
  return report;
}

function triangleCount(geometry: MeshSimplifyGeometry): number {
  return geometry.descriptor.nonTriangle ? 0 : geometry.input.index.length / 3;
}

/** Serial asynchronous transport with the EXACT worker handler, loaded only on demand.
 * It yields between jobs but cannot interrupt a running synchronous WASM call.
 * The client therefore never selects this transport above 50,000 unique triangles.
 */
export function createInlineMeshSimplifyPort(): MeshSimplifyPort {
  let stopped = false;
  let messageHandler: (message: MeshSimplifyWorkerResponse) => void = () => {};
  let errorHandler: (error: unknown) => void = () => {};
  let handler: ReturnType<typeof import('./rv-mesh-simplify-worker')['createMeshSimplifyHandler']> | undefined;
  let queue = Promise.resolve();
  return {
    kind: 'inline',
    onMessage: callback => { messageHandler = callback; },
    onError: callback => { errorHandler = callback; },
    terminate: () => { stopped = true; handler = undefined; },
    postMessage: message => {
      const copy = structuredClone(message);
      queue = queue.then(async () => {
        // A macrotask gives UI cancel events a chance to run between jobs.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        if (stopped) return;
        if (!handler) {
          const module = await import('./rv-mesh-simplify-worker');
          if (stopped) return;
          handler = module.createMeshSimplifyHandler();
        }
        const reply = await handler(copy);
        if (!stopped) messageHandler(structuredClone(reply.response, { transfer: reply.transfer }));
      }).catch(error => { if (!stopped) errorHandler(error); });
    },
  };
}

function defaultCreatePort(): MeshSimplifyPort | null {
  if (typeof Worker === 'undefined') return null;
  const worker = new Worker(new URL('./rv-mesh-simplify-worker.ts', import.meta.url), { type: 'module' });
  return {
    kind: 'worker',
    postMessage: (message, transfer) => worker.postMessage(message, transfer ?? []),
    terminate: () => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    },
    onMessage: callback => { worker.onmessage = event => callback(event.data as MeshSimplifyWorkerResponse); },
    onError: callback => {
      worker.onerror = event => { event.preventDefault(); callback(new Error(event.message)); };
      worker.onmessageerror = () => callback(new Error('Could not decode mesh simplification worker response'));
    },
  };
}
