// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-628 §9.9i (Phase 8.7, E36) — building blocks LOADED from a file (no
 * `__rvAdded`) are fully editable in the REAL viewer with the REAL scene
 * executor (`RvUnifiedExecutor('scene')`):
 *  - move, rotate, parametrise and reset are plain `setField` steps;
 *  - DELETE is one undo step (persisted authored removal, `removeNode` with
 *    `authored: true`); undo restores block + path + the predecessor's link,
 *    the restored nodes are authored again (no `__rvAdded`), redo removes again;
 *  - the removal survives save → reload both ways: draft replay (op log →
 *    `materialise().removedNodes` → load phase) and a web-saved GLB
 *    (`bakeIntoGlb` full path drops the subtree);
 *  - the protection of every other authored node is unchanged: an authored or
 *    plain `removeNode` on a node outside the `PathNetwork` subtree is a no-op.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';
import type { RVViewer } from '../../src/core/rv-viewer';
import type { RvOp } from '../../src/core/ops/rv-unified-ops';
import { RvDocument } from '../../src/core/ops/rv-document';
import { RvUnifiedExecutor } from '../../src/core/ops/rv-unified-executors';
import { setActiveEditTarget, type EditTarget } from '../../src/core/hmi/rv-edit-target';
import type { CommandContext, CommandImpl } from '../../src/core/hmi/rv-command-registry';
import { makeDraftScene } from '../../src/core/hmi/scene/rv-scene-types';
import { materialise } from '../../src/core/hmi/scene/rv-scene-edits';
import { bakeIntoGlb, makeRegistryBakeResolver } from '../../src/core/hmi/scene/rv-scene-glb-bake';
import { objectToGlb, sceneMirroringLoad } from '../../src/core/import/rv-import-object';
import { loadGLB, isAuthoredRemovalEligible } from '../../src/core/engine/rv-scene-loader';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { foldEdit, pathPayload } from '../../src/plugins/path-network/path-network-scene';
import { placeBlock, type NetworkInput } from '../../src/core/engine/rv-path-network-ops';
import { PATH_BLOCK_TYPE, PATH_NETWORK_NODE } from '../../src/core/engine/rv-path-block';
import {
  createPathNetworkCommandDescriptors,
  type PathCommandResult,
} from '../../src/plugins/path-network/path-network-commands';

const MODEL_URL = 'p628-loaded-blocks.glb';

let handle: TestViewerHandle | null = null;

afterEach(() => {
  setActiveEditTarget(null);
  handle?.dispose();
  handle = null;
  getDefaultPathNetwork().clear();
});

// ─── Fixture: a file with two chained blocks and two foreign nodes ────────

/** `Root/PathNetwork/{PN_Block_1/PN_S1 → PN_Block_2/PN_S2}`, `Root/Course/Loose`, `Root/Machine`. */
async function sourceGlb(): Promise<ArrayBuffer> {
  const net0: NetworkInput = { paths: [], blocks: [] };
  const r1 = placeBlock(net0, { kind: 'straight', lengthM: 4 }, { x: 0, z: 0, headingDeg: 0 });
  expect(r1.ok).toBe(true);
  const net1 = foldEdit(net0, r1.edit);
  const r2 = placeBlock(net1, { kind: 'straight', lengthM: 3 }, { pathId: 'PN_S1', end: 'end' });
  expect(r2.ok).toBe(true);
  const net2 = foldEdit(net1, r2.edit);

  const root = new Object3D();
  root.name = 'Root';
  const network = new Object3D();
  network.name = PATH_NETWORK_NODE;
  root.add(network);
  for (const b of net2.blocks ?? []) {
    const bn = new Object3D();
    bn.name = b.id;
    bn.userData.realvirtual = { [PATH_BLOCK_TYPE]: JSON.parse(JSON.stringify(b.extras)) };
    network.add(bn);
    for (const p of net2.paths.filter((x) => x.block === b.id)) {
      const pn = new Object3D();
      pn.name = p.nodeName;
      pn.userData.realvirtual = { Path: pathPayload(p) };
      bn.add(pn);
    }
  }
  const course = new Object3D();
  course.name = 'Course';
  const loose = new Object3D();
  loose.name = 'Loose';
  loose.userData.realvirtual = {
    Path: { type: 'Path', version: 1, id: 'Loose', segments: [{ kind: 'line', from: [0, 0, 5], to: [4, 0, 5] }], successors: [] },
  };
  course.add(loose);
  root.add(course);
  const machine = new Object3D();
  machine.name = 'Machine';
  machine.position.set(0, 0, -5);
  root.add(machine);
  // Exported as the file's SCENE (what a web save writes): `PathNetwork` is a
  // top-level node directly under the model root.
  return objectToGlb(sceneMirroringLoad(root));
}

// ─── Rig ────────────────────────────────────────────────────────────────

function docTarget(doc: RvDocument): EditTarget {
  return {
    available: true,
    persistsTo: 'scene',
    documentKey: doc,
    setField: () => { throw new Error('unused'); },
    unsetField: () => { throw new Error('unused'); },
    withTransaction: (label, fn) => doc.withTransaction(label, fn),
  };
}

async function loadInto(v: RVViewer, data: ArrayBuffer, ops: RvOp[] = []): Promise<void> {
  const scene = makeDraftScene({ kind: 'builtin', url: MODEL_URL, label: 'Loaded blocks' }, 'p628-loaded');
  scene.edits.ops = ops;
  await v.loadScene(scene, undefined, { data: data.slice(0) });
  await v.whenSceneReady();
}

interface Rig { v: RVViewer; doc: RvDocument; source: ArrayBuffer }

async function boot(): Promise<Rig> {
  handle = await createTestViewer('webgl', { width: 320, height: 240 });
  const v = handle.viewer;
  v.setSimulationPaused('p628-loaded', true);
  const source = await sourceGlb();
  await loadInto(v, source);
  const doc = new RvDocument({ id: 'p628-loaded', name: 'Loaded', mode: 'scene', executor: new RvUnifiedExecutor(v, 'scene') });
  setActiveEditTarget(docTarget(doc));
  return { v, doc, source };
}

const IMPLS = new Map(createPathNetworkCommandDescriptors().map((d) => [d.id, d.eagerImpl as CommandImpl<unknown, unknown>]));

async function cmd(v: RVViewer, id: string, args: Record<string, unknown>): Promise<PathCommandResult> {
  const impl = IMPLS.get(id)!;
  const ctx: CommandContext = { viewer: v, doc: null, selection: [], mode: 'planner', handle: null };
  const en = impl.enabled(ctx, args);
  if (en !== true) throw new Error(en.reason);
  return await impl.run(ctx, args) as PathCommandResult;
}

function nodeByName(v: RVViewer, name: string): Object3D | null {
  let found: Object3D | null = null;
  v.scene.traverse((n) => { if (!found && n.name === name) found = n; });
  return found;
}

function pathOf(v: RVViewer, name: string): string {
  const n = nodeByName(v, name);
  expect(n, `node ${name}`).toBeTruthy();
  return v.registry!.getPathForNode(n!)!;
}

const blockExtras = (v: RVViewer, id: string): Record<string, unknown> =>
  (nodeByName(v, id)!.userData.realvirtual as Record<string, Record<string, unknown>>)[PATH_BLOCK_TYPE];
const successorsOf = (v: RVViewer, id: string): unknown =>
  (nodeByName(v, id)!.userData.realvirtual as { Path: { successors: unknown } }).Path.successors;
const undoLen = (doc: RvDocument): number => doc.historyHead().undoLen;

// ─── Tests ──────────────────────────────────────────────────────────────

describe('plan-628 9.9i — loaded blocks are editable and deletable (8.7)', () => {
  it('loaded nodes carry no __rvAdded; the eligibility predicate admits only the PathNetwork subtree', async () => {
    const { v } = await boot();
    for (const name of ['PN_Block_1', 'PN_S1', 'PN_Block_2', 'PN_S2', 'Loose', 'Machine']) {
      expect(nodeByName(v, name)!.userData.__rvAdded, name).toBeUndefined();
    }
    expect(isAuthoredRemovalEligible(nodeByName(v, 'PN_Block_2')!)).toBe(true);
    expect(isAuthoredRemovalEligible(nodeByName(v, 'PN_S2')!)).toBe(true);
    expect(isAuthoredRemovalEligible(nodeByName(v, 'Loose')!)).toBe(false);
    expect(isAuthoredRemovalEligible(nodeByName(v, 'Machine')!)).toBe(false);
    expect(isAuthoredRemovalEligible(nodeByName(v, PATH_NETWORK_NODE)!)).toBe(false);
    const list = await cmd(v, 'layout.path.list', {}) as unknown as { blocks: { id: string; imported?: boolean }[] };
    expect(list.blocks.map((b) => [b.id, b.imported ?? false])).toEqual([['PN_Block_1', false], ['PN_Block_2', false]]);
  }, 60_000);

  it('move, rotate, parametrise, reset: each one undo step on the loaded block', async () => {
    const { v, doc } = await boot();
    const pose0 = JSON.stringify(blockExtras(v, 'PN_Block_2').pose);

    const p0 = JSON.parse(pose0) as number[];

    // Move: one step, undo restores.
    await cmd(v, 'layout.path.move', { blockId: 'PN_Block_2', dx: 1, dz: 0.5 });
    expect(undoLen(doc)).toBe(1);
    expect((blockExtras(v, 'PN_Block_2').pose as number[])[0]).toBeCloseTo(p0[0] + 1, 6);
    await doc.undo();
    expect(JSON.stringify(blockExtras(v, 'PN_Block_2').pose)).toBe(pose0);

    // Rotate: one step, undo restores.
    await cmd(v, 'layout.path.move', { blockId: 'PN_Block_2', dHeadingDeg: 90 });
    expect(undoLen(doc)).toBe(1);
    expect((blockExtras(v, 'PN_Block_2').pose as number[])[2]).toBeCloseTo(p0[2] + 90, 6);
    await doc.undo();
    expect(JSON.stringify(blockExtras(v, 'PN_Block_2').pose)).toBe(pose0);

    // Parametrise: one step; reset to template: one more step, back to 3 m.
    await cmd(v, 'layout.path.setParams', { blockId: 'PN_Block_2', lengthM: 5 });
    expect(undoLen(doc)).toBe(1);
    expect(getDefaultPathNetwork().get('PN_S2')?.length).toBeCloseTo(5, 6);
    await cmd(v, 'layout.path.reset', { blockId: 'PN_Block_2' });
    expect(undoLen(doc)).toBeGreaterThanOrEqual(1);
    expect(blockExtras(v, 'PN_Block_2').params).toBeTruthy();
    // Nothing about the loaded nodes changed their authored state.
    expect(nodeByName(v, 'PN_Block_2')!.userData.__rvAdded).toBeUndefined();
  }, 60_000);

  it('delete = one undo step; undo restores block + path + link (authored again); redo removes again', async () => {
    const { v, doc } = await boot();
    const blockPath = pathOf(v, 'PN_Block_2');
    expect(successorsOf(v, 'PN_S1')).toEqual(['PN_S2']);

    const r = await cmd(v, 'layout.path.remove', { ids: 'PN_Block_2' });
    expect(r.removedPaths).toEqual(['PN_S2']);
    expect(undoLen(doc)).toBe(1);
    expect(nodeByName(v, 'PN_Block_2')).toBeNull();
    expect(nodeByName(v, 'PN_S2')).toBeNull();
    expect(v.registry!.getNode(blockPath)).toBeNull();
    expect(getDefaultPathNetwork().get('PN_S2')).toBeNull();
    expect(successorsOf(v, 'PN_S1')).toEqual([]);
    const composite = doc.ops[doc.ops.length - 1] as unknown as { ops: { kind: string; authored?: boolean }[] };
    expect(composite.ops.filter((o) => o.kind === 'removeNode').map((o) => o.authored)).toEqual([true, true]);

    await doc.undo();
    expect(nodeByName(v, 'PN_Block_2')).toBeTruthy();
    expect(nodeByName(v, 'PN_S2')?.parent?.name).toBe('PN_Block_2');
    expect(getDefaultPathNetwork().get('PN_S2')?.length).toBeCloseTo(3, 6);
    expect(successorsOf(v, 'PN_S1')).toEqual(['PN_S2']);
    expect(nodeByName(v, 'PN_Block_2')!.userData.__rvAdded).toBeUndefined();
    expect(nodeByName(v, 'PN_S2')!.userData.__rvAdded).toBeUndefined();

    await doc.redo();
    expect(nodeByName(v, 'PN_Block_2')).toBeNull();
    expect(successorsOf(v, 'PN_S1')).toEqual([]);
  }, 60_000);

  it('save → reload: draft replay AND web-saved GLB keep the deleted block gone', async () => {
    const { v, doc, source } = await boot();
    const s2Path = pathOf(v, 'PN_S2');
    const blockPath = pathOf(v, 'PN_Block_2');
    await cmd(v, 'layout.path.remove', { ids: 'PN_Block_2' });
    const ops = [...doc.ops];
    const edits = materialise(ops);
    expect(edits.removedNodes).toEqual([s2Path, blockPath]);
    expect(edits.addedNodes).toEqual([]);

    // Draft replay: the same op log on the same base.
    setActiveEditTarget(null);
    await loadInto(v, source, ops);
    expect(nodeByName(v, 'PN_Block_2')).toBeNull();
    expect(nodeByName(v, 'PN_S2')).toBeNull();
    expect(nodeByName(v, 'PN_Block_1')).toBeTruthy();
    expect(successorsOf(v, 'PN_S1')).toEqual([]);
    expect(nodeByName(v, 'Loose')).toBeTruthy();
    expect(getDefaultPathNetwork().get('PN_S2')).toBeNull();

    // Web save: bake the op log into the source file, reload the bytes alone.
    const ref = await loadGLB('src.glb', new Scene(), { data: source.slice(0), preserveHierarchy: true, loadKinematicsSidecar: false });
    const baked = await bakeIntoGlb(source, materialise(ops), makeRegistryBakeResolver(ref.registry, ref.composition?.frames ?? []));
    expect(baked.path).toBe('full');
    expect(baked.removedNodes).toBeGreaterThanOrEqual(1);
    expect(baked.warnings).toEqual([]);
    const bytes = baked.glb.buffer.slice(baked.glb.byteOffset, baked.glb.byteOffset + baked.glb.byteLength) as ArrayBuffer;
    await loadInto(v, bytes);
    expect(nodeByName(v, 'PN_Block_2')).toBeNull();
    expect(nodeByName(v, 'PN_S2')).toBeNull();
    expect(nodeByName(v, 'PN_Block_1')).toBeTruthy();
    expect(successorsOf(v, 'PN_S1')).toEqual([]);
    expect(nodeByName(v, 'Loose')).toBeTruthy();
    expect(nodeByName(v, 'Machine')).toBeTruthy();
  }, 90_000);

  it('the protection stays: removeNode (authored or not) on a non-path-network original node is a no-op', async () => {
    const { v, doc } = await boot();
    for (const name of ['Loose', 'Machine']) {
      const nodePath = pathOf(v, name);
      const spec = {
        parentPath: nodePath.slice(0, nodePath.lastIndexOf('/')), name,
        position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], components: {},
      };
      for (const authored of [true, false]) {
        await doc.applyOp({
          id: `rm_${name}_${authored}`, ts: Date.now(), schemaV: 1, kind: 'removeNode', nodePath, spec,
          ...(authored ? { authored: true } : {}),
        } as unknown as RvOp);
        expect(v.registry!.getNode(nodePath), `${name} authored=${authored}`).toBeTruthy();
        expect(nodeByName(v, name)?.parent).toBeTruthy();
      }
    }
    expect(getDefaultPathNetwork().get('Loose')).not.toBeNull();
    // ...and the PathNetwork container itself is not admitted either.
    const netPath = pathOf(v, PATH_NETWORK_NODE);
    await doc.applyOp({
      id: 'rm_net', ts: Date.now(), schemaV: 1, kind: 'removeNode', nodePath: netPath, authored: true,
      spec: { parentPath: 'Root', name: PATH_NETWORK_NODE, position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], components: {} },
    } as unknown as RvOp);
    expect(v.registry!.getNode(netPath)).toBeTruthy();
  }, 60_000);
});
