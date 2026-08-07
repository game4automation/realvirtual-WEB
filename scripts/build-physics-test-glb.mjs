// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * build-physics-test-glb.mjs — writes the plan-276 physics-zone E2E fixture
 * `public/models/physics-zone-test.glb` as a hand-built glTF 2.0 binary
 * (JSON chunk + BIN chunk with one shared unit-cube mesh).
 *
 * Follows the established programmatic fixture pattern of
 * scripts/generate-conformance-glbs.mjs (GLTFExporter needs FileReader/Blob
 * plumbing in Node — the direct GLB writer is deterministic and dependency-free),
 * extended with a real BIN chunk because this fixture needs visible geometry.
 *
 * Scene (glTF space, meters, Y up; transport runs along +Z so no Unity-X
 * negation is involved anywhere):
 *  - Conveyor:     2.0 m x 0.1 m x 0.4 m box, top surface at y = 0.5,
 *                  z in [-2, 0]. Drive + TransportSurface (+Z) + BoxCollider.
 *  - PartSource:   0.15 m cube on the belt start — Source (the node itself is
 *                  the MU prototype) so the Phase-3 E2E has moving MUs.
 *  - PhysicsZone:  meshless node with WebPhysicsZone + BoxCollider extras;
 *                  volume covers the conveyor end and the fall/bin area.
 *  - Container:    4 static walls (boxes with BoxCollider extras) below and
 *                  behind the belt end; referenced by the zone's StaticColliders.
 *
 * Re-run after changing the scene:  node scripts/build-physics-test-glb.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The test fixtures live with every other bundled demo asset in public/models/.
const outDir = join(dirname(fileURLToPath(import.meta.url)),
  '..', 'public', 'models');
mkdirSync(outDir, { recursive: true });

// ─── Unit-cube geometry (centered at origin, size 1) ────────────────────────

const POSITIONS = new Float32Array([
  -0.5, -0.5, -0.5,   0.5, -0.5, -0.5,   0.5, 0.5, -0.5,   -0.5, 0.5, -0.5,
  -0.5, -0.5,  0.5,   0.5, -0.5,  0.5,   0.5, 0.5,  0.5,   -0.5, 0.5,  0.5,
]);

const INDICES = new Uint16Array([
  0, 3, 2,  0, 2, 1,   // back  (z = -0.5)
  4, 5, 6,  4, 6, 7,   // front (z = +0.5)
  0, 4, 7,  0, 7, 3,   // left  (x = -0.5)
  1, 2, 6,  1, 6, 5,   // right (x = +0.5)
  0, 1, 5,  0, 5, 4,   // bottom (y = -0.5)
  3, 7, 6,  3, 6, 2,   // top   (y = +0.5)
]);

const posBytes = Buffer.from(POSITIONS.buffer);
const idxBytes = Buffer.from(INDICES.buffer);
const bin = Buffer.concat([posBytes, idxBytes]); // 96 + 72 bytes, 4-byte aligned

// ─── glTF document ──────────────────────────────────────────────────────────

/** Unity-style BoxCollider extras (center/size in meters, x=0 → no LHS flip). */
const box = (sx, sy, sz) => ({ center: { x: 0, y: 0, z: 0 }, size: { x: sx, y: sy, z: sz } });

/** Node factory: unit-cube mesh scaled to full size, plus rv extras. */
const cube = (name, mesh, translation, scale, realvirtual) => ({
  name,
  mesh,
  translation,
  scale,
  ...(realvirtual ? { extras: { realvirtual: { _formatVersion: '1.0', ...realvirtual } } } : {}),
});

const MESH_BELT = 0;
const MESH_WALL = 1;
const MESH_PART = 2;

const nodes = [
  // 0 — Conveyor: z in [-2, 0], top surface y = 0.5, transport toward +Z.
  cube('Conveyor', MESH_BELT, [0, 0.45, -1], [0.4, 0.1, 2.0], {
    Drive: { Direction: 'LinearZ', TargetSpeed: 500 },
    TransportSurface: { TransportDirection: { x: 0, y: 0, z: 1 }, Accumulate: true },
    BoxCollider: box(0.4, 0.1, 2.0),
  }),

  // 1 — PhysicsZone: meshless empty; volume covers belt end + fall area + bin
  //     (world x [-0.75, 0.75], y [0, 1.5], z [-0.5, 2.0]).
  {
    name: 'PhysicsZone',
    translation: [0, 0.75, 0.75],
    extras: {
      realvirtual: {
        _formatVersion: '1.0',
        WebPhysicsZone: {
          ZoneEnabled: true,
          WholeScene: false,
          Friction: 0.8,
          Restitution: 0,
          RemoveBelowY: -10,
          ShowGizmo: true,
          StaticColliders: [
            'Container/WallLeft',
            'Container/WallRight',
            'Container/WallFront',
            'Container/WallBack',
          ],
        },
        BoxCollider: box(1.5, 1.5, 2.5),
      },
    },
  },

  // 2 — Container: bin (4 walls, no floor — ground plane catches) right behind
  //     the belt end, interior about x [-0.33, 0.33], z [0.08, 0.83].
  { name: 'Container', translation: [0, 0, 0.45], children: [3, 4, 5, 6] },
  cube('WallLeft', MESH_WALL, [-0.35, 0.15, 0], [0.05, 0.3, 0.8], { BoxCollider: box(0.05, 0.3, 0.8) }),
  cube('WallRight', MESH_WALL, [0.35, 0.15, 0], [0.05, 0.3, 0.8], { BoxCollider: box(0.05, 0.3, 0.8) }),
  cube('WallFront', MESH_WALL, [0, 0.15, 0.4], [0.7, 0.3, 0.05], { BoxCollider: box(0.7, 0.3, 0.05) }),
  cube('WallBack', MESH_WALL, [0, 0.15, -0.4], [0.7, 0.3, 0.05], { BoxCollider: box(0.7, 0.3, 0.05) }),

  // 7 — PartSource: MU prototype ON the belt start (top of belt = 0.5).
  cube('PartSource', MESH_PART, [0, 0.575, -1.8], [0.15, 0.15, 0.15], {
    Source: { AutomaticGeneration: true, Interval: 2, PlaceOnTransportSurface: true },
  }),
];

const gltf = {
  asset: { version: '2.0', generator: 'rv physics-zone fixture generator (plan-276)' },
  scene: 0,
  scenes: [{ name: 'PhysicsZoneTest', nodes: [0, 1, 2, 7] }],
  nodes,
  meshes: [
    { name: 'BeltCube', primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] },
    { name: 'WallCube', primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 1 }] },
    { name: 'PartCube', primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 2 }] },
  ],
  materials: [
    { name: 'Belt', pbrMetallicRoughness: { baseColorFactor: [0.30, 0.30, 0.35, 1], metallicFactor: 0.2, roughnessFactor: 0.8 } },
    { name: 'Wall', pbrMetallicRoughness: { baseColorFactor: [0.55, 0.55, 0.60, 1], metallicFactor: 0.1, roughnessFactor: 0.9 } },
    { name: 'Part', pbrMetallicRoughness: { baseColorFactor: [0.80, 0.27, 0.27, 1], metallicFactor: 0.1, roughnessFactor: 0.7 } },
  ],
  accessors: [
    { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
    { bufferView: 1, componentType: 5123, count: INDICES.length, type: 'SCALAR' },
  ],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: posBytes.length, target: 34962 },
    { buffer: 0, byteOffset: posBytes.length, byteLength: idxBytes.length, target: 34963 },
  ],
  buffers: [{ byteLength: bin.length }],
};

// ─── GLB packing (JSON chunk space-padded, BIN chunk zero-padded) ───────────

const json = Buffer.from(JSON.stringify(gltf), 'utf8');
const jsonPad = (4 - (json.length % 4)) % 4;
const jsonChunk = Buffer.concat([json, Buffer.alloc(jsonPad, 0x20)]);
const binPad = (4 - (bin.length % 4)) % 4;
const binChunk = Buffer.concat([bin, Buffer.alloc(binPad, 0x00)]);

const totalLength = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); // 'glTF'
header.writeUInt32LE(2, 4);
header.writeUInt32LE(totalLength, 8);

const jsonChunkHeader = Buffer.alloc(8);
jsonChunkHeader.writeUInt32LE(jsonChunk.length, 0);
jsonChunkHeader.writeUInt32LE(0x4e4f534a, 4); // 'JSON'

const binChunkHeader = Buffer.alloc(8);
binChunkHeader.writeUInt32LE(binChunk.length, 0);
binChunkHeader.writeUInt32LE(0x004e4942, 4); // 'BIN\0'

const glb = Buffer.concat([header, jsonChunkHeader, jsonChunk, binChunkHeader, binChunk]);
const outPath = join(outDir, 'physics-zone-test.glb');
writeFileSync(outPath, glb);
console.log(`physics-zone-test.glb  (${glb.length} bytes) → ${outPath}`);
