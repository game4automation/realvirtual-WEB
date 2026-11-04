// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-641 §9.6 — the Phase-3 modelling commands, registry-only and reached
 * through `web_execute` on the REAL bridge path (`_handleMessage` → `_handleCall`
 * → `web_execute` → `runCommandStep` → registry → private impl → AssetDocument):
 *
 *  - `editor.clone`: a deep copy with a new unique name and OWN nodes, geometry
 *    and material; components copied; undo/redo through the trash; the macro
 *    line stores the resolved parent and base name (M4);
 *  - `editor.materialDefine`: a named PBR material, applied and undoable;
 *  - `editor.reorder`: the sibling index, undoable;
 *  - community edition: all three answer `requires-commercial`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, PerspectiveCamera, Scene } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { McpBridgePlugin } from '../src/plugins/mcp-bridge-plugin';
import { buildMultiDispatcher } from '../src/core/engine/rv-mcp-tools';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { setActiveAssetContext } from '../src/core/editor/active-asset-store';
import type { AssetDocument } from '../src/core/editor/rv-asset-document';
import { __clearDraftStoresForTests } from '../src/core/ops/rv-document-drafts';
import { _resetButtonSimStateForTest } from '../src/core/hmi/button-sim-state';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import {
  macroBookOf,
  macroJobs,
  macroRecorder,
  type RvMacroCommandStep,
} from '../src/plugins/mcp-bridge/rv-mcp-macro';

interface Env {
  viewer: RVViewer;
  doc: AssetDocument;
  root: Group;
  registry: NodeRegistry;
  call: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  exec: (command: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

function makeEnv(): Env {
  const scene = new Scene();
  const root = new Group();
  root.name = 'Asset';
  scene.add(root);
  const box = new Object3D();
  box.name = 'Box';
  box.position.set(0.5, 0, 0);
  (box.userData as Record<string, unknown>)['realvirtual'] = { Drive: { TargetSpeed: 100, Direction: 'LinearX' } };
  root.add(box);
  const body = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0x336699 }));
  body.name = 'Body';
  box.add(body);
  const other = new Object3D();
  other.name = 'Other';
  root.add(other);
  scene.updateMatrixWorld(true);

  const registry = new NodeRegistry();
  root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  let selectedPaths: string[] = [];
  const camera = new PerspectiveCamera(50, 1, 0.1, 1000);
  const viewer = {
    scene, registry, camera, signalStore: null, transportManager: null,
    get currentModelRoot() { return root; },
    modes: { activeMode: 'editor', has: () => true, setMode() {}, list: () => [{ id: 'editor' }], subscribe: () => () => {} },
    selectionManager: {
      select(p: string) { selectedPaths = [p]; }, clear() { selectedPaths = []; },
      selectPaths(p: string[]) { selectedPaths = [...p]; },
      getSnapshot: () => ({ selectedPaths, primaryPath: selectedPaths[0] ?? null }),
    },
    leftPanelManager: { isOpen: () => true, open() {} },
    highlighter: { flash() {} },
    fitToNodes() {}, getPlugin: () => undefined, use() {},
    markRenderDirty() {}, markShadowsDirty() {}, emit() {}, on() { return () => {}; },
    rebuildGroupedBvh() {}, refitRaycastSubtrees() {}, buildMeshBvhsAsync() {},
  } as unknown as RVViewer;

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
  const handleMessage = (plugin as unknown as { _handleMessage: (raw: string) => Promise<void> })._handleMessage.bind(plugin);
  let id = 0;
  const call = async (tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const n = sent.length;
    await handleMessage(JSON.stringify({ type: 'call', id: ++id, tool, arguments: args }));
    const frame = JSON.parse(sent[n]);
    expect(frame.error, `transport error: ${frame.error}`).toBeUndefined();
    return JSON.parse(frame.result);
  };
  const exec = (command: string, args: Record<string, unknown>) =>
    call('web_execute', { command, args: JSON.stringify(args) });
  return { viewer, doc, root, registry, call, exec };
}

let env: Env;

beforeEach(async () => {
  await __clearDraftStoresForTests();
  _resetButtonSimStateForTest();
  env = makeEnv();
});

afterEach(() => {
  macroRecorder._resetForTest();
  macroJobs._resetForTest();
  setActiveAssetContext(null);
  env.doc.dispose();
  _resetButtonSimStateForTest();
});

const childNames = (o: Object3D): string[] => o.children.map((c) => c.name);

describe.runIf(__RV_HAS_PRIVATE__)('plan-641 §9.6 — clone / materialDefine / reorder (private)', () => {
  it('editor.clone: new unique name, own nodes/geometry/material, components copied; undo + redo', async () => {
    const r = await env.exec('editor.clone', { path: 'Asset/Box' });
    expect(r).toMatchObject({ ok: true, status: 'ok', created: ['Asset/Box_1'] });
    const src = env.root.getObjectByName('Box')!;
    const copy = env.registry.getNode('Asset/Box_1')!;
    expect(copy).toBeTruthy();
    expect(copy).not.toBe(src);
    expect(copy.parent).toBe(env.root);
    expect(copy.position.toArray()).toEqual([0.5, 0, 0]);
    const srcBody = src.children[0] as Mesh;
    const copyBody = copy.children[0] as Mesh;
    expect(copyBody.name).toBe('Body');
    expect(copyBody).not.toBe(srcBody);
    expect(copyBody.geometry).not.toBe(srcBody.geometry);
    expect(copyBody.material).not.toBe(srcBody.material);
    expect(env.registry.getNode('Asset/Box_1/Body')).toBe(copyBody);
    expect((copy.userData as Record<string, Record<string, unknown>>)['realvirtual']['Drive'])
      .toEqual({ TargetSpeed: 100, Direction: 'LinearX' });
    // Editing the copy's material never reaches the source.
    (copyBody.material as MeshStandardMaterial).color.setHex(0xff0000);
    expect((srcBody.material as MeshStandardMaterial).color.getHex()).toBe(0x336699);

    await env.doc.undo();
    expect(env.registry.getNode('Asset/Box_1')).toBeFalsy();
    expect(childNames(env.root)).toEqual(['Box', 'Other']);
    await env.doc.redo();
    expect(env.registry.getNode('Asset/Box_1')).toBe(copy);
    expect(childNames(env.root)).toEqual(['Box', 'Other', 'Box_1']);
  });

  it('editor.clone with name + parentPath lands under that parent; a recorded line stores resolved args', async () => {
    await env.call('web_macro_record_start', { name: 'm' });
    const a = await env.exec('editor.clone', { path: 'Asset/Box', name: 'Copy', parentPath: 'Asset/Other' });
    expect(a).toMatchObject({ ok: true, created: ['Asset/Other/Copy'], recorded: true });
    const b = await env.exec('editor.clone', { path: 'Asset/Box' });
    expect(b).toMatchObject({ ok: true, created: ['Asset/Box_1'], recorded: true });
    await env.call('web_macro_record_stop', {});
    const lines = macroBookOf(env.doc.document).macros.get('m')!.steps as RvMacroCommandStep[];
    expect(lines[0].args).toEqual({ path: 'Asset/Box', name: 'Copy', parentPath: 'Asset/Other' });
    // Parent and base name made explicit: '' = the asset root.
    expect(lines[1].args).toEqual({ path: 'Asset/Box', name: 'Box', parentPath: '' });
    expect(lines[1].result.created).toEqual(['Asset/Box_1']);
  });

  it('editor.clone refuses a parent inside the copied subtree and an unknown source', async () => {
    expect(await env.exec('editor.clone', { path: 'Asset/Box', parentPath: 'Asset/Box/Body' }))
      .toMatchObject({ ok: false, status: 'failed' });
    expect(await env.exec('editor.clone', { path: 'Asset/Nope' })).toMatchObject({ ok: false, status: 'failed' });
  });

  it('editor.materialDefine creates a named PBR material on the meshes; undo restores', async () => {
    const r = await env.exec('editor.materialDefine', {
      name: 'Festo-Alu', color: '#C0C0C0', roughness: 0.3, metalness: 0.8, paths: 'Asset/Box',
    });
    expect(r).toMatchObject({ ok: true, status: 'ok', value: { material: 'Festo-Alu', paths: 1, color: '#c0c0c0' } });
    const body = env.root.getObjectByName('Body') as Mesh;
    const mat = body.material as MeshStandardMaterial;
    expect(mat.name).toBe('Festo-Alu');
    expect(mat.color.getHexString()).toBe('c0c0c0');
    expect(mat.roughness).toBeCloseTo(0.3, 5);
    expect(mat.metalness).toBeCloseTo(0.8, 5);
    await env.doc.undo();
    expect(((body.material as MeshStandardMaterial).color.getHex())).toBe(0x336699);
    // A bad colour is refused, not guessed.
    expect(await env.exec('editor.materialDefine', { name: 'X', color: 'grey', paths: 'Asset/Box' }))
      .toMatchObject({ ok: false, status: 'failed' });
  });

  it('editor.materialDefine paints material-array, `_`-named and comma-named meshes; undo restores the exact originals', async () => {
    const slotA = new MeshStandardMaterial({ color: 0x111111 });
    const slotB = new MeshStandardMaterial({ color: 0x222222 });
    const multi = new Mesh(new BoxGeometry(1, 1, 1), [slotA, slotB]);
    multi.name = 'Multi';
    multi.geometry.addGroup(0, 18, 0);
    multi.geometry.addGroup(18, 18, 1);
    const groupsBefore = multi.geometry.groups.map((g) => ({ ...g }));
    const originalArray = multi.material;
    const under = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0x333333 }));
    under.name = '_CADpart';
    const comma = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0x444444 }));
    comma.name = 'LINK,PLATE';
    for (const m of [multi, under, comma]) {
      env.root.add(m);
      env.registry.registerNode(NodeRegistry.computeNodePath(m), m);
    }
    const r = await env.exec('editor.materialDefine', {
      name: 'Red', color: '#ff0000', paths: JSON.stringify(['Asset/Multi', 'Asset/_CADpart', 'Asset/LINK,PLATE']),
    });
    expect(r).toMatchObject({ ok: true, status: 'ok', value: { material: 'Red', paths: 3, meshes: 3 } });
    // Every slot of the array is painted; the array (and with it the groups) survives.
    expect(Array.isArray(multi.material)).toBe(true);
    for (const m of multi.material as MeshStandardMaterial[]) expect(m.color.getHexString()).toBe('ff0000');
    expect(multi.geometry.groups).toEqual(groupsBefore);
    expect((under.material as MeshStandardMaterial).color.getHexString()).toBe('ff0000');
    expect((comma.material as MeshStandardMaterial).color.getHexString()).toBe('ff0000');

    await env.doc.undo();
    expect(multi.material).toBe(originalArray);
    expect((multi.material as MeshStandardMaterial[])[0]).toBe(slotA);
    expect((multi.material as MeshStandardMaterial[])[1]).toBe(slotB);
    expect((under.material as MeshStandardMaterial).color.getHex()).toBe(0x333333);
    expect((comma.material as MeshStandardMaterial).color.getHex()).toBe(0x444444);
  });

  it('editor.materialDefine fails when nothing is painted and reports what it skipped', async () => {
    const ops = env.doc.document.ops.length;
    const r = await env.exec('editor.materialDefine', { name: 'Red', color: '#ff0000', paths: 'Asset/Other,Asset/Nope' });
    expect(r).toMatchObject({ ok: false, status: 'failed' });
    expect(JSON.stringify(r)).toContain('No mesh was painted');
    expect(env.doc.document.ops.length).toBe(ops);
    // A partly paintable selection paints what it can and names the rest.
    const p = await env.exec('editor.materialDefine', { name: 'Red', color: '#ff0000', paths: 'Asset/Box,Asset/Nope' });
    expect(p).toMatchObject({
      ok: true, value: { paths: 1, meshes: 1, skipped: [{ path: 'Asset/Nope', reason: 'unresolved' }] },
    });
  });

  it('editor.reorder sets the sibling index; undo restores the order', async () => {
    expect(childNames(env.root)).toEqual(['Box', 'Other']);
    const r = await env.exec('editor.reorder', { path: 'Asset/Other', index: 0 });
    expect(r).toMatchObject({ ok: true, status: 'ok', value: { path: 'Asset/Other', index: 0, moved: true } });
    expect(childNames(env.root)).toEqual(['Other', 'Box']);
    // Already there → noop, no history entry.
    const ops = env.doc.document.ops.length;
    expect(await env.exec('editor.reorder', { path: 'Asset/Other', index: 0 })).toMatchObject({ ok: true, value: { moved: false } });
    expect(env.doc.document.ops.length).toBe(ops);
    await env.doc.undo();
    expect(childNames(env.root)).toEqual(['Box', 'Other']);
    expect(await env.exec('editor.reorder', { path: 'Asset/Other', index: -1 })).toMatchObject({ ok: false, status: 'failed' });
  });

  it('web_commands lists the three as macro commands without an alias tool', async () => {
    const r = await env.call('web_commands', { query: 'editor.' });
    const rows = (r['commands'] as Array<Record<string, unknown>>).filter((c) =>
      ['editor.clone', 'editor.materialDefine', 'editor.reorder'].includes(String(c['id'])));
    expect(rows.map((c) => c['id']).sort()).toEqual(['editor.clone', 'editor.materialDefine', 'editor.reorder']);
    for (const row of rows) {
      expect(row['macro']).toBe(true);
      expect(row['tool'] ?? null).toBeNull();
    }
  });
});

describe.runIf(!__RV_HAS_PRIVATE__)('plan-641 §9.6 — community edition', () => {
  it('clone / materialDefine / reorder answer requires-commercial', async () => {
    for (const [command, args] of [
      ['editor.clone', { path: 'Asset/Box' }],
      ['editor.materialDefine', { name: 'A', color: '#ffffff', paths: 'Asset/Box' }],
      ['editor.reorder', { path: 'Asset/Other', index: 0 }],
    ] as const) {
      expect(await env.exec(command, args)).toMatchObject({ ok: false, status: 'requires-commercial', kind: 'unavailable' });
    }
  });
});
