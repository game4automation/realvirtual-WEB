// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-641 §9.7 + §9.7b (geometry, pose validity) — `web_check_gap` /
 * `web_check_contact` and assertion lines in the replay.
 *
 *  - two plates 5 mm apart, tilted 45° → 5 mm (mesh), while their AABBs overlap;
 *  - intersection → `overlap`, enclosure → `contained`;
 *  - instances and a non-uniformly scaled millimetre subtree come out in mm;
 *  - runtime tree (baked: chunk segment ranges via `chunkTargetsOf`) measures the
 *    same as the editor tree in the authoring pose; a pose is set and restored;
 *    a pose in the editor tree is `pose-requires-runtime`;
 *  - `unsupported-target`, `too-complex`;
 *  - `web_macro_assert` adds a line that a replay measures: green, then red
 *    (`macro-step-failed`) after the geometry moved.
 *
 * AGPL-only — runs in the community edition as well.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BoxGeometry, BufferGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, Object3D,
  PerspectiveCamera, Scene, SphereGeometry, Vector3,
} from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { DriveDirection, RVDrive } from '../src/core/engine/rv-drive';
import type { ChunkHighlightTarget } from '../src/core/engine/rv-bake-registry';
import { runGeometryCheck, type GeometryCheckResult } from '../src/plugins/mcp-bridge/rv-mcp-check-tools';
import { GAP_TRIANGLE_BUDGET } from '../src/plugins/mcp-bridge/rv-mesh-gap';
import { McpBridgePlugin } from '../src/plugins/mcp-bridge-plugin';
import { buildMultiDispatcher } from '../src/core/engine/rv-mcp-tools';
import { setActiveAssetContext } from '../src/core/editor/active-asset-store';
import { __clearDraftStoresForTests } from '../src/core/ops/rv-document-drafts';
import { _resetButtonSimStateForTest } from '../src/core/hmi/button-sim-state';
import { getProblems } from '../src/core/hmi/problems-store';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { macroBookOf, macroJobs, macroRecorder, type RvMacroAssertStep } from '../src/plugins/mcp-bridge/rv-mcp-macro';

const MAT = new MeshStandardMaterial();

interface Rig {
  scene: Scene;
  root: Group;
  registry: NodeRegistry;
  viewer: RVViewer;
  add(parent: Object3D, name: string, obj?: Object3D): Object3D;
}

function rig(opts: { bake?: { placementOf: (n: Object3D) => Object3D | null; chunkTargetsOf: (n: Object3D) => ChunkHighlightTarget[] | null }; drives?: RVDrive[] } = {}): Rig {
  const scene = new Scene();
  const root = new Group();
  root.name = 'Asset';
  scene.add(root);
  const registry = new NodeRegistry();
  const drives: RVDrive[] = opts.drives ?? [];
  const viewer = {
    scene, registry, drives, camera: new PerspectiveCamera(),
    get currentModelRoot() { return root; },
    ...(opts.bake ? { bakeRegistry: opts.bake } : {}),
  } as unknown as RVViewer;
  const add = (parent: Object3D, name: string, obj: Object3D = new Object3D()): Object3D => {
    obj.name = name;
    parent.add(obj);
    registry.registerNode(NodeRegistry.computeNodePath(obj), obj);
    return obj;
  };
  registry.registerNode(NodeRegistry.computeNodePath(root), root);
  return { scene, root, registry, viewer, add };
}

/** A thin plate (0.2 × 0.01 × 0.2 m) tilted 45° about Z, its centre offset along the tilted normal. */
function tiltedPlate(normalOffset: number): Mesh {
  const m = new Mesh(new BoxGeometry(0.2, 0.01, 0.2), MAT);
  m.rotation.z = Math.PI / 4;
  const n = new Vector3(0, 1, 0).applyAxisAngle(new Vector3(0, 0, 1), Math.PI / 4);
  m.position.copy(n.multiplyScalar(normalOffset));
  return m;
}

async function check(r: Rig, a: string, b: string, extra: { pose?: Record<string, number>; toleranceMm?: number } = {}) {
  r.scene.updateMatrixWorld(true);
  return runGeometryCheck(r.viewer, { a, b, ...extra });
}

function ok(res: unknown): GeometryCheckResult {
  expect(res, JSON.stringify(res)).not.toHaveProperty('error');
  return res as GeometryCheckResult;
}

describe('web_check_gap geometry (M7)', () => {
  it('two tilted plates 5 mm apart → 5 mm (mesh), although their AABBs overlap', async () => {
    const r = rig();
    r.add(r.root, 'A', tiltedPlate(0));
    r.add(r.root, 'B', tiltedPlate(0.015)); // centre distance 15 mm − 10 mm thickness
    const res = ok(await check(r, 'Asset/A', 'Asset/B'));
    expect(res.gapMm).toBeCloseTo(5, 2);
    expect(res).toMatchObject({ contact: false, overlap: false, contained: false, tree: 'editor', triangles: { a: 12, b: 12 } });
    // The AABBs of the two tilted plates intersect — an AABB measurement would say 0.
    r.scene.updateMatrixWorld(true);
    const ba = new (await import('three')).Box3().setFromObject(r.root.getObjectByName('A')!);
    const bb = new (await import('three')).Box3().setFromObject(r.root.getObjectByName('B')!);
    expect(ba.intersectsBox(bb)).toBe(true);
  });

  it('contact within tolerance; intersection → overlap; enclosure → contained', async () => {
    const r = rig();
    const big = new Mesh(new BoxGeometry(1, 1, 1), MAT);
    r.add(r.root, 'Big', big);
    const touching = new Mesh(new BoxGeometry(1, 1, 1), MAT);
    touching.position.set(1.00005, 0, 0); // 0.05 mm gap
    r.add(r.root, 'Touch', touching);
    const crossing = new Mesh(new BoxGeometry(1, 1, 1), MAT);
    crossing.position.set(0.5, 0.2, 0);
    r.add(r.root, 'Cross', crossing);
    const inner = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), MAT);
    r.add(r.root, 'Inner', inner);

    expect(ok(await check(r, 'Asset/Big', 'Asset/Touch'))).toMatchObject({ contact: true, overlap: false });
    expect(ok(await check(r, 'Asset/Big', 'Asset/Touch', { toleranceMm: 0.01 }))).toMatchObject({ contact: false });
    expect(ok(await check(r, 'Asset/Big', 'Asset/Cross'))).toMatchObject({ gapMm: 0, overlap: true, contact: true });
    expect(ok(await check(r, 'Asset/Big', 'Asset/Inner'))).toMatchObject({ gapMm: 0, overlap: true, contained: true, containedIn: 'b' });
    expect(ok(await check(r, 'Asset/Inner', 'Asset/Big'))).toMatchObject({ contained: true, containedIn: 'a' });
  });

  it('instances and a non-uniformly scaled millimetre subtree come out in mm', async () => {
    const r = rig();
    // CAD root in millimetres, non-uniform (x stretched 2×).
    const cad = r.add(r.root, 'Cad');
    cad.scale.set(0.002, 0.001, 0.001);
    const part = new Mesh(new BoxGeometry(10, 10, 10), MAT); // 20 × 10 × 10 mm in world
    r.add(cad, 'Part', part);
    const inst = new InstancedMesh(new BoxGeometry(0.01, 0.01, 0.01), MAT, 2);
    inst.setMatrixAt(0, new Matrix4().makeTranslation(0.5, 0, 0));
    inst.setMatrixAt(1, new Matrix4().makeTranslation(0.03, 0, 0)); // nearest: x 0.025..0.035
    r.add(r.root, 'Inst', inst);
    const res = ok(await check(r, 'Asset/Cad', 'Asset/Inst'));
    // Part spans x −0.01..0.01 m → gap to 0.025 = 15 mm.
    expect(res.gapMm).toBeCloseTo(15, 2);
    expect(res.triangles).toEqual({ a: 12, b: 24 });
  });

  it('unsupported-target for a node without geometry; too-complex above the budget', async () => {
    const r = rig();
    r.add(r.root, 'Empty');
    r.add(r.root, 'Box', new Mesh(new BoxGeometry(1, 1, 1), MAT));
    expect(await check(r, 'Asset/Empty', 'Asset/Box')).toMatchObject({ code: 'unsupported-target' });
    expect(await check(r, 'Asset/Nope', 'Asset/Box')).toMatchObject({ code: 'node-not-found' });
    const segs = Math.ceil(Math.sqrt(GAP_TRIANGLE_BUDGET / 2)) + 10;
    r.add(r.root, 'S1', new Mesh(new SphereGeometry(1, segs, segs), MAT));
    r.add(r.root, 'S2', new Mesh(new SphereGeometry(1, segs, segs), MAT));
    expect(await check(r, 'Asset/S1', 'Asset/S2')).toMatchObject({ code: 'too-complex' });
  });
});

describe('runtime tree and pose (M6 validity, M7)', () => {
  /** A "baked" rig: B is a chunk-geometry window owned by node B (segment range), A a keep mesh. */
  function runtimeRig() {
    const chunkGeom: BufferGeometry = new BoxGeometry(0.1, 0.1, 0.1).toNonIndexed();
    chunkGeom.setIndex([...Array(36).keys()]);
    let ref: Rig;
    const targets = new Map<Object3D, ChunkHighlightTarget[]>();
    const bake = {
      placementOf: (n: Object3D) => (n === ref.root || n.parent ? ref.root : null),
      chunkTargetsOf: (n: Object3D) => targets.get(n) ?? null,
    };
    const drive = (() => {
      const r = rig({ bake, drives: [] });
      ref = r;
      return r;
    })();
    const r = drive;
    r.add(r.root, 'A', new Mesh(new BoxGeometry(0.1, 0.1, 0.1), MAT));
    const axis = r.add(r.root, 'Axis');
    axis.position.set(0.15, 0, 0); // B spans x 0.1..0.2 → gap 50 mm to A (x ≤ 0.05)
    const d = new RVDrive(axis);
    d.Direction = DriveDirection.LinearX;
    d.initDrive();
    r.registry.register('Drive', 'Asset/Axis', d);
    (r.viewer as unknown as { drives: RVDrive[] }).drives.push(d);
    // The chunk mesh hangs under the axis (a mover chunk), node B owns a window of it.
    const chunkMesh = new Mesh(chunkGeom, MAT);
    chunkMesh.userData['_rvBakeChunk'] = true;
    axis.add(chunkMesh);
    const b = r.add(axis, 'B');
    targets.set(b, [{ mesh: chunkMesh, range: { indexStart: 0, indexCount: 36, centerX: 0, centerY: 0, centerZ: 0, radius: 1 } }]);
    return { r, drive: d, axis };
  }

  it('the runtime tree measures via segment ranges; a pose is set for the copy and restored', async () => {
    const { r, drive, axis } = runtimeRig();
    const base = ok(await check(r, 'Asset/A', 'Asset/Axis/B'));
    expect(base).toMatchObject({ tree: 'runtime', triangles: { a: 12, b: 12 } });
    expect(base.gapMm).toBeCloseTo(50, 3);
    const before = [...axis.position.toArray(), ...axis.matrixWorld.elements];
    // LinearX moves along −X in glTF space: +30 mm closes the gap to 20 mm.
    const posed = ok(await check(r, 'Asset/A', 'Asset/Axis/B', { pose: { 'Asset/Axis': 30 } }));
    expect(posed.gapMm).toBeCloseTo(20, 3);
    expect(posed.pose).toEqual([{ drive: 'Axis', position: 30, source: 'explicit' }]);
    expect([...axis.position.toArray(), ...axis.matrixWorld.elements]).toEqual(before);
    expect(drive.currentPosition).toBe(0);
    // By unique name as well.
    expect(ok(await check(r, 'Asset/A', 'Asset/Axis/B', { pose: { Axis: 60 } }))).toMatchObject({ overlap: true });
    expect(await check(r, 'Asset/A', 'Asset/Axis/B', { pose: { Nope: 1 } })).toMatchObject({ code: 'pose-unknown-drive' });
  });

  it('editor tree and runtime tree agree in the authoring pose; a pose in the editor tree is refused', async () => {
    const r = rig();
    r.add(r.root, 'A', new Mesh(new BoxGeometry(0.1, 0.1, 0.1), MAT));
    const axis = r.add(r.root, 'Axis');
    axis.position.set(0.15, 0, 0);
    r.add(axis, 'B', new Mesh(new BoxGeometry(0.1, 0.1, 0.1), MAT));
    const editor = ok(await check(r, 'Asset/A', 'Asset/Axis/B'));
    const { r: rt } = runtimeRig();
    const runtime = ok(await check(rt, 'Asset/A', 'Asset/Axis/B'));
    expect(editor.tree).toBe('editor');
    expect(editor.gapMm).toBeCloseTo(runtime.gapMm, 6);
    expect(await check(r, 'Asset/A', 'Asset/Axis/B', { pose: { Axis: 1 } })).toMatchObject({ code: 'pose-requires-runtime' });
  });
});

// ─── assertion lines in the replay ─────────────────────────────────────

describe('web_macro_assert + replay (§9.7)', () => {
  afterEach(() => {
    macroRecorder._resetForTest();
    macroJobs._resetForTest();
    setActiveAssetContext(null);
    _resetButtonSimStateForTest();
  });

  it('an assertion line is measured on add and on every replay: green, then red after the geometry moved', async () => {
    await __clearDraftStoresForTests();
    const r = rig();
    r.add(r.root, 'A', tiltedPlate(0));
    const b = r.add(r.root, 'B', tiltedPlate(0.015));
    const viewer = Object.assign(r.viewer, {
      modes: { activeMode: 'editor', has: () => true, setMode() {}, list: () => [{ id: 'editor' }], subscribe: () => () => {} },
      selectionManager: { select() {}, clear() {}, selectPaths() {}, getSnapshot: () => ({ selectedPaths: [], primaryPath: null }) },
      leftPanelManager: { isOpen: () => true, open() {} }, highlighter: { flash() {} },
      fitToNodes() {}, getPlugin: () => undefined, use() {}, markRenderDirty() {}, markShadowsDirty() {}, emit() {},
      on() { return () => {}; }, rebuildGroupedBvh() {}, refitRaycastSubtrees() {},
    }) as unknown as RVViewer;
    const doc = scratchAssetDocument(viewer);
    setActiveAssetContext({ viewer, doc });
    const plugin = new McpBridgePlugin();
    // plan-668: the test transport stands for a tab with AI control on.
    (plugin as unknown as { _aiEnabled: boolean })._aiEnabled = true;
    (plugin as unknown as { viewer: RVViewer }).viewer = viewer;
    (plugin as unknown as { _dispatcher: ReturnType<typeof buildMultiDispatcher> })._dispatcher =
      buildMultiDispatcher(plugin.mcpToolInstances);
    const sent: string[] = [];
    (plugin as unknown as { _ws: unknown })._ws = {
      readyState: 1, send: (d: string) => { sent.push(d); }, close: vi.fn(), onclose: null, onerror: null, onmessage: null,
    };
    const handle = (plugin as unknown as { _handleMessage: (raw: string) => Promise<void> })._handleMessage.bind(plugin);
    let id = 0;
    const call = async (tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const n = sent.length;
      await handle(JSON.stringify({ type: 'call', id: ++id, tool, arguments: args }));
      const frame = JSON.parse(sent[n]);
      expect(frame.error, `transport error: ${frame.error}`).toBeUndefined();
      return JSON.parse(frame.result);
    };
    try {
      r.scene.updateMatrixWorld(true);
      const tool = await call('web_check_gap', { a: 'Asset/A', b: 'Asset/B' });
      expect(tool['gapMm'] as number).toBeCloseTo(5, 2);
      expect(await call('web_check_contact', { a: 'Asset/A', b: 'Asset/B', toleranceMm: 6 })).toMatchObject({ contact: true });

      const added = await call('web_macro_assert', {
        name: 'checks', check: 'gap',
        args: JSON.stringify({ a: 'Asset/A', b: 'Asset/B' }),
        expect: JSON.stringify({ gapMm: { min: 4, max: 6 } }),
        _reason: 'rod must clear the plate', _source: 'customer:demo',
      });
      expect(added).toMatchObject({ name: 'checks', step: 1, passesNow: true });
      const line = macroBookOf(doc.document).macros.get('checks')!.steps[0] as RvMacroAssertStep;
      expect(line).toMatchObject({ kind: 'assert', check: 'gap', args: { a: 'Asset/A', b: 'Asset/B' }, note: { reason: 'rod must clear the plate' } });
      expect(await call('web_macro_assert', { name: 'checks', check: 'volume', args: '{}', expect: '{}' })).toHaveProperty('error');

      const dry = await call('web_macro_replay', { name: 'checks', dryRun: true });
      expect((dry['steps'] as Array<{ willRun: boolean }>)[0].willRun).toBe(true);

      const run = async () => {
        const job = await call('web_macro_replay', { name: 'checks' });
        let s: Record<string, unknown> = {};
        await vi.waitFor(async () => {
          s = await call('web_macro_status', { jobId: job['jobId'] });
          expect(s['state']).not.toBe('running');
        }, { timeout: 30_000, interval: 20 });
        return s;
      };
      const green = await run();
      expect(green).toMatchObject({ state: 'done', counts: { ok: 1 } });
      expect((green['report'] as Array<Record<string, unknown>>)[0]).toMatchObject({ kind: 'assert', check: 'gap', status: 'ok' });

      // The plate moves 3 mm closer — the stored assertion now fails.
      b.position.add(new Vector3(0, 1, 0).applyAxisAngle(new Vector3(0, 0, 1), Math.PI / 4).multiplyScalar(-0.003));
      r.scene.updateMatrixWorld(true);
      const red = await run();
      expect(red).toMatchObject({ state: 'done', counts: { failed: 1 } });
      const redLine = (red['report'] as Array<Record<string, unknown>>)[0];
      expect(redLine).toMatchObject({ status: 'failed', errorKind: 'assertion-failed' });
      expect(String(redLine['reason'])).toMatch(/< min 4 mm/);
      expect(getProblems().some((p) => p.code === 'macro-step-failed' && p.title.includes('assert gap'))).toBe(true);
    } finally {
      doc.dispose();
    }
  });
});
