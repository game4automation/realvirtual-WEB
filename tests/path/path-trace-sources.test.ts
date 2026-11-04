// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-629 §9.2 — the congestion trace sources in the CONTINUOUS kernel (real
 * Agv component, headless): planned vehicles through the authority clock hook,
 * legacy vehicles (UseAcceleration = false) through the traveler state.
 *
 * - a queue in front of a zone held by a stopped vehicle is BLOCKED, the
 *   buckets outside the queue are not; the stopped vehicle itself (Run off)
 *   does not want to move and is not blocked;
 * - a vehicle in service at its destination occupies the bucket, never blocks;
 * - legacy: a free-running vehicle is never blocked (gate R1-2), a legacy
 *   follower behind a stopped one is;
 * - reverse stub manoeuvre with the asymmetric forklift (forks at the rear):
 *   the body interval is `[s − rear, s + front]` in the geometric `s` (gate
 *   R1-3 / R2-3) — checked against `footprint()` at the AUTHORITY position;
 * - M3: `locate(id, t)` between the last sync and the next event is monotone.
 *
 * Every assertion is in authority time (plan-629 addendum on #202): no drawn
 * pose positions, no per-vehicle output signals of planned vehicles.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { iterateFixedUpdate, type BindContextHandle } from '../../src/core/behavior-runtime';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultAgvFleet, AgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultMovementAuthority, setReverseGateOpen } from '../../src/core/engine/rv-movement-authority';
import { PathTraceDriver } from '../../src/core/engine/rv-path-trace-sources';
import type { TraceSink } from '../../src/core/engine/rv-path-trace';
import { TICK, makeHost, makeAgvRoot, bindContinuous, clearShared, footprint, type AgvTestHost } from '../helpers/agv-harness';
import { stubLayout, makeStubWorld, forkCfg, FORK, FORK_MESH } from '../helpers/agv-stub-world';

beforeEach(() => { clearShared(); setReverseGateOpen(true); });
/** Drivers attached in a test — the clock listener outlives clearShared(), so detach after each test. */
const attached: PathTraceDriver[] = [];
afterEach(() => { for (const d of attached.splice(0)) d.detach(); });

/** Ring P0 (20 m) → P1 (zone Z, 4 m) → P2 (10 m) → P3 (24 m) → P4 (10 m) → P0. */
function ring(): void {
  const net = getDefaultPathNetwork();
  const add = (id: string, from: number[], to: number[], succ: string, zone?: string): void => {
    net.register(parsePathExtras({
      type: 'Path', version: 1, id, closed: false, align: [0, 1, 0], successors: [succ],
      segments: [{ kind: 'line', from, to }], ...(zone ? { zone, zoneCapacity: 1 } : {}),
    }, id)!);
  };
  add('P0', [0, 0, 0], [20, 0, 0], 'P1');
  add('P1', [20, 0, 0], [24, 0, 0], 'P2', 'Z');
  add('P2', [24, 0, 0], [24, 0, 10], 'P3');
  add('P3', [24, 0, 10], [0, 0, 10], 'P4');
  add('P4', [0, 0, 10], [0, 0, 0], 'P0');
  net.resolveGraph();
}

interface ContWorld { host: AgvTestHost; handles: BindContextHandle[]; driver: PathTraceDriver; step(): void; run(sec: number): void }

function contWorld(cfgs: Array<[string, Record<string, unknown>]>): ContWorld {
  const host = makeHost();
  const roots = cfgs.map(([n, c]) => makeAgvRoot(n, c));
  const handles = roots.map((r) => bindContinuous(r, host));
  const driver = new PathTraceDriver();
  driver.rebuild(getDefaultPathNetwork().all());
  driver.attachContinuous(getDefaultMovementAuthority('continuous'));
  attached.push(driver);
  const step = (): void => { for (const h of handles) iterateFixedUpdate(h, TICK); driver.tickFixed(TICK); };
  return { host, handles, driver, step, run: (sec) => { for (let i = 0, n = Math.round(sec / TICK); i < n; i++) step(); } };
}

const cart = (pathId: string, startMm: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  PathId: pathId, StartPosition: startMm, TargetSpeed: 1000, VehicleLength: 1200, VehicleWidth: 800, ...extra,
});

describe('PathTrace planned source — continuous kernel (plan-629 §9.2)', () => {
  it('a queue in front of a held zone is blocked; buckets outside the queue are not', () => {
    ring();
    const w = contWorld([['V1', cart('P1', 2000)], ['V2', cart('P0', 3000)]]);
    w.host.signalStore!.set('V1.Agv.Run', false); // stands IN the zone, holds it
    w.run(90);
    const tr = w.driver.trace;
    const fleet = getDefaultAgvFleet();
    expect(fleet.get('V1')!.traceSource).toBe('planned');
    expect(fleet.get('V2')!.traceSource).toBe('planned');
    const p0 = tr.pathBuckets(tr.indexOfPathId('P0'));
    const last = p0.first + p0.count - 1;
    expect(tr.value('blocked', 'window', last)).toBeGreaterThan(0.5);
    for (let j = 0; j < 6; j++) {
      expect(tr.count('blocked', 'start', p0.first + j)).toBe(0);
      if (j > 0) expect(tr.count('utilization', 'start', p0.first + j)).toBeGreaterThan(0); // V2 drove through (starts at 3 m)
    }
    // The stopped zone holder (Run off) does not want to move → its zone piece is occupied, not blocked.
    const p1 = tr.pathBuckets(tr.indexOfPathId('P1'));
    expect(tr.value('utilization', 'start', p1.first)).toBeGreaterThan(0.9);
    for (let j = 0; j < p1.count; j++) expect(tr.count('blocked', 'start', p1.first + j)).toBe(0);
    // Authority time drives the grid.
    const mb = getDefaultMovementAuthority('continuous');
    expect(tr.simTime).toBe(mb.clock.now);
    expect(tr.samplesTotal).toBe(Math.ceil(mb.clock.now / 0.5) - 1);
  });

  it('a vehicle in service at its destination occupies the bucket and never blocks', () => {
    ring();
    const w = contWorld([['S', cart('P0', 1000)]]);
    getDefaultAgvFleet().get('S')!.assign({ destination: 'P2', serviceSec: 1000 });
    w.run(120);
    const tr = w.driver.trace;
    expect(getDefaultAgvFleet().get('S')!.phase).toBe('servicing');
    const p2 = tr.pathBuckets(tr.indexOfPathId('P2'));
    expect(tr.value('utilization', 'start', p2.first + p2.count - 1)).toBeGreaterThan(0.5);
    for (let b = 0; b < tr.bucketCount; b++) expect(tr.count('blocked', 'start', b)).toBe(0);
  });
});

describe('PathTrace legacy source — UseAcceleration = false (gate R1-2)', () => {
  it('a free-running legacy vehicle is never blocked; a legacy follower behind a stopped one is', () => {
    ring();
    const w = contWorld([
      ['Free', cart('P3', 1000, { UseAcceleration: false })],
      ['Lead', cart('P0', 12000, { UseAcceleration: false })],
      ['Foll', cart('P0', 2000, { UseAcceleration: false })],
    ]);
    w.host.signalStore!.set('Lead.Agv.Run', false);
    w.run(60);
    const tr = w.driver.trace;
    const fleet = getDefaultAgvFleet();
    for (const id of ['Free', 'Lead', 'Foll']) expect(fleet.get(id)!.traceSource).toBe('legacy');
    // No planned vehicle: since plan-632 the shared continuous clock still advances once per frame (one tick
    // time per frame), so clock and dt sum agree. Sampled exactly once per raster point - no double counting
    // between the clock hook and the dt-sum time base.
    expect(getDefaultMovementAuthority('continuous').clock.now).toBeCloseTo(60, 6);
    expect(tr.samplesTotal).toBe(Math.ceil(60 / 0.5) - 1);
    expect(tr.simTime).toBeCloseTo(60, 6);
    // Free ran around the ring (P3 → P4 → P0 …): occupied buckets, nothing blocked on P3/P4.
    for (const id of ['P3', 'P4']) {
      const pb = tr.pathBuckets(tr.indexOfPathId(id));
      let occ = 0;
      for (let j = 0; j < pb.count; j++) {
        occ += tr.count('utilization', 'start', pb.first + j);
        expect(tr.count('blocked', 'start', pb.first + j)).toBe(0);
      }
      expect(occ).toBeGreaterThan(0);
    }
    // Foll queues behind Lead on P0 (≈ 12 m − safety distance) → blocked buckets there; Lead's own bucket
    // (Run off) is occupied but not blocked unless a blocked follower body reaches into it.
    const p0 = tr.pathBuckets(tr.indexOfPathId('P0'));
    let blocked = 0;
    for (let j = 0; j < p0.count; j++) blocked += tr.count('blocked', 'window', p0.first + j);
    expect(blocked).toBeGreaterThan(0);
    const leadBucket = p0.first + Math.floor(12 / p0.length);
    expect(tr.value('utilization', 'start', leadBucket)).toBeGreaterThan(0.9);
  });
});

describe('PathTrace body interval — reverse stub manoeuvre (gate R1-3 / R2-3)', () => {
  it('forklift reversing into a stub: [s − rear, s + front] in geometric s, matching footprint() at the authority position', () => {
    stubLayout();
    const w = makeStubWorld('continuous', [{ name: 'F', cfg: forkCfg('L0', 3500), mesh: FORK_MESH, body: FORK }], 300);
    // Only the forklift (the stub world's parked Clock timers stay out of the record).
    const only = new AgvFleet();
    only.register(getDefaultAgvFleet().get('F')!);
    const driver = new PathTraceDriver(undefined, only);
    driver.rebuild(getDefaultPathNetwork().all());
    const covers: Array<{ p: number; a: number; b: number; blocked: boolean }> = [];
    const rec: TraceSink = { sampleTime: 0, cover: (p, a, b, blocked) => { covers.push({ p, a, b, blocked }); } };
    driver.sampler.planned = w.mb;
    getDefaultAgvFleet().get('F')!.assign({ destination: 'S2', approach: 'reverse' });
    const net = getDefaultPathNetwork();
    const stub = net.get('S2')!;
    const sIdx = driver.trace.indexOfPathId('S2');
    let checked = 0, forwardChecked = 0;
    const a = new Vector3(), b = new Vector3(), probe = new Object3D();
    while (!w.done() && checked < 5) {
      w.step();
      const t = w.now();
      const loc = w.mb.locate('F', t)!;
      const dir = w.mb.planDirOf('F');
      covers.length = 0;
      driver.sampler.sample(t, rec);
      expect(covers.length).toBe(1);
      const c = covers[0];
      expect(driver.trace.paths[c.p]).toBe(loc.path);
      expect(c.b - loc.s).toBeCloseTo(FORK.front, 6); // mesh-derived (float32 geometry)  // never mirrored by the travel direction
      expect(loc.s - c.a).toBeCloseTo(FORK.rear, 6);
      if (dir === 1 && loc.path.id === 'L0' && forwardChecked === 0) forwardChecked++;
      if (dir === -1 && c.p === sIdx && loc.s > FORK.rear + 0.05 && loc.s < stub.length - FORK.front - 0.05) {
        // Pose from the AUTHORITY position (not the drawn root); orientation = the piece's positive
        // tangent (a planned vehicle does not turn when it reverses). The footprint's ends are the interval.
        stub.getAbsPosition(loc.s, probe.position);
        stub.getAbsDirection(loc.s, a);
        probe.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), a.setY(0).normalize());
        const fp = footprint(probe, FORK);
        stub.getAbsPosition(c.b, a);
        stub.getAbsPosition(c.a, b);
        expect(Math.hypot(fp.cx + fp.fx - a.x, fp.cz + fp.fz - a.z)).toBeLessThan(1e-6); // front end
        expect(Math.hypot(fp.cx - fp.fx - b.x, fp.cz - fp.fz - b.z)).toBeLessThan(1e-6); // rear (fork) end
        checked++;
      }
    }
    w.dispose();
    expect(forwardChecked).toBe(1);
    expect(checked).toBe(5);
  });
});

describe('M3 — locate() between the last sync and the next event', () => {
  it('route coordinate and piece index are monotone for any t in [now, nextEvent)', () => {
    ring();
    const w = contWorld([['M', cart('P0', 1000)]]);
    const mb = getDefaultMovementAuthority('continuous');
    let checks = 0;
    for (let i = 0; i < 60 * 40; i++) {
      w.step();
      const now = mb.clock.now;
      const end = Math.min(mb.clock.nextEventTime, now + 2);
      let lastX = -Infinity, lastPath = mb.locate('M', now)!.path;
      const order = ['P0', 'P1', 'P2', 'P3', 'P4'];
      for (let j = 0; j < 8; j++) {
        const loc = mb.locate('M', now + ((end - now) * j) / 8)!;
        expect(loc.x).toBeGreaterThanOrEqual(lastX - 1e-12);
        const di = (order.indexOf(loc.path.id) - order.indexOf(lastPath.id) + 5) % 5;
        expect(di === 0 || di === 1).toBe(true);
        lastX = loc.x; lastPath = loc.path;
        checks++;
      }
    }
    expect(checks).toBe(60 * 40 * 8);
  });
});
