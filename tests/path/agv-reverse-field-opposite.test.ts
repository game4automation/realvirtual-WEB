// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-595 §9.16 (R3-3) — the scanner field sees opposite-direction vehicles.
 *
 * G2 keeps opposite-direction vehicles OUT of the leader projection (exclusive
 * zones are the traffic rule). The protective field is the second, independent
 * layer and must not inherit that filter. Layout: P1 (Z1) → P2 (Z2) → P3 (Z3).
 * A cart U stands on P1 facing +x; it holds only Z1, but its front overhangs
 * into P2. A forklift R reverses from P3 toward it: the zones let R into P2 (its
 * stop is at the Z1 entrance — right inside U's front), so ONLY the field can
 * stop it before contact. Then, standing in the protective field, R changes
 * direction: the field does not report clear before the exit plus the 0.5 s
 * restart lock, then R leaves forward. Continuous kernel (Run edges re-plan at
 * once); SAT oracle for contact.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { iterateFixedUpdate } from '../../src/core/behavior-runtime';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { getDefaultMovementAuthority, setReverseGateOpen } from '../../src/core/engine/rv-movement-authority';
import { TICK, makeHost, makeAgvRoot, bindContinuous, clearShared, footprint, satOverlap, sig, type BodyExtents } from '../helpers/agv-harness';

beforeEach(() => { clearShared(); setReverseGateOpen(true); });
afterEach(() => setReverseGateOpen(true));

const R_BODY: BodyExtents = { front: 0.6, rear: 1.6, width: 1.0 };
const U_BODY: BodyExtents = { front: 0.6, rear: 0.6, width: 0.8 };

describe('plan-595 9.16 — protective field against opposite-direction vehicles (R3-3)', () => {
  it('continuous: the field stops the reversing forklift before the cart; after the direction change no clear before exit + 0.5 s', () => {
    const net = getDefaultPathNetwork();
    for (const [id, from, to, succ] of [
      ['P1', [0, 0, 0], [4, 0, 0], ['P2']], ['P2', [4, 0, 0], [8, 0, 0], ['P3']], ['P3', [8, 0, 0], [14, 0, 0], []],
    ] as [string, number[], number[], string[]][]) {
      net.register(parsePathExtras({
        type: 'Path', version: 1, id, closed: false, align: [0, 1, 0],
        segments: [{ kind: 'line', from, to }], successors: succ, zone: `Z${id}`, zoneCapacity: 1,
      }, id)!);
    }
    net.resolveGraph();
    const host = makeHost();
    const rootU = makeAgvRoot('U', { PathId: 'P1', StartPosition: 3600, TargetSpeed: 1000, VehicleLength: 1200, VehicleWidth: 800 });
    const rootR = makeAgvRoot('R', { PathId: 'P3', StartPosition: 4000, TargetSpeed: 1200, ReverseSpeed: 300, AllowReverse: true,
      VehicleLength: 0, VehicleWidth: 0, ScannerFields: true }, { length: 2.2, width: 1.0, rootOffset: -0.5 });
    const hs = [rootU, rootR].map((r) => bindContinuous(r, host));
    const tick = (): void => { for (const h of hs) iterateFixedUpdate(h, TICK); };
    const mb = getDefaultMovementAuthority('continuous');
    const zones = getDefaultZoneRegistry();
    host.signalStore!.set('U.Agv.Run', false);
    host.signalStore!.set('R.Agv.Run', false);
    tick();
    // Preconditions: U stands, holds only Z1, and its front overhangs P2; R's body is the forklift.
    expect(mb.speedOf('U', mb.clock.now)).toBe(0);
    expect(zones.isHolder('ZP1', 'U')).toBe(true);
    expect(zones.isHolder('ZP2', 'U')).toBe(false);
    expect(rootU.position.x + U_BODY.front).toBeGreaterThan(4);
    expect(mb.bodyOf('R')!.rear).toBeCloseTo(1.6, 6);
    expect(mb.speedOf('R', mb.clock.now)).toBe(0);
    expect(mb.setDirection('R', -1, [net.get('P3')!, net.get('P2')!, net.get('P1')!])).toBe(true);
    host.signalStore!.set('R.Agv.Run', true); // setDirection only marks dirty — the Run edge re-plans
    let overlap = 0, protectiveSeen = -1, clearedWhileFacing = 0, reverseFrames = 0;
    let f = 0;
    for (; f < 60 * 60; f++) {
      tick();
      const now = mb.clock.now;
      if (satOverlap(footprint(rootR, R_BODY), footprint(rootU, U_BODY)) > 1e-6) overlap++;
      if (mb.planDirOf('R') === -1) reverseFrames++;
      const st = mb.fieldStateOf('R');
      if (st === 'protective' && protectiveSeen < 0) protectiveSeen = now;
      if (protectiveSeen >= 0 && st !== 'protective') clearedWhileFacing++;
      if (protectiveSeen >= 0 && mb.speedOf('R', now) === 0 && now - protectiveSeen > 2) break;
    }
    expect(reverseFrames).toBeGreaterThan(0);
    expect(protectiveSeen).toBeGreaterThan(0);           // the opposite cart engaged the protective field
    expect(clearedWhileFacing).toBe(0);                   // no clear while still facing it
    expect(overlap).toBe(0);                              // and no contact
    expect(zones.isHolder('ZP2', 'R')).toBe(true);        // the zones alone let R into P2 — the field stopped it
    const gap = (rootR.position.x - R_BODY.rear) - (rootU.position.x + U_BODY.front);
    expect(gap).toBeGreaterThan(0);
    expect(sig(host, 'R', 'FieldProtective')).toBe(true);
    expect(sig(host, 'R', 'FieldRear')).toBe(true);
    // Direction change WITH the protective field active.
    const tChange = mb.clock.now;
    expect(mb.setDirection('R', 1)).toBe(true);
    host.signalStore!.set('R.Agv.Run', false);
    tick();
    host.signalStore!.set('R.Agv.Run', true);
    let clearAt = -1, movedAt = -1;
    const x0 = rootR.position.x;
    const seen: number[] = [];  // field states of the two following plans at least
    for (let g = 0; g < 60 * 10; g++) {
      tick();
      const now = mb.clock.now;
      seen.push(mb.versionOf('R'));
      if (clearAt < 0 && mb.fieldStateOf('R') !== 'protective') clearAt = now;
      if (movedAt < 0 && Math.abs(rootR.position.x - x0) > 1e-6) movedAt = now;
      if (satOverlap(footprint(rootR, R_BODY), footprint(rootU, U_BODY)) > 1e-6) overlap++;
    }
    expect(clearAt).toBeGreaterThan(0);
    expect(clearAt - tChange).toBeGreaterThanOrEqual(0.5 - 1e-9);   // restart lock after the exit
    expect(movedAt).toBeGreaterThanOrEqual(clearAt - 1e-9);         // no motion before the release
    expect(rootR.position.x).toBeGreaterThan(x0 + 0.5);            // then it leaves forward
    expect(new Set(seen).size).toBeGreaterThanOrEqual(2);           // at least two plans after the change
    expect(mb.planDirOf('R')).toBe(1);
    expect(sig(host, 'R', 'FieldRear')).toBe(false);
    expect(sig(host, 'R', 'Reverse')).toBe(false);
    expect(overlap).toBe(0);
    expect(mb.stats.violations).toBe(0);
  }, 120000);
});
