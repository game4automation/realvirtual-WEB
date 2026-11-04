// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * build-perf-robot-asset.mjs — the plan-492 benchmark's OWN copy of the library
 * robot, with the random axis sweep.
 *
 *   node scripts/build-perf-robot-asset.mjs
 *
 * Until 2026-10-25 the benchmark placed the library asset itself, and the
 * library asset therefore carried `Drive_ErraticPosition` on A1..A6. Thomas
 * decided the library robot gets a logical robot definition instead (RobotIK +
 * demo IKPath, `author-robot-ik.mjs`), and the benchmark a separate copy. This
 * script makes that copy from the CURRENT library file, so physics authoring,
 * geometry and every drive stay identical to what a user places:
 *
 *   1. drops the `RobotIK` and the `Robotpath` subtree — the benchmark places
 *      dozens of robots through `rescopeComponentRefs`, which only rewrites
 *      `ComponentReference` objects, and `RobotIK.TCP` is a plain path string;
 *      the sweep needs no rig;
 *   2. adds `Drive_ErraticPosition` to A1..A6 in iterate mode, no SignalEnable,
 *      so every axis sweeps on its own the moment the scene is initialised —
 *      deterministic, no PLC, no seed;
 *   3. writes `public/perf/Robots/FanucCRX-10iA-L-erratic.glb` — OUTSIDE
 *      `public/library/`, so the library catalog never lists it.
 *
 * The root keeps the name `FanucCRX-10iA-L` (`ROBOT_ASSET_ROOT` in
 * `rv-cell-matrix.ts` is the prefix its references carry).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlb, writeGlb } from './lib/rv-glb.mjs';
import { findByPath } from './lib/rv-glb-nodes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

export const SOURCE = 'public/library/Robots/FanucCRX-10iA-L.glb';
export const PERF_ROBOT_FILE = 'public/perf/Robots/FanucCRX-10iA-L-erratic.glb';
const R = 'FanucCRX-10iA-L';

/**
 * Sweep range per axis in degrees and speed in deg/s. Chosen so the arm stays
 * clear of its own base and of a conveyor standing beside it, and so the six
 * periods differ (no two axes reverse in the same tick).
 */
export const ERRATIC = Object.freeze({
  A1: { MinPos: -60, MaxPos: 60, Speed: 40 },
  A2: { MinPos: -25, MaxPos: 25, Speed: 25 },
  A3: { MinPos: -35, MaxPos: 35, Speed: 30 },
  A4: { MinPos: -90, MaxPos: 90, Speed: 60 },
  A5: { MinPos: -45, MaxPos: 45, Speed: 45 },
  A6: { MinPos: -180, MaxPos: 180, Speed: 90 },
});

export function erraticExtras(spec) {
  return {
    _fullTypeName: 'realvirtual.Drive_ErraticPosition',
    _version: 2,
    _enabled: true,
    MinPos: spec.MinPos,
    MaxPos: spec.MaxPos,
    Speed: spec.Speed,
    Driving: false,
    IterateBetweenMaxAndMin: true,
    SignalEnable: null,
    ConnectionInfo: [],
    Name: '',
    Active: 'Always',
  };
}

/**
 * Remove node `idx` and its whole subtree from the JSON chunk, remapping every
 * node index that remains. Refuses a file whose skins or animations reference
 * nodes (the robot has none, and a silent remap there would be untested).
 */
export function removeSubtree(json, idx) {
  if ((json.skins?.length ?? 0) > 0 || (json.animations?.length ?? 0) > 0) {
    throw new Error('removeSubtree: skins/animations present — not supported');
  }
  const drop = new Set();
  const walk = (i) => { drop.add(i); for (const c of json.nodes[i].children ?? []) walk(c); };
  walk(idx);
  const remap = new Map();
  const kept = [];
  json.nodes.forEach((n, i) => { if (!drop.has(i)) { remap.set(i, kept.length); kept.push(n); } });
  const fix = (list) => list.filter((i) => !drop.has(i)).map((i) => remap.get(i));
  for (const n of kept) {
    if (n.children) {
      n.children = fix(n.children);
      if (n.children.length === 0) delete n.children;
    }
  }
  for (const s of json.scenes ?? []) if (s.nodes) s.nodes = fix(s.nodes);
  json.nodes = kept;
  return drop.size;
}

export function applyPerfCopy(json) {
  const log = [];
  const at = (path) => {
    const i = findByPath(json, path);
    if (i === null) throw new Error(`${SOURCE}: no node at "${path}"`);
    return i;
  };
  const rootRv = json.nodes[at(R)].extras?.realvirtual;
  if (rootRv?.RobotIK) { delete rootRv.RobotIK; log.push(`${R}: RobotIK dropped`); }
  const pathIdx = findByPath(json, `${R}/Robotpath`);
  if (pathIdx !== null) log.push(`${R}/Robotpath: subtree dropped (${removeSubtree(json, pathIdx)} nodes)`);
  let path = R;
  for (const [axis, spec] of Object.entries(ERRATIC)) {
    path += `/${axis}`;
    const n = json.nodes[at(path)];
    n.extras ??= {};
    n.extras.realvirtual ??= {};
    n.extras.realvirtual.Drive_ErraticPosition = erraticExtras(spec);
    log.push(`${path}: Drive_ErraticPosition ${spec.MinPos}..${spec.MaxPos} deg @ ${spec.Speed} deg/s`);
  }
  const info = json.scenes?.[0]?.extras?.realvirtual?.DocumentInfo;
  if (info) {
    info.summary = 'BENCHMARK COPY (plan-492) of the library Fanuc CRX-10iA/L: every axis sweeps on its own via Drive_ErraticPosition. Not a library asset.';
    info.description = '# Fanuc CRX-10iA/L (benchmark copy)\n\n'
      + 'Made by `scripts/build-perf-robot-asset.mjs` from the library robot for the plan-492 cell-matrix '
      + 'benchmark: no RobotIK, no IKPath, and `Drive_ErraticPosition` on A1-A6 so dozens of placed copies '
      + 'move without a PLC. Place the library robot instead for anything else.';
    info.updatedAt = new Date().toISOString();
  }
  return log;
}

async function main() {
  const { json, rest } = readGlb(await readFile(resolve(ROOT, SOURCE)));
  const log = applyPerfCopy(json);
  const out = resolve(ROOT, PERF_ROBOT_FILE);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, writeGlb(json, rest));
  console.log(`[build-perf-robot-asset] ${SOURCE} -> ${PERF_ROBOT_FILE}`);
  for (const line of log) console.log(`  ~ ${line}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
