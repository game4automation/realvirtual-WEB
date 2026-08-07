// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * turntable-des-router.test.ts — Plan 194 P5b (Turntable DES router).
 *
 * Tests the unified Turntable `des` block at the FSM level against a controllable
 * fake `self` (ports/outputs injected, scheduled events + transfers captured):
 *  - `canAccept` only at the currently aligned input port (when a port is given)
 *    and below capacity;
 *  - `onAccept` rotates to a free output and schedules `RotateComplete` after
 *    `|Δang| / RotationSpeed` seconds;
 *  - `onRotateComplete` dispatches the MU to the selected free output;
 *  - HOLD when no output is free, then dispatch on `onDownstreamReady`.
 *
 * The Turntable angle math reads the output snap node's world position via
 * `dispatchToOutputAngle`; the test seeds deterministic output roots so |Δang|
 * is predictable.
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { TurntableFlow } from '../../src/behaviors/Turntable';
import type {
  MaterialFlowSelf,
  MU,
  Port,
} from '../../src/core/material-flow/material-flow-self';
import { dispatchToOutputAngle, alignToInputAngle } from '../../src/behaviors/_shared/turntable-angle-math';

const des = TurntableFlow.des!;

/** The concrete self type the Turntable des hooks expect (local is private to Turntable.ts). */
type TTSelf = Parameters<NonNullable<typeof des.onAccept>>[0];

// ─── Controllable fake self ──────────────────────────────────────────────

interface ScheduledEvent { delay: number; hook: string; mu: MU | null }

interface TurntableLocalLike {
  driveAxis: Vector3;
  beltNeutralAngle: number;
  lastCommandedAngle: number;
}

/** A port backed by a positioned owner root (so the angle math is deterministic). */
function makeOutputPort(id: string, x: number, z: number, occupied = false): Port {
  const ownerRoot = new Object3D();
  ownerRoot.name = `Out-${id}`;
  ownerRoot.position.set(x, 0, z);
  ownerRoot.updateMatrixWorld(true);
  return {
    id,
    role: 'output',
    ownerRoot,
    ownerComponent: null,
    mySnapId: `tt-${id}`,
    partnerSnapId: id,
    partnerRoot: ownerRoot,
    partnerComponent: null,
    occupied: () => occupied,
    upstreamWaiting: () => false,
    setOccupied: () => {},
  };
}

/** An INPUT port carrying THIS turntable's local input snap (for the return-to-
 *  input alignment). ownerRoot is positioned too, but the angle math uses snapNode. */
function makeInputPort(id: string, x: number, z: number): Port {
  const snapNode = new Object3D(); snapNode.position.set(x, 0, z); snapNode.updateMatrixWorld(true);
  const ownerRoot = new Object3D(); ownerRoot.name = `In-${id}`; ownerRoot.position.set(x, 0, z); ownerRoot.updateMatrixWorld(true);
  return {
    id, role: 'input', ownerRoot, snapNode, ownerComponent: null,
    mySnapId: `tt-${id}`, partnerSnapId: id, partnerRoot: ownerRoot, partnerComponent: null,
    occupied: () => false, upstreamWaiting: () => false, setOccupied: () => {},
  };
}

function makeFakeSelf(outputs: Port[], inputs: Port[] = []): {
  self: TTSelf;
  events: ScheduledEvent[];
  transfers: { mu: MU; port?: Port }[];
  statCats: string[];
  lastCat: () => string | undefined;
  setLoad: (n: number) => void;
  setOutputs: (ports: Port[]) => void;
} {
  const events: ScheduledEvent[] = [];
  const transfers: { mu: MU; port?: Port }[] = [];
  const muList: MU[] = [];
  let outs = outputs;
  const ins = inputs;
  let state = 'idle';
  let load = 0;
  const statCats: string[] = []; // canonical utilization categories reported via statState
  const prop: Record<string, unknown> = { RotationSpeed: 45, MaxCapacity: 1, alignedPort: null };

  const self = {
    type: 'Turntable',
    kind: 'router',
    local: { driveAxis: new Vector3(0, 1, 0), beltNeutralAngle: 0, lastCommandedAngle: 0 },
    prop,
    get state() { return state; },
    setState(n: string) { state = n; },
    statState: (n: string) => { statCats.push(n); }, // record canonical utilization categories
    get currentLoad() { return load; },
    get mus() { return muList; },
    signals: { get: () => undefined, set: () => {}, on: () => {} },
    // The router publishes Flow.Occupied/Running via the typed `self.sig.*`
    // accessors (signals block, namespace 'Flow'); stub them as no-ops here.
    sig: {
      Run: { get: () => false, set: () => {} },
      Occupied: { get: () => false, set: () => {} },
      Running: { get: () => false, set: () => {} },
      PartCount: { get: () => 0, set: () => {} },
    },
    outputs: () => outs,
    inputs: () => ins,
    freeOutputs: () => outs.filter(p => !p.occupied()),
    in: (delay: number, hook: string, mu?: MU | null) => { events.push({ delay, hook, mu: mu ?? null }); return events.length; },
    transfer: (mu: MU, port?: Port) => { transfers.push({ mu, port }); },
  } as unknown as TTSelf;

  return {
    self,
    events,
    transfers,
    statCats,
    lastCat: () => statCats[statCats.length - 1],
    setLoad: (n: number) => { load = n; muList.length = 0; for (let i = 0; i < n; i++) muList.push({ id: 100 + i }); },
    setOutputs: (ports: Port[]) => { outs = ports; },
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('Turntable DES router — acceptance', () => {
  it('accepts below capacity; rejects when full', () => {
    const { self, setLoad } = makeFakeSelf([makeOutputPort('a', 1, 0)]);
    expect(des.canAccept!(self, { id: 1 } as MU, undefined)).toBe(true);
    setLoad(1); // at MaxCapacity = 1
    expect(des.canAccept!(self, { id: 2 } as MU, undefined)).toBe(false);
  });

  it('accepts only at the aligned input port when a port is supplied', () => {
    const { self } = makeFakeSelf([makeOutputPort('a', 1, 0)]);
    self.prop['alignedPort'] = 'IN-A';
    const aligned = { id: 'IN-A' } as unknown as Port;
    const other = { id: 'IN-B' } as unknown as Port;
    expect(des.canAccept!(self, { id: 1 } as MU, aligned)).toBe(true);
    expect(des.canAccept!(self, { id: 1 } as MU, other)).toBe(false);
  });
});

describe('Turntable DES router — rotate timing + dispatch', () => {
  it('RIDES the part to the centre booking point first (no rotation until it arrives)', () => {
    const out = makeOutputPort('a', 0, 1); // +Z
    const ctx = makeFakeSelf([out]);
    const { self, events } = ctx;

    // onAccept rides the part onto the platform centre — it does NOT rotate yet.
    des.onAccept!(self, { id: 1 } as MU, undefined);
    expect(self.state).toBe('receiving');
    expect(events.length).toBe(1);
    expect(events[0].hook).toBe('Arrival');             // a ride, not a rotation
    expect(self.prop['driveTarget']).toBeUndefined();    // not rotated yet
  });

  it('rotates to a free output after the ride-on (RotateComplete at |Δang|/RotationSpeed)', () => {
    const out = makeOutputPort('a', 0, 1); // +Z → 90°
    const ctx = makeFakeSelf([out]);
    const { self, events } = ctx;
    const mu = { id: 1 } as MU;

    const expectedAngle = dispatchToOutputAngle(
      self.local.driveAxis, self.local.beltNeutralAngle, out.ownerRoot, self.local.lastCommandedAngle,
    );

    des.onAccept!(self, mu, undefined);   // ride-on
    des.onArrival!(self, mu);              // reached centre → pick output + rotate

    expect(self.state).toBe('rotating_out');
    expect(events.length).toBe(2);
    expect(events[1].hook).toBe('RotateComplete');
    expect(events[1].delay).toBeCloseTo(Math.max(0.001, Math.abs(expectedAngle) / 45), 3);
    expect(self.prop['selectedOutput']).toBe('a');
    expect(self.prop['driveTarget']).toBeCloseTo(expectedAngle, 3);
  });

  it('uses THIS turntable\'s local output SNAP (not the downstream owner root) for the dispatch angle', () => {
    // Regression for the DES frame bug: the dispatch angle MUST be computed from
    // the turntable's OWN local output snap node (root-local position), NOT from
    // out.ownerRoot (the downstream conveyor's scene-positioned root). Here the two
    // frames disagree: the local snap sits at +Z (→ 90°), while the partner root
    // sits at a different scene position (→ a wrong ~116° angle).
    const snapNode = new Object3D(); snapNode.position.set(0, 0, 1); snapNode.updateMatrixWorld(true);
    const out: Port = { ...makeOutputPort('a', -2, 4), snapNode }; // ownerRoot at (-2,0,4) = wrong frame
    const ctx = makeFakeSelf([out]);
    const { self } = ctx;

    const correctAngle = dispatchToOutputAngle(self.local.driveAxis, self.local.beltNeutralAngle, snapNode, self.local.lastCommandedAngle);
    const wrongAngle = dispatchToOutputAngle(self.local.driveAxis, self.local.beltNeutralAngle, out.ownerRoot, self.local.lastCommandedAngle);
    expect(Math.abs(correctAngle - wrongAngle)).toBeGreaterThan(10);

    des.onAccept!(self, { id: 1 } as MU, undefined);
    des.onArrival!(self, { id: 1 } as MU);   // ride done → dispatch angle computed here

    expect(self.prop['driveTarget']).toBeCloseTo(correctAngle, 3);
    expect(Math.abs((self.prop['driveTarget'] as number) - wrongAngle)).toBeGreaterThan(10);
  });

  it('dispatches the MU to the output after ride-on → rotate → ride-off, then HECK-clears', () => {
    const out = makeOutputPort('a', 0, 1);
    const ctx = makeFakeSelf([out]); // no inputs → after the tail clears, straight to idle
    const { self, transfers } = ctx;
    const mu = { id: 7 } as MU;

    des.onAccept!(self, mu, undefined);      // ride-on (no input → rides directly)
    des.onArrival!(self, mu);                 // → rotate to output
    expect(self.state).toBe('rotating_out');
    des.onRotateComplete!(self, mu);          // → ride-off (NOT yet transferred)
    expect(self.state).toBe('discharging');
    expect(transfers.length).toBe(0);
    des.onArrival!(self, mu);                  // ride-off done → hand off + start the HECK clear

    expect(transfers.length).toBe(1);
    expect(transfers[0].mu.id).toBe(7);
    expect(transfers[0].port?.id).toBe('a');
    expect(self.prop['selectedOutput']).toBe(null);
    expect(self.state).toBe('discharge_clearing'); // disc waits for the tail to clear

    des.onArrival!(self, mu);                  // HECK cleared → no input snap → idle
    expect(self.state).toBe('idle');
  });

  it('reports canonical utilization categories per FSM phase (Working / Setup / Empty)', () => {
    // The disc must book: ride-on/rotate-with-part/ride-off → Working; the EMPTY
    // align-in and return rotations → Setup; idle → Empty (Plan 201 station stats).
    const out = makeOutputPort('a', 1, 0);   // +X
    const inp = makeInputPort('in', 0, -1);   // -Z
    const ctx = makeFakeSelf([out], [inp]);
    const { self, lastCat } = ctx;
    const mu = { id: 21 } as MU;

    des.onAccept!(self, mu, undefined);
    expect(self.state).toBe('aligning_in');
    expect(lastCat()).toBe('Setup');          // empty rotation to face the input

    des.onRotateComplete!(self, mu);
    expect(self.state).toBe('receiving');
    expect(lastCat()).toBe('Working');        // part rides onto the disc

    des.onArrival!(self, mu);
    expect(self.state).toBe('rotating_out');
    expect(lastCat()).toBe('Working');        // rotating WITH the part

    des.onRotateComplete!(self, mu);
    expect(self.state).toBe('discharging');
    expect(lastCat()).toBe('Working');        // part rides off

    des.onArrival!(self, mu);
    expect(self.state).toBe('discharge_clearing');
    expect(lastCat()).toBe('Working');        // tail still on the disc

    des.onArrival!(self, mu);
    expect(self.state).toBe('returning_in');
    expect(lastCat()).toBe('Setup');          // empty return rotation

    des.onRotateComplete!(self, mu);
    expect(self.state).toBe('idle');
    expect(lastCat()).toBe('Empty');          // free
  });

  it('HECK-GATES discharge: aligns on accept, WAITS for the tail, THEN returns to the input', () => {
    // A 90° corner: output +X, input -Z. The disc ALIGNS to the input on accept; after
    // discharge it must WAIT for the part's TAIL to clear (discharge_clearing) before it
    // RETURNS to the input — it never rotates while a part is still on it ("verrücken").
    const out = makeOutputPort('a', 1, 0);          // +X
    const inp = makeInputPort('in', 0, -1);          // -Z (turntable-local snap)
    const ctx = makeFakeSelf([out], [inp]);
    const { self, transfers } = ctx;
    const mu = { id: 8 } as MU;

    // 1) Accept → ALIGN to the input first (aligning_in), NOT a ride yet.
    des.onAccept!(self, mu, undefined);
    expect(self.state).toBe('aligning_in');
    const inAlign = alignToInputAngle(self.local.driveAxis, self.local.beltNeutralAngle, inp.snapNode!, 0);
    expect(self.prop['driveTarget']).toBeCloseTo(inAlign, 3);

    // 2) Align done → ride on; 3) reached centre → dispatch to the output.
    des.onRotateComplete!(self, mu);
    expect(self.state).toBe('receiving');
    des.onArrival!(self, mu);
    expect(self.state).toBe('rotating_out');
    const dispatchAngle = self.prop['driveTarget'] as number;
    expect(Math.abs(dispatchAngle - inAlign)).toBeGreaterThan(10);

    // 4) Dispatch done → ride off; 5) arrival → transfer + HECK gate (NOT idle yet).
    des.onRotateComplete!(self, mu);
    expect(self.state).toBe('discharging');
    des.onArrival!(self, mu);
    expect(transfers.length).toBe(1);
    expect(self.state).toBe('discharge_clearing');                  // waiting for the tail
    expect(self.prop['driveTarget']).toBeCloseTo(dispatchAngle, 3); // disc still at output — has NOT moved
    expect(des.canAccept!(self, { id: 99 } as MU, undefined)).toBe(false); // rejects while occupied

    // 6) Tail cleared → NOW the disc returns to the input (the gated "zurückfahren").
    des.onArrival!(self, mu);
    expect(self.state).toBe('returning_in');
    const homeAngle = alignToInputAngle(self.local.driveAxis, self.local.beltNeutralAngle, inp.snapNode!, dispatchAngle);
    expect(self.prop['driveTarget']).toBeCloseTo(homeAngle, 3);
    expect(Math.abs((self.prop['driveTarget'] as number) - dispatchAngle)).toBeGreaterThan(10); // moved back
    expect(des.canAccept!(self, { id: 99 } as MU, undefined)).toBe(false); // still rejecting (returning)

    // 7) Return done → idle, ready for the next part (disc already at the input).
    des.onRotateComplete!(self, mu);
    expect(self.state).toBe('idle');
    expect(des.canAccept!(self, { id: 9 } as MU, undefined)).toBe(true);
  });
});

describe('Turntable DES router — back-pressure HOLD', () => {
  it('HOLDs at the centre when no output is free, then dispatches on onDownstreamReady', () => {
    const blocked = makeOutputPort('a', 0, 1, /*occupied*/ true);
    const ctx = makeFakeSelf([blocked]);
    const { self, events, transfers, setLoad, lastCat } = ctx;
    const mu = { id: 9 } as MU;

    // Ride the part onto the centre; with no free output it HOLDs there.
    des.onAccept!(self, mu, undefined);
    expect(self.state).toBe('receiving');
    expect(events.length).toBe(1);              // the ride-on ('Arrival')
    des.onArrival!(self, mu);                    // reached centre, no free output → HOLD
    expect(self.state).toBe('holding');
    expect(lastCat()).toBe('Blocked');           // holds a part it cannot dispatch → Blocked
    expect(self.prop['heldMU']).toBe(9);
    expect(events.length).toBe(1);              // no rotation scheduled

    // The held MU must be discoverable for the retry — put it on the platform.
    setLoad(0);
    (self.mus as MU[]).push(mu);

    // Output frees → retry: now a free output exists → rotate scheduled.
    ctx.setOutputs([makeOutputPort('a', 0, 1, /*occupied*/ false)]);
    des.onDownstreamReady!(self, undefined);
    expect(events.length).toBe(2);
    expect(events[1].hook).toBe('RotateComplete');
    expect(self.state).toBe('rotating_out');

    // Completing the rotation → ride-off → arrival dispatches the held MU.
    des.onRotateComplete!(self, mu);
    des.onArrival!(self, mu);
    expect(transfers.length).toBe(1);
    expect(transfers[0].mu.id).toBe(9);
  });
});
