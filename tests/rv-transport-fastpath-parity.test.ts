// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-473 §9.4 — the surface-pick fast path (F3) picks what the slow path picks.
 *
 * The sticky-ownership pre-check is PRODUCTION as of plan-473. The reference
 * side of every case below is the SLOW PATH itself, forced with
 * `manager.refSlowPick = true` — a reference that ran the same fast path would
 * prove nothing (SOL R2#8).
 *
 * The cases are the ones where the predicate could be wrong rather than merely
 * slow: a surface that moves ONLY in Y (no cell-span change, so nothing
 * re-indexes by itself), the numerical edge of the top band, a surface that
 * disappears through an array reassignment with no dispose and no notify, a
 * Radial surface (excluded by predicate iii), and MUs the pipeline skips
 * entirely (gripped, physics-owned).
 */
import { describe, it, expect } from 'vitest';
import { Object3D, Scene, Vector3 } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { RVSensor } from '../src/core/engine/rv-sensor';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';

const dt = 1 / 60;
const TICKS = 600;

function createMU(name: string, x: number, y: number, z: number, half = 0.05): RVMovingUnit {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, y, z);
  return new RVMovingUnit(node, 'test-source', new Vector3(half, half, half));
}

function createSurface(
  name: string, x: number, y: number, z: number,
  halfSize: Vector3, direction: Vector3, speed: number,
): RVTransportSurface {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, y, z);
  const surface = new RVTransportSurface(node, AABB.fromHalfSize(node, halfSize));
  surface.TransportDirection.copy(direction);
  surface.Radial = false;
  surface.TextureScale = 1;
  surface.HeightOffsetOverride = 0;
  surface.initTransport();
  surface.drive = { currentSpeed: speed, name: `drive-${name}` } as never;
  return surface;
}

function createSensor(x: number, y: number, z: number): RVSensor {
  const node = new Object3D();
  node.position.set(x, y, z);
  const sensor = new RVSensor(node, AABB.fromHalfSize(node, new Vector3(0.03, 0.5, 0.5)));
  sensor.invertSignal = false;
  sensor.UseRaycast = false;
  return sensor;
}

interface Scene473 {
  manager: RVTransportManager;
  /** Deterministic scene mutation, applied before `update()` of that tick. */
  mutate?: (tick: number) => void;
}

type Builder = () => Scene473;

function base(): RVTransportManager {
  const m = new RVTransportManager();
  m.scene = new Scene();
  m.bruteForceThreshold = 0; // grid path everywhere — the path the fast path reads
  return m;
}

interface Snapshot {
  positions: string[];
  surfaces: string[];
  sensorEvents: string[];
  consumed: number[];
}

function run(build: Builder, slowPath: boolean): Snapshot {
  const scene = build();
  const m = scene.manager;
  m.refSlowPick = slowPath;
  const snap: Snapshot = { positions: [], surfaces: [], sensorEvents: [], consumed: [] };
  const prevOccupied = new Map<RVSensor, boolean>();
  for (let tick = 0; tick < TICKS; tick++) {
    scene.mutate?.(tick);
    m.update(dt);
    for (const mu of m.mus) {
      const p = mu.getPosition();
      snap.positions.push(`${mu.getName()}:${p.x.toFixed(12)},${p.y.toFixed(12)},${p.z.toFixed(12)}`);
      snap.surfaces.push(`${mu.getName()}:${mu.currentSurface?.node.name ?? 'null'}:${mu.blocked ? 1 : 0}`);
    }
    for (const s of m.sensors) {
      const was = prevOccupied.get(s) ?? false;
      if (s.occupied !== was) {
        snap.sensorEvents.push(`t${tick}:${s.occupied ? 'enter' : 'exit'}`);
        prevOccupied.set(s, s.occupied);
      }
    }
    snap.consumed.push(m.totalConsumed);
  }
  m.refSlowPick = false;
  return snap;
}

function expectParity(build: Builder): void {
  const reference = run(build, true);   // slow path — the comparison side
  const production = run(build, false); // fast path — what ships
  expect(production.surfaces, 'surface ownership').toEqual(reference.surfaces);
  expect(production.positions, 'MU positions').toEqual(reference.positions);
  expect(production.sensorEvents, 'sensor events').toEqual(reference.sensorEvents);
  expect(production.consumed, 'sink consumption').toEqual(reference.consumed);
}

const builders: Record<string, Builder> = {
  'Y lift with no adjacency rebuild': () => {
    const m = base();
    const low = createSurface('low', 3, 0, 0, new Vector3(3, 0.05, 1), new Vector3(1, 0, 0), 600);
    const lift = createSurface('lift', 3, 0.02, 0, new Vector3(1, 0.05, 1), new Vector3(0, 0, 1), 600);
    m.surfaces.push(low, lift);
    for (let i = 0; i < 6; i++) m.mus.push(createMU(`mu${i}`, 0.3 + i * 0.4, 0.2, 0));
    return {
      manager: m,
      mutate: (tick) => {
        // Pure Y move: nothing about the cell span changes, so only the
        // per-tick surface-AABB refresh can notice at all.
        if (tick === 200) { lift.node.position.y = 0.08; lift.node.updateMatrixWorld(true); }
        if (tick === 400) { lift.node.position.y = 0.01; lift.node.updateMatrixWorld(true); }
      },
    };
  },

  'height change straddling the TOP_EPS band edge': () => {
    const m = base();
    const low = createSurface('low', 3, 0, 0, new Vector3(3, 0.05, 1), new Vector3(1, 0, 0), 600);
    // Second belt exactly at the 5 mm band edge, then a hair inside / outside it.
    const hi = createSurface('hi', 3, 0.005, 0, new Vector3(1, 0.05, 1), new Vector3(0, 0, 1), 600);
    m.surfaces.push(low, hi);
    for (let i = 0; i < 6; i++) m.mus.push(createMU(`mu${i}`, 0.3 + i * 0.4, 0.2, 0));
    return {
      manager: m,
      mutate: (tick) => {
        // Walk the band edge in sub-millimetre steps: 5.0 mm is exactly TOP_EPS.
        if (tick % 50 !== 0 || tick === 0) return;
        const steps = [0.0049, 0.0050, 0.0051, 0.0050, 0.0, 0.0060, 0.0050, 0.0049, 0.0051, 0.0050, 0.0];
        const y = steps[(tick / 50) % steps.length];
        hi.node.position.y = y;
        hi.node.updateMatrixWorld(true);
      },
    };
  },

  'array reassignment without dispose or notify': () => {
    const m = base();
    const a = createSurface('a', 2, 0, 0, new Vector3(2, 0.05, 0.4), new Vector3(1, 0, 0), 700);
    const b = createSurface('b', 6, 0, 0, new Vector3(2, 0.05, 0.4), new Vector3(1, 0, 0), 700);
    m.surfaces.push(a, b);
    for (let i = 0; i < 6; i++) m.mus.push(createMU(`mu${i}`, 0.3 + i * 0.5, 0.1, 0));
    return {
      manager: m,
      // `filter()` REPLACES the array. No dispose, no topology notification —
      // membership is the only sound test the predicate can make (ii).
      mutate: (tick) => { if (tick === 200) m.surfaces = m.surfaces.filter((s) => s !== b); },
    };
  },

  'surface removed while it is the current owner': () => {
    const m = base();
    const a = createSurface('a', 2, 0, 0, new Vector3(2, 0.05, 0.4), new Vector3(1, 0, 0), 400);
    const b = createSurface('b', 5.5, 0, 0, new Vector3(1.5, 0.05, 0.4), new Vector3(1, 0, 0), 400);
    m.surfaces.push(a, b);
    for (let i = 0; i < 6; i++) m.mus.push(createMU(`mu${i}`, 4.3 + i * 0.2, 0.1, 0));
    return {
      manager: m,
      mutate: (tick) => { if (tick === 120) m.surfaces = m.surfaces.filter((s) => s !== b); },
    };
  },

  'radial surface is excluded by predicate (iii)': () => {
    const m = base();
    const turntable = createSurface('tt', 0, 0, 0, new Vector3(0.6, 0.1, 0.6), new Vector3(1, 0, 0), 0);
    turntable.Radial = true;
    const arm = createSurface('arm', 1.0, 0, 0, new Vector3(0.5, 0.1, 0.3), new Vector3(1, 0, 0), 600);
    m.surfaces.push(turntable, arm);
    for (let i = 0; i < 4; i++) m.mus.push(createMU(`mu${i}`, -0.3 + i * 0.2, 0.15, 0));
    return { manager: m };
  },

  'physics handover: an owned MU leaves the kinematic pipeline': () => {
    const m = base();
    m.surfaces.push(createSurface('belt', 5, 0, 0, new Vector3(5, 0.05, 0.5), new Vector3(1, 0, 0), 700));
    for (let i = 0; i < 8; i++) m.mus.push(createMU(`mu${i}`, 0.5 + i * 0.3, 0.1, 0));
    return {
      manager: m,
      // Ownership flips mid-run, exactly like a real handover at a zone.
      mutate: (tick) => {
        if (tick === 150) m.mus[5].physicsOwned = true;
        if (tick === 350) m.mus[5].physicsOwned = false;
      },
    };
  },

  'grip: a held MU is skipped and un-held again': () => {
    const m = base();
    m.surfaces.push(createSurface('belt', 5, 0, 0, new Vector3(5, 0.05, 0.5), new Vector3(1, 0, 0), 700));
    m.sensors.push(createSensor(8, 0, 0));
    for (let i = 0; i < 8; i++) m.mus.push(createMU(`mu${i}`, 0.5 + i * 0.3, 0.1, 0));
    return {
      manager: m,
      mutate: (tick) => {
        // `isGripped` is derived from `heldBy`.
        if (tick === 100) (m.mus[3] as RVMovingUnit).heldBy = 'grip';
        if (tick === 300) (m.mus[3] as RVMovingUnit).heldBy = null;
      },
    };
  },

  'stopped belt beside a running one (rule 2 must still decide)': () => {
    const m = base();
    const stopped = createSurface('stopped', 2, 0, 0, new Vector3(2, 0.05, 0.4), new Vector3(1, 0, 0), 0);
    m.surfaces.push(stopped);
    m.surfaces.push(createSurface('running', 6, 0, 0, new Vector3(2, 0.05, 0.4), new Vector3(1, 0, 0), 900));
    for (let i = 0; i < 6; i++) m.mus.push(createMU(`mu${i}`, 3.2 + i * 0.2, 0.1, 0));
    return {
      manager: m,
      // Start and stop the upstream belt so ownership has to be re-decided.
      mutate: (tick) => {
        if (tick === 150) (stopped.drive as unknown as { currentSpeed: number }).currentSpeed = 900;
        if (tick === 350) (stopped.drive as unknown as { currentSpeed: number }).currentSpeed = 0;
      },
    };
  },
};

describe('plan-473 §9.4 — fast path vs. the real slow path', () => {
  for (const [name, build] of Object.entries(builders)) {
    it(name, () => { expectParity(build); });
  }

  it('the reference switch is off in production', () => {
    expect(new RVTransportManager().refSlowPick).toBe(false);
  });
});
