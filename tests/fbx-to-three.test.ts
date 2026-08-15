// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * fbx-to-three.test.ts — FBX parsing + normalization.
 *
 *   - minimal ASCII FBX fixture (1 mesh) → Object3D with geometry
 *   - UnitScaleFactor is CENTIMETRES PER UNIT (FBX default 1 = cm) and is baked
 *     into the root matrix: FBX units × UnitScaleFactor/100 = meters
 *   - UpAxis Z → Z-up→Y-up rotation, baked on OUR root (not on the loader's)
 *   - version floors (binary >= 6400, ASCII >= 7000) → actionable errors
 *   - non-FBX input → actionable error
 *   - Phong/Lambert → MeshStandardMaterial (GLTFExporter maps nothing else)
 *   - empty scene → error (no silent empty import)
 */
import { describe, it, expect } from 'vitest';
import {
  Box3, Mesh, MeshLambertMaterial, MeshPhongMaterial, Texture,
  type Material, type Object3D,
} from 'three';
import {
  fbxBufferToObject3D,
  fbxUnitScaleToMeters,
  normalizeFbxRoot,
  isFbxBinaryBuffer,
  readFbxVersion,
  assertSupportedFbx,
  convertFbxMaterials,
  toStandardMaterial,
  phongShininessToRoughness,
  fbxBaseName,
  FBX_DEFAULT_UNIT_SCALE_FACTOR,
} from '@rv-private/plugins/import-providers/fbx-to-three';

// ─── Fixtures ────────────────────────────────────────────────────────────

/**
 * Minimal ASCII FBX 7300 stage: one triangle with 100-unit legs in the XY
 * plane, plus the GlobalSettings the normalization reads.
 */
function fbxFixture(opts?: { unitScaleFactor?: number; upAxis?: number; vertices?: string }): string {
  const unit = opts?.unitScaleFactor ?? 1;
  const upAxis = opts?.upAxis ?? 1; // 1 = Y-up (FBX default), 2 = Z-up
  const vertices = opts?.vertices ?? '0,0,0,100,0,0,0,100,0';
  return [
    '; FBX 7.3.0 project file',
    'FBXHeaderExtension:  {',
    '\tFBXHeaderVersion: 1003',
    '\tFBXVersion: 7300',
    '}',
    'GlobalSettings:  {',
    '\tVersion: 1000',
    '\tProperties70:  {',
    `\t\tP: "UpAxis", "int", "Integer", "",${upAxis}`,
    '\t\tP: "UpAxisSign", "int", "Integer", "",1',
    `\t\tP: "UnitScaleFactor", "double", "Number", "",${unit}`,
    '\t}',
    '}',
    'Objects:  {',
    '\tGeometry: 140, "Geometry::", "Mesh" {',
    '\t\tVertices: *9 {',
    `\t\t\ta: ${vertices}`,
    '\t\t}',
    '\t\tPolygonVertexIndex: *3 {',
    '\t\t\ta: 0,1,-3',
    '\t\t}',
    '\t\tGeometryVersion: 124',
    '\t}',
    '\tModel: 240, "Model::Tri", "Mesh" {',
    '\t\tVersion: 232',
    '\t}',
    '}',
    'Connections:  {',
    '\tC: "OO",140,240',
    '\tC: "OO",240,0',
    '}',
    '',
  ].join('\n');
}

/**
 * ASCII FBX that parses fine but holds no geometry — a single Null node, which
 * is what an export containing only locators, cameras or a skeleton looks like.
 */
function emptyFbxFixture(): string {
  return [
    '; FBX 7.3.0 project file',
    'FBXHeaderExtension:  {',
    '\tFBXHeaderVersion: 1003',
    '\tFBXVersion: 7300',
    '}',
    'Objects:  {',
    '\tModel: 240, "Model::Locator", "Null" {',
    '\t\tVersion: 232',
    '\t}',
    '}',
    'Connections:  {',
    '\tC: "OO",240,0',
    '}',
    '',
  ].join('\n');
}

/** Structurally broken FBX: a valid header over a truncated body. */
function brokenFbxFixture(): string {
  return '; FBX 7.3.0 project file\nFBXHeaderExtension:  {\n\tFBXVersion: 7300\n}\n';
}

function textBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

/** Binary FBX header: magic + 2 pad bytes + little-endian uint32 version. */
function binaryFbxHeader(version: number): Uint8Array {
  const magic = 'Kaydara FBX Binary  \0';
  const bytes = new Uint8Array(magic.length + 2 + 4);
  for (let i = 0; i < magic.length; i++) bytes[i] = magic.charCodeAt(i);
  new DataView(bytes.buffer).setUint32(23, version, true);
  return bytes;
}

function countMeshVertices(root: Object3D): number {
  let n = 0;
  root.traverse((o) => {
    if ((o as Mesh).isMesh) n += (o as Mesh).geometry?.getAttribute('position')?.count ?? 0;
  });
  return n;
}

// ─── Units ───────────────────────────────────────────────────────────────

describe('fbxUnitScaleToMeters', () => {
  it('treats UnitScaleFactor as centimetres per unit', () => {
    expect(fbxUnitScaleToMeters(1)).toBeCloseTo(0.01);   // cm — the FBX default
    expect(fbxUnitScaleToMeters(100)).toBeCloseTo(1);    // metres
    expect(fbxUnitScaleToMeters(0.1)).toBeCloseTo(0.001); // millimetres
    expect(fbxUnitScaleToMeters(2.54)).toBeCloseTo(0.0254); // inches
  });

  it('falls back to the cm default for absent or invalid values', () => {
    const cm = FBX_DEFAULT_UNIT_SCALE_FACTOR / 100;
    expect(fbxUnitScaleToMeters(undefined)).toBeCloseTo(cm);
    expect(fbxUnitScaleToMeters(0)).toBeCloseTo(cm);
    expect(fbxUnitScaleToMeters(-5)).toBeCloseTo(cm);
    expect(fbxUnitScaleToMeters('nonsense')).toBeCloseTo(cm);
  });
});

// ─── normalizeFbxRoot ────────────────────────────────────────────────────

describe('normalizeFbxRoot', () => {
  it('bakes metersPerUnit into the root scale (Y-up: no rotation)', () => {
    const content = new Mesh();
    const root = normalizeFbxRoot(content, { metersPerUnit: 0.01, zUp: false });
    expect(root.scale.x).toBeCloseTo(0.01);
    expect(root.rotation.x).toBeCloseTo(0);
    expect(root.children).toContain(content);
  });

  it('rotates Z-up scenes to Y-up (STEP/USD pattern)', () => {
    const root = normalizeFbxRoot(new Mesh(), { metersPerUnit: 1, zUp: true });
    expect(root.rotation.x).toBeCloseTo(-Math.PI / 2);
  });
});

// ─── Format + version detection ──────────────────────────────────────────

describe('format detection', () => {
  it('isFbxBinaryBuffer matches only the Kaydara magic', () => {
    expect(isFbxBinaryBuffer(binaryFbxHeader(7400))).toBe(true);
    expect(isFbxBinaryBuffer(new TextEncoder().encode('; FBX 7.3.0'))).toBe(false);
    expect(isFbxBinaryBuffer(new Uint8Array([0x4b, 0x61]))).toBe(false);
  });

  it('readFbxVersion reads the binary header field and the ASCII comment', () => {
    expect(readFbxVersion(binaryFbxHeader(7400))).toBe(7400);
    expect(readFbxVersion(new TextEncoder().encode(fbxFixture()))).toBe(7300);
    expect(readFbxVersion(new TextEncoder().encode('just some text'))).toBeNull();
  });

  it('assertSupportedFbx rejects old versions with the minimum in the message', () => {
    expect(() => assertSupportedFbx(binaryFbxHeader(6000), 'old.fbx')).toThrow(/6400/);
    expect(() => assertSupportedFbx(new TextEncoder().encode('FBXVersion: 6100'), 'old.fbx'))
      .toThrow(/7000/);
  });

  it('assertSupportedFbx rejects non-FBX input with an actionable message', () => {
    expect(() => assertSupportedFbx(new TextEncoder().encode('hello world'), 'notes.txt'))
      .toThrow(/not a readable FBX/i);
  });

  it('assertSupportedFbx accepts current versions', () => {
    expect(() => assertSupportedFbx(binaryFbxHeader(7700), 'new.fbx')).not.toThrow();
    expect(() => assertSupportedFbx(new TextEncoder().encode(fbxFixture()), 'new.fbx')).not.toThrow();
  });
});

// ─── Materials ───────────────────────────────────────────────────────────

describe('material conversion', () => {
  it('maps the Phong exponent to a clamped GGX roughness', () => {
    expect(phongShininessToRoughness(0)).toBeCloseTo(1);
    expect(phongShininessToRoughness(30)).toBeCloseTo(0.25);
    expect(phongShininessToRoughness(1e6)).toBe(0.05); // clamped, never a perfect mirror
    expect(phongShininessToRoughness(undefined)).toBeCloseTo(1);
  });

  it('carries colour, textures and transparency onto MeshStandardMaterial', () => {
    const map = new Texture();
    const phong = new MeshPhongMaterial({ color: 0x336699, map, transparent: true, opacity: 0.5 });
    phong.name = 'Housing';
    const std = toStandardMaterial(phong);
    expect(std.isMeshStandardMaterial).toBe(true);
    expect(std.name).toBe('Housing');
    expect(std.color.getHex()).toBe(0x336699);
    expect(std.map).toBe(map);
    expect(std.transparent).toBe(true);
    expect(std.opacity).toBeCloseTo(0.5);
    expect(std.metalness).toBe(0); // FBX carries no metalness — dielectric by default
  });

  it('converts every mesh in the tree and keeps sharing intact', () => {
    const shared = new MeshLambertMaterial({ color: 0xff0000 });
    const a = new Mesh(undefined, shared);
    const b = new Mesh(undefined, shared);
    const root = new Mesh();
    root.add(a, b);
    convertFbxMaterials(root);
    expect((a.material as Material).type).toBe('MeshStandardMaterial');
    expect(a.material).toBe(b.material); // one conversion, still one material
  });

  it('leaves multi-material meshes as an array', () => {
    const mesh = new Mesh(undefined, [new MeshPhongMaterial(), new MeshLambertMaterial()]);
    const root = new Mesh();
    root.add(mesh);
    convertFbxMaterials(root);
    expect(Array.isArray(mesh.material)).toBe(true);
    for (const m of mesh.material as Material[]) {
      expect(m.type).toBe('MeshStandardMaterial');
    }
  });
});

// ─── fbxBufferToObject3D ─────────────────────────────────────────────────

describe('fbxBufferToObject3D', () => {
  it('parses a minimal ASCII FBX into a tree with mesh geometry', async () => {
    const root = await fbxBufferToObject3D(textBuffer(fbxFixture()), 'tri.fbx');
    expect(countMeshVertices(root)).toBeGreaterThan(0);
  });

  it('applies the FBX DEFAULT UnitScaleFactor = 1: 100 cm-units → 1 m', async () => {
    const root = await fbxBufferToObject3D(textBuffer(fbxFixture()), 'tri.fbx');
    const box = new Box3().setFromObject(root);
    expect(box.max.x).toBeCloseTo(1, 5);
    expect(box.max.y).toBeCloseTo(1, 5);
  });

  it('applies an explicit UnitScaleFactor = 100 (metres): 100 units → 100 m', async () => {
    const root = await fbxBufferToObject3D(textBuffer(fbxFixture({ unitScaleFactor: 100 })), 'tri.fbx');
    const box = new Box3().setFromObject(root);
    expect(box.max.x).toBeCloseTo(100, 4);
  });

  it('converts Z-up scenes to Y-up: a +Z point ends up on +Y', async () => {
    const text = fbxFixture({ upAxis: 2, vertices: '0,0,0,100,0,0,0,0,100' });
    const root = await fbxBufferToObject3D(textBuffer(text), 'tri.fbx');
    expect(root.rotation.x).toBeCloseTo(-Math.PI / 2); // on OUR root, not the content
    expect(root.children[0].rotation.x).toBeCloseTo(0);
    const box = new Box3().setFromObject(root);
    expect(box.max.y).toBeCloseTo(1, 5); // was Z=100 (up), now Y=1 m (up)
    expect(box.max.z).toBeCloseTo(0, 5);
  });

  it('hands back PBR materials, never Phong (GLTFExporter maps nothing else)', async () => {
    const root = await fbxBufferToObject3D(textBuffer(fbxFixture()), 'tri.fbx');
    let checked = 0;
    root.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        expect(m.type).toBe('MeshStandardMaterial');
        checked++;
      }
    });
    expect(checked).toBeGreaterThan(0);
  });

  it('throws a visible error for a scene without meshes (empty guard)', async () => {
    await expect(fbxBufferToObject3D(textBuffer(emptyFbxFixture()), 'empty.fbx'))
      .rejects.toThrow(/no renderable mesh/i);
  });

  it('rejects a non-FBX buffer before reaching the loader', async () => {
    await expect(fbxBufferToObject3D(textBuffer('not an fbx at all'), 'notes.txt'))
      .rejects.toThrow(/not a readable FBX/i);
  });

  it('wraps a parser crash in a message naming the file', async () => {
    // A structurally broken FBX makes three throw from deep inside its parser.
    // That must surface as a per-file failure in the dialog, not as an unhandled
    // rejection with a bare "Cannot read properties of undefined".
    await expect(fbxBufferToObject3D(textBuffer(brokenFbxFixture()), 'broken.fbx'))
      .rejects.toThrow(/"broken\.fbx" could not be parsed/i);
  });
});

// ─── Naming ──────────────────────────────────────────────────────────────

describe('fbxBaseName', () => {
  it('strips the FBX extension and falls back to "fbx"', () => {
    expect(fbxBaseName('Robot.fbx')).toBe('Robot');
    expect(fbxBaseName('cell.FBX')).toBe('cell');
    expect(fbxBaseName('.fbx')).toBe('fbx');
  });
});
