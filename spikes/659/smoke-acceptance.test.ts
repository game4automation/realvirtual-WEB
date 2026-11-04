// plan-659 — the acceptance criterion of the viewer smoke test, under test.
//
// The bug being fixed was a criterion nobody could trust: `falls === 0` while
// the scene deliberately trips the robot once, so a green run reported red.
// The replacement must therefore prove two things, and a 60 s browser run can
// show neither on demand:
//
//   * it PASSES the reference run (3.6 m, 1 fall, 1 get-up, 0 dropped sim
//     time) — otherwise it is the old bug with new words;
//   * it FAILS each failure the obstacle work actually produced — a fall with
//     no get-up, wedged between two blocks, frozen in a tilted squat — and
//     does not fail a robot merely walking a curve.

import { describe, expect, it } from 'vitest';
import {
  evaluateAcceptance, stallAnalysis, MAX_STALL_SIM_S, STALL_RADIUS_M,
  // @ts-expect-error — plain .mjs beside this file, no types.
} from './smoke-acceptance.mjs';

/** The structural half of the verdict, healthy. */
const OK_EXTRA = {
  lazyLoad: { passed: true, requested: ['mujoco.wasm', 'ort-wasm-simd-threaded.wasm'] },
  registry: { allAddressable: true, joints: new Array(14) },
};

/** The measured reference run (phase2b-report.json, 2026-10-23). */
const REFERENCE_RUN = {
  simSeconds: 60.54,
  distanceM: 3.6022468471952784,
  falls: 1,
  recoveries: 1,
  finite: true,
  droppedSimTimeS: 0,
  policySteps: 3101,
  policyStalls: 0,
  nonFiniteActions: 0,
};

/** A straight walk at the reference pace: one sample per second. */
function walking(seconds: number, speed = 0.06): Array<Record<string, number | string>> {
  return Array.from({ length: seconds }, (_, i) => ({
    sim: i, x: i * speed, y: 0, gz: -0.999, policy: 'walking',
  }));
}

/** Standing still at one spot for `seconds`, starting at sim time `from`. */
function frozen(from: number, seconds: number, at: [number, number], gz = -0.71) {
  return Array.from({ length: seconds }, (_, i) => ({
    sim: from + i, x: at[0], y: at[1], gz, policy: 'walking',
  }));
}

const run = (over: Partial<typeof REFERENCE_RUN> = {}) => ({ ...REFERENCE_RUN, ...over });
const verdict = (r: object, samples: unknown[]) => evaluateAcceptance(r, samples, OK_EXTRA);
const failed = (r: object, samples: unknown[]): string[] => verdict(r, samples).acceptance.failed;

describe('viewer smoke acceptance', () => {
  it('passes the measured reference run — one fall, one get-up, 3.6 m', () => {
    const v = verdict(run(), walking(60));
    expect(v.acceptance.failed).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('still passes it when the robot never falls at all', () => {
    expect(failed(run({ falls: 0, recoveries: 0 }), walking(60))).toEqual([]);
  });

  it('fails a fall that is never recovered — the wedged case', () => {
    // Measured: 1 fall, 0 get-ups in 40 s, wedged between two close obstacles.
    const samples = [...walking(20), ...frozen(20, 20, [1.2, 0.3], -0.42)];
    const out = failed(run({ simSeconds: 40, falls: 1, recoveries: 0, distanceM: 1.2 }), samples);
    expect(out).toContain('every-fall-recovered');
    expect(out).toContain('never-stuck');
  });

  it('fails the tilted squat — upright enough to count as neither fallen nor recovered', () => {
    // Measured: projectedGravityZ = -0.71, above the -0.85 recovery threshold
    // and below the -0.5 fall threshold, so NO counter ever moves. Only the
    // motion stops, which is exactly what this check reads.
    const samples = [...walking(10), ...frozen(10, 40, [0.6, 0.0], -0.71)];
    const out = failed(run({ simSeconds: 50, falls: 0, recoveries: 0, distanceM: 0.6 }), samples);
    expect(out).toContain('never-stuck');
  });

  it('fails a robot that falls over and over', () => {
    expect(failed(run({ falls: 9, recoveries: 9 }), walking(60))).toContain('falls-capped');
  });

  it('does NOT fail a robot walking a curve back towards its start', () => {
    // `distanceM` is displacement from the start, so a curve makes it SHRINK
    // for seconds at a time (measured: 1.149 → 0.910 → 1.166 in one 20 s run).
    // The base is moving the whole time, which is why the detector reads the
    // base and not the displacement.
    const samples = Array.from({ length: 60 }, (_, i) => {
      const a = (i / 60) * Math.PI * 2;
      return { sim: i, x: Math.cos(a) * 0.6, y: Math.sin(a) * 0.6, gz: -0.999, policy: 'walking' };
    });
    const out = failed(run({ distanceM: 1.2 }), samples);
    expect(out).not.toContain('never-stuck');
  });

  it('fails dropped sim time and non-finite actions outright', () => {
    expect(failed(run({ droppedSimTimeS: 0.4 }), walking(60))).toContain('no-dropped-sim-time');
    expect(failed(run({ nonFiniteActions: 1 }), walking(60))).toContain('no-non-finite-actions');
    expect(failed(run({ finite: false }), walking(60))).toContain('state-finite');
  });

  it('tolerates a few slow inferences but not a starved policy', () => {
    // A stall costs no SIM time in `parity` mode; it is a wall-clock symptom,
    // and the machine these runs happen on is not quiet.
    expect(failed(run({ policyStalls: 3 }), walking(60))).not.toContain('policy-keeps-up');
    expect(failed(run({ policyStalls: 40 }), walking(60))).toContain('policy-keeps-up');
  });

  it('fails a structurally broken run whatever the robot did', () => {
    const broken = evaluateAcceptance(run(), walking(60), {
      lazyLoad: { passed: false, requested: ['ort-wasm-simd-threaded.jsep.wasm'] },
      registry: { allAddressable: false, joints: new Array(2) },
    });
    expect(broken.acceptance.failed).toEqual(['lazy-load', 'joints-addressable']);
  });

  describe('stallAnalysis', () => {
    it('reports the longest confined stretch and where it was', () => {
      const s = stallAnalysis([...walking(5), ...frozen(5, 12, [0.24, 0.0]), ...walking(5)]);
      expect(s.longestStallSimS).toBeGreaterThanOrEqual(11);
      expect(s.at.gz).toBeCloseTo(-0.71, 5);
    });

    it('stays far under the limit for a walk that never pauses', () => {
      // Not 0: at the reference pace of 0.06 m/s the robot needs ~2.5 s to
      // leave a 15 cm circle, so a healthy walk always carries a couple of
      // seconds of "confinement". That is the baseline the 15 s limit sits
      // above, and it is why the limit is not 3.
      const walk = stallAnalysis(walking(60)).longestStallSimS;
      expect(walk).toBeLessThan(4);
      expect(walk * 3).toBeLessThan(MAX_STALL_SIM_S);
    });

    it('allows a pause shorter than the limit (a fall plus getting up)', () => {
      const s = stallAnalysis([...walking(10), ...frozen(10, 6, [0.54, 0.0], -0.9), ...walking(10)]);
      expect(s.longestStallSimS).toBeLessThanOrEqual(MAX_STALL_SIM_S);
      expect(STALL_RADIUS_M).toBeGreaterThan(0);
    });
  });
});
