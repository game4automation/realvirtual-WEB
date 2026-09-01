// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Phase E — CADLink re-import: pure tree matching (relative name-paths,
 * duplicate-sibling disambiguation) and the full swap flow (components carried
 * over, root transform preserved, unmatched reported, undo restores).
 */
import { describe, it, expect, afterEach } from 'vitest';
 import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { Scene, Group, Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { AssetDocument } from '../src/core/editor/rv-asset-document';
import {
  relativePathMap,
  matchCadTrees,
  reimportCad,
} from '../src/core/editor/rv-cadlink-reimport';
import { registerCadProvider } from '../src/core/editor/rv-cad-provider';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import { isDescendantOf } from './kinematic-fixture';
import type { CADLinkExtras } from '../src/core/editor/rv-asset-ops';

function named(name: string, ...children: Object3D[]): Object3D {
  const n = new Object3D();
  n.name = name;
  for (const c of children) n.add(c);
  return n;
}

afterEach(() => registerCadProvider('step', null));

describe('relativePathMap / matchCadTrees (pure)', () => {
  it('maps nested nodes by relative name-path', () => {
    const root = named('Root', named('Housing', named('Shaft')), named('Base'));
    const map = relativePathMap(root);
    expect([...map.keys()].sort()).toEqual(['Base', 'Housing', 'Housing/Shaft']);
  });

  it('disambiguates duplicate sibling names by occurrence index', () => {
    const root = named('Root', named('Bolt'), named('Bolt'), named('Bolt'));
    const keys = [...relativePathMap(root).keys()];
    expect(keys).toEqual(['Bolt', 'Bolt#1', 'Bolt#2']);
  });

  it('matches identical paths; renamed/missing nodes map to null', () => {
    const oldRoot = named('Root', named('Housing', named('Shaft')), named('Legacy'));
    const newRoot = named('Root', named('Housing', named('Shaft')), named('NewPart'));
    const matches = matchCadTrees(oldRoot, newRoot);

    const oldHousing = oldRoot.children[0];
    const oldShaft = oldHousing.children[0];
    const oldLegacy = oldRoot.children[1];
    expect(matches.get(oldHousing)?.name).toBe('Housing');
    expect(matches.get(oldShaft)?.name).toBe('Shaft');
    expect(matches.get(oldLegacy)).toBeNull();
  });

  it('JT: keys on the stable jtHandle, so a renamed part still matches', () => {
    // JT nodes carry userData.jtHandle (the CAD-stable persistent id from the reader).
    const withHandle = (name: string, handle: number): Object3D => {
      const n = new Object3D();
      n.name = name;
      n.userData.jtHandle = handle;
      return n;
    };
    const oldRoot = named('Root', withHandle('Greiferbacke', 1157739));
    const newRoot = named('Root', withHandle('Gripper-Jaw', 1157739)); // renamed, same handle

    // Path key uses the handle, not the (changed) name.
    const oldKeys = [...relativePathMap(oldRoot).keys()];
    expect(oldKeys).toEqual([' jtHandle:1157739']);

    const matches = matchCadTrees(oldRoot, newRoot);
    expect(matches.get(oldRoot.children[0])?.name).toBe('Gripper-Jaw');
  });
});

describe('reimportCad (swap flow)', () => {
  function makeWorld() {
    const scene = new Scene();
    const model = new Group();
    model.name = 'Asset';
    scene.add(model);

    // Old CAD subtree with components + a custom transform on the root.
    const cadRoot = named('Gearbox', named('Housing', named('Shaft')), named('Legacy'));
    cadRoot.position.set(1, 0, 2);
    cadRoot.userData.realvirtual = {
      CADLink: { File: 'gearbox.step', Sha256: 'oldhash', Quality: 'standard', ImportScaleFactor: 0.001, ZIsUpVector: true },
      Group: { GroupName: 'GearboxGroup' },
    };
    const housing = cadRoot.children[0];
    housing.userData.realvirtual = { Drive: { Direction: 'LinearX', TargetSpeed: 100 } };
    const legacy = cadRoot.children[1];
    legacy.userData.realvirtual = { Sensor: { Limit: 5 } };
    model.add(cadRoot);

    const registry = new NodeRegistry();
    model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));

    const viewer = {
      scene,
      registry,
      signalStore: null,
      transportManager: null,
      get currentModelRoot() { return model; },
      markRenderDirty() {},
      markShadowsDirty() {},
      emit() {},
      rebuildGroupedBvh() {},
    } as unknown as RVViewer;

    return { viewer, model, cadRoot, registry, cadRootPath: NodeRegistry.computeNodePath(cadRoot) };
  }

  it('JT: actually ATTACHES the carried component, not just matches it', async () => {
    // The regression this pins: matching and attaching are different layers, and every earlier
    // test stopped at the first. Keys come from `localMatchId`, which for JT is the stable
    // handle — so rebuilding a scene path from the key addresses `jtHandle:1157739` while the
    // scene holds the part name. `addComponent` on an unknown path is a silent no-op, so a JT
    // re-import used to drop EVERY configured component while reporting them as matched.
    // Renaming the part between revisions is the normal JT case and makes the two layers differ.
    const scene = new Scene();
    const model = new Group();
    model.name = 'Asset';
    scene.add(model);

    const withHandle = (name: string, handle: number): Object3D => {
      const n = new Object3D();
      n.name = name;
      n.userData.jtHandle = handle;
      return n;
    };

    const cadRoot = named('Gearbox');
    cadRoot.userData.realvirtual = {
      CADLink: { File: 'g.jt', Sha256: 'old', Quality: '2', ImportScaleFactor: 0.001, ZIsUpVector: true },
    };
    const oldJaw = withHandle('Greiferbacke', 1157739);
    oldJaw.userData.realvirtual = { Drive: { Direction: 'LinearX', TargetSpeed: 250 } };
    cadRoot.add(oldJaw);
    cadRoot.add(withHandle('Rahmen', 42));
    model.add(cadRoot);

    const registry = new NodeRegistry();
    model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
    const viewer = {
      scene, registry, signalStore: null, transportManager: null,
      get currentModelRoot() { return model; },
      markRenderDirty() {}, markShadowsDirty() {}, emit() {}, rebuildGroupedBvh() {},
    } as unknown as RVViewer;
    const doc = scratchAssetDocument(viewer);

    // Same part, same handle, NEW name — exactly what the handle-based key exists for.
    // Two children on purpose: parseGlbSubtree unwraps a single-child wrapper, which would
    // make the jaw itself the CAD root and quietly change what this test exercises.
    const newTree = named('IGNORED', withHandle('Gripper-Jaw', 1157739), withHandle('Frame', 42));
    const glb = await objectToGlb(newTree);
    registerCadProvider('jt', {
      importFile: async () => ({
        glb,
        cadlink: {
          File: 'g_v2.jt', Sha256: 'new', Quality: '2',
          ImportScaleFactor: 0.001, ZIsUpVector: true,
        } as CADLinkExtras,
      }),
    });

    const report = await reimportCad(viewer, doc, NodeRegistry.computeNodePath(cadRoot),
      new File(['dummy'], 'g_v2.jt'), '2');
    await doc.whenIdle();

    const newRoot = model.children.find((c) => c.name === 'Gearbox')!;
    const newJaw = newRoot.children.find((c) => c.userData.jtHandle === 1157739)!;
    expect(newJaw).toBeDefined();
    expect(newJaw.name).toBe('Gripper-Jaw');
    // The assertion that used to fail: the Drive has to be ON the node, not merely counted.
    expect((newJaw.userData.realvirtual as any)?.Drive)
      .toEqual({ Direction: 'LinearX', TargetSpeed: 250 });
    // And the report must agree with reality.
    expect(report.matched).toBe(1);
    expect(report.unmatched).toEqual([]);

    doc.dispose();
    registerCadProvider('jt', null);
  });

  it('carries components onto matched nodes, keeps root name+transform, reports unmatched; undo restores', async () => {
    const { viewer, model, registry, cadRootPath } = makeWorld();
    const doc = scratchAssetDocument(viewer);

    // New revision: Housing/Shaft survive, Legacy is gone, NewPart appears.
    // The provider returns GLB BYTES (as every provider now does); reimportCad
    // parses them itself, so this exercises the real round-trip: the tree it
    // diffs against is exactly the tree that lands in the scene.
    const newTree = named('IGNORED', named('Housing', named('Shaft')), named('NewPart'));
    const glb = await objectToGlb(newTree);
    const cadlink: CADLinkExtras = {
      File: 'gearbox_v2.step', Sha256: 'newhash', Quality: 'standard',
      ImportScaleFactor: 0.001, ZIsUpVector: true,
    };
    registerCadProvider('step', {
      importFile: async () => ({ glb, cadlink }),
    });

    const report = await reimportCad(
      viewer, doc, cadRootPath,
      new File(['dummy'], 'gearbox_v2.step'), 'standard',
    );
    await doc.whenIdle();

    // Report: Housing matched (carried), Legacy unmatched (surfaced, not dropped silently).
    expect(report.matched).toBe(1);
    expect(report.unmatched).toEqual([
      { relPath: 'Legacy', components: { Sensor: { Limit: 5 } } },
    ]);
    expect(report.newUnmapped).toContain('NewPart');

    // The swapped root keeps the OLD name + transform, gets the fresh CADLink,
    // and root-level non-CADLink components carried over.
    const newRoot = model.children.find((c) => c.name === 'Gearbox')!;
    expect(newRoot).toBeDefined();
    expect(newRoot.position.toArray()).toEqual([1, 0, 2]);
    const rootRv = newRoot.userData.realvirtual as any;
    expect(rootRv.CADLink.Sha256).toBe('newhash');
    expect(rootRv.Group).toEqual({ GroupName: 'GearboxGroup' });

    // Matched node got its component back.
    const newHousing = newRoot.children.find((c) => c.name === 'Housing')!;
    expect((newHousing.userData.realvirtual as any).Drive).toEqual({ Direction: 'LinearX', TargetSpeed: 100 });

    // ONE undo restores the entire old subtree — including the unmatched node.
    await doc.undo();
    const restored = model.children.find((c) => c.name === 'Gearbox')!;
    expect((restored.userData.realvirtual as any).CADLink.Sha256).toBe('oldhash');
    const restoredLegacy = restored.children.find((c) => c.name === 'Legacy')!;
    expect((restoredLegacy.userData.realvirtual as any).Sensor).toEqual({ Limit: 5 });
    expect(registry.getNode(cadRootPath)).toBe(restored);

    doc.dispose();
  });
});

/**
 * plan-727 — the reported bug, end to end.
 *
 * `relativePathMap(oldRoot)` builds its match keys by walking `children` down
 * from the CAD root. A node that kinematic re-parenting pulled out of that
 * subtree is not traversed at all: it shows up neither as matched nor as
 * unmatched, so its components vanish from the re-import SILENTLY. Both
 * directions are asserted — the authoring load must preserve the node, and the
 * runtime load must still re-parent (that behaviour is unchanged and correct).
 */
describe('CAD re-import after an editor reload (plan-727)', () => {
  /** CadRoot[CADLink] > Part[Group G]; Kine[Kinematic integrates G, Drive]. */
  async function buildCadKinematicGlb(): Promise<ArrayBuffer> {
    const src = new Scene();

    const cadRoot = new Object3D();
    cadRoot.name = 'Gearbox';
    cadRoot.userData = {
      realvirtual: {
        CADLink: {
          File: 'gearbox.step', Sha256: 'oldhash', Quality: 'standard',
          ImportScaleFactor: 0.001, ZIsUpVector: true,
        },
      },
    };
    const part = new Object3D();
    part.name = 'Part';
    part.position.set(1, 0, 0);
    part.userData = { realvirtual: { Group: { GroupName: 'G' } } };
    cadRoot.add(part);

    const kin = new Object3D();
    kin.name = 'Kine';
    kin.position.set(0, 2, 0);
    kin.userData = {
      realvirtual: {
        Kinematic: { IntegrateGroupEnable: true, GroupName: 'G' },
        Drive: { Direction: 'LinearX', StartPosition: 0 },
      },
    };

    src.add(cadRoot);
    src.add(kin);
    return (await new GLTFExporter().parseAsync(src, { binary: true })) as ArrayBuffer;
  }

  async function loadAndReimport(authoring: boolean) {
    const scene = new Scene();
    const loaded = await loadGLB('cad-kin.glb', scene, {
      data: await buildCadKinematicGlb(),
      preserveHierarchy: true,
      ...(authoring ? { preserveAuthoringHierarchy: true } : {}),
    });
    const model = loaded.root;
    const registry = loaded.registry;
    const cadRoot = registry.getNode('Gearbox')!;
    const part = model.getObjectByName('Part')!;

    const viewer = {
      scene, registry, signalStore: loaded.signalStore, transportManager: null,
      get currentModelRoot() { return model; },
      markRenderDirty() {}, markShadowsDirty() {}, emit() {}, rebuildGroupedBvh() {},
    } as unknown as RVViewer;
    const doc = scratchAssetDocument(viewer);

    // Two children so parseGlbSubtree does not unwrap the single-child wrapper.
    const newTree = named('IGNORED', named('Part'), named('Extra'));
    const glb = await objectToGlb(newTree);
    registerCadProvider('step', {
      importFile: async () => ({
        glb,
        cadlink: {
          File: 'gearbox_v2.step', Sha256: 'newhash', Quality: 'standard',
          ImportScaleFactor: 0.001, ZIsUpVector: true,
        } as CADLinkExtras,
      }),
    });

    const report = await reimportCad(
      viewer, doc, NodeRegistry.computeNodePath(cadRoot),
      new File(['dummy'], 'gearbox_v2.step'), 'standard',
    );
    await doc.whenIdle();
    doc.dispose();
    return { report, cadRoot, part, model };
  }

  it('authoring load keeps the group member inside the CAD root, so re-import carries it', async () => {
    const { report, cadRoot, part } = await loadAndReimport(true);

    // The precondition relativePathMap depends on.
    expect(isDescendantOf(part, cadRoot)).toBe(true);
    // And the component actually crosses the revision.
    expect(report.matched).toBe(1);
    expect(report.unmatched).toEqual([]);
  });

  it('runtime load still re-parents (unchanged) — which is exactly why the editor must not', async () => {
    const { report, part, cadRoot } = await loadAndReimport(false);
    expect(part.parent?.name).toBe('Kine');
    expect(isDescendantOf(part, cadRoot)).toBe(false);
    // The silent loss, spelled out: NOT carried over, and NOT reported as
    // unmatched either — the node is simply outside what relativePathMap walks.
    // This is the state an editor save used to bake into the GLB permanently.
    expect(report.matched).toBe(0);
    expect(report.unmatched).toEqual([]);
  });
});
