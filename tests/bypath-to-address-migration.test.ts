// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 test 9.22 — old `byPath` / `byNodeId` overrides become `byAddress` on read.
 *
 *  - **Read.** `byNodeId[id]` is the address `#id` of that node in the referenced
 *    asset; a `byAddress` entry for the same key wins field by field. `byPath` is
 *    kept as `legacyByPath` until it is applied.
 *  - **Apply = migrate.** A legacy path that resolves comes back with its address
 *    (`migratedPaths`) and the reference node holds the 769 form in memory, for a
 *    composed frame and a placement instance alike — and remembers the migration,
 *    so the scene save (which works on the file's JSON) writes `byAddress` only. An older layout record (in-memory form) normalises the same way.
 *  - **Asset changed between save and load.** An address or path whose node is gone
 *    is an `override-orphaned` problem — visible, and the unresolved path is kept
 *    (written back as `byPath`), never dropped.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { loadGLB, type LoadResult } from '../src/core/engine/rv-scene-loader';
import {
  getAssetOverrides, migrateLegacyOverridePaths, readAssetOverridesRecord, setAssetOverrides, setAssetReference,
} from '../src/core/engine/rv-asset-reference';
import { setNodeId } from '../src/core/engine/rv-node-id';
import { parseGlbChunks } from '../src/core/persistence/rv-glb-chunks';
import { bakeIntoGlb, makeRegistryBakeResolver } from '../src/core/hmi/scene/rv-scene-glb-bake';
import { materialise } from '../src/core/hmi/scene/rv-scene-edits';
import type { RvOp } from '../src/core/ops/rv-unified-ops';
import type { ReferenceResolver } from '../src/core/engine/rv-glb-compose';
import { countInstanceOverrides } from '../src/core/ops/rv-document-stack';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';

const material = new MeshStandardMaterial({ color: 0x445566 });
const RAM_ID = 'n-ram-922';
const CLAMP_ID = 'n-clamp-922';

function meshNamed(name: string, extras?: Record<string, unknown>): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
  mesh.name = name;
  if (extras) mesh.userData.realvirtual = extras;
  return mesh;
}

/** The referenced asset. `variant: 'changed'` = the same asset after its Clamp was deleted. */
function buildPressTree(variant: 'original' | 'changed' = 'original'): Group {
  const press = new Group();
  press.name = 'Press';
  const ram = meshNamed('Ram', { Drive: { Direction: 'LinearY', TargetSpeed: 250 } });
  setNodeId(ram, RAM_ID);
  press.add(ram);
  if (variant === 'original') {
    const clamp = meshNamed('Clamp', { Sensor: { Enabled: true } });
    setNodeId(clamp, CLAMP_ID);
    press.add(clamp);
  }
  return press;
}

/** The scene with ONE reference whose stored override record is `raw`. */
function buildPlantTree(raw: Record<string, unknown>): Group {
  const plant = new Group();
  plant.name = 'Plant';
  plant.add(meshNamed('Floor'));
  const reference = new Object3D();
  reference.name = 'Press_0';
  setAssetReference(reference, { assetId: 'press' });
  (reference.userData.realvirtual as Record<string, unknown>).AssetOverrides = raw;
  plant.add(reference);
  return plant;
}

let pressBytes: ArrayBuffer;
const pressResolver: ReferenceResolver = async () => ({
  bytes: pressBytes, url: 'lib/press.glb', sha256: 'sha-press', signatureState: 'none', signaturePresent: false,
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
    data: source, referenceResolver: pressResolver, preserveHierarchy: true,
    loadKinematicsSidecar: false, sourceSha256: 'sha-plant',
  });
}

let opCounter = 0;
const moveFloor = (nodePath: string): RvOp => ({
  id: `op_${++opCounter}`, ts: Date.now(), schemaV: 1,
  kind: 'transformNode', nodePath,
  transform: { position: [0, 0, 1], quaternion: [0, 0, 0, 1] },
  prev: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
} as unknown as RvOp);

function overridesOf(glb: Uint8Array | ArrayBuffer, nodeName: string): Record<string, unknown> | undefined {
  const json = parseGlbChunks(glb).json as { nodes: Array<{ name?: string; extras?: Record<string, unknown> }> };
  const node = json.nodes.find((n) => n.name === nodeName);
  return (node?.extras?.realvirtual as Record<string, unknown> | undefined)?.AssetOverrides as Record<string, unknown> | undefined;
}
const rvOf = (n: Object3D): Record<string, Record<string, unknown>> => n.userData.realvirtual as Record<string, Record<string, unknown>>;

/** An old layout: one override by NodeId, one by path. */
const OLD_LAYOUT = {
  byNodeId: { [RAM_ID]: { Drive: { TargetSpeed: 400 } } },
  byPath: { Clamp: { Sensor: { Enabled: false } } },
};

beforeEach(async () => {
  resetProblemsForTests();
  pressBytes = await objectToGlb(buildPressTree());
});

describe('9.22 read: byNodeId is "#id", byPath stays a legacy bridge', () => {
  it('byNodeId → byAddress["#id"], byPath → legacyByPath', () => {
    expect(readAssetOverridesRecord(OLD_LAYOUT)).toEqual({
      byAddress: { [`#${RAM_ID}`]: { Drive: { TargetSpeed: 400 } } },
      legacyByPath: { Clamp: { Sensor: { Enabled: false } } },
    });
  });

  it('a byAddress entry for the same node wins field by field over the legacy byNodeId', () => {
    expect(readAssetOverridesRecord({
      byNodeId: { [RAM_ID]: { Drive: { TargetSpeed: 1, Acceleration: 2 } } },
      byAddress: { [`#${RAM_ID}`]: { Drive: { TargetSpeed: 3 } } },
    })).toEqual({ byAddress: { [`#${RAM_ID}`]: { Drive: { TargetSpeed: 3, Acceleration: 2 } } } });
  });

  it('the in-memory form normalises to itself (an older layout record and a current one read the same)', () => {
    const current = readAssetOverridesRecord(OLD_LAYOUT)!;
    expect(readAssetOverridesRecord(current)).toEqual(current);
  });

  it('migrateLegacyOverridePaths moves a resolved path under its address; an existing byAddress entry wins', () => {
    const migrated = migrateLegacyOverridePaths({
      byAddress: { [`#${CLAMP_ID}`]: { Sensor: { Enabled: true } } },
      legacyByPath: { Clamp: { Sensor: { Enabled: false, Range: 5 } }, Gone: { Drive: { TargetSpeed: 1 } } },
    }, { Clamp: `#${CLAMP_ID}` });
    expect(migrated).toEqual({
      byAddress: { [`#${CLAMP_ID}`]: { Sensor: { Enabled: true, Range: 5 } } },
      legacyByPath: { Gone: { Drive: { TargetSpeed: 1 } } },
    });
  });
});

describe('9.22 apply = migrate (composed frame)', () => {
  it('both old forms reach their nodes; the reference node holds byAddress only; the save writes it; the reload applies the same values', async () => {
    const plantBytes = await objectToGlb(buildPlantTree(OLD_LAYOUT));
    const first = await load(plantBytes);
    expect(rvOf(findByName(first.root, 'Ram')!).Drive.TargetSpeed).toBe(400);
    expect(rvOf(findByName(first.root, 'Clamp')!).Sensor.Enabled).toBe(false);
    expect(first.orphanedOverrides).toEqual([]);

    const reference = findByName(first.root, 'Press_0')!;
    const migrated = {
      byAddress: {
        [`#${RAM_ID}`]: { Drive: { TargetSpeed: 400 } },
        [`#${CLAMP_ID}`]: { Sensor: { Enabled: false } },
      },
    };
    expect(rvOf(reference).AssetOverrides).toEqual(migrated);
    expect(countInstanceOverrides(reference)).toBe(2);

    // Saved through the scene bake (an unrelated edit keeps the full record path honest).
    const resolver = makeRegistryBakeResolver(first.registry, first.composition?.frames ?? []);
    const floorPath = first.registry.getPathForNode(findByName(first.root, 'Floor')!)!;
    const baked = await bakeIntoGlb(plantBytes.slice(0), materialise([moveFloor(floorPath)]), resolver,
      { expectedNames: first.registry.getGltfNodeNames() });
    // The saved file holds the migrated form: byNodeId → "#id" (JSON pass) and the
    // legacy byPath the live reference node resolved → its address (the node's
    // migration memo, plan-769 4b) — no path goes back into the file.
    expect(overridesOf(baked.glb, 'Press_0')).toEqual(migrated);
    expect(JSON.stringify(parseGlbChunks(baked.glb).json)).not.toContain('_rvOverridePathMigration');

    const second = await load(baked.glb);
    expect(rvOf(findByName(second.root, 'Ram')!).Drive.TargetSpeed).toBe(400);
    expect(rvOf(findByName(second.root, 'Clamp')!).Sensor.Enabled).toBe(false);
    expect(rvOf(findByName(second.root, 'Press_0')!).AssetOverrides).toEqual(migrated);
  });
});

describe('9.22 the asset changed between save and load', () => {
  it('an address and a path whose node is gone are override-orphaned problems; the path is kept for the next save', async () => {
    const plantBytes = await objectToGlb(buildPlantTree({
      byAddress: { [`#${CLAMP_ID}`]: { Sensor: { Enabled: false } } },
      byPath: { 'Clamp': { Sensor: { Range: 9 } } },
      byNodeId: { [RAM_ID]: { Drive: { TargetSpeed: 333 } } },
    }));
    pressBytes = await objectToGlb(buildPressTree('changed'));
    const result = await load(plantBytes);

    // What still has a target is applied.
    expect(rvOf(findByName(result.root, 'Ram')!).Drive.TargetSpeed).toBe(333);
    // What lost it is reported, by address and by path.
    expect(result.orphanedOverrides.map((o) => `${o.addressing}:${o.key}`).sort())
      .toEqual([`address:#${CLAMP_ID}`, 'path:Clamp']);
    const problems = getProblems().filter((p) => p.code === 'override-orphaned');
    expect(problems).toHaveLength(2);
    expect(problems.every((p) => p.nodePath === result.registry.getPathForNode(findByName(result.root, 'Press_0')!))).toBe(true);
    // Nothing is dropped: the orphaned entries stay on the reference node, in the 769 form.
    expect(rvOf(findByName(result.root, 'Press_0')!).AssetOverrides).toEqual({
      byAddress: {
        [`#${CLAMP_ID}`]: { Sensor: { Enabled: false } },
        [`#${RAM_ID}`]: { Drive: { TargetSpeed: 333 } },
      },
      byPath: { Clamp: { Sensor: { Range: 9 } } },
    });
  });
});

describe('9.22 setAssetOverrides round trip', () => {
  it('writes the 769 form and reads it back unchanged', () => {
    const node = new Object3D();
    setAssetOverrides(node, readAssetOverridesRecord(OLD_LAYOUT));
    expect(node.userData.realvirtual.AssetOverrides).toEqual({
      byAddress: { [`#${RAM_ID}`]: { Drive: { TargetSpeed: 400 } } },
      byPath: { Clamp: { Sensor: { Enabled: false } } },
    });
    expect(getAssetOverrides(node)).toEqual(readAssetOverridesRecord(OLD_LAYOUT));
  });
});
