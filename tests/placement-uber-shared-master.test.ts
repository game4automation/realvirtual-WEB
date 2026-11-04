// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * placement-uber-shared-master.test.ts — plan-752 Phase 2 / §9.7.
 *
 * The bake belongs to the ASSET, not to the occurrence. A bake "at the
 * placement" was never a per-placement bake at all: it mutated the shared
 * master, once per drop, wastefully and behind the caller's back (R6). Doing
 * it deliberately ONCE per asset is the whole of Phase 2.
 *
 * Where that once happens moved with plan-757 (Phase 1a): the uber pass is no
 * longer a step of the DECODE (`bakeMasterOntoUber` is gone) but step 4 of THE
 * recipe — `prepareAndBake`: dedup → uber → bake — that `ModelCache._bake`
 * runs exactly once per cache key. The shared thing is therefore the
 * `BakedAsset`: its chunk geometry carries the baked colour + `rmPacked`, its
 * chunk material IS the session's uber singleton, every `instantiate()` shares
 * that geometry by reference, and `getOrLoad` (drag ghost, thumbnail) serves a
 * clone of the same template. A raw decode that nobody baked yet keeps its own
 * materials — that is the recipe's input, not an occurrence.
 *
 * What is pinned here:
 *   - two occurrences (and the ghost) share ONE baked geometry and ONE material reference;
 *   - the empty-document case (nothing loaded yet) still gets a material, so
 *     the very first placement of a session does not fall back to N arenas (S2);
 *   - `createUberMaterial` covers the WebGPU branch;
 *   - a session without the uber path (editor / STEP load, merging off) skips
 *     the bake at the master too (S4).
 */

import { describe, it, expect } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshStandardMaterial, type Object3D } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Side effect: registers every component's capabilities — what the recipe's
// survival model reads (same as model-cache-pruned-master.test.ts).
import '../src/core/engine/rv-scene-loader';
import { ModelCache } from '../src/plugins/layout-planner/model-cache';
import {
  RVUberMaterial,
  createUberMaterial,
  isGeometryUberBaked,
} from '../src/core/engine/rv-uber-material';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import viewerSourceRaw from '../src/core/rv-viewer.ts?raw';

// `?raw` hands back the WORKING-TREE bytes, so a CRLF checkout carries `\r\n`.
// The multi-line invariants below are written with `\n`, and the method slices
// below count characters — normalise the line endings once, here.
const viewerSource = viewerSourceRaw.replace(/\r\n/g, '\n');

/** The body of a 2-space-indented class member, from its signature to its `}`. */
function memberSource(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `signature not found: ${signature}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n  }\n', start);
  return source.slice(start, end < 0 ? undefined : end + 5);
}

/** A GLTFLoader stand-in that hands back a fresh tree per decode. */
function fakeLoader(make: () => Group): GLTFLoader {
  return {
    loadAsync: async (): Promise<{ scene: Group }> => ({ scene: make() }),
  } as unknown as GLTFLoader;
}

/** One asset: a root with two meshes on ONE shared geometry + material —
 *  the shape a GLTFLoader produces for a repeated part. */
function makeAssetTree(): Group {
  const root = new Group();
  root.name = 'Conveyor';
  const geometry = new BoxGeometry(1, 1, 1);
  const material = new MeshStandardMaterial({ color: 0x3366aa, roughness: 0.4, metalness: 0.1 });
  for (let i = 0; i < 2; i++) {
    const mesh = new Mesh(geometry, material);
    mesh.name = `part${i}`;
    mesh.position.x = i;
    root.add(mesh);
  }
  return root;
}

const BLOB_URL = 'blob:rv-test/conveyor.glb';

/** The cache as the placement instancer builds it — with the inline pick port
 *  (the standard suite seam: the bake AWAITS its pick builds, plan-756). */
function makeCache(loader: GLTFLoader, uber: RVUberMaterial | null): ModelCache {
  return new ModelCache(loader, {
    uber: () => uber,
    pickPort: () => createPickBuildPort({ createWorker: () => null }),
  });
}

function meshesOf(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((n) => { if ((n as Mesh).isMesh) out.push(n as Mesh); });
  return out;
}

describe('ModelCache bakes the master once (plan-752 Phase 2 / plan-757 recipe)', () => {
  it('gives every occurrence the same baked geometry and material', async () => {
    const uber = new RVUberMaterial(false);
    const cache = makeCache(fakeLoader(makeAssetTree), uber);

    // ONE BakedAsset per cache key — the second ask is the same object.
    const baked = await cache.getOrLoadBaked(BLOB_URL);
    expect(await cache.getOrLoadBaked(BLOB_URL)).toBe(baked);

    // Two placements of it, the way the placement instancer makes them…
    const registry = new BakeRegistry();
    const firstRoot = new Group();
    const secondRoot = new Group();
    registry.instantiate(baked, firstRoot);
    registry.instantiate(baked, secondRoot);
    // …and the ghost / thumbnail clone `getOrLoad` serves after the bake.
    const ghost = await cache.getOrLoad(BLOB_URL);

    const firstMeshes = meshesOf(firstRoot);
    const secondMeshes = meshesOf(secondRoot);
    const ghostMeshes = meshesOf(ghost);
    // Both parts share one material and sit under the static root, so the
    // recipe bakes them into ONE chunk.
    expect(firstMeshes.length).toBe(1);
    expect(secondMeshes.length).toBe(1);
    expect(ghostMeshes.length).toBe(1);

    for (const mesh of [...firstMeshes, ...secondMeshes, ...ghostMeshes]) {
      expect(mesh.material).toBe(uber);
      expect(isGeometryUberBaked(mesh.geometry)).toBe(true);
    }
    // ONE geometry across every occurrence — shared by reference from the
    // asset's chunk, never cloned per placement (D21).
    const geometries = new Set([...firstMeshes, ...secondMeshes, ...ghostMeshes].map((m) => m.geometry));
    expect(geometries.size).toBe(1);
    expect(geometries.has(baked.chunks[0].geometry)).toBe(true);
  });

  it('bakes exactly once — the second occurrence is a cache hit, not a second bake', async () => {
    const uber = new RVUberMaterial(false);
    let decodes = 0;
    const cache = makeCache(fakeLoader(() => { decodes++; return makeAssetTree(); }), uber);

    const baked = await cache.getOrLoadBaked(BLOB_URL);
    await cache.getOrLoadBaked(BLOB_URL);
    await cache.getOrLoad(BLOB_URL);
    expect(decodes).toBe(1);
    expect(cache.getBakeStats().assets).toBe(1);
    expect(baked.chunks.length).toBe(1);

    // The colour that was baked in is the ASSET's, not the uber material's
    // identity white — a second bake on top would have overwritten it.
    const color = baked.chunks[0].geometry.getAttribute('color');
    expect(color).toBeDefined();
    expect(Math.round(color.getX(0) * 255)).toBeGreaterThan(0);
    expect(Math.round(color.getX(0) * 255)).toBeLessThan(255);
  });

  it('skips the bake when the session has no uber path (S4)', async () => {
    // `placementUberMaterial` returns null for an editor / STEP-inspection
    // load (an authoring load — the loader skipped the uber pass there; the
    // "static merging off" session went with plan-757 Phase 3 commit B), so
    // the recipe skips it for a placement too: the chunk
    // keeps the asset's own material as its bucket, nothing is encoded into
    // the vertices.
    const cache = makeCache(fakeLoader(makeAssetTree), null);
    const baked = await cache.getOrLoadBaked(BLOB_URL);
    expect(baked.chunks.length).toBe(1);
    const chunk = baked.chunks[0];
    expect(chunk.material).toBeInstanceOf(MeshStandardMaterial);
    expect(chunk.material).not.toBeInstanceOf(RVUberMaterial);
    expect(isGeometryUberBaked(chunk.geometry)).toBe(false);
    // The raw decode of a session without an uber path is untouched as well.
    const raw = await cache.decodeFresh(BLOB_URL);
    const mesh = raw.children[0] as Mesh;
    expect(mesh.material).toBeInstanceOf(MeshStandardMaterial);
    expect(isGeometryUberBaked(mesh.geometry)).toBe(false);
  });

  it('skips the bake when no options were given at all (older embedders)', async () => {
    const cache = new ModelCache(fakeLoader(makeAssetTree));
    const clone = await cache.getOrLoad(BLOB_URL);
    expect(isGeometryUberBaked((clone.children[0] as Mesh).geometry)).toBe(false);
  });

  it('drops the baked masters on a document change but keeps serving (S1)', async () => {
    const uber = new RVUberMaterial(false);
    let decodes = 0;
    const cache = new ModelCache(
      fakeLoader(() => { decodes++; return makeAssetTree(); }),
      { uber: () => uber },
    );

    const fromA = await cache.getOrLoad(BLOB_URL);
    expect(decodes).toBe(1);
    expect(cache.size).toBe(1);

    // Document change: `onModelCleared` → `clearDecoded()`.
    cache.clearDecoded();
    expect(cache.size).toBe(0);

    const fromB = await cache.getOrLoad(BLOB_URL);
    expect(decodes).toBe(2);
    // Document B got its OWN tree — it did not inherit geometry that document
    // A's session had baked and shares with A's live placements.
    expect((fromB.children[0] as Mesh).geometry)
      .not.toBe((fromA.children[0] as Mesh).geometry);
  });
});

/** The JSON chunk of a binary GLB. */
function glbJson(bytes: ArrayBuffer): Record<string, unknown> {
  const view = new DataView(bytes);
  const chunkLength = view.getUint32(12, true);
  const json = new TextDecoder().decode(new Uint8Array(bytes, 20, chunkLength));
  return JSON.parse(json) as Record<string, unknown>;
}

describe('a delivered export carries no WebViewer-only encoding (plan-752 I2 / §9.11)', () => {
  it('strips rmPacked for the export and puts it back afterwards', async () => {
    const { objectToGlb } = await import('../src/core/import/rv-import-object');
    const { stripUberPrivateAttributes } = await import('../src/core/engine/rv-uber-material');

    const uber = new RVUberMaterial(false);
    const cache = makeCache(fakeLoader(makeAssetTree), uber);
    // What a placement puts into the scene — and what the export walks — is
    // the baked template's chunk mesh, the geometry the recipe encoded.
    const baked = await cache.getOrLoadBaked(BLOB_URL);
    expect(baked.chunks.length).toBe(1);
    const geometry = baked.chunks[0].geometry;
    expect(baked.chunks[0].templateMesh?.geometry).toBe(geometry);
    const rmBefore = geometry.getAttribute('rmPacked');
    expect(rmBefore).toBeDefined();

    // Exactly the sequence `SceneStore.exportSceneGlb({embedReferences:true})`
    // runs around `objectToGlb` on the model root.
    const shield = stripUberPrivateAttributes(baked.template);
    expect(shield.stripped).toBe(1);
    expect(geometry.getAttribute('rmPacked')).toBeUndefined();

    let json: Record<string, unknown>;
    try {
      json = glbJson(await objectToGlb(baked.template));
    } finally {
      shield.restore();
    }

    // The live scene renders exactly as before — the SAME attribute object, so
    // nothing is re-uploaded either.
    expect(geometry.getAttribute('rmPacked')).toBe(rmBefore);

    const meshes = json.meshes as Array<{ primitives: Array<{ attributes: Record<string, number> }> }>;
    const attributeNames = new Set<string>();
    for (const mesh of meshes ?? []) {
      for (const primitive of mesh.primitives) {
        for (const name of Object.keys(primitive.attributes)) attributeNames.add(name);
      }
    }
    // `GLTFExporter` does not drop an unknown attribute, it underscore-prefixes
    // it (`_RMPACKED`) — conformant, but a viewer-private encoding in a file we
    // hand out as self-contained.
    expect([...attributeNames].filter((n) => n.includes('RMPACKED'))).toEqual([]);
    // The baked BASE COLOUR does survive, because it rides on the standard
    // `COLOR_0` every glTF reader understands. That is the whole point: the
    // file still looks right, it just no longer speaks WebViewer.
    expect(attributeNames.has('COLOR_0')).toBe(true);
  });

  it('restore() is idempotent and a shield over an unbaked tree is a no-op', async () => {
    const { stripUberPrivateAttributes } = await import('../src/core/engine/rv-uber-material');
    const raw = makeAssetTree();
    const shield = stripUberPrivateAttributes(raw);
    expect(shield.stripped).toBe(0);
    shield.restore();
    shield.restore();
    expect((raw.children[0] as Mesh).geometry.getAttribute('rmPacked')).toBeUndefined();
  });
});

describe('the uber material has ONE owner (plan-752 S2)', () => {
  it('createUberMaterial covers both renderer branches', () => {
    const gl = createUberMaterial(false);
    expect(gl).toBeInstanceOf(RVUberMaterial);
    expect(gl.name).toBe('__rvUberMaterial');
    expect(gl.vertexColors).toBe(true);
    expect(gl.userData._rvShared).toBe(true);

    // WebGPU without a pre-warmed TSL module falls back to the guarded GLSL
    // instance: vertexColors kept, no onBeforeCompile patch installed.
    const gpu = createUberMaterial(true);
    expect(gpu.vertexColors).toBe(true);
    expect(gpu.userData._rvShared).toBe(true);
  });

  it('the viewer owns it and hands the same instance to the loader', () => {
    // The coupling, asserted at the source: a second instance would mean a
    // second arena bucket for identical geometry (three.js#19377).
    expect(viewerSource).toContain('ensureUberMaterial(): RVUberMaterial');
    expect(viewerSource).toContain('this._uberMaterial = createUberMaterial(this.isWebGPU)');
    expect(viewerSource).toContain('sharedUber: this.ensureUberMaterial()');
    expect(viewerSource).toContain('get placementUberMaterial(): RVUberMaterial | null');
  });

  it('the planner drops the decoded masters on every document change (S1)', async () => {
    // `onModelCleared` is called by `RVViewer.clearModel()`, which runs at the
    // start of EVERY load — so this is the document-change hook, asserted
    // where the wiring is rather than through a full viewer boot.
    const plannerSource = (await import('../src/plugins/layout-planner/index.ts?raw')).default;
    const hook = plannerSource.slice(plannerSource.indexOf('onModelCleared(_viewer: RVViewer)'), 0
      + plannerSource.indexOf('onModelCleared(_viewer: RVViewer)') + 1500);
    // The cache moved to the viewer's placement instancer (plan-753 structure
    // hardening): `clearDocument()` retires the bakes + drops the masters.
    // plan-774 F6: only for a host without `viewer.placements` — the viewer's
    // own clear (pinned below) decides whether the bakes are kept for the next load.
    // Review fix E8: only the planner's OWN fallback instancer (which exists
    // exactly on such hosts) — never `this._placements`, which resolves to the
    // viewer's instancer whenever the viewer has one.
    expect(hook).toContain('this._ownPlacements?.clearDocument();');
    expect(hook).not.toContain('this._placements.clearDocument()');
    const instancerSource = (await import('../src/core/engine/rv-placement-instancer.ts?raw')).default;
    // plan-774 F6: the release is `releaseDocument` — `clearDecoded` unless the
    // viewer's clear keeps the bakes for an authoring reload (default: retire).
    expect(instancerSource).toContain('this._cache?.releaseDocument({ keepBaked })');
    expect(viewerSource).toContain('this.placements.clearDocument({\n      keepBaked: opts?.keepBaked === true,');
    // plan-774 leak fix: the clear also releases every instance in the dropped model roots.
    expect(viewerSource).toContain('documentRoots: this._modelRootsOnScene(),');
    // …and the cache is constructed with the viewer's single owner.
    const integrateSource = (await import('../src/core/engine/rv-placement-integrate.ts?raw')).default;
    expect(integrateSource).toContain('uber: () => viewer.placementUberMaterial');
  });

  it('answers with a material before the first model load (empty document)', () => {
    // The most common case of all — an empty document, first drop. Before
    // plan-752 this was the case that produced N arenas, because the only
    // owner of an uber material was a load that had not happened yet.
    const getter = memberSource(viewerSource, 'get placementUberMaterial(): RVUberMaterial | null');
    expect(getter).toContain('if (this._lastLoadResult)');
    // plan-757 Phase 3 commit B: the bake is the only runtime, so before the
    // first load the answer is unconditionally the session material.
    expect(getter).toContain('return this.ensureUberMaterial();');
    expect(getter).not.toContain('isStaticMeshMergingEnabled');
  });
});
