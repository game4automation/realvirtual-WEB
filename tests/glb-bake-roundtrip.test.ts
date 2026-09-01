// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * glb-bake-roundtrip.test.ts — plan-397 Phase 4, plan §9.4.
 *
 * The plan's most important test. `materialise()` produces seven categories and
 * the old writer persisted exactly one of them, so six kinds of user work were
 * lost the moment the op log went away. Each case here bakes ONE category into a
 * GLB, reloads the bytes through the real `loadGLB`, and compares the RUNTIME
 * state that comes back.
 *
 * Comparing against `materialise(ops)` would be meaningless (review finding 11):
 * after a load there is no op log left to derive the same structure from. The
 * projection is therefore taken from the loaded tree — the state a user would
 * actually see — or, where the point is the file's shape rather than its
 * behaviour, from the GLB JSON itself.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Scene,
  type Quaternion,
} from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { loadGLB, type LoadResult } from '../src/core/engine/rv-scene-loader';
import {
  getAssetReference,
  getPlacementMeta,
  getSceneCamera,
  setAssetReference,
} from '../src/core/engine/rv-asset-reference';
import {
  readPlacementsFromScene,
  readSceneSettingsFromScene,
} from '../src/core/hmi/scene/rv-scene-glb-read';
import type { PlacedComponent } from '../src/plugins/layout-planner/rv-layout-store';
import { getNodeId } from '../src/core/engine/rv-node-id';
import { parseGlbChunks, rebuildGlbWithJson, defaultSceneExtras } from '../src/core/persistence/rv-glb-chunks';
import {
  bakeIntoGlb,
  bakeRequiresFullPath,
  bakeIsEmpty,
  makeRegistryBakeResolver,
  ReferencedFileWriteError,
  SaveReferenceCycleError,
  type BakeResolver,
} from '../src/core/hmi/scene/rv-scene-glb-bake';
import { ModelSourceChangedError } from '../src/core/hmi/scene/rv-scene-settings-into-model';
import { materialise, type MaterialisedEdits } from '../src/core/hmi/scene/rv-scene-edits';
import type { RvOp } from '../src/core/ops/rv-unified-ops';
import type { ReferenceResolver } from '../src/core/engine/rv-glb-compose';
import type { RvConnection, ConnectionType } from '../src/core/engine/rv-connection-registry';

const material = new MeshStandardMaterial({ color: 0x445566 });

function meshNamed(name: string, extras?: Record<string, unknown>): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
  mesh.name = name;
  if (extras) mesh.userData.realvirtual = extras;
  return mesh;
}

/** The referenced asset — one drive-bearing part, so an override has a target. */
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
  plant.add(meshNamed('Motor'));
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

/** Load bytes through the real loader, with the press reference resolvable. */
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

async function harness(bytes: ArrayBuffer | Uint8Array = plantBytes): Promise<Harness> {
  const result = await load(bytes);
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
/** An op with the boilerplate header filled in — the tests only care about the payload. */
function op<T extends Omit<RvOp, 'id' | 'ts' | 'schemaV'>>(body: T): RvOp {
  return { id: `op_${++opCounter}`, ts: Date.now(), schemaV: 1, ...body } as unknown as RvOp;
}

function emptyEdits(): MaterialisedEdits {
  return materialise([]);
}

beforeEach(async () => {
  pressBytes = await objectToGlb(buildPressTree());
  plantBytes = await objectToGlb(buildPlantTree());
});

// ─── The seven categories ────────────────────────────────────────────────

describe('Bake-Round-Trip über alle 7 Kategorien', () => {
  it('Kategorie 1 overlay: ein Feld überlebt Bake und Reload', async () => {
    const h = await harness();
    const edits = materialise([op({
      kind: 'setField',
      nodePath: h.pathOf('Floor'),
      componentType: 'Conveyor',
      fieldName: 'Speed',
      value: 777,
      prev: 100,
    })]);

    const baked = await bakeIntoGlb(plantBytes, edits, h.resolver, { expectedNames: h.expectedNames });
    expect(baked.path).toBe('fast');

    const reloaded = await load(baked.glb);
    const floor = findByName(reloaded.root, 'Floor')!;
    expect((floor.userData.realvirtual as Record<string, Record<string, unknown>>).Conveyor.Speed)
      .toBe(777);
  });

  it('Kategorie 1 overlay: null löscht das Feld (RFC 7396)', async () => {
    const h = await harness();
    const edits = materialise([op({
      kind: 'setField',
      nodePath: h.pathOf('Floor'),
      componentType: 'Conveyor',
      fieldName: 'Speed',
      value: null,
      prev: 100,
    })]);

    const baked = await bakeIntoGlb(plantBytes, edits, h.resolver, { expectedNames: h.expectedNames });
    const reloaded = await load(baked.glb);
    const floor = findByName(reloaded.root, 'Floor')!;
    const rv = floor.userData.realvirtual as Record<string, Record<string, unknown>>;
    expect(rv.Conveyor).toBeDefined();
    expect('Speed' in rv.Conveyor).toBe(false);
  });

  it('Kategorie 2 placements: wird ein AssetReference-Knoten mit TRS', async () => {
    const h = await harness();
    const edits = materialise([op({
      kind: 'addPlacement',
      placement: {
        id: 'plc_press_1',
        catalogId: 'press',
        glbUrl: 'lib/press.glb',
        label: 'Presse_02',
        position: [1000, 0, -250],
        rotation: [0, 90, 0],
        scale: [1, 1, 1],
      },
    })]);

    const baked = await bakeIntoGlb(plantBytes, edits, h.resolver, { expectedNames: h.expectedNames });
    expect(baked.path).toBe('full');
    expect(baked.placements).toBe(1);

    const reloaded = await load(baked.glb);
    const placed = findByName(reloaded.root, 'Presse_02')!;
    expect(placed).toBeTruthy();
    // The reference resolved: the referenced file's content is under it.
    expect(findByName(placed, 'Ram')).toBeTruthy();
    expect(getAssetReference(placed)?.assetId).toBe('press');
    // The placement id became the node's stable identity.
    expect(getNodeId(placed)).toBe('plc_press_1');
    expect(placed.position.toArray()).toEqual([1000, 0, -250]);
    expect(placed.rotation.y).toBeCloseTo(Math.PI / 2, 6);
  });

  it('Kategorie 3 cameraStart: überlebt inklusive duration/savedAt/source', async () => {
    const h = await harness();
    const edits = materialise([op({
      kind: 'setCamera',
      preset: {
        px: 1, py: 2, pz: 3, tx: 4, ty: 5, tz: 6,
        duration: 2.5, savedAt: 1_700_000_000_000, source: 'user',
      },
      prev: null,
    })]);

    const baked = await bakeIntoGlb(plantBytes, edits, h.resolver, { expectedNames: h.expectedNames });
    expect(baked.cameraWritten).toBe(true);

    const reloaded = await load(baked.glb);
    expect(getSceneCamera(reloaded.root)).toEqual({
      px: 1, py: 2, pz: 3, tx: 4, ty: 5, tz: 6,
      duration: 2.5, savedAt: 1_700_000_000_000, source: 'user',
    });
  });

  it('Kategorie 4 addedNodes: wird ein echter glTF-Knoten mit Komponenten', async () => {
    const h = await harness();
    const parentPath = h.pathOf('Plant');
    const edits = materialise([op({
      kind: 'addNode',
      nodePath: `${parentPath}/Waypoint`,
      spec: {
        parentPath,
        name: 'Waypoint',
        position: [10, 20, 30],
        quaternion: [0, 0, 0, 1],
        scale: [1, 1, 1],
        components: { IKTarget: { BlendRadius: 25 } },
      },
    })]);

    const baked = await bakeIntoGlb(plantBytes, edits, h.resolver, { expectedNames: h.expectedNames });
    expect(baked.path).toBe('full');
    expect(baked.addedNodes).toBe(1);

    const reloaded = await load(baked.glb);
    const waypoint = findByName(reloaded.root, 'Waypoint')!;
    expect(waypoint).toBeTruthy();
    expect(waypoint.parent?.name).toBe('Plant');
    expect(waypoint.position.toArray()).toEqual([10, 20, 30]);
    expect((waypoint.userData.realvirtual as Record<string, Record<string, unknown>>).IKTarget)
      .toEqual({ BlendRadius: 25 });
  });

  it('Kategorie 5 nodeTransforms: wird glTF-nativ als TRS geschrieben', async () => {
    const h = await harness();
    const q: [number, number, number, number] = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
    const edits = materialise([op({
      kind: 'transformNode',
      nodePath: h.pathOf('Motor'),
      transform: { position: [5, 6, 7], quaternion: q },
      prev: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
    })]);

    const baked = await bakeIntoGlb(plantBytes, edits, h.resolver, { expectedNames: h.expectedNames });
    expect(baked.path).toBe('fast');
    expect(baked.transforms).toBe(1);

    // GLB-JSON projection: TRS, not a component in extras.
    const json = parseGlbChunks(baked.glb).json as { nodes: Array<{ name?: string; translation?: number[] }> };
    const motorJson = json.nodes.find((n) => n.name === 'Motor')!;
    expect(motorJson.translation).toEqual([5, 6, 7]);

    const reloaded = await load(baked.glb);
    const motor = findByName(reloaded.root, 'Motor')!;
    expect(motor.position.toArray()).toEqual([5, 6, 7]);
    const rotation = motor.quaternion as Quaternion;
    expect(rotation.y).toBeCloseTo(Math.SQRT1_2, 6);
    expect(rotation.w).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('Kategorie 6 connections: die Kante steht im Connections-Block', async () => {
    const h = await harness();
    const edge: RvConnection = {
      id: 'edge_1',
      source: h.pathOf('Floor'),
      target: h.pathOf('Motor'),
      type: 'StopOnExit',
      config: { ProcessTime: 3 },
    };
    const edits = materialise([op({ kind: 'addConnection', connection: edge })]);

    const baked = await bakeIntoGlb(plantBytes, edits, h.resolver, { expectedNames: h.expectedNames });
    expect(baked.connections).toBe(1);

    const reloaded = await load(baked.glb);
    expect(collectConnections(reloaded.root).connections).toEqual([edge]);
  });

  it('Kategorie 7 connectionTypes: die Signatur steht im selben Block', async () => {
    const h = await harness();
    const type: ConnectionType = {
      type: 'Handover',
      request: { Part: 'string' },
      response: { Ok: 'bool' },
    };
    const edits = materialise([op({ kind: 'setConnectionType', connectionType: type, prev: undefined })]);

    const baked = await bakeIntoGlb(plantBytes, edits, h.resolver, { expectedNames: h.expectedNames });
    expect(baked.connectionTypes).toBe(1);

    const reloaded = await load(baked.glb);
    expect(collectConnections(reloaded.root).connectionTypes).toEqual([type]);
  });

  it('schreibt alle sieben Kategorien in einem Durchlauf', async () => {
    const h = await harness();
    const parentPath = h.pathOf('Plant');
    const edits = materialise([
      op({
        kind: 'setField', nodePath: h.pathOf('Floor'),
        componentType: 'Conveyor', fieldName: 'Speed', value: 42, prev: 100,
      }),
      op({
        kind: 'addPlacement',
        placement: {
          id: 'plc_1', catalogId: 'press', glbUrl: 'lib/press.glb', label: 'Presse_A',
          position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        },
      }),
      op({ kind: 'setCamera', preset: { px: 9, py: 9, pz: 9, tx: 0, ty: 0, tz: 0 }, prev: null }),
      op({
        kind: 'addNode', nodePath: `${parentPath}/Marker`,
        spec: {
          parentPath, name: 'Marker',
          position: [1, 1, 1], quaternion: [0, 0, 0, 1], scale: [1, 1, 1],
          components: { IKTarget: {} },
        },
      }),
      op({
        kind: 'transformNode', nodePath: h.pathOf('Motor'),
        transform: { position: [2, 0, 0], quaternion: [0, 0, 0, 1] },
        prev: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
      }),
      op({
        kind: 'addConnection',
        connection: { id: 'e1', source: 'Floor', target: 'Motor', type: 'StopOnExit' },
      }),
      op({ kind: 'setConnectionType', connectionType: { type: 'Handover' }, prev: undefined }),
    ]);

    const baked = await bakeIntoGlb(plantBytes, edits, h.resolver, { expectedNames: h.expectedNames });
    const reloaded = await load(baked.glb);

    const floor = findByName(reloaded.root, 'Floor')!;
    expect((floor.userData.realvirtual as Record<string, Record<string, unknown>>).Conveyor.Speed).toBe(42);
    expect(findByName(reloaded.root, 'Presse_A')).toBeTruthy();
    expect(getSceneCamera(reloaded.root)?.px).toBe(9);
    expect(findByName(reloaded.root, 'Marker')).toBeTruthy();
    expect(findByName(reloaded.root, 'Motor')!.position.x).toBe(2);
    const parsed = collectConnections(reloaded.root);
    expect(parsed.connections.map((c) => c.id)).toEqual(['e1']);
    expect(parsed.connectionTypes.map((t) => t.type)).toEqual(['Handover']);
  });
});

// ─── Path selection ──────────────────────────────────────────────────────

describe('Schnell-/Vollpfad-Weiche an der materialisierten Struktur', () => {
  it('wählt den Schnellpfad, wenn keine strukturelle Kategorie befüllt ist', async () => {
    const h = await harness();
    const edits = materialise([op({
      kind: 'setField', nodePath: h.pathOf('Floor'),
      componentType: 'Conveyor', fieldName: 'Speed', value: 1, prev: 100,
    })]);
    expect(bakeRequiresFullPath(edits)).toBe(false);

    const baked = await bakeIntoGlb(plantBytes, edits, h.resolver, { expectedNames: h.expectedNames });
    expect(baked.path).toBe('fast');
    expect(baked.binChunkUnchanged).toBe(true);
  });

  it('lässt den BIN-Chunk auf dem Schnellpfad byte-identisch', async () => {
    const h = await harness();
    const edits = materialise([op({
      kind: 'setField', nodePath: h.pathOf('Floor'),
      componentType: 'Conveyor', fieldName: 'Speed', value: 1, prev: 100,
    })]);
    const baked = await bakeIntoGlb(plantBytes, edits, h.resolver, { expectedNames: h.expectedNames });

    const before = new Uint8Array(plantBytes);
    const beforeTail = before.subarray(parseGlbChunks(before).restOffset);
    const afterTail = baked.glb.subarray(parseGlbChunks(baked.glb).restOffset);
    expect(afterTail.byteLength).toBe(beforeTail.byteLength);
    expect(Array.from(afterTail.subarray(0, 256)))
      .toEqual(Array.from(beforeTail.subarray(0, 256)));
  });

  it('wählt den Vollpfad bei addPlacement', async () => {
    const h = await harness();
    const edits = materialise([op({
      kind: 'addPlacement',
      placement: {
        id: 'plc_1', catalogId: 'press', glbUrl: 'lib/press.glb', label: 'P',
        position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
      },
    })]);
    expect(bakeRequiresFullPath(edits)).toBe(true);

    const baked = await bakeIntoGlb(plantBytes, edits, h.resolver, { expectedNames: h.expectedNames });
    expect(baked.path).toBe('full');
    expect(baked.binChunkUnchanged).toBe(false);
  });

  it('wählt den Vollpfad bei addNode', async () => {
    const h = await harness();
    const parentPath = h.pathOf('Plant');
    const edits = materialise([op({
      kind: 'addNode', nodePath: `${parentPath}/X`,
      spec: {
        parentPath, name: 'X',
        position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], components: {},
      },
    })]);
    expect(bakeRequiresFullPath(edits)).toBe(true);
    expect((await bakeIntoGlb(plantBytes, edits, h.resolver, {})).path).toBe('full');
  });

  it('erkennt einen leeren Editstand', () => {
    expect(bakeIsEmpty(emptyEdits())).toBe(true);
  });
});

// ─── The referenced file is never written to ─────────────────────────────

describe('Overrides auf referenzierte Knoten', () => {
  it('schreibt einen Override auf einen referenzierten Knoten NICHT in die Quelldatei', async () => {
    const h = await harness();
    const ramPath = h.pathOf('Ram');
    const edits = materialise([op({
      kind: 'setField', nodePath: ramPath,
      componentType: 'Drive', fieldName: 'TargetSpeed', value: 999, prev: 250,
    })]);

    const pressBefore = new Uint8Array(pressBytes).slice();
    const baked = await bakeIntoGlb(plantBytes, edits, h.resolver, { expectedNames: h.expectedNames });
    expect(baked.referenceOverrides).toBe(1);

    // The referenced file is untouched — structurally, because the bake only
    // ever receives the root file's bytes.
    expect(Array.from(new Uint8Array(pressBytes))).toEqual(Array.from(pressBefore));

    // And the override sits on the reference node, keyed by the NodeId the
    // referenced file's bytes derive.
    const json = parseGlbChunks(baked.glb).json as {
      nodes: Array<{ name?: string; extras?: Record<string, unknown> }>;
    };
    const referenceJson = json.nodes.find((n) => n.name === 'Press_0')!;
    const rv = referenceJson.extras!.realvirtual as Record<string, Record<string, unknown>>;
    const byNodeId = rv.AssetOverrides.byNodeId as Record<string, Record<string, unknown>>;
    const ids = Object.keys(byNodeId);
    expect(ids).toHaveLength(1);
    expect(byNodeId[ids[0]]).toEqual({ Drive: { TargetSpeed: 999 } });
  });

  it('der Override kommt beim Reload am richtigen Knoten an', async () => {
    const h = await harness();
    const edits = materialise([op({
      kind: 'setField', nodePath: h.pathOf('Ram'),
      componentType: 'Drive', fieldName: 'TargetSpeed', value: 999, prev: 250,
    })]);

    const baked = await bakeIntoGlb(plantBytes, edits, h.resolver, { expectedNames: h.expectedNames });
    const reloaded = await load(baked.glb);
    const ram = findByName(reloaded.root, 'Ram')!;
    expect((ram.userData.realvirtual as Record<string, Record<string, unknown>>).Drive.TargetSpeed)
      .toBe(999);
    expect(reloaded.orphanedOverrides).toHaveLength(0);
  });

  // Plan-444 F3 turned this case around. It used to throw; refusing it was the
  // reason "import a STEP and drag a part into place" could not be saved, and
  // the move is now recorded as a transform override on the reference node.
  // The refusal that REMAINS is the nested case — see
  // rv-scene-glb-bake-move-in-reference.test.ts, which owns both halves.
  it('schreibt eine Verschiebung INNERHALB eines referenzierten Assets als trs-Override', async () => {
    const h = await harness();
    const edits = materialise([op({
      kind: 'transformNode', nodePath: h.pathOf('Ram'),
      transform: { position: [1, 2, 3], quaternion: [0, 0, 0, 1] },
      prev: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
    })]);

    const baked = await bakeIntoGlb(plantBytes, edits, h.resolver, {});
    expect(baked.referenceTransforms).toBe(1);
    // Not written as one of THIS file's own node transforms.
    expect(baked.transforms).toBe(0);

    const json = parseGlbChunks(baked.glb).json as {
      nodes: Array<{ name?: string; extras?: Record<string, unknown> }>;
    };
    const referenceJson = json.nodes.find((n) => n.name === 'Press_0')!;
    const rv = referenceJson.extras!.realvirtual as Record<string, Record<string, unknown>>;
    const trs = rv.AssetOverrides.trsByNodeId as Record<string, { position: number[] }>;
    expect(Object.values(trs)[0].position).toEqual([1, 2, 3]);
  });

  it('verweigert einen Override, dessen Referenzknoten selbst aus einer fremden Datei stammt', async () => {
    const resolver: BakeResolver = {
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
    const edits = materialise([op({
      kind: 'setField', nodePath: 'Deep',
      componentType: 'Drive', fieldName: 'TargetSpeed', value: 1, prev: 0,
    })]);
    await expect(bakeIntoGlb(plantBytes, edits, resolver, {}))
      .rejects.toBeInstanceOf(ReferencedFileWriteError);
  });
});

// ─── Identity and cycles ─────────────────────────────────────────────────

describe('Schutzmechanismen beim Speichern', () => {
  it('verweigert das Patchen, wenn die Quelldatei sich geändert hat (Knotenzahl)', async () => {
    const h = await harness();
    const edits = materialise([op({
      kind: 'setField', nodePath: h.pathOf('Floor'),
      componentType: 'Conveyor', fieldName: 'Speed', value: 1, prev: 100,
    })]);
    await expect(bakeIntoGlb(plantBytes, edits, h.resolver, {
      expectedNames: [...h.expectedNames, 'Ghost'],
    })).rejects.toBeInstanceOf(ModelSourceChangedError);
  });

  it('verweigert das Patchen, wenn ein Knotenname sich geändert hat', async () => {
    const h = await harness();
    const floorPath = h.pathOf('Floor');
    const location = h.resolver.locate(floorPath)!;
    expect(location.kind).toBe('root');
    const tampered = [...h.expectedNames];
    tampered[(location as { index: number }).index] = 'SomethingElse';

    const edits = materialise([op({
      kind: 'setField', nodePath: floorPath,
      componentType: 'Conveyor', fieldName: 'Speed', value: 1, prev: 100,
    })]);
    await expect(bakeIntoGlb(plantBytes, edits, h.resolver, { expectedNames: tampered }))
      .rejects.toBeInstanceOf(ModelSourceChangedError);
  });

  it('erkennt eine Selbstreferenz beim Speichern als Zyklus', async () => {
    const h = await harness();
    const edits = materialise([op({
      kind: 'addPlacement',
      placement: {
        id: 'plc_self', catalogId: 'plant', glbUrl: 'plant.glb', label: 'Selbst',
        position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
      },
    })]);
    await expect(bakeIntoGlb(plantBytes, edits, h.resolver, { self: { assetId: 'plant' } }))
      .rejects.toBeInstanceOf(SaveReferenceCycleError);
  });

  it('erlaubt dieselbe Baugruppe mehrfach — ein DAG ist kein Zyklus', async () => {
    const h = await harness();
    const edits = materialise([
      op({
        kind: 'addPlacement',
        placement: {
          id: 'a', catalogId: 'press', glbUrl: 'lib/press.glb', label: 'P1',
          position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        },
      }),
      op({
        kind: 'addPlacement',
        placement: {
          id: 'b', catalogId: 'press', glbUrl: 'lib/press.glb', label: 'P2',
          position: [500, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        },
      }),
    ]);
    const baked = await bakeIntoGlb(plantBytes, edits, h.resolver, { self: { assetId: 'plant' } });
    expect(baked.placements).toBe(2);

    const reloaded = await load(baked.glb);
    expect(findByName(reloaded.root, 'P1')).toBeTruthy();
    expect(findByName(reloaded.root, 'P2')).toBeTruthy();
  });

  it('verliert keine Platzierungsdaten mehr — nichts bleibt als Warnung übrig', async () => {
    const h = await harness();
    const edits = materialise([op({
      kind: 'addPlacement',
      placement: {
        id: 'plc_splat', catalogId: 'press', glbUrl: 'lib/press.glb', label: 'Splat',
        position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        splatUrl: 'lib/scan.splat',
        signalMappings: [{ slot: 'Forward', signal: 'M1.Run', direction: 'plcInput', enabled: true }],
      },
    })]);
    const baked = await bakeIntoGlb(plantBytes, edits, h.resolver, {});
    expect(baked.warnings).toEqual([]);
  });

  it('lässt eine ungültig gewordene Signatur fallen, statt sie als manipuliert zu hinterlassen', async () => {
    // A signed source: rv_sig in the default scene extras.
    const chunks = parseGlbChunks(plantBytes);
    const extras = defaultSceneExtras(chunks.json) ?? {};
    (chunks.json.scenes as Array<Record<string, unknown>>)[0].extras = { ...extras, rv_sig: 'x' };
    const signed = rebuildGlbWithJson(chunks);

    const h = await harness(signed);
    const edits = materialise([op({
      kind: 'setField', nodePath: h.pathOf('Floor'),
      componentType: 'Conveyor', fieldName: 'Speed', value: 5, prev: 100,
    })]);
    const baked = await bakeIntoGlb(signed, edits, h.resolver, {});
    expect(baked.signatureDropped).toBe(true);
    const out = parseGlbChunks(baked.glb).json;
    expect(defaultSceneExtras(out)).not.toHaveProperty('rv_sig');
  });
});

// ─── Phase-6 precondition: nothing a placement carries may be lost ───────
//
// Phase 6 replaces the debounced op-log autosave with a debounced GLB write.
// The moment that happens, anything the bake does not write — or writes but
// nobody reads back — is gone. These cases are the round-trip the plan demanded
// before that switch may be thrown, and each one is a field that had NO rv-ODT
// home when phase 4 ended.

describe('Platzierungsdaten ohne rv-ODT-Zuhause (Vorbedingung Phase 6)', () => {
  /** Bake one placement and return what a reader gets back after a real load. */
  async function roundTripPlacement(placement: Record<string, unknown>): Promise<PlacedComponent> {
    const h = await harness();
    const edits = materialise([op({ kind: 'addPlacement', placement })]);
    const baked = await bakeIntoGlb(plantBytes, edits, h.resolver, { expectedNames: h.expectedNames });
    const reloaded = await load(baked.glb);
    const placements = readPlacementsFromScene(reloaded.root);
    expect(placements).toHaveLength(1);
    return placements[0];
  }

  const basePlacement = {
    id: 'plc_1', catalogId: 'press', glbUrl: 'lib/press.glb', label: 'Presse_02',
    position: [1000, 0, -250] as [number, number, number],
    rotation: [0, 90, 0] as [number, number, number],
    scale: [1, 1, 1] as [number, number, number],
  };

  it('splatUrl überlebt — und ein Splat bekommt bewusst KEINE AssetReference', async () => {
    const h = await harness();
    const edits = materialise([op({
      kind: 'addPlacement',
      placement: { ...basePlacement, id: 'plc_splat', label: 'Scan', splatUrl: 'lib/scan.splat' },
    })]);
    const baked = await bakeIntoGlb(plantBytes, edits, h.resolver, { expectedNames: h.expectedNames });

    const reloaded = await load(baked.glb);
    const node = findByName(reloaded.root, 'Scan')!;
    expect(node).toBeTruthy();
    // A reference points at a glTF asset; a splat is not one. Writing a
    // reference anyway would spend a resolution attempt per splat and report
    // every one of them as missing.
    expect(getAssetReference(node)).toBeNull();
    expect(getPlacementMeta(node)?.splatUrl).toBe('lib/scan.splat');

    const [placement] = readPlacementsFromScene(reloaded.root);
    expect(placement.splatUrl).toBe('lib/scan.splat');
    // Identity still survives — it moved into the meta because nothing else holds it.
    expect(placement.catalogId).toBe('press');
  });

  it('signalMappings überleben unverändert, inklusive unbekannter Felder', async () => {
    const mappings = [
      { id: 'm1', slot: 'Forward', signal: 'M1.Run', direction: 'plcInput', enabled: true },
      { signal: 'M1.Speed', direction: 'plcOutput', enabled: false, sourceKind: 'internal', futureField: 42 },
    ];
    const placement = await roundTripPlacement({ ...basePlacement, signalMappings: mappings });
    expect(placement.signalMappings).toEqual(mappings);
  });

  it('visible: false überlebt — glTF hat kein Sichtbarkeitsflag', async () => {
    const placement = await roundTripPlacement({ ...basePlacement, visible: false });
    expect(placement.visible).toBe(false);
  });

  it('eine sichtbare Platzierung trägt kein visible-Feld (Abwesenheit heißt sichtbar)', async () => {
    const placement = await roundTripPlacement(basePlacement);
    expect(placement.visible).toBeUndefined();
  });

  it('Identität, Ziel und Transform kommen vollständig zurück', async () => {
    const placement = await roundTripPlacement({ ...basePlacement, scale: [2, 2, 2] });
    expect(placement.id).toBe('plc_1');
    expect(placement.catalogId).toBe('press');
    expect(placement.glbUrl).toBe('lib/press.glb');
    expect(placement.label).toBe('Presse_02');
    expect(placement.position).toEqual([1000, 0, -250]);
    expect(placement.rotation[1]).toBeCloseTo(90, 4);
    expect(placement.scale).toEqual([2, 2, 2]);
  });

  it('unterscheidet eine Platzierung von einem handgeschriebenen Referenzknoten', async () => {
    // `Press_0` in the fixture is an AssetReference an author wrote — not a
    // placement. Without the PlacementMeta marker the reader could not tell,
    // and the planner would adopt a node it never created.
    const reloaded = await load(plantBytes);
    expect(findByName(reloaded.root, 'Press_0')).toBeTruthy();
    expect(readPlacementsFromScene(reloaded.root)).toEqual([]);
  });

  it('steigt nicht in eine Platzierung hinab — Referenzen im Asset sind keine Platzierungen', async () => {
    const h = await harness();
    const edits = materialise([op({ kind: 'addPlacement', placement: basePlacement })]);
    const baked = await bakeIntoGlb(plantBytes, edits, h.resolver, { expectedNames: h.expectedNames });
    const reloaded = await load(baked.glb);
    // The press subtree is grafted under the placement; nothing in it is a
    // placement of THIS scene.
    expect(findByName(reloaded.root, 'Ram')).toBeTruthy();
    expect(readPlacementsFromScene(reloaded.root).map((p) => p.id)).toEqual(['plc_1']);
  });
});

describe('Workspace-Settings (Vorbedingung Phase 6)', () => {
  it('catalogUrls und gridSizeMm überleben Bake und Reload', async () => {
    const h = await harness();
    const baked = await bakeIntoGlb(plantBytes, emptyEdits(), h.resolver, {
      expectedNames: h.expectedNames,
      settings: { catalogUrls: ['library/std.json', 'https://x/y.json'], gridSizeMm: 250 },
    });
    expect(baked.settingsWritten).toBe(true);

    const reloaded = await load(baked.glb);
    expect(readSceneSettingsFromScene(reloaded.root)).toEqual({
      catalogUrls: ['library/std.json', 'https://x/y.json'],
      gridSizeMm: 250,
    });
  });

  it('ohne settings-Option bleibt ein vorhandener Block unangetastet', async () => {
    const h = await harness();
    const first = await bakeIntoGlb(plantBytes, emptyEdits(), h.resolver, {
      expectedNames: h.expectedNames,
      settings: { catalogUrls: ['library/std.json'], gridSizeMm: 250 },
    });

    // A bake that folds an unrelated field change into the file has no opinion
    // about settings and must not delete them.
    const h2 = await harness(first.glb);
    const second = await bakeIntoGlb(first.glb, materialise([op({
      kind: 'setField', nodePath: h2.pathOf('Floor'),
      componentType: 'Conveyor', fieldName: 'Speed', value: 12, prev: 100,
    })]), h2.resolver, { expectedNames: h2.expectedNames });
    expect(second.settingsWritten).toBe(false);

    const reloaded = await load(second.glb);
    expect(readSceneSettingsFromScene(reloaded.root)?.gridSizeMm).toBe(250);
  });

  it('settings: null löscht den Block ausdrücklich', async () => {
    const h = await harness();
    const first = await bakeIntoGlb(plantBytes, emptyEdits(), h.resolver, {
      expectedNames: h.expectedNames,
      settings: { catalogUrls: ['library/std.json'], gridSizeMm: 250 },
    });
    const h2 = await harness(first.glb);
    const second = await bakeIntoGlb(first.glb, emptyEdits(), h2.resolver, {
      expectedNames: h2.expectedNames, settings: null,
    });
    const reloaded = await load(second.glb);
    expect(readSceneSettingsFromScene(reloaded.root)).toBeNull();
  });

  it('eine Datei ohne Block liefert null, nicht erfundene Standardwerte', async () => {
    const reloaded = await load(plantBytes);
    expect(readSceneSettingsFromScene(reloaded.root)).toBeNull();
  });
});

describe('Wiederholtes Speichern derselben Szene (Vorbedingung Phase 6)', () => {
  const placement = {
    id: 'plc_1', catalogId: 'press', glbUrl: 'lib/press.glb', label: 'Presse_02',
    position: [1000, 0, -250] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    scale: [1, 1, 1] as [number, number, number],
  };

  it('verdoppelt eine bereits gebackene Platzierung NICHT', async () => {
    const h = await harness();
    const edits = materialise([op({ kind: 'addPlacement', placement })]);
    const first = await bakeIntoGlb(plantBytes, edits, h.resolver, { expectedNames: h.expectedNames });
    expect(first.path).toBe('full');
    expect(first.placementsUpdated).toBe(0);

    // Second save of the SAME scene: once a baked GLB is the base, every save
    // materialises the same placements again. Appending them would double the
    // layout on the first re-save.
    const h2 = await harness(first.glb);
    const second = await bakeIntoGlb(first.glb, edits, h2.resolver, { expectedNames: h2.expectedNames });
    expect(second.placementsUpdated).toBe(1);
    expect(second.path).toBe('fast');

    const reloaded = await load(second.glb);
    expect(readPlacementsFromScene(reloaded.root)).toHaveLength(1);
  });

  it('übernimmt Verschiebung und Umbenennung einer bestehenden Platzierung', async () => {
    const h = await harness();
    const first = await bakeIntoGlb(
      plantBytes,
      materialise([op({ kind: 'addPlacement', placement })]),
      h.resolver,
      { expectedNames: h.expectedNames },
    );

    const moved = { ...placement, label: 'Presse_neu', position: [7, 8, 9] as [number, number, number] };
    const h2 = await harness(first.glb);
    const second = await bakeIntoGlb(
      first.glb,
      materialise([op({ kind: 'addPlacement', placement: moved })]),
      h2.resolver,
      { expectedNames: h2.expectedNames },
    );
    expect(second.placementsUpdated).toBe(1);

    const reloaded = await load(second.glb);
    const [out] = readPlacementsFromScene(reloaded.root);
    expect(out.label).toBe('Presse_neu');
    expect(out.position).toEqual([7, 8, 9]);
  });

  it('lässt AssetOverrides auf demselben Referenzknoten unberührt', async () => {
    // The override and the placement live on the same node. Reconciliation
    // rewrites the placement's own keys; a wholesale replace would drop the
    // override that was just routed there.
    const h = await harness();
    const first = await bakeIntoGlb(
      plantBytes,
      materialise([op({ kind: 'addPlacement', placement })]),
      h.resolver,
      { expectedNames: h.expectedNames },
    );

    const h2 = await harness(first.glb);
    const second = await bakeIntoGlb(first.glb, materialise([
      op({ kind: 'addPlacement', placement }),
      op({
        kind: 'setField', nodePath: h2.pathOf('Ram'),
        componentType: 'Drive', fieldName: 'TargetSpeed', value: 999, prev: 250,
      }),
    ]), h2.resolver, { expectedNames: h2.expectedNames });
    expect(second.referenceOverrides).toBe(1);

    const reloaded = await load(second.glb);
    const ram = findByName(reloaded.root, 'Ram')!;
    expect((ram.userData.realvirtual as Record<string, Record<string, unknown>>).Drive.TargetSpeed)
      .toBe(999);
    expect(readPlacementsFromScene(reloaded.root)).toHaveLength(1);
  });

  it('fügt eine neue Platzierung neben die bestehende, statt sie zu ersetzen', async () => {
    const h = await harness();
    const first = await bakeIntoGlb(
      plantBytes,
      materialise([op({ kind: 'addPlacement', placement })]),
      h.resolver,
      { expectedNames: h.expectedNames },
    );

    const second = { ...placement, id: 'plc_2', label: 'Presse_03' };
    const h2 = await harness(first.glb);
    const baked = await bakeIntoGlb(first.glb, materialise([
      op({ kind: 'addPlacement', placement }),
      op({ kind: 'addPlacement', placement: second }),
    ]), h2.resolver, { expectedNames: h2.expectedNames });
    // One updated in place, one genuinely new — so the file has to be rebuilt.
    expect(baked.placementsUpdated).toBe(1);
    expect(baked.path).toBe('full');

    const reloaded = await load(baked.glb);
    expect(readPlacementsFromScene(reloaded.root).map((p) => p.id).sort())
      .toEqual(['plc_1', 'plc_2']);
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Union of every `Connections` block in a loaded tree — the plugin's view. */
function collectConnections(root: Object3D): {
  connections: RvConnection[];
  connectionTypes: ConnectionType[];
} {
  const connections: RvConnection[] = [];
  const connectionTypes: ConnectionType[] = [];
  root.traverse((node) => {
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    const block = rv?.Connections as
      { connections?: RvConnection[]; connectionTypes?: ConnectionType[] } | undefined;
    if (!block) return;
    connections.push(...(block.connections ?? []));
    connectionTypes.push(...(block.connectionTypes ?? []));
  });
  return { connections, connectionTypes };
}
