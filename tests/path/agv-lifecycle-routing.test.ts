// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-558 Phase 3 — R2-3 lifecycle contract and R2-5 routing / notify
 * contract of the movement authority, WITHOUT any manual global `clear()`
 * between the lifecycle steps (only the test's initial isolation).
 *
 * R2-3: freeze of a MOVING leader (DES downtime) brakes it with its own
 * deceleration and its followers re-plan safely; resume continues (service
 * time included); a runner reset and a model switch (new runner, other
 * vehicles) start a new epoch without ghosts; a continuous despawn removes
 * the vehicle, frees its claims and wakes its followers.
 * R2-5: routing decisions are made once per junction pass and kept by later
 * re-plans (state-dependent router); with a router installed every piece end
 * is announced exactly once, in route order, at its exact arrival time; a
 * task change from inside the callback re-routes the vehicle.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultMovementAuthority } from '../../src/core/engine/rv-movement-authority';
import { iterateFixedUpdate } from '../../src/core/behavior-runtime';
import { DESRunner } from '@rv/plugins/des/des-runner';
import {
  TICK, makeHost, makeAgvRoot, bindDes, bindContinuous, clearShared, runAnimated, centredBody, sig,
} from '../helpers/agv-harness';

beforeEach(() => clearShared());

const net = (): ReturnType<typeof getDefaultPathNetwork> => getDefaultPathNetwork();
function add(raw: Record<string, unknown>): void {
  net().register(parsePathExtras({ type: 'Path', version: 1, closed: false, align: [0, 1, 0], ...raw }, raw.id as string)!);
}
const line = (a: number[], b: number[]): Record<string, unknown> => ({ kind: 'line', from: a, to: b });

function adapterOf(runner: DESRunner, root: Object3D): { setFailure(f: boolean): void } {
  const inst = runner.liveInstances.find((i) => i.self.root === root)!;
  return inst.adapter as unknown as { setFailure(f: boolean): void };
}

describe('R2-3 lifecycle contract (plan-558)', () => {
  it('freeze of a MOVING leader: it brakes, followers re-plan safely; resume continues', () => {
    add({ id: 'Long', segments: [line([0, 0, 0], [80, 0, 0])] });
    add({ id: 'Park', segments: [line([0, 0, 5], [4, 0, 5])] });
    net().resolveGraph();
    const runner = new DESRunner({ subMode: 'animated' });
    const host = makeHost();
    const roots = [
      makeAgvRoot('Lead', { PathId: 'Long', StartPosition: 4000, VehicleLength: 1000, VehicleWidth: 600 }),
      makeAgvRoot('Follow', { PathId: 'Long', StartPosition: 1500, VehicleLength: 1000, VehicleWidth: 600 }),
      makeAgvRoot('Clock', { PathId: 'Park', VehicleLength: 1000, VehicleWidth: 600 }),
    ];
    roots.forEach((r) => bindDes(runner, r, host));
    runner.start([], { root: new Object3D() });
    const mb = getDefaultMovementAuthority('des');
    let tFreeze = -1, tResume = -1;
    // Freeze while both cruise; repair 10 s later — both from events.
    getDefaultAgvFleet().get('Clock')!.assign({
      destination: 'Park', serviceSec: 4,
      onServiceEnd: (id) => {
        tFreeze = runner.getManager().currentTime;
        adapterOf(runner, roots[0]).setFailure(true);
        getDefaultAgvFleet().get(id)!.assign({
          destination: 'Park', serviceSec: 10,
          onServiceEnd: () => { tResume = runner.getManager().currentTime; adapterOf(runner, roots[0]).setFailure(false); },
        });
      },
    });
    let minFR = Infinity;
    let leadSpeedAfterStop = 0;
    const m = runAnimated(runner, { roots: roots.slice(0, 2), names: ['Lead', 'Follow'], bodies: [centredBody(1, 0.6), centredBody(1, 0.6)] }, 40, (f) => {
      const t = f * TICK;
      const g = mb.minFrontRearGap(t);
      if (g < minFR) minFR = g;
      if (tFreeze > 0 && t > tFreeze + 3 && (tResume < 0 || t < tResume)) leadSpeedAfterStop = Math.max(leadSpeedAfterStop, mb.speedOf('Lead', t));
    });
    const endX = roots[0].position.x;
    console.log(`[agv-life] freeze tFreeze=${tFreeze.toFixed(2)} tResume=${tResume.toFixed(2)} endX=${endX.toFixed(3)} lead=${mb.describe(40).join(' || ')}`);
    runner.dispose();
    expect(tFreeze).toBeGreaterThan(0);
    expect(tResume).toBeGreaterThan(tFreeze);
    expect(leadSpeedAfterStop).toBe(0);           // braked to a standstill and stayed while failed
    expect(m.overlapFrames).toBe(0);
    expect(minFR).toBeGreaterThanOrEqual(0.3 - 1e-6);
    expect(mb.stats.violations).toBe(0);
    expect(mb.stats.forced).toBe(0);
    expect(endX).toBeGreaterThan(4 + tFreeze + 5);  // it drove on after the resume
  });

  it('freeze during a service stay keeps the remaining service time', () => {
    add({ id: 'A', segments: [line([0, 0, 0], [5, 0, 0])], successors: ['B'] });
    add({ id: 'B', segments: [line([5, 0, 0], [30, 0, 0])] });
    add({ id: 'Park', segments: [line([0, 0, 5], [4, 0, 5])] });
    net().resolveGraph();
    const runner = new DESRunner({ subMode: 'animated' });
    const host = makeHost();
    const v = makeAgvRoot('V', { PathId: 'A', StartPosition: 0 });
    const c = makeAgvRoot('Clock', { PathId: 'Park', StartPosition: 4000 });
    [v, c].forEach((r) => bindDes(runner, r, host));
    runner.start([], { root: new Object3D() });
    let arrived = -1, ended = -1, tFail = -1;
    const clock = (): ReturnType<ReturnType<typeof getDefaultAgvFleet>['get']> => getDefaultAgvFleet().get('Clock');
    getDefaultAgvFleet().get('V')!.assign({
      destination: 'A', serviceSec: 6,
      onArrive: () => {
        arrived = runner.getManager().currentTime;
        // Fail V 2 s into its stay, repair 5 s later (the parked Clock's service ends).
        clock()!.assign({
          destination: 'Park', serviceSec: 2,
          onServiceEnd: () => {
            tFail = runner.getManager().currentTime;
            adapterOf(runner, v).setFailure(true);
            clock()!.assign({ destination: 'Park', serviceSec: 5, onServiceEnd: () => adapterOf(runner, v).setFailure(false) });
          },
        });
      },
      onServiceEnd: () => { ended = runner.getManager().currentTime; },
    });
    for (let i = 0; i < Math.round(40 / TICK); i++) { runner.tick(TICK); runner.lateTick(TICK); }
    runner.dispose();
    console.log(`[agv-life] service arrived=${arrived.toFixed(3)} fail=${tFail.toFixed(3)} ended=${ended.toFixed(3)}`);
    expect(arrived).toBeGreaterThan(0);
    // 6 s service + ~5 s downtime (the stay is FROZEN, not restarted).
    expect(ended - arrived).toBeGreaterThan(10.5);
    expect(ended - arrived).toBeLessThan(11.6);
  });

  it('runner reset and a model switch start a new epoch: no ghosts, no stale claims', () => {
    add({ id: 'In', segments: [line([0, 0, 0], [10, 0, 0])], successors: ['Z'] });
    add({ id: 'Z', segments: [line([10, 0, 0], [12, 0, 0])], successors: ['Out'], zone: 'Z' });
    add({ id: 'Out', segments: [line([12, 0, 0], [40, 0, 0])] });
    net().resolveGraph();
    const mb = getDefaultMovementAuthority('des');
    const zones = getDefaultZoneRegistry();
    // Run 1: three vehicles, one inside the zone when the run is reset.
    const runner = new DESRunner({ subMode: 'animated' });
    const host = makeHost();
    const r1 = ['A', 'B', 'C'].map((n, i) => makeAgvRoot(n, { PathId: 'In', StartPosition: 6000 - i * 2000 }));
    r1.forEach((r) => bindDes(runner, r, host));
    runner.start([], { root: new Object3D() });
    for (let i = 0; i < Math.round(5 / TICK); i++) { runner.tick(TICK); runner.lateTick(TICK); }
    expect(zones.isHolder('Z', 'A')).toBe(true);
    runner.reset();
    expect(mb.size).toBe(3);
    // The restart re-seeded everyone at the start: nobody holds the zone ahead.
    expect(zones.isHolder('Z', 'A')).toBe(false);
    for (let i = 0; i < Math.round(30 / TICK); i++) { runner.tick(TICK); runner.lateTick(TICK); }
    expect(r1[2].position.x).toBeGreaterThan(12); // the last one passed the zone too
    runner.dispose();

    // Model switch: a new runner with OTHER vehicles; the old ones must not be obstacles.
    const runner2 = new DESRunner({ subMode: 'animated' });
    const r2 = [makeAgvRoot('X', { PathId: 'In', StartPosition: 500 })];
    r2.forEach((r) => bindDes(runner2, r, makeHost()));
    runner2.start([], { root: new Object3D() });
    for (let i = 0; i < Math.round(1 / TICK); i++) { runner2.tick(TICK); runner2.lateTick(TICK); }
    expect(mb.has('A')).toBe(false);
    expect(mb.size).toBe(1);
    for (let i = 0; i < Math.round(40 / TICK); i++) { runner2.tick(TICK); runner2.lateTick(TICK); }
    expect(r2[0].position.x).toBeGreaterThan(30);
    runner2.dispose();
  });

  it('continuous despawn: the vehicle leaves the authority, frees its zone, its follower drives on', () => {
    add({ id: 'In', segments: [line([0, 0, 0], [10, 0, 0])], successors: ['Z'] });
    add({ id: 'Z', segments: [line([10, 0, 0], [12, 0, 0])], successors: ['Out'], zone: 'Z' });
    add({ id: 'Out', segments: [line([12, 0, 0], [12.5, 0, 0])] });
    net().resolveGraph();
    const host = makeHost();
    const lead = makeAgvRoot('Lead', { PathId: 'Z', StartPosition: 1000 });
    const fol = makeAgvRoot('Follow', { PathId: 'In', StartPosition: 6000 });
    const hLead = bindContinuous(lead, host);
    const hFol = bindContinuous(fol, host);
    const mb = getDefaultMovementAuthority('continuous');
    for (let i = 0; i < Math.round(15 / TICK); i++) { iterateFixedUpdate(hLead, TICK); iterateFixedUpdate(hFol, TICK); }
    // The leader stands at the dead end inside the zone; the follower waits.
    expect(getDefaultZoneRegistry().isHolder('Z', 'Lead')).toBe(true);
    expect(sig(host, 'Follow', 'Moving')).toBe(false);
    hLead.dispose();
    expect(mb.has('Lead')).toBe(false);
    expect(getDefaultZoneRegistry().holderCount('Z')).toBeLessThanOrEqual(1);
    for (let i = 0; i < Math.round(15 / TICK); i++) iterateFixedUpdate(hFol, TICK);
    expect(fol.position.x).toBeGreaterThan(11.5);
    hFol.dispose();
    expect(mb.size).toBe(0);
  });
});

describe('R2-5 routing / notify contract (plan-558)', () => {
  /** Loop with a junction J → {L, R} merging (zone 'M') back into the loop. */
  function loop(): void {
    add({ id: 'J', segments: [line([0, 0, 0], [5, 0, 0])], successors: ['L', 'R'] });
    add({ id: 'L', segments: [line([5, 0, 0], [10, 0, -3])], successors: ['ML'] });
    add({ id: 'R', segments: [line([5, 0, 0], [10, 0, 3])], successors: ['MR'] });
    add({ id: 'ML', segments: [line([10, 0, -3], [15, 0, 0])], successors: ['Back'], zone: 'M' });
    add({ id: 'MR', segments: [line([10, 0, 3], [15, 0, 0])], successors: ['Back'], zone: 'M' });
    add({ id: 'Back', segments: [line([15, 0, 0], [15, 0, 8]), line([15, 0, 8], [0, 0, 8]), line([0, 0, 8], [0, 0, 0])], successors: ['J'], zone: 'M' });
    net().resolveGraph();
  }

  it('a STATE-DEPENDENT router is asked once per junction pass; re-plans keep the decision; arrivals exactly once, in order, at the exact time', () => {
    loop();
    const mb = getDefaultMovementAuthority('des');
    let runnerRef: DESRunner | null = null;
    let asked = 0;
    const decided: string[] = [];
    const arrivals: string[] = [];
    let maxOffset = 0;
    const jTimes: number[] = [];
    net().setRouter({
      selectNextPath: (cands) => {
        asked++;
        const pick = asked % 2 === 1 ? 'L' : 'R';
        decided.push(pick);
        return cands.includes(pick) ? pick : undefined;
      },
      onArrive: (pathId, id) => {
        arrivals.push(pathId);
        if (pathId === 'J') jTimes.push(runnerRef!.getManager().currentTime);
        // Exact time: the vehicle stands exactly at the end of the announced piece.
        const t = runnerRef!.getManager().currentTime;
        const loc = mb.locate(id, t)!;
        const atEnd = loc.path.id === pathId ? Math.abs(loc.s - loc.path.length) : loc.s;
        maxOffset = Math.max(maxOffset, atEnd);
      },
    }, 'test-router');
    const runner = new DESRunner({ subMode: 'animated' });
    runnerRef = runner;
    const root = makeAgvRoot('V', { PathId: 'J', StartPosition: 500 });
    bindDes(runner, root, makeHost());
    runner.start([], { root: new Object3D() });
    for (let i = 0; i < Math.round(200 / TICK); i++) { runner.tick(TICK); runner.lateTick(TICK); }
    runner.dispose();
    console.log(`[agv-life] router asked=${asked} decided=${decided.join('')} J@${jTimes.map((t) => t.toFixed(1)).join(',')} n=${arrivals.length}`);
    // Taken branches = the router's answers, in order (decided at planning time, never re-asked).
    const taken = arrivals.filter((p) => p === 'L' || p === 'R');
    const passes = arrivals.filter((p) => p === 'J').length;
    expect(passes).toBeGreaterThanOrEqual(4);
    expect(asked).toBeGreaterThanOrEqual(taken.length);
    expect(asked).toBeLessThanOrEqual(taken.length + 1); // + the decision for the pass in progress
    expect(taken).toEqual(decided.slice(0, taken.length));
    // Arrivals exactly once per piece end, in route order J → (L|R) → (ML|MR) → Back → J.
    for (let i = 1; i < arrivals.length; i++) {
      const prev = arrivals[i - 1], cur = arrivals[i];
      const ok = (prev === 'J' && (cur === 'L' || cur === 'R')) || (prev === 'L' && cur === 'ML')
        || (prev === 'R' && cur === 'MR') || ((prev === 'ML' || prev === 'MR') && cur === 'Back') || (prev === 'Back' && cur === 'J');
      expect(ok, `${prev} → ${cur}`).toBe(true);
    }
    expect(maxOffset).toBeLessThan(1e-6);
    expect(mb.stats.events['Replan:notify'] ?? 0).toBeGreaterThan(0);
  });

  it('a task change from inside the router callback re-routes the vehicle to the new destination', () => {
    loop();
    add({ id: 'Spur', segments: [line([10, 0, 3], [10, 0, 8])] });
    // R gets a second successor: the spur (destination of the new task).
    net().get('R')!.successors.length = 0;
    net().unregister('R');
    add({ id: 'R', segments: [line([5, 0, 0], [10, 0, 3])], successors: ['MR', 'Spur'] });
    net().resolveGraph();
    let arrivedSpur = -1;
    const runner = new DESRunner({ subMode: 'animated' });
    net().setRouter({
      onArrive: (pathId, id) => {
        if (pathId === 'J' && arrivedSpur < 0) {
          getDefaultAgvFleet().get(id)!.assign({
            destination: 'Spur', serviceSec: 1, onArrive: () => { arrivedSpur = runner.getManager().currentTime; },
          });
        }
      },
    }, 'test-router');
    const root = makeAgvRoot('V', { PathId: 'Back', StartPosition: 20000 });
    bindDes(runner, root, makeHost());
    runner.start([], { root: new Object3D() });
    for (let i = 0; i < Math.round(60 / TICK); i++) { runner.tick(TICK); runner.lateTick(TICK); }
    runner.dispose();
    expect(arrivedSpur).toBeGreaterThan(0);
    expect(root.position.z).toBeCloseTo(8, 3);
  });
});
