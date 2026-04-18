// Stub `self` so three's GLTFLoader works under node, then load the Mauser GLB
// and report Door_3_1's bbox + mesh children.
globalThis.self = globalThis;
globalThis.URL = globalThis.URL || (await import('node:url')).URL;
globalThis.document = { createElementNS: () => ({}), createElement: () => ({ getContext: () => null }) };

import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Box3, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const glbPath = resolve(__dirname, '../../realvirtual-WebViewer-Private~/projects/mauser3dhmi/models/DemoCageLineMauser.glb');
const buf = await fs.readFile(glbPath);

const loader = new GLTFLoader();
// Skip texture loading (we only need transforms + geometry)
loader.register((parser) => ({
  name: 'NoTextures',
  loadTexture: async () => null,
  loadTextureImage: async () => null,
  loadImageSource: async () => null,
}));

const gltf = await new Promise((resolveP, rejectP) => {
  loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', resolveP, rejectP);
});

// Sanity: count total meshes in the loaded scene
let totalMeshes = 0;
gltf.scene.traverse(c => { if (c.isMesh) totalMeshes++; });
console.error(`[debug] total meshes in scene: ${totalMeshes}`);

let door = null;
gltf.scene.traverse(n => { if (!door && n.name === 'Door_3_1') door = n; });
if (!door) {
  console.log('Door_3_1 not found. Door_* nodes present:');
  const names = [];
  gltf.scene.traverse(n => { if (n.name?.startsWith('Door_')) names.push(n.name); });
  console.log(names);
  process.exit(1);
}

// Walk Door_3_1 tree showing all children (incl. non-mesh)
console.error('[debug] Door_3_1 subtree:');
function dump(n, depth) {
  const pad = '  '.repeat(depth);
  const wp = new Vector3(); n.getWorldPosition(wp);
  console.error(`${pad}- ${n.type} "${n.name || '<noname>'}" worldY=${wp.y.toFixed(3)} isMesh=${!!n.isMesh}`);
  for (const c of n.children) dump(c, depth + 1);
}
dump(door, 0);

// Walk PARENT (Door_3) subtree to find the actual visible door mesh and its location
console.error('\n[debug] Door_3 (parent) subtree:');
let parent = door.parent;
function dumpFull(n, depth, maxDepth = 3) {
  if (depth > maxDepth) return;
  const pad = '  '.repeat(depth);
  const wp = new Vector3(); n.getWorldPosition(wp);
  let extra = '';
  if (n.isMesh && n.geometry) {
    const cb = new Box3().setFromObject(n);
    extra = ` MESH wbboxY=[${cb.min.y.toFixed(2)} … ${cb.max.y.toFixed(2)}]`;
  }
  console.error(`${pad}- ${n.type} "${n.name || '<noname>'}" worldY=${wp.y.toFixed(3)}${extra}`);
  for (const c of n.children) dumpFull(c, depth + 1, maxDepth);
}
if (parent) dumpFull(parent, 0, 3);

door.updateMatrixWorld(true);
const wp = new Vector3();
door.getWorldPosition(wp);

const wbox = new Box3().setFromObject(door);
const wsize = new Vector3();
wbox.getSize(wsize);

const inv = door.matrixWorld.clone().invert();
const lbox = wbox.clone().applyMatrix4(inv);

const meshes = [];
door.traverse(c => {
  if (c.isMesh && c.geometry) {
    const mw = new Vector3();
    c.getWorldPosition(mw);
    const cbox = new Box3().setFromObject(c);
    meshes.push({
      name: c.name || '<unnamed>',
      worldPos: { x: +mw.x.toFixed(3), y: +mw.y.toFixed(3), z: +mw.z.toFixed(3) },
      wbboxMin: { x: +cbox.min.x.toFixed(3), y: +cbox.min.y.toFixed(3), z: +cbox.min.z.toFixed(3) },
      wbboxMax: { x: +cbox.max.x.toFixed(3), y: +cbox.max.y.toFixed(3), z: +cbox.max.z.toFixed(3) },
    });
  }
});

console.log(JSON.stringify({
  parent: door.parent?.name ?? null,
  worldPos: { x: +wp.x.toFixed(3), y: +wp.y.toFixed(3), z: +wp.z.toFixed(3) },
  localPos: { x: +door.position.x.toFixed(3), y: +door.position.y.toFixed(3), z: +door.position.z.toFixed(3) },
  worldBBox: {
    min: { x: +wbox.min.x.toFixed(3), y: +wbox.min.y.toFixed(3), z: +wbox.min.z.toFixed(3) },
    max: { x: +wbox.max.x.toFixed(3), y: +wbox.max.y.toFixed(3), z: +wbox.max.z.toFixed(3) },
    size: { x: +wsize.x.toFixed(3), y: +wsize.y.toFixed(3), z: +wsize.z.toFixed(3) },
  },
  localBBox: {
    min: { x: +lbox.min.x.toFixed(3), y: +lbox.min.y.toFixed(3), z: +lbox.min.z.toFixed(3) },
    max: { x: +lbox.max.x.toFixed(3), y: +lbox.max.y.toFixed(3), z: +lbox.max.z.toFixed(3) },
  },
  totalMeshChildren: meshes.length,
  meshChildren: meshes,
}, null, 2));
