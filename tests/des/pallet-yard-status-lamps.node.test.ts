// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-612 CP1c — the status lamp table (lamp-map.ts) and the sim-time blink.
import { describe, expect, it } from 'vitest';
import { lampStatesOf as lampStates, litAt } from '../../src/core/fleet/exec/lamp-map';
import type { VehicleStatusFlags } from '../../src/core/fleet/exec/vehicle-status';

const base: VehicleStatusFlags = { free: true, orderActive: false, busy: false, handling: false, charging: false, fault: false, moving: false };
const on = { on: true, flashing: false }, off = { on: false, flashing: false }, blink = { on: true, flashing: true };

describe('PalletYard status lamps', () => {
  it('free: green on, eyes on, beacon off', () => {
    expect(lampStates(base)).toEqual({ StackGreen: on, StackAmber: off, StackRed: off, Beacon: off, EyeL: on, EyeR: on });
  });
  it('order active and driving: green blinks, beacon blinks', () => {
    expect(lampStates({ ...base, busy: true, free: false, orderActive: true, moving: true })).toMatchObject({ StackGreen: blink, StackAmber: off, Beacon: blink });
  });
  it('fork / hand-over: amber on, green off', () => {
    expect(lampStates({ ...base, busy: true, free: false, orderActive: true, handling: true })).toMatchObject({ StackGreen: off, StackAmber: on, StackRed: off });
  });
  it('charging: amber blinks', () => {
    expect(lampStates({ ...base, busy: true, free: false, orderActive: true, charging: true })).toMatchObject({ StackGreen: off, StackAmber: blink });
  });
  it('fault: red on, eyes off, green / amber off — beacon still follows the motion', () => {
    expect(lampStates({ ...base, busy: true, free: false, orderActive: true, handling: true, fault: true })).toEqual({
      StackGreen: off, StackAmber: off, StackRed: on, Beacon: off, EyeL: off, EyeR: off,
    });
    expect(lampStates({ ...base, fault: true, moving: true }).Beacon).toEqual(blink);
  });
  it('blink in sim time: first half of the period lit, deterministic', () => {
    expect([0, 0.25, 0.49, 0.5, 0.75, 1.0, 1.6].map((t) => litAt(blink, t, 1))).toEqual([true, true, true, false, false, true, false]);
    expect(litAt(on, 0.7, 1)).toBe(true);
    expect(litAt(off, 0.1, 1)).toBe(false);
    expect(litAt(blink, 0.7, 0)).toBe(false);                      // invalid period → 1 s
  });
});
