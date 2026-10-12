// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * mu-preplaced.test.ts — plan-516 §9.2: classification, activation, gates.
 *
 * Every MU node of the main model that no Source references (neither as its
 * node nor as its resolved `ThisObjectAsMU` template, nor an ancestor of
 * either) is PRE-PLACED: visible, and simulated from sim start on. Source
 * templates, planner placements, a logic-gated load before its release, DES
 * mode and a multiuser client session keep today's behaviour.
 *
 * The loader half runs through the shipping `loadGLB()` on a GLB built with
 * GLTFExporter — the same extras a Unity export writes.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Object3D, Scene } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import { classifyPreplacedMUs } from '../src/core/engine/rv-scene-loader';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { RVViewer } from '../src/core/rv-viewer';
import { MultiuserPlugin } from '../src/plugins/multiuser-plugin';
import { RV_SIG_PLACEHOLDER } from '../src/core/persistence/rv-sig-verify';
import { parseGlbChunks, rebuildGlbWithJson, ensureDefaultSceneExtras } from '../src/core/persistence/rv-glb-chunks';
import { PALLET, PART, muNode, muOf } from './_mu-preplaced-fixture';

let warn: ReturnType<typeof vi.spyOn> | null = null;
afterEach(() => { warn?.mockRestore(); warn = null; });

/**
 * Source `Src` spawning the separate template `Template` (which has a child MU
 * `Inner`), a self-template Source `SelfSrc` carrying MU extras itself, and
 * two free MUs: `Pallet` with `Product` resting on it.
 */
function authoredScene(): Scene {
  const src = new Scene();
  const model = new Object3D();
  model.name = 'Cell';
  src.add(model);

  const source = new Object3D();
  source.name = 'Src';
  source.position.set(-3, 0, 0);
  source.userData.realvirtual = { Source: { ThisObjectAsMU: 'Template', Interval: 5 } };
  model.add(source);

  const template = muNode('Template', PART, [-3, 0, 2]);
  template.add(muNode('Inner', PART, [0, PART[1], 0]));
  model.add(template);

  const self = muNode('SelfSrc', PART, [-5, 0, 0]);
  (self.userData.realvirtual as Record<string, unknown>).Source = { ThisObjectAsMU: '', Interval: 5 };
  model.add(self);

  model.add(muNode('Pallet', PALLET, [2, 0, 0]));
  model.add(muNode('Product', PART, [2, PALLET[1], 0]));
  return src;
}

async function glbBytes(scene: Scene): Promise<ArrayBuffer> {
  return (await new GLTFExporter().parseAsync(scene, { binary: true })) as ArrayBuffer;
}

function withBrokenSignature(bytes: ArrayBuffer): ArrayBuffer {
  const chunks = parseGlbChunks(bytes);
  const extras = ensureDefaultSceneExtras(chunks.json as Record<string, unknown>);
  extras.rv_sig = RV_SIG_PLACEHOLDER;
  const out = rebuildGlbWithJson(chunks);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

function byName(root: Object3D, name: string): Object3D {
  const n = root.getObjectByName(name);
  if (!n) throw new Error(`node ${name} not found`);
  return n;
}

describe('pre-placed MU classification through loadGLB (plan-516 F1/F8)', () => {
  it('an unreferenced MU is visible, and after sim start it is in mus under its spawn parent', async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await loadGLB('preplaced.glb', new Scene(), { data: await glbBytes(authoredScene()) });
    const tm = result.transportManager;
    const pallet = byName(result.root, 'Pallet');
    const product = byName(result.root, 'Product');
    expect(pallet.visible).toBe(true);
    expect(product.visible).toBe(true);
    expect(tm.preplacedMUs.map((m) => m.node.name).sort()).toEqual(['Pallet', 'Product']);
    expect(tm.mus.length).toBe(0); // classified, not simulated yet

    expect(tm.activatePreplaced()).toBe(1);
    const palletMU = muOf(tm, pallet);
    expect(tm.mus).toEqual([palletMU]);
    // Spawn parent = the transform-neutral model root (the loader classifies
    // before the root joins the scene — same rule the Sources use).
    expect(pallet.parent).toBe(result.root);
    expect(muOf(tm, product).loadedOn).toBe(palletMU);
    expect(tm.activatePreplaced()).toBe(0); // idempotent — registered exactly once
    expect(tm.mus.length).toBe(1);
  });

  it('Source node, ThisObjectAsMU template and MUs below a template stay hidden templates', async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await loadGLB('preplaced.glb', new Scene(), { data: await glbBytes(authoredScene()) });
    const tm = result.transportManager;
    for (const name of ['Template', 'Inner', 'SelfSrc']) {
      const node = byName(result.root, name);
      expect(tm.isPreplacedNode(node), name).toBe(false);
    }
    expect(byName(result.root, 'Template').visible).toBe(false);
    expect(byName(result.root, 'SelfSrc').visible).toBe(false);
    expect(tm.sources.length).toBe(2);
  });

  it('an MU inside a planner placement is not classified (placements keep the template semantics)', () => {
    const root = new Object3D();
    const placement = new Object3D();
    placement.userData._layoutId = 'lay_1';
    const inside = muNode('Placed', PART);
    inside.visible = false;
    placement.add(inside);
    root.add(placement);
    const free = muNode('Free', PART, [1, 0, 0]);
    root.add(free);
    const tm = new RVTransportManager();
    const created = classifyPreplacedMUs(root, tm);
    expect(created.map((m) => m.node.name)).toEqual(['Free']);
    expect(inside.visible).toBe(false);
    // and a second classification registers nothing twice
    expect(classifyPreplacedMUs(root, tm)).toEqual([]);
    expect(tm.preplacedMUs.length).toBe(1);
  });

  it('logic gate: gated load keeps every MU hidden; the release classifies, shows and registers once', async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bytes = withBrokenSignature(await glbBytes(authoredScene()));
    const result = await loadGLB('gated.glb', new Scene(), { data: bytes });
    expect(result.logicGated).toBe(true);
    const tm = result.transportManager;
    const pallet = byName(result.root, 'Pallet');
    expect(pallet.visible).toBe(false);
    expect(tm.preplacedMUs.length).toBe(0);

    const fakeViewer = {
      logicRunState: 'gated',
      _signatureState: 'invalid',
      _signatureModelName: 'gated.glb',
      _signatureSignerOrganization: undefined,
      _loadGeneration: 1,
      _lastLoadResult: result,
      _deferredLogic: result.deferredLogic ? [result.deferredLogic] : [],
      _heldPlacementLogicRoots: [] as Object3D[],
      _kernel: null,
      transportManager: tm,
      _publishSignatureUiState: () => {},
      _attachLogicSystems: () => {},
      emit: () => {},
    };
    const activate = RVViewer.prototype.activateGatedLogic as unknown as (this: typeof fakeViewer) => Promise<boolean>;
    await expect(activate.call(fakeViewer)).resolves.toBe(true);

    expect(pallet.visible).toBe(true);
    expect(byName(result.root, 'Template').visible).toBe(false); // the source knows its template now
    expect(tm.preplacedMUs.map((m) => m.node.name).sort()).toEqual(['Pallet', 'Product']);
    expect(tm.mus).toEqual([muOf(tm, pallet)]);
    // A second release attempt and a repeated classification change nothing.
    await expect(activate.call(fakeViewer)).resolves.toBe(false);
    classifyPreplacedMUs(result.root, tm);
    expect(tm.preplacedMUs.length).toBe(2);
    expect(tm.mus.length).toBe(1);
    localStorage.clear();
  });

  it('multiuser client session: visible, not registered (activation blocked, active ones put back)', () => {
    const root = new Object3D();
    const pallet = muNode('Pallet', PALLET);
    root.add(pallet);
    const scene = new Scene();
    scene.add(root);
    const tm = new RVTransportManager();
    classifyPreplacedMUs(root, tm);
    tm.activatePreplaced();
    expect(tm.mus.length).toBe(1);

    const plugin = new MultiuserPlugin();
    (plugin as unknown as { viewer: unknown }).viewer = { transportManager: tm, simulationKernel: null, registry: null, scene, emit: () => {} };
    (plugin as unknown as { _applyMUSync(m: unknown[]): void })._applyMUSync([]);
    expect(tm.mus.length).toBe(0);
    expect(tm.preplacedActivationBlocked).toBe(true);
    expect(pallet.visible).toBe(true);
    expect(pallet.parent).toBe(root);
    expect(tm.activatePreplaced()).toBe(0);
    tm.update(1 / 60);
    expect(pallet.parent).toBe(root); // not removed by the sync's removal pass

    plugin.leaveSession();
    expect(tm.preplacedActivationBlocked).toBe(false);
  });

  it('a non-uniformly scaled ancestor: not registered, one warning', () => {
    const root = new Object3D();
    const stretched = new Object3D();
    stretched.scale.set(1, 2, 1);
    stretched.rotation.y = 0.3;
    const mu = muNode('Stretched', PART);
    stretched.add(mu);
    root.add(stretched);
    const tm = new RVTransportManager();
    classifyPreplacedMUs(root, tm);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tm.activatePreplaced();
    expect(tm.mus.length).toBe(0);
    expect(mu.parent).toBe(stretched);
    expect(mu.visible).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    tm.restorePreplaced(true);
    expect(warn).toHaveBeenCalledTimes(1); // warned once
  });
});
