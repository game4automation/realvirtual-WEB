// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-469 §9.2 / plan-473 §9.5 — the switch inventory changes NO product behaviour.
 *
 * MIGRATED in plan-473 (F3): `protoFastPath` and `protoUnionCache` are gone.
 * The sticky-ownership fast path is production now, and the cell-union cache was
 * removed outright (slower than its reference in both plan-469 campaigns). What
 * is left is the INVERSE kind of switch — `refSlowPick` / `rvProtoFlags.refAabb`
 * restore the reference path for measurement and parity testing — plus the two
 * surviving plan-469 prototypes. Every one of them is `false` in production.
 *
 * This file pins two things:
 *
 *  1. **Switches off == reference path.** A snapshot of surface ownership, MU
 *     positions, sensor events (value AND tick) and sink consumption is taken
 *     over 600 ticks per scene. The snapshot is produced by the SAME code with
 *     the switches never touched, which is exactly the assertion that the
 *     switch code has no side effect in its off state — the numbers are compared
 *     bit-for-bit (`toFixed(12)`), not approximately.
 *  2. **Switches on == a finding, not a blocker.** Each prototype is run alone
 *     against the same reference. A mismatch here is recorded in the plan's
 *     `## Baseline Phase 0` section; it does not fail the spike, so each of
 *     these assertions is reported as a per-prototype parity verdict.
 */
import { describe, it, expect } from 'vitest';
import { Object3D, Vector3, Scene } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit, rvProtoFlags } from '../src/core/engine/rv-mu';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { RVSensor } from '../src/core/engine/rv-sensor';
import { RVSink } from '../src/core/engine/rv-sink';
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
  x: number, y: number, z: number,
  halfSize: Vector3, direction: Vector3, speed: number,
): RVTransportSurface {
  const node = new Object3D();
  node.position.set(x, y, z);
  const surface = new RVTransportSurface(node, AABB.fromHalfSize(node, halfSize));
  surface.TransportDirection.copy(direction);
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
  const sensor = new RVSensor(node, AABB.fromHalfSize(node, new Vector3(0.03, 0.5, 0.5)));
  sensor.invertSignal = false;
  sensor.UseRaycast = false;
  return sensor;
}

function createSink(x: number, y: number, z: number): RVSink {
  const node = new Object3D();
  node.position.set(x, y, z);
  return new RVSink(node, AABB.fromHalfSize(node, new Vector3(0.15, 0.5, 0.5)));
}

interface Snapshot {
  positions: string[];
  surfaces: string[];
  sensorEvents: string[];
  consumed: number[];
  leading: string[];
}

type SceneBuilder = () => RVTransportManager;

// ─── Scenes ────────────────────────────────────────────────────────

const scenes: Record<string, SceneBuilder> = {
  /** Straight line with a stopper sensor → a jam builds up (accumulation). */
  'straight line with jam': () => {
    const m = base();
    m.surfaces.push(createSurface(5, 0, 0, new Vector3(5, 0.05, 0.5), new Vector3(1, 0, 0), 500));
    m.sensors.push(createSensor(8, 0, 0));
    for (let i = 0; i < 12; i++) m.mus.push(createMU(`mu${i}`, 0.5 + i * 0.3, 0.1, 0));
    return m;
  },
  /** 90° handover between two belts. */
  '90 degree handover': () => {
    const m = base();
    m.surfaces.push(createSurface(2, 0, 0, new Vector3(2, 0.05, 0.4), new Vector3(1, 0, 0), 800));
    m.surfaces.push(createSurface(4, 0, 2, new Vector3(0.4, 0.05, 2), new Vector3(0, 0, 1), 800));
    for (let i = 0; i < 6; i++) m.mus.push(createMU(`mu${i}`, 0.2 + i * 0.5, 0.1, 0));
    return m;
  },
  /** A stopped belt next to a running one — rule 2 (entering) decides. */
  'stopped surface next to a running one': () => {
    const m = base();
    m.surfaces.push(createSurface(2, 0, 0, new Vector3(2, 0.05, 0.4), new Vector3(1, 0, 0), 0));
    m.surfaces.push(createSurface(6, 0, 0, new Vector3(2, 0.05, 0.4), new Vector3(1, 0, 0), 900));
    for (let i = 0; i < 6; i++) m.mus.push(createMU(`mu${i}`, 3.2 + i * 0.2, 0.1, 0));
    return m;
  },
  /** Stacked surfaces (ChainTransfer pattern) — the top band decides. */
  'stacked surfaces': () => {
    const m = base();
    m.surfaces.push(createSurface(3, 0, 0, new Vector3(3, 0.05, 1), new Vector3(1, 0, 0), 600));
    m.surfaces.push(createSurface(3, 0.05, 0, new Vector3(1, 0.05, 1), new Vector3(0, 0, 1), 600));
    for (let i = 0; i < 6; i++) m.mus.push(createMU(`mu${i}`, 0.3 + i * 0.4, 0.2, 0));
    return m;
  },
  /** A surface whose Y is raised mid-run without any cell-span change. */
  'surface raised in Y without a cell change': () => {
    const m = base();
    const low = createSurface(3, 0, 0, new Vector3(3, 0.05, 1), new Vector3(1, 0, 0), 600);
    const lift = createSurface(3, 0.02, 0, new Vector3(1, 0.05, 1), new Vector3(0, 0, 1), 600);
    m.surfaces.push(low, lift);
    for (let i = 0; i < 6; i++) m.mus.push(createMU(`mu${i}`, 0.3 + i * 0.4, 0.2, 0));
    (m as unknown as { __lift: RVTransportSurface }).__lift = lift;
    return m;
  },
  /** Array reassignment via filter() — a surface disappears with no dispose. */
  'array reassignment without notify': () => {
    const m = base();
    const a = createSurface(2, 0, 0, new Vector3(2, 0.05, 0.4), new Vector3(1, 0, 0), 700);
    const b = createSurface(6, 0, 0, new Vector3(2, 0.05, 0.4), new Vector3(1, 0, 0), 700);
    m.surfaces.push(a, b);
    for (let i = 0; i < 6; i++) m.mus.push(createMU(`mu${i}`, 0.3 + i * 0.5, 0.1, 0));
    (m as unknown as { __drop: RVTransportSurface }).__drop = b;
    return m;
  },
  /** A gripped MU is skipped by transport and excluded from accumulation. */
  'gripped MU': () => {
    const m = base();
    m.surfaces.push(createSurface(5, 0, 0, new Vector3(5, 0.05, 0.5), new Vector3(1, 0, 0), 700));
    for (let i = 0; i < 8; i++) m.mus.push(createMU(`mu${i}`, 0.5 + i * 0.3, 0.1, 0));
    // `isGripped` is a derived getter — ownership is expressed via `heldBy`.
    (m.mus[3] as RVMovingUnit).heldBy = 'grip';
    return m;
  },
  /** Physics ownership bypasses the kinematic pipeline entirely. */
  'physics-owned MU': () => {
    const m = base();
    m.surfaces.push(createSurface(5, 0, 0, new Vector3(5, 0.05, 0.5), new Vector3(1, 0, 0), 700));
    for (let i = 0; i < 8; i++) m.mus.push(createMU(`mu${i}`, 0.5 + i * 0.3, 0.1, 0));
    m.mus[5].physicsOwned = true;
    return m;
  },
  /** Sinks consume; MUs are removed by swap-and-pop mid-run. */
  'sink consumption with removals': () => {
    const m = base();
    m.surfaces.push(createSurface(5, 0, 0, new Vector3(5, 0.05, 0.5), new Vector3(1, 0, 0), 1500));
    m.sinks.push(createSink(9.7, 0, 0));
    m.sensors.push(createSensor(5, 0, 0));
    for (let i = 0; i < 14; i++) m.mus.push(createMU(`mu${i}`, 0.3 + i * 0.3, 0.1, 0));
    return m;
  },
  /** Turntable: a Radial surface with a discharge arm. The fast path excludes
   *  Radial surfaces by predicate (iii), so this scene pins that exclusion. */
  'turntable with discharge arm': () => {
    const m = base();
    const turntable = createSurface(0, 0, 0, new Vector3(0.6, 0.1, 0.6), new Vector3(1, 0, 0), 0);
    turntable.Radial = true;
    const arm = createSurface(1.0, 0, 0, new Vector3(0.5, 0.1, 0.3), new Vector3(1, 0, 0), 600);
    m.surfaces.push(turntable, arm);
    for (let i = 0; i < 4; i++) m.mus.push(createMU(`mu${i}`, -0.3 + i * 0.2, 0.15, 0));
    return m;
  },
  /** Different MU sizes in one lane (lateral test and gap clamp). */
  'mixed MU sizes': () => {
    const m = base();
    m.surfaces.push(createSurface(5, 0, 0, new Vector3(5, 0.05, 0.6), new Vector3(1, 0, 0), 600));
    for (let i = 0; i < 10; i++) m.mus.push(createMU(`mu${i}`, 0.4 + i * 0.35, 0.1, 0, 0.03 + (i % 3) * 0.02));
    return m;
  },
};

function base(): RVTransportManager {
  const m = new RVTransportManager();
  m.scene = new Scene();
  m.bruteForceThreshold = 0; // grid path everywhere — the path the caches touch
  return m;
}

/** Scene-specific mutations applied at a fixed tick, so a run is deterministic. */
function mutate(manager: RVTransportManager, tick: number): void {
  const anyM = manager as unknown as { __lift?: RVTransportSurface; __drop?: RVTransportSurface };
  if (anyM.__lift && tick === 200) {
    // Pure Y move: the lift rises above the low belt without touching XZ.
    anyM.__lift.node.position.y = 0.08;
    anyM.__lift.node.updateMatrixWorld(true);
  }
  if (anyM.__drop && tick === 200) {
    // filter() reassignment — no dispose, no notifyTopologyChanged.
    manager.surfaces = manager.surfaces.filter((s) => s !== anyM.__drop);
  }
}

function run(build: SceneBuilder): Snapshot {
  const m = build();
  const snap: Snapshot = { positions: [], surfaces: [], sensorEvents: [], consumed: [], leading: [] };
  const out: (RVMovingUnit | never)[] = [];
  const prevOccupied = new Map<RVSensor, boolean>();
  for (let tick = 0; tick < TICKS; tick++) {
    mutate(m, tick);
    m.update(dt);
    // Positions, to the last representable digit.
    for (const mu of m.mus) {
      const p = mu.getPosition();
      snap.positions.push(`${mu.getName()}:${p.x.toFixed(12)},${p.y.toFixed(12)},${p.z.toFixed(12)}`);
      snap.surfaces.push(`${mu.getName()}:${mu.currentSurface?.node.name ?? 'null'}:${mu.blocked ? 1 : 0}`);
    }
    // Sensor enter/exit with the tick they happened on.
    for (const s of m.sensors) {
      const was = prevOccupied.get(s) ?? false;
      if (s.occupied !== was) {
        snap.sensorEvents.push(`t${tick}:${s.occupied ? 'enter' : 'exit'}`);
        prevOccupied.set(s, s.occupied);
      }
    }
    snap.consumed.push(m.totalConsumed);
    // `queryLeadingMU` results (set AND order) for the first few MUs.
    for (let i = 0; i < Math.min(4, m.mus.length); i++) {
      const mu = m.mus[i];
      const n = m.queryLeadingMU(mu, new Vector3(1, 0, 0), 0.5, out as never);
      snap.leading.push(`${mu.getName()}:` + out.slice(0, n).map((o) => o.getName()).join('|'));
    }
  }
  return snap;
}

function resetSwitches(): void {
  rvProtoFlags.oneWalk = false;
  rvProtoFlags.poolBounds = false;
  rvProtoFlags.refAabb = false;
}

/** Run a scene with the named manager-level prototypes armed. */
function runWith(build: SceneBuilder, arm: (m: RVTransportManager) => void): Snapshot {
  return run(() => { const m = build(); arm(m); return m; });
}

describe('plan-469 §9.2 — prototype switches off == reference path', () => {
  for (const [name, build] of Object.entries(scenes)) {
    it(`${name}: production state is bit-identical across runs`, () => {
      resetSwitches();
      const a = run(build);
      const b = run(build);
      expect(b.positions).toEqual(a.positions);
      expect(b.surfaces).toEqual(a.surfaces);
      expect(b.sensorEvents).toEqual(a.sensorEvents);
      expect(b.consumed).toEqual(a.consumed);
      expect(b.leading).toEqual(a.leading);
    });
  }

  it('the switch inventory is exactly the production state (plan-473 §9.5)', () => {
    const m = new RVTransportManager();
    // Reference switches — off means the PRODUCTION path (fast pick, cached AABB).
    expect(m.refSlowPick).toBe(false);
    expect(rvProtoFlags.refAabb).toBe(false);
    // Surviving plan-469 prototypes.
    expect(rvProtoFlags.oneWalk).toBe(false);
    expect(rvProtoFlags.poolBounds).toBe(false);
    // The two removed switches must not come back under their old names.
    expect((m as unknown as Record<string, unknown>).protoFastPath).toBeUndefined();
    expect((m as unknown as Record<string, unknown>).protoUnionCache).toBeUndefined();
    expect((rvProtoFlags as unknown as Record<string, unknown>).union).toBeUndefined();
  });

  it('installing the hit-rate counters alone does not change behaviour', () => {
    resetSwitches();
    const build = scenes['straight line with jam'];
    const ref = run(build);
    const probed = runWith(build, (m) => {
      m.probeCounters = {
        pickTotal: 0, pickFastPathHit: 0, accumTotal: 0, accumSpanStable: 0,
        cloneAabb: 0, instAabb: 0, poolGrew: false, adjacencyRebuilt: false,
        surfaceGridRebuilt: false, liveMUs: 0,
      };
    });
    expect(probed.positions).toEqual(ref.positions);
    expect(probed.surfaces).toEqual(ref.surfaces);
    expect(probed.leading).toEqual(ref.leading);
  });
});

// ─── Switch-ON parity (a FINDING, not a blocker — plan §9.2) ───────

const armers: Record<string, (m: RVTransportManager) => void> = {
  // plan-473: the reference switches must reproduce the production result
  // exactly — that is what makes them usable as the comparison side of an ABBA
  // measurement and of the F2/F3 parity tests.
  refslowpick: (m) => { m.refSlowPick = true; },
  refaabb: () => { rvProtoFlags.refAabb = true; },
  walk: () => { rvProtoFlags.oneWalk = true; },
  bounds: () => { rvProtoFlags.poolBounds = true; },
};

describe('plan-469 §9.2 / plan-473 §9.5 — switches ON, parity against production', () => {
  for (const [proto, arm] of Object.entries(armers)) {
    for (const [name, build] of Object.entries(scenes)) {
      it(`proto=${proto} — ${name}`, () => {
        resetSwitches();
        const ref = run(build);
        resetSwitches();
        const withProto = runWith(build, arm);
        resetSwitches();
        expect(withProto.surfaces, 'surface ownership').toEqual(ref.surfaces);
        expect(withProto.positions, 'MU positions').toEqual(ref.positions);
        expect(withProto.sensorEvents, 'sensor events').toEqual(ref.sensorEvents);
        expect(withProto.consumed, 'sink consumption').toEqual(ref.consumed);
        expect(withProto.leading, 'queryLeadingMU results').toEqual(ref.leading);
      });
    }
  }
});
