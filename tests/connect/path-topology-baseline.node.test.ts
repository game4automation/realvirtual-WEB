// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * path-topology-baseline.node.test.ts — plan-633 Phase 0, step 3 (input for F8).
 *
 * COUNTS ONLY, changes nothing. For every shipped scene with paths it measures
 * how the authored `successors` relate to the geometry, so the load-time check
 * of Phase 4 (`path-successor-mismatch`) can be judged before it exists — a
 * check that would flood the Problems panel on the shipped scenes is caught
 * here, not by a customer.
 *
 * Per scene:
 *   - paths, declared successor links (Σ successorIds);
 *   - geometric links: ordered pairs END(i) → START(j), i ≠ j, within
 *     5 mm AND tangent angle ≤ 2° (angle between the END tangent of i and the
 *     START tangent of j — both along travel, NOT the opposed outward vectors);
 *   - declared ∩ geometric, declared without geometry, geometry without
 *     declaration (what F8 would report as missing / extra);
 *   - near misses: END → START between 5 mm and 30 mm (the planned info code).
 *
 * Sources: the four scene GLBs of the DES project (read straight from the GLB
 * JSON chunk, all Path nodes carry identity transforms — asserted) and the
 * public AGVFactory fixture graph.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePathExtras, getPathEndpoints, type RVPath } from '../../src/core/engine/rv-path';
import { buildFactoryLayout } from '../fixtures/agv-factory-fixture';

const DIST_M = 0.005;
const TANGENT_DEG = 2;
const NEAR_MISS_M = 0.03;

const DEMO_PROJECT = fileURLToPath(
  new URL('../../public/demo-realvirtual/', import.meta.url),
);

interface GltfNode {
  name?: string;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  extras?: { realvirtual?: { Path?: unknown } };
}

/** Path payloads of a GLB (JSON chunk only) + whether every Path node chain is identity. */
function readGlbPaths(file: string): { raws: { raw: unknown; name: string }[]; identity: boolean } {
  const b = readFileSync(file);
  expect(b.readUInt32LE(0), `${file} is a GLB`).toBe(0x46546c67);
  const len = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + len).toString('utf8')) as { nodes?: GltfNode[] };
  const nodes = json.nodes ?? [];
  const parent = new Map<number, number>();
  nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parent.set(c, i)));
  const nonIdentity = (n: GltfNode): boolean =>
    !!n.matrix
    || !!n.translation?.some((v) => Math.abs(v) > 1e-9)
    || (!!n.rotation && Math.abs(n.rotation[3] - 1) > 1e-9)
    || !!n.scale?.some((v) => Math.abs(v - 1) > 1e-9);
  let identity = true;
  const raws: { raw: unknown; name: string }[] = [];
  nodes.forEach((n, i) => {
    const raw = n.extras?.realvirtual?.Path;
    if (!raw) return;
    raws.push({ raw, name: n.name ?? `node${i}` });
    for (let k: number | undefined = i; k !== undefined; k = parent.get(k)) {
      if (nonIdentity(nodes[k])) identity = false;
    }
  });
  return { raws, identity };
}

interface PathCounts {
  paths: number;
  declared: number;
  geometric: number;
  declaredAndGeometric: number;
  declaredOnly: number;
  geometricOnly: number;
  nearMiss: number;
}

function countTopology(paths: readonly RVPath[]): PathCounts {
  const ends = paths.map((p) => getPathEndpoints(p));
  const cosMax = Math.cos((TANGENT_DEG * Math.PI) / 180);
  const geometric = new Set<string>();
  let nearMiss = 0;
  for (let i = 0; i < paths.length; i++) {
    const a = ends[i];
    if (!a) continue;
    for (let j = 0; j < paths.length; j++) {
      if (i === j) continue;
      const c = ends[j];
      if (!c) continue;
      const d = a.end.position.distanceTo(c.start.position);
      if (d <= DIST_M) {
        if (a.end.tangent.dot(c.start.tangent) >= cosMax) geometric.add(`${paths[i].id}>${paths[j].id}`);
      } else if (d <= NEAR_MISS_M) {
        nearMiss++;
      }
    }
  }
  const declared = new Set<string>();
  for (const p of paths) for (const s of p.successorIds) declared.add(`${p.id}>${s}`);
  let both = 0;
  for (const k of declared) if (geometric.has(k)) both++;
  return {
    paths: paths.length,
    declared: declared.size,
    geometric: geometric.size,
    declaredAndGeometric: both,
    declaredOnly: declared.size - both,
    geometricOnly: geometric.size - both,
    nearMiss,
  };
}

function glbScene(rel: string): RVPath[] {
  const { raws, identity } = readGlbPaths(DEMO_PROJECT + rel);
  expect(identity, `${rel}: Path nodes carry identity transforms (counts are world-valid)`).toBe(true);
  return raws.map(({ raw, name }) => parsePathExtras(raw, name)).filter((p): p is RVPath => p !== null);
}

function factoryFixture(): RVPath[] {
  return buildFactoryLayout().graph.map((p) => parsePathExtras({
    type: 'Path', version: 1, id: p.id, segments: p.segments, closed: false, successors: p.successors,
  }, p.id)!);
}

/** REFERENCE — recorded on the unchanged stand (WV ab4da781 / PRIV f77f931). */
const REFERENCE: Record<string, PathCounts> = {
  'AGVDemo.glb': { paths: 4, declared: 4, geometric: 4, declaredAndGeometric: 4, declaredOnly: 0, geometricOnly: 0, nearMiss: 0 },
  'Course.glb (library)': { paths: 4, declared: 4, geometric: 4, declaredAndGeometric: 4, declaredOnly: 0, geometricOnly: 0, nearMiss: 0 },
  'AGVFactory.glb': { paths: 46, declared: 50, geometric: 50, declaredAndGeometric: 50, declaredOnly: 0, geometricOnly: 0, nearMiss: 0 },
  'PalletYard.glb': { paths: 62, declared: 62, geometric: 62, declaredAndGeometric: 62, declaredOnly: 0, geometricOnly: 0, nearMiss: 0 },
  'agv-factory-fixture': { paths: 46, declared: 50, geometric: 50, declaredAndGeometric: 50, declaredOnly: 0, geometricOnly: 0, nearMiss: 0 },
};

const SCENES: Record<string, () => RVPath[]> = {
  'AGVDemo.glb': () => glbScene('AGVDemo.glb'),
  'Course.glb (library)': () => glbScene('library/Custom/Course.glb'),
  'AGVFactory.glb': () => glbScene('AGVFactory.glb'),
  'PalletYard.glb': () => glbScene('PalletYard.glb'),
  'agv-factory-fixture': factoryFixture,
};

describe('plan-633 Phase 0 — path topology baseline (counts only)', () => {
  for (const [id, load] of Object.entries(SCENES)) {
    it(id, () => {
      const counts = countTopology(load());
      const ref = REFERENCE[id];
      expect(ref, `REFERENCE for ${id}`).toBeDefined();
      expect(counts).toEqual(ref);
    });
  }
});
