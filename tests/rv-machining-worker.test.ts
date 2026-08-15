// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-machining-worker.test.ts — plan-405 test 9.3.
 *
 * The worker PROTOCOL, driven directly (no `Worker`, no WASM) with the
 * {@link VoxelMockKernel} and a manual scheduler — pattern:
 * `rv-mesh-merge-worker`'s exported body.
 *
 * Covered: strict sequence ordering, the 16-chunk tessellation budget, the
 * backlog cap of the provider, segment-list coalescing INCLUDING the curved-path
 * parity assertion (and its counter-proof that a chord would differ), the reset
 * barrier, the idle ack, epoch/generation guards and idempotent `destroyGrid`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CsgWorkerBody,
  MAX_SEGMENTS_PER_JOB,
  TESSELLATE_BUDGET,
  degradeSubsteps,
  type CsgWorkerResponse,
} from '@rv-private/machining/rv-csg-worker-body';
import { CsgMachiningProvider, type CsgWorkerPort } from '@rv-private/machining/rv-csg-provider';
import type { CsgToolSegment } from '@rv-private/machining/rv-csg-kernel';
import { MACHINING_MAX_PENDING_JOBS } from '../src/core/engine/rv-machining-registry';
import { VoxelMockKernel, mockGridDesc, segment, type MockGrid } from './rv-machining-mocks';

/**
 * Drives a {@link CsgWorkerBody} with a MANUAL scheduler instead of
 * `queueMicrotask`, so every pump turn happens exactly where the test says it
 * does. The callback must really be invoked (not just flagged): the body clears
 * its own `pumpScheduled` latch inside it, and skipping that would silently
 * swallow every follow-up turn.
 */
class Harness {
  readonly kernel = new VoxelMockKernel();
  readonly messages: CsgWorkerResponse[] = [];
  readonly body: CsgWorkerBody;
  private _next: (() => void) | null = null;

  constructor() {
    this.body = new CsgWorkerBody(
      this.kernel,
      (msg) => { this.messages.push(msg); },
      (run) => { this._next = run; },
    );
  }

  /** Runs the pump until it stops asking for another turn (bounded). */
  drain(maxTurns = 500): void {
    let turns = 0;
    while (this._next && turns++ < maxTurns) {
      const run = this._next;
      this._next = null;
      run();
    }
    expect(turns).toBeLessThan(maxTurns);
  }

  /** Runs exactly one pump turn, if one is scheduled. */
  step(): void {
    const run = this._next;
    this._next = null;
    run?.();
  }

  of<T extends CsgWorkerResponse['t']>(t: T): Array<Extract<CsgWorkerResponse, { t: T }>> {
    return this.messages.filter((m) => m.t === t) as Array<Extract<CsgWorkerResponse, { t: T }>>;
  }

  createGrid(): number {
    this.body.handle({ t: 'createGrid', rid: 1, desc: mockGridDesc() });
    const created = this.of('gridCreated');
    expect(created).toHaveLength(1);
    return created[0].grid.id;
  }
}

/** Centre of the mock grid in grid space. */
function centre(): [number, number, number] {
  return [50 + 1.5 * (100 / 29), 30 + 1.5 * (60 / 29), 40 + 1.5 * (80 / 29)];
}

describe('CsgWorkerBody — ordering and budgets (plan-405 §9.3)', () => {
  let h: Harness;
  let gridId: number;

  beforeEach(() => {
    h = new Harness();
    gridId = h.createGrid();
  });

  it('reports the created grid with the derived lattice geometry', () => {
    const info = h.of('gridCreated')[0].grid;
    expect(info.resolution).toEqual({ x: 32, y: 32, z: 32 });
    expect(info.chunkResolution).toEqual({ x: 2, y: 2, z: 2 });
    expect(info.chunkCount).toBe(8);
    expect(info.totalVoxels).toBe(32 * 32 * 32);
    expect(info.initialSolidVoxels).toBe(32 * 32 * 32);
  });

  it('processes jobs strictly in sequence order, one per pump turn', () => {
    const c = centre();
    for (let seq = 1; seq <= 4; seq++) {
      h.body.handle({
        t: 'subtract', gridId, gen: 0, seq,
        segments: [segment(c, [c[0] + seq, c[1], c[2]])],
      });
    }
    h.drain();
    const acks = h.of('ack').filter((a) => a.seq >= 0);
    expect(acks.map((a) => a.seq)).toEqual([1, 2, 3, 4]);
    // pendingJobs must count DOWN as the queue drains.
    expect(acks.map((a) => a.pendingJobs)).toEqual([3, 2, 1, 0]);
  });

  it('never tessellates more than the 16-chunk budget per turn', () => {
    // The fresh grid marks all 8 chunks dirty; force > 16 by using a bigger grid.
    const big = new Harness();
    big.body.handle({
      t: 'createGrid', rid: 1,
      desc: mockGridDesc({ resolution: { x: 96, y: 96, z: 96 } }),
    });
    big.drain();
    expect(big.kernel.tessellateCalls.length).toBeGreaterThan(1);
    for (const batch of big.kernel.tessellateCalls) {
      expect(batch.length).toBeLessThanOrEqual(TESSELLATE_BUDGET);
    }
    // Every chunk of the 6×6×6 lattice is tessellated exactly once.
    const all = big.kernel.tessellateCalls.flat();
    expect(new Set(all).size).toBe(216);
    expect(all).toHaveLength(216);
  });

  it('emits exactly one idle ack after both queues drain', () => {
    const c = centre();
    h.body.handle({ t: 'subtract', gridId, gen: 0, seq: 1, segments: [segment(c, c)] });
    h.drain();

    const idle = h.of('ack').filter((a) => a.seq < 0);
    expect(idle).toHaveLength(1);
    expect(idle[0]).toMatchObject({ pendingJobs: 0, pendingChunks: 0, removedVoxels: 0 });

    // The idle ack is the LAST ack — MachiningActive must fall, not flicker.
    const acks = h.of('ack');
    expect(acks[acks.length - 1].seq).toBe(-1);

    // Pumping again produces no second idle ack (one per busy→idle transition).
    h.step();
    expect(h.of('ack').filter((a) => a.seq < 0)).toHaveLength(1);
  });

  it('deduplicates a chunk that is re-dirtied while it waits in the queue', () => {
    h.drain(); // initial full build
    h.kernel.tessellateCalls.length = 0;
    const c = centre();
    // Two jobs hitting the same chunk before the queue is pumped.
    h.body.handle({ t: 'subtract', gridId, gen: 0, seq: 1, segments: [segment(c, c)] });
    h.body.handle({ t: 'subtract', gridId, gen: 0, seq: 2, segments: [segment(c, c)] });
    h.drain();
    for (const batch of h.kernel.tessellateCalls) {
      expect(new Set(batch).size).toBe(batch.length);
    }
  });

  it('destroyGrid is idempotent and frees the grid exactly once', () => {
    h.body.handle({ t: 'destroyGrid', rid: 10, gridId });
    h.body.handle({ t: 'destroyGrid', rid: 11, gridId });
    h.body.handle({ t: 'destroyGrid', rid: 12, gridId: 9999 });
    expect(h.of('done').map((d) => d.rid)).toEqual([10, 11, 12]);
    expect(h.of('error')).toHaveLength(0);
    expect(h.kernel.destroyed).toEqual([gridId]);
    expect(h.body.gridCount).toBe(0);
  });

  it('drops jobs for a destroyed grid without acking them', () => {
    h.drain();
    h.body.handle({ t: 'destroyGrid', rid: 10, gridId });
    const before = h.of('ack').length;
    h.body.handle({ t: 'subtract', gridId, gen: 0, seq: 99, segments: [segment(centre(), centre())] });
    h.drain();
    expect(h.of('ack').length).toBe(before);
  });

  it('turns a kernel trap into a fatal message instead of continuing', () => {
    h.drain();
    h.kernel.throwOnNextSubtract = 'rvc_subtract failed (rv_csg code -1)';
    h.body.handle({ t: 'subtract', gridId, gen: 0, seq: 1, segments: [segment(centre(), centre())] });
    h.drain();
    const fatal = h.of('fatal');
    expect(fatal).toHaveLength(1);
    expect(fatal[0].message).toContain('rv_csg code -1');
  });
});

describe('CsgWorkerBody — reset barrier and generations (plan-405 §9.3)', () => {
  it('discards queued jobs, rebuilds the stock and only then reports done', () => {
    const h = new Harness();
    const gridId = h.createGrid();
    h.drain();

    const c = centre();
    // Queue three jobs WITHOUT pumping, then reset.
    for (let seq = 1; seq <= 3; seq++) {
      h.body.handle({ t: 'subtract', gridId, gen: 0, seq, segments: [segment(c, c)] });
    }
    expect(h.body.depths(gridId)).toEqual({ jobs: 3, chunks: 0 });

    h.messages.length = 0;
    h.body.handle({ t: 'resetGrid', rid: 50, gridId });

    // The stock is already rebuilt when `done` goes out — that is the barrier.
    expect(h.kernel.resets).toEqual([gridId]);
    expect(h.of('done').map((d) => d.rid)).toEqual([50]);
    expect(h.body.depths(gridId)!.jobs).toBe(0);
    // ... and all chunks are re-queued for the fresh surface.
    expect(h.body.depths(gridId)!.chunks).toBe(8);

    h.drain();
    // No ack for the discarded jobs.
    expect(h.of('ack').filter((a) => a.seq > 0)).toHaveLength(0);
  });

  it('ignores subtract jobs from a stale generation', () => {
    const h = new Harness();
    const gridId = h.createGrid();
    h.drain();
    h.body.handle({ t: 'resetGrid', rid: 1, gridId });
    h.drain();
    h.messages.length = 0;

    h.body.handle({ t: 'subtract', gridId, gen: 0, seq: 1, segments: [segment(centre(), centre())] });
    h.drain();
    expect(h.of('ack')).toHaveLength(0);

    h.body.handle({ t: 'subtract', gridId, gen: 1, seq: 1, segments: [segment(centre(), centre())] });
    h.drain();
    expect(h.of('ack').filter((a) => a.seq >= 0)).toHaveLength(1);
  });

  it('bumps the epoch on reset so older chunk batches are recognisable as stale', () => {
    const h = new Harness();
    const gridId = h.createGrid();
    h.drain();
    const before = h.of('chunks').map((c) => c.epoch);
    expect(new Set(before)).toEqual(new Set([0]));

    h.body.handle({ t: 'resetGrid', rid: 1, gridId });
    h.drain();
    const after = h.of('chunks').slice(before.length).map((c) => c.epoch);
    expect(after.every((e) => e === 1)).toBe(true);
  });

  it('reports an error for a reset of an unknown grid', () => {
    const h = new Harness();
    h.body.handle({ t: 'resetGrid', rid: 7, gridId: 4242 });
    expect(h.of('error')).toHaveLength(1);
    expect(h.of('error')[0].rid).toBe(7);
  });
});

describe('segment-list coalescing (plan-405 R2-3, §9.3)', () => {
  /**
   * The load-bearing assertion of the whole backpressure design: coalescing a
   * backlog must keep a CURVED path curved. Applied as one job with two segments,
   * A→B→C must remove exactly what two separate ticks remove — and demonstrably
   * NOT what the chord A→C removes.
   */
  it('a coalesced curved path equals the un-coalesced tick sequence', () => {
    const c = centre();
    const a: [number, number, number] = [c[0] - 20, c[1], c[2] - 12];
    const b: [number, number, number] = [c[0], c[1], c[2] + 14];
    const d: [number, number, number] = [c[0] + 20, c[1], c[2] - 12];

    // (1) two ticks
    const seqH = new Harness();
    const seqGrid = seqH.createGrid();
    seqH.drain();
    seqH.body.handle({ t: 'subtract', gridId: seqGrid, gen: 0, seq: 1, segments: [segment(a, b)] });
    seqH.drain();
    seqH.body.handle({ t: 'subtract', gridId: seqGrid, gen: 0, seq: 2, segments: [segment(b, d)] });
    seqH.drain();
    const seqSolid = seqH.kernel.countSolid(gridOf(seqH, seqGrid));

    // (2) ONE coalesced job carrying both segments, in order
    const coH = new Harness();
    const coGrid = coH.createGrid();
    coH.drain();
    coH.body.handle({
      t: 'subtract', gridId: coGrid, gen: 0, seq: 1,
      segments: [segment(a, b), segment(b, d)],
    });
    coH.drain();
    const coSolid = coH.kernel.countSolid(gridOf(coH, coGrid));

    expect(coSolid).toBe(seqSolid);

    // (3) counter-proof: the chord must NOT match — otherwise this test would
    // pass even for a protocol that collapsed the path to start/end.
    const chordH = new Harness();
    const chordGrid = chordH.createGrid();
    chordH.drain();
    chordH.body.handle({
      t: 'subtract', gridId: chordGrid, gen: 0, seq: 1, segments: [segment(a, d)],
    });
    chordH.drain();
    expect(chordH.kernel.countSolid(gridOf(chordH, chordGrid))).not.toBe(seqSolid);
  });

  it('preserves rotation waypoints of a rotating sweep', () => {
    const c = centre();
    const q = (deg: number): { x: number; y: number; z: number; w: number } => {
      const half = (deg * Math.PI) / 360;
      return { x: 0, y: 0, z: Math.sin(half), w: Math.cos(half) };
    };
    const h = new Harness();
    const gridId = h.createGrid();
    h.drain();
    h.kernel.subtractCalls.length = 0;
    h.body.handle({
      t: 'subtract', gridId, gen: 0, seq: 1,
      segments: [
        segment(c, [c[0] + 10, c[1], c[2]], { rotStart: q(0), rotEnd: q(30) }),
        segment([c[0] + 10, c[1], c[2]], [c[0] + 20, c[1], c[2]], { rotStart: q(30), rotEnd: q(60) }),
      ],
    });
    h.drain();
    const call = h.kernel.subtractCalls[0];
    expect(call).toHaveLength(2);
    // The intermediate orientation survives as BOTH the first segment's end and
    // the second one's start — a chord would have thrown it away.
    expect(call[0].rotEnd).toEqual(q(30));
    expect(call[1].rotStart).toEqual(q(30));
    expect(call[1].rotEnd).toEqual(q(60));
  });

  it('degrades substeps above the cap without dropping a single segment', () => {
    const c = centre();
    const many: CsgToolSegment[] = [];
    for (let i = 0; i < MAX_SEGMENTS_PER_JOB * 2; i++) {
      many.push(segment(c, [c[0] + i, c[1], c[2]], { substeps: 16 }));
    }
    const out = degradeSubsteps(many);
    expect(out).toHaveLength(many.length); // no segment is ever dropped
    expect(out.every((s) => s.substeps >= 1)).toBe(true);
    expect(out[0].substeps).toBe(8); // 16 * 64/128
    // Positions untouched — only the sampling density changes.
    expect(out.map((s) => s.posEnd.x)).toEqual(many.map((s) => s.posEnd.x));
    // Deterministic: same input, same output.
    expect(degradeSubsteps(many).map((s) => s.substeps)).toEqual(out.map((s) => s.substeps));
    // At or below the cap the list is returned unchanged (identity, no copy).
    const few = many.slice(0, MAX_SEGMENTS_PER_JOB);
    expect(degradeSubsteps(few)).toBe(few);
  });
});

describe('CsgMachiningProvider — backpressure over a fake port (plan-405 §9.3)', () => {
  /** In-process port that runs a real {@link CsgWorkerBody} synchronously. */
  function makeProvider(): { provider: CsgMachiningProvider; harness: Harness } {
    const harness = new Harness();
    let onMsg: ((m: CsgWorkerResponse) => void) | null = null;
    const port: CsgWorkerPort = {
      postMessage: (msg) => {
        harness.body.handle(msg);
        harness.drain();
        for (const m of harness.messages.splice(0)) onMsg?.(m);
      },
      terminate: () => { harness.body.disposeAll(); },
      onMessage: (cb) => {
        onMsg = cb;
        // The real worker announces itself once the WASM is up.
        cb({ t: 'ready', rvcAbi: 1, rvwAbi: 1 });
      },
    };
    return { provider: new CsgMachiningProvider(() => port), harness };
  }

  /**
   * Port that HOLDS worker responses until `flush()` — the only way to observe
   * backpressure, since a synchronously draining port acks every job before the
   * next submit and the counter never rises.
   */
  function makeDeferredProvider(): {
    provider: CsgMachiningProvider; harness: Harness; flush: () => void;
  } {
    const harness = new Harness();
    let onMsg: ((m: CsgWorkerResponse) => void) | null = null;
    const held: CsgWorkerResponse[] = [];
    const flush = (): void => {
      for (const m of held.splice(0)) onMsg?.(m);
    };
    const port: CsgWorkerPort = {
      postMessage: (msg) => {
        harness.body.handle(msg);
        harness.drain();
        held.push(...harness.messages.splice(0));
        // Grid creation must resolve, otherwise the test cannot even start.
        if (msg.t !== 'subtract') flush();
      },
      terminate: () => { harness.body.disposeAll(); },
      onMessage: (cb) => { onMsg = cb; cb({ t: 'ready', rvcAbi: 1, rvwAbi: 1 }); },
    };
    return { provider: new CsgMachiningProvider(() => port), harness, flush };
  }

  it('accepts up to the cap, then reports backlog, and recovers on acks', async () => {
    const { provider, flush } = makeDeferredProvider();
    await provider.init();
    expect(provider.ready).toBe(true);
    expect(provider.abi).toEqual({ rvc: 1, rvw: 1 });

    const handle = await provider.createGrid(mockGridDesc());
    const c = centre();

    const results = [];
    for (let i = 0; i < MACHINING_MAX_PENDING_JOBS + 3; i++) {
      results.push(provider.submitSubtract(handle, { segments: [segment(c, c)] }));
    }
    expect(results.filter((r) => r.accepted)).toHaveLength(MACHINING_MAX_PENDING_JOBS);
    expect(results.filter((r) => !r.accepted && r.reason === 'backlog')).toHaveLength(3);

    // Delivering the held acks frees the slots again.
    flush();
    expect(provider.submitSubtract(handle, { segments: [segment(c, c)] }).accepted).toBe(true);

    flush();
    await provider.destroyGrid(handle);
    provider.dispose();
  });

  it('zeroes the pending counter on the reset barrier (jobs are discarded, not acked)', async () => {
    const { provider, flush } = makeDeferredProvider();
    await provider.init();
    const handle = await provider.createGrid(mockGridDesc());
    const c = centre();

    for (let i = 0; i < MACHINING_MAX_PENDING_JOBS; i++) {
      provider.submitSubtract(handle, { segments: [segment(c, c)] });
    }
    expect(provider.submitSubtract(handle, { segments: [segment(c, c)] }))
      .toEqual({ accepted: false, reason: 'backlog' });

    // The worker discards queued jobs on reset WITHOUT acking them. If the
    // counter only ever fell on acks, the grid would be jammed forever.
    await provider.resetGrid(handle);
    expect(provider.submitSubtract(handle, { segments: [segment(c, c)] }).accepted).toBe(true);

    // Stale acks from the pre-reset generation must not double-decrement.
    flush();
    provider.dispose();
  });

  it('rejects with "closed" after the grid was destroyed', async () => {
    const { provider } = makeProvider();
    await provider.init();
    const handle = await provider.createGrid(mockGridDesc());
    await provider.destroyGrid(handle);
    const res = provider.submitSubtract(handle, { segments: [segment(centre(), centre())] });
    expect(res).toEqual({ accepted: false, reason: 'closed' });
    provider.dispose();
  });

  it('latches off permanently on a fatal message', async () => {
    const harness = new Harness();
    let onMsg: ((m: CsgWorkerResponse) => void) | null = null;
    const port: CsgWorkerPort = {
      postMessage: (msg) => {
        harness.body.handle(msg);
        harness.drain();
        for (const m of harness.messages.splice(0)) onMsg?.(m);
      },
      terminate: () => {},
      onMessage: (cb) => { onMsg = cb; cb({ t: 'ready', rvcAbi: 1, rvwAbi: 1 }); },
    };
    const provider = new CsgMachiningProvider(() => port);
    await provider.init();
    const handle = await provider.createGrid(mockGridDesc());

    harness.kernel.throwOnNextSubtract = 'kernel trap';
    provider.submitSubtract(handle, { segments: [segment(centre(), centre())] });

    expect(provider.failed).toBe(true);
    expect(provider.ready).toBe(false);
    expect(provider.submitSubtract(handle, { segments: [segment(centre(), centre())] }))
      .toEqual({ accepted: false, reason: 'closed' });
  });

  it('degrades to "closed" when the runtime has no Worker', async () => {
    const provider = new CsgMachiningProvider(() => null);
    await expect(provider.init()).rejects.toThrow(/Web Workers/);
    expect(provider.failed).toBe(true);
  });

  it('fails off when the worker never reports ready (boot watchdog)', async () => {
    // A module Worker that fails to LOAD runs none of our code: it can neither post
    // `ready` nor `fatal`. Without the watchdog `init()` stayed pending forever and
    // the manager sat in `creating` with the workpiece already hidden — the invisible
    // workpiece of the plan-405 live test.
    const silentPort: CsgWorkerPort = {
      postMessage: () => {},
      terminate: () => {},
      onMessage: () => {},
    };
    const provider = new CsgMachiningProvider(() => silentPort, 20);
    await expect(provider.init()).rejects.toThrow(/did not report ready/);
    expect(provider.failed).toBe(true);
  });

  it('reports a worker-level error as fatal', async () => {
    // `worker.onerror` is the ONLY channel for a module-load failure.
    let onMsg: ((m: CsgWorkerResponse) => void) | null = null;
    const port: CsgWorkerPort = {
      postMessage: () => {},
      terminate: () => {},
      onMessage: (cb) => {
        onMsg = cb;
        cb({ t: 'fatal', message: 'machining worker failed to run: module load error' });
      },
    };
    const provider = new CsgMachiningProvider(() => port, 0);
    await expect(provider.init()).rejects.toThrow(/failed to run/);
    expect(provider.failed).toBe(true);
    expect(onMsg).not.toBeNull();
  });
});

describe('CsgWorkerBody — scheduler contract (plan-405 live finding F1)', () => {
  /**
   * The live blocker. The body keeps the scheduler in an instance field and calls it
   * as `this.schedule(...)`, so the receiver is the body. Passing the bare
   * `queueMicrotask` therefore throws `Illegal invocation` (a WebIDL brand check) in a
   * real browser — invisibly, because the throw happened inside `onCreateGrid`'s try
   * AFTER `gridCreated` was posted, so the resulting `error` reply named an rid the
   * provider had already settled. `pumpScheduled` stayed armed and the worker never
   * subtracted or tessellated again while still answering `countSolid` normally.
   *
   * The mock scheduler in every other test is a plain function and cannot see this,
   * hence this explicit pair: the latch must survive a throwing scheduler, and the
   * shipped default must be a wrapper rather than the builtin itself.
   */
  it('does not wedge the pump when the scheduler throws', () => {
    const kernel = new VoxelMockKernel();
    const messages: CsgWorkerResponse[] = [];
    let armed = true;
    let pending: (() => void) | null = null;
    const body = new CsgWorkerBody(kernel, (m) => { messages.push(m); }, (run) => {
      if (armed) throw new TypeError('Illegal invocation');
      pending = run;
    });

    expect(() => body.handle({ t: 'createGrid', rid: 1, desc: mockGridDesc() })).not.toThrow();
    // The grid still exists — only the pump turn was lost.
    expect(messages.some((m) => m.t === 'gridCreated')).toBe(true);

    // A working scheduler must be able to take over: the latch was released.
    armed = false;
    body.handle({ t: 'countSolid', rid: 2, gridId: 1 });
    const grid = (messages.find((m) => m.t === 'gridCreated') as { grid: { id: number } }).grid;
    body.handle({
      t: 'subtract', gridId: grid.id, gen: 0, seq: 1,
      segments: [segment(centre(), centre())],
    });
    expect(pending).not.toBeNull();
    (pending as unknown as () => void)();
    expect(messages.some((m) => m.t === 'ack')).toBe(true);
  });

  it('defaults to a WRAPPED scheduler, never the platform builtin', async () => {
    // Regression guard for the exact mistake: if the default were `queueMicrotask`
    // itself, the receiver check would reject it here too.
    const kernel = new VoxelMockKernel();
    const messages: CsgWorkerResponse[] = [];
    const body = new CsgWorkerBody(kernel, (m) => { messages.push(m); });

    expect(() => body.handle({ t: 'createGrid', rid: 1, desc: mockGridDesc() })).not.toThrow();
    // Let the real microtask queue run the pump.
    await Promise.resolve();
    await Promise.resolve();
    expect(messages.some((m) => m.t === 'chunks')).toBe(true);
  });
});

/** The mock-kernel grid object behind a grid id. */
function gridOf(h: Harness, id: number): MockGrid {
  return h.kernel.grid(id);
}
