// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * generate-conformance-glbs.mjs — writes the rv-ODT conformance GLBs
 * (schema/v1/conformance/*.glb) as minimal, JSON-chunk-only glTF 2.0 binaries.
 *
 * The files carry no geometry — only named nodes with `extras.realvirtual`
 * payloads. That is a valid glTF 2.0 container and exactly what the
 * conformance suite tests: component-data parsing, defaults, aliases,
 * enum mapping and coordinate conversion.
 *
 * Re-run after changing a scenario:  node scripts/generate-conformance-glbs.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema', 'v1', 'conformance');
mkdirSync(outDir, { recursive: true });

/** Pack a glTF JSON document into a GLB (JSON chunk only, 4-byte space padding). */
function toGlb(gltf) {
  const json = Buffer.from(JSON.stringify(gltf), 'utf8');
  const pad = (4 - (json.length % 4)) % 4;
  const jsonChunk = Buffer.concat([json, Buffer.alloc(pad, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // 'glTF'
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length, 8);
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(jsonChunk.length, 0);
  chunkHeader.writeUInt32LE(0x4e4f534a, 4); // 'JSON'
  return Buffer.concat([header, chunkHeader, jsonChunk]);
}

/** Build a single-scene glTF document from a flat list of named nodes. */
function scene(nodes) {
  return {
    asset: { version: '2.0', generator: 'rv-ODT conformance generator' },
    scene: 0,
    scenes: [{ name: 'Scene', nodes: nodes.map((_, i) => i) }],
    nodes,
  };
}

const ref = (path, componentType) => ({ type: 'ComponentReference', path, componentType });

const files = {
  '01-empty-scene.glb': scene([
    { name: 'Empty' },
  ]),

  '02-single-drive.glb': scene([
    {
      name: 'Axis',
      extras: {
        realvirtual: {
          _formatVersion: '1.0',
          Drive: {
            Direction: 'RotationZ',
            ReverseDirection: true,
            Offset: 10,
            StartPosition: 5,
            TargetSpeed: 250,
            Acceleration: 500,
            UseAcceleration: true,
            UseLimits: true,
            LowerLimit: -90,
            UpperLimit: 90,
          },
        },
      },
    },
  ]),

  '03-drive-with-signal.glb': scene([
    {
      name: 'Conveyor',
      extras: {
        realvirtual: {
          _formatVersion: '1.0',
          Drive: { Direction: 'LinearX' },
          Drive_Simple: {
            Forward: ref('PLC/ConveyorStart', 'PLCOutputBool'),
            ScaleSpeed: 2,
          },
        },
      },
    },
  ]),

  '04-transport-with-unitycoords.glb': scene([
    {
      name: 'Belt',
      extras: {
        realvirtual: {
          _formatVersion: '1.0',
          TransportSurface: {
            TransportDirection: { x: 1, y: 0, z: 0 },
            TextureScale: 2.5,
            DriveReference: ref('Cell/BeltDrive', 'Drive'),
          },
        },
      },
    },
  ]),

  '05-grip-with-enum.glb': scene([
    {
      name: 'Gripper',
      extras: {
        realvirtual: {
          _formatVersion: '1.0',
          Grip: { PlaceMode: 'Physics', GripRange: 80 },
        },
      },
    },
    {
      name: 'FaultLamp',
      extras: {
        realvirtual: {
          _formatVersion: '1.0',
          // Legacy integer-index enum wire value — reader must map '1' → 'FlashObject'.
          WebError: { ErrorText: 'Overtemp', HighlightStyle: '1' },
        },
      },
    },
  ]),

  '06-source-with-aliases.glb': scene([
    {
      name: 'PartSource',
      extras: {
        realvirtual: {
          _formatVersion: '1.0',
          // Legacy field names — reader must migrate SpawnInterval → Interval,
          // SpawnDistance → GenerateIfDistance.
          Source: { SpawnInterval: 5, SpawnDistance: 450, AutomaticGeneration: true },
        },
      },
    },
  ]),
};

for (const [name, gltf] of Object.entries(files)) {
  const glb = toGlb(gltf);
  writeFileSync(join(outDir, name), glb);
  console.log(`${name}  (${glb.length} bytes)`);
}
