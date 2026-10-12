// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ribbon-tension-math.test.ts — the scalar span model (plan-471 Phase 1, §9).
 *
 * The steady state is the oracle of the whole feature: every pipeline assertion
 * further up eventually reduces to "the zone reaches `strainSteadyState`". So it
 * is pinned here against the closed form FIRST, and the integrator is then shown
 * to converge to it rather than to something near it.
 */

import { describe, it, expect } from 'vitest';
import {
  bandDeviation,
  breakStrain,
  classify,
  MIN_ZONE_LENGTH_MM,
  N_PER_M_PER_PLI,
  pliFromNPerM,
  specificTenacity,
  specificTension,
  strainFromTension,
  strainSteadyState,
  strainStepImplicit,
  tensionFromDancerLoad,
  tensionFromStrain,
  type RibbonStrainThresholds,
} from '../src/core/engine/ribbon/ribbon-tension-math';

/** The demo web of plan-471 §Phase 6: K = 10 N/mm, w = 500 mm, T_ref = 50 N. */
const DEMO: RibbonStrainThresholds = {
  minStrain: 0,
  maxStrain: 0.02,
  breakStrain: breakStrain(35, 10),
  refStrain: 0.01,
  tolerance: 0.1,
};

describe('strainSteadyState', () => {
  it('is the closed form of the span equation', () => {
    // The worked example from the plan: eps_in = 0, v_A = 1000, v_B = 1010.
    expect(strainSteadyState(0, 1000, 1010)).toBeCloseTo(10 / 1010, 12);
    expect(strainSteadyState(0, 1000, 1010)).toBeCloseTo(0.00990099009900990, 9);
  });

  it('carries the entry strain through when both speeds are equal', () => {
    // v_A = v_B: nothing is stretched, the zone simply passes eps_in on.
    expect(strainSteadyState(0.01, 800, 800)).toBeCloseTo(0.01, 12);
  });

  it('is negative — slack — when the exit runs slower than the entry', () => {
    // The demo's sag case: eps_in = 1 %, v_A = 800, v_B = 784.
    expect(strainSteadyState(0.01, 800, 784)).toBeCloseTo((784 - 800 + 0.01 * 800) / 784, 12);
    expect(strainSteadyState(0.01, 800, 784)).toBeLessThan(0);
  });

  it('is undefined for a stopped or reversing exit, and for non-finite input', () => {
    expect(strainSteadyState(0, 1000, 0)).toBeNaN();
    expect(strainSteadyState(0, 1000, -10)).toBeNaN();
    expect(strainSteadyState(Number.NaN, 1000, 1010)).toBeNaN();
  });
});

describe('strainStepImplicit', () => {
  it('converges to strainSteadyState', () => {
    const vA = 800;
    const vB = 816;
    const L = 800;
    const target = strainSteadyState(0.01, vA, vB);
    let eps = 0.01;
    // L / v_B ~ 1 s, so 8 s of 60 Hz ticks leaves e^-8 of the initial error —
    // 1e-5 absolute, which is the convergence budget the plan states.
    for (let i = 0; i < 8 * 60; i++) eps = strainStepImplicit(eps, 0.01, vA, vB, L, 1 / 60);
    expect(Math.abs(eps - target)).toBeLessThan(1e-5);
  });

  it('is stable at a step the explicit form would explode on', () => {
    // dt * v_B / L = 0.02 * 1000 / 1 = 20, far past the explicit limit of 2.
    // q = 1 / (1 + 20) = 1/21: the error shrinks monotonically instead.
    const target = strainSteadyState(0, 0, 1000);
    let eps = 0;
    let previousError = Math.abs(eps - target);
    for (let i = 0; i < 50; i++) {
      eps = strainStepImplicit(eps, 0, 0, 1000, 1, 0.02);
      expect(Number.isFinite(eps)).toBe(true);
      const error = Math.abs(eps - target);
      expect(error).toBeLessThanOrEqual(previousError);
      previousError = error;
    }
    expect(eps).toBeCloseTo(target, 9);
  });

  it('applies exactly one implicit Euler step', () => {
    const a = 0.5 / 400;
    const expected = (0.004 + a * (1010 - 1000 + 0.002 * 1000)) / (1 + a * 1010);
    expect(strainStepImplicit(0.004, 0.002, 1000, 1010, 400, 0.5)).toBeCloseTo(expected, 15);
  });

  it('leaves the strain untouched on a paused frame', () => {
    expect(strainStepImplicit(0.013, 0, 1000, 1010, 500, 0)).toBe(0.013);
    expect(strainStepImplicit(0.013, 0, 1000, 1010, 500, -1)).toBe(0.013);
  });

  it('freezes a backwards-running zone instead of integrating it', () => {
    expect(strainStepImplicit(0.013, 0, 1000, -10, 500, 1 / 60)).toBe(0.013);
  });

  it('leaves a standing web at the strain it stopped with', () => {
    // Nothing enters and nothing leaves the control volume — a deliberate
    // state-preservation rule, not an oversight (plan-471 §Integration).
    expect(strainStepImplicit(0.017, 0.01, 0, 0, 500, 1 / 60)).toBe(0.017);
  });

  it('ignores non-finite inputs and a non-positive length', () => {
    expect(strainStepImplicit(0.01, Number.NaN, 800, 800, 500, 1 / 60)).toBe(0.01);
    expect(strainStepImplicit(0.01, 0, Number.POSITIVE_INFINITY, 800, 500, 1 / 60)).toBe(0.01);
    expect(strainStepImplicit(0.01, 0, 800, 810, 0, 1 / 60)).toBe(0.01);
    expect(strainStepImplicit(0.01, 0, 800, 810, -5, 1 / 60)).toBe(0.01);
  });
});

describe('tension and strain', () => {
  it('is T = K * w * eps for a taut web', () => {
    expect(tensionFromStrain(10, 500, 0.01)).toBeCloseTo(50, 12);
  });

  it('carries no tension when the web is slack — a rope does not push', () => {
    expect(tensionFromStrain(10, 500, -0.01)).toBe(0);
    expect(tensionFromStrain(10, 500, 0)).toBe(0);
  });

  it('is 0 when tension is switched off (stiffness <= 0)', () => {
    expect(tensionFromStrain(0, 500, 0.01)).toBe(0);
    expect(tensionFromStrain(-1, 500, 0.01)).toBe(0);
  });

  it('inverts through zero, so a set point may be negative', () => {
    expect(strainFromTension(50, 10, 500)).toBeCloseTo(0.01, 12);
    expect(strainFromTension(-50, 10, 500)).toBeCloseTo(-0.01, 12);
    expect(strainFromTension(50, 0, 500)).toBe(0);
  });

  it('splits a dancer load over its strands', () => {
    expect(tensionFromDancerLoad(100, 2)).toBe(50);
    expect(tensionFromDancerLoad(100, 1)).toBe(100);
    // A load of 0 is the default: a purely kinematic dancer, as before plan-471.
    expect(tensionFromDancerLoad(0, 2)).toBe(0);
    expect(tensionFromDancerLoad(-5, 2)).toBe(0);
    // Strands below 1 is a mis-authored dancer, not a divide-by-zero.
    expect(tensionFromDancerLoad(100, 0)).toBe(100);
  });

  it('derives the break strain from the MD strip force per 50 mm', () => {
    // 35 N / 50 mm at K = 10 N/mm -> 0.7 N/mm / 10 = 7 % strain.
    expect(breakStrain(35, 10)).toBeCloseTo(0.07, 12);
    expect(breakStrain(0, 10)).toBe(Number.POSITIVE_INFINITY);
    expect(breakStrain(35, 0)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('unit conversions', () => {
  it('reports tension per unit width', () => {
    expect(specificTension(50, 500)).toBeCloseTo(100, 12);
    expect(specificTension(50, 0)).toBe(0);
  });

  it('converts N/m to PLI', () => {
    expect(pliFromNPerM(N_PER_M_PER_PLI)).toBeCloseTo(1, 12);
    expect(pliFromNPerM(100)).toBeCloseTo(100 / 175.1, 12);
  });

  it('normalises tension by basis weight into a specific tenacity', () => {
    // 100 N/m on a 20 gsm web = 100 / 0.02 = 5000 N*m/kg.
    expect(specificTenacity(100, 20)).toBeCloseTo(5000, 9);
    expect(specificTenacity(100, 0)).toBe(0);
  });
});

describe('classify', () => {
  it('names every state of the demo web at its boundaries', () => {
    expect(classify(-0.001, DEMO)).toBe('slack');
    // The SLACK threshold is exclusive: exactly at MinStrain the web is not slack.
    expect(classify(0, DEMO)).toBe('below');
    expect(classify(0.0089, DEMO)).toBe('below');
    // The band edges are INCLUSIVE (plan-471: "dazwischen, Grenzen inklusive").
    // They are probed as the COMPUTED edges: `0.01 * 0.9` is not the double
    // `0.009`, and a literal here would test float representation, not the rule.
    const lo = DEMO.refStrain * (1 - DEMO.tolerance);
    const hi = DEMO.refStrain * (1 + DEMO.tolerance);
    expect(classify(lo, DEMO)).toBe('inBand');
    expect(classify(0.01, DEMO)).toBe('inBand');
    expect(classify(hi, DEMO)).toBe('inBand');
    expect(classify(0.0111, DEMO)).toBe('above');
    expect(classify(0.02, DEMO)).toBe('above');
    expect(classify(0.0201, DEMO)).toBe('over');
    expect(classify(0.0699, DEMO)).toBe('over');
    // eps_break = 0.07 for this web, and it is INCLUSIVE.
    expect(classify(0.07, DEMO)).toBe('broken');
    expect(classify(0.5, DEMO)).toBe('broken');
  });

  it('lets broken outrank over, and over outrank slack', () => {
    // A pathological configuration where several conditions hold at once.
    const t: RibbonStrainThresholds = {
      minStrain: 0.5, maxStrain: 0.01, breakStrain: 0.02, refStrain: 0.01, tolerance: 0.1,
    };
    expect(classify(0.03, t)).toBe('broken');
    expect(classify(0.015, t)).toBe('over');
    expect(classify(0.005, t)).toBe('slack');
  });

  it('never invents an alarm out of a NaN', () => {
    expect(classify(Number.NaN, DEMO)).toBe('inBand');
  });

  it('leaves breaking disabled when no strength was quoted', () => {
    const t = { ...DEMO, breakStrain: Number.POSITIVE_INFINITY };
    expect(classify(1e6, t)).toBe('over');
  });
});

describe('bandDeviation', () => {
  it('is exactly 0 everywhere inside the band — the good web is not coloured', () => {
    // The computed edges, for the same reason `classify` probes them (above).
    expect(bandDeviation(DEMO.refStrain * (1 - DEMO.tolerance), DEMO)).toBe(0);
    expect(bandDeviation(0.01, DEMO)).toBe(0);
    expect(bandDeviation(DEMO.refStrain * (1 + DEMO.tolerance), DEMO)).toBe(0);
  });

  it('grows continuously from the band edge to the alarm threshold', () => {
    // Below: the edge is 0.009, MinStrain is 0, so the span is 0.009.
    expect(bandDeviation(DEMO.refStrain * (1 - DEMO.tolerance), DEMO)).toBe(0);
    expect(bandDeviation(0.0045, DEMO)).toBeCloseTo(0.5, 12);
    expect(bandDeviation(0, DEMO)).toBeCloseTo(1, 12);
    // Above: the edge is 0.011, MaxStrain is 0.02, so the span is 0.009.
    expect(bandDeviation(0.0155, DEMO)).toBeCloseTo(0.5, 12);
    expect(bandDeviation(0.02, DEMO)).toBeCloseTo(1, 12);
  });

  it('saturates rather than running past 1', () => {
    expect(bandDeviation(-1, DEMO)).toBe(1);
    expect(bandDeviation(1, DEMO)).toBe(1);
  });

  it('is monotone across the whole below-band range', () => {
    let previous = -1;
    for (let eps = 0.009; eps >= 0; eps -= 0.0005) {
      const d = bandDeviation(eps, DEMO);
      expect(d).toBeGreaterThanOrEqual(previous);
      previous = d;
    }
  });

  it('falls back to full saturation when a band has no room', () => {
    const t: RibbonStrainThresholds = {
      minStrain: 0.01, maxStrain: 0.01, breakStrain: 1, refStrain: 0.01, tolerance: 0,
    };
    expect(bandDeviation(0.009, t)).toBe(1);
    expect(bandDeviation(0.011, t)).toBe(1);
  });
});

describe('constants', () => {
  it('keeps the short-zone threshold at one millimetre', () => {
    expect(MIN_ZONE_LENGTH_MM).toBe(1);
  });
});
