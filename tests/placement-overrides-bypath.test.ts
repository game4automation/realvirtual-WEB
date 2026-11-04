// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-757 Phase 1b — overrides on a PLACEMENT have placement semantics
 * everywhere (F9 / D13), and a placement's problems reach the Problems panel.
 *
 *  - `AssetOverrides.byPath` is applied to a placed instance through the ONE
 *    resolver: asset-relative as written, root-prefixed (Unity form), and the
 *    AUTHORED spelling of a node a pre-bake hook moved (the asset's alias table);
 *  - `byAddress` (and the legacy `byNodeId`, read as `#id`) go through the same
 *    `applyAssetOverrides` the composed (grafted) frame uses — one application path,
 *    same counts; a resolved `byPath` comes back as its address (plan-769 9.22);
 *  - an orphan (no target in the baked asset) is a `override-orphaned` problem,
 *    idempotent on re-apply, cleared with the document — never a dropped line;
 *  - an old `trsByNodeId` is NOT applied (plan-769 F14): its count comes back and
 *    is an `override-transforms-dropped` problem;
 *  - §2.6: a plugin `bakeClaims()` claim addressed into a placement is a
 *    `plugin-claim-not-applicable` problem — also in the DOCUMENT-ROOT spelling
 *    of a placement under an intermediate node (plan-612 b1-2).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import '../src/core/engine/rv-scene-loader';
import { detectRenamedNodes, gltfLoader, type GltfParserLike } from '../src/core/engine/rv-glb-parse';
import { objectToGlb, sceneMirroringLoad } from '../src/core/import/rv-import-object';
import { prepareAndBake } from '../src/core/engine/rv-prepare-and-bake';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { setNodeId } from '../src/core/engine/rv-node-id';
import { setAssetReference, setPlacementMeta } from '../src/core/engine/rv-asset-reference';
import {
  applyAssetOverrides, makeSubtreeResolvers, readAssetOverridesRecord, type AssetOverrides,
} from '../src/core/engine/rv-asset-reference';
import {
  clearOverrideOrphanedProblems, getProblems, resetProblemsForTests,
} from '../src/core/hmi/problems-store';
import { inlinePickPort } from './fixtures/bake-fixture';
import { parityFixture } from './fixtures/parity-fixtures';
import { createParityHost, fixtureBytes, loadAsSinglePlacement, type ParityHost } from './helpers/parity-harness';

const uber = new RVUberMaterial(false);

function box(name: string, color: number): Mesh {
  const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color }));
  m.name = name;
  return m;
}

function node(name: string, pos: [number, number, number], extras?: Record<string, unknown>): Object3D {
  const n = new Object3D();
  n.name = name;
  n.position.set(...pos);
  if (extras) n.userData.realvirtual = extras;
  return n;
}

/**
 *   Machine
 *   ├─ Frame {NodeId n-frame}     bare mesh → merged away (no instance node)
 *   ├─ Mount                      reference target
 *   ├─ Cad ─ Kine {Kinematic → Parent 'Machine/Mount', Drive, NodeId n-kine}  moved under Mount
 *   └─ Axis {Drive, NodeId n-axis}  boundary → own instance node
 */
function buildMachine(): Group {
  const root = new Group();
  root.name = 'Machine';
  const frame = box('Frame', 0x777777);
  setNodeId(frame, 'n-frame');
  root.add(frame);
  root.add(node('Mount', [0, 0.5, 0]));
  const cad = node('Cad', [1, 0, 0]);
  const kine = node('Kine', [0, 0.4, 0], {
    Kinematic: { KinematicParentEnable: true, Parent: 'Machine/Mount' },
    Drive: { Direction: 'LinearX', TargetSpeed: 100 },
  });
  setNodeId(kine, 'n-kine');
  kine.add(box('Tool', 0x99cc33));
  cad.add(kine);
  root.add(cad);
  const axis = node('Axis', [-2, 0, 0], { Drive: { Direction: 'LinearY', TargetSpeed: 100 } });
  setNodeId(axis, 'n-axis');
  axis.add(box('arm', 0x3366cc));
  root.add(axis);
  return root;
}

async function bakeMachine(assetId: string) {
  const gltf = await gltfLoader.parseAsync(await objectToGlb(sceneMirroringLoad(buildMachine())), '');
  const renamedNodes = detectRenamedNodes((gltf as unknown as { parser?: GltfParserLike }).parser);
  return prepareAndBake(gltf.scene, {
    assetId, renamedNodes, signatureState: 'none', uber, isWebGPU: false, pickPort: inlinePickPort(),
    // A saved transform forces its node into its own chunk (plan-753 I7).
    forceSplit: (n) => n.name === 'Axis',
  });
}

const drive = (n: Object3D): Record<string, unknown> =>
  (n.userData.realvirtual as Record<string, Record<string, unknown>>).Drive;

describe('AssetOverrides.byPath on a placement — through the ONE resolver (F9 / F7)', () => {
  beforeEach(() => resetProblemsForTests());

  it('asset-relative, root-prefixed and AUTHORED (pre-hook) spellings all reach their node; an unknown path is an orphan', async () => {
    const baked = await bakeMachine('bypath');
    const reg = new BakeRegistry();
    // Scene → Layout → the placement: `computeNodePath` stops at the scene root.
    const layout = new Group();
    layout.name = 'Layout';
    new Group().add(layout);
    const root = new Group();
    root.name = 'Machine_1';
    layout.add(root);
    const overrides: AssetOverrides = {
      byAddress: {},
      legacyByPath: {
        'Axis': { Drive: { TargetSpeed: 7 } },            // as written, asset-relative
        'Machine/Cad/Kine': { Drive: { TargetSpeed: 9 } }, // Unity form of the AUTHORED path (moved by the hook)
        'Nowhere/Part': { Drive: { TargetSpeed: 1 } },     // orphan
      },
    };
    const inst = reg.instantiate(baked, root, { overrides });
    expect(drive(root.getObjectByName('Axis')!).TargetSpeed).toBe(7);
    const kine = root.getObjectByName('Kine')!;
    expect(kine.parent!.name).toBe('Mount');
    expect(drive(kine).TargetSpeed).toBe(9);

    const problems = getProblems().filter((p) => p.code === 'override-orphaned');
    expect(problems).toHaveLength(1);
    expect(problems[0].detail).toContain('Nowhere/Part');
    expect(problems[0].detail).toContain('bypath');
    expect(problems[0].nodePath).toBe('Layout/Machine_1');
    // Idempotent: re-applying the same overrides replaces, never appends.
    reg.applyOverrides(inst, overrides);
    expect(getProblems().filter((p) => p.code === 'override-orphaned')).toHaveLength(1);
    // Cleared with the document.
    clearOverrideOrphanedProblems();
    expect(getProblems()).toHaveLength(0);
    reg.release(inst);
    baked.dispose();
  });

  it('byAddress (legacy byNodeId) and byPath run through the SAME application path as composition — same counts; old part moves are reported, never applied (plan-769 F14)', async () => {
    const baked = await bakeMachine('one-path');
    const reg = new BakeRegistry();
    const root = new Group();
    root.name = 'Machine_1';
    // An OLD file's record: byNodeId + byPath + trsByNodeId, read the one way.
    const overrides = readAssetOverridesRecord({
      byNodeId: { 'n-axis': { Drive: { TargetSpeed: 3 } }, 'n-frame': { Drive: { TargetSpeed: 4 } } },
      byPath: { 'Axis': { Drive: { Acceleration: 5 } } },
      trsByNodeId: { 'n-axis': { position: [4, 0, 0] }, 'n-frame': { position: [1, 1, 1] } },
    })!;
    expect(overrides.droppedTransforms).toBe(2);
    const inst = reg.instantiate(baked, root);
    const axis = root.getObjectByName('Axis')!;
    const axisX = axis.position.x;
    const placed = reg.applyOverrides(inst, overrides);
    // The instance: Axis patched twice (id + path), NOT moved; Frame is merged → 1 orphan.
    expect(drive(axis).TargetSpeed).toBe(3);
    expect(drive(axis).Acceleration).toBe(5);
    expect(axis.position.x).toBe(axisX);
    expect(placed.droppedTransforms).toBe(2);
    expect(placed.migratedPaths).toEqual({ Axis: '#n-axis' });
    expect(placed.orphaned.map((o) => `${o.addressing}:${o.key}`)).toEqual(['address:#n-frame']);
    expect(getProblems().filter((p) => p.code === 'override-orphaned').map((p) => p.id))
      .toEqual(['override-orphaned:Machine_1:address:#n-frame']);
    const dropped = getProblems().filter((p) => p.code === 'override-transforms-dropped');
    expect(dropped).toHaveLength(1);
    expect(dropped[0].title).toContain('2 moved parts');
    // Composition (the grafted frame) applies the same overrides with the same
    // function over the RAW tree, where Frame still exists: 3 applied, 0 orphans.
    const raw = buildMachine();
    const composed = applyAssetOverrides(overrides, makeSubtreeResolvers(raw), { occurrence: 'occ', assetId: 'one-path' });
    expect(composed.orphaned).toEqual([]);
    expect(composed.droppedTransforms).toBe(2);
    // What differs is exactly the merged node — everything a placement CAN hold, it holds the same way.
    expect(placed.applied).toBe(composed.applied - 1);
    reg.release(inst);
    baked.dispose();
  });
});

describe('a plugin bake claim addressed into a placement (§2.6 / D5)', () => {
  let host: ParityHost | null = null;
  beforeEach(() => resetProblemsForTests());
  afterEach(() => { host?.dispose(); host = null; });

  it('is a `plugin-claim-not-applicable` problem on the placement root, not a console line', async () => {
    host = await createParityHost();
    const fixture = parityFixture('e');
    const bytes = await fixtureBytes(fixture.build());
    // The claims a model plugin would make for the document: one aimed into
    // the placed conveyor (asset-root form), one by the placement's document
    // path, one that has nothing to do with the placement.
    const placed = await loadAsSinglePlacement(host, bytes, fixture.rootName, {
      claims: [
        { path: 'Conveyor/Label', role: 'merge' },
        { path: 'Layout/Conveyor_1/frame', role: 'chunk' },
        { path: 'Layout/Hall/Floor', role: 'merge' },
      ],
    });
    const problems = getProblems().filter((p) => p.code === 'plugin-claim-not-applicable');
    expect(problems.map((p) => p.id).sort()).toEqual([
      'plugin-claim-not-applicable:Layout/Conveyor_1:Conveyor/Label',
      'plugin-claim-not-applicable:Layout/Conveyor_1:Layout/Conveyor_1/frame',
    ]);
    for (const p of problems) {
      expect(p.nodePath).toBe(placed.rootPath);
      expect(p.detail).toContain('parity-claims');
      expect(p.severity).toBe('info');
    }
    // Idempotent across re-integration: the same document, the same two.
    expect(getProblems().filter((p) => p.code === 'plugin-claim-not-applicable')).toHaveLength(2);
    placed.release();
    // A new document clears them.
    host.viewer.clearModel();
    expect(getProblems().filter((p) => p.code === 'plugin-claim-not-applicable')).toHaveLength(0);
  });
});

// plan-612 b1-2: a model plugin addresses its nodes from the DOCUMENT root
// (`PalletYardRoot/Stapler_1/Lift/ForkAnchor`), not from the model root the
// registry adds in front (`PalletYard/PalletYardRoot/...`). A placement BELOW an
// intermediate node was not recognised in that spelling — the claim was lost
// silently. Read like the main-model bake reads it (relative to the enclosing
// scope, as written or with its root name stripped), it is reported.
describe('a document-root spelled claim into a placement under an intermediate node (plan-612 b1-2)', () => {
  let host: ParityHost | null = null;
  beforeEach(() => resetProblemsForTests());
  afterEach(() => { host?.dispose(); host = null; });

  it('is reported; a sibling claim in the main model is not', async () => {
    host = await createParityHost();
    const fixture = parityFixture('e');
    const assetBytes = await fixtureBytes(fixture.build());
    const blobUrl = URL.createObjectURL(new Blob([assetBytes], { type: 'model/gltf-binary' }));
    // Model root `Hall` (the scene), the document's own top node `Bay`, the reference below it.
    const docRoot = new Group();
    docRoot.name = 'Hall';
    const bay = new Group();
    bay.name = 'Bay';
    docRoot.add(bay);
    const ref = new Object3D();
    ref.name = 'Conveyor_7';
    setNodeId(ref, 'nid-b1-2-ref');
    setAssetReference(ref, { assetId: 'cat:b1-2', path: blobUrl });
    setPlacementMeta(ref, {});
    bay.add(ref);
    bay.add(box('Floor', 0x808080));
    host.setClaims([
      { path: 'Bay/Conveyor_7/Label', role: 'merge' },   // document-root spelling, into the placement
      { path: 'Bay/Floor', role: 'merge' },              // document-root spelling, main model
    ]);
    const added: Object3D[] = [];
    const off = host.viewer.on('layout-content-added', (d: unknown) => {
      const r = (d as { root?: Object3D } | undefined)?.root;
      if (r) added.push(r);
    });
    try {
      await host.viewer.loadModel('b1-2-layout.glb', { data: await objectToGlb(sceneMirroringLoad(docRoot)) });
      await host.viewer.whenSceneReady();
    } finally {
      off();
      URL.revokeObjectURL(blobUrl);
    }
    const placed = added.find((r) => r.name === 'Conveyor_7');
    expect(placed, 'the placement materialised').toBeTruthy();
    const rootPath = host.viewer.registry!.getPathForNode(placed!);
    expect(rootPath, 'placement registry path').toBeTruthy();
    expect(rootPath!.split('/').length, `an intermediate node lies between model root and placement (${rootPath})`).toBeGreaterThanOrEqual(3);
    const problems = getProblems().filter((p) => p.code === 'plugin-claim-not-applicable');
    expect(rootPath).toBe('Hall/Bay/Conveyor_7');
    expect(problems.map((p) => p.id)).toEqual([`plugin-claim-not-applicable:${rootPath}:Bay/Conveyor_7/Label`]);
  });
});
