// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-686 §9.1 — semantics of the read-only wait-cycle query
 * `MovementAuthority.findZoneWaitCycles()`.
 *
 * Unit level: vehicles are registered on a tiny network with a stub host, and
 * the traffic state (held zones, waiter lists, stop cause, standstill) is set
 * directly — the query reads that state and nothing else. Holder edges, FIFO
 * edges over a free zone, the capacity-1 restriction, normalisation and the
 * read-only contract are checked.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { getDefaultMovementAuthority, type MbHost, type MbParams, type MovementAuthority } from '../../src/core/engine/rv-movement-authority';
import { planProfile } from '../../src/core/engine/rv-motion-profile';
import type { PathTraveler } from '../../src/core/engine/rv-path-traveler';
import { clearShared } from '../helpers/agv-harness';

const T = 10;

const P: MbParams = { vmax: 1, a: 0.5, b: 0.5, aLat: 0.5, front: 0.5, rear: 0.5, width: 0.6, gap: 0.2, dockSpeed: 0.2, dockDist: 0.3, scanner: null };

function host(): MbHost {
  return {
    now: () => T, nextEventTime: () => Infinity, schedule: () => -1, cancel: () => {},
    legTween: () => null, serviceStopAt: () => false, canMove: () => true,
  };
}

interface VehicleState { held: Map<string, number>; plan: { stopCause: string; profile: unknown } }

/** Internal state access (test seam): the query only reads it. */
function internals(mb: MovementAuthority): { vehicles: Map<string, VehicleState>; addWaiter(z: string, id: string, t: number): void } {
  const m = mb as unknown as { vehicles: Map<string, VehicleState>; addWaiter(z: string, id: string, t: number): void };
  return { vehicles: m.vehicles, addWaiter: (z, id, t) => m.addWaiter(z, id, t) };
}

let mb: MovementAuthority;

beforeEach(() => {
  clearShared();
  const net = getDefaultPathNetwork();
  for (let i = 0; i < 6; i++) {
    net.register(parsePathExtras({ type: 'Path', version: 1, closed: false, align: [0, 1, 0], id: `P${i}`,
      segments: [{ kind: 'line', from: [10 * i, 0, 0], to: [10 * i + 5, 0, 0] }], successors: [] }, `P${i}`)!);
  }
  net.resolveGraph();
  const zones = getDefaultZoneRegistry();
  for (const z of ['Z1', 'Z2', 'Z3']) zones.define(z, 1);
  zones.define('W2', 2);
  mb = getDefaultMovementAuthority('des');
});

/** Register a vehicle standing at a zone stop (stop cause 'zone', plan ended). */
function stand(id: string, pathIdx: number, cause = 'zone'): void {
  const path = getDefaultPathNetwork().get(`P${pathIdx}`)!;
  mb.register(id, { id, path, s: 1 } as unknown as PathTraveler, host(), P);
  internals(mb).vehicles.get(id)!.plan.stopCause = cause;
}

/** Make a registered vehicle MOVE (a plan that has not ended). */
function drive(id: string): void {
  const v = internals(mb).vehicles.get(id)!;
  v.plan.profile = planProfile(T - 1, 0, 0.5, [{ x0: 0, x1: 100, c0: 1, c1: 0 }], P.a, P.b, 50, true);
  v.plan.stopCause = 'zone';
}

function hold(id: string, z: string): void {
  expect(getDefaultZoneRegistry().claim(z, id)).toBe(true);
  internals(mb).vehicles.get(id)!.held.set(z, Infinity);
}

function waitFor(id: string, z: string, since: number): void { internals(mb).addWaiter(z, id, since); }

describe('plan-686 9.1 — findZoneWaitCycles', () => {
  it('a) two standing vehicles holding each other\'s zone form one cycle', () => {
    stand('A', 0); stand('B', 1);
    hold('A', 'Z1'); hold('B', 'Z2');
    waitFor('A', 'Z2', 1); waitFor('B', 'Z1', 2);
    expect(mb.findZoneWaitCycles()).toEqual([{ vehicles: ['A', 'B'], zones: ['Z2', 'Z1'] }]);
  });

  it('b) a waiter whose holder drives is no cycle', () => {
    stand('A', 0); stand('B', 1);
    hold('A', 'Z1'); hold('B', 'Z2');
    waitFor('A', 'Z2', 1); waitFor('B', 'Z1', 2);
    drive('B');
    expect(mb.findZoneWaitCycles()).toEqual([]);
  });

  it('c) a passive waiter behind a driving leader is no cycle', () => {
    stand('A', 0); stand('B', 1);
    hold('A', 'Z1'); hold('B', 'Z2');
    waitFor('A', 'Z2', Number.NaN); // passive
    waitFor('B', 'Z1', 2);
    drive('B');
    expect(mb.findZoneWaitCycles()).toEqual([]);
  });

  it('d) a FIFO-blocked free zone closes a cycle; without the back edge there is none', () => {
    stand('V', 0); stand('W', 1);
    hold('V', 'Z1');
    // Z2 is FREE: W waits for it since t = 1, V since t = 3 — V queues behind W.
    waitFor('W', 'Z2', 1); waitFor('V', 'Z2', 3);
    expect(mb.findZoneWaitCycles()).toEqual([]); // W waits for nothing V holds
    waitFor('W', 'Z1', 2);                         // back edge: W waits for V's Z1
    expect(mb.findZoneWaitCycles()).toEqual([{ vehicles: ['V', 'W'], zones: ['Z2', 'Z1'] }]);
  });

  it('e) a zone of capacity 2 is not analysed', () => {
    stand('A', 0); stand('B', 1);
    hold('A', 'Z1'); hold('B', 'W2'); hold('A', 'W2');
    waitFor('B', 'Z1', 1);
    // A "waits" for the capacity-2 zone B holds — ignored.
    waitFor('A', 'W2', 2);
    expect(mb.findZoneWaitCycles()).toEqual([]);
  });

  it('f) two overlapping cycles of three vehicles: both, normalised, sorted, stable', () => {
    stand('C', 2); stand('A', 0); stand('B', 1);
    hold('A', 'Z1'); hold('B', 'Z2'); hold('C', 'Z3');
    waitFor('A', 'Z2', 1); waitFor('B', 'Z1', 2); // A <-> B
    waitFor('C', 'Z1', 3); waitFor('B', 'Z3', 4); // B <-> ... C waits for A's Z1, B waits for C's Z3
    waitFor('A', 'Z3', 5);                         // A -> C closes A -> C -> A
    const one = mb.findZoneWaitCycles();
    const two = mb.findZoneWaitCycles();
    expect(one).toEqual(two);
    expect(one).toEqual([
      { vehicles: ['A', 'B', 'C'], zones: ['Z2', 'Z3', 'Z1'] },
      { vehicles: ['A', 'B'], zones: ['Z2', 'Z1'] },
      { vehicles: ['A', 'C'], zones: ['Z3', 'Z1'] },
    ]);
    for (const c of one) expect(c.vehicles[0]).toBe([...c.vehicles].sort()[0]);
  });

  it('g) the query changes nothing: claims, waiters and statistics before == after', () => {
    stand('A', 0); stand('B', 1);
    hold('A', 'Z1'); hold('B', 'Z2');
    waitFor('A', 'Z2', 1); waitFor('B', 'Z1', 2);
    const snap = (): string => JSON.stringify({
      a: mb.describeZoneHolds('A'), b: mb.describeZoneHolds('B'), stats: mb.stats,
      reg: ['Z1', 'Z2'].map((z) => getDefaultZoneRegistry().holderCount(z)),
    });
    const before = snap();
    mb.findZoneWaitCycles();
    mb.findZoneWaitCycles();
    expect(snap()).toBe(before);
    expect(mb.describeZoneHolds('A')).toEqual({ held: [{ zone: 'Z1', exitOdo: Infinity }], waits: [{ zone: 'Z2', since: 1, passive: false }] });
  });
});
