// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-610 Phase 3 — the reference audit over the shipped demo models, without a
 * browser: every `public/demo-realvirtual/*.glb` is read as glTF JSON, its node
 * tree rebuilt with the names the VIEWER gives the nodes (GLTFLoader's file-wide
 * de-duplication in load order plus the raw-name restore,
 * `scripts/lib/rv-glb-nodes.mjs` `nodeNames`) and registered in a real
 * `NodeRegistry` the way the loader leaves it after `prepare` (plan-610 Phase 5b,
 * `registryFromGlbJson(..., { loaderPrepare: true })`): the real `Kinematic`
 * pre-bake hook re-parents group members and axes, then the dedup aliases and the
 * re-parent alias table are registered. Then `auditReferences` runs exactly as in
 * the viewer. No components are constructed, so every reference is judged at node
 * level (the audit's own rule for a typed miss).
 *
 * Not covered here (browser tests do that): the bake (it keeps referenced nodes
 * and their ancestors, so it changes no referenced path) and the content of
 * library assets a layout document references (they are audited when they are
 * placed, in their own scope).
 *
 * Findings are REAL defects of the model. They are pinned in {@link KNOWN}
 * below instead of being hidden: a new finding fails the test, and a fixed one
 * fails it too until its line is removed.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlb } from '../scripts/lib/rv-glb.mjs';
import { auditReferences, describeReferenceLocation, forEachStoredReference, type ReferenceAuditFinding } from '../src/core/engine/rv-reference-audit';
import { seedNodeIdsForFile } from '../src/core/engine/rv-node-id-seed.mjs';
import { registryFromGlbJson, type GltfJson } from './helpers/glb-json-registry';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEMO_DIR = join(repoRoot, 'public', 'demo-realvirtual');

const demoFiles = readdirSync(DEMO_DIR).filter((f) => f.toLowerCase().endsWith('.glb')).sort();

/** One line per finding — what the report lists and {@link KNOWN} pins. */
function line(file: string, f: ReferenceAuditFinding): string {
  const target = f.kind === 'rescued' ? ` -> ${f.resolvedPath} (${f.stage})` : '';
  return `${file} | ${f.kind} | ${f.referrerPath} | ${describeReferenceLocation(f)} | ${f.writtenPath}${target}`;
}

/**
 * Known findings in the shipped demo models (plan-610 Phase 3 report). Each is a
 * real defect (of the model, or of the engine where the comment says so); fix it,
 * then delete the line.
 */
const KNOWN: readonly string[] = [
  // Empty since plan-610 Phase 5c: the welding station's three grips (moved under their
  // axis by the `Kinematic` hook) name their own child sensor by its authored path, and the
  // re-parent PREFIX alias now resolves that path exactly (stage `alias`).
];

describe('reference audit over the demo models (plan-610 Phase 3)', () => {
  it('finds the demo models', () => {
    expect(demoFiles.length).toBeGreaterThan(0);
  });

  for (const file of demoFiles) {
    it(`${file}: every stored reference names an authored node`, () => {
      const { json } = readGlb(readFileSync(join(DEMO_DIR, file))) as { json: GltfJson };
      // Viewer naming + prepare re-parenting + loader aliases, FMU signal leaves mirrored.
      const { registry } = registryFromGlbJson(json, file.replace(/\.glb$/i, ''), { mirrorFmuSignals: true, loaderPrepare: true, identity: true });
      const r = auditReferences(registry);
      const lines = r.findings.map((f) => line(file, f));
      if (lines.length > 0) console.log(`[reference-audit] ${file}: ${r.counts.references} refs, ${lines.length} findings\n  ${lines.join('\n  ')}`);
      else console.log(`[reference-audit] ${file}: ${r.counts.references} refs, ${r.counts.referrers} referrers, clean (${r.ms.toFixed(1)} ms)`);
      expect([...lines].sort()).toEqual(KNOWN.filter((k) => k.startsWith(`${file} |`)).sort());
    });
  }

  // An address into a placement (`<p>#<id>`, plan-769) reads `pending` above — the placed
  // content is not loaded here. Resolve it one level deep against the referenced asset
  // file instead, so a dangling id into placed content still fails (PegGameSetzkasten's
  // LogicSteps drive the axes of the placed library Fanuc CRX this way).
  it('addresses into placed content name a node of the placed asset', () => {
    const misses: string[] = [];
    let checked = 0;
    // PegGameSetzkasten (moved to the private Development project, 2026-10-28) is the model with
    // addresses into a placement; it is checked when the private repo is checked out.
    const PEG = join(repoRoot, '..', 'realvirtual-WebViewer-Private~', 'projects', 'Development', 'models', 'PegGameSetzkasten.glb');
    const sources = [...demoFiles.map((f) => ({ file: f, abs: join(DEMO_DIR, f) })), ...(existsSync(PEG) ? [{ file: 'Development/PegGameSetzkasten.glb', abs: PEG }] : [])];
    for (const { file, abs } of sources) {
      const { json } = readGlb(readFileSync(abs)) as { json: GltfJson };
      const nodes = (json.nodes ?? []) as Array<{ name?: string; extras?: { realvirtual?: Record<string, unknown> } }>;
      const fileIds = seedNodeIdsForFile(json, json.scene ?? 0).ids as Array<string | undefined>;
      const assetOf = new Map<string, string>();
      nodes.forEach((n, i) => {
        const ref = n.extras?.realvirtual?.AssetReference as { path?: string; embedded?: boolean } | undefined;
        if (ref?.path && !ref.embedded && fileIds[i]) assetOf.set(fileIds[i]!, ref.path);
      });
      const idsOfAsset = new Map<string, Set<string>>();
      nodes.forEach((n) => forEachStoredReference(n.extras?.realvirtual, (r) => {
        const address = r.form === 'address' && r.stored && typeof r.stored === 'object' && 'address' in r.stored ? r.stored.address : null;
        const m = address ? /^([^/#]+)#(.+)$/.exec(address) : null;
        if (!m || !assetOf.has(m[1])) return;
        const assetFile = join(repoRoot, 'public', assetOf.get(m[1])!);
        if (!existsSync(assetFile)) { misses.push(`${file} | ${n.name} | ${address} | asset missing: ${assetOf.get(m[1])}`); return; }
        let ids = idsOfAsset.get(assetFile);
        if (!ids) {
          const asset = (readGlb(readFileSync(assetFile)) as { json: GltfJson }).json;
          ids = new Set((seedNodeIdsForFile(asset, asset.scene ?? 0).ids as Array<string | undefined>).filter((x): x is string => !!x));
          idsOfAsset.set(assetFile, ids);
        }
        checked++;
        if (!ids.has(m[2])) misses.push(`${file} | ${n.name} | ${r.componentType}.${r.field} | ${address}`);
      }));
    }
    expect(checked).toBeGreaterThan(0);
    expect(misses).toEqual([]);
  });
});

/**
 * plan-610 Phase 5b regression: the pattern that made the Phase-5 welding GLB
 * load with 7 `reference-rescued` warnings although the Phase-3 node audit
 * called it clean. A new group named like an existing node elsewhere in the
 * file (`FG03` = the signal table `Signals/FG03`) is loaded by GLTFLoader as
 * `FG03_1` / `FG03_2` (file-wide dedup), and the `Kinematic` pre-bake hook then
 * moves the `Group` members under their axis — so a path written through the
 * new group neither resolves exactly nor through an alias.
 */
describe('reference audit: file-wide name collision + kinematic re-parent (plan-610 Phase 5b)', () => {
  const ref = (path: string, componentType: string) => ({ type: 'ComponentReference', path, componentType });
  /** `kin` / `plant`: the names of the two new station groups. */
  const fixture = (kin: string, plant: string): GltfJson => ({
    scene: 0,
    scenes: [{ name: 'Station', nodes: [0, 3, 8] }],
    nodes: [
      /* 0 */ { name: 'Signals', children: [1] },
      /* 1 */ { name: 'FG03', children: [2] },
      /* 2 */ { name: 'FG03_Gripper_InWork', extras: { realvirtual: { PLCInputBool: { Name: 'FG03_Gripper_InWork' } } } },
      /* 3 */ { name: 'Kinematics', children: [4] },
      /* 4 */ { name: kin, children: [5, 6, 7] },
      /* 5 */ { name: 'FG03_Y2', extras: { realvirtual: { Kinematic: { GroupName: 'FG03_Y2', IntegrateGroupEnable: true }, Drive: {} } } },
      /* 6 */ { name: 'FG03_Gripper_A', extras: { realvirtual: { Group: { GroupName: 'FG03_Y2' }, Drive: {} } } },
      /* 7 */ {
        name: 'FG03_Gripper_B',
        extras: { realvirtual: { Group: { GroupName: 'FG03_Y2' }, Drive: {}, Drive_Gear: { MasterDrive: ref(`Kinematics/${kin}/FG03_Gripper_A`, 'Drive') } } },
      },
      /* 8 */ { name: 'Plant', children: [9] },
      /* 9 */ { name: plant, children: [10] },
      /* 10 */ {
        name: 'FG03_Grip', children: [11],
        extras: { realvirtual: { Group: { GroupName: 'FG03_Y2' }, Grip: { PartToGrip: ref(`Plant/${plant}/FG03_Grip/FG03_GripSensor`, 'Sensor'), SignalPick: ref('Signals/FG03/FG03_Gripper_InWork', 'PLCInputBool') } } },
      },
      /* 11 */ { name: 'FG03_GripSensor', extras: { realvirtual: { Sensor: {} } } },
    ],
  });
  const audit = (json: GltfJson, loaderPrepare: boolean) => {
    const { registry, reparented } = registryFromGlbJson(json, 'Station', { loaderPrepare });
    const r = auditReferences(registry);
    return { r, reparented, lines: r.findings.map((f) => `${f.kind} | ${describeReferenceLocation(f)} | ${f.writtenPath} (${f.stage})`).sort() };
  };

  it('the loader names the colliding groups file-wide: FG03_1 / FG03_2', () => {
    const { registry } = registryFromGlbJson(fixture('FG03', 'FG03'), 'Station', { loaderPrepare: false });
    expect(registry.getNode('Station/Kinematics/FG03_1/FG03_Y2')).not.toBeNull();
    expect(registry.getNode('Station/Plant/FG03_2/FG03_Grip')).not.toBeNull();
  });

  it('flags the Phase-5 pattern: both references written through a colliding group are rescued', () => {
    const { lines, reparented } = audit(fixture('FG03', 'FG03'), true);
    expect(reparented.map((p) => p.previousPath).sort()).toEqual([
      'Station/Kinematics/FG03_1/FG03_Gripper_A',
      'Station/Kinematics/FG03_1/FG03_Gripper_B',
      'Station/Plant/FG03_2/FG03_Grip',
    ]);
    expect(lines).toEqual([
      'rescued | Drive_Gear.MasterDrive | Kinematics/FG03/FG03_Gripper_A (name-in-scope)',
      'rescued | Grip.PartToGrip | Plant/FG03/FG03_Grip/FG03_GripSensor (name-in-scope)',
    ]);
  });

  it('file-unique group names: a reference to a moved node resolves through the re-parent alias', () => {
    const { lines } = audit(fixture('FG03_Kinematics', 'FG03_Plant'), true);
    // plan-610 Phase 5c regression: a path INTO a moved subtree (the Grip's own sensor)
    // resolves through the re-parent PREFIX alias — before 5c it fell back to the name match.
    expect(lines).toEqual([]);
  });

  it('without the prefix alias (pre-5c alias table) the subtree path was a rescue', () => {
    const { registry } = registryFromGlbJson(fixture('FG03_Kinematics', 'FG03_Plant'), 'Station', { loaderPrepare: true, prefixAliases: false });
    const lines = auditReferences(registry).findings.map((f) => `${f.kind} | ${describeReferenceLocation(f)} | ${f.writtenPath} (${f.stage})`);
    expect(lines).toEqual(['rescued | Grip.PartToGrip | Plant/FG03_Plant/FG03_Grip/FG03_GripSensor (name-in-scope)']);
  });
});
