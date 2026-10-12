// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-753 §9.10 — editor continuity (F12).
 *
 * A placement is chunks + logic nodes; the asset editor must never see those.
 * Two guarantees:
 *   1. the baked asset is self-contained: everything it names — logic-node
 *      templates, keep meshes, pick windows — lives inside `baked.template`,
 *      and an instance adds nothing to it;
 *   2. the planner's selection→asset resolver answers with the LIBRARY document
 *      of the placement for the root AND for a logic node inside it — never
 *      with anything derived from the placement's scene subtree.
 * Plus: the bake-side naming scan is idempotent with the per-clone scan the
 * planner still runs (`applyKinematicsSpec` deep-merges).
 *
 * CHANGED by plan-754 Phase 1b (D9): guarantee 1 used to read "the ModelCache
 * keeps the decoded MASTER next to the baked form, so `getOrLoad` still hands
 * out the full source hierarchy". The destructive bake CONSUMES the decode, so
 * `baked.template` is the bake's own pruned graph and `getOrLoad` serves a
 * clone of it. What the editor gets instead — the child's own bytes as an
 * authoring load, plus `decodeFresh` as the cache-level door — is pinned in
 * `model-cache-editor-open.test.ts` (§9.21); the pruning itself in
 * `model-cache-pruned-master.test.ts` (§9.8). Kept here: the self-containment
 * of the asset, which is what the editor path actually depends on.
 */
import { describe, it, expect } from 'vitest';
import { Group, Mesh } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import '../src/core/engine/rv-scene-loader';
import { ModelCache, applyNamingScanToMaster } from '../src/plugins/layout-planner/model-cache';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { group, uberMesh, withComponent } from './fixtures/bake-fixture';
import { setupPlanner, GLB_ENTRY, GLB_URL, flush } from './_layout-planner-async-harness';
import type { LibraryCatalogEntry } from '../src/plugins/layout-planner/rv-layout-store';

const BLOB_URL = 'blob:rv-test/editor-continuity.glb';
const uber = new RVUberMaterial(false);

/** Conveyor: frame + Transport-Z (naming convention, no authored extras) + Drive. */
function makeAsset(): Group {
  const root = group('Conveyor');
  root.add(uberMesh(uber, 'frame'));
  const transport = group('Transport-Z');
  transport.add(uberMesh(uber, 'belt', [0, 0.5, 0]));
  root.add(transport);
  const drive = withComponent(group('Drive-Rot-Y'), 'Drive');
  drive.add(uberMesh(uber, 'roll', [1, 0, 0]));
  root.add(drive);
  return root;
}

function countMeshes(root: Group): number {
  let n = 0;
  root.traverse((o) => { if ((o as Mesh).isMesh) n++; });
  return n;
}

function fakeLoader(): GLTFLoader {
  return { loadAsync: async (): Promise<{ scene: Group }> => ({ scene: makeAsset() }) } as unknown as GLTFLoader;
}

describe('editor continuity (plan-753 §9.10)', () => {
  it('the baked asset is self-contained and an instance never touches it', async () => {
    const cache = new ModelCache(fakeLoader(), { uber: () => uber, pickPort: () => createPickBuildPort({ createWorker: () => null }) });
    const baked = await cache.getOrLoadBaked(BLOB_URL);
    expect(baked.chunks.length).toBeGreaterThan(0);
    // `getOrLoad` hands out a drawable clone of whatever the asset's template
    // is — the same shape, mesh for mesh, after a destructive bake as before.
    const clone = await cache.getOrLoad(BLOB_URL);
    expect(countMeshes(clone)).toBe(countMeshes(baked.template as Group));
    expect(clone.children.map((c) => c.name)).toEqual(baked.template.children.map((c) => c.name));
    // Every logic-node template lives INSIDE the asset's template graph — the
    // property the instantiate path rebuilds parent chains from.
    for (const l of baked.logicNodes) {
      let inTemplate = false;
      for (let n = l.template; n; n = n.parent!) { if (n === baked.template) { inTemplate = true; break; } }
      expect(inTemplate, l.path).toBe(true);
    }
    // Nothing of the placement ever enters the template: an instance under a
    // fresh root adds no node to it.
    const before = countMeshes(baked.template as Group);
    const reg = new BakeRegistry();
    const inst = reg.instantiate(baked, new Group());
    expect(countMeshes(baked.template as Group)).toBe(before);
    expect(inst.chunks.every((m) => !isUnder(m, baked.template))).toBe(true);
    reg.release(inst);
  });

  it('the bake-side naming scan is idempotent with the per-clone scan', async () => {
    const master = makeAsset();
    applyNamingScanToMaster(master);
    const transport = master.getObjectByName('Transport-Z')!;
    const first = JSON.stringify(transport.userData.realvirtual);
    expect(first).toContain('TransportSurface');
    applyNamingScanToMaster(master);
    expect(JSON.stringify(transport.userData.realvirtual)).toBe(first);
    // Same on a clone (what `registerPlaced` still does): no new keys.
    const clone = master.clone();
    applyNamingScanToMaster(clone);
    expect(JSON.stringify(clone.getObjectByName('Transport-Z')!.userData.realvirtual)).toBe(first);
  });

  it('the planner resolves root AND logic node of a placement to the LIBRARY document', async () => {
    const h = setupPlanner();
    const entry: LibraryCatalogEntry = { ...GLB_ENTRY, id: 'cat:lib-belt', localPath: 'Custom/Belt.glb' };
    h.plugin.store.addCatalogDirect('cat://lib', { version: '1.0', name: 'lib', entries: [entry] });
    const id = await h.plugin.placeComponent(entry, [0, 0, 0]);
    await flush();
    const root = (h.plugin as unknown as { _objectMap: Map<string, import('three').Object3D> })._objectMap.get(id)!;
    const registry = h.viewer.registry as NodeRegistry;
    const rootPath = registry.getPathForNode(root)!;
    const resolve = (p: string) => (h.plugin as unknown as { _resolveSelectionToAsset(p: string): { kind: string; path?: string } | null })
      ._resolveSelectionToAsset(p);
    const fromRoot = resolve(rootPath);
    expect(fromRoot).not.toBeNull();
    // The LIBRARY document (`libraryDocumentBase` prefixes the library folder)
    // — a file the editor decodes itself, never the placement's scene subtree.
    expect(fromRoot!.path).toContain('Custom/Belt.glb');
    expect(fromRoot!.kind).not.toBe('scene-node');
    // A registered node INSIDE the placement (chunk mesh or logic node) answers
    // the same — the editor opens the library file, never the placement subtree.
    let innerPath: string | null = null;
    root.traverse((n) => { if (!innerPath && n !== root) innerPath = registry.getPathForNode(n); });
    if (!innerPath) {
      const inner = root.children[0];
      innerPath = NodeRegistry.computeNodePath(inner);
      registry.registerNode(innerPath, inner);
    }
    expect(resolve(innerPath!)).toEqual(fromRoot);
    void GLB_URL;
    h.plugin.dispose?.();
  });
});

function isUnder(node: import('three').Object3D, root: import('three').Object3D): boolean {
  for (let n: import('three').Object3D | null = node; n; n = n.parent) if (n === root) return true;
  return false;
}
