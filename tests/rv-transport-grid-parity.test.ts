// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Transport-manager spatial-grid parity tests (plan-240 §9.2).
 *
 * Drives a bare RVTransportManager with `manager.update(1/60)` exactly like
 * tests/rv-transport.test.ts (whose helper factories are mirrored here — they
 * are file-local there). The public `bruteForceThreshold` switch forces the
 * grid path (0) or the brute-force path (Infinity) so both codepaths and the
 * threshold transition can be compared without duplicating engine logic.
 */
import { describe, it, expect } from 'vitest';
import { Object3D, Vector3, Scene } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { RVSensor } from '../src/core/engine/rv-sensor';
import { RVSink } from '../src/core/engine/rv-sink';
import { RVGrip } from '../src/core/engine/rv-grip';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';

// ─── Helpers (mirrored from tests/rv-transport.test.ts) ───────────

const dt = 1 / 60;

function createMU(name: string, x: number, y: number, z: number): RVMovingUnit {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, y, z);
  return new RVMovingUnit(node, 'test-source', new Vector3(0.05, 0.05, 0.05));
}

function createSurface(
  x: number, y: number, z: number,
  halfSize: Vector3,
  direction: Vector3,
  speed: number,
): RVTransportSurface {
  const node = new Object3D();
  node.position.set(x, y, z);

  const aabb = AABB.fromHalfSize(node, halfSize);
  const surface = new RVTransportSurface(node, aabb);
  surface.TransportDirection.copy(direction);
  surface.Radial = false;
  surface.TextureScale = 1;
  surface.HeightOffsetOverride = 0;
  surface.initTransport();

  surface.drive = {
    currentSpeed: speed,
    name: 'mock-drive',
  } as any;

  return surface;
}

function createSensor(x: number, y: number, z: number, halfSize: Vector3): RVSensor {
  const node = new Object3D();
  node.position.set(x, y, z);
  const aabb = AABB.fromHalfSize(node, halfSize);
  const sensor = new RVSensor(node, aabb);
  sensor.invertSignal = false;
  sensor.UseRaycast = false;
  return sensor;
}

function createRaycastSensor(
  x: number, y: number, z: number,
  direction: { x: number; y: number; z: number },
  lengthMm: number,
): RVSensor {
  const node = new Object3D();
  node.position.set(x, y, z);
  const aabb = AABB.fromHalfSize(node, new Vector3(0.05, 0.05, 0.05));
  const sensor = new RVSensor(node, aabb);
  sensor.invertSignal = false;
  sensor.UseRaycast = true;
  sensor.RayCastDirection = direction;
  sensor.RayCastLength = lengthMm;
  return sensor;
}

function createSink(x: number, y: number, z: number, halfSize: Vector3): RVSink {
  const node = new Object3D();
  node.position.set(x, y, z);
  const aabb = AABB.fromHalfSize(node, halfSize);
  return new RVSink(node, aabb);
}

function createManager(bruteForceThreshold: number): RVTransportManager {
  const manager = new RVTransportManager();
  manager.scene = new Scene();
  manager.bruteForceThreshold = bruteForceThreshold;
  return manager;
}

/** Structural view of the manager's private grids (test introspection only). */
interface GridView {
  size: number;
  has(item: unknown): boolean;
}
function grids(manager: RVTransportManager): { mu: GridView; surface: GridView } {
  const m = manager as unknown as { _muGrid: GridView; _surfaceGrid: GridView };
  return { mu: m._muGrid, surface: m._surfaceGrid };
}

/** Count `sensor.aabb.overlaps` narrow-phase invocations (instance shadowing). */
function countOverlapCalls(sensor: RVSensor): { calls: () => number } {
  let n = 0;
  const target = sensor.aabb as { overlaps(other: AABB): boolean };
  const orig = target.overlaps.bind(sensor.aabb);
  target.overlaps = (other: AABB) => {
    n++;
    return orig(other);
  };
  return { calls: () => n };
}

// ─── Tests ────────────────────────────────────────────────────────

describe('TransportManager grid parity', () => {
  it('sensor occupancy sequence identical with grid enabled vs brute force over 300 ticks', () => {
    // Belt x∈[0,5] @1500 mm/s, sensor at x=2, sink at x≈4.8; a new MU enters
    // every 25 ticks → continuous spawn/travel/consume traffic in both runs.
    const build = (threshold: number) => {
      const manager = createManager(threshold);
      manager.surfaces.push(createSurface(2.5, 0, 0, new Vector3(2.5, 0.1, 0.6), new Vector3(1, 0, 0), 1500));
      const sensor = createSensor(2.0, 0, 0, new Vector3(0.2, 0.5, 0.5));
      manager.sensors.push(sensor);
      manager.sinks.push(createSink(4.8, 0, 0, new Vector3(0.2, 0.5, 0.5)));
      return { manager, sensor };
    };
    const grid = build(0);            // always grid
    const brute = build(Infinity);    // always brute force

    const gridSeq: boolean[] = [];
    const bruteSeq: boolean[] = [];
    for (let i = 0; i < 300; i++) {
      if (i % 25 === 0) {
        grid.manager.mus.push(createMU(`g${i}`, 0, 0, 0));
        brute.manager.mus.push(createMU(`b${i}`, 0, 0, 0));
      }
      grid.manager.update(dt);
      brute.manager.update(dt);
      gridSeq.push(grid.sensor.occupied);
      bruteSeq.push(brute.sensor.occupied);
    }

    expect(gridSeq).toEqual(bruteSeq);
    expect(gridSeq).toContain(true);                       // the scene actually pulsed
    expect(grid.manager.totalConsumed).toBe(brute.manager.totalConsumed);
    expect(grid.manager.totalConsumed).toBeGreaterThan(0); // sink actually consumed
    expect(grid.manager.mus.length).toBe(brute.manager.mus.length);
  });

  it('occupiedMU identity deterministic (seq order) with TWO MUs overlapping one sensor (stau)', () => {
    // Stau scene: several MUs sit in one sensor zone at once. The grid path
    // must resolve first-hit by the stable spawn ordinal (seq), NOT by the
    // swap-and-pop-scrambled mus array order.
    const manager = createManager(0); // force grid path
    const sensor = createSensor(0, 0, 0, new Vector3(1, 1, 1));
    manager.sensors.push(sensor);

    const muA = createMU('muA', 0.2, 0, 0);
    const muB = createMU('muB', -0.2, 0, 0);
    const muC = createMU('muC', 0.4, 0, 0);
    manager.mus.push(muA, muB, muC);

    manager.update(dt);
    expect(sensor.occupied).toBe(true);
    expect(sensor.occupiedMU).toBe(muA); // earliest seq wins the rising edge

    // Remove muA — swap-and-pop reorders mus to [muC, muB]. Array order now
    // DIFFERS from spawn order; seq order must still win.
    manager.removeMU(muA);
    expect(manager.mus[0]).toBe(muC); // precondition: array order scrambled

    // Force a fresh rising edge: park both outside, then bring both back in,
    // crossing grid cell boundaries on the way.
    muB.node.position.set(50, 0, 0);
    muC.node.position.set(51, 0, 0);
    manager.update(dt);
    expect(sensor.occupied).toBe(false);

    muB.node.position.set(0.3, 0, 0);
    muC.node.position.set(-0.3, 0, 0);
    manager.update(dt);
    expect(sensor.occupied).toBe(true);
    expect(sensor.occupiedMU).toBe(muB); // seq(muB) < seq(muC) — not array order (muC first)

    // Latched identity stays stable while both keep overlapping across cell moves.
    for (let i = 0; i < 5; i++) {
      muB.node.position.x += 0.1;
      muC.node.position.x -= 0.1;
      manager.update(dt);
      expect(sensor.occupied).toBe(true);
      expect(sensor.occupiedMU).toBe(muB);
    }
  });

  it('PartToGrip picks the same MU as occupiedMU in multi-occupancy scene', () => {
    // rv-grip.ts findNearestMU() path: with a PartToGrip sensor the grip takes
    // sensor.occupiedMU — which the grid path resolves deterministically.
    const manager = createManager(0);
    const sensor = createSensor(0, 0, 0, new Vector3(1, 1, 1));
    manager.sensors.push(sensor);

    const muA = createMU('muA', 0.2, 0, 0);
    const muB = createMU('muB', -0.2, 0, 0);
    manager.mus.push(muA, muB);
    manager.update(dt);
    expect(sensor.occupiedMU).toBe(muA);

    const gripNode = new Object3D();
    gripNode.name = 'grip';
    const grip = new RVGrip(gripNode);
    grip.partToGripSensor = sensor;
    manager.grips.push(grip);

    grip.pick();
    expect(muA.isGripped).toBe(true);   // gripped exactly the deterministic occupiedMU
    expect(muB.isGripped).toBe(false);
  });

  it('threshold fallback: brute-force path below 64 MUs, grid path above, transition consistent', () => {
    const manager = createManager(64); // production default
    const sensor = createSensor(0, 0, 0, new Vector3(0.5, 0.5, 0.5));
    manager.sensors.push(sensor);

    // Two MUs permanently in the zone; far MUs pump the count across 64.
    const muA = createMU('muA', 0.1, 0, 0);
    const muB = createMU('muB', -0.1, 0, 0);
    manager.mus.push(muA, muB);
    const far: RVMovingUnit[] = [];
    const addFar = (n: number) => {
      for (let i = 0; i < n; i++) {
        const mu = createMU(`far${far.length}`, 100 + far.length * 3, 0, 0);
        far.push(mu);
        manager.mus.push(mu);
      }
    };

    const history: boolean[] = [];
    const step = () => { manager.update(dt); history.push(sensor.occupied); };

    addFar(30); step();                       // 32 MUs  → brute-force regime
    expect(manager.mus.length).toBeLessThan(64);
    addFar(40); step();                       // 72 MUs  → grid regime
    expect(manager.mus.length).toBeGreaterThanOrEqual(64);
    for (let i = 0; i < 5; i++) step();       // stay above the threshold a while
    while (far.length > 10) manager.removeMU(far.pop()!);  // drain to 12 → brute again
    expect(manager.mus.length).toBeLessThan(64);
    for (let i = 0; i < 5; i++) step();
    addFar(60); step();                       // and back up → grid again
    expect(manager.mus.length).toBeGreaterThanOrEqual(64);
    for (let i = 0; i < 5; i++) step();

    // Occupancy never glitched across any regime change.
    expect(history.every((o) => o === true)).toBe(true);
    expect(sensor.occupiedMU).toBe(muA);
  });

  it('raycast-mode sensor (UseRaycast) uses grid candidates with identical results', () => {
    // Light barrier ACROSS the belt: ray from (1.5,0,-2) along +Z, 4 m long.
    // The sensor's own AABB does NOT cover the beam — this exercises the
    // computeRayQueryBounds() broad-phase path. An MU rides +X through the
    // beam; grid and brute occupancy sequences must match tick for tick.
    const build = (threshold: number) => {
      const manager = createManager(threshold);
      manager.surfaces.push(createSurface(2.5, 0, 0, new Vector3(2.5, 0.1, 0.6), new Vector3(1, 0, 0), 500));
      const sensor = createRaycastSensor(1.5, 0, -2, { x: 0, y: 0, z: 1 }, 4000);
      manager.sensors.push(sensor);
      const mu = createMU('rider', 0.5, 0, 0);
      manager.mus.push(mu);
      return { manager, sensor };
    };
    const grid = build(0);
    const brute = build(Infinity);

    const gridSeq: boolean[] = [];
    const bruteSeq: boolean[] = [];
    for (let i = 0; i < 300; i++) {
      grid.manager.update(dt);
      brute.manager.update(dt);
      gridSeq.push(grid.sensor.occupied);
      bruteSeq.push(brute.sensor.occupied);
    }

    expect(gridSeq).toEqual(bruteSeq);
    expect(gridSeq).toContain(true);   // the beam actually broke
    expect(gridSeq).toContain(false);  // ... and cleared again
  });

  it('gripped MU moving across multiple cells still triggers sensors', () => {
    const manager = createManager(0); // force grid path
    const sensor = createSensor(10, 0, 0, new Vector3(0.5, 0.5, 0.5));
    manager.sensors.push(sensor);
    const sink = createSink(5, 0, 0, new Vector3(0.5, 0.5, 0.5));
    manager.sinks.push(sink);

    const mu = createMU('carried', 0, 0, 0);
    mu.heldBy = 'grip'; // carried by a grip — transport skips it, AABB update does not
    manager.mus.push(mu);

    let sawSensor = false;
    for (let i = 1; i <= 12; i++) {
      mu.node.position.x = i; // robot-arm style carry: 1 m per tick = several cells
      manager.update(dt);
      if (sensor.occupied) sawSensor = true;
    }

    expect(sawSensor).toBe(true);           // grid followed the multi-cell jumps
    expect(manager.mus.length).toBe(1);     // sink skipped the gripped MU on the way
    expect(mu.markedForRemoval).toBe(false);
  });

  it('multiuser-style direct mus.push() is picked up by lazy insert same tick', () => {
    const manager = createManager(0); // force grid path
    const sensor = createSensor(0, 0, 0, new Vector3(0.5, 0.5, 0.5));
    manager.sensors.push(sensor);

    // Follower-sync style: the MU bypasses Source.update and is pushed raw
    // (multiuser-plugin `tm.mus.push(newMU)`). No registration call exists.
    const mu = createMU('follower', 0, 0, 0);
    manager.mus.push(mu);

    manager.update(dt); // ONE tick — lazy insert must index it before step 5

    expect(sensor.occupied).toBe(true);
    expect(sensor.occupiedMU).toBe(mu);
    expect(grids(manager).mu.has(mu)).toBe(true);
  });

  it('sensors/surfaces array reassignment (filter) triggers reference-guard rebuild', () => {
    const manager = createManager(0); // force grid path
    const A = createSurface(0, 0, 0, new Vector3(1, 0.1, 1), new Vector3(1, 0, 0), 1000);
    const B = createSurface(10, 0, 0, new Vector3(1, 0.1, 1), new Vector3(1, 0, 0), 1000);
    manager.surfaces.push(A, B);

    const muA = createMU('onA', 0, 0, 0);
    const muB = createMU('onB', 9.5, 0, 0);
    manager.mus.push(muA, muB);

    manager.update(dt);
    expect(muA.currentSurface).toBe(A);
    expect(muB.currentSurface).toBe(B);

    // scene-mutations removal style: REASSIGN the array via filter.
    manager.surfaces = manager.surfaces.filter((s) => s !== A);

    const xBefore = muA.node.position.x;
    manager.update(dt);
    expect(muA.currentSurface).toBeNull();                  // A no longer served by the grid
    expect(muA.node.position.x).toBeCloseTo(xBefore, 5);    // ... so it stopped moving
    expect(muB.currentSurface).toBe(B);                     // survivors keep working
    expect(grids(manager).surface.size).toBe(1);            // guard rebuilt the index

    // Sensors array reassignment must be honoured the same tick too.
    const sensor = createSensor(9.9, 0, 0, new Vector3(0.5, 0.5, 0.5));
    manager.sensors = [sensor];
    manager.update(dt);
    expect(sensor.occupied).toBe(true); // muB reached/inside the fresh sensor's zone
  });

  it('mid-tick removal: sink consumes MU, sensor next tick sees it gone, grid entry removed', () => {
    const manager = createManager(0); // force grid path
    const sensor = createSensor(0, 0, 0, new Vector3(0.5, 0.5, 0.5));
    manager.sensors.push(sensor);
    const sink = createSink(0, 0, 0, new Vector3(0.5, 0.5, 0.5));
    manager.sinks.push(sink);

    const mu = createMU('doomed', 0, 0, 0);
    manager.mus.push(mu);

    manager.update(dt); // sensor sees it (step 5) BEFORE the sink consumes it (steps 6/7)
    expect(sensor.occupied).toBe(true);
    expect(manager.mus.length).toBe(0);
    expect(grids(manager).mu.has(mu)).toBe(false); // entry removed with the MU
    expect(grids(manager).mu.size).toBe(0);

    manager.update(dt); // next tick: zone reads empty
    expect(sensor.occupied).toBe(false);
    expect(sensor.occupiedMU).toBeNull();
  });

  it('sim reset keeps surface grid, clears mu grid; dispose clears both', () => {
    const manager = createManager(0);
    manager.surfaces.push(
      createSurface(0, 0, 0, new Vector3(1, 0.1, 1), new Vector3(1, 0, 0), 1000),
      createSurface(5, 0, 0, new Vector3(1, 0.1, 1), new Vector3(1, 0, 0), 1000),
    );
    manager.mus.push(createMU('m1', 0, 0, 0), createMU('m2', 5, 0, 0));
    manager.update(dt);
    expect(grids(manager).mu.size).toBe(2);
    expect(grids(manager).surface.size).toBe(2);

    manager.reset(false); // sim restart: surfaces persist → surface grid persists
    expect(grids(manager).mu.size).toBe(0);
    expect(grids(manager).surface.size).toBe(2);

    // The kept surface grid still transports a freshly pushed MU.
    const mu = createMU('m3', 0, 0, 0);
    manager.mus.push(mu);
    manager.update(dt);
    expect(mu.currentSurface).not.toBeNull();
    expect(mu.node.position.x).toBeGreaterThan(0);

    manager.reset(true); // model unload: both grids dropped
    expect(grids(manager).mu.size).toBe(0);
    expect(grids(manager).surface.size).toBe(0);

    // And the dirty flag rebuilds the surface grid on the next tick.
    const mu2 = createMU('m4', 0, 0, 0);
    manager.mus.push(mu2);
    manager.update(dt);
    expect(mu2.currentSurface).not.toBeNull();
    expect(grids(manager).surface.size).toBe(2);
  });

  it('sensor candidate count is bounded by cell occupancy (call-count assertion)', () => {
    // 2 MUs share the sensor's cells (XZ) but sit at y=5 so the 3D narrow
    // phase never early-breaks; 100 MUs live far away. The grid path must
    // narrow-phase ONLY the cell-local MUs, the brute path scans all 102.
    const build = (threshold: number) => {
      const manager = createManager(threshold);
      const sensor = createSensor(0, 0, 0, new Vector3(0.5, 0.5, 0.5));
      manager.sensors.push(sensor);
      manager.mus.push(createMU('nearA', 0.1, 5, 0), createMU('nearB', -0.1, 5, 0));
      for (let i = 0; i < 100; i++) manager.mus.push(createMU(`far${i}`, 20 + i * 5, 0, 0));
      return { manager, sensor };
    };

    const grid = build(0);
    const gridCounter = countOverlapCalls(grid.sensor);
    grid.manager.update(dt);

    const brute = build(Infinity);
    const bruteCounter = countOverlapCalls(brute.sensor);
    brute.manager.update(dt);

    expect(grid.sensor.occupied).toBe(false);   // y-offset → no 3D overlap
    expect(brute.sensor.occupied).toBe(false);
    expect(gridCounter.calls()).toBe(2);        // exactly the cell-local candidates
    expect(bruteCounter.calls()).toBe(102);     // brute force scans every MU
  });
});
