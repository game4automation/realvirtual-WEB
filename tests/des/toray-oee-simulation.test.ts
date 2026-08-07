// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * toray-oee-simulation.test.ts — Toray OEE showcase fake-data engine.
 *
 * Pure-TS test of the seeded shift simulation:
 *  - determinism: same seed → identical trajectories
 *  - invariants: state percents >= 0 and sum to ~100 after warmup,
 *    OEE = A × P × Q, factors in (0, 1], totalProcessed monotonic
 *  - post-warmup OEE bands per machine personality (FA-12 / PA-1 / RW-4)
 *
 * Runs only in the private build (imports `@rv-projects/Toray/*`).
 */

import { describe, it, expect } from 'vitest';
import {
  TorayOeeSimulation,
  TORAY_MACHINES,
  TORAY_STATE_NAMES,
} from '@rv-projects/Toray/plugins/toray-oee-simulation';

const WARMUP_S = 4 * 3600;

describe('TorayOeeSimulation', () => {
  it('is deterministic for the same seed', () => {
    const a = new TorayOeeSimulation(0x70aa, TORAY_MACHINES);
    const b = new TorayOeeSimulation(0x70aa, TORAY_MACHINES);
    for (let t = 0; t < 10000; t++) { a.advance(1); b.advance(1); }
    for (let i = 0; i < a.machines.length; i++) {
      expect(a.machines[i].oee).toBe(b.machines[i].oee);
      expect(a.machines[i].totalProcessed).toBe(b.machines[i].totalProcessed);
      expect(a.machines[i].currentState).toBe(b.machines[i].currentState);
    }
  });

  it('keeps statistics invariants after warmup', () => {
    const sim = new TorayOeeSimulation(0x70aa, TORAY_MACHINES);
    sim.warmup(WARMUP_S);
    for (const m of sim.machines) {
      let sum = 0;
      for (const s of TORAY_STATE_NAMES) {
        const pct = m.percentOf(s);
        expect(pct).toBeGreaterThanOrEqual(0);
        sum += pct;
      }
      expect(sum).toBeGreaterThan(99.5);
      expect(sum).toBeLessThan(100.5);
      expect(m.oee).toBeCloseTo(m.availability * m.performance * m.quality, 10);
      expect(m.availability).toBeGreaterThan(0);
      expect(m.availability).toBeLessThanOrEqual(1);
      expect(m.performance).toBeGreaterThan(0);
      expect(m.performance).toBeLessThanOrEqual(1);
      expect(m.quality).toBeGreaterThan(0);
      expect(m.quality).toBeLessThanOrEqual(1);
    }
  });

  it('totalProcessed is monotonic', () => {
    const sim = new TorayOeeSimulation(0x70aa, TORAY_MACHINES);
    sim.warmup(600);
    let prev = sim.machines.map((m) => m.totalProcessed);
    for (let t = 0; t < 3600; t++) {
      sim.advance(1);
      sim.machines.forEach((m, i) => {
        expect(m.totalProcessed).toBeGreaterThanOrEqual(prev[i]);
      });
      prev = sim.machines.map((m) => m.totalProcessed);
    }
  });

  it('lands in the per-machine OEE bands after warmup', () => {
    const sim = new TorayOeeSimulation(0x70aa, TORAY_MACHINES);
    sim.warmup(WARMUP_S);
    // Average over a demo-length window to smooth state-machine noise.
    const sums = new Map<string, number>();
    const SAMPLES = 3600;
    for (let t = 0; t < SAMPLES; t++) {
      sim.advance(1);
      for (const m of sim.machines) sums.set(m.cfg.id, (sums.get(m.cfg.id) ?? 0) + m.oee);
    }
    const avg = (id: string) => ((sums.get(id) ?? 0) / SAMPLES) * 100;
    expect(avg('FA-12')).toBeGreaterThan(62);
    expect(avg('FA-12')).toBeLessThan(82);
    expect(avg('PA-1')).toBeGreaterThan(72);
    expect(avg('PA-1')).toBeLessThan(90);
    expect(avg('RW-4')).toBeGreaterThan(53);
    expect(avg('RW-4')).toBeLessThan(77);
  });
});
