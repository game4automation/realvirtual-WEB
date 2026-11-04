// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-595 §9.3 — zone ownership across direction changes (the riskiest point).
 *
 * 1. Stub manoeuvre (forks at the rear: rear 1.6 m > front 0.8 m): the stub
 *    zone K2 is held continuously from its claim (together with M2) through
 *    BOTH direction changes and released exactly once — when the trailing end
 *    has left the stub. The merge zone M2 survives the direction change at the
 *    turn point and is released only once the body has left it. A second
 *    forklift with a task to the same stub waits before the stub and never
 *    enters it while the first one holds it. Every release is checked at its
 *    own event time against the body pose re-computed from the applied plan
 *    (all three kernels, FastForward included).
 * 2. The release fix of plan-595 (held keys at a direction change): a forklift
 *    stops with its REAR still overhanging the previous zone Z1, a cart waits
 *    for Z1, and the forklift reverses back into Z1. Z1 must not be released
 *    while the body covers it (the forward key tested with the new trailing end
 *    — the front — would release it at the direction change), the cart never
 *    enters, the SAT oracle sees no overlap.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D } from 'three';
import { iterateFixedUpdate } from '../../src/core/behavior-runtime';
import { parsePathExtras, type RVPath } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultPathDockRegistry } from '../../src/core/engine/rv-path-dock';
import { getDefaultMovementAuthority, setReverseGateOpen, type MbPlan } from '../../src/core/engine/rv-movement-authority';
import { TICK, makeHost, makeAgvRoot, bindContinuous, clearShared, footprint, satOverlap, type BodyExtents } from '../helpers/agv-harness';
import {
  stubLayout, makeStubWorld, forkCfg, FORK, FORK_MESH, delay, frameOverlap, planPose, type Mode,
} from '../helpers/agv-stub-world';

beforeEach(() => { clearShared(); setReverseGateOpen(true); });
afterEach(() => setReverseGateOpen(true)); // restore the default

/** Footprint of a path piece as a lane of `width` (m) — straight pieces only. */
function laneOf(path: RVPath, width: number): ReturnType<typeof footprint> {
  const o = new Object3D();
  path.getAbsPosition(path.length / 2, o.position);
  const d = path.getAbsDirection(path.length / 2, o.position.clone()).normalize();
  o.quaternion.setFromUnitVectors(new Object3D().up.set(0, 0, 1), d);
  return footprint(o, { front: path.length / 2, rear: path.length / 2, width });
}

interface ZoneEvent { t: number; zone: string; agv: string; kind: 'claim' | 'release'; penIn: number }

describe('plan-595 9.3 — zone hold across both direction changes', () => {
  for (const mode of ['animated', 'fastforward', 'continuous'] as Mode[]) {
    it(`${mode}: K2 held from the claim to the trailing end leaving the stub; M2 survives the turn; B waits before the stub`, () => {
      stubLayout();
      const w = makeStubWorld(mode, [
        { name: 'F', cfg: forkCfg('L0', 5000), mesh: FORK_MESH, body: FORK },
        { name: 'B', cfg: forkCfg('R2', 30000), mesh: FORK_MESH, body: FORK },
      ], 600);
      const { mb } = w;
      const net = getDefaultPathNetwork();
      const zones = getDefaultZoneRegistry();
      const fleet = getDefaultAgvFleet();
      const lanes: Record<string, ReturnType<typeof footprint>> = {};
      for (const id of ['S2', 'Mouth2', 'Pre2', 'Turn2']) lanes[id] = laneOf(net.get(id)!, FORK.width);
      const piecesOf: Record<string, string[]> = { K2: ['S2'], M2: ['Mouth2', 'Pre2', 'Turn2'] };
      const events: ZoneEvent[] = [];
      const pose = new Object3D();
      const pen = (agv: string, zone: string): number => {
        planPose(mb.planOf(agv)! as MbPlan, w.now(), pose);
        const fp = footprint(pose, FORK);
        return Math.max(...piecesOf[zone].map((id) => satOverlap(fp, lanes[id])));
      };
      const claim = zones.claim.bind(zones), release = zones.release.bind(zones);
      zones.claim = (z: string, a: string): boolean => {
        const had = zones.isHolder(z, a);
        const ok = claim(z, a);
        if (ok && !had && piecesOf[z]) events.push({ t: w.now(), zone: z, agv: a, kind: 'claim', penIn: pen(a, z) });
        return ok;
      };
      zones.release = (z: string, a: string): void => {
        const had = zones.isHolder(z, a);
        if (had && piecesOf[z]) events.push({ t: w.now(), zone: z, agv: a, kind: 'release', penIn: pen(a, z) });
        release(z, a);
      };
      const done: Record<string, number> = {};
      const dock: Record<string, number> = {};
      getDefaultPathDockRegistry().register('S2', { onVehicleArrive: (id, rel) => { dock[id] = w.now(); delay(20, rel); } });
      for (const id of ['F', 'B']) {
        fleet.get(id)!.assign({ destination: 'S2', approach: 'reverse', onServiceEnd: () => { done[id] = w.now(); fleet.get(id)!.clear(); } });
      }
      let bInStubWhileFHolds = 0, overlap = 0;
      try {
        while (!w.done() && Object.keys(done).length < 2) {
          w.step();
          if (mode === 'fastforward') continue;
          if (zones.isHolder('K2', 'F') && satOverlap(footprint(w.roots.B, FORK), lanes.S2) > 1e-6) bInStubWhileFHolds++;
          if (frameOverlap(w).hit) overlap++;
        }
      } finally {
        zones.claim = claim;
        zones.release = release;
      }
      const ev = (agv: string, zone: string): ZoneEvent[] => events.filter((e) => e.agv === agv && e.zone === zone);
      // F: K2 claimed once (together with M2, before the body is near the stub), released once — after
      // the trailing end left the stub (penetration ≤ 0 at the release instant).
      const fk = ev('F', 'K2');
      expect(fk.map((e) => e.kind)).toEqual(['claim', 'release']);
      expect(fk[0].penIn).toBeLessThanOrEqual(1e-6);
      expect(fk[1].penIn).toBeLessThanOrEqual(1e-6);
      expect(fk[0].t).toBeLessThan(dock.F);
      expect(fk[1].t).toBeGreaterThan(done.F);
      // M2: one visit in (claim … release once the body has left M2 on the reverse leg — after the
      // turn point, before the dock), one visit out (after the stay).
      const fm = ev('F', 'M2').slice(0, 4); // later laps of the cruising forklift pass M2 again (FastForward runs on)
      expect(fm.map((e) => e.kind)).toEqual(['claim', 'release', 'claim', 'release']);
      expect(fm[0].t).toBe(fk[0].t);                    // claimed together (K before M)
      expect(fm[1].t).toBeLessThan(dock.F);
      for (const e of fm) if (e.kind === 'release') expect(e.penIn).toBeLessThanOrEqual(1e-6);
      // B: claims M2 + K2 only after F gave K2 back, and serves after F.
      const bk = ev('B', 'K2');
      expect(bk[0].kind).toBe('claim');
      expect(bk[0].t).toBeGreaterThanOrEqual(fk[1].t);
      expect(dock.B).toBeGreaterThan(done.F);
      expect(done.B).toBeDefined();
      expect(mb.stats.violations).toBe(0);
      if (mode !== 'fastforward') { expect(bInStubWhileFHolds).toBe(0); expect(overlap).toBe(0); }
      w.dispose();
    }, 300000);
  }

  it('continuous: a zone the rear still covers is not released at the direction change (release fix)', () => {
    const net = getDefaultPathNetwork();
    const add = (id: string, from: number[], to: number[], succ: string[], zone?: string): void => {
      net.register(parsePathExtras({
        type: 'Path', version: 1, id, closed: false, align: [0, 1, 0],
        segments: [{ kind: 'line', from, to }], successors: succ, ...(zone ? { zone, zoneCapacity: 1 } : {}),
      }, id)!);
    };
    add('Q', [-10, 0, 0], [0, 0, 0], ['P1']);
    add('P1', [0, 0, 0], [8, 0, 0], ['P2'], 'Z1');
    add('P2', [8, 0, 0], [9.2, 0, 0], [], 'Z2');
    net.resolveGraph();
    const host = makeHost();
    // Forklift: front 0.6 m, rear 1.6 m (root 0.5 m ahead of the body centre).
    const F: BodyExtents = { front: 0.6, rear: 1.6, width: 1.0 };
    const W: BodyExtents = { front: 0.6, rear: 0.6, width: 0.8 };
    const rootF = makeAgvRoot('F', { PathId: 'P1', StartPosition: 2000, TargetSpeed: 1200, ScannerFields: false,
      VehicleLength: 0, VehicleWidth: 0, DockingSpeed: 300 }, { length: 2.2, width: 1.0, rootOffset: -0.5 });
    const rootW = makeAgvRoot('W', { PathId: 'Q', StartPosition: 4000, TargetSpeed: 1000, ScannerFields: false,
      VehicleLength: 1200, VehicleWidth: 800 });
    const hs = [rootF, rootW].map((r) => bindContinuous(r, host));
    const mb = getDefaultMovementAuthority('continuous');
    const zones = getDefaultZoneRegistry();
    const tick = (): void => { for (const h of hs) iterateFixedUpdate(h, TICK); };
    expect(mb.bodyOf('F')!.rear).toBeCloseTo(1.6, 6);
    const releases: { t: number; rearX: number }[] = [];
    const release = zones.release.bind(zones);
    zones.release = (z: string, a: string): void => {
      if (z === 'Z1' && a === 'F' && zones.isHolder(z, a)) releases.push({ t: mb.clock.now, rearX: rootF.position.x - F.rear });
      release(z, a);
    };
    let overlap = 0, wInP1 = 0, phase = 0, t0 = 0, minX = Infinity, reverseSeen = false;
    try {
      for (let f = 0; f < 60 * 40; f++) {
        tick();
        const now = mb.clock.now;
        if (satOverlap(footprint(rootF, F), footprint(rootW, W)) > 1e-6) overlap++;
        if (rootW.position.x + W.front > 1e-6 && zones.isHolder('Z1', 'F')) wInP1++;
        const pl = mb.planOf('F')!;
        if (pl.dir === -1) reverseSeen = true;
        if (phase >= 1) minX = Math.min(minX, rootF.position.x);
        if (phase === 0 && pl.stopCause === 'deadend' && now >= pl.profile.tEnd && mb.speedOf('F', now) === 0) {
          // Standstill at the end of P2: the rear (1.6 m) still overhangs P1 (Z1 held), W waits for Z1.
          expect(rootF.position.x - F.rear).toBeLessThan(8);
          expect(zones.isHolder('Z1', 'F')).toBe(true);
          expect(mb.setDirection('F', -1, [net.get('P2')!, net.get('P1')!])).toBe(true);
          // setDirection only marks the vehicle dirty — a Run edge makes it re-plan now.
          host.signalStore!.set('F.Agv.Run', false);
          phase = 1; t0 = now;
        } else if (phase === 1 && host.values.get('F.Agv.Run') === false) {
          host.signalStore!.set('F.Agv.Run', true);
        } else if (phase === 1 && now - t0 > 2) {
          host.signalStore!.set('F.Agv.Run', false);   // stop inside P2 / P1 after ~0.6 m of reverse travel
          phase = 2; t0 = now;
        } else if (phase === 2 && now - t0 > 2 && mb.speedOf('F', now) === 0) {
          expect(mb.setDirection('F', 1)).toBe(true);  // and forward again (second direction change)
          host.signalStore!.set('F.Agv.Run', true);
          phase = 3; t0 = now;
        } else if (phase === 3 && now - t0 > 6) break;
      }
    } finally {
      zones.release = release;
    }
    // Z1 never released while the forklift's body covered P1 (x < 8), W never entered P1, no overlap.
    for (const r of releases) expect(r.rearX).toBeGreaterThanOrEqual(8);
    expect(phase).toBe(3);
    expect(reverseSeen).toBe(true);
    expect(minX).toBeLessThan(9.2 - 0.3);               // it really reversed back toward P1
    expect(zones.isHolder('Z1', 'F')).toBe(true);
    expect(wInP1).toBe(0);
    expect(overlap).toBe(0);
    expect(mb.stats.violations).toBe(0);
  }, 120000);
});
