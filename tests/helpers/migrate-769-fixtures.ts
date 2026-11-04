// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 Phase 1a — fixtures for the migration on load (9.2 / 9.3 / 9.16 / 9.20 / 9.21).
 *
 * "Unity" files: references are path strings in `userData.realvirtual`, no NodeIds
 * anywhere, different geometry sizes (GLTFExporter merges identical meshes).
 */
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Scene } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

export const CR = (path: string, componentType = 'realvirtual.Drive') => ({ type: 'ComponentReference', path, componentType });

export function box(name: string, size: number): Mesh {
  const m = new Mesh(new BoxGeometry(size, size, size), new MeshBasicMaterial());
  m.name = name;
  return m;
}

export function node(name: string, extras?: Record<string, unknown>): Object3D {
  const n = new Object3D();
  n.name = name;
  if (extras) n.userData.realvirtual = extras;
  return n;
}

export async function sceneToGlb(scene: Scene): Promise<ArrayBuffer> {
  return (await new GLTFExporter().parseAsync(scene, { binary: true })) as ArrayBuffer;
}

const DRIVE = { Direction: 'LinearX', TargetSpeed: 100 };

/**
 * The Mauser core (plan-769 9.2): two `Sep`s with a `Pin` each, the SECOND one
 * renamed by the loader (`Sep_1`, `Pin_1`) AND re-parented by its Kinematic hook
 * under `Mount`. References are written in the AUTHORED names.
 *
 *   Cell                                 (scene = model root)
 *    ├─ CadA/Sep (Drive)/Pin (mesh 0.1)  ← the wrong candidate a guess can hit
 *    ├─ CadB/Sep (Drive, Kinematic → Mount)/Pin (mesh 0.2)
 *    ├─ Mount
 *    ├─ Slave  Drive + Drive_Gear.MasterDrive = "CadB/Sep"
 *    └─ Panel  CRI steps[0].targetObjects = ["CadB/Sep/Pin"], Signals: CR "CadB/Sep" (Drive) in a list
 */
export async function buildMauserCoreGlb(): Promise<ArrayBuffer> {
  const scene = new Scene();
  scene.name = 'Cell';
  const cadA = node('CadA');
  cadA.position.set(-2, 0, 0);
  const sepA = node('Sep', { Drive: { ...DRIVE } });
  sepA.add(box('Pin', 0.1));
  cadA.add(sepA);
  const cadB = node('CadB');
  cadB.position.set(2, 0, 0);
  const sepB = node('Sep', {
    Kinematic: { KinematicParentEnable: true, Parent: 'Mount' },
    Drive: { ...DRIVE, TargetSpeed: 222 },
  });
  sepB.add(box('Pin', 0.2));
  cadB.add(sepB);
  const mount = node('Mount');
  mount.position.set(0, 1, 0);
  const slave = node('Slave', {
    Drive: { ...DRIVE },
    Drive_Gear: { MasterDrive: CR('CadB/Sep'), GearFactor: 2, Offset: 0 },
  });
  const panel = node('Panel', {
    CustomRuntimeInstruction: { steps: [{ instruction: 'look at the pin', targetObjects: ['CadB/Sep/Pin'] }] },
  });
  scene.add(cadA, cadB, mount, slave, panel);
  return sceneToGlb(scene);
}

/**
 * The content-root case (Phase-0 finding "Scope-Wurzel", PalletScanner): the
 * scene is a wrapper (`AuxScene`), references are written relative to the Unity
 * root `Machine`, and the guessing stages see TWO `Static/Axis` candidates.
 *
 *   AuxScene
 *    └─ Machine
 *        ├─ Other/Static/Axis (Drive 999)   ← FIRST in glTF order: keeps the loader names "Static"/"Axis"
 *        ├─ Static/Axis       (Drive 111)   ← "Static/Axis" as authored (loads as Static_1/Axis_1)
 *        ├─ Slave  Drive + Drive_Gear.MasterDrive = "Static/Axis"
 *        └─ Body   (mesh)
 */
export async function buildContentRootGlb(): Promise<ArrayBuffer> {
  const scene = new Scene();
  scene.name = 'AuxScene';
  const machine = node('Machine');
  const stat = node('Static');
  stat.add(node('Axis', { Drive: { ...DRIVE, TargetSpeed: 111 } }));
  const other = node('Other');
  const stat2 = node('Static');
  stat2.add(node('Axis', { Drive: { ...DRIVE, TargetSpeed: 999 } }));
  other.add(stat2);
  const slave = node('Slave', {
    Drive: { ...DRIVE },
    Drive_Gear: { MasterDrive: CR('Static/Axis'), GearFactor: 1, Offset: 0 },
  });
  machine.add(other, stat, slave, box('Body', 0.3));
  scene.add(machine);
  return sceneToGlb(scene);
}

/**
 * plan-769 Phase 1b — one file for every STORED-reference reader (9.2 extension).
 * The Mauser core (CadB/Sep renamed `Sep_1` + re-parented under Mount) plus one
 * referrer per reader. Each reader has a target that only the file's verdict
 * names correctly, and one that only a guessing stage would reach:
 *
 *   Cell
 *    ├─ CadA/Sep (Drive 111)/Pin (mesh 0.1)       ← the wrong candidate of every guess
 *    ├─ Slave  Drive + Drive_Gear.MasterDrive = "CadB/Sep"   (BEFORE CadB: drive order matters)
 *    ├─ CadB/Sep (Drive 222, Kinematic → Mount)/Pin (mesh 0.2)
 *    ├─ Mount
 *    ├─ Panel  CRI targets ["CadB/Sep/Pin", "Sep/Pin"]          (2nd: no such authored path)
 *    ├─ Vis    WebVisibility.AdditionalTargets [CR "CadB/Sep/Pin", CR "Sep/Pin"]
 *    ├─ Zone   WebPhysicsZone (WholeScene) StaticColliders ["CadB/Sep/Pin", "Sep/Pin"]
 *    └─ Src    Source.ThisObjectAsMU = "Pin"                     (two "Pin" in the file: ambiguous)
 */
export async function buildStoredReadersGlb(): Promise<ArrayBuffer> {
  const scene = new Scene();
  scene.name = 'Cell';
  const cadA = node('CadA');
  cadA.position.set(-2, 0, 0);
  const sepA = node('Sep', { Drive: { ...DRIVE, TargetSpeed: 111 } });
  sepA.add(box('Pin', 0.1));
  cadA.add(sepA);
  const slave = node('Slave', {
    Drive: { ...DRIVE },
    Drive_Gear: { MasterDrive: CR('CadB/Sep'), GearFactor: 2, Offset: 0 },
  });
  const cadB = node('CadB');
  cadB.position.set(2, 0, 0);
  const sepB = node('Sep', {
    Kinematic: { KinematicParentEnable: true, Parent: 'Mount' },
    Drive: { ...DRIVE, TargetSpeed: 222 },
  });
  sepB.add(box('Pin', 0.2));
  cadB.add(sepB);
  const mount = node('Mount');
  mount.position.set(0, 1, 0);
  // A bindable slot (Forward) for the persistence-read case of 9.14.
  mount.add(node('Belt', { Drive: { ...DRIVE, TargetSpeed: 333 }, Drive_Simple: {} }));
  const panel = node('Panel', {
    CustomRuntimeInstruction: { steps: [{ instruction: 'look', targetObjects: ['CadB/Sep/Pin', 'Sep/Pin'] }] },
  });
  const vis = node('Vis', {
    WebVisibility: {
      DefaultVisible: true,
      AdditionalTargets: [CR('CadB/Sep/Pin', 'UnityEngine.Transform'), CR('Sep/Pin', 'UnityEngine.Transform')],
    },
  });
  const zone = node('Zone', { WebPhysicsZone: { ZoneEnabled: true, WholeScene: true, StaticColliders: ['CadB/Sep/Pin', 'Sep/Pin'] } });
  const src = node('Src', { Source: { ThisObjectAsMU: 'Pin', Interval: 0, AutomaticGeneration: false } });
  src.add(box('SrcBody', 0.3));
  scene.add(cadA, slave, cadB, mount, panel, vis, zone, src);
  return sceneToGlb(scene);
}

/** Every node of `root` whose name is `name`. */
export function allNamed(root: Object3D, name: string): Object3D[] {
  const out: Object3D[] = [];
  root.traverse((n) => { if (n.name === name) out.push(n); });
  return out;
}

/** The node carrying a Drive with `TargetSpeed === speed` (authored marker). */
export function driveNodeBySpeed(root: Object3D, speed: number): Object3D | null {
  let hit: Object3D | null = null;
  root.traverse((n) => {
    const d = (n.userData?.realvirtual as { Drive?: { TargetSpeed?: number } } | undefined)?.Drive;
    if (!hit && d?.TargetSpeed === speed) hit = n;
  });
  return hit;
}
