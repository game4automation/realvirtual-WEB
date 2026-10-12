// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared builders for the plan-753 bake tests (§9.1–9.4, 9.11, 9.13).
 *
 * Synthetic master trees: uber-baked box meshes (the shape `bakeMasterOntoUber`
 * leaves behind), textured meshes, component tags, and a `bake()` wrapper that
 * always builds the pick structures inline — vitest never spawns a real worker.
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  RGBAFormat,
  type Material,
} from 'three';
import { RVUberMaterial } from '../../src/core/engine/rv-uber-material';
import { createPickBuildPort, type PickBuildJob, type PickBuildJobResult, type PickBuildPort } from '../../src/core/engine/rv-pick-build-port';
import { bake, type BakeOptions } from '../../src/core/engine/rv-bake-pipeline';
import type { BakedAsset } from '../../src/core/engine/rv-bake-chunk';
import type { BakeRegistry, PlacementInstance } from '../../src/core/engine/rv-bake-registry';

/** Tag a node with an rv_extras component (truthy config = present). */
export function withComponent<T extends Object3D>(node: T, key: string, cfg: Record<string, unknown> = { enabled: true }): T {
  node.userData.realvirtual = { ...(node.userData.realvirtual ?? {}), [key]: cfg };
  return node;
}

/** A named Group / Object3D. */
export function group(name: string): Group {
  const g = new Group();
  g.name = name;
  return g;
}

/** Write uber attributes onto a geometry (what `bakeMaterialToAttributes` does). */
export function uberBakeGeometry(geometry: BufferGeometry, color = 0x336699, roughness = 0.5, metalness = 0): BufferGeometry {
  const n = geometry.getAttribute('position').count;
  const col = new Uint8Array(n * 3);
  const rm = new Uint8Array(n * 2);
  const r = (color >> 16) & 255; const g = (color >> 8) & 255; const b = color & 255;
  for (let i = 0; i < n; i++) {
    col[i * 3] = r; col[i * 3 + 1] = g; col[i * 3 + 2] = b;
    rm[i * 2] = Math.round(roughness * 255); rm[i * 2 + 1] = Math.round(metalness * 255);
  }
  geometry.setAttribute('color', new BufferAttribute(col, 3, true));
  geometry.setAttribute('rmPacked', new BufferAttribute(rm, 2, true));
  geometry.userData._rvUberBaked = true;
  return geometry;
}

/** An uber-baked box mesh at `pos` (the master shape after `bakeMasterOntoUber`). */
export function uberMesh(uber: RVUberMaterial, name: string, pos: [number, number, number] = [0, 0, 0], color = 0x336699): Mesh {
  const mesh = new Mesh(uberBakeGeometry(new BoxGeometry(1, 1, 1), color), uber);
  mesh.name = name;
  mesh.position.set(...pos);
  mesh.userData._rvUberBaked = true;
  return mesh;
}

/** A 1×1 white texture so a material counts as textured. */
export function makeTexture(): DataTexture {
  const tex = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}

/** A textured (non-uber) box mesh. */
export function texturedMesh(name: string, material?: MeshStandardMaterial, pos: [number, number, number] = [0, 0, 0]): Mesh {
  const mat = material ?? new MeshStandardMaterial({ map: makeTexture() });
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), mat);
  mesh.name = name;
  mesh.position.set(...pos);
  return mesh;
}

/** Triangles of a geometry (index or position count / 3). */
export function trianglesOf(geometry: BufferGeometry): number {
  return (geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3;
}

/** Sum of triangles of every Mesh under `root`. */
export function sourceTriangles(root: Object3D): number {
  let n = 0;
  root.traverse((o) => {
    const m = o as Mesh;
    if (m.isMesh && m.geometry?.getAttribute('position')) n += trianglesOf(m.geometry);
  });
  return n;
}

/** Sum of triangles staged into chunks + kept meshes. */
export function bakedTriangles(asset: BakedAsset): number {
  let n = 0;
  for (const c of asset.chunks) n += trianglesOf(c.geometry);
  for (const k of asset.keep) n += trianglesOf(k.mesh.geometry);
  return n;
}

export function chunkKeys(asset: BakedAsset): string[] {
  return asset.chunks.map((c) => c.key).sort();
}

export function chunkByKey(asset: BakedAsset, key: string) {
  const c = asset.chunks.find((x) => x.key === key);
  if (!c) throw new Error(`chunk ${key} missing — have ${chunkKeys(asset).join(', ')}`);
  return c;
}

/**
 * A pick-build port that never spawns a `Worker` (plan-756 §2.2): the build runs
 * inline through the very same `buildPickStructure` the worker calls, so a bake
 * in the suite is deterministic and costs no worker slots.
 */
export function inlinePickPort(): PickBuildPort {
  return createPickBuildPort({ createWorker: () => null });
}

/** `bake()` with the inline ports and a fresh uber material unless given. */
export async function bakeTree(
  root: Object3D,
  overrides: Partial<BakeOptions> & { uber?: Material | null } = {},
): Promise<BakedAsset> {
  const { uber, ...rest } = overrides;
  return bake(root, {
    assetId: 'test-asset',
    uberMaterial: uber === undefined ? null : uber,
    pickPort: inlinePickPort(),
    ...rest,
  });
}

/**
 * The runtime entry in one call (plan-754 §2.4): bake `root` DESTRUCTIVELY and
 * place the resulting template — the only placement path a drawable model has
 * since Phase 1c deleted the in-place bake.
 *
 * `root` is consumed. Its survivors are re-created as fresh `Group`s in the
 * template, so any node reference a test held before the bake is stale —
 * look it up again through the returned `node(name)`.
 */
export async function bakeAndPlace(
  root: Object3D,
  bakeRegistry: BakeRegistry,
  overrides: Partial<BakeOptions> & { uber?: Material | null } = {},
): Promise<{
  baked: BakedAsset;
  instance: PlacementInstance;
  template: Object3D;
  node: (name: string) => Object3D;
}> {
  const baked = await bakeTree(root, { ...overrides, destructive: true });
  const instance = bakeRegistry.instantiateTemplate(baked);
  baked.template.updateMatrixWorld(true);
  const node = (name: string): Object3D => {
    let found: Object3D | null = null;
    baked.template.traverse((n) => { if (!found && n.name === name) found = n; });
    if (!found) throw new Error(`node "${name}" did not survive the bake`);
    return found;
  };
  return { baked, instance, template: baked.template, node };
}

/**
 * A PICK build port whose builds hang until `settleAll()` is called (race tests;
 * plan-756 §9.4 replaced the deferred BVH port with this one, because the bake
 * AWAITS the pick builds — the lifecycle race is now "a dispose arrives while a
 * chunk's structure is still being built", not "a late tree lands").
 */
export function makeDeferredPickPort(): PickBuildPort & { settleAll(): Promise<void>; pending: number } {
  const waiting: Array<() => void> = [];
  const inline = createPickBuildPort({ createWorker: () => null });
  const defer = (
    delegate: (job: PickBuildJob) => Promise<PickBuildJobResult>,
    job: PickBuildJob,
  ): Promise<PickBuildJobResult> => new Promise<PickBuildJobResult>((resolve, reject) => {
    waiting.push(() => { delegate(job).then(resolve, reject); });
  });
  return {
    get size() { return inline.size; },
    get usesWorker() { return inline.usesWorker; },
    get stats() { return inline.stats; },
    get pending() { return waiting.length; },
    beginEpoch() {
      const epoch = inline.beginEpoch();
      return {
        get id() { return epoch.id; },
        get stale() { return epoch.stale; },
        build: (job) => defer((j) => epoch.build(j), job),
        abort: () => epoch.abort(),
      };
    },
    build: (job) => defer((j) => inline.build(j), job),
    dispose() { inline.dispose(); },
    async settleAll() {
      for (const fn of waiting.splice(0)) fn();
      // Let the inline builds run to completion.
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

/** Flush a few microtask turns. */
export async function flush(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/** Poll `cond` on macrotasks until true (or `timeoutMs`) — for work behind dynamic imports. */
export async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > timeoutMs) throw new Error('waitFor: condition not met within ' + timeoutMs + ' ms');
    await new Promise((r) => setTimeout(r, 5));
  }
}
