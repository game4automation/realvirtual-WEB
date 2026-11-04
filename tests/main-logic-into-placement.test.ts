// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 test 9.23 (Phase 6, D20) — the main model's LogicSteps are built ONCE,
 * against the complete scene.
 *
 * Befund 2026-10-23: a `LogicStep_DriveTo` in a MAIN document addressed
 * `<placement>#<drive>` into a placed asset ran with `drive = null` and finished at
 * once — `loadGLB` built the steps before the placements existed. Now the viewer
 * merges the model root's steps through `mergePlacedLogic` after the scene is
 * complete (placements materialised), the same function a placement uses.
 *
 *  - `p#id` (placement) and `p/b#id` (nested placement) → after `whenSceneReady()`
 *    the step holds the placed drive, and the drive moves to the destination;
 *  - every placement still brings its own steps exactly once (the main merge
 *    skips placement content);
 *  - a document WITHOUT placements has its engine as before: right after
 *    `loadModel` resolves, started;
 *  - a superseded load attaches nothing;
 *  - `viewer.whenModelLogicBuilt()` names that moment: resolved at `model-loaded`
 *    without placements; with placements pending until the settle, then resolved
 *    BEFORE any `whenSceneReady()` continuation (measured, both call orders);
 *    released without a build when the load is superseded.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { ModelCache } from '../src/core/engine/rv-model-cache';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { setNodeId } from '../src/core/engine/rv-node-id';
import { RVDriveTo, RVSerialContainer, type RVLogicStep } from '../src/core/engine/rv-logic-step';
import { RVLogicEngine } from '../src/core/engine/rv-logic-engine';
import type { RVDrive } from '../src/core/engine/rv-drive';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { group, withComponent } from './fixtures/bake-fixture';
import { findByName, makeOuter, referenceNode, tick } from './helpers/nested-placement-fixture';

const ARM_URL = 'blob:rv-test/p769-arm.glb';
const ROBOT_URL = 'blob:rv-test/p769-robot.glb';
const JOINT_ID = 'nid-joint';
const ARM_REF_ID = 'nid-arm';
const PLC_ARM = 'plc-arm';
const PLC_ROBOT = 'plc-robot';

/** The placed asset: a base mesh, a `Joint` drive (still, NodeId `nid-joint`) and one sequence of its own. */
function makeArm(): Group {
  const root = group('Arm');
  const base = new Mesh(new BoxGeometry(0.4, 0.2, 0.4), new MeshStandardMaterial({ color: 0x556677 }));
  base.name = 'Base';
  base.position.set(0, 0.1, 0);
  root.add(base);
  const joint = withComponent(group('Joint'), 'Drive', {
    Direction: 'LinearX', TargetSpeed: 500, UseAcceleration: false, UseLimits: false, JogForward: false,
  });
  setNodeId(joint, JOINT_ID);
  joint.position.set(0, 0.3, 0);
  const tool = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial({ color: 0x88aa22 }));
  tool.name = 'Tool';
  joint.add(tool);
  root.add(joint);
  // The asset's OWN logic — merged by the placement, never a second time by the main model.
  const own = withComponent(group('ArmIdle'), 'LogicStep_SerialContainer', {});
  own.add(withComponent(group('Wait'), 'LogicStep_Delay', { Duration: 100 }));
  root.add(own);
  return root;
}

function treeFor(url: string): Group {
  if (url === ARM_URL) return makeArm();
  if (url === ROBOT_URL) return makeOuter('Robot', [{ name: 'Arm_1', id: ARM_REF_ID, url: ARM_URL, planner: true, pos: [1, 0, 0] }]);
  throw new Error(`fake loader: unknown url ${url}`);
}

/** A fake loader serving {@link treeFor}; `gate` holds that url's decode until `open()`. */
function fakeLoader(gate?: string): { loader: GLTFLoader; open(): void } {
  let openGate!: () => void;
  const held = new Promise<void>((r) => { openGate = r; });
  const loader = {
    loadAsync: async (url: string): Promise<{ scene: Group }> => {
      if (gate && url === gate) await held;
      return { scene: treeFor(url) };
    },
  } as unknown as GLTFLoader;
  return { loader, open: () => openGate() };
}

let h: TestViewerHandle | null = null;
afterEach(() => { h?.dispose(); h = null; });

async function boot(gate?: string): Promise<{ h: TestViewerHandle; open(): void }> {
  h = await createTestViewer('webgl');
  const { loader, open } = fakeLoader(gate);
  h.viewer.placements.setModelCache(new ModelCache(loader, {
    uber: () => h!.viewer.placementUberMaterial,
    isWebGPU: () => h!.viewer.isWebGPU,
    pickPort: () => createPickBuildPort({ createWorker: () => null }),
  }));
  // Only `tick()` advances time.
  h.viewer.setSimulationPaused('main-logic-test', true);
  return { h, open };
}

const driveRef = (address: string) => ({ type: 'ComponentReference', address, componentType: 'realvirtual.Drive' });

/** A top-level sequence `name` → one `LogicStep_DriveTo` with the given drive reference. */
function sequence(name: string, drive: unknown, destination: number): Object3D {
  const seq = withComponent(group(name), 'LogicStep_SerialContainer', {});
  seq.add(withComponent(group(`${name}_Move`), 'LogicStep_DriveTo', { drive, Destination: destination, Relative: false }));
  return seq;
}

/** Layout: `ArmP` → Arm, `RobotP` → Robot (→ nested `Arm_1`), and two sequences addressed into them. */
async function layoutBytes(): Promise<ArrayBuffer> {
  const doc = new Group();
  doc.name = 'Layout';
  doc.add(referenceNode('ArmP', PLC_ARM, ARM_URL, true, [0, 0, 0]));
  doc.add(referenceNode('RobotP', PLC_ROBOT, ROBOT_URL, true, [4, 0, 0]));
  doc.add(sequence('SeqPlaced', driveRef(`${PLC_ARM}#${JOINT_ID}`), 100));
  doc.add(sequence('SeqNested', driveRef(`${PLC_ROBOT}/${ARM_REF_ID}#${JOINT_ID}`), 50));
  return objectToGlb(doc);
}

/** A document without placements: its own drive and a sequence addressed to it. */
async function plainBytes(): Promise<ArrayBuffer> {
  const doc = new Group();
  doc.name = 'Plain';
  const box = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0x884422 }));
  box.name = 'Box';
  doc.add(box);
  const axis = withComponent(group('Axis'), 'Drive', { Direction: 'LinearX', TargetSpeed: 500, UseAcceleration: false, UseLimits: false });
  setNodeId(axis, 'nid-axis');
  doc.add(axis);
  doc.add(sequence('SeqOwn', driveRef('#nid-axis'), 80));
  return objectToGlb(doc);
}

function rootNamed(roots: readonly RVLogicStep[], name: string): RVSerialContainer {
  const r = roots.find((s) => s.name === name);
  if (!r) throw new Error(`no root "${name}" (have: ${roots.map((s) => s.name).join(', ')})`);
  return r as RVSerialContainer;
}

function driveToOf(root: RVSerialContainer): RVDriveTo {
  const step = root.children[0];
  expect(step).toBeInstanceOf(RVDriveTo);
  return step as RVDriveTo;
}

function jointDriveUnder(placement: Object3D | null): RVDrive {
  const joint = placement ? findByName(placement, 'Joint') : null;
  expect(joint).not.toBeNull();
  const drive = h!.viewer.drives.find((d) => d.node === joint);
  expect(drive).toBeDefined();
  return drive!;
}

describe('9.23 main-model logic into placements (D20)', () => {
  it('p#id and p/b#id: after whenSceneReady the steps hold the placed drives and move them', async () => {
    const { h } = await boot();
    await h.viewer.loadModel('layout.glb', { data: await layoutBytes() });
    await h.viewer.whenSceneReady();

    const engine = h.viewer.logicEngine;
    expect(engine).not.toBeNull();
    expect(engine!.isStarted).toBe(true);
    const modelRoot = h.viewer.currentModelRoot!;
    const placedDrive = jointDriveUnder(findByName(modelRoot, 'ArmP'));
    const nestedDrive = jointDriveUnder(findByName(findByName(modelRoot, 'RobotP')!, 'Arm_1'));
    expect(placedDrive).not.toBe(nestedDrive);

    const placedStep = driveToOf(rootNamed(engine!.roots, 'SeqPlaced'));
    const nestedStep = driveToOf(rootNamed(engine!.roots, 'SeqNested'));
    expect(placedStep.drive).toBe(placedDrive);
    expect(nestedStep.drive).toBe(nestedDrive);

    // Each placement's own sequence once, the main model's two once — nothing twice.
    expect(engine!.roots.filter((r) => r.name === 'ArmIdle')).toHaveLength(2);
    expect(engine!.roots.filter((r) => r.name === 'SeqPlaced')).toHaveLength(1);
    expect(engine!.roots.filter((r) => r.name === 'SeqNested')).toHaveLength(1);
    expect(engine!.roots).toHaveLength(4);

    tick(h, 60); // 1 s at 500 mm/s — both destinations reached
    expect(placedDrive.currentPosition).toBeCloseTo(100, 3);
    expect(nestedDrive.currentPosition).toBeCloseTo(50, 3);
  });

  it('a document without placements: the engine is there right after loadModel, started, as before', async () => {
    const { h } = await boot();
    await h.viewer.loadModel('plain.glb', { data: await plainBytes() });
    // Not awaiting whenSceneReady on purpose — nothing to wait for.
    const engine = h.viewer.logicEngine;
    expect(engine).not.toBeNull();
    expect(engine!.isStarted).toBe(true);
    const step = driveToOf(rootNamed(engine!.roots, 'SeqOwn'));
    const axis = h.viewer.drives.find((d) => d.node.name === 'Axis');
    expect(step.drive).toBe(axis);
    tick(h, 60);
    expect(axis!.currentPosition).toBeCloseTo(80, 3);
  });

  it('a superseded load attaches nothing', async () => {
    const { h, open } = await boot(ARM_URL);
    await h.viewer.loadModel('layout.glb', { data: await layoutBytes() });
    expect(h.viewer.placements.state).toBe('materializing'); // the Arm decode is held
    const layoutRoot = h.viewer.currentModelRoot!;
    // Whatever the teardown does with an engine afterwards: the overtaken
    // document's steps are never BUILT (its deferred attach sees the abort).
    const merged = vi.spyOn(RVLogicEngine.prototype, 'addSubtree');
    // The next document replaces it before its scene was complete.
    await h.viewer.loadModel('plain.glb', { data: await plainBytes() });
    open();
    await h.viewer.whenSceneReady();
    await new Promise((r) => setTimeout(r, 50));

    const engine = h.viewer.logicEngine!;
    expect(engine.roots.map((r) => r.name)).toEqual(['SeqOwn']);
    expect(h.viewer.currentModelRoot).not.toBe(layoutRoot);
    expect(merged.mock.calls.some(([root]) => root === layoutRoot)).toBe(false);
    merged.mockRestore();
  });
});

/** Settled-state probe: true when `p` has resolved by the time pending microtasks ran. */
async function isSettled(p: Promise<void>): Promise<boolean> {
  let done = false;
  void p.then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 0));
  return done;
}

describe('viewer.whenModelLogicBuilt() — the moment the document\'s own LogicSteps exist (D20)', () => {
  it('no placements: already resolved at model-loaded, with the steps built', async () => {
    const { h } = await boot();
    const seen: { atModelLoaded?: Promise<void>; rootsAtResolve?: string[] } = {};
    const off = h.viewer.on('model-loaded', () => {
      const p = h.viewer.whenModelLogicBuilt();
      seen.atModelLoaded = p;
      void p.then(() => { seen.rootsAtResolve = h.viewer.logicEngine?.roots.map((r) => r.name) ?? []; });
    });
    await h.viewer.loadModel('plain.glb', { data: await plainBytes() });
    off();
    expect(seen.atModelLoaded).toBeDefined();
    expect(await isSettled(seen.atModelLoaded!)).toBe(true);
    expect(seen.rootsAtResolve).toEqual(['SeqOwn']);
    // Already built → a later call resolves at once, too.
    expect(await isSettled(h.viewer.whenModelLogicBuilt())).toBe(true);
  });

  it('with placements: pending until the settle, then resolves BEFORE whenSceneReady with the placed drives bound', async () => {
    const { h, open } = await boot(ARM_URL);
    await h.viewer.loadModel('layout.glb', { data: await layoutBytes() });
    expect(h.viewer.placements.state).toBe('materializing'); // the Arm decode is held

    const order: string[] = [];
    const seen: { atLogic?: { roots: string[]; placedDriveBound: boolean } } = {};
    // whenSceneReady started FIRST and AFTER — the logic continuation precedes both.
    const sceneBefore = h.viewer.whenSceneReady().then(() => { order.push('scene-before'); });
    const logic = h.viewer.whenModelLogicBuilt().then(() => {
      order.push('logic');
      const engine = h.viewer.logicEngine;
      const roots = engine?.roots.map((r) => r.name) ?? [];
      const step = engine ? driveToOf(rootNamed(engine.roots, 'SeqPlaced')) : null;
      const joint = findByName(findByName(h.viewer.currentModelRoot!, 'ArmP')!, 'Joint');
      seen.atLogic = { roots, placedDriveBound: !!step?.drive && step.drive.node === joint };
    });
    const sceneAfter = h.viewer.whenSceneReady().then(() => { order.push('scene-after'); });
    // The plugin pattern: await the logic, THEN the scene — sees the roots built.
    const chained = h.viewer.whenModelLogicBuilt().then(async () => {
      const builtNow = !!h.viewer.logicEngine?.roots.some((r) => r.name === 'SeqPlaced');
      await h.viewer.whenSceneReady();
      order.push(`chained:${builtNow}`);
    });

    expect(await isSettled(logic)).toBe(false); // nothing built while the placements are pending
    expect(h.viewer.logicEngine?.roots.some((r) => r.name === 'SeqPlaced') ?? false).toBe(false);

    open();
    await Promise.all([sceneBefore, logic, sceneAfter, chained]);
    expect(order[0]).toBe('logic');
    expect(order).toContain('chained:true');
    expect(order.indexOf('logic')).toBeLessThan(order.indexOf('scene-before'));
    expect(order.indexOf('logic')).toBeLessThan(order.indexOf('scene-after'));
    expect(seen.atLogic).toBeDefined();
    expect(seen.atLogic!.roots).toEqual(expect.arrayContaining(['SeqPlaced', 'SeqNested', 'ArmIdle']));
    expect(seen.atLogic!.placedDriveBound).toBe(true);
  });

  it('a superseded load: the old promise resolves without its steps being built', async () => {
    const { h, open } = await boot(ARM_URL);
    await h.viewer.loadModel('layout.glb', { data: await layoutBytes() });
    expect(h.viewer.placements.state).toBe('materializing');
    const layoutRoot = h.viewer.currentModelRoot!;
    const old = h.viewer.whenModelLogicBuilt();
    expect(await isSettled(old)).toBe(false);
    const merged = vi.spyOn(RVLogicEngine.prototype, 'addSubtree');

    const next = h.viewer.loadModel('plain.glb', { data: await plainBytes() });
    // Released by the supersede (clearModel), not by a build of the old document.
    expect(await isSettled(old)).toBe(true);
    await next;
    open();
    await h.viewer.whenSceneReady();
    await new Promise((r) => setTimeout(r, 50));

    expect(merged.mock.calls.some(([root]) => root === layoutRoot)).toBe(false);
    expect(h.viewer.logicEngine!.roots.map((r) => r.name)).toEqual(['SeqOwn']);
    expect(await isSettled(h.viewer.whenModelLogicBuilt())).toBe(true); // the new document's
    merged.mockRestore();
  });
});
