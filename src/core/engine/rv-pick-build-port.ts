// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-pick-build-port — the worker pool that builds pick structures
 * (plan-756, step 1b).
 *
 * Built to the two existing blueprints of this repo, not on top of them:
 * `rv-bvh-build-port.ts` contributes the shape (worker path / inline fallback /
 * injectable factory so vitest never spawns a real worker, plus
 * retire-and-continue-inline on a worker-level failure), `rv-mesh-merge-client.ts`
 * contributes the monotonic request id as an abort EPOCH and the "one function,
 * two callers" rule. What is new here is a POOL instead of a single sequential
 * worker, and a buffer-ownership contract strict enough to be zero-copy.
 *
 * ## Ownership — the one rule to remember
 *
 * A job HANDS OVER its `position` and `index` arrays. Between `build()` and the
 * resolved result nothing on the main thread may reference them: they are
 * transferred to a worker, which detaches them here. The result carries the
 * arrays BACK (the index permuted), and only those returned arrays may be
 * attached to a `BufferGeometry` (plan §2.4 "Buffer ownership window"). That is
 * why the API is shaped as give-and-get-back rather than build-in-place.
 *
 * ## What a dead worker costs
 *
 * Transferred buffers die with the worker that owned them. A job that wants to
 * survive that therefore supplies `restage()`: the callback re-produces the two
 * arrays (in the bake: re-run `stageChunk` for that one chunk) so the build can
 * be redone INLINE. Without `restage()` — or when the inline retry throws too —
 * the promise REJECTS with the chunk key in the message, which is what lets the
 * gated bake of step 1c surface a load error instead of awaiting forever
 * (plan §2.4a.8, risk R12). No path here waits without a bound: every worker
 * job carries a watchdog.
 *
 * ## Staleness
 *
 * An epoch is the abort unit. `epoch.abort()` (dispose, a superseded bake, an
 * asset thrown away) does NOT interrupt a running worker — nothing can — it only
 * decides that the answer is uninteresting. Such a job still returns its
 * buffers, the port drops them on the floor, and the caller gets
 * `{ status: 'stale' }` so it cannot accidentally publish them (risk R2).
 *
 * ## Inline fallback
 *
 * No `Worker` in the environment, or every pool worker retired: the build runs
 * on the main thread through `buildPickStructureAsync`, yielding to the event
 * loop whenever a time slice is spent. The slice budget is deliberately below
 * the plan's 50 ms so that budget + the work of one checkpoint stays clear of
 * the 100 ms main-thread gate (plan §2.4a.5).
 */

import {
  buildPickStructureAsync,
  type PickBuildOptions,
  type PickBuildStats,
  type PickSegmentInput,
} from './rv-pick-build';
import type { ChunkPickData } from './rv-pick-structure';

// ─── Wire protocol (shared with rv-pick-build-worker.ts) ─────────────

/** Build options that survive `postMessage` — everything but the hook. */
export type PickBuildWireOptions = Omit<PickBuildOptions, 'onYield'>;

/** Main thread → worker. `position` / `index` are TRANSFERRED, never copied. */
export interface PickBuildRequest {
  id: number;
  key: string;
  position: Float32Array;
  index: Uint32Array;
  segments: PickSegmentInput[];
  options: PickBuildWireOptions;
}

/** Worker → main thread. Both variants carry the buffers back. */
export type PickBuildResponse =
  | {
      id: number;
      key: string;
      ok: true;
      data: ChunkPickData;
      position: Float32Array;
      /** The SAME array the request carried — permuted in place. */
      index: Uint32Array;
      stats: PickBuildStats;
    }
  | {
      id: number;
      key: string;
      ok: false;
      error: string;
      /** Possibly HALF-PERMUTED — the port discards these and re-stages. */
      position?: Float32Array;
      index?: Uint32Array;
    };

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Message channel to one pool worker — injectable so the suite can drive the
 * pool deterministically without a real `Worker`.
 */
export interface PickBuildWorkerPort {
  postMessage(message: PickBuildRequest, transfer: Transferable[]): void;
  onMessage(callback: (message: PickBuildResponse) => void): void;
  /** `error` and `messageerror` both land here — both are fatal for the worker. */
  onError(callback: (reason: unknown) => void): void;
  terminate(): void;
}

/** One chunk of work. The arrays are handed over — see the ownership rule above. */
export interface PickBuildJob {
  /** Chunk key; appears in errors and `performance.measure` details. */
  key: string;
  position: Float32Array;
  index: Uint32Array;
  segments: readonly PickSegmentInput[];
  options?: PickBuildWireOptions;
  /**
   * Re-produce `position` / `index` after a worker died with them. Without it a
   * worker failure is unrecoverable and the job rejects.
   */
  restage?: () => { position: Float32Array; index: Uint32Array };
}

export type PickBuildJobResult =
  | {
      status: 'ok';
      key: string;
      data: ChunkPickData;
      /** Attach THESE to the geometry — the originals are detached. */
      position: Float32Array;
      index: Uint32Array;
      stats: PickBuildStats;
      /** False when the job ran (or was retried) on the main thread. */
      viaWorker: boolean;
    }
  | { status: 'stale'; key: string };

/** Abort unit: one epoch per bake. */
export interface PickBuildEpoch {
  readonly id: number;
  readonly stale: boolean;
  build(job: PickBuildJob): Promise<PickBuildJobResult>;
  /** Everything of this epoch resolves `stale`; running workers are not killed. */
  abort(): void;
}

export interface PickBuildPortStats {
  /** Jobs completed off-thread. */
  workerJobs: number;
  /** Jobs completed on the main thread (no worker, or a retry). */
  inlineJobs: number;
  /** Worker failures that led to an inline retry. */
  retries: number;
  /** Workers retired after `error` / `messageerror` / watchdog. */
  retiredWorkers: number;
  /** Longest uninterrupted main-thread slice of an inline build, in ms. */
  maxInlineSliceMs: number;
}

export interface PickBuildPort {
  /** Worker slots (never more than one inline build runs at a time). */
  readonly size: number;
  /** False once the environment has no `Worker` or every worker retired. */
  readonly usesWorker: boolean;
  readonly stats: PickBuildPortStats;
  beginEpoch(): PickBuildEpoch;
  /** Convenience for a caller with no lifetime of its own (never goes stale). */
  build(job: PickBuildJob): Promise<PickBuildJobResult>;
  dispose(): void;
}

export interface PickBuildPortOptions {
  /**
   * Creates one worker transport, or `null` to force the inline path. THE test
   * seam (plan §2.2): vitest injects a mock here and never spawns a `Worker`.
   *
   * Note this is deliberately finer-grained than `createBVHPort(factory)`, which
   * replaces the whole port: pool sizing, largest-first ordering, the watchdog
   * and the inline retry are precisely what has to be tested, and a port-level
   * mock would test none of them.
   */
  createWorker?: () => PickBuildWorkerPort | null;
  /** Worker slots. Default `clamp(hardwareConcurrency − 1, 1, 4)`. */
  size?: number;
  /** Per-job worker watchdog. Default 30 000 ms. */
  watchdogMs?: number;
  /** Main-thread slice budget of the inline path. Default 40 ms. */
  inlineSliceMs?: number;
  /** Clock seam (fake clock in tests). Default `performance.now`. */
  now?: () => number;
  /** Event-loop yield of the inline path. Default: `scheduler.yield` → MessageChannel → `setTimeout(0)`. */
  yieldToEventLoop?: () => Promise<void>;
  /** Timer seam for the watchdog. Default `setTimeout` / `clearTimeout`. */
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Plan §2.4: `clamp(hardwareConcurrency − 1, 1, 4)`. */
export const MAX_PICK_BUILD_WORKERS = 4;

/**
 * `clamp(cores − 1, 1, MAX_PICK_BUILD_WORKERS)`, robust against the values
 * `navigator.hardwareConcurrency` really produces (0, `undefined`, NaN).
 *
 * `hardwareConcurrency` is an UPPER bound that Apple devices under-report, so it
 * is never treated as a promise of parallelism: one core is left to the main
 * thread and the whole thing is capped at four.
 */
export function clampPickBuildPoolSize(cores: number): number {
  const usable = Math.floor(cores) - 1;
  if (!Number.isFinite(usable) || usable < 1) return 1;
  return Math.min(usable, MAX_PICK_BUILD_WORKERS);
}

/** Default pool size, read from `navigator.hardwareConcurrency`. */
export function defaultPickBuildPoolSize(): number {
  return clampPickBuildPoolSize(typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? 0) : 0);
}

/** Default slice budget of the inline path — below the plan's 50 ms on purpose. */
export const DEFAULT_INLINE_SLICE_MS = 40;

/** Default per-job watchdog (plan §2.4a.8). */
export const DEFAULT_PICK_WATCHDOG_MS = 30_000;

// ─── Internals ──────────────────────────────────────────────────────

interface Slot {
  transport: PickBuildWorkerPort | null;
  /** True once this slot's worker was retired — it never gets another job. */
  dead: boolean;
  job: QueuedJob | null;
  watchdog: unknown;
}

interface QueuedJob {
  id: number;
  key: string;
  job: PickBuildJob;
  epoch: EpochImpl;
  /** Sort key of the largest-first queue. */
  triangles: number;
  /** Current owner-side arrays; `null` once transferred to a worker. */
  position: Float32Array | null;
  index: Uint32Array | null;
  startedAt: number;
  settled: boolean;
  resolve: (result: PickBuildJobResult) => void;
  reject: (reason: unknown) => void;
}

class EpochImpl implements PickBuildEpoch {
  stale = false;
  constructor(
    readonly id: number,
    private readonly pool: PickBuildPool,
  ) {}

  build(job: PickBuildJob): Promise<PickBuildJobResult> {
    return this.pool.submit(job, this);
  }

  abort(): void {
    if (this.stale) return;
    this.stale = true;
    this.pool.dropQueued(this);
  }
}

class PickBuildPool implements PickBuildPort {
  readonly size: number;
  readonly stats: PickBuildPortStats = {
    workerJobs: 0,
    inlineJobs: 0,
    retries: 0,
    retiredWorkers: 0,
    maxInlineSliceMs: 0,
  };

  private readonly createWorker: () => PickBuildWorkerPort | null;
  private readonly watchdogMs: number;
  private readonly inlineSliceMs: number;
  private readonly now: () => number;
  private readonly yieldHook: () => Promise<void>;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private readonly slots: Slot[] = [];
  private readonly queue: QueuedJob[] = [];
  private nextId = 1;
  private nextEpochId = 1;
  /** No worker can be had any more (environment or every slot retired). */
  private inlineOnly = false;
  /** Inline builds in flight (queued ones included). */
  private inlineActive = 0;
  /**
   * Serialises main-thread builds. Two inline builds interleaving would each
   * still be correct — they own separate arrays — but they would double the
   * main-thread cost per slice, and the 100 ms gate is stated per thread, not
   * per build. Failure retries go through the same chain as ordinary inline
   * work, which is why this is a lock and not just the `inlineActive` counter.
   */
  private inlineChain: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly evergreen: EpochImpl;

  constructor(options: PickBuildPortOptions = {}) {
    this.createWorker = options.createWorker ?? defaultCreateWorkerPort;
    this.size = Math.max(1, Math.floor(options.size ?? defaultPickBuildPoolSize()));
    this.watchdogMs = options.watchdogMs ?? DEFAULT_PICK_WATCHDOG_MS;
    this.inlineSliceMs = options.inlineSliceMs ?? DEFAULT_INLINE_SLICE_MS;
    this.now = options.now ?? (() => performance.now());
    this.yieldHook = options.yieldToEventLoop ?? yieldToEventLoop;
    this.setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    for (let i = 0; i < this.size; i++) this.slots.push({ transport: null, dead: false, job: null, watchdog: null });
    this.evergreen = new EpochImpl(0, this);
  }

  get usesWorker(): boolean {
    return !this.inlineOnly && typeof Worker !== 'undefined';
  }

  /** True while the main thread is building (or about to build). */
  private get inlineBusy(): boolean {
    return this.inlineActive > 0;
  }

  beginEpoch(): PickBuildEpoch {
    return new EpochImpl(this.nextEpochId++, this);
  }

  build(job: PickBuildJob): Promise<PickBuildJobResult> {
    return this.submit(job, this.evergreen);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.evergreen.stale = true;
    // Queued work is abandoned, never rejected: dispose() is a normal teardown
    // and must not turn into an unhandled rejection in whoever awaited a build.
    for (const queued of this.queue.splice(0)) settleStale(queued);
    for (const slot of this.slots) {
      this.clearWatchdog(slot);
      if (slot.job) settleStale(slot.job);
      slot.job = null;
      slot.dead = true;
      try {
        slot.transport?.terminate();
      } catch {
        /* ignore */
      }
      slot.transport = null;
    }
  }

  // ── submission / scheduling ──────────────────────────────────────

  submit(job: PickBuildJob, epoch: EpochImpl): Promise<PickBuildJobResult> {
    const triangles = Math.floor(job.index.length / 3);
    return new Promise<PickBuildJobResult>((resolve, reject) => {
      const queued: QueuedJob = {
        id: this.nextId++,
        key: job.key,
        job,
        epoch,
        triangles,
        position: job.position,
        index: job.index,
        startedAt: this.now(),
        settled: false,
        resolve,
        reject,
      };
      // Disposed or already-stale work is answered without ever queueing — the
      // handed-over arrays are simply dropped, which is what "returns its
      // buffers, the client discards them" means before a transfer happened.
      if (this.disposed || epoch.stale) {
        settleStale(queued);
        return;
      }
      this.queue.push(queued);
      this.pump();
    });
  }

  /** Answer everything of an aborted epoch that has not started yet. */
  dropQueued(epoch: EpochImpl): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].epoch === epoch) settleStale(this.queue.splice(i, 1)[0]);
    }
  }

  /**
   * Start whatever can start. The main thread is NOT an overflow lane: as long
   * as a worker exists, a job waits for a free slot rather than competing with
   * rendering. Inline runs only when no worker can be had at all (no `Worker`
   * in the environment, or every slot retired) — or as the retry of a failure.
   */
  private pump(): void {
    if (this.disposed) return;
    while (this.queue.length > 0) {
      if (!this.inlineOnly) {
        // Every worker busy — the next completion pumps again.
        if (!this.hasFreeSlot()) return;
        const queued = this.takeLargest();
        if (queued.epoch.stale) {
          settleStale(queued);
          continue;
        }
        const slot = this.acquireSlot();
        if (slot) {
          this.dispatchToWorker(slot, queued);
          continue;
        }
        // A slot just turned out to be unusable (worker creation failed). Put
        // the job back and re-decide: another slot may still work, or the pool
        // has now collapsed to inline-only.
        this.queue.push(queued);
        continue;
      }
      if (this.inlineBusy) return;
      const queued = this.takeLargest();
      if (queued.epoch.stale) {
        settleStale(queued);
        continue;
      }
      // `runInline` sets `inlineBusy` synchronously before its first await, so
      // the next loop turn already sees the main thread as taken.
      void this.runInline(queued, queued.position, queued.index, false);
    }
  }

  /** Largest job first (plan §2.4): the one chunk that dominates a bake starts first. */
  private takeLargest(): QueuedJob {
    let best = 0;
    for (let i = 1; i < this.queue.length; i++) {
      if (this.queue[i].triangles > this.queue[best].triangles) best = i;
    }
    return this.queue.splice(best, 1)[0];
  }

  private hasFreeSlot(): boolean {
    return this.slots.some((slot) => !slot.dead && slot.job === null);
  }

  /** A free slot with a live transport, lazily started. `null` ⇒ go inline. */
  private acquireSlot(): Slot | null {
    for (const slot of this.slots) {
      if (slot.dead || slot.job !== null) continue;
      if (!slot.transport) {
        let transport: PickBuildWorkerPort | null = null;
        try {
          transport = this.createWorker();
        } catch (err) {
          console.warn('[PickBuildPort] worker creation failed — using inline builds:', err);
          transport = null;
        }
        if (!transport) {
          // No worker to be had at all: the whole pool is inline from now on.
          slot.dead = true;
          if (this.slots.every((s) => s.dead)) this.inlineOnly = true;
          continue;
        }
        transport.onMessage((message) => this.onResponse(slot, message));
        transport.onError((reason) => this.failSlot(slot, reason));
        slot.transport = transport;
      }
      return slot;
    }
    return null;
  }

  private dispatchToWorker(slot: Slot, queued: QueuedJob): void {
    const transport = slot.transport;
    if (!transport) {
      void this.runInline(queued, queued.position, queued.index, false);
      return;
    }
    const position = queued.position;
    const index = queued.index;
    if (!position || !index) {
      queued.reject(new Error(`[PickBuildPort] chunk "${queued.key}": no buffers to build from`));
      queued.settled = true;
      return;
    }
    const request: PickBuildRequest = {
      id: queued.id,
      key: queued.key,
      position,
      index,
      segments: queued.job.segments as PickSegmentInput[],
      options: queued.job.options ?? {},
    };
    slot.job = queued;
    queued.startedAt = this.now();
    // Ownership leaves the main thread HERE — drop our references first, so a
    // later code path cannot read a detached buffer even by accident.
    queued.position = null;
    queued.index = null;
    slot.watchdog = this.setTimer(() => this.failSlot(slot, new Error('watchdog timeout')), this.watchdogMs);
    try {
      transport.postMessage(request, [position.buffer as ArrayBuffer, index.buffer as ArrayBuffer]);
    } catch (err) {
      // postMessage threw — the buffers were NOT transferred, but the worker is
      // not trustworthy either. Retire it and keep the arrays for the retry.
      queued.position = position;
      queued.index = index;
      this.failSlot(slot, err);
    }
  }

  private clearWatchdog(slot: Slot): void {
    if (slot.watchdog !== null) {
      this.clearTimer(slot.watchdog);
      slot.watchdog = null;
    }
  }

  // ── worker outcomes ──────────────────────────────────────────────

  private onResponse(slot: Slot, message: PickBuildResponse): void {
    const queued = slot.job;
    if (!queued || queued.id !== message.id) return; // late answer of a retired job
    this.clearWatchdog(slot);
    slot.job = null;

    if (!message.ok) {
      // The build itself threw in the worker. The index may be half-permuted,
      // so the returned arrays are unusable — same recovery as a dead worker,
      // but the worker stays alive (it is not the worker that is broken).
      this.finishJob(() => this.recoverInline(queued, new Error(message.error)));
      return;
    }
    if (queued.epoch.stale) {
      // The buffers came back and are dropped here, deliberately: nothing may
      // be published from a superseded bake (plan risk R2).
      settleStale(queued);
      this.measure(queued, 'worker-stale');
      this.pump();
      return;
    }
    this.stats.workerJobs++;
    this.measure(queued, 'worker');
    settleOk(queued, message.data, message.position, message.index, message.stats, true);
    this.pump();
  }

  /** `error` / `messageerror` / watchdog — all systemic, all retire the worker. */
  private failSlot(slot: Slot, reason: unknown): void {
    this.clearWatchdog(slot);
    const queued = slot.job;
    slot.job = null;
    if (!slot.dead) {
      slot.dead = true;
      this.stats.retiredWorkers++;
      console.warn('[PickBuildPort] worker retired — continuing inline:', reason);
      try {
        slot.transport?.terminate();
      } catch {
        /* ignore */
      }
      slot.transport = null;
      if (this.slots.every((s) => s.dead)) this.inlineOnly = true;
    }
    if (queued) this.finishJob(() => this.recoverInline(queued, reason));
    else this.pump();
  }

  /**
   * Redo a failed job on the main thread. The transferred buffers are gone, so
   * the job's `restage()` has to produce them again; without it (or when the
   * inline build throws too) this is where the promise rejects.
   */
  private async recoverInline(queued: QueuedJob, reason: unknown): Promise<void> {
    if (queued.settled) return;
    if (this.disposed || queued.epoch.stale) {
      settleStale(queued);
      return;
    }
    this.stats.retries++;
    let position = queued.position;
    let index = queued.index;
    if (!position || !index) {
      const restage = queued.job.restage;
      if (!restage) {
        queued.settled = true;
        queued.reject(
          new Error(
            `[PickBuildPort] pick build of chunk "${queued.key}" failed in the worker ` +
              `(${describe(reason)}) and its buffers were transferred away — ` +
              `the job supplied no restage() callback, so it cannot be redone inline`,
          ),
        );
        return;
      }
      try {
        const staged = restage();
        position = staged.position;
        index = staged.index;
      } catch (err) {
        queued.settled = true;
        queued.reject(
          new Error(
            `[PickBuildPort] pick build of chunk "${queued.key}" failed in the worker ` +
              `(${describe(reason)}) and re-staging for the inline retry failed too: ${describe(err)}`,
          ),
        );
        return;
      }
    }
    await this.runInline(queued, position, index, true, reason);
  }

  /** Run a recovery to its end and keep the pump going afterwards, either way. */
  private finishJob(run: () => Promise<void>): void {
    void run().then(
      () => this.pump(),
      () => this.pump(),
    );
  }

  private async runInline(
    queued: QueuedJob,
    position: Float32Array | null,
    index: Uint32Array | null,
    isRetry: boolean,
    originalReason?: unknown,
  ): Promise<void> {
    if (queued.settled) return;
    if (!position || !index) {
      queued.settled = true;
      queued.reject(new Error(`[PickBuildPort] chunk "${queued.key}": no buffers to build from`));
      return;
    }
    this.inlineActive++;
    const prior = this.inlineChain;
    let releaseLock!: () => void;
    this.inlineChain = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let lastYield = 0;
    try {
      await prior;
      queued.startedAt = this.now();
      lastYield = this.now();
      const result = await buildPickStructureAsync(position, index, queued.job.segments, {
        ...(queued.job.options ?? {}),
        onYield: async () => {
          const elapsed = this.now() - lastYield;
          if (elapsed < this.inlineSliceMs) return;
          if (elapsed > this.stats.maxInlineSliceMs) this.stats.maxInlineSliceMs = elapsed;
          await this.yieldHook();
          lastYield = this.now();
        },
      });
      const tail = this.now() - lastYield;
      if (tail > this.stats.maxInlineSliceMs) this.stats.maxInlineSliceMs = tail;
      this.measure(queued, isRetry ? 'inline-retry' : 'inline');
      if (this.disposed || queued.epoch.stale) {
        settleStale(queued);
        return;
      }
      this.stats.inlineJobs++;
      settleOk(queued, result.data, position, result.index, result.stats, false);
    } catch (err) {
      queued.settled = true;
      if (isRetry) {
        queued.reject(
          new Error(
            `[PickBuildPort] pick build of chunk "${queued.key}" failed in the worker ` +
              `(${describe(originalReason)}) AND in the inline retry: ${describe(err)}`,
          ),
        );
      } else {
        queued.reject(
          new Error(`[PickBuildPort] inline pick build of chunk "${queued.key}" failed: ${describe(err)}`),
        );
      }
    } finally {
      this.inlineActive--;
      releaseLock();
      if (!isRetry) this.pump();
    }
  }

  /** One `rv:pick.build` measure per job — the perf harness reads these (R10 aside). */
  private measure(queued: QueuedJob, path: string): void {
    try {
      performance.measure('rv:pick.build', {
        start: queued.startedAt,
        detail: { key: queued.key, path, triangles: queued.triangles },
      });
    } catch {
      /* measures are diagnostics — never let one fail a build */
    }
  }
}

function settleOk(
  queued: QueuedJob,
  data: ChunkPickData,
  position: Float32Array,
  index: Uint32Array,
  stats: PickBuildStats,
  viaWorker: boolean,
): void {
  if (queued.settled) return;
  queued.settled = true;
  queued.position = null;
  queued.index = null;
  queued.resolve({ status: 'ok', key: queued.key, data, position, index, stats, viaWorker });
}

function settleStale(queued: QueuedJob): void {
  if (queued.settled) return;
  queued.settled = true;
  // Drop the arrays here — a stale job never hands geometry back to anyone.
  queued.position = null;
  queued.index = null;
  queued.resolve({ status: 'stale', key: queued.key });
}

function describe(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  try {
    return JSON.stringify(reason) ?? String(reason);
  } catch {
    return String(reason);
  }
}

interface SchedulerLike {
  yield?: () => Promise<void>;
}

/**
 * Yield one turn to the event loop: `scheduler.yield()` where it exists (it
 * resumes with priority, so a long build does not lose its slot), otherwise a
 * MessageChannel macrotask (`setTimeout(0)` is clamped to 4 ms+), otherwise
 * `setTimeout(0)` as the last resort.
 */
function yieldToEventLoop(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: SchedulerLike }).scheduler;
  if (scheduler && typeof scheduler.yield === 'function') {
    return scheduler.yield();
  }
  if (typeof MessageChannel !== 'undefined') {
    return new Promise<void>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(null);
    });
  }
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Real ES module worker, or `null` when the environment has none. */
function defaultCreateWorkerPort(): PickBuildWorkerPort | null {
  if (typeof Worker === 'undefined') return null;
  // Literal form on purpose: Vite only bundles `new Worker(new URL('./x.ts',
  // import.meta.url), { type: 'module' })`. Same shape as the signature-verify
  // worker, which is why it is emitted into `dist-embed` (CONNECT) unchanged.
  const worker = new Worker(new URL('./rv-pick-build-worker.ts', import.meta.url), { type: 'module' });
  let onMessage: ((message: PickBuildResponse) => void) | null = null;
  let onError: ((reason: unknown) => void) | null = null;
  worker.onmessage = (ev: MessageEvent) => onMessage?.(ev.data as PickBuildResponse);
  worker.onerror = (ev: ErrorEvent) => onError?.(ev.message ? new Error(ev.message) : ev);
  worker.onmessageerror = () => onError?.(new Error('worker messageerror (uncloneable message)'));
  return {
    postMessage: (message, transfer) => worker.postMessage(message, transfer),
    onMessage: (callback) => {
      onMessage = callback;
    },
    onError: (callback) => {
      onError = callback;
    },
    terminate: () => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    },
  };
}

// ─── Construction ───────────────────────────────────────────────────

/** Create an OWN pool. Production code wants `getSharedPickBuildPort()`. */
export function createPickBuildPort(options: PickBuildPortOptions = {}): PickBuildPort {
  return new PickBuildPool(options);
}

let sharedPort: PickBuildPool | null = null;

/**
 * The ONE pool every bake shares (plan P3). `ModelCache._sharedBake` dedupes per
 * asset but has no cross-asset cap, so a per-bake pool would spawn a set of
 * workers per dragged library asset.
 *
 * `options` are honoured only when the pool is actually created — a later caller
 * cannot resize the running pool.
 */
export function getSharedPickBuildPort(options: PickBuildPortOptions = {}): PickBuildPort {
  if (!sharedPort) sharedPort = new PickBuildPool(options);
  return sharedPort;
}

/** Terminate the shared pool (viewer teardown, HMR, tests). */
export function disposeSharedPickBuildPort(): void {
  sharedPort?.dispose();
  sharedPort = null;
}

// HMR would otherwise leave a set of pool workers alive per edit (plan risk R10).
// Dev-only path: `import.meta.hot` does not exist in a production bundle.
if (import.meta.hot) {
  import.meta.hot.dispose(() => disposeSharedPickBuildPort());
}
