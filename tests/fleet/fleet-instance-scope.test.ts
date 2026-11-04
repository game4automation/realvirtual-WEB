// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-559 §9.8 (Phase 2a) — the instance principle without a vehicle id.
 *
 * Real viewer, synthetic asset (a small `Cart`, not the Stapler GLB — the real
 * asset carries the fleet behaviour plan-648 is rewriting; the principle under
 * test is the naming, which the synthetic asset exercises the same way):
 *
 *   Cart: Body (mesh) / Lift {Drive LinearX} / Fork (mesh)
 *         Signals / Run      {PLCInputBool, Generated — the runtime-created kind}
 *                 / Occupied {PLCOutputBool, authored}
 *
 *  a. two PLACEMENTS of the Cart → `Inst1.Run` / `Inst2.Run` separate, the
 *     drive of instance 2 moves only instance 2 (sim time, fixed ticks);
 *  b. two EMBEDDED copies WITH `InstanceScope` → `CartA.Run` / `CartB.Run`;
 *     a third copy whose `PrefixNode` points at `Factory/Labels/Vehicle7` → `Vehicle7.Run`;
 *  c. the same copies WITHOUT the marker → names exactly as before (`Run`,
 *     shared) and exactly ONE `instance-signal-collision` per colliding name,
 *     naming every claiming node path;
 *  d. two path nodes with one id → ONE `path-id-collision` with both node
 *     paths; the network keeps one path under the id (last registration wins,
 *     as before);
 *  e. (2b) a reload of the SAME document without the collisions leaves no
 *     stale `signal-name-collision` / `instance-signal-collision` /
 *     `path-id-collision` entry (`clearModel`);
 *  f. (2b) disposing a path that does not own its id keeps the owner's path in
 *     the network; the collision entry follows the remaining claimants.
 *
 * Every comparison first proves the value exists (#211). No wall clock: motion
 * is measured over `_tickOnce` steps of the paused runtime.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { objectToGlb } from '../../src/core/import/rv-import-object';
import { createPickBuildPort } from '../../src/core/engine/rv-pick-build-port';
import { ModelCache } from '../../src/core/engine/rv-model-cache';
import { setAssetReference, setPlacementMeta } from '../../src/core/engine/rv-asset-reference';
import { setNodeId } from '../../src/core/engine/rv-node-id';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { pathFromNode, RVPathComponent } from '../../src/core/engine/rv-path';
import type { ComponentContext } from '../../src/core/engine/rv-component-registry';
import {
  getProblems, resetProblemsForTests, INSTANCE_SIGNAL_COLLISION_CODE, PATH_ID_COLLISION_CODE,
  type ProblemEntry,
} from '../../src/core/hmi/problems-store';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';
import { group, withComponent } from '../fixtures/bake-fixture';

// ─── Synthetic asset ─────────────────────────────────────────────────────

const CART_URL = 'blob:rv-test/p559-cart.glb';

function box(name: string, x: number, y: number, z: number, color: number): Mesh {
  const m = new Mesh(new BoxGeometry(0.4, 0.4, 0.4), new MeshStandardMaterial({ color }));
  m.name = name;
  m.position.set(x, y, z);
  return m;
}

/** The Cart: a body, a jogging-capable lift with a fork, one generated and one authored signal. */
function makeCart(name = 'Cart'): Group {
  const root = group(name);
  root.add(box('Body', 0, 0.2, 0, 0x336699));
  const lift = withComponent(group('Lift'), 'Drive', { Direction: 'LinearX', TargetSpeed: 500, JogForward: false });
  lift.position.set(0, 0.6, 0);
  lift.add(box('Fork', 0, 0, 0, 0x99cc33));
  root.add(lift);
  const signals = group('Signals');
  const run = new Object3D();
  run.name = 'Run';
  run.userData.realvirtual = { PLCInputBool: { Name: 'Run', Generated: true, Status: { Value: false } } };
  const occupied = new Object3D();
  occupied.name = 'Occupied';
  occupied.userData.realvirtual = { PLCOutputBool: { Name: 'Occupied', Status: { Value: false } } };
  signals.add(run, occupied);
  root.add(signals);
  return root;
}

// ─── Viewer with a fake asset loader (the `ModelCache._decode` seam) ─────

let handle: TestViewerHandle | null = null;

async function bootViewer(): Promise<TestViewerHandle> {
  const h = await createTestViewer('webgl');
  handle = h;
  const loader = {
    loadAsync: async (url: string): Promise<{ scene: Group }> => {
      if (url !== CART_URL) throw new Error(`fake loader: unknown url ${url}`);
      return { scene: makeCart() };
    },
  } as unknown as GLTFLoader;
  h.viewer.placements.setModelCache(new ModelCache(loader, {
    uber: () => h.viewer.placementUberMaterial,
    isWebGPU: () => h.viewer.isWebGPU,
    pickPort: () => createPickBuildPort({ createWorker: () => null }),
  }));
  h.viewer.setSimulationPaused('p559-instance-scope', true);
  return h;
}

function tick(h: TestViewerHandle, n: number): void {
  const v = h.viewer as unknown as { _tickOnce(dt: number): void };
  for (let i = 0; i < n; i++) v._tickOnce(1 / 60);
}

function findByName(root: Object3D, name: string): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((n) => { if (!found && n.name === name) found = n; });
  return found;
}

/** Problems of one code. */
const problemsOf = (code: string): ProblemEntry[] => getProblems().filter((p) => p.code === code);

beforeEach(() => {
  resetProblemsForTests();
  getDefaultPathNetwork().clear();
});
afterEach(() => {
  handle?.dispose();
  handle = null;
  resetProblemsForTests();
  getDefaultPathNetwork().clear();
});

// ─── a. placements ───────────────────────────────────────────────────────

describe('a. two placements of the same asset', () => {
  async function placementDoc(): Promise<ArrayBuffer> {
    const root = new Group();
    root.name = 'Layout';
    [['Inst1', 0], ['Inst2', 5]].forEach(([name, x], i) => {
      const ref = new Object3D();
      ref.name = name as string;
      ref.position.set(x as number, 0, 0);
      setNodeId(ref, `nid-p559-inst-${i + 1}`);
      setAssetReference(ref, { assetId: 'cat:p559-cart', path: CART_URL });
      setPlacementMeta(ref, {});
      root.add(ref);
    });
    return objectToGlb(root);
  }

  it('scopes the generated signals per instance and moves only the jogged instance', async () => {
    const h = await bootViewer();
    await h.viewer.loadModel('p559-placements.glb', { data: await placementDoc() });
    await h.viewer.whenSceneReady();
    const store = h.viewer.signalStore;
    expect(store).toBeTruthy();
    const root = h.viewer.currentModelRoot;
    expect(root).toBeTruthy();

    // Signals: one per instance, prefixed with the placement name; the
    // unscoped name does not exist.
    expect(store!.get('Inst1.Run')).toBe(false);
    expect(store!.get('Inst2.Run')).toBe(false);
    expect(store!.get('Run')).toBeUndefined();
    const p1 = store!.registeredPaths('Inst1.Run');
    const p2 = store!.registeredPaths('Inst2.Run');
    expect(p1).toHaveLength(1);
    expect(p2).toHaveLength(1);
    expect(p1[0]).toMatch(/Inst1\//);
    expect(p2[0]).toMatch(/Inst2\//);

    // The authored name stays raw — the existing placement rule reports it,
    // the new embedded-copy rule does not.
    expect(store!.registeredPaths('Occupied')).toHaveLength(2);
    expect(problemsOf('signal-name-collision').map((p) => p.id)).toEqual(['signal-name-collision:Occupied']);
    expect(problemsOf(INSTANCE_SIGNAL_COLLISION_CODE)).toHaveLength(0);

    // Kinematics per instance: jog the lift of instance 2 only.
    const inst1 = findByName(root!, 'Inst1');
    const inst2 = findByName(root!, 'Inst2');
    expect(inst1).toBeTruthy();
    expect(inst2).toBeTruthy();
    const lift1 = findByName(inst1!, 'Lift');
    const lift2 = findByName(inst2!, 'Lift');
    expect(lift1).toBeTruthy();
    expect(lift2).toBeTruthy();
    expect(lift1).not.toBe(lift2);
    const drive2 = h.viewer.drives.find((d) => d.node === lift2);
    const drive1 = h.viewer.drives.find((d) => d.node === lift1);
    expect(drive1).toBeTruthy();
    expect(drive2).toBeTruthy();
    expect(drive1).not.toBe(drive2);
    const x1 = lift1!.position.x;
    const x2 = lift2!.position.x;
    drive2!.jogForward = true;
    tick(h, 60); // 1 s sim time at 500 mm/s
    expect(Math.abs(lift2!.position.x - x2)).toBeGreaterThan(0.2);
    expect(lift1!.position.x).toBeCloseTo(x1, 6);
  });
});

// ─── b./c. embedded copies ───────────────────────────────────────────────

/** A document embedding three Carts; `marker` puts `InstanceScope` on each root. */
async function embeddedDoc(marker: boolean): Promise<ArrayBuffer> {
  const root = new Group();
  root.name = 'Factory';
  root.add(box('Floor', 0, -0.2, 0, 0x777777));
  const labels = group('Labels');
  labels.add(group('Vehicle7'));
  root.add(labels);
  const prefixes: Array<Record<string, unknown>> = [
    {},
    {},
    // Root-inclusive, the form a Unity export writes (the document root is `Factory`).
    { PrefixNode: { type: 'ComponentReference', path: 'Factory/Labels/Vehicle7' } },
  ];
  ['CartA', 'CartB', 'CartC'].forEach((name, i) => {
    const cart = makeCart(name);
    cart.position.set(i * 3, 0, 2);
    if (marker) withComponent(cart, 'InstanceScope', prefixes[i]);
    root.add(cart);
  });
  return objectToGlb(root);
}

describe('b. embedded copies WITH InstanceScope', () => {
  it('get separate prefixed signals; PrefixNode names the prefix', async () => {
    const h = await bootViewer();
    await h.viewer.loadModel('p559-embedded-marked.glb', { data: await embeddedDoc(true) });
    await h.viewer.whenSceneReady();
    const store = h.viewer.signalStore;
    expect(store).toBeTruthy();

    expect(store!.get('CartA.Run')).toBe(false);
    expect(store!.get('CartB.Run')).toBe(false);
    expect(store!.get('Vehicle7.Run')).toBe(false);
    expect(store!.get('CartC.Run')).toBeUndefined();
    expect(store!.get('Run')).toBeUndefined();
    for (const name of ['CartA.Run', 'CartB.Run', 'Vehicle7.Run']) {
      expect(store!.registeredPaths(name), name).toHaveLength(1);
    }
    // The marker is a component of its node (survives the bake, inspector-visible).
    const cartA = findByName(h.viewer.currentModelRoot!, 'CartA');
    expect(cartA).toBeTruthy();
    expect(h.viewer.registry!.getComponentTypes(h.viewer.registry!.getPathForNode(cartA!)!)).toContain('InstanceScope');

    // No generated name collides any more; the AUTHORED `Occupied` stays raw
    // (plan-589 rule), so it is still shared — and reported.
    const collisions = problemsOf(INSTANCE_SIGNAL_COLLISION_CODE);
    expect(collisions.map((p) => p.id)).toEqual([`${INSTANCE_SIGNAL_COLLISION_CODE}:Occupied`]);
  });
});

describe('c. embedded copies WITHOUT InstanceScope', () => {
  it('keep today\'s names and report each colliding name once, with every node path', async () => {
    const h = await bootViewer();
    await h.viewer.loadModel('p559-embedded-plain.glb', { data: await embeddedDoc(false) });
    await h.viewer.whenSceneReady();
    const store = h.viewer.signalStore;
    expect(store).toBeTruthy();

    // Names unchanged versus today: unscoped, ONE shared signal per name.
    expect(store!.get('Run')).toBe(false);
    expect(store!.get('Occupied')).toBe(false);
    for (const scoped of ['CartA.Run', 'CartB.Run', 'CartC.Run', 'Vehicle7.Run']) {
      expect(store!.get(scoped), scoped).toBeUndefined();
    }
    const runPaths = store!.registeredPaths('Run');
    expect(runPaths).toHaveLength(3);

    const collisions = problemsOf(INSTANCE_SIGNAL_COLLISION_CODE);
    expect(collisions.map((p) => p.id).sort()).toEqual([
      `${INSTANCE_SIGNAL_COLLISION_CODE}:Occupied`,
      `${INSTANCE_SIGNAL_COLLISION_CODE}:Run`,
    ]);
    const run = collisions.find((p) => p.id === `${INSTANCE_SIGNAL_COLLISION_CODE}:Run`);
    expect(run).toBeTruthy();
    expect(run!.severity).toBe('warning');
    for (const path of runPaths) expect(run!.detail).toContain(path);
    for (const cart of ['CartA', 'CartB', 'CartC']) expect(run!.detail).toContain(`${cart}/`);
    // Not a placement → the placement rule stays silent.
    expect(problemsOf('signal-name-collision')).toHaveLength(0);
  });
});

// ─── d. duplicate path id ────────────────────────────────────────────────

describe('d. two path nodes with the same path id', () => {
  const pathExtras = (x: number): Record<string, unknown> => ({
    type: 'Path', version: 1, closed: false, align: [0, 1, 0], id: 'Lane',
    segments: [{ kind: 'line', from: [x, 0, 0], to: [x + 10, 0, 0] }], successors: [],
  });

  async function pathDoc(): Promise<ArrayBuffer> {
    const root = new Group();
    root.name = 'Hall';
    root.add(box('Floor', 0, -0.2, 0, 0x777777));
    const a = withComponent(group('LaneA'), 'Path', pathExtras(0));
    const b = withComponent(group('LaneB'), 'Path', pathExtras(20));
    const other = withComponent(group('Other'), 'Path', { ...pathExtras(40), id: 'Other' });
    root.add(a, b, other);
    return objectToGlb(root);
  }

  it('reports one path-id-collision naming both nodes; the network still holds one path per id', async () => {
    const h = await bootViewer();
    await h.viewer.loadModel('p559-paths.glb', { data: await pathDoc() });
    await h.viewer.whenSceneReady();
    const root = h.viewer.currentModelRoot;
    expect(root).toBeTruthy();
    const laneA = findByName(root!, 'LaneA');
    const laneB = findByName(root!, 'LaneB');
    expect(laneA).toBeTruthy();
    expect(laneB).toBeTruthy();

    const collisions = problemsOf(PATH_ID_COLLISION_CODE);
    expect(collisions).toHaveLength(1);
    expect(collisions[0].id).toBe(`${PATH_ID_COLLISION_CODE}:Lane`);
    expect(collisions[0].severity).toBe('warning');
    const pathA = h.viewer.registry!.getPathForNode(laneA!);
    const pathB = h.viewer.registry!.getPathForNode(laneB!);
    expect(pathA).toBeTruthy();
    expect(pathB).toBeTruthy();
    expect(collisions[0].detail).toContain(pathA!);
    expect(collisions[0].detail).toContain(pathB!);

    // Routing unchanged: one path under the id — the one registered LAST — and
    // the unique id untouched.
    const net = getDefaultPathNetwork();
    const lane = net.get('Lane');
    expect(lane).toBeTruthy();
    expect(net.all().filter((p) => p.id === 'Lane')).toHaveLength(1);
    const fromA = pathFromNode(laneA!);
    const fromB = pathFromNode(laneB!);
    expect(fromA).toBeTruthy();
    expect(fromB).toBeTruthy();
    expect([fromA, fromB]).toContain(lane);
    expect(net.get('Other')).toBeTruthy();
  });
});

// ─── e. reload of the SAME document after the collision is gone (2b) ─────

describe('e. clearModel drops the collision entries of the old model', () => {
  const lane = (id: string, x: number): Record<string, unknown> => ({
    type: 'Path', version: 1, closed: false, align: [0, 1, 0], id,
    segments: [{ kind: 'line', from: [x, 0, 0], to: [x + 10, 0, 0] }], successors: [],
  });

  /**
   * `colliding`: two placements + two embedded Carts + two paths with one id.
   * Clean: one placement, no embedded Cart (its authored `Occupied` would meet
   * the placement's — a real collision), two unique path ids.
   */
  async function reloadDoc(colliding: boolean): Promise<ArrayBuffer> {
    const root = new Group();
    root.name = 'Reload';
    root.add(box('Floor', 0, -0.2, 0, 0x777777));
    const refs = colliding ? ['Inst1', 'Inst2'] : ['Inst1'];
    refs.forEach((name, i) => {
      const ref = new Object3D();
      ref.name = name;
      ref.position.set(i * 5, 0, 8);
      setNodeId(ref, `nid-p559-reload-${i + 1}`);
      setAssetReference(ref, { assetId: 'cat:p559-cart', path: CART_URL });
      setPlacementMeta(ref, {});
      root.add(ref);
    });
    (colliding ? ['CartA', 'CartB'] : []).forEach((name, i) => {
      const cart = makeCart(name);
      cart.position.set(i * 3, 0, 2);
      root.add(cart);
    });
    root.add(withComponent(group('LaneA'), 'Path', lane('Lane', 0)));
    root.add(withComponent(group('LaneB'), 'Path', lane(colliding ? 'Lane' : 'LaneB', 20)));
    return objectToGlb(root);
  }

  it('the same document reloaded without collisions keeps no stale entry', async () => {
    const h = await bootViewer();
    const codes = ['signal-name-collision', INSTANCE_SIGNAL_COLLISION_CODE, PATH_ID_COLLISION_CODE];

    await h.viewer.loadModel('p559-reload.glb', { data: await reloadDoc(true) });
    await h.viewer.whenSceneReady();
    await h.viewer.placements.whenMaterialized();
    for (const code of codes) expect(problemsOf(code).length, `${code} before`).toBeGreaterThan(0);

    // Same document name (same Problems document key) — only the content changed.
    await h.viewer.loadModel('p559-reload.glb', { data: await reloadDoc(false) });
    await h.viewer.whenSceneReady();
    await h.viewer.placements.whenMaterialized();
    expect(h.viewer.signalStore).toBeTruthy();
    expect(h.viewer.signalStore!.registeredPaths('Occupied').length).toBeGreaterThan(0);
    for (const code of codes) expect(problemsOf(code), `${code} after the reload`).toEqual([]);
  });
});

// ─── f. dispose of a path that does not own its id (2b) ──────────────────

describe('f. RVPathComponent.dispose of a non-owner', () => {
  const lane = (x: number): Record<string, unknown> => ({
    type: 'Path', version: 1, closed: false, align: [0, 1, 0], id: 'Shared',
    segments: [{ kind: 'line', from: [x, 0, 0], to: [x + 10, 0, 0] }], successors: [],
  });

  function component(name: string, x: number): RVPathComponent {
    const n = withComponent(group(name), 'Path', lane(x));
    const c = new RVPathComponent(n);
    c.init({} as ComponentContext);
    return c;
  }

  it('leaves the owner\'s path in the network and keeps the collision entry consistent', () => {
    const net = getDefaultPathNetwork();
    const first = component('PathFirst', 0);
    const second = component('PathSecond', 20);
    const third = component('PathThird', 40);
    expect(first.path).toBeTruthy();
    expect(third.path).toBeTruthy();
    // Last registration wins the id: `third` owns it.
    expect(net.get('Shared')).toBe(third.path);
    const before = problemsOf(PATH_ID_COLLISION_CODE);
    expect(before).toHaveLength(1);
    for (const n of ['PathFirst', 'PathSecond', 'PathThird']) expect(before[0].detail).toContain(n);

    // A non-owner leaves: the owner's path stays; the entry names the two left.
    first.dispose();
    expect(net.get('Shared')).toBe(third.path);
    const mid = problemsOf(PATH_ID_COLLISION_CODE);
    expect(mid).toHaveLength(1);
    expect(mid[0].detail).not.toContain('PathFirst');
    expect(mid[0].detail).toContain('PathSecond');
    expect(mid[0].detail).toContain('PathThird');

    // The second non-owner leaves: no collision any more, owner still registered.
    second.dispose();
    expect(net.get('Shared')).toBe(third.path);
    expect(problemsOf(PATH_ID_COLLISION_CODE)).toEqual([]);

    // The owner leaves: the id is gone.
    third.dispose();
    expect(net.get('Shared')).toBeNull();
  });
});
