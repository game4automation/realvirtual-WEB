// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-628 §9.9e (8.6) — the PalletYard generator writes a real path NETWORK of blocks:
// a top-level PathNetwork, one PathBlock parent per composed block, every Path under a
// block (no exception list — every piece maps onto a block kind), path ids / successors /
// zones / AGV starts / docks deep-equal to today's graph, every generated node owner-marked
// (composition-owned: the path-network ops refuse to write it), each block exactly its
// template (not "edited"), and 0 path-kink. composeYardBlocks is checked for sizes 1, 2, 4
// too (plan-681 Phase 3 materializes the same blocks at runtime).
import { beforeAll, describe, expect, it } from 'vitest';
import { parsePathBlockExtras, PATH_NETWORK_NODE } from '@rv/core/engine/rv-path-block';
import {
  isBlockEdited, moveBlock, removeBlock, removePaths, setBlockParams,
  type BlockEntry, type NetworkInput, type PathGraphEntry as OpsEntry,
} from '@rv/core/engine/rv-path-network-ops';
import { validatePathNetwork } from '@rv/core/engine/rv-path-network-validate';
import {
  DEFAULT_GLB, PATH_NETWORK_NAME, ROOT_NAME, readGlb,
  type GltfDocumentLike, type GltfNodeLike,
} from '../../tools/des-examples/pallet-yard.mjs';
import {
  buildPathGraph, stichPathId, STATION_TAG_KEY, VEHICLES, type PathGraphEntry,
} from '../../src/plugins/models/PalletYard/layout';
import { composeYard, composeYardBlocks, GENERATED_OWNER } from '../../src/plugins/models/PalletYard/yard-compose';

const rv = (n: GltfNodeLike): Record<string, any> => n.getExtras()?.realvirtual ?? {};
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The pure ops input the viewer's snapshot would build from these nodes (owner = Generated.owner). */
function inputOf(graph: Array<{ block: string; owner?: string; p: PathGraphEntry }>, blocks: BlockEntry[]): NetworkInput {
  const paths: OpsEntry[] = graph.map(({ block, owner, p }) => ({
    id: p.id, nodeName: p.id, block, segments: clone(p.segments) as OpsEntry['segments'], successors: [...p.successors],
    ...(p.zone ? { zone: p.zone, zoneCapacity: p.zoneCapacity } : {}),
    ...(owner ? { owner } : {}),
  }));
  return { paths, blocks, takenNames: [...paths.map((p) => p.id), ...blocks.map((b) => b.id)] };
}

/** The ops input of composeYard(n) grouped by composeYardBlocks (what the generator writes). */
function composedInput(n: number): NetworkInput {
  const yard = composeYard(n);
  const blocks = composeYardBlocks(yard);
  const blockOf = new Map(blocks.flatMap((b) => b.paths.map((id) => [id, b.id] as const)));
  return inputOf(
    yard.pathGraph.map((p) => ({ block: blockOf.get(p.id)!, owner: GENERATED_OWNER, p })),
    blocks.map((b) => {
      const { paths: _p, id, ...x } = b;
      return { id, extras: parsePathBlockExtras({ type: 'PathBlock', version: 1, ...x })!, owner: GENERATED_OWNER };
    }),
  );
}

const kinks = (net: NetworkInput): string[] => validatePathNetwork(net).issues
  .filter((i) => i.code === 'path-kink' || i.code === 'path-link-gap').map((i) => `${i.code} ${i.key}`);

let doc: GltfDocumentLike;
let network: GltfNodeLike;
/** Every Path node of the file with its parent. */
const pathNodes: Array<{ node: GltfNodeLike; parent: GltfNodeLike | null }> = [];
const blockNodes: GltfNodeLike[] = [];

beforeAll(async () => {
  doc = await readGlb(DEFAULT_GLB);
  const roots = doc.getRoot().listScenes()[0].listChildren();
  network = roots.find((r) => r.getName() === PATH_NETWORK_NAME)!;
  const walk = (n: GltfNodeLike, parent: GltfNodeLike | null): void => {
    if (rv(n).Path) pathNodes.push({ node: n, parent });
    if (rv(n).PathBlock) blockNodes.push(n);
    for (const c of n.listChildren()) walk(c, n);
  };
  for (const r of roots) walk(r, null);
}, 120_000);

describe('PalletYard path network of blocks (plan-628 9.9e)', () => {
  it('a top-level PathNetwork (the document\'s own network, unmarked container) holds the blocks', () => {
    expect(PATH_NETWORK_NAME).toBe(PATH_NETWORK_NODE);
    expect(network).toBeTruthy();
    expect(rv(network)).toEqual({});
    expect(network.listChildren().length).toBe(blockNodes.length);
    expect(network.listChildren().every((c) => !!rv(c).PathBlock)).toBe(true);
    expect(doc.getRoot().listNodes().some((n) => n.getName() === 'Course')).toBe(false);
  });

  it('every Path node has a PathBlock parent — the exception list is empty', () => {
    const exceptions = pathNodes.filter((e) => !e.parent || !rv(e.parent).PathBlock).map((e) => e.node.getName());
    expect(exceptions).toEqual([]);
    for (const b of blockNodes) expect(parsePathBlockExtras(rv(b).PathBlock), b.getName()).not.toBeNull();
  });

  it('ids unique and equal to today\'s graph: successors, zones, capacities, segments deep-equal', () => {
    const ids = pathNodes.map((e) => rv(e.node).Path.id as string);
    expect(new Set(ids).size).toBe(ids.length);
    const today = new Map(buildPathGraph().map((p) => [p.id, p]));
    expect([...ids].sort()).toEqual([...today.keys()].sort());
    for (const e of pathNodes) {
      const p = rv(e.node).Path;
      const t = today.get(p.id)!;
      expect(e.node.getName()).toBe(p.id);
      expect({ segments: p.segments, successors: p.successors, zone: p.zone, zoneCapacity: p.zoneCapacity })
        .toEqual({ segments: t.segments, successors: t.successors, zone: t.zone, zoneCapacity: t.zoneCapacity });
    }
  });

  it('AGV starts and conveyor docks (Path-Id strings) are unchanged', () => {
    const root = doc.getRoot().listScenes()[0].listChildren().find((r) => r.getName() === ROOT_NAME)!;
    const byName = new Map(root.listChildren().map((c) => [c.getName(), c]));
    expect(VEHICLES.map((v) => ({ id: v.id, startPathId: rv(byName.get(v.id)!).Agv.PathId })))
      .toEqual(VEHICLES.map((v) => ({ id: v.id, startPathId: v.startPathId })));
    const docks = [...byName.values()].filter((n) => rv(n)[STATION_TAG_KEY]).map((n) => rv(n)[STATION_TAG_KEY]);
    expect(docks.length).toBe(4);
    for (const d of docks) expect(d.StichPathId).toBe(stichPathId(d.Station));
  });

  it('every generated node (blocks and paths) carries Generated.owner = palletYard', () => {
    for (const n of [...blockNodes, ...pathNodes.map((e) => e.node)]) {
      expect(rv(n).Generated, n.getName()).toEqual({ owner: GENERATED_OWNER });
    }
  });

  it('as the viewer reads it: every block is its template (not edited), 0 path-kink / path-link-gap', () => {
    const input = inputOf(
      pathNodes.map((e) => ({ block: e.parent!.getName(), owner: rv(e.node).Generated?.owner, p: rv(e.node).Path })),
      blockNodes.map((b) => ({ id: b.getName(), extras: parsePathBlockExtras(rv(b).PathBlock)!, owner: rv(b).Generated?.owner })),
    );
    for (const b of input.blocks!) expect(isBlockEdited(input, b.id), b.id).toBe(false);
    expect(kinks(input)).toEqual([]);
    expect(input.blocks!.map((b) => b.extras.kind).sort()).toEqual(['curve', 'curve', 'straight', 'straight', ...Array(7).fill('stub')].sort());
  });

  it('composition-owned: removing, moving or re-parametrizing a generated block or path is refused', () => {
    const input = composedInput(2);
    const straight = input.blocks!.find((b) => b.extras.kind === 'straight')!.id;
    const stub = input.blocks!.find((b) => b.extras.kind === 'stub')!.id;
    for (const r of [
      removeBlock(input, stub),
      removePaths(input, ['Stich_A1']),
      moveBlock(input, straight, { dx: 1, dz: 0, dHeadingDeg: 0, pivot: [0, 0] }),
      setBlockParams(input, straight, { lengthM: 16 }),
    ]) {
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('composition-owned');
      expect(r.edit.set).toEqual([]);
    }
  });

  it.each([1, 2, 4])('composeYardBlocks(size %i): every piece in exactly one block, templates exact, 0 kinks', (n) => {
    const yard = composeYard(n);
    const blocks = composeYardBlocks(yard);
    const all = blocks.flatMap((b) => b.paths);
    expect([...all].sort()).toEqual(yard.pathGraph.map((p) => p.id).sort());
    expect(new Set(all).size).toBe(all.length);
    expect(blocks.map((b) => b.id)).toEqual(blocks.map((_, i) => `PN_Block_${i + 1}`));
    const input = composedInput(n);
    for (const b of input.blocks!) expect(isBlockEdited(input, b.id), `${n}: ${b.id}`).toBe(false);
    expect(kinks(input)).toEqual([]);
  });
});
