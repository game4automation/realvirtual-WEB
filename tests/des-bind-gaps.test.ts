// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * des-bind-gaps.test.ts — plan-645 9.5 (Phase 4 klein: S8, L4, L5, R2-2, R2-4).
 *
 * On a REAL viewer (placements materialised by the PlacementInstancer):
 *  - c5: layout content added in DES (planner drop) is bound by ONE coalesced
 *    rebind; removed content leaves the runner again;
 *  - c7: content that arrived while continuous was active is bound on the next
 *    `setMode('des')` (scene generation moved on → rebind instead of reuse);
 *  - a repeated `placements-materialized` does not rebind twice, an aborted one
 *    not at all;
 *  - R2-2: a restore while the scene changed since the last bind is refused
 *    before any change (Problems entry), and works again after the rebind;
 *  - the normal path (load complete, then DES) binds exactly once.
 *
 * The "drop" is the planner's observable effect: a placed LayoutObject subtree
 * plus `layout-content-added` (like the spike, plan-645 c5). Bounded by sim
 * steps, never wall clock. Private build only.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { markDeferredPlacement, setAssetReference, setPlacementMeta } from '../src/core/engine/rv-asset-reference';
import { createPlanningRegistry } from '../src/core/planning/rv-planning-registry';
import { collectDeferredPlacements } from '../src/core/engine/rv-placement-instancer';
import { disposeComponentsInSubtree } from '../src/core/engine/rv-scene-loader';
import { setNodeId } from '../src/core/engine/rv-node-id';
import { registerAllBehaviors } from '../src/core/behaviors';
import { getProblems } from '../src/core/hmi/problems-store';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { DESRunner } from '@rv/plugins/des/des-runner';

const CONVEYOR = 'library/PalletHandling/RollConveyor-2m.glb';
const SINK = 'library/PalletHandling/PalletSink.glb';

function refNode(name: string, path: string, x: number): Object3D {
  const n = new Object3D();
  n.name = name;
  n.position.set(x, 0, 0);
  setNodeId(n, `nid-${name}`);
  setAssetReference(n, { assetId: `cat:${path.split('/').pop()}`, path });
  return n;
}

function find(root: Object3D, name: string): Object3D | null {
  let hit: Object3D | null = null;
  root.traverse((n) => { if (!hit && n.name === name) hit = n; });
  return hit;
}

interface Loaded { h: TestViewerHandle; v: RVViewer; model: Object3D }

async function load(): Promise<Loaded> {
  const h = await createTestViewer('webgl');
  const v = h.viewer;
  v.loop.setPaused('plan-645-bind-gaps', true);
  registerAllBehaviors(v.behaviors);
  const doc = new Group();
  doc.name = 'BindGapsDoc';
  doc.add(refNode('Conveyor_1', CONVEYOR, 0), refNode('PalletSink_1', SINK, 3));
  await v.loadModel('plan-645-bind-gaps.glb', { data: await objectToGlb(doc) });
  await v.whenSceneReady();
  const model = (v as unknown as { currentModel: Object3D }).currentModel;
  v.scene.updateMatrixWorld(true);
  return { h, v, model };
}

const quietInfo = () => vi.spyOn(console, 'info').mockImplementation(() => {});

function runnerOf(v: RVViewer): DESRunner {
  const r = v.simulationKernel!.desControl() as unknown as DESRunner;
  expect(r, 'DES runner').toBeTruthy();
  return r;
}

const conveyors = (r: DESRunner): number => r.liveInstances.filter((i) => i.def.type === 'Conveyor').length;

/** A planner-drop stand-in: a deep clone of a placed conveyor + `layout-content-added`.
 *  The binding matches a placement by its node name minus the `_N` suffix. */
function drop(x: Loaded, name: string): Object3D {
  const src = find(x.model, 'Conveyor_1')!;
  const clone = src.clone(true);
  clone.name = name;
  clone.position.x += 6;
  // Keep the placement stamp of the source (the binding matches a placement by
  // its catalog asset name, like a real planner drop of the same asset).
  clone.userData._layoutId = `${String(clone.userData._layoutId ?? 'drop')}-${name}`;
  x.model.add(clone);
  x.v.scene.updateMatrixWorld(true);
  x.v.emit('layout-content-added', { root: clone });
  return clone;
}

function remove(x: Loaded, node: Object3D): void {
  node.removeFromParent();
  x.v.emit('layout-content-removed', { root: node });
}

const flush = (): Promise<void> => new Promise((r) => queueMicrotask(r));

let open: Loaded | null = null;
afterEach(() => { open?.h.dispose(); open = null; });

describe('plan-645 9.5 — DES bind gaps (Phase 4 klein)', () => {
  it('normal path: load complete, then DES → exactly one bind', async () => {
    const x = (open = await load());
    const spy = vi.spyOn(DESRunner.prototype, 'rebindScene');
    const q = quietInfo();
    try { x.v.simulationKernel!.setMode('des'); } finally { q.mockRestore(); }
    const r = runnerOf(x.v);
    expect(conveyors(r)).toBeGreaterThanOrEqual(1);
    expect(spy).not.toHaveBeenCalled();
    expect(r.boundSceneGeneration).toBe(x.v.sceneGeneration);
    spy.mockRestore();
  });

  it('c5: a drop in DES is bound by ONE coalesced rebind; removing it unbinds it', async () => {
    const x = (open = await load());
    const q = quietInfo();
    try {
      x.v.simulationKernel!.setMode('des');
      const r = runnerOf(x.v);
      const n0 = conveyors(r);
      const spy = vi.spyOn(r, 'rebindScene');
      const a = drop(x, 'Conveyor_7');
      const b = drop(x, 'Conveyor_8');
      expect(conveyors(r), 'nothing happens synchronously').toBe(n0);
      await flush();
      expect(spy, 'two drops, one rebind').toHaveBeenCalledTimes(1);
      expect(conveyors(r)).toBe(n0 + 2);
      remove(x, a);
      remove(x, b);
      await flush();
      expect(spy).toHaveBeenCalledTimes(2);
      expect(conveyors(r), 'removed content leaves the runner').toBe(n0);
      spy.mockRestore();
    } finally { q.mockRestore(); }
  });

  it('c7: content added while continuous is bound on the next setMode(des)', async () => {
    const x = (open = await load());
    const q = quietInfo();
    try {
      const k = x.v.simulationKernel!;
      k.setMode('des');
      const n0 = conveyors(runnerOf(x.v));
      k.setMode('continuous');
      drop(x, 'Conveyor_9');
      await flush();
      k.setMode('des');
      const r = runnerOf(x.v);
      expect(conveyors(r), 'the stale instance set is not reused').toBe(n0 + 1);
      expect(r.boundSceneGeneration).toBe(x.v.sceneGeneration);
    } finally { q.mockRestore(); }
  });

  it('a repeated placements-materialized rebinds once, an aborted one not at all', async () => {
    const x = (open = await load());
    const q = quietInfo();
    try {
      x.v.simulationKernel!.setMode('des');
      const r = runnerOf(x.v);
      const spy = vi.spyOn(r, 'rebindScene');
      x.v.emit('placements-materialized', { aborted: true, total: 1, materialized: 1, missing: 0 });
      expect(spy, 'aborted → nothing').not.toHaveBeenCalled();
      x.v.emit('placements-materialized', { aborted: false, total: 1, materialized: 1, missing: 0 });
      x.v.emit('placements-materialized', { aborted: false, total: 1, materialized: 1, missing: 0 });
      expect(spy, 'already served generation → no rebind').not.toHaveBeenCalled();
      spy.mockRestore();
    } finally { q.mockRestore(); }
  });

  it('R2-2: restore with an unbound scene change is refused before any change; after the rebind it works', async () => {
    const x = (open = await load());
    const q = quietInfo();
    try {
      x.v.simulationKernel!.setMode('des');
      const r = runnerOf(x.v);
      r.getManager().processUpTo(5, 2000);
      const snap = r.fullSnapshot();
      drop(x, 'Conveyor_10');                       // rebind pending (microtask)
      const t = r.simTime;
      expect(() => r.restoreFull(snap)).toThrow(/scene changed/);
      expect(r.simTime, 'nothing changed').toBe(t);
      expect(getProblems().some((p) => p.code === 'des-restore-scene-changed')).toBe(true);
      await flush();                                  // the pending rebind still runs
      expect(r.boundSceneGeneration).toBe(x.v.sceneGeneration);
      expect(getProblems().some((p) => p.code === 'des-restore-scene-changed'), 'cleared by the bind').toBe(false);
      r.getManager().processUpTo(3, 2000);
      // plan-2059: the fake drop is a bare clone without its own plan-769 identity,
      // so the rebound scene is not snapshottable — refused visibly, nothing guessed.
      // (A real planner drop gets a fresh reference NodeId and is addressable.)
      expect(() => r.fullSnapshot()).toThrow(/des-snapshot-unaddressable: .*Conveyor_10/);
    } finally { q.mockRestore(); }
  });
});

// ─── plan-687: the rebind debt, redeemed at the instancer's idle ────────
//
// A placement that lands AFTER the load (`materializeDeferred` via MCP /
// plugin / planner, or a nested reference of a dropped asset) raises the scene
// generation while the instancer is `materializing` — and `placements-materialized`
// fires only ONCE PER LOAD, so before plan-687 the DES runner saw the new
// conveyors only after the next manual reset (681 spike, finding A4).
//
// Every assertion below measures the EFFECT (a binding that was missing is
// there afterwards, on a demonstrably materialised placement), never that a
// method was called or a flag is set.

/** A runtime placement, queued SYNCHRONOUSLY — exactly the spike path. */
function queueRuntime(x: Loaded, name: string, xPos: number, path: string = CONVEYOR): Object3D {
  const n = new Object3D();
  n.name = name;
  n.position.set(xPos, 0, 0);
  setNodeId(n, `nid-rt-${name}`);
  setAssetReference(n, { assetId: `cat:${path.split('/').pop()}`, path });
  x.model.add(n);
  markDeferredPlacement(n, `occ-rt-${name}`, path);
  const queued = x.v.placements.materializeDeferred(collectDeferredPlacements(n));
  expect(queued, `queued ${name}`).toBe(1);
  return n;
}

/** Wait for the instancer AND the coalescing microtask. */
async function settle(x: Loaded): Promise<void> {
  await x.v.placements.whenMaterialized();
  await flush();
  await flush();
}

/** Release a placed subtree the way the planner does, then announce it. */
function releaseRuntime(x: Loaded, node: Object3D): void {
  disposeComponentsInSubtree(x.v.registry!, node);
  x.v.registry!.unregisterSubtree(node);
  x.v.placements.release?.(node);
  node.parent?.remove(node);
  x.v.emit('layout-content-removed', { root: node });
}

function lifecycleLog(v: RVViewer): string[] {
  const log: string[] = [];
  v.simulationKernel!.onDesLifecycle((e) => log.push(e.type));
  return log;
}

describe('plan-687 — a runtime placement is bound at the instancer idle', () => {
  it('9.1: two runtime placements in DES → ONE rebind, both conveyors bound, no manual reset', async () => {
    const x = (open = await load());
    const q = quietInfo();
    try {
      x.v.simulationKernel!.setMode('des');
      const r = runnerOf(x.v);
      const n0 = conveyors(r);
      const lc = lifecycleLog(x.v);
      const spy = vi.spyOn(r, 'rebindScene');
      queueRuntime(x, 'Conveyor_21', 12);
      queueRuntime(x, 'Conveyor_22', 18);
      expect(x.v.placements.state, 'the instancer took the work').toBe('materializing');
      expect(spy, 'nothing binds an incomplete scene').not.toHaveBeenCalled();
      await settle(x);
      expect(spy, 'two placements, one rebind').toHaveBeenCalledTimes(1);
      expect(conveyors(r), 'both new conveyors are live instances').toBe(n0 + 2);
      expect(r.boundSceneGeneration).toBe(x.v.sceneGeneration);
      expect(lc, 'exactly one reset to bound pair').toEqual(['reset', 'bound']);
      spy.mockRestore();
    } finally { q.mockRestore(); }
  });

  it('9.2b: removing a runtime placement at idle unbinds it', async () => {
    const x = (open = await load());
    const q = quietInfo();
    try {
      x.v.simulationKernel!.setMode('des');
      const r = runnerOf(x.v);
      const n0 = conveyors(r);
      const node = queueRuntime(x, 'Conveyor_23', 12);
      await settle(x);
      expect(conveyors(r)).toBe(n0 + 1);
      const spy = vi.spyOn(r, 'rebindScene');
      expect(x.v.placements.state, 'idle before the removal').toBe('idle');
      releaseRuntime(x, node);
      await flush();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(conveyors(r), 'the removed placement left the runner').toBe(n0);
      spy.mockRestore();
    } finally { q.mockRestore(); }
  });

  it('9.2c: a removal WHILE another placement materialises is redeemed by the same idle rebind', async () => {
    const x = (open = await load());
    const q = quietInfo();
    try {
      x.v.simulationKernel!.setMode('des');
      const r = runnerOf(x.v);
      const n0 = conveyors(r);
      const victim = queueRuntime(x, 'Conveyor_24', 12);
      await settle(x);
      expect(conveyors(r)).toBe(n0 + 1);
      const spy = vi.spyOn(r, 'rebindScene');
      queueRuntime(x, 'Conveyor_25', 18);           // instancer busy …
      releaseRuntime(x, victim);                     // … and a removal lands
      await settle(x);
      expect(spy, 'both changes share ONE rebind').toHaveBeenCalledTimes(1);
      expect(conveyors(r), 'the new one in, the removed one out').toBe(n0 + 1);
      expect(r.boundSceneGeneration).toBe(x.v.sceneGeneration);
      spy.mockRestore();
    } finally { q.mockRestore(); }
  });

  it('9.2d: a failing placement counts as completion — the burst still binds once', async () => {
    const x = (open = await load());
    const q = quietInfo();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      x.v.simulationKernel!.setMode('des');
      const r = runnerOf(x.v);
      const n0 = conveyors(r);
      const spy = vi.spyOn(r, 'rebindScene');
      queueRuntime(x, 'Conveyor_26', 12);
      queueRuntime(x, 'Broken_1', 24, 'library/does-not-exist/Nope.glb');
      await settle(x);
      expect(spy, 'one rebind for the whole burst').toHaveBeenCalledTimes(1);
      expect(conveyors(r), 'the successful one is bound').toBe(n0 + 1);

      // Second case: a burst that ONLY fails, while an existing placement is removed.
      const victim = queueRuntime(x, 'Conveyor_27', 30);
      await settle(x);
      const n1 = conveyors(r);
      spy.mockClear();
      queueRuntime(x, 'Broken_2', 36, 'library/does-not-exist/Nope2.glb');
      releaseRuntime(x, victim);
      await settle(x);
      expect(spy, 'the failing burst still redeems the debt').toHaveBeenCalledTimes(1);
      expect(conveyors(r), 'the removed one is out').toBe(n1 - 1);
      spy.mockRestore();
    } finally { q.mockRestore(); warn.mockRestore(); }
  });

  it('9.2e: a waiting job that meets a fresh materialisation binds once, at the idle', async () => {
    const x = (open = await load());
    const q = quietInfo();
    try {
      x.v.simulationKernel!.setMode('des');
      const r = runnerOf(x.v);
      const victim = queueRuntime(x, 'Conveyor_28', 12);
      await settle(x);
      const n0 = conveyors(r);
      const spy = vi.spyOn(r, 'rebindScene');
      // Same synchronous block, no await in between: the removal schedules the
      // job, the new placement puts the instancer back to `materializing`.
      releaseRuntime(x, victim);
      queueRuntime(x, 'Conveyor_29', 18);
      await flush();
      expect(spy, 'the job does not bind an interim scene').not.toHaveBeenCalled();
      await settle(x);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(conveyors(r), 'one out, one in').toBe(n0);
      expect(r.boundSceneGeneration).toBe(x.v.sceneGeneration);
      spy.mockRestore();
    } finally { q.mockRestore(); }
  });

  it('9.3: boot into DES — the load path still binds exactly once', async () => {
    const h = await createTestViewer('webgl');
    const v = h.viewer;
    open = { h, v, model: v.scene };
    const q = quietInfo();
    const spy = vi.spyOn(DESRunner.prototype, 'rebindScene');
    try {
      v.loop.setPaused('plan-687-boot-des', true);
      registerAllBehaviors(v.behaviors);
      // Boot-into-DES: the mode is set while the references still materialise.
      v.on('model-loaded', () => { v.simulationKernel!.setMode('des'); });
      const doc = new Group();
      doc.name = 'BootDesDoc';
      doc.add(refNode('Conveyor_1', CONVEYOR, 0), refNode('Conveyor_2', CONVEYOR, 3), refNode('PalletSink_1', SINK, 6));
      await v.loadModel('plan-687-boot-des.glb', { data: await objectToGlb(doc) });
      await v.whenSceneReady();
      await flush();
      await flush();
      const calls = spy.mock.calls.length;
      expect(calls, 'the load binds once — the idle listener adds nothing').toBe(1);
      const r = runnerOf(v);
      expect(conveyors(r)).toBe(2);
      expect(r.boundSceneGeneration).toBe(v.sceneGeneration);
      // A further idle with no content change adds no rebind.
      await settle({ h, v, model: v.scene });
      expect(spy.mock.calls.length).toBe(calls);
    } finally { q.mockRestore(); spy.mockRestore(); }
  });

  it('9.4: a document change lets the debt lapse — no rebind of a scene that is gone', async () => {
    const x = (open = await load());
    const q = quietInfo();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      x.v.simulationKernel!.setMode('des');
      const r = runnerOf(x.v);
      const spy = vi.spyOn(r, 'rebindScene');
      queueRuntime(x, 'Conveyor_30', 12);
      expect(x.v.placements.state).toBe('materializing');
      x.v.clearModel();                     // before the idle
      await x.v.placements.whenMaterialized();
      await flush();
      await flush();
      expect(spy, 'the lapsed debt binds nothing').not.toHaveBeenCalled();
      // And the state is clean: a later idle without a content change is a no-op.
      await settle(x);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    } finally { q.mockRestore(); warn.mockRestore(); }
  });

  it('9.6a: continuous mode redeems nothing; the next setMode(des) binds the full scene', async () => {
    const x = (open = await load());
    const q = quietInfo();
    try {
      const k = x.v.simulationKernel!;
      k.setMode('des');
      const n0 = conveyors(runnerOf(x.v));
      const spy = vi.spyOn(DESRunner.prototype, 'rebindScene');
      k.setMode('continuous');
      queueRuntime(x, 'Conveyor_31', 12);
      await settle(x);
      expect(spy, 'no rebind outside DES').not.toHaveBeenCalled();
      k.setMode('des');
      const r = runnerOf(x.v);
      expect(conveyors(r), 'the runtime placement is bound on the switch').toBe(n0 + 1);
      expect(r.boundSceneGeneration).toBe(x.v.sceneGeneration);
      spy.mockRestore();
    } finally { q.mockRestore(); }
  });

  it('9.6b: a reset in the same block as a synchronous content change → ONE rebind', async () => {
    const x = (open = await load());
    const q = quietInfo();
    try {
      x.v.simulationKernel!.setMode('des');
      const r = runnerOf(x.v);
      const n0 = conveyors(r);
      const spy = vi.spyOn(r, 'rebindScene');
      expect(x.v.placements.state).toBe('idle');
      drop(x, 'Conveyor_32');            // synchronous content + announcement
      x.v.resetSimulation();             // start() rebinds on the new generation
      await flush();
      expect(spy, 'the reset served the generation, the job stands down').toHaveBeenCalledTimes(1);
      expect(conveyors(r)).toBe(n0 + 1);
      expect(r.boundSceneGeneration).toBe(x.v.sceneGeneration);
      spy.mockRestore();
    } finally { q.mockRestore(); }
  });

  it('9.6c: a reset during a pending materialisation — the idle still binds the placement', async () => {
    const x = (open = await load());
    const q = quietInfo();
    try {
      x.v.simulationKernel!.setMode('des');
      const r = runnerOf(x.v);
      const n0 = conveyors(r);
      queueRuntime(x, 'Conveyor_33', 12);
      x.v.resetSimulation();             // the placement is not there yet
      await settle(x);
      expect(conveyors(r), 'the placement is bound in the end').toBe(n0 + 1);
      expect(r.boundSceneGeneration).toBe(x.v.sceneGeneration);
    } finally { q.mockRestore(); }
  });
});

describe('plan-687 — withholding rebinds at all three origins (plan-681 contract)', () => {
  const hold = (v: RVViewer) =>
    vi.spyOn(v as unknown as { _desRebindHeld(): boolean }, '_desRebindHeld').mockReturnValue(true);
  const take = (v: RVViewer): boolean =>
    (v as unknown as { _takeDesRebindDue(): boolean })._takeDesRebindDue();

  it('9.5a: a job scheduled BEFORE the hold does not bind; the debt survives', async () => {
    const x = (open = await load());
    const q = quietInfo();
    try {
      x.v.simulationKernel!.setMode('des');
      const r = runnerOf(x.v);
      const lc = lifecycleLog(x.v);
      const spy = vi.spyOn(r, 'rebindScene');
      drop(x, 'Conveyor_41');                 // job scheduled
      const h = hold(x.v);                    // … then the transaction opens
      await flush();
      expect(spy, 'the waiting job is withheld').not.toHaveBeenCalled();
      h.mockRestore();
      expect(take(x.v), 'the debt is handed over').toBe(true);
      expect(take(x.v), 'exactly once').toBe(false);
      x.v.resetSimulation();                  // stand-in for the close
      expect(lc.filter((t) => t === 'bound'), 'exactly one bind').toHaveLength(1);
      spy.mockRestore();
    } finally { q.mockRestore(); }
  });

  it('9.5b: an idle inside the hold leaves the debt standing', async () => {
    const x = (open = await load());
    const q = quietInfo();
    try {
      x.v.simulationKernel!.setMode('des');
      const r = runnerOf(x.v);
      const lc = lifecycleLog(x.v);
      const spy = vi.spyOn(r, 'rebindScene');
      const h = hold(x.v);
      queueRuntime(x, 'Conveyor_42', 12);
      await settle(x);
      expect(spy, 'no rebind while withheld').not.toHaveBeenCalled();
      h.mockRestore();
      expect(take(x.v)).toBe(true);
      expect(take(x.v)).toBe(false);
      x.v.resetSimulation();
      expect(lc.filter((t) => t === 'bound')).toHaveLength(1);
      spy.mockRestore();
    } finally { q.mockRestore(); }
  });

  it('9.5c: the load branch under a hold does not bind directly', async () => {
    const x = (open = await load());
    const q = quietInfo();
    try {
      x.v.simulationKernel!.setMode('des');
      const r = runnerOf(x.v);
      const spy = vi.spyOn(r, 'rebindScene');
      const h = hold(x.v);
      drop(x, 'Conveyor_43');                 // generation moved on
      x.v.emit('placements-materialized', { aborted: false, total: 1, materialized: 1, missing: 0 });
      expect(spy, 'the settle branch is withheld too').not.toHaveBeenCalled();
      await flush();
      expect(spy).not.toHaveBeenCalled();
      h.mockRestore();
      expect(take(x.v)).toBe(true);
      spy.mockRestore();
    } finally { q.mockRestore(); }
  });

  it('9.5d: under an active hold at idle no job is scheduled at all', async () => {
    const x = (open = await load());
    const q = quietInfo();
    try {
      x.v.simulationKernel!.setMode('des');
      const r = runnerOf(x.v);
      const spy = vi.spyOn(r, 'rebindScene');
      const h = hold(x.v);
      expect(x.v.placements.state).toBe('idle');
      const node = drop(x, 'Conveyor_44');
      expect((x.v as unknown as { _desRebindPending: unknown })._desRebindPending, 'no job').toBeNull();
      await flush();
      expect(spy).not.toHaveBeenCalled();
      remove(x, node);
      await flush();
      expect(spy).not.toHaveBeenCalled();
      h.mockRestore();
      expect(take(x.v)).toBe(true);
      spy.mockRestore();
    } finally { q.mockRestore(); }
  });

  it('9.5e: taking the debt over cancels a waiting job — the close binds once', async () => {
    const x = (open = await load());
    const q = quietInfo();
    try {
      x.v.simulationKernel!.setMode('des');
      const r = runnerOf(x.v);
      const lc = lifecycleLog(x.v);
      const spy = vi.spyOn(r, 'rebindScene');
      drop(x, 'Conveyor_45');                 // job scheduled, hold NOT active
      expect(take(x.v), 'the waiting job is the debt').toBe(true);
      expect(take(x.v)).toBe(false);
      await flush();
      expect(spy, 'the cancelled job is inert').not.toHaveBeenCalled();
      x.v.resetSimulation();
      expect(lc.filter((t) => t === 'bound')).toHaveLength(1);
      spy.mockRestore();
    } finally { q.mockRestore(); }
  });
});

describe('plan-687 — nested content and the PlanningRegistry apply', () => {
  /** GLB bytes as a `data:` url — a reference path under such a base passes through as written. */
  function dataUrlOf(bytes: ArrayBuffer): string {
    const view = new Uint8Array(bytes);
    let binary = '';
    for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
    return `data:model/gltf-binary;base64,${btoa(binary)}`;
  }

  /** An outer asset: a frame plus ONE planner reference to `innerPath`, named `innerName`. */
  async function outerAssetUrl(innerName: string, innerPath: string): Promise<string> {
    const root = new Group();
    root.name = 'Machine';
    const frame = new Mesh(new BoxGeometry(1, 0.2, 1), new MeshStandardMaterial({ color: 0x777777 }));
    frame.name = 'Frame';
    root.add(frame);
    const ref = refNode(innerName, innerPath, 2);
    setPlacementMeta(ref, {});
    root.add(ref);
    return dataUrlOf(await objectToGlb(root));
  }

  const instanceNames = (r: DESRunner): string[] => r.liveInstances.map((i) => i.adapter.node.name);

  it('9.2a: a runtime placement WITH a nested reference → ONE rebind, both levels bound', async () => {
    const x = (open = await load());
    const q = quietInfo();
    try {
      x.v.simulationKernel!.setMode('des');
      const r = runnerOf(x.v);
      const n0 = conveyors(r);
      const spy = vi.spyOn(r, 'rebindScene');
      const gen0 = x.v.sceneGeneration;
      const outerUrl = await outerAssetUrl('PalletSink_51', SINK);
      // The outer placement is itself DES content (name → the `Conveyor`
      // definition), and it carries a nested reference to a PalletSink. The
      // instancer queues the nested reference as the LAST step of
      // `materialize()` — BEFORE it registers and announces the outer one, so
      // the outer `layout-content-added` already sees `materializing`.
      queueRuntime(x, 'Conveyor_51', 24, outerUrl);
      expect(spy, 'nothing binds a half-materialised placement tree').not.toHaveBeenCalled();
      await flush();
      expect(spy, 'and nothing after the first microtask either').not.toHaveBeenCalled();
      await settle(x);
      expect(spy, 'outer + nested share ONE rebind').toHaveBeenCalledTimes(1);
      expect(x.v.placements.progress, 'both levels materialised').toMatchObject({ state: 'idle', pending: 0, missing: 0 });
      expect(x.v.sceneGeneration - gen0, 'the outer AND the nested content announced themselves').toBeGreaterThanOrEqual(2);
      expect(conveyors(r), 'the outer placement is bound').toBe(n0 + 1);
      // Both levels, addressed by subtree rather than by name: the bound node of
      // a nested placement is its CONTENT root, not the reference node.
      const placed = find(x.model, 'Conveyor_51')!;
      const under = (n: Object3D): boolean => {
        for (let c: Object3D | null = n; c; c = c.parent) if (c === placed) return true;
        return false;
      };
      const bound = r.liveInstances.filter((i) => under(i.adapter.node));
      expect(bound.length, 'outer + nested, nothing else').toBe(2);
      expect(bound.some((i) => i.adapter.node === placed), 'the OUTER content is bound').toBe(true);
      const nested = bound.find((i) => i.adapter.node !== placed);
      expect(nested, 'the NESTED content is bound too').toBeTruthy();
      expect(under(find(placed, 'PalletSink_51')!), 'the nested reference node is in the placement').toBe(true);
      expect(r.boundSceneGeneration).toBe(x.v.sceneGeneration);
      void instanceNames;
      spy.mockRestore();
    } finally { q.mockRestore(); }
  });

  it('9.6d: PlanningRegistry apply with the default runner — the owner places, the idle binds once', async () => {
    const x = (open = await load());
    const q = quietInfo();
    try {
      x.v.simulationKernel!.setMode('des');
      const r = runnerOf(x.v);
      const n0 = conveyors(r);
      const spy = vi.spyOn(r, 'rebindScene');
      const registry = createPlanningRegistry();
      registry.declare({
        owner: 'plan687',
        title: 'plan-687 test owner',
        params: [{ key: 'count', label: 'Count', type: 'integer', default: 0, group: 'Test', apply: 'reset' }],
        onStructuralReset: async () => {
          queueRuntime(x, 'Conveyor_61', 30);
          await x.v.placements.whenMaterialized();
        },
      });
      expect(registry.set('plan687.count', 1, 'mcp').ok, 'the pending value is accepted').toBe(true);
      const res = await registry.applyPendingAndReset();
      expect(res.ok, res.error ?? 'apply').toBe(true);
      await flush();
      await flush();
      expect(spy, 'the runtime placement of the apply is bound by ONE rebind').toHaveBeenCalledTimes(1);
      expect(conveyors(r)).toBe(n0 + 1);
      expect(r.boundSceneGeneration).toBe(x.v.sceneGeneration);
      spy.mockRestore();
    } finally { q.mockRestore(); }
  });
});
