// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-756 §9.2 / §9.4a — the pick-build PORT (step 1b).
 *
 * What is under test is the pool, not the build: sizing, largest-first
 * ordering, the buffer-ownership window, staleness, and above all the failure
 * path — because from step 1c on, `bake()` AWAITS this port, so a hung or lost
 * job would hang a scene load (plan risk R12).
 *
 * Exactly ONE test spawns a real `Worker` (the worker == inline byte-identity
 * proof, §9.2). Every other test injects a mock transport whose "worker" runs
 * `handlePickBuildRequest` — the REAL worker body — on the main thread, so the
 * pool logic is exercised deterministically and no test depends on worker
 * startup timing.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INLINE_SLICE_MS,
  DEFAULT_PICK_WATCHDOG_MS,
  MAX_PICK_BUILD_WORKERS,
  clampPickBuildPoolSize,
  createPickBuildPort,
  disposeSharedPickBuildPort,
  getSharedPickBuildPort,
  type PickBuildJob,
  type PickBuildJobResult,
  type PickBuildRequest,
  type PickBuildResponse,
  type PickBuildWorkerPort,
} from '../src/core/engine/rv-pick-build-port';
import { handlePickBuildRequest } from '../src/core/engine/rv-pick-build-worker';
import { buildPickStructure, type PickSegmentInput } from '../src/core/engine/rv-pick-build';
import { makePrimitiveAssembly } from './helpers/pick-geometry';

// ─── Fixtures ───────────────────────────────────────────────────────

interface Staged {
  position: Float32Array;
  index: Uint32Array;
  segments: PickSegmentInput[];
}

/**
 * `triangles` independent triangles on a diagonal, split into `segments`
 * segments. Deliberately trivial geometry: this suite asserts pool behaviour,
 * the geometry-dependent invariants live in `rv-pick-build.test.ts`.
 */
function stage(triangles: number, segmentCount = 2): Staged {
  const position = new Float32Array(triangles * 9);
  const index = new Uint32Array(triangles * 3);
  for (let t = 0; t < triangles; t++) {
    const o = t * 9;
    const x = (t % 97) * 0.37;
    const y = (t % 31) * 0.11;
    const z = t * 0.013;
    position[o] = x; position[o + 1] = y; position[o + 2] = z;
    position[o + 3] = x + 0.4; position[o + 4] = y; position[o + 5] = z;
    position[o + 6] = x; position[o + 7] = y + 0.4; position[o + 8] = z;
    index[3 * t] = 3 * t;
    index[3 * t + 1] = 3 * t + 1;
    index[3 * t + 2] = 3 * t + 2;
  }
  const segments: PickSegmentInput[] = [];
  const per = Math.ceil(triangles / segmentCount);
  for (let s = 0; s < segmentCount; s++) {
    const first = s * per;
    if (first >= triangles) break;
    const count = Math.min(per, triangles - first) * 3;
    segments.push({ indexStart: first * 3, indexCount: count, node: s, owner: s === 1 ? -1 : s });
  }
  return { position, index, segments };
}

/** A job that hands over freshly staged arrays and can re-stage on demand. */
function jobFor(key: string, triangles: number, options: { restage?: boolean } = {}): PickBuildJob {
  const staged = stage(triangles);
  return {
    key,
    position: staged.position,
    index: staged.index,
    segments: staged.segments,
    ...(options.restage === false
      ? {}
      : { restage: () => { const again = stage(triangles); return { position: again.position, index: again.index }; } }),
  };
}

// ─── Mock worker transport ──────────────────────────────────────────

interface MockWorker {
  port: PickBuildWorkerPort;
  requests: PickBuildRequest[];
  terminated: boolean;
  /** Run the REAL worker body for the oldest pending request and answer. */
  respond(): void;
  /** Answer the oldest pending request as a failed build (worker stays alive). */
  failBuild(message?: string): void;
  /** Raise a worker-level `error` / `messageerror`. */
  raise(reason?: unknown): void;
  pending: number;
}

function makeMockWorkers(): { create: () => PickBuildWorkerPort; workers: MockWorker[] } {
  const workers: MockWorker[] = [];
  const create = (): PickBuildWorkerPort => {
    let onMessage: ((message: PickBuildResponse) => void) | null = null;
    let onError: ((reason: unknown) => void) | null = null;
    const requests: PickBuildRequest[] = [];
    const port: PickBuildWorkerPort = {
      postMessage: (message) => { requests.push(message); },
      onMessage: (cb) => { onMessage = cb; },
      onError: (cb) => { onError = cb; },
      // A terminated worker loses its queue — as a real one does, together with
      // the buffers that were transferred into it.
      terminate: () => { mock.terminated = true; requests.length = 0; },
    };
    const mock: MockWorker = {
      port,
      requests,
      terminated: false,
      get pending() { return requests.length; },
      respond() {
        const request = requests.shift();
        if (!request) throw new Error('mock worker: nothing to respond to');
        const { response } = handlePickBuildRequest(request);
        onMessage?.(response);
      },
      failBuild(message = 'synthetic build failure') {
        const request = requests.shift();
        if (!request) throw new Error('mock worker: nothing to fail');
        onMessage?.({ id: request.id, key: request.key, ok: false, error: message });
      },
      raise(reason = new Error('synthetic worker error')) {
        onError?.(reason);
      },
    };
    workers.push(mock);
    return port;
  };
  return { create, workers };
}

/** Controllable watchdog timers — the "fake timer" of §9.4a. */
function makeTimers() {
  const fired: Array<{ callback: () => void; ms: number; cancelled: boolean }> = [];
  return {
    fired,
    setTimer: (callback: () => void, ms: number) => {
      const entry = { callback, ms, cancelled: false };
      fired.push(entry);
      return entry;
    },
    clearTimer: (handle: unknown) => { (handle as { cancelled: boolean }).cancelled = true; },
    /** Fire every timer that is still armed. */
    fireAll() {
      for (const entry of fired) {
        if (!entry.cancelled) { entry.cancelled = true; entry.callback(); }
      }
    },
    get armed() { return fired.filter((e) => !e.cancelled).length; },
  };
}

async function flush(turns = 30): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

function expectOk(result: PickBuildJobResult): Extract<PickBuildJobResult, { status: 'ok' }> {
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error('not ok');
  return result;
}

// ─── Pool sizing ────────────────────────────────────────────────────

describe('pool size', () => {
  it('clamps hardwareConcurrency − 1 into [1, 4]', () => {
    expect(clampPickBuildPoolSize(0)).toBe(1);
    expect(clampPickBuildPoolSize(1)).toBe(1);
    expect(clampPickBuildPoolSize(2)).toBe(1);
    expect(clampPickBuildPoolSize(3)).toBe(2);
    expect(clampPickBuildPoolSize(5)).toBe(4);
    expect(clampPickBuildPoolSize(64)).toBe(MAX_PICK_BUILD_WORKERS);
    // Under-reporting / nonsense values must never produce 0 or NaN workers.
    expect(clampPickBuildPoolSize(Number.NaN)).toBe(1);
    expect(clampPickBuildPoolSize(-8)).toBe(1);
  });

  it('never runs more jobs concurrently than it has slots, and starts workers lazily', async () => {
    const mock = makeMockWorkers();
    const port = createPickBuildPort({ createWorker: mock.create, size: 2 });
    expect(mock.workers.length).toBe(0); // lazy

    const epoch = port.beginEpoch();
    const results = [jobFor('a', 300), jobFor('b', 400), jobFor('c', 500)].map((job) => epoch.build(job));
    await flush();

    expect(mock.workers.length).toBe(2);
    expect(mock.workers[0].pending + mock.workers[1].pending).toBe(2);

    mock.workers[0].respond();
    await flush();
    // The third job only started after a slot came free.
    expect(mock.workers[0].pending + mock.workers[1].pending).toBe(2);
    mock.workers[0].respond();
    mock.workers[1].respond();
    await flush();

    for (const result of await Promise.all(results)) expectOk(result);
    expect(port.stats.workerJobs).toBe(3);
    port.dispose();
  });
});

// ─── Ordering ───────────────────────────────────────────────────────

describe('queue order', () => {
  it('dispatches the largest queued job first', async () => {
    const mock = makeMockWorkers();
    const port = createPickBuildPort({ createWorker: mock.create, size: 1 });
    const epoch = port.beginEpoch();

    // Submitted smallest first on purpose: the first one starts immediately
    // (nothing to choose from), the remaining two are ordered by size.
    const results = [
      epoch.build(jobFor('small', 200)),
      epoch.build(jobFor('mid', 400)),
      epoch.build(jobFor('big', 900)),
    ];
    await flush();
    const worker = mock.workers[0];
    const order: string[] = [];
    for (let i = 0; i < 3; i++) {
      order.push(worker.requests[0].key);
      worker.respond();
      await flush();
    }
    expect(order).toEqual(['small', 'big', 'mid']);
    for (const result of await Promise.all(results)) expectOk(result);
    port.dispose();
  });
});

// ─── Ownership / staleness ──────────────────────────────────────────

describe('buffer ownership and staleness', () => {
  it('hands the buffers over and gives permuted arrays back', async () => {
    const mock = makeMockWorkers();
    const port = createPickBuildPort({ createWorker: mock.create, size: 1 });
    const job = jobFor('chunk', 600);
    const position = job.position;
    const index = job.index;

    const promise = port.build(job);
    await flush();
    // The request carries the very arrays the caller handed over — no copy.
    expect(mock.workers[0].requests[0].position).toBe(position);
    expect(mock.workers[0].requests[0].index).toBe(index);
    mock.workers[0].respond();

    const result = expectOk(await promise);
    expect(result.position).toBe(position);
    expect(result.index).toBe(index);
    expect(result.data.segmentCount).toBe(job.segments.length);
    expect(result.viaWorker).toBe(true);
    port.dispose();
  });

  it('a job of an aborted epoch resolves stale and publishes nothing', async () => {
    const mock = makeMockWorkers();
    const port = createPickBuildPort({ createWorker: mock.create, size: 1 });
    const epoch = port.beginEpoch();
    const promise = epoch.build(jobFor('chunk', 600));
    await flush();

    epoch.abort();
    // The worker answers anyway — the buffers come back and are dropped here.
    mock.workers[0].respond();
    const result = await promise;
    expect(result.status).toBe('stale');
    expect(result).not.toHaveProperty('data');
    expect(port.stats.workerJobs).toBe(0);
    port.dispose();
  });

  it('a job submitted into an already aborted epoch never reaches a worker', async () => {
    const mock = makeMockWorkers();
    const port = createPickBuildPort({ createWorker: mock.create, size: 2 });
    const epoch = port.beginEpoch();
    epoch.abort();
    const result = await epoch.build(jobFor('chunk', 300));
    expect(result.status).toBe('stale');
    expect(mock.workers.length).toBe(0);
    port.dispose();
  });

  it('abort answers everything still queued', async () => {
    const mock = makeMockWorkers();
    const port = createPickBuildPort({ createWorker: mock.create, size: 1 });
    const epoch = port.beginEpoch();
    const inFlight = epoch.build(jobFor('running', 300));
    const queued = epoch.build(jobFor('queued', 300));
    await flush();

    epoch.abort();
    expect((await queued).status).toBe('stale');
    mock.workers[0].respond();
    expect((await inFlight).status).toBe('stale');
    port.dispose();
  });

  it('dispose during a pending job does not throw and resolves it stale', async () => {
    const mock = makeMockWorkers();
    const port = createPickBuildPort({ createWorker: mock.create, size: 1 });
    const running = port.build(jobFor('running', 400));
    const waiting = port.build(jobFor('waiting', 400));
    await flush();

    expect(() => port.dispose()).not.toThrow();
    expect((await running).status).toBe('stale');
    expect((await waiting).status).toBe('stale');
    expect(mock.workers[0].terminated).toBe(true);
    // Work submitted after dispose is answered, never left hanging.
    expect((await port.build(jobFor('after', 300))).status).toBe('stale');
  });
});

// ─── Failure path (plan §2.4a.8 / R12) ──────────────────────────────

describe('failure path', () => {
  it('a failed build in the worker is redone inline from restage()', async () => {
    const mock = makeMockWorkers();
    const port = createPickBuildPort({ createWorker: mock.create, size: 1 });
    let restaged = 0;
    const base = jobFor('chunk', 600);
    const promise = port.build({
      ...base,
      restage: () => { restaged++; const again = stage(600); return { position: again.position, index: again.index }; },
    });
    await flush();
    mock.workers[0].failBuild('index out of range');

    const result = expectOk(await promise);
    expect(restaged).toBe(1);
    expect(result.viaWorker).toBe(false);
    expect(result.data.triangleCount).toBe(600);
    expect(port.stats.retries).toBe(1);
    expect(port.stats.inlineJobs).toBe(1);
    // A failed BUILD is not a broken worker — it is not retired.
    expect(port.stats.retiredWorkers).toBe(0);
    port.dispose();
  });

  it('a worker error retires the worker and the job is redone inline', async () => {
    const mock = makeMockWorkers();
    const port = createPickBuildPort({ createWorker: mock.create, size: 1 });
    const promise = port.build(jobFor('chunk', 600));
    await flush();
    mock.workers[0].raise(new Error('module load failed'));

    const result = expectOk(await promise);
    expect(result.viaWorker).toBe(false);
    expect(port.stats.retiredWorkers).toBe(1);
    expect(mock.workers[0].terminated).toBe(true);
    expect(port.usesWorker).toBe(false);
    port.dispose();
  });

  it('a worker that never answers is caught by the watchdog and redone inline', async () => {
    const mock = makeMockWorkers();
    const timers = makeTimers();
    const port = createPickBuildPort({
      createWorker: mock.create,
      size: 1,
      watchdogMs: 1234,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    const promise = port.build(jobFor('chunk', 600));
    await flush();
    expect(timers.armed).toBe(1);
    expect(timers.fired[0].ms).toBe(1234);

    timers.fireAll(); // the worker still says nothing

    const result = expectOk(await promise);
    expect(result.viaWorker).toBe(false);
    expect(port.stats.retiredWorkers).toBe(1);
    port.dispose();
  });

  it('arms the 30 s watchdog by default', async () => {
    const mock = makeMockWorkers();
    const timers = makeTimers();
    const port = createPickBuildPort({
      createWorker: mock.create,
      size: 1,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    const promise = port.build(jobFor('chunk', 200));
    await flush();
    expect(timers.fired[0].ms).toBe(DEFAULT_PICK_WATCHDOG_MS);
    mock.workers[0].respond();
    expectOk(await promise);
    // The watchdog is disarmed on the answer — nothing fires later.
    expect(timers.armed).toBe(0);
    port.dispose();
  });

  it('rejects with the chunk key when the buffers are gone and no restage() exists', async () => {
    const mock = makeMockWorkers();
    const port = createPickBuildPort({ createWorker: mock.create, size: 1 });
    const promise = port.build(jobFor('lonely-chunk', 400, { restage: false }));
    await flush();
    mock.workers[0].raise(new Error('worker died'));

    await expect(promise).rejects.toThrow(/lonely-chunk/);
    await expect(promise).rejects.toThrow(/restage/);
    port.dispose();
  });

  it('rejects when restage() throws', async () => {
    const mock = makeMockWorkers();
    const port = createPickBuildPort({ createWorker: mock.create, size: 1 });
    const base = jobFor('chunk', 400, { restage: false });
    const promise = port.build({ ...base, restage: () => { throw new Error('the source graph is gone'); } });
    await flush();
    mock.workers[0].raise(new Error('worker died'));

    await expect(promise).rejects.toThrow(/re-staging for the inline retry failed/);
    await expect(promise).rejects.toThrow(/the source graph is gone/);
    port.dispose();
  });

  it('rejects when the inline retry throws too', async () => {
    const mock = makeMockWorkers();
    const port = createPickBuildPort({
      createWorker: mock.create,
      size: 1,
      // Budget 0 ⇒ the inline build yields at its first checkpoint, and this
      // yield explodes: the way to make the inline path fail deterministically.
      inlineSliceMs: 0,
      yieldToEventLoop: () => Promise.reject(new Error('main thread is gone')),
    });
    const promise = port.build(jobFor('chunk', 400));
    await flush();
    mock.workers[0].raise(new Error('worker died'));

    await expect(promise).rejects.toThrow(/failed in the worker .* AND in the inline retry/);
    await expect(promise).rejects.toThrow(/main thread is gone/);
    port.dispose();
  });

  it('leaks no job after failures — the pool keeps serving', async () => {
    const mock = makeMockWorkers();
    const port = createPickBuildPort({ createWorker: mock.create, size: 2 });
    const epoch = port.beginEpoch();
    const a = epoch.build(jobFor('a', 300));
    const b = epoch.build(jobFor('b', 400));
    const c = epoch.build(jobFor('c', 500));
    await flush();

    mock.workers[0].raise(new Error('boom')); // slot 0 retired, job a redone inline
    mock.workers[1].failBuild();              // slot 1 survives, job b redone inline
    // Awaiting is the only honest wait here: the inline retries yield through
    // real macrotasks, which a microtask flush does not drain.
    expect(expectOk(await a).viaWorker).toBe(false);
    expect(expectOk(await b).viaWorker).toBe(false);

    // The queued third job must have been handed to the surviving worker — a
    // leaked slot or a lost job would strand it here.
    await flush();
    const survivor = mock.workers.find((worker) => worker.pending > 0);
    expect(survivor, 'third job never reached the surviving worker').toBeDefined();
    survivor?.respond();
    expect(expectOk(await c).viaWorker).toBe(true);

    // And a brand-new job still completes afterwards.
    const d = port.build(jobFor('d', 300));
    await flush();
    mock.workers.find((worker) => worker.pending > 0)?.respond();
    expectOk(await d);
    port.dispose();
  });
});

// ─── Inline fallback ────────────────────────────────────────────────

describe('inline fallback', () => {
  it('runs everything inline when no worker can be created', async () => {
    const port = createPickBuildPort({ createWorker: () => null, size: 3 });
    const results = await Promise.all([port.build(jobFor('a', 400)), port.build(jobFor('b', 600))]);
    for (const result of results) {
      const ok = expectOk(result);
      expect(ok.viaWorker).toBe(false);
    }
    expect(port.stats.inlineJobs).toBe(2);
    expect(port.stats.retries).toBe(0); // an absent worker is not a failure
    expect(port.usesWorker).toBe(false);
    port.dispose();
  });

  it('keeps every inline slice inside the 50 ms contract', async () => {
    // Fake clock: every reading is 10 ms later than the previous one, so the
    // budget is crossed after a handful of checkpoints and the recorded slice
    // is exact rather than machine-dependent.
    let clock = 0;
    let yields = 0;
    const port = createPickBuildPort({
      createWorker: () => null,
      size: 1,
      inlineSliceMs: DEFAULT_INLINE_SLICE_MS,
      now: () => (clock += 10),
      yieldToEventLoop: async () => { yields++; },
    });
    // 3 segments well above one cluster ⇒ many checkpoints.
    const staged = stage(9000, 3);
    const result = expectOk(
      await port.build({ key: 'big', position: staged.position, index: staged.index, segments: staged.segments }),
    );
    expect(result.data.segmentCount).toBe(3);
    expect(yields).toBeGreaterThan(0);
    expect(port.stats.maxInlineSliceMs).toBeGreaterThan(0);
    expect(port.stats.maxInlineSliceMs).toBeLessThanOrEqual(50);
    port.dispose();
  });
});

// ─── Shared pool (plan P3) ──────────────────────────────────────────

describe('shared pool', () => {
  it('is one instance and can be disposed and re-created', async () => {
    disposeSharedPickBuildPort();
    const mock = makeMockWorkers();
    const first = getSharedPickBuildPort({ createWorker: mock.create, size: 1 });
    expect(getSharedPickBuildPort()).toBe(first);
    const promise = first.build(jobFor('chunk', 300));
    await flush();
    mock.workers[0].respond();
    expectOk(await promise);

    disposeSharedPickBuildPort();
    const second = getSharedPickBuildPort({ createWorker: mock.create, size: 1 });
    expect(second).not.toBe(first);
    disposeSharedPickBuildPort();
  });
});

// ─── The one real worker (plan §9.2) ────────────────────────────────

describe('real module worker', () => {
  it('produces byte-identical arrays to the inline build', async () => {
    const fixture = makePrimitiveAssembly();
    // Two independent copies: the port takes ownership of what it is given.
    const workerPosition = fixture.position.slice();
    const workerIndex = fixture.index.slice();
    const inlinePosition = fixture.position.slice();
    const inlineIndex = fixture.index.slice();

    const port = createPickBuildPort({ size: 1 });
    let result: PickBuildJobResult;
    try {
      result = await port.build({
        key: 'parity',
        position: workerPosition,
        index: workerIndex,
        segments: fixture.segments,
        restage: () => ({ position: fixture.position.slice(), index: fixture.index.slice() }),
      });
    } finally {
      port.dispose();
    }
    const ok = expectOk(result);
    // If this is false the module worker did not load — the parity claim below
    // would be vacuous (it would compare inline against inline).
    expect(ok.viaWorker).toBe(true);

    const reference = buildPickStructure(inlinePosition, inlineIndex, fixture.segments);

    expect(Array.from(ok.index)).toEqual(Array.from(reference.index));
    const d = ok.data;
    const r = reference.data;
    expect(d.segmentCount).toBe(r.segmentCount);
    expect(d.clusterCount).toBe(r.clusterCount);
    expect(d.treeNodeCount).toBe(r.treeNodeCount);
    expect(d.treeMaxDepth).toBe(r.treeMaxDepth);
    expect(d.treeRoot).toBe(r.treeRoot);
    expect(d.clusterTris).toBe(r.clusterTris);
    expect(d.triangleCount).toBe(r.triangleCount);
    expect(d.blocks).toBe(r.blocks);
    expect(d.doubleSided).toBe(r.doubleSided);
    for (const key of [
      'segNode', 'segOwner', 'segIndexStart', 'segIndexCount', 'segBox', 'segFirstCluster',
      'clusterBox', 'clusterSeg', 'clusterOrder', 'treeBox', 'treeLink',
    ] as const) {
      const a = d[key] as unknown as ArrayLike<number>;
      const b = r[key] as unknown as ArrayLike<number>;
      expect(a.length, key).toBe(b.length);
      let differences = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differences++;
      expect(differences, key).toBe(0);
    }
  }, 120_000);
});
