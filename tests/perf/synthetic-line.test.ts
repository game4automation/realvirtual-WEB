// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-465 §9.1 — the synthetic line: plan validity, topology, determinism,
 * steady state and PLC signal binding.
 *
 * The line is the measurement instrument, so a wrong line silently produces
 * confident wrong numbers. The plan arithmetic is checked against values
 * computed by hand, and the running behaviour is checked by actually stepping
 * the engine (drives → transport manager), not by trusting the builder.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Scene } from 'three';
import {
  buildSyntheticLine, computeSyntheticLinePlan, DEFAULT_SYNTHETIC_LINE,
  type SyntheticLineConfig, type SyntheticLineHandle, type SyntheticLineHost,
} from '../../src/core/engine/perf/rv-synthetic-line';
import { RVTransportManager } from '../../src/core/engine/rv-transport-manager';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import type { RVDrive } from '../../src/core/engine/rv-drive';

const STEP = 1 / 60;

function makeHost(): SyntheticLineHost & { drives: RVDrive[] } {
  const scene = new Scene();
  const transportManager = new RVTransportManager();
  transportManager.scene = scene;
  return { scene, transportManager, signalStore: new SignalStore(), drives: [], fixedTimeStep: STEP };
}

/** Run the engine the way `CoreSubsystems` does: drives first, then transport. */
function run(host: SyntheticLineHost & { drives: RVDrive[] }, seconds: number): void {
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i++) {
    for (const drive of host.drives) drive.update(STEP);
    host.transportManager.update(STEP);
  }
}

/** Small but genuinely steady-state-capable line (keeps the test under a second). */
const SMALL: Partial<SyntheticLineConfig> = {
  lanes: 2, plcs: 2, segments: 4, segmentLengthM: 5,
  sensorsPerSegment: 1, targetMUs: 40, speedMmS: 1000,
  muLengthMm: 200, muGapMm: 100, signalBinding: 'none',
};

describe('SyntheticLinePlan arithmetic', () => {
  it('computes capacity, fill time and source interval by hand-checkable formulas', () => {
    // 2 lanes x 4 segments x 5 m = 40 m of belt; pitch 300 mm → 133 MUs fit.
    // A lane is 20 m, of which 19 m are actually travelled (0.5 m source inset,
    // 0.5 m sink inset) → 19 s transit at 1 m/s; 20 MUs per lane → one every 0.95 s.
    const plan = computeSyntheticLinePlan({ ...DEFAULT_SYNTHETIC_LINE, ...SMALL } as SyntheticLineConfig, STEP);
    expect(plan.capacityMUs).toBe(133);
    expect(plan.travelLengthM).toBeCloseTo(19, 6);
    expect(plan.fillTimeS).toBeCloseTo(19, 6);
    expect(plan.partPeriodS).toBeCloseTo(0.95, 6);
    // The spawn point stays blocked for one MU length at belt speed (0.2 m at
    // 1 m/s) and the source's timer does not advance meanwhile, so the interval
    // it is CONFIGURED with has to be shorter than the part period it produces.
    expect(plan.spawnGateS).toBeCloseTo(0.2, 6);
    expect(plan.sourceIntervalS).toBeCloseTo(0.75, 6);
    expect(plan.maxLiveMUs).toBe(48);            // ceil(1.2 * 40)
    expect(plan.valid).toBe(true);
  });

  it('rejects a target the geometry cannot hold', () => {
    const plan = computeSyntheticLinePlan(
      { ...DEFAULT_SYNTHETIC_LINE, ...SMALL, targetMUs: 120 } as SyntheticLineConfig, STEP);
    expect(plan.valid).toBe(false);
    expect(plan.reason).toMatch(/capacity/);
    expect(plan.reason).toContain('133');
  });

  it('rejects a target the SPAWNER cannot reach even though the geometry fits', () => {
    // The counterexample from the plan (SOL R2#4): 1 lane, 100 m of belt at
    // 10 m/s, tiny MUs — geometric capacity 5000, but a source emits at most one
    // MU per 60 Hz step, and a part clears the lane in ~10 s, so no more than
    // ~600 can ever be in flight. Capacity alone would have passed this.
    const plan = computeSyntheticLinePlan({
      ...DEFAULT_SYNTHETIC_LINE,
      lanes: 1, segments: 10, segmentLengthM: 10,
      muLengthMm: 10, muGapMm: 10, speedMmS: 10_000, targetMUs: 2400,
    } as SyntheticLineConfig, STEP);

    expect(plan.capacityMUs).toBe(5000);
    expect(plan.spawnCapMUs).toBe(594);   // 99 m travelled / (1/60 s) per lane
    expect(plan.valid).toBe(false);
    expect(plan.reason).toMatch(/spawn cap/);
  });

  it('rejects a target that would need parts closer together than the spawn gate allows', () => {
    // A short lane makes the gate the binding constraint: 2 m of belt with 1 m
    // of travel after the insets, parts 0.2 m long at 1 m/s. Four parts in flight
    // means one every 0.25 s, but the spawn point is blocked for 0.2 s after each
    // one — the parts would have to overlap. The geometric capacity (6) says
    // nothing about this, which is exactly why the gate is checked separately.
    const plan = computeSyntheticLinePlan({
      ...DEFAULT_SYNTHETIC_LINE,
      lanes: 1, segments: 1, segmentLengthM: 2, sensorsPerSegment: 1,
      targetMUs: 4, speedMmS: 1000, muLengthMm: 200, muGapMm: 100,
    } as SyntheticLineConfig, STEP);
    expect(plan.capacityMUs).toBe(6);
    expect(plan.valid).toBe(false);
    expect(plan.reason).toMatch(/source gate/);
  });

  it('rejects degenerate geometry instead of dividing by zero', () => {
    const plan = computeSyntheticLinePlan(
      { ...DEFAULT_SYNTHETIC_LINE, speedMmS: 0 } as SyntheticLineConfig, STEP);
    expect(plan.valid).toBe(false);
    expect(plan.reason).toMatch(/degenerate/);
  });

  it('lists exactly the signals the builder will register', () => {
    const plan = computeSyntheticLinePlan(
      { ...DEFAULT_SYNTHETIC_LINE, ...SMALL, signalBinding: 'connect' } as SyntheticLineConfig, STEP);
    // 8 conveyors x (Run + Speed + 1 sensor) + 2 PLCs x (TS + SEQ)
    expect(plan.signals).toHaveLength(8 * 3 + 4);
    expect(plan.signals).toContain('LINE/PLC0/Conv0/Run');
    expect(plan.signals).toContain('LINE/PLC1/Conv4/Speed');
    expect(plan.signals).toContain('LINE/PLC0/Sensor0');
    expect(plan.signals).toContain('LINE/PLC1/SEQ');
  });

  it('registers no signals at all when the binding is off', () => {
    const plan = computeSyntheticLinePlan(
      { ...DEFAULT_SYNTHETIC_LINE, ...SMALL, signalBinding: 'none' } as SyntheticLineConfig, STEP);
    expect(plan.signals).toEqual([]);
  });
});

describe('synthetic line topology', () => {
  let host: ReturnType<typeof makeHost>;
  let handle: SyntheticLineHandle;

  beforeEach(() => { host = makeHost(); });

  it('registers the expected component counts and takes over maxLiveMUs', () => {
    handle = buildSyntheticLine(host, SMALL);
    const tm = host.transportManager;
    expect(tm.surfaces).toHaveLength(2 * 4);
    expect(tm.sensors).toHaveLength(2 * 4 * 1);
    expect(tm.sources).toHaveLength(2);
    expect(tm.sinks).toHaveLength(2);
    expect(host.drives).toHaveLength(2 * 4);
    expect(tm.maxLiveMUs).toBe(handle.plan.maxLiveMUs);
    handle.dispose();
  });

  it('creates one instance pool per lane (pool-per-source, not per template)', () => {
    handle = buildSyntheticLine(host, { ...SMALL, lanes: 4, targetMUs: 40, muTemplates: 1 });
    const pools = host.transportManager.sources.filter((s) => s.pool !== null);
    expect(pools).toHaveLength(4);
    expect(handle.plan.pools).toBe(4);
    handle.dispose();
  });

  it('refuses to build an invalid configuration rather than measuring it', () => {
    expect(() => buildSyntheticLine(host, { ...SMALL, targetMUs: 500 }))
      .toThrow(/invalid configuration/);
    // Nothing may be left behind by the refusal.
    expect(host.transportManager.surfaces).toHaveLength(0);
    expect(host.drives).toHaveLength(0);
  });

  it('is deterministic: the same seed produces identical geometry', () => {
    const positions = (h: SyntheticLineHandle) => h.surfaces.map((s) => {
      const p = s.node.getWorldPosition(s.node.position.clone());
      return `${p.x.toFixed(6)},${p.y.toFixed(6)},${p.z.toFixed(6)}`;
    }).join('|');

    const a = buildSyntheticLine(host, { ...SMALL, seed: 7 });
    const layoutA = positions(a);
    a.dispose();

    const host2 = makeHost();
    const b = buildSyntheticLine(host2, { ...SMALL, seed: 7 });
    expect(positions(b)).toBe(layoutA);
    b.dispose();
  });

  it('alternates lane direction so the block folds back on itself', () => {
    handle = buildSyntheticLine(host, { ...SMALL, lanes: 2 });
    const lane0 = handle.surfaces[0];
    const lane1 = handle.surfaces[4];
    // TransportDirection is the LOCAL axis; reapplyConfig() projects it to world.
    expect(Math.sign(lane0.TransportDirection.x)).toBe(1);
    expect(Math.sign(lane1.TransportDirection.x)).toBe(-1);
    handle.dispose();
  });
});

describe('synthetic line steady state', () => {
  it('fills to the configured occupancy and then spawns as fast as it sinks', () => {
    const host = makeHost();
    const handle = buildSyntheticLine(host, SMALL);
    const tm = host.transportManager;

    run(host, handle.plan.fillTimeS * 1.5);

    const spawnedAtWindowStart = tm.totalSpawned;
    const consumedAtWindowStart = tm.totalConsumed;
    const windowS = 30;
    run(host, windowS);

    const spawned = tm.totalSpawned - spawnedAtWindowStart;
    const consumed = tm.totalConsumed - consumedAtWindowStart;
    const requiredRate = SMALL.lanes! / handle.plan.partPeriodS;

    // Occupancy…
    expect(tm.mus.length).toBeGreaterThanOrEqual(0.9 * handle.plan.config.targetMUs);
    expect(tm.mus.length).toBeLessThanOrEqual(1.1 * handle.plan.config.targetMUs);
    // …AND throughput. A stalled line would satisfy occupancy alone (SOL R1#3).
    expect(spawned / windowS).toBeGreaterThanOrEqual(0.9 * requiredRate);
    expect(consumed / Math.max(1, spawned)).toBeGreaterThanOrEqual(0.9);

    handle.dispose();
  });

  it('never exceeds the maxLiveMUs ceiling it set', () => {
    const host = makeHost();
    const handle = buildSyntheticLine(host, SMALL);
    run(host, handle.plan.fillTimeS * 2);
    expect(host.transportManager.mus.length).toBeLessThanOrEqual(handle.plan.maxLiveMUs);
    handle.dispose();
  });
});

describe('synthetic line PLC signal binding', () => {
  it('drives belt speed from LINE/.../Speed and stops a belt from LINE/.../Run', () => {
    const host = makeHost();
    const handle = buildSyntheticLine(host, { ...SMALL, signalBinding: 'browser' });
    const store = host.signalStore;

    run(host, 1);
    expect(handle.surfaces[0].speed).toBeCloseTo(SMALL.speedMmS!, 3);

    store.set('LINE/PLC0/Conv0/Speed', 250);
    run(host, 0.2);
    expect(handle.surfaces[0].speed).toBeCloseTo(250, 3);

    store.set('LINE/PLC0/Conv0/Run', false);
    run(host, 0.2);
    expect(handle.surfaces[0].speed).toBe(0);
    expect(handle.surfaces[0].isActive).toBe(false);
    // Only the addressed belt stops — the rest of the line keeps running.
    expect(handle.surfaces[1].isActive).toBe(true);

    handle.dispose();
  });

  it('mirrors the sensor state into the store, transition for transition', () => {
    const host = makeHost();
    const handle = buildSyntheticLine(host, { ...SMALL, signalBinding: 'browser' });
    const store = host.signalStore;
    const sensor = handle.sensors[0];
    expect(store.getBool('LINE/PLC0/Sensor0')).toBe(false);

    // Sample the pair every 100 ms of simulated time. A binding that fired on
    // some transitions but not others would show up as a mismatch here, which a
    // single end-of-run assertion could not see.
    let sawOccupied = false;
    for (let i = 0; i < 100; i++) {
      run(host, 0.1);
      expect(store.getBool('LINE/PLC0/Sensor0')).toBe(sensor.occupied);
      if (sensor.occupied) sawOccupied = true;
    }
    expect(sawOccupied).toBe(true);
    handle.dispose();
  });

  it('holds the sensor signal true while a stopped belt parks a part on it', () => {
    const host = makeHost();
    const handle = buildSyntheticLine(host, { ...SMALL, signalBinding: 'browser' });
    const store = host.signalStore;
    const sensor = handle.sensors[0];

    // Advance until a part is actually over the sensor, THEN stop the belt — a
    // fixed delay would depend on the exact spawn phase and be flaky.
    let guard = 0;
    while (!sensor.occupied && guard++ < 2000) run(host, 1 / 60);
    expect(sensor.occupied).toBe(true);

    store.set('LINE/PLC0/Conv0/Run', false);
    run(host, 3);

    expect(handle.surfaces[0].speed).toBe(0);
    expect(sensor.occupied).toBe(true);
    expect(store.getBool('LINE/PLC0/Sensor0')).toBe(true);
    handle.dispose();
  });

  it('leaves the belts jogging free when the binding is off', () => {
    const host = makeHost();
    const handle = buildSyntheticLine(host, { ...SMALL, signalBinding: 'none' });
    expect(host.signalStore.size).toBe(0);
    run(host, 1);
    expect(handle.surfaces[0].speed).toBeCloseTo(SMALL.speedMmS!, 3);
    handle.dispose();
  });
});

/**
 * plan-465 fix 2026-09-06 — the line must not draw its own scaffolding.
 *
 * `RVSource.init()` builds a source-marker ring plus ghost / ghost-fill /
 * preview meshes, and the MU template stays in the scene. That is five extra
 * non-instanced draw calls PER LANE. In the first sweep it was 120 of the 141
 * draw calls a 24-lane line reported — so the `draws` column tracked the lane
 * count and told you nothing about the MU count the matrix sweeps. The MUs
 * themselves cost one InstancedMesh per pool.
 */
describe('synthetic line draw-call footprint', () => {
  const visibleMeshes = (handle: SyntheticLineHandle): number => {
    let n = 0;
    handle.root.traverse((o) => {
      const m = o as unknown as { isMesh?: boolean; isInstancedMesh?: boolean; visible: boolean };
      if (m.isMesh && !m.isInstancedMesh && m.visible) n++;
    });
    return n;
  };

  it('leaves NO visible non-instanced mesh, whatever the segment count', () => {
    for (const segments of [2, 4, 8]) {
      const host = makeHost();
      const handle = buildSyntheticLine(host, { ...SMALL, segments, targetMUs: 20 });
      expect(visibleMeshes(handle), `segments=${segments}`).toBe(0);
      handle.dispose();
    }
  });

  it('keeps that footprint constant as lanes grow — MUs are the only drawn thing', () => {
    const counts: number[] = [];
    for (const lanes of [1, 2, 6]) {
      const host = makeHost();
      const handle = buildSyntheticLine(host, { ...SMALL, lanes, plcs: 1, targetMUs: 10 * lanes });
      counts.push(visibleMeshes(handle));
      handle.dispose();
    }
    expect(counts).toEqual([0, 0, 0]);
  });
});
