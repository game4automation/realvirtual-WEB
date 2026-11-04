// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * patch-agv-stacker-glb.mjs — reproducible metadata patch of the library model
 * `public/library/MobileRobots/AGVStacker.glb` (plan-612 CP1d-b, step b1-0).
 *
 * The stacker itself was built in the WEB editor (CP1b); this script only edits
 * the glTF JSON chunk (the BIN chunk is copied verbatim) so the model works as a
 * PLACEMENT (an `AssetReference` in a layout, the instance principle):
 *
 *  1. `LiftRam.Drive_Gear.MasterDrive` becomes a TAGGED asset-relative reference
 *     `{ type: 'ComponentReference', path: 'AGV_Stacker/Lift', componentType: 'Drive' }`.
 *     The editor had written the same path without `type` — the loader resolves only
 *     tagged references, so the gear had no master and LiftRam ran NaN (b0 finding 2',
 *     main model and placement alike). The path stays `AGV_Stacker/Lift`: the glTF
 *     scene is the asset scope and `AGV_Stacker` is its (only) top-level node.
 *  2. `Lift/ForkAnchor` gets the authored bake role `rv.BakeRole: 'merge'`: the
 *     PalletYard plugin seats the carried pallet on it, and a plugin bake claim
 *     cannot reach into a placement (plan-757 D5) — without the role the bake
 *     drops the empty node (b0 finding 3).
 *  3. (plan-612 CP1d-a a3) `Lamp_Beacon` wears the amber signal material
 *     `Signal Amber` (already in the asset, worn by `Lamp_StackAmber`) instead of
 *     `Signal Red`: the beacon lights amber (`Lamp.OnColor`), so its unlit glass
 *     must be amber too. Only the material index of its own mesh changes.
 *  4. The catalog row `mobilerobots-agvstacker` in `public/library/catalog.json`
 *     gets the new `sha256` / `sizeBytes`.
 *
 * Idempotent: a second run changes no byte. Node ≥ 20.
 *
 * Run (from the WebViewer repo root):
 *   node tools/solidcraft/agv-stacker/patch-agv-stacker-glb.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlb, writeGlb } from '../../../scripts/lib/rv-glb.mjs';
import { findByPath } from '../../../scripts/lib/rv-glb-nodes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const WV_ROOT = path.resolve(here, '../../..');
export const STACKER_GLB = path.join(WV_ROOT, 'public', 'library', 'MobileRobots', 'AGVStacker.glb');
export const CATALOG = path.join(WV_ROOT, 'public', 'library', 'catalog.json');
const CATALOG_ID = 'mobilerobots-agvstacker';

/** Material the beacon wears (matches its amber `OnColor`). */
export const BEACON_MATERIAL = 'Signal Amber';

/** The gear master as it must stand in the asset (asset-relative, tagged). */
export const MASTER_DRIVE_REF = Object.freeze({ type: 'ComponentReference', path: 'AGV_Stacker/Lift', componentType: 'Drive' });

function rvOf(node) {
  node.extras = node.extras ?? {};
  node.extras.realvirtual = node.extras.realvirtual ?? {};
  return node.extras.realvirtual;
}

function nodeAt(json, p) {
  const i = findByPath(json, p);
  if (i === null) throw new Error(`AGVStacker.glb: node ${p} missing`);
  return json.nodes[i];
}

/** Apply the patch to a parsed glTF JSON (in place). Returns the list of changes made. */
export function patchStackerJson(json) {
  const changes = [];
  const ram = rvOf(nodeAt(json, 'AGV_Stacker/LiftRam'));
  if (!ram.Drive_Gear) throw new Error('AGVStacker.glb: LiftRam carries no Drive_Gear');
  if (JSON.stringify(ram.Drive_Gear.MasterDrive) !== JSON.stringify(MASTER_DRIVE_REF)) {
    ram.Drive_Gear.MasterDrive = { ...MASTER_DRIVE_REF };
    changes.push('LiftRam.Drive_Gear.MasterDrive');
  }
  const anchor = rvOf(nodeAt(json, 'AGV_Stacker/Lift/ForkAnchor'));
  if (anchor.BakeRole !== 'merge') {
    anchor.BakeRole = 'merge';
    changes.push('Lift/ForkAnchor rv.BakeRole');
  }
  const beacon = nodeAt(json, 'AGV_Stacker/Chassis/Lamp_Beacon');
  const amber = (json.materials ?? []).findIndex((m) => m.name === BEACON_MATERIAL);
  if (amber < 0) throw new Error(`AGVStacker.glb: material ${BEACON_MATERIAL} missing`);
  const mesh = json.meshes?.[beacon.mesh];
  if (!mesh) throw new Error('AGVStacker.glb: Lamp_Beacon has no mesh');
  const sharedBy = json.nodes.filter((n) => n.mesh === beacon.mesh).length;
  if (sharedBy !== 1) throw new Error(`AGVStacker.glb: the Lamp_Beacon mesh is shared by ${sharedBy} nodes`);
  if (mesh.primitives.some((p) => p.material !== amber)) {
    for (const p of mesh.primitives) p.material = amber;
    changes.push(`Lamp_Beacon material ${BEACON_MATERIAL}`);
  }
  return changes;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Patch the GLB (only when needed) and keep the catalog row in step. */
export function patchAgvStacker({ glbPath = STACKER_GLB, catalogPath = CATALOG } = {}) {
  const before = readFileSync(glbPath);
  const { json, rest } = readGlb(before);
  const changes = patchStackerJson(json);
  const bytes = changes.length > 0 ? writeGlb(json, rest) : before;
  if (changes.length > 0) writeFileSync(glbPath, bytes);
  const hash = sha256(bytes);
  const catalogText = readFileSync(catalogPath, 'utf8');
  const catalog = JSON.parse(catalogText);
  const row = catalog.entries?.find((e) => e.id === CATALOG_ID);
  if (!row) throw new Error(`catalog.json: row ${CATALOG_ID} missing`);
  let catalogWritten = false;
  if (row.sha256 !== hash || row.sizeBytes !== bytes.length) {
    row.sha256 = hash;
    row.sizeBytes = bytes.length;
    const eol = catalogText.includes('\r\n') ? '\r\n' : '\n';
    let out = JSON.stringify(catalog, null, 2);
    if (eol !== '\n') out = out.replace(/\n/g, eol);
    writeFileSync(catalogPath, out + (catalogText.endsWith('\n') ? eol : ''));
    catalogWritten = true;
  }
  return { changes, sha256: hash, sizeBytes: bytes.length, catalogWritten };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const r = patchAgvStacker();
  console.log(`${r.changes.length ? `patched ${r.changes.join(', ')}` : 'unchanged'} — AGVStacker.glb ${r.sizeBytes} B, sha256 ${r.sha256}`
    + `${r.catalogWritten ? ' (catalog.json row updated)' : ''}`);
}
