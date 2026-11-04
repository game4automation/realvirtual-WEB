// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-559 §9.1 (+ SOL round 2 S2) — the pure fleet core primitives:
 * SimClock (continuous), Reservations, RouteTable, StorageGroup.
 * Node test: no Three, no DOM, no wall clock — every assertion compares
 * counters and simulation time.
 */
import { describe, expect, it } from 'vitest';
import { ContinuousSimClock } from '../../src/core/fleet/core/sim-clock';
import { ReservationTable } from '../../src/core/fleet/core/reservations';
import {
  forwardApproach,
  reverseApproach,
  RouteTable,
  type RouteGraph,
} from '../../src/core/fleet/core/route-table';
import { StorageGroup } from '../../src/core/fleet/core/storage-group';

describe('SimClock (continuous)', () => {
  it('fires an event at t=10 exactly once', () => {
    const clock = new ContinuousSimClock();
    let n = 0;
    let firedAt = -1;
    clock.schedule(10, () => { n++; firedAt = clock.now(); });
    expect(clock.advanceTo(5)).toBe(0);
    expect(n).toBe(0);
    expect(clock.advanceTo(10)).toBe(1);
    expect(n).toBe(1);
    expect(firedAt).toBe(10);
    clock.advanceTo(20);
    clock.advanceTo(30);
    expect(n).toBe(1);
    expect(clock.now()).toBe(30);
    expect(clock.pendingCount).toBe(0);
  });

  it('fires skipped events in time order, ties in scheduling order, each with its own time', () => {
    const clock = new ContinuousSimClock();
    const log: string[] = [];
    const at = (name: string) => () => { log.push(`${name}@${clock.now()}`); };
    clock.schedule(3, at('a'));
    clock.schedule(1, at('b'));
    clock.schedule(2, at('c'));
    clock.schedule(2, at('d'));
    expect(clock.advanceTo(100)).toBe(4);
    expect(log).toEqual(['b@1', 'c@2', 'd@2', 'a@3']);
    expect(clock.now()).toBe(100);
    expect(clock.firedCount).toBe(4);
  });

  it('fires an event scheduled from a callback inside the same advance when it is due', () => {
    const clock = new ContinuousSimClock();
    const log: number[] = [];
    clock.schedule(2, () => {
      log.push(clock.now());
      clock.schedule(4, () => log.push(clock.now()));
      clock.schedule(50, () => log.push(clock.now()));
    });
    clock.advanceTo(10);
    expect(log).toEqual([2, 4]);
    clock.advanceTo(50);
    expect(log).toEqual([2, 4, 50]);
  });

  it('cancel prevents the event; null, undefined and a fired handle are no-ops', () => {
    const clock = new ContinuousSimClock();
    let a = 0;
    let b = 0;
    const ha = clock.schedule(5, () => { a++; });
    const hb = clock.schedule(6, () => { b++; });
    clock.cancel(ha);
    clock.cancel(null);
    clock.cancel(undefined);
    clock.advanceTo(10);
    expect(a).toBe(0);
    expect(b).toBe(1);
    clock.cancel(hb); // already fired
    expect(b).toBe(1);
  });

  it('an old generation never fires after reset, and its handle cannot cancel new events', () => {
    const clock = new ContinuousSimClock();
    let old = 0;
    let fresh = 0;
    const hOld = clock.schedule(5, () => { old++; });
    const g0 = clock.generation;
    clock.reset();
    expect(clock.generation).toBe(g0 + 1);
    expect(clock.now()).toBe(0);
    clock.schedule(5, () => { fresh++; });
    clock.cancel(hOld); // foreign generation: no-op
    clock.advanceTo(10);
    expect(old).toBe(0);
    expect(fresh).toBe(1);
  });

  it('a reset from inside a callback ends the advance; the old remainder never fires', () => {
    const clock = new ContinuousSimClock();
    const log: string[] = [];
    clock.schedule(1, () => { log.push('reset'); clock.reset(); });
    clock.schedule(2, () => log.push('stale'));
    clock.advanceTo(10);
    clock.advanceTo(20);
    expect(log).toEqual(['reset']);
  });

  it('an event in the past fires on the next advance, never inside schedule; dispose stops everything', () => {
    const clock = new ContinuousSimClock();
    clock.advanceTo(10);
    let n = 0;
    clock.schedule(3, () => { n++; });
    expect(n).toBe(0);
    clock.advanceTo(10);
    expect(n).toBe(1);
    expect(clock.now()).toBe(10);
    clock.dispose();
    clock.schedule(11, () => { n++; });
    clock.advanceTo(100);
    expect(n).toBe(1);
  });
});

describe('Reservations', () => {
  it('rejects a second owner, keeps the first owner idempotent', () => {
    const r = new ReservationTable();
    expect(r.tryReserve('station', 'S1', 'v1', 0)).toBe(true);
    expect(r.tryReserve('station', 'S1', 'v2', 1)).toBe(false);
    expect(r.ownerOf('S1')).toBe('v1');
    expect(r.tryReserve('station', 'S1', 'v1', 2)).toBe(true);
    expect(r.get('S1')!.since).toBe(0);
    r.release('S1', 'v2'); // not the owner: no-op
    expect(r.ownerOf('S1')).toBe('v1');
    r.release('S1', 'v1');
    expect(r.ownerOf('S1')).toBeNull();
    expect(r.tryReserve('station', 'S1', 'v2', 3)).toBe(true);
  });

  it('releaseAllOf frees exactly the owner\'s reservations; reset frees all', () => {
    const r = new ReservationTable();
    r.tryReserve('station', 'S1', 'v1', 0);
    r.tryReserve('charger', 'C1', 'v1', 0);
    r.tryReserve('wait', 'W1', 'v2', 0);
    expect(r.heldBy('v1').map((x) => x.id)).toEqual(['C1', 'S1']);
    r.releaseAllOf('v1');
    expect(r.ownerOf('S1')).toBeNull();
    expect(r.ownerOf('C1')).toBeNull();
    expect(r.ownerOf('W1')).toBe('v2');
    expect(r.size).toBe(1);
    r.reset();
    expect(r.size).toBe(0);
    expect(r.ownerOf('W1')).toBeNull();
  });
});

/**
 * Hand graph (lengths in m):
 *
 *   A(10) → B(5) → M(2) → C(8) → A      main loop
 *   K(4)  → M                           stub K, authored from the handling position toward the lane
 *   C     → D(6)                        dead-end station path
 *   Z(3)                                island, unreachable
 *
 * M has two predecessors (B, K) — the merge piece / turn of stub K.
 */
function handGraph(): RouteGraph {
  const len: Record<string, number> = { A: 10, B: 5, M: 2, C: 8, K: 4, D: 6, Z: 3 };
  const succ: Record<string, string[]> = { A: ['B'], B: ['M'], M: ['C'], C: ['A', 'D'], K: ['M'], D: [], Z: [] };
  const preds: Record<string, number> = {};
  for (const id of Object.keys(len)) preds[id] = 0;
  for (const id of Object.keys(succ)) for (const s of succ[id]) preds[s]++;
  const ids = Object.keys(len);
  return {
    pathIds: () => ids,
    length: (id) => len[id] ?? NaN,
    successors: (id) => succ[id] ?? [],
    predecessorCount: (id) => preds[id] ?? 0,
  };
}

describe('RouteTable (S2: arc position, service position, turn piece)', () => {
  const g = handGraph();
  const table = new RouteTable(g);
  const stationD = forwardApproach('D');

  it('two vehicles on the same path with different s get different distances', () => {
    // rest (L − s) + network A→D (B5 + M2 + C8 + D6 = 21) + approach 0
    expect(table.distanceM({ pathId: 'A', s: 2, dir: 1 }, stationD)).toBe(29);
    expect(table.distanceM({ pathId: 'A', s: 7, dir: 1 }, stationD)).toBe(24);
  });

  it('reverse stub: forward to the END of the turn, then back over the turn and the stub chain', () => {
    const stationK = reverseApproach(g, 'K');
    expect(stationK).toEqual({ viaPathId: 'M', approachM: 6 }); // turn M (2) + stub K (4)
    // rest 8 + network A→M (B5 + M2 = 7) + approach 6
    expect(table.distanceM({ pathId: 'A', s: 2, dir: 1 }, stationK!)).toBe(21);
    // no stub chain into a merge piece: C has two successors
    expect(reverseApproach(g, 'C')).toBeNull();
    expect(reverseApproach(g, 'nope')).toBeNull();
  });

  it('a reversing vehicle (dir −1) goes back to s = 0 and leaves forward over the same piece', () => {
    // in stub K at s = 1: rest 1 + 4, network K→D (M2 + C8 + D6 = 16)
    expect(table.distanceM({ pathId: 'K', s: 1, dir: -1 }, stationD)).toBe(21);
  });

  it('a vehicle reversing on the TURN piece still runs the stub chain down and up again', () => {
    // on M at s = 1.5, reversing toward stub K: rest 1.5 + 2·K4 + M2 = 11.5, network M→D (C8 + D6 = 14)
    expect(table.distanceM({ pathId: 'M', s: 1.5, dir: -1 }, stationD)).toBe(25.5);
    expect(table.distanceM({ pathId: 'M', s: 1.5, dir: -1, stubId: 'K' }, stationD)).toBe(25.5);
    // two stubs K (4) and J (3) into M: inference is ambiguous (chain 0), the stubId decides
    const len: Record<string, number> = { A: 10, M: 2, K: 4, J: 3 };
    const succ: Record<string, string[]> = { A: ['M'], M: ['A'], K: ['M'], J: ['M'] };
    const preds: Record<string, number> = { A: 1, M: 3, K: 0, J: 0 };
    const twin = new RouteTable({
      pathIds: () => Object.keys(len), length: (id) => len[id], successors: (id) => succ[id] ?? [],
      predecessorCount: (id) => preds[id] ?? 0,
    });
    expect(twin.restOnPathM({ pathId: 'M', s: 1, dir: -1 })).toBe(3);
    expect(twin.restOnPathM({ pathId: 'M', s: 1, dir: -1, stubId: 'J' })).toBe(9);
    expect(twin.restOnPathM({ pathId: 'M', s: 1, dir: -1, stubId: 'K' })).toBe(11);
  });

  it('on the via path itself only the rest counts; s is clamped into [0, L]', () => {
    expect(table.distanceM({ pathId: 'D', s: 1, dir: 1 }, stationD)).toBe(5);
    expect(table.distanceM({ pathId: 'D', s: 99, dir: 1 }, stationD)).toBe(0);
    expect(table.distanceM({ pathId: 'D', s: -5, dir: 1 }, stationD)).toBe(6);
  });

  it('unreachable or unknown = Infinity', () => {
    expect(table.distanceM({ pathId: 'A', s: 0, dir: 1 }, forwardApproach('Z'))).toBe(Infinity);
    expect(table.distanceM({ pathId: 'Z', s: 0, dir: 1 }, stationD)).toBe(Infinity);
    expect(table.distanceM({ pathId: 'D', s: 0, dir: 1 }, forwardApproach('A'))).toBe(Infinity); // dead end
    expect(table.distanceM({ pathId: 'nope', s: 0, dir: 1 }, stationD)).toBe(Infinity);
    expect(table.distanceM({ pathId: 'A', s: 0, dir: 1 }, forwardApproach('nope'))).toBe(Infinity);
  });

  it('nearestOf breaks distance ties by id and skips unreachable candidates', () => {
    const loc = { pathId: 'A', s: 2, dir: 1 } as const;
    const best = table.nearestOf(loc, [
      { id: 'y', approach: stationD },
      { id: 'z', approach: forwardApproach('Z') },
      { id: 'x', approach: stationD },
    ]);
    expect(best).toEqual({ id: 'x', distanceM: 29 });
    expect(table.nearestOf(loc, [{ id: 'z', approach: forwardApproach('Z') }])).toBeNull();
  });

  it('caches one Dijkstra row per source path; invalidate drops it', () => {
    const t = new RouteTable(g);
    for (let i = 0; i < 5; i++) t.distanceM({ pathId: 'A', s: i, dir: 1 }, stationD);
    expect(t.runs).toBe(1);
    t.distanceM({ pathId: 'K', s: 0, dir: 1 }, stationD);
    expect(t.runs).toBe(2);
    t.invalidate();
    t.distanceM({ pathId: 'A', s: 0, dir: 1 }, stationD);
    expect(t.runs).toBe(3);
  });
});

describe('StorageGroup', () => {
  it('retrieves FIFO by storage time, ties by configuration order', () => {
    const g = new StorageGroup('Buffer', ['p1', 'p2', 'p3']);
    g.commitStore('p2', 'mu-a', 5);
    g.commitStore('p1', 'mu-b', 8);
    g.commitStore('p3', 'mu-c', 8);
    expect(g.occupancy()).toBe(3);
    expect(g.peekRetrieve()!.id).toBe('p2');
    expect(g.reserveRetrieve('v1')).toBe('p2');
    // p2 is reserved: next is the tie p1/p3 at t=8 → configuration order
    expect(g.reserveRetrieve('v2')).toBe('p1');
    expect(g.reserveRetrieve('v3')).toBe('p3');
    expect(g.reserveRetrieve('v4')).toBeNull();
    expect(g.commitRetrieve('p2', 10)).toBe('mu-a');
  });

  it('stores into the place free the longest, configuration order while all are untouched', () => {
    const g = new StorageGroup('Buffer', ['a', 'b', 'c']);
    expect(g.peekStore()!.id).toBe('a');
    expect(g.reserveStore('v1')).toBe('a');
    expect(g.reserveStore('v2')).toBe('b');
    g.commitStore('a', 'mu-1', 1);
    g.commitStore('b', 'mu-2', 2);
    g.commitStore('c', 'mu-3', 3);
    expect(g.isFull()).toBe(true);
    g.commitRetrieve('a', 20);
    g.commitRetrieve('b', 10);
    expect(g.peekStore()!.id).toBe('b'); // free since 10, longer than a (since 20)
    g.cancel('b');
    expect(g.reserveStore('v3')).toBe('b');
    expect(g.reserveStore('v4')).toBe('a');
    expect(g.reserveStore('v5')).toBeNull();
    g.cancelAllOf('v3');
    expect(g.place('b').reservedBy).toBeNull();
  });

  it('reset empties the group; misuse throws', () => {
    const g = new StorageGroup('Buffer', ['a', 'b']);
    g.commitStore('a', 'mu-1', 1);
    expect(() => g.commitStore('a', 'mu-2', 2)).toThrow();
    expect(() => g.commitRetrieve('b', 2)).toThrow();
    expect(() => g.place('x')).toThrow();
    expect(() => new StorageGroup('dup', ['a', 'a'])).toThrow();
    g.reset();
    expect(g.occupancy()).toBe(0);
    expect(g.peekStore()!.id).toBe('a');
  });
});
