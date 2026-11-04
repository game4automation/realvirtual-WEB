// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-595 §9.1 (F1/F2) — reverse travel is forward travel in a MIRRORED route
 * frame.
 *
 * A chain P1 → P2 → P3 (P3 angled) is driven backwards from P3 to the start of
 * P1. The plan route is the PREDECESSOR chain, the plan carries `dir = -1`, the
 * root stays on the geometry with the PATH tangent as heading (rear first), the
 * arc progress along the reversed chain is monotone, the vehicle arrives at the
 * start of P1 and the built-in verifier stays at `violations === 0` — in the
 * continuous kernel and in DES Animated.
 *
 * Body projection (`lead`/`trail`): with asymmetric bodies, a reverse vehicle R
 * behind a reverse vehicle U (in travel direction — geometrically BEHIND R)
 * measures the gap from its REAR to U's FRONT (`minFrontRearGap`, route
 * projection, plan-595 D), which matches the geometric gap; a vehicle W that is
 * geometrically AHEAD of R (behind it in travel direction) is no leader. The
 * SAT oracle of the harness confirms that no footprints overlap.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { iterateFixedUpdate, type BindContextHandle } from '../../src/core/behavior-runtime';
import { parsePathExtras, type RVPath } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultMovementAuthority, setReverseGateOpen } from '../../src/core/engine/rv-movement-authority';
import { DESRunner } from '@rv/plugins/des/des-runner';
import {
  TICK, makeHost, makeAgvRoot, bindContinuous, bindDes, clearShared, footprint, satOverlap, type BodyExtents,
} from '../helpers/agv-harness';

beforeEach(() => { clearShared(); setReverseGateOpen(true); });
afterEach(() => setReverseGateOpen(true)); // restore the default

/** P1 (0,0,0)→(4,0,0), P2 →(8,0,0), P3 angled →(12,0,3); one capacity-1 zone per piece. */
function chain(): { P1: RVPath; P2: RVPath; P3: RVPath } {
  const net = getDefaultPathNetwork();
  const add = (id: string, from: number[], to: number[], succ: string[]): void => {
    net.register(parsePathExtras({
      type: 'Path', version: 1, id, closed: false, align: [0, 1, 0],
      segments: [{ kind: 'line', from, to }], successors: succ, zone: `Z${id}`, zoneCapacity: 1,
    }, id)!);
  };
  add('P1', [0, 0, 0], [4, 0, 0], ['P2']);
  add('P2', [4, 0, 0], [8, 0, 0], ['P3']);
  add('P3', [8, 0, 0], [12, 0, 3], []);
  net.resolveGraph();
  return { P1: net.get('P1')!, P2: net.get('P2')!, P3: net.get('P3')! };
}

const _p = new Vector3();
const _d = new Vector3();
const _fwd = new Vector3();

/** Closest point of the reversed chain [P3, P2, P1]: distance, arc progress from R's start, tangent. */
function project(chainRev: RVPath[], startS: number, pos: Vector3): { dist: number; progress: number; dot: number } {
  let best = { dist: Infinity, progress: 0, dot: 0 };
  let before = 0; // reversed arc length before this piece
  for (let k = 0; k < chainRev.length; k++) {
    const q = chainRev[k];
    const a = q.getAbsPosition(0, new Vector3());
    const b = q.getAbsPosition(q.length, new Vector3());
    const ab = b.clone().sub(a);
    const t = Math.min(1, Math.max(0, pos.clone().sub(a).dot(ab) / ab.lengthSq()));
    const c = a.clone().addScaledVector(ab, t);
    const dist = c.distanceTo(pos);
    const s = t * q.length;
    const progress = k === 0 ? startS - s : before + (q.length - s);
    if (dist < best.dist - 1e-9) best = { dist, progress, dot: 0 };
    if (k === 0) before = startS; else before += q.length;
  }
  return best;
}

describe('plan-595 9.1 — mirrored route frame', () => {
  for (const mode of ['continuous', 'animated'] as const) {
    it(`${mode}: reverse P3 → P1 over the predecessors, pose on the geometry, arrival at s = 0`, () => {
      const { P1, P2, P3 } = chain();
      const host = makeHost();
      const root = makeAgvRoot('R', { PathId: 'P3', StartPosition: 3000, TargetSpeed: 800, ScannerFields: false,
        VehicleLength: 0, VehicleWidth: 0 }, { length: 1.6, width: 0.8, rootOffset: 0.3 });
      let step: () => void;
      let now: () => number;
      let dispose = (): void => {};
      const mb = getDefaultMovementAuthority(mode === 'continuous' ? 'continuous' : 'des');
      if (mode === 'continuous') {
        const h: BindContextHandle = bindContinuous(root, host);
        step = () => iterateFixedUpdate(h, TICK);
        now = () => mb.clock.now;
      } else {
        const runner = new DESRunner({ subMode: 'animated' });
        bindDes(runner, root, host);
        runner.start([], { root: new Object3D() });
        step = () => { runner.tick(TICK); runner.lateTick(TICK); };
        now = () => runner.getManager().currentTime;
        dispose = () => runner.dispose();
      }
      // Body from the mesh: root 0.3 m behind the body centre → front 1.1 m, rear 0.5 m.
      const body = mb.bodyOf('R')!;
      expect(body.front).toBeCloseTo(1.1, 6);
      expect(body.rear).toBeCloseTo(0.5, 6);
      expect(mb.setDirection('R', -1, [P3, P2, P1])).toBe(true);

      const rev = [P3, P2, P1];
      let lastProgress = -Infinity;
      let maxDist = 0, minDot = Infinity, frames = 0, routeOk = false;
      for (let f = 0; f < 60 * 60; f++) {
        step();
        const pl = mb.planOf('R')!;
        if (pl.dir !== -1) continue;
        if (!routeOk && pl.route.length === 3) {
          // The route is the predecessor chain of the start piece.
          expect(pl.route.map((e) => e.path.id)).toEqual(['P3', 'P2', 'P1']);
          for (let i = 0; i + 1 < pl.route.length; i++) expect(pl.route[i].path.predecessors).toContain(pl.route[i + 1].path);
          routeOk = true;
        }
        const pr = project(rev, 3, root.position);
        maxDist = Math.max(maxDist, pr.dist);
        expect(pr.progress).toBeGreaterThanOrEqual(lastProgress - 1e-9);
        lastProgress = pr.progress;
        // Heading = path tangent of the piece the root is on (the body keeps its orientation).
        const loc = mb.locate('R', now());
        if (loc) {
          loc.path.getAbsDirection(loc.s, _d);
          _fwd.set(0, 0, 1).applyQuaternion(root.quaternion);
          // Only where the pose and the authority agree on the piece (DES renders on its own clock).
          loc.path.getAbsPosition(loc.s, _p);
          if (_p.distanceTo(root.position) < 1e-6) minDot = Math.min(minDot, _fwd.dot(_d));
        }
        frames++;
        if (pl.stopCause === 'deadend' && mb.speedOf('R', now()) === 0 && root.position.length() < 1e-6) break;
      }
      expect(routeOk).toBe(true);
      expect(frames).toBeGreaterThan(30);
      expect(maxDist).toBeLessThan(1e-6);
      expect(minDot).toBeGreaterThan(1 - 1e-9);
      // Arrival at the START of P1 (the end of the mirrored route).
      expect(root.position.distanceTo(P1.getAbsPosition(0, new Vector3()))).toBeLessThan(1e-6);
      expect(lastProgress).toBeCloseTo(3 + 4 + 4, 6);
      expect(mb.planDirOf('R')).toBe(-1);
      expect(mb.stats.violations).toBe(0);
      dispose();
    }, 60000);
  }

  it('lead / trail: R measures rear-to-front against U ahead in travel direction; W behind is no leader', () => {
    const { P1, P2, P3 } = chain();
    const host = makeHost();
    // R: front 1.1, rear 0.5 (lead in reverse = 0.5). U: front 1.0, rear 0.2 (trail in reverse = 1.0).
    const bodyR: BodyExtents = { front: 1.1, rear: 0.5, width: 0.8 };
    const bodyU: BodyExtents = { front: 1.0, rear: 0.2, width: 0.8 };
    const bodyW: BodyExtents = { front: 0.5, rear: 0.5, width: 0.8 };
    const rootR = makeAgvRoot('R', { PathId: 'P3', StartPosition: 2000, TargetSpeed: 800, ScannerFields: false,
      VehicleLength: 0, VehicleWidth: 0, SafetyGap: 300 }, { length: 1.6, width: 0.8, rootOffset: 0.3 });
    const rootU = makeAgvRoot('U', { PathId: 'P1', StartPosition: 3000, TargetSpeed: 800, ScannerFields: false,
      VehicleLength: 0, VehicleWidth: 0 }, { length: 1.2, width: 0.8, rootOffset: 0.4 });
    const rootW = makeAgvRoot('W', { PathId: 'P3', StartPosition: 4300, TargetSpeed: 800, ScannerFields: false,
      VehicleLength: 1000, VehicleWidth: 800 });
    const hs = [rootR, rootU, rootW].map((r) => bindContinuous(r, host));
    const tick = (): void => { for (const h of hs) iterateFixedUpdate(h, TICK); };
    const mb = getDefaultMovementAuthority('continuous');
    host.signalStore!.set('W.Agv.Run', false);
    expect(mb.setDirection('U', -1, [P1])).toBe(true);
    expect(mb.setDirection('R', -1, [P3, P2, P1])).toBe(true);
    // U starts reversing, then is stopped (Run off: the hold keeps U's reverse frame).
    tick();
    host.signalStore!.set('U.Agv.Run', false);
    let overlap = 0;
    let t = 0;
    let opposite0 = -1;
    for (let f = 0; f < 60 * 40; f++) {
      tick();
      t = mb.clock.now;
      // From here on both reverse vehicles carry dir = -1 plans (the very first flush may still see U's initial plan).
      if (f === 10) opposite0 = mb.stats.oppositeEncounters;
      const fr = footprint(rootR, bodyR), fu = footprint(rootU, bodyU), fw = footprint(rootW, bodyW);
      if (satOverlap(fr, fu) > 1e-6 || satOverlap(fr, fw) > 1e-6 || satOverlap(fu, fw) > 1e-6) overlap++;
    }
    expect(overlap).toBe(0);
    expect(mb.planDirOf('U')).toBe(-1);
    expect(mb.planDirOf('R')).toBe(-1);
    expect(mb.speedOf('R', t)).toBe(0);
    expect(mb.speedOf('U', t)).toBe(0);
    // R stands behind U, bound by the leader trajectory with G = lead(R) + trail(U) + gap
    // = rear_R + front_U + gap (the zone entrance of P1, which U holds, lies further on).
    const lr = mb.locate('R', t)!, lu = mb.locate('U', t)!;
    expect(lu.path).toBe(P1);
    expect(lr.path).toBe(P2);
    expect(mb.stopCauseOf('R')).toBe('leader');
    const G = bodyR.rear + bodyU.front + 0.3;
    expect(lr.s).toBeCloseTo(G - (P1.length - lu.s), 6);
    expect(lr.s).toBeGreaterThan(0.5 + 0.05); // the leader stop binds before the zone stop
    // Geometric gap along the straight lane: R's rear at x = 4 + s_R − 0.5, U's front at x = s_U + 1.0.
    const geoGap = (4 + lr.s - bodyR.rear) - (lu.s + bodyU.front);
    expect(geoGap).toBeGreaterThan(0);
    expect(geoGap).toBeCloseTo(0.3, 6); // exactly the SafetyGap
    expect(mb.minFrontRearGap(t)).toBeCloseTo(geoGap, 6); // mesh bounds are float32
    // The forward formula (front of R, rear of U) would give a different number — the test discriminates.
    expect(Math.abs((4 + lr.s - bodyR.front) - (lu.s + bodyU.rear) - geoGap)).toBeGreaterThan(0.1);
    // W (forward, geometrically ahead of R on the same piece) is never seen as R's leader nor as an
    // opposite vehicle on R's route.
    expect(opposite0).toBeGreaterThanOrEqual(0);
    expect(mb.stats.oppositeEncounters).toBe(opposite0);
    expect(mb.stats.violations).toBe(0);
  }, 60000);
});
