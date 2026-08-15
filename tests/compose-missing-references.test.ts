// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * §9.10 — an unresolvable reference is a visible hole with a readable cause
 * (plan-703 Phase 8, §2.8, F16).
 *
 * Before this phase `ComposeResult.missing` had exactly one reader: these tests'
 * older sibling, `glb-reference-resolve.test.ts`. Production read it nowhere, so
 * a plant that could reach five of its six machines looked like a plant with
 * five machines. Four things are pinned here, and the third is the one F16 is
 * actually about:
 *
 *  1. `missing` is filled and a placeholder stands under the reference node.
 *  2. The placeholder is sized from the authored `AssetReference.bounds`, and
 *     falls back to a fixed marker when the reference carries none.
 *  3. **The Problems entry names what was looked for** — `assetId` and, when the
 *     reference had one, `path`. A placeholder whose cause cannot be found does
 *     not satisfy F16.
 *  4. Saving keeps the reference node **byte-identical**. Both bake paths build
 *     from the source bytes, so nothing composition grafts can leak into a file
 *     — but that is a property worth a test rather than a comment, because it is
 *     the difference between "the reference is broken" and "the reference is
 *     gone".
 *
 * Renderer-free (§4 "Testsuite während der Umsetzung"): real `Object3D`s, a real
 * `loadGLB`, no `WebGLRenderer`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import { compose, type ReferenceResolver } from '../src/core/engine/rv-glb-compose';
import {
  getAssetReference,
  parseReferenceBounds,
  setAssetReference,
  type RvReferenceBounds,
} from '../src/core/engine/rv-asset-reference';
import {
  FALLBACK_PLACEHOLDER_SIZE,
  buildMissingReferencePlaceholder,
  isMissingReferencePlaceholder,
  missingReferenceLabel,
  referenceBoundsFromSubtree,
} from '../src/core/engine/rv-missing-reference-placeholder';
import {
  getProblems,
  missingReferenceDetail,
  missingReferenceProblemId,
  reportMissingReferences,
  resetProblemsForTests,
} from '../src/core/hmi/problems-store';
import { parseGlbChunks } from '../src/core/persistence/rv-glb-chunks';
import {
  bakeIntoGlb,
  makeRegistryBakeResolver,
} from '../src/core/hmi/scene/rv-scene-glb-bake';
import { materialise } from '../src/core/hmi/scene/rv-scene-edits';
import type { RvOp } from '../src/core/ops/rv-unified-ops';

const material = new MeshStandardMaterial({ color: 0x445566 });

/** Bounds of a two-metre roll standing on the floor. */
const ROLL_BOUNDS: RvReferenceBounds = { min: [-1, 0, -0.25], max: [1, 0.4, 0.25] };

function meshNamed(name: string, extras?: Record<string, unknown>): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
  mesh.name = name;
  if (extras) mesh.userData.realvirtual = extras;
  return mesh;
}

/** A plant with own geometry plus one reference that will not resolve. */
function buildPlantTree(ref: Parameters<typeof setAssetReference>[1]): Group {
  const plant = new Group();
  plant.name = 'Plant';
  plant.add(meshNamed('Floor', { Conveyor: { Speed: 100 } }));
  const reference = new Object3D();
  reference.name = 'Roll_0';
  reference.position.set(3, 0, 0);
  setAssetReference(reference, ref);
  plant.add(reference);
  return plant;
}

/** Resolves nothing — the whole point of this file. */
const nothingResolves: ReferenceResolver = async () => null;

function findByName(root: Object3D, name: string): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((n) => { if (!found && n.name === name) found = n; });
  return found;
}

/** The `nodes[]` entry for a node of that name, as raw JSON. */
function jsonNodeNamed(bytes: ArrayBuffer | Uint8Array, name: string): Record<string, unknown> {
  const source = bytes instanceof Uint8Array
    ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    : bytes;
  const chunks = parseGlbChunks(source);
  const nodes = (chunks.json.nodes ?? []) as Array<Record<string, unknown>>;
  const hit = nodes.find(n => n.name === name);
  if (!hit) throw new Error(`test fixture: no glTF node named ${name}`);
  return hit;
}

beforeEach(() => {
  resetProblemsForTests();
});

// ─── 1. The hole you can see ─────────────────────────────────────────────

describe('§9.10 — the placeholder', () => {
  it('reports the reference and grafts a placeholder under it', async () => {
    const plant = buildPlantTree({ assetId: 'roll2m', path: 'library/parts/Roll2m.glb' });
    const result = await compose(plant, { baseUrl: 'plant.glb', resolve: nothingResolves });

    expect(result.frames).toHaveLength(0);
    expect(result.missing).toHaveLength(1);

    const [miss] = result.missing;
    expect(miss.assetId).toBe('roll2m');
    expect(miss.path).toBe('library/parts/Roll2m.glb');
    expect(miss.placeholder.parent).toBe(miss.referenceNode);
    expect(isMissingReferencePlaceholder(miss.placeholder)).toBe(true);
    result.dispose();
  });

  it('names the placeholder after the file, not after the id hash', async () => {
    const plant = buildPlantTree({ assetId: 'doc_9f3ab1', path: 'library/parts/Roll2m.glb' });
    const result = await compose(plant, { baseUrl: 'plant.glb', resolve: nothingResolves });
    expect(result.missing[0].label).toBe('Roll2m.glb');
    expect(result.missing[0].placeholder.name).toBe('Roll2m.glb');
    result.dispose();
  });

  it('falls back to the id when there is no path, and to a sentence when there is neither', () => {
    expect(missingReferenceLabel({ assetId: 'doc_9f3ab1' })).toBe('doc_9f3ab1');
    expect(missingReferenceLabel({})).toBe('<missing asset>');
    // A path that is only separators must not produce an empty row.
    expect(missingReferenceLabel({ assetId: 'doc_x', path: '///' })).toBe('doc_x');
  });

  it('is invisible to picking — its data is precisely what we could not load', () => {
    const placeholder = buildMissingReferencePlaceholder({ label: 'Roll2m.glb' });
    const hits: unknown[] = [];
    placeholder.raycast({} as never, hits as never);
    expect(hits).toHaveLength(0);
    expect(placeholder.castShadow).toBe(false);
    expect(placeholder.receiveShadow).toBe(false);
  });

  it('comes off again with everything else compose grafted', async () => {
    const plant = buildPlantTree({ assetId: 'roll2m' });
    const result = await compose(plant, { baseUrl: 'plant.glb', resolve: nothingResolves });
    const reference = result.missing[0].referenceNode;
    expect(reference.children).toHaveLength(1);
    result.dispose();
    expect(reference.children).toHaveLength(0);
  });
});

// ─── 2. Sizing ───────────────────────────────────────────────────────────

describe('§9.10 — the placeholder is sized from the authored bounds', () => {
  /** Local half-extents of an edges-only box, read back off its geometry. */
  function extentsOf(node: Object3D): { size: number[]; centre: number[] } {
    const geometry = (node as unknown as { geometry: { boundingBox: unknown; computeBoundingBox(): void } }).geometry;
    geometry.computeBoundingBox();
    const box = geometry.boundingBox as { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
    return {
      size: [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z],
      centre: [node.position.x, node.position.y, node.position.z],
    };
  }

  it('takes size and centre from the bounds when the reference carries them', async () => {
    const plant = buildPlantTree({ assetId: 'roll2m', path: 'p/Roll2m.glb', bounds: ROLL_BOUNDS });
    const result = await compose(plant, { baseUrl: 'plant.glb', resolve: nothingResolves });

    const { size, centre } = extentsOf(result.missing[0].placeholder);
    expect(size[0]).toBeCloseTo(2, 6);
    expect(size[1]).toBeCloseTo(0.4, 6);
    expect(size[2]).toBeCloseTo(0.5, 6);
    // Centre of the authored box, in the reference node's own local frame.
    expect(centre[0]).toBeCloseTo(0, 6);
    expect(centre[1]).toBeCloseTo(0.2, 6);
    expect(centre[2]).toBeCloseTo(0, 6);
    result.dispose();
  });

  it('uses the fixed marker when the reference carries no bounds', async () => {
    const plant = buildPlantTree({ assetId: 'roll2m' });
    const result = await compose(plant, { baseUrl: 'plant.glb', resolve: nothingResolves });
    const { size } = extentsOf(result.missing[0].placeholder);
    for (const axis of size) expect(axis).toBeCloseTo(FALLBACK_PLACEHOLDER_SIZE, 6);
    result.dispose();
  });

  it('survives a GLB round-trip — bounds is an ordinary additive extras field', async () => {
    const bytes = await objectToGlb(buildPlantTree({
      assetId: 'roll2m', path: 'p/Roll2m.glb', bounds: ROLL_BOUNDS,
    }));
    const loaded = await loadGLB('plant.glb', new Scene(), {
      data: bytes,
      referenceResolver: nothingResolves,
      preserveHierarchy: true,
      loadKinematicsSidecar: false,
      sourceSha256: 'sha-plant',
    });
    const reference = findByName(loaded.root, 'Roll_0')!;
    expect(getAssetReference(reference)?.bounds).toEqual(ROLL_BOUNDS);
  });

  it('rejects a malformed or inverted bounds rather than guessing at it', () => {
    expect(parseReferenceBounds(undefined)).toBeNull();
    expect(parseReferenceBounds({ min: [0, 0, 0] })).toBeNull();
    expect(parseReferenceBounds({ min: [0, 0], max: [1, 1] })).toBeNull();
    expect(parseReferenceBounds({ min: [0, 0, 0], max: [1, 1, 'x'] })).toBeNull();
    // min > max on one axis: the writer was confused, and drawing a guess would
    // hide that. A rejected bounds falls back to the fixed marker.
    expect(parseReferenceBounds({ min: [0, 5, 0], max: [1, 1, 1] })).toBeNull();
    expect(parseReferenceBounds({ min: [-1, 0, -1], max: [1, 2, 1] }))
      .toEqual({ min: [-1, 0, -1], max: [1, 2, 1] });
  });

  it('measures a subtree in its own local frame — the authoring side of the field', () => {
    const asset = new Group();
    const box = new Mesh(new BoxGeometry(2, 1, 1), material);
    box.position.set(0, 0.5, 0);
    asset.add(box);
    asset.position.set(100, 100, 100);   // where it sits must not reach the answer

    const bounds = referenceBoundsFromSubtree(asset, asset)!;
    expect(bounds.min[0]).toBeCloseTo(-1, 6);
    expect(bounds.max[0]).toBeCloseTo(1, 6);
    expect(bounds.min[1]).toBeCloseTo(0, 6);
    expect(bounds.max[1]).toBeCloseTo(1, 6);
  });

  it('returns null for a subtree with no geometry rather than a zero-size box', () => {
    const empty = new Group();
    empty.add(new Object3D());
    expect(referenceBoundsFromSubtree(empty, empty)).toBeNull();
  });
});

// ─── 3. The cause you can read (F16) ─────────────────────────────────────

describe('§9.10 — the Problems entry names what was looked for', () => {
  it('names both the assetId and the path', () => {
    reportMissingReferences([{
      assetId: 'roll2m',
      path: 'library/parts/Roll2m.glb',
      occurrence: 'root/ref_1',
      label: 'Roll2m.glb',
      nodePath: 'Plant/Roll_0',
    }]);

    const problems = getProblems();
    expect(problems).toHaveLength(1);
    const [problem] = problems;
    expect(problem.code).toBe('missing-reference');
    expect(problem.severity).toBe('error');
    expect(problem.title).toContain('Roll2m.glb');
    expect(problem.detail).toContain('roll2m');
    expect(problem.detail).toContain('library/parts/Roll2m.glb');
    expect(problem.nodePath).toBe('Plant/Roll_0');
  });

  it('names the one key it has when the reference carries only an id', () => {
    const detail = missingReferenceDetail({ assetId: 'roll2m' });
    expect(detail).toContain('assetId "roll2m"');
    expect(detail).not.toContain('path');
  });

  it('says so out loud when a reference carries neither key', () => {
    expect(missingReferenceDetail({})).toMatch(/neither an assetId nor a path/);
  });

  it('re-reporting the same composition does not double the list', () => {
    const report = [{ assetId: 'a', path: 'p/a.glb', occurrence: 'root/r1', label: 'a.glb' }];
    reportMissingReferences(report);
    const first = getProblems();
    reportMissingReferences(report);
    expect(getProblems()).toHaveLength(1);
    // Identity too: an unchanged re-report must not wake React.
    expect(getProblems()).toBe(first);
  });

  it('retires the entry when the reference is repaired', () => {
    reportMissingReferences([{ assetId: 'a', occurrence: 'root/r1', label: 'a.glb' }]);
    expect(getProblems()).toHaveLength(1);
    reportMissingReferences([]);
    expect(getProblems()).toHaveLength(0);
  });

  it('keys on the occurrence chain, so two holes are two entries', () => {
    reportMissingReferences([
      { assetId: 'a', occurrence: 'root/r1', label: 'a.glb' },
      { assetId: 'a', occurrence: 'root/r2', label: 'a.glb' },
    ]);
    expect(getProblems().map(p => p.id)).toEqual([
      missingReferenceProblemId('root/r1'),
      missingReferenceProblemId('root/r2'),
    ]);
  });

  it('the loader reports through to the store on a real load', async () => {
    const bytes = await objectToGlb(buildPlantTree({
      assetId: 'roll2m', path: 'library/parts/Roll2m.glb',
    }));
    await loadGLB('plant.glb', new Scene(), {
      data: bytes,
      referenceResolver: nothingResolves,
      preserveHierarchy: true,
      loadKinematicsSidecar: false,
      sourceSha256: 'sha-plant',
    });

    const problems = getProblems();
    expect(problems).toHaveLength(1);
    expect(problems[0].detail).toContain('library/parts/Roll2m.glb');
    // The node path comes from the registry — without it the user has a
    // message but no idea which of forty references it is about.
    expect(problems[0].nodePath).toBeTruthy();
  });
});

// ─── 4. Saving keeps the reference node byte-identical ───────────────────

describe('§9.10 — a save does not lose the broken reference', () => {
  let plantBytes: ArrayBuffer;

  beforeEach(async () => {
    plantBytes = await objectToGlb(buildPlantTree({
      assetId: 'roll2m', path: 'library/parts/Roll2m.glb', bounds: ROLL_BOUNDS,
    }));
  });

  it('writes the reference node back byte-identically', async () => {
    const before = jsonNodeNamed(plantBytes, 'Roll_0');

    const loaded = await loadGLB('plant.glb', new Scene(), {
      data: plantBytes.slice(0),
      referenceResolver: nothingResolves,
      preserveHierarchy: true,
      loadKinematicsSidecar: false,
      sourceSha256: 'sha-plant',
    });
    const resolver = makeRegistryBakeResolver(loaded.registry, loaded.composition?.frames ?? []);
    const floor = findByName(loaded.root, 'Floor')!;
    const floorPath = loaded.registry.getPathForNode(floor)!;

    // An edit somewhere ELSE in the file: the reference node is not the subject
    // of the save, which is exactly the case where silent loss would go unnoticed.
    const edits = materialise([{
      id: 'op_1', ts: 1, schemaV: 1,
      kind: 'setField',
      nodePath: floorPath,
      componentType: 'Conveyor',
      fieldName: 'Speed',
      value: 777,
      prev: 100,
    } as unknown as RvOp]);

    const baked = await bakeIntoGlb(plantBytes.slice(0), edits, resolver, {
      expectedNames: loaded.registry.getGltfNodeNames(),
    });

    const after = jsonNodeNamed(baked.glb, 'Roll_0');
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it('the placeholder never reaches the file', async () => {
    const loaded = await loadGLB('plant.glb', new Scene(), {
      data: plantBytes.slice(0),
      referenceResolver: nothingResolves,
      preserveHierarchy: true,
      loadKinematicsSidecar: false,
      sourceSha256: 'sha-plant',
    });
    const resolver = makeRegistryBakeResolver(loaded.registry, loaded.composition?.frames ?? []);
    const baked = await bakeIntoGlb(plantBytes.slice(0), materialise([]), resolver, {
      expectedNames: loaded.registry.getGltfNodeNames(),
    });

    const chunks = parseGlbChunks(
      baked.glb.buffer.slice(baked.glb.byteOffset, baked.glb.byteOffset + baked.glb.byteLength) as ArrayBuffer,
    );
    const names = ((chunks.json.nodes ?? []) as Array<{ name?: string }>).map(n => n.name);
    expect(names).not.toContain('Roll2m.glb');
    expect(JSON.stringify(chunks.json)).not.toContain('MissingAssetPlaceholder');
  });

  it('the reference — bounds included — is still there after the round-trip', async () => {
    const loaded = await loadGLB('plant.glb', new Scene(), {
      data: plantBytes.slice(0),
      referenceResolver: nothingResolves,
      preserveHierarchy: true,
      loadKinematicsSidecar: false,
      sourceSha256: 'sha-plant',
    });
    const resolver = makeRegistryBakeResolver(loaded.registry, loaded.composition?.frames ?? []);
    const baked = await bakeIntoGlb(plantBytes.slice(0), materialise([]), resolver, {
      expectedNames: loaded.registry.getGltfNodeNames(),
    });

    const reloaded = await loadGLB('plant.glb', new Scene(), {
      data: baked.glb.buffer.slice(
        baked.glb.byteOffset, baked.glb.byteOffset + baked.glb.byteLength,
      ) as ArrayBuffer,
      referenceResolver: nothingResolves,
      preserveHierarchy: true,
      loadKinematicsSidecar: false,
      sourceSha256: 'sha-plant',
    });
    const ref = getAssetReference(findByName(reloaded.root, 'Roll_0')!);
    expect(ref?.assetId).toBe('roll2m');
    expect(ref?.path).toBe('library/parts/Roll2m.glb');
    expect(ref?.bounds).toEqual(ROLL_BOUNDS);
  });
});
