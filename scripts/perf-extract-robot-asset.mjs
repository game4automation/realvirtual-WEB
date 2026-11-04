// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
/**
 * Cut the six-axis robot out of the demo model and write it as THE library
 * robot (written first for the plan-492 cell-matrix benchmark).
 *
 *   node scripts/perf-extract-robot-asset.mjs [--source <glb>] [--out <glb>] [--no-catalog]
 *
 * What it does:
 *   1. Loads `public/demo-realvirtual/DemoRealvirtualWeb.glb` and takes the
 *      `FanucCRX-10iA_L` subtree (A1..A6 `Drive`s, links, Schunk gripper).
 *   2. Makes that subtree the ONLY scene root, at the origin.
 *   3. Strips everything that binds the robot to the demo cell: `rigidbody`,
 *      `AASLink`, `Grip`, and every ComponentReference that leaves the subtree
 *      (gripper `Out`/`IsOut` signals); references INTO the subtree (`MasterDrive`)
 *      are rewritten onto the new root name. Keeps the axis and gripper `Drive`s.
 *   4. Adds NO motion of its own any more. Until 2026-10-25 this step put
 *      `Drive_ErraticPosition` on A1..A6; Thomas decided the library robot gets
 *      a logical robot definition instead (RobotIK + demo IKPath,
 *      `author-robot-ik.mjs`) and the benchmark its own sweeping copy
 *      (`build-perf-robot-asset.mjs`, which now owns the sweep table).
 *   5. Prunes unused meshes/materials/textures and writes
 *      `public/library/Robots/FanucCRX-10iA-L.glb`, then rebuilds the local catalog
 *      (`build-local-library-catalog.mjs`, entry id `robots-fanuccrx-10ia-l`).
 *
 * The result is a plain library asset like the PalletHandling conveyors: a
 * single root, no PlacementMeta (the planner adds that on placement), no
 * snap ports (the robot is placed freely beside a lane).
 *
 * RE-RUNNING THIS DROPS THE PHYSICS AND IK AUTHORING. The full chain is
 *
 *   node scripts/perf-extract-robot-asset.mjs
 *   node scripts/author-robot-physics.mjs
 *   node scripts/author-robot-ik.mjs
 *   node scripts/build-perf-robot-asset.mjs
 *
 * and `tests/robot-library-asset.node.test.ts` fails if a step is missing.
 * Since plan-673 Phase 4b the same
 * asset also carries `MechanismBody`, `CollisionShapeSet`, `ContactProfile`,
 * `DynamicAxis` and `GripLoad`, written by `scripts/author-robot-physics.mjs`
 * from the demo model's geometry. This script rebuilds the file from the demo
 * scene and knows nothing about them, so run the authoring script again right
 * after it; `tests/crx-library-physics.node.test.ts` fails if you forget.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, draco } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const SOURCE = resolve(ROOT, opt('--source', 'public/demo-realvirtual/DemoRealvirtualWeb.glb'));
const OUT = resolve(ROOT, opt('--out', 'public/library/Robots/FanucCRX-10iA-L.glb'));
const WRITE_CATALOG = !args.includes('--no-catalog');

const ROBOT_NODE = 'FanucCRX-10iA_L';
const ROOT_NAME = 'FanucCRX-10iA-L';

/** Extras keys that tie the robot to the demo cell — dropped on every node. */
const STRIP_KEYS = new Set(['rigidbody', 'AASLink', 'Grip', 'colliders', 'ConnectSignal', 'PLCInputBool', 'PLCOutputBool']);

// The demo model is Draco-compressed (KHR_draco_mesh_compression is REQUIRED),
// so the reader needs the decoder; the writer re-encodes the same way, like
// scripts/compress-glb.mjs does, to keep the library asset small.
const [decoder, encoder] = await Promise.all([draco3d.createDecoderModule(), draco3d.createEncoderModule()]);
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'draco3d.decoder': decoder, 'draco3d.encoder': encoder });
const doc = await io.read(SOURCE);
const root = doc.getRoot();
const scene = root.listScenes()[0];
if (!scene) throw new Error(`${SOURCE}: no scene`);

const robot = root.listNodes().find((n) => n.getName() === ROBOT_NODE);
if (!robot) throw new Error(`${SOURCE}: node "${ROBOT_NODE}" not found`);

// 1. Re-root: the robot becomes the only scene root, at the origin.
const parent = robot.getParentNode();
if (parent) parent.removeChild(robot);
for (const top of scene.listChildren()) scene.removeChild(top);
robot.setTranslation([0, 0, 0]).setRotation([0, 0, 0, 1]).setScale([1, 1, 1]);
robot.setName(ROOT_NAME);
scene.addChild(robot);

// 2. Walk the subtree: strip demo bindings.
//
//    ComponentReferences (`{ type: 'ComponentReference', path, … }`) are the
//    second way the demo cell reaches into the robot: the gripper cylinder's
//    `Out` / `IsOut` point at PLC signal nodes under `Robot/…`, and the finger
//    gears' `MasterDrive` points at the gripper by its OLD absolute path. A
//    reference into the extracted subtree is rewritten onto the new root name;
//    a reference anywhere else is dropped (set to null), so the asset carries
//    no path into a scene it will never be loaded with.
const OLD_PREFIX = 'Robot/' + ROBOT_NODE;
const report = { nodes: 0, stripped: {}, drives: [], refsRewritten: [], refsDropped: [] };
const fixRefs = (obj, where) => {
  if (!obj || typeof obj !== 'object') return obj;
  if (obj.type === 'ComponentReference' && typeof obj.path === 'string') {
    if (obj.path === OLD_PREFIX || obj.path.startsWith(OLD_PREFIX + '/')) {
      const next = ROOT_NAME + obj.path.slice(OLD_PREFIX.length);
      report.refsRewritten.push(`${where}: ${obj.path} -> ${next}`);
      return { ...obj, path: next };
    }
    report.refsDropped.push(`${where}: ${obj.path}`);
    return null;
  }
  if (Array.isArray(obj)) return obj.map((v, i) => fixRefs(v, `${where}[${i}]`));
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = fixRefs(v, `${where}.${k}`);
  return out;
};
const walk = (node) => {
  report.nodes++;
  const extras = node.getExtras() ?? {};
  let rv = extras.realvirtual;
  if (rv && typeof rv === 'object') {
    for (const key of Object.keys(rv)) {
      if (STRIP_KEYS.has(key)) {
        delete rv[key];
        report.stripped[key] = (report.stripped[key] ?? 0) + 1;
      }
    }
    rv = fixRefs(rv, node.getName());
    if (rv.Drive) report.drives.push(node.getName());
    node.setExtras({ ...extras, realvirtual: rv });
  }
  for (const c of node.listChildren()) walk(c);
};
walk(robot);

// 3. Drop every node that is no longer reachable from the scene, then prune
//    the meshes/materials/textures/accessors nothing references any more.
for (const n of root.listNodes()) {
  if (n === robot) continue;
  let p = n;
  while (p && p !== robot) p = p.getParentNode();
  if (p !== robot) n.dispose();
}
await doc.transform(dedup(), prune(), draco({ method: 'edgebreaker' }));

// 4. Write.
await mkdir(dirname(OUT), { recursive: true });
const glb = await io.writeBinary(doc);
await writeFile(OUT, glb);

// 5. Verify by re-reading the file we just wrote.
const check = await io.read(OUT);
let triangles = 0;
for (const mesh of check.getRoot().listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const idx = prim.getIndices();
    triangles += idx ? idx.getCount() / 3 : prim.getAttribute('POSITION').getCount() / 3;
  }
}
const nodes = check.getRoot().listNodes();
const comps = {};
for (const n of nodes) {
  const rv = n.getExtras()?.realvirtual ?? {};
  for (const k of Object.keys(rv)) {
    if (k === 'layer' || k === 'tag' || k === 'activeSelf' || k === 'renderer') continue;
    comps[k] = (comps[k] ?? 0) + 1;
  }
}
console.log(`[extract-robot] wrote ${OUT}`);
console.log(`  size        ${(glb.byteLength / 1048576).toFixed(2)} MB`);
console.log(`  nodes       ${nodes.length} (walked ${report.nodes})`);
console.log(`  triangles   ${triangles}`);
console.log(`  materials   ${check.getRoot().listMaterials().length}, textures ${check.getRoot().listTextures().length}`);
console.log(`  drives      ${report.drives.join(', ')}`);
console.log(`  stripped    ${JSON.stringify(report.stripped)}`);
console.log(`  refs        rewritten ${report.refsRewritten.length}, dropped ${report.refsDropped.length}`);
for (const r of report.refsRewritten) console.log(`              ~ ${r}`);
for (const r of report.refsDropped) console.log(`              - ${r}`);
console.log(`  components  ${JSON.stringify(comps)}`);
for (const k of STRIP_KEYS) if (comps[k]) throw new Error(`verification: ${k} still present`);
// No ComponentReference may point outside the asset: every remaining path must
// start with the new root name (checked on the re-read file, not on memory).
const leaks = [];
const scanRefs = (o, where) => {
  if (!o || typeof o !== 'object') return;
  if (o.type === 'ComponentReference' && typeof o.path === 'string' && !o.path.startsWith(ROOT_NAME)) leaks.push(`${where}: ${o.path}`);
  for (const [k, v] of Object.entries(o)) scanRefs(v, `${where}.${k}`);
};
for (const n of nodes) scanRefs(n.getExtras()?.realvirtual, n.getName());
if (leaks.length) throw new Error(`verification: references leave the asset:\n  ${leaks.join('\n  ')}`);

// 6. Library: `build-local-library-catalog.mjs` regenerates library/project.json from the
//    folder scan (id = slug of the path, e.g. `robots-fanuccrx-10ia-l`), so a
//    hand-written row would be overwritten on its next run. Run it instead.
if (WRITE_CATALOG) {
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, [resolve(HERE, 'build-local-library-catalog.mjs')], { stdio: 'inherit' });
}
