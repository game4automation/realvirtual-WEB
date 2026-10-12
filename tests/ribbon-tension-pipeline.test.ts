// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ribbon-tension-pipeline.test.ts — zones, modes and the dancer as a tension
 * setter (plan-471 Phases 2 + 3, §9 "Vitest, Pipeline").
 *
 * ## The layout
 *
 * The plan's demo machine, built on a straight line of equal-radius rollers so
 * every zone length is exactly a sum of centre distances and the wrap arcs are
 * zero-length. That is what makes the assertions ANALYTIC rather than measured:
 *
 * ```
 *   idx  0    1    2     3     4     5      6     7     8
 *        R0 — I1 — N1 —  I2 —  N2 —  D  —   I3 —  N3 —  R4
 *        0   400  800  1200  1600  2000   2400  2800  3200   [mm]
 *      driven    driven      driven dancer     driven
 * ```
 *
 * Boundary rollers are the two ends, the three nips and the dancer, so there are
 * five zones: `R0-N1` (800 mm), `N1-N2` (800 mm — the one the plan pins),
 * `N2-D` (400), `D-N3` (800) and `N3-R4` (400).
 *
 * ## Why R0 is DRIVEN
 *
 * The boundary contract gives a NON-driven end roller the speed of its SECTION,
 * and a section runs at the speed of its LAST driven roller — `N2`, not `N1`.
 * An undriven `R0` would therefore feed the first zone `N2`'s speed, and the
 * whole strain pattern would shift one zone upstream. Driving the unwinder at
 * the base speed — what a real unwinder with a brake drive does — makes the
 * first zone `v_A = v_B` and leaves it at the set point, which is the premise
 * every number in the plan's Phase 6 table is computed under.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ribbonHarness, signalRef, type RibbonHarness, type RollerSpec } from './ribbon-fixture';
import { strainSteadyState } from '../src/core/engine/ribbon/ribbon-tension-math';

const DT = 1 / 60;

/** K = 10 N/mm, w = 500 mm -> K*w = 5000 N; T_ref = 50 N -> eps_ref = 1 %. */
const TENSION = {
  TensileStiffnessNPerMmWidth: 10,
  RibbonWidthMm: 500,
  TargetTensionNPerM: 100,
  MinStrainPercent: 0,
  MaxStrainPercent: 2,
  ToleranceBandPercent: 10,
  BreakForceNPer50mm: 35,
  EnableSag: true,
} as const;

const EPS_REF = 0.01;

/** % — the hysteresis the `StrainPercent` slot is written with. */
const SIGNAL_STRAIN_HYSTERESIS_PERCENT = 0.01;
const BASE_SPEED = 800;

const LAYOUT: RollerSpec[] = [
  { name: 'R0', xMm: 0, yMm: 0, radiusMm: 50, driven: true },
  { name: 'I1', xMm: 400, yMm: 0, radiusMm: 50 },
  { name: 'N1', xMm: 800, yMm: 0, radiusMm: 50, driven: true },
  { name: 'I2', xMm: 1200, yMm: 0, radiusMm: 50 },
  { name: 'N2', xMm: 1600, yMm: 0, radiusMm: 50, driven: true },
  { name: 'D', xMm: 2000, yMm: 0, radiusMm: 50, dancer: true },
  { name: 'I3', xMm: 2400, yMm: 0, radiusMm: 50 },
  { name: 'N3', xMm: 2800, yMm: 0, radiusMm: 50, driven: true },
  { name: 'R4', xMm: 3200, yMm: 0, radiusMm: 50 },
];

type Path = ReturnType<RibbonHarness['buildPath']>;

/**
 * The demo machine, every nip commanded to the base web speed, settled by one
 * tick.
 *
 * The tick is load-bearing: `RibbonRoller.isDriven` is answered from the drive
 * SAMPLE of the current tick (a linear drive does not drive a web, and only the
 * sample knows the axis), so at construction time no roller reports itself
 * driven yet and the partition is provisional. The first tick re-partitions it —
 * which is the same mechanism that picks up a `Drive` added at run time.
 */
function machine(overrides: Record<string, unknown> = {}): { h: RibbonHarness; path: Path } {
  const h = ribbonHarness(LAYOUT.map((r) => ({ ...r })));
  const path = h.buildPath({ ...TENSION, ...overrides });
  h.drive.jog(BASE_SPEED);
  for (const name of ['R0', 'N1', 'N2', 'N3']) h.drive.jogRoller(name, BASE_SPEED);
  h.step(DT);
  return { h, path };
}

function run(h: RibbonHarness, seconds: number): void {
  const ticks = Math.round(seconds / DT);
  for (let i = 0; i < ticks; i++) h.step(DT);
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

describe('the zone partition', () => {
  it('puts a boundary at both ends, at every driven roller and at the dancer', () => {
    const { h, path } = machine();
    expect(path.tensionEnabled).toBe(true);
    expect(path.zones.map((z) => [z.fromRoller, z.toRoller]))
      .toEqual([[0, 2], [2, 4], [4, 5], [5, 7], [7, 8]]);
  });

  it('takes the zone length from the analytic segments, not from sample indices', () => {
    const { path } = machine();
    // Straight line of equal radii: every wrap arc is zero-length, so a zone is
    // exactly the sum of the centre distances it spans.
    expect(path.zones.map((z) => Math.round(z.lengthMm))).toEqual([800, 800, 400, 800, 400]);
  });

  it('starts every zone at the set-point strain', () => {
    const { path } = machine();
    expect(path.referenceStrain).toBeCloseTo(EPS_REF, 12);
    for (const zone of path.zones) expect(zone.eps).toBeCloseTo(EPS_REF, 12);
  });

  it('builds NOTHING while the stiffness is 0 — the whole feature is one switch', () => {
    const h = ribbonHarness(LAYOUT.map((r) => ({ ...r })));
    const path = h.buildPath({ ...TENSION, TensileStiffnessNPerMmWidth: 0 });
    h.drive.jog(BASE_SPEED);
    run(h, 1);
    expect(path.tensionEnabled).toBe(false);
    expect(path.zones).toHaveLength(0);
    expect(path.groupToZone).toHaveLength(0);
  });
});

describe('the span equation on the machine', () => {
  it('converges every integrated zone onto its steady state (the oracle)', () => {
    const { h, path } = machine();
    h.drive.jogRoller('N2', 816);
    run(h, 8);

    // The first zone is fed at the set point and runs v_A = v_B, so it stays
    // there: that is the premise of the numbers below.
    expect(path.zones[0].eps).toBeCloseTo(EPS_REF, 9);
    // N1 -> N2: v_A = 800, v_B = 816, eps_in = 1 % -> 24 / 816 = 2.94 %.
    expect(Math.abs(path.zones[1].eps - strainSteadyState(EPS_REF, 800, 816))).toBeLessThan(1e-5);
    expect(path.zones[1].eps).toBeCloseTo(0.0294117647, 4);
    expect(path.zones[1].state).toBe('over');
  });

  it('goes SLACK when the downstream nip runs slower', () => {
    const { h, path } = machine();
    h.drive.jogRoller('N2', 784);
    run(h, 8);
    // (784 - 800 + 0.01 * 800) / 784 = -1.02 %.
    expect(Math.abs(path.zones[1].eps - strainSteadyState(EPS_REF, 800, 784))).toBeLessThan(1e-5);
    expect(path.zones[1].eps).toBeCloseTo(-0.0102040816, 4);
    expect(path.zones[1].state).toBe('slack');
    expect(path.zones[1].tensionN).toBe(0);          // a rope does not push
    expect(path.zones[1].sagDepthMm).toBeGreaterThan(0);
  });

  it('sits exactly at the set point when every nip runs at the same speed', () => {
    const { h, path } = machine();
    run(h, 4);
    for (const zone of path.zones) {
      expect(zone.eps).toBeCloseTo(EPS_REF, 9);
      expect(zone.state).toBe('inBand');
      expect(zone.tensionN).toBeCloseTo(50, 6);
    }
  });

  it('lets a middle driven roller keep its OWN speed against its section', () => {
    const { h, path } = machine();
    // N2 leads section 0, so the section runs at 816 — but N1, which is in the
    // same section, still contributes its own 800 as the zone's entry speed.
    // Without that there would be no speed difference anywhere and no tension.
    h.drive.jogRoller('N2', 816);
    run(h, 2);
    expect(path.sections[0].speed).toBeCloseTo(816, 6);
    expect(path.zones[1].eps).toBeGreaterThan(EPS_REF);
  });
});

describe('the loaded dancer', () => {
  function loaded(loadN: number): { h: RibbonHarness; path: ReturnType<RibbonHarness['buildPath']> } {
    const { h, path } = machine();
    h.dancer('D').LoadN = loadN;
    return { h, path };
  }

  it('sets the tension of BOTH neighbouring zones immediately', () => {
    const { h, path } = loaded(100);
    h.step(DT);
    // T = LoadN / Strands = 100 / 2 = 50 N, in ONE tick, not integrated towards.
    expect(path.zones[2].mode).toBe('algebraic');
    expect(path.zones[3].mode).toBe('algebraic');
    expect(path.zones[2].tensionN).toBeCloseTo(50, 9);
    expect(path.zones[3].tensionN).toBeCloseTo(50, 9);
  });

  it('jumps on 0 -> 100 and resumes WITHOUT a jump on 100 -> 0', () => {
    const { h, path } = loaded(0);
    h.drive.jogRoller('N3', 808);
    run(h, 3);
    const beforeLoad = path.zones[3].eps;

    h.dancer('D').LoadN = 300;                  // T = 150 N -> eps = 3 %
    h.step(DT);
    expect(path.zones[3].mode).toBe('algebraic');
    expect(path.zones[3].eps).toBeCloseTo(0.03, 9);
    expect(Math.abs(path.zones[3].eps - beforeLoad)).toBeGreaterThan(0.005);   // a real jump

    h.dancer('D').LoadN = 0;
    h.step(DT);
    expect(path.zones[3].mode).toBe('integrated');
    // Continuity: the integrator starts from the value the load left behind, so
    // one tick moves it by at most one implicit Euler step, never by a jump.
    expect(Math.abs(path.zones[3].eps - 0.03)).toBeLessThan(5e-4);
  });

  it('does not move the carriage when only the LOAD changes (E9)', () => {
    const { h, path } = loaded(0);
    run(h, 2);
    const at = h.dancer('D').positionMm;
    h.dancer('D').LoadN = 400;
    run(h, 2);
    expect(h.dancer('D').positionMm).toBeCloseTo(at, 9);
    expect(path.zones[2].tensionN).toBeCloseTo(200, 9);
  });

  it('still moves the carriage on a speed difference, load or no load', () => {
    const { h } = loaded(100);
    h.drive.jogRoller('N3', 780);               // the store fills
    run(h, 2);
    expect(h.dancer('D').positionMm).toBeGreaterThan(1);
  });

  it('reports its tension through its own signal slot', () => {
    const h = ribbonHarness(LAYOUT.map((r) => (r.name === 'D'
      ? { ...r, extras: { TensionN: signalRef('Signals/DancerTension', 'PLCInputFloat') } }
      : { ...r })));
    const writes: Array<[string, number | boolean]> = [];
    h.ribbonManager.setSignalWriter((a, v) => { writes.push([a, v]); });
    h.buildPath(TENSION);
    h.drive.jog(BASE_SPEED);
    h.dancer('D').LoadN = 100;
    h.step(DT);
    expect(writes).toContainEqual(['Signals/DancerTension', 50]);
  });
});

describe('clamps, stops and the things that are NOT clamps', () => {
  it('preserves every strain exactly through a group stop', () => {
    const specs: RollerSpec[] = [
      { name: 'Unwind', xMm: 0, yMm: 0, radiusMm: 90, winder: true, driven: true },
      { name: 'N1', xMm: 800, yMm: 0, radiusMm: 90, driven: true },
      { name: 'I2', xMm: 1200, yMm: 0, radiusMm: 90 },
      { name: 'N2', xMm: 1600, yMm: 0, radiusMm: 90, driven: true },
      { name: 'Rewind', xMm: 2400, yMm: 0, radiusMm: 90, winder: true },
    ];
    const h = ribbonHarness(specs);
    const path = h.buildPath({ ...TENSION, InitialWoundLengthMm: 0 });
    h.drive.jog(BASE_SPEED);
    h.drive.jogRoller('N2', 816);
    run(h, 4);
    const before = path.zones.map((z) => z.eps);
    expect(before[1]).not.toBeCloseTo(EPS_REF, 4);

    // Empty the unwinder: step 3a zeroes every section of the whole group, and
    // with both boundary slots at 0 the span equation is a no-op.
    for (const winder of path.winders) if (winder.role === 'unwind') winder.woundLengthMm = 0;
    run(h, 1);
    expect(path.zones.map((z) => z.eps)).toEqual(before);
  });

  it('does NOT clamp anything at the SLACK or OVER thresholds', () => {
    const { h, path } = machine({ MaxStrainPercent: 0.5 });
    h.drive.jogRoller('N2', 816);
    run(h, 8);
    // The alarm fires, the strain keeps going: an alarm is not a clamp.
    expect(path.zones[1].state).toBe('over');
    expect(path.zones[1].eps).toBeGreaterThan(0.02);
  });

  it('freezes a BROKEN zone until a reset, and only that one', () => {
    // eps_break = (35 / 50) / 10 = 0.07; drive zone 1 straight past it.
    const { h, path } = machine();
    h.drive.jogRoller('N2', 1000);
    run(h, 8);
    expect(path.zones[1].state).toBe('broken');
    expect(path.zones[1].broken).toBe(true);
    const torn = path.zones[1].eps;
    run(h, 2);
    expect(path.zones[1].eps).toBe(torn);
    expect(path.zones[1].mode).toBe('frozen');
    expect(path.zones[0].broken).toBe(false);

    h.ribbonManager.resetAll();
    expect(path.zones[1].broken).toBe(false);
    expect(path.zones[1].eps).toBeCloseTo(EPS_REF, 12);
  });

  it('freezes — and warns once — while the web runs backwards', () => {
    const { h, path } = machine();
    h.drive.jogRoller('N2', 816);
    run(h, 4);
    const before = path.zones[1].eps;
    h.drive.jog(-BASE_SPEED);
    for (const name of ['R0', 'N1', 'N2', 'N3']) h.drive.jogRoller(name, -BASE_SPEED);
    run(h, 2);
    expect(path.zones[1].eps).toBe(before);
    expect(path.zones[1].mode).toBe('frozen');
    expect(warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('BACKWARDS'))).toHaveLength(1);
  });
});

describe('the partition follows the configuration', () => {
  it('ignores a SECOND dancer, for LoadN exactly as for everything else', () => {
    const specs = LAYOUT.map((r) => ({ ...r }));
    specs[6] = { ...specs[6], dancer: true };              // I3 becomes a second dancer
    const h = ribbonHarness(specs);
    const path = h.buildPath(TENSION);
    h.drive.jog(BASE_SPEED);
    for (const name of ['R0', 'N1', 'N2', 'N3']) h.drive.jogRoller(name, BASE_SPEED);
    h.dancer('I3').LoadN = 1000;
    h.step(DT);
    expect(path.dancers).toHaveLength(1);
    // The ignored dancer is not a boundary and sets no tension anywhere.
    expect(path.zones.some((z) => z.fromRoller === 6 || z.toRoller === 6)).toBe(false);
    for (const zone of path.zones) expect(zone.eps).toBeCloseTo(EPS_REF, 6);
  });

  // SOL R1 #5. A slit strip used to refuse tension outright; it now carries it,
  // with the force split by width at the blade.
  it('tensions a SLIT strip and carries the FULL width upstream of the blade', () => {
    const h = ribbonHarness(LAYOUT.map((r) => ({ ...r })));
    const path = h.buildPath({ ...TENSION, SlitAtRoller: { type: 'ComponentReference', path: 'Root/N2', componentType: 'UnityEngine.Transform' }, FullWidthMm: 900 });
    h.drive.jog(BASE_SPEED);
    run(h, 1);

    expect(path.tensionEnabled).toBe(true);
    expect(warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('SLIT strip'))).toHaveLength(0);

    // N2 is roller 4 and the blade sits on it, so no zone straddles the cut.
    for (const zone of path.zones) {
      expect(zone.fromRoller >= 4 || zone.toRoller <= 4).toBe(true);
    }

    // At the set point every zone holds eps_ref, so the only thing separating
    // the force upstream from the force downstream is the width that carries
    // it: 900 mm of sheet before the blade, 500 mm of strip after it.
    const before = path.zones.find((z) => z.toRoller <= 4)!;
    const after = path.zones.find((z) => z.fromRoller >= 4)!;
    expect(before.eps).toBeCloseTo(EPS_REF, 6);
    expect(after.eps).toBeCloseTo(EPS_REF, 6);
    expect(before.tensionN).toBeCloseTo(10 * 900 * EPS_REF, 6);
    expect(after.tensionN).toBeCloseTo(10 * 500 * EPS_REF, 6);
    // The strip's share of the force is its share of the width.
    expect(after.tensionN / before.tensionN).toBeCloseTo(500 / 900, 6);
  });

  it('keeps the strain of a zone whose boundaries survived a rebuild', () => {
    const { h, path } = machine();
    h.drive.jogRoller('N2', 816);
    run(h, 4);
    const before = path.zones[1].eps;
    // The dancer moves every tick, so the geometry is rebuilt constantly; the
    // boundary pair (2, 4) is unchanged and the strain must survive it.
    h.drive.jogRoller('N3', 700);
    run(h, 0.5);
    expect(path.zones[1].eps).not.toBe(before);          // it kept integrating
    expect(path.zones.map((z) => [z.fromRoller, z.toRoller]))
      .toEqual([[0, 2], [2, 4], [4, 5], [5, 7], [7, 8]]);
  });

  it('re-partitions when a Drive appears on a roller', () => {
    const { h, path } = machine();
    run(h, 0.2);
    expect(path.zones).toHaveLength(5);
    h.addDrive('I2');
    h.drive.jogRoller('I2', BASE_SPEED);
    h.step(DT);
    expect(path.zones.map((z) => [z.fromRoller, z.toRoller]))
      .toEqual([[0, 2], [2, 3], [3, 4], [4, 5], [5, 7], [7, 8]]);
  });

  it('tears the partition down when the stiffness is switched off at run time', () => {
    const { h, path } = machine();
    const writes: Array<[string, number | boolean]> = [];
    h.ribbonManager.setSignalWriter((a, v) => { writes.push([a, v]); });
    h.drive.jogRoller('N2', 784);
    run(h, 4);
    expect(path.zones[1].sagDepthMm).toBeGreaterThan(0);

    path.TensileStiffnessNPerMmWidth = 0;
    run(h, 0.2);
    expect(path.tensionEnabled).toBe(false);
    expect(path.zones).toHaveLength(0);
    expect(path.band!.groupCount).toBe(path.sections.length);
  });
});

describe('the path signals', () => {
  function wired(): { h: RibbonHarness; path: Path; writes: Array<[string, number | boolean]> } {
    const h = ribbonHarness(LAYOUT.map((r) => ({ ...r })));
    const writes: Array<[string, number | boolean]> = [];
    h.ribbonManager.setSignalWriter((a, v) => { writes.push([a, v]); h.signalStore.setByPath(a, v); });
    const path = h.buildPath({
      ...TENSION,
      TensionN: signalRef('Signals/Tension', 'PLCInputFloat'),
      SpecificTensionNPerM: signalRef('Signals/NPerM', 'PLCInputFloat'),
      StrainPercent: signalRef('Signals/Strain', 'PLCInputFloat'),
      IsSlack: signalRef('Signals/Slack', 'PLCInputBool'),
      IsOverstretched: signalRef('Signals/Over', 'PLCInputBool'),
      IsBroken: signalRef('Signals/Broken', 'PLCInputBool'),
    });
    h.drive.jog(BASE_SPEED);
    for (const name of ['R0', 'N1', 'N2', 'N3']) h.drive.jogRoller(name, BASE_SPEED);
    h.step(DT);
    return { h, path, writes };
  }

  it('measures the LAST zone and ORs the alarms over all of them', () => {
    const { h, path, writes } = wired();
    h.drive.jogRoller('N2', 784);
    run(h, 8);
    // Zone 1 is slack; the last zone passes its strain on, so both agree here.
    expect(path.zones.map((z) => z.state)).toEqual(
      ['inBand', 'slack', 'slack', 'slack', 'slack'],
    );
    const lastOf = (address: string): number | boolean | undefined => {
      for (let i = writes.length - 1; i >= 0; i--) if (writes[i][0] === address) return writes[i][1];
      return undefined;
    };
    expect(lastOf('Signals/Slack')).toBe(true);
    expect(lastOf('Signals/Over')).toBe(false);
    expect(lastOf('Signals/Broken')).toBe(false);
    // The measured zone is the LAST one, which here carries zone 1's slackness
    // through two pass-through zones, so the specific tension reads 0 N/m.
    expect(lastOf('Signals/NPerM')).toBe(0);
    // Within the 0.01 % hysteresis of the strain slot, never further: the last
    // written value may legitimately lag the current one by exactly that much.
    expect(Math.abs((lastOf('Signals/Strain') as number) - path.zones[4].eps * 100))
      .toBeLessThanOrEqual(SIGNAL_STRAIN_HYSTERESIS_PERCENT);
  });

  it('writes the initial state once and then only on a real change', () => {
    const { h, writes } = wired();
    run(h, 1);
    const slack = writes.filter(([a]) => a === 'Signals/Slack');
    expect(slack).toEqual([['Signals/Slack', false]]);
    const nPerM = writes.filter(([a]) => a === 'Signals/NPerM');
    // Everything sits exactly at the set point, so after the first write the
    // hysteresis swallows the rest.
    expect(nPerM).toHaveLength(1);
    expect(nPerM[0][1]).toBeCloseTo(100, 6);
  });

  it('reports zero and false once the stiffness is switched off', () => {
    const { h, writes } = wired();
    h.drive.jogRoller('N2', 784);
    run(h, 4);
    writes.length = 0;
    (h.ribbonManager.groups[0].paths[0] as { TensileStiffnessNPerMmWidth: number })
      .TensileStiffnessNPerMmWidth = 0;
    run(h, 0.2);
    const lastOf = (address: string): number | boolean | undefined => {
      for (let i = writes.length - 1; i >= 0; i--) if (writes[i][0] === address) return writes[i][1];
      return undefined;
    };
    expect(lastOf('Signals/Slack')).toBe(false);
    expect(lastOf('Signals/NPerM')).toBe(0);
  });
});

/**
 * The boundary rule for FREE end rollers (corrected in the closing gate).
 *
 * An unwinder without a drive is dragged by the FIRST nip downstream, and the
 * web between the two runs at that nip's speed. The plan first wrote "the speed
 * of its section" — and a section runs at the speed of its LAST driven roller,
 * i.e. the far end of the line — so a free unwinder was fed a speed from a
 * completely different part of the machine and its zone showed a strain that
 * belonged to nothing.
 *
 * The layout below makes the difference impossible to miss: the rewinder runs
 * at 808 mm/s while the first nip runs at 800, so the two rules disagree about
 * the first zone by an order of magnitude.
 */
describe('free end rollers take the nearest driven roller, not their section', () => {
  const FREE_UNWINDER: RollerSpec[] = [
    { name: 'Unwind', xMm: 0, yMm: 0, radiusMm: 50 },                 // NOT driven
    { name: 'N1', xMm: 800, yMm: 0, radiusMm: 50, driven: true },
    { name: 'I', xMm: 1200, yMm: 0, radiusMm: 50 },
    { name: 'N2', xMm: 1600, yMm: 0, radiusMm: 50, driven: true },
    { name: 'Rewind', xMm: 2400, yMm: 0, radiusMm: 50, driven: true },
  ];

  /** The mirror image: the REWINDER is the free one. */
  const FREE_REWINDER: RollerSpec[] = [
    { name: 'Unwind', xMm: 0, yMm: 0, radiusMm: 50, driven: true },
    { name: 'N1', xMm: 800, yMm: 0, radiusMm: 50, driven: true },
    { name: 'I', xMm: 1200, yMm: 0, radiusMm: 50 },
    { name: 'N2', xMm: 1600, yMm: 0, radiusMm: 50, driven: true },
    { name: 'Rewind', xMm: 2400, yMm: 0, radiusMm: 50 },              // NOT driven
  ];

  function line(specs: RollerSpec[], driven: Record<string, number>): { h: RibbonHarness; path: Path } {
    const h = ribbonHarness(specs.map((r) => ({ ...r })));
    const path = h.buildPath(TENSION);
    h.drive.jog(BASE_SPEED);
    for (const [name, speed] of Object.entries(driven)) h.drive.jogRoller(name, speed);
    h.step(DT);
    return { h, path };
  }

  it('leaves the first zone at the set point whatever the far end does', () => {
    // Rewind at 808 is the trap: under the old "speed of its section" rule the
    // free unwinder would have been fed 808 against N1's 800, and the first zone
    // would have settled near 0 % instead of at its 1 % set point.
    const { h, path } = line(FREE_UNWINDER, { N1: 800, N2: 816, Rewind: 808 });
    run(h, 8);
    expect(path.zones.map((z) => [z.fromRoller, z.toRoller])).toEqual([[0, 1], [1, 3], [3, 4]]);
    expect(path.zones[0].eps).toBeCloseTo(EPS_REF, 9);
    expect(path.zones[0].state).toBe('inBand');
  });

  it('reproduces the plan numbers for the zone between the two nips', () => {
    // 816 -> eps_ss = (816 - 800 + 0.01 * 800) / 816 = +2.94 %.
    const fast = line(FREE_UNWINDER, { N1: 800, N2: 816, Rewind: 808 });
    run(fast.h, 8);
    expect(fast.path.zones[1].lengthMm).toBeCloseTo(800, 6);
    expect(Math.abs(fast.path.zones[1].eps - 0.0294117647)).toBeLessThan(1e-4);
    expect(fast.path.zones[1].state).toBe('over');

    // 784 -> eps_ss = (784 - 800 + 0.01 * 800) / 784 = -1.02 %.
    const slow = line(FREE_UNWINDER, { N1: 800, N2: 784, Rewind: 808 });
    run(slow.h, 8);
    expect(Math.abs(slow.path.zones[1].eps - -0.0102040816)).toBeLessThan(1e-4);
    expect(slow.path.zones[1].state).toBe('slack');
  });

  it('holds the first zone steady even when the far end is moved mid-run', () => {
    const { h, path } = line(FREE_UNWINDER, { N1: 800, N2: 800, Rewind: 800 });
    run(h, 4);
    expect(path.zones[0].eps).toBeCloseTo(EPS_REF, 9);
    h.drive.jogRoller('Rewind', 900);
    h.drive.jogRoller('N2', 770);
    run(h, 6);
    // The unwinder follows N1 and nothing else, so its zone never moved.
    expect(path.zones[0].eps).toBeCloseTo(EPS_REF, 9);
  });

  it('makes a FREE rewinder follow the LAST nip (the mirror rule)', () => {
    const { h, path } = line(FREE_REWINDER, { Unwind: 800, N1: 800, N2: 816 });
    // 16 s rather than 8: the last zone chases the one above it through a second
    // first-order lag, so the cascade settles at roughly half the rate a single
    // zone does.
    run(h, 16);
    // v_A and v_B of the last zone are both N2's speed, so it carries the strain
    // of the zone above it through unchanged instead of stretching it again.
    // Within 1e-4: it chases a zone that is itself still settling, so it lags by
    // its own time constant rather than being bit-equal.
    expect(Math.abs(path.zones[2].eps - path.zones[1].eps)).toBeLessThan(1e-4);
    expect(Math.abs(path.zones[1].eps - 0.0294117647)).toBeLessThan(1e-4);

    // Move the last nip: the free rewinder moves with it, so the last zone stays
    // a pass-through rather than developing a strain of its own.
    h.drive.jogRoller('N2', 784);
    run(h, 16);
    expect(Math.abs(path.zones[2].eps - path.zones[1].eps)).toBeLessThan(1e-4);
    expect(Math.abs(path.zones[1].eps - -0.0102040816)).toBeLessThan(1e-4);
  });

  it('falls back to the section speed when that side has no driven roller', () => {
    // Nothing driven upstream of the rewinder except through the section fill:
    // a path whose ONLY drive sits on the unwinder. The free rewinder then has a
    // driven roller upstream (the unwinder), which is exactly the fallback's
    // neighbour case; a path with no drive at all stands still with a warning.
    const specs: RollerSpec[] = [
      { name: 'Unwind', xMm: 0, yMm: 0, radiusMm: 50, driven: true },
      { name: 'I', xMm: 800, yMm: 0, radiusMm: 50 },
      { name: 'Rewind', xMm: 1600, yMm: 0, radiusMm: 50 },
    ];
    const { h, path } = line(specs, { Unwind: 800 });
    run(h, 4);
    // One zone, both ends at 800: it simply holds the set point.
    expect(path.zones).toHaveLength(1);
    expect(path.zones[0].eps).toBeCloseTo(EPS_REF, 9);

    // And with NOTHING driven the whole path stands still — every slot 0, and
    // the span equation preserves the strain rather than inventing one.
    const idle = ribbonHarness(specs.map((r) => ({ ...r, driven: false })));
    const idlePath = idle.buildPath(TENSION);
    for (let i = 0; i < 120; i++) idle.step(DT);
    for (const zone of idlePath.zones) expect(zone.eps).toBeCloseTo(EPS_REF, 12);
  });
});

describe('the readout', () => {
  it('reports N/m, PLI, mode and state per zone plus the specific tenacity', () => {
    const { h, path } = machine();
    run(h, 1);
    const readout = path.tensionReadout;
    expect(readout.zones).toHaveLength(5);
    expect(readout.zones[4].nPerM).toBeCloseTo(100, 6);
    expect(readout.zones[4].pli).toBeCloseTo(100 / 175.1, 9);
    expect(readout.zones[4].mode).toBe('integrated');
    expect(readout.zones[4].state).toBe('inBand');
    // 100 N/m over 20 gsm.
    expect(readout.specificTenacityNmPerKg).toBeCloseTo(5000, 6);
  });
});
