// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-492 Phase 0 — the Fanuc CRX-10iA/L library asset is structurally what
 * the cell-matrix generator expects.
 *
 * `scripts/perf-extract-robot-asset.mjs` cuts the robot out of the demo model.
 * The script verifies its own output once, at extraction time; this test keeps
 * the COMMITTED file honest: a re-extraction from a changed demo export, a
 * hand edit, or a Draco re-compression that loses extras all fail here.
 *
 * Asserted (the generator depends on each one):
 *  - one scene root named `FanucCRX-10iA-L`, at the origin, unrotated
 *  - `Drive_ErraticPosition` in iterate mode without `SignalEnable` on A1..A6
 *    (deterministic min/max sweep, no `Math.random`, no PLC signal)
 *  - no demo bindings left (`rigidbody`, `AASLink`, `Grip`, …)
 *  - no `ComponentReference` that leaves the asset subtree — every path is
 *    rooted at `FanucCRX-10iA-L`, so two placements of the asset can be
 *    rewritten onto their own placement path (plan-492 R4)
 *  - the local library catalog lists it as `robots-fanuccrx-10ia-l`
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO, type Document, type Node as GltfNode } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSET = resolve(ROOT, 'public/library/Robots/FanucCRX-10iA-L.glb');
const CATALOG = resolve(ROOT, 'public/library/catalog.json');

const ROOT_NAME = 'FanucCRX-10iA-L';
const AXES = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'] as const;
/** Keys the extraction strips because they bind the robot to the demo cell. */
const STRIPPED_KEYS = ['rigidbody', 'AASLink', 'Grip', 'colliders', 'ConnectSignal'];

type RvExtras = Record<string, unknown>;

/** Read a Draco-compressed GLB (the library assets are all `edgebreaker`). */
async function readWithDraco(path: string): Promise<Document> {
  const decoder = await draco3d.createDecoderModule();
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'draco3d.decoder': decoder });
  return io.read(path);
}

/** Every `ComponentReference.path` anywhere inside `value`, with its field trail. */
function collectRefPaths(value: unknown, where: string, out: Array<{ where: string; path: string }>): void {
  if (!value || typeof value !== 'object') return;
  const obj = value as Record<string, unknown>;
  if (obj.type === 'ComponentReference' && typeof obj.path === 'string') {
    out.push({ where, path: obj.path });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectRefPaths(v, `${where}[${i}]`, out));
    return;
  }
  for (const [k, v] of Object.entries(obj)) collectRefPaths(v, `${where}.${k}`, out);
}

describe('public/library/Robots/FanucCRX-10iA-L.glb (plan-492 Phase 0)', () => {
  let doc: Document;
  let nodes: GltfNode[];
  let rvByName: Map<string, RvExtras>;

  beforeAll(async () => {
    doc = await readWithDraco(ASSET);
    nodes = doc.getRoot().listNodes();
    rvByName = new Map(nodes.map((n) => [
      n.getName(),
      ((n.getExtras() ?? {}) as { realvirtual?: RvExtras }).realvirtual ?? {},
    ]));
  }, 60_000);

  it('is a single scene root at the origin', () => {
    const scenes = doc.getRoot().listScenes();
    expect(scenes).toHaveLength(1);
    const children = scenes[0].listChildren();
    expect(children).toHaveLength(1);
    expect(children[0].getName()).toBe(ROOT_NAME);
    expect(children[0].getTranslation()).toEqual([0, 0, 0]);
    expect(children[0].getRotation()).toEqual([0, 0, 0, 1]);
    expect(children[0].getScale()).toEqual([1, 1, 1]);
  });

  it('carries 6 iterate-mode erratic drivers on A1..A6 with no SignalEnable', () => {
    for (const axis of AXES) {
      const rv = rvByName.get(axis);
      expect(rv, `node "${axis}" exists`).toBeDefined();
      expect(rv!.Drive, `${axis} has a Drive`).toBeDefined();
      const erratic = rv!.Drive_ErraticPosition as Record<string, unknown> | undefined;
      expect(erratic, `${axis} has Drive_ErraticPosition`).toBeDefined();
      expect(erratic!.IterateBetweenMaxAndMin).toBe(true);
      expect(erratic!.SignalEnable).toBeNull();
      // A sweep needs a non-degenerate range and a speed, else the axis parks.
      expect(erratic!.MaxPos as number).toBeGreaterThan(erratic!.MinPos as number);
      expect(erratic!.Speed as number).toBeGreaterThan(0);
    }
    const withErratic = [...rvByName.values()].filter((rv) => rv.Drive_ErraticPosition).length;
    expect(withErratic, 'exactly the six axes sweep').toBe(6);
  });

  it('keeps the axis and gripper drives', () => {
    const drives = [...rvByName.entries()].filter(([, rv]) => rv.Drive).map(([name]) => name);
    // Six axes plus the gripper kinematics the demo robot carries.
    expect(drives.length).toBeGreaterThanOrEqual(6);
    for (const axis of AXES) expect(drives).toContain(axis);
  });

  it('carries no demo binding left over', () => {
    const offenders: string[] = [];
    for (const [name, rv] of rvByName) {
      for (const key of STRIPPED_KEYS) if (key in rv) offenders.push(`${name}.${key}`);
    }
    expect(offenders).toEqual([]);
  });

  it('has no ComponentReference leaving the asset subtree (R4 precondition)', () => {
    const refs: Array<{ where: string; path: string }> = [];
    for (const node of nodes) collectRefPaths(rvByName.get(node.getName()) ?? {}, node.getName(), refs);
    const escaping = refs.filter((r) => r.path !== ROOT_NAME && !r.path.startsWith(`${ROOT_NAME}/`));
    expect(escaping, 'every reference is rooted at the asset root').toEqual([]);
  });

  it('is listed in the local catalog as robots-fanuccrx-10ia-l', async () => {
    const catalog = JSON.parse(await readFile(CATALOG, 'utf8')) as {
      entries: Array<{ id: string; name: string; glbUrl: string; category?: string }>;
    };
    const entry = catalog.entries.find((e) => e.id === 'robots-fanuccrx-10ia-l');
    expect(entry, 'catalog entry present').toBeDefined();
    expect(entry!.glbUrl).toBe('Robots/FanucCRX-10iA-L.glb');
  });
});
