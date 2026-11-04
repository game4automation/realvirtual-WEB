// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-675 §9.2 + §9.3 — `editor.generateUVs`: the op (a `replaceNodeGeometry`
 * per mesh, one undo step), undo/redo, `skipped`, the command descriptor with
 * explicit selection for macro replay, and the GLB round trip.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Scene, type BufferGeometry } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import type { AssetDocument } from '../src/core/editor/rv-asset-document';
import { McpEditorTools, editorGenerateUVsImpl } from '../src/plugins/mcp-bridge/rv-mcp-editor-tools';
import { EDITOR_GENERATE_UVS_COMMAND } from '../src/core/hmi/uv-command-descriptors';
import { hashPhase01 } from '../src/core/editor/rv-uv-generate';
import { setActiveAssetContext } from '../src/core/editor/active-asset-store';
import { __clearDraftStoresForTests } from '../src/core/ops/rv-document-drafts';
import { clearCadGlbCache } from '../src/core/import/rv-cad-glb-cache';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';

interface Env { viewer: RVViewer; doc: AssetDocument; tools: McpEditorTools; root: Group; roller: Mesh; plate: Mesh; twinA: Mesh; twinB: Mesh; selection: string[] }

function noUV<G extends BufferGeometry>(g: G): G { g.deleteAttribute('uv'); return g; }

function makeEnv(): Env {
  const scene = new Scene();
  const root = new Group(); root.name = 'Asset';
  scene.add(root);
  const mat = new MeshStandardMaterial({ color: 0xd8d8d8 });
  // SolidCraft-like body: millimetres under a 0.001 node scale.
  const rollers = new Group(); rollers.name = 'Rollers'; rollers.scale.setScalar(0.001);
  root.add(rollers);
  const roller = new Mesh(noUV(new CylinderGeometry(25, 25, 610, 32, 1, true)), mat); roller.name = 'Roller';
  rollers.add(roller);
  const plate = new Mesh(noUV(new BoxGeometry(1, 0.02, 0.5)), mat.clone()); plate.name = 'Plate';
  root.add(plate);
  const shared = noUV(new CylinderGeometry(0.02, 0.02, 0.4, 16, 1, true));
  const twinA = new Mesh(shared, mat); twinA.name = 'TwinA'; root.add(twinA);
  const twinB = new Mesh(shared, mat); twinB.name = 'TwinB'; root.add(twinB);
  const registry = new NodeRegistry();
  root.traverse((n: Object3D) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  root.updateMatrixWorld(true);
  const selection: string[] = [];
  const viewer = {
    scene, registry, signalStore: null, transportManager: null,
    get currentModelRoot() { return root; },
    modes: { activeMode: 'editor', has: () => true, setMode() {}, list: () => [{ id: 'editor' }], subscribe: () => () => {} },
    selectionManager: { select() {}, selectPaths() {}, clear() {}, getSnapshot: () => ({ selectedPaths: selection }) },
    markRenderDirty() {}, markShadowsDirty() {}, emit() {}, on() { return () => {}; },
    rebuildGroupedBvh() {}, refitRaycastSubtrees() {},
  } as unknown as RVViewer;
  const doc = scratchAssetDocument(viewer);
  setActiveAssetContext({ viewer, doc });
  return { viewer, doc, tools: new McpEditorTools(() => viewer), root, roller, plate, twinA, twinB, selection };
}

let env: Env;
beforeEach(async () => { await __clearDraftStoresForTests(); await clearCadGlbCache(); env = makeEnv(); });
afterEach(() => { setActiveAssetContext(null); env.doc.dispose(); });

const run = async (paths: string, mode = 'auto', overwrite = false): Promise<Record<string, unknown>> =>
  JSON.parse(await env.tools.generateUVsForPaths(paths, mode, overwrite)) as Record<string, unknown>;

describe('plan-675 §9.2 — generateUVs op', () => {
  it('adds uv to every mesh under a group path in ONE undo step; undo restores the geometry without uv; redo is deterministic', async () => {
    const before = env.roller.geometry;
    const r = await run('Asset');
    expect(r['error']).toBeUndefined();
    expect(r['ok']).toBe(true);
    expect(r['generatedCount']).toBe(4);
    const generated = r['generated'] as Array<{ path: string; mode: string; radiusMm?: number }>;
    const roller = generated.find((g) => g.path === 'Asset/Rollers/Roller')!;
    expect(roller.mode).toBe('cylindrical');
    expect(roller.radiusMm).toBeCloseTo(25, 0); // mm, through the 0.001 scale
    expect(generated.find((g) => g.path === 'Asset/Plate')!.mode).toBe('planar');
    expect(env.roller.geometry).not.toBe(before);
    expect(env.roller.geometry.getAttribute('uv')).toBeDefined();
    const uvAfter = Array.from(env.roller.geometry.getAttribute('uv').array);
    // One transaction = one history entry.
    expect(env.doc.ops.length).toBe(1);

    await env.doc.undo();
    await env.doc.whenIdle();
    expect(env.roller.geometry.getAttribute('uv')).toBeUndefined();
    expect(env.plate.geometry.getAttribute('uv')).toBeUndefined();

    await env.doc.redo();
    await env.doc.whenIdle();
    expect(Array.from(env.roller.geometry.getAttribute('uv').array)).toEqual(uvAfter);
  });

  it('cylindrical meshes sharing one geometry are split: each node gets its own start phase from its path', async () => {
    const r = await run('Asset/TwinA\nAsset/TwinB');
    expect(env.twinA.geometry.getAttribute('uv')).toBeDefined();
    expect(env.twinB.geometry.getAttribute('uv')).toBeDefined();
    expect(env.twinA.geometry).not.toBe(env.twinB.geometry);
    const generated = r['generated'] as Array<{ path: string; mode: string; phase?: number; sharedWith?: number }>;
    expect(generated.map((g) => g.mode)).toEqual(['cylindrical', 'cylindrical']);
    expect(generated.every((g) => g.sharedWith === undefined)).toBe(true);
    const pa = hashPhase01('Asset/TwinA'), pb = hashPhase01('Asset/TwinB');
    expect(generated.find((g) => g.path === 'Asset/TwinA')!.phase).toBe(pa);
    expect(generated.find((g) => g.path === 'Asset/TwinB')!.phase).toBe(pb);
    const ua = env.twinA.geometry.getAttribute('uv'), ub = env.twinB.geometry.getAttribute('uv');
    expect(ub.count).toBe(ua.count);
    for (let i = 0; i < ua.count; i++) expect(ub.getX(i) - ua.getX(i)).toBeCloseTo(pb - pa, 5);
    // Still one undo step.
    expect(env.doc.ops.length).toBe(1);
  });

  it('box meshes sharing one geometry at the same scale keep sharing it', async () => {
    const shared = noUV(new BoxGeometry(0.3, 0.3, 0.3));
    const a = new Mesh(shared, new MeshStandardMaterial()); a.name = 'CubeA'; env.root.add(a);
    const b = new Mesh(shared, new MeshStandardMaterial()); b.name = 'CubeB'; env.root.add(b);
    env.viewer.registry!.registerNode('Asset/CubeA', a);
    env.viewer.registry!.registerNode('Asset/CubeB', b);
    env.root.updateMatrixWorld(true);
    const r = await run('Asset/CubeA\nAsset/CubeB', 'box');
    expect((r['generated'] as Array<{ sharedWith?: number }>).every((g) => g.sharedWith === 1)).toBe(true);
    expect(a.geometry.getAttribute('uv')).toBeDefined();
    expect(a.geometry).toBe(b.geometry);
  });

  it('existing UVs are skipped unless overwrite; a second plain run generates nothing', async () => {
    await run('Asset/Plate');
    const second = await run('Asset/Plate');
    expect(second['ok']).toBe(false);
    expect((second['skipped'] as Array<{ reason: string }>)[0].reason).toBe('has-uv');
    const forced = await run('Asset/Plate', 'box', true);
    expect(forced['ok']).toBe(true);
    expect((forced['generated'] as Array<{ mode: string }>)[0].mode).toBe('box');
  });

  it('refuses an unknown mode and reports missing nodes in skipped', async () => {
    expect((await run('Asset/Plate', 'spherical'))['error']).toMatch(/mode must be/);
    const r = await run('Asset/Nope\nAsset/Plate');
    expect(r['ok']).toBe(true);
    expect((r['skipped'] as Array<{ path: string }>).map((s) => s.path)).toContain('Asset/Nope');
  });

  it('falls back to the current selection when no paths are given', async () => {
    env.selection.push('Asset/Plate');
    const r = await run('');
    expect(r['generatedCount']).toBe(1);
  });

  it('the generated UVs survive the GLB export and re-import', async () => {
    await run('Asset/Rollers/Roller');
    const uv = Array.from(env.roller.geometry.getAttribute('uv').array);
    const bytes = await exportAssetGlb(env.root);
    const loaded = await new GLTFLoader().parseAsync(bytes, '');
    const mesh = loaded.scene.getObjectByName('Roller') as Mesh;
    const back = mesh.geometry.getAttribute('uv');
    expect(back).toBeDefined();
    expect(back.count).toBe(uv.length / 2);
    for (let i = 0; i < 20; i++) expect(back.array[i]).toBeCloseTo(uv[i], 5);
  });
});

describe('plan-675 §9.3 — editor.generateUVs command', () => {
  it('is registered eagerly as a macro command bound to web_editor_generate_uvs', () => {
    const d = commandRegistry.get(EDITOR_GENERATE_UVS_COMMAND);
    expect(d).toBeDefined();
    expect(d!.macro).toBe(true);
    expect(d!.readOnly).toBe(false);
    expect(d!.mcp?.tool).toBe('web_editor_generate_uvs');
    expect(d!.argsSchema).toEqual({ paths: 'string', mode: 'string', overwrite: 'boolean' });
  });

  it('the lazy implementation is the bridge body', async () => {
    const d = commandRegistry.get(EDITOR_GENERATE_UVS_COMMAND)!;
    expect(await d.impl()).toBe(editorGenerateUVsImpl);
  });

  it('resolveArgs spells out the selection and the defaults (macro replay)', () => {
    const impl = editorGenerateUVsImpl as unknown as { resolveArgs: (ctx: unknown, a: unknown) => Record<string, unknown> };
    expect(impl.resolveArgs({ selection: ['A/B', 'A/C'] }, {})).toEqual({ paths: 'A/B\nA/C', mode: 'auto', overwrite: false });
    expect(impl.resolveArgs({ selection: ['A/B'] }, { paths: 'X', mode: 'Box', overwrite: true })).toEqual({ paths: 'X', mode: 'box', overwrite: true });
    // A name with a comma is stored as a JSON array (rv-path-list): a re-joined
    // singleton would split again on replay.
    expect(impl.resolveArgs({ selection: [] }, { paths: '["A/LINK,PLATE"]' }).paths).toBe('["A/LINK,PLATE"]');
  });

  it('runs through the command (with the call-context selection)', async () => {
    const impl = editorGenerateUVsImpl as unknown as { run: (ctx: unknown, a: unknown) => Promise<Record<string, unknown>> };
    const v = await impl.run({ viewer: env.viewer, selection: ['Asset/Plate'] }, {});
    expect(v['generatedCount']).toBe(1);
    expect(env.plate.geometry.getAttribute('uv')).toBeDefined();
  });
});
