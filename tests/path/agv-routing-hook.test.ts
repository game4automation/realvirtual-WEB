// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-268 §9.2 — routing is a HOOK (project logic), not built in:
 * an injected id-based `selectNextPath` picks branch B; without a hook the
 * default is `successors[0]` (no built-in pathfinding, no hang); `onArrive`
 * fires with the correct node id. Headless, synthetic RVPath graph.
 */

import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { LineSegment, RVPath } from '../../src/core/engine/rv-path';
import { RVPathNetwork, type SelectNextPathContext } from '../../src/core/engine/rv-path-network';
import { PathTraveler } from '../../src/core/engine/rv-path-traveler';

const v3 = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);

/** Junction fixture: M (1 m) forks into A and B (1 m each). */
function makeFork(): { net: RVPathNetwork; m: RVPath } {
  const net = new RVPathNetwork();
  const m = new RVPath('M', [new LineSegment(v3(0, 0, 0), v3(0, 0, 1))], { successorIds: ['A', 'B'] });
  const a = new RVPath('A', [new LineSegment(v3(0, 0, 1), v3(-1, 0, 1))]);
  const b = new RVPath('B', [new LineSegment(v3(0, 0, 1), v3(1, 0, 1))]);
  net.register(m); net.register(a); net.register(b);
  return { net, m };
}

const TICK = 1 / 60;
/** Speed that advances 0.6 m per tick — crosses the 1 m fork in two ticks. */
const V_06_PER_TICK = 0.6 * 1000 * 60;

describe('Agv routing — selectNextPath as an injected hook', () => {
  it('the injected hook picks branch B → the traveler drives B, not A', () => {
    const { net, m } = makeFork();
    const seenCtx: SelectNextPathContext[] = [];
    const seenCandidates: string[][] = [];
    const t = new PathTraveler('agv1', m, net);
    t.hooks.selectNextPath = (candidateIds, ctx) => {
      seenCandidates.push([...candidateIds]);
      seenCtx.push(ctx);
      return 'B';
    };
    t.v = V_06_PER_TICK;
    t.advance(TICK);
    t.advance(TICK); // crosses the end of M at s=1.2 → hand-off

    expect(t.path?.id).toBe('B');
    expect(t.s).toBeCloseTo(0.2, 9);
    // ID-based signature (plan-268 §2.4 S1): plain string ids + plain ctx
    expect(seenCandidates).toEqual([['A', 'B']]);
    expect(seenCtx[0]).toEqual({ travelerId: 'agv1', currentPathId: 'M', direction: 1 });
  });

  it('without a hook the default is successors[0] (no built-in pathfinding)', () => {
    const { net, m } = makeFork();
    const t = new PathTraveler('agv1', m, net);
    t.v = V_06_PER_TICK;
    t.advance(TICK);
    t.advance(TICK);
    expect(t.path?.id).toBe('A');
    expect(t.s).toBeCloseTo(0.2, 9);
  });

  it('an invalid hook result falls back to the default candidate (defensive)', () => {
    const { net, m } = makeFork();
    const t = new PathTraveler('agv1', m, net);
    t.hooks.selectNextPath = () => 'DoesNotExist';
    t.v = V_06_PER_TICK;
    t.advance(TICK);
    t.advance(TICK);
    expect(t.path?.id).toBe('A'); // fallback candidates[0], no crash
  });

  it('onArrive fires at the marked node with the correct nodeId + travelerId', () => {
    const { net, m } = makeFork();
    const arrivals: Array<{ nodeId: string; travelerId: string }> = [];
    const t = new PathTraveler('agv7', m, net);
    t.hooks.selectNextPath = () => 'B';
    t.hooks.onArrive = (nodeId, travelerId) => arrivals.push({ nodeId, travelerId });
    t.v = V_06_PER_TICK;
    t.advance(TICK);
    expect(arrivals).toEqual([]); // still on M (s=0.6)
    t.advance(TICK);              // end of M crossed
    expect(arrivals).toEqual([{ nodeId: 'M', travelerId: 'agv7' }]);
    // continue to the dead end of B → second arrival with nodeId 'B'
    t.advance(TICK);
    t.advance(TICK);
    expect(arrivals).toEqual([
      { nodeId: 'M', travelerId: 'agv7' },
      { nodeId: 'B', travelerId: 'agv7' },
    ]);
    expect(t.atEnd).toBe(true);
  });

  it('backward travel (s < 0) routes through predecessors with the same hook contract', () => {
    const { net, m } = makeFork();
    net.resolveGraph();
    const b = net.get('B')!;
    const directions: Array<1 | -1> = [];
    const t = new PathTraveler('agv1', b, net);
    t.hooks.selectNextPath = (_ids, ctx) => { directions.push(ctx.direction); return undefined; };
    t.s = 0.1;
    t.v = -V_06_PER_TICK; // -0.6 m per tick → s = -0.5 → carry to M
    t.advance(TICK);
    expect(t.path?.id).toBe('M');
    expect(t.s).toBeCloseTo(0.5, 9);
    expect(directions).toEqual([-1]);
  });
});

describe('Agv routing — network-level project router (plan-268 Phase 6)', () => {
  it('a registered router routes travelers WITHOUT a per-traveler hook', () => {
    const { net, m } = makeFork();
    const seen: string[][] = [];
    net.setRouter({
      selectNextPath: (ids, ctx) => {
        seen.push([...ids, ctx.travelerId, ctx.currentPathId]);
        return 'B';
      },
    }, 'test-router');
    const t = new PathTraveler('agv1', m, net);
    t.v = V_06_PER_TICK;
    t.advance(TICK);
    t.advance(TICK);
    expect(t.path?.id).toBe('B');
    expect(seen).toEqual([['A', 'B', 'agv1', 'M']]);
  });

  it('a per-traveler hook takes PRECEDENCE over the registered router', () => {
    const { net, m } = makeFork();
    let routerAsked = 0;
    net.setRouter({ selectNextPath: () => { routerAsked++; return 'B'; } }, 'test-router');
    const t = new PathTraveler('agv1', m, net);
    t.hooks.selectNextPath = () => 'A';
    t.v = V_06_PER_TICK;
    t.advance(TICK);
    t.advance(TICK);
    expect(t.path?.id).toBe('A');
    expect(routerAsked).toBe(0);
  });

  it('unregister restores the default route (identity-checked, hot-reload safe)', () => {
    const { net, m } = makeFork();
    const unregister = net.setRouter({ selectNextPath: () => 'B' }, 'r1');
    expect(net.hasRouter).toBe(true);
    unregister();
    expect(net.hasRouter).toBe(false);
    // A stale unregister of a REPLACED router must not drop the new one.
    const routerB = { selectNextPath: (): string => 'B' };
    const staleUnreg = net.setRouter(routerB, 'r1');
    net.setRouter({ selectNextPath: () => 'A' }, 'r2'); // replaces routerB
    staleUnreg();                                       // identity mismatch → no-op
    expect(net.hasRouter).toBe(true);
    const t = new PathTraveler('agv1', m, net);
    t.v = V_06_PER_TICK;
    t.advance(TICK);
    t.advance(TICK);
    expect(t.path?.id).toBe('A'); // r2 routes
  });

  it('router onArrive fires on every completed path end; requestDispatch ONCE per dead-end stop', () => {
    const { net, m } = makeFork();
    const arrivals: string[] = [];
    const dispatches: string[] = [];
    net.setRouter({
      onArrive: (pathId, travelerId) => arrivals.push(`${pathId}:${travelerId}`),
      requestDispatch: (travelerId) => dispatches.push(travelerId),
    }, 'test-router');
    const t = new PathTraveler('agv3', m, net);
    t.v = V_06_PER_TICK;
    t.advance(TICK);
    t.advance(TICK); // end of M → hand-off to A (default: no selectNextPath on the router)
    expect(arrivals).toEqual(['M:agv3']);
    expect(dispatches).toEqual([]);
    t.advance(TICK);
    t.advance(TICK); // end of A → dead end
    expect(arrivals).toEqual(['M:agv3', 'A:agv3']);
    expect(dispatches).toEqual(['agv3']);
    expect(t.atEnd).toBe(true);
    expect(t.v).toBe(0); // the stop zeroed the speed
    // Parked at the dead end (v = 0): no re-fire on further ticks.
    t.advance(TICK);
    t.advance(TICK);
    expect(dispatches).toEqual(['agv3']);
    expect(arrivals).toEqual(['M:agv3', 'A:agv3']);
  });

  it('network.clear() drops the router (a stale router never routes the next model)', () => {
    const { net } = makeFork();
    net.setRouter({ selectNextPath: () => 'B' }, 'old-model');
    expect(net.hasRouter).toBe(true);
    net.clear();
    expect(net.hasRouter).toBe(false);
  });
});
