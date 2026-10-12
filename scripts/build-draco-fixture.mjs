// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Generate the versioned test fixture for `tests/glb-draco-roundtrip.node.test.ts`
 * (plan-749 phase 2, finding R2-2).
 *
 * ## Why a generated fixture and not the real asset
 *
 * `scripts/compress-glb.mjs` replaces `DemoRealvirtualWeb.glb` IN PLACE. After
 * that step a fresh checkout only holds the Draco fassung, so a test that
 * compares "before" against "after" would have no before to compare to —
 * re-compressing the compressed asset proves neither metadata preservation nor
 * the original size reduction. The fixture is the reproducible source of truth
 * instead: 41 KB in the repo rather than 34 MB, and it runs on every machine.
 *
 * ## What makes it representative
 *
 * It reproduces every structural property of the demo asset that the roundtrip
 * could plausibly break, verified against the real file:
 *
 *   - `extras` on **every** node (the demo has them on all 325), shaped like the
 *     real `{ realvirtual: { <Component>: { … } } }` payloads that carry
 *     classification and signal binding
 *   - **duplicate node names at different hierarchy paths** — the reason T9
 *     compares by path and not as a name set
 *   - indexed TRIANGLES primitives with POSITION, NORMAL, TEXCOORD_0, TANGENT
 *     and COLOR_0, the exact semantic set the demo uses
 *   - the demo's three material extensions, `KHR_materials_unlit` in
 *     `extensionsRequired`, plus an embedded PNG behind a
 *     `KHR_texture_transform`
 *   - several nodes that carry extras and children but no mesh
 *
 * Deterministic: a fixed LCG, no clock, no randomness. Re-running must produce
 * identical bytes.
 *
 * Usage: `node scripts/build-draco-fixture.mjs [--out <file.glb>]`
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Document, NodeIO } from '@gltf-transform/core';
import {
  ALL_EXTENSIONS,
  KHRMaterialsEmissiveStrength,
  KHRMaterialsUnlit,
  KHRTextureTransform,
} from '@gltf-transform/extensions';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_PATH = resolve(HERE, '../tests/fixtures/draco-roundtrip-source.glb');

/** Deterministic LCG (numerical recipes) — no Math.random anywhere. */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** A minimal, valid 4x4 RGBA PNG built from scratch — no binary blob checked in. */
function makePng(size = 4) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y += 1) {
    const row = y * (1 + size * 4);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const px = row + 1 + x * 4;
      const checker = (x + y) % 2 === 0;
      raw[px] = checker ? 0xd0 : 0x30;
      raw[px + 1] = checker ? 0x60 : 0x90;
      raw[px + 2] = checker ? 0x20 : 0xc0;
      raw[px + 3] = 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * An indexed, subdivided box. Each face is split (24 * segments^2 vertices), so
 * normals are hard at the edges — the case the plan flags as the one Draco
 * quantization is most likely to disturb.
 */
function buildBox(segments, scale, random) {
  const faces = [
    { normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { normal: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
    { normal: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { normal: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { normal: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  ];
  const position = [];
  const normal = [];
  const texcoord = [];
  const tangent = [];
  const color = [];
  const indices = [];

  for (const face of faces) {
    const base = position.length / 3;
    for (let iy = 0; iy <= segments; iy += 1) {
      for (let ix = 0; ix <= segments; ix += 1) {
        const su = (ix / segments) * 2 - 1;
        const sv = (iy / segments) * 2 - 1;
        for (let axis = 0; axis < 3; axis += 1) {
          position.push((face.u[axis] * su + face.v[axis] * sv + face.normal[axis]) * scale);
        }
        normal.push(...face.normal);
        texcoord.push(ix / segments, iy / segments);
        tangent.push(face.u[0], face.u[1], face.u[2], 1);
        color.push(0.2 + random() * 0.8, 0.2 + random() * 0.8, 0.2 + random() * 0.8, 1);
      }
    }
    for (let iy = 0; iy < segments; iy += 1) {
      for (let ix = 0; ix < segments; ix += 1) {
        const a = base + iy * (segments + 1) + ix;
        const b = a + 1;
        const c = a + (segments + 1);
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
  }

  return {
    position: new Float32Array(position),
    normal: new Float32Array(normal),
    texcoord: new Float32Array(texcoord),
    tangent: new Float32Array(tangent),
    color: new Float32Array(color),
    indices: new Uint32Array(indices),
  };
}

/** realvirtual-shaped extras, so T10 compares against the real payload shape. */
function makeExtras(componentName, index) {
  return {
    realvirtual: {
      [componentName]: {
        _fullTypeName: `realvirtual.${componentName}`,
        _version: 2,
        _enabled: index % 3 !== 0,
        Name: `${componentName}_${index}`,
        Value: Number((index * 1.5).toFixed(3)),
        Signals: [`Signal_${index}_A`, `Signal_${index}_B`],
        Nested: { Depth: index % 4, Flags: [true, false, index % 2 === 0] },
      },
    },
    rv_path_hint: `fixture/node-${index}`,
  };
}

export async function buildFixture() {
  const random = makeRandom(0x5eed_749);
  const document = new Document();
  const buffer = document.createBuffer();
  const root = document.getRoot();
  root.getAsset().generator = 'realvirtual draco-fixture builder (plan-749)';

  const unlit = document.createExtension(KHRMaterialsUnlit).setRequired(true);
  const emissiveStrength = document.createExtension(KHRMaterialsEmissiveStrength);
  const textureTransform = document.createExtension(KHRTextureTransform);

  const texture = document.createTexture('Checker')
    .setMimeType('image/png')
    .setImage(makePng());

  const materials = [];

  const standard = document.createMaterial('StandardWithTransform')
    .setBaseColorFactor([0.8, 0.8, 0.85, 1])
    .setMetallicFactor(0.1)
    .setRoughnessFactor(0.7)
    .setBaseColorTexture(texture);
  standard.getBaseColorTextureInfo().setExtension(
    'KHR_texture_transform',
    textureTransform.createTransform().setScale([2, 2]).setOffset([0.25, 0.125]).setRotation(0.5),
  );
  materials.push(standard);

  const emissive = document.createMaterial('EmissiveStrong')
    .setBaseColorFactor([0.2, 0.3, 0.9, 1])
    .setEmissiveFactor([0.9, 0.4, 0.1]);
  emissive.setExtension(
    'KHR_materials_emissive_strength',
    emissiveStrength.createEmissiveStrength().setEmissiveStrength(4.5),
  );
  materials.push(emissive);

  const flat = document.createMaterial('UnlitFlat').setBaseColorFactor([0.95, 0.2, 0.2, 1]);
  flat.setExtension('KHR_materials_unlit', unlit.createUnlit());
  materials.push(flat);

  // 12 meshes, 2 primitives each where the index is even — 18 primitives total.
  const meshes = [];
  for (let i = 0; i < 12; i += 1) {
    const mesh = document.createMesh(`Mesh_${i}`);
    const primitiveCount = i % 2 === 0 ? 2 : 1;
    for (let p = 0; p < primitiveCount; p += 1) {
      const geometry = buildBox(2 + ((i + p) % 3), 0.5 + ((i + p) % 4) * 0.25, random);
      const primitive = document.createPrimitive()
        .setMaterial(materials[(i + p) % materials.length])
        .setIndices(document.createAccessor().setType('SCALAR').setArray(geometry.indices).setBuffer(buffer))
        .setAttribute('POSITION', document.createAccessor().setType('VEC3').setArray(geometry.position).setBuffer(buffer))
        .setAttribute('NORMAL', document.createAccessor().setType('VEC3').setArray(geometry.normal).setBuffer(buffer))
        .setAttribute('TEXCOORD_0', document.createAccessor().setType('VEC2').setArray(geometry.texcoord).setBuffer(buffer))
        .setAttribute('TANGENT', document.createAccessor().setType('VEC4').setArray(geometry.tangent).setBuffer(buffer))
        .setAttribute('COLOR_0', document.createAccessor().setType('VEC4').setArray(geometry.color).setBuffer(buffer));
      mesh.addPrimitive(primitive);
    }
    meshes.push(mesh);
  }

  // Hierarchy: three stations, each with the SAME child names. That collision is
  // deliberate — a name-set comparison cannot tell these apart, a path can.
  const scene = document.createScene('FixtureScene');
  let nodeIndex = 0;
  let meshCursor = 0;

  for (let station = 0; station < 3; station += 1) {
    const stationNode = document.createNode(`Station`)
      .setTranslation([station * 4, 0, 0])
      .setExtras(makeExtras('Group', nodeIndex++));
    scene.addChild(stationNode);

    for (const childName of ['Drive', 'Sensor', 'Frame']) {
      const child = document.createNode(childName)
        .setTranslation([0, 1 + station * 0.5, 0])
        .setRotation([0, Math.sin(station * 0.3), 0, Math.cos(station * 0.3)])
        .setScale([1, 1 + station * 0.1, 1])
        .setExtras(makeExtras(childName, nodeIndex++));
      stationNode.addChild(child);

      // Every child gets a mesh, and each also carries a mesh-less leaf.
      child.setMesh(meshes[meshCursor++ % meshes.length]);
      const marker = document.createNode('Marker')
        .setTranslation([0.1 * station, 0.2, 0.3])
        .setExtras(makeExtras('WebSensor', nodeIndex++));
      child.addChild(marker);
    }
  }

  // A second root with the same child names again, at a different depth.
  const spare = document.createNode('Station')
    .setTranslation([0, -3, 0])
    .setExtras(makeExtras('Group', nodeIndex++));
  scene.addChild(spare);
  for (const childName of ['Drive', 'Sensor']) {
    const child = document.createNode(childName)
      .setExtras(makeExtras(childName, nodeIndex++))
      .setMesh(meshes[meshCursor++ % meshes.length]);
    spare.addChild(child);
  }

  const io = await new NodeIO().registerExtensions(ALL_EXTENSIONS);
  return Buffer.from(await io.writeBinary(document));
}

async function runCli() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const out = outIndex >= 0 ? resolve(args[outIndex + 1]) : FIXTURE_PATH;
  const bytes = await buildFixture();
  writeFileSync(out, bytes);
  console.log(`${out}: ${bytes.length} B`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli().catch((error) => {
    console.error(`[build-draco-fixture] ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
