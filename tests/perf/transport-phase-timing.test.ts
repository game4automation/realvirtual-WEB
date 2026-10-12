// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Transport-step region attribution (plan-469 §9.1).
 *
 * Pins the three properties the Phase-0 numbers stand or fall on:
 *  - hooks `null` is the production state: no call, no behaviour change;
 *  - per-MU regions ACCUMULATE (entered N times per tick) and nested regions are
 *    EXCLUSIVE (the accumulation query is subtracted from the transport body),
 *    so the exclusive regions sum to at most the step;
 *  - regions that do not depend on MUs still run when there are none (SOL R2#6),
 *    and an MU spawned during the tick is counted in the same tick.
 *
 * The manager is driven bare with `manager.update(1/60)`, the same way
 * `tests/rv-transport-grid-parity.test.ts` does.
 */
import { describe, it, expect } from 'vitest';
import { Object3D, Vector3, Scene } from 'three';
import { AABB } from '../../src/core/engine/rv-aabb';
import { RVMovingUnit } from '../../src/core/engine/rv-mu';
import { RVTransportSurface } from '../../src/core/engine/rv-transport-surface';
import { RVSensor } from '../../src/core/engine/rv-sensor';
import { RVSink } from '../../src/core/engine/rv-sink';
import { RVTransportManager } from '../../src/core/engine/rv-transport-manager';
import {
  RVRegionTimer, PERF_REGIONS, TIMING_BIN_MS, createProbeCounters, resetProbeCounters,
  type PerfRegion,
} from '../../src/core/engine/perf/rv-perf-probe';

const dt = 1 / 60;

function createMU(name: string, x: number, y: number, z: number): RVMovingUnit {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, y, z);
  return new RVMovingUnit(node, 'test-source', new Vector3(0.05, 0.05, 0.05));
}

function createSurface(x: number, y: number, z: number, halfSize: Vector3, speed: number): RVTransportSurface {
  const node = new Object3D();
  node.position.set(x, y, z);
  const aabb = AABB.fromHalfSize(node, halfSize);
  const surface = new RVTransportSurface(node, aabb);
  surface.TransportDirection.copy(new Vector3(1, 0, 0));
  surface.Radial = false;
  surface.TextureScale = 1;
  surface.HeightOffsetOverride = 0;
  surface.initTransport();
  surface.drive = { currentSpeed: speed, name: 'mock-drive' } as never;
  return surface;
}

function createSensor(x: number, y: number, z: number): RVSensor {
  const node = new Object3D();
  node.position.set(x, y, z);
  const sensor = new RVSensor(node, AABB.fromHalfSize(node, new Vector3(0.05, 0.5, 0.5)));
  sensor.invertSignal = false;
  sensor.UseRaycast = false;
  return sensor;
}

function createSink(x: number, y: number, z: number): RVSink {
  const node = new Object3D();
  node.position.set(x, y, z);
  return new RVSink(node, AABB.fromHalfSize(node, new Vector3(0.2, 0.5, 0.5)));
}

/** Manager on a 10 m belt with a sensor and a sink; `n` MUs strung along it. */
function makeScene(n: number): RVTransportManager {
  const manager = new RVTransportManager();
  manager.scene = new Scene();
  manager.bruteForceThreshold = 0; // force the grid path everywhere
  manager.surfaces.push(createSurface(5, 0, 0, new Vector3(5, 0.05, 0.5), 1000));
  manager.sensors.push(createSensor(3, 0, 0));
  manager.sinks.push(createSink(9.8, 0, 0));
  for (let i = 0; i < n; i++) manager.mus.push(createMU(`mu${i}`, 0.5 + i * 0.4, 0.1, 0));
  return manager;
}

/** A hook recorder that counts enter/leave calls per region (no timing). */
function countingHooks() {
  const enters = new Map<string, number>();
  const leaves = new Map<string, number>();
  const order: string[] = [];
  return {
    enters, leaves, order,
    hooks: {
      enter(r: PerfRegion) { enters.set(r, (enters.get(r) ?? 0) + 1); order.push(`+${r}`); },
      leave(r: PerfRegion) { leaves.set(r, (leaves.get(r) ?? 0) + 1); order.push(`-${r}`); },
    },
  };
}

describe('plan-469 §9.1 — transport-step region attribution', () => {
  it('is not installed by default (production state)', () => {
    const manager = makeScene(3);
    expect(manager.regionHooks).toBeNull();
    expect(manager.probeCounters).toBeNull();
    // plan-473 F3: the fast path is production; only the REFERENCE switch remains.
    expect(manager.refSlowPick).toBe(false);
  });

  it('hooks null → identical MU positions to a run with hooks installed', () => {
    const a = makeScene(6);
    const b = makeScene(6);
    const rec = countingHooks();
    b.regionHooks = rec.hooks;
    b.probeCounters = createProbeCounters();
    for (let i = 0; i < 60; i++) { a.update(dt); b.update(dt); }
    const pos = (m: RVTransportManager) => m.mus.map((mu) => mu.getPosition().x.toFixed(9));
    expect(pos(b)).toEqual(pos(a));
    expect(rec.enters.get('sources')).toBe(60);
  });

  it('per-MU regions are entered once per MU per tick and are balanced', () => {
    const manager = makeScene(5);
    const rec = countingHooks();
    manager.regionHooks = rec.hooks;
    manager.update(dt);
    // 5 MUs, all on the belt → 5 picks and 5 transport bodies in this tick.
    expect(rec.enters.get('pick')).toBe(5);
    expect(rec.enters.get('transportExcl')).toBe(5);
    // Every region that was entered was also left exactly as often.
    for (const [r, n] of rec.enters) expect(rec.leaves.get(r), `region ${r}`).toBe(n);
  });

  it('accumulation is nested inside the transport body and subtracted from it', () => {
    const manager = makeScene(5);
    const timer = new RVRegionTimer();
    manager.regionHooks = timer;
    manager.probeCounters = createProbeCounters();
    for (let i = 0; i < 20; i++) {
      timer.beginTick();
      const t0 = performance.now();
      manager.update(dt);
      timer.endTick(performance.now() - t0, i, manager.probeCounters, true);
      resetProbeCounters(manager.probeCounters!);
    }
    const rep = timer.report();
    // The accumulation query ran (the MUs are strung along one belt with
    // `Accumulate` default on), and its time is NOT inside transportExcl.
    expect(rep.hitRates.accumSamples).toBeGreaterThan(0);
    // Sum of the exclusive regions never exceeds the measured step. Compared on
    // the SAME statistic: histogram percentiles are the upper edge of the bin
    // holding the rank, so a p95 may legitimately sit one bin width (0.25 ms)
    // above the raw value — comparing a p95 against a raw max would be a
    // rounding artefact, not a property of the attribution.
    expect(rep.sumExclusive.p95).toBeLessThanOrEqual(rep.total.p95 + TIMING_BIN_MS);
    expect(rep.sumExclusive.max).toBeLessThanOrEqual(rep.total.max + 1e-9);
    expect(rep.ticks).toBe(20);
  });

  it('with no MUs the MU regions are silent but surfaces/sensors/sinks still run (SOL R2#6)', () => {
    const manager = makeScene(0);
    const rec = countingHooks();
    manager.regionHooks = rec.hooks;
    manager.update(dt);
    expect(rec.enters.get('pick') ?? 0).toBe(0);
    expect(rec.enters.get('transportExcl') ?? 0).toBe(0);
    expect(rec.enters.get('accumulation') ?? 0).toBe(0);
    expect(rec.enters.get('surfaceGrid')).toBe(1);
    expect(rec.enters.get('sensors')).toBe(1);
    expect(rec.enters.get('sinks')).toBe(1);
    expect(rec.enters.get('muAabbGrid')).toBe(1);
  });

  it('an MU pushed during the sources phase is counted in the SAME tick', () => {
    const manager = makeScene(0);
    const rec = countingHooks();
    manager.regionHooks = rec.hooks;
    const counters = createProbeCounters();
    manager.probeCounters = counters;
    // A source stand-in: the sources loop pushes into `manager.mus`, which the
    // MU loop of the same tick then walks.
    manager.sources.push({
      update: () => createMU('spawned', 0.5, 0.1, 0),
      drainGenerated: () => [],
      CollisionRoleForMUs: undefined,
      node: { name: 'src' },
      pool: null,
      // Free-standing source: no discharge direction, so the spawn grow-out
      // effect is skipped (the tick is about the REGIONS, not the effect).
      getDischargeDirection: () => false,
    } as never);
    manager.update(dt);
    expect(manager.mus.length).toBe(1);
    expect(rec.enters.get('pick')).toBe(1);
    expect(counters.cloneAabb + counters.instAabb).toBe(1);
  });

  it('long-step records carry the flags and the exclusive regions', () => {
    const timer = new RVRegionTimer();
    const counters = createProbeCounters();
    counters.poolGrew = true;
    counters.adjacencyRebuilt = true;
    counters.surfaceGridRebuilt = true;
    counters.liveMUs = 2400;
    timer.beginTick();
    timer.enter('sensors');
    timer.addExclusive('growth', 250);
    timer.leave('sensors');
    timer.endTick(410, 77, counters, true);
    const rep = timer.report();
    expect(rep.longSteps).toHaveLength(1);
    const rec = rep.longSteps[0];
    expect(rec.tick).toBe(77);
    expect(rec.totalMs).toBe(410);
    expect(rec.poolGrew).toBe(true);
    expect(rec.adjacencyRebuilt).toBe(true);
    expect(rec.surfaceGridRebuilt).toBe(true);
    expect(rec.liveMUs).toBe(2400);
    expect(rec.exclusiveByRegion.growth).toBeCloseTo(250, 3);
    // A step BELOW the threshold produces no record.
    timer.beginTick();
    timer.endTick(5, 78, counters, true);
    expect(timer.report().longSteps).toHaveLength(1);
  });

  it('the region timer accounts nested spans exclusively', () => {
    // Deterministic clock: every `now()` advances by 1 ms.
    let t = 0;
    const timer = new RVRegionTimer(() => (t += 1));
    timer.beginTick();          // t = 1
    timer.enter('transportExcl'); // t = 2
    timer.enter('accumulation');  // t = 3  → transportExcl += 1
    timer.leave('accumulation');  // t = 4  → accumulation += 1
    timer.leave('transportExcl'); // t = 5  → transportExcl += 1
    timer.endTick(10, 1, null, true);
    const rep = timer.report();
    // Both regions saw exactly one 1 ms slice; the nested one is NOT in the parent.
    expect(rep.exclusive.accumulation.max).toBeCloseTo(1, 6);
    expect(rep.exclusive.transportExcl.max).toBeCloseTo(2, 6);
    // Inclusive transportExcl spans the whole nesting.
    expect(rep.inclusive.transportExcl.max).toBeGreaterThan(rep.exclusive.transportExcl.max);
  });

  it('every declared region has a histogram', () => {
    const timer = new RVRegionTimer();
    const rep = timer.report();
    for (const r of PERF_REGIONS) {
      expect(rep.exclusive[r], `exclusive ${r}`).toBeDefined();
      expect(rep.inclusive[r], `inclusive ${r}`).toBeDefined();
    }
  });
});
