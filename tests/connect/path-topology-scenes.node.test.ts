// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * path-topology-scenes.node.test.ts — plan-633 Phase 4: the load-time check
 * (`PathTopologyCheck.runNow`, the same code the viewer runs after
 * `whenSceneReady()`) on every shipped scene with paths.
 *
 * Expectation from Phase 0 (`path-topology-baseline.node.test.ts`): ZERO
 * reports — no `path-successor-mismatch`, no `path-end-near-miss`. A report
 * here is a FINDING about the scene or the check, never a reason to widen the
 * tolerance. The link counts are pinned against the Phase-0 numbers so the
 * check and the baseline cannot drift apart.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePathExtras, type RVPath } from '../../src/core/engine/rv-path';
import { RVPathNetwork } from '../../src/core/engine/rv-path-network';
import { pairPathEnds } from '../../src/core/connect/path-topology';
import { PathTopologyCheck } from '../../src/core/connect/path-topology-check';
import { clearAllProblems, getProblems } from '../../src/core/hmi/problems-store';
import { buildFactoryLayout } from '../fixtures/agv-factory-fixture';

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

/** Path payloads of a GLB (JSON chunk only); asserts identity transforms on every Path chain. */
function glbScene(rel: string): RVPath[] {
  const file = DEMO_PROJECT + rel;
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
  const out: RVPath[] = [];
  nodes.forEach((n, i) => {
    const raw = n.extras?.realvirtual?.Path;
    if (!raw) return;
    for (let k: number | undefined = i; k !== undefined; k = parent.get(k)) {
      expect(nonIdentity(nodes[k]), `${rel}: Path chain of '${n.name}' is identity`).toBe(false);
    }
    const p = parsePathExtras(raw, n.name ?? `node${i}`);
    if (p) out.push(p);
  });
  return out;
}

function factoryFixture(): RVPath[] {
  return buildFactoryLayout().graph.map((p) => parsePathExtras({
    type: 'Path', version: 1, id: p.id, segments: p.segments, closed: false, successors: p.successors,
  }, p.id)!);
}

/** Phase-0 numbers (paths, geometric links) — see path-topology-baseline.node.test.ts. */
const SCENES: Record<string, { load: () => RVPath[]; paths: number; links: number }> = {
  'AGVDemo.glb': { load: () => glbScene('AGVDemo.glb'), paths: 4, links: 4 },
  'Course.glb (library)': { load: () => glbScene('library/Custom/Course.glb'), paths: 4, links: 4 },
  'AGVFactory.glb': { load: () => glbScene('AGVFactory.glb'), paths: 46, links: 50 },
  'PalletYard.glb': { load: () => glbScene('PalletYard.glb'), paths: 62, links: 62 },
  'agv-factory-fixture': { load: factoryFixture, paths: 46, links: 50 },
};

describe('plan-633 Phase 4 — the successor check on the shipped scenes reports nothing', () => {
  beforeEach(() => clearAllProblems());

  for (const [id, s] of Object.entries(SCENES)) {
    it(id, () => {
      const paths = s.load();
      const net = new RVPathNetwork();
      for (const p of paths) net.register(p);
      expect(pairPathEnds(net).length).toBe(s.links);
      const check = new PathTopologyCheck({ on: () => () => {}, whenSceneReady: async () => {} }, net);
      const res = check.runNow();
      expect(res.paths).toBe(s.paths);
      expect(res.links).toBe(s.links);
      expect(res.mismatches).toEqual([]);
      expect(res.nearMisses).toEqual([]);
      expect(getProblems()).toEqual([]);
    });
  }
});
