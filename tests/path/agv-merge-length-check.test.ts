// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-595 §9.11 (R3-2, finding #194) — the merge-entry length check.
 *
 * A vehicle waiting for a merge zone stops with its front STOP_MARGIN before the
 * zone run on its branch. If that run (`pre`) is shorter than the bodies need,
 * a body rooted on another branch or on the merge piece reaches the waiting one.
 * `findShortMergeEntries` checks every incoming branch (symmetric) by sampling;
 * it is geometric and direction-independent.
 * - Ring with stubs: pre = 1 m fails for forklift bodies, pre = 3 m passes; a
 *   small cart passes where the forklift fails (body-dependent).
 * - An oblique (45°) and a CURVED (arc) side branch: both branches are checked.
 * - Enforced for stub manoeuvres: a reverse task onto a short entry is rejected
 *   BEFORE the approach (the vehicle does not start, Problems entry); a long
 *   entry is accepted.
 * - Forward only: a warning (Problems), no behaviour change — and the plan-558
 *   hazard it reports is real: with pre = 1 m a vehicle leaving the stub FORWARD
 *   overlaps the lane vehicle waiting at the entry (SAT oracle).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Vector3 } from 'three';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import {
  findShortMergeEntries, isZonedMerge, setReverseGateOpen, type MergeCheckCounts,
} from '../../src/core/engine/rv-movement-authority';
import type { RVPath } from '../../src/core/engine/rv-path';
import { getProblems, clearAllProblems } from '../../src/core/hmi/problems-store';
import { getMergeEntryCheckStats, runMergeEntryCheck } from '../../src/behaviors/Agv';
import { clearShared, makeHost, makeAgvRoot, bindContinuous } from '../helpers/agv-harness';
import { stubLayout, makeStubWorld, forkCfg, carCfg, FORK, FORK_MESH, CAR, frameOverlap } from '../helpers/agv-stub-world';

beforeEach(() => { clearShared(); clearAllProblems(); setReverseGateOpen(true); });
afterEach(() => setReverseGateOpen(true));

/** Quarter arc of radius r ending at `j` with tangent +x, coming from −z (orientation found numerically). */
function arcInto(j: Vector3, r: number): Record<string, unknown> {
  for (const startAngle of [0, 90, 180, 270]) {
    for (const clockwise of [false, true]) {
      for (const center of [[j.x, 0, j.z - r], [j.x, 0, j.z + r]]) {
        const seg = { kind: 'arc', center, radius: r, startAngle, degrees: 90, clockwise, plane: 'XZ' };
        const p = parsePathExtras({ type: 'Path', version: 1, id: 'probe', segments: [seg] }, 'probe');
        if (!p) continue;
        const start = p.getAbsPosition(0, new Vector3());
        if (p.getAbsPosition(p.length, new Vector3()).distanceTo(j) < 1e-6 && start.z < j.z - 1e-6
          && p.getAbsDirection(p.length, new Vector3()).distanceTo(new Vector3(1, 0, 0)) < 1e-6) return seg;
      }
    }
  }
  throw new Error('no arc orientation ends at the junction heading +x');
}

const codes = (code: string): string[] => getProblems().filter((p) => p.code === code).map((p) => p.id);

describe('plan-595 9.11 — merge entry length (R3-2)', () => {
  it('ring with stubs: pre = 1 m fails for forklifts, pre = 3 m passes; a small cart passes at 1 m', () => {
    stubLayout({ preLen: 1 });
    const net = getDefaultPathNetwork();
    const short = findShortMergeEntries(net.all(), FORK);
    expect(short.map((m) => m.mergePathId)).toContain('Turn2');
    expect(short.some((m) => m.mergePathId === 'Turn2' && m.branchId === 'Pre2' && Math.abs(m.pre - 1) < 1e-9)).toBe(true);
    for (const m of short) expect(m.penetration).toBeGreaterThan(0);
    clearShared();
    stubLayout({ preLen: 3 });
    expect(findShortMergeEntries(getDefaultPathNetwork().all(), FORK)).toEqual([]);
    clearShared();
    stubLayout({ preLen: 1 });
    const small = { front: 0.3, rear: 0.3, width: 0.4 };
    expect(findShortMergeEntries(getDefaultPathNetwork().all(), small)).toEqual([]);
  });

  it('oblique and curved side branches: both incoming branches are checked', () => {
    for (const curved of [false, true]) {
      for (const pre of [0.5, 4]) {
        clearShared();
        const net = getDefaultPathNetwork();
        const add = (raw: Record<string, unknown>): void => {
          net.register(parsePathExtras({ type: 'Path', version: 1, closed: false, align: [0, 1, 0], ...raw }, raw.id as string)!);
        };
        add({ id: 'Lane', segments: [{ kind: 'line', from: [0, 0, 0], to: [10 - pre, 0, 0] }], successors: ['Pre'] });
        add({ id: 'Pre', segments: [{ kind: 'line', from: [10 - pre, 0, 0], to: [10, 0, 0] }], successors: ['T'], zone: 'M', zoneCapacity: 1 });
        add({ id: 'T', segments: [{ kind: 'line', from: [10, 0, 0], to: [16, 0, 0] }], zone: 'M', zoneCapacity: 1 });
        // Side branch into the junction (10, 0, 0): oblique 45° line, or a quarter arc ending tangent to +x.
        const d = pre / Math.SQRT2;
        const side = curved ? arcInto(new Vector3(10, 0, 0), pre) : { kind: 'line', from: [10 - d, 0, -d], to: [10, 0, 0] };
        add({ id: 'Side', segments: [side], successors: ['T'], zone: 'M', zoneCapacity: 1 });
        net.resolveGraph();
        const s0 = parsePathExtras({ type: 'Path', version: 1, id: 'probe', segments: [side] }, 'probe')!;
        const a = s0.getAbsPosition(0, new Vector3()), ad = s0.getAbsDirection(0, new Vector3());
        add({ id: 'Feed', segments: [{ kind: 'line', from: a.clone().addScaledVector(ad, -6).toArray(), to: a.toArray() }], successors: ['Side'] });
        net.resolveGraph();
        const sidePath = net.get('Side')!;
        // The side branch really ends at the junction.
        expect(sidePath.getAbsPosition(sidePath.length, new Vector3()).distanceTo(new Vector3(10, 0, 0))).toBeLessThan(1e-3);
        const branchesFor = (body: typeof FORK): string[] =>
          findShortMergeEntries(net.all(), body).filter((m) => m.mergePathId === 'T').map((m) => m.branchId).sort();
        const WIDE = { front: FORK.front, rear: FORK.rear, width: 1.4 };
        if (pre >= 1) {
          expect(branchesFor(FORK)).toEqual([]);   // both sides pass with a long entry
          expect(branchesFor(WIDE)).toEqual([]);
        } else if (!curved) {
          expect(branchesFor(FORK)).toEqual(['Pre', 'Side']); // oblique: both waiting sides fail
        } else {
          // Curved: the side waiter stands on the feed parallel to the lane and clears it by 5 cm
          // with a 1.0 m body (independently computed) — only the lane side fails …
          expect(branchesFor(FORK)).toEqual(['Pre']);
          expect(branchesFor(WIDE)).toEqual(['Pre', 'Side']); // … a 1.4 m wide body fails on both sides
        }
      }
    }
  });

  it('animated: a reverse task onto a short entry is rejected before the approach; a long one is accepted', () => {
    stubLayout({ preLen: 1 });
    let w = makeStubWorld('animated', [{ name: 'F', cfg: forkCfg('L0', 3500), mesh: FORK_MESH, body: FORK }], 60);
    const fleet = getDefaultAgvFleet();
    w.hostOf().signalStore!.set('F.Agv.Run', true);
    const before = { ...getMergeEntryCheckStats().last };
    expect(before.branches).toBeGreaterThan(0);
    expect(getMergeEntryCheckStats().stubRejections).toBe(0);
    fleet.get('F')!.assign({ destination: 'S2', approach: 'reverse' });
    expect(fleet.get('F')!.task).toBeNull();                          // not started …
    expect(codes('agv-reverse-stub-refused').length).toBe(1);         // … and reported
    // plan-618 9.5: the rejection is counted; the [turn] check passes no counts — `last` unchanged.
    expect(getMergeEntryCheckStats().stubRejections).toBe(1);
    expect(getMergeEntryCheckStats().last.merges).toBe(before.merges);
    expect(getMergeEntryCheckStats().last.branches).toBe(before.branches);
    let reversed = false;
    for (let f = 0; f < 60 * 30; f++) { w.step(); if (w.mb.planDirOf('F') === -1) reversed = true; }
    expect(reversed).toBe(false);
    w.dispose();
    clearShared(); clearAllProblems();
    stubLayout({ preLen: 3 });
    w = makeStubWorld('animated', [{ name: 'F', cfg: forkCfg('L0', 3500), mesh: FORK_MESH, body: FORK }], 120);
    getDefaultAgvFleet().get('F')!.assign({ destination: 'S2', approach: 'reverse' });
    expect(getDefaultAgvFleet().get('F')!.task).not.toBeNull();
    expect(codes('agv-reverse-stub-refused')).toEqual([]);
    reversed = false;
    for (let f = 0; f < 60 * 60 && !reversed; f++) { w.step(); if (w.mb.planDirOf('F') === -1) reversed = true; }
    expect(reversed).toBe(true);
    w.dispose();
  }, 120000);

  it('continuous, forward only: pre = 1 m is reported as a warning and the forward exit really overlaps the waiting lane vehicle', () => {
    stubLayout({ preLen: 1 });
    // F starts INSIDE the stub and leaves it forward; C on the lane arrives at the short entry meanwhile.
    const w = makeStubWorld('continuous', [
      { name: 'F', cfg: forkCfg('S2', 500, { TargetSpeed: 600 }), mesh: FORK_MESH, body: FORK },
      { name: 'C', cfg: carCfg('L1', 0, { TargetSpeed: 1000 }), body: CAR },
    ], 60);
    expect(codes('agv-merge-entry-too-short').some((id) => id.includes('Turn2'))).toBe(true);
    let overlap = 0;
    for (let f = 0; f < 60 * 30; f++) { w.step(); if (frameOverlap(w).hit) overlap++; }
    expect(w.mb.planDirOf('F')).toBe(1);   // forward only — no behaviour change by the check
    expect(overlap).toBeGreaterThan(0);    // the hazard the warning names (pre-existing, plan-558)
    w.dispose();
  }, 120000);
});

/**
 * plan-618 — the check is countable: "no short entry" is distinguishable from
 * "nothing was checked". Counters only (no wall clock), behaviour unchanged.
 */
describe('plan-618 — merge-entry check counters and statistics', () => {
  const SHORT = 'agv-merge-entry-too-short';
  const SKIPPED = 'agv-merge-check-skipped';
  const zonedMerges = (): number => [...getDefaultPathNetwork().all()].filter(isZonedMerge).length;
  const paths = (): RVPath[] => [...getDefaultPathNetwork().all()];
  const stats = getMergeEntryCheckStats;

  it('9.1 ring layout: counts cover every zoned merge and its branches', () => {
    stubLayout({ preLen: 3 });
    const counts: MergeCheckCounts = { merges: 0, branches: 0 };
    expect(findShortMergeEntries(getDefaultPathNetwork().all(), FORK, counts)).toEqual([]);
    expect(counts.merges).toBeGreaterThan(0);
    expect(counts.merges).toBe(zonedMerges());
    expect(counts.branches).toBeGreaterThanOrEqual(2 * counts.merges);
  });

  it('9.2 the check runs for explicit, mesh and fallback bodies — continuous and DES', () => {
    const sources = [
      { name: 'explicit', cfg: forkCfg('L0', 3500, { VehicleLength: 2400, VehicleWidth: 1000 }), mesh: undefined,
        env: { front: 1.2, rear: 1.2, width: 1.0 } },
      { name: 'mesh', cfg: forkCfg('L0', 3500), mesh: FORK_MESH, env: FORK },
      { name: 'fallback', cfg: forkCfg('L0', 3500), mesh: undefined, env: { front: 0.5, rear: 0.5, width: 0.6 } },
    ];
    for (const mode of ['continuous', 'animated'] as const) {
      for (const src of sources) {
        clearShared(); clearAllProblems();
        stubLayout({ preLen: 1 });
        const w = makeStubWorld(mode, [{ name: 'F', cfg: src.cfg, mesh: src.mesh, body: src.env }], 60);
        const s = stats();
        const cell = `${mode}/${src.name}`;
        expect(s.last.skipped, cell).toBeNull();
        expect(s.last.branches, cell).toBeGreaterThan(0);
        expect(s.last.merges, cell).toBe(zonedMerges());
        // one check per successful setup: the vehicle plus the stub world's parked clock vehicles
        expect(s.checks, cell).toBe(Object.keys(w.roots).length);
        expect(s.last.envelope.front, cell).toBeCloseTo(src.env.front, 6);
        expect(s.last.envelope.rear, cell).toBeCloseTo(src.env.rear, 6);
        expect(s.last.envelope.width, cell).toBeCloseTo(src.env.width, 6);
        expect(s.last.shortEntries, cell).toBe(codes(SHORT).length);
        expect(codes(SKIPPED), cell).toEqual([]);
        w.dispose();
      }
    }
  }, 120000);

  it('9.3 empty envelope is reported, a missing body is named (defensive branches)', () => {
    stubLayout({ preLen: 1 });
    runMergeEntryCheck(paths(), ['A'], new Map());
    let last = stats().last;
    expect(last.skipped).toBe('empty-envelope');
    expect(last.merges).toBeGreaterThan(0);
    expect(last.merges).toBe(zonedMerges());
    expect(last.branches).toBe(0);
    expect(last.bodiesMissing).toBe(1);
    expect(codes(SKIPPED).length).toBe(1);
    expect(codes(SHORT)).toEqual([]);

    runMergeEntryCheck(paths(), ['A', 'B'], new Map([['A', FORK]]));
    last = stats().last;
    expect(last.skipped).toBeNull();
    expect(last.bodiesMissing).toBe(1);
    expect(last.shortEntries).toBeGreaterThan(0);
    const shorts = getProblems().filter((p) => p.code === SHORT);
    expect(shorts.length).toBe(last.shortEntries);
    for (const p of shorts) expect(p.detail).toContain("'B'");
    expect(codes(SKIPPED)).toEqual([]);
  });

  it('9.4 state changes re-initialise `last` and switch the codes; existing codes unchanged', () => {
    stubLayout({ preLen: 1 });
    const bodies = new Map([['A', FORK]]);
    runMergeEntryCheck(paths(), ['A'], bodies);
    const s1 = stats().last;
    expect(s1.shortEntries).toBeGreaterThan(0);
    expect(codes(SHORT).length).toBe(s1.shortEntries);
    expect(codes(SKIPPED)).toEqual([]);

    runMergeEntryCheck(paths(), ['A'], new Map());
    const s2 = stats().last;
    expect(s2).not.toBe(s1);
    expect(s2).toEqual({ merges: s1.merges, branches: 0, shortEntries: 0, envelope: { front: 0, rear: 0, width: 0 },
      skipped: 'empty-envelope', bodiesMissing: 1 });
    expect(codes(SHORT)).toEqual([]);
    expect(codes(SKIPPED).length).toBe(1);

    runMergeEntryCheck(paths(), ['A'], bodies);
    const s3 = stats().last;
    expect(s3).toEqual(s1);
    expect(codes(SHORT).length).toBe(s1.shortEntries);
    expect(codes(SKIPPED)).toEqual([]);
    expect(stats().checks).toBe(3);

    // An unzoned merge next to a zoned, too short one — both codes as before the plan.
    clearShared(); clearAllProblems();
    const net = getDefaultPathNetwork();
    const add = (raw: Record<string, unknown>): void => {
      net.register(parsePathExtras({ type: 'Path', version: 1, closed: false, align: [0, 1, 0], ...raw }, raw.id as string)!);
    };
    add({ id: 'Lane', segments: [{ kind: 'line', from: [0, 0, 0], to: [9.5, 0, 0] }], successors: ['Pre'] });
    add({ id: 'Pre', segments: [{ kind: 'line', from: [9.5, 0, 0], to: [10, 0, 0] }], successors: ['T'], zone: 'M', zoneCapacity: 1 });
    add({ id: 'Side', segments: [{ kind: 'line', from: [9.6, 0, -0.4], to: [10, 0, 0] }], successors: ['T'], zone: 'M', zoneCapacity: 1 });
    add({ id: 'T', segments: [{ kind: 'line', from: [10, 0, 0], to: [16, 0, 0] }], zone: 'M', zoneCapacity: 1 });
    add({ id: 'X1', segments: [{ kind: 'line', from: [0, 0, 20], to: [10, 0, 20] }], successors: ['Y'] });
    add({ id: 'X2', segments: [{ kind: 'line', from: [5, 0, 25], to: [10, 0, 20] }], successors: ['Y'] });
    add({ id: 'Y', segments: [{ kind: 'line', from: [10, 0, 20], to: [16, 0, 20] }] });
    net.resolveGraph();
    const handle = bindContinuous(makeAgvRoot('F', forkCfg('Lane', 0), FORK_MESH), makeHost());
    expect(codes('agv-merge-without-zone')).toEqual(['agv-merge-without-zone:Y']);
    expect(codes(SHORT).some((id) => id.startsWith(`${SHORT}:T:`))).toBe(true);
    expect(stats().last.merges).toBe(1);
    // Without vehicles: 'no-vehicles', no short / skipped entry.
    runMergeEntryCheck(paths(), [], new Map());
    expect(stats().last.skipped).toBe('no-vehicles');
    expect(codes(SHORT)).toEqual([]);
    expect(codes(SKIPPED)).toEqual([]);
    expect(codes('agv-merge-without-zone')).toEqual(['agv-merge-without-zone:Y']);
    handle.dispose();
  });

  it('9.7 the last teardown resets `last` and clears the codes', () => {
    stubLayout({ preLen: 1 });
    const host = makeHost();
    const a = bindContinuous(makeAgvRoot('F1', forkCfg('L0', 0), FORK_MESH), host);
    const b = bindContinuous(makeAgvRoot('F2', forkCfg('L1', 0), FORK_MESH), host);
    expect(stats().checks).toBe(2);
    expect(codes(SHORT).length).toBeGreaterThan(0);
    a.dispose();
    expect(stats().last.skipped).not.toBe('no-vehicles');
    expect(codes(SHORT).length).toBeGreaterThan(0);
    b.dispose();
    expect(stats().last).toEqual({ merges: 0, branches: 0, shortEntries: 0, envelope: { front: 0, rear: 0, width: 0 },
      skipped: 'no-vehicles', bodiesMissing: 0 });
    expect(codes(SHORT)).toEqual([]);
    expect(codes(SKIPPED)).toEqual([]);
    expect(stats().checks).toBe(2);
  });

  it('9.8 a generator input is counted like the array', () => {
    stubLayout({ preLen: 1 });
    const net = getDefaultPathNetwork();
    const ca: MergeCheckCounts = { merges: 0, branches: 0 };
    const cg: MergeCheckCounts = { merges: 0, branches: 0 };
    const fromArray = findShortMergeEntries(paths(), FORK, ca);
    function* gen(): Generator<RVPath> { yield* net.all(); }
    const fromGen = findShortMergeEntries(gen(), FORK, cg);
    expect(cg.branches).toBeGreaterThan(0);
    expect(cg).toEqual(ca);
    expect(fromGen).toEqual(fromArray);
  });
});
