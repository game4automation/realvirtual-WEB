// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// The plugin/viewer side of the bundled-demo trust rule (rv-script-trust.ts): only a
// buffer the fetch boundary tokened with its final same-origin demo-folder URL opens
// the gate. Caller-supplied strings, plain `data`, edited scenes and later loads do not;
// ?scripts (allowScripts) is unchanged.

import { afterEach, expect, it, vi } from 'vitest';
import { Group, Object3D } from 'three';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { WebComponentPlugin } from '../src/plugins/web-component-plugin';
import { bundledDemoScriptTrust, fetchedUrlOf, readTrackedBody } from '../src/core/engine/rv-script-trust';
import { resetSidecarProbeCache } from '../src/core/engine/rv-scene-loader';
import { makeDraftScene } from '../src/core/hmi/scene/rv-scene-types';
import type { RVViewerPlugin } from '../src/core/rv-plugin';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';
import type { RvScenePrimitiveOp } from '../src/core/ops/rv-unified-ops';

/** A small GLB that really is in the bundled demo folder. */
const DEMO_URL = '/demo-realvirtual/Test-DES-Turntable-Loop.glb';
const CODE = `function setup(self) { self.statValue('Demo', 1); return {}; }`;
const WEB_COMPONENT = { Active: true, ApiVersion: 1, Language: 'js', TypeId: 'TrustTest', Code: CODE };

let handle: TestViewerHandle | null = null;
afterEach(() => { handle?.dispose(); handle = null; vi.restoreAllMocks(); resetSidecarProbeCache(); });

async function scriptedGlb(): Promise<ArrayBuffer> {
  const root = new Group(); root.name = 'TrustAsset';
  const node = new Object3D(); node.name = 'Monitor';
  node.userData.realvirtual = { WebComponent: { ...WEB_COMPONENT } };
  root.add(node);
  return objectToGlb(root);
}

/** Fresh tracked bytes of the real demo file, read the way the fetch boundary reads them. */
async function trackedDemoBytes(): Promise<ArrayBuffer> {
  const buf = await readTrackedBody(await fetch(DEMO_URL));
  expect(fetchedUrlOf(buf)).toBe(new URL(DEMO_URL, location.href).href);
  return buf;
}

/** Puts a script node under the loaded root BEFORE the web-component plugin wires (registered first). */
const injector: RVViewerPlugin = {
  id: 'test-script-injector',
  onModelLoaded(result: LoadResult) {
    const node = new Object3D(); node.name = 'InjectedMonitor';
    node.userData.realvirtual = { WebComponent: { ...WEB_COMPONENT } };
    result.root.add(node);
  },
};

async function viewerWith(allowScripts: boolean, inject = false): Promise<{ plugin: WebComponentPlugin; logs: () => string }> {
  handle = await createTestViewer('webgl', { desRunner: false });
  if (inject) handle.viewer.use(injector);
  const plugin = new WebComponentPlugin({ allowScripts });
  handle.viewer.use(plugin);
  const info = vi.spyOn(console, 'info');
  return { plugin, logs: () => info.mock.calls.map(c => String(c[0])).filter(s => s.includes('[web-component]')).join('\n') };
}

const trustOf = () => bundledDemoScriptTrust(handle!.viewer.currentModelSource ?? null);

it('runs the scripts of a tokened bundled demo document without ?scripts and says so', async () => {
  const { plugin, logs } = await viewerWith(false, true);
  await handle!.viewer.loadModel(DEMO_URL, { data: await trackedDemoBytes() });
  await plugin.whenWired();
  expect(trustOf()).toEqual({ trusted: true, reason: 'bundled demo project' });
  expect(plugin.instances.map(i => i.nodePath).some(p => p.endsWith('InjectedMonitor'))).toBe(true);
  expect(logs()).toContain('execution enabled: bundled demo project');
}, 90_000);

it('a caller cannot forge provenance: same URL string, plain data, other origin all stay gated', async () => {
  for (const [url, extra] of [
    // The pre-review hole: a caller-supplied source string is no longer an option at all.
    ['/demo-realvirtual/TrustAsset.glb', { fetchedFrom: '/demo-realvirtual/TrustAsset.glb' }],
    ['/demo-realvirtual/TrustAsset.glb', {}],
    ['https://evil.example/demo-realvirtual/TrustAsset.glb', {}],
  ] as Array<[string, Record<string, unknown>]>) {
    const { plugin, logs } = await viewerWith(false);
    await handle!.viewer.loadModel(url, { data: await scriptedGlb(), ...extra } as never);
    await plugin.whenWired();
    expect(plugin.instances, url).toHaveLength(0);
    expect(logs()).toContain('execution disabled (trust gate, plan-210 §10; bytes not read from a deploy URL)');
    handle?.dispose(); handle = null;
  }
}, 90_000);

it('trust never leaks to a later load — a copy of the same bytes, a failed load', async () => {
  await viewerWith(false);
  const v = handle!.viewer;
  await v.loadModel(DEMO_URL, { data: await trackedDemoBytes() });
  expect(trustOf().trusted).toBe(true);
  // The same bytes copied into a new buffer carry no token.
  const copy = (await trackedDemoBytes()).slice(0);
  await v.loadModel(DEMO_URL, { data: copy });
  expect(v.currentModelSource?.sourceUrl).toBeNull();
  expect(trustOf().trusted).toBe(false);
  // Trusted again, then a load that fails: the failed load leaves no trusted source behind.
  await v.loadModel(DEMO_URL, { data: await trackedDemoBytes() });
  expect(trustOf().trusted).toBe(true);
  await expect(v.loadModel('broken.glb', { data: new ArrayBuffer(16) })).rejects.toBeTruthy();
  expect(trustOf().trusted).toBe(false);
}, 90_000);

it('an edited scene is a modified document: an added placement via loadScene, editedScene via loadModel', async () => {
  await viewerWith(false);
  const v = handle!.viewer;
  await v.loadModel(DEMO_URL, { data: await trackedDemoBytes(), editedScene: true });
  expect(trustOf()).toEqual({ trusted: false, reason: 'modified document' });
  const scene = makeDraftScene({ kind: 'builtin', url: DEMO_URL, label: 'Demo' }, 'Demo');
  const T0: [number, number, number] = [0, 0, 0];
  scene.edits.ops = [{
    id: 'op_trust_1', ts: Date.now(), schemaV: 1, kind: 'addPlacement',
    placement: { id: 'plc-added', catalogId: 'cat:x', glbUrl: 'x.glb', label: 'X', position: T0, rotation: T0, scale: [1, 1, 1] },
  } as unknown as RvScenePrimitiveOp];
  await v.loadScene(scene, undefined, { data: await trackedDemoBytes() }).catch(() => { /* planner absent: the op may refuse */ });
  expect(v.currentModelSource?.hasPlacementEdits).toBe(true);
  expect(trustOf().trusted).toBe(false);
}, 90_000);

it('?scripts (allowScripts) still runs any document', async () => {
  const { plugin, logs } = await viewerWith(true);
  await handle!.viewer.loadModel('dropped.glb', { data: await scriptedGlb() });
  await plugin.whenWired();
  expect(plugin.instances).toHaveLength(1);
  expect(logs()).not.toContain('execution disabled');
}, 90_000);

it('a URL load without data is trusted from the loader fetch, and reloadModel keeps it', async () => {
  const { plugin, logs } = await viewerWith(false, true);
  const v = handle!.viewer;
  await v.loadModel(DEMO_URL);
  await plugin.whenWired();
  expect(v.currentModelSource?.sourceUrl).toBe(new URL(DEMO_URL, location.href).href);
  expect(trustOf()).toEqual({ trusted: true, reason: 'bundled demo project' });
  expect(plugin.instances.map(i => i.nodePath).some(p => p.endsWith('InjectedMonitor'))).toBe(true);
  expect(logs()).toContain('execution enabled: bundled demo project');
  // The source facts are frozen: a consumer cannot rewrite what the rule reads.
  expect(Object.isFrozen(v.currentModelSource)).toBe(true);
  await v.reloadModel();
  await plugin.whenWired();
  expect(trustOf()).toEqual({ trusted: true, reason: 'bundled demo project' });
  expect(plugin.instances.map(i => i.nodePath).some(p => p.endsWith('InjectedMonitor'))).toBe(true);
}, 90_000);

it('a .kin.json sidecar that adds a WebComponent makes the demo a modified document', async () => {
  await viewerWith(false);
  const v = handle!.viewer;
  // The root node name of the demo file, as the sidecar addresses it.
  await v.loadModel(DEMO_URL);
  expect(trustOf().trusted).toBe(true);
  const rootName = v.currentModelRoot!.name;
  expect(rootName).toBeTruthy();
  const realFetch = globalThis.fetch.bind(globalThis);
  const sidecar = (spec: unknown) => vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (/Test-DES-Turntable-Loop\.kin\.json/.test(u)) {
      return new Response(JSON.stringify(spec), { headers: { 'content-type': 'application/json' } });
    }
    return realFetch(input, init);
  });
  // A sidecar whose targets match nothing changes nothing: trust stays.
  resetSidecarProbeCache();
  const noop = sidecar({ behaviors: [{ target: 'NoSuchNode_xyz', type: 'WebComponent', props: { ...WEB_COMPONENT } }] });
  await v.loadModel(DEMO_URL);
  expect(v.currentModelSource?.hasSidecar).toBe(false);
  expect(trustOf().trusted).toBe(true);
  noop.mockRestore();
  // A sidecar that adds a WebComponent to the document's own node revokes it.
  resetSidecarProbeCache();
  sidecar({ behaviors: [{ target: rootName, type: 'WebComponent', props: { ...WEB_COMPONENT } }] });
  await v.loadModel(DEMO_URL);
  expect(v.currentModelSource?.hasSidecar).toBe(true);
  expect(trustOf()).toEqual({ trusted: false, reason: 'modified document' });
}, 90_000);

it('a polluting sidecar (type __proto__) cannot plant a WebComponent into a later trusted demo load', async () => {
  const { plugin } = await viewerWith(false);
  const v = handle!.viewer;
  await v.loadModel(DEMO_URL);
  const rootName = v.currentModelRoot!.name;
  const realFetch = globalThis.fetch.bind(globalThis);
  const payload = `{"behaviors":[{"target":${JSON.stringify(rootName)},"type":"__proto__","props":{"WebComponent":`
    + `{"Active":true,"Code":"function setup(self) { self.statValue('Pwned', 1); return {}; }"}}}]}`;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (u.includes('Test-DES-Turntable-Loop.kin.json')) {
      return new Response(payload, { headers: { 'content-type': 'application/json' } });
    }
    return realFetch(input, init);
  });
  try {
    resetSidecarProbeCache();
    await v.loadModel(DEMO_URL);
    await plugin.whenWired();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'WebComponent')).toBe(false);
    spy.mockRestore();
    // The next, trusted load of the demo: no inherited WebComponent appears.
    resetSidecarProbeCache();
    await v.loadModel(DEMO_URL);
    await plugin.whenWired();
    expect(trustOf().trusted).toBe(true);
    expect(plugin.instances).toHaveLength(0);
    expect(({} as Record<string, unknown>).WebComponent).toBeUndefined();
  } finally {
    delete (Object.prototype as unknown as Record<string, unknown>).WebComponent;
  }
}, 90_000);
