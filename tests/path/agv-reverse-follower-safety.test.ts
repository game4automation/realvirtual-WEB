// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-595 §9.5 (F7, G2) + the go-around rule of R3-1.
 *
 * G2 — reverse travel only on exclusively held track: `setDirection(…, -1)` is
 * refused when a piece of the reverse route has no zone, a zone with capacity
 * ≠ 1, or when the vehicle does not hold the zone it starts in; it is accepted
 * once all of that holds — and then nobody else can be rooted in the start run.
 *
 * Go-around: a forklift that is already INSIDE the merge zone when its reverse
 * task comes cannot claim the stub zone together with M; if the stub zone is
 * taken at the turn point it does NOT wait inside M — it drives on, comes back
 * on the next lap and runs the manoeuvre then.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { iterateFixedUpdate } from '../../src/core/behavior-runtime';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultPathDockRegistry } from '../../src/core/engine/rv-path-dock';
import { getDefaultMovementAuthority, setReverseGateOpen } from '../../src/core/engine/rv-movement-authority';
import { speedAt } from '../../src/core/engine/rv-motion-profile';
import { TICK, makeHost, makeAgvRoot, bindContinuous, clearShared } from '../helpers/agv-harness';
import { stubLayout, makeStubWorld, forkCfg, FORK, FORK_MESH, delay } from '../helpers/agv-stub-world';

beforeEach(() => { clearShared(); setReverseGateOpen(true); });
afterEach(() => setReverseGateOpen(true));

describe('plan-595 9.5 — reverse travel only on exclusively held track (G2)', () => {
  it('continuous: refused without zone / with capacity 2 / without holding the start zone; accepted when exclusive', () => {
    const net = getDefaultPathNetwork();
    const add = (id: string, from: number[], to: number[], succ: string[], zone?: string, cap = 1): void => {
      net.register(parsePathExtras({
        type: 'Path', version: 1, id, closed: false, align: [0, 1, 0],
        segments: [{ kind: 'line', from, to }], successors: succ, ...(zone ? { zone, zoneCapacity: cap } : {}),
      }, id)!);
    };
    add('P0', [-4, 0, 0], [0, 0, 0], ['P1']);               // no zone
    add('P1', [0, 0, 0], [4, 0, 0], ['P2'], 'Z1');
    add('P2', [4, 0, 0], [8, 0, 0], ['P3'], 'Z2');
    add('P3', [8, 0, 0], [12, 0, 0], [], 'W3', 2);          // capacity 2
    net.resolveGraph();
    const zones = getDefaultZoneRegistry();
    zones.define('W3', 2);
    const host = makeHost();
    const root = makeAgvRoot('R', { PathId: 'P2', StartPosition: 2000, VehicleLength: 1200, VehicleWidth: 800, ScannerFields: false, AllowReverse: true });
    const h = bindContinuous(root, host);
    const mb = getDefaultMovementAuthority('continuous');
    host.signalStore!.set('R.Agv.Run', false);
    iterateFixedUpdate(h, TICK);
    expect(mb.speedOf('R', mb.clock.now)).toBe(0);           // precondition: standstill
    expect(zones.isHolder('Z2', 'R')).toBe(true);            // … holding its start zone
    const P = (id: string) => net.get(id)!;
    const refused = (route: string[]): boolean => {
      const before = mb.stats.dirRefused;
      const ok = mb.setDirection('R', -1, route.map(P));
      return !ok && mb.stats.dirRefused === before + 1 && mb.planDirOf('R') === 1;
    };
    expect(refused(['P2', 'P1', 'P0'])).toBe(true);          // a piece without a zone
    expect(refused(['P3'])).toBe(true);                      // not the piece it stands on
    zones.release('Z2', 'R');
    zones.claim('Z2', 'ghost');
    expect(refused(['P2', 'P1'])).toBe(true);                // start zone held by someone else
    zones.release('Z2', 'ghost');
    zones.claim('Z2', 'R');
    // capacity ≠ 1: a route that runs through the capacity-2 zone
    const root2 = makeAgvRoot('Q', { PathId: 'P3', StartPosition: 1000, VehicleLength: 1200, VehicleWidth: 800, ScannerFields: false });
    const h2 = bindContinuous(root2, host);
    host.signalStore!.set('Q.Agv.Run', false);
    iterateFixedUpdate(h2, TICK);
    const before = mb.stats.dirRefused;
    expect(mb.setDirection('Q', -1, [P('P3'), P('P2')])).toBe(false);
    expect(mb.stats.dirRefused).toBe(before + 1);
    // Exclusive: accepted — and nobody else is rooted in the held start run.
    expect(mb.setDirection('R', -1, [P('P2'), P('P1')])).toBe(true);
    expect(zones.holderCount('Z2')).toBe(1);
    expect(mb.locate('Q', mb.clock.now)!.path).not.toBe(P('P2'));
  });

  it('animated: already inside M with the stub zone taken — goes around, serves on the next lap', () => {
    stubLayout();
    // The forklift starts INSIDE the merge zone M2 (on Pre2) — no chance to claim K2 together with M2.
    const w = makeStubWorld('animated', [{ name: 'F', cfg: forkCfg('Pre2', 500), mesh: FORK_MESH, body: FORK }], 600);
    const zones = getDefaultZoneRegistry();
    const fleet = getDefaultAgvFleet();
    expect(zones.isHolder('M2', 'F')).toBe(true);            // precondition
    zones.claim('K2', 'ghost');                              // the stub zone is taken
    let dockT = -1, done = false;
    getDefaultPathDockRegistry().register('S2', { onVehicleArrive: (_id, release) => { dockT = w.now(); delay(2, release); } });
    let passedTurnT = -1;
    getDefaultPathNetwork().setRouter({
      onArrive: (pathId, id) => {
        if (id !== 'F') return;
        if (pathId === 'Turn2' && passedTurnT < 0) passedTurnT = w.now();
        // Free again once the forklift has gone around the turn point — for the next lap.
        if (pathId === 'L2' && passedTurnT >= 0 && zones.isHolder('K2', 'ghost')) zones.release('K2', 'ghost');
      },
    }, 'agv-go-around');
    fleet.get('F')!.assign({ destination: 'S2', approach: 'reverse', onServiceEnd: () => { done = true; } });
    let reverseBeforeLap = false, drivesOn: boolean | null = null;
    while (!w.done() && !done) {
      w.step();
      const now = w.now();
      if (passedTurnT >= 0 && zones.isHolder('K2', 'ghost') && w.mb.planDirOf('F') === -1) reverseBeforeLap = true;
      if (drivesOn === null && passedTurnT >= 0) {
        // The plan applied at the turn point drives on at once (no wait inside M2): 0.5 s later it moves forward.
        const pl = w.mb.planOf('F')!;
        drivesOn = pl.dir === 1 && speedAt(pl.profile, passedTurnT + 0.5) > 0;
      }
      void now;
    }
    w.dispose();
    expect(passedTurnT).toBeGreaterThan(0);                  // reached the turn point …
    expect(reverseBeforeLap).toBe(false);                    // … did not reverse there …
    expect(drivesOn).toBe(true);                             // … and did not stand inside M2 waiting for K2
    expect(dockT).toBeGreaterThan(passedTurnT + 30);         // served on the next lap (ring ~100 m)
    expect(done).toBe(true);
  }, 120000);
});
