// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * The Fanuc CRX-10iA/L library robot and the plan-492 benchmark's copy of it.
 *
 * `public/library/Robots/FanucCRX-10iA-L.glb` is built by a chain of scripts
 * (`perf-extract-robot-asset.mjs` → `author-robot-physics.mjs` →
 * `author-robot-ik.mjs`), and the benchmark copy
 * `public/perf/Robots/FanucCRX-10iA-L-erratic.glb` by `build-perf-robot-asset.mjs`
 * from it. The scripts verify their own output once; this test keeps the
 * COMMITTED files honest: a re-extraction that forgets a step, a hand edit or a
 * Draco re-compression that loses extras all fail here.
 *
 * Since 2026-10-25 (Thomas: "the fanuc in the library should have a logical
 * inverse kinematic definition and not the erratic setup") the two files split:
 *
 * LIBRARY robot
 *  - one scene root `FanucCRX-10iA-L` at the origin, unrotated
 *  - NO `Drive_ErraticPosition` — it stands still until its path is switched on
 *  - a `RobotIK` on the root (its fields: `crx-library-physics.node.test.ts`)
 *  - an `IKPath` `Robotpath` with Home / PickBefore / Pick / PlaceBefore / Place,
 *    `StartPath` false (the start switch, default OFF), `LoopPath` true, whose
 *    baked `AxisPos` lie inside the drive limits and REACH their target node —
 *    checked with the runtime's own forward kinematics (`chainFk`) over the
 *    runtime's own chain derivation, not with the script's solver
 *  - listed in the library catalog as `robots-fanuccrx-10ia-l`
 *
 * BENCHMARK copy
 *  - the same root, no `RobotIK`, no `Robotpath`
 *  - `Drive_ErraticPosition` in iterate mode without `SignalEnable` on A1..A6
 *    (deterministic min/max sweep, no `Math.random`, no PLC signal)
 *  - NOT in the library catalog
 *
 * Both: no demo bindings (`rigidbody`, `AASLink`, `Grip`, …) and no
 * `ComponentReference` leaving the asset subtree — every path is rooted at
 * `FanucCRX-10iA-L`, so two placements can be rewritten onto their own
 * placement path (plan-492 R4).
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO, type Document, type Node as GltfNode } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import type { Object3D } from 'three';
import { loadGlbAsThree } from '../scripts/lib/rv-glb-three.mjs';
import { driveView } from '../scripts/author-robot-ik.mjs';
import { chainFromDerivation, deriveSerialAxisChain } from '../src/core/engine/rv-robot-rig';
import { chainFk, orientationErrorDeg, positionErrorMm, type Quat, type Vec3 } from '../src/core/engine/rv-robot-fk';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSET = resolve(ROOT, 'public/library/Robots/FanucCRX-10iA-L.glb');
const PERF_ASSET = resolve(ROOT, 'public/perf/Robots/FanucCRX-10iA-L-erratic.glb');
// plan-778 Phase 4: the bundled library is a project — its manifest replaces catalog.json.
const LIBRARY_PROJECT = resolve(ROOT, 'public/library/project.json');

const ROOT_NAME = 'FanucCRX-10iA-L';
const AXES = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'] as const;
const TARGETS = ['Home', 'PickBefore', 'Pick', 'PlaceBefore', 'Place'] as const;
/** Keys the extraction strips because they bind the robot to the demo cell. */
const STRIPPED_KEYS = ['rigidbody', 'AASLink', 'Grip', 'colliders', 'ConnectSignal'];

type RvExtras = Record<string, unknown>;

/** Read a Draco-compressed GLB (the library assets are all `edgebreaker`). */
async function readWithDraco(path: string): Promise<Document> {
  const decoder = await draco3d.createDecoderModule();
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'draco3d.decoder': decoder });
  return io.read(path);
}

/** Every `ComponentReference.path` anywhere inside `value`, with its field trail. */
function collectRefPaths(value: unknown, where: string, out: Array<{ where: string; path: string }>): void {
  if (!value || typeof value !== 'object') return;
  const obj = value as Record<string, unknown>;
  if (obj.type === 'ComponentReference' && typeof obj.path === 'string') {
    out.push({ where, path: obj.path });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectRefPaths(v, `${where}[${i}]`, out));
    return;
  }
  for (const [k, v] of Object.entries(obj)) collectRefPaths(v, `${where}.${k}`, out);
}

interface Loaded { doc: Document; nodes: GltfNode[]; rvByName: Map<string, RvExtras> }

async function load(path: string): Promise<Loaded> {
  const doc = await readWithDraco(path);
  const nodes = doc.getRoot().listNodes();
  const rvByName = new Map(nodes.map((n) => [
    n.getName(),
    ((n.getExtras() ?? {}) as { realvirtual?: RvExtras }).realvirtual ?? {},
  ]));
  return { doc, nodes, rvByName };
}

/** The assertions both files share. */
function sharedShape(get: () => Loaded): void {
  it('is a single scene root at the origin', () => {
    const scenes = get().doc.getRoot().listScenes();
    expect(scenes).toHaveLength(1);
    const children = scenes[0].listChildren();
    expect(children).toHaveLength(1);
    expect(children[0].getName()).toBe(ROOT_NAME);
    expect(children[0].getTranslation()).toEqual([0, 0, 0]);
    expect(children[0].getRotation()).toEqual([0, 0, 0, 1]);
    expect(children[0].getScale()).toEqual([1, 1, 1]);
  });

  it('keeps the axis and gripper drives', () => {
    const drives = [...get().rvByName.entries()].filter(([, rv]) => rv.Drive).map(([name]) => name);
    expect(drives.length).toBeGreaterThanOrEqual(6);
    for (const axis of AXES) expect(drives).toContain(axis);
  });

  it('carries no demo binding left over', () => {
    const offenders: string[] = [];
    for (const [name, rv] of get().rvByName) {
      for (const key of STRIPPED_KEYS) if (key in rv) offenders.push(`${name}.${key}`);
    }
    expect(offenders).toEqual([]);
  });

  it('has no ComponentReference leaving the asset subtree (R4 precondition)', () => {
    const refs: Array<{ where: string; path: string }> = [];
    for (const node of get().nodes) collectRefPaths(get().rvByName.get(node.getName()) ?? {}, node.getName(), refs);
    const escaping = refs.filter((r) => r.path !== ROOT_NAME && !r.path.startsWith(`${ROOT_NAME}/`));
    expect(escaping, 'every reference is rooted at the asset root').toEqual([]);
  });
}

describe('public/library/Robots/FanucCRX-10iA-L.glb — the library robot', () => {
  let lib: Loaded;
  beforeAll(async () => { lib = await load(ASSET); }, 60_000);

  sharedShape(() => lib);

  it('carries NO erratic sweep — it stands still until its path is switched on', () => {
    const withErratic = [...lib.rvByName.entries()].filter(([, rv]) => rv.Drive_ErraticPosition).map(([n]) => n);
    expect(withErratic).toEqual([]);
  });

  it('carries exactly one RobotIK, on the root, naming the six axes and the TCP', () => {
    const carriers = [...lib.rvByName.entries()].filter(([, rv]) => rv.RobotIK).map(([n]) => n);
    expect(carriers).toEqual([ROOT_NAME]);
    const rig = lib.rvByName.get(ROOT_NAME)!.RobotIK as Record<string, unknown>;
    let path = ROOT_NAME;
    const axisPaths = AXES.map((a) => (path += `/${a}`));
    expect((rig.Axis as Array<{ path: string }>).map((r) => r.path)).toEqual(axisPaths);
    expect(rig.TCP).toBe(`${axisPaths[5]}/TCP`);
    expect(rig.WristType).toBe('NonSpherical');
  });

  it('has a demo IKPath Robotpath: five targets in order, start switch OFF, looping', () => {
    const ik = lib.rvByName.get('Robotpath')!.IKPath as Record<string, unknown>;
    expect(ik, 'IKPath on Robotpath').toBeDefined();
    expect(ik.StartPath).toBe(false);
    expect(ik.LoopPath).toBe(true);
    expect((ik.Path as Array<{ path: string }>).map((r) => r.path))
      .toEqual(TARGETS.map((t) => `${ROOT_NAME}/Robotpath/${t}`));
    for (const t of TARGETS) {
      const target = lib.rvByName.get(t)!.IKTarget as Record<string, unknown>;
      expect(target, `IKTarget on ${t}`).toBeDefined();
      expect(target.AxisPos as number[]).toHaveLength(6);
    }
    // The approach and the retreat are straight lines; the transfers are PTP.
    expect((lib.rvByName.get('Pick')!.IKTarget as RvExtras).InterpolationToTarget).toBe('Linear');
    expect((lib.rvByName.get('Place')!.IKTarget as RvExtras).InterpolationToTarget).toBe('Linear');
  });

  it('bakes AxisPos that lie inside the drive limits and REACH their targets (runtime FK)', async () => {
    const tree = await loadGlbAsThree(ASSET);
    const root = tree.byPath.get(ROOT_NAME)!;
    const drives: ReturnType<typeof driveView>[] = [];
    root.traverse((n: Object3D) => { if (n.userData?.realvirtual?.Drive) drives.push(driveView(n)); });
    const derivation = deriveSerialAxisChain(root, drives as never);
    expect(derivation.failure).toBeNull();
    const chain = chainFromDerivation(root, derivation)!;
    expect(chain).not.toBeNull();

    for (const t of TARGETS) {
      const node = tree.byPath.get(`${ROOT_NAME}/Robotpath/${t}`)!;
      const q = node.userData.realvirtual.IKTarget.AxisPos as number[];
      q.forEach((deg, i) => {
        const d = drives.find((v) => v.node.name === AXES[i])!;
        expect(deg, `${t} ${AXES[i]}`).toBeGreaterThanOrEqual(d.LowerLimit);
        expect(deg, `${t} ${AXES[i]}`).toBeLessThanOrEqual(d.UpperLimit);
      });
      // Robotpath sits at identity under the root, so the target's local pose IS
      // its pose in the robot base frame — the frame chainFk answers in.
      const fk = chainFk(chain, q).tcp;
      const pos: Vec3 = [node.position.x, node.position.y, node.position.z];
      const quat: Quat = [node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w];
      expect(positionErrorMm(fk.pos, pos), `${t} position`).toBeLessThan(0.05);
      expect(orientationErrorDeg(fk.quat, quat), `${t} orientation`).toBeLessThan(0.05);
    }
  }, 60_000);

  it('is listed in the library project as robots-fanuccrx-10ia-l — and the benchmark copy is not', async () => {
    const project = JSON.parse(await readFile(LIBRARY_PROJECT, 'utf8')) as {
      documents: Array<{ id: string; name: string; path: string; collections?: string[] }>;
    };
    const row = project.documents.find((d) => d.id === 'robots-fanuccrx-10ia-l');
    expect(row, 'library document present').toBeDefined();
    expect(row!.path).toBe('Robots/FanucCRX-10iA-L.glb');
    expect(project.documents.filter((d) => /erratic/i.test(d.path))).toEqual([]);
  });
});

describe('public/perf/Robots/FanucCRX-10iA-L-erratic.glb — the plan-492 benchmark copy', () => {
  let perf: Loaded;
  beforeAll(async () => { perf = await load(PERF_ASSET); }, 60_000);

  sharedShape(() => perf);

  it('carries 6 iterate-mode erratic drivers on A1..A6 with no SignalEnable', () => {
    for (const axis of AXES) {
      const rv = perf.rvByName.get(axis);
      expect(rv, `node "${axis}" exists`).toBeDefined();
      expect(rv!.Drive, `${axis} has a Drive`).toBeDefined();
      const erratic = rv!.Drive_ErraticPosition as Record<string, unknown> | undefined;
      expect(erratic, `${axis} has Drive_ErraticPosition`).toBeDefined();
      expect(erratic!.IterateBetweenMaxAndMin).toBe(true);
      expect(erratic!.SignalEnable).toBeNull();
      // A sweep needs a non-degenerate range and a speed, else the axis parks.
      expect(erratic!.MaxPos as number).toBeGreaterThan(erratic!.MinPos as number);
      expect(erratic!.Speed as number).toBeGreaterThan(0);
    }
    const withErratic = [...perf.rvByName.values()].filter((rv) => rv.Drive_ErraticPosition).length;
    expect(withErratic, 'exactly the six axes sweep').toBe(6);
  });

  it('carries no robot definition — no RobotIK, no IKPath, no IKTarget', () => {
    for (const [name, rv] of perf.rvByName) {
      for (const key of ['RobotIK', 'IKPath', 'IKTarget']) expect(Object.keys(rv), name).not.toContain(key);
    }
    expect(perf.rvByName.has('Robotpath')).toBe(false);
  });

  it('is the library robot otherwise: same nodes minus the path, same physics', async () => {
    const lib = await load(ASSET);
    const libNames = [...lib.rvByName.keys()].filter((n) => !['Robotpath', ...TARGETS].includes(n)).sort();
    expect([...perf.rvByName.keys()].sort()).toEqual(libNames);
    for (const axis of AXES) {
      expect(perf.rvByName.get(axis)!.Drive).toEqual(lib.rvByName.get(axis)!.Drive);
      expect(perf.rvByName.get(axis)!.DynamicAxis).toEqual(lib.rvByName.get(axis)!.DynamicAxis);
    }
  }, 60_000);
});
