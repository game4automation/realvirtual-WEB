// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
//
// plan-2246 §9.1 — splitting oversized single-material geometries around
// `parseAsync`, at a lowered test threshold (small, deterministic):
// - the length counter equals three's USDZExporter output character for
//   character (R2 #2: unused vertices, missing normals, the UV quirk, colours);
// - `splitGeometryForExport` keeps every triangle once in read order with its
//   corner data, compact vertex subsets, and never touches the input (bake-picking 10);
// - `withSplitOversizedMeshes` restores the tree after success and after a throw,
//   splits a shared geometry once, releases the copies, never splits multi-material;
// - end to end: tables unchanged, parts `rvPart_<k>` named against the real
//   siblings (R2 #3), named refusals `usd-geometry-too-large` and
//   `usd-model-layer-too-large` (R2 #4) instead of "Invalid string length";
// - the animation pipeline (`buildStageWithMus` + `appendMuToStage` +
//   `exportAnimatedUsdz`): MU tables unchanged, animated split mesh keeps its
//   tracks (R2 #1), MU with a mesh root.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AnimationClip, BoxGeometry, BufferAttribute, BufferGeometry, Float32BufferAttribute, Matrix4, Mesh, MeshStandardMaterial,
  Object3D, PlaneGeometry, QuaternionKeyframeTrack, Scene, SphereGeometry, TorusGeometry, VectorKeyframeTrack,
} from 'three';
import { USDZExporter } from 'three/examples/jsm/exporters/USDZExporter.js';
import { strFromU8, unzipSync } from 'three/examples/jsm/libs/fflate.module.js';
import {
  MAX_UV_Y_CHARS, UsdExportTooLargeError, exceedsSerializedLimit, isUsdExportTooLargeError, maxNumberChars,
  modelLayerLengthBound,
  serializedGeometryLength, serializedLengthBound, setUsdExportLimitsForTests, splitGeometryForExport,
  withSplitOversizedMeshes,
} from '../src/core/usd/usd-export-geometry-split';
import { allocatePartNames } from '../src/core/usd/usd-prim-names';
import { buildRuntimeStageTree, exportRuntimeStage } from '../src/core/usd/runtime-stage-export';
import { buildStageWithMus } from '../src/core/usd/mu-export';
import { TimeSampleStore } from '../src/core/usd/time-sample-store';
import { exportAnimatedUsdz } from '@rv-private/plugins/usd/anim/anim-usdz';

const PY = process.env.RV_USD_PYTHON;

afterEach(() => { vi.restoreAllMocks(); });

const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

/** The geometry file text three writes for `g` with one material. */
async function exporterFileText(g: BufferGeometry): Promise<string> {
  const scene = new Scene(); scene.add(new Mesh(g, new MeshStandardMaterial()));
  const files = unzipSync(new Uint8Array(await new USDZExporter().parseAsync(scene)));
  const name = Object.keys(files).find((k) => k.startsWith('geometries/'))!;
  return strFromU8(files[name]);
}

function colored(g: BufferGeometry, normalizedBytes: boolean): BufferGeometry {
  const n = g.attributes.position.count;
  if (normalizedBytes) {
    const c = new Uint8Array(n * 3); for (let i = 0; i < c.length; i++) c[i] = (i * 37) % 256;
    g.setAttribute('color', new BufferAttribute(c, 3, true));
  } else {
    const c = new Float32Array(n * 3); for (let i = 0; i < c.length; i++) c[i] = ((i * 0.00137) % 1) - 0.25;
    g.setAttribute('color', new Float32BufferAttribute(c, 3));
  }
  return g;
}

/** Indexed geometry whose index references only every other vertex (unused vertices). */
function withUnusedVertices(): BufferGeometry {
  const g = new BufferGeometry();
  const p = new Float32Array(3 * 40); for (let i = 0; i < p.length; i++) p[i] = Math.sin(i) * 1e4;
  g.setAttribute('position', new BufferAttribute(p, 3));
  g.setIndex([0, 2, 4, 4, 2, 6, 8, 10, 12]);
  return g;
}

/** Strip of quads: neighbouring triangles share vertices across any part boundary (R2 #7). */
function strip(quads: number): BufferGeometry {
  const g = new PlaneGeometry(10, 1, quads, 1);
  colored(g, true);
  const uv1 = new Float32Array(g.attributes.position.count * 2); for (let i = 0; i < uv1.length; i++) uv1[i] = i * 0.013;
  g.setAttribute('uv1', new Float32BufferAttribute(uv1, 2));
  return g;
}

/** Corner data of every triangle in read order (getX reads, so encodings are compared as the exporter sees them). */
function corners(g: BufferGeometry): number[][] {
  const out: number[][] = [];
  const n = g.index ? g.index.count : g.attributes.position.count;
  const names = ['position', 'normal', 'uv', 'uv1', 'color'].filter((a) => g.attributes[a]);
  for (let i = 0; i < n; i++) {
    const v = g.index ? g.index.getX(i) : i;
    const row: number[] = [];
    for (const a of names) {
      const attr = g.attributes[a];
      row.push(attr.getX(v), attr.getY(v));
      if (attr.itemSize > 2) row.push(attr.getZ(v));
    }
    out.push(row);
  }
  return out;
}

function arraysOf(g: BufferGeometry): Uint8Array[] {
  const out = Object.values(g.attributes).map((a) => new Uint8Array((a as BufferAttribute).array.buffer.slice(0)));
  if (g.index) out.push(new Uint8Array(g.index.array.buffer.slice(0)));
  return out;
}

describe('serialized length counter (R2 #2)', () => {
  it('equals the real exporter file text character for character', async () => {
    quiet();
    const noUv = new PlaneGeometry(1e5, 2e-5, 5, 5); noUv.deleteAttribute('uv');
    const noNormals = new BoxGeometry(1, 2, 3); noNormals.deleteAttribute('normal');
    const twoUv = new BoxGeometry(1, 1, 1, 2, 2, 2);
    twoUv.setAttribute('uv1', new Float32BufferAttribute(new Float32Array(twoUv.attributes.position.count * 2).map((_, i) => i * 1e-9), 2));
    const cases: BufferGeometry[] = [
      new BoxGeometry(1.234567, 2.5, 3.25, 3, 3, 3),
      new SphereGeometry(7.1, 24, 16).toNonIndexed(),
      colored(new TorusGeometry(100.333, 3, 12, 40), false),
      colored(new BoxGeometry(2, 2, 2, 2, 2, 2), true),
      noUv, noNormals, twoUv, withUnusedVertices(),
    ];
    for (const g of cases) {
      const real = (await exporterFileText(g)).length;
      expect(serializedGeometryLength(g)).toBe(real);
      expect(serializedLengthBound(g)).toBeGreaterThanOrEqual(real);
    }
  });

  it('decides on the exact length: at the limit no split, one below it a split', () => {
    const g = strip(8);
    const exact = serializedGeometryLength(g);
    expect(exceedsSerializedLimit(g, exact)).toBe(false);
    expect(exceedsSerializedLimit(g, exact - 1)).toBe(true);
    // Unused vertices count: the exporter writes every vertex of every attribute.
    const sparse = withUnusedVertices();
    expect(serializedGeometryLength(sparse)).toBeGreaterThan(40 * 3 * 8);
  });
});

/**
 * Values with the LONGEST `toPrecision(7)` texts (post-review R1): fixed notation at
 * e = -6 ('-0.000001234567', 15), the exponent edges of float32, zero and -0. UV y
 * near 1 and tiny gives the longest `1 - y` texts.
 */
const HARD = [-0.000001234567, 0.000009999999, -0.0000015, 1e-7, -9.999999e-7, -3.4e38, 1.2e-38, 3e-45, 0, -0, -1234567, 0.1234567];
/** Only the 15-character texts: no short value can hide an under-estimate. */
const HARD_LONG = [-0.000001234567, -0.000009999999, -0.0000015123456];
const HARD_UV = [0.9999999, 1.000001, 0.999998, 1e-7, -0.000001234567, 2.5e-6, 0, -0];
function hardGeometry(vertices: number, indexed: boolean, values: number[] = HARD): BufferGeometry {
  const g = new BufferGeometry();
  const fill = (n: number, values: number[], shift: number) => Float32Array.from({ length: n }, (_, i) => values[(i + shift) % values.length]);
  g.setAttribute('position', new Float32BufferAttribute(fill(vertices * 3, values, 0), 3));
  g.setAttribute('normal', new Float32BufferAttribute(fill(vertices * 3, values, 5), 3));
  // No UV with HARD_LONG: the generous UV bound must not hide a short number bound.
  if (values !== HARD_LONG) g.setAttribute('uv', new Float32BufferAttribute(fill(vertices * 2, HARD_UV, 0), 2));
  g.setAttribute('color', new Float32BufferAttribute(fill(vertices * 3, values, 7), 3));
  if (indexed) g.setIndex(Array.from({ length: (vertices - 2) * 3 }, (_, k) => Math.floor(k / 3) + (k % 3)));
  return g;
}

describe('number bounds with the longest texts (post-review R1)', () => {
  it('the exact counter stays exact and the bound stays above the real exporter text', async () => {
    quiet();
    for (const g of [hardGeometry(300, true), hardGeometry(300, false), hardGeometry(301, true), hardGeometry(300, true, HARD_LONG)]) {
      const real = (await exporterFileText(g)).length;
      expect(serializedGeometryLength(g)).toBe(real);
      expect(serializedLengthBound(g)).toBeGreaterThanOrEqual(real);
    }
    // The per-type maxima hold for every value of the type (getX = what the exporter prints).
    const longest = (attr: BufferAttribute) => {
      let m = 0;
      for (let i = 0; i < attr.count; i++) m = Math.max(m, attr.getX(i).toPrecision(7).length);
      return m;
    };
    const range = (n: number, min: number) => Array.from({ length: n }, (_, i) => min + i);
    const cases: Array<[BufferAttribute, number]> = [
      [new BufferAttribute(Uint8Array.from(range(256, 0)), 1, true), 11],
      [new BufferAttribute(Int8Array.from(range(256, -128)), 1, true), 12],
      [new BufferAttribute(Uint16Array.from(range(65536, 0)), 1, true), 13],
      [new BufferAttribute(Int16Array.from(range(65536, -32768)), 1, true), 14],
      [new BufferAttribute(Int32Array.from([-2147483648, 2147483647, -1234567, 9999999, 0]), 1, false), 12],
      [new BufferAttribute(Uint32Array.from([4294967295, 12345678, 1]), 1, false), 12],
      [new Float32BufferAttribute(Float32Array.from(HARD), 1), 15],
    ];
    for (const [attr, expected] of cases) {
      expect(maxNumberChars(attr)).toBe(expected);
      expect(longest(attr)).toBeLessThanOrEqual(maxNumberChars(attr));
    }
    expect(longest(new Float32BufferAttribute(Float32Array.from(HARD), 1))).toBe(15);
    for (const y of [...HARD_UV, ...HARD]) {
      const f = Math.fround(y);
      expect(String(1 - (f.toPrecision(7) as unknown as number)).length).toBeLessThanOrEqual(MAX_UV_Y_CHARS);
    }
  });

  it('every part of a split with such values stays within the limit, measured by the real exporter', async () => {
    quiet();
    for (const indexed of [true, false]) {
      const g = hardGeometry(300, indexed, HARD_LONG);
      const maxChars = Math.floor(serializedGeometryLength(g) / 4);
      const parts = splitGeometryForExport(g, maxChars, '/hard');
      expect(parts.length).toBeGreaterThan(3);
      expect(parts.flatMap(corners)).toEqual(corners(g));
      for (const part of parts) expect((await exporterFileText(part)).length).toBeLessThanOrEqual(maxChars);
    }
  });

  it('a multi-material mesh with such values: the model.usda bound is safe and refuses at the real length', async () => {
    quiet();
    const root = new Object3D(); root.name = 'Hall';
    const g = hardGeometry(30_000, true, HARD_LONG);
    g.addGroup(0, 3000, 0); g.addGroup(3000, g.index!.count - 3000, 1);
    const multi = new Mesh(g, [new MeshStandardMaterial(), new MeshStandardMaterial()]); multi.name = 'Multi'; root.add(multi);
    const tree = buildRuntimeStageTree({ root, templates: [], exclude: new Set(), preplaced: [] }, { primNames: 'sibling' });
    const real = strFromU8(unzipSync(new Uint8Array(await new USDZExporter().parseAsync(tree.scene, { includeAnchoringProperties: false })))['model.usda']).length;
    expect(modelLayerLengthBound(tree.scene)).toBeGreaterThanOrEqual(real);
    const restore = setUsdExportLimitsForTests({ maxModelLayerChars: real - 1 });
    try {
      await expect(exportRuntimeStage({ root, templates: [], exclude: new Set(), preplaced: [] }))
        .rejects.toMatchObject({ code: 'usd-model-layer-too-large', maxChars: real - 1 });
    } finally { restore(); }
  });
});

describe('splitGeometryForExport', () => {
  for (const indexed of [true, false]) {
    it(`keeps every triangle once, in read order, with its corner data (${indexed ? 'indexed' : 'not indexed'})`, () => {
      const g = indexed ? strip(24) : strip(24).toNonIndexed();
      const before = arraysOf(g);
      const exact = serializedGeometryLength(g);
      const maxChars = Math.floor(exact / 4);
      const parts = splitGeometryForExport(g, maxChars, '/p');
      expect(parts.length).toBeGreaterThan(3);
      // Triangle count and the reconstructed corner data are the same, in order.
      expect(parts.flatMap(corners)).toEqual(corners(g));
      for (const part of parts) {
        expect(serializedGeometryLength(part)).toBeLessThanOrEqual(maxChars);
        expect(part.index === null).toBe(!indexed);
        // Compact subset: exactly the vertices the part's triangles use (R2 #7).
        if (part.index) {
          const used = new Set(Array.from(part.index.array));
          expect(used.size).toBe(part.attributes.position.count);
          expect(Math.max(...used)).toBe(part.attributes.position.count - 1);
        }
        // Same encodings as the source (normalized byte colours stay bytes).
        expect(part.attributes.color.array).toBeInstanceOf(Uint8Array);
        expect((part.attributes.color as BufferAttribute).normalized).toBe(true);
      }
      if (indexed) {
        // Shared vertices across part boundaries are copied into each part that uses them.
        const total = parts.reduce((s, p) => s + p.attributes.position.count, 0);
        expect(total).toBeGreaterThan(g.attributes.position.count);
      }
      // Input untouched (bake-picking 10): index and attribute bytes identical.
      expect(arraysOf(g)).toEqual(before);
    });
  }

  it('refuses a triangle that alone exceeds the limit and a geometry that is no triangle list', () => {
    const g = strip(2);
    let error: unknown;
    try { splitGeometryForExport(g, 50, '/Root/Scenes/Scene/Big'); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(UsdExportTooLargeError);
    expect(error).toMatchObject({ code: 'usd-geometry-too-large', primPath: '/Root/Scenes/Scene/Big', maxChars: 50 });
    expect(isUsdExportTooLargeError(error)).toBe(true);
    const lines = new BufferGeometry(); lines.setAttribute('position', new Float32BufferAttribute(new Float32Array(3 * 4), 3));
    expect(() => splitGeometryForExport(lines, 1e9, '/x')).toThrow(UsdExportTooLargeError);
  });
});

/** Every mesh / object, its parent, children (identity and order), name, uuid and matrix. */
function treeShape(root: Object3D): unknown[] {
  const out: unknown[] = [];
  root.traverse((o) => out.push([o, o.parent, [...o.children], o.name, o.uuid, o.matrix.elements.join(',')]));
  return out;
}

function cell() {
  const root = new Object3D(); root.name = 'Cell';
  const material = new MeshStandardMaterial({ color: 0x336699 });
  const shared = strip(30);
  const big = new Mesh(shared, material); big.name = 'Big'; big.position.set(1, 2, 3); root.add(big);
  // Real children whose names look like parts or exporter names (R1 #4, R2 #3).
  const realPart = new Object3D(); realPart.name = 'rvPart_0'; big.add(realPart);
  const part0 = new Object3D(); part0.name = 'Part_0'; big.add(part0);
  const geo = new Mesh(new BoxGeometry(), material); geo.name = 'Geometry'; big.add(geo);
  const twin = new Mesh(shared, material); twin.name = 'Twin'; twin.rotation.z = 0.5; root.add(twin);
  const multi = new Mesh(strip(30), [material, new MeshStandardMaterial()]); multi.name = 'Multi';
  multi.geometry.addGroup(0, 30, 0); multi.geometry.addGroup(30, multi.geometry.index!.count - 30, 1); root.add(multi);
  return { root, big, twin, multi, shared };
}

const LIMIT = (g: BufferGeometry) => Math.floor(serializedGeometryLength(g) / 3);

describe('withSplitOversizedMeshes', () => {
  it('swaps in place during the run and restores the tree after success and after a throw', async () => {
    const c = cell();
    const tree = buildRuntimeStageTree({ root: c.root, templates: [], exclude: new Set(), preplaced: [] }, { primNames: 'sibling' });
    const shape = treeShape(tree.scene);
    const opts = { finalNames: tree.finalNames!, primPaths: tree.primPaths, maxChars: LIMIT(c.shared) };
    const bigClone = tree.scene.children[0].children[0] as Mesh;
    let seen: BufferGeometry[] = [];
    const info = await withSplitOversizedMeshes(tree.scene, opts, async (split) => {
      const stand = tree.scene.children[0].children[0];
      expect(stand).not.toBe(bigClone);
      expect((stand as Mesh).isMesh).toBeFalsy();
      expect(stand.name).toBe(bigClone.name);
      expect(stand.uuid).toBe(bigClone.uuid);
      expect(stand.matrix.equals(bigClone.matrix)).toBe(true);
      // Real children first, in order, then the parts.
      expect(stand.children.slice(0, 3)).toEqual(bigClone.children);
      const parts = stand.children.slice(3) as Mesh[];
      expect(parts.length).toBeGreaterThan(1);
      expect(parts.every((p) => /^_rvP\d+_\d+$/.test(p.name) && p.material === bigClone.material)).toBe(true);
      // Twin shares the source geometry: same part geometries (one split per source).
      const twinStand = tree.scene.children[0].children[1];
      expect(twinStand.children.map((p) => (p as Mesh).geometry)).toEqual(parts.map((p) => p.geometry));
      // Multi-material is never split.
      expect((tree.scene.children[0].children[2] as Mesh).isMesh).toBe(true);
      seen = parts.map((p) => p.geometry);
      return split;
    });
    expect(info.splitMeshes).toBe(2);
    expect(info.partGeometries).toBe(seen.length);
    // Part names: rvPart_0 is a real sibling, so the first part is rvPart_0_2.
    expect([...info.partNames.values()].slice(0, 3)).toEqual(['rvPart_0_2', 'rvPart_1', 'rvPart_2']);
    expect(treeShape(tree.scene)).toEqual(shape);
    // Copies released: no attribute arrays left reachable through them.
    for (const g of seen) { expect(Object.keys(g.attributes)).toEqual([]); expect(g.index).toBeNull(); }

    await expect(withSplitOversizedMeshes(tree.scene, opts, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(treeShape(tree.scene)).toEqual(shape);
  });

  it('allocates part names after the runtime names, never touching a real sibling', () => {
    expect(allocatePartNames([], 3)).toEqual(['rvPart_0', 'rvPart_1', 'rvPart_2']);
    expect(allocatePartNames(['rvPart_1', 'rvPart_0_2', 'Part_0'], 2)).toEqual(['rvPart_0', 'rvPart_1_2']);
    expect(allocatePartNames(['rvPart_0', 'rvPart_0_2'], 1)).toEqual(['rvPart_0_3']);
  });
});

/** Prim paths of a USDA text (indentation = nesting, exporter layout). */
function usdaPrimPaths(text: string): string[] {
  const stack: string[] = [], out: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^(\t*)def (?:\w+ )?"([^"]+)"/.exec(line);
    if (!m) continue;
    stack.length = m[1].length; stack.push(m[2]);
    out.push('/' + stack.join('/'));
  }
  return out;
}

describe('exportRuntimeStage with a lowered threshold', () => {
  it('tables are unchanged, parts are rvPart_<k> without customData, every table path resolves once', async () => {
    quiet();
    const c = cell();
    const input = { root: c.root, templates: [], exclude: new Set<Object3D>(), preplaced: [] };
    const plain = await exportRuntimeStage(input);
    const restore = setUsdExportLimitsForTests({ maxPartChars: LIMIT(c.shared) });
    let split;
    try { split = await exportRuntimeStage(input); } finally { restore(); }
    expect(split.nodes).toEqual(plain.nodes);
    expect(split.primPaths).toEqual(plain.primPaths);
    expect(split.addresses).toEqual(plain.addresses);
    expect(split.templates).toEqual(plain.templates);
    const files = unzipSync(split.usdz);
    const text = strFromU8(files['model.usda']);
    expect(text).not.toMatch(/_rvP\d|_rvN\d/);
    const paths = usdaPrimPaths(text);
    for (const p of split.primPaths) expect(paths.filter((q) => q === p), p).toHaveLength(1);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain('/Root/Scenes/Scene/Cell/Big/rvPart_0');
    expect(paths).toContain('/Root/Scenes/Scene/Cell/Big/rvPart_0_2');
    expect(paths).toContain('/Root/Scenes/Scene/Cell/Big/rvPart_1');
    expect(paths).toContain('/Root/Scenes/Scene/Cell/Twin/rvPart_0');
    // A part prim is a plain reference to its geometry file plus the material binding.
    const at = text.indexOf('def Xform "rvPart_1"');
    const block = text.slice(at, text.indexOf('}', at));
    expect(block).toContain('prepend references = @./geometries/Geometry_');
    expect(block).toContain('rel material:binding');
    expect(block).not.toContain('customData');
    // One geometry file per part (shared by Big and Twin), none for the unsplit source.
    const geometryFiles = Object.keys(files).filter((k) => k.startsWith('geometries/'));
    const referenced = new Set([...text.matchAll(/@\.\/(geometries\/Geometry_\d+\.usda)@/g)].map((m) => m[1]));
    expect(new Set(geometryFiles)).toEqual(referenced);
    const partFiles = new Set([...text.matchAll(/def Xform "rvPart_[^"]*" \(\n\s*prepend references = @\.\/(geometries\/[^@]+)@/g)].map((m) => m[1]));
    expect(geometryFiles.length).toBe(partFiles.size + 1); // + the BoxGeometry of `Geometry`
  });

  it('refuses a geometry that cannot be split small enough: usd-geometry-too-large with the prim path', async () => {
    quiet();
    const c = cell();
    const restore = setUsdExportLimitsForTests({ maxPartChars: 60 });
    try {
      await expect(exportRuntimeStage({ root: c.root, templates: [], exclude: new Set(), preplaced: [] }))
        .rejects.toMatchObject({ code: 'usd-geometry-too-large', primPath: '/Root/Scenes/Scene/Cell/Big', maxChars: 60 });
    } finally { restore(); }
    expect(c.big.geometry).toBe(c.shared);
  });

  it('bounds model.usda: many small multi-material meshes and repeated MUs refuse with usd-model-layer-too-large', async () => {
    quiet();
    const root = new Object3D(); root.name = 'Hall';
    const mats = [new MeshStandardMaterial(), new MeshStandardMaterial()];
    for (let i = 0; i < 40; i++) {
      const g = new BoxGeometry(1, 1, 1, 2, 2, 2); g.addGroup(0, 24, 0); g.addGroup(24, g.index!.count - 24, 1);
      const m = new Mesh(g, mats); m.name = `M${i}`; root.add(m);
    }
    const template = new Mesh(new BoxGeometry(), mats[0]); template.name = 'Tpl'; template.visible = false; root.add(template);
    const stage = buildStageWithMus({ root, templates: [template], exclude: new Set(), preplaced: [] },
      Array.from({ length: 30 }, (_, i) => ({ muId: i + 1, node: null, template, preplaced: false })));
    // The bound is safe: never below the real model.usda.
    const real = strFromU8(unzipSync(new Uint8Array(await new USDZExporter().parseAsync(stage.model.scene, { includeAnchoringProperties: false })))['model.usda']).length;
    const bound = modelLayerLengthBound(stage.model.scene);
    expect(bound).toBeGreaterThanOrEqual(real);
    expect(bound).toBeLessThan(real * 20);
    const store = new TimeSampleStore(30, stage.model.nodes.length); store.beginTick(0); store.endTick(); store.finish();
    const restore = setUsdExportLimitsForTests({ maxModelLayerChars: bound - 1 });
    try {
      await expect(exportAnimatedUsdz({ stage, primTracks: store.getPrimTracks(), muTracks: [], fps: 30, endFrame: 0 }))
        .rejects.toMatchObject({ code: 'usd-model-layer-too-large', primPath: 'model.usda', serializedChars: bound, maxChars: bound - 1 });
    } finally { restore(); }
    const input = { root, templates: [template], exclude: new Set<Object3D>(), preplaced: [] };
    const restore2 = setUsdExportLimitsForTests({ maxModelLayerChars: 1000 });
    try {
      await expect(exportRuntimeStage(input)).rejects.toMatchObject({ code: 'usd-model-layer-too-large' });
    } finally { restore2(); }
  });

  it('the model.usda bound counts animation samples exactly enough: safe, and close for a long take', async () => {
    quiet();
    const scene = new Scene();
    const nodes: Object3D[] = [];
    for (let i = 0; i < 20; i++) { const o = new Object3D(); o.name = `N${i}`; (nodes[i - 1] ?? scene).add(o); nodes.push(o); }
    const frames = 3000, times = Float32Array.from({ length: frames }, (_, f) => f / 60);
    const tracks = nodes.flatMap((o, i) => [
      new VectorKeyframeTrack(`${o.uuid}.position`, times, Float32Array.from({ length: frames * 3 }, (_, k) => Math.sin(k + i) * 1234.5678)),
      new QuaternionKeyframeTrack(`${o.uuid}.quaternion`, times, Float32Array.from({ length: frames * 4 }, (_, k) => Math.cos(k * 0.37 + i) * 0.5)),
    ]);
    const clip = new AnimationClip('take', frames / 60, tracks);
    const real = strFromU8(unzipSync(new Uint8Array(await new USDZExporter().parseAsync(scene,
      { includeAnchoringProperties: false, animations: [clip], animationFrameRate: 60 })))['model.usda']).length;
    const bound = modelLayerLengthBound(scene, { animations: [clip], animationFrameRate: 60 });
    expect(bound).toBeGreaterThanOrEqual(real);
    expect(bound).toBeLessThan(real * 1.1);
  });

  it.skipIf(!PY)('usd-core: parts carry every face, a material binding, the parent keeps the runtime matrix', async () => {
    quiet();
    const c = cell();
    const restore = setUsdExportLimitsForTests({ maxPartChars: LIMIT(c.shared) });
    let snapshot;
    try { snapshot = await exportRuntimeStage({ root: c.root, templates: [], exclude: new Set(), preplaced: [] }); } finally { restore(); }
    const dir = mkdtempSync(join(tmpdir(), 'rv-2246-'));
    try {
      const file = join(dir, 'stage.usdz');
      writeFileSync(file, snapshot.usdz);
      const script = [
        'import sys, json', 'from pxr import Usd, UsdGeom, UsdShade',
        's = Usd.Stage.Open(sys.argv[1])', 'out = {}',
        'for name in ("Big", "Twin"):',
        '    p = s.GetPrimAtPath("/Root/Scenes/Scene/Cell/" + name)',
        '    faces = 0; points = 0; bound = 0',
        '    parts = [c for c in p.GetChildren() if c.GetName().startswith("rvPart_") and c.GetChildren() and c.GetChildren()[0].IsA(UsdGeom.Mesh)]',
        '    for c in parts:',
        '        m = UsdGeom.Mesh(c.GetChildren()[0])',
        '        faces += len(m.GetFaceVertexCountsAttr().Get()); points += len(m.GetPointsAttr().Get())',
        '        bound += 1 if UsdShade.MaterialBindingAPI(c).GetDirectBinding().GetMaterial() else 0',
        '    x = UsdGeom.Xformable(p).GetLocalTransformation()',
        '    out[name] = {"faces": faces, "points": points, "bound": bound, "parts": len(parts), "m": [x[i][j] for i in range(4) for j in range(4)]}',
        'print(json.dumps(out))',
      ].join('\n');
      const r = spawnSync(PY!, ['-c', script, file], { encoding: 'utf8', windowsHide: true });
      expect(r.status, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout) as Record<string, { faces: number; points: number; bound: number; parts: number; m: number[] }>;
      const faces = c.shared.index!.count / 3;
      for (const name of ['Big', 'Twin'] as const) {
        expect(out[name].faces).toBe(faces);
        expect(out[name].bound).toBe(out[name].parts);
        expect(out[name].points).toBeGreaterThan(c.shared.attributes.position.count);
        const node = name === 'Big' ? c.big : c.twin;
        node.updateMatrix();
        out[name].m.forEach((v, i) => expect(v).toBeCloseTo(node.matrix.elements[i], 5));
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('animation pipeline (buildStageWithMus, appendMuToStage, exportAnimatedUsdz)', () => {
  function animatedRig() {
    const root = new Object3D(); root.name = 'Cell';
    const material = new MeshStandardMaterial();
    const shared = strip(30);
    const arm = new Mesh(shared, material); arm.name = 'Arm'; root.add(arm); // directly animated, split
    const template = new Mesh(shared, material); template.name = 'Tpl'; template.visible = false; root.add(template);
    const pre = new Mesh(shared, material); pre.name = 'Pre'; root.add(pre);
    const spawned = new Mesh(shared, material); spawned.name = 'Spawned'; // MU whose root is a mesh
    const stage = buildStageWithMus({ root, templates: [template], exclude: new Set(), preplaced: [{ muId: 1, node: pre }] }, [
      { muId: 1, node: pre, template: null, preplaced: true },
      { muId: 2, node: spawned, template, preplaced: false },
    ]);
    const store = new TimeSampleStore(30, stage.model.nodes.length);
    const m = new Matrix4(), s = new Matrix4();
    for (let f = 0; f <= 6; f++) {
      store.beginTick(f / 30);
      store.onNodes(stage.model.indexOf.get(arm)!, m.makeRotationZ(f * 0.2).multiply(s.makeScale(1 + f * 0.1, 1, 1)).elements);
      if (f === 0) store.onMuSpawn(1, -1, new Matrix4().makeTranslation(3, 0, 0).elements);
      if (f === 1) store.onMuSpawn(2, 0, new Matrix4().makeTranslation(0, 1, 0).elements);
      if (f >= 2 && f <= 4) store.onMuPoses(2, new Matrix4().makeRotationY(f * 0.3).setPosition(f, 1, 0).elements);
      if (f === 5) store.onMuDelete(2);
      store.endTick();
    }
    store.finish();
    return { stage, shared, input: { stage, primTracks: store.getPrimTracks(), muTracks: store.getMuTracks(), fps: 30 as const, endFrame: store.endFrame } };
  }

  /** The prim's own xform ops / visibility (up to its first nested prim), metadata stripped. */
  function ops(text: string, path: string): string {
    const paths = usdaPrimPaths(text);
    const lines = text.split('\n');
    let k = -1, seen = 0;
    for (let i = 0; i < lines.length; i++) if (/^\t*def /.test(lines[i]) && paths[seen++] === path) { k = i; break; }
    expect(k, path).toBeGreaterThanOrEqual(0);
    const out: string[] = [];
    for (let i = k + 1; i < lines.length && !/^\t*def /.test(lines[i]); i++) {
      if (/xformOp|visibility/.test(lines[i]) || /^\t+[-\d.e]+: /.test(lines[i])) out.push(lines[i]);
    }
    return out.join('\n');
  }

  it('MU indices and paths are unchanged, animated split mesh and mesh-rooted MU keep their tracks', async () => {
    quiet();
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 0, 1));
    try {
      const plainRig = animatedRig();
      const plain = strFromU8(unzipSync(await exportAnimatedUsdz(plainRig.input))['model.usda']);
      const splitRig = animatedRig();
      const restore = setUsdExportLimitsForTests({ maxPartChars: LIMIT(splitRig.shared) });
      let text: string;
      try { text = strFromU8(unzipSync(await exportAnimatedUsdz(splitRig.input))['model.usda']); } finally { restore(); }
      expect([...splitRig.stage.muPrimIndices]).toEqual([...plainRig.stage.muPrimIndices]);
      expect(splitRig.stage.primPaths).toEqual(plainRig.stage.primPaths);
      expect(splitRig.stage.finalNames).toEqual(plainRig.stage.finalNames);
      const paths = usdaPrimPaths(text);
      expect(new Set(paths).size).toBe(paths.length);
      for (const p of splitRig.stage.primPaths) expect(paths.filter((q) => q === p), p).toHaveLength(1);
      // Every exported mesh prim (model, template, pre-placed MU, spawned MU) has parts now.
      const meshPaths = splitRig.stage.primPaths.filter((_, i) => (splitRig.stage.clones[i] as Mesh).isMesh);
      expect(meshPaths).toHaveLength(4);
      for (const p of meshPaths) expect(paths, p).toContain(`${p}/rvPart_0`);
      // Same animation on the stand prims as on the unsplit mesh prims (R2 #1).
      const arm = splitRig.stage.primPaths.find((p) => p.endsWith('/Arm'))!;
      const spawnedMu = splitRig.stage.primPaths[splitRig.stage.muPrimIndices.get(2)!];
      for (const p of [arm, spawnedMu]) {
        const animated = ops(text, p);
        expect(animated).toMatch(/xformOp:(orient|transform)/);
        expect(animated).toBe(ops(plain, p));
      }
      expect(ops(text, arm)).toContain('xformOp:scale.timeSamples');
      expect(ops(text, arm)).toContain('xformOp:orient.timeSamples');
      expect(ops(text, spawnedMu)).toContain('visibility.timeSamples');
      expect(text).not.toMatch(/_rvP\d|_rvN\d/);
    } finally { vi.useRealTimers(); }
  });
});
