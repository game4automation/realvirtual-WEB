// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-757 Phase 0 — the public synthetic parity fixtures (a)–(i).
 *
 * Every fixture is a plain three.js tree with REAL materials (no pre-baked uber
 * attributes), so both pipelines run their own `dedup → uber → bake` on the
 * same bytes. `objectToGlb(sceneMirroringLoad(root))` turns the root into the
 * FILE'S SCENE, which is what the loader hands back as the model root — the
 * asset root therefore carries the fixture's name on both paths.
 *
 * Positions are metres (glTF), drive values millimetres (rv_extras).
 */
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D } from 'three';

export type ParityFixtureId = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i';

/** A ray in ASSET space (root at the origin, before any placement pivot). */
export interface ParityPickRay {
  origin: [number, number, number];
  direction: [number, number, number];
  /** The asset-relative path the ray must resolve to on both paths — `null`
   *  when the ray is expected to hit nothing selectable (opaque unowned chunk
   *  blocks, plan-756 Q5). */
  expect: string | null;
}

export interface ParityFixture {
  id: ParityFixtureId;
  title: string;
  /** Name of the asset root (== the scene name in the GLB). */
  rootName: string;
  build(): Group;
  pick: ParityPickRay;
  /** Plugin `bakeClaims()` a test plugin makes for this fixture (D5: main
   *  model only) — paths as the loader's pre-bake registry spells them. */
  claims?: Array<{ path: string; role: 'merge' | 'chunk' }>;
  /** Fixed steps to simulate for the behaviour snapshot (dt = 1/60 s). */
  steps: number;
}

// ─── Builders ───────────────────────────────────────────────────────────

function mesh(
  name: string,
  size: [number, number, number],
  pos: [number, number, number],
  color: number,
): Mesh {
  const m = new Mesh(new BoxGeometry(...size), new MeshStandardMaterial({ color }));
  m.name = name;
  m.position.set(...pos);
  return m;
}

function node(name: string, pos: [number, number, number] = [0, 0, 0]): Object3D {
  const n = new Object3D();
  n.name = name;
  n.position.set(...pos);
  return n;
}

function group(name: string): Group {
  const g = new Group();
  g.name = name;
  return g;
}

function extras<T extends Object3D>(target: T, rv: Record<string, unknown>): T {
  target.userData.realvirtual = { ...(target.userData.realvirtual ?? {}), ...rv };
  return target;
}

function driveRef(path: string): Record<string, unknown> {
  return { type: 'ComponentReference', path, componentType: 'realvirtual.Drive' };
}

function serial(name: string, children: Object3D[]): Object3D {
  const seq = extras(node(name), { LogicStep_SerialContainer: { AutoLoop: true } });
  for (const c of children) seq.add(c);
  return seq;
}

function driveTo(name: string, path: string, destination: number): Object3D {
  return extras(node(name), { LogicStep_DriveTo: { drive: driveRef(path), Destination: destination } });
}

// ─── (a) Arburg shape: kinematic group + Drive + LogicStep_DriveTo + PLCOutputFloat ──

function buildA(): Group {
  const root = group('Arburg');
  root.add(mesh('Frame', [2, 0.5, 1], [0, 0.25, 0], 0x777777));
  const kine = extras(node('Kine', [0, 0.5, 0]), {
    Kinematic: { IntegrateGroupEnable: true, GroupName: 'Platen' },
    Drive: { Direction: 'LinearX', TargetSpeed: 200, StartPosition: 0 },
  });
  kine.add(mesh('Carriage', [0.4, 0.2, 0.4], [0, 0.1, 0], 0x3366cc));
  root.add(kine);
  const cad = node('Cad', [0.8, 0.5, 0]);
  cad.add(extras(mesh('PlatenPart', [0.2, 0.6, 0.6], [0, 0.3, 0], 0xcc3333), { Group: { GroupName: 'Platen' } }));
  root.add(cad);
  root.add(serial('SeqCycle', [
    driveTo('MoveOut', 'Arburg/Kine', 500),
    driveTo('MoveBack', 'Arburg/Kine', 0),
  ]));
  const signals = node('Signals');
  signals.add(extras(node('MachineSpeed'), { PLCOutputFloat: { Name: 'MachineSpeed', Status: { Value: 55 } } }));
  root.add(signals);
  return root;
}

// ─── (b) KinematicParentEnable chain ─────────────────────────────────────

function buildB(): Group {
  const root = group('Chain');
  root.add(mesh('Base', [1, 0.2, 1], [0, 0.1, 0], 0x555555));
  const mount = extras(node('Mount', [0, 0.2, 0]), { Drive: { Direction: 'LinearZ', TargetSpeed: 100 } });
  mount.add(mesh('MountBody', [0.5, 0.3, 0.5], [0, 0.15, 0], 0x336699));
  root.add(mount);
  const cad = node('Cad', [1, 0, 0]);
  const kine = extras(node('Kine', [0, 0.4, 0]), {
    Kinematic: { KinematicParentEnable: true, Parent: 'Mount' },
    Drive: { Direction: 'LinearX', TargetSpeed: 100 },
  });
  kine.add(mesh('Tool', [0.2, 0.2, 0.2], [0, 0.1, 0], 0x99cc33));
  cad.add(kine);
  root.add(cad);
  return root;
}

// ─── (c) convention Sensor without Ray marker ────────────────────────────

function buildC(): Group {
  const root = group('Station');
  root.add(mesh('Table', [1, 0.1, 1], [0, 0.05, 0], 0x666666));
  const sensor = node('Sensor-1', [0, 0.3, 0]);
  sensor.add(mesh('Beam', [0.05, 0.05, 0.6], [0, 0, 0], 0x33cc33));
  root.add(sensor);
  return root;
}

// ─── (d) Group partitions ────────────────────────────────────────────────

function buildD(): Group {
  const root = group('Cabinet');
  root.add(mesh('Housing', [1, 1, 1], [0, 0.5, 0], 0x888888));
  root.add(extras(mesh('DoorL', [0.1, 0.8, 0.4], [0.55, 0.5, -0.25], 0x3355aa), { Group: { GroupName: 'Doors' } }));
  root.add(extras(mesh('DoorR', [0.1, 0.8, 0.4], [0.55, 0.5, 0.25], 0x3355aa), { Group: { GroupName: 'Doors' } }));
  root.add(extras(mesh('Lamp', [0.1, 0.1, 0.1], [0, 1.1, 0], 0xffcc00), { Group: { GroupName: 'Lights' } }));
  root.add(extras(mesh('Warn', [0.1, 0.1, 0.1], [0, 1.1, 0.3], 0xff3300), {
    Group: { GroupName: 'Doors' },
    Group_1: { GroupName: 'Lights' },
  }));
  const fan = extras(node('Fan', [-0.6, 0.5, 0]), { Drive: { Direction: 'RotationY', TargetSpeed: 90 } });
  fan.add(mesh('Blade', [0.1, 0.4, 0.4], [0, 0, 0], 0x222222));
  root.add(fan);
  return root;
}

// ─── (e) plain conveyor (naming conventions, snap ports, plugin claim) ──

function buildE(): Group {
  const root = group('Conveyor');
  root.add(mesh('frame', [2, 0.2, 0.6], [0, 0.4, 0], 0x444444));
  const drive = node('Drive-Lin-X', [0, 0.5, 0]);
  const transport = node('Transport-X');
  transport.add(mesh('belt', [2, 0.05, 0.5], [0, 0.05, 0], 0x222222));
  drive.add(transport);
  root.add(drive);
  root.add(node('Snap-XP-conv', [1, 0.5, 0]));
  root.add(node('Snap-XN-conv', [-1, 0.5, 0]));
  // A bare CAD leaf a model plugin claims at runtime (D5).
  root.add(mesh('Label', [0.2, 0.1, 0.02], [0, 0.7, 0.31], 0xffffff));
  // A WebComponent script (plan-757 §2.8): wired under the same session-wide
  // `allowScripts` rule on both paths — `webComponents.wired` must agree.
  root.add(extras(node('Controller'), {
    WebComponent: { Active: true, ApiVersion: 1, Language: 'js', TypeId: 'ParityController', Code: 'function setup(self) { return {}; }' },
  }));
  return root;
}

// ─── (f) duplicate sibling names ─────────────────────────────────────────

function buildF(): Group {
  const root = group('Twin');
  root.add(mesh('Base', [3, 0.2, 1], [0, 0.1, 0], 0x555555));
  for (const x of [-1, 1]) {
    const axis = extras(node('Axis', [x, 0.3, 0]), { Drive: { Direction: 'LinearX', TargetSpeed: 100 } });
    axis.add(mesh('Slider', [0.3, 0.2, 0.3], [0, 0.1, 0], 0x3366cc));
    root.add(axis);
  }
  return root;
}

// ─── (g) unsigned asset with a LogicStep ─────────────────────────────────

function buildG(): Group {
  const root = group('Cell');
  root.add(mesh('Floor', [1, 0.1, 1], [0, 0.05, 0], 0x666666));
  const slide = extras(node('Slide', [0, 0.2, 0]), { Drive: { Direction: 'LinearY', TargetSpeed: 300 } });
  slide.add(mesh('Head', [0.3, 0.2, 0.3], [0, 0.1, 0], 0xcc6633));
  root.add(slide);
  root.add(serial('Seq', [driveTo('Up', 'Cell/Slide', 300), driveTo('Down', 'Cell/Slide', 0)]));
  return root;
}

// ─── (h) asymmetric asset with a top-level drive (pivot offset ≠ 0) ──────

function buildH(): Group {
  const root = group('Asym');
  root.add(mesh('Base', [1, 0.4, 1], [2, 0.2, 3], 0x555555));
  const drive = node('Drive-Lin-X', [2.5, 0.4, 3]);
  drive.add(mesh('Slider', [0.3, 0.2, 0.3], [0, 0.1, 0], 0x3366cc));
  root.add(drive);
  return root;
}

// ─── (i) child named like the root ───────────────────────────────────────

function buildI(): Group {
  const root = group('Conveyor');
  root.add(mesh('Base', [2, 0.2, 0.6], [0, 0.1, 0], 0x555555));
  const inner = node('Conveyor', [0, 0.2, 0]);
  const belt = extras(node('Belt'), { Drive: { Direction: 'LinearX', TargetSpeed: 100 } });
  belt.add(mesh('BeltMesh', [1.8, 0.05, 0.5], [0, 0.05, 0], 0x222222));
  inner.add(belt);
  root.add(inner);
  root.add(serial('Seq', [driveTo('Go', 'Conveyor/Conveyor/Belt', 400), driveTo('Back', 'Conveyor/Conveyor/Belt', 0)]));
  return root;
}

// ─── The table ──────────────────────────────────────────────────────────

const DOWN: [number, number, number] = [0, -1, 0];

export const PARITY_FIXTURES: readonly ParityFixture[] = Object.freeze([
  { id: 'a', title: 'kinematic group + Drive + LogicStep_DriveTo + PLCOutputFloat (Arburg shape)', rootName: 'Arburg', build: buildA, pick: { origin: [0, 5, 0], direction: DOWN, expect: 'Kine' }, steps: 60 },
  { id: 'b', title: 'KinematicParentEnable chain', rootName: 'Chain', build: buildB, pick: { origin: [1, 5, 0], direction: DOWN, expect: 'Mount/Kine' }, steps: 60 },
  { id: 'c', title: 'convention Sensor without Ray', rootName: 'Station', build: buildC, pick: { origin: [0, 5, 0], direction: DOWN, expect: 'Sensor-1' }, steps: 60 },
  { id: 'd', title: 'Group partitions', rootName: 'Cabinet', build: buildD, pick: { origin: [-0.6, 5, 0], direction: DOWN, expect: 'Fan' }, steps: 60 },
  { id: 'e', title: 'plain conveyor', rootName: 'Conveyor', build: buildE, pick: { origin: [0.5, 5, 0], direction: DOWN, expect: 'Drive-Lin-X/Transport-X' }, claims: [{ path: 'Conveyor/Label', role: 'merge' }], steps: 60 },
  { id: 'f', title: 'duplicate sibling names', rootName: 'Twin', build: buildF, pick: { origin: [1, 5, 0], direction: DOWN, expect: 'Axis_1' }, steps: 60 },
  { id: 'g', title: 'unsigned asset with a LogicStep', rootName: 'Cell', build: buildG, pick: { origin: [0, 5, 0], direction: DOWN, expect: 'Slide' }, steps: 60 },
  { id: 'h', title: 'asymmetric asset with a top-level drive (pivot offset ≠ 0)', rootName: 'Asym', build: buildH, pick: { origin: [2.5, 5, 3], direction: DOWN, expect: 'Drive-Lin-X' }, steps: 60 },
  { id: 'i', title: 'child named like the root', rootName: 'Conveyor', build: buildI, pick: { origin: [0, 5, 0], direction: DOWN, expect: 'Conveyor_1/Belt' }, steps: 60 },
]);

export function parityFixture(id: ParityFixtureId): ParityFixture {
  const f = PARITY_FIXTURES.find((x) => x.id === id);
  if (!f) throw new Error(`parity fixture (${id}) does not exist`);
  return f;
}
