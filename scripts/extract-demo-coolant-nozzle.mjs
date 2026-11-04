// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * extract-demo-coolant-nozzle.mjs — plan-522: make the CNC spindle's EXISTING
 * coolant nozzle of the standard demo an addressable node `CoolantNozzle`.
 *
 * The nozzle is modelled in the spindle head: the `PlasticBlue` primitive of the
 * `ZAxis` Draco mesh (`ZAxis_3` in the viewer) carries the hose fittings and,
 * below the black elbow, one blue nozzle tip — a connected part of its own
 * (≈ 430 triangles, the lowest component of that primitive). This script cuts
 * exactly that part out; nothing is invented (review Thomas 2026-10-22, which
 * replaced the four added tips of the first version).
 *
 * Bytes: the decoded `PlasticBlue` primitive is rewritten UNCOMPRESSED without
 * the nozzle triangles (its Draco extension is dropped, every other primitive and
 * mesh keeps its compressed data), and the nozzle becomes one uncompressed mesh
 * on a new node created through `rv-glb-nodes` (`createGroup`, file-wide name
 * rule) under `ZAxis`, so it follows the spindle. All new data is appended
 * behind the existing BIN data.
 *
 * Nozzle frame: node origin = nozzle mouth, local -Y = spray direction (the
 * axis of the tip), the body extends along local +Y. Unscrewing the tip is a
 * move along local +Y plus a rotation about local Y.
 *
 * Usage: node scripts/extract-demo-coolant-nozzle.mjs --in <glb without nozzle node> [--out <glb>] [--check]
 *   --check  only report whether the nozzle node is present (exit 1 when missing)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readGlb, writeGlb, CHUNK_BIN } from './lib/rv-glb.mjs';
import { createGroup, findByPath, fileNameCollisions, nodePaths } from './lib/rv-glb-nodes.mjs';

export const ZAXIS_PATH = 'DemoCell/CNC/MovingParts/X_Axis/YAxis/ZAxis';
export const NOZZLE_NAME = 'CoolantNozzle';
export const NOZZLE_PATH = `${ZAXIS_PATH}/${NOZZLE_NAME}`;
const MATERIAL_NAME = 'PlasticBlue';
const MESH_NAME = 'CoolantNozzleMesh';
const DRACO = 'KHR_draco_mesh_compression';

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function norm(a) { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

/** Quaternion [x,y,z,w] that turns unit vector `from` onto unit vector `to`. */
function quatFromTo(from, to) {
  const d = dot(from, to);
  if (d < -0.999999) { const ax = norm(Math.abs(from[0]) < 0.9 ? cross(from, [1, 0, 0]) : cross(from, [0, 1, 0])); return [ax[0], ax[1], ax[2], 0]; }
  const c = cross(from, to); const q = [c[0], c[1], c[2], 1 + d]; const l = Math.hypot(...q);
  return q.map((v) => v / l);
}

/** Rotate v by the inverse of unit quaternion q. */
function rotateInv(q, v) {
  const [x, y, z, w] = [-q[0], -q[1], -q[2], q[3]];
  const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [v[0] + w * t[0] + (y * t[2] - z * t[1]), v[1] + w * t[1] + (z * t[0] - x * t[2]), v[2] + w * t[2] + (x * t[1] - y * t[0])];
}

/** Connected parts of an indexed triangle list (vertices welded by position). */
export function connectedParts(pos, idx) {
  const n = pos.length / 3;
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const seen = new Map();
  for (let i = 0; i < n; i++) {
    const k = `${pos[3 * i].toFixed(5)},${pos[3 * i + 1].toFixed(5)},${pos[3 * i + 2].toFixed(5)}`;
    const j = seen.get(k);
    if (j === undefined) seen.set(k, i); else parent[find(i)] = find(j);
  }
  for (let t = 0; t < idx.length; t += 3) { const a = find(idx[t]); parent[find(idx[t + 1])] = a; parent[find(idx[t + 2])] = a; }
  const parts = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    const r = find(idx[t]);
    let p = parts.get(r);
    if (!p) { p = { tris: [], minY: Infinity }; parts.set(r, p); }
    p.tris.push(t / 3);
    for (let c = 0; c < 3; c++) p.minY = Math.min(p.minY, pos[3 * idx[t + c] + 1]);
  }
  return [...parts.values()];
}

/** Axis of a point set (power iteration on the covariance), centroid. */
function principalAxis(points) {
  const c = [0, 0, 0];
  for (const p of points) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  c[0] /= points.length; c[1] /= points.length; c[2] /= points.length;
  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of points) { const d = sub(p, c); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i][j] += d[i] * d[j]; }
  let v = [0, -1, 0];
  for (let k = 0; k < 64; k++) v = norm([dot(m[0], v), dot(m[1], v), dot(m[2], v)]);
  return { centroid: c, axis: v };
}

/** Decoded attribute arrays of the ZAxis PlasticBlue primitive. */
async function decodePrimitive(file, meshName, materialName) {
  const { NodeIO } = await import('@gltf-transform/core');
  const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
  const draco3d = (await import('draco3dgltf')).default;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() });
  const doc = await io.readBinary(new Uint8Array(file));
  const mesh = doc.getRoot().listMeshes().find((m) => m.getName() === meshName);
  if (!mesh) throw new Error(`mesh ${meshName} not found`);
  const prims = mesh.listPrimitives();
  const index = prims.findIndex((p) => p.getMaterial()?.getName() === materialName);
  if (index < 0) throw new Error(`primitive ${materialName} not found in ${meshName}`);
  const p = prims[index];
  const attributes = {};
  for (const s of p.listSemantics()) {
    const a = p.getAttribute(s);
    attributes[s] = { array: a.getArray(), type: a.getType(), normalized: a.getNormalized() };
  }
  return { index, attributes, indices: p.getIndices().getArray() };
}

const COMPONENT_TYPE = new Map([[Float32Array, 5126], [Uint16Array, 5123], [Uint8Array, 5121], [Uint32Array, 5125]]);
const ITEM_SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/** Gather `tris` of the decoded primitive into compact attribute arrays. */
function gather(decoded, tris, transform) {
  const remap = new Map();
  const order = [];
  const indices = new Uint32Array(tris.length * 3);
  tris.forEach((t, k) => {
    for (let c = 0; c < 3; c++) {
      const v = decoded.indices[3 * t + c];
      let r = remap.get(v);
      if (r === undefined) { r = order.length; remap.set(v, r); order.push(v); }
      indices[3 * k + c] = r;
    }
  });
  const attributes = {};
  for (const [sem, a] of Object.entries(decoded.attributes)) {
    const size = ITEM_SIZE[a.type];
    const out = new a.array.constructor(order.length * size);
    order.forEach((v, i) => {
      let val = Array.from(a.array.subarray(v * size, v * size + size));
      if (transform && sem === 'POSITION') val = transform.position(val);
      if (transform && sem === 'NORMAL') val = transform.normal(val);
      out.set(val, i * size);
    });
    attributes[sem] = { ...a, array: out };
  }
  return { attributes, indices: order.length < 65536 ? Uint16Array.from(indices) : indices };
}

function pad4(n) { return (n + 3) & ~3; }

export async function extractNozzle(buffer) {
  const { json, rest } = readGlb(buffer);
  if (findByPath(json, NOZZLE_PATH) !== null) throw new Error(`${NOZZLE_PATH} already present — refusing to cut it twice`);
  const zaxis = findByPath(json, ZAXIS_PATH);
  if (zaxis === null) throw new Error(`${ZAXIS_PATH} not found`);
  const meshIndex = json.nodes[zaxis].mesh;
  const meshName = json.meshes[meshIndex].name;
  const collisionsBefore = fileNameCollisions(json).length;
  const pathsBefore = nodePaths(json);

  const decoded = await decodePrimitive(buffer, meshName, MATERIAL_NAME);
  const parts = connectedParts(decoded.attributes.POSITION.array, decoded.indices);
  const nozzle = parts.reduce((a, b) => (b.minY < a.minY ? b : a)); // the tip hangs lowest
  const inNozzle = new Set(nozzle.tris);
  const restTris = [];
  for (let t = 0; t < decoded.indices.length / 3; t++) if (!inNozzle.has(t)) restTris.push(t);

  // Nozzle frame: axis of the tip, mouth at its lower end.
  const P = decoded.attributes.POSITION.array;
  const pts = [];
  for (const t of nozzle.tris) for (let c = 0; c < 3; c++) { const v = decoded.indices[3 * t + c]; pts.push([P[3 * v], P[3 * v + 1], P[3 * v + 2]]); }
  const { centroid, axis } = principalAxis(pts);
  const spray = axis[1] < 0 ? axis : [-axis[0], -axis[1], -axis[2]];
  let reach = 0;
  for (const p of pts) reach = Math.max(reach, dot(sub(p, centroid), spray));
  const mouth = [centroid[0] + spray[0] * reach, centroid[1] + spray[1] * reach, centroid[2] + spray[2] * reach];
  const rotation = quatFromTo([0, -1, 0], spray);
  const toLocal = { position: (v) => rotateInv(rotation, sub(v, mouth)), normal: (n) => rotateInv(rotation, n) };

  const { bin, tail } = splitBin(rest);
  const chunks = [];
  let offset = pad4(bin.length);
  const accessor = (a, target) => {
    const bytes = Buffer.from(a.array.buffer, a.array.byteOffset, a.array.byteLength);
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    chunks.push({ offset, bytes }); offset = pad4(offset + bytes.length);
    const acc = { bufferView: json.bufferViews.length - 1, componentType: COMPONENT_TYPE.get(a.array.constructor), count: a.array.length / ITEM_SIZE[a.type], type: a.type };
    if (a.normalized) acc.normalized = true;
    if (a.min) { acc.min = a.min; acc.max = a.max; }
    json.accessors.push(acc);
    return json.accessors.length - 1;
  };
  const writePrimitive = (g, material) => {
    const attributes = {};
    for (const [sem, a] of Object.entries(g.attributes)) {
      if (sem === 'POSITION') {
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < a.array.length; i += 3) for (let j = 0; j < 3; j++) { min[j] = Math.min(min[j], a.array[i + j]); max[j] = Math.max(max[j], a.array[i + j]); }
        a.min = min; a.max = max;
      }
      attributes[sem] = accessor(a, 34962);
    }
    return { attributes, indices: accessor({ array: g.indices, type: 'SCALAR' }, 34963), material, mode: 4 };
  };

  const prim = json.meshes[meshIndex].primitives[decoded.index];
  const material = prim.material;
  json.meshes[meshIndex].primitives[decoded.index] = writePrimitive(gather(decoded, restTris), material);
  json.meshes.push({ name: MESH_NAME, primitives: [writePrimitive(gather(decoded, nozzle.tris, toLocal), material)] });

  const node = createGroup(json, ZAXIS_PATH, NOZZLE_NAME);
  Object.assign(json.nodes[node.nodeIndex], { mesh: json.meshes.length - 1, translation: mouth, rotation });

  const newBin = Buffer.alloc(offset);
  bin.copy(newBin, 0);
  for (const c of chunks) c.bytes.copy(newBin, c.offset);
  json.buffers[0].byteLength = newBin.length;
  const header = Buffer.alloc(8); header.writeUInt32LE(newBin.length, 0); header.writeUInt32LE(CHUNK_BIN, 4);
  const out = writeGlb(json, Buffer.concat([header, newBin, tail]));

  // Structural self-check: every old path unchanged, no new file-wide collisions.
  const pathsAfter = nodePaths(json);
  for (const [i, p] of pathsBefore) if (pathsAfter.get(i) !== p) throw new Error(`path of node ${i} changed: ${p} -> ${pathsAfter.get(i)}`);
  if (fileNameCollisions(json).length !== collisionsBefore) throw new Error('new file-wide name collisions');
  return { out, nozzleTriangles: nozzle.tris.length, restTriangles: restTris.length, mouth, spray, dracoDropped: !!prim.extensions?.[DRACO] };
}

/** Splits the GLB's trailing bytes into the BIN chunk payload and anything behind it. */
function splitBin(rest) {
  if (rest.length < 8) throw new Error('GLB has no BIN chunk');
  const len = rest.readUInt32LE(0), type = rest.readUInt32LE(4);
  if (type !== CHUNK_BIN) throw new Error('second chunk is not BIN');
  return { bin: rest.subarray(8, 8 + len), tail: rest.subarray(8 + len) };
}

function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; }

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const input = resolve(arg('--in') ?? 'public/demo-realvirtual/DemoRealvirtualWeb.glb');
  const buffer = readFileSync(input);
  if (process.argv.includes('--check')) {
    const present = findByPath(readGlb(buffer).json, NOZZLE_PATH) !== null;
    console.log(`coolant nozzle present: ${present}`);
    process.exit(present ? 0 : 1);
  }
  const output = resolve(arg('--out') ?? input);
  const r = await extractNozzle(buffer);
  writeFileSync(output, r.out);
  console.log(`${NOZZLE_PATH}: ${r.nozzleTriangles} triangles cut out (${r.restTriangles} stay in ${MATERIAL_NAME}, Draco dropped: ${r.dracoDropped})`);
  console.log(`mouth=${r.mouth.map((v) => v.toFixed(4)).join(',')}  spray=${r.spray.map((v) => v.toFixed(3)).join(',')}`);
  console.log(`wrote ${output} (${r.out.length} bytes)`);
}
