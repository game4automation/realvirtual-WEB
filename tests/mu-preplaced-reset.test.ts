// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * mu-preplaced-reset.test.ts — plan-516 §9.4: every reset caller (F4).
 *
 *  - `resetSimulation()` restores pose, parent and loads of every pre-placed
 *    MU after belt / sink / grip moved them, and re-activates them;
 *  - `clearModel()` hands them back to the model tree, activates nothing;
 *  - a mode switch Continuous → DES (Reset-on-Switch) restores them static.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Object3D, Quaternion, Scene, Vector3 } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { RVSink } from '../src/core/engine/rv-sink';
import { RVGrip } from '../src/core/engine/rv-grip';
import { RVGripTarget } from '../src/core/engine/rv-grip-target';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { loadMu } from '../src/core/engine/rv-mu-load';
import type { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { RVViewer } from '../src/core/rv-viewer';
import { ContinuousRunner } from '../src/core/material-flow/continuous-runner';
import { SimulationKernel } from '../src/core/material-flow/simulation-kernel';
import type { SimulationExecutor } from '../src/core/material-flow/simulation-executor';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import {
  CAP_SINK, PALLET, VALVE, VALVE_SINK, WT, classifiedScene, jigCell, muNode, muOf, palletRow, worldPos, worldPose, PART,
} from './_mu-preplaced-fixture';

const DT = 1 / 60;

function belt(x: number, speed: number): RVTransportSurface {
  const node = new Object3D();
  node.position.set(x, -0.05, 0);
  const surface = new RVTransportSurface(node, AABB.fromHalfSize(node, new Vector3(0.6, 0.05, 0.4)));
  surface.TransportDirection.set(1, 0, 0);
  surface.Radial = false;
  surface.TextureScale = 1;
  surface.HeightOffsetOverride = 0;
  surface.reapplyConfig();
  surface.initTransport();
  surface.drive = { currentSpeed: speed, name: 'belt' } as unknown as RVTransportSurface['drive'];
  return surface;
}

/** Authored state of every pre-placed MU: parent, local position, visibility. */
interface Authored { parent: Object3D | null; pos: Vector3; world: Vector3; visible: boolean }

function authored(tm: RVTransportManager): Map<RVMovingUnit, Authored> {
  const m = new Map<RVMovingUnit, Authored>();
  for (const mu of tm.preplacedMUs) {
    m.set(mu, { parent: mu.node.parent, pos: mu.node.position.clone(), world: worldPos(mu.node), visible: mu.node.visible });
  }
  return m;
}

/** `checkParent`: the authored parent and local pose too (true while NOT activated). */
function expectAuthored(tm: RVTransportManager, before: Map<RVMovingUnit, Authored>, checkParent = true): void {
  for (const [mu, a] of before) {
    expect(worldPos(mu.node).distanceTo(a.world), mu.getName()).toBeLessThan(1e-6);
    if (checkParent) {
      expect(mu.node.parent, mu.getName()).toBe(a.parent);
      expect(mu.node.position.distanceTo(a.pos), mu.getName()).toBeLessThan(1e-9);
    }
    expect(mu.node.visible).toBe(a.visible);
    expect(mu.markedForRemoval).toBe(false);
    expect(mu.isGripped).toBe(false);
  }
}

/** Run the production `RVViewer.prototype.resetSimulation` on a narrow fake. */
function resetViaViewer(tm: RVTransportManager, kernel: SimulationKernel | null = null): void {
  const fakeViewer = {
    _simTime: 0,
    drives: [] as { reset(): void }[],
    chainManager: { resetAll() {} },
    ribbonManager: { resetAll() {} },
    transportManager: tm,
    logicEngine: null,
    logicRunState: 'active',
    _kernel: kernel,
    statisticsManager: { resetAll() {} },
    signalReapply: { reapplyAll() {} },
    emit() {},
  };
  const reset = RVViewer.prototype.resetSimulation as unknown as (this: typeof fakeViewer) => void;
  reset.call(fakeViewer);
}

let warn: ReturnType<typeof vi.spyOn> | null = null;
let handle: TestViewerHandle | null = null;
afterEach(() => {
  warn?.mockRestore(); warn = null;
  handle?.dispose(); handle = null;
});

describe('resetSimulation after belt, sink and grip (plan-516 F4)', () => {
  it('restores pose, parent and loads and re-activates the pre-placed MUs', () => {
    const { root, pallets, parts } = palletRow(3, 1);
    const { tm, scene } = classifiedScene(root);
    const before = authored(tm);
    tm.activatePreplaced();
    const [a, b, c] = pallets.map((p) => muOf(tm, p));
    const productA = muOf(tm, parts[0][0]);
    const productB = muOf(tm, parts[1][0]);
    const productC = muOf(tm, parts[2][0]);

    // Belt under pallet A, sink under pallet C, a grip over product B.
    tm.surfaces.push(belt(0, 500));
    const sinkNode = new Object3D();
    sinkNode.position.set(2, 0, 0);
    scene.add(sinkNode);
    const sink = new RVSink(sinkNode, AABB.fromHalfSize(sinkNode, new Vector3(0.1, 0.1, 0.1)));
    tm.sinks.push(sink);
    const gripNode = new Object3D();
    gripNode.position.set(1, PALLET[1] + PART[1], 0);
    scene.add(gripNode);
    const grip = new RVGrip(gripNode);
    grip.allMUs = () => tm.mus;
    grip.allGripTargets = () => [];
    grip.loadHost = tm;
    tm.grips.push(grip);

    for (let i = 0; i < 30; i++) tm.update(DT);
    grip.pick();
    expect(productB.isGripped).toBe(true);
    expect(productB.loadedOn).toBeNull();
    gripNode.position.x += 2;
    gripNode.position.y += 1;
    grip.place(); // no carrier below → scene root, active MU

    expect(worldPos(a.node).x).toBeGreaterThan(0.1); // belt moved A (and its load)
    expect(tm.mus).not.toContain(c);                 // sink consumed C with its load
    expect(c.node.parent).toBeNull();
    expect(productB.node.parent).toBe(scene);

    resetViaViewer(tm);

    // Activated again: the loads hang under their carriers, the carriers in the
    // spawn parent — every WORLD pose is the authored one.
    expectAuthored(tm, before, false);
    expect(tm.preplacedActive).toBe(true);
    expect(tm.mus.length).toBe(3);
    expect(productA.loadedOn).toBe(a);
    expect(productB.loadedOn).toBe(b);
    expect(productC.loadedOn).toBe(c);
    // loads ride under their carriers again, carriers sit in the spawn parent
    expect(productC.node.parent).toBe(c.node);
    expect(c.node.parent).toBe(root);
  });

  it('a spawned MU put onto a pre-placed carrier is disposed by the reset', () => {
    const { root, pallets } = palletRow(1, 0);
    const { tm } = classifiedScene(root);
    tm.activatePreplaced();
    const pallet = muOf(tm, pallets[0]);
    const extraNode = muNode('Spawned', PART, [0, PALLET[1], 0]);
    root.add(extraNode);
    // Not pre-placed: an MU as a source spawns it, then put onto the pallet.
    const spawned = new RVMovingUnit(extraNode, 'src', new Vector3(0.05, 0.04, 0.05), new Vector3(0, 0.04, 0));
    tm.mus.push(spawned);
    expect(loadMu(spawned, pallet, tm)).toBe(true);
    expect(tm.mus).not.toContain(spawned);
    expect(extraNode.parent).toBe(pallet.node);

    resetViaViewer(tm);
    expect(extraNode.parent).toBeNull();
    expect(pallet.loadedMus.length).toBe(0);
    expect(tm.mus).toEqual([pallet]);
  });
});

describe('clearModel and mode switches never activate (plan-516 F4)', () => {
  it('Continuous → DES: pre-placed MUs are restored, visible and static', () => {
    const { root, pallets, parts } = palletRow(2, 1);
    const { tm, scene } = classifiedScene(root);
    const before = authored(tm);
    const runner = new ContinuousRunner(tm, { tick() {} });
    const des: SimulationExecutor = {
      mode: 'des', muCount: 0,
      start() {}, tick() {}, clearMUs() {}, reset() {}, dispose() {},
      instances: () => [],
    } as unknown as SimulationExecutor;
    const kernel = new SimulationKernel({
      continuousRunner: runner,
      topology: { root: scene, host: {} as never },
      desRunnerFactory: () => des,
    });
    tm.activatePreplaced();
    tm.surfaces.push(belt(0, 500));
    for (let i = 0; i < 20; i++) kernel.tick(DT);
    expect(worldPos(pallets[0]).x).toBeGreaterThan(0.05);

    kernel.setMode('des');
    expect(kernel.mode).toBe('des');
    expectAuthored(tm, before);
    expect(tm.mus.length).toBe(0);
    expect(tm.preplacedActive).toBe(false);
    expect(parts[0][0].visible).toBe(true);

    // resetSimulation in DES mode restores but does NOT activate
    resetViaViewer(tm, kernel);
    expect(tm.mus.length).toBe(0);
    expect(tm.preplacedActive).toBe(false);
  });

  it('executor dispose restores without activating', () => {
    const { root } = palletRow(1, 1);
    const { tm } = classifiedScene(root);
    tm.activatePreplaced();
    new ContinuousRunner(tm, { tick() {} }).dispose();
    expect(tm.mus.length).toBe(0);
    expect(tm.preplacedActive).toBe(false);
  });

  it('real viewer: load activates, grip + sink + clearModel leave nothing outside the model tree', async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const src = new Scene();
    const model = new Object3D();
    model.name = 'Cell';
    src.add(model);
    model.add(muNode('Pallet', PALLET, [0, 0, 0]));
    model.add(muNode('Product', PART, [0, PALLET[1], 0]));
    model.add(muNode('Pallet2', PALLET, [3, 0, 0]));
    const data = (await new GLTFExporter().parseAsync(src, { binary: true })) as ArrayBuffer;

    handle = await createTestViewer('webgl');
    const { viewer } = handle;
    await viewer.loadModel('preplaced-real.glb', { data });
    const tm = viewer.transportManager!;
    expect(tm.preplacedActive).toBe(true);
    expect(tm.mus.length).toBe(2);
    const byName = (name: string) => tm.preplacedMUs.find((m) => m.node.name === name)!;
    const pallet = byName('Pallet');
    const pallet2 = byName('Pallet2');
    const product = byName('Product');
    // The model root: the scene child the pre-placed MUs live under.
    let modelRoot: Object3D = product.node;
    while (modelRoot.parent && modelRoot.parent !== viewer.scene) modelRoot = modelRoot.parent;
    expect(modelRoot.parent).toBe(viewer.scene);
    expect(product.loadedOn).toBe(pallet);

    // Grip the product off, consume pallet 2 by removal (the sink path).
    const gripNode = new Object3D();
    viewer.scene.add(gripNode);
    gripNode.position.copy(worldPos(product.node)).add(new Vector3(0, PART[1], 0));
    const grip = new RVGrip(gripNode);
    grip.allMUs = () => tm.mus;
    grip.allGripTargets = () => [];
    grip.loadHost = tm;
    tm.grips.push(grip);
    grip.pick();
    expect(product.isGripped).toBe(true);
    tm.removeMU(pallet2);
    expect(pallet2.node.parent).toBeNull();

    // Simulation reset through the real viewer.
    viewer.resetSimulation();
    expect(tm.preplacedActive).toBe(true);
    expect(product.loadedOn).toBe(pallet);
    expect(pallet2.node.parent).not.toBeNull();

    // Grip again, then unload the model.
    grip.pick();
    tm.removeMU(pallet2);
    viewer.clearModel();
    expect(tm.mus.length).toBe(0);
    expect(tm.preplacedActive).toBe(false);
    for (const mu of [pallet, pallet2, product]) {
      let top: Object3D = mu.node;
      while (top.parent) top = top.parent;
      // back inside the (now removed) model tree — not left in the scene or on the grip
      expect(top, mu.getName()).toBe(modelRoot);
    }
  }, 120_000);
});

// ─── plan-577 F9: reset of a moved nested load (parent ≠ carrier) ──────────

describe('plan-577 F9: reset after a cap was moved onto another valve', () => {
  const SEAT_X = 0.03;
  const SEAT_Z = 0.02;
  const VALVE_TOP = WT[1] - VALVE_SINK + VALVE[1];

  interface Pose { parent: Object3D | null; pos: Vector3; quat: Quaternion }

  function poses(tm: RVTransportManager): Map<RVMovingUnit, Pose> {
    const m = new Map<RVMovingUnit, Pose>();
    for (const mu of tm.preplacedMUs) {
      const w = worldPose(mu.node);
      m.set(mu, { parent: mu.node.parent, pos: w.pos, quat: w.quat });
    }
    return m;
  }

  /** Max world deviation (mm, deg) of every pre-placed MU from `ref`. */
  function deviation(tm: RVTransportManager, ref: Map<RVMovingUnit, Pose>): { mm: number; deg: number; worst: string } {
    let mm = 0; let deg = 0; let worst = '-';
    for (const [mu, p] of ref) {
      const w = worldPose(mu.node);
      const d = w.pos.distanceTo(p.pos) * 1000;
      const a = (w.quat.angleTo(p.quat) * 180) / Math.PI;
      if (d > mm || a > deg) worst = mu.getName();
      mm = Math.max(mm, d); deg = Math.max(deg, a);
    }
    return { mm, deg, worst };
  }

  /**
   * Jig 0: WT + valve + cap, jig 1: WT + valve (siblings under a plain jig group —
   * parent ≠ carrier). `frozen`: cap and valves carry the loader freeze
   * (`matrixAutoUpdate` false), as a mesh-node MU of a baked GLB does — the
   * laser-welding cap (measured, see plan-577 Implementation Complete).
   */
  function cell(frozen: boolean) {
    const { root, wts, valves, caps } = jigCell(2, (i) => i === 0);
    if (frozen) {
      for (const n of [caps[0]!, valves[0], valves[1]]) { n.updateMatrix(); n.matrixAutoUpdate = false; }
    }
    const { tm, scene } = classifiedScene(root);
    tm.activatePreplaced();
    const loaded = poses(tm);
    const loadedActive = tm.mus.length;
    const grip = new RVGrip(new Object3D());
    scene.add(grip.node);
    grip.allMUs = () => tm.mus;
    grip.allGripTargets = () => tm.gripTargets;
    grip.loadHost = tm;
    tm.grips.push(grip);
    return {
      tm, scene, grip, loaded, loadedActive,
      wt0: muOf(tm, wts[0]), wt1: muOf(tm, wts[1]),
      valve0: muOf(tm, valves[0]), valve1: muOf(tm, valves[1]), cap0: muOf(tm, caps[0]!),
    };
  }

  /** Grip the cap off valve 0, turn it 90° (screwing), place it onto valve 1 (LoadOnCarrier, rotation kept). */
  function moveCapToValve1(c: ReturnType<typeof cell>): void {
    const { tm, scene, grip, cap0, valve1 } = c;
    grip.node.position.set(SEAT_X, VALVE_TOP + 0.02, SEAT_Z);
    grip.node.updateWorldMatrix(true, true);
    (grip as unknown as { fix(m: RVMovingUnit): void }).fix(cap0);
    grip.node.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    grip.node.position.set(0.5 + SEAT_X, VALVE_TOP + 0.05, SEAT_Z);
    grip.node.updateWorldMatrix(true, true);
    const tNode = new Object3D();
    tNode.name = 'CapSeat_1';
    tNode.position.set(0.5 + SEAT_X, VALVE_TOP - CAP_SINK, SEAT_Z);
    scene.add(tNode);
    const t = new RVGripTarget(tNode);
    t.LoadOnCarrier = true;
    t.AlignRotation = false;
    tm.gripTargets.push(t);
    grip.place();
    expect(cap0.loadedOn).toBe(valve1);
    expect(cap0.node.parent).toBe(valve1.node);
    // Aligned position also for a frozen node (the TRS write reached its matrix).
    expect(worldPos(cap0.node).distanceTo(worldPos(tNode))).toBeLessThan(1e-9);
  }

  function expectLoadedState(c: ReturnType<typeof cell>, label: string): void {
    const { tm, loaded, loadedActive, wt0, wt1, valve0, valve1, cap0 } = c;
    const dev = deviation(tm, loaded);
    expect(dev.mm, `${label}: world position (worst ${dev.worst})`).toBeLessThan(1e-6);
    expect(dev.deg, `${label}: world rotation (worst ${dev.worst})`).toBeLessThan(1e-4);
    expect(valve0.loadedOn, label).toBe(wt0);
    expect(cap0.loadedOn, label).toBe(valve0);
    expect(valve1.loadedOn, label).toBe(wt1);
    expect(valve1.loadedMus, label).toHaveLength(0);
    expect(tm.mus.length, label).toBe(loadedActive);
    expect(cap0.isGripped, label).toBe(false);
  }

  for (const frozen of [false, true]) {
    it(`three measuring points after the move${frozen ? ' (frozen node matrices)' : ''}: restore, activation, first tick`, () => {
      const c = cell(frozen);
      const { tm, loaded, cap0, valve1 } = c;
      tm.surfaces.push(belt(0.5, 500));
      moveCapToValve1(c);
      for (let i = 0; i < 20; i++) tm.update(DT); // the belt carries both jigs with valves and cap
      expect(worldPos(c.wt1.node).x).toBeGreaterThan(0.6);
      expect(cap0.loadedOn).toBe(valve1);

      // (a) restore only (not activated): authored parent, no load links, world = after load.
      tm.reset();
      const a = deviation(tm, loaded);
      for (const mu of tm.preplacedMUs) {
        expect(mu.node.parent, `(a) ${mu.getName()}`).toBe(mu.snapshot!.parent);
        expect(mu.loadedOn, `(a) ${mu.getName()}`).toBeNull();
      }
      expect(a.mm, `(a) worst ${a.worst}`).toBeLessThan(1e-6);
      expect(a.deg, `(a) worst ${a.worst}`).toBeLessThan(1e-4);

      // (b) activation: loads re-resolved (cap → its ORIGINAL valve), no extra free MUs.
      tm.activatePreplaced();
      const b = deviation(tm, loaded);
      expectLoadedState(c, '(b)');

      // (c) first tick (the belt is still there — nothing may have moved yet).
      tm.surfaces.length = 0;
      tm.update(DT);
      const cc = deviation(tm, loaded);
      expectLoadedState(c, '(c)');
      console.log(`[plan-577 F9] frozen=${frozen} (a) ${a.mm.toFixed(6)} mm / ${a.deg.toFixed(6)} deg, `
        + `(b) ${b.mm.toFixed(6)} mm / ${b.deg.toFixed(6)} deg, (c) ${cc.mm.toFixed(6)} mm / ${cc.deg.toFixed(6)} deg`);
    });
  }

  it('reset while the cap is held by the grip, and two resets in a row are identical', () => {
    const c = cell(true);
    const { tm, grip, cap0 } = c;
    grip.node.position.set(SEAT_X, VALVE_TOP + 0.02, SEAT_Z);
    grip.node.updateWorldMatrix(true, true);
    (grip as unknown as { fix(m: RVMovingUnit): void }).fix(cap0);
    grip.node.position.set(2, 1, 0);
    grip.node.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), 0.7);
    grip.node.updateWorldMatrix(true, true);
    expect(cap0.heldBy).toBe('grip');

    resetViaViewer(tm);
    expectLoadedState(c, 'reset 1');
    const once = poses(tm);
    resetViaViewer(tm);
    expectLoadedState(c, 'reset 2');
    expect(deviation(tm, once).mm).toBeLessThan(1e-9);
    expect(grip.grippedMUs).toHaveLength(0);
  });

  it('a pre-placed load on a SPAWNED carrier at reset time goes home; the spawned carrier is disposed', () => {
    const c = cell(true);
    const { tm, scene, grip, valve1 } = c;
    const spawnedNode = muNode('SpawnedWT', WT, [3, 0, 0]);
    scene.add(spawnedNode);
    const spawned = new RVMovingUnit(spawnedNode, 'src', new Vector3(WT[0] / 2, WT[1] / 2, WT[2] / 2), new Vector3(0, WT[1] / 2, 0));
    spawned.loadSeatDepth = 0.07;
    tm.mus.push(spawned);
    grip.node.position.set(0.5 + SEAT_X, VALVE_TOP + 0.01, SEAT_Z);
    grip.node.updateWorldMatrix(true, true);
    grip.pick();
    expect(grip.grippedMUs).toEqual([valve1]);
    const tNode = new Object3D();
    tNode.position.set(3 + SEAT_X, WT[1] - VALVE_SINK, SEAT_Z);
    scene.add(tNode);
    const t = new RVGripTarget(tNode);
    t.LoadOnCarrier = true;
    tm.gripTargets.push(t);
    grip.node.position.set(3 + SEAT_X, 0.4, SEAT_Z);
    grip.node.updateWorldMatrix(true, true);
    grip.place();
    expect(valve1.loadedOn).toBe(spawned);

    resetViaViewer(tm);
    expectLoadedState(c, 'after reset');
    expect(spawnedNode.parent).toBeNull();
    expect(valve1.node.parent).not.toBe(spawnedNode);
  });
});
