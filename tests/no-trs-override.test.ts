// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 test 9.10 — `trsByNodeId` is gone (D11, F14).
 *
 * Inside placed content only component VALUES are overridable. Three halves:
 *
 *  - **Refused.** A part move inside a referenced asset (a composed frame, a
 *    placement instance, at any depth) is refused by name on save —
 *    `NestedTransformRefusedError`, code `nested-transform-refused` — and nothing
 *    is written. In the asset editor the guard keeps `transformNode` structural.
 *  - **Old files load.** A file written with plan-444's `trsByNodeId` loads: the
 *    component patch beside it is applied, the parts stay where their asset puts
 *    them, and ONE `override-transforms-dropped` problem per reference node names
 *    the count.
 *  - **Never written.** No writer emits `trsByNodeId` (or `byNodeId`) again — the
 *    scene bake, the editor export, `setAssetOverrides`.
 *
 * Replaces the mechanism tests of plan-444 (`rv-asset-override-trs`,
 * `rv-asset-override-compat`, `rv-glb-compose-trs-roundtrip`,
 * `rv-scene-glb-bake-move-in-reference`), see `tests/MIGRATION-769.md`.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { loadGLB, type LoadResult } from '../src/core/engine/rv-scene-loader';
import {
  applyAssetOverrides, getAssetOverrides, makeSubtreeResolvers, readAssetOverridesRecord,
  setAssetOverrides, setAssetReference,
} from '../src/core/engine/rv-asset-reference';
import { setNodeId } from '../src/core/engine/rv-node-id';
import { parseGlbChunks } from '../src/core/persistence/rv-glb-chunks';
import {
  bakeIntoGlb, makeRegistryBakeResolver, NestedTransformRefusedError, UnwritableTransformError,
} from '../src/core/hmi/scene/rv-scene-glb-bake';
import { materialise } from '../src/core/hmi/scene/rv-scene-edits';
import type { RvOp } from '../src/core/ops/rv-unified-ops';
import type { ReferenceResolver } from '../src/core/engine/rv-glb-compose';
import { guardReferenceOp } from '../src/core/ops/rv-reference-guard';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';

const material = new MeshStandardMaterial({ color: 0x445566 });
const RAM_ID = 'n-ram-0001';
const HOUSING_ID = 'n-housing-0001';

function meshNamed(name: string, extras?: Record<string, unknown>): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
  mesh.name = name;
  if (extras) mesh.userData.realvirtual = extras;
  return mesh;
}

/** The referenced asset: two parts with authored ids, one component-bearing. */
function buildPressTree(): Group {
  const press = new Group();
  press.name = 'Press';
  const ram = meshNamed('Ram', { Drive: { Direction: 'LinearY', TargetSpeed: 250 } });
  setNodeId(ram, RAM_ID);
  const housing = meshNamed('Housing');
  setNodeId(housing, HOUSING_ID);
  housing.position.set(0.5, 0, 0);
  press.add(ram, housing);
  return press;
}

/** The scene: own geometry plus one reference to the press; `overrides` = the raw stored record. */
function buildPlantTree(overrides?: Record<string, unknown>): Group {
  const plant = new Group();
  plant.name = 'Plant';
  plant.add(meshNamed('Floor', { Conveyor: { Speed: 100 } }));
  const reference = new Object3D();
  reference.name = 'Press_0';
  setAssetReference(reference, { assetId: 'press' });
  if (overrides) (reference.userData.realvirtual as Record<string, unknown>).AssetOverrides = overrides;
  plant.add(reference);
  return plant;
}

/** What plan-444 wrote: a component patch by NodeId plus two part moves. */
const OLD_RECORD = {
  byNodeId: { [RAM_ID]: { Drive: { TargetSpeed: 999 } } },
  trsByNodeId: {
    [RAM_ID]: { position: [1, 2, 3], quaternion: [0, 0, 0, 1] },
    [HOUSING_ID]: { position: [4, 5, 6] },
  },
};

let pressBytes: ArrayBuffer;

const pressResolver: ReferenceResolver = async () => ({
  bytes: pressBytes,
  url: 'lib/press.glb',
  sha256: 'sha-press',
  signatureState: 'none',
  signaturePresent: false,
});

function findByName(root: Object3D, name: string): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((n) => { if (!found && n.name === name) found = n; });
  return found;
}

async function load(bytes: ArrayBuffer | Uint8Array): Promise<LoadResult> {
  const source = bytes instanceof Uint8Array
    ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    : bytes.slice(0);
  return loadGLB('plant.glb', new Scene(), {
    data: source,
    referenceResolver: pressResolver,
    preserveHierarchy: true,
    loadKinematicsSidecar: false,
    sourceSha256: 'sha-plant',
  });
}

let opCounter = 0;
function op<T extends Omit<RvOp, 'id' | 'ts' | 'schemaV'>>(body: T): RvOp {
  return { id: `op_${++opCounter}`, ts: Date.now(), schemaV: 1, ...body } as unknown as RvOp;
}
const moveOp = (nodePath: string, position: [number, number, number]): RvOp => op({
  kind: 'transformNode', nodePath,
  transform: { position, quaternion: [0, 0, 0, 1] },
  prev: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
});
const setFieldOp = (nodePath: string, value: number): RvOp => op({
  kind: 'setField', nodePath, componentType: 'Drive', fieldName: 'TargetSpeed', value, prev: 250,
});

function jsonOf(glb: Uint8Array | ArrayBuffer): { nodes: Array<{ name?: string; extras?: Record<string, unknown> }> } {
  return parseGlbChunks(glb).json as { nodes: Array<{ name?: string; extras?: Record<string, unknown> }> };
}
function overridesOf(glb: Uint8Array | ArrayBuffer, nodeName: string): Record<string, unknown> | undefined {
  const node = jsonOf(glb).nodes.find((n) => n.name === nodeName);
  return (node?.extras?.realvirtual as Record<string, unknown> | undefined)?.AssetOverrides as Record<string, unknown> | undefined;
}

beforeEach(async () => {
  resetProblemsForTests();
  pressBytes = await objectToGlb(buildPressTree());
});

describe('9.10 a part move inside placed content is refused', () => {
  it('scene bake: a moved part of a referenced asset → NestedTransformRefusedError naming it and its placement; nothing written', async () => {
    const plantBytes = await objectToGlb(buildPlantTree());
    const result = await load(plantBytes);
    const resolver = makeRegistryBakeResolver(result.registry, result.composition?.frames ?? []);
    const ramPath = result.registry.getPathForNode(findByName(result.root, 'Ram')!)!;
    const pressPath = result.registry.getPathForNode(findByName(result.root, 'Press_0')!)!;
    const pressBefore = Array.from(new Uint8Array(pressBytes));

    let error: unknown;
    try {
      await bakeIntoGlb(plantBytes.slice(0), materialise([moveOp(ramPath, [1, 2, 3])]), resolver,
        { expectedNames: result.registry.getGltfNodeNames() });
    } catch (e) { error = e; }
    expect(error).toBeInstanceOf(NestedTransformRefusedError);
    expect(error).toBeInstanceOf(UnwritableTransformError);
    const refused = error as NestedTransformRefusedError;
    expect(refused.code).toBe('nested-transform-refused');
    expect(refused.paths).toEqual([ramPath]);
    expect(refused.owners).toEqual([pressPath]);
    expect(refused.message).toContain(ramPath);
    expect(refused.message).toContain('Inside placed content only component values can be changed');
    // …and one Problems entry per refused node, retired by the next save attempt.
    expect(getProblems().filter((p) => p.code === 'nested-transform-refused').map((p) => p.nodePath)).toEqual([ramPath]);
    await bakeIntoGlb(plantBytes.slice(0), materialise([]), resolver, { expectedNames: result.registry.getGltfNodeNames() });
    expect(getProblems().filter((p) => p.code === 'nested-transform-refused')).toEqual([]);
    // The referenced asset was never a write target.
    expect(Array.from(new Uint8Array(pressBytes))).toEqual(pressBefore);
  });

  it('a mix with an own-file move and a component override is refused as a whole — no partial write; the own move alone still saves', async () => {
    const plantBytes = await objectToGlb(buildPlantTree());
    const result = await load(plantBytes);
    const resolver = makeRegistryBakeResolver(result.registry, result.composition?.frames ?? []);
    const pathOf = (name: string): string => result.registry.getPathForNode(findByName(result.root, name)!)!;
    const expectedNames = result.registry.getGltfNodeNames();

    await expect(bakeIntoGlb(plantBytes.slice(0), materialise([
      moveOp(pathOf('Floor'), [0, 0, 2]),
      setFieldOp(pathOf('Ram'), 600),
      moveOp(pathOf('Ram'), [1, 2, 3]),
    ]), resolver, { expectedNames })).rejects.toBeInstanceOf(NestedTransformRefusedError);

    const own = await bakeIntoGlb(plantBytes.slice(0), materialise([
      moveOp(pathOf('Floor'), [0, 0, 2]),
      setFieldOp(pathOf('Ram'), 600),
    ]), resolver, { expectedNames });
    expect(own.transforms).toBe(1);
    expect(own.referenceOverrides).toBe(1);
    expect(overridesOf(own.glb, 'Press_0')).toEqual({ byAddress: { [`#${RAM_ID}`]: { Drive: { TargetSpeed: 600 } } } });
  });

  it('asset editor: transformNode on a node inside a reference stays a structural refusal', () => {
    const verdict = guardReferenceOp(moveOp('Press_0/Ram', [1, 2, 3]), () => ({ reference: new Object3D() }));
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe('structural-in-reference');
  });
});

describe('9.10 an old file with trsByNodeId loads, with a problem naming the count', () => {
  it('composed frame: the component patch is applied, the parts stay where the asset puts them, one problem with the count', async () => {
    const result = await load(await objectToGlb(buildPlantTree(OLD_RECORD)));
    const ram = findByName(result.root, 'Ram')!;
    const housing = findByName(result.root, 'Housing')!;
    expect((ram.userData.realvirtual as { Drive: { TargetSpeed: number } }).Drive.TargetSpeed).toBe(999);
    expect(ram.position.toArray()).toEqual([0, 0, 0]);
    expect(housing.position.toArray()).toEqual([0.5, 0, 0]);
    expect(result.orphanedOverrides).toEqual([]);

    const dropped = getProblems().filter((p) => p.code === 'override-transforms-dropped');
    expect(dropped).toHaveLength(1);
    expect(dropped[0].title).toContain('2 moved parts');
    expect(dropped[0].nodePath).toBe(result.registry.getPathForNode(findByName(result.root, 'Press_0')!));
    // The reference node holds the 769 form in memory: byAddress, no trsByNodeId / byNodeId.
    const live = findByName(result.root, 'Press_0')!.userData.realvirtual.AssetOverrides as Record<string, unknown>;
    expect(live).toEqual({ byAddress: { [`#${RAM_ID}`]: { Drive: { TargetSpeed: 999 } } } });
  });

  it('applyAssetOverrides: part moves are counted, never applied — over any resolver', () => {
    const overrides = readAssetOverridesRecord(OLD_RECORD)!;
    expect(overrides).toEqual({
      byAddress: { [`#${RAM_ID}`]: { Drive: { TargetSpeed: 999 } } },
      droppedTransforms: 2,
    });
    const press = buildPressTree();
    const result = applyAssetOverrides(overrides, makeSubtreeResolvers(press), { occurrence: 'occ', assetId: 'press' });
    expect(result.applied).toBe(1);
    expect(result.droppedTransforms).toBe(2);
    expect(press.getObjectByName('Ram')!.position.toArray()).toEqual([0, 0, 0]);
  });

  it('a record with ONLY part moves is still an override set (so the count is reported), but applies nothing', () => {
    const overrides = readAssetOverridesRecord({ trsByNodeId: OLD_RECORD.trsByNodeId })!;
    expect(overrides).toEqual({ byAddress: {}, droppedTransforms: 2 });
    const result = applyAssetOverrides(overrides, makeSubtreeResolvers(buildPressTree()), { occurrence: '', assetId: 'press' });
    expect(result).toMatchObject({ applied: 0, orphaned: [], droppedTransforms: 2 });
  });
});

describe('9.10 no writer emits trsByNodeId (or byNodeId) again', () => {
  it('scene bake of the old file with an edit on the same reference: byAddress only', async () => {
    const plantBytes = await objectToGlb(buildPlantTree(OLD_RECORD));
    const result = await load(plantBytes);
    const resolver = makeRegistryBakeResolver(result.registry, result.composition?.frames ?? []);
    const ramPath = result.registry.getPathForNode(findByName(result.root, 'Ram')!)!;
    const baked = await bakeIntoGlb(plantBytes.slice(0), materialise([setFieldOp(ramPath, 700)]), resolver,
      { expectedNames: result.registry.getGltfNodeNames() });
    expect(overridesOf(baked.glb, 'Press_0')).toEqual({ byAddress: { [`#${RAM_ID}`]: { Drive: { TargetSpeed: 700 } } } });
  });

  it('scene bake of the old file with an unrelated edit: the reference record is rewritten to the 769 form too', async () => {
    const plantBytes = await objectToGlb(buildPlantTree(OLD_RECORD));
    const result = await load(plantBytes);
    const resolver = makeRegistryBakeResolver(result.registry, result.composition?.frames ?? []);
    const floorPath = result.registry.getPathForNode(findByName(result.root, 'Floor')!)!;
    const baked = await bakeIntoGlb(plantBytes.slice(0), materialise([moveOp(floorPath, [0, 0, 1])]), resolver,
      { expectedNames: result.registry.getGltfNodeNames() });
    expect(overridesOf(baked.glb, 'Press_0')).toEqual({ byAddress: { [`#${RAM_ID}`]: { Drive: { TargetSpeed: 999 } } } });
    expect(JSON.stringify(jsonOf(baked.glb))).not.toContain('trsByNodeId');
  });

  it('editor export: a tree whose reference node still carries the raw old record exports byAddress only', async () => {
    const plant = buildPlantTree(OLD_RECORD);
    const glb = await exportAssetGlb(plant, 'Plant');
    const text = JSON.stringify(jsonOf(glb));
    expect(text).not.toContain('trsByNodeId');
    expect(text).not.toContain('byNodeId');
    expect(overridesOf(glb, 'Press_0')).toEqual({ byAddress: { [`#${RAM_ID}`]: { Drive: { TargetSpeed: 999 } } } });
  });

  it('setAssetOverrides writes byAddress (+ unresolved byPath), never byNodeId / trsByNodeId', () => {
    const node = new Object3D();
    setAssetOverrides(node, {
      byAddress: { '#a': { Drive: { TargetSpeed: 1 } } },
      legacyByPath: { 'Gone/Part': { Drive: { TargetSpeed: 2 } } },
      droppedTransforms: 3,
    });
    expect(node.userData.realvirtual.AssetOverrides).toEqual({
      byAddress: { '#a': { Drive: { TargetSpeed: 1 } } },
      byPath: { 'Gone/Part': { Drive: { TargetSpeed: 2 } } },
    });
    expect(getAssetOverrides(node)).toEqual({
      byAddress: { '#a': { Drive: { TargetSpeed: 1 } } },
      legacyByPath: { 'Gone/Part': { Drive: { TargetSpeed: 2 } } },
    });
  });
});
