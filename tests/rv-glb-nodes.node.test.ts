// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-610 Phase 4 (test 9.5) — `scripts/lib/rv-glb-nodes.mjs`, the reference-safe
 * rename / move / group creation on glTF JSON for the Node GLB scripts.
 *
 * Covers: path model (loader dedup), create / rename / move with the reference
 * rewrite (ComponentReference scalar / array / deep, PATH_FIELDS, name field),
 * segment boundary (`PLC` vs `PLC_Programs`), spelling kept (relative vs
 * root-prefixed), healing of a suffix-only reference, idempotency down to the
 * written GLB bytes, the refusals (collision, cycle, world mismatch, `/`, signal
 * node, foreign content), atomic batch moves and the dedup shift — and PARITY
 * with the editor: the same fixture planned through the core with the editor's
 * resolver over a real `NodeRegistry` (`resolveWithStage`, `outermostReference`,
 * the editor's name lookup) writes the very same reference values.
 *
 * The editor itself (`AssetDocument`) needs a viewer and a browser; the parity
 * side therefore rebuilds what `planDocumentReferenceRewrite` hands the core —
 * same registry, same chain, same scope — at node level (a GLB carries no
 * constructed components; `componentType` is passed exactly as the editor
 * passes it, the fixture's typed references are signal / Transform kinds that
 * resolve to plain nodes either way).
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { Object3D } from 'three';
import { readGlb, writeGlb } from '../scripts/lib/rv-glb.mjs';
import { PropertyBinding } from 'three';
import {
  ambiguousLoaderNames,
  createGroup,
  fileNameCollisions,
  findByPath,
  modelRootName,
  moveNode,
  moveNodes,
  NodeOpError,
  nodeNames,
  nodePaths,
  renameNode,
  sanitizeLikeThree,
  SIGNAL_COMPONENT_TYPES,
} from '../scripts/lib/rv-glb-nodes.mjs';
import { isPureSanitization, sanitizeLikeThree as sanitizeLikeThreeTs } from '../src/core/engine/rv-three-names';
import { planReferenceRewrite } from '../src/core/engine/rv-node-path-rewrite.mjs';
import { outermostReference } from '../src/core/engine/rv-reference-scope';
import { SIGNAL_TYPES } from '../src/core/engine/rv-signal-construction';
import { registryFromGlbJson, type GltfJson } from './helpers/glb-json-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const CR = (path: string, componentType?: string): Record<string, unknown> =>
  (componentType ? { type: 'ComponentReference', path, componentType } : { type: 'ComponentReference', path });

/**
 * Scene `Cell`:
 *   PLC/FG01/{X (Name 'X'), Y (Name '')}     PLC_Programs/Station01
 *   Lift01/Child (Drive_Cylinder: relative + root-prefixed signal refs, NodeId)
 *   Zone (StaticColliders)  Instr (steps[].targetObjects/targetObject)
 *   Src/MU1 (Source.ThisObjectAsMU)  Kin (Kinematic.Parent)  Deep (nested refs)
 *   Grip/GripSensor (suffix-only ref)  Rot (rotated) /RotA  Group1 (empty identity)
 *   Ref (AssetReference)/Inner (foreign refs)
 *   scene extras: Drive.Target → Lift01
 */
function fixture(): Json {
  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{
      name: 'Cell',
      nodes: [0, 4, 6, 8, 9, 10, 12, 13, 14, 16, 18, 19],
      extras: { realvirtual: { Drive: { Target: CR('Lift01', 'UnityEngine.Transform') }, NodeKnowledge: { Note: 'PLC/FG01 holds the signals' } } },
    }],
    nodes: [
      /* 0 */ { name: 'PLC', children: [1] },
      /* 1 */ { name: 'FG01', children: [2, 3] },
      /* 2 */ { name: 'X', extras: { realvirtual: { PLCOutputBool: { Name: 'X' } } } },
      /* 3 */ { name: 'Y', extras: { realvirtual: { PLCInputBool: { Name: '' } } } },
      /* 4 */ { name: 'PLC_Programs', children: [5] },
      /* 5 */ { name: 'Station01', extras: { realvirtual: { PLCProgram: { Source: 'X := TRUE;' } } } },
      /* 6 */ {
        name: 'Lift01', children: [7], translation: [1, 2, 3],
        extras: { realvirtual: {
          NodeId: 'id-lift-01',
          Drive: { Direction: 'LinearY' },
          Drive_Cylinder: {
            Out: CR('PLC/FG01/X', 'realvirtual.PLCOutputBool'),
            In: CR('Cell/PLC/FG01/Y', 'realvirtual.PLCInputBool'),
            Program: CR('PLC_Programs/Station01'),
          },
        } },
      },
      /* 7 */ { name: 'Child' },
      /* 8 */ { name: 'Zone', extras: { realvirtual: { WebPhysicsZone: { StaticColliders: ['PLC_Programs/Station01', 'Lift01/Child', 'PLC/FG01'] } } } },
      /* 9 */ { name: 'Instr', extras: { realvirtual: { CustomRuntimeInstruction: { steps: [{ targetObjects: ['PLC/FG01/X', 'Lift01'], targetObject: 'PLC/FG01', text: 'PLC' }] } } } },
      /* 10 */ { name: 'Src', children: [11], extras: { realvirtual: { Source: { ThisObjectAsMU: 'MU1' } } } },
      /* 11 */ { name: 'MU1' },
      /* 12 */ { name: 'Kin', extras: { realvirtual: { Kinematic: { Parent: 'Lift01' } } } },
      /* 13 */ {
        name: 'Deep',
        extras: { realvirtual: { Custom: { list: [CR('PLC/FG01/X'), { nested: { r: CR('Cell/PLC/FG01/X') } }], other: CR('PLC_Programs/Station01') } } },
      },
      /* 14 */ { name: 'Grip', children: [15], extras: { realvirtual: { Grip: { PartToGrip: CR('GripSensor') } } } },
      /* 15 */ { name: 'GripSensor' },
      /* 16 */ { name: 'Rot', rotation: [0, 0.7071067811865476, 0, 0.7071067811865476], children: [17] },
      /* 17 */ { name: 'RotA' },
      /* 18 */ { name: 'Group1' },
      /* 19 */ { name: 'Ref', children: [20], extras: { realvirtual: { AssetReference: { assetId: 'machine-a' } } } },
      /* 20 */ { name: 'Inner', extras: { realvirtual: { Custom: { r: CR('PLC/FG01/X') } } } },
    ],
  };
}

const rv = (json: Json, path: string): Json => json.nodes[findByPath(json, path)!].extras.realvirtual;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const bytes = (json: Json): Buffer => writeGlb(json, Buffer.alloc(0));

function expectRefused(fn: () => unknown, code: string): void {
  let err: unknown = null;
  try { fn(); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(NodeOpError);
  expect((err as NodeOpError).code).toBe(code);
}

describe('rv-glb-nodes: path model', () => {
  it("paths are asset-relative with the loader's FILE-WIDE dedup (plan-610 Phase 5b)", () => {
    const json = {
      scenes: [{ name: 'S', nodes: [0, 1, 2] }],
      nodes: [{ name: 'A', children: [3] }, { name: 'A', children: [4] }, { name: 'A_1' }, { name: 'L' }, { name: 'L' }],
    };
    const paths = nodePaths(json);
    // Load order: scene `S`, then depth-first A, L, A, L, A_1. The second `L` is a
    // cousin, not a sibling — GLTFLoader still makes it `L_1`. And `createUniqueName`
    // counts per sanitized name without checking the spelling it generates: the
    // second `A` becomes `A_1`, and the node really named `A_1` keeps `A_1` too.
    expect([...paths.entries()]).toEqual([[0, 'A'], [3, 'A/L'], [1, 'A_1'], [4, 'A_1/L_1'], [2, 'A_1']]);
    expect(nodeNames(json).get(4)).toBe('L_1');
    expect(findByPath(json, 'A_1/L_1')).toBe(4);
    expect(findByPath(json, 'nope')).toBeNull();
    expect(modelRootName(json)).toBe('S');
    expect(fileNameCollisions(json).map((c) => [c.path, c.raw])).toEqual([['A_1', 'A'], ['A_1/L_1', 'L']]);
  });

  it('shares the name table with the scene name and cameras; sanitizes; restores a purely sanitized name', () => {
    const json = {
      scene: 0,
      scenes: [{ name: 'Cell', nodes: [0, 1, 3, 4, 5] }],
      nodes: [
        /* 0 */ { name: 'Cell' }, // the scene claimed `Cell` first
        /* 1 */ { name: 'Cam1', camera: 0, children: [2] },
        /* 2 */ { name: 'Front' }, // claimed by the camera of its parent, synchronously before it
        /* 3 */ { name: 'MC04.01' }, // pure sanitization → the viewer restores the raw name
        /* 4 */ { name: 'MC0401' }, // same sanitized key → `MC0401_1`
        /* 5 */ { name: 'Two Words', mesh: 0 }, // mesh names are claimed later, never shift a node
      ],
      cameras: [{ name: 'Front', type: 'perspective', perspective: { yfov: 1, znear: 0.1 } }],
      meshes: [{ name: 'Cam1', primitives: [] }],
    };
    expect([...nodeNames(json).values()]).toEqual(['Cell_1', 'Cam1', 'Front_1', 'MC04.01', 'MC0401_1', 'Two Words']);
    expect(sanitizeLikeThree('a b.c[d]:e/f')).toBe('a_bcdef');
  });

  it('sanitizeLikeThree equals THREE.PropertyBinding.sanitizeNodeName and rv-three-names.ts', () => {
    for (const name of ['MC04.01I00W', 'a b\tc','[x]:y/z.w', 'plain', '  lead', 'Ü ä.ö']) {
      expect(sanitizeLikeThree(name)).toBe(PropertyBinding.sanitizeNodeName(name));
      expect(sanitizeLikeThree(name)).toBe(sanitizeLikeThreeTs(name));
    }
  });

  it("names exactly like the real GLTFLoader + the viewer's restore (load-order parity)", async () => {
    const pos = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
    const json = {
      asset: { version: '2.0' },
      scene: 1,
      scenes: [{ name: 'Other', nodes: [9] }, { name: 'Main', nodes: [0, 4, 8] }],
      nodes: [
        /* 0 */ { name: 'Group', children: [1, 2], mesh: 0 },
        /* 1 */ { name: 'Body' },
        /* 2 */ { name: 'X', camera: 0, children: [3] },
        /* 3 */ { name: 'Signals' },
        /* 4 */ { name: 'Signals', children: [5, 6] },
        /* 5 */ { name: 'FG03.Table' },
        /* 6 */ { name: 'Body', children: [7] },
        /* 7 */ { name: 'Cam' },
        /* 8 */ { name: 'Main' },
        /* 9 */ { name: 'Group' },
      ],
      cameras: [{ name: 'Cam', type: 'perspective', perspective: { yfov: 1, znear: 0.1 } }],
      meshes: [{ name: 'Body', primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
      bufferViews: [{ buffer: 0, byteLength: pos.length }],
      buffers: [{ byteLength: pos.length, uri: `data:application/octet-stream;base64,${pos.toString('base64')}` }],
    };
    const g = globalThis as { ProgressEvent?: unknown };
    if (!g.ProgressEvent) g.ProgressEvent = class { constructor(public type: string, o: object) { Object.assign(this, o); } };
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const gltf = await new GLTFLoader().parseAsync(JSON.stringify(json), '');
    // Walk the loaded default scene alongside the glTF tree (no fixture node adds a
    // non-node child), then the viewer's restore step (rv-glb-parse.ts `detectRenamedNodes`).
    // (`parser.associations` is not used: with several scenes each `loadScene` reduces it
    // to its own nodes, so it is incomplete for exactly this fixture.)
    const loaded = new Map<number, string>();
    const walk = (index: number, obj: { name: string; children: { name: string; children: unknown[] }[] }): void => {
      const orig = json.nodes[index].name ?? '';
      loaded.set(index, isPureSanitization(orig, obj.name) ? orig : obj.name);
      const kids = (json.nodes[index] as { children?: number[] }).children ?? [];
      kids.forEach((c, k) => walk(c, obj.children[k] as never));
    };
    json.scenes[json.scene].nodes.forEach((i, k) => walk(i, gltf.scene.children[k] as never));
    const names = nodeNames(json);
    expect([...names.keys()].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    for (const [i, name] of names) expect(`${i}:${name}`).toBe(`${i}:${loaded.get(i)}`);
  });

  it('GLTFLoader has exactly the five createUniqueName call sites the replay models (checklist)', () => {
    // A three update that adds, drops or changes a caller of the ONE name table
    // fails here — simulateLoaderNames must then be revisited.
    const src = readFileSync(createRequire(import.meta.url).resolve('three/examples/jsm/loaders/GLTFLoader.js'), 'utf8');
    const lines = src.split(/\r?\n/);
    expect(lines.filter((l) => /^\tcreateUniqueName\( originalName \) \{$/.test(l))).toHaveLength(1);
    const sites: string[] = [];
    lines.forEach((line, k) => {
      const at = line.indexOf('createUniqueName(');
      if (at < 0 || /^\tcreateUniqueName\(/.test(line)) return;
      let method = '?';
      for (let j = k; j >= 0; j--) {
        const m = /^\t(\w+)\( [^)]*\) \{$/.exec(lines[j]) ?? /^\t(\w+)\(\) \{$/.exec(lines[j]);
        if (m) { method = m[1]; break; }
      }
      sites.push(`${method}: ${line.slice(at + 'createUniqueName('.length).trim()}`);
    });
    const pots: Record<string, string> = { _loadLight: 'light', loadMesh: 'mesh', loadCamera: 'camera', _loadNodeShallow: 'node', loadScene: 'scene' };
    expect(sites.map((s) => pots[s.split(':')[0]] ?? s).sort()).toEqual(['camera', 'light', 'mesh', 'node', 'scene']);
    // The argument decides whether an unnamed definition claims (light, mesh) or not.
    expect(sites.sort()).toEqual([
      "_loadLight: lightDef.name || ( 'light_' + lightIndex ) );",
      "_loadNodeShallow: nodeDef.name ) : '';",
      'loadCamera: cameraDef.name );',
      "loadMesh: meshDef.name || ( 'mesh_' + meshIndex ) );",
      'loadScene: sceneDef.name );',
    ]);
  });

  it('every name pot names like the real GLTFLoader: scene, unnamed mesh, camera, light, shared mesh (parity)', async () => {
    const pos = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
    const prim = { attributes: { POSITION: 0 } };
    const json = {
      asset: { version: '2.0' },
      extensionsUsed: ['KHR_lights_punctual'],
      extensions: { KHR_lights_punctual: { lights: [{ type: 'point' }, { type: 'point', name: 'Lamp' }] } },
      scene: 0,
      scenes: [{ name: 'Station', nodes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }],
      nodes: [
        /* 0 */ { name: 'Station' }, // the named scene claimed it first → Station_1
        /* 1 */ { name: 'mesh_0' }, // a node really named like the unnamed mesh 0
        /* 2 */ { mesh: 0 }, // unnamed node = the mesh → mesh_0_1 (meshes claim after every node)
        /* 3 */ { name: 'light_0' },
        /* 4 */ { extensions: { KHR_lights_punctual: { light: 0 } } }, // unnamed node = the unnamed light → light_0_1
        /* 5 */ { name: 'Lamp', extensions: { KHR_lights_punctual: { light: 1 } } }, // node claims first, the light gets Lamp_1
        /* 6 */ { name: 'Front' },
        /* 7 */ { camera: 0 }, // unnamed node = the named camera → Front_1
        /* 8 */ { name: 'Wheel', mesh: 1 }, // shared mesh: the named node consumes use 0
        /* 9 */ { mesh: 1 }, // → Tire_instance_1
        /* 10 */ { mesh: 2, camera: 1 }, // two objects → an unnamed Group (own unnamed camera, so camera 0 stays unshared)
      ],
      cameras: [{ name: 'Front', type: 'perspective', perspective: { yfov: 1, znear: 0.1 } }, { type: 'perspective', perspective: { yfov: 1, znear: 0.1 } }],
      meshes: [{ primitives: [prim] }, { name: 'Tire', primitives: [prim] }, { name: 'Other', primitives: [prim] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
      bufferViews: [{ buffer: 0, byteLength: pos.length }],
      buffers: [{ byteLength: pos.length, uri: `data:application/octet-stream;base64,${pos.toString('base64')}` }],
    };
    const g = globalThis as { ProgressEvent?: unknown };
    if (!g.ProgressEvent) g.ProgressEvent = class { constructor(public type: string, o: object) { Object.assign(this, o); } };
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const gltf = await new GLTFLoader().parseAsync(JSON.stringify(json), '');
    const loaded = gltf.scene.children.map((o, k) => {
      const orig = (json.nodes[k] as { name?: string }).name ?? '';
      return isPureSanitization(orig, o.name) ? orig : o.name;
    });
    expect([...nodeNames(json).values()]).toEqual(loaded);
    expect(loaded).toEqual(['Station_1', 'mesh_0', 'mesh_0_1', 'light_0', 'light_0_1', 'Lamp', 'Front', 'Front_1', 'Wheel', 'Tire_instance_1', '']);
    expect(ambiguousLoaderNames(json)).toEqual([]);
  });
});

describe('rv-glb-nodes: name pots and order-dependent names', () => {
  const meshFile = (): Json => ({
    scenes: [{ name: 'S', nodes: [0, 1, 2, 3] }],
    nodes: [
      /* 0 */ { name: 'Part' }, // named: claimed synchronously, never shifted by a mesh
      /* 1 */ { mesh: 0, children: [4] }, // unnamed → Part_1 or Part_2, depending on the settle order
      /* 2 */ { mesh: 1 },
      /* 3 */ { name: 'Holder', children: [5] },
      /* 4 */ { name: 'Pin' },
      /* 5 */ { mesh: 2 }, // unnamed, but its mesh name is unique → deterministic
    ],
    meshes: [{ name: 'Part', primitives: [{}] }, { name: 'Part', primitives: [{}] }, { name: 'Bolt', primitives: [{}] }],
    cameras: [{ name: 'Overview', type: 'perspective', perspective: { yfov: 1, znear: 0.1 } }],
    extensions: { KHR_lights_punctual: { lights: [{ type: 'point' }] } },
  });

  it('detects names that depend on the mesh settle order, and only those', () => {
    const json = meshFile();
    expect([...nodePaths(json).values()]).toEqual(['Part', 'Part_1', 'Part_1/Pin', 'Part_2', 'Holder', 'Holder/Bolt']);
    expect(ambiguousLoaderNames(json)).toEqual([
      { index: 1, path: 'Part_1', name: 'Part_1', ancestor: false },
      { index: 4, path: 'Part_1/Pin', name: 'Pin', ancestor: true },
      { index: 2, path: 'Part_2', name: 'Part_2', ancestor: false },
    ]);
    // One mesh claim per base is deterministic, even when a node holds the base.
    const one: Json = { scenes: [{ nodes: [0, 1] }], nodes: [{ name: 'Body' }, { mesh: 0 }], meshes: [{ name: 'Body', primitives: [{}] }] };
    expect([...nodePaths(one).values()]).toEqual(['Body', 'Body_1']);
    expect(ambiguousLoaderNames(one)).toEqual([]);
  });

  it('refuses a name from any pot or a generated `<base>_<n>` spelling', () => {
    const json = meshFile();
    const before = clone(json);
    expectRefused(() => renameNode(json, 'Holder', 'Bolt'), 'name-taken-in-file'); // mesh name (and an unnamed node's name)
    expectRefused(() => renameNode(json, 'Part_1/Pin', 'Part_2'), 'name-taken-in-file'); // generated for a mesh claim
    expectRefused(() => renameNode(json, 'Holder', 'Overview'), 'name-taken-in-file'); // a camera no node uses
    expectRefused(() => renameNode(json, 'Holder', 'light_0'), 'name-taken-in-file'); // unnamed light, not even loaded
    expectRefused(() => renameNode(json, 'Holder', 'S'), 'name-taken-in-file'); // the named scene
    expect(json).toEqual(before);
    const unnamedMesh: Json = { scenes: [{ nodes: [0] }], nodes: [{ name: 'A' }], meshes: [{ primitives: [{}] }] };
    expectRefused(() => createGroup(unnamedMesh, null, 'mesh_0'), 'name-taken-in-file'); // unnamed mesh, not even loaded
    expect(renameNode(json, 'Holder', 'Bracket').path).toBe('Bracket');
  });

  it('warns `ambiguous-loader-name` when a rewritten path runs through an order-dependent name', () => {
    const json = meshFile();
    json.nodes[3].extras = { realvirtual: { Custom: { r: CR('Part_1/Pin') } } };
    const r = renameNode(json, 'Part_1/Pin', 'Pin2');
    expect(r.path).toBe('Part_1/Pin2');
    expect(r.warnings.map((w) => [w.code, w.path, w.nodePath])).toEqual([['ambiguous-loader-name', 'Part_1/Pin', 'Part_1/Pin2']]);
    expect(json.nodes[3].extras.realvirtual.Custom.r).toEqual(CR('Part_1/Pin2'));
    // An unrelated path: no warning.
    expect(renameNode(json, 'Holder', 'Bracket').warnings).toEqual([]);
  });
});

describe('rv-glb-nodes: rename', () => {
  it('renames PLC → Signals: relative + root-prefixed spellings kept, PLC_Programs untouched, NodeId kept', () => {
    const json = fixture();
    const before = clone(json);
    const r = renameNode(json, 'PLC', 'Signals');
    expect(r.path).toBe('Signals');
    expect(r.warnings).toEqual([]);
    // Drive_Cylinder 2 + Zone 1 + Instr 2 + Deep 2 (Inner is foreign → untouched).
    expect(r.referencesRewritten).toBe(7);
    const cyl = rv(json, 'Lift01').Drive_Cylinder;
    expect(cyl.Out).toEqual(CR('Signals/FG01/X', 'realvirtual.PLCOutputBool'));
    expect(cyl.In).toEqual(CR('Cell/Signals/FG01/Y', 'realvirtual.PLCInputBool'));
    expect(cyl.Program).toEqual(CR('PLC_Programs/Station01'));
    expect(rv(json, 'Lift01').NodeId).toBe('id-lift-01');
    expect(rv(json, 'Zone').WebPhysicsZone.StaticColliders).toEqual(['PLC_Programs/Station01', 'Lift01/Child', 'Signals/FG01']);
    expect(rv(json, 'Instr').CustomRuntimeInstruction.steps).toEqual([{ targetObjects: ['Signals/FG01/X', 'Lift01'], targetObject: 'Signals/FG01', text: 'PLC' }]);
    expect(rv(json, 'Deep').Custom).toEqual({ list: [CR('Signals/FG01/X'), { nested: { r: CR('Cell/Signals/FG01/X') } }], other: CR('PLC_Programs/Station01') });
    expect(rv(json, 'Ref/Inner').Custom.r).toEqual(CR('PLC/FG01/X'));
    // Free text (NodeKnowledge note) is no reference.
    expect(json.scenes[0].extras).toEqual(before.scenes[0].extras);
    expect(json.nodes[0].name).toBe('Signals');
    expect(findByPath(json, 'Signals/FG01/X')).toBe(2);

    // The name swap of plan-610 Phase 5: PLC_Programs → PLC, now free.
    const r2 = renameNode(json, 'PLC_Programs', 'PLC');
    expect(r2.referencesRewritten).toBe(3); // Zone 1, Deep.other 1, Drive_Cylinder.Program 1
    expect(rv(json, 'Zone').WebPhysicsZone.StaticColliders).toEqual(['PLC/Station01', 'Lift01/Child', 'Signals/FG01']);
    expect(rv(json, 'Lift01').Drive_Cylinder.Out).toEqual(CR('Signals/FG01/X', 'realvirtual.PLCOutputBool'));
  });

  it('rewrites a name field on a rename of its uniquely named target', () => {
    const json = fixture();
    const r = renameNode(json, 'Src/MU1', 'MU_Part');
    expect(r.nameFieldsRewritten).toBe(1);
    expect(rv(json, 'Src').Source.ThisObjectAsMU).toBe('MU_Part');
  });

  it('refuses collisions, "/", empty names, missing paths, a name-following signal and foreign content', () => {
    const json = fixture();
    const before = clone(json);
    expectRefused(() => renameNode(json, 'Zone', 'Instr'), 'name-collision');
    expectRefused(() => renameNode(json, 'Zone', 'A/B'), 'slash-in-name');
    expectRefused(() => renameNode(json, 'Zone', ' '), 'empty-name');
    expectRefused(() => renameNode(json, 'Nope', 'X'), 'not-found');
    expectRefused(() => renameNode(json, 'PLC/FG01/Y', 'Y2'), 'signal-name-follows-node');
    expectRefused(() => renameNode(json, 'Ref/Inner', 'Inner2'), 'inside-reference');
    expect(json).toEqual(before);
    // A signal with its own Name may be renamed (its signal name stays 'X').
    expect(renameNode(json, 'PLC/FG01/X', 'X_Node').referencesRewritten).toBe(4);
    expect(rv(json, 'PLC/FG01/X_Node').PLCOutputBool.Name).toBe('X');
  });

  it('refuses a collision with a de-duplicated sibling name', () => {
    const json: Json = { scenes: [{ name: 'S', nodes: [0, 1, 2] }], nodes: [{ name: 'A' }, { name: 'A' }, { name: 'B' }] };
    expectRefused(() => renameNode(json, 'B', 'A_1'), 'name-collision');
  });

  it('refuses a name already used elsewhere in the file — no silent `_N` (plan-610 Phase 5b)', () => {
    const json = fixture();
    const before = clone(json);
    expectRefused(() => renameNode(json, 'Zone', 'Child'), 'name-taken-in-file'); // Lift01/Child
    expectRefused(() => renameNode(json, 'Zone', 'Grip.Sensor'), 'name-taken-in-file'); // sanitizes to GripSensor
    expectRefused(() => renameNode(json, 'Zone', 'Cell'), 'name-taken-in-file'); // the scene name
    expectRefused(() => createGroup(json, null, 'FG01'), 'name-taken-in-file'); // PLC/FG01
    expect(json).toEqual(before);
    // Renaming away from a duplicate is fine; the other node gets its plain name back.
    const dup: Json = { scenes: [{ name: 'S', nodes: [0, 1] }], nodes: [{ name: 'T', children: [2] }, { name: 'G', children: [3] }, { name: 'X' }, { name: 'X' }] };
    expect(nodePaths(dup).get(3)).toBe('G/X_1');
    const r = renameNode(dup, 'T/X', 'Y');
    expect(nodePaths(dup).get(3)).toBe('G/X');
    expect(r.warnings.map((w) => w.code)).toEqual(['dedup-shift']);
  });
});

describe('rv-glb-nodes: move', () => {
  it('moves into an identity group: refs to the node and its subtree follow, the referrer itself moves', () => {
    const json = fixture();
    const r = moveNode(json, 'Lift01', 'Group1');
    expect(r.path).toBe('Group1/Lift01');
    // scene Drive.Target, Zone 'Lift01/Child', Instr 'Lift01', Kin.Parent.
    expect(r.referencesRewritten).toBe(4);
    expect(json.scenes[0].extras.realvirtual.Drive.Target).toEqual(CR('Group1/Lift01', 'UnityEngine.Transform'));
    expect(rv(json, 'Zone').WebPhysicsZone.StaticColliders).toEqual(['PLC_Programs/Station01', 'Group1/Lift01/Child', 'PLC/FG01']);
    expect(rv(json, 'Kin').Kinematic.Parent).toBe('Group1/Lift01');
    // The moved referrer's own refs point outside the moved subtree → unchanged.
    expect(rv(json, 'Group1/Lift01').Drive_Cylinder.Out).toEqual(CR('PLC/FG01/X', 'realvirtual.PLCOutputBool'));
    // Local transform kept (identity parent).
    expect(json.nodes[6].translation).toEqual([1, 2, 3]);
    expect(json.scenes[0].nodes).not.toContain(6);
    expect(json.nodes[18].children).toEqual([6]);
  });

  it('heals a suffix-only reference onto the exact new path', () => {
    const json = fixture();
    const r = moveNode(json, 'Grip', 'Group1');
    expect(r.referencesRewritten).toBe(1);
    expect(rv(json, 'Group1/Grip').Grip.PartToGrip).toEqual(CR('Group1/Grip/GripSensor'));
  });

  it('moves back to the top level and honours index', () => {
    const json = fixture();
    moveNode(json, 'Lift01', 'Group1');
    const r = moveNode(json, 'Group1/Lift01', null, { index: 0 });
    expect(r.path).toBe('Lift01');
    expect(json.scenes[0].nodes[0]).toBe(6);
    expect(json.nodes[18].children).toBeUndefined();
    expect(rv(json, 'Kin').Kinematic.Parent).toBe('Lift01');
  });

  it('allows a move between parents with the same world matrix, refuses a different one', () => {
    const json = fixture();
    createGroup(json, 'Rot', 'RotB');
    expect(moveNode(json, 'Rot/RotA', 'Rot/RotB').path).toBe('Rot/RotB/RotA');
    const before = clone(json);
    expectRefused(() => moveNode(json, 'Lift01', 'Rot'), 'world-mismatch');
    expectRefused(() => moveNode(json, 'Rot/RotB/RotA', null), 'world-mismatch');
    expect(json).toEqual(before);
  });

  it('refuses a cycle, a collision, a move into or out of foreign content', () => {
    const json = fixture();
    const before = clone(json);
    expectRefused(() => moveNode(json, 'PLC', 'PLC/FG01'), 'cycle');
    expectRefused(() => moveNode(json, 'PLC', 'PLC'), 'cycle');
    // A second `Zone` cannot be created any more (file-wide unique names) — a legacy
    // file may still carry one: the move next to it stays refused among siblings.
    expectRefused(() => createGroup(json, 'Group1', 'Zone'), 'name-taken-in-file');
    json.nodes.push({ name: 'Zone' });
    json.nodes[18].children = [json.nodes.length - 1];
    const withGroup = clone(json);
    expectRefused(() => moveNode(json, 'Zone', 'Group1'), 'name-collision');
    expectRefused(() => moveNode(json, 'Zone', 'Ref'), 'inside-reference');
    expectRefused(() => moveNode(json, 'Ref/Inner', null), 'inside-reference');
    expect(json).toEqual(withGroup);
    expect(before.nodes.length).toBe(json.nodes.length - 1);
  });

  it('rewrites a sibling whose de-duplicated name shifts and warns about it', () => {
    const json: Json = {
      scenes: [{ name: 'S', nodes: [0, 1, 3, 4] }],
      nodes: [
        { name: 'A' }, { name: 'A', children: [2] }, { name: 'Leaf' },
        { name: 'G' },
        { name: 'User', extras: { realvirtual: { Custom: { r: CR('A_1/Leaf') } } } },
      ],
    };
    const r = moveNode(json, 'A', 'G');
    expect(findByPath(json, 'A/Leaf')).toBe(2);
    expect(json.nodes[4].extras.realvirtual.Custom.r).toEqual(CR('A/Leaf'));
    expect(r.referencesRewritten).toBe(1);
    expect(r.warnings.map((w) => [w.code, w.path, w.nodePath])).toEqual([['dedup-shift', 'A_1', 'A']]);
  });
});

describe('rv-glb-nodes: batch moves', () => {
  it('resolves every path against the state before the first move, one rewrite for all', () => {
    const json = fixture();
    createGroup(json, null, 'Kinematics');
    createGroup(json, null, 'Simulation');
    const r = moveNodes(json, [
      { path: 'Lift01', newParentPath: 'Kinematics' },
      { path: 'Kin', newParentPath: 'Kinematics' },
      { path: 'Grip', newParentPath: 'Simulation' },
      { path: 'Src', newParentPath: 'Simulation' },
      // A group moved into a group within the same batch, and a node into the moved group.
      { path: 'Simulation', newParentPath: 'Group1' },
      { path: 'Zone', newParentPath: 'Simulation' },
    ]);
    expect(r.paths).toEqual([
      'Kinematics/Lift01', 'Kinematics/Kin', 'Group1/Simulation/Grip', 'Group1/Simulation/Src', 'Group1/Simulation', 'Group1/Simulation/Zone',
    ]);
    expect(rv(json, 'Kinematics/Kin').Kinematic.Parent).toBe('Kinematics/Lift01');
    expect(rv(json, 'Group1/Simulation/Zone').WebPhysicsZone.StaticColliders).toEqual(['PLC_Programs/Station01', 'Kinematics/Lift01/Child', 'PLC/FG01']);
    expect(rv(json, 'Group1/Simulation/Grip').Grip.PartToGrip).toEqual(CR('Group1/Simulation/Grip/GripSensor'));
    expect(json.scenes[0].extras.realvirtual.Drive.Target.path).toBe('Kinematics/Lift01');
    expect(rv(json, 'Instr').CustomRuntimeInstruction.steps[0].targetObjects).toEqual(['PLC/FG01/X', 'Kinematics/Lift01']);
  });

  it('is atomic: one refused move leaves the JSON untouched', () => {
    const json = fixture();
    const before = clone(json);
    expectRefused(() => moveNodes(json, [
      { path: 'Lift01', newParentPath: 'Group1' },
      { path: 'Kin', newParentPath: 'Rot' },
    ]), 'world-mismatch');
    expectRefused(() => moveNodes(json, [
      { path: 'Lift01', newParentPath: 'Group1' },
      { path: 'Lift01', newParentPath: null },
    ]), 'duplicate-move');
    expect(json).toEqual(before);
  });

  it('moves 300 nodes with 600 references in one call', () => {
    const N = 300;
    const nodes: Json[] = [{ name: 'Target' }];
    const roots = [0];
    for (let i = 0; i < N; i++) {
      roots.push(nodes.length);
      nodes.push({ name: `N${i}`, extras: { realvirtual: { Custom: { self: CR(`N${i}`), other: CR(`N${(i + 1) % N}`) } } } });
    }
    const json: Json = { scenes: [{ name: 'Big', nodes: roots }], nodes };
    const t0 = performance.now();
    const r = moveNodes(json, Array.from({ length: N }, (_, i) => ({ path: `N${i}`, newParentPath: 'Target' })));
    const ms = performance.now() - t0;
    console.log(`[rv-glb-nodes] ${N} moves, ${r.referencesRewritten} references rewritten in ${ms.toFixed(1)} ms`);
    expect(r.referencesRewritten).toBe(2 * N);
    expect(json.nodes[5].extras.realvirtual.Custom).toEqual({ self: CR('Target/N4'), other: CR('Target/N5') });
  });
});

describe('rv-glb-nodes: createGroup', () => {
  it('creates an identity group, reuses an empty one, refuses one with content', () => {
    const json = fixture();
    const a = createGroup(json, 'PLC', 'Extra');
    expect(a).toMatchObject({ path: 'PLC/Extra', created: true, referencesRewritten: 0 });
    expect(json.nodes[a.nodeIndex]).toEqual({ name: 'Extra' });
    const b = createGroup(json, 'PLC', 'Extra');
    expect(b).toMatchObject({ path: 'PLC/Extra', created: false, nodeIndex: a.nodeIndex });
    // A reused group may already hold moved children.
    moveNode(json, 'PLC_Programs', 'PLC/Extra');
    expect(createGroup(json, 'PLC', 'Extra').created).toBe(false);
    expectRefused(() => createGroup(json, null, 'Lift01'), 'group-name-taken'); // transform + components
    expectRefused(() => createGroup(json, null, 'Rot'), 'group-name-taken'); // rotation
    expectRefused(() => createGroup(json, null, 'A/B'), 'slash-in-name');
    expectRefused(() => createGroup(json, 'Ref', 'G'), 'inside-reference');
    expectRefused(() => createGroup(json, 'Nope', 'G'), 'not-found');
  });
});

describe('rv-glb-nodes: idempotency', () => {
  /** A restructuring script in the style of plan-610 Phase 5, re-runnable. */
  function restructure(json: Json): number {
    let n = 0;
    const count = (r: { referencesRewritten: number; nameFieldsRewritten: number }): void => { n += r.referencesRewritten + r.nameFieldsRewritten; };
    if (findByPath(json, 'Signals') === null) count(renameNode(json, 'PLC', 'Signals'));
    count(renameNode(json, 'PLC_Programs', 'PLC', { skipIfDone: true }));
    count(createGroup(json, null, 'Kinematics'));
    count(createGroup(json, null, 'Simulation'));
    count(moveNodes(json, [
      { path: 'Lift01', newParentPath: 'Kinematics' },
      { path: 'Kin', newParentPath: 'Kinematics' },
      { path: 'Grip', newParentPath: 'Simulation' },
    ], { skipIfDone: true }));
    count(renameNode(json, 'Signals', 'Signals'));
    count(moveNode(json, 'Simulation/Grip', 'Simulation'));
    return n;
  }

  it('a second run changes nothing — 0 rewrites, identical GLB bytes', () => {
    const { json } = readGlb(writeGlb(fixture(), Buffer.alloc(0))) as { json: Json };
    const first = restructure(json);
    expect(first).toBeGreaterThan(0);
    const afterFirst = bytes(json);
    expect(restructure(json)).toBe(0);
    expect(bytes(json).equals(afterFirst)).toBe(true);
    expect(rv(json, 'Kinematics/Kin').Kinematic.Parent).toBe('Kinematics/Lift01');
    expect(rv(json, 'Kinematics/Lift01').Drive_Cylinder.In.path).toBe('Cell/Signals/FG01/Y');
  });
});

// ─── Parity with the editor ──────────────────────────────────────────

/**
 * What `planDocumentReferenceRewrite` (rv-asset-document.ts) hands the core,
 * rebuilt over a real `NodeRegistry` of the fixture: the registry's ONE chain
 * (`resolveWithStage` with the reference's componentType and the referrer as
 * scope; a typed miss that exactly names a node of a late type follows it),
 * `outermostReference` for foreign content, the editor's name lookup. Applies
 * the planned steps to a copy of the JSON and returns it.
 */
function editorRewrite(source: Json, moves: Map<string, string>): Json {
  const out = clone(source);
  const { registry, root, byIndex } = registryFromGlbJson(source as GltfJson, 'Cell');
  const indexOf = new Map<Object3D, number>();
  for (const [i, o] of byIndex) indexOf.set(o, i);
  const nodesByPath = new Map<string, Object3D>();
  const referrers: { nodePath: string; extras: Record<string, unknown> }[] = [];
  registry.forEachNode((path, node) => {
    if (registry.getPathForNode(node) !== path) return;
    const extras = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!extras || typeof extras !== 'object') return;
    nodesByPath.set(path, node);
    referrers.push({ nodePath: path, extras });
  });
  const namedUnder = (r: Object3D, name: string): Object3D[] => {
    const found: Object3D[] = [];
    r.traverse((n) => { if (n.name === name) found.push(n); });
    return found;
  };
  const isEager = (ct: string): boolean => {
    const t = ct.slice(ct.lastIndexOf('.') + 1);
    return ct === 'UnityEngine.Transform' || t.includes('Drive') || t.includes('Sensor') || t.includes('Signal') || t.includes('PLC');
  };
  const plan = planReferenceRewrite({
    referrers,
    moves,
    isForeign: (p) => { const n = nodesByPath.get(p); return !!n && outermostReference(n, root) !== null; },
    resolveOld: ({ path, componentType, referrerPath }) => {
      const referrer = nodesByPath.get(referrerPath);
      if (!referrer) return null;
      let hit = registry.resolveWithStage({ path }, componentType ?? '', referrer);
      if (!hit && componentType && !isEager(componentType)) {
        const asNode = registry.resolveWithStage({ path }, '', referrer);
        if (asNode && asNode.stage === 'exact') hit = asNode;
      }
      if (!hit) return null;
      const canonical = registry.getPathForNode(hit.node);
      return canonical === null ? null : { canonical, spelling: hit.spelling, stage: hit.stage, scopeRootPath: hit.scopeRootPath };
    },
    resolveName: ({ name, referrerPath }) => {
      const owner = nodesByPath.get(referrerPath);
      if (!owner) return null;
      const inOwner = namedUnder(owner, name);
      if (inOwner.length === 1) return { canonical: registry.getPathForNode(inOwner[0]) };
      if (inOwner.length > 1) return { canonical: null, ambiguous: true };
      const inScope = namedUnder(registry.enclosingScope(owner).root, name);
      if (inScope.length > 1) return { canonical: null, ambiguous: true };
      const node = inScope[0] ?? registry.getNode(name);
      return node ? { canonical: registry.getPathForNode(node) } : null;
    },
  });
  for (const s of [...plan.steps, ...plan.nameSteps]) {
    const node = nodesByPath.get(s.oldNodePath)!;
    const holder = node === root ? out.scenes[0] : out.nodes[indexOf.get(node)!];
    holder.extras.realvirtual[s.componentType][s.field] = s.value;
  }
  return out;
}

/** Every stored rv extras block of a JSON: the scene's and each node's, by node index. */
const allExtras = (json: Json): unknown => ({ scene: json.scenes[0].extras, nodes: json.nodes.map((n: Json) => n.extras ?? null) });

describe('rv-glb-nodes: parity with the editor rewrite', () => {
  const cases: { name: string; moves: Map<string, string>; run: (json: Json) => void }[] = [
    { name: 'rename PLC → Signals', moves: new Map([['Cell/PLC', 'Cell/Signals']]), run: (j) => renameNode(j, 'PLC', 'Signals') },
    { name: 'rename PLC_Programs → Progs', moves: new Map([['Cell/PLC_Programs', 'Cell/Progs']]), run: (j) => renameNode(j, 'PLC_Programs', 'Progs') },
    { name: 'rename MU1 (name field)', moves: new Map([['Cell/Src/MU1', 'Cell/Src/MU_Part']]), run: (j) => renameNode(j, 'Src/MU1', 'MU_Part') },
    {
      name: 'batch move Lift01 + Grip + PLC into Group1',
      moves: new Map([['Cell/Lift01', 'Cell/Group1/Lift01'], ['Cell/Grip', 'Cell/Group1/Grip'], ['Cell/PLC', 'Cell/Group1/PLC']]),
      run: (j) => moveNodes(j, [{ path: 'Lift01', newParentPath: 'Group1' }, { path: 'Grip', newParentPath: 'Group1' }, { path: 'PLC', newParentPath: 'Group1' }]),
    },
  ];
  for (const c of cases) {
    it(`${c.name}: lib and editor chain write the same reference values`, () => {
      const source = fixture();
      const editor = editorRewrite(source, c.moves);
      const lib = fixture();
      c.run(lib);
      expect(allExtras(lib)).toEqual(allExtras(editor));
      // And something was written at all.
      expect(allExtras(lib)).not.toEqual(allExtras(source));
    });
  }
});

describe('rv-glb-nodes: signal types mirror', () => {
  it('SIGNAL_COMPONENT_TYPES equals SIGNAL_TYPES of rv-signal-construction.ts', () => {
    expect([...SIGNAL_COMPONENT_TYPES]).toEqual([...SIGNAL_TYPES]);
  });
});
