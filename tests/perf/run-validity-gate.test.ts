// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-473 §9.1 — the run-validity gate (F4).
 *
 * The gate replaces `stationary`, which graded the source against the rate the
 * configuration ASKS for (`lanes / sourceIntervalS`) while the line physically
 * tops out near half of it, and therefore reported FAIL in every single cell.
 * The four conditions of §1.3 are tested individually and in combination; the
 * case that matters most is the one the old criterion could not express at all:
 * a line standing completely still is INVALID, not a perfect steady state.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateRunValidity,
  VALIDITY_OCCUPANCY_TOL,
  VALIDITY_RATE_TOL,
  VALIDITY_LOST_SIM_TOL,
  type RunValidityInput,
} from '../../src/plugins/demo/perf-test-plugin';

/** A healthy, capped run: occupancy on target, source at the achievable rate. */
function healthy(over: Partial<RunValidityInput> = {}): RunValidityInput {
  return {
    targetMUs: 2400,
    liveMUs: 2400,
    spawnRate: 54,
    sinkRate: 54,
    referenceSpawnRate: 54,
    lostSimSeconds: 0.5,
    windowS: 300,
    ...over,
  };
}

const check = (r: ReturnType<typeof evaluateRunValidity>, name: string) =>
  r.checks.find((c) => c.name === name);

describe('plan-473 F4 run-validity gate', () => {
  it('accepts a capped but healthy run (the case the old criterion always failed)', () => {
    const r = evaluateRunValidity(healthy());
    expect(r.valid).toBe(true);
    expect(r.checks).toHaveLength(4);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    expect(r.referenceMissing).toBe(false);
  });

  it('rejects a standstill at target occupancy (source = sink = 0)', () => {
    const r = evaluateRunValidity(healthy({ spawnRate: 0, sinkRate: 0 }));
    expect(r.valid).toBe(false);
    expect(check(r, 'occupancy')?.ok).toBe(true);       // the belt IS full
    expect(check(r, 'sourceThroughput')?.ok).toBe(false); // …and dead
    expect(check(r, 'sinkThroughput')?.ok).toBe(false);
    expect(r.reason).toContain('sourceThroughput FAIL');
  });

  it('rejects occupancy drift beyond ±10 %', () => {
    const hi = Math.ceil(2400 * (1 + VALIDITY_OCCUPANCY_TOL)) + 1;
    const lo = Math.floor(2400 * (1 - VALIDITY_OCCUPANCY_TOL)) - 1;
    expect(evaluateRunValidity(healthy({ liveMUs: hi })).valid).toBe(false);
    expect(evaluateRunValidity(healthy({ liveMUs: lo })).valid).toBe(false);
    // …and accepts the edges of the band.
    expect(evaluateRunValidity(healthy({ liveMUs: 2400 * (1 + VALIDITY_OCCUPANCY_TOL) })).valid).toBe(true);
    expect(evaluateRunValidity(healthy({ liveMUs: 2400 * (1 - VALIDITY_OCCUPANCY_TOL) })).valid).toBe(true);
  });

  it('grades the source against the REFERENCE rate, not the configured rate', () => {
    // 54/s measured against a 54/s reference is fine even though the
    // configuration asks for 100/s — that is the whole point of the repair.
    expect(evaluateRunValidity(healthy({ spawnRate: 54, referenceSpawnRate: 54 })).valid).toBe(true);
    // Just inside / just outside the ±15 % band. (Not ON the edge: 54*0.85
    // is not representable exactly, so an exact-edge assertion would test
    // binary floating point, not the gate.)
    const edge = 54 * (1 - VALIDITY_RATE_TOL) + 0.01;
    expect(check(evaluateRunValidity(healthy({ spawnRate: edge, sinkRate: edge })), 'sourceThroughput')?.ok).toBe(true);
    const out = 54 * (1 - VALIDITY_RATE_TOL) - 0.1;
    expect(check(evaluateRunValidity(healthy({ spawnRate: out, sinkRate: out })), 'sourceThroughput')?.ok).toBe(false);
    // A source running far ABOVE the reference is equally suspect.
    const fast = 54 * (1 + VALIDITY_RATE_TOL) + 0.1;
    expect(check(evaluateRunValidity(healthy({ spawnRate: fast, sinkRate: fast })), 'sourceThroughput')?.ok).toBe(false);
  });

  it('grades the source as "> 0" only when no reference rate is supplied', () => {
    const r = evaluateRunValidity(healthy({ referenceSpawnRate: null, spawnRate: 7, sinkRate: 7 }));
    expect(r.valid).toBe(true);
    expect(r.referenceMissing).toBe(true);
    expect(r.reason).toContain('no reference rate');
    expect(check(r, 'sourceThroughput')?.detail).toContain('no reference rate supplied');
    // Even without a reference, a standstill is invalid.
    expect(evaluateRunValidity(healthy({ referenceSpawnRate: null, spawnRate: 0, sinkRate: 0 })).valid).toBe(false);
  });

  it('rejects a sink that does not keep up with the source', () => {
    const r = evaluateRunValidity(healthy({ sinkRate: 54 * (1 - VALIDITY_RATE_TOL) - 1 }));
    expect(r.valid).toBe(false);
    expect(check(r, 'sinkThroughput')?.ok).toBe(false);
    // …and a sink consuming far MORE than the source is drift, too.
    expect(check(evaluateRunValidity(healthy({ sinkRate: 54 * (1 + VALIDITY_RATE_TOL) + 1 })), 'sinkThroughput')?.ok).toBe(false);
  });

  it('rejects lost simulation time above 5 % of the window', () => {
    const limit = 300 * VALIDITY_LOST_SIM_TOL;
    expect(check(evaluateRunValidity(healthy({ lostSimSeconds: limit })), 'simTimeLoss')?.ok).toBe(true);
    const r = evaluateRunValidity(healthy({ lostSimSeconds: limit + 0.01 }));
    expect(r.valid).toBe(false);
    expect(check(r, 'simTimeLoss')?.ok).toBe(false);
  });

  it('reports every failing condition, not just the first', () => {
    const r = evaluateRunValidity(healthy({ liveMUs: 10, spawnRate: 0, sinkRate: 0, lostSimSeconds: 999 }));
    expect(r.valid).toBe(false);
    expect(r.checks.filter((c) => !c.ok)).toHaveLength(4);
    for (const name of ['occupancy', 'sourceThroughput', 'sinkThroughput', 'simTimeLoss']) {
      expect(r.reason).toContain(`${name} FAIL`);
    }
  });

  it('rejects a zero window and a zero target as ungradeable', () => {
    expect(evaluateRunValidity(healthy({ windowS: 0 })).valid).toBe(false);
    expect(evaluateRunValidity(healthy({ targetMUs: 0, liveMUs: 0 })).valid).toBe(false);
  });
});
