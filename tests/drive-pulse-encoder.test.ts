// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVDrivePulseEncoder — port of DrivePulseEncoder.cs. Pins the toggle-per-
 * interval rule, the offset of the first pulse, the after-physics hook and the
 * 0-interval guard. The encoder is NOT a Drive_* behavior: it coexists with one.
 */

import { describe, expect, it } from 'vitest';
import { RVDrivePulseEncoder } from '../src/core/engine/rv-drive-pulse-encoder';
import { RVDriveSimple } from '../src/core/engine/rv-drive-simple';
import type { IDriveBehavior } from '../src/core/engine/rv-drive';
import { buildBehaviorRig, type SignalSpec } from './fixtures/drive-behavior-harness';

const SIGNALS: SignalSpec = { PulseEncoderSignal: 'PLCInputBool' };

describe('RVDrivePulseEncoder', () => {
  it('toggles the signal each time the position passes another interval, starting at Offset + interval', () => {
    const r = buildBehaviorRig<RVDrivePulseEncoder>('DrivePulseEncoder', SIGNALS, { PulseIntervall: 10, Offset: 5 });
    expect(r.bool('PulseEncoderSignal')).toBe(false);

    r.drive.currentPosition = 14;
    r.behavior.tick(r.drive);
    expect(r.bool('PulseEncoderSignal')).toBe(false); // first mark is at 15
    r.drive.currentPosition = 16;
    r.behavior.tick(r.drive);
    expect(r.bool('PulseEncoderSignal')).toBe(true);
    r.behavior.tick(r.drive);
    expect(r.bool('PulseEncoderSignal')).toBe(true);  // same interval: no second toggle
    r.drive.currentPosition = 26;
    r.behavior.tick(r.drive);
    expect(r.bool('PulseEncoderSignal')).toBe(false);
  });

  it('runs from the drive after-update hook', () => {
    const r = buildBehaviorRig<RVDrivePulseEncoder>('DrivePulseEncoder', SIGNALS, { PulseIntervall: 1 });
    r.drive.currentPosition = 1.5;
    (r.drive as unknown as { dispatchAfterUpdate(): void }).dispatchAfterUpdate();
    expect(r.bool('PulseEncoderSignal')).toBe(true);
  });

  it('a zero interval leaves the encoder inactive instead of toggling every tick', () => {
    const r = buildBehaviorRig<RVDrivePulseEncoder>('DrivePulseEncoder', SIGNALS, { PulseIntervall: 0 });
    r.drive.currentPosition = 100;
    (r.drive as unknown as { dispatchAfterUpdate(): void }).dispatchAfterUpdate();
    expect(r.bool('PulseEncoderSignal')).toBe(false);
  });

  it('coexists with a Drive_* behavior on the same node', () => {
    const r = buildBehaviorRig<RVDrivePulseEncoder>('DrivePulseEncoder', SIGNALS, { PulseIntervall: 10 });
    const simple = new RVDriveSimple(r.drive.node) as unknown as IDriveBehavior;
    r.drive.driveBehaviors.push(simple);
    r.drive.currentPosition = 11;
    (r.drive as unknown as { dispatchAfterUpdate(): void }).dispatchAfterUpdate();
    expect(r.bool('PulseEncoderSignal')).toBe(true);
    expect(r.drive.driveBehaviors).toContain(simple);
  });
});
