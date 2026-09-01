// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-scene-glb-bake-move-in-reference.test.ts — plan-444 §9.2.
 *
 * The bake's category-5 decision, which plan-444 turned from a refusal into a
 * write. "Import a STEP, drag a part into place, save" ran into
 * `UnwritableTransformError` before, because a transform is glTF-native data on
 * `nodes[i]` and the override schema only spoke componentType → fields.
 *
 * Three outcomes have to stay apart, and this file is what keeps them apart:
 *
 *  - the node is in THIS file            → glTF-native TRS on `nodes[i]`;
 *  - the node is in a referenced file    → `AssetOverrides.trsByNodeId` on the
 *                                          reference node that owns it (F3);
 *  - the reference node is ITSELF inside a referenced file → still refused (F5),
 *    because the file we may write has nowhere to record the move.
 *
 * The last case is not a leftover to be tidied away later: writing into the
 * referenced asset instead would move the part in every other instance of that
 * assembly, which is exactly what the reference model exists to prevent.
 *
 * The final describe is the blast-radius guard the plan asked for: bake
 * categories 1, 3, 6 and 7 must come out of a run byte-identical to a run
 * without the transform, or the recategorisation quietly took something else
 * with it.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { loadGLB, type LoadResult } from '../src/core/engine/rv-scene-loader';
import { setAssetReference } from '../src/core/engine/rv-asset-reference';
import { parseGlbChunks } from '../src/core/persistence/rv-glb-chunks';
import {
  bakeIntoGlb,
  makeRegistryBakeResolver,
  UnwritableTransformError,
  type BakeResolver,
} from '../src/core/hmi/scene/rv-scene-glb-bake';
import { ModelSourceChangedError } from '../src/core/hmi/scene/rv-scene-settings-into-model';
import { materialise } from '../src/core/hmi/scene/rv-scene-edits';
import type { RvOp } from '../src/core/ops/rv-unified-ops';
import type { ReferenceResolver } from '../src/core/engine/rv-glb-compose';

const material = new MeshStandardMaterial({ color: 0x445566 });

function meshNamed(name: string, extras?: Record<string, unknown>): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
  mesh.name = name;
  if (extras) mesh.userData.realvirtual = extras;
  return mesh;
}

/** The referenced asset: two parts, one of them component-bearing. */
function buildPressTree(): Group {
  const press = new Group();
  press.name = 'Press';
  press.add(meshNamed('Ram', { Drive: { Direction: 'LinearY', TargetSpeed: 250 } }));
  press.add(meshNamed('Housing'));
  return press;
}

/** The scene: own geometry plus one reference to the press. */
function buildPlantTree(): Group {
  const plant = new Group();
  plant.name = 'Plant';
  plant.add(meshNamed('Floor', { Conveyor: { Speed: 100 } }));
  const reference = new Object3D();
  reference.name = 'Press_0';
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
  expectedNames: readonly (string | undefined)[];
}

async function harness(): Promise<Harness> {
  const result = await load(plantBytes);
  const resolver = makeRegistryBakeResolver(result.registry, result.composition?.frames ?? []);
  return {
    result,
    resolver,
    pathOf(name: string): string {
      const node = findByName(result.root, name);
      if (!node) throw new Error(`test fixture: no node named ${name}`);
      const path = result.registry.getPathForNode(node);
      if (!path) throw new Error(`test fixture: node ${name} is not registered`);
      return path;
    },
    expectedNames: result.registry.getGltfNodeNames(),
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

/** The `AssetOverrides` block a baked file carries on one named node. */
function overridesOf(glb: Uint8Array, nodeName: string): Record<string, unknown> | undefined {
  const json = parseGlbChunks(glb).json as {
    nodes: Array<{ name?: string; extras?: Record<string, unknown> }>;
  };
  const node = json.nodes.find((n) => n.name === nodeName);
  const rv = node?.extras?.realvirtual as Record<string, unknown> | undefined;
  return rv?.AssetOverrides as Record<string, unknown> | undefined;
}

beforeEach(async () => {
  pressBytes = await objectToGlb(buildPressTree());
  plantBytes = await objectToGlb(buildPlantTree());
});

// ─── The write that used to be a refusal ────────────────────────────────

describe('Verschieben eines Teils in einem referenzierten Asset (F3)', () => {
  it('schreibt die Bewegung als trsByNodeId-Eintrag auf den Referenzknoten', async () => {
    const h = await harness();
    const baked = await bakeIntoGlb(
      plantBytes,
      materialise([moveOp(h.pathOf('Ram'), [1, 2, 3])]),
      h.resolver,
      { expectedNames: h.expectedNames },
    );

    expect(baked.referenceTransforms).toBe(1);
    const overrides = overridesOf(baked.glb, 'Press_0')!;
    const trs = overrides.trsByNodeId as Record<string, { position: number[]; quaternion: number[] }>;
    const ids = Object.keys(trs);
    expect(ids).toHaveLength(1);
    expect(trs[ids[0]].position).toEqual([1, 2, 3]);
    expect(trs[ids[0]].quaternion).toEqual([0, 0, 0, 1]);
  });

  it('lässt das referenzierte Asset unangetastet', async () => {
    const h = await harness();
    const before = Array.from(new Uint8Array(pressBytes));
    await bakeIntoGlb(plantBytes, materialise([moveOp(h.pathOf('Ram'), [1, 2, 3])]), h.resolver, {});
    expect(Array.from(new Uint8Array(pressBytes))).toEqual(before);
  });

  it('zählt sie NICHT als eigenen Knoten-Transform', async () => {
    const h = await harness();
    const baked = await bakeIntoGlb(
      plantBytes, materialise([moveOp(h.pathOf('Ram'), [1, 2, 3])]), h.resolver, {},
    );
    // `transforms` is "nodes of THIS file that moved" and this file's own nodes
    // did not move. Folding the two together would report a fast-path rewrite
    // of geometry that never happened.
    expect(baked.transforms).toBe(0);
    expect(baked.path).toBe('fast');
    expect(baked.binChunkUnchanged).toBe(true);
  });

  it('koalesziert Mehrfach-Bewegungen desselben Knotens auf die finale TRS', async () => {
    const h = await harness();
    const ram = h.pathOf('Ram');
    const baked = await bakeIntoGlb(
      plantBytes,
      materialise([moveOp(ram, [1, 0, 0]), moveOp(ram, [2, 0, 0]), moveOp(ram, [3, 4, 5])]),
      h.resolver,
      {},
    );

    expect(baked.referenceTransforms).toBe(1);
    const trs = overridesOf(baked.glb, 'Press_0')!.trsByNodeId as Record<string, { position: number[] }>;
    expect(Object.keys(trs)).toHaveLength(1);
    expect(Object.values(trs)[0].position).toEqual([3, 4, 5]);
  });

  it('schreibt zwei bewegte Teile derselben Referenz in EINEN Block', async () => {
    const h = await harness();
    const baked = await bakeIntoGlb(
      plantBytes,
      materialise([moveOp(h.pathOf('Ram'), [1, 0, 0]), moveOp(h.pathOf('Housing'), [0, 1, 0])]),
      h.resolver,
      {},
    );
    expect(baked.referenceTransforms).toBe(2);
    expect(Object.keys(overridesOf(baked.glb, 'Press_0')!.trsByNodeId as object)).toHaveLength(2);
  });

  it('lässt Komponenten-Overrides derselben Referenz unberührt daneben stehen', async () => {
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

    const overrides = overridesOf(baked.glb, 'Press_0')!;
    // Siblings, never nested: a `trs` key INSIDE byNodeId would be read back as
    // a component type called "trs" and written into the part's extras.
    const byNodeId = overrides.byNodeId as Record<string, Record<string, unknown>>;
    const nodeId = Object.keys(byNodeId)[0];
    expect(byNodeId[nodeId]).toEqual({ Drive: { TargetSpeed: 999 } });
    expect(Object.keys(byNodeId[nodeId])).not.toContain('trs');
    expect((overrides.trsByNodeId as Record<string, unknown>)[nodeId]).toBeDefined();
  });

  it('ersetzt einen vorhandenen trs-Eintrag beim erneuten Speichern', async () => {
    const h = await harness();
    const once = await bakeIntoGlb(
      plantBytes, materialise([moveOp(h.pathOf('Ram'), [1, 1, 1])]), h.resolver, {},
    );
    const h2 = await harness();
    const twice = await bakeIntoGlb(
      once.glb, materialise([moveOp(h2.pathOf('Ram'), [9, 9, 9])]), h2.resolver, {},
    );

    const trs = overridesOf(twice.glb, 'Press_0')!.trsByNodeId as Record<string, { position: number[] }>;
    expect(Object.keys(trs)).toHaveLength(1);
    expect(Object.values(trs)[0].position).toEqual([9, 9, 9]);
  });

  it('bemerkt eine geänderte Quelldatei auch auf dem Referenzknoten', async () => {
    // The identity check must cover the OWNER index too — patching an override
    // onto whatever node now sits at that index is the silent corruption
    // `ModelSourceChangedError` exists to prevent.
    const h = await harness();
    const owner = h.resolver.locate(h.pathOf('Press_0')) as { kind: 'root'; index: number };
    const tampered = [...h.expectedNames];
    tampered[owner.index] = 'SomethingElse';

    await expect(bakeIntoGlb(
      plantBytes, materialise([moveOp(h.pathOf('Ram'), [1, 2, 3])]), h.resolver,
      { expectedNames: tampered },
    )).rejects.toBeInstanceOf(ModelSourceChangedError);
  });
});

// ─── The refusal that remains ───────────────────────────────────────────

describe('Der verschachtelte Fall bleibt eine Verweigerung (F5)', () => {
  /** Deep sits in Outer, and Outer itself came out of a referenced file. */
  const nestedResolver: BakeResolver = {
    locate(path) {
      if (path === 'Deep') {
        return { kind: 'referenced', referenceNodePath: 'Outer', nodeId: 'n1', sourceKey: 'sha-a' };
      }
      if (path === 'Outer') {
        return { kind: 'referenced', referenceNodePath: 'Root', nodeId: 'n2', sourceKey: 'sha-b' };
      }
      return null;
    },
  };

  it('wirft UnwritableTransformError, wenn der Referenzknoten selbst referenziert ist', async () => {
    await expect(bakeIntoGlb(plantBytes, materialise([moveOp('Deep', [1, 2, 3])]), nestedResolver, {}))
      .rejects.toBeInstanceOf(UnwritableTransformError);
  });

  /** The `UnwritableTransformError` a bake threw. Fails loudly if it did not. */
  async function refusalOf(...args: Parameters<typeof bakeIntoGlb>): Promise<UnwritableTransformError> {
    try {
      await bakeIntoGlb(...args);
    } catch (e) {
      expect(e).toBeInstanceOf(UnwritableTransformError);
      return e as UnwritableTransformError;
    }
    throw new Error('expected the bake to refuse, but it succeeded');
  }

  it('nennt den Knoten und den Ausweg im Meldungstext', async () => {
    // The dialog renders this string verbatim, so a user who cannot save has to
    // be able to read what to do from it alone.
    const error = await refusalOf(
      plantBytes, materialise([moveOp('Deep', [1, 2, 3])]), nestedResolver, {},
    );

    expect(error.paths).toEqual(['Deep']);
    expect(error.message).toContain('Deep');
    expect(error.message).toContain('Open the referenced asset');
  });

  it('wirft auch für einen Knoten, den der Resolver gar nicht kennt', async () => {
    await expect(bakeIntoGlb(
      plantBytes, materialise([moveOp('Ghost', [1, 2, 3])]), nestedResolver, {},
    )).rejects.toBeInstanceOf(UnwritableTransformError);
  });

  it('sammelt alle betroffenen Pfade, statt beim ersten abzubrechen', async () => {
    const error = await refusalOf(
      plantBytes,
      materialise([moveOp('Deep', [1, 0, 0]), moveOp('Ghost', [0, 1, 0])]),
      nestedResolver,
      {},
    );
    expect(error.paths).toEqual(['Deep', 'Ghost']);
  });

  it('schreibt bei einer Verweigerung KEINEN Teil-Override in die Bytes', async () => {
    // A bake that half-succeeds produces a file that looks complete and is not.
    const h = await harness();
    const mixed: BakeResolver = {
      locate(path) {
        if (path === 'Deep') {
          return { kind: 'referenced', referenceNodePath: 'Outer', nodeId: 'n1', sourceKey: 'sha-a' };
        }
        if (path === 'Outer') {
          return { kind: 'referenced', referenceNodePath: 'Root', nodeId: 'n2', sourceKey: 'sha-b' };
        }
        return h.resolver.locate(path);
      },
    };
    await expect(bakeIntoGlb(
      plantBytes,
      materialise([moveOp(h.pathOf('Ram'), [1, 2, 3]), moveOp('Deep', [4, 5, 6])]),
      mixed,
      {},
    )).rejects.toBeInstanceOf(UnwritableTransformError);
  });
});

// ─── Blast radius: the untouched categories ─────────────────────────────

describe('Unberührte Bake-Kategorien (1, 3, 6, 7)', () => {
  const connection = {
    id: 'c1', type: 'material', fromPath: 'Plant/Floor', toPath: 'Plant/Press_0',
  } as unknown as Parameters<typeof materialise>[0][number];

  /** Categories 1 + 3 + 6/7 in one edit set, deliberately without a move. */
  function mixedEdits(floorPath: string) {
    return [
      op({
        kind: 'setField', nodePath: floorPath,
        componentType: 'Conveyor', fieldName: 'Speed', value: 777, prev: 100,
      }),
      op({
        kind: 'setCamera',
        camera: { px: 1, py: 2, pz: 3, tx: 0, ty: 0, tz: 0 },
        prev: null,
      }),
      op({ kind: 'addConnection', connection }),
      op({
        kind: 'setConnectionType',
        connectionType: { type: 'material', color: '#fff' },
      }),
    ];
  }

  it('produziert dieselben JSON-Chunks mit und ohne zusätzliche Referenz-Bewegung', async () => {
    const h = await harness();
    const floor = h.pathOf('Floor');

    const withoutMove = await bakeIntoGlb(plantBytes, materialise(mixedEdits(floor)), h.resolver, {});
    const h2 = await harness();
    const withMove = await bakeIntoGlb(
      plantBytes,
      materialise([...mixedEdits(h2.pathOf('Floor')), moveOp(h2.pathOf('Ram'), [1, 2, 3])]),
      h2.resolver,
      {},
    );

    const a = parseGlbChunks(withoutMove.glb).json as Record<string, unknown>;
    const b = parseGlbChunks(withMove.glb).json as Record<string, unknown>;

    // The move is expected to show up in exactly ONE place — the reference
    // node's AssetOverrides. Strip it and the two files must be identical.
    const bNodes = b.nodes as Array<{ name?: string; extras?: Record<string, unknown> }>;
    const press = bNodes.find((n) => n.name === 'Press_0')!;
    const rv = press.extras!.realvirtual as Record<string, Record<string, unknown>>;
    expect(rv.AssetOverrides.trsByNodeId).toBeDefined();
    delete rv.AssetOverrides.trsByNodeId;
    // An overrides block that held nothing else is now an empty husk the
    // no-move run never wrote at all.
    if (Object.keys(rv.AssetOverrides.byNodeId ?? {}).length === 0) delete rv.AssetOverrides;

    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('lässt den BIN-Chunk in beiden Läufen unangetastet', async () => {
    const h = await harness();
    const baked = await bakeIntoGlb(
      plantBytes,
      materialise([...mixedEdits(h.pathOf('Floor')), moveOp(h.pathOf('Ram'), [1, 2, 3])]),
      h.resolver,
      {},
    );
    expect(baked.binChunkUnchanged).toBe(true);
    expect(baked.path).toBe('fast');
  });
});
