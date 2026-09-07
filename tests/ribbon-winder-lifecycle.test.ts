// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-459 §9.4 / plan-460 §9.2 — winders over time: length conservation, the
 * roll build-up curve, Empty/Full with REAL signals, reset, and the web-group
 * rules that make a slitter behave (ownership, group-wide stop).
 *
 * The group tests are the reason `RibbonManager` is more than `ChainManager`: a
 * shared unwinder that lost length once per path, or stopped only the path that
 * noticed first, is exactly the bug SOL round-2 finding 2 named.
 *
 * Since plan-460 the speed comes from a rotational drive ON a roller, and the
 * fixture converts a commanded WEB speed into the deg/s that roller must turn at
 * — recomputed per tick, so a winder whose radius shrinks still delivers exactly
 * the commanded surface speed and every length assertion below is unchanged.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ribbonHarness, signalRef, type RollerSpec } from './ribbon-fixture';
import { radiusFromLengthMm } from '../src/core/engine/ribbon/ribbon-winder-math';
import { RVRibbonWinder } from '../src/core/engine/rv-ribbon-winder';

const DT = 1 / 60;

/** Unwinder — idler — rewinder. */
function line(extra: Partial<Record<string, unknown>> = {}): RollerSpec[] {
  return [
    { name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 400, winder: true, extras: extra as Record<string, unknown> },
    { name: 'Idler', xMm: 1500, yMm: 300, radiusMm: 60 },
    { name: 'Rewinder', xMm: 3000, yMm: 0, radiusMm: 100, winder: true, driven: true },
  ];
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

describe('RibbonWinder lifecycle', () => {
  it('derives the initial wound length from the measured outer radius', () => {
    const h = ribbonHarness(line());
    const path = h.buildPath();
    const unwinder = path.winders[0];
    // L = pi (R^2 - R0^2) / t, with R = 400, R0 = 76.2, t = 0.1
    const expected = (Math.PI * (400 * 400 - 76.2 * 76.2)) / 0.1;
    expect(unwinder.woundLengthMm).toBeCloseTo(expected, 3);
    expect(unwinder.radiusMm).toBeCloseTo(400, 6);
  });

  it('rewinder gains exactly the length the unwinder loses (600 ticks @ 1000 mm/s -> 10 000 mm)', () => {
    const h = ribbonHarness(line());
    const path = h.buildPath();
    const [unwinder, rewinder] = path.winders;
    const u0 = unwinder.woundLengthMm;
    const r0 = rewinder.woundLengthMm;

    h.drive.jog(1000);
    for (let i = 0; i < 600; i++) {
      h.step(DT);
    }
    const lost = u0 - unwinder.woundLengthMm;
    const gained = rewinder.woundLengthMm - r0;
    expect(lost).toBeCloseTo(10_000, 3);
    expect(gained).toBeCloseTo(lost, 6);
  });

  it('unwinder radius follows sqrt(R0^2 + L t / pi)', () => {
    const h = ribbonHarness(line());
    const path = h.buildPath();
    const unwinder = path.winders[0];
    h.drive.jog(5000);
    for (let i = 0; i < 200; i++) {
      h.step(DT);
    }
    expect(unwinder.radiusMm).toBeCloseTo(
      radiusFromLengthMm(76.2, 0.1, unwinder.woundLengthMm), 9,
    );
    expect(unwinder.radiusMm).toBeLessThan(400);
  });

  it('scales the roll mesh radially against its AUTHORED (non-unit) scale', () => {
    const h = ribbonHarness(line());
    const path = h.buildPath();
    const unwinder = path.winders[0];
    const roll = h.nodes.get('Unwinder')!.getObjectByName('Roll')!;
    // The fixture authors (2, 1, 2); the winding axis is Z, so X and Y scale.
    expect(roll.scale.toArray()).toEqual([2, 1, 2]);

    h.drive.jog(20_000);
    for (let i = 0; i < 300; i++) {
      h.step(DT);
    }
    const f = unwinder.radiusMm / 400;
    expect(roll.scale.x).toBeCloseTo(2 * f, 6);
    expect(roll.scale.y).toBeCloseTo(1 * f, 6);
    expect(roll.scale.z).toBeCloseTo(2, 6); // axial: untouched
    expect(f).toBeLessThan(1);
  });

  it('empty unwinder clamps web speed to 0 and sets the registered Empty signal', () => {
    const h = ribbonHarness([
      // A nearly-empty roll: R barely above the core.
      {
        name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 100, winder: true, driven: true,
        extras: {
          InitialWoundLengthMm: 500,
          Empty: signalRef('Signals/Empty', 'PLCInputBool'),
          DiameterMm: signalRef('Signals/Diameter', 'PLCInputFloat'),
        },
      },
      { name: 'Rewinder', xMm: 2000, yMm: 0, radiusMm: 100, winder: true },
    ]);
    h.signalStore.register('Empty', 'Signals/Empty', false, 'PLCInputBool');
    h.signalStore.register('Diameter', 'Signals/Diameter', 0, 'PLCInputFloat');
    h.ribbonManager.setSignalWriter((address, value) => h.signalStore.setByPath(address, value));

    const path = h.buildPath();
    const unwinder = path.winders[0];
    expect(unwinder.isEmpty).toBe(false);

    h.drive.jog(1000);
    for (let i = 0; i < 120; i++) {
      h.step(DT);
    }
    expect(unwinder.woundLengthMm).toBe(0);
    expect(unwinder.isEmpty).toBe(true);
    expect(h.signalStore.getBool('Empty')).toBe(true);

    // And the web has stopped: no further rotation once it is empty. The
    // rewinder is a FOLLOWER here, so its angle is the honest witness.
    const angle = path.rollers[1].angle;
    h.step(DT);
    expect(path.rollers[1].angle).toBe(angle);
  });

  it('Full at MaxDiameterMm stops the web and sets Full', () => {
    const h = ribbonHarness([
      { name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 400, winder: true, driven: true },
      {
        name: 'Rewinder', xMm: 3000, yMm: 0, radiusMm: 100, winder: true,
        extras: {
          MaxDiameterMm: 210,
          Full: signalRef('Signals/Full', 'PLCInputBool'),
        },
      },
    ]);
    h.signalStore.register('Full', 'Signals/Full', false, 'PLCInputBool');
    h.ribbonManager.setSignalWriter((address, value) => h.signalStore.setByPath(address, value));

    const path = h.buildPath();
    const rewinder = path.winders[1];
    expect(rewinder.isFull).toBe(false);

    h.drive.jog(50_000);
    for (let i = 0; i < 600; i++) {
      h.step(DT);
    }
    expect(rewinder.isFull).toBe(true);
    expect(rewinder.diameterMm).toBeGreaterThanOrEqual(210);
    expect(h.signalStore.getBool('Full')).toBe(true);

    const length = rewinder.woundLengthMm;
    h.step(DT);
    expect(rewinder.woundLengthMm).toBe(length);
  });

  it('DiameterMm signal is written only on change > 0.1 mm', () => {
    const h = ribbonHarness([
      {
        name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 400, winder: true, driven: true,
        extras: { DiameterMm: signalRef('Signals/Diameter', 'PLCInputFloat') },
      },
      { name: 'Rewinder', xMm: 3000, yMm: 0, radiusMm: 100, winder: true },
    ]);
    h.signalStore.register('Diameter', 'Signals/Diameter', 0, 'PLCInputFloat');
    const writes: Array<[string, number | boolean]> = [];
    h.ribbonManager.setSignalWriter((address, value) => { writes.push([address, value]); });

    h.buildPath();
    h.drive.jog(1); // 1 mm/s: the diameter barely moves
    for (let i = 0; i < 60; i++) {
      h.step(DT);
    }
    // The first tick writes the initial value (a first write is always made,
    // otherwise the PLC would never learn the starting diameter); nothing after
    // it moved 0.1 mm.
    const diameterWrites = writes.filter(([a]) => a === 'Signals/Diameter');
    expect(diameterWrites).toHaveLength(1);
  });

  it('resetAll restores wound length, radius, roller angle and texture offset', () => {
    const h = ribbonHarness(line());
    const path = h.buildPath();
    const [unwinder] = path.winders;
    const length0 = unwinder.woundLengthMm;
    const radius0 = unwinder.radiusMm;
    const pathLength0 = path.lengthMm;

    h.drive.jog(20_000);
    for (let i = 0; i < 200; i++) {
      h.step(DT);
    }
    expect(unwinder.woundLengthMm).toBeLessThan(length0);
    expect(path.rollers[1].angle).not.toBe(0);

    h.drive.reset();
    h.ribbonManager.resetAll();

    expect(unwinder.woundLengthMm).toBeCloseTo(length0, 6);
    expect(unwinder.radiusMm).toBeCloseTo(radius0, 6);
    expect(path.rollers[1].angle).toBe(0);
    expect(path.band!.map!.offset.x).toBe(0);
    expect(path.lengthMm).toBeCloseTo(pathLength0, 6);
  });

  it('a DRIVEN winder sets the web speed to omega * pi/180 * R(t) in the same tick (plan-460)', () => {
    const h = ribbonHarness(line());
    const path = h.buildPath();
    const rewinder = path.winders[1];
    const idler = path.rollers[1];
    const r = rewinder.radiusMm;

    // Turn the rewinder drive at 90 deg/s directly, bypassing the mm/s façade,
    // so the test states the omega -> v conversion rather than assuming it.
    const drive = h.drive.driveOf('Rewinder')!;
    drive.currentPosition += 90 * DT;
    h.ribbonManager.update(DT);

    const expectedV = ((90 * Math.PI) / 180) * r;
    expect(rewinder.isDriven).toBe(true);
    expect(rewinder.surfaceSpeedMmPerS).toBeCloseTo(expectedV, 6);
    // The idler turned by v / r_idler * dt with that v. `angularSpeedRad` takes
    // the ROLLER radius, not the contact radius — the half caliper belongs to
    // the path geometry, not to how fast a roller spins.
    expect(idler.angle).toBeCloseTo((expectedV / 60) * DT, 5);
  });
});

describe('Web groups (slitter)', () => {
  it('an unwinder shared by two web paths is owned by the lexicographically smallest path and unwinds once per tick', () => {
    const h = ribbonHarness([
      { name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 400, winder: true },
      { name: 'Rewinder_A', xMm: 3000, yMm: 200, radiusMm: 100, winder: true, driven: true },
      { name: 'Rewinder_B', xMm: 3000, yMm: -200, radiusMm: 100, winder: true, driven: true },
    ]);
    const pathB = h.addPath('Ribbon_B', ['Unwinder', 'Rewinder_B']);
    const pathA = h.addPath('Ribbon_A', ['Unwinder', 'Rewinder_A']);

    expect(h.ribbonManager.size).toBe(2);
    expect(h.ribbonManager.groups).toHaveLength(1);

    const unwinder = pathA.winders[0];
    // Root/Ribbon_A sorts before Root/Ribbon_B, and registration order (B first) must
    // not matter.
    expect(h.ribbonManager.ownerOf(unwinder)).toBe(pathA);
    expect(pathB.winders[0]).toBe(unwinder);

    const before = unwinder.woundLengthMm;
    h.drive.jog(1000);
    h.step(DT);
    // ONE tick of one path's worth of length, not two.
    expect(before - unwinder.woundLengthMm).toBeCloseTo(1000 * DT, 6);
  });

  it('rollers shared by two strips (unwinder, idler) turn ONCE per tick, not once per strip', () => {
    const h = ribbonHarness([
      { name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 400, winder: true },
      { name: 'Idler', xMm: 1500, yMm: 300, radiusMm: 60 },
      { name: 'Rewinder_A', xMm: 3000, yMm: 200, radiusMm: 100, winder: true, driven: true },
      { name: 'Rewinder_B', xMm: 3000, yMm: -200, radiusMm: 100, winder: true, driven: true },
    ]);
    const pathA = h.addPath('Ribbon_A', ['Unwinder', 'Idler', 'Rewinder_A']);
    const pathB = h.addPath('Ribbon_B', ['Unwinder', 'Idler', 'Rewinder_B']);
    expect(pathB.rollers[1]).toBe(pathA.rollers[1]);

    h.drive.jog(1000);
    h.step(DT);

    const idler = pathA.rollers[1];
    expect(idler.angle).toBeCloseTo((1000 * DT) / 60, 9);
    expect(pathA.rollers[0].angle).toBeCloseTo((1000 * DT) / pathA.rollers[0].radiusMm, 9);
    // The strip-private rewinders CARRY the drives, so the path leaves them to it.
    expect(pathB.rollers[2].isDriven).toBe(true);
    expect(pathB.rollers[2].angle).toBe(0);
  });

  it('shared unwinder reaching Empty stops ALL paths of the group in the same tick', () => {
    const h = ribbonHarness([
      {
        name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 100, winder: true,
        extras: { InitialWoundLengthMm: 1000 * DT }, // exactly one tick of web
      },
      { name: 'Rewinder_A', xMm: 3000, yMm: 200, radiusMm: 100, winder: true, driven: true },
      { name: 'Rewinder_B', xMm: 3000, yMm: -200, radiusMm: 100, winder: true, driven: true },
    ]);
    const pathA = h.addPath('Ribbon_A', ['Unwinder', 'Rewinder_A']);
    const pathB = h.addPath('Ribbon_B', ['Unwinder', 'Rewinder_B']);

    h.drive.jog(1000);
    h.step(DT);
    // The shared unwinder is the only FOLLOWER here, so it is the witness for
    // both strips: each strip's own rewinder carries a drive and is not turned.
    const angleShared = pathA.rollers[0].angle;
    const lengthA = pathA.winders[1].woundLengthMm;
    const lengthB = pathB.winders[1].woundLengthMm;
    expect(angleShared).toBeGreaterThan(0);

    // Second tick: the shared roll is empty, so BOTH strips stop together.
    h.step(DT);
    expect(pathA.winders[0].isEmpty).toBe(true);
    expect(pathA.rollers[0].angle).toBe(angleShared);
    expect(pathA.winders[1].woundLengthMm).toBe(lengthA);
    expect(pathB.winders[1].woundLengthMm).toBe(lengthB);
  });

  it('shared rewinder reaching Full stops the whole group', () => {
    const h = ribbonHarness([
      { name: 'Unwinder_A', xMm: 0, yMm: 200, radiusMm: 400, winder: true },
      { name: 'Unwinder_B', xMm: 0, yMm: -200, radiusMm: 400, winder: true },
      {
        name: 'Rewinder', xMm: 3000, yMm: 0, radiusMm: 100, winder: true, driven: true,
        extras: { MaxDiameterMm: 200.5 },
      },
    ]);
    const pathA = h.addPath('Ribbon_A', ['Unwinder_A', 'Rewinder']);
    const pathB = h.addPath('Ribbon_B', ['Unwinder_B', 'Rewinder']);
    expect(h.ribbonManager.groups).toHaveLength(1);

    h.drive.jog(50_000);
    for (let i = 0; i < 400; i++) {
      h.step(DT);
    }
    expect(pathA.winders[1].isFull).toBe(true);
    const angleA = pathA.rollers[0].angle;
    const angleB = pathB.rollers[0].angle;
    h.step(DT);
    expect(pathA.rollers[0].angle).toBe(angleA);
    expect(pathB.rollers[0].angle).toBe(angleB);
  });

  // plan-460 removed the "same ConnectedDrive per group" rule with the field:
  // a group no longer has ONE speed to disagree about. Two strips pulled by two
  // independent rewinder drives are a legitimate model — which is the point of
  // this test, and the reason the old mismatch test is gone rather than ported.
  it('two strips of one group may run at DIFFERENT speeds, each from its own driven rewinder', () => {
    const h = ribbonHarness([
      { name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 400, winder: true },
      { name: 'Rewinder_A', xMm: 3000, yMm: 200, radiusMm: 100, winder: true, driven: true },
      { name: 'Rewinder_B', xMm: 3000, yMm: -200, radiusMm: 100, winder: true, driven: true },
    ]);
    const pathA = h.addPath('Ribbon_A', ['Unwinder', 'Rewinder_A']);
    const pathB = h.addPath('Ribbon_B', ['Unwinder', 'Rewinder_B']);

    h.drive.jogRoller('Rewinder_A', 1000);
    h.drive.jogRoller('Rewinder_B', 400);
    const a0 = pathA.winders[1].woundLengthMm;
    const b0 = pathB.winders[1].woundLengthMm;
    h.step(DT);

    expect(pathA.sections[0].speed).toBeCloseTo(1000, 6);
    expect(pathB.sections[0].speed).toBeCloseTo(400, 6);
    // Each strip wound the length its OWN speed delivers.
    expect(pathA.winders[1].woundLengthMm - a0).toBeCloseTo(1000 * DT, 6);
    expect(pathB.winders[1].woundLengthMm - b0).toBeCloseTo(400 * DT, 6);
  });

  it('two paths that share no winder stay in separate groups', () => {
    const h = ribbonHarness([
      { name: 'U_A', xMm: 0, yMm: 200, radiusMm: 400, winder: true },
      { name: 'R_A', xMm: 3000, yMm: 200, radiusMm: 100, winder: true, driven: true },
      { name: 'U_B', xMm: 0, yMm: -200, radiusMm: 400, winder: true },
      { name: 'R_B', xMm: 3000, yMm: -200, radiusMm: 100, winder: true, driven: true },
    ]);
    h.addPath('Ribbon_A', ['U_A', 'R_A']);
    h.addPath('Ribbon_B', ['U_B', 'R_B']);
    expect(h.ribbonManager.groups).toHaveLength(2);
  });

  it('a RibbonWinder is a RibbonRoller, so the path needs no special case for it', () => {
    const h = ribbonHarness(line());
    const path = h.buildPath();
    expect(path.rollers[0]).toBeInstanceOf(RVRibbonWinder);
    expect(path.rollers[0].sideSign).toBe(1);
    expect(path.winders[0].role).toBe('unwind');
    expect(path.winders[1].role).toBe('rewind');
  });
});

// ── Grouping by any shared roller (plan-459 /fix 2026-09-05) ─────────────
describe('grouping by shared rollers', () => {
  it('two paths that share only an idler are one group (one web, one speed)', () => {
    const h = ribbonHarness([
      { name: 'U_A', xMm: 0, yMm: 200, radiusMm: 400, winder: true },
      { name: 'Idler', xMm: 1500, yMm: 0, radiusMm: 80 },
      { name: 'R_A', xMm: 3000, yMm: 200, radiusMm: 100, winder: true, driven: true },
      { name: 'R_B', xMm: 3000, yMm: -200, radiusMm: 100, winder: true, driven: true },
    ]);
    h.addPath('Ribbon_A', ['U_A', 'Idler', 'R_A']);
    h.addPath('Ribbon_B', ['U_A', 'Idler', 'R_B']);
    expect(h.ribbonManager.groups).toHaveLength(1);
  });
});
