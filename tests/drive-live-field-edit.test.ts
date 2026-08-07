// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Regression tests for RVDrive.setLiveField — the inspector's live-edit seam.
 *
 * applyLiveEdit() (rv-value-resolver.ts) applies an inspector edit as:
 *
 *     if (inst.setLiveField?.(fieldName, coerced)) return;      // component-owned
 *     if (fieldName in bag) bag[fieldName] = coerced;           // generic fallback
 *
 * `fieldName` is the PascalCase schema/display name ('JogForward'), but the
 * RUNTIME field on RVDrive is camelCase ('jogForward'). So the generic fallback
 * cannot see it — `'JogForward' in drive` is false — and the edit was silently
 * dropped: the checkbox showed checked (it round-trips through the extras
 * overlay) while the drive never jogged and never moved.
 *
 * These tests pin the PascalCase → camelCase mapping so a jog toggled in the
 * inspector actually reaches the engine.
 */

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import { RVDrive } from '../src/core/engine/rv-drive';
import { applySchema } from '../src/core/engine/rv-component-registry';

function makeDrive(): RVDrive {
  const node = new Object3D();
  node.name = 'Axis1';
  return new RVDrive(node);
}

describe('RVDrive authored jog (GLB extras → engine)', () => {
  it('an authored JogForward:true actually makes the drive jog', () => {
    const d = makeDrive();
    // Exactly what constructDrive() does: applySchema(extras) then initDrive().
    applySchema(d as unknown as Record<string, unknown>, RVDrive.schema, {
      Direction: 'RotationX',
      TargetSpeed: 500,
      JogForward: true,
    });
    d.initDrive();

    // Regression: JogForward used to be absent from the Drive schema (it sat in
    // the extras-validator "not implemented" ignore list), so an authored
    // `JogForward: true` was parsed and thrown away — the drive reported
    // JogForward=true in the inspector but `jogForward` stayed false and it
    // never turned (Toray.glb: 358/359 drives were dead this way).
    expect(d.JogForward).toBe(true);   // config applied from the extras
    expect(d.jogForward).toBe(true);   // copied into the RUNTIME field by initDrive
  });

  it('defaults to not jogging when the GLB does not author it', () => {
    const d = makeDrive();
    applySchema(d as unknown as Record<string, unknown>, RVDrive.schema, {
      Direction: 'RotationX',
    });
    d.initDrive();
    expect(d.jogForward).toBe(false);
    expect(d.jogBackward).toBe(false);
  });
});

describe('RVDrive.setLiveField (inspector live edit)', () => {
  it('the generic fallback alone would NOT make the drive jog', () => {
    const d = makeDrive();
    const bag = d as unknown as Record<string, unknown>;

    // Both names exist: `JogForward` is the CONFIG field (schema/GLB) and
    // `jogForward` is the RUNTIME field the physics loop actually reads.
    expect('JogForward' in bag).toBe(true);
    expect('jogForward' in bag).toBe(true);

    // applyLiveEdit's generic fallback is `bag[fieldName] = value`, which would
    // set ONLY the PascalCase config field — the engine would keep reading a
    // false `jogForward` and the drive would never move. That is why
    // setLiveField must map config → runtime explicitly.
    bag['JogForward'] = true;
    expect(d.jogForward).toBe(false); // ← the bug, if setLiveField didn't exist
  });

  it('maps JogForward → jogForward', () => {
    const d = makeDrive();
    expect(d.setLiveField('JogForward', true)).toBe(true);
    expect(d.jogForward).toBe(true);

    expect(d.setLiveField('JogForward', false)).toBe(true);
    expect(d.jogForward).toBe(false);
  });

  it('maps JogBackward → jogBackward', () => {
    const d = makeDrive();
    expect(d.setLiveField('JogBackward', true)).toBe(true);
    expect(d.jogBackward).toBe(true);
  });

  it('maps TargetPosition → targetPosition', () => {
    const d = makeDrive();
    expect(d.setLiveField('TargetPosition', 250)).toBe(true);
    expect(d.targetPosition).toBe(250);
  });

  it('still applies TargetSpeed to BOTH config and runtime', () => {
    const d = makeDrive();
    expect(d.setLiveField('TargetSpeed', 750)).toBe(true);
    expect(d.TargetSpeed).toBe(750);
    expect(d.targetSpeed).toBe(750);
  });

  it('reports the live jog state back to the inspector', () => {
    const d = makeDrive();
    d.setLiveField('JogForward', true);
    // getLiveState is what the inspector renders — it must agree with the engine,
    // so the checkbox can never again show "checked" on a drive that isn't jogging.
    expect(d.getLiveState().JogForward).toBe(true);
  });

  it('returns false for an unmapped field (generic fallback still used)', () => {
    const d = makeDrive();
    expect(d.setLiveField('UseLimits', true)).toBe(false);
  });
});
