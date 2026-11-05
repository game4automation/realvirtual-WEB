// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-637 Phase 1 — the runtime snapshot (sync stage).
 *
 * Demo cell (real `loadGLB` + bake, 30 s simulated): every drive node and
 * every source template has exactly one prim, the node table comes from the
 * same traversal as `model.usda`, helpers / overlays / clone MUs / MU pools
 * are absent, the materials sit under `/Root` (bindings survive the Kit
 * reference) and vertex-colour materials read `displayColor`.
 *
 * Synthetic (R2): a self-template source exports its AUTHORED materials (the
 * same ones a spawn gets), a pre-placed MU is in `preplaced[]` with its prim,
 * clone MUs are left out.
 */

import { describe, it, expect } from 'vitest';
import {
  BoxGeometry,
  CanvasTexture,
  CompressedTexture,
  DataTexture,
  FloatType,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  RGBAFormat,
  Scene,
  Texture,
  UnsignedByteType,
  type Material,
} from 'three';
import { unzipSync, strFromU8 } from 'three/examples/jsm/libs/fflate.module.js';
import { loadGLB, type LoadResult } from '../src/core/engine/rv-scene-loader';
import { RVLogicEngine } from '../src/core/engine/rv-logic-engine';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { RVSource, getSourceTemplateMaterial } from '../src/core/engine/rv-source';
import {
  buildRuntimeStageTree,
  dataImageToCanvas,
  exportRuntimeStage,
  isStageHelper,
  patchModelUsda,
  sanitizePrimName,
} from '../src/core/usd/runtime-stage-export';
import { buildTemplateTable } from '../src/core/usd/collect-stage-input';

const DEMO = '/demo-realvirtual/DemoRealvirtualWeb.glb';
const DT = 1 / 60;

/** Prim paths defined in a usda text (tiny parser: `def … "name"` + brace depth). */
function primPaths(usda: string): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [];
  let pending: string | null = null;
  let dictDepth = 0; // `customData = {` … `}` inside prim metadata is not a prim body
  for (const raw of usda.split('\n')) {
    const line = raw.trim();
    if (line.endsWith('= {')) { dictDepth++; continue; }
    if (dictDepth > 0 && line.startsWith('}')) { dictDepth--; continue; }
    const def = /^def\s+\w*\s*"([^"]+)"/.exec(line);
    if (def) {
      const path = `${stack.length ? stack[stack.length - 1] : ''}/${def[1]}`;
      out.add(path);
      if (line.endsWith('{')) stack.push(path); else pending = path;
      continue;
    }
    if (line.startsWith('{') && pending) { stack.push(pending); pending = null; continue; }
    if (line.startsWith('}')) stack.pop();
  }
  return out;
}

describe('usd-live-link runtime stage (demo cell)', () => {
  it('maps every drive node and source template to exactly one prim, without helpers and clone MUs', async () => {
    const scene = new Scene();
    const bytes = await (await fetch(DEMO)).arrayBuffer();
    const load: LoadResult = await loadGLB(DEMO, scene, {
      data: bytes,
      loadKinematicsSidecar: false,
      bakeRegistry: new BakeRegistry(),
      bakePickPort: createPickBuildPort({ createWorker: () => null }),
    });
    // plan-769 Phase 6: loadGLB builds no logic any more — the engine it used to
    // return, built the same way here (never started, as before).
    const logic = RVLogicEngine.build(load.root, load.registry, load.signalStore);
    for (let i = 0; i < 30 / DT; i++) {
      logic.fixedUpdate(DT);
      for (const d of load.drives) d.update(DT);
      load.transportManager.update(DT);
    }
    const tm = load.transportManager;
    expect(tm.mus.length).toBeGreaterThan(0);

    const table = buildTemplateTable(tm.sources);
    const exclude = new Set<Object3D>();
    for (const mu of tm.mus) if (!mu.isInstanced && !(mu as { preplaced?: boolean }).preplaced) exclude.add(mu.node);
    const snap = await exportRuntimeStage({
      root: load.root,
      templates: table.templates,
      exclude,
      preplaced: tm.preplacedMUs.map((mu) => ({ muId: mu.id, node: mu.node })),
    });

    const files = unzipSync(snap.usdz);
    expect(Object.keys(files)[0]).toBe('model.usda');
    const usda = strFromU8(files['model.usda']);
    const prims = primPaths(usda);

    // Same traversal: unique paths, one per node, all present in the file.
    expect(snap.nodes.length).toBe(snap.primPaths.length);
    expect(new Set(snap.primPaths).size).toBe(snap.primPaths.length);
    expect(snap.primPaths.filter((p) => !prims.has(p))).toEqual([]);

    // Every visible drive node has exactly one prim.
    const visible = (n: Object3D) => { for (let o: Object3D | null = n; o; o = o.parent) if (!o.visible) return false; return true; };
    const drives = load.drives.map((d) => d.node).filter(visible);
    expect(drives.length).toBeGreaterThan(5);
    for (const n of drives) {
      const i = snap.indexOf.get(n);
      expect(i, n.name).toBeDefined();
      expect(snap.primPaths.filter((p) => p === snap.primPaths[i!])).toHaveLength(1);
    }
    // Every template (hidden at runtime) has its prim.
    expect(snap.templates.length).toBe(table.templates.length);
    for (const p of snap.templates) expect(prims.has(p), p).toBe(true);

    // No helpers, no clone MUs, no pools.
    for (const n of snap.nodes) {
      expect(isStageHelper(n), n.name).toBe(false);
      expect((n as InstancedMesh).isInstancedMesh).toBeFalsy();
    }
    for (const n of exclude) expect(snap.indexOf.has(n)).toBe(false);

    // Materials under Root; vertex-colour materials read displayColor.
    expect(usda).not.toContain('</Materials/');
    expect(prims.has('/Root/Materials')).toBe(true);
    if (usda.includes('primvars:displayColor') || [...Object.keys(files)].some((f) => f.startsWith('geometries/') && strFromU8(files[f]).includes('displayColor'))) {
      expect(usda).toContain('UsdPrimvarReader_float3');
    }
  }, 120_000);
});

describe('usd-live-link runtime stage (synthetic)', () => {
  function cell() {
    const scene = new Scene();
    const root = new Object3D(); root.name = 'Cell';
    scene.add(root);
    return { scene, root };
  }

  it('self-template source: the exported template has the materials a spawn gets', () => {
    const { root } = cell();
    const real = new MeshStandardMaterial({ color: 0x3366ff });
    const srcNode = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), real);
    srcNode.name = 'Feeder';
    srcNode.add(new Mesh(new BoxGeometry(0.1, 0.1, 0.1), real)); // multi-mesh → clone path
    root.add(srcNode);
    srcNode.userData.realvirtual = { Source: { ThisObjectAsMU: '' } };
    const source = new RVSource(srcNode);
    source.computeSpawnConfig({});
    expect(source.sourceIsTemplate).toBe(true);
    source.spawnParent = root;
    source.setTemplate(srcNode);
    // At runtime the source mesh carries the hidden-fill helper material.
    expect(srcNode.material).not.toBe(real);
    expect(getSourceTemplateMaterial(srcNode)).toBe(real);

    const spawned = source.spawnMU()!;
    const spawnedMat = (spawned.node as Mesh).material as Material;
    const tree = buildRuntimeStageTree({ root, templates: [srcNode], exclude: new Set([spawned.node]), preplaced: [] });
    const exported = tree.scene.getObjectByName('Feeder') as Mesh;
    expect(exported.material).toBe(spawnedMat);
    expect(exported.material).toBe(real);
    // Overlay shells are not exported, the clone MU is not exported.
    expect(tree.nodes.some((n) => n.userData._isGhostOverlay)).toBe(false);
    expect(tree.indexOf.has(spawned.node)).toBe(false);
  });

  it('pre-placed MU appears in preplaced[] with its prim; clone MUs and pools are left out', () => {
    const { root } = cell();
    const pre = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshStandardMaterial()); pre.name = 'Pallet 1';
    const clone = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshStandardMaterial()); clone.name = 'Box_3';
    const pool = new InstancedMesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshStandardMaterial(), 4); pool.name = '__muPool_Box';
    root.add(pre, clone, pool);
    const tree = buildRuntimeStageTree({ root, templates: [], exclude: new Set([clone]), preplaced: [{ muId: 42, node: pre }] });
    expect(tree.preplaced).toEqual([{ muId: 42, nodeIndex: tree.indexOf.get(pre) }]);
    expect(tree.primPaths[tree.preplaced[0].nodeIndex]).toBe('/Root/Scenes/Scene/Cell/Pallet1');
    expect(tree.indexOf.has(clone)).toBe(false);
    expect(tree.indexOf.has(pool)).toBe(false);
  });

  it('names are unique stage-wide and the live tree keeps its names and visibility', () => {
    const { root } = cell();
    const a = new Object3D(); a.name = 'Axis';
    const b = new Object3D(); b.name = 'Axis';
    const hidden = new Object3D(); hidden.name = 'Hidden'; hidden.visible = false;
    const tpl = new Object3D(); tpl.name = '1 Template'; tpl.visible = false;
    root.add(a, b, hidden, tpl);
    a.add(new Object3D()); // unnamed → Object
    const tree = buildRuntimeStageTree({ root, templates: [tpl], exclude: new Set(), preplaced: [] });
    expect(tree.primPaths).toContain('/Root/Scenes/Scene/Cell/Axis');
    expect(tree.primPaths).toContain('/Root/Scenes/Scene/Cell/Axis_1');
    expect(tree.indexOf.has(hidden)).toBe(false);
    expect(tree.templates).toEqual(['/Root/Scenes/Scene/Cell/_1Template']);
    expect(tpl.visible).toBe(false);
    expect(tpl.name).toBe('1 Template');
    expect(sanitizePrimName('')).toBe('Object');
  });

  it('root carries its world transform; children their local matrix', () => {
    const scene = new Scene();
    const parent = new Object3D(); parent.position.set(5, 0, 0);
    const root = new Object3D(); root.name = 'Model'; root.position.set(0, 1, 0);
    const child = new Object3D(); child.name = 'C'; child.position.set(0, 0, 2);
    scene.add(parent); parent.add(root); root.add(child);
    const tree = buildRuntimeStageTree({ root, templates: [], exclude: new Set(), preplaced: [] });
    const r = tree.scene.children[0];
    expect(r.matrix.elements.slice(12, 15)).toEqual([5, 1, 0]);
    expect(r.children[0].matrix.elements.slice(12, 15)).toEqual([0, 0, 2]);
  });

  it('textures: DataTexture converted, compressed / empty maps left out of a clone, canvas kept; live materials untouched', async () => {
    const { root } = cell();
    // 2×2 RGBA DataTexture, used by two materials (converted once).
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 128]);
    const data = new DataTexture(rgba, 2, 2, RGBAFormat);
    // Float RGBA DataTexture (normalised).
    const floats = new DataTexture(new Float32Array([0, 0.5, 2, 1, 4, 0, 0, 1]), 2, 1, RGBAFormat, FloatType);
    // Compressed texture without texture utils, and a texture without an image.
    const compressed = new CompressedTexture([{ data: new Uint8Array(8), width: 4, height: 4 }] as never, 4, 4);
    const empty = new Texture();
    // A plain canvas texture the exporter reads as-is.
    const canvas = document.createElement('canvas');
    canvas.width = 4; canvas.height = 4;
    canvas.getContext('2d')!.fillRect(0, 0, 4, 4);
    const canvasTex = new CanvasTexture(canvas);

    const matData = new MeshStandardMaterial({ map: data, roughnessMap: floats });
    const matShared = new MeshStandardMaterial({ map: data, color: 0x00ff00 });
    const matBad = new MeshStandardMaterial({ map: compressed, normalMap: empty, color: 0xff0000, roughness: 0.3 });
    const matCanvas = new MeshStandardMaterial({ map: canvasTex });
    const mats = [matData, matShared, matBad, matCanvas];
    const geo = new BoxGeometry(0.1, 0.1, 0.1);
    const meshes = mats.map((m, i) => {
      const mesh = new Mesh(geo, m); mesh.name = `M${i}`; root.add(mesh); return mesh;
    });
    const live = mats.map((m) => ({ map: m.map, roughnessMap: m.roughnessMap, normalMap: m.normalMap }));
    matBad.userData.self = matBad; // circular userData must not break the clone

    const snap = await exportRuntimeStage({ root, templates: [], exclude: new Set(), preplaced: [] });
    expect(snap.texturesConverted).toBe(2); // data + floats, each once
    expect(snap.texturesSkipped).toBe(2); // compressed + empty

    const files = unzipSync(snap.usdz);
    const pngs = Object.keys(files).filter((f) => f.startsWith('textures/'));
    expect(pngs).toHaveLength(3); // data, floats, canvas
    const usda = strFromU8(files['model.usda']);
    expect(usda).toContain('inputs:roughness = 0.3'); // the stripped clone keeps its factors

    // Live meshes and materials are unchanged.
    mats.forEach((m, i) => {
      expect(meshes[i].material).toBe(m);
      expect(m.map).toBe(live[i].map);
      expect(m.roughnessMap).toBe(live[i].roughnessMap);
      expect(m.normalMap).toBe(live[i].normalMap);
    });
    expect(data.image.data).toBe(rgba);
    expect(matBad.userData.self).toBe(matBad);

    // Export tree: one clone per material, the same converted texture for both users.
    const tree = buildRuntimeStageTree({ root, templates: [], exclude: new Set(), preplaced: [] });
    const exp = (name: string) => (tree.scene.getObjectByName(name) as Mesh).material as MeshStandardMaterial;
    expect(exp('M0')).not.toBe(matData);
    expect(exp('M0').map).toBe(exp('M1').map);
    expect(exp('M0').map!.image).toBeInstanceOf(HTMLCanvasElement);
    expect(exp('M2').map).toBeNull();
    expect(exp('M2').normalMap).toBeNull();
    expect(exp('M2').color.getHex()).toBe(0xff0000);
    expect(exp('M3')).toBe(matCanvas);
  });

  it('dataImageToCanvas: RGBA bytes keep their row order, float data is normalised, oversize is subsampled', () => {
    const c = dataImageToCanvas({ data: new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255]), width: 1, height: 2 }, RGBAFormat, UnsignedByteType)!;
    const px = (c as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 1, 2).data;
    expect(Array.from(px)).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
    const f = dataImageToCanvas({ data: new Float32Array([2, 1, 0, 2]), width: 1, height: 1 }, RGBAFormat, FloatType)!;
    expect(Array.from((f as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 1, 1).data)).toEqual([255, 128, 0, 255]);
    const big = dataImageToCanvas({ data: new Uint8Array(8 * 2 * 4), width: 8, height: 2 }, RGBAFormat, UnsignedByteType, 4)!;
    expect([big.width, big.height]).toEqual([4, 1]);
    expect(dataImageToCanvas({ data: new Int32Array(4), width: 1, height: 1 }, RGBAFormat, UnsignedByteType)).toBeNull();
    expect(dataImageToCanvas({ data: new Uint8Array(3), width: 1, height: 1 }, RGBAFormat, UnsignedByteType)).toBeNull();
  });

  it('patchModelUsda: primvar reader for untextured vertex-colour materials, Materials under Root', () => {
    const usda = [
      '#usda 1.0', '(', '\tdefaultPrim = "Root"', ')', '',
      'def Xform "Root"', '{', '\tdef Xform "A" (', '\t\tprepend references = @./geometries/Geometry_1.usda@', '\t)', '\t{',
      '\t\trel material:binding = </Materials/Material_7>', '\t}', '}', '', '',
      'def "Materials"', '{', '\tdef Material "Material_7"', '\t{',
      '\t\ttoken outputs:surface.connect = </Materials/Material_7/PreviewSurface.outputs:surface>', '',
      '\t\tdef Shader "PreviewSurface"', '\t\t{', '\t\t\tuniform token info:id = "UsdPreviewSurface"',
      '\t\t\tcolor3f inputs:diffuseColor = (1, 1, 1)', '\t\t\ttoken outputs:surface', '\t\t}', '\t}', '}', '',
    ].join('\n');
    const out = patchModelUsda(usda, new Set([7]));
    expect(out).not.toContain('</Materials/');
    expect(out).toContain('rel material:binding = </Root/Materials/Material_7>');
    expect(out).toContain('color3f inputs:diffuseColor.connect = </Root/Materials/Material_7/PrimvarReader_displayColor.outputs:result>');
    expect(out).toContain('uniform token info:id = "UsdPrimvarReader_float3"');
    const prims = primPaths(out);
    expect(prims.has('/Root/Materials/Material_7/PrimvarReader_displayColor')).toBe(true);
    expect(prims.has('/Root/Materials/Material_7/PreviewSurface')).toBe(true);
    expect(prims.has('/Materials')).toBe(false);
  });
});
