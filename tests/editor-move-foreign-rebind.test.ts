// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-614 F1 — the re-bind of FOREIGN referrers at the end of a
 * reference-rewrite range keeps the target IDENTITY.
 *
 * A foreign referrer is a component whose extras the range does not write
 * (content of a placed asset, in the real editor). plan-610 re-resolved its
 * unchanged extras after the move; an OLD ABSOLUTE spelling then landed by
 * suffix on a FOREIGN twin, and undo could not repair it (spike 614, part 1:
 * "nach Move UND nach Undo fremd gebunden"). F1 applies the session's composed
 * remap ONCE to the address the field held and sets exactly that address.
 *
 *  1. The spike repro on the REAL PlacementInstancer / ModelCache chain as a
 *     regression test: move, undo, redo — and two moves in a row (A→B→C) with
 *     undo/redo — the Lamp reacts to its OWN signal and never to the foreign one.
 *  2. Unit level on the renderer-free fixture. A hand-built MARKED composite
 *     without rewrite steps makes every referrer foreign to the executor — the
 *     exact code path placed content takes (a structural op inside a placement
 *     is refused by the document, so the moved node is document-owned here):
 *     - neighbour fields stay bit-identical (value AND instance / array identity),
 *     - a mixed array changes only its affected element,
 *     - the composed remap inside ONE composite: A→B→C and A→B→A,
 *     - refuse instead of guess: a remapped address without a live node rejects
 *       the action (ReferenceRebindError with the reason), rolls it back and
 *       leaves every binding untouched.
 *     - move a node, then move its NEW parent (two composites, and ONE composite
 *       = the batch shape): binds transitively; a refusal there is a bug.
 *     The real chain covers the same "then move the new parent" case as two
 *     composites and as one transaction (one undo step).
 *  3. The void `renameNode` reports a ReferenceRebindError (console.warn + the
 *     viewer event `editor-edit-refused` + the HMI toast) and stays rolled back.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { makeSpikeViewer, op, ref, extrasOf, HOLDER, IDENTITY_T } from './helpers/spike-610-ref-fixture';
import { makeAssetComposite } from '../src/core/ops/rv-unified-ops';
import type { RvAssetPrimitiveOp } from '../src/core/ops/rv-unified-ops';
import { ReferenceRebindError } from '../src/core/editor/rv-asset-executors';
import { RVLamp } from '../src/core/engine/rv-lamp';
import { applySchema, resolveComponentRefs } from '../src/core/engine/rv-component-registry';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { ModelCache } from '../src/core/engine/rv-model-cache';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { installEditRefusalWiring, EDIT_REFUSED_TOAST_ID } from '../src/core/hmi/edit-refusal-wiring';
import { getInstructions, _resetStoreForTests } from '../src/core/hmi/instruction-store';
import { referenceNode, findByName } from './helpers/nested-placement-fixture';

const SIG_T = 'realvirtual.PLCOutputBool';
const DRIVE_T = 'realvirtual.Drive';
const MARK = { referenceRewrite: true as const };

type Doc = ReturnType<typeof scratchAssetDocument>;
const rebindInfo = (doc: Doc) =>
  (doc.executor as unknown as { lastRefRebind: { deferred: number; foreign: number; stalePaths: number; failed: number } | null }).lastRefRebind;

// ─── 1. The spike repro on the REAL placement chain ──────────────────────

const CELL_URL = 'blob:rv-test/p614-f1-cell.glb';
/** The reference is written as the document's OLD ABSOLUTE path. */
const OLD_ABSOLUTE = 'Root/Old/Machine/Signals/S';

function signalObject(name: string, signal: string): Object3D {
  const n = new Object3D();
  n.name = name;
  n.userData.realvirtual = { PLCOutputBool: { Name: signal, Status: { Value: false } } };
  return n;
}

/** The placed asset: Signals/S and a Lamp whose reference is the OLD absolute path. */
function cell(): Group {
  const root = new Group();
  root.name = 'Cell';
  const signals = new Object3D();
  signals.name = 'Signals';
  signals.add(signalObject('S', 'P614.S'));
  root.add(signals);
  const lamp = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial({ color: 0x777777 }));
  lamp.name = 'Lamp';
  lamp.userData.realvirtual = { Lamp: { SignalLampOn: ref(OLD_ABSOLUTE, SIG_T) } };
  root.add(lamp);
  return root;
}

/**
 *   Root
 *   ├── Old/Machine                       ← placement of `Cell` (moved via Old)
 *   ├── New, Next                         ← move destinations
 *   └── Other/Root/Old/Machine/Signals/S  ← document-owned FOREIGN twin `P614.Foreign`
 */
function documentTree(): Group {
  const doc = new Group();
  doc.name = 'Root';
  const old = new Object3D(); old.name = 'Old';
  const fresh = new Object3D(); fresh.name = 'New';
  const next = new Object3D(); next.name = 'Next';
  old.add(referenceNode('Machine', 'nid-p614-f1-machine', CELL_URL, true, [0, 0, 0]));
  let parent: Object3D = new Object3D(); parent.name = 'Other';
  const other = parent;
  for (const name of ['Root', 'Old', 'Machine', 'Signals']) {
    const n = new Object3D(); n.name = name; parent.add(n); parent = n;
  }
  parent.add(signalObject('S', 'P614.Foreign'));
  doc.add(old, fresh, next, other);
  return doc;
}

describe('plan-614 F1 — editor move of a document-owned ancestor, foreign suffix twin (REAL placement chain)', () => {
  let h: TestViewerHandle | null = null;
  afterEach(() => { h?.dispose(); h = null; });

  async function loadScene() {
    h = await createTestViewer('webgl');
    const loader = { loadAsync: async () => ({ scene: cell() }) } as unknown as GLTFLoader;
    h.viewer.placements.setModelCache(new ModelCache(loader, {
      uber: () => h!.viewer.placementUberMaterial,
      isWebGPU: () => h!.viewer.isWebGPU,
      pickPort: () => createPickBuildPort({ createWorker: () => null }),
    }));
    h.viewer.setSimulationPaused('p614-f1', true);
    await h.viewer.loadModel('p614-f1.glb', { data: await objectToGlb(documentTree()) });
    await h.viewer.whenSceneReady();

    const viewer = h.viewer;
    const reg = viewer.registry!;
    const store = viewer.signalStore!;
    const root = viewer.currentModelRoot!;
    const lampNode = findByName(root, 'Lamp')!;
    const machine = findByName(root, 'Machine')!;
    const oldNode = findByName(root, 'Old')!;
    const otherNode = findByName(root, 'Other')!;
    expect(lampNode, 'placed Lamp node').toBeTruthy();
    const lamp = reg.getByPath<RVLamp>('Lamp', reg.getPathForNode(lampNode)!)!;
    expect(lamp, 'placed Lamp is a live component').toBeTruthy();
    const firstS = (under: Object3D): Object3D | null => {
      let s: Object3D | null = null;
      under.traverse((n) => { if (!s && n.name === 'S') s = n; });
      return s;
    };
    const ownS = firstS(machine)!;
    const foreignS = firstS(otherNode)!;
    expect(ownS && foreignS, 'both S nodes exist').toBeTruthy();

    const reacts = (signal: string): boolean => {
      store.set(signal, false); const before = lamp.LampOn;
      store.set(signal, true); const after = lamp.LampOn;
      store.set(signal, false);
      return before === false && after === true;
    };
    /** The Lamp holds its OWN signal's current path and reacts to it — and only to it. */
    const expectOwnBinding = (phase: string) => {
      const own = reg.getPathForNode(ownS);
      const foreign = reg.getPathForNode(foreignS);
      expect(lamp.SignalLampOn, `${phase}: Lamp holds its own S`).toBe(own);
      expect(lamp.SignalLampOn, `${phase}: Lamp does not hold the foreign twin`).not.toBe(foreign);
      expect(reacts('P614.S'), `${phase}: the own signal drives the Lamp`).toBe(true);
      expect(reacts('P614.Foreign'), `${phase}: the foreign signal does not`).toBe(false);
      // The placed asset's extras are never written.
      expect(extrasOf(lampNode, 'Lamp').SignalLampOn).toEqual(ref(OLD_ABSOLUTE, SIG_T));
      return own;
    };
    const pathOf = (name: string) => reg.getPathForNode(findByName(root, name)!)!;
    return { viewer, reg, root, oldNode, expectOwnBinding, pathOf };
  }

  it('move, undo, redo: the Lamp stays on its own signal (spike 614 repro)', async () => {
    const s = await loadScene();
    const loaded = s.expectOwnBinding('loaded');
    const doc = scratchAssetDocument(s.viewer);

    await doc.reparentNodes([s.reg.getPathForNode(s.oldNode)!], s.pathOf('New'));
    const moved = s.expectOwnBinding('after move');
    expect(moved).not.toBe(loaded);
    expect(moved).toContain('/New/Old/');
    expect(rebindInfo(doc)).toMatchObject({ failed: 0 });

    await doc.undo();
    expect(s.expectOwnBinding('after undo')).toBe(loaded);

    await doc.redo();
    expect(s.expectOwnBinding('after redo')).toBe(moved);
    doc.dispose();
  }, 120_000);

  it('two moves in a row (A→B→C), undo both, redo both', async () => {
    const s = await loadScene();
    const a = s.expectOwnBinding('loaded');
    const doc = scratchAssetDocument(s.viewer);

    await doc.reparentNodes([s.reg.getPathForNode(s.oldNode)!], s.pathOf('New'));
    const b = s.expectOwnBinding('after A→B');
    await doc.reparentNodes([s.reg.getPathForNode(s.oldNode)!], s.pathOf('Next'));
    const c = s.expectOwnBinding('after B→C');
    expect(c).toContain('/Next/Old/');
    expect(new Set([a, b, c]).size).toBe(3);

    await doc.undo();
    expect(s.expectOwnBinding('after undo B→C')).toBe(b);
    await doc.undo();
    expect(s.expectOwnBinding('after undo A→B')).toBe(a);
    await doc.redo();
    expect(s.expectOwnBinding('after redo A→B')).toBe(b);
    await doc.redo();
    expect(s.expectOwnBinding('after redo B→C')).toBe(c);
    doc.dispose();
  }, 120_000);

  it('move a node, then move its NEW parent (two composites): undo both, redo both', async () => {
    const s = await loadScene();
    const a = s.expectOwnBinding('loaded');
    const doc = scratchAssetDocument(s.viewer);

    await doc.reparentNodes([s.reg.getPathForNode(s.oldNode)!], s.pathOf('New'));
    const b = s.expectOwnBinding('after Old → New');
    expect(rebindInfo(doc)).toMatchObject({ failed: 0 });
    // Now the NEW parent moves: the field's address moves a second time.
    await doc.reparentNodes([s.pathOf('New')], s.pathOf('Next'));
    const c = s.expectOwnBinding('after New → Next');
    expect(rebindInfo(doc)).toMatchObject({ failed: 0 });
    expect(c).toContain('/Next/New/Old/');
    expect(new Set([a, b, c]).size).toBe(3);

    await doc.undo();
    expect(s.expectOwnBinding('after undo New → Next')).toBe(b);
    await doc.undo();
    expect(s.expectOwnBinding('after undo Old → New')).toBe(a);
    await doc.redo();
    expect(s.expectOwnBinding('after redo Old → New')).toBe(b);
    await doc.redo();
    expect(s.expectOwnBinding('after redo New → Next')).toBe(c);
    doc.dispose();
  }, 120_000);

  it('move a node, then move its NEW parent inside ONE transaction (one undo step): undo, redo', async () => {
    const s = await loadScene();
    const a = s.expectOwnBinding('loaded');
    const doc = scratchAssetDocument(s.viewer);

    await doc.withTransaction('Move twice', async () => {
      await doc.reparentNodes([s.reg.getPathForNode(s.oldNode)!], s.pathOf('New'));
      await doc.reparentNodes([s.pathOf('New')], s.pathOf('Next'));
    });
    const c = s.expectOwnBinding('after the transaction');
    expect(c).toContain('/Next/New/Old/');
    expect(rebindInfo(doc)).toMatchObject({ failed: 0 });
    expect(doc.ops).toHaveLength(1);

    await doc.undo();
    expect(s.expectOwnBinding('after undo')).toBe(a);
    await doc.redo();
    expect(s.expectOwnBinding('after redo')).toBe(c);
    doc.dispose();
  }, 120_000);
});

// ─── 2. Unit level: neighbour fields, composed remap, refusal ───────────

/**
 *   Asset
 *   ├── Signals/On (P614.On), Signals/Go (P614.Go)
 *   ├── Bin, Bin2                 ← move destinations of `On`
 *   ├── Axis                      ← Drive (instance reference target)
 *   ├── Lamp                      ← Lamp.SignalLampOn → Signals/On
 *   ├── Holder                    ← Sig → Signals/On; DriveA → Axis; Tools → [Go, Go]; Label
 *   └── Holder2                   ← Tools → [Go, On] (mixed array)
 */
function unitFixture() {
  const f = makeSpikeViewer({ signals: true });
  const signals = f.add(f.model, 'Signals');
  const on = f.signalNode(signals, 'On', 'P614.On');
  const go = f.signalNode(signals, 'Go', 'P614.Go');
  const bin = f.add(f.model, 'Bin');
  const bin2 = f.add(f.model, 'Bin2');
  const axis = f.add(f.model, 'Axis');
  const lampNode = f.add(f.model, 'Lamp');
  const holderNode = f.add(f.model, 'Holder');
  const holder2Node = f.add(f.model, 'Holder2');
  f.register();
  const drive = f.drive(axis);
  // A Lamp built like the loader builds it.
  const lampExtras = { SignalLampOn: ref('Signals/On', SIG_T) };
  lampNode.userData.realvirtual = { Lamp: lampExtras };
  const lamp = new RVLamp(lampNode);
  applySchema(lamp as unknown as Record<string, unknown>, RVLamp.schema, lampExtras);
  resolveComponentRefs(lamp as unknown as Record<string, unknown>, f.registry, lampNode);
  f.registry.register('Lamp', NodeRegistry.computeNodePath(lampNode), lamp);
  lamp.init({ registry: f.registry, signalStore: f.store } as never);
  const holder = f.component(holderNode, HOLDER, {
    Sig: ref('Signals/On', SIG_T),
    DriveA: ref('Axis', DRIVE_T),
    Tools: [ref('Signals/Go', SIG_T), ref('Signals/Go', SIG_T)],
    Label: 'keep',
  });
  const holder2 = f.component(holder2Node, HOLDER, {
    Tools: [ref('Signals/Go', SIG_T), ref('Signals/On', SIG_T)],
  });
  return { ...f, signals, on, go, bin, bin2, axis, drive, lampNode, lamp, holderNode, holder, holder2Node, holder2 };
}

type Unit = ReturnType<typeof unitFixture>;

const ON = 'Asset/Signals/On';
const GO = 'Asset/Signals/Go';

/** Move `On` from `from` (a parent path) to `to`; `prevIndex` = its index under `from`. */
const moveOn = (from: string, to: string, prevIndex = 0, newIndex?: number): RvAssetPrimitiveOp => op({
  kind: 'reparentNode', nodePath: `${from}/On`, newParentPath: to,
  ...(newIndex !== undefined ? { newIndex } : {}),
  transform: IDENTITY_T, prevParentPath: from, prevIndex, prevTransform: IDENTITY_T,
});

/** Move `Bin` (the node `On` was moved into) under `Bin2`. Bin is the 2nd child of `Asset`. */
const moveBin = (): RvAssetPrimitiveOp => op({
  kind: 'reparentNode', nodePath: 'Asset/Bin', newParentPath: 'Asset/Bin2',
  transform: IDENTITY_T, prevParentPath: 'Asset', prevIndex: 1, prevTransform: IDENTITY_T,
});

const lampReactsTo = (f: Unit, signal: string): boolean => {
  f.store!.set(signal, false); const before = f.lamp.LampOn;
  f.store!.set(signal, true); const after = f.lamp.LampOn;
  f.store!.set(signal, false);
  return before === false && after === true;
};

/** Every reference to `On` sits on `onPath`; every neighbour is exactly as loaded. */
function expectBound(f: Unit, onPath: string, neighbours: { tools: unknown; drive: unknown }) {
  expect(f.registry.getPathForNode(f.on)).toBe(onPath);
  expect(f.lamp.SignalLampOn).toBe(onPath);
  expect(f.holder.Sig).toBe(onPath);
  expect(f.holder2.Tools).toEqual([GO, onPath]);
  expect(f.store!.getPath('P614.On')).toBe(onPath);
  expect(lampReactsTo(f, 'P614.On')).toBe(true);
  // Neighbour fields: bit-identical — the array is the SAME array, the drive the SAME instance.
  expect(f.holder.Tools).toBe(neighbours.tools);
  expect(f.holder.Tools).toEqual([GO, GO]);
  expect(f.holder.DriveA).toBe(neighbours.drive);
  expect(f.holder.DriveA).toBe(f.drive);
  expect(f.holder.DriveB ?? null).toBeNull();
  expect(f.holder.Label).toBe('keep');
  // Extras are never written by the foreign re-bind.
  expect(extrasOf(f.holderNode, HOLDER).Sig).toEqual(ref('Signals/On', SIG_T));
  expect(extrasOf(f.holder2Node, HOLDER).Tools).toEqual([ref('Signals/Go', SIG_T), ref('Signals/On', SIG_T)]);
  expect(extrasOf(f.lampNode, 'Lamp').SignalLampOn).toEqual(ref('Signals/On', SIG_T));
}

describe('plan-614 F1 — foreign re-bind at unit level (renderer-free fixture)', () => {
  it('loaded state', () => {
    const f = unitFixture();
    expectBound(f, ON, { tools: f.holder.Tools, drive: f.drive });
  });

  it('only the remapped fields change; neighbour fields stay bit-identical — forward, undo, redo', async () => {
    const f = unitFixture();
    const neighbours = { tools: f.holder.Tools, drive: f.holder.DriveA };
    const mixedBefore = f.holder2.Tools as unknown[];
    const goElement = mixedBefore[0];
    const doc = scratchAssetDocument(f.viewer);

    await doc.applyOp(makeAssetComposite('Move', [moveOn('Asset/Signals', 'Asset/Bin')], MARK) as never);
    expect(rebindInfo(doc)).toMatchObject({ failed: 0 });
    expect(rebindInfo(doc)!.foreign).toBeGreaterThanOrEqual(3);
    expectBound(f, 'Asset/Bin/On', neighbours);
    // The mixed array changed ONLY its affected element.
    expect((f.holder2.Tools as unknown[])[0]).toBe(goElement);

    await doc.undo();
    expectBound(f, ON, neighbours);
    await doc.redo();
    expectBound(f, 'Asset/Bin/On', neighbours);
    doc.dispose();
  });

  it('composed remap inside ONE composite: A→B→C binds to C; undo back to A; redo to C', async () => {
    const f = unitFixture();
    const neighbours = { tools: f.holder.Tools, drive: f.holder.DriveA };
    const doc = scratchAssetDocument(f.viewer);
    await doc.applyOp(makeAssetComposite('Move twice', [
      moveOn('Asset/Signals', 'Asset/Bin'),
      moveOn('Asset/Bin', 'Asset/Bin2'),
    ], MARK) as never);
    expect(rebindInfo(doc)).toMatchObject({ failed: 0 });
    expectBound(f, 'Asset/Bin2/On', neighbours);
    await doc.undo();
    expectBound(f, ON, neighbours);
    await doc.redo();
    expectBound(f, 'Asset/Bin2/On', neighbours);
    doc.dispose();
  });

  it('composed remap inside ONE composite: A→B→A touches nothing', async () => {
    const f = unitFixture();
    const neighbours = { tools: f.holder.Tools, drive: f.holder.DriveA };
    const sigBefore = f.holder.Sig;
    const mixedBefore = f.holder2.Tools;
    const doc = scratchAssetDocument(f.viewer);
    await doc.applyOp(makeAssetComposite('There and back', [
      moveOn('Asset/Signals', 'Asset/Bin'),
      moveOn('Asset/Bin', 'Asset/Signals', 0, 0),
    ], MARK) as never);
    expect(rebindInfo(doc)).toMatchObject({ stalePaths: 0, foreign: 0, failed: 0 });
    expectBound(f, ON, neighbours);
    expect(f.holder.Sig).toBe(sigBefore);
    expect(f.holder2.Tools).toBe(mixedBefore);
    await doc.undo();
    expectBound(f, ON, neighbours);
    await doc.redo();
    expectBound(f, ON, neighbours);
    doc.dispose();
  });

  it('move On, then move its NEW parent Bin — two composites: transitive binding, undo/redo', async () => {
    const f = unitFixture();
    const neighbours = { tools: f.holder.Tools, drive: f.holder.DriveA };
    expect(f.model.children.indexOf(f.bin)).toBe(1); // moveBin's prevIndex
    const doc = scratchAssetDocument(f.viewer);
    await doc.applyOp(makeAssetComposite('Move On', [moveOn('Asset/Signals', 'Asset/Bin')], MARK) as never);
    expect(rebindInfo(doc)).toMatchObject({ failed: 0 });
    expectBound(f, 'Asset/Bin/On', neighbours);
    await doc.applyOp(makeAssetComposite('Move Bin', [moveBin()], MARK) as never);
    expect(rebindInfo(doc)).toMatchObject({ failed: 0 });
    expectBound(f, 'Asset/Bin2/Bin/On', neighbours);
    expect(lampReactsTo(f, 'P614.Go')).toBe(false);

    await doc.undo();
    expectBound(f, 'Asset/Bin/On', neighbours);
    await doc.undo();
    expectBound(f, ON, neighbours);
    await doc.redo();
    expectBound(f, 'Asset/Bin/On', neighbours);
    await doc.redo();
    expectBound(f, 'Asset/Bin2/Bin/On', neighbours);
    doc.dispose();
  });

  it('move On, then move its NEW parent Bin — ONE composite (the batch shape): transitive binding, undo/redo', async () => {
    const f = unitFixture();
    const neighbours = { tools: f.holder.Tools, drive: f.holder.DriveA };
    expect(f.model.children.indexOf(f.bin)).toBe(1);
    const doc = scratchAssetDocument(f.viewer);
    // The shape `reparentNodesBatch` produces: reparent primitives in ONE marked
    // composite, one re-bind flush. (`reparentNodesBatch` itself takes ONE target
    // parent, so "On -> Bin, then Bin -> Bin2" can only be expressed as this composite.)
    await doc.applyOp(makeAssetComposite('Move On + Bin', [
      moveOn('Asset/Signals', 'Asset/Bin'),
      moveBin(),
    ], MARK) as never);
    expect(rebindInfo(doc)).toMatchObject({ failed: 0 });
    expectBound(f, 'Asset/Bin2/Bin/On', neighbours);
    expect(lampReactsTo(f, 'P614.Go')).toBe(false);
    await doc.undo();
    expectBound(f, ON, neighbours);
    await doc.redo();
    expectBound(f, 'Asset/Bin2/Bin/On', neighbours);
    doc.dispose();
  });

  it('refuses instead of guessing: remapped address without a live node → rejected, rolled back, bindings untouched', async () => {
    const f = unitFixture();
    const neighbours = { tools: f.holder.Tools, drive: f.holder.DriveA };
    const mixedBefore = f.holder2.Tools;
    const extrasBefore = JSON.stringify([
      f.lampNode.userData.realvirtual, f.holderNode.userData.realvirtual, f.holder2Node.userData.realvirtual,
    ]);
    const doc = scratchAssetDocument(f.viewer);
    // `On` moves to Bin and is then trashed inside the same range: the remap
    // names `Asset/Bin/On`, which has no live node at the flush.
    const err = await doc.applyOp(makeAssetComposite('Move + delete', [
      moveOn('Asset/Signals', 'Asset/Bin'),
      op({ kind: 'deleteNode', nodePath: 'Asset/Bin/On' }),
    ], MARK) as never).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ReferenceRebindError);
    const failures = (err as ReferenceRebindError).failures;
    expect(failures.map((x) => x.path)).toEqual(expect.arrayContaining(['Asset/Lamp', 'Asset/Holder', 'Asset/Holder2']));
    for (const x of failures) {
      expect(x.error).toBeInstanceOf(Error);
      expect((x.error as Error).message).toMatch(/no live node there, refusing to guess/);
    }
    expect((err as Error).message).toMatch(/refusing to guess/);
    expect(rebindInfo(doc)).toMatchObject({ foreign: 0 });

    // Rolled back, nothing recorded, document unchanged.
    expect(doc.ops).toHaveLength(0);
    expect(f.on.parent).toBe(f.signals);
    expect(f.registry.getNode(ON)).toBe(f.on);
    expect(JSON.stringify([
      f.lampNode.userData.realvirtual, f.holderNode.userData.realvirtual, f.holder2Node.userData.realvirtual,
    ])).toBe(extrasBefore);
    // Bindings untouched — values AND array identity.
    expect(f.lamp.SignalLampOn).toBe(ON);
    expect(f.holder.Sig).toBe(ON);
    expect(f.holder2.Tools).toBe(mixedBefore);
    expect(f.holder.Tools).toBe(neighbours.tools);
    expect(f.holder.DriveA).toBe(neighbours.drive);
    expect(f.store!.getPath('P614.On')).toBe(ON);
    doc.dispose();
  });
});

// ─── 3. The void renameNode reports a re-bind refusal (plan-614 F1) ─────

describe('plan-614 F1 — void renameNode: a ReferenceRebindError is rolled back AND reported', () => {
  afterEach(() => { vi.restoreAllMocks(); _resetStoreForTests(); });

  it('rename whose re-bind fails: warn + editor-edit-refused event + toast, state rolled back, nothing recorded', async () => {
    const f = unitFixture();
    const doc = scratchAssetDocument(f.viewer);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Force the re-bind to fail ONCE (forward pass); the rollback's own flush succeeds.
    const lamp = f.lamp as unknown as { reapplyConfig: () => void };
    const original = lamp.reapplyConfig.bind(lamp);
    let failNext = true;
    lamp.reapplyConfig = () => {
      if (failNext) { failNext = false; throw new Error('forced re-bind failure'); }
      original();
    };
    const extrasBefore = JSON.stringify(f.lampNode.userData.realvirtual);

    doc.renameNode('Asset/Signals', 'Sigs', 'Signals');
    await doc.whenIdle();
    // The queue settles BEFORE the op's own promise rejects into trackDetached's handler.
    await new Promise((r) => setTimeout(r, 0));

    expect(failNext, 'the forced failure fired').toBe(false);
    // Rolled back: name, paths, binding, extras; nothing on the undo stack.
    expect(f.signals.name).toBe('Signals');
    expect(f.registry.getPathForNode(f.on)).toBe(ON);
    expect(doc.ops).toHaveLength(0);
    expect(f.lamp.SignalLampOn).toBe(ON);
    expect(JSON.stringify(f.lampNode.userData.realvirtual)).toBe(extrasBefore);
    expect(lampReactsTo(f, 'P614.On')).toBe(true);
    // Reported: console.warn and the viewer event the HMI toasts.
    expect(warn.mock.calls.some((c) => String(c[0]).includes('renameNode refused and rolled back (reference re-bind)'))).toBe(true);
    const refused = f.events.filter((e) => e.name === 'editor-edit-refused');
    expect(refused).toHaveLength(1);
    expect(refused[0].data).toMatchObject({ verb: 'Rename', nodePath: 'Asset/Signals', reason: 'ReferenceRebindError' });
    expect((refused[0].data as { message: string }).message).toMatch(/forced re-bind failure/);

    // The HMI wiring turns exactly this event into the shared toast.
    const listeners: Array<(d: unknown) => void> = [];
    const bus = {
      on: (name: string, cb: (d: unknown) => void) => {
        if (name === 'editor-edit-refused') listeners.push(cb);
        return () => {};
      },
    };
    const uninstall = installEditRefusalWiring(bus as never);
    expect(listeners).toHaveLength(1);
    for (const l of listeners) l(refused[0].data);
    const toast = getInstructions().find((i) => i.id === EDIT_REFUSED_TOAST_ID);
    expect(toast, 'toast shown').toBeTruthy();
    expect(toast!.style).toBe('toast');
    expect(toast!.text).toMatch(/Rename of "Asset\/Signals" refused and undone: .*forced re-bind failure/);
    uninstall();
    doc.dispose();
  });
});
