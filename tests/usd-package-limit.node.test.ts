// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, Object3D, Scene, Texture } from 'three';
import { USDZExporter } from 'three/examples/jsm/exporters/USDZExporter.js';
import * as fflate from 'three/examples/jsm/libs/fflate.module.js';
import {
  assertUsdzFilesFit, assertUsdzPackageSize, estimateStageUsdzPackageBytes, estimateUsdzPackageBytes,
  MAX_USDZ_PACKAGE_BYTES, setUsdPackageLimitForTests,
} from '../src/core/usd/usd-package-limit';
import { isUsdExportTooLargeError, UsdExportTooLargeError } from '../src/core/usd/usd-export-geometry-split';
import {
  buildRuntimeStageTree, compressForMount, exportRuntimeStage, repackUsdz, type RuntimeStageInput,
} from '../src/core/usd/runtime-stage-export';

// Native ESM exports cannot be spied on; keep real ZIP output through a mock.
vi.mock('three/examples/jsm/libs/fflate.module.js', async () => {
  const actual = await vi.importActual<typeof import('three/examples/jsm/libs/fflate.module.js')>(
    'three/examples/jsm/libs/fflate.module.js',
  );
  return { ...actual, zipSync: vi.fn(actual.zipSync) };
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function input(): RuntimeStageInput {
  const root = new Object3D(); root.name = 'Cell';
  const geometry = new BoxGeometry(1, 2, 3);
  const material = new MeshStandardMaterial();
  for (let i = 0; i < 4; i++) {
    const mesh = new Mesh(geometry, material); mesh.name = `Body_${i}`; root.add(mesh);
  }
  return { root, templates: [], exclude: new Set(), preplaced: [],
    registry: { getAddressForNode: () => '#part/\u00e4\u6a21\ud83d\ude80' } };
}

describe('stored USDZ package bound', () => {
  const cases: Array<{ name: string; files: Record<string, Uint8Array> }> = [
    { name: 'empty', files: {} },
    { name: 'empty layer', files: { 'model.usda': new Uint8Array() } },
    { name: 'mixed payloads', files: { 'model.usda': new Uint8Array(63), 'geometries/g.usda': new Uint8Array(8193),
      'textures/t.png': new Uint8Array(1024) } },
    { name: 'many tiny files', files: Object.fromEntries(Array.from({ length: 1500 }, (_, i) => [`g/${i}.usda`, new Uint8Array(i % 5)])) },
    { name: 'long and UTF-8 names', files: { [`${'long/'.repeat(60)}layer.usda`]: new Uint8Array(65),
      'textures/\u00e4\u6a21\ud83d\ude80.png': new Uint8Array(127) } },
    { name: 'alignment residues', files: Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`${'n'.repeat(i + 1)}.usda`, new Uint8Array(i)])) },
  ];
  for (const { name, files } of cases) it(`never underestimates zipSync or repackUsdz: ${name}`, () => {
    const estimate = estimateUsdzPackageBytes(files);
    expect(estimate).toBeGreaterThanOrEqual(fflate.zipSync(files, { level: 0 }).byteLength);
    expect(estimate).toBeGreaterThanOrEqual(repackUsdz(fflate, files).byteLength);
  });

  it('counts chunked model bytes without joining and accepts exactly the bound, rejects bound minus one', () => {
    const files = { 'model.usda': [new Uint8Array(19), new Uint8Array(33)] };
    const estimate = estimateUsdzPackageBytes(files);
    expect(estimate).toBe(estimateUsdzPackageBytes({ 'model.usda': new Uint8Array(52) }));
    let restore = setUsdPackageLimitForTests(estimate);
    try { expect(() => assertUsdzFilesFit(files)).not.toThrow(); } finally { restore(); }
    restore = setUsdPackageLimitForTests(estimate - 1);
    try {
      let error: unknown;
      try { assertUsdzFilesFit(files); } catch (e) { error = e; }
      expect(error).toBeInstanceOf(UsdExportTooLargeError);
      expect(isUsdExportTooLargeError(error)).toBe(true);
      expect((error as UsdExportTooLargeError).toDetails()).toEqual({
        code: 'usd-package-too-large', estimatedBytes: estimate, limitBytes: estimate - 1,
      });
    } finally { restore(); }
    expect(() => assertUsdzPackageSize(MAX_USDZ_PACKAGE_BYTES)).not.toThrow();
    expect(() => assertUsdzPackageSize(MAX_USDZ_PACKAGE_BYTES + 1)).toThrow('usd-package-too-large');
  });
});

describe('package guards around the exporter', () => {
  it('bounds shared geometry, inline multi-material geometry and UTF-8 post metadata before parseAsync', async () => {
    const model = input();
    model.root.add(new Mesh(new BoxGeometry(), [new MeshStandardMaterial(), new MeshStandardMaterial()]));
    const tree = buildRuntimeStageTree(model, { primNames: 'sibling' });
    const bound = estimateStageUsdzPackageBytes(tree.scene, { post: { finalNames: tree.finalNames!, prims: tree.prims } });
    const raw = await new USDZExporter().parseAsync(tree.scene, { includeAnchoringProperties: false });
    expect(bound).toBeGreaterThanOrEqual(raw.byteLength);
    const snapshot = await exportRuntimeStage(model);
    expect(bound).toBeGreaterThanOrEqual(snapshot.usdz.byteLength);
  });

  it('reserves textures before parseAsync without encoding them', () => {
    const scene = new Scene();
    const material = new MeshStandardMaterial();
    scene.add(new Mesh(new BoxGeometry(), material));
    const plain = estimateStageUsdzPackageBytes(scene, { post: { finalNames: [] } });
    material.map = new Texture();
    expect(estimateStageUsdzPackageBytes(scene, { post: { finalNames: [] } }) - plain)
      .toBeGreaterThanOrEqual(1024 * 1024 * 8 + 65536);
  });

  it('counts a shared texture once per source/flip pair, including across material slots', () => {
    const scene = new Scene();
    const texture = new Texture();
    const material = new MeshStandardMaterial({ map: texture });
    const other = new MeshStandardMaterial();
    scene.add(new Mesh(new BoxGeometry(), material), new Mesh(new BoxGeometry(), other));
    const once = estimateStageUsdzPackageBytes(scene, { post: { finalNames: [] } });
    other.map = texture;
    material.normalMap = texture;
    expect(estimateStageUsdzPackageBytes(scene, { post: { finalNames: [] } })).toBe(once);
    const flipped = texture.clone(); flipped.flipY = !texture.flipY; other.map = flipped;
    expect(estimateStageUsdzPackageBytes(scene, { post: { finalNames: [] } }) - once)
      .toBeGreaterThanOrEqual(1024 * 1024 * 8 + 65536);
  });

  it('refuses before parseAsync and restores the limit for a later export', async () => {
    const parse = vi.spyOn(USDZExporter.prototype, 'parseAsync');
    const restore = setUsdPackageLimitForTests(1);
    try {
      await expect(exportRuntimeStage(input())).rejects.toMatchObject({ code: 'usd-package-too-large', limitBytes: 1 });
      expect(parse).not.toHaveBeenCalled();
    } finally { restore(); }
    await expect(exportRuntimeStage(input())).resolves.toHaveProperty('usdz');
    expect(parse).toHaveBeenCalledOnce();
  });

  it('accepts exactly the preflight bound and refuses one byte below it before parseAsync', async () => {
    const model = input();
    const tree = buildRuntimeStageTree(model, { primNames: 'sibling' });
    const bound = estimateStageUsdzPackageBytes(tree.scene, { post: { finalNames: tree.finalNames!, prims: tree.prims } });
    const parse = vi.spyOn(USDZExporter.prototype, 'parseAsync');
    let restore = setUsdPackageLimitForTests(bound);
    try { await expect(exportRuntimeStage(model)).resolves.toHaveProperty('usdz'); } finally { restore(); }
    parse.mockClear();
    restore = setUsdPackageLimitForTests(bound - 1);
    try {
      await expect(exportRuntimeStage(model)).rejects.toMatchObject({
        code: 'usd-package-too-large', estimatedBytes: bound, limitBytes: bound - 1,
      });
      expect(parse).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  it('checks complete files before final zip, compression or Blob even if preflight passed', async () => {
    const model = input();
    const tree = buildRuntimeStageTree(model, { primNames: 'sibling' });
    const files = fflate.unzipSync(await new USDZExporter().parseAsync(tree.scene));
    // Simulate an encoder adding more bytes than the preflight reserved.
    files['textures/extra.png'] = new Uint8Array(100_001);
    const raw = fflate.zipSync(files, { level: 0 });
    vi.spyOn(USDZExporter.prototype, 'parseAsync').mockResolvedValue(raw);
    const zip = vi.mocked(fflate.zipSync);
    zip.mockClear(); // Exclude fixture construction; observe only the export below.
    const compress = vi.fn(compressForMount);
    const blob = vi.fn(); vi.stubGlobal('Blob', blob);
    const restore = setUsdPackageLimitForTests(100_000);
    try {
      await expect(exportRuntimeStage(model).then((snapshot) => compress(snapshot.usdz)))
        .rejects.toMatchObject({ code: 'usd-package-too-large', limitBytes: 100_000 });
      expect(zip).not.toHaveBeenCalled();
      expect(compress).not.toHaveBeenCalled();
      expect(blob).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  it('checks actual mount bytes before constructing a Blob or CompressionStream', async () => {
    const blob = vi.fn(), compression = vi.fn();
    vi.stubGlobal('Blob', blob); vi.stubGlobal('CompressionStream', compression);
    const restore = setUsdPackageLimitForTests(63);
    try {
      await expect(compressForMount(new Uint8Array(64))).rejects.toMatchObject({
        code: 'usd-package-too-large', estimatedBytes: 64, limitBytes: 63,
      });
      expect(blob).not.toHaveBeenCalled(); expect(compression).not.toHaveBeenCalled();
    } finally { restore(); }
  });
});
