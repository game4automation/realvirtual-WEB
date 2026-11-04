// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2013 test 9.4 — activating a variant end to end (Phase 1 spike).
 *
 * Part 1 — a REAL DESRunner behind a viewer slice with the real `structuralEdit` semantics:
 *  a) variant `Interval = 4` → generations step by 4 s, exactly one reset; back to Base → 10 s;
 *  b) saving under the active variant → the GLB keeps the base value 10, the `Variants`
 *     block carries 4; a normal save (no opinion about variants) leaves the block untouched;
 *  d) an inspector edit of the variant in the scene (`updateOverlayField` through the variant
 *     edit target) is one apply with one reset and reaches the DES configuration; no
 *     optimistic overlay entry, and the inspector's live-edit gate is closed.
 *
 * Part 2 — a REAL RVViewer (DES mode) and a structural rebuild that places a library asset
 * with `viewer.structural.place()`:
 *  c) variant = structural field + a field on the placement `B` the rebuild creates → both
 *     applied, `B` carries the value, one reset and one `bound`; back to Base → `B` gone,
 *     no error, the field is "not in this configuration";
 *  e) round trip with save: a base overlay edit + the structural variant in the scene →
 *     save → reload with the preference on → base values incl. the overlay edit unchanged in
 *     the GLB, the structural field at base, the block carries both values; after the load
 *     the saved variant is in the scene again (`B` there, value set).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshStandardMaterial, Object3D } from 'three';

import '../../src/behaviors/Source';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { variantRunnerSetup } from './variant-runner-fixture';
import type { MaterialFlowAdapter } from '@rv/plugins/des/material-flow-adapter';
import { _resetDesHookCache } from '@rv/plugins/des/des-hook-adapter';
import { createBindContext, type BindContextHost } from '../../src/core/behavior-runtime';
import { createSelf, type MaterialFlowSelf } from '../../src/core/material-flow/material-flow-self';
import { defineMaterialFlow, type MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import { EventEmitter } from '../../src/core/rv-events';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { __resetDesRunSettingsForTest } from '../../src/core/hmi/des-run-settings-store';
import { createVariantsRuntime, type VariantsRuntime, type VariantsViewer } from '../../src/plugins/variants/variants-runtime';
import { VariantsPlugin } from '../../src/plugins/variants';
import { RvExtrasEditorPlugin } from '../../src/core/hmi/rv-extras-editor';
import { getActiveEditTarget, getActivePersistenceTarget } from '../../src/core/hmi/rv-edit-target';
import { isVariantInScene } from '../../src/core/hmi/rv-run-lease';
import { registerParamFieldResolver, registerParamRebuild } from '../../src/core/params/rv-param-apply';
import { registerParamApply } from '../../src/core/engine/rv-component-registry';
import { objectToGlb } from '../../src/core/import/rv-import-object';
import { parseGlbChunks } from '../../src/core/persistence/rv-glb-chunks';
import { bakeIntoGlb } from '../../src/core/hmi/scene/rv-scene-glb-bake';
import { materialise } from '../../src/core/hmi/scene/rv-scene-edits';
import { writeDocumentVariants } from '../../src/core/project/rv-document-variants-write';
import { revisionOfBytes } from '../../src/core/project/rv-scene-record';
import { docPathOf, type DocRef, type DocumentRecord, type ProjectBackend } from '../../src/core/project/backends/project-backend';
import { setNodeId } from '../../src/core/engine/rv-node-id';
import { registerAllBehaviors } from '../../src/core/behaviors';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';
import type { RVViewer } from '../../src/core/rv-viewer';
import { ensureActiveScope, setActiveProject, type ProjectManagerViewerLike } from '../../src/core/material-flow/rv-project-manager';
import { createProject, runScopeStore } from '../../src/core/material-flow/rv-run-history-store';

type Json = { nodes: Array<{ name?: string; extras?: { realvirtual?: Record<string, Record<string, unknown>> } }>; scenes: Array<{ extras?: { realvirtual?: Record<string, unknown> } }> };
const jsonOf = (bytes: Uint8Array): Json => parseGlbChunks(bytes).json as unknown as Json;
const nodeExtras = (j: Json, name: string) => j.nodes.find((n) => n.name === name)?.extras?.realvirtual ?? {};

/** A writable fake project backend over one byte array. */
function fakeBackend(initial: Uint8Array) {
  const state = { bytes: initial };
  const doc = { id: 'doc-1', path: 'scenes/Doc.glb', name: 'Doc' };
  const backend = {
    kind: 'folder', id: 'fake', writable: true, isActive: true,
    async readDocument(ref: DocRef): Promise<DocumentRecord | null> {
      return { bytes: state.bytes, revision: await revisionOfBytes(state.bytes), meta: { id: doc.id, name: doc.name, path: docPathOf(ref) } };
    },
    async readDocumentUrl() { return null; },
    async writeDocument(_ref: DocRef, written: Uint8Array) { state.bytes = written; return { revision: await revisionOfBytes(written) }; },
  } as unknown as ProjectBackend;
  return { state, write: async (payload: Record<string, unknown> | null) => { await writeDocumentVariants(backend, doc as never, payload); } };
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { localStorage.clear(); });

// ─── Part 1: real DESRunner ────────────────────────────────────────────────

describe('9.4 a/b/d — a variant with a real DES runner', () => {
  const runners: DESRunner[] = [];
  let rt: VariantsRuntime | null = null;
  beforeEach(() => { _resetDesHookCache(); __resetDesRunSettingsForTest(); });
  afterEach(() => { rt?.dispose(); rt = null; for (const r of runners.splice(0)) r.dispose(); __resetDesRunSettingsForTest(); });

  const setup = () => variantRunnerSetup(runners);

  it('a) Interval 4 → generations step by 4 with one reset; back to Base → 10', async () => {
    const s = await setup();
    rt = createVariantsRuntime({ viewer: () => s.viewer as unknown as VariantsViewer, documentLoadId: () => 'doc' });
    await rt.bindDocument({ userData: {} }, { applyActive: false });
    const id = (rt.create('Fast') as { id: string }).id;
    expect((await rt.store.set(id, { address: '#gen', component: 'VarTaktSource', field: 'Interval' }, 4)).ok).toBe(true);
    expect(s.viewer.resets).toBe(0);               // an inactive variant only changes the store
    expect((await rt.activate(id)).ok).toBe(true);
    expect(s.viewer.resets).toBe(1);
    expect(isVariantInScene()).toBe(true);
    expect(s.steps()).toEqual([4, 4]);
    expect((await rt.activate(null)).ok).toBe(true);
    expect(s.viewer.resets).toBe(2);
    expect(isVariantInScene()).toBe(false);
    expect((s.gen.userData.realvirtual as Record<string, Record<string, unknown>>).VarTaktSource.Interval).toBe(10);
    expect(s.steps()).toEqual([10, 10]);
  });

  // The experiment-column case ('holds live Play until scene identity, scope and RNG are
  // ready') resolves a commercial scope (column, pin, manifest) and lives in Private~
  // tests/des-experiments/variants/variant-activate-scope.test.ts since plan-2211; without the
  // experiment manager the variant switch needs no scope (tests/des/variants-without-backend).

  it('b) saving under the active variant keeps the base value in the GLB; the block carries the variant', async () => {
    const s = await setup();
    const docRoot = new Group(); docRoot.name = 'Doc';
    const g = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial()); g.name = 'Gen';
    g.userData.realvirtual = { VarTaktSource: { Interval: 10 } };
    docRoot.add(g);
    const source = new Uint8Array(await objectToGlb(docRoot));
    const fb = fakeBackend(source);
    rt = createVariantsRuntime({
      viewer: () => s.viewer as unknown as VariantsViewer,
      documentLoadId: () => 'doc',
      saveDocument: async () => {
        const payload = rt!.store.snapshot();
        await fb.write(payload);
        rt!.store.markSaved(payload);
        return { kind: 'saved', sceneId: 'doc-1' };
      },
    });
    await rt.bindDocument({ userData: {} }, { applyActive: false });
    const id = (rt.create('Fast') as { id: string }).id;
    await rt.store.set(id, { address: '#gen', component: 'VarTaktSource', field: 'Interval' }, 4);
    await rt.activate(id);
    expect((s.gen.userData.realvirtual as Record<string, Record<string, unknown>>).VarTaktSource.Interval).toBe(4);
    await rt.save();
    expect(rt.store.dirty).toBe(false);
    const j = jsonOf(fb.state.bytes);
    expect(nodeExtras(j, 'Gen').VarTaktSource.Interval).toBe(10);       // base, not the scene's 4
    const block = j.scenes[0].extras!.realvirtual!.Variants as { active: string; variants: Array<{ overrides: Array<{ value: unknown }> }> };
    expect(block.active).toBe(id);
    expect(block.variants[0].overrides[0].value).toBe(4);
    // A normal save that has no opinion about variants keeps the block deep-equal, BIN identical.
    const normal = await bakeIntoGlb(fb.state.bytes, materialise([]), { locate: () => null });
    expect(jsonOf(normal.glb).scenes[0].extras!.realvirtual!.Variants).toEqual(block);
    expect(normal.binChunkUnchanged).toBe(true);
  });

  it('d) an inspector edit of the variant in the scene is one apply with one reset and reaches DES', async () => {
    const s = await setup();
    rt = createVariantsRuntime({ viewer: () => s.viewer as unknown as VariantsViewer, documentLoadId: () => 'doc' });
    await rt.bindDocument({ userData: {} }, { applyActive: false });
    const id = (rt.create('Fast') as { id: string }).id;
    await rt.store.set(id, { address: '#gen', component: 'VarTaktSource', field: 'Interval' }, 4);
    await rt.activate(id);
    expect(getActivePersistenceTarget()).toBe('variant');   // the inspector's applyLiveEdit gate is closed
    const editor = new RvExtrasEditorPlugin();
    const notify = vi.fn();
    (editor as unknown as { subscribe?(fn: () => void): void }).subscribe?.(notify);
    expect(editor.updateOverlayField('Root/Gen', 'VarTaktSource', 'Interval', 6)).toBe(true);
    // No optimistic write: the value arrives only through the transaction.
    expect((editor as unknown as { _overlay: unknown })._overlay).toBeNull();
    await vi.waitFor(() => expect(rt!.store.variant(id)!.overrides[0].value).toBe(6));
    expect(s.viewer.resets).toBe(2);
    expect(s.steps()).toEqual([6, 6]);
    // A field that cannot vary is refused, nothing written.
    expect(editor.updateOverlayField('Root/Gen', 'VarTaktSource', 'Nope', 1)).toBe(false);
    expect(editor.lastRefusal).toMatch(/Shared field/);
    // The edit target is the variant's; Base again removes it.
    expect(getActiveEditTarget().persistsTo).toBe('variant');
    await rt.activate(null);
    expect(getActiveEditTarget().persistsTo).not.toBe('variant');
  });
});

// ─── Part 2: real viewer, real structural placement ────────────────────────

const PLACED = 'library/PalletHandling/PalletSink.glb';
const YARD_KEY = { address: '#nid-yard', component: 'VarYard', field: 'Size' };
const B_KEY = { address: '#nid-B', component: 'VarTaktSource', field: 'Interval' };

describe('9.4 c/e — structural variant on a real viewer', () => {
  let h: TestViewerHandle | null = null;
  const offs: Array<() => void> = [];
  afterEach(() => { for (const off of offs.splice(0)) off(); h?.dispose(); h = null; registerParamApply('VarYard', null); });

  function installYard(v: RVViewer) {
    registerParamApply('VarYard', 'rebuild');
    offs.push(registerParamFieldResolver('VarYard', (_c, f) => (f === 'Size' ? { type: 'integer' } : null)));
    offs.push(registerParamRebuild('VarYard', async (ops, ctx) => {
      const op = ops.find((o) => o.field === 'Size');
      const size = op && op.op === 'set' ? Number(op.value) : 0;
      const existing = v.registry!.getNodeByAddress('nid-B');
      if (size >= 1 && !existing) {
        await v.structural.place({
          parentPath: 'StructDoc/Placements', name: 'B', nodeId: 'nid-B',
          assetRef: { assetId: 'cat:PalletSink.glb', path: PLACED },
          position: [0, 0, 0], quaternion: [0, 0, 0, 1],
        } as never);
        await ctx.awaitPlacements();
      } else if (size < 1 && existing) {
        v.structural.removePlacement(existing);
      }
    }));
  }

  function docBytes(): Promise<ArrayBuffer> {
    const root = new Group(); root.name = 'StructDoc';
    const yard = new Object3D(); yard.name = 'Yard'; setNodeId(yard, 'nid-yard');
    yard.userData.realvirtual = { ...yard.userData.realvirtual, VarYard: { Size: 0, Label: 'base' } };
    const placements = new Object3D(); placements.name = 'Placements'; setNodeId(placements, 'nid-pl');
    root.add(yard, placements);
    return objectToGlb(root);
  }

  let modelUrl: string;
  async function load(bytes: ArrayBuffer | Uint8Array): Promise<RVViewer> {
    h ??= await createTestViewer('webgl');
    const v = h.viewer;
    v.loop.setPaused('plan-2013-9.4', true);
    registerAllBehaviors(v.behaviors);
    await v.loadModel(modelUrl, { data: bytes instanceof Uint8Array ? bytes.slice().buffer : bytes });
    await v.whenSceneReady();
    const q = vi.spyOn(console, 'info').mockImplementation(() => {});
    try { v.simulationKernel!.setMode('des'); } finally { q.mockRestore(); }
    return v;
  }

  // VarTaktSource must be a DES type so the field on B is admissible (des-extras).
  beforeEach(() => {
    // Experiment snapshots survive viewer disposal; each case owns its model identity.
    modelUrl = `struct-doc-${crypto.randomUUID()}.glb`;
    defineMaterialFlow<MaterialFlowSelf>({
      type: 'VarTaktSource', kind: 'source', continuous: {},
      schema: { Interval: { type: 'number', default: 10, unit: 's' } },
      des: { onGenerate() {} },
    });
  });

  it('c) structural field + field on the placement B: one reset, one bound; back to Base removes B', async () => {
    const v = await load(await docBytes());
    installYard(v);
    let resets = 0;
    let bounds = 0;
    offs.push(v.on('simulation-reset', () => { resets++; }));
    offs.push(v.simulationKernel!.onDesLifecycle!((e: { type: string }) => { if (e.type === 'bound') bounds++; }));
    const rt = createVariantsRuntime({ viewer: () => v as unknown as VariantsViewer, documentLoadId: () => 'doc' });
    offs.push(() => rt.dispose());
    await rt.bindDocument({ userData: {} }, { applyActive: false });
    const id = (rt.create('Big') as { id: string }).id;
    await rt.store.set(id, YARD_KEY, 1);
    await rt.store.set(id, B_KEY, 3);
    const r = await rt.activate(id);
    expect(r).toEqual({ ok: true, id });
    const b = v.registry!.getNodeByAddress('nid-B')!;
    expect(b, 'the rebuild placed B').toBeTruthy();
    expect(v.registry!.getAddressForNode(b)).toBe('#nid-B');
    expect(v.placements.instanceOf(b), 'B is a materialised placement').not.toBeNull();
    expect((b.userData.realvirtual as Record<string, Record<string, unknown>>).VarTaktSource.Interval).toBe(3);
    expect(resets).toBe(1);
    expect(bounds).toBe(1);
    expect(rt.store.isUnresolved(B_KEY)).toBe(false);

    const back = await rt.activate(null);
    expect(back.ok).toBe(true);
    expect(v.registry!.getNodeByAddress('nid-B')).toBeNull();
    expect(rt.store.isUnresolved(B_KEY)).toBe(true);      // "not in this configuration"
    expect(resets).toBe(2);
    expect(bounds).toBe(2);
  });

  it('e) round trip with save: base overlay edit kept, structural field at base, the variant back after reload', async () => {
    const source = new Uint8Array(await docBytes());
    let v = await load(source);
    installYard(v);
    const fb = fakeBackend(source);
    const rt = createVariantsRuntime({
      viewer: () => v as unknown as VariantsViewer,
      documentLoadId: () => 'doc',
      saveDocument: async () => {
        const payload = rt.store.snapshot();
        await fb.write(payload);
        rt.store.markSaved(payload);
        return { kind: 'saved', sceneId: 'doc-1' };
      },
    });
    offs.push(() => rt.dispose());
    await rt.bindDocument({ userData: {} }, { applyActive: false });
    const id = (rt.create('Big') as { id: string }).id;
    await rt.store.set(id, YARD_KEY, 1);
    await rt.store.set(id, B_KEY, 3);
    expect((await rt.activate(id)).ok).toBe(true);

    // Save = the variants block, then the normal document save with a base overlay edit
    // on another field (what the scene store's bake does: source bytes + op log).
    await rt.save();
    const yardIndex = jsonOf(fb.state.bytes).nodes.findIndex((n) => n.name === 'Yard');
    const saved = await bakeIntoGlb(fb.state.bytes, materialise([{
      id: 'op-1', ts: 1, schemaV: 1, kind: 'setField', nodePath: 'StructDoc/Yard', componentType: 'VarYard', fieldName: 'Label', value: 'edited', prev: 'base',
    } as never]), { locate: (p) => (p === 'StructDoc/Yard' ? { kind: 'root', index: yardIndex } : null) });
    const j = jsonOf(saved.glb);
    expect(nodeExtras(j, 'Yard').VarYard).toMatchObject({ Size: 0, Label: 'edited' });   // base + overlay edit
    expect(j.nodes.some((n) => n.name === 'B')).toBe(false);                             // B is never saved
    const block = j.scenes[0].extras!.realvirtual!.Variants as { active: string; variants: Array<{ overrides: Array<{ address: string; value: unknown }> }> };
    expect(block.active).toBe(id);
    expect(block.variants[0].overrides.map((o) => [o.address, o.value])).toEqual([['#nid-yard', 1], ['#nid-B', 3]]);

    // Reload with the preference on: the eager plugin binds and applies the saved variant.
    rt.dispose();
    localStorage.setItem('rv-variants-enabled', '1');
    const plugin = new VariantsPlugin();
    v.use(plugin);
    v = await load(saved.glb);
    const reloaded = await plugin.runtime();
    await vi.waitFor(() => expect(reloaded.store.sceneVariant).toBe(id), { timeout: 10_000 });
    const b = v.registry!.getNodeByAddress('nid-B')!;
    expect(b).toBeTruthy();
    expect((b.userData.realvirtual as Record<string, Record<string, unknown>>).VarTaktSource.Interval).toBe(3);
    const yard = v.registry!.getNodeByAddress('nid-yard')!;
    expect((yard.userData.realvirtual as Record<string, Record<string, unknown>>).VarYard).toMatchObject({ Size: 1, Label: 'edited' });
  });
});
