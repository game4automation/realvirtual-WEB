// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2016 — a raycast Sensor is ONE ray that detects the NEAREST MU on it,
 * filtered by `AdditionalRayCastLayers` and `LimitSensorToTag`. Cases taken from
 * the blow-moulding line handovers, as they stand after Thomas' withdrawals of
 * 2026-10-29 (the standard demo's light barriers had gone dark) and the correction
 * of 2026-10-30 (the blow-moulding line acceptance run was red: 1/1/1 instead of 20/19/19):
 *
 *  (1) a collider that CONTAINS the ray origin is not hit (PhysX) — the beam sees
 *      what lies behind it, not distance 0 (point (c2), withdrawn 2026-10-29 and
 *      REINSTATED 2026-10-30: it is what bounds a DirectlyGrip grip, measured —
 *      without it the blow-moulding line loading gripper held 60 MUs and the QC line ran 0/0/0);
 *  (2) the NEAREST collider in the mask blocks everything behind it: a non-MU
 *      collider occupies (no MU enter), another sensor's collider blocks without
 *      occupying (point (c), reinstated 2026-10-30 on Thomas' decision) — while an
 *      MU that `LimitSensorToTag` rejects does NOT block (point (b) stays out,
 *      Festo);
 *  (3) the beam moving to ANOTHER collider of the same MU enters that MU again
 *      (point (f), withdrawn 2026-10-29 and REINSTATED 2026-10-30: without it the
 *      first hose stayed `_inside` the loading gripper's sensor for good);
 *  (4) after a MUSwitcher switch the ACTIVE variant's colliders count, each with
 *      its own layer — and the switch does not re-trigger itself;
 *  (5) two DirectlyGrip grips hand an MU over and the first does not take it back
 *      (the variant hull is on a layer its mask excludes, like Mauser.unity), and
 *      the next MU is gripped by the second grip;
 *  (6) a sensor below a moved parent with a frozen local matrix casts from the
 *      CURRENT pose without a render in between;
 *  (7) a sensor that starts free writes its NotOccupied signal at the first
 *      detection (Unity writes both signals every FixedUpdate).
 *
 *   Cell (layer table 24 = MauserParts)
 *    ├─ Fass       MU, layer 17, box 0.2 (root collider)          template at x = -10
 *    │   ├─ Lid    layer 17, box 0.2 × 0.05 × 0.2, 0.3 above the root
 *    │   └─ Hull   Group "Fass", INACTIVE, layer 24, box 0.5
 *    ├─ SrcFass    Source
 *    └─ … per test: ray sensors (layer 15, +Z unless stated), plate, grips
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Scene, Vector3 } from 'three';
import { loadBakedGLB } from './helpers/load-baked-glb';
import { CR, node, sceneToGlb } from './helpers/migrate-769-fixtures';
import { clearAllProblems } from '../src/core/hmi/problems-store';
import { resetLayerNames } from '../src/core/engine/rv-layers';
import { RVSensor } from '../src/core/engine/rv-sensor';
import { AABB } from '../src/core/engine/rv-aabb';
import type { RVMovingUnit, InstancedMovingUnit } from '../src/core/engine/rv-mu';
import type { RVSource } from '../src/core/engine/rv-source';
import type { RVGrip } from '../src/core/engine/rv-grip';

const LAYER_NAMES = Array.from({ length: 32 }, (_, i) => (i === 24 ? 'MauserParts' : ''));
const MAUSER = ['rvMU', 'rvMUSensor', 'MauserParts'];

const box = (sx: number, sy: number, sz: number, trigger = false) => ({
  type: 'BoxCollider', isTrigger: trigger, enabled: true,
  center: { x: 0, y: 0, z: 0 }, size: { x: sx, y: sy, z: sz },
});

interface RaySpec {
  layers: unknown;
  at: [number, number, number];
  dir?: { x: number; y: number; z: number };
  lengthMm?: number;
  extra?: Record<string, unknown>;
  /** Parent node name (a grip). */
  parent?: string;
}

interface Build {
  rays: Record<string, RaySpec>;
  /** Non-MU colliders: name → [layer, position, extras]. */
  statics?: Record<string, [number, [number, number, number], Record<string, unknown>?]>;
  grips?: Record<string, { at: [number, number, number]; sensor: string; placeSignal?: string }>;
}

async function build(b: Build): Promise<ArrayBuffer> {
  const scene = new Scene();
  scene.name = 'Cell';
  scene.userData.realvirtual = { layerNames: LAYER_NAMES };
  const fass = node('Fass', { MU: {}, layer: 17, colliders: [box(0.2, 0.2, 0.2)] });
  fass.position.set(-10, 0, 0);
  const body = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshBasicMaterial());
  body.name = 'Fass_Body';
  fass.add(body);
  const lid = node('Lid', { layer: 17, colliders: [box(0.2, 0.05, 0.2)] });
  lid.position.set(0, 0.3, 0);
  fass.add(lid);
  const hull = node('Hull', { Group: { GroupName: 'Fass' }, layer: 24, activeSelf: false, colliders: [box(0.5, 0.5, 0.5)] });
  fass.add(hull);
  const src = node('SrcFass', { Source: { ThisObjectAsMU: 'Fass', AutomaticGeneration: false, GenerateMU: true } });
  src.position.set(0, 10, 0);
  scene.add(fass, src);

  const signals = node('Signals');
  scene.add(signals);
  const parents = new Map<string, Object3D>();
  for (const [name, g] of Object.entries(b.grips ?? {})) {
    const grip = node(name, {
      layer: 0,
      Grip: {
        DirectlyGrip: true, OneBitControl: false, PlaceMode: 'Static', PartToGrip: CR(g.sensor, 'Sensor'),
        ...(g.placeSignal ? { SignalPlace: CR('Signals/' + g.placeSignal, 'PLCOutputBool') } : {}),
      },
    });
    grip.position.set(...g.at);
    if (g.placeSignal) signals.add(node(g.placeSignal, { PLCOutputBool: { Name: g.placeSignal, Status: { Value: false } } }));
    parents.set(name, grip);
    scene.add(grip);
  }
  for (const [name, r] of Object.entries(b.rays)) {
    const n = node(name, {
      layer: 15,
      Sensor: {
        UseRaycast: true, RayCastLength: r.lengthMm ?? 1000, RayCastDirection: r.dir ?? { x: 0, y: 0, z: 1 },
        AdditionalRayCastLayers: r.layers, ...(r.extra ?? {}),
      },
      ...(r.extra?.MUSwitcher ? { MUSwitcher: r.extra.MUSwitcher } : {}),
    });
    const p = r.parent ? parents.get(r.parent)! : null;
    if (p) {
      p.updateMatrixWorld(true);
      n.position.copy(p.worldToLocal(new Vector3(...r.at)));
      p.add(n);
    } else {
      n.position.set(...r.at);
      scene.add(n);
    }
  }
  for (const [name, [layer, at, extra]] of Object.entries(b.statics ?? {})) {
    const n = node(name, { layer, colliders: [box(0.4, 0.4, 0.02, !!extra?.trigger)], ...(extra?.Sensor ? { Sensor: extra.Sensor } : {}) });
    n.position.set(...at);
    scene.add(n);
  }
  return sceneToGlb(scene);
}

async function load(b: Build) {
  const result = await loadBakedGLB('sensor-unity-parity.glb', new Scene(), { data: (await build(b)).slice(0), loadKinematicsSidecar: false, expectChunks: false });
  const tm = result.transportManager;
  const source = tm.sources.find((s: RVSource) => s.node.name === 'SrcFass')!;
  const spawn = (): RVMovingUnit => tm.spawnFromSource(source) as RVMovingUnit;
  const sensor = (name: string): RVSensor => tm.sensors.find((s: RVSensor) => s.node.name === name)!;
  const grip = (name: string): RVGrip => tm.grips.find((g: RVGrip) => g.node.name === name) as RVGrip;
  const place = (mu: RVMovingUnit, x: number, y: number, z: number): void => {
    const p = mu.node.parent!;
    p.updateWorldMatrix(true, false);
    mu.node.position.copy(p.worldToLocal(new Vector3(x, y, z)));
    mu.node.updateMatrix();
    mu.node.updateMatrixWorld(true);
  };
  const moveNode = (n: Object3D, x: number, y: number, z: number): void => {
    n.position.set(x, y, z);
    n.updateMatrix();
    n.updateMatrixWorld(true);
  };
  const tick = (n = 1): void => { for (let i = 0; i < n; i++) tm.update(1 / 60); };
  const enters = (s: RVSensor): (RVMovingUnit | InstancedMovingUnit)[] => {
    const out: (RVMovingUnit | InstancedMovingUnit)[] = [];
    s.addMuEnterListener((mu) => out.push(mu));
    return out;
  };
  return { result, tm, spawn, sensor, grip, place, moveNode, tick, enters };
}

beforeEach(() => resetLayerNames());
afterEach(() => clearAllProblems());

describe('plan-2016 — raycast Sensor: the nearest MU on one ray', () => {
  it('(1) origin-inside: a collider containing the ray origin is not hit, the beam sees the MU behind it', async () => {
    const { spawn, sensor, place, tick } = await load({ rays: { Ray: { layers: MAUSER, at: [2, 1, -0.5] } } });
    const around = spawn();
    const behind = spawn();
    place(around, 2, 1, -0.5);   // root box (0.2) contains the origin
    place(behind, 2, 1, 0.3);
    tick();
    // Reinstated 2026-10-30. This rule is what BOUNDS a DirectlyGrip grip: without it
    // the blow-moulding line loading gripper saw every hose containing its ray origin, gripped each
    // one and held 60 at a time (QC line 0/0/0 instead of 20/19/19). Neither Unity's
    // Grip.cs nor ours caps the hold list, so the bound is the query, not a capacity.
    expect(sensor('Ray').occupiedMU, 'not the MU the ray starts in').toBe(behind);
    place(behind, 2, 1, -20);
    tick();
    expect(sensor('Ray').occupied, 'alone, the surrounding MU is not seen').toBe(false);
  });

  it('(2a) a non-MU collider in the mask blocks and occupies without an MU enter', async () => {
    const { spawn, sensor, place, tick, enters } = await load({
      rays: { RayT: { layers: ['rvMU', 'rvTransport'], at: [2, 1, -0.5] }, RayMU: { layers: ['rvMU'], at: [2, 1, -0.5] } },
      statics: { Plate: [16, [2, 1, 0]] },
    });
    const inT = enters(sensor('RayT'));
    const mu = spawn();
    place(mu, 2, 1, 0.3);
    tick();
    expect(sensor('RayT').occupied, 'the plate (rvTransport) is hit first').toBe(true);
    expect(sensor('RayT').occupiedMU).toBeNull();
    expect(inT).toEqual([]);
    expect(sensor('RayMU').occupiedMU, 'a mask without rvTransport looks through the plate').toBe(mu);
  });

  it('(2b) another sensor\'s collider blocks without occupying; a tag-rejected MU does NOT hide the wanted one', async () => {
    const { spawn, sensor, place, tick } = await load({
      rays: {
        RayS: { layers: MAUSER, at: [2, 1, -0.5] },            // own layer 15 → OtherSens (layer 15) is on the beam
        RayTag: { layers: MAUSER, at: [5, 1, -0.5], extra: { LimitSensorToTag: 'Wanted' } },
      },
      statics: { OtherSens: [15, [2, 1, 0], { trigger: true, Sensor: { UseRaycast: false } }] },
    });
    const behindSensor = spawn();
    place(behindSensor, 2, 1, 0.3);
    const near = spawn();
    const far = spawn();
    far.node.userData.tag = 'Wanted';
    place(near, 5, 1, 0);
    place(far, 5, 1, 0.4);
    tick();
    // Point (c) reinstated 2026-10-30: a Sensor's own collider blocks the beam but
    // never occupies (Unity `OnTriggerEnter` ignores a hit on a Sensor node).
    expect(sensor('RayS').occupied, 'a sensor collider blocks but never occupies').toBe(false);
    expect(sensor('RayS').occupiedMU, 'and the MU behind it is not reported').toBeNull();
    // Point (b) stays WITHDRAWN: on the Mauser all 18 raycast sensors have an empty
    // tag, so the rule bought nothing there, while for Festo (two sensors on
    // "FestoBox") it meant any foreign MU in front silenced the sensor.
    expect(sensor('RayTag').occupiedMU, 'the rejected MU in front does not hide it').toBe(far);
    place(near, 5, 1, -20);
    tick();
    expect(sensor('RayTag').occupiedMU).toBe(far);
  });

  it('(3) the beam moving to another collider of the same MU enters that MU again', async () => {
    const { spawn, sensor, place, tick, enters } = await load({ rays: { Ray: { layers: MAUSER, at: [2, 1, -0.5] } } });
    const s = sensor('Ray');
    const entered = enters(s);
    const mu = spawn();
    place(mu, 2, 1, 0);           // root collider on the beam
    tick(3);
    expect(entered).toEqual([mu]);
    place(mu, 2, 0.7, 0);         // now the Lid (0.3 above the root) is on the beam
    tick(3);
    // Point (f) reinstated 2026-10-30: measured on the blow-moulding line, one enter per stay left
    // the first hose `_inside` the loading gripper's sensor for good — one enter, one
    // pick, then the QC line ran 1/1/1 instead of 20/19/19. Its MUs carry 3 and 5
    // colliders, so collider-to-collider has to be a new entry.
    expect(entered, 'Unity: exit(root) + enter(lid)').toEqual([mu, mu]);
    expect(s.occupiedMU).toBe(mu);
    tick(3);
    expect(entered, 'and staying on that collider does not re-enter').toEqual([mu, mu]);
  });

  it('(4) after a MUSwitcher switch the active variant counts, per collider layer, and the switch does not loop', async () => {
    const { spawn, sensor, place, tick, enters } = await load({
      rays: {
        Switch: { layers: ['rvMU'], at: [2, 1, -0.5], extra: { MUSwitcher: { SwitchToGroup: 'Fass' } } },
        RayMU: { layers: ['rvMU'], at: [2.2, 1, -0.5] },        // hits only the hull (0.5), not the root (0.2)
        RayParts: { layers: ['MauserParts'], at: [2.2, 1.05, -0.5] },
      },
    });
    const sw = enters(sensor('Switch'));
    const mu = spawn();
    place(mu, 2, 1, 0);
    tick(10);
    expect(sw, 'one enter, the switch does not re-trigger itself').toEqual([mu]);
    expect(mu.detectPartLayers, 'root + lid on 17, the hull on 24').toEqual([17, 17, 24]);
    expect(sensor('RayMU').occupied, 'the hull is on MauserParts').toBe(false);
    expect(sensor('RayParts').occupiedMU).toBe(mu);
  });

  it('(5) DirectlyGrip handover A → B without taking back; the next MU is gripped by B', async () => {
    const { result, spawn, grip, sensor, place, moveNode, tick } = await load({
      grips: { GripA: { at: [0, 1, -0.4], sensor: 'GripA/RayA' }, GripB: { at: [2, 1, 0.4], sensor: 'RayB', placeSignal: 'PlaceB' } },
      rays: {
        // Grip A carries its sensor: ray +Z from z = -0.35, 250 mm.
        RayA: { layers: ['rvMU', 'rvMUSensor'], at: [0, 1, -0.35], lengthMm: 250, parent: 'GripA' },
        // Station B: ray -Z from z = 0.35 (the barrel variant is switched on here).
        RayB: { layers: ['rvMU', 'rvMUSensor'], at: [2, 1, 0.35], dir: { x: 0, y: 0, z: -1 }, lengthMm: 250, extra: { MUSwitcher: { SwitchToGroup: 'Fass' } } },
      },
    });
    const a = grip('GripA');
    const b = grip('GripB');
    const mu1 = spawn();
    place(mu1, 0, 1, 0);
    tick();
    expect(a.grippedMUs).toEqual([mu1]);

    moveNode(a.node, 2, 1, -0.4);       // A carries mu1 into station B
    tick();
    expect(b.grippedMUs, 'B takes over').toEqual([mu1]);
    expect(a.grippedMUs).toEqual([]);
    expect(mu1.detectPartLayers, 'the barrel hull (24) is active now').toContain(24);

    // A pulls back step by step: its ray origin leaves the hull (box 0.5) — the hull
    // is on MauserParts, which A's mask does not contain, so A never re-enters mu1.
    for (let z = -0.4; z >= -0.8; z -= 0.02) { moveNode(a.node, 2, 1, z); tick(); }
    moveNode(a.node, 0, 1, -0.4);
    tick();
    expect(b.grippedMUs, 'no take-back').toEqual([mu1]);
    expect(a.grippedMUs).toEqual([]);
    expect(sensor('RayA').occupied).toBe(false);

    // B places mu1, it is carried off; the next MU arrives and is gripped by B.
    result.signalStore.set('PlaceB', true);
    tick();
    result.signalStore.set('PlaceB', false);
    expect(b.grippedMUs).toEqual([]);
    place(mu1, 20, 1, 0);
    const mu2 = spawn();
    place(mu2, 0, 1, 0);
    tick();
    expect(a.grippedMUs).toEqual([mu2]);
    moveNode(a.node, 2, 1, -0.4);
    tick();
    expect(b.grippedMUs).toEqual([mu2]);
    expect(a.grippedMUs).toEqual([]);
    expect(mu1.heldBy).toBeNull();
  });

  it('(5b) the same handover with the hull IN grip A\'s mask: A takes the MU back (Unity semantics — the layer is the reason)', async () => {
    const { spawn, grip, place, moveNode, tick } = await load({
      grips: { GripA: { at: [0, 1, -0.4], sensor: 'GripA/RayA' }, GripB: { at: [2, 1, 0.4], sensor: 'RayB' } },
      rays: {
        RayA: { layers: MAUSER, at: [0, 1, -0.35], lengthMm: 250, parent: 'GripA' },
        RayB: { layers: ['rvMU', 'rvMUSensor'], at: [2, 1, 0.35], dir: { x: 0, y: 0, z: -1 }, lengthMm: 250, extra: { MUSwitcher: { SwitchToGroup: 'Fass' } } },
      },
    });
    const a = grip('GripA');
    const b = grip('GripB');
    const mu1 = spawn();
    place(mu1, 0, 1, 0);
    tick();
    moveNode(a.node, 2, 1, -0.4);
    let backToA = false;
    for (let i = 0; i < 5; i++) { tick(); if (a.grippedMUs.includes(mu1)) backToA = true; }
    expect(b.grippedMUs.includes(mu1) || backToA, 'B took it over first').toBe(true);
    // Point (f) reinstated 2026-10-30 (the blow-moulding line QC line needs the per-collider enter,
    // see case (3)): A's beam moving from the root collider to the hull is an exit +
    // enter again, so the LAYER of the hull is what decides whether A re-grips — which
    // is why case (5a), with the hull outside A's mask, is the configuration Mauser.unity
    // actually ships.
    expect(backToA, 'A\'s beam moves from the root to the hull: exit + enter → Fix → take-back').toBe(true);
  });
});

describe('plan-2016 — sensor pose and signals', () => {
  it('(6) a sensor below a moved parent with a frozen local matrix casts from the current pose', () => {
    const mover = new Object3D();
    const sensorNode = new Object3D();
    mover.add(sensorNode);
    sensorNode.position.set(0, 1, 0);
    sensorNode.updateMatrix();
    sensorNode.matrixAutoUpdate = false;   // what the freeze pass does to a static child of a mover
    mover.updateMatrixWorld(true);
    const sensor = new RVSensor(sensorNode, AABB.fromBoxCollider(sensorNode, { x: 0, y: 0, z: 0 }, { x: 0.1, y: 0.1, z: 0.1 }));
    sensor.UseRaycast = true;
    const origin = new Vector3();
    const dir = new Vector3();
    sensor.getWorldRay(origin, dir);
    expect(origin.x).toBeCloseTo(0, 6);
    mover.position.x = 1.5;                // the mover drives; no render, no updateMatrixWorld
    (sensor as unknown as { _rayTickId: number })._rayTickId = -2;
    sensor.getWorldRay(origin, dir);
    expect(origin.x, 'the ray follows the mover at once').toBeCloseTo(1.5, 6);
  });

  it('(7) a free sensor writes its NotOccupied signal at the first detection, without an onChanged edge', async () => {
    const scene = new Scene();
    scene.name = 'Cell';
    const signals = node('Signals');
    signals.add(node('Empty', { PLCInputBool: { Name: 'Empty', Status: { Value: false } } }));
    signals.add(node('Busy', { PLCInputBool: { Name: 'Busy', Status: { Value: false } } }));
    const s = node('Stop', {
      Sensor: {
        UseRaycast: true, RayCastLength: 500, RayCastDirection: { x: 0, y: 0, z: 1 },
        SensorOccupied: CR('Signals/Busy', 'PLCInputBool'), SensorNotOccupied: CR('Signals/Empty', 'PLCInputBool'),
      },
    });
    scene.add(signals, s);
    const result = await loadBakedGLB('sensor-prime.glb', new Scene(), { data: (await sceneToGlb(scene)).slice(0), loadKinematicsSidecar: false, expectChunks: false });
    const tm = result.transportManager;
    const sensor = tm.sensors.find((x: RVSensor) => x.node.name === 'Stop')!;
    const edges: boolean[] = [];
    const write = sensor.onChanged!;
    sensor.onChanged = (o, se) => { edges.push(o); write(o, se); };
    expect(result.signalStore.get('Empty')).toBe(false);
    tm.update(1 / 60);
    expect(result.signalStore.get('Empty'), 'Unity writes !Occupied every step').toBe(true);
    expect(result.signalStore.get('Busy')).toBe(false);
    expect(edges, 'no edge: the state did not change').toEqual([]);
  });
});
