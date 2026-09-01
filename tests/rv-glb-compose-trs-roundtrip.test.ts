// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-glb-compose-trs-roundtrip.test.ts — plan-444 §9.3.
 *
 * The half of F3/F4 the bake test cannot see. A transform override that is
 * written correctly and never read back is worth nothing: the user's part snaps
 * home on the next open and the file quietly holds a position nobody applies.
 *
 * So every case here goes the whole way — move → bake → real `loadGLB` → read
 * the WORLD position off the reloaded tree. World, not local, because that is
 * what the user sees; a local-only check would pass even if the override landed
 * on the wrong node of a subtree that happens to be at the origin.
 *
 * The `matrixWorld` case is the one worth naming. Composition hands the tree to
 * bounds computation, auto-align and the node registry before a single frame is
 * drawn, so a subtree left with a stale world matrix reads as "still at the old
 * position" to all three — a bug that would only appear as a wrong bounding box
 * and never as an error.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Scene, Vector3 } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { loadGLB, type LoadResult } from '../src/core/engine/rv-scene-loader';
import { setAssetReference } from '../src/core/engine/rv-asset-reference';
import { parseGlbChunks, rebuildGlbWithJson } from '../src/core/persistence/rv-glb-chunks';
import {
  bakeIntoGlb,
  makeRegistryBakeResolver,
  type BakeResolver,
} from '../src/core/hmi/scene/rv-scene-glb-bake';
import { materialise } from '../src/core/hmi/scene/rv-scene-edits';
import type { RvOp } from '../src/core/ops/rv-unified-ops';
import type { ReferenceResolver } from '../src/core/engine/rv-glb-compose';

const material = new MeshStandardMaterial({ color: 0x445566 });
const TOLERANCE = 1e-6;

function meshNamed(name: string, extras?: Record<string, unknown>): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
  mesh.name = name;
  if (extras) mesh.userData.realvirtual = extras;
  return mesh;
}

function buildPressTree(): Group {
  const press = new Group();
  press.name = 'Press';
  press.add(meshNamed('Ram', { Drive: { Direction: 'LinearY', TargetSpeed: 250 } }));
  press.add(meshNamed('Housing'));
  return press;
}

/** The reference sits at a non-zero offset, so world ≠ local by construction. */
function buildPlantTree(): Group {
  const plant = new Group();
  plant.name = 'Plant';
  plant.add(meshNamed('Floor', { Conveyor: { Speed: 100 } }));
  const reference = new Object3D();
  reference.name = 'Press_0';
  reference.position.set(10, 0, 20);
  setAssetReference(reference, { assetId: 'press' });
  plant.add(reference);
  return plant;
}

let pressBytes: ArrayBuffer;
let plantBytes: ArrayBuffer;

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

interface Harness {
  result: LoadResult;
  resolver: BakeResolver;
  pathOf(name: string): string;
}

async function harness(bytes: ArrayBuffer | Uint8Array = plantBytes): Promise<Harness> {
  const result = await load(bytes);
  return {
    result,
    resolver: makeRegistryBakeResolver(result.registry, result.composition?.frames ?? []),
    pathOf(name: string): string {
      const node = findByName(result.root, name);
      if (!node) throw new Error(`test fixture: no node named ${name}`);
      const path = result.registry.getPathForNode(node);
      if (!path) throw new Error(`test fixture: node ${name} is not registered`);
      return path;
    },
  };
}

let opCounter = 0;
function op<T extends Omit<RvOp, 'id' | 'ts' | 'schemaV'>>(body: T): RvOp {
  return { id: `op_${++opCounter}`, ts: Date.now(), schemaV: 1, ...body } as unknown as RvOp;
}

function moveOp(nodePath: string, position: [number, number, number],
  quaternion: [number, number, number, number] = [0, 0, 0, 1]): RvOp {
  return op({
    kind: 'transformNode', nodePath,
    transform: { position, quaternion },
    prev: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
  });
}

function worldPositionOf(result: LoadResult, name: string): Vector3 {
  const node = findByName(result.root, name);
  if (!node) throw new Error(`no node named ${name} after reload`);
  node.updateWorldMatrix(true, false);
  return node.getWorldPosition(new Vector3());
}

function expectClose(actual: Vector3, expected: [number, number, number]): void {
  expect(actual.x).toBeCloseTo(expected[0], 6);
  expect(actual.y).toBeCloseTo(expected[1], 6);
  expect(actual.z).toBeCloseTo(expected[2], 6);
}

beforeEach(async () => {
  pressBytes = await objectToGlb(buildPressTree());
  plantBytes = await objectToGlb(buildPlantTree());
});

// ─── The round trip ─────────────────────────────────────────────────────

describe('Verschieben → Speichern → Laden (F4)', () => {
  it('bringt das Teil an genau derselben Weltposition zurück', async () => {
    const h = await harness();
    const before = worldPositionOf(h.result, 'Ram');
    expectClose(before, [10, 0, 20]);

    const baked = await bakeIntoGlb(
      plantBytes, materialise([moveOp(h.pathOf('Ram'), [1, 2, 3])]), h.resolver, {},
    );
    const reloaded = await load(baked.glb);

    // The reference is at (10, 0, 20) and the override moves the part to
    // (1, 2, 3) INSIDE the referenced file — so the world position is the sum.
    expectClose(worldPositionOf(reloaded, 'Ram'), [11, 2, 23]);
  });

  it('meldet dabei keinen verwaisten Override', async () => {
    const h = await harness();
    const baked = await bakeIntoGlb(
      plantBytes, materialise([moveOp(h.pathOf('Ram'), [1, 2, 3])]), h.resolver, {},
    );
    expect((await load(baked.glb)).composition?.orphanedOverrides ?? []).toHaveLength(0);
  });

  it('lässt die Geschwister des bewegten Teils stehen', async () => {
    const h = await harness();
    const baked = await bakeIntoGlb(
      plantBytes, materialise([moveOp(h.pathOf('Ram'), [1, 2, 3])]), h.resolver, {},
    );
    const reloaded = await load(baked.glb);
    // An override that reached the wrong node — or all of them — is the failure
    // this pins; Housing was never touched.
    expectClose(worldPositionOf(reloaded, 'Housing'), [10, 0, 20]);
  });

  it('aktualisiert matrixWorld sofort, nicht erst beim ersten Frame', async () => {
    const h = await harness();
    const baked = await bakeIntoGlb(
      plantBytes, materialise([moveOp(h.pathOf('Ram'), [4, 5, 6])]), h.resolver, {},
    );
    const reloaded = await load(baked.glb);

    // Read matrixWorld WITHOUT asking for an update first: everything the load
    // path hands the tree to (bounds, auto-align, the registry) does exactly
    // this, and a stale matrix there is a wrong bounding box with no error.
    const ram = findByName(reloaded.root, 'Ram')!;
    const world = new Vector3().setFromMatrixPosition(ram.matrixWorld);
    expectClose(world, [14, 5, 26]);
  });

  it('überlebt eine zweite Runde (laden → erneut verschieben → speichern → laden)', async () => {
    const h1 = await harness();
    const once = await bakeIntoGlb(
      plantBytes, materialise([moveOp(h1.pathOf('Ram'), [1, 0, 0])]), h1.resolver, {},
    );

    const h2 = await harness(once.glb);
    expectClose(worldPositionOf(h2.result, 'Ram'), [11, 0, 20]);
    const twice = await bakeIntoGlb(
      once.glb, materialise([moveOp(h2.pathOf('Ram'), [0, 7, 0])]), h2.resolver, {},
    );

    expectClose(worldPositionOf(await load(twice.glb), 'Ram'), [10, 7, 20]);
  });

  it('trägt Komponenten-Override und Bewegung gemeinsam durch den Roundtrip', async () => {
    const h = await harness();
    const baked = await bakeIntoGlb(
      plantBytes,
      materialise([
        op({
          kind: 'setField', nodePath: h.pathOf('Ram'),
          componentType: 'Drive', fieldName: 'TargetSpeed', value: 999, prev: 250,
        }),
        moveOp(h.pathOf('Ram'), [1, 2, 3]),
      ]),
      h.resolver,
      {},
    );

    const reloaded = await load(baked.glb);
    const ram = findByName(reloaded.root, 'Ram')!;
    expectClose(worldPositionOf(reloaded, 'Ram'), [11, 2, 23]);
    const rv = ram.userData.realvirtual as Record<string, Record<string, unknown>>;
    expect(rv.Drive.TargetSpeed).toBe(999);
    // The sibling block must never surface as a component on the target node.
    expect(rv.trs).toBeUndefined();
    expect(rv.trsByNodeId).toBeUndefined();
  });
});

// ─── Undo after save ────────────────────────────────────────────────────

describe('Undo NACH dem Speichern', () => {
  it('stellt die Live-Transform wieder her und der Folge-Save schreibt sie mit', async () => {
    const h = await harness();
    const ram = h.pathOf('Ram');

    const moved = await bakeIntoGlb(plantBytes, materialise([moveOp(ram, [1, 2, 3])]), h.resolver, {});
    expect(moved.referenceTransforms).toBe(1);

    // Undo is an op-log operation: the move op is gone from the log, so the
    // NEXT materialise carries the original transform, not the moved one. The
    // file follows the log — that is the whole contract, and it is why an undo
    // after a save is not a special case anywhere in the writer.
    const h2 = await harness(moved.glb);
    const undone = await bakeIntoGlb(
      moved.glb, materialise([moveOp(h2.pathOf('Ram'), [0, 0, 0])]), h2.resolver, {},
    );

    const reloaded = await load(undone.glb);
    expectClose(worldPositionOf(reloaded, 'Ram'), [10, 0, 20]);
  });

  it('lässt eine Datei ohne neuen Move den vorhandenen Override behalten', async () => {
    const h = await harness();
    const moved = await bakeIntoGlb(
      plantBytes, materialise([moveOp(h.pathOf('Ram'), [1, 2, 3])]), h.resolver, {},
    );

    // A save that touches something else entirely must not disturb the stored
    // move — the file is the truth for everything the current op log is silent
    // about.
    const h2 = await harness(moved.glb);
    const other = await bakeIntoGlb(
      moved.glb,
      materialise([op({
        kind: 'setField', nodePath: h2.pathOf('Floor'),
        componentType: 'Conveyor', fieldName: 'Speed', value: 5, prev: 100,
      })]),
      h2.resolver,
      {},
    );

    expectClose(worldPositionOf(await load(other.glb), 'Ram'), [11, 2, 23]);
  });
});

// ─── Backward compatibility (F6) ────────────────────────────────────────

describe('Dateien ohne trsByNodeId', () => {
  it('laden byte-identisch zu vorher', async () => {
    const h = await harness();
    const baked = await bakeIntoGlb(
      plantBytes,
      materialise([op({
        kind: 'setField', nodePath: h.pathOf('Floor'),
        componentType: 'Conveyor', fieldName: 'Speed', value: 777, prev: 100,
      })]),
      h.resolver,
      {},
    );

    const json = parseGlbChunks(baked.glb).json as {
      nodes: Array<{ name?: string; extras?: Record<string, unknown> }>;
    };
    // No transform edit, so the field must not appear anywhere — an empty block
    // written "just in case" is schema noise every older viewer has to skip.
    expect(JSON.stringify(json)).not.toContain('trsByNodeId');

    expectClose(worldPositionOf(await load(baked.glb), 'Ram'), [10, 0, 20]);
  });

  it('ignorieren einen unbrauchbaren trs-Eintrag statt zu scheitern', async () => {
    // A file from a build that wrote the field differently, or a hand-edited
    // one. Defensive parsing means the rest of the model still loads.
    const chunks = parseGlbChunks(plantBytes);
    const nodes = (chunks.json as { nodes: Array<{ name?: string; extras?: Record<string, unknown> }> }).nodes;
    const press = nodes.find((n) => n.name === 'Press_0')!;
    const rv = (press.extras!.realvirtual ??= {}) as Record<string, unknown>;
    rv.AssetOverrides = { byNodeId: {}, trsByNodeId: { unknown_id: { position: 'over there' } } };

    const reloaded = await load(rebuildGlbWithJson(chunks));
    expectClose(worldPositionOf(reloaded, 'Ram'), [10, 0, 20]);
    // Unparseable, so it is not even an orphan — there is no override left to
    // be orphaned by the time resolution runs.
    expect(reloaded.composition?.orphanedOverrides ?? []).toHaveLength(0);
  });

  it('melden einen trs-Override auf einem verschwundenen Knoten als Orphan', async () => {
    const chunks = parseGlbChunks(plantBytes);
    const nodes = (chunks.json as { nodes: Array<{ name?: string; extras?: Record<string, unknown> }> }).nodes;
    const press = nodes.find((n) => n.name === 'Press_0')!;
    const rv = (press.extras!.realvirtual ??= {}) as Record<string, unknown>;
    rv.AssetOverrides = { byNodeId: {}, trsByNodeId: { deadbeefdeadbeef: { position: [1, 2, 3] } } };

    const reloaded = await load(rebuildGlbWithJson(chunks));
    const orphans = reloaded.composition?.orphanedOverrides ?? [];
    expect(orphans).toHaveLength(1);
    expect(orphans[0].addressing).toBe('trs');
    expect(orphans[0].key).toBe('deadbeefdeadbeef');
    expect(orphans[0].assetId).toBe('press');
  });
});
