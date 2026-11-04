// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-558 §9.6b — acceptance with UNEQUAL bodies and OFF-CENTRE roots.
 *
 * Course: two lanes merge through a zone 'Z' whose middle piece ('Short',
 * 0.5 m) is shorter than every vehicle, then straight + 90° arc to a service
 * station whose end is followed by the zoned piece 'Exit' ('Y'), then a long
 * dead end. Vehicles 0.8 / 1.2 / 2.0 m long; the 1.2 m and 2.0 m bodies carry
 * their root at the REAR (VehicleLength / VehicleWidth = 0 → mesh bounds).
 * A foreign holder ('PLC') keeps 'Y' for the first 20 s, so the vehicle at
 * the station must stop short of the station end instead of letting its
 * front overhang the unclaimed zone.
 *
 * Independent oracles every frame: (1) SAT body overlap with each vehicle's
 * own extents, (2) a body overlapping a zone region ('Short' for 'Z', 'Exit'
 * for 'Y') must hold that zone — this proves "claimed before the front
 * enters" and "released only after the rear has left".
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { getDefaultAgvFleet, type AgvTask } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultMovementAuthority } from '../../src/core/engine/rv-movement-authority';
import { DESRunner } from '@rv/plugins/des/des-runner';
import {
  TICK, makeHost, makeAgvRoot, bindDes, clearShared, footprint, satOverlap,
  type BodyExtents, type Footprint, type TestBody,
} from '../helpers/agv-harness';

beforeEach(() => clearShared());

function registerCourse(): void {
  const net = getDefaultPathNetwork();
  const add = (raw: Record<string, unknown>): void => {
    net.register(parsePathExtras({ type: 'Path', version: 1, closed: false, align: [0, 1, 0], ...raw }, raw.id as string)!);
  };
  add({ id: 'InA', segments: [{ kind: 'line', from: [-8, 0, -3], to: [0, 0, 0] }], successors: ['Short'], zone: 'Z' });
  add({ id: 'InB', segments: [{ kind: 'line', from: [-8, 0, 3], to: [0, 0, 0] }], successors: ['Short'], zone: 'Z' });
  add({ id: 'Short', segments: [{ kind: 'line', from: [0, 0, 0], to: [0.5, 0, 0] }], successors: ['Main'], zone: 'Z' });
  add({ id: 'Main', segments: [{ kind: 'line', from: [0.5, 0, 0], to: [6, 0, 0] }], successors: ['Arc'] });
  add({ id: 'Arc', segments: [{ kind: 'arc', center: [6, 0, 3], radius: 3, startAngle: -90, degrees: 90, plane: 'XZ' }], successors: ['Station'] });
  add({ id: 'Station', segments: [{ kind: 'line', from: [9, 0, 3], to: [9, 0, 5] }], successors: ['Exit'] });
  add({ id: 'Exit', segments: [{ kind: 'line', from: [9, 0, 5], to: [9, 0, 7] }], successors: ['End'], zone: 'Y' });
  add({ id: 'End', segments: [{ kind: 'line', from: [9, 0, 7], to: [9, 0, 30] }] });
  net.resolveGraph();
}

interface Spec { name: string; path: string; s: number; body: TestBody }

/** Body extents relative to the root for a TestBody (root offset behind the centre). */
function extents(b: TestBody): BodyExtents {
  const off = b.rootOffset ?? 0;
  return { front: b.length / 2 + off, rear: b.length / 2 - off, width: b.width };
}

/** Thin rectangle along a straight zone piece (centre, half extents along / across). */
function region(cx: number, cz: number, alongX: boolean, half: number): Footprint {
  return {
    cx, cz, fx: alongX ? half : 0, fz: alongX ? 0 : half, rx: alongX ? 0 : 0.005, rz: alongX ? 0.005 : 0,
    radius: half + 0.005,
  };
}

describe('AGV mixed footprints + off-centre roots (plan-558 §9.6b)', () => {
  it('0.8 / 1.2 / 2.0 m bodies, roots at the rear, short zone, service stop before an unclaimed zone: no overlap, no zone intrusion', () => {
    registerCourse();
    const zones = getDefaultZoneRegistry();
    zones.claim('Y', 'PLC');
    const specs: Spec[] = [
      { name: 'V1', path: 'InA', s: 6.2, body: { length: 2.0, width: 0.8, rootOffset: 1.0 } },
      { name: 'V2', path: 'InB', s: 6.6, body: { length: 0.8, width: 0.6 } },
      { name: 'V3', path: 'InA', s: 3.3, body: { length: 1.2, width: 0.6, rootOffset: 0.6 } },
      { name: 'V4', path: 'InB', s: 3.6, body: { length: 2.0, width: 0.7, rootOffset: 1.0 } },
      { name: 'V5', path: 'InA', s: 0.6, body: { length: 0.8, width: 0.6 } },
      { name: 'V6', path: 'InB', s: 0.2, body: { length: 1.2, width: 0.6, rootOffset: 0.6 } },
    ];
    const runner = new DESRunner({ subMode: 'animated' });
    const host = makeHost();
    const roots: Object3D[] = specs.map((sp) => makeAgvRoot(sp.name, {
      PathId: sp.path, StartPosition: sp.s * 1000, TargetSpeed: 1000, VehicleLength: 0, VehicleWidth: 0,
    }, sp.body));
    roots.forEach((r) => bindDes(runner, r, host));
    runner.start([], { root: new Object3D() });
    const served: string[] = [];
    const parked = new Set<string>();
    for (const sp of specs) {
      const toEnd: AgvTask = { destination: 'End', onArrive: (id) => { parked.add(id); } };
      getDefaultAgvFleet().get(sp.name)!.assign({
        destination: 'Station', serviceSec: 3,
        onServiceEnd: (id) => { served.push(id); getDefaultAgvFleet().get(id)!.assign(toEnd); },
      });
    }
    const mb = getDefaultMovementAuthority('des');
    const bodies = specs.map((sp) => extents(sp.body));
    const shortBox = region(0.25, 0, true, 0.25);
    const exitBox = region(9, 6, false, 1.0);
    let overlapFrames = 0, intrusionFrames = 0, stationBlockedFrames = 0;
    const intrusions: string[] = [];
    let minFR = Infinity;
    const frames = Math.round(120 / TICK);
    for (let f = 1; f <= frames; f++) {
      if (f === Math.round(20 / TICK)) zones.release('Y', 'PLC'); // external release (foreign holder)
      runner.tick(TICK);
      runner.lateTick(TICK);
      const fps = roots.map((r, i) => footprint(r, bodies[i]));
      for (let i = 0; i < fps.length; i++) {
        for (let j = i + 1; j < fps.length; j++) if (satOverlap(fps[i], fps[j]) > 1e-6) overlapFrames++;
        for (const [box, zone] of [[shortBox, 'Z'], [exitBox, 'Y']] as const) {
          if (satOverlap(fps[i], box) > 1e-6 && !zones.isHolder(zone, specs[i].name)) {
            intrusionFrames++;
            if (intrusions.length < 5) intrusions.push(`${specs[i].name}@${(f * TICK).toFixed(2)}:${zone}`);
          }
        }
        if (f * TICK < 20 && satOverlap(fps[i], exitBox) > 1e-6) stationBlockedFrames++;
      }
      if (f % 3 === 0) { const g = mb.minFrontRearGap(f * TICK); if (g < minFR) minFR = g; }
    }
    console.log(`[agv-mixed] overlap=${overlapFrames} intrusion=${intrusionFrames} ${intrusions.join(' ')} preRelease=${stationBlockedFrames}`
      + ` minFrontRear=${minFR.toFixed(3)} served=${served.join(',')} parked=${[...parked].sort().join(',')}`
      + ` violations=${mb.stats.violations} forced=${mb.stats.forced}`);
    runner.dispose();
    expect(mb.stats.violations).toBe(0);
    expect(mb.stats.forced).toBe(0);
    expect(overlapFrames).toBe(0);
    expect(intrusionFrames).toBe(0);
    expect(stationBlockedFrames).toBe(0);
    expect(minFR).toBeGreaterThanOrEqual(0.3 - 1e-6);
    expect(served.length).toBe(6);
    // The first one parks at the dead end, the others queue behind it on 'End'
    // (their destination end is occupied) — every body has cleared zone 'Y'.
    expect(parked.size).toBe(1);
    for (let i = 0; i < roots.length; i++) expect(roots[i].position.z - bodies[i].rear).toBeGreaterThan(7);
  }, 120_000);
});
