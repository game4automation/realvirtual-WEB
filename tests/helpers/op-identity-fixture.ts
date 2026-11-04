// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 Phase 2 — an asset-editor fixture for the op identity tests (9.8, 9.21):
 * real GLB bytes through `loadGLB` with `preserveHierarchy` (the editor's load, no
 * bake), so every node carries its decode identity, and a renderer-free viewer an
 * `AssetDocument` can author on (pattern of `editor-save-authored-names.test.ts`).
 *
 *  Cell
 *   ├─ Pusher
 *   ├─ Sep / Pusher (loads as Pusher_1) / MC ;  Sep / Holder  RefHolder.Out → "Sep/Pusher/MC"
 *   ├─ Cylinder
 *   ├─ Islands                    two-island mesh (separate)
 *   └─ Asm / M1 (red), M2 (blue)  two materials (merge)
 */
import { BufferAttribute, BufferGeometry, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { RVViewer } from '../../src/core/rv-viewer';
import type { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { loadGLB } from '../../src/core/engine/rv-scene-loader';
import { identityIdOf } from '../../src/core/engine/rv-decode-identity';
import type { AssetDocument } from '../../src/core/editor/rv-asset-document';
import { scratchAssetDocument } from './scratch-asset-document';

export function child(parent: Object3D, name: string, extras?: Record<string, unknown>): Object3D {
  const n = new Object3D();
  n.name = name;
  if (extras) n.userData.realvirtual = extras;
  parent.add(n);
  return n;
}

/** Two disjoint triangles — two islands. */
export function twoIslands(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    10, 0, 0, 11, 0, 0, 10, 1, 0,
  ]), 3));
  g.setIndex([0, 1, 2, 3, 4, 5]);
  return g;
}

/** One triangle at `offset` (distinct geometries: GLTFExporter merges identical meshes). */
export function tri(offset: number): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([
    offset, 0, 0, offset + 1, 0, 0, offset, 1, 0,
  ]), 3));
  g.setIndex([0, 1, 2]);
  return g;
}

export interface OpIdentityFixture {
  viewer: RVViewer;
  registry: NodeRegistry;
  root: Object3D;
  doc: AssetDocument;
}

/** Load the fixture as the asset editor does and open a scratch document on it. */
export async function loadOpIdentityFixture(): Promise<OpIdentityFixture> {
  const src = new Scene();
  src.name = 'Cell';
  child(src, 'Pusher');
  const sep = child(src, 'Sep');
  child(child(sep, 'Pusher'), 'MC');
  child(sep, 'Holder', { RefHolder: { Out: { type: 'ComponentReference', path: 'Sep/Pusher/MC', componentType: '' } } });
  child(src, 'Cylinder');
  const islands = new Mesh(twoIslands(), new MeshStandardMaterial({ color: 0x808080 }));
  islands.name = 'Islands';
  src.add(islands);
  const asm = child(src, 'Asm');
  const m1 = new Mesh(tri(0), new MeshStandardMaterial({ color: 0xff0000 }));
  m1.name = 'M1';
  const m2 = new Mesh(tri(5), new MeshStandardMaterial({ color: 0x0000ff }));
  m2.name = 'M2';
  asm.add(m1, m2);
  const data = (await new GLTFExporter().parseAsync(src, { binary: true })) as ArrayBuffer;
  const scene = new Scene();
  const result = await loadGLB('op-id-769.glb', scene, { data, preserveHierarchy: true });
  const root = result.root;
  const registry = result.registry;
  const viewer = {
    scene, registry, signalStore: null, transportManager: null,
    get currentModelRoot() { return root; },
    drives: [],
    markRenderDirty() {}, markShadowsDirty() {}, emit() {}, on() { return () => {}; },
    rebuildGroupedBvh() {}, refitRaycastSubtrees() {}, rebuildIKPaths() {},
    getPlugin: () => undefined, instancePickIndex: undefined, buildMeshBvhsAsync() {},
    selectionManager: { select() {} },
  } as unknown as RVViewer;
  return { viewer, registry, root, doc: scratchAssetDocument(viewer) };
}

/** node → identity of every node of the live tree below `root`. */
export function identities(root: Object3D): Map<Object3D, string> {
  const m = new Map<Object3D, string>();
  root.traverse((n) => { const id = identityIdOf(n); if (id) m.set(n, id); });
  return m;
}
