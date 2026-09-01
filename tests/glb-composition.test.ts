// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * glb-composition.test.ts — plan-397 Phase 3, plan §9.2. Blocker-1 regression.
 *
 * The plan review's first blocker: a referenced subtree grafted in shortly
 * before `traverseAndRegister` would skip four passes that had already run —
 * mesh processing, rename detection plus the glTF index capture, the sidecar,
 * and the library naming scan. Composition was therefore moved to sit directly
 * behind the parse. These tests are what proves it actually is there: each one
 * asserts an EFFECT of a phase, observed on a node that came out of a
 * referenced file (F15).
 *
 * They go through the real `loadGLB`, not through `compose` alone — the point
 * is the ordering inside the loader, which a direct `compose` call cannot show.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Scene, Group, Mesh, BoxGeometry, MeshStandardMaterial, Object3D } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { loadGLB, resetSidecarProbeCache, type LoadResult } from '../src/core/engine/rv-scene-loader';
import { setAssetReference } from '../src/core/engine/rv-asset-reference';
import { ROOT_SOURCE_KEY } from '../src/core/engine/rv-node-id';
import type { ReferenceResolver } from '../src/core/engine/rv-glb-compose';

const material = new MeshStandardMaterial({ color: 0x8899aa });

function meshNamed(name: string, extras?: Record<string, unknown>): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
  mesh.name = name;
  if (extras) mesh.userData.realvirtual = extras;
  return mesh;
}

function referenceNode(name: string, assetId: string): Object3D {
  const node = new Object3D();
  node.name = name;
  setAssetReference(node, { assetId });
  return node;
}

/**
 * The referenced asset. Deliberately exercises FOUR loader phases at once:
 * a plain mesh (triangle count + shadow classification), an authored Drive
 * (`processMeshes`' drive node set), and a `Drive-Lin-X` name (the naming scan).
 */
function buildPressTree(): Group {
  const press = new Group();
  press.name = 'Press';
  press.add(meshNamed('Ram', { Drive: { Direction: 'LinearY', TargetSpeed: 250 } }));
  press.add(meshNamed('Drive-Lin-X'));
  press.add(meshNamed('Housing'));
  // Two siblings with the SAME name: Three.js dedups the second to `Bolt_1`,
  // which is the only case that produces a rename alias.
  press.add(meshNamed('Bolt'));
  press.add(meshNamed('Bolt'));
  return press;
}

/** The scene: a mesh of its own plus one reference. */
function buildPlantTree(): Group {
  const plant = new Group();
  plant.name = 'Plant';
  plant.add(meshNamed('Floor'));
  plant.add(referenceNode('Press_0', 'press'));
  return plant;
}

interface Loaded {
  result: LoadResult;
  scene: Scene;
}

function findByName(root: Object3D, name: string): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((n) => { if (!found && n.name === name) found = n; });
  return found;
}

let pressBytes: ArrayBuffer;
let plantBytes: ArrayBuffer;

/** A resolver over one asset, with a fixed content hash and a per-file URL. */
function pressResolver(overrides: Partial<{ url: string; sha256: string }> = {}): ReferenceResolver {
  return async () => ({
    bytes: pressBytes,
    url: overrides.url ?? 'lib/press.glb',
    sha256: overrides.sha256 ?? 'sha-press',
    signatureState: 'none',
    signaturePresent: false,
  });
}

async function loadPlant(resolver: ReferenceResolver = pressResolver()): Promise<Loaded> {
  const scene = new Scene();
  const result = await loadGLB('plant.glb', scene, {
    data: plantBytes.slice(0),
    referenceResolver: resolver,
    preserveHierarchy: true, // keep every node individually inspectable
    loadKinematicsSidecar: false,
  });
  return { result, scene };
}

beforeEach(async () => {
  // The probe cache is session-scoped in the app; per-test here, so every test
  // sees its own mocked fetch answered rather than a neighbour's cached one.
  resetSidecarProbeCache();
  pressBytes = await objectToGlb(buildPressTree());
  plantBytes = await objectToGlb(buildPlantTree());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Composition vor allen Baumphasen (F15)', () => {
  it('zählt Dreiecke referenzierter Meshes mit (processMeshes)', async () => {
    const { result } = await loadPlant();
    // Floor (12) plus the referenced file's five boxes (12 each) = 72.
    expect(result.triangleCount).toBe(72);
  });

  it('klassifiziert Schatten in referenzierten Meshes (processMeshes)', async () => {
    const { result } = await loadPlant();
    const housing = findByName(result.root, 'Housing') as Mesh;
    expect(housing).not.toBeNull();
    // The same classification the root file's own meshes receive — a subtree
    // grafted after Phase 2 would still carry Three.js' `castShadow = false`.
    const floor = findByName(result.root, 'Floor') as Mesh;
    expect(housing.castShadow).toBe(floor.castShadow);
    expect(housing.receiveShadow).toBe(floor.receiveShadow);
  });

  it('erkennt Drive-Knoten aus referenzierten Assets', async () => {
    const { result } = await loadPlant();
    const ram = findByName(result.root, 'Ram')!;
    expect(result.drives.some((d) => d.node === ram)).toBe(true);
  });

  it('wendet den Library-Naming-Scan auf referenzierte Teilbäume an (Phase 4c)', async () => {
    const { result } = await loadPlant();
    const scanned = findByName(result.root, 'Drive-Lin-X')!;
    // The scan derives a Drive purely from the NAME — nothing in the file says
    // Drive. It only ever runs on the tree the loader holds at Phase 4c.
    expect(result.drives.some((d) => d.node === scanned)).toBe(true);
  });

  it('registriert referenzierte Knoten in der Registry mit ihrem Pfad', async () => {
    const { result } = await loadPlant();
    const ram = findByName(result.root, 'Ram')!;
    expect(result.registry.getPathForNode(ram)).toBeTruthy();
    expect(result.registry.getNode(result.registry.getPathForNode(ram)!)).toBe(ram);
  });

  it('registriert Rename-Aliase für referenzierte Knoten (Phase 3 + 6)', async () => {
    const { result } = await loadPlant();
    // Three.js renamed the second `Bolt` to `Bolt_1` file-globally. The alias is
    // what keeps a reference written against the authored name resolvable —
    // and it only exists because the composed subtree carried its rename stamps
    // into the map Phase 6 reads.
    const deduped = findByName(result.root, 'Bolt_1');
    expect(deduped).not.toBeNull();
    const dedupedPath = result.registry.getPathForNode(deduped!)!;
    const authoredPath = dedupedPath.replace(/Bolt_1$/, 'Bolt');
    expect(result.registry.getNode(dedupedPath)).toBe(deduped);
    // The authored path resolves to SOMETHING (the alias published for it) —
    // without composition-aware renames it would resolve to nothing at all.
    expect(result.registry.getNode(authoredPath)).not.toBeNull();
  });

  it('führt eine eigene glTF-Index-Map je Quelldatei (sourceKey)', async () => {
    const { result } = await loadPlant();
    const floorPath = result.registry.getPathForNode(findByName(result.root, 'Floor')!)!;
    const housingPath = result.registry.getPathForNode(findByName(result.root, 'Housing')!)!;

    const floorAt = result.registry.getGltfLocation(floorPath)!;
    const housingAt = result.registry.getGltfLocation(housingPath)!;

    expect(floorAt.sourceKey).toBe(ROOT_SOURCE_KEY);
    expect(housingAt.sourceKey).toBe('sha-press');
    // Both files number their nodes from zero, so the indices may well COLLIDE.
    // That is precisely why the source key has to travel with them.
    expect(result.registry.getGltfSourceKeys()).toEqual([ROOT_SOURCE_KEY, 'sha-press']);
    expect(result.registry.getGltfNodeNames('sha-press').length).toBeGreaterThan(0);
    expect(result.registry.getGltfNodeNames()).not.toEqual(result.registry.getGltfNodeNames('sha-press'));
  });

  it('indiziert referenzierte Knoten unter ihrer Vorkommensadresse', async () => {
    const { result } = await loadPlant();
    const frame = result.composition!.frames[0];
    const housing = findByName(result.root, 'Housing')!;
    const address = result.registry.getAddressForNode(housing);
    expect(address).toBeTruthy();
    expect(address!.startsWith(`${frame.occurrence}#`)).toBe(true);
  });

  it('reicht Composition-Meldungen im LoadResult durch', async () => {
    const { result } = await loadPlant();
    expect(result.composition).not.toBeNull();
    expect(result.composition!.frames).toHaveLength(1);
    expect(result.orphanedOverrides).toEqual([]);
    expect(result.gatedFrames).toEqual([]);
  });

  it('lässt ein Modell ohne Referenzen unverändert — keine Composition', async () => {
    const scene = new Scene();
    const bytes = await objectToGlb(buildPressTree());
    const result = await loadGLB('press.glb', scene, {
      data: bytes,
      preserveHierarchy: true,
      loadKinematicsSidecar: false,
    });
    expect(result.composition).toBeNull();
    expect(result.gatedFrames).toEqual([]);
  });
});

describe('Sidecar je Quelldatei (§2.9)', () => {
  it('wendet den .kin.json-Sidecar der referenzierten Datei an, nicht den der Wurzel', async () => {
    // Two sidecars exist. The root's names a node that only the ROOT file has;
    // the referenced file's names a node only IT has. Each must land in its own
    // file — a single global sidecar pass could not tell them apart.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const requested = String(input);
      if (requested === 'plant.kin.json') {
        return new Response(JSON.stringify({ sensors: [{ target: 'Floor', extra: { AutoRay: false } }] }), { status: 200 });
      }
      if (requested === 'lib/press.kin.json') {
        return new Response(JSON.stringify({ sensors: [{ target: 'Housing', extra: { AutoRay: false } }] }), { status: 200 });
      }
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const scene = new Scene();
    const result = await loadGLB('plant.glb', scene, {
      data: plantBytes.slice(0),
      referenceResolver: pressResolver(),
      preserveHierarchy: true,
    });

    const asked = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(asked).toContain('plant.kin.json');
    expect(asked).toContain('lib/press.kin.json');

    const floor = findByName(result.root, 'Floor')!;
    const housing = findByName(result.root, 'Housing')!;
    expect((floor.userData.realvirtual as Record<string, unknown>)?.Sensor).toBeTruthy();
    expect((housing.userData.realvirtual as Record<string, unknown>)?.Sensor).toBeTruthy();
  });

  it('wendet den Sidecar einer SIGNIERTEN referenzierten Datei nicht an', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => { void input; return new Response('', { status: 404 }); });
    vi.stubGlobal('fetch', fetchMock);

    const scene = new Scene();
    await loadGLB('plant.glb', scene, {
      data: plantBytes.slice(0),
      referenceResolver: async () => ({
        bytes: pressBytes,
        url: 'lib/press.glb',
        sha256: 'sha-press',
        signatureState: 'valid',
        signaturePresent: true,
      }),
      preserveHierarchy: true,
    });

    // A signed file declares itself self-contained: no sidecar is even REQUESTED
    // for it, which is the only way the signature can mean anything.
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).not.toContain('lib/press.kin.json');
  });
});

// ─── Load time and memory against the flat case (plan §NFR, Phase 3) ─────

/**
 * The plan's two non-functional thresholds for composition: a composed scene may
 * cost at most 15 % more load time and 20 % more memory than the same model
 * flat-exported.
 *
 * Memory is asserted STRUCTURALLY — as the number of distinct `BufferGeometry`
 * instances the tree ends up holding — because that, not a heap sample, is what
 * the composition design actually controls: the template cache parses each asset
 * once and every occurrence clones it, sharing the buffers. A wall-clock
 * assertion at the 15 % line would be a coin flip on a loaded CI machine, so the
 * ratio is measured and PRINTED for the plan record while the assertion is set
 * where it can only catch a real collapse.
 */
describe('Ladezeit und Speicher gegen den Flach-Fall', () => {
  const OCCURRENCES = 10;

  /** N assemblies, all sharing ONE geometry set — what a flat export produces. */
  function buildFlatPlant(): Group {
    const plant = new Group();
    plant.name = 'Plant';
    plant.add(meshNamed('Floor'));
    const shared = [new BoxGeometry(1, 1, 1), new BoxGeometry(2, 1, 1), new BoxGeometry(1, 2, 1)];
    for (let n = 0; n < OCCURRENCES; n++) {
      const press = new Group();
      press.name = `Press_${n}`;
      shared.forEach((g, i) => {
        const mesh = new Mesh(g, material);
        mesh.name = `Part${i}`;
        press.add(mesh);
      });
      plant.add(press);
    }
    return plant;
  }

  function buildReferencedPlant(): Group {
    const plant = new Group();
    plant.name = 'Plant';
    plant.add(meshNamed('Floor'));
    for (let n = 0; n < OCCURRENCES; n++) plant.add(referenceNode(`Press_${n}`, 'press'));
    return plant;
  }

  function buildAssembly(): Group {
    const press = new Group();
    press.name = 'Press';
    [new BoxGeometry(1, 1, 1), new BoxGeometry(2, 1, 1), new BoxGeometry(1, 2, 1)].forEach((g, i) => {
      const mesh = new Mesh(g, material);
      mesh.name = `Part${i}`;
      press.add(mesh);
    });
    return press;
  }

  function distinctGeometries(root: Object3D): number {
    const seen = new Set<unknown>();
    root.traverse((n) => {
      const g = (n as Mesh).geometry;
      if (g) seen.add(g);
    });
    return seen.size;
  }

  it('hält Geometrie-Instanzen und Ladezeit im Rahmen des Flach-Falls', async () => {
    const flatBytes = await objectToGlb(buildFlatPlant());
    const refBytes = await objectToGlb(buildReferencedPlant());
    const assemblyBytes = await objectToGlb(buildAssembly());

    const flatStart = performance.now();
    const flat = await loadGLB('flat.glb', new Scene(), {
      data: flatBytes, preserveHierarchy: true, loadKinematicsSidecar: false,
    });
    const flatMs = performance.now() - flatStart;

    const refStart = performance.now();
    const composed = await loadGLB('plant.glb', new Scene(), {
      data: refBytes,
      preserveHierarchy: true,
      loadKinematicsSidecar: false,
      referenceResolver: async () => ({
        bytes: assemblyBytes, url: 'lib/press.glb', sha256: 'sha-press',
        signatureState: 'none', signaturePresent: false,
      }),
    });
    const refMs = performance.now() - refStart;

    const flatGeoms = distinctGeometries(flat.root);
    const refGeoms = distinctGeometries(composed.root);
    console.log(`[plan-397 Phase 3] flat ${flatMs.toFixed(1)}ms / ${flatGeoms} geometries · `
      + `composed ${refMs.toFixed(1)}ms / ${refGeoms} geometries · `
      + `time ${(refMs / flatMs).toFixed(2)}x · geometry ${(refGeoms / flatGeoms).toFixed(2)}x`);

    // Both trees hold the same content.
    expect(composed.triangleCount).toBe(flat.triangleCount);
    // The memory claim: ten occurrences share the template's buffers, so the
    // composed tree holds no more distinct geometry than the flat one.
    expect(refGeoms).toBeLessThanOrEqual(flatGeoms);
    // The time claim, at a bound that only a collapse can cross.
    expect(refMs).toBeLessThan(flatMs * 3 + 50);
  });
});
