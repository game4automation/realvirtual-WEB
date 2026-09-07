// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-460 §9.2 — driven rollers, the section contract, and the plan-459
 * regression gate.
 *
 * The first test is the gate the whole plan hangs on: a path with ONE driven
 * roller and no dancer must behave exactly as plan-459 did. Everything after it
 * is new surface — the sign of the surface speed, the two-pass propagation of
 * empty sections, the deprecation of `ConnectedDrive`, and the band groups.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ribbonHarness, transformRef, type RollerSpec } from './ribbon-fixture';
import { MM_TO_METERS } from '../src/core/engine/rv-constants';

const DT = 1 / 60;

/** Unwinder — idler — nip(D) — rewinder, all on one Z axis. */
function line(): RollerSpec[] {
  return [
    { name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 400, winder: true },
    { name: 'Idler', xMm: 1200, yMm: 400, radiusMm: 60 },
    { name: 'Nip', xMm: 2400, yMm: 400, radiusMm: 80, driven: true },
    { name: 'Rewinder', xMm: 3600, yMm: 0, radiusMm: 100, winder: true },
  ];
}

/** The same line with a dancer between the nip and the rewinder. */
function lineWithDancer(): RollerSpec[] {
  return [
    { name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 400, winder: true },
    { name: 'Idler', xMm: 1200, yMm: 400, radiusMm: 60 },
    { name: 'Nip', xMm: 2400, yMm: 400, radiusMm: 80, driven: true },
    { name: 'Dancer', xMm: 3000, yMm: 200, radiusMm: 50, dancer: true },
    { name: 'Rewinder', xMm: 3600, yMm: 0, radiusMm: 100, winder: true, driven: true },
  ];
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

function warnings(): string {
  return warn.mock.calls.flat().join(' ');
}

describe('driven rollers and sections', () => {
  it('a path with one driven roller and no dancer has exactly ONE section and behaves like plan-459', () => {
    const h = ribbonHarness(line());
    const path = h.buildPath();
    expect(path.sections).toHaveLength(1);
    expect(path.band!.sectionCount).toBe(1);
    // A single section keeps a single (non-array) material — the 459 draw call.
    expect(Array.isArray(path.band!.mesh.material)).toBe(false);

    const u0 = path.winders[0].woundLengthMm;
    const r0 = path.winders[1].woundLengthMm;
    h.drive.jog(1000);
    for (let i = 0; i < 60; i++) h.step(DT);

    // Angles, winder lengths and the texture offset are the 459 numbers.
    expect(path.rollers[1].angle).toBeCloseTo((1000 * 60 * DT) / 60, 6);
    expect(u0 - path.winders[0].woundLengthMm).toBeCloseTo(1000, 6);
    expect(path.winders[1].woundLengthMm - r0).toBeCloseTo(1000, 6);
    expect(path.band!.map!.offset.x).toBeGreaterThan(0);
  });

  it('a driven roller sets v = omega*r; followers turn with v/r and the driven one is left to its drive', () => {
    const h = ribbonHarness(line());
    const path = h.buildPath();
    const nip = path.rollers[2];
    // 90 deg/s about the roller axis on an 80 mm roller.
    h.drive.driveOf('Nip')!.currentPosition += 90 * DT;
    h.ribbonManager.update(DT);

    const expectedV = ((90 * Math.PI) / 180) * 80;
    expect(nip.isDriven).toBe(true);
    expect(nip.surfaceSpeedMmPerS).toBeCloseTo(expectedV, 9);
    expect(nip.angle).toBe(0);                                  // its drive turns it
    expect(path.rollers[1].isDriven).toBe(false);
    expect(path.rollers[1].angle).toBeCloseTo((expectedV / 60) * DT, 9);
  });

  it('a driven WINDER uses its current R(t), so the web speed follows the shrinking roll', () => {
    const h = ribbonHarness([
      { name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 400, winder: true, driven: true },
      { name: 'Idler', xMm: 2000, yMm: 0, radiusMm: 50 },
      { name: 'Rewinder', xMm: 4000, yMm: 0, radiusMm: 100, winder: true },
    ]);
    const path = h.buildPath();
    const unwinder = path.winders[0];
    const drive = h.drive.driveOf('Unwinder')!;

    // A CONSTANT angular speed: the surface speed must fall with the radius.
    const omega = 200; // deg/s
    drive.currentPosition += omega * DT;
    h.ribbonManager.update(DT);
    const vStart = unwinder.surfaceSpeedMmPerS;
    expect(vStart).toBeCloseTo(((omega * Math.PI) / 180) * 400, 6);

    let radiusBeforeLastTick = unwinder.radiusMm;
    for (let i = 0; i < 400; i++) {
      radiusBeforeLastTick = unwinder.radiusMm;
      drive.currentPosition += omega * DT;
      h.ribbonManager.update(DT);
    }
    expect(unwinder.radiusMm).toBeLessThan(400);
    // The speed of a tick is read from the radius BEFORE that tick is integrated
    // (sample, then advance) — the same order production uses.
    expect(unwinder.surfaceSpeedMmPerS).toBeCloseTo(
      ((omega * Math.PI) / 180) * radiusBeforeLastTick, 6,
    );
    expect(unwinder.surfaceSpeedMmPerS).toBeLessThan(vStart);
  });

  it('the surface speed is SIGNED by the drive position difference: forward, backward and a DriveTo reversal', () => {
    const h = ribbonHarness(line());
    const path = h.buildPath();
    const nip = path.rollers[2];
    const drive = h.drive.driveOf('Nip')!;

    drive.currentPosition += 90 * DT;
    h.ribbonManager.update(DT);
    expect(nip.surfaceSpeedMmPerS).toBeGreaterThan(0);
    const forward = path.rollers[1].angle;

    // A DriveTo running BACKWARDS reports `currentSpeed` as a MAGNITUDE — the
    // exact case that made plan-459's reading run a web the wrong way. Only the
    // position difference is read, so the sign is right anyway.
    drive.currentSpeed = 90;
    drive.jogForward = false;
    drive.jogBackward = false;
    drive.currentPosition -= 90 * DT;
    h.ribbonManager.update(DT);
    expect(nip.surfaceSpeedMmPerS).toBeLessThan(0);
    expect(path.rollers[1].angle).toBeCloseTo(forward - (nip.surfaceSpeedMmPerS / -60) * DT, 9);
  });

  it('the surface speed is signed by dot(driveAxis, rollerAxis): an antiparallel axis reverses the web', () => {
    const h = ribbonHarness(line().map((s) => (
      s.name === 'Nip' ? { ...s, driveAxis: [0, 0, -1] as [number, number, number] } : s
    )));
    const path = h.buildPath();
    const nip = path.rollers[2];
    h.drive.driveOf('Nip')!.currentPosition += 90 * DT;
    h.ribbonManager.update(DT);
    expect(nip.surfaceSpeedMmPerS).toBeCloseTo(-((90 * Math.PI) / 180) * 80, 9);
  });

  it('a LINEAR drive on a roller node is not a web speed source (warn, roller stays a follower)', () => {
    const h = ribbonHarness(line().map((s) => (s.name === 'Nip' ? { ...s, driveIsLinear: true } : s)));
    const path = h.buildPath();
    h.drive.driveOf('Nip')!.currentPosition += 500 * DT;
    h.ribbonManager.update(DT);
    expect(path.rollers[2].isDriven).toBe(false);
    expect(warnings()).toContain('carries a LINEAR Drive');
    expect(warnings()).toContain('has no driven roller');
  });

  it('a SKEWED drive axis makes the roller a follower with a warning', () => {
    const h = ribbonHarness(line().map((s) => (
      s.name === 'Nip' ? { ...s, driveAxis: [0, 0.5, 0.866] as [number, number, number] } : s
    )));
    const path = h.buildPath();
    h.drive.driveOf('Nip')!.currentPosition += 90 * DT;
    h.ribbonManager.update(DT);
    expect(path.rollers[2].isDriven).toBe(false);
    expect(warnings()).toContain('deviates from the roller axis');
  });

  it('two driven rollers in one section: the LAST in running direction wins, a >1 % mismatch warns once', () => {
    const h = ribbonHarness([
      { name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 400, winder: true },
      { name: 'Pull_1', xMm: 1500, yMm: 300, radiusMm: 60, driven: true },
      { name: 'Pull_2', xMm: 2500, yMm: 300, radiusMm: 60, driven: true },
      { name: 'Rewinder', xMm: 4000, yMm: 0, radiusMm: 100, winder: true },
    ]);
    const path = h.buildPath();
    h.drive.jogRoller('Pull_1', 1000);
    h.drive.jogRoller('Pull_2', 1200);   // 20 % apart
    h.step(DT);

    expect(path.sections).toHaveLength(1);
    expect(path.sections[0].speed).toBeCloseTo(1200, 6);
    expect(path.sections[0].driven).toBe(path.rollers[2]);
    expect(warnings()).toContain('slip is not simulated');

    // Once, not per tick.
    const before = warn.mock.calls.length;
    for (let i = 0; i < 5; i++) h.step(DT);
    const added = warn.mock.calls.slice(before).flat().join(' ');
    expect(added).not.toContain('slip is not simulated');
  });

  it('rollers within 1 % of each other do NOT warn about slip', () => {
    const h = ribbonHarness([
      { name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 400, winder: true },
      { name: 'Pull_1', xMm: 1500, yMm: 300, radiusMm: 60, driven: true },
      { name: 'Pull_2', xMm: 2500, yMm: 300, radiusMm: 60, driven: true },
      { name: 'Rewinder', xMm: 4000, yMm: 0, radiusMm: 100, winder: true },
    ]);
    h.buildPath();
    h.drive.jogRoller('Pull_1', 1000);
    h.drive.jogRoller('Pull_2', 1005);
    h.step(DT);
    expect(warnings()).not.toContain('slip is not simulated');
  });

  it('a path with no driven roller at all stands still, with one warning', () => {
    const h = ribbonHarness(line().map((s) => ({ ...s, driven: false })));
    const path = h.buildPath();
    h.drive.jog(1000);
    for (let i = 0; i < 5; i++) h.step(DT);
    expect(path.rollers[1].angle).toBe(0);
    expect(path.sections[0].speed).toBe(0);
    const hits = warn.mock.calls.flat().filter((m: unknown) => String(m).includes('has no driven roller'));
    expect(hits).toHaveLength(1);
  });
});

describe('section propagation and the dancer split', () => {
  it('a dancer splits the path into two sections at its arc end and the band into two groups', () => {
    const h = ribbonHarness(lineWithDancer());
    const path = h.buildPath();

    expect(path.sections).toHaveLength(2);
    // Rollers 0..2 upstream, the dancer and everything after it downstream.
    expect(path.sectionOfRoller(0)).toBe(0);
    expect(path.sectionOfRoller(2)).toBe(0);
    expect(path.sectionOfRoller(3)).toBe(1);
    expect(path.sectionOfRoller(4)).toBe(1);

    const band = path.band!;
    expect(band.sectionCount).toBe(2);
    expect(band.maps).toHaveLength(2);
    // The two clones scroll independently but share the SAME image upload.
    expect(band.maps[0]).not.toBe(band.maps[1]);
    expect(band.maps[0].image).toBe(band.maps[1].image);
    expect(Array.isArray(band.mesh.material)).toBe(true);
    expect(band.mesh.geometry.groups).toHaveLength(2);
    // The boundary is the dancer's departure tangent point.
    expect(band.sectionStarts[1]).toBeGreaterThan(0);
    expect(band.sectionStarts[1]).toBeLessThan(band.sampleCount - 1);
  });

  it('rollers before the dancer turn with v_up, after it with v_down, and each section scrolls its own map', () => {
    const h = ribbonHarness(lineWithDancer());
    const path = h.buildPath();
    h.drive.jogRoller('Nip', 1000);
    h.drive.jogRoller('Rewinder', 500);
    h.step(DT);

    expect(path.sections[0].speed).toBeCloseTo(1000, 6);
    expect(path.sections[1].speed).toBeCloseTo(500, 6);
    // The upstream idler runs at 1000, the dancer itself at the speed it LEAVES with.
    expect(path.rollers[1].angle).toBeCloseTo((1000 / 60) * DT, 9);
    expect(path.rollers[3].angle).toBeCloseTo((500 / 50) * DT, 9);
    // Two offsets, two speeds — and the faster section has moved further.
    const band = path.band!;
    expect(band.maps[0].offset.x).not.toBeCloseTo(band.maps[1].offset.x, 9);
  });

  it('setTextureLength applies the repeat to EVERY section material and resetScroll clears every offset', () => {
    const h = ribbonHarness(lineWithDancer());
    const path = h.buildPath();
    const band = path.band!;
    expect(band.maps[1].repeat.x).toBeCloseTo(band.maps[0].repeat.x, 12);
    expect(band.maps[0].repeat.x).toBeGreaterThan(0);

    h.drive.jogRoller('Nip', 1000);
    h.drive.jogRoller('Rewinder', 500);
    for (let i = 0; i < 10; i++) h.step(DT);
    expect(band.maps[0].offset.x).not.toBe(0);
    expect(band.maps[1].offset.x).not.toBe(0);

    h.ribbonManager.resetAll();
    for (const map of band.maps) expect(map.offset.x).toBe(0);
  });

  it('an empty section takes the next driven section in running direction (backward pass)', () => {
    // Only the REWINDER drives: the upstream section has no driven roller.
    const h = ribbonHarness(lineWithDancer().map((s) => (
      s.name === 'Nip' ? { ...s, driven: false } : s
    )));
    const path = h.buildPath();
    h.drive.jogRoller('Rewinder', 800);
    h.step(DT);
    expect(path.sections[0].speed).toBeCloseTo(800, 6);
    expect(path.sections[1].speed).toBeCloseTo(800, 6);
    // A negative speed propagates with its sign.
    h.drive.jogRoller('Rewinder', -800);
    h.step(DT);
    expect(path.sections[0].speed).toBeCloseTo(-800, 6);
  });

  it('a trailing empty section takes the PREVIOUS one (forward pass)', () => {
    const h = ribbonHarness(lineWithDancer().map((s) => (
      s.name === 'Rewinder' ? { ...s, driven: false } : s
    )));
    const path = h.buildPath();
    h.drive.jogRoller('Nip', 700);
    h.step(DT);
    expect(path.sections[0].speed).toBeCloseTo(700, 6);
    expect(path.sections[1].speed).toBeCloseTo(700, 6);
    expect(warnings()).not.toContain('has no driven roller');
  });

  it('a dancer as the FIRST or LAST roller is ignored with a warning', () => {
    const h = ribbonHarness([
      { name: 'Dancer', xMm: 0, yMm: 0, radiusMm: 60, dancer: true },
      { name: 'Idler', xMm: 1500, yMm: 0, radiusMm: 60, driven: true },
      { name: 'Rewinder', xMm: 3000, yMm: 0, radiusMm: 100, winder: true },
    ]);
    const path = h.buildPath();
    expect(path.dancers).toHaveLength(0);
    expect(path.sections).toHaveLength(1);
    expect(warnings()).toContain('at an END of');
  });

  it('a SECOND dancer on one path is ignored with a warning (plan-460 supports one)', () => {
    const h = ribbonHarness([
      { name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 400, winder: true },
      { name: 'Dancer_1', xMm: 1000, yMm: 300, radiusMm: 50, dancer: true },
      { name: 'Nip', xMm: 2000, yMm: 300, radiusMm: 80, driven: true },
      { name: 'Dancer_2', xMm: 3000, yMm: 300, radiusMm: 50, dancer: true },
      { name: 'Rewinder', xMm: 4000, yMm: 0, radiusMm: 100, winder: true, driven: true },
    ]);
    const path = h.buildPath();
    expect(path.dancers).toHaveLength(1);
    expect(path.sections).toHaveLength(2);
    expect(warnings()).toContain('SECOND RibbonDancer');
  });

  it('slit strip + dancer: drawStart and the section groups combine', () => {
    const h = ribbonHarness([
      { name: 'Unwinder', xMm: 0, yMm: 1200, radiusMm: 400, winder: true },
      { name: 'Idler_01', xMm: 1000, yMm: 1700, radiusMm: 200, extras: { RibbonSide: 'Auto' } },
      { name: 'Nip', xMm: 2000, yMm: 1200, radiusMm: 190, driven: true, extras: { RibbonSide: 'Auto' } },
      { name: 'Dancer_A', xMm: 2600, yMm: 1500, radiusMm: 60, dancer: true, extras: { RibbonSide: 'Auto' } },
      { name: 'Rewinder_A', xMm: 3200, yMm: 1500, radiusMm: 90, winder: true, driven: true },
    ]);
    const a = h.addPath('Ribbon_A', ['Unwinder', 'Idler_01', 'Nip', 'Dancer_A', 'Rewinder_A'], {
      RibbonWidthMm: 400, FullWidthMm: 860, SlitAtRoller: transformRef('Root/Nip'),
    });
    expect(a.slitSampleIndex).toBeGreaterThan(0);
    expect(a.sections).toHaveLength(2);
    const band = a.band!;
    expect(band.sectionCount).toBe(2);
    // The dancer boundary sits AFTER the slit (the dancer is downstream of the nip).
    expect(band.sectionStarts[1]).toBeGreaterThan(a.slitSampleIndex);

    // Both mechanisms are live at once: the strip narrows at the slit…
    const pos = band.mesh.geometry.getAttribute('position');
    const width = (i: number) => Math.hypot(
      pos.getX(i * 2 + 1) - pos.getX(i * 2), pos.getY(i * 2 + 1) - pos.getY(i * 2),
      pos.getZ(i * 2 + 1) - pos.getZ(i * 2),
    ) * MM_TO_METERS;
    expect(width(0)).toBeCloseTo(860, 3);
    expect(width(a.slitSampleIndex)).toBeCloseTo(400, 3);
    // …and the two groups still cover the whole band.
    const groups = band.mesh.geometry.groups;
    expect(groups[0].start).toBe(0);
    expect(groups[1].start).toBe(band.sectionStarts[1] * 6);
  });
});

describe('shared wrap sides before the slit', () => {
  /**
   * Two strips cut at one roller are ONE web up to that roller, so they must
   * wrap every shared roller on the same side. Here the two rewinders straddle
   * the nip — one strip turns up out of it, the other down — so `RibbonSide:
   * Auto` resolves the nip differently for each of them and the shared,
   * full-width part would take two different tangent lines at once.
   */
  const STRADDLING_SLITTER: RollerSpec[] = [
    { name: 'Unwinder', xMm: 0, yMm: 1200, radiusMm: 400, winder: true },
    { name: 'Idler_01', xMm: 1000, yMm: 1700, radiusMm: 200, extras: { RibbonSide: 'Auto' } },
    { name: 'Nip', xMm: 2000, yMm: 1200, radiusMm: 190, driven: true, extras: { RibbonSide: 'Auto' } },
    { name: 'Rewinder_A', xMm: 3200, yMm: 700, radiusMm: 90, winder: true },
    { name: 'Rewinder_B', xMm: 3200, yMm: 300, radiusMm: 90, winder: true },
  ];
  const SLIT = { RibbonWidthMm: 400, FullWidthMm: 860, SlitAtRoller: transformRef('Root/Nip') };

  it('warns ONCE per document when two strips resolve a shared roller differently, and keeps drawing', () => {
    const h = ribbonHarness(STRADDLING_SLITTER);
    const common = ['Unwinder', 'Idler_01', 'Nip'];
    const a = h.addPath('Ribbon_A', [...common, 'Rewinder_A'], SLIT);
    const b = h.addPath('Ribbon_B', [...common, 'Rewinder_B'], SLIT);
    expect(a.resolvedSideAt(2)).not.toBe(b.resolvedSideAt(2));

    h.step(DT);
    // The warning is emitted ONCE per document, so counting the occurrences in
    // the joined console output is exactly as precise as counting calls.
    const conflicts = (): number => (warnings().match(/opposite\s+sides/g) ?? []).length;
    expect(conflicts()).toBe(1);
    expect(warnings()).toContain('Ribbon_A');
    expect(warnings()).toContain('Ribbon_B');
    expect(warnings()).toContain('Nip');
    // Diagnosed, not repaired: both strips are still live and still drawn.
    expect(a.isActive).toBe(true);
    expect(b.isActive).toBe(true);
    expect(a.band!.sampleCount).toBeGreaterThan(2);
    expect(b.band!.sampleCount).toBeGreaterThan(2);

    // Warned once per DOCUMENT, however many ticks and however many rollers.
    for (let i = 0; i < 20; i++) h.step(DT);
    expect(conflicts()).toBe(1);
  });

  /**
   * The layout the motion test needs: `Dancer_A` is the nip's downstream
   * neighbour for strip A, so `resolveAutoSides` decides the SHARED nip from the
   * dancer's CURRENT position. At the authored y = 1000 both strips wrap it the
   * same way; below y = 900 strip A flips and the shared, pre-slit web would take
   * two tangent lines at once. The dancer's travel range reaches y = 800.
   */
  const FLIPPING_SLITTER: RollerSpec[] = [
    { name: 'Unwinder', xMm: 0, yMm: 1200, radiusMm: 400, winder: true },
    { name: 'Idler_01', xMm: 1000, yMm: 1700, radiusMm: 200, extras: { RibbonSide: 'Auto' } },
    { name: 'Nip', xMm: 2000, yMm: 1200, radiusMm: 190, driven: true, extras: { RibbonSide: 'Auto' } },
    { name: 'Dancer_A', xMm: 2600, yMm: 1000, radiusMm: 60, dancer: true, extras: { RibbonSide: 'Auto' } },
    { name: 'Rewinder_A', xMm: 3200, yMm: 700, radiusMm: 90, winder: true, driven: true },
    { name: 'Rewinder_B', xMm: 3400, yMm: 700, radiusMm: 90, winder: true },
  ];

  it('warns when a TRAVELLING dancer flips a shared side mid-run, once per document', () => {
    const h = ribbonHarness(FLIPPING_SLITTER);
    const common = ['Unwinder', 'Idler_01', 'Nip'];
    const a = h.addPath('Ribbon_A', [...common, 'Dancer_A', 'Rewinder_A'], SLIT);
    const b = h.addPath('Ribbon_B', [...common, 'Rewinder_B'], SLIT);
    const conflicts = (): number => (warnings().match(/opposite\s+sides/g) ?? []).length;

    // At load the two strips agree at the nip, so the grouping check is silent.
    h.step(DT);
    expect(a.resolvedSideAt(2)).toBe(b.resolvedSideAt(2));
    expect(conflicts()).toBe(0);

    // The rewinder pulls FASTER than the nip feeds, so the store empties and the
    // carriage travels down to its lower stop (y 1000 -> 800) — which is what a
    // dancer DOES, and is exactly the case a check that only runs on grouping
    // never sees. 400 mm/s of difference over 2 strands = 200 mm/s of travel, so
    // the 200 mm range is covered inside a second.
    h.drive.jog(500);
    h.drive.jogRoller('Rewinder_A', 900);
    for (let i = 0; i < 90; i++) h.step(DT);
    const dancer = h.dancer('Dancer_A');
    expect(dancer.positionMm).toBeCloseTo(-200, 3);

    expect(a.resolvedSideAt(2)).not.toBe(b.resolvedSideAt(2));
    expect(conflicts()).toBe(1);
    expect(warnings()).toContain('Nip');

    // Still once, however long it keeps running in the conflicting pose.
    for (let i = 0; i < 20; i++) h.step(DT);
    expect(conflicts()).toBe(1);

    // A model switch clears the latch: the NEXT document warns once again — and
    // the reload goes back into the SAME manager instance, which is the only way
    // a broken `clear()` reset can be caught (a fresh harness brings a fresh
    // manager and would warn no matter what `clear()` did).
    //
    // `clear()` disposes the paths and, through them, the winders; the plain
    // rollers survive. Dropping the winder nodes' rv_extras makes the fixture's
    // `constructRollers` build them again on the next `addPath`, which is as
    // close to a document switch as this fixture gets.
    h.ribbonManager.clear();
    for (const name of ['Unwinder', 'Rewinder_A', 'Rewinder_B']) {
      delete h.nodes.get(name)!.userData.realvirtual;
    }
    const c = h.addPath('Ribbon_C', [...common, 'Dancer_A', 'Rewinder_A'], SLIT);
    const d = h.addPath('Ribbon_D', [...common, 'Rewinder_B'], SLIT);
    expect(c.isActive).toBe(true);
    expect(d.isActive).toBe(true);
    // The carriage is still at the flipped pose, so the conflict is there again.
    h.step(DT);
    expect(c.resolvedSideAt(2)).not.toBe(d.resolvedSideAt(2));
    expect(conflicts()).toBe(2);
  });

  it('warns once when two strips slit at one roller end up on DIFFERENT sample grids', () => {
    // `Ribbon_B` is 100 m long and outgrows its sample buffer, so its grid is
    // coarsened to 31.25 mm; its 3 m sibling stays on 15.625 mm. The shared
    // arrival at the cutter then rounds to a different point for each of them —
    // the one case the absolute grid cannot fix on its own.
    const h = ribbonHarness([
      { name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 400, winder: true },
      { name: 'Cutter', xMm: 1000, yMm: 500, radiusMm: 100, extras: { RibbonSide: 'Auto' } },
      { name: 'Rewinder_A', xMm: 3000, yMm: 0, radiusMm: 100, winder: true },
      { name: 'Rewinder_B', xMm: 100_000, yMm: 0, radiusMm: 400, winder: true },
    ]);
    const opts = { RibbonWidthMm: 400, FullWidthMm: 860, SlitAtRoller: transformRef('Root/Cutter') };
    const a = h.addPath('Ribbon_A', ['Unwinder', 'Cutter', 'Rewinder_A'], opts);
    const b = h.addPath('Ribbon_B', ['Unwinder', 'Cutter', 'Rewinder_B'], opts);
    h.step(DT);

    // The sides agree — this is purely a sampling-grid conflict.
    expect(a.resolvedSideAt(1)).toBe(b.resolvedSideAt(1));
    expect(warnings()).not.toContain('opposite');

    expect(b.sampleStepMm).toBeGreaterThan(a.sampleStepMm);
    const grids = (): number => (warnings().match(/different\s+grids/g) ?? []).length;
    expect(grids()).toBe(1);
    expect(warnings()).toContain('Ribbon_A');
    expect(warnings()).toContain('Ribbon_B');
    expect(warnings()).toContain('Cutter');

    // Once per document, however long it runs.
    for (let i = 0; i < 20; i++) h.step(DT);
    expect(grids()).toBe(1);
    // Both strips keep drawing — reported, never repaired.
    expect(a.isActive).toBe(true);
    expect(b.isActive).toBe(true);
  });

  it('checks EVERY slit group: a side conflict in the first does not hide a grid conflict in the second', () => {
    // One machine, two cutters, all four strips off one unwinder — so it is ONE
    // manager group with TWO slit groups. Returning out of the whole check on
    // the first conflict skipped the second group entirely, AND recorded a
    // snapshot for it, so it was never looked at again either.
    const h = ribbonHarness([
      { name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 400, winder: true },
      // Group 1 — the two rewinders straddle the cutter: a SIDE conflict.
      { name: 'Cutter_1', xMm: 1000, yMm: 500, radiusMm: 100, extras: { RibbonSide: 'Auto' } },
      { name: 'Rewinder_A', xMm: 3000, yMm: 2000, radiusMm: 100, winder: true },
      { name: 'Rewinder_B', xMm: 3000, yMm: -1500, radiusMm: 100, winder: true },
      // Group 2 — same turn, but one strip is 100 m long and gets a coarser
      // sample grid than its 3 m sibling: a GRID conflict.
      { name: 'Cutter_2', xMm: 1000, yMm: -500, radiusMm: 100, extras: { RibbonSide: 'Auto' } },
      { name: 'Rewinder_C', xMm: 3000, yMm: -600, radiusMm: 100, winder: true },
      { name: 'Rewinder_D', xMm: 100_000, yMm: -600, radiusMm: 400, winder: true },
    ]);
    const cut1 = { RibbonWidthMm: 400, FullWidthMm: 860, SlitAtRoller: transformRef('Root/Cutter_1') };
    const cut2 = { RibbonWidthMm: 400, FullWidthMm: 860, SlitAtRoller: transformRef('Root/Cutter_2') };
    const a = h.addPath('Ribbon_A', ['Unwinder', 'Cutter_1', 'Rewinder_A'], cut1);
    const b = h.addPath('Ribbon_B', ['Unwinder', 'Cutter_1', 'Rewinder_B'], cut1);
    const c = h.addPath('Ribbon_C', ['Unwinder', 'Cutter_2', 'Rewinder_C'], cut2);
    const d = h.addPath('Ribbon_D', ['Unwinder', 'Cutter_2', 'Rewinder_D'], cut2);
    h.step(DT);

    // One manager group (they all share the unwinder), two slit groups.
    expect(h.ribbonManager.groups).toHaveLength(1);
    expect(a.resolvedSideAt(1)).not.toBe(b.resolvedSideAt(1));   // group 1: sides
    expect(c.resolvedSideAt(1)).toBe(d.resolvedSideAt(1));       // group 2: sides agree
    expect(d.sampleStepMm).toBeGreaterThan(c.sampleStepMm);      // group 2: grids differ

    const sides = (): number => (warnings().match(/opposite\s+sides/g) ?? []).length;
    const grids = (): number => (warnings().match(/different\s+grids/g) ?? []).length;
    expect(sides()).toBe(1);
    expect(grids()).toBe(1);
    expect(warnings()).toContain('Cutter_1');
    expect(warnings()).toContain('Cutter_2');

    // Both still once per document, and every strip keeps drawing.
    for (let i = 0; i < 20; i++) h.step(DT);
    expect(sides()).toBe(1);
    expect(grids()).toBe(1);
    for (const path of [a, b, c, d]) expect(path.isActive).toBe(true);
  });

  it('says nothing when the two strips take the same turn at the slit roller', () => {
    const h = ribbonHarness([
      ...STRADDLING_SLITTER.slice(0, 3),
      { name: 'Rewinder_A', xMm: 3200, yMm: 700, radiusMm: 90, winder: true },
      { name: 'Rewinder_B', xMm: 3400, yMm: 700, radiusMm: 90, winder: true },
    ]);
    const common = ['Unwinder', 'Idler_01', 'Nip'];
    const a = h.addPath('Ribbon_A', [...common, 'Rewinder_A'], SLIT);
    const b = h.addPath('Ribbon_B', [...common, 'Rewinder_B'], SLIT);
    h.step(DT);
    expect(a.resolvedSideAt(2)).toBe(b.resolvedSideAt(2));
    expect(warnings()).not.toContain('opposite');
  });
});

describe('deprecated ConnectedDrive / SpeedSource', () => {
  it('are ignored with ONE production warning for two deprecated paths, and again once for the next document', () => {
    const h = ribbonHarness([
      { name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 400, winder: true },
      { name: 'Rewinder_A', xMm: 3000, yMm: 200, radiusMm: 100, winder: true, driven: true },
      { name: 'Rewinder_B', xMm: 3000, yMm: -200, radiusMm: 100, winder: true, driven: true },
    ]);
    h.addPath('Ribbon_A', ['Unwinder', 'Rewinder_A'], {
      ConnectedDrive: { type: 'ComponentReference', path: 'Root/Nowhere', componentType: 'realvirtual.Drive' },
    });
    h.addPath('Ribbon_B', ['Unwinder', 'Rewinder_B'], { SpeedSource: 'RibbonWinder' });

    const hits = () => warn.mock.calls.flat().filter((m: unknown) => String(m).includes('are deprecated since plan-460'));
    expect(hits()).toHaveLength(1);

    // ...and the web still runs, from the driven rollers alone.
    h.drive.jog(1000);
    h.step(DT);
    expect(h.ribbonManager.groups[0].paths[0].sections[0].speed).toBeCloseTo(1000, 6);

    // A model switch clears the flag: the NEXT document warns once again.
    h.ribbonManager.clear();
    const h2 = ribbonHarness([
      { name: 'A', xMm: 0, yMm: 0, radiusMm: 100, driven: true },
      { name: 'B', xMm: 2000, yMm: 0, radiusMm: 100 },
    ]);
    h2.buildPath({ SpeedSource: 'RibbonWinder' });
    expect(hits()).toHaveLength(2);
  });
});
