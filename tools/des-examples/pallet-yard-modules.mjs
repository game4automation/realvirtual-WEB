// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Pure geometry for the bundled PalletYard library; no runtime components or paths. */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COURSE, PALLET_WIDTH_M, PALLET_LENGTH_M, VEHICLE_LENGTH_MM } from '../../src/plugins/models/PalletYard/layout.ts';
import { composeGeometry, MODULE_PITCH_M } from '../../src/plugins/models/PalletYard/yard-compose.ts';
import { boxMesh } from './lib/gltf-box.mjs';
import { round } from '../../src/plugins/models/PalletYard/path-dsl.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const WV_ROOT = path.resolve(here, '../..');
const LIB_DIR = path.join(WV_ROOT, 'public/demo-realvirtual/library/PalletHandling');
const requireWV = createRequire(path.join(WV_ROOT, 'package.json'));
const importWV = async (spec) => import(pathToFileURL(requireWV.resolve(spec)).href);
const FRAME_H = 0.004, FRAME_W = 0.05, LANE_HALF_M = 0.55;
const END_STRAIGHT_M = round((-3.4 - MODULE_PITCH_M / 2) - composeGeometry(1).xMin);
const NAMES = ['PalletYardModule', 'PalletYardEndWest', 'PalletYardEndEast',
  'PalletYardSlotMarking', 'PalletYardChargerStation', 'PalletYardWaitMarking'];

/** One primitive per edge arc, with the chord boxes baked into its vertices. */
function arcMesh(doc, buffer, name, radius, startDeg, material) {
  const delta = Math.PI / 18;
  const chord = 2 * radius * Math.sin(delta / 2);
  const box = boxMesh(doc, buffer, name + '_Chord', [chord, FRAME_H, FRAME_W], material);
  const primitive = box.listPrimitives()[0];
  const position = primitive.getAttribute('POSITION'), normal = primitive.getAttribute('NORMAL');
  const indices = primitive.getIndices();
  const pos = [], nor = [], idx = [];
  for (let i = 0; i < 18; i++) {
    const angle = startDeg * Math.PI / 180 + (i + 0.5) * delta;
    const cx = radius * Math.cos(delta / 2) * Math.cos(angle);
    const cz = radius * Math.cos(delta / 2) * Math.sin(angle);
    // Local +X follows the chord tangent (-sin(angle), cos(angle)).
    const c = -Math.sin(angle), s = -Math.cos(angle);
    for (let v = 0; v < position.getCount(); v++) {
      const [x, y, z] = position.getElement(v, []);
      const [nx, ny, nz] = normal.getElement(v, []);
      pos.push(c * x + s * z + cx, y + FRAME_H / 2, -s * x + c * z + cz);
      nor.push(c * nx + s * nz, ny, -s * nx + c * nz);
    }
    for (const index of indices.getArray()) idx.push(index + i * position.getCount());
  }
  box.dispose(); primitive.dispose(); position.dispose(); normal.dispose(); indices.dispose();
  const acc = (type, arr, T) => doc.createAccessor().setType(type).setArray(new T(arr)).setBuffer(buffer);
  return doc.createMesh(name).addPrimitive(doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', pos, Float32Array))
    .setAttribute('NORMAL', acc('VEC3', nor, Float32Array))
    .setIndices(acc('SCALAR', idx, pos.length / 3 > 65535 ? Uint32Array : Uint16Array))
    .setMaterial(material));
}

/** Build all six assets in memory; map keys are GLB filenames. */
export async function buildYardModuleBytes() {
  const { Document, NodeIO } = await importWV('@gltf-transform/core');
  const { ALL_EXTENSIONS } = await importWV('@gltf-transform/extensions');
  const { unpartition } = await importWV('@gltf-transform/functions');
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const out = new Map();
  for (const name of NAMES) {
    const doc = new Document();
    const buffer = doc.createBuffer();
    const scene = doc.createScene(name);
    doc.getRoot().setDefaultScene(scene);
    const root = doc.createNode(name);
    scene.addChild(root);
    const mat = (label, rgb, rough = 0.8) => doc.createMaterial(label).setBaseColorFactor([...rgb, 1])
      .setRoughnessFactor(rough).setMetallicFactor(0);
    const at = (label, mesh, x, y, z) => doc.createNode(label).setMesh(mesh).setTranslation([x, y, z].map(round));
    if (name === 'PalletYardModule') {
      const white = mat('Marking_White', [0.92, 0.92, 0.92]);
      const mesh = boxMesh(doc, buffer, 'LaneEdge', [MODULE_PITCH_M, FRAME_H, FRAME_W], white);
      for (const [label, z] of [['SouthIn', -COURSE.r + LANE_HALF_M], ['SouthOut', -COURSE.r - LANE_HALF_M],
        ['NorthIn', COURSE.r - LANE_HALF_M], ['NorthOut', COURSE.r + LANE_HALF_M]]) {
        root.addChild(at('LaneEdge_' + label, mesh, 0, FRAME_H / 2, z));
      }
    } else if (name === 'PalletYardEndWest' || name === 'PalletYardEndEast') {
      const white = mat('Marking_White', [0.92, 0.92, 0.92]);
      for (const [label, radius] of [['EdgeInner', COURSE.r - LANE_HALF_M], ['EdgeOuter', COURSE.r + LANE_HALF_M]]) {
        root.addChild(doc.createNode(label).setMesh(arcMesh(doc, buffer, label, radius,
          name === 'PalletYardEndEast' ? -90 : 90, white)));
      }
      const mesh = boxMesh(doc, buffer, 'LaneEdge', [END_STRAIGHT_M, FRAME_H, FRAME_W], white);
      const x = (name === 'PalletYardEndWest' ? 1 : -1) * END_STRAIGHT_M / 2;
      for (const [label, z] of [['SouthIn', -COURSE.r + LANE_HALF_M], ['SouthOut', -COURSE.r - LANE_HALF_M],
        ['NorthIn', COURSE.r - LANE_HALF_M], ['NorthOut', COURSE.r + LANE_HALF_M]]) {
        root.addChild(at('LaneEdge_' + label, mesh, x, FRAME_H / 2, z));
      }
    } else if (name === 'PalletYardSlotMarking') {
      const yellow = mat('Marking_Yellow', [0.95, 0.76, 0]);
      const fx = PALLET_WIDTH_M + 0.1, fz = PALLET_LENGTH_M + 0.1;
      const barX = boxMesh(doc, buffer, 'Marking_SlotBarX', [fx + FRAME_W, FRAME_H, FRAME_W], yellow);
      const barZ = boxMesh(doc, buffer, 'Marking_SlotBarZ', [FRAME_W, FRAME_H, fz - FRAME_W], yellow);
      const frame = doc.createNode('Frame').setTranslation([0, FRAME_H / 2, 0]);
      frame.addChild(at('N', barX, 0, 0, fz / 2)).addChild(at('S', barX, 0, 0, -fz / 2))
        .addChild(at('E', barZ, fx / 2, 0, 0)).addChild(at('W', barZ, -fx / 2, 0, 0));
      root.addChild(frame);
    } else if (name === 'PalletYardChargerStation') {
      const blue = mat('Marking_Blue', [0.12, 0.35, 0.66]);
      const housing = mat('Charger_Housing', [0.18, 0.2, 0.23], 0.5);
      root.addChild(at('Plate', boxMesh(doc, buffer, 'Marking_ChargerPlate', [1, FRAME_H, 1.9], blue), 0, FRAME_H / 2, 0));
      root.addChild(at('Housing', boxMesh(doc, buffer, 'Charger_Box', [0.7, 0.6, 0.35], housing),
        0, 0.3, -(VEHICLE_LENGTH_MM / 2000 + 0.25)));
    } else {
      const white = mat('Marking_White', [0.92, 0.92, 0.92]);
      root.addChild(at('Line', boxMesh(doc, buffer, 'Marking_WaitLine', [1, FRAME_H, 0.08], white),
        0, FRAME_H / 2, VEHICLE_LENGTH_MM / 2000 + 0.1));
    }
    await doc.transform(unpartition());
    out.set(name + '.glb', await io.writeBinary(doc));
  }
  return out;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Write only changed bytes; the caller refreshes the bundled library catalog. */
export async function writeYardModules({ libDir = LIB_DIR } = {}) {
  const results = [];
  for (const [name, bytes] of await buildYardModuleBytes()) {
    mkdirSync(libDir, { recursive: true });
    const file = path.join(libDir, name);
    const hash = sha256(bytes);
    const written = !existsSync(file) || sha256(readFileSync(file)) !== hash;
    if (written) writeFileSync(file, bytes);
    results.push({ file, sha256: hash, sizeBytes: bytes.byteLength, written });
  }
  return results;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  for (const r of await writeYardModules({ libDir: process.argv[2] ? path.resolve(process.argv[2]) : LIB_DIR })) {
    console.log(`${r.written ? 'wrote' : 'unchanged'} ${r.file} (${r.sizeBytes} B, sha256 ${r.sha256})`);
  }
  console.log('run: node scripts/build-local-library-catalog.mjs (in realvirtual-WebViewer~)');
}
