// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { existsSync, writeFileSync } from 'node:fs';

const target = new URL('./triangle.glb', import.meta.url);
if (existsSync(target)) {
  console.log('triangle.glb already exists; preserving it.');
} else {
  // A complete glTF 2.0 triangle: no third-party model or private assets.
  const binary = Buffer.alloc(36);
  [-1, 0, 0, 1, 0, 0, 0, 2, 0].forEach((value, index) => binary.writeFloatLE(value, index * 4));
  const gltf = {
    asset: { version: '2.0', generator: 'realvirtual Community documentation example' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'CommunityTriangle', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [0.1, 0.65, 0.9, 1], metallicFactor: 0 } }],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binary.length, target: 34962 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, 0, 0], max: [1, 2, 0] }],
  };
  const json = Buffer.from(JSON.stringify(gltf));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(padded);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + padded.length + binary.length, 8);
  header.writeUInt32LE(padded.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binary.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  writeFileSync(target, Buffer.concat([header, padded, binHeader, binary]), { flag: 'wx' });
  console.log('Created triangle.glb. Compile plugins/counter.ts next.');
}
