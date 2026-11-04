// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
/**
 * Rewrites the path network of scenes/AGVFactory.glb as a smooth course.
 *
 * Every junction is tangent-continuous: the main oval is two straights plus
 * two R=4 m half circles, and every station spur (WS1, WS2, WS3, Load) leaves
 * and rejoins the oval through an S-curve of two opposite arcs. Docks and the
 * load queue stay straight so a stopped vehicle stands square to its station.
 *
 * The path graph and the fleet are rebuilt from this file on every run
 * (idempotent): long oval paths are split into <= 2.5 m pieces (no longer
 * required since the plan-558 moving block, kept harmless); every merge is a
 * capacity-1 zone over the merging pieces and the successor; the
 * junction and station ids the work plan in plugins/agv-factory.ts addresses
 * are kept. AGV_1 is the template for AGV_COUNT vehicles spread around the
 * oval. Station boxes sit beside the docks. The project.json entry is updated.
 * The path DSL (segments, splitting, merge zones, clone) lives in
 * lib/path-dsl.mjs, shared with tools/pallet-yard.mjs (plan-612).
 *
 * Run from the WebViewer checkout (it provides @gltf-transform):
 *   AGV_COUNT=8 node <this file> [path/to/AGVFactory.glb]
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { updateDocumentRow } from '../../scripts/lib/rv-project-json.mjs';
import {
  applyMergeZones, arc, buildGraph, cloneNode, line as dslLine, pathExtras, sCurve as dslSCurve, v3,
} from '../../src/plugins/models/PalletYard/path-dsl.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const glbPath = path.resolve(process.argv[2] ?? path.join(here, '..', '..', 'public', 'demo-realvirtual', 'AGVFactory.glb'));
const require = createRequire(path.join(process.cwd(), 'package.json'));
const { NodeIO } = await import(pathToFileURL(require.resolve('@gltf-transform/core')).href);

// ── Layout parameters (meters) ──────────────────────────────────────────────
const X_END = 11;        // straights run from -X_END to +X_END
const Z_MAIN = 4;        // oval half width = end-curve radius
const OFFSET = 2.5;      // lateral offset of a spur from the oval
const S_LEN = 3;         // longitudinal length of one S-curve
const DOCK = 2;          // straight dock length at a station

const line = dslLine;
/** S-curve with this layout's offset and length (see lib/path-dsl.mjs). */
const sCurve = (x0, z0, hx, sz) => dslSCurve(x0, z0, hx, sz, { sLen: S_LEN, offset: OFFSET });

// ── Course ──────────────────────────────────────────────────────────────────
const zS = -Z_MAIN, zN = Z_MAIN;
const zSD = zS - OFFSET, zND = zN + OFFSET; // dock lanes

// South straight, travel +X; spurs to the south (-Z).
const ws1In = -9, ws2In = 1;
// North straight, travel -X; spurs to the north (+Z).
const loadIn = 9, ws3In = -3;

const PATHS = {
  SouthA:    [line(-X_END, zS, ws1In, zS)],
  WS1In:     sCurve(ws1In, zS, +1, -1),
  WS1:       [line(ws1In + S_LEN, zSD, ws1In + S_LEN + DOCK, zSD)],
  WS1Out:    sCurve(ws1In + S_LEN + DOCK, zSD, +1, +1),
  SouthB:    [line(ws1In, zS, ws1In + 2 * S_LEN + DOCK, zS)],
  SouthC:    [line(ws1In + 2 * S_LEN + DOCK, zS, ws2In, zS)],
  WS2In:     sCurve(ws2In, zS, +1, -1),
  WS2:       [line(ws2In + S_LEN, zSD, ws2In + S_LEN + DOCK, zSD)],
  WS2Out:    sCurve(ws2In + S_LEN + DOCK, zSD, +1, +1),
  SouthD:    [line(ws2In, zS, ws2In + 2 * S_LEN + DOCK, zS)],
  SouthE:    [line(ws2In + 2 * S_LEN + DOCK, zS, X_END, zS)],
  East:      [arc(X_END, 0, Z_MAIN, -90, 180)],
  NorthA:    [line(X_END, zN, loadIn, zN)],
  LoadIn:    sCurve(loadIn, zN, -1, +1),
  LoadQueue: [line(loadIn - S_LEN, zND, loadIn - S_LEN - DOCK, zND)],
  Load:      [line(loadIn - S_LEN - DOCK, zND, loadIn - S_LEN - 2 * DOCK, zND)],
  LoadOut:   sCurve(loadIn - S_LEN - 2 * DOCK, zND, -1, -1),
  NorthB:    [line(loadIn, zN, loadIn - 2 * S_LEN - 2 * DOCK, zN)],
  NorthC:    [line(loadIn - 2 * S_LEN - 2 * DOCK, zN, ws3In, zN)],
  WS3In:     sCurve(ws3In, zN, -1, +1),
  WS3:       [line(ws3In - S_LEN, zND, ws3In - S_LEN - DOCK, zND)],
  WS3Out:    sCurve(ws3In - S_LEN - DOCK, zND, -1, -1),
  NorthD:    [line(ws3In, zN, -X_END, zN)],
  West:      [arc(-X_END, 0, Z_MAIN, 90, 180)],
};

// Station boxes beside their docks (1.5 m behind the dock lane).
const STATIONS = {
  WorkStation1:       v3(ws1In + S_LEN + DOCK / 2, zSD - 1.5),
  WorkStation2:       v3(ws2In + S_LEN + DOCK / 2, zSD - 1.5),
  WorkStation3:       v3(ws3In - S_LEN - DOCK / 2, zND + 1.5),
  LoadingStation:     v3(loadIn - S_LEN - 1.5 * DOCK, zND + 1.5),
  LoadingStation_Rack: v3(loadIn - S_LEN - DOCK / 2 + 0.5, zND + 1.7),
};

// Junction graph: successors of every path (first entry = straight on).
const SUCCESSORS = {
  SouthA: ['SouthB', 'WS1In'], WS1In: ['WS1'], WS1: ['WS1Out'], WS1Out: ['SouthC'],
  SouthB: ['SouthC'], SouthC: ['SouthD', 'WS2In'], WS2In: ['WS2'], WS2: ['WS2Out'],
  WS2Out: ['SouthE'], SouthD: ['SouthE'], SouthE: ['East'], East: ['NorthA'],
  NorthA: ['NorthB', 'LoadIn'], LoadIn: ['LoadQueue'], LoadQueue: ['Load'], Load: ['LoadOut'],
  LoadOut: ['NorthC'], NorthB: ['NorthC'], NorthC: ['NorthD', 'WS3In'], WS3In: ['WS3'],
  WS3: ['WS3Out'], WS3Out: ['West'], NorthD: ['West'], West: ['SouthA'],
};

// ── Segment splitting ───────────────────────────────────────────────────────
// The DES kernel holds ONE vehicle per path segment, so a 10 m straight is a
// single slot and a queue advances in 10 m jumps. Long oval paths are split
// into pieces of at most MAX_PIECE; the first piece keeps the original id (the
// work plan and the junctions address it), the rest are `<id>_2`, `<id>_3`, …
// Docks, the load queue and the S-curves stay whole.
const MAX_PIECE = 2.5;
const KEEP_WHOLE = /^(WS\d|Load)/;

const { graph: GRAPH, order: OVAL_ORDER } = buildGraph(PATHS, SUCCESSORS, { maxPiece: MAX_PIECE, keepWhole: KEEP_WHOLE });

// Oval pieces in the order a vehicle drives them (south +X, east, north -X, west).
const DRIVE_ORDER = ['SouthA', 'SouthB', 'SouthC', 'SouthD', 'SouthE', 'East', 'NorthA', 'NorthB', 'NorthC', 'NorthD', 'West']
  .flatMap((id) => OVAL_ORDER.filter((p) => p === id || p.startsWith(`${id}_`)));

// ── Merge zones ─────────────────────────────────────────────────────────────
// Where two paths join, two vehicles arrive at an angle and neither sees the
// other: the segment-occupancy rule only guards the path AFTER the merge, so the
// second vehicle stopped ON the merge point while the first was still pulling
// away — the bodies overlapped. One reservation zone (capacity 1) per merge
// covers the last piece of every incoming path plus the first outgoing piece;
// the second vehicle now waits at the zone entrance, one piece before the merge.
const MERGES = {
  SouthC: ['SouthB', 'WS1Out'],
  SouthE: ['SouthD', 'WS2Out'],
  NorthC: ['NorthB', 'LoadOut'],
  West:   ['NorthD', 'WS3Out'],
};
applyMergeZones(GRAPH, MERGES);

// ── Fleet ───────────────────────────────────────────────────────────────────
const AGV_COUNT = Number(process.env.AGV_COUNT ?? 8);
const AGV_SPEED = 1000; // mm/s

// ── Rewrite ─────────────────────────────────────────────────────────────────
const io = new NodeIO();
const doc = await io.read(glbPath);
const root = doc.getRoot();
const scene = root.listScenes()[0];
const nodes = root.listNodes();
const course = nodes.find((n) => n.getName() === 'Course');
if (!course) throw new Error('Course node not found');

// Paths: drop every old path node, build the graph fresh.
for (const n of course.listChildren()) if (n.getExtras()?.realvirtual?.Path) n.dispose();
for (const p of GRAPH) {
  course.addChild(doc.createNode(p.id).setExtras({ realvirtual: pathExtras(p) }));
}

// Stations.
for (const n of nodes) if (STATIONS[n.getName()]) n.setTranslation(STATIONS[n.getName()]);

// Fleet: AGV_1 is the template; every other AGV_* is rebuilt from it.
const template = scene.listChildren().find((n) => n.getName() === 'AGV_1');
if (!template) throw new Error('AGV_1 template not found');
for (const n of scene.listChildren()) if (/^AGV_\d+$/.test(n.getName()) && n !== template) {
  for (const c of n.listChildren()) c.dispose();
  n.dispose();
}
const clone = (src, name) => cloneNode(doc, src, name);
const stride = DRIVE_ORDER.length / AGV_COUNT;
for (let i = 0; i < AGV_COUNT; i++) {
  const agv = i === 0 ? template : clone(template, `AGV_${i + 1}`);
  if (i > 0) scene.addChild(agv);
  const extras = agv.getExtras();
  // plan-558 distance control, explicit (equal to the schema defaults): the
  // body comes from the AGV mesh (VehicleLength / VehicleWidth = 0), the start
  // keeps it on its own piece.
  extras.realvirtual.Agv = {
    PathId: DRIVE_ORDER[Math.floor(i * stride)], StartPosition: 600, TargetSpeed: AGV_SPEED,
    Acceleration: 500, Deceleration: 500, LateralAcceleration: 500, SafetyGap: 300,
    DockingSpeed: 300, DockingDistance: 500, VehicleLength: 0, VehicleWidth: 0,
    ScannerFields: true, ScannerReactionTime: 0.2, ProtectiveMargin: 200, WarningMargin: 1000,
  };
  agv.setExtras(extras);
}

await io.write(glbPath, doc);
console.log(`${GRAPH.length} paths (${DRIVE_ORDER.length} oval pieces), ${AGV_COUNT} AGVs -> ${glbPath}`);

// Keep the project manifest in step with the rewritten document.
// plan-587 F6: the shared updater parses the manifest; this caller selects its
// row BY PATH (relative to the manifest), rounds `mtimeMs` with `Math.round`,
// stamps `modifiedAt`, KEEPS its `scriptRef` (the row legitimately binds a
// model plugin) and stays silent when the row is absent — all named here
// rather than unified away.
const manifestPath = path.join(here, '..', '..', 'public', 'demo-realvirtual', 'project.json');
const rel = path.relative(path.dirname(manifestPath), glbPath).split(path.sep).join('/');
const updated = updateDocumentRow(manifestPath, { path: rel }, {
  glbPath,
  mtimeRounding: 'round',
  setModifiedAt: true,
  ifMissing: 'ignore',
  trailingNewline: 'none',
});
if (updated) console.log(`project.json: updated ${rel}`);
