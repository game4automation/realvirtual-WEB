// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2013 test 9.3 (browser half) — opt-in (T1, UI-Review U1), Phase 1 spike without UI:
 *
 *  - preference off + document without a block → the runtime chunk is never evaluated;
 *  - preference off + document WITH a `Variants` block (active "Fast") → runtime not loaded,
 *    scene in Base, the plugin only notes "this document contains variants", a save keeps
 *    the block deep-equal; the same for a `PlanningScenarios` block;
 *  - switching on stores only the preference: nothing dirty, the saved `active` applies at
 *    the next load, not before;
 *  - creating a variant switches the preference on; first variant + save → block there; last
 *    one deleted + save → `extras.realvirtual` deep-equal to the original, BIN byte-equal;
 *  - switching off with a variant in the scene goes back to Base first.
 *
 * NOTE: this file must not import `variants-runtime` statically (the flag below proves it).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import '../../src/behaviors/Source';
import { VariantsPlugin } from '../../src/plugins/variants';
import { objectToGlb } from '../../src/core/import/rv-import-object';
import { parseGlbChunks } from '../../src/core/persistence/rv-glb-chunks';
import { bakeIntoGlb } from '../../src/core/hmi/scene/rv-scene-glb-bake';
import { materialise } from '../../src/core/hmi/scene/rv-scene-edits';
import { writeDocumentVariants } from '../../src/core/project/rv-document-variants-write';
import { revisionOfBytes } from '../../src/core/project/rv-scene-record';
import { getVariantsSavePayload, isVariantsDirty } from '../../src/core/hmi/rv-run-lease';
import { UIPluginRegistry } from '../../src/core/rv-ui-registry';
import { rememberVariantMode, variantModeOf } from '../../src/core/hmi/rv-variant-ui-mode';
import { docPathOf, type DocRef, type DocumentRecord, type ProjectBackend } from '../../src/core/project/backends/project-backend';
import type { RVViewer } from '../../src/core/rv-viewer';

const loaded = (): boolean => (globalThis as { __rvVariantsRuntimeLoaded?: boolean }).__rvVariantsRuntimeLoaded === true;

/** A document GLB: one Source node `Src` with Interval 10, optional scene-extras block (written by the bake). */
async function docBytes(sceneExtras?: { Variants?: Record<string, unknown>; PlanningScenarios?: Record<string, unknown> }): Promise<Uint8Array> {
  const root = new Group(); root.name = 'Doc';
  const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial()); m.name = 'Src';
  m.userData.realvirtual = { Source: { Interval: 10 } };
  root.add(m);
  const plain = new Uint8Array(await objectToGlb(root));
  if (!sceneExtras) return plain;
  const baked = await bakeIntoGlb(plain, materialise([]), { locate: () => null }, {
    ...(sceneExtras.Variants ? { variants: sceneExtras.Variants } : {}),
    ...(sceneExtras.PlanningScenarios ? { planningScenarios: sceneExtras.PlanningScenarios as never } : {}),
  });
  return baked.glb;
}

type Json = { scenes: Array<{ extras?: { realvirtual?: Record<string, unknown> } }> };
const sceneRv = (bytes: Uint8Array) => (parseGlbChunks(bytes).json as unknown as Json).scenes[0].extras?.realvirtual;

/** Loads `bytes` like the viewer: GLTFLoader → root with the scene extras, nodes by address. */
async function loadInto(bytes: Uint8Array) {
  const gltf = await new GLTFLoader().parseAsync(bytes.slice().buffer, '');
  const root = gltf.scene as unknown as Object3D;
  let src: Object3D | null = null;
  root.traverse((n) => { if (n.name === 'Src') src = n; });
  return { root, src: src! };
}

function fakeViewer(scene: { src: Object3D }) {
  let depth = 0;
  let owed = false;
  const v = {
    isSimulationPaused: false, resets: 0,
    setSimulationPaused() {},
    resetSimulation() { if (depth > 0) { owed = true; return; } v.resets++; },
    async structuralEdit<T>(fn: () => Promise<T> | T): Promise<T> {
      depth++;
      try { return await fn(); } finally { depth--; if (depth === 0 && owed) { owed = false; v.resetSimulation(); } }
    },
    simulationKernel: null,
    registry: {
      getNodeByAddress: (id: string, occ = '') => (`${occ}#${id}` === '#src' ? scene.src : null),
      getNode: () => scene.src,
      getAddressForNode: () => '#src',
    },
    whenSceneReady: () => Promise.resolve(),
    getPlugin: () => undefined,
  };
  return v;
}

const intervalOf = (n: Object3D) => (n.userData.realvirtual as Record<string, Record<string, unknown>>).Source.Interval;

const FAST_BLOCK = {
  Variants: {
    version: 1, active: 'v_fast',
    variants: [{ id: 'v_fast', name: 'Fast', revision: 1, overrides: [{ address: '#src', component: 'Source', field: 'Interval', value: 4 }] }],
  },
};

/** The fake viewer has no model url, so every document shares this key. */
const DOC_KEY = '(no document)';
/** Concept D: a document WITH variants is auto-ON — an explicit OFF is what these tests set. */
const modeOff = () => rememberVariantMode(DOC_KEY, false, true);

let plugin: VariantsPlugin;
beforeEach(() => { localStorage.clear(); plugin = new VariantsPlugin(); });
afterEach(() => { plugin.dispose(); localStorage.clear(); });

describe('9.3 opt-in — mode off', () => {
  it('a document without a block: no runtime, nothing loaded', async () => {
    const scene = await loadInto(await docBytes());
    const v = fakeViewer(scene);
    plugin.init(v as unknown as RVViewer);
    plugin.onModelLoaded({ root: scene.root }, v as unknown as RVViewer);
    await new Promise((r) => setTimeout(r, 20));
    expect(plugin.runtimeLoaded).toBe(false);
    expect(loaded()).toBe(false);
    expect(plugin.documentHasVariants).toBe(false);
  });

  for (const [label, extras] of [
    ['Variants', FAST_BLOCK],
    ['PlanningScenarios', { PlanningScenarios: { version: 1, active: 'Hoch', scenarios: { Basis: {}, Hoch: {} } } }],
  ] as const) {
    it(`a document WITH a ${label} block: no runtime, Base in the scene, the block survives a save deep-equal`, async () => {
      modeOff();
      const bytes = await docBytes(extras as Record<string, unknown>);
      const scene = await loadInto(bytes);
      const v = fakeViewer(scene);
      plugin.init(v as unknown as RVViewer);
      plugin.onModelLoaded({ root: scene.root }, v as unknown as RVViewer);
      await new Promise((r) => setTimeout(r, 20));
      expect(plugin.runtimeLoaded).toBe(false);
      expect(loaded()).toBe(false);
      expect(plugin.documentHasVariants).toBe(true);
      expect(intervalOf(scene.src)).toBe(10);
      expect(v.resets).toBe(0);
      const saved = await bakeIntoGlb(bytes, materialise([]), { locate: () => null });
      expect(sceneRv(saved.glb)).toEqual(sceneRv(bytes));
      expect(saved.binChunkUnchanged).toBe(true);
    });
  }
});

describe('9.3 opt-in — switching on, creating, deleting', () => {
  it('switching on stores only the mode; the saved active applies at the next load', async () => {
    modeOff();
    const bytes = await docBytes(FAST_BLOCK);
    const scene = await loadInto(bytes);
    const v = fakeViewer(scene);
    plugin.init(v as unknown as RVViewer);
    plugin.onModelLoaded({ root: scene.root }, v as unknown as RVViewer);
    await plugin.setEnabled(true);
    expect(plugin.enabled).toBe(true);
    expect(variantModeOf(DOC_KEY, true)).toBe(true);
    const rt = await plugin.runtime();
    expect(rt.store.dirty).toBe(false);
    expect(rt.store.sceneVariant).toBeNull();
    expect(intervalOf(scene.src)).toBe(10);       // not mid-session
    expect(v.resets).toBe(0);

    // The next load (same file) applies the saved variant.
    const scene2 = await loadInto(bytes);
    const v2 = fakeViewer(scene2);
    plugin.onModelLoaded({ root: scene2.root }, v2 as unknown as RVViewer);
    await vi_waitFor(() => rt.store.sceneVariant === 'v_fast');
    expect(intervalOf(scene2.src)).toBe(4);
    expect(v2.resets).toBe(1);
  });

  it('create switches the preference on; first variant + save → block; last deleted + save → original extras, BIN equal', async () => {
    const original = await docBytes();
    let bytes = original;
    const doc = { id: 'doc-1', path: 'scenes/Doc.glb', name: 'Doc' };
    const backend = {
      kind: 'folder', id: 'fake', writable: true, isActive: true,
      async readDocument(ref: DocRef): Promise<DocumentRecord | null> {
        return { bytes, revision: await revisionOfBytes(bytes), meta: { id: doc.id, name: doc.name, path: docPathOf(ref) } };
      },
      async readDocumentUrl() { return null; },
      async writeDocument(_ref: DocRef, written: Uint8Array) { bytes = written; return { revision: await revisionOfBytes(written) }; },
    } as unknown as ProjectBackend;
    const scene = await loadInto(original);
    const v = fakeViewer(scene);
    plugin.init(v as unknown as RVViewer);
    plugin.onModelLoaded({ root: scene.root }, v as unknown as RVViewer);
    expect(plugin.enabled).toBe(false);
    const rt = await plugin.runtime();
    await rt.bindDocument(scene.root, { applyActive: false });
    const r = rt.create('Fast');
    expect(r.ok).toBe(true);
    expect(plugin.enabled).toBe(true);            // T1: creating the first variant switches on
    const id = (r as { id: string }).id;
    await rt.store.set(id, { address: '#src', component: 'Source', field: 'Interval' }, 4);
    const write = async () => { await writeDocumentVariants(backend, doc as never, (await import('../../src/core/variants/rv-variant-model')).serializeVariantsBlock(rt.store.block)); };
    await write();
    expect((sceneRv(bytes)?.Variants as { variants: unknown[] }).variants).toHaveLength(1);
    await rt.store.remove(id);
    await write();
    // Deep-equal to what any save of the untouched original writes (the bake stamps its own keys).
    const reference = await bakeIntoGlb(original, materialise([]), { locate: () => null });
    expect(sceneRv(bytes)).toEqual(sceneRv(reference.glb));
    expect(sceneRv(bytes)?.Variants).toBeUndefined();
    const binOf = (b: Uint8Array) => { const c = parseGlbChunks(b); return c.bytes.slice(c.restOffset); };
    expect(binOf(bytes)).toEqual(binOf(original));
  });

  it('switching off returns to Base and fully unbinds; re-enabling binds and registers UI again', async () => {
    const scene = await loadInto(await docBytes(FAST_BLOCK));
    const v = fakeViewer(scene);
    const uiRegistry = new UIPluginRegistry();
    Object.assign(v, { uiRegistry, getPlugin: (id: string) => id === 'variants' ? plugin : undefined });
    plugin.init(v as unknown as RVViewer);
    plugin.onModelLoaded({ root: scene.root }, v as unknown as RVViewer);
    const rt = await plugin.runtime();
    await vi_waitFor(() => rt.store.sceneVariant === 'v_fast');
    expect(intervalOf(scene.src)).toBe(4);
    await plugin.setEnabled(false);
    expect(intervalOf(scene.src)).toBe(10);
    expect(plugin.enabled).toBe(false);
    expect(rt.bound).toBe(false);
    expect(rt.store.block.variants).toHaveLength(0);
    expect(getVariantsSavePayload()).toBeUndefined();
    expect(isVariantsDirty()).toBe(false);
    expect(uiRegistry.getSlotComponents('toolbar-button-leading')).toHaveLength(0);
    expect(variantModeOf(DOC_KEY, true)).toBe(false);   // the OFF decision survives a reload

    await plugin.setEnabled(true);
    expect(rt.bound).toBe(true);
    expect(rt.store.block.variants).toHaveLength(1);
    expect(uiRegistry.getSlotComponents('toolbar-button-leading')).toHaveLength(1);
  });

  it('a document WITH variants is auto-ON: the runtime loads, applies the active variant and shows the toolbar switcher', async () => {
    const scene = await loadInto(await docBytes(FAST_BLOCK));
    const v = fakeViewer(scene);
    const uiRegistry = new UIPluginRegistry();
    Object.assign(v, { uiRegistry, getPlugin: (id: string) => id === 'variants' ? plugin : undefined });
    plugin.init(v as unknown as RVViewer);
    plugin.onModelLoaded({ root: scene.root }, v as unknown as RVViewer);
    expect(plugin.enabled).toBe(true);     // nobody had to find the switch
    const rt = await plugin.runtime();
    await vi_waitFor(() => rt.store.sceneVariant === 'v_fast');
    expect(intervalOf(scene.src)).toBe(4);
    expect(v.resets).toBe(1);
    expect(uiRegistry.getSlotComponents('toolbar-button-leading')).toHaveLength(1);
  });

  it('refuses switching off while variants are dirty', async () => {
    const scene = await loadInto(await docBytes(FAST_BLOCK));
    const v = fakeViewer(scene);
    plugin.init(v as unknown as RVViewer);
    plugin.onModelLoaded({ root: scene.root }, v as unknown as RVViewer);
    const rt = await plugin.runtime();
    await vi_waitFor(() => rt.store.sceneVariant === 'v_fast');
    rt.store.rename('v_fast', 'Faster');

    await expect(plugin.setEnabled(false)).rejects.toThrow('Save or discard variant changes first');
    expect(plugin.enabled).toBe(true);
    expect(rt.bound).toBe(true);
    expect(getVariantsSavePayload()).toBeDefined();
  });
});

async function vi_waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 5));
  }
}
