// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-766 §9.7 — the arenas change WHO DRAWS, never what the tree means:
 *   - contract: sources `visible = true`, `layers.mask = 0`
 *   - pick (real InstancePickIndex): arena source pickable, user-hidden source
 *     ray-transparent, trashed source unpickable
 *   - highlight: arena sources take the overlay path (isRenderedMesh false)
 *   - MCP universe (`buildMeshUniverse`) and source userData unchanged
 *   - export: GLB bytes identical with and without arenas
 *   - dispose: layers restored, `.visible` untouched, no arena left, only
 *     arena-owned resources disposed (never source geometry/material)
 *   - two documents in a row / F5-style swap leave no arena behind
 *   - capture mode (withCaptureMode, wireframe swapIn) switches layers and back
 *   - runtime neutrality: every seam is a no-op without a manager
 */
import { describe, it, expect, vi } from 'vitest';
import { BufferGeometry, Group, Mesh, Raycaster, Scene, Vector3 } from 'three';
import type { Intersection, Object3D } from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { InstancePickIndex } from '../src/core/engine/rv-instance-pick-index';
import { RVHighlightManager } from '../src/core/engine/rv-highlight-manager';
import { MODE_HIGHLIGHT_PROFILES } from '../src/core/engine/rv-highlight-profiles';
import { buildMeshUniverse } from '../src/plugins/mcp-bridge/rv-mcp-view-tools';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { RVWireframeView } from '../src/core/rv-wireframe-view';
import { EditorArenaManager } from '../src/core/editor/rv-editor-arena';
import { RVUberArenaMaterial } from '../src/core/engine/rv-uber-arena-material';
import { arenaSinkOf } from '../src/core/engine/rv-arena-sink';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import {
  arenaMeshesIn, buildArenaFixture, makeArenaViewerStub, part, testRoleOf, uberMat,
} from './helpers/editor-arena-fixture';
import '../src/core/editor/rv-cadlink';

BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
Mesh.prototype.raycast = acceleratedRaycast;

function makeEnv(withArena: boolean) {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);
  const a = new Group(); a.name = 'A';
  const b = new Group(); b.name = 'B'; b.position.x = 5;
  const meshA = part('MeshA', uberMat(0xff0000));
  const meshB = part('MeshB', uberMat(0x00ff00));
  a.add(meshA); b.add(meshB);
  model.add(a, b);
  model.updateMatrixWorld(true);
  const registry = new NodeRegistry();
  model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  const index = new InstancePickIndex(registry);
  index.addSubtree(model);
  const stub = makeArenaViewerStub({
    scene, registry,
    get currentModelRoot() { return model; },
    get instancePickIndex() { return index; },
  });
  let mgr: EditorArenaManager | null = null;
  if (withArena) {
    mgr = new EditorArenaManager({ scene, roleOf: testRoleOf });
    mgr.build(model);
    (stub as { editorArena: unknown }).editorArena = mgr;
  }
  const viewer = stub as unknown as RVViewer;
  const doc = scratchAssetDocument(viewer);
  return { scene, model, registry, index, viewer, doc, mgr, meshA, meshB };
}

function pick(index: InstancePickIndex, x: number): string | null {
  const ray = new Raycaster(new Vector3(x, 10, 0), new Vector3(0, -1, 0));
  const out: Intersection<Object3D>[] = [];
  index.raycast(ray, out);
  out.sort((p, q) => p.distance - q.distance);
  for (const hit of out) {
    const path = index.resolvePath(hit.object);
    if (path) return path;
  }
  return null;
}

describe('contract + pick', () => {
  it('sources stay visible with mask 0; pick hits the arena source exactly', () => {
    const { mgr, index, registry, meshA, meshB } = makeEnv(true);
    expect(mgr!.refOf(meshA)).toBeDefined();
    for (const m of [meshA, meshB]) {
      expect(m.visible).toBe(true);
      expect(m.layers.mask).toBe(0);
    }
    expect(pick(index, 0)).toBe(registry.getPathForNode(meshA));
    expect(pick(index, 5)).toBe(registry.getPathForNode(meshB));
  });

  it('user-hidden source is ray-transparent, trashed source unpickable', async () => {
    const { doc, index } = makeEnv(true);
    doc.setNodeVisible('Asset/A', false);
    await doc.whenIdle();
    expect(pick(index, 0)).toBeNull();
    await doc.undo();
    await doc.whenIdle();
    await doc.deleteNodes(['Asset/B']);
    await doc.whenIdle();
    expect(pick(index, 5)).toBeNull();
  });
});

describe('highlight + MCP universe + userData', () => {
  it('arena sources take the overlay path (outline profile falls back), editor profile builds fill pairs', () => {
    const { scene, model, mgr } = makeEnv(true);
    const outline = {
      available: true,
      hoverOutlined: [] as Object3D[],
      selectionOutlined: [] as Object3D[],
      setStyle() {}, setHoverStyle() {},
      setHoverOutlined(objs: readonly Object3D[]) { this.hoverOutlined = [...objs]; },
      clearHover() { this.hoverOutlined = []; },
      setOutlined(objs: readonly Object3D[]) { this.selectionOutlined = [...objs]; },
      clear() { this.selectionOutlined = []; },
      get hoverPass() { return { selectedObjects: this.hoverOutlined }; },
      get pass() { return { selectedObjects: this.selectionOutlined }; },
    };
    const hl = new RVHighlightManager(scene);
    hl.setOutlineManager(outline as never);
    hl.setProfile(MODE_HIGHLIGHT_PROFILES.planner);
    hl.highlight(model.children[0]);
    expect(outline.hoverOutlined).toEqual([]);
    const overlays = () => {
      let n = 0;
      scene.traverse((o) => { if (o.userData?._highlightOverlay && o.parent) n++; });
      return n;
    };
    expect(overlays()).toBeGreaterThan(0);
    hl.clear();
    hl.setProfile(MODE_HIGHLIGHT_PROFILES.editor);
    hl.highlight(model.children[0]);
    expect(overlays()).toBeGreaterThan(0);
    // overlay meshes are never adopted by the arenas
    mgr!.reconcile();
    expect(mgr!.stats().instances).toBe(2);
    hl.clear();
  });

  it('buildMeshUniverse and source userData are identical with and without arenas', () => {
    const plain = makeEnv(false);
    const arena = makeEnv(true);
    expect([...buildMeshUniverse(arena.viewer).keys()]).toEqual([...buildMeshUniverse(plain.viewer).keys()]);
    const ud = (m: Group) => {
      const out: string[] = [];
      m.traverse((o) => out.push(JSON.stringify(o.userData)));
      return out;
    };
    expect(ud(arena.model)).toEqual(ud(plain.model));
  });
});

describe('export', () => {
  it('GLB bytes are identical with and without arenas; arenas never reach the file', async () => {
    const plain = makeEnv(false);
    const arena = makeEnv(true);
    const a = new Uint8Array(await exportAssetGlb(plain.model));
    const b = new Uint8Array(await exportAssetGlb(arena.model));
    expect(b.length).toBe(a.length);
    expect(b).toEqual(a);
    expect(new TextDecoder().decode(b)).not.toContain('__rvEditorArena');
    // the live sources are still masked after the export clone
    expect(arena.meshA.layers.mask).toBe(0);
  });
});

describe('lifecycle', () => {
  it('dispose: layers back, .visible untouched, no arena left, only arena resources disposed', () => {
    const f = buildArenaFixture();
    f.uber[3].visible = false;
    const mgr = new EditorArenaManager({ scene: f.scene, roleOf: testRoleOf });
    mgr.build(f.root);
    const geoSpies = f.all.map((m) => vi.spyOn(m.geometry, 'dispose'));
    const matSpies = [...new Set(f.all.map((m) => m.material as { dispose: () => void }))]
      .map((m) => vi.spyOn(m, 'dispose'));
    const uberMatOwn = mgr.arenas[0].mesh.material as RVUberArenaMaterial;
    const ownSpy = vi.spyOn(uberMatOwn, 'dispose');
    const arenaGeoSpies = mgr.arenas.map((a) => vi.spyOn(a.mesh.geometry, 'dispose'));
    mgr.dispose();
    for (const m of f.all) expect(m.layers.mask).toBe(1);
    expect(f.uber[3].visible).toBe(false);
    for (const m of f.all.filter((x) => x !== f.uber[3])) expect(m.visible).toBe(true);
    expect(arenaMeshesIn(f.scene).length).toBe(0);
    for (const s of geoSpies) expect(s).not.toHaveBeenCalled();
    for (const s of matSpies) expect(s).not.toHaveBeenCalled();
    expect(ownSpy).toHaveBeenCalledTimes(1);
    for (const s of arenaGeoSpies) expect(s).toHaveBeenCalled();
  });

  it('two documents in a row and an F5-style swap leave no arena behind', () => {
    const scene = new Scene();
    const mgr = new EditorArenaManager({ scene, roleOf: testRoleOf });
    const doc1 = new Group(); doc1.add(part('x', uberMat())); scene.add(doc1);
    mgr.build(doc1);
    expect(arenaMeshesIn(scene).length).toBe(1);
    // document close / swap: dispose, the old root leaves the scene
    mgr.dispose();
    doc1.removeFromParent();
    const doc2 = new Group(); doc2.add(part('y', uberMat()), part('z', uberMat())); scene.add(doc2);
    mgr.build(doc2);
    expect(arenaMeshesIn(scene).length).toBe(1);
    expect(mgr.stats().instances).toBe(2);
    // F5 test-run swap: dispose before the swap, rebuild after the restore
    mgr.dispose();
    expect(arenaMeshesIn(scene).length).toBe(0);
    for (const m of doc2.children) expect(m.layers.mask).toBe(1);
    mgr.build(doc2);
    expect(arenaMeshesIn(scene).length).toBe(1);
    mgr.dispose();
  });

  it('withCaptureMode / wireframe swapIn switch layers for the duration and back', () => {
    const f = buildArenaFixture();
    const mgr = new EditorArenaManager({ scene: f.scene, roleOf: testRoleOf });
    mgr.build(f.root);
    const arenas = arenaMeshesIn(f.scene);
    const inside = mgr.withCaptureMode(() => ({
      src: f.uber[0].layers.mask, arena: arenas.map((a) => a.layers.mask),
    }));
    expect(inside.src).toBe(1);
    expect(inside.arena.every((m) => m === 0)).toBe(true);
    expect(f.uber[0].layers.mask).toBe(0);
    expect(arenas.every((a) => a.layers.mask === 1)).toBe(true);

    const wire = new RVWireframeView();
    wire.swapIn(f.root, () => false, mgr);
    expect(mgr.captureDepth).toBe(1);
    expect(wire.swappedCount).toBe(f.all.length); // every source visible to the line pass
    wire.swapOut();
    expect(mgr.captureDepth).toBe(0);
    expect(f.uber[0].layers.mask).toBe(0);
    wire.dispose();
    mgr.dispose();
  });
});

describe('runtime neutrality (no manager)', () => {
  it('executor visibility / trash flush, wireframe and sink lookups behave as before', async () => {
    const env = makeEnv(false);
    expect(arenaSinkOf(env.meshA)).toBeNull();
    env.doc.setNodeVisible('Asset/A', false);
    await env.doc.whenIdle();
    expect(env.registry.getNode('Asset/A')!.visible).toBe(false);
    await env.doc.deleteNodes(['Asset/B']);
    await env.doc.whenIdle();
    env.doc.executor.flushTrash();
    expect(env.meshA.layers.mask).toBe(1);
    const wire = new RVWireframeView();
    env.doc.setNodeVisible('Asset/A', true);
    await env.doc.whenIdle();
    wire.swapIn(env.model, () => false, null);
    expect(wire.swappedCount).toBe(1);
    wire.swapOut();
    wire.dispose();
    expect(arenaMeshesIn(env.scene).length).toBe(0);
  });

  it('apply listeners are opt-in: no listener → the op path is unchanged', async () => {
    const env = makeEnv(false);
    const seen: string[] = [];
    const off = env.doc.executor.addApplyListener((op, dir) => seen.push(`${op.kind}:${dir}`));
    env.doc.setNodeVisible('Asset/A', false);
    await env.doc.whenIdle();
    await env.doc.undo();
    await env.doc.whenIdle();
    expect(seen).toEqual(['setNodeVisible:forward', 'setNodeVisible:inverse']);
    off();
    env.doc.setNodeVisible('Asset/A', false);
    await env.doc.whenIdle();
    expect(seen.length).toBe(2);
  });
});
