// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * author-robot-ik.mjs — give the library robot a LOGICAL robot definition:
 * a `RobotIK` rig and a demo `IKPath`, instead of the random axis sweep.
 *
 *   node scripts/author-robot-ik.mjs [--check] [--no-catalog]
 *
 * `--check` derives, solves and prints everything without touching the file.
 *
 * ## Decision (Thomas, 2026-10-25) — plan-773 E5 is lifted for this asset
 *
 * Until now `public/library/Robots/FanucCRX-10iA-L.glb` deliberately carried NO
 * `RobotIK` (plan-773 E5: "the rig is derived in the browser") and swept its six
 * axes with `Drive_ErraticPosition` for the plan-492 benchmark. Thomas: "the
 * fanuc in the library should have a logical inverse kinematic definition and
 * not the erratic setup". So this script:
 *
 *   1. removes `Drive_ErraticPosition` from A1..A6 — the benchmark keeps its
 *      sweep in its OWN copy, `public/perf/Robots/FanucCRX-10iA-L-erratic.glb`
 *      (`scripts/build-perf-robot-asset.mjs`, never in the library catalog);
 *   2. writes `RobotIK` on the robot root with fields produced by the SAME
 *      derivation `web_robot_rig_from_library` runs in the browser
 *      (`deriveSerialAxisChain` → `chainFromDerivation` → `measureWristType` /
 *      `estimateOpwFromChain` → `buildRobotIkRigFields`, `rv-robot-rig.ts`).
 *      No number in it is typed by hand. The frame objection of the old
 *      `author-robot-physics.mjs` header (OPW measured Z-up in a Y-up asset) does
 *      not apply to these fields: the derivation measures along the base axis it
 *      FINDS, not along a fixed one;
 *   3. adds an `IKPath` `Robotpath` with five `IKTarget`s in front of the robot
 *      (-Z, where the arm points at home): Home, PickBefore, Pick, PlaceBefore, Place — the shape of the
 *      realvirtual reference rig in `DemoRobotIK.glb`. `StartPath` is FALSE (the
 *      start switch, default OFF), `LoopPath` true: a placed robot stands still at
 *      home until somebody switches the path on, so a document that drives the
 *      axes itself (the peg game's LogicStep sequence) is not fought.
 *
 * ## How the targets are made
 *
 * Every target is chosen as a GRIPPER pose (approach straight down, the tool
 * orientation the peg game uses — `toolQuat`), solved for its six joint angles
 * by the damped-least-squares solver of `solve-peg-game-poses.mjs` against the
 * asset's own `Drive` declarations, seeded from the previous target so the
 * cycle stays on one branch, and REQUIRED to land inside the drive limits. The
 * target node is then put exactly where forward kinematics of those angles puts
 * the `TCP` node — so the baked `AxisPos` reach the target pose by construction
 * and a build without the cobot solver (free tier: replay only) still runs the
 * path correctly.
 *
 * Re-running `perf-extract-robot-asset.mjs` + `author-robot-physics.mjs`
 * rebuilds the file without any of this; run this script after them, then
 * `build-perf-robot-asset.mjs`. `tests/robot-library-asset.node.test.ts`
 * fails if a step is forgotten.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { readGlb, writeGlb } from './lib/rv-glb.mjs';
import { findByPath, createGroup } from './lib/rv-glb-nodes.mjs';
import { loadGlbAsThree } from './lib/rv-glb-three.mjs';
import { fk, readChain, solveRobust, toolQuat } from './solve-peg-game-poses.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const FILE = 'public/library/Robots/FanucCRX-10iA-L.glb';
const R = 'FanucCRX-10iA-L';
const AXES = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'];
const PATH_NODE = 'Robotpath';

/**
 * The demo cycle, as GRIPPER-node positions in the robot frame (m, glTF Y up).
 * "In front" is -Z: A1's authored frame is turned 90 deg about Y, so at the
 * home pose the arm points along -Z. X 0.15 is the lateral wrist offset of the
 * CRX (axis 6 runs 150 mm beside the wrist point) — with it, Home solves to
 * A1 = 0 exactly. Pick and place sit 350 mm either side of that line, with a
 * 200 mm straight approach, all well inside the 1418 mm reach.
 */
export const DEMO_TARGETS = Object.freeze([
  { name: 'Home', pos: [0.15, 0.75, -0.55], interpolation: 'PointToPoint', speed: 1, wait: 0 },
  { name: 'PickBefore', pos: [0.5, 0.5, -0.6], interpolation: 'PointToPoint', speed: 1, wait: 0 },
  { name: 'Pick', pos: [0.5, 0.3, -0.6], interpolation: 'Linear', speed: 0.5, wait: 0.5 },
  { name: 'PlaceBefore', pos: [-0.2, 0.5, -0.6], interpolation: 'PointToPoint', speed: 1, wait: 0 },
  { name: 'Place', pos: [-0.2, 0.3, -0.6], interpolation: 'Linear', speed: 0.5, wait: 0.5 },
]);

/**
 * Yaw of the tool about the approach axis, degrees. -90 is the one of the four
 * quarter turns that keeps A4 at 0 and A6 small on every target (0 / 180 park A6
 * at 50-130 deg, +90 flips A4 to -180) — an operator's programme, not a solver's.
 */
export const TOOL_YAW_DEG = -90;

// ─── The runtime derivation, imported from TypeScript ────────────────────────

/**
 * `rv-robot-rig.ts` bundled on the fly with esbuild (installed with Vite), so
 * this script runs the browser's derivation and not a transcription of it.
 * `three` stays external and resolves to the same package this script uses.
 */
async function importRobotRig() {
  const esbuild = await import('esbuild');
  const built = await esbuild.build({
    entryPoints: [resolve(ROOT, 'src/core/engine/rv-robot-rig.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['three'],
    write: false,
    logLevel: 'silent',
  });
  const dir = resolve(ROOT, 'node_modules/.cache/rv-scripts');
  await mkdir(dir, { recursive: true });
  const out = resolve(dir, 'rv-robot-rig.bundle.mjs');
  await writeFile(out, built.outputFiles[0].text);
  return import(`${pathToFileURL(out).href}?t=${Date.now()}`);
}

/** The slice of `RVDrive` the derivation reads, over an authored node. */
export function driveView(node) {
  const d = node.userData.realvirtual.Drive;
  return {
    node,
    Direction: d.Direction,
    ReverseDirection: !!d.ReverseDirection,
    UseLimits: !!d.UseLimits,
    LowerLimit: d.LowerLimit,
    UpperLimit: d.UpperLimit,
    // The file is authored AT the home pose, so home == authored local TRS,
    // which is exactly what `RVDrive.initDrive` captures as its base.
    getHomeLocalPosition: (out = new Vector3()) => out.copy(node.position),
    getHomeLocalQuaternion: (out = new Quaternion()) => out.copy(node.quaternion),
  };
}

/** Derive the `RobotIK` block exactly as `ik.robot.rig` would write it. */
export async function deriveRig(file = resolve(ROOT, FILE)) {
  const rig = await importRobotRig();
  const tree = await loadGlbAsThree(file);
  const root = tree.byPath.get(R);
  if (!root) throw new Error(`${FILE}: no root "${R}"`);
  const pathOf = new Map([...tree.byPath].map(([p, n]) => [n, p]));
  const drives = [];
  root.traverse((n) => { if (n.userData?.realvirtual?.Drive) drives.push(driveView(n)); });

  const derivation = rig.deriveSerialAxisChain(root, drives);
  if (derivation.failure) throw new Error(`rig derivation failed: ${derivation.failure}`);
  const chain = rig.chainFromDerivation(root, derivation);
  if (!chain) throw new Error('rig derivation: no joint chain');
  const wrist = rig.measureWristType(rig.chainGeometry(chain));
  const estimate = rig.estimateOpwFromChain(chain);
  const registry = { getPathForNode: (n) => pathOf.get(n) ?? null };
  const fields = rig.buildRobotIkRigFields(registry, derivation, estimate, wrist);
  if ('error' in fields) throw new Error(`rig fields: ${fields.error}`);
  return { fields, wrist, estimate, chain, tcpReason: derivation.tcpReason };
}

// ─── The demo path ───────────────────────────────────────────────────────────

/** Solve the demo targets; returns per target the AxisPos and the TCP pose. */
export async function solveDemoPath() {
  const chain = await readChain();
  const tcp = chain.tree.byPath.get(`${R}/A1/A2/A3/A4/A5/A6/TCP`);
  const chainTcp = { ...chain, a6ToGripper: new Matrix4().compose(tcp.position, tcp.quaternion, new Vector3(1, 1, 1)) };
  const quat = toolQuat(TOOL_YAW_DEG);
  let from = null;
  const out = [];
  for (const t of DEMO_TARGETS) {
    const r = solveRobust(chain, new Vector3(...t.pos), quat, t.name, from);
    from = r.q;
    const m = fk(chainTcp, r.q);
    const p = new Vector3(); const q = new Quaternion(); const s = new Vector3();
    m.decompose(p, q, s);
    out.push({ ...t, axisPos: r.q, posErrMm: r.posErrMm, rotErrDeg: r.rotErrDeg, tcpPos: p, tcpQuat: q });
  }
  return out;
}

const r6 = (x) => +x.toFixed(6);

function ikTargetExtras(t) {
  return {
    _fullTypeName: 'realvirtual.IKTarget',
    _version: 2,
    _enabled: true,
    FollowInEditMode: true,
    SpeedToTarget: t.speed,
    LinearAcceleration: 200,
    InterpolationToTarget: t.interpolation,
    LinearSpeedToTarget: 200,
    TurnCorrection: false,
    SetSignalDuration: 0.5,
    WaitForSeconds: t.wait,
    PickAndPlace: false,
    Pick: false,
    Place: false,
    EnableBlending: false,
    BlendRadius: 25,
    AxisPos: t.axisPos,
  };
}

/** Apply rig + path + Erratic removal to the JSON chunk. Returns a log. */
export function applyRobotIk(json, rig, targets) {
  const log = [];
  const at = (path) => {
    const i = findByPath(json, path);
    if (i === null) throw new Error(`${FILE}: no node at "${path}"`);
    return i;
  };
  const rvOf = (idx) => {
    const n = json.nodes[idx];
    n.extras ??= {};
    n.extras.realvirtual ??= {};
    return n.extras.realvirtual;
  };

  let path = R;
  for (const a of AXES) {
    path += `/${a}`;
    const rv = rvOf(at(path));
    if (rv.Drive_ErraticPosition) { delete rv.Drive_ErraticPosition; log.push(`${path}: Drive_ErraticPosition removed`); }
  }

  const rootRv = rvOf(at(R));
  rootRv.RobotIK = { _fullTypeName: 'realvirtual.RobotIK', _version: 2, _enabled: true, ...rig.fields };
  log.push(`${R}: RobotIK ${rig.fields.WristType}, TCP ${rig.fields.TCP ?? '(flange)'}`);

  const group = createGroup(json, R, PATH_NODE);
  const pathIdx = group.nodeIndex;
  const refs = [];
  for (const t of targets) {
    const { nodeIndex } = createGroup(json, `${R}/${PATH_NODE}`, t.name);
    const n = json.nodes[nodeIndex];
    n.translation = [r6(t.tcpPos.x), r6(t.tcpPos.y), r6(t.tcpPos.z)];
    n.rotation = [r6(t.tcpQuat.x), r6(t.tcpQuat.y), r6(t.tcpQuat.z), r6(t.tcpQuat.w)];
    rvOf(nodeIndex).IKTarget = ikTargetExtras(t);
    refs.push({ type: 'ComponentReference', path: `${R}/${PATH_NODE}/${t.name}`, componentType: 'realvirtual.IKTarget', componentIndex: 0 });
    log.push(`${R}/${PATH_NODE}/${t.name}: AxisPos ${JSON.stringify(t.axisPos)}`);
  }
  rvOf(pathIdx).IKPath = {
    _fullTypeName: 'realvirtual.IKPath',
    _version: 2,
    _enabled: true,
    SpeedOverride: 1,
    SetNewTCP: false,
    DrawPath: true,
    DrawTargets: true,
    DebugPath: false,
    DebugBlending: false,
    StartPath: false,
    LoopPath: true,
    Path: refs,
  };
  log.push(`${R}/${PATH_NODE}: IKPath, ${refs.length} targets, StartPath false, LoopPath true`);

  // The document description named the erratic demo motion — say what it has now.
  const info = json.scenes?.[0]?.extras?.realvirtual?.DocumentInfo;
  if (info && typeof info.description === 'string') {
    info.description = info.description.replace(
      /Some drives carry `Drive_ErraticPosition` for a demo motion and the gripper/,
      'A `RobotIK` rig and a demo `IKPath` *Robotpath* (Home, Pick, Place — switch it on with `StartPath`) make it a ready inverse-kinematics robot, and the gripper',
    );
    info.updatedAt = new Date().toISOString();
  }
  return log;
}

async function main() {
  const args = process.argv.slice(2);
  const file = resolve(ROOT, FILE);
  const rig = await deriveRig(file);
  console.log(`[author-robot-ik] ${FILE}`);
  console.log(`  RobotIK  WristType ${rig.fields.WristType} (${rig.wrist.evidence})`);
  console.log(`           confidence ${rig.estimate.confidence}, TCP ${rig.fields.TCP} (${rig.tcpReason})`);
  console.log(`           a1 ${rig.fields.a1} a2 ${rig.fields.a2} b ${rig.fields.b} c1 ${rig.fields.c1} c2 ${rig.fields.c2} c3 ${rig.fields.c3} c4 ${rig.fields.c4}`);
  const targets = await solveDemoPath();
  for (const t of targets) {
    console.log(`  ${t.name.padEnd(12)} q ${JSON.stringify(t.axisPos)}  err ${t.posErrMm.toFixed(4)} mm / ${t.rotErrDeg.toFixed(4)} deg`);
  }
  if (args.includes('--check')) { console.log('  --check: nothing written'); return; }

  const { json, rest } = readGlb(await readFile(file));
  const log = applyRobotIk(json, rig, targets);
  await writeFile(file, writeGlb(json, rest));
  for (const line of log) console.log(`  ~ ${line}`);
  console.log(`  wrote ${FILE}`);
  if (!args.includes('--no-catalog')) {
    execFileSync(process.execPath, [resolve(HERE, 'build-local-library-catalog.mjs')], { stdio: 'inherit' });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
