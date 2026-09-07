// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-460 §9.1 — the dancer as a pure integrator.
 *
 * The anti-windup case is the one that matters: clamping only the POSITION and
 * letting `L_acc` run on would make a reversal do nothing for as long as it took
 * to unwind a length the machine never held. Every other assertion here is
 * arithmetic; that one is the contract.
 */

import { describe, expect, it } from 'vitest';
import {
  accumulate,
  clampTravel,
  normaliseStrands,
  positionFromAccumulated,
} from '../src/core/engine/ribbon/ribbon-dancer-math';

describe('ribbon dancer math', () => {
  it('accumulates (vUp - vDown) * dt', () => {
    expect(accumulate(0, 1000, 800, 1 / 60)).toBeCloseTo(200 / 60, 9);
    // A negative delta empties the store again, symmetrically.
    expect(accumulate(100, 800, 1000, 1 / 60)).toBeCloseTo(100 - 200 / 60, 9);
  });

  it('dt <= 0 and a non-finite delta leave L_acc untouched', () => {
    expect(accumulate(42, 1000, 0, 0)).toBe(42);
    expect(accumulate(42, 1000, 0, -1)).toBe(42);
    expect(accumulate(42, Number.NaN, 0, 1 / 60)).toBe(42);
  });

  it('position is home + L / strands', () => {
    expect(positionFromAccumulated(100, 300, 2)).toBe(250);
    expect(positionFromAccumulated(0, 300, 1)).toBe(300);
    // Four strands store four times the web per millimetre of travel.
    expect(positionFromAccumulated(0, 400, 4)).toBe(100);
  });

  it('clampTravel clamps position AND rewinds L_acc (anti-windup), flagging atMax', () => {
    // Home 0, limits [-150, 150], 2 strands: 400 mm of web wants 200 mm of travel.
    const c = clampTravel(200, 0, -150, 150, 2);
    expect(c.posMm).toBe(150);
    expect(c.atMax).toBe(true);
    expect(c.atMin).toBe(false);
    // L_acc is DERIVED from the clamped position: 150 mm * 2 strands = 300 mm.
    expect(c.lAccMm).toBe(300);

    // ...so one reversed tick immediately leaves the stop, instead of first
    // running out the 100 mm of phantom length a naive clamp would have kept.
    const back = clampTravel(
      positionFromAccumulated(0, accumulate(c.lAccMm, 0, 600, 1 / 60), 2), 0, -150, 150, 2,
    );
    expect(back.atMax).toBe(false);
    expect(back.posMm).toBeLessThan(150);
  });

  it('clampTravel flags atMin at the lower stop and rewinds there too', () => {
    const c = clampTravel(-400, 0, -150, 150, 2);
    expect(c.posMm).toBe(-150);
    expect(c.atMin).toBe(true);
    expect(c.lAccMm).toBe(-300);
  });

  it('a HomeMm offset shifts both stops with it', () => {
    const c = clampTravel(1000, 500, -100, 100, 1);
    expect(c.posMm).toBe(600);
    expect(c.atMax).toBe(true);
    // L_acc is measured from HOME, not from zero.
    expect(c.lAccMm).toBe(100);
  });

  it('strands must be at least 1, and a reversed limit pair is normalised not NaN', () => {
    expect(normaliseStrands(0)).toBe(1);
    expect(normaliseStrands(-3)).toBe(1);
    expect(normaliseStrands(Number.NaN)).toBe(1);
    expect(positionFromAccumulated(0, 300, 0)).toBe(300);

    const c = clampTravel(0, 0, 150, -150, 2);   // min and max swapped
    expect(Number.isFinite(c.posMm)).toBe(true);
    expect(c.posMm).toBe(0);
  });

  it('a non-finite position falls back to home rather than poisoning the carriage', () => {
    const c = clampTravel(Number.NaN, 25, -100, 100, 2);
    expect(c.posMm).toBe(25);
    expect(c.lAccMm).toBe(0);
  });
});
