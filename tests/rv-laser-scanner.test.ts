// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-laser-scanner — the component layer of the ray sensors (plan-664 test 9.3).
 *
 * The ray KERNEL is already pinned by `rv-ray-scan.node.test.ts` and the noise
 * layer by `rv-ray-noise.node.test.ts`. What is left for the components is the
 * part that only exists once a sensor is a component in a scene, and every one
 * of those is a place a sim can silently drift:
 *
 *  - the rate accumulator and the latency ring, both in SIM time;
 *  - the measurement frame travelling WITH the frame, so a delayed scan is
 *    evaluated where it was taken and not where the sensor is now;
 *  - the mount offset and yaw, which is what lets a scanner sit on a vehicle
 *    root and look forward;
 *  - the derived signals in mm, and the no-hit convention on them;
 *  - the independent rate phase F1 demands;
 *  - and dispose, because a channel entry that outlives its sensor is a leak
 *    with a path attached.
 *
 * Everything is driven by calling `scanStep(dt, now)` directly. That is not a
 * shortcut around the engine — it IS the contract the transport manager uses
 * (`RayScanSensorLike`), and driving it by hand is the only way to assert "a
 * frame at exactly these sim times".
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, Object3D, Scene, Vector3 } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import { applySchema, getCapabilities, getSchemaDefaults } from '../src/core/engine/rv-component-registry';
import type { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { RVLaserScanner, LASER_SCANNER_SCHEMA } from '../src/core/engine/rv-laser-scanner';
import { RVRangefinder, SENSOR_SAFETY_NOTE } from '../src/core/engine/rv-rangefinder';
import { RVRayTarget, rayTargetBoxes } from '../src/core/engine/rv-ray-target';
import { getSensorDataStore } from '../src/core/engine/rv-sensor-data-store';
import { HIT_MU, HIT_TARGET, NO_HIT } from '../src/core/engine/rv-ray-scan';
import type { MuLike } from '../src/core/engine/rv-ray-scene-query';

const SCANNER_PATH = 'Cell/Vehicle';
const MIN_DIST = 'Cell/MinDist';
const IN_FIELD = 'Cell/InField';
const DISTANCE = 'Cell/Distance';

/** An MU-shaped candidate: a 1 m cube standing `z` metres in front of the origin. */
function crate(z: number, halfW = 0.5): MuLike {
  return {
    aabb: {
      min: { x: -halfW, y: 0, z: z - halfW },
      max: { x: halfW, y: 1, z: z + halfW },
    },
  };
}

interface Rig {
  node: Object3D;
  store: SignalStore;
  ctx: ComponentContext;
  /** Candidates the stub broad-phase hands out — mutate between ticks. */
  mus: MuLike[];
}

function rig(mus: MuLike[] = []): Rig {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Cell';
  const node = new Object3D();
  node.name = 'Vehicle';
  root.add(node);
  scene.add(root);

  const registry = new NodeRegistry();
  registry.registerNode('Cell', root);
  registry.registerNode(SCANNER_PATH, node);

  const store = new SignalStore();
  store.register('MinDist', MIN_DIST, 0, 'PLCInputFloat');
  store.register('InField', IN_FIELD, false, 'PLCInputBool');
  store.register('Distance', DISTANCE, 0, 'PLCInputFloat');
  store.buildIndex();

  const live = { mus };
  // The transport-manager seam the sensor actually uses: one list it appends
  // itself to and one broad-phase call. A real manager would drag the physics
  // registry and the MU pools into a test about timing.
  const tm = {
    raySensors: [] as unknown[],
    queryMUsXZ: (_min: ArrayLike<number>, _max: ArrayLike<number>, out: unknown[]): number => {
      out.length = 0;
      for (const m of live.mus) out.push(m);
      return live.mus.length;
    },
  } as unknown as RVTransportManager;

  const ctx = { registry, signalStore: store, scene, root, transportManager: tm } as ComponentContext;
  return { node, store, ctx, mus: live.mus };
}

/** A scanner with the schema defaults applied, then the given overrides. */
function scanner(r: Rig, over: Partial<RVLaserScanner> = {}): RVLaserScanner {
  const s = new RVLaserScanner(r.node);
  applySchema(s as unknown as Record<string, unknown>, LASER_SCANNER_SCHEMA, {});
  Object.assign(s, over);
  s.init(r.ctx);
  return s;
}

afterEach(() => { getSensorDataStore().clear(); });

describe('ray sensor schema', () => {
  it('is authorable, WEB-only and carries the safety note as a read-only row', () => {
    const d = getSchemaDefaults('LaserScanner');
    expect(d.FieldOfView).toBe(270);
    expect(d.AngularResolution).toBe(1);
    expect(d.RangeMax).toBe(8000);
    expect(d.SafetyNote).toBe(SENSOR_SAFETY_NOTE);
    expect(LASER_SCANNER_SCHEMA.SafetyNote.readonly).toBe(true);
    // F12 is a promise to the operator, not a comment in the source.
    expect(String(d.SafetyNote)).toMatch(/not a safety function/i);
    expect(getCapabilities('LaserScanner').authorable).toBe(true);
    expect(getCapabilities('Rangefinder').authorable).toBe(true);
    expect(getCapabilities('RayTarget').authorable).toBe(true);
    // The node must survive a destructive bake — a scanner that is baked away
    // has no pose to measure from.
    expect(getCapabilities('LaserScanner').claimsNode).toBe(true);
  });

  it('declares every signal slot as a PLC signal reference, never a string', () => {
    // A signal field that is not a `componentRef` + `signal` is invisible to the
    // binding UI and to the Unity-parity write path.
    for (const key of ['SignalMinDistance', 'SignalObstacleInField']) {
      expect(LASER_SCANNER_SCHEMA[key].type, key).toBe('componentRef');
      expect(LASER_SCANNER_SCHEMA[key].signal, key).toBeTruthy();
    }
  });

  it('a 270 deg fan at 1 deg is 271 rays, both edges included', () => {
    const r = rig();
    const s = scanner(r);
    expect(s.rayCount).toBe(271);
  });
});

describe('measurement, rate and latency in sim time', () => {
  it('RateHz 0 measures every tick; the frame reaches the channel at once', () => {
    const r = rig([crate(2)]);
    const s = scanner(r, { RateHz: 0, FieldOfView: 0, AngularResolution: 0 });
    s.scanStep(1 / 60, 1 / 60);
    const f = getSensorDataStore().get(SCANNER_PATH)!;
    expect(f.seq).toBe(1);
    expect(f.ranges[0]).toBeCloseTo(1.5, 5);   // front face of a 1 m crate at 2 m
    expect(f.hitKind[0]).toBe(HIT_MU);
    s.scanStep(1 / 60, 2 / 60);
    expect(getSensorDataStore().get(SCANNER_PATH)!.seq).toBe(2);
  });

  it('RateHz 25 on a 60 Hz tick measures at the rate, not at the tick', () => {
    const r = rig([crate(2)]);
    const s = scanner(r, { RateHz: 25, FieldOfView: 0, AngularResolution: 0, Seed: 1 });
    const dt = 1 / 60;
    let scans = 0;
    let now = 0;
    for (let i = 0; i < 60; i++) {
      now += dt;
      s.scanStep(dt, now);
      const f = getSensorDataStore().get(SCANNER_PATH);
      if (f && f.seq > scans) scans = f.seq;
    }
    // One sim second at 25 Hz: 25 measurements, give or take the phase offset
    // that F1 requires (the first one is due part-way into the second).
    expect(scans).toBeGreaterThanOrEqual(24);
    expect(scans).toBeLessThanOrEqual(26);
  });

  it('LatencyMs 40 delivers the frame 40 ms of SIM time later, with its measurement time', () => {
    const r = rig([crate(2)]);
    const s = scanner(r, { RateHz: 0, LatencyMs: 40, FieldOfView: 0, AngularResolution: 0 });
    const dt = 0.01;
    let now = 0;
    // The first measurement happens at t = 0.01, so it is due at t = 0.05.
    // Four ticks: measured four times, delivered nothing.
    for (let i = 0; i < 4; i++) { now += dt; s.scanStep(dt, now); }
    expect(getSensorDataStore().get(SCANNER_PATH)).toBeNull();
    now += dt;                                     // t = 0.05
    s.scanStep(dt, now);
    const f = getSensorDataStore().get(SCANNER_PATH)!;
    expect(f.seq).toBe(1);
    // The delivered frame carries the time it was MEASURED, not the time it
    // arrived — the whole point of the latency, and what the Phase-3 corridor
    // evaluation depends on.
    expect(f.simTime).toBeCloseTo(0.01, 9);
  });

  it('the delayed frame carries the pose it was measured in, not the current one', () => {
    const r = rig([crate(3)]);
    const s = scanner(r, { RateHz: 0, LatencyMs: 20, FieldOfView: 0, AngularResolution: 0 });
    s.scanStep(0.01, 0.01);                        // measured at the origin
    r.node.position.set(0, 0, 1);                  // the vehicle drove on
    r.node.updateMatrixWorld(true);
    s.scanStep(0.01, 0.02);
    expect(getSensorDataStore().get(SCANNER_PATH)).toBeNull();
    s.scanStep(0.01, 0.03);                        // the 10 ms-old frame is due
    const f = getSensorDataStore().get(SCANNER_PATH)!;
    expect(f.simTime).toBeCloseTo(0.01, 9);
    expect(f.sensorWorld[14]).toBeCloseTo(0, 6);   // z of the MEASUREMENT origin
    expect(f.ranges[0]).toBeCloseTo(2.5, 5);       // measured from z = 0
  });

  it('two sensors on different nodes do not share a rate phase (F1)', () => {
    // Phase-locked scanners are the one configuration the Phase-1 measurement
    // found over budget, so this is a performance contract, not a nicety.
    const a = rig();
    const b = rig();
    b.node.name = 'Other';
    (b.ctx.registry as NodeRegistry).registerNode('Cell/Other', b.node);
    const sa = scanner(a, { RateHz: 25, FieldOfView: 0, AngularResolution: 0 });
    const sb = scanner(b, { RateHz: 25, FieldOfView: 0, AngularResolution: 0 });
    const dt = 1 / 240;
    const ticksA: number[] = [];
    const ticksB: number[] = [];
    let now = 0;
    for (let i = 0; i < 240; i++) {
      now += dt;
      const beforeA = sa.lastFrame?.seq ?? 0;
      const beforeB = sb.lastFrame?.seq ?? 0;
      sa.scanStep(dt, now);
      sb.scanStep(dt, now);
      if ((sa.lastFrame?.seq ?? 0) > beforeA) ticksA.push(i);
      if ((sb.lastFrame?.seq ?? 0) > beforeB) ticksB.push(i);
    }
    expect(ticksA.length).toBeGreaterThan(20);
    expect(ticksB.length).toBeGreaterThan(20);
    expect(ticksA).not.toEqual(ticksB);
  });

  it('resetScan puts the pipeline back so a restarted run measures identically', () => {
    const r = rig([crate(2)]);
    const s = scanner(r, { RateHz: 25, NoiseSigma: 10, FieldOfView: 0, AngularResolution: 0 });
    const dt = 1 / 60;
    const first: number[] = [];
    let now = 0;
    for (let i = 0; i < 30; i++) { now += dt; s.scanStep(dt, now); first.push(s.lastFrame?.ranges[0] ?? NO_HIT); }
    s.resetScan();
    const second: number[] = [];
    now = 0;
    for (let i = 0; i < 30; i++) { now += dt; s.scanStep(dt, now); second.push(s.lastFrame?.ranges[0] ?? NO_HIT); }
    expect(second).toEqual(first);
  });
});

describe('mounting', () => {
  it('MountOffset and MountYaw turn and shift the fan', () => {
    const r = rig([crate(2, 0.5)]);
    // Yaw 90 deg: the single ray looks along local +X, where there is nothing.
    const s = scanner(r, { RateHz: 0, FieldOfView: 0, AngularResolution: 0, MountYaw: 90 });
    s.scanStep(0.01, 0.01);
    expect(getSensorDataStore().get(SCANNER_PATH)!.ranges[0]).toBe(NO_HIT);
    s.dispose();

    // Mounted 1 m further forward: the same crate is 1 m nearer.
    const s2 = scanner(r, {
      RateHz: 0, FieldOfView: 0, AngularResolution: 0,
      MountOffset: { x: 0, y: 0, z: 1000 },
    });
    s2.scanStep(0.01, 0.01);
    expect(getSensorDataStore().get(SCANNER_PATH)!.ranges[0]).toBeCloseTo(0.5, 5);
  });

  it('the measurement frame follows the node and stays orthonormal under a mirrored scale', () => {
    const r = rig([crate(2)]);
    r.node.scale.set(-1, 1, 1);                    // mirrored placement
    r.node.updateMatrixWorld(true);
    const s = scanner(r, { RateHz: 0, FieldOfView: 90, AngularResolution: 45 });
    s.scanStep(0.01, 0.01);
    const w = getSensorDataStore().get(SCANNER_PATH)!.sensorWorld;
    const f = new Vector3(w[8], w[9], w[10]);
    const right = new Vector3(w[0], w[1], w[2]);
    expect(f.length()).toBeCloseTo(1, 9);
    expect(right.length()).toBeCloseTo(1, 9);
    expect(f.dot(right)).toBeCloseTo(0, 9);
  });
});

describe('derived signals', () => {
  it('MinDistance is written in mm; no hit reports RangeMax, never -1', () => {
    const r = rig([crate(2)]);
    const s = scanner(r, {
      RateHz: 0, FieldOfView: 0, AngularResolution: 0, RangeMax: 8000,
      SignalMinDistance: MIN_DIST,
    });
    s.scanStep(0.01, 0.01);
    expect(r.store.getByPath(MIN_DIST)).toBeCloseTo(1500, 3);
    r.mus.length = 0;                              // crate removed
    s.scanStep(0.01, 0.02);
    // A PLC reads a distance word; -1 there is a value nobody can scale.
    expect(r.store.getByPath(MIN_DIST)).toBe(8000);
  });

  it('ObstacleInField belongs to the coupling, not to the scan', () => {
    const r = rig([crate(2)]);
    const s = scanner(r, {
      RateHz: 0, FieldOfView: 0, AngularResolution: 0,
      SignalObstacleInField: IN_FIELD,
    });
    s.scanStep(0.01, 0.01);
    // A hit is NOT a field violation: whether the obstacle stands in the
    // corridor the vehicle is about to drive through is the Phase-3 field
    // machine's decision, and Phase 2 must not pre-empt it.
    expect(r.store.getByPath(IN_FIELD)).toBe(false);
    expect(s.obstacleInField).toBe(false);
    s.setObstacleInField(true);
    expect(r.store.getByPath(IN_FIELD)).toBe(true);
  });

  it('a Rangefinder writes its one distance in mm', () => {
    const r = rig([crate(2)]);
    const rf = new RVRangefinder(r.node);
    rf.RangeMax = 5000;
    rf.SignalDistance = DISTANCE;
    rf.init(r.ctx);
    rf.scanStep(0.01, 0.01);
    expect(r.store.getByPath(DISTANCE)).toBeCloseTo(1500, 3);
    expect(getSensorDataStore().infoOf(SCANNER_PATH)!.type).toBe('Rangefinder');
    rf.dispose();
  });
});

/**
 * A real 2 x 1 x 1 m wall centred `z` metres ahead — a RayTarget derives its box
 * from the node's GEOMETRY, so a bare `Object3D` would measure to nothing and the
 * test would only be exercising a hand-written box.
 */
function wall(r: Rig, name: string, z: number): Object3D {
  const mesh = new Mesh(new BoxGeometry(2, 1, 1));
  mesh.name = name;
  mesh.position.set(0, 0.5, z);
  r.node.parent!.add(mesh);
  mesh.updateMatrixWorld(true);
  return mesh;
}

describe('RayTarget', () => {
  it('makes a marked node visible to the rays and refreshes only when Dynamic', () => {
    const r = rig();
    const t = new RVRayTarget(wall(r, 'Wall', 3));
    t.Dynamic = false;
    t.init(r.ctx);

    const s = scanner(r, { RateHz: 0, FieldOfView: 0, AngularResolution: 0 });
    s.scanStep(0.01, 0.01);
    const f = getSensorDataStore().get(SCANNER_PATH)!;
    expect(f.ranges[0]).toBeCloseTo(2.5, 5);
    expect(f.hitKind[0]).toBe(HIT_TARGET);

    // Disabled → the box collapses and every ray misses it.
    t.Enabled = false;
    s.scanStep(0.01, 0.02);
    expect(getSensorDataStore().get(SCANNER_PATH)!.ranges[0]).toBe(NO_HIT);

    // Re-enabled → measured again. A static target that kept its collapsed box
    // would stay invisible until a reload, which is the trap a "measure once"
    // flag sets without this.
    t.Enabled = true;
    s.scanStep(0.01, 0.03);
    expect(getSensorDataStore().get(SCANNER_PATH)!.ranges[0]).not.toBe(NO_HIT);
    t.dispose();
  });

  it('a disposed target is gone from the candidates', () => {
    const r = rig();
    const t = new RVRayTarget(wall(r, 'Wall2', 3));
    t.init(r.ctx);
    const s = scanner(r, { RateHz: 0, FieldOfView: 0, AngularResolution: 0 });
    s.scanStep(0.01, 0.01);
    expect(getSensorDataStore().get(SCANNER_PATH)!.hitKind[0]).toBe(HIT_TARGET);
    t.dispose();
    s.scanStep(0.01, 0.02);
    expect(getSensorDataStore().get(SCANNER_PATH)!.ranges[0]).toBe(NO_HIT);
  });
});

/**
 * plan-664 §9.10, the COMPONENT layer (Phase 2's own measurement).
 *
 * Phase 1 measured the kernel. What is measured here is everything the kernel
 * does not do and a scene pays for anyway: the mount matrix, the broad-phase
 * call, the candidate collection, the noise, the rate accumulator, the latency
 * ring, the channel publish and the signal write — three real components, 271
 * rays each, 25 Hz, 40 ms latency, against 200 crates in a 40 x 40 m yard.
 *
 * Two measurement notes, both earned in Phase 1:
 *  - Chromium coarsens `performance.now()` to 100 us, the same order as a tick,
 *    so a per-tick sample would be measuring the clock. Ticks are BUNDLED.
 *  - the assertion is an order of magnitude, never a tight wall-clock bound; the
 *    p95 is PRINTED for the plan.
 */
describe('cost of the component layer', () => {
  const BUDGET_MS = 0.5;
  const TICKS_PER_SAMPLE = 60;

  it('3 scanners x 271 rays x 200 crates: p95 per fixed tick', () => {
    // A yard of 200 crates; the stub broad-phase does the real XZ filter, so
    // the measurement includes the candidate work and not just the cast.
    const yard: MuLike[] = [];
    let seed = 664;
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let i = 0; i < 200; i++) {
      const cx = (rnd() - 0.5) * 40;
      const cz = (rnd() - 0.5) * 40;
      yard.push({
        aabb: { min: { x: cx - 0.6, y: 0, z: cz - 0.4 }, max: { x: cx + 0.6, y: 1.2, z: cz + 0.4 } },
      });
    }

    const scene = new Scene();
    const root = new Object3D();
    root.name = 'Yard';
    scene.add(root);
    const registry = new NodeRegistry();
    registry.registerNode('Yard', root);
    const store = new SignalStore();
    const sensors: RVLaserScanner[] = [];
    let candidates = 0;
    const tm = {
      raySensors: [] as unknown[],
      queryMUsXZ: (min: ArrayLike<number>, max: ArrayLike<number>, out: unknown[]): number => {
        out.length = 0;
        for (const m of yard) {
          const a = m.aabb;
          if (a.max.x < min[0] || a.min.x > max[0] || a.max.z < min[2] || a.min.z > max[2]) continue;
          out.push(m);
        }
        candidates = out.length;
        return out.length;
      },
    } as unknown as RVTransportManager;

    for (let i = 0; i < 3; i++) {
      const node = new Object3D();
      node.name = `Fork_${i}`;
      node.position.set(i * 3 - 3, 0.2, 0);
      root.add(node);
      registry.registerNode(`Yard/Fork_${i}`, node);
      store.register(`Min_${i}`, `Yard/Fork_${i}/Min`, 0, 'PLCInputFloat');
      const s = new RVLaserScanner(node);
      applySchema(s as unknown as Record<string, unknown>, LASER_SCANNER_SCHEMA, {});
      Object.assign(s, {
        RangeMax: 8000, RateHz: 25, LatencyMs: 40,
        NoiseSigma: 5, NoiseSigmaPerM: 2, DropoutProb: 0.001, Resolution: 1,
        SignalMinDistance: `Yard/Fork_${i}/Min`,
      });
      store.buildIndex();
      s.init({ registry, signalStore: store, scene, root, transportManager: tm } as ComponentContext);
      sensors.push(s);
    }
    expect(sensors[0].rayCount).toBe(271);

    const dt = 1 / 60;
    let now = 0;
    const bundle = (): void => {
      for (let t = 0; t < TICKS_PER_SAMPLE; t++) {
        now += dt;
        for (const s of sensors) s.scanStep(dt, now);
      }
    };
    for (let i = 0; i < 5; i++) bundle();            // warm up the JIT
    const perTick: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      bundle();
      perTick.push((performance.now() - t0) / TICKS_PER_SAMPLE);
    }
    const sorted = [...perTick].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    const scans = sensors.reduce((n, s) => n + (s.lastFrame?.seq ?? 0), 0);
    // eslint-disable-next-line no-console
    console.log(`[plan-664 §9.10 component] 3 x 271 rays, 25 Hz, 40 ms latency, `
      + `${candidates}/200 crates in the fan -> median ${median.toFixed(4)} ms/tick, `
      + `p95 ${p95.toFixed(4)} ms/tick (budget ${BUDGET_MS}); ${scans} scans delivered over `
      + `${(now).toFixed(2)} s sim time`);
    expect(p95).toBeLessThan(BUDGET_MS * 10);
    expect(scans).toBeGreaterThan(50);               // the scenario really ran

    // The ceiling, and the evidence behind the LaserScanner's RateHz default of
    // 25: the same three scanners with `RateHz = 0` measure in EVERY tick — the
    // phase-locked configuration F1 found over budget, and four clean runs on
    // 2026-10-24 still put it there in half of them (p95 0.39-0.68 ms against the
    // 0.5 ms budget) while the 25 Hz default never left 0.18-0.33 ms. Printed
    // rather than asserted: the number is the evidence for the default, and a
    // wall-clock assertion on it would go red on a loaded box instead.
    // Re-init is how a changed rate takes effect (the period and the ring are
    // derived there); clear the stub's list first so it does not collect doubles.
    (tm as unknown as { raySensors: unknown[] }).raySensors.length = 0;
    for (const s of sensors) { s.RateHz = 0; s.init({ registry, signalStore: store, scene, root, transportManager: tm } as ComponentContext); }
    for (let i = 0; i < 3; i++) bundle();
    const ceiling: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      bundle();
      ceiling.push((performance.now() - t0) / TICKS_PER_SAMPLE);
    }
    const cs = [...ceiling].sort((a, b) => a - b);
    // eslint-disable-next-line no-console
    console.log(`[plan-664 §9.10 component ceiling] the same 3 scanners at RateHz 0 (every tick) `
      + `-> median ${cs[cs.length >> 1].toFixed(4)} ms/tick, p95 `
      + `${cs[Math.min(cs.length - 1, Math.floor(cs.length * 0.95))].toFixed(4)} ms/tick`);
    for (const s of sensors) s.dispose();
  });
});

describe('lifecycle', () => {
  let r: Rig;
  beforeEach(() => { r = rig([crate(2)]); });

  it('registers in the transport manager and the channel, and leaves neither behind', () => {
    const tm = r.ctx.transportManager as unknown as { raySensors: unknown[] };
    const s = scanner(r, { RateHz: 0 });
    expect(tm.raySensors).toHaveLength(1);
    expect(getSensorDataStore().paths()).toEqual([SCANNER_PATH]);
    s.dispose();
    expect(tm.raySensors).toHaveLength(0);
    expect(getSensorDataStore().paths()).toEqual([]);
    expect(getSensorDataStore().get(SCANNER_PATH)).toBeNull();
  });

  it('a second init replaces the first instead of adding a second scanner', () => {
    const tm = r.ctx.transportManager as unknown as { raySensors: unknown[] };
    const s = scanner(r, { RateHz: 0, FieldOfView: 0, AngularResolution: 0 });
    s.RateHz = 25;
    s.init(r.ctx);                                   // a live config edit re-inits
    expect(tm.raySensors).toHaveLength(1);
    expect(getSensorDataStore().paths()).toEqual([SCANNER_PATH]);
    expect(getSensorDataStore().infoOf(SCANNER_PATH)!.rateHz).toBe(25);
    s.dispose();
    expect(tm.raySensors).toHaveLength(0);
  });

  it('20 load/unload cycles leave the channel empty', () => {
    const tm = r.ctx.transportManager as unknown as { raySensors: unknown[] };
    for (let i = 0; i < 20; i++) {
      const s = scanner(r, { RateHz: 0, FieldOfView: 0, AngularResolution: 0 });
      s.scanStep(0.01, 0.01);
      s.dispose();
    }
    expect(tm.raySensors).toHaveLength(0);
    expect(getSensorDataStore().paths()).toEqual([]);
  });

  it('a steady scan allocates nothing: the frames come from a fixed pool', () => {
    // There is no allocation counter in a browser test, so the pool IDENTITY is
    // the proxy: 40 scans may only ever hand out the arrays of the pre-allocated
    // latency ring, and the constant fan must be ONE array shared by all of them.
    const s = scanner(r, { RateHz: 0, LatencyMs: 20 });
    const warmUp = new Set<Float32Array>();
    const steady = new Set<Float32Array>();
    const fans = new Set<Float32Array>();
    for (let i = 1; i <= 60; i++) {
      s.scanStep(0.01, i * 0.01);
      const f = getSensorDataStore().get(SCANNER_PATH);
      if (!f) continue;
      (i <= 30 ? warmUp : steady).add(f.ranges);
      fans.add(f.angles);
    }
    expect(warmUp.size).toBeGreaterThan(0);
    // The ring may GROW during warm-up (it does not know the host's tick rate),
    // but in the steady state it hands out nothing new — that is the allocation
    // claim, and it is stronger than an exact pool size.
    for (const b of steady) expect(warmUp.has(b)).toBe(true);
    expect(fans.size).toBe(1);
  });
});
