// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * path-topology.test.ts — plan-633 Phase 4 §9.4 (integration).
 *
 * 1. The write path F7 in the path visualizer: an endpoint drag that rasts
 *    onto another path end writes `successors` together with `segments` in ONE
 *    transaction of a real `RvDocument` — one undo step, redo, a failed commit
 *    leaves nothing half written, and the written state survives a save/reload
 *    (extras JSON roundtrip + op-log replay onto a fresh scene).
 * 2. The check service F8 inside a REAL viewer load lifecycle
 *    (`createTestViewer` + `loadScene`): an empty base scene whose only content
 *    is stored `addNode(Path)` nodes (they are created AFTER `model-loaded`,
 *    R2-2), and a load overtaken by a second one reports nothing.
 *
 * Every assertion on a looked-up value first asserts that it exists (#211).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D, PerspectiveCamera, Scene } from 'three';
import { EventEmitter } from '../../src/core/rv-events';
import { RVPathComponent, type PathSegmentSpec } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { getDefaultSpacingController } from '../../src/core/engine/rv-spacing-controller';
import { getComponentInstances, setComponentInstance } from '../../src/core/engine/rv-component-registry';
import { cloneSegmentSpecs, readSegmentSpecs } from '../../src/core/engine/rv-path-edit';
import { PathVisualizerPlugin } from '../../src/plugins/path-visualizer-plugin';
import type { RVViewer } from '../../src/core/rv-viewer';
import { RvDocument } from '../../src/core/ops/rv-document';
import type { RvOp } from '../../src/core/ops/rv-unified-ops';
import type { RvExecutor } from '../../src/core/ops/rv-unified-executors';
import { setActiveEditTarget, type EditTarget } from '../../src/core/hmi/rv-edit-target';
import { clearAllProblems, getProblems } from '../../src/core/hmi/problems-store';
import { PATH_SUCCESSOR_MISMATCH, PathTopologyCheck } from '../../src/core/connect/path-topology-check';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';
import { makeDraftScene } from '../../src/core/hmi/scene/rv-scene-types';

type V3 = [number, number, number];
const lineSpec = (from: V3, to: V3): PathSegmentSpec => ({ kind: 'line', from, to });

// ─── 1. Write path F7 ───────────────────────────────────────────────────

/** Scene + node map + a real RvDocument whose executor writes into the nodes. */
interface Rig {
  scene: Scene;
  nodes: Map<string, Object3D>;
  doc: RvDocument;
  plugin: PathVisualizerPlugin;
  /** Make the executor refuse the next forward op on this field. */
  failOn: { field: string | null };
}

function reapply(node: Object3D): void {
  for (const inst of getComponentInstances(node)) {
    if (inst instanceof RVPathComponent) inst.reapplyConfig();
  }
}

function writeField(node: Object3D, comp: string, field: string, value: unknown): void {
  const rv = (node.userData.realvirtual ??= {}) as Record<string, Record<string, unknown>>;
  rv[comp] ??= {};
  if (value === undefined) delete rv[comp][field];
  else rv[comp][field] = JSON.parse(JSON.stringify(value));
  reapply(node);
}

interface FieldOp { kind: 'setField'; nodePath: string; componentType: string; fieldName: string; value: unknown; prev: unknown }

function makeExecutor(nodes: Map<string, Object3D>, failOn: { field: string | null }): RvExecutor {
  const forward = async (op: RvOp): Promise<void> => {
    if (op.kind === 'composite') {
      for (const c of (op as unknown as { ops: RvOp[] }).ops) await forward(c);
      return;
    }
    const f = op as unknown as FieldOp;
    if (failOn.field === f.fieldName) {
      failOn.field = null;
      throw new Error(`refused ${f.fieldName}`);
    }
    const node = nodes.get(f.nodePath);
    if (!node) throw new Error(`no node ${f.nodePath}`);
    writeField(node, f.componentType, f.fieldName, f.value);
  };
  const inverse = async (op: RvOp): Promise<void> => {
    if (op.kind === 'composite') {
      const children = [...(op as unknown as { ops: RvOp[] }).ops].reverse();
      for (const c of children) await inverse(c);
      return;
    }
    const f = op as unknown as FieldOp;
    const node = nodes.get(f.nodePath);
    if (!node) throw new Error(`no node ${f.nodePath}`);
    writeField(node, f.componentType, f.fieldName, f.prev);
  };
  return { applyForward: forward, applyInverse: inverse };
}

function docTarget(doc: RvDocument): EditTarget {
  let n = 0;
  const op = (nodePath: string, componentType: string, fieldName: string, value: unknown, prev: unknown): RvOp =>
    ({ id: `op_${++n}`, ts: Date.now(), schemaV: 1, kind: 'setField', nodePath, componentType, fieldName, value, prev }) as unknown as RvOp;
  return {
    available: true,
    persistsTo: 'scene',
    documentKey: doc,
    setField: (p, c, f, v, prev) => { void doc.applyOp(op(p, c, f, v, prev)); },
    setFieldAsync: (p, c, f, v, prev) => doc.applyOp(op(p, c, f, v, prev)),
    unsetField: () => { throw new Error('unused'); },
    withTransaction: (label, fn) => doc.withTransaction(label, fn),
  };
}

function addPath(rig: Pick<Rig, 'scene' | 'nodes'>, id: string, segments: PathSegmentSpec[], successors: string[] = []): Object3D {
  const node = new Object3D();
  node.name = id;
  node.userData.realvirtual = { Path: { id, segments: cloneSegmentSpecs(segments), successors: [...successors] } };
  rig.scene.add(node);
  rig.nodes.set(`Root/${id}`, node);
  const comp = new RVPathComponent(node);
  comp.init({} as never);
  setComponentInstance(node, comp);
  return node;
}

function makeRig(): Rig {
  const scene = new Scene();
  const nodes = new Map<string, Object3D>();
  const failOn = { field: null as string | null };
  const doc = new RvDocument({ id: 'doc', name: 'Paths', mode: 'scene', executor: makeExecutor(nodes, failOn) });
  setActiveEditTarget(docTarget(doc));
  const events = new EventEmitter();
  const camera = new PerspectiveCamera(50, 1.333, 0.1, 1000);
  const stub = {
    scene,
    camera,
    controls: { enabled: true },
    renderer: null,
    raycastManager: null,
    registry: {
      getPathForNode: (node: Object3D) => {
        for (const [p, n] of nodes) if (n === node) return p;
        return null;
      },
    },
    on: events.on.bind(events),
    emit: (e: string, d: unknown) => events.emit(e as never, d as never),
    markRenderDirty: () => {},
  };
  const plugin = new PathVisualizerPlugin();
  plugin.init(stub as unknown as RVViewer);
  return { scene, nodes, doc, plugin, failOn };
}

const succ = (id: string): readonly string[] => {
  const p = getDefaultPathNetwork().get(id);
  expect(p, `path ${id} registered`).not.toBeNull();
  return p!.successorIds;
};

/** Drag one handle of `pathId` to `to` and release; resolves with the durable outcome. */
async function drag(rig: Rig, pathId: string, handleId: string, to: V3) {
  rig.plugin.refresh();
  rig.plugin.setPlannerMode(true);
  expect(rig.plugin.beginHandleDrag(pathId, handleId)).toBe(true);
  rig.plugin.updateHandleDrag(to);
  const committed = rig.plugin.endHandleDrag();
  expect(committed).not.toBeNull();
  const result = await rig.plugin.whenCommitted();
  expect(result).not.toBeNull();
  return result!;
}

describe('F7 — the visualizer writes successors with the segments, in one transaction', () => {
  let rig: Rig;

  beforeEach(() => {
    getDefaultPathNetwork().clear();
    getDefaultZoneRegistry().clear();
    getDefaultSpacingController().clear();
    rig = makeRig();
  });

  afterEach(() => {
    rig.plugin.dispose();
    setActiveEditTarget(null);
  });

  it('END of A rasted onto START of B writes A → B; ONE undo step; undo and redo', async () => {
    const a = addPath(rig, 'A', [lineSpec([0, 0, 0], [0, 0, 5])]);
    addPath(rig, 'B', [lineSpec([0, 0, 8], [0, 0, 12])]);
    const before = readSegmentSpecs(a as unknown as { userData: Record<string, unknown> });

    const r = await drag(rig, 'A', 'v1', [0.05, 0, 7.9]);
    expect(r.ok).toBe(true);
    expect(r.successorChanges).toEqual([{ from: 'A', to: 'B', op: 'add' }]);
    expect(succ('A')).toEqual(['B']);
    const pa = getDefaultPathNetwork().get('A');
    expect(pa).not.toBeNull();
    expect(pa!.length).toBeCloseTo(8, 9);

    // ONE composite entry carries both fields.
    expect(rig.doc.ops.length).toBe(1);
    const entry = rig.doc.ops[0] as unknown as { kind: string; ops: { fieldName: string }[] };
    expect(entry).toBeDefined();
    expect(entry.kind).toBe('composite');
    expect(entry.ops.map((o) => o.fieldName)).toEqual(['segments', 'successors']);

    await rig.doc.undo();
    expect(succ('A')).toEqual([]);
    expect(readSegmentSpecs(a as unknown as { userData: Record<string, unknown> })).toEqual(before);
    expect(getDefaultPathNetwork().get('A')!.length).toBeCloseTo(5, 9);

    await rig.doc.redo();
    expect(succ('A')).toEqual(['B']);
    expect(getDefaultPathNetwork().get('A')!.length).toBeCloseTo(8, 9);
  });

  it('START of B rasted onto END of A writes A → B into A (the direction the ends imply)', async () => {
    addPath(rig, 'A', [lineSpec([0, 0, 0], [0, 0, 5])]);
    addPath(rig, 'B', [lineSpec([0, 0, 5.2], [0, 0, 12])]);
    const r = await drag(rig, 'B', 'v0', [0.02, 0, 5.05]);
    expect(r.ok).toBe(true);
    expect(r.successorChanges).toEqual([{ from: 'A', to: 'B', op: 'add' }]);
    expect(succ('A')).toEqual(['B']);
    expect(succ('B')).toEqual([]);
  });

  it('END onto END writes nothing (same-end)', async () => {
    addPath(rig, 'A', [lineSpec([0, 0, 0], [0, 0, 5])]);
    addPath(rig, 'B', [lineSpec([0, 0, 12], [0, 0, 8])]);
    const r = await drag(rig, 'A', 'v1', [0, 0, 7.9]);
    expect(r.ok).toBe(true);
    expect(r.linkSkipped).toBe('same-end');
    expect(r.successorChanges).toEqual([]);
    expect(succ('A')).toEqual([]);
    expect(rig.doc.ops.length).toBe(1);
    const entry = rig.doc.ops[0] as unknown as { kind: string; fieldName?: string; ops?: { fieldName: string }[] };
    expect(entry).toBeDefined();
    // Only the segments op — no successors write.
    const fields = entry.kind === 'composite' ? entry.ops!.map((o) => o.fieldName) : [entry.fieldName];
    expect(fields).toEqual(['segments']);
  });

  it('ends that meet with directions beyond 2° write nothing (tolerance)', async () => {
    addPath(rig, 'A', [lineSpec([0, 0, 0], [0, 0, 5])]);
    addPath(rig, 'B', [lineSpec([0, 0, 8], [4, 0, 8])]); // B runs along +X, A along +Z
    const r = await drag(rig, 'A', 'v1', [0, 0, 7.9]);
    expect(r.ok).toBe(true);
    expect(r.linkSkipped).toBe('tolerance');
    expect(succ('A')).toEqual([]);
  });

  it('pulling a linked end apart removes the link it broke', async () => {
    addPath(rig, 'A', [lineSpec([0, 0, 0], [0, 0, 5])], ['B']);
    addPath(rig, 'B', [lineSpec([0, 0, 5], [0, 0, 9])]);
    const r = await drag(rig, 'A', 'v1', [3, 0, 3]); // free, far from any end
    expect(r.ok).toBe(true);
    expect(r.successorChanges).toEqual([{ from: 'A', to: 'B', op: 'remove' }]);
    expect(succ('A')).toEqual([]);
    await rig.doc.undo();
    expect(succ('A')).toEqual(['B']);
  });

  it('a failed commit leaves nothing half written and records no undo step', async () => {
    const a = addPath(rig, 'A', [lineSpec([0, 0, 0], [0, 0, 5])]);
    addPath(rig, 'B', [lineSpec([0, 0, 8], [0, 0, 12])]);
    const before = readSegmentSpecs(a as unknown as { userData: Record<string, unknown> });
    rig.failOn.field = 'successors'; // segments op applies, successors op is refused
    const origError = console.error;
    console.error = () => {};
    let r;
    try {
      r = await drag(rig, 'A', 'v1', [0.05, 0, 7.9]);
    } finally {
      console.error = origError;
    }
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('refused successors');
    expect(readSegmentSpecs(a as unknown as { userData: Record<string, unknown> })).toEqual(before);
    expect(succ('A')).toEqual([]);
    const pa = getDefaultPathNetwork().get('A');
    expect(pa).not.toBeNull();
    expect(pa!.length).toBeCloseTo(5, 9);
    expect(rig.doc.ops.length).toBe(0);
    expect(rig.doc.canUndo()).toBe(false);
  });

  it('save / reload: the extras roundtrip and an op-log replay both keep A → B, and the check is clean', async () => {
    addPath(rig, 'A', [lineSpec([0, 0, 0], [0, 0, 5])]);
    addPath(rig, 'B', [lineSpec([0, 0, 8], [0, 0, 12])]);
    const r = await drag(rig, 'A', 'v1', [0.05, 0, 7.9]);
    expect(r.ok).toBe(true);

    // (a) "save" = the extras as they go into the GLB; "reload" = fresh nodes from them.
    const saved = new Map([...rig.nodes].map(([p, n]) => [p, JSON.stringify(n.userData.realvirtual)]));
    const ops = [...rig.doc.ops];
    rig.plugin.dispose();
    getDefaultPathNetwork().clear();
    const reloaded = { scene: new Scene(), nodes: new Map<string, Object3D>() };
    for (const [p, json] of saved) {
      const extras = JSON.parse(json) as { Path: { id: string; segments: PathSegmentSpec[]; successors: string[] } };
      addPath(reloaded, p.slice('Root/'.length), extras.Path.segments, extras.Path.successors);
    }
    expect(succ('A')).toEqual(['B']);
    const check = new PathTopologyCheck({ on: () => () => {}, whenSceneReady: async () => {} });
    clearAllProblems();
    const res = check.runNow();
    expect(res.paths).toBe(2);
    expect(res.links).toBe(1);
    expect(res.mismatches).toEqual([]);
    expect(getProblems()).toEqual([]);

    // (b) the op log replayed onto the ORIGINAL geometry reproduces the link.
    getDefaultPathNetwork().clear();
    const fresh = { scene: new Scene(), nodes: new Map<string, Object3D>() };
    addPath(fresh, 'A', [lineSpec([0, 0, 0], [0, 0, 5])]);
    addPath(fresh, 'B', [lineSpec([0, 0, 8], [0, 0, 12])]);
    const replayDoc = new RvDocument({
      id: 'replay', name: 'Replay', mode: 'scene', executor: makeExecutor(fresh.nodes, { field: null }),
    });
    await replayDoc.replayOps(ops);
    expect(succ('A')).toEqual(['B']);
    expect(getDefaultPathNetwork().get('A')!.length).toBeCloseTo(8, 9);
    rig.plugin = new PathVisualizerPlugin(); // afterEach disposes a live instance
  });
});

// ─── 2. Check service in the real load lifecycle ────────────────────────

describe('F8 — the check service in a real viewer load (R2-2)', () => {
  let handle: TestViewerHandle | null = null;

  beforeEach(() => {
    clearAllProblems();
  });

  afterEach(() => {
    handle?.dispose();
    handle = null;
  });

  async function rootPathOfEmptyScene(viewer: RVViewer): Promise<string> {
    await viewer.loadScene(makeDraftScene({ kind: 'empty' }, 'probe'));
    const root = (viewer as unknown as { currentModel: Object3D | null }).currentModel;
    expect(root, 'empty scene has a model root').toBeTruthy();
    const path = viewer.registry?.getPathForNode(root!) ?? root!.name;
    expect(typeof path).toBe('string');
    return path;
  }

  function sceneWithPaths(rootPath: string, name: string, paths: { id: string; from: V3; to: V3; successors?: string[] }[]) {
    const scene = makeDraftScene({ kind: 'empty' }, name);
    let n = 0;
    scene.edits.ops = paths.map((p) => ({
      id: `${name}_add_${++n}`,
      ts: Date.now(),
      schemaV: 1,
      kind: 'addNode',
      nodePath: `${rootPath}/${p.id}`,
      spec: {
        parentPath: rootPath,
        name: p.id,
        position: [0, 0, 0],
        quaternion: [0, 0, 0, 1],
        scale: [1, 1, 1],
        components: { Path: { type: 'Path', id: p.id, segments: [lineSpec(p.from, p.to)], successors: p.successors ?? [] } },
      },
    })) as unknown as RvOp[];
    return scene;
  }

  const mismatchIds = (): string[] =>
    getProblems().filter((p) => p.code === PATH_SUCCESSOR_MISMATCH).map((p) => p.id).sort();

  it('an empty base whose only content is stored addNode(Path) nodes is checked AFTER they exist', async () => {
    handle = await createTestViewer('webgl');
    const v = handle.viewer;
    const rootPath = await rootPathOfEmptyScene(v);
    const runs0 = v.pathTopologyCheck.runs;

    // A → B touch, nothing declared → one mismatch on A.
    await v.loadScene(sceneWithPaths(rootPath, 'bad', [
      { id: 'PA', from: [0, 0, 0], to: [1, 0, 0] },
      { id: 'PB', from: [1, 0, 0], to: [2, 0, 0] },
    ]));
    await v.whenSceneReady();
    await v.pathTopologyCheck.whenIdle();
    expect(getDefaultPathNetwork().get('PA'), 'addNode path registered').not.toBeNull();
    expect(v.pathTopologyCheck.runs).toBeGreaterThan(runs0);
    const last = v.pathTopologyCheck.lastResult;
    expect(last).not.toBeNull();
    expect(last!.paths).toBe(2);
    expect(mismatchIds()).toEqual([`${PATH_SUCCESSOR_MISMATCH}:PA`]);
    const entry = getProblems().find((p) => p.code === PATH_SUCCESSOR_MISMATCH);
    expect(entry).toBeDefined();
    // An empty GLB's root has an empty name, so its children read '/PA'.
    expect(entry!.nodePath).toBe(`${rootPath}/PA`);

    // Other paths, declared consistently → the model change clears, the new check is clean.
    // The shared default network still holds PA/PB of the previous model (path
    // components are not disposed on a model switch — pre-existing); the check
    // reads the model's own paths, so it neither counts nor reports them.
    await v.loadScene(sceneWithPaths(rootPath, 'good', [
      { id: 'GA', from: [0, 0, 0], to: [1, 0, 0], successors: ['GB'] },
      { id: 'GB', from: [1, 0, 0], to: [2, 0, 0] },
    ]));
    await v.whenSceneReady();
    await v.pathTopologyCheck.whenIdle();
    expect(v.pathTopologyCheck.lastResult).not.toBeNull();
    expect(v.pathTopologyCheck.lastResult!.paths, getDefaultPathNetwork().all().map((p) => p.id).join(',')).toBe(2);
    expect(mismatchIds()).toEqual([]);
  });

  it('a load overtaken by a second one reports nothing of its own', async () => {
    handle = await createTestViewer('webgl');
    const v = handle.viewer;
    const rootPath = await rootPathOfEmptyScene(v);
    const skipped0 = v.pathTopologyCheck.skipped;

    const first = v.loadScene(sceneWithPaths(rootPath, 'first', [
      { id: 'XA', from: [0, 0, 0], to: [1, 0, 0] },
      { id: 'XB', from: [1, 0, 0], to: [2, 0, 0] },
    ]));
    first.catch(() => { /* superseded — expected */ });
    const second = v.loadScene(sceneWithPaths(rootPath, 'second', [
      { id: 'YA', from: [0, 0, 0], to: [1, 0, 0], successors: ['YB'] },
      { id: 'YB', from: [1, 0, 0], to: [2, 0, 0] },
    ]));
    await Promise.allSettled([first, second]);
    await v.whenSceneReady();
    await v.pathTopologyCheck.whenIdle();
    expect(getProblems().filter((p) => p.id.includes('XA') || p.id.includes('XB'))).toEqual([]);
    expect(mismatchIds()).toEqual([]);
    const registered = (v.registry?.getAll<{ path?: { id: string } | null }>('Path') ?? []).map((e) => e.instance.path?.id);
    expect(registered).not.toContain('XA');
    const last = v.pathTopologyCheck.lastResult;
    expect(last).not.toBeNull();
    expect(last!.paths).toBe(2);
    expect(v.pathTopologyCheck.skipped).toBeGreaterThanOrEqual(skipped0);
  });
});
