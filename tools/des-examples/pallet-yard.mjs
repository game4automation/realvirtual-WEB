// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Builds public/demo-realvirtual/PalletYard.glb from composeYard(size), the one source of geometry,
 * placements and project configuration. PalletYardRoot carries the config + Size.
 * Module/end caps/markings, conveyors and stackers are bundled-library placements;
 * sources, scanners and sinks are placements too. Reference poses compensate
 * library root translations and rotations while retaining the library root scale.
 * The path graph is a path NETWORK of blocks (plan-628 8.6): a top-level
 * `PathNetwork` node (a direct child of the model root, ahead of PalletYardRoot)
 * holds one `PN_Block_<n>` node per `composeYardBlocks()` block (rv_extras
 * PathBlock) with its Path nodes as children. Generated path, block and slot
 * nodes carry Generated.owner = 'palletYard': composition owns them, so the
 * path-network ops refuse to write them ('composition-owned'). The PathNetwork
 * container is not marked — author blocks may live next to the generated ones.
 * Floor slots retain BakeRole merge so they survive a bake before plugin loading.
 *
 * Deterministic bytes; write the GLB and update its project.json row only on change.
 * A rerun KEEPS what the document says about itself and the generator does not make:
 * the planning scenarios (`scenes[0].extras.realvirtual.PlanningScenarios`, plan-630
 * Phase 3) are copied from the existing file into the new one — otherwise every scene
 * regeneration would delete the scenarios a planner saved.
 * Run the pallet-yard-modules.mjs generator first to populate the bundled library.
 * Run (Node >= 22.18):
 *   node tools/des-examples/pallet-yard.mjs [--size <1..16>] [out.glb] [project.json]
 */

import { deepStrictEqual, strictEqual } from 'node:assert';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  findDocumentRow, updateDocumentRow,
} from '../../scripts/lib/rv-project-json.mjs';
import { pathExtras, round, specLength } from '../../src/plugins/models/PalletYard/path-dsl.mjs';
import {
  CONVEYOR_LENGTH_M, CONVEYOR_OUT_LENGTH_M, CONVEYOR_SURFACE_M,
  FORK_SEAT_OFFSET_M, FORK_TOP_HOME_MM, SINK_BEHIND_END_M,
  agvConfigOf, conveyorNodeOf, conveyorZOf, headSeatOf, handlingPose, straightOf,
} from '../../src/plugins/models/PalletYard/layout.ts';
import { composeYard, composeYardBlocks, generatedMarker, pathBlockExtras, withDowntimes, downtimeComponents, DOWNTIME_OWNER, NO_AGV_DOWNTIME, YARD_ASSETS, SIZE_MIN, SIZE_MAX } from '../../src/plugins/models/PalletYard/yard-compose.ts';


export { buildPathGraph } from '../../src/plugins/models/PalletYard/layout.ts';

function validateSize(size) {
  if (!Number.isInteger(size) || size < SIZE_MIN || size > SIZE_MAX) {
    throw new RangeError(`--size: expected integer ${SIZE_MIN}..${SIZE_MAX}, got ${size}`);
  }
  return size;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const WV_ROOT = path.resolve(here, '../..');
export const LIBRARY_DIR = path.join(WV_ROOT, 'public', 'library');
export const DEFAULT_GLB = path.resolve(here, '..', '..', 'public', 'demo-realvirtual', 'PalletYard.glb');
export const DEFAULT_MANIFEST = path.resolve(here, '..', '..', 'public', 'demo-realvirtual', 'project.json');
/** glTF scene name = the file stem. The loader turns the glTF scene into the
 *  model root under this name and dedups node names file-wide against it. */
export const SCENE_NAME = 'PalletYard';
/** Scene root node. Deliberately NOT the scene name / file stem: an equal root
 *  node would load as `PalletYard_1` and an editor save would write that loader
 *  name back as authored (finding #188, Welding `Lift01_1`). */
export const ROOT_NAME = 'PalletYardRoot';
/** Top-level node of the generated path network (the WebViewer's `PATH_NETWORK_NODE`). */
export const PATH_NETWORK_NAME = 'PathNetwork';
/** Display name of the project.json row (the document, not a node). */
export const DOCUMENT_NAME = 'PalletYard';
export const SCRIPT_REF = ''; // Public model plugin binds by the PalletYard filename.
export const DOCUMENT_ID = 'doc_palletyard_hzmdb6';
/** NodeId of PalletYardRoot: the address (`#<id>`) the demo variants name their fields by. */
export const ROOT_NODE_ID = 'palletyard-root';

/**
 * AGV breakdowns of the demo document (Base): every stacker fails on average once
 * per hour of operation and is repaired in ten minutes on average, both drawn
 * exponentially from the seeded RNG. Availability 3600 / 4200 = 86 %, about seven
 * breakdowns per AGV in an 8 h shift: visible in the KPIs, not crippling.
 */
export const DEMO_AGV_DOWNTIME = Object.freeze({ mtbf: 3600, mttr: 600, stochastic: true });

/**
 * The demo experiment (`scenes[0].extras.realvirtual.Variants`): Base = the
 * document (3 AGVs with breakdowns); three variants change one thing each, so
 * every column of the Experiments panel compares against Base on one axis.
 */
export const DEMO_VARIANTS = Object.freeze({
  version: 1,
  active: null,
  baseDescription: 'Three AGVs; each breaks down about once an hour (MTBF 3600 s) for about ten minutes (MTTR 600 s, random).',
  variants: [
    { id: 'palletyard-2-agvs', name: '2 AGVs', revision: 1,
      description: 'One AGV less, same breakdowns: how much throughput does the third vehicle buy?',
      overrides: [{ address: '#' + ROOT_NODE_ID, component: 'PalletYard', field: 'VehicleCount', value: 2 }] },
    { id: 'palletyard-4-agvs', name: '4 AGVs', revision: 1,
      description: 'One AGV more, same breakdowns. The vehicles start to block each other on the one-way network, so more is not better here.',
      overrides: [{ address: '#' + ROOT_NODE_ID, component: 'PalletYard', field: 'VehicleCount', value: 4 }] },
    { id: 'palletyard-no-downtime', name: 'No downtime', revision: 1,
      description: 'Three AGVs that never break down: the upper bound, and what the breakdowns cost.',
      overrides: [{ address: '#' + ROOT_NODE_ID, component: 'PalletYard', field: 'AgvMtbf', value: 0 }] },
  ],
});

/** NodeId of the ShippingMonitor script node: the authored id the DES registers its address by. */
export const SHIPPING_MONITOR_NODE_ID = 'pallet-yard-ShippingMonitor';
/** Target shipping takt of the demo in seconds (the doc example reads the same number). */
export const SHIPPING_TARGET_TAKT_S = 60;

/**
 * Teaching example (docs: doc-experiment-manager.md, "Your own KPI"): a Model-Script that only
 * OBSERVES the two shipping sinks and publishes two experiment KPIs. It never changes the yard.
 * - Subscriptions are made in setup() only (the DES restarts the script for every replication).
 * - Sinks are addressed by their placement names (Sink_V1/Sink_V2).
 * - All state lives in self.persist, so snapshots and continuation restore it.
 * - A shipment is late when the gap since the previous one exceeds twice the target takt.
 */
export const SHIPPING_MONITOR_CODE = `// ShippingMonitor - teaching example: counts late shipments of the PalletYard.
// Observes both shipping sinks; changes nothing in the model.
function setup(self) {
  // All state in self.persist: snapshots and continuation restore it.
  const st = self.persist({ last: null, late: 0, longest: 0 });
  // Publish initial values so the KPI picker finds both rows.
  self.statValue('Late shipments', 0);
  self.statValue('Longest shipping gap', 0, 's');
  function onShipment() {
    const targetTakt = ${SHIPPING_TARGET_TAKT_S}; // seconds between shipments we aim for
    if (st.last !== null) {
      const gap = self.now - st.last;
      if (gap > 2 * targetTakt) st.late++;
      st.longest = Math.max(st.longest, gap);
      self.statValue('Late shipments', st.late);
      self.statValue('Longest shipping gap', st.longest, 's');
    }
    st.last = self.now;
  }
  // Subscribe in setup() only, by placement name. Outside a DES run there is no sink to hear: stay idle.
  const sinkV1 = self.sink('Sink_V1');
  if (sinkV1) sinkV1.on(onShipment);
  const sinkV2 = self.sink('Sink_V2');
  if (sinkV2) sinkV2.on(onShipment);
  return {};
}
`;

const requireWV = createRequire(path.join(WV_ROOT, 'package.json'));
const importWV = async (spec) => import(pathToFileURL(requireWV.resolve(spec)).href);

// The lane graph (split zones, junctions, stiches) lives in layout.ts — the
// plugin and the tests build the same graph from it.

/** Point + unit tangent (x, z) at arc length `s` of one segment spec. */
function pointOn(spec, s) {
  if (spec.kind === 'line') {
    const L = specLength(spec);
    const tx = (spec.to[0] - spec.from[0]) / L, tz = (spec.to[2] - spec.from[2]) / L;
    return { x: spec.from[0] + tx * s, z: spec.from[2] + tz * s, tx, tz };
  }
  const sign = Math.sign(spec.degrees);
  const a = (spec.startAngle * Math.PI) / 180 + sign * (s / spec.radius);
  return {
    x: spec.center[0] + spec.radius * Math.cos(a), z: spec.center[2] + spec.radius * Math.sin(a),
    tx: -sign * Math.sin(a), tz: sign * Math.cos(a),
  };
}

// ── glTF helpers ────────────────────────────────────────────────────────────

/** Rotation about +Y that turns local +Z onto the heading (tx, tz). */
const headingQuat = (tx, tz) => {
  const th = Math.atan2(tx, tz);
  return [0, round(Math.sin(th / 2)), 0, round(Math.cos(th / 2))];
};

/** The single top-level node of a library GLB (the asset root a placement keeps as a child). */
async function libraryRoot(io, libPath) {
  const file = path.join(LIBRARY_DIR, ...libPath.replace(/^\/library\//, '').split('/'));
  const src = await io.read(file);
  const roots = src.getRoot().listScenes()[0].listChildren();
  if (roots.length !== 1) throw new Error(`${libPath}: expected one root node, got ${roots.length}`);
  return roots[0];
}

/** Offset of `ForkAnchor` from the PLACEMENT root (the asset scene origin) — the asset root's own transform included. */
function forkAnchorOffset(stackerRoot) {
  const find = (n) => (n.getName() === 'ForkAnchor' ? n : n.listChildren().map(find).find(Boolean));
  const fa = find(stackerRoot);
  if (!fa) throw new Error('AGVStacker: ForkAnchor missing — rebuild the library model');
  const m = fa.getWorldMatrix();
  return [m[12], m[13], m[14]];
}

/** Hamilton product a·b of two quaternions (x, y, z, w). */
const qMul = ([ax, ay, az, aw], [bx, by, bz, bw]) => [
  aw * bx + ax * bw + ay * bz - az * by,
  aw * by - ax * bz + ay * bw + az * bx,
  aw * bz + ax * by - ay * bx + az * bw,
  aw * bw - ax * bx - ay * by - az * bz,
];
/** v rotated by the unit quaternion q = (x, y, z, w): v' = v + w·c + q×c, c = 2·(q×v). */
function qRotate([qx, qy, qz, qw], t) {
  const cx = 2 * (qy * t[2] - qz * t[1]), cy = 2 * (qz * t[0] - qx * t[2]), cz = 2 * (qx * t[1] - qy * t[0]);
  return [t[0] + qw * cx + (qy * cz - qz * cy), t[1] + qw * cy + (qz * cx - qx * cz), t[2] + qw * cz + (qx * cy - qy * cx)];
}
const isIdentityQuat = (q) => Math.abs(q[0]) + Math.abs(q[1]) + Math.abs(q[2]) <= 1e-9 && Math.abs(Math.abs(q[3]) - 1) <= 1e-9;

/**
 * Pose of a reference node so the asset content stands where an embedded
 * clone with root pose (`at`, `rot`) stood (the clone's root got translation
 * `at`, rotation `rot` and KEPT its own scale): the placement keeps the asset
 * root as a CHILD with its own transform (t, R, S — no PlacementMeta → no pivot),
 * so the reference rotation is rot·R⁻¹ and its translation at − (rot·R⁻¹)·t.
 * The root's own scale stays on the root (it scales only the root's children),
 * exactly as on the embedded clone. With R = identity the rotation is `rot`
 * itself (bit-identical to the translation-only form of CP1d-b).
 */
export function compensatedPose(assetRoot, at, rot) {
  const r = assetRoot.getRotation();
  const q = isIdentityQuat(r) ? [...rot] : qMul(rot, [-r[0], -r[1], -r[2], r[3]]).map(round);
  const t = qRotate(q, assetRoot.getTranslation());
  return { translation: [round(at[0] - t[0]), round(at[1] - t[1]), round(at[2] - t[2])], rotation: q };
}

/** Translation half of {@link compensatedPose} (kept for callers of the CP1d-b form). */
export function compensatedTranslation(assetRoot, at, rot) {
  return compensatedPose(assetRoot, at, rot).translation;
}

/** The `rv_extras.PathBlock` payload of one composed block — shared with the runtime rebuild (yard-compose.ts). */
export { pathBlockExtras };

/** Scene-extras keys a rerun copies from the existing file (authored in the viewer, not generated). */
export const PRESERVED_SCENE_KEYS = ['PlanningScenarios', 'Variants'];

/**
 * The preserved scene-extras blocks of an existing GLB (`{}` when there is no file, no
 * block, or the file is not a readable GLB). Reads only the JSON chunk.
 */
export function readPreservedSceneExtras(glbPath) {
  if (!existsSync(glbPath)) return {};
  try {
    const buf = readFileSync(glbPath);
    if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) return {};
    const jsonLength = buf.readUInt32LE(12);
    if (buf.readUInt32LE(16) !== 0x4e4f534a) return {};
    const json = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8'));
    const rv = json.scenes?.[json.scene ?? 0]?.extras?.realvirtual;
    const out = {};
    if (rv && typeof rv === 'object') {
      for (const key of PRESERVED_SCENE_KEYS) if (rv[key] !== undefined) out[key] = rv[key];
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Build the PalletYard document in memory. `preserved` = scene-extras blocks to carry
 * over (a preserved `Variants` block wins over the generated demo one). The default
 * size-2 document is the demo: 3 AGVs with {@link DEMO_AGV_DOWNTIME} and the
 * {@link DEMO_VARIANTS} experiment; `demo: false` builds the bare yard.
 */
export async function buildPalletYardDocument({ preserved = {}, size = 2, demo = size === 2 } = {}) {
  const downtime = demo ? DEMO_AGV_DOWNTIME : NO_AGV_DOWNTIME;
  const YARD = withDowntimes(composeYard(validateSize(size)), downtime);
  const { Document, NodeIO } = await importWV('@gltf-transform/core');
  const { ALL_EXTENSIONS } = await importWV('@gltf-transform/extensions');
  const { unpartition } = await importWV('@gltf-transform/functions');
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = new Document();
  const scene = doc.createScene(SCENE_NAME);
  doc.getRoot().setDefaultScene(scene);
  const sceneExtras = { ...(demo ? { Variants: structuredClone(DEMO_VARIANTS) } : {}), ...preserved };
  if (Object.keys(sceneExtras).length > 0) scene.setExtras({ realvirtual: structuredClone(sceneExtras) });
  // Paths: PathNetwork → PN_Block_<n> (PathBlock) → Path nodes, all from composeYard(size).
  const graph = YARD.pathGraph;
  const network = doc.createNode(PATH_NETWORK_NAME);
  scene.addChild(network);
  for (const b of composeYardBlocks(YARD)) {
    const block = doc.createNode(b.id).setExtras({ realvirtual: { PathBlock: pathBlockExtras(b), Generated: generatedMarker() } });
    network.addChild(block);
    for (const id of b.paths) {
      const p = graph.find((q) => q.id === id);
      block.addChild(doc.createNode(p.id).setExtras({ realvirtual: { ...pathExtras(p), Generated: generatedMarker() } }));
    }
  }

  const downtimeFields = demo
    ? { AgvMtbf: downtime.mtbf, AgvMttr: downtime.mttr, AgvDowntimeStochastic: downtime.stochastic }
    : {};
  const root = doc.createNode(ROOT_NAME).setExtras({ realvirtual: {
    ...(demo ? { NodeId: ROOT_NODE_ID } : {}),
    PalletYard: { ...structuredClone(YARD.config), Size: YARD.size, ...downtimeFields },
  } });
  scene.addChild(root);
  const geomOf = (id) => YARD.geometry.find((g) => g.id === id);

  const assetRoots = new Map();
  for (const [asset, ref] of Object.entries(YARD_ASSETS)) {
    assetRoots.set(asset, await libraryRoot(io, ref.path));
  }
  // A placement: an empty reference node (NodeId + AssetReference + own extras),
  // positioned so the asset content stands at (at, rot) — see compensatedPose.
  const reference = (name, lib, assetRoot, at, rot, extras = {}) => {
    const pose = compensatedPose(assetRoot, at, rot);
    const n = doc.createNode(name)
      .setTranslation(pose.translation).setRotation(pose.rotation)
      .setExtras({ realvirtual: {
        NodeId: `pallet-yard-${name}`,
        AssetReference: { assetId: lib.assetId, path: lib.path.replace(/^\//, '') },
        ...extras,
      } });
    root.addChild(n);
    return n;
  };
  const stacker = assetRoots.get('AGVStacker');
  const fa = forkAnchorOffset(stacker);
  if (Math.abs(-fa[2] - FORK_SEAT_OFFSET_M) > 5e-4 || Math.abs(fa[1] * 1000 - FORK_TOP_HOME_MM) > 0.5 || Math.abs(fa[0]) > 5e-4) {
    throw new Error('AGVStacker ForkAnchor ' + fa + ' does not match layout.ts');
  }
  const group = (p) => p.asset === 'AGVStacker' ? 1
    : ['YardModule', 'YardEndWest', 'YardEndEast'].includes(p.asset) ? 2
    : ['YardSlotMarking', 'YardChargerStation', 'YardWaitMarking'].includes(p.asset) ? 3 : 0;
  const placements = [0, 1, 2, 3].flatMap(g => YARD.placements.filter(p => group(p) === g));
  const stationIds = YARD.geometry.filter(g => g.kind === 'pick' || g.kind === 'drop').map(g => g.id);
  const legacyOrder = stationIds.flatMap(id => geomOf(id).kind === 'pick'
    ? ['Conveyor_' + id, 'Pallet_' + id]
    : ['Conveyor_' + id, 'Scanner_' + id, 'ConveyorOut_' + id, 'Sink_' + id]);
  deepStrictEqual(placements.filter(p => group(p) < 2).map(p => p.id), [...legacyOrder, ...YARD.vehicles.map(v => v.id)]);
  for (const id of stationIds) {
    const g = geomOf(id);
    const towardLane = straightOf(g.straight).z - handlingPose(g).seat[1];
    if (Math.sign(towardLane) !== (g.kind === 'pick' ? 1 : -1)) throw new Error(id + ': conveyor orientation');
  }
  const pickConveyors = new Set(YARD.geometry.filter(g => g.kind === 'pick').map(g => conveyorNodeOf(g.id)));
  for (const p of placements) {
    const yaw = p.yawDeg * Math.PI / 180;
    let rot = p.yawDeg === 0 ? [0, 0, 0, 1] : [0, round(Math.sin(yaw / 2)), 0, round(Math.cos(yaw / 2))];
    if (p.asset === 'AGVStacker') {
      const v = YARD.vehicles.find(v => v.id === p.id);
      const piece = graph.find(q => q.id === v.startPathId);
      const pt = pointOn(piece.segments[0], 0.6);
      const legacyRot = headingQuat(pt.tx, pt.tz);
      if (rot.some((value, i) => Math.abs(value - legacyRot[i]) > 1e-9)) throw new Error(p.id + ': vehicle yaw changed');
      rot = legacyRot;
      deepStrictEqual(p.position, [round(pt.x), 0, round(pt.z)]);
      if (size === 2) {
        const legacyExtras = { Agv: agvConfigOf(v.id, 600) };
        deepStrictEqual(p.extras, legacyExtras);
        strictEqual(JSON.stringify(p.extras), JSON.stringify(legacyExtras));
      }
    }
    // Guard the legacy embedded poses even when switching an asset to a reference.
    if (['EuropalletLoaded', 'PalletScanner', 'PalletSink'].includes(p.asset)) {
      const g = geomOf(p.id.split('_')[1]);
      const convZ = conveyorZOf(g);
      const expected = p.asset === 'EuropalletLoaded' ? headSeatOf(g)
        : p.asset === 'PalletScanner' ? [g.x, 0, convZ + 0.8]
        : [g.x, CONVEYOR_SURFACE_M + 0.1, convZ + CONVEYOR_LENGTH_M / 2 + CONVEYOR_OUT_LENGTH_M + SINK_BEHIND_END_M];
      deepStrictEqual(p.position, expected.map(round));
      deepStrictEqual(rot, [0, 0, 0, 1]);
      if (p.asset === 'EuropalletLoaded') deepStrictEqual(p.overrides.Source,
        { AutomaticGeneration: false, GenerateMU: false, Interval: 0, ThisObjectAsMU: p.id });
    }
    const assetRoot = assetRoots.get(p.asset);
    const extras = { ...p.extras };
    if (pickConveyors.has(p.id)) extras.BlockageBudget = { MaxIdleSec: 600 };
    if (p.overrides) {
      // In the placement the Source names its own asset root as template (the library
      // value) — the embedded clone's renamed ThisObjectAsMU does not exist there.
      const ov = structuredClone(p.overrides);
      if (ov.Source) delete ov.Source.ThisObjectAsMU;
      extras.AssetOverrides = { byPath: { [assetRoot.getName()]: ov } };
    }
    reference(p.id, p.assetRef, assetRoot, p.position, rot, extras);
  }
  for (const slot of YARD.slots) {
    root.addChild(doc.createNode(slot.node).setTranslation(slot.position)
      .setExtras({ realvirtual: { BakeRole: 'merge', Generated: generatedMarker() } }));
  }
  // AGV breakdowns: one Downtime per stacker, aimed at its DES component path
  // (`<scene>/<root>/<vehicle>`) — the runtime rebuild writes the same nodes.
  for (const d of downtimeComponents(YARD, `${SCENE_NAME}/${ROOT_NAME}`)) {
    root.addChild(doc.createNode(d.name)
      .setExtras({ realvirtual: { Downtime: d.Downtime, Generated: { owner: DOWNTIME_OWNER } } }));
  }

  // Teaching example of a Model-Script KPI (demo only): observes the shipping sinks.
  if (demo) {
    root.addChild(doc.createNode('ShippingMonitor').setExtras({ realvirtual: {
      NodeId: SHIPPING_MONITOR_NODE_ID,
      WebComponent: { Active: true, ApiVersion: 1, Language: 'js', TypeId: 'PalletYardShippingMonitor', Code: SHIPPING_MONITOR_CODE },
    } }));
  }

  // Nothing outside the scene may stay behind (a merged template's stray node — the
  // orphan `LiftRam` of the embedded-stacker era): dispose it, no dead glTF node.
  const inScene = new Set();
  scene.traverse((n) => inScene.add(n));
  for (const n of doc.getRoot().listNodes()) if (!inScene.has(n)) n.dispose();
  await doc.transform(unpartition());
  return { doc, io };
}

/** Build and serialize the scene (deterministic bytes). */
export async function buildPalletYardBytes({ preserved = {}, size = 2 } = {}) {
  const { doc, io } = await buildPalletYardDocument({ preserved, size });
  return io.writeBinary(doc);
}

/** Read a GLB with the WebViewer's gltf-transform (all extensions registered) — for tests. */
export async function readGlb(file) {
  const { NodeIO } = await importWV('@gltf-transform/core');
  const { ALL_EXTENSIONS } = await importWV('@gltf-transform/extensions');
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).read(file);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Insert the manifest row for `rel` when missing (scriptRef + identity), never
 * touch an existing one here. Returns true when the manifest was written.
 */
export function ensureManifestRow(manifestPath, rel) {
  const text = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(text);
  if (findDocumentRow(manifest, { path: rel })) return false;
  manifest.documents = Array.isArray(manifest.documents) ? manifest.documents : [];
  manifest.documents.push({
    id: DOCUMENT_ID, path: rel, name: DOCUMENT_NAME, section: 'library', ...(SCRIPT_REF ? { scriptRef: SCRIPT_REF } : {}),
    createdAt: new Date().toISOString(),
  });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + (text.endsWith('\n') ? '\n' : ''));
  return true;
}

/**
 * Build, then write the GLB only when its bytes changed; keep the manifest row
 * in step. Returns what happened (for the CLI and the tests).
 */
export async function writePalletYard({ glbPath = DEFAULT_GLB, manifestPath = DEFAULT_MANIFEST, size = 2 } = {}) {
  validateSize(size);
  const bytes = await buildPalletYardBytes({ preserved: readPreservedSceneExtras(glbPath), size });
  const hash = sha256(bytes);
  const old = existsSync(glbPath) ? sha256(readFileSync(glbPath)) : null;
  const written = old !== hash;
  if (written) writeFileSync(glbPath, bytes);
  const rel = path.relative(path.dirname(manifestPath), glbPath).split(path.sep).join('/');
  const inserted = ensureManifestRow(manifestPath, rel);
  // updateDocumentRow takes the file's mtime — only when the bytes (and with them the
  // mtime) changed, or for a freshly inserted row, so an unchanged run writes nothing.
  if (written || inserted) {
    updateDocumentRow(manifestPath, { path: rel }, {
      glbPath, mtimeRounding: 'round', setModifiedAt: true, ifMissing: 'throw', trailingNewline: 'preserve',
    });
  }
  return { sha256: hash, sizeBytes: bytes.byteLength, written, inserted, rel };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  let size = 2;
  if (args[0] === '--size') {
    args.shift();
    size = validateSize(Number(args.shift()));
  }
  if (args.length > 2 || args.some(arg => arg.startsWith('--'))) throw new Error('Usage: pallet-yard.mjs [--size <1..16>] [out.glb] [project.json]');
  const glbPath = path.resolve(args[0] ?? DEFAULT_GLB);
  const manifestPath = path.resolve(args[1] ?? DEFAULT_MANIFEST);
  const r = await writePalletYard({ glbPath, manifestPath, size });
  console.log(`${r.written ? 'wrote' : 'unchanged'} ${glbPath} (${r.sizeBytes} B, sha256 ${r.sha256})`
    + `${r.inserted ? ` — project.json row ${r.rel} added` : ''}`);
}
