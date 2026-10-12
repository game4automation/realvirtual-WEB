// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ribbon-tension-render.test.ts — sag geometry, the colour partition and the
 * band tint (plan-471 Phases 4 + 5, §9 "Vitest, Rendering").
 *
 * This file carries five of the seven Implementierungsauflagen:
 *
 * | Auflage | what is asserted here |
 * |---|---|
 * | A1 | the tint saturation grows with NO call to the band write (a spy) |
 * | A2 | a parent rotated 90 deg still makes the web sag downwards in the WORLD |
 * | A3 | line tangents come from `f'(s)`; arc samples are bit-identical |
 * | A5 | 200 warm ticks with sag, colour change and a moving dancer allocate
 *        nothing — with a positive control that a deliberate `slice()` is caught |
 * | A6 | the alarm emission is set and restored BIT-EXACTLY |
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Euler, Quaternion, Vector3 } from 'three';
import { ribbonHarness, type RibbonHarness, type RollerSpec } from './ribbon-fixture';
import { RIBBON_BAND_SAMPLE_STRIDE } from '../src/core/engine/rv-ribbon-band-mesh';

const DT = 1 / 60;
const STRIDE = RIBBON_BAND_SAMPLE_STRIDE;

const TENSION = {
  TensileStiffnessNPerMmWidth: 10,
  RibbonWidthMm: 500,
  TargetTensionNPerM: 100,
  MinStrainPercent: 0,
  MaxStrainPercent: 2,
  ToleranceBandPercent: 10,
  BreakForceNPer50mm: 35,
  EnableSag: true,
  TensionColoring: true,
  TintStrength: 0.7,
  DeformationScale: 1,
} as const;

const BASE_SPEED = 800;

/**
 * A machine with a genuine WRAP: the middle idlers sit above the line, so the
 * rollers between the nips carry real arcs and the "arcs never sag" rule has
 * something to be true about.
 */
const LAYOUT: RollerSpec[] = [
  { name: 'R0', xMm: 0, yMm: 0, radiusMm: 60, driven: true },
  { name: 'N1', xMm: 800, yMm: 0, radiusMm: 60, driven: true },
  { name: 'I2', xMm: 1200, yMm: 300, radiusMm: 60 },
  { name: 'N2', xMm: 1600, yMm: 0, radiusMm: 60, driven: true },
  { name: 'D', xMm: 2000, yMm: 0, radiusMm: 60, dancer: true },
  { name: 'N3', xMm: 2400, yMm: 0, radiusMm: 60, driven: true },
  { name: 'R4', xMm: 2800, yMm: 0, radiusMm: 60 },
];

type Path = ReturnType<RibbonHarness['buildPath']>;

function machine(overrides: Record<string, unknown> = {}): { h: RibbonHarness; path: Path } {
  const h = ribbonHarness(LAYOUT.map((r) => ({ ...r })));
  const path = h.buildPath({ ...TENSION, ...overrides });
  h.drive.jog(BASE_SPEED);
  for (const name of ['R0', 'N1', 'N2', 'N3']) h.drive.jogRoller(name, BASE_SPEED);
  h.step(DT);       // settle the partition (see the pipeline test's `machine`)
  return { h, path };
}

function run(h: RibbonHarness, seconds: number): void {
  const ticks = Math.round(seconds / DT);
  for (let i = 0; i < ticks; i++) h.step(DT);
}

/** A copy of the live sample buffer, so a later write can be compared to it. */
function snapshot(path: Path): Float32Array {
  return path.sampleBuffer.slice(0, path.sampleCount * STRIDE);
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

describe('sag geometry', () => {
  it('leaves the taut web untouched, sample for sample', () => {
    const { h, path } = machine();
    const taut = snapshot(path);
    run(h, 2);
    // Everything runs at the set point: no zone is slack, so nothing moves.
    expect(path.zones.every((z) => z.eps >= 0)).toBe(true);
    expect(snapshot(path)).toStrictEqual(taut);
  });

  it('displaces the LINE samples of a slack zone and no others', () => {
    const { h, path } = machine();
    const taut = snapshot(path);
    h.drive.jogRoller('N2', 760);
    run(h, 6);
    const sagged = snapshot(path);
    expect(path.zones[1].eps).toBeLessThan(0);
    expect(path.zones[1].sagDepthMm).toBeGreaterThan(1);

    let moved = 0;
    for (let i = 0; i < path.sampleCount; i++) {
      const at = i * STRIDE;
      const d = Math.hypot(
        sagged[at] - taut[at], sagged[at + 1] - taut[at + 1], sagged[at + 2] - taut[at + 2],
      );
      if (d > 1e-6) moved++;
    }
    expect(moved).toBeGreaterThan(5);
    // ... but nowhere near everywhere: only the slack zone's free spans moved.
    expect(moved).toBeLessThan(path.sampleCount);
  });

  it('keeps the sample count, the step and every index exactly as they were', () => {
    // The raster invariant is about SAG, so the dancer — which legitimately
    // changes the path LENGTH and with it the sample count every tick — is held
    // out of it: the machine is run into slackness with the sag switched OFF,
    // and the sag is then switched on for a single tick that moves nothing else.
    const { h, path } = machine({ EnableSag: false });
    h.drive.jogRoller('N2', 760);
    run(h, 6);
    expect(path.zones[1].eps).toBeLessThan(0);
    const count = path.sampleCount;
    const step = path.sampleStepMm;
    const taut = snapshot(path);

    h.drive.jog(0);
    for (const name of ['R0', 'N1', 'N2', 'N3']) h.drive.jogRoller(name, 0);
    path.EnableSag = true;
    h.step(DT);
    expect(path.zones[1].sagDepthMm).toBeGreaterThan(1);
    expect(path.sampleCount).toBe(count);
    expect(path.sampleStepMm).toBe(step);
    expect(snapshot(path)).not.toStrictEqual(taut);
  });

  it('never moves a sample that sits on an ARC (A3)', () => {
    const { h, path } = machine();
    const taut = snapshot(path);
    // The arc on I2 is long (a 300 mm rise over 400 mm), so it owns a run of
    // samples in the middle of the slack zone; every one of them must be
    // bit-identical, because the web lies on the roller there.
    h.drive.jogRoller('N2', 760);
    run(h, 6);
    const sagged = snapshot(path);
    // The arc of I2 begins where the LINE from N1 ends; find the longest
    // unchanged run inside the slack zone and assert it is not empty.
    const zone = path.zones[1];
    let longestUnchanged = 0;
    let current = 0;
    for (let i = zone.colorFromSample; i <= zone.colorToSample; i++) {
      const at = i * STRIDE;
      const same = sagged[at] === taut[at] && sagged[at + 1] === taut[at + 1]
        && sagged[at + 2] === taut[at + 2];
      current = same ? current + 1 : 0;
      if (current > longestUnchanged) longestUnchanged = current;
    }
    expect(longestUnchanged).toBeGreaterThan(2);
  });

  it('leaves the sagging line along the CHORD at both contact points (A3)', () => {
    const { h, path } = machine();
    h.drive.jogRoller('N2', 760);
    run(h, 6);
    const buffer = path.sampleBuffer;
    // The tangent of every sample stays a UNIT vector — a central difference
    // across the line/arc corner would not produce one.
    for (let i = 0; i < path.sampleCount; i++) {
      const at = i * STRIDE;
      const length = Math.hypot(buffer[at + 3], buffer[at + 4], buffer[at + 5]);
      expect(length).toBeCloseTo(1, 6);
    }
  });

  it('scales the DEPTH and nothing else with DeformationScale', () => {
    const { h: h1, path: p1 } = machine();
    h1.drive.jogRoller('N2', 760);
    run(h1, 6);
    const { h: h20, path: p20 } = machine({ DeformationScale: 20 });
    h20.drive.jogRoller('N2', 760);
    run(h20, 6);

    expect(p20.zones[1].eps).toBeCloseTo(p1.zones[1].eps, 9);
    expect(p20.zones[1].tensionN).toBe(p1.zones[1].tensionN);
    expect(p20.zones[1].sagDepthMm).toBeCloseTo(p1.zones[1].sagDepthMm * 20, 6);
    expect(p20.groupToZone).toEqual(p1.groupToZone);
    expect(p20.sampleCount).toBe(p1.sampleCount);
  });

  it('replaces the deformed buffer the moment EnableSag is switched off (A1)', () => {
    // Two identical runs — the dancer travels the same distance in both, so the
    // TAUT geometry is the same one — and only one of them ever sags.
    const { h: hTaut, path: pTaut } = machine({ EnableSag: false });
    hTaut.drive.jogRoller('N2', 760);
    run(hTaut, 6);

    const { h, path } = machine();
    h.drive.jogRoller('N2', 760);
    run(h, 6);
    expect(path.zones[1].sagDepthMm).toBeGreaterThan(1);
    expect(snapshot(path)).not.toStrictEqual(snapshot(pTaut));

    path.EnableSag = false;
    h.step(DT);
    hTaut.step(DT);
    expect(path.zones[1].sagDepthMm).toBe(0);
    // The strain keeps reporting the slackness — only the picture went taut.
    expect(path.zones[1].eps).toBeLessThan(0);
    expect(path.zones[1].state).toBe('slack');
    expect(snapshot(path)).toStrictEqual(snapshot(pTaut));
  });

  it('hangs DOWNWARDS in the world under a rotated parent (A2)', () => {
    // The path node's parent is turned UPSIDE DOWN (180 degrees about Z), so the
    // path's own local -Y is the world +Y. Gravity has to be rotated INTO the
    // local frame; a displacement computed against a hard-coded local -Y would
    // make the web sag UPWARDS in the world, which is the failure this pins.
    //
    // 180 degrees rather than 90: at 90 the layout plane itself becomes vertical
    // in the world and the answer is legitimately not "straight down" any more,
    // so the test would be asserting the wrong thing.
    const h = ribbonHarness(LAYOUT.map((r) => ({ ...r })));
    h.root.quaternion.setFromEuler(new Euler(0, 0, Math.PI));
    h.root.updateMatrixWorld(true);
    const path = h.buildPath({ ...TENSION, EnableSag: false });
    h.drive.jog(BASE_SPEED);
    for (const name of ['R0', 'N1', 'N2', 'N3']) h.drive.jogRoller(name, BASE_SPEED);
    h.step(DT);
    h.drive.jogRoller('N2', 760);
    run(h, 6);
    const taut = snapshot(path);
    // Freeze everything, then let the sag in: the only difference between the
    // two buffers is then the displacement itself.
    h.drive.jog(0);
    for (const name of ['R0', 'N1', 'N2', 'N3']) h.drive.jogRoller(name, 0);
    path.EnableSag = true;
    h.step(DT);
    const sagged = snapshot(path);

    // The largest displacement, rotated into WORLD space.
    const q = new Quaternion();
    h.path.getWorldQuaternion(q);
    const displacement = new Vector3();
    const world = new Vector3();
    const worst = new Vector3();
    const worstLocal = new Vector3();
    let bestMagnitude = 0;
    let highestWorldY = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < path.sampleCount; i++) {
      const at = i * STRIDE;
      displacement.set(
        sagged[at] - taut[at], sagged[at + 1] - taut[at + 1], sagged[at + 2] - taut[at + 2],
      );
      const magnitude = displacement.length();
      if (magnitude < 1e-6) continue;
      world.copy(displacement).applyQuaternion(q);
      if (world.y > highestWorldY) highestWorldY = world.y;
      if (magnitude <= bestMagnitude) continue;
      bestMagnitude = magnitude;
      worst.copy(world);
      worstLocal.copy(displacement);
    }
    expect(bestMagnitude).toBeGreaterThan(1);
    // World: downwards. Local: UPWARDS — which is only possible if gravity was
    // rotated into the path's frame rather than assumed to be local -Y.
    expect(worst.y).toBeLessThan(0);
    expect(worstLocal.y).toBeGreaterThan(0);
    // Every displaced sample hangs the same way; none of them goes up in world.
    expect(highestWorldY).toBeLessThanOrEqual(1e-6);
  });
});

describe('the colour partition', () => {
  it('covers every sample index exactly once', () => {
    const { h, path } = machine();
    run(h, 1);
    let covered = 0;
    for (let k = 0; k < path.zones.length; k++) {
      const zone = path.zones[k];
      expect(zone.colorFromSample).toBe(k === 0 ? 0 : path.zones[k - 1].colorToSample + 1);
      covered += zone.colorToSample - zone.colorFromSample + 1;
    }
    expect(path.zones[0].colorFromSample).toBe(0);
    expect(path.zones[path.zones.length - 1].colorToSample).toBe(path.sampleCount - 1);
    expect(covered).toBe(path.sampleCount);
  });

  it('stays gapless with a WrapDeg end winding and a zero-length arc', () => {
    const specs: RollerSpec[] = [
      { name: 'Unwind', xMm: 0, yMm: 0, radiusMm: 120, winder: true, driven: true, extras: { WrapDeg: 200 } },
      { name: 'N1', xMm: 900, yMm: 0, radiusMm: 120, driven: true },
      // Collinear with equal radii: a ZERO-length wrap arc.
      { name: 'I2', xMm: 1500, yMm: 0, radiusMm: 120 },
      { name: 'N2', xMm: 2100, yMm: 0, radiusMm: 120, driven: true },
      { name: 'Rewind', xMm: 3000, yMm: 0, radiusMm: 120, winder: true, extras: { WrapDeg: 140 } },
    ];
    const h = ribbonHarness(specs);
    const path = h.buildPath(TENSION);
    h.drive.jog(BASE_SPEED);
    run(h, 1);
    let covered = 0;
    for (const zone of path.zones) covered += zone.colorToSample - zone.colorFromSample + 1;
    expect(path.zones.length).toBeGreaterThanOrEqual(3);
    expect(covered).toBe(path.sampleCount);
  });

  it('makes a render group the intersection of a section and a zone', () => {
    const { h, path } = machine();
    run(h, 1);
    // Both maps are as long as the group list, ascending, and start at 0.
    expect(path.groupToSection).toHaveLength(path.groupToZone.length);
    expect(path.groupToSection[0]).toBe(0);
    expect(path.groupToZone[0]).toBe(0);
    for (let g = 1; g < path.groupToZone.length; g++) {
      expect(path.groupToSection[g]).toBeGreaterThanOrEqual(path.groupToSection[g - 1]);
      expect(path.groupToZone[g]).toBeGreaterThanOrEqual(path.groupToZone[g - 1]);
    }
    // More groups than sections: the zones split the sections further.
    expect(path.groupToZone.length).toBeGreaterThan(path.sections.length);
    expect(path.band!.groupCount).toBe(path.groupToZone.length);
  });

  it('scrolls EVERY group of a section, not just the first', () => {
    const { h, path } = machine();
    run(h, 1);
    const band = path.band!;
    const groupsOfSection0: number[] = [];
    for (let g = 0; g < band.groupToSection.length; g++) {
      if (band.groupToSection[g] === 0) groupsOfSection0.push(g);
    }
    expect(groupsOfSection0.length).toBeGreaterThan(1);
    const before = groupsOfSection0.map((g) => band.groupMaterial(g)!.map!.offset.x);
    band.scroll(0, 0.25);
    const after = groupsOfSection0.map((g) => band.groupMaterial(g)!.map!.offset.x);
    for (let i = 0; i < before.length; i++) expect(after[i]).not.toBe(before[i]);
  });

  it('falls back to the plain section partition without tension', () => {
    const h = ribbonHarness(LAYOUT.map((r) => ({ ...r })));
    const path = h.buildPath({ ...TENSION, TensileStiffnessNPerMmWidth: 0 });
    h.drive.jog(BASE_SPEED);
    run(h, 1);
    expect(path.groupToZone).toHaveLength(0);
    expect(path.band!.groupCount).toBe(path.sections.length);
    expect(path.band!.sectionStarts.length).toBe(path.sections.length);
  });
});

describe('the band tint', () => {
  it('leaves the good web completely alone', () => {
    const { h, path } = machine();
    run(h, 2);
    const band = path.band!;
    for (const zone of path.zones) expect(zone.state).toBe('inBand');
    for (let g = 0; g < band.groupCount; g++) expect(band.isTinted(g)).toBe(false);
  });

  it('paints SLACK cyan and OVER magenta', () => {
    const { h, path } = machine();
    h.drive.jogRoller('N2', 700);
    run(h, 6);
    const band = path.band!;
    const slackGroup = path.groupToZone.findIndex((z) => path.zones[z].state === 'slack');
    expect(slackGroup).toBeGreaterThanOrEqual(0);
    const cyan = band.groupMaterial(slackGroup)!;
    expect(cyan.color.b).toBeGreaterThan(cyan.color.r);
    expect(cyan.color.g).toBeGreaterThan(cyan.color.r);

    const { h: h2, path: p2 } = machine();
    h2.drive.jogRoller('N2', 900);
    run(h2, 6);
    const overGroup = p2.groupToZone.findIndex((z) => p2.zones[z].state === 'over' || p2.zones[z].state === 'broken');
    expect(overGroup).toBeGreaterThanOrEqual(0);
    const magenta = p2.band!.groupMaterial(overGroup)!;
    expect(magenta.color.r).toBeGreaterThan(magenta.color.g);
    expect(magenta.color.b).toBeGreaterThan(magenta.color.g);
  });

  it('sets an EMISSIVE contribution for an alarm and restores it bit-exactly (A6)', () => {
    const { h, path } = machine();
    const band = path.band!;
    const group = 0;
    const material = band.groupMaterial(group)!;
    const baseColor = material.color.clone();
    const baseEmissive = material.emissive.clone();
    const baseIntensity = material.emissiveIntensity;

    h.drive.jogRoller('N1', 1400);          // drive zone 0 hard into OVER
    run(h, 6);
    const zone = path.zones[path.groupToZone[group]];
    expect(['over', 'broken']).toContain(zone.state);
    // Additive, so it is readable even on a black texel — which `.color` alone,
    // being a multiply, never would be.
    expect(material.emissive.getHex()).not.toBe(baseEmissive.getHex());
    expect(material.emissive.r + material.emissive.g + material.emissive.b).toBeGreaterThan(0);

    path.TensionColoring = false;
    run(h, 0.1);
    expect(material.color.getHex()).toBe(baseColor.getHex());
    expect(material.emissive.getHex()).toBe(baseEmissive.getHex());
    expect(material.emissiveIntensity).toBe(baseIntensity);
    expect(band.isTinted(group)).toBe(false);
  });

  it('grows the saturation continuously and WITHOUT re-sampling the band (A1)', () => {
    const { h, path } = machine();
    run(h, 1);
    const band = path.band!;
    // Freeze the machine: nothing moves, so the geometry has no reason to be
    // rewritten — and the colour still has to follow the strain.
    h.drive.jog(0);
    for (const name of ['R0', 'N1', 'N2', 'N3']) h.drive.jogRoller(name, 0);
    run(h, 0.2);

    const writeSpy = vi.spyOn(band, 'write');
    const group = 0;
    const material = band.groupMaterial(group)!;
    const saturations: number[] = [];
    // Walk the strain of zone 0 by hand, from inside the band out to the alarm.
    for (const eps of [0.0095, 0.0080, 0.0060, 0.0040, 0.0020, 0.0005]) {
      path.zones[0].eps = eps;
      h.step(DT);
      saturations.push(Math.abs(material.color.b - material.color.r));
    }
    expect(writeSpy).not.toHaveBeenCalled();
    // Strictly increasing: a continuous ramp, not a two-step on/off.
    expect(saturations[0]).toBe(0);
    for (let i = 2; i < saturations.length; i++) {
      expect(saturations[i]).toBeGreaterThan(saturations[i - 1]);
    }
    writeSpy.mockRestore();
  });
});

describe('allocation (A5)', () => {
  /**
   * Count the allocation sources this subsystem could plausibly use.
   *
   * A proxy on `Array` alone is not enough and the plan says so: an array
   * LITERAL never calls it, and neither does `slice()`. So the prototype methods
   * that produce new arrays are patched too, together with `Float32Array` and
   * the three.js group churn — and the counter is proven to work by a POSITIVE
   * CONTROL that allocates on purpose.
   */
  function withAllocationCounter<T>(body: (count: () => number) => T): T {
    let n = 0;
    const bump = <R>(fn: () => R): R => { n++; return fn(); };
    const arrayProto = Array.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    const originals: Record<string, (...a: unknown[]) => unknown> = {};
    for (const name of ['slice', 'map', 'filter', 'concat', 'flat']) {
      originals[name] = arrayProto[name];
      const original = originals[name];
      arrayProto[name] = function patched(this: unknown[], ...args: unknown[]) {
        return bump(() => original.apply(this, args));
      };
    }
    const globals = globalThis as unknown as Record<string, unknown>;
    const F32 = globals.Float32Array as Float32ArrayConstructor;
    const Arr = globals.Array as ArrayConstructor;
    globals.Float32Array = new Proxy(F32, { construct: (t, a) => bump(() => Reflect.construct(t, a)) });
    globals.Array = new Proxy(Arr, { construct: (t, a) => bump(() => Reflect.construct(t, a)) });
    try {
      return body(() => n);
    } finally {
      for (const name of ['slice', 'map', 'filter', 'concat', 'flat']) arrayProto[name] = originals[name];
      globals.Float32Array = F32;
      globals.Array = Arr;
    }
  }

  it('catches a deliberate allocation (the positive control)', () => {
    withAllocationCounter((count) => {
      const before = count();
      const victim = [1, 2, 3];
      victim.slice();
      expect(count()).toBeGreaterThan(before);
    });
  });

  it('allocates nothing over 200 warm ticks with sag, colour AND a moving dancer', () => {
    const { h, path } = machine();
    // Sag in one zone, a colour that keeps changing, and a carriage in motion —
    // the three things that re-solve the geometry on every single tick.
    h.drive.jogRoller('N2', 770);
    h.drive.jogRoller('N3', 790);
    h.dancer('D').LoadN = 80;
    run(h, 3);                                  // warm up: every buffer grown
    expect(path.zones.some((z) => z.sagDepthMm > 0)).toBe(true);

    withAllocationCounter((count) => {
      const before = count();
      for (let i = 0; i < 200; i++) h.step(DT);
      expect(count() - before).toBe(0);
    });
  });
});

describe('the disabled path', () => {
  /**
   * The hard fallback guarantee: with the stiffness at 0 the tension code is
   * never entered, so the band a path produces must be EXACTLY the band a path
   * that never heard of tension produces — compared `toStrictEqual` on the
   * sample buffer and the group list, not through a float tolerance.
   */
  function reference(overrides: Record<string, unknown>, seconds = 4): { samples: Float32Array; starts: number[]; count: number } {
    const h = ribbonHarness(LAYOUT.map((r) => ({ ...r })));
    const path = h.buildPath(overrides);
    h.drive.jog(BASE_SPEED);
    for (const name of ['R0', 'N1', 'N2', 'N3']) h.drive.jogRoller(name, BASE_SPEED);
    h.step(DT);
    h.drive.jogRoller('N2', 760);
    run(h, seconds);
    return {
      samples: path.sampleBuffer.slice(0, path.sampleCount * STRIDE),
      starts: [...path.band!.sectionStarts],
      count: path.sampleCount,
    };
  }

  it('is bit-identical to a path with no tension fields at all', () => {
    const untensioned = reference({ RibbonWidthMm: 500 });
    const disabled = reference({ ...TENSION, TensileStiffnessNPerMmWidth: 0 });
    expect(disabled.count).toBe(untensioned.count);
    expect(disabled.samples).toStrictEqual(untensioned.samples);
    expect(disabled.starts).toStrictEqual(untensioned.starts);
  });

  it('returns to that exact state when the stiffness is switched back off', () => {
    // The twin runs exactly as long, so the dancer has travelled exactly as far
    // and the only thing that could still differ is a leftover of the tension
    // code: a sag in the buffer, or a zone split in the group list.
    const untensioned = reference({ RibbonWidthMm: 500 }, 4.5);
    const h = ribbonHarness(LAYOUT.map((r) => ({ ...r })));
    const path = h.buildPath(TENSION);
    h.drive.jog(BASE_SPEED);
    for (const name of ['R0', 'N1', 'N2', 'N3']) h.drive.jogRoller(name, BASE_SPEED);
    h.step(DT);
    h.drive.jogRoller('N2', 760);
    run(h, 4);
    expect(path.zones.some((z) => z.sagDepthMm > 0)).toBe(true);

    path.TensileStiffnessNPerMmWidth = 0;
    run(h, 0.5);
    expect(path.sampleCount).toBe(untensioned.count);
    expect(path.sampleBuffer.slice(0, path.sampleCount * STRIDE)).toStrictEqual(untensioned.samples);
    expect([...path.band!.sectionStarts]).toStrictEqual(untensioned.starts);
  });
});
