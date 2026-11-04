// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * audit-asset-overrides — offline GLB audit for plan-753 Phase 0: how many
 * `AssetOverrides.byNodeId` (component-field patches) and
 * `AssetOverrides.trsByNodeId` (moved single parts) do the project scenes
 * carry, and how many of them sit on nodes WITHOUT a component?
 *
 * Why it matters (plan-753 Phase 0, decision 1): once a placement is baked
 * into chunks, a `byNodeId` patch on a plain CAD leaf has no component to land
 * on and is dropped with a warning; a `trsByNodeId` entry forces a chunk split
 * so the moved part keeps its corrected position. The numbers below size both.
 *
 * Reads only the glTF JSON chunk (no three.js): a scene record is a glTF node
 * whose `extras.realvirtual.AssetReference` exists (rv-asset-reference.ts);
 * its sibling `extras.realvirtual.AssetOverrides` holds
 *   byNodeId:    { <nodeId>: { <componentType>: { <field>: value } } }
 *   trsByNodeId: { <nodeId>: { t?: number[], r?: number[], s?: number[] } }
 * (writer: rv-scene-glb-bake.ts, reader: rv-asset-reference.ts).
 *
 * "Without a component" is decided WITHOUT resolving the referenced asset:
 *   - a `byNodeId` entry counts as component-less when its patch object names
 *     no component type at all (empty patch) or only types that are not in
 *     the shipped component-type set below (marker keys, not components);
 *   - a `trsByNodeId` entry counts as component-less when the same scene has
 *     no `byNodeId` patch for that node id (best available proxy — the node's
 *     own extras live in the asset file, which this audit does not open).
 *
 * Usage:
 *   node scripts/audit-asset-overrides.mjs [--json] [--root <dir>]...
 * Default roots: the four private project folders (wmyb, mauser3dhmi, Toray,
 * Development) and `public/`. A missing private root is reported, not fatal.
 *
 * plan-769 (F13/F14): the viewer writes `byAddress` (`#<id>` → patch) only. It still
 * READS `byNodeId` (as `#<id>`) and `byPath` (migrated to its address when it
 * resolves); `trsByNodeId` is no longer applied — a load reports it
 * (`override-transforms-dropped`) and the next save drops it. So the old columns
 * below are what is left to migrate, and `byAddress` is what is already migrated.
 *
 * Exit codes: 0 = audit printed · 2 = no GLB found at all.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readGlb } from './lib/rv-glb.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');
const PRIVATE_PROJECTS = resolve(WEB_ROOT, '..', 'realvirtual-WebViewer-Private~', 'projects');

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const rootArgs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--root' && argv[i + 1]) rootArgs.push(resolve(argv[++i]));
}
const ROOTS = rootArgs.length > 0 ? rootArgs : [
  ...['wmyb', 'mauser3dhmi', 'Toray', 'Development'].map((p) => join(PRIVATE_PROJECTS, p)),
  join(WEB_ROOT, 'public'),
];

/**
 * Component types the viewer ships (rv_extras keys with a registered schema or
 * capability). A `byNodeId` patch naming only keys outside this set is not a
 * component-field patch. Kept as a literal so the audit stays runnable without
 * the TypeScript build.
 */
const COMPONENT_TYPES = new Set([
  'Drive', 'Drive_Cylinder', 'Drive_DestinationMotor', 'Drive_FollowPosition', 'Drive_Gear',
  'Drive_PositionSwitch', 'Drive_SEWMovilink', 'Drive_Simple', 'Drive_Speed', 'Drive_ErraticPosition',
  'TransportSurface', 'Sensor', 'Source', 'Sink', 'MU', 'Grip', 'GripTarget', 'Cam', 'Kinematic',
  'KinematicMechanism', 'KinematicJoint', 'KinematicTarget', 'MechanismBody',
  'Lamp', 'SceneButtonBase', 'SceneButtonMoveable', 'PushButton3D', 'EmergencyButton3D', 'HandleSwitch3D',
  'WebSafetyDoor', 'EnergyChain', 'Chain', 'ChainElement', 'RibbonPath', 'RibbonWinder', 'RibbonRoller',
  'RibbonDancer', 'PhysicsZone', 'CollisionRole', 'TransportStopper', 'MachiningVolume', 'MachiningTool',
  'WebSensor', 'WebDiagnostics', 'WebError', 'WebVisibility', 'CustomRuntimeInstruction', 'RuntimeMetadata',
  'Metadata', 'NodeKnowledge', 'Group', 'IKTarget', 'IKPath', 'RobotIK', 'Path', 'Pipe', 'ResourceTank',
  'Tank', 'Pump', 'ProcessingUnit', 'AASLink', 'CADLink', 'JTData', 'ConnectSignal', 'PlcProgram',
  'LogicStep', 'Splat',
]);

/**
 * Read the JSON chunk of a GLB without a full glTF parse — the shared reader
 * of `scripts/lib/rv-glb.mjs` (plan-587). It checks more than the hand-written
 * version did (container version, both length directions, every chunk length),
 * so a file this audit used to read half-blindly now lands in `errors` with a
 * named reason instead of being counted as a non-scene.
 */
function readGlbJson(bytes) {
  return readGlb(bytes).json;
}

function* walkGlbs(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walkGlbs(full);
    else if (/\.glb$/iu.test(entry)) yield full;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Audit one GLB → one row (or null when it is not a scene: no AssetReference). */
function auditGlb(file) {
  let gltf;
  try { gltf = readGlbJson(readFileSync(file)); } catch (e) { return { file, error: e instanceof Error ? e.message : String(e) }; }
  const nodes = Array.isArray(gltf.nodes) ? gltf.nodes : [];
  const row = {
    file,
    nodes: nodes.length,
    placements: 0,
    placementsWithOverrides: 0,
    byNodeId: 0,
    byNodeIdNoComponent: 0,
    byNodeIdFields: 0,
    trsByNodeId: 0,
    trsByNodeIdNoComponent: 0,
    byPath: 0,
    byAddress: 0,
    componentTypes: new Map(),
  };
  for (const node of nodes) {
    const rv = node?.extras?.realvirtual;
    if (!isObj(rv) || !rv.AssetReference) continue;
    row.placements++;
    const ov = rv.AssetOverrides;
    if (!isObj(ov)) continue;
    const byNodeId = isObj(ov.byNodeId) ? ov.byNodeId : {};
    const trsByNodeId = isObj(ov.trsByNodeId) ? ov.trsByNodeId : {};
    const byPath = isObj(ov.byPath) ? ov.byPath : {};
    const byAddress = isObj(ov.byAddress) ? ov.byAddress : {};
    const nId = Object.keys(byNodeId).length;
    const nTrs = Object.keys(trsByNodeId).length;
    const nPath = Object.keys(byPath).length;
    const nAddr = Object.keys(byAddress).length;
    if (nId + nTrs + nPath + nAddr > 0) row.placementsWithOverrides++;
    row.byNodeId += nId;
    row.trsByNodeId += nTrs;
    row.byPath += nPath;
    row.byAddress += nAddr;
    for (const patch of [...Object.values(byNodeId), ...Object.values(byAddress)]) {
      const types = isObj(patch) ? Object.keys(patch) : [];
      const componentTypes = types.filter((t) => COMPONENT_TYPES.has(t));
      if (componentTypes.length === 0) row.byNodeIdNoComponent++;
      for (const t of types) {
        row.componentTypes.set(t, (row.componentTypes.get(t) ?? 0) + 1);
        const fields = isObj(patch[t]) ? Object.keys(patch[t]).length : 0;
        row.byNodeIdFields += fields;
      }
    }
    for (const nodeId of Object.keys(trsByNodeId)) {
      if (!(nodeId in byNodeId)) row.trsByNodeIdNoComponent++;
    }
  }
  return row.placements > 0 ? row : null;
}

const rows = [];
const errors = [];
const missingRoots = [];
let glbCount = 0;
let nonSceneCount = 0;
for (const root of ROOTS) {
  if (!existsSync(root)) { missingRoots.push(root); continue; }
  for (const file of walkGlbs(root)) {
    glbCount++;
    const r = auditGlb(file);
    if (r === null) { nonSceneCount++; continue; }
    if (r.error) { errors.push(r); continue; }
    rows.push(r);
  }
}

if (glbCount === 0) {
  console.error('no GLB found under: ' + ROOTS.join(', '));
  process.exit(2);
}

const total = rows.reduce((acc, r) => ({
  placements: acc.placements + r.placements,
  placementsWithOverrides: acc.placementsWithOverrides + r.placementsWithOverrides,
  byNodeId: acc.byNodeId + r.byNodeId,
  byNodeIdNoComponent: acc.byNodeIdNoComponent + r.byNodeIdNoComponent,
  byNodeIdFields: acc.byNodeIdFields + r.byNodeIdFields,
  trsByNodeId: acc.trsByNodeId + r.trsByNodeId,
  trsByNodeIdNoComponent: acc.trsByNodeIdNoComponent + r.trsByNodeIdNoComponent,
  byPath: acc.byPath + r.byPath,
  byAddress: acc.byAddress + r.byAddress,
}), { placements: 0, placementsWithOverrides: 0, byNodeId: 0, byNodeIdNoComponent: 0, byNodeIdFields: 0, trsByNodeId: 0, trsByNodeIdNoComponent: 0, byPath: 0, byAddress: 0 });

const typeTotals = new Map();
for (const r of rows) for (const [t, n] of r.componentTypes) typeTotals.set(t, (typeTotals.get(t) ?? 0) + n);

const rel = (f) => relative(resolve(WEB_ROOT, '..'), f).replace(/\\/gu, '/');

if (JSON_OUT) {
  console.log(JSON.stringify({
    roots: ROOTS, missingRoots, glbCount, sceneCount: rows.length, nonSceneCount, errors,
    scenes: rows.map((r) => ({ ...r, file: rel(r.file), componentTypes: Object.fromEntries(r.componentTypes) })),
    total, componentTypes: Object.fromEntries(typeTotals),
  }, null, 2));
  process.exit(0);
}

const row = (cells) => `| ${cells.join(' | ')} |`;
const out = [];
out.push('# AssetOverrides audit (plan-753 Phase 0)');
out.push('');
out.push(`GLBs scanned: ${glbCount} · scenes (with AssetReference): ${rows.length} · assets/other: ${nonSceneCount} · unreadable: ${errors.length}`);
if (missingRoots.length > 0) out.push(`Missing roots: ${missingRoots.map(rel).join(', ')}`);
out.push('');
out.push(row(['scene', 'placements', 'with overrides', 'byNodeId', 'byNodeId no-component', 'byNodeId fields', 'trsByNodeId', 'trsByNodeId no byNodeId', 'byPath', 'byAddress']));
out.push(row(Array(10).fill('---')));
for (const r of rows) {
  out.push(row([rel(r.file), r.placements, r.placementsWithOverrides, r.byNodeId, r.byNodeIdNoComponent, r.byNodeIdFields, r.trsByNodeId, r.trsByNodeIdNoComponent, r.byPath, r.byAddress]));
}
out.push(row(['**total**', total.placements, total.placementsWithOverrides, total.byNodeId, total.byNodeIdNoComponent, total.byNodeIdFields, total.trsByNodeId, total.trsByNodeIdNoComponent, total.byPath, total.byAddress]));
out.push('');
if (typeTotals.size > 0) {
  out.push('Component types patched via byNodeId / byAddress: ' + [...typeTotals].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}×${n}${COMPONENT_TYPES.has(t) ? '' : ' (not a component)'}`).join(', '));
  out.push('');
}
for (const e of errors) out.push(`- unreadable: ${rel(e.file)} — ${e.error}`);
console.log(out.join('\n'));
