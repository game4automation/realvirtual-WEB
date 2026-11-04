// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** plan-628 §9.2 / §9.1b — pure network ops: place, junctions, heal, move, address contract. */

import { describe, it, expect } from 'vitest';
import {
  isBlockEdited, linkEnds, moveBlock, placeBlock, placeJunction, relocateJunction, removeBlock,
  removePaths, resetBlockToTemplate, setBlockParams,
  type NetworkEdit, type NetworkInput, type PathGraphEntry, type VehicleStart,
} from '../../src/core/engine/rv-path-network-ops';
import { specListLength } from '../../src/core/engine/rv-path-edit';
import { findUnzonedMerges, findShortMergeEntries } from '../../src/core/engine/rv-movement-authority';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { RVPathNetwork } from '../../src/core/engine/rv-path-network';
import { specEnds } from '../../src/core/engine/rv-path-blocks';

function line(id: string, from: [number, number, number], to: [number, number, number], extra: Partial<PathGraphEntry> = {}): PathGraphEntry {
  return { id, nodeName: id, block: '', segments: [{ kind: 'line', from, to }], successors: [], ...extra };
}

/** Simulated commit: the snapshot after applying `edit`. */
function apply(net: NetworkInput, edit: NetworkEdit): NetworkInput {
  const paths = new Map(net.paths.map((p) => [p.id, JSON.parse(JSON.stringify(p)) as PathGraphEntry]));
  const blocks = new Map((net.blocks ?? []).map((b) => [b.id, JSON.parse(JSON.stringify(b))]));
  for (const b of edit.addBlocks) blocks.set(b.id, JSON.parse(JSON.stringify(b)));
  for (const p of edit.add) paths.set(p.id, JSON.parse(JSON.stringify(p)));
  for (const s of edit.set) {
    const p = paths.get(s.id)!;
    expect(JSON.stringify((p as unknown as Record<string, unknown>)[s.field] ?? null)).toBe(JSON.stringify(s.prev));
    if (s.value === null) delete (p as unknown as Record<string, unknown>)[s.field];
    else (p as unknown as Record<string, unknown>)[s.field] = s.value;
  }
  for (const b of edit.setBlocks) blocks.get(b.id).extras = b.value;
  for (const id of edit.remove) paths.delete(id);
  for (const id of edit.removeBlocks) blocks.delete(id);
  const vehicles = (net.vehicles ?? []).map((v) => {
    const r = edit.agvRewrites.find((x) => x.agvNode === v.agvNode);
    return r ? { agvNode: v.agvNode, pathId: r.pathId, startPositionMm: r.startPositionMm } : v;
  });
  return { ...net, paths: [...paths.values()], blocks: [...blocks.values()], vehicles };
}

function runtime(net: NetworkInput): RVPathNetwork {
  const n = new RVPathNetwork();
  for (const p of net.paths) {
    n.register(parsePathExtras({ id: p.id, segments: p.segments, successors: p.successors, zone: p.zone, zoneCapacity: p.zoneCapacity }, p.id)!);
  }
  n.resolveGraph();
  return n;
}

const get = (net: NetworkInput, id: string): PathGraphEntry => net.paths.find((p) => p.id === id)!;
const fingerprint = (net: NetworkInput): string => JSON.stringify({
  p: [...net.paths].sort((a, b) => (a.id < b.id ? -1 : 1)).map((p) => [p.id, p.block, p.segments, p.successors, p.zone ?? null]),
  b: [...(net.blocks ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1)).map((b) => [b.id, b.extras]),
});

const host10 = (): NetworkInput => ({ paths: [line('A', [0, 0, 0], [10, 0, 0], { successors: ['B'] }), line('B', [10, 0, 0], [12, 0, 0])] });

describe('placeBlock (P5)', () => {
  it('at the end of A: new path, A.successors contains it, nothing else changed', () => {
    const net: NetworkInput = { paths: [line('A', [0, 0, 0], [5, 0, 0])] };
    const r = placeBlock(net, { kind: 'straight' }, { pathId: 'A', end: 'end' });
    expect(r.ok).toBe(true);
    expect(r.blockId).toBe('PN_Block_1');
    expect(r.createdPaths).toEqual(['PN_S1']);
    expect(r.edit.set).toEqual([{ id: 'A', field: 'successors', value: ['PN_S1'], prev: [] }]);
    const after = apply(net, r.edit);
    expect(get(after, 'PN_S1').block).toBe('PN_Block_1');
    expect(specEnds(get(after, 'PN_S1').segments)!.end.position[0]).toBeCloseTo(7, 9);
  });

  it('before the start of A: the block end links into A', () => {
    const net: NetworkInput = { paths: [line('A', [0, 0, 0], [5, 0, 0])] };
    const r = placeBlock(net, { kind: 'curve', side: 'right' }, { pathId: 'A', end: 'start' });
    expect(r.ok).toBe(true);
    expect(get(apply(net, r.edit), 'PN_C1').successors).toEqual(['A']);
  });

  it('start/start and end/end are refused (P5)', () => {
    const net: NetworkInput = { paths: [line('A', [0, 0, 0], [5, 0, 0]), line('B', [5, 0, 0], [8, 0, 0])] };
    expect(linkEnds(net, { pathId: 'A', end: 'start' }, { pathId: 'B', end: 'start' }).reason).toBe('invalid-link');
    expect(linkEnds(net, { pathId: 'A', end: 'end' }, { pathId: 'B', end: 'end' }).reason).toBe('invalid-link');
    expect(linkEnds(net, { pathId: 'A', end: 'end' }, { pathId: 'B', end: 'start' }).ok).toBe(true);
  });

  it('ids skip taken node names (P4)', () => {
    const net: NetworkInput = { paths: [line('A', [0, 0, 0], [5, 0, 0])], takenNames: ['PN_S1', 'PN_Block_1'] };
    const r = placeBlock(net, { kind: 'straight' }, { pathId: 'A', end: 'end' });
    expect(r.blockId).toBe('PN_Block_2');
    expect(r.createdPaths).toEqual(['PN_S2']);
  });
});

describe('placeJunction (P7/P8)', () => {
  it('merge on a 10 m straight at s=5: original id on the end piece, zones, unzoned merges empty, length kept', () => {
    const net: NetworkInput = { paths: [line('Z', [-3, 0, 0], [0, 0, 0], { successors: ['A'] }), ...host10().paths] };
    const r = placeJunction(net, { kind: 'merge' }, { pathId: 'A', s: 5, side: 'left' });
    expect(r.ok, r.detail).toBe(true);
    expect(r.preM).toBe(1.8);
    expect(r.mergeSizing).toBe('skipped');
    expect(r.edit.renamedFront).toBe('A_F1');
    const after = apply(net, r.edit);
    expect(get(after, 'Z').successors).toEqual(['A_F1']);
    expect(get(after, 'A_F1').successors).toEqual(['PN_J1_In']);
    expect(get(after, 'PN_J1_Out').successors).toEqual(['A']);
    expect(get(after, 'A').successors).toEqual(['B']);
    for (const id of ['PN_J1_In', 'PN_J1_Out', 'PN_C1']) expect(get(after, id).zone).toBe('PN_M1');
    expect(r.zones).toEqual(['PN_M1']);
    expect(findUnzonedMerges(runtime(after).all())).toEqual([]);
    const lane = ['A_F1', 'PN_J1_In', 'PN_J1_Out', 'A'].map((id) => specListLength(get(after, id).segments)).reduce((a, b) => a + b);
    expect(lane).toBeCloseTo(10, 9);
    expect(specEnds(get(after, 'A').segments)!.end.position[0]).toBeCloseTo(10, 12);
  });

  it('stub: zone K (capacity 1) on the stub straight, mouth in M; stub starts outside', () => {
    const r = placeJunction(host10(), { kind: 'stub' }, { pathId: 'A', s: 5, side: 'right' });
    expect(r.ok).toBe(true);
    const after = apply(host10(), r.edit);
    const k = get(after, 'PN_K1');
    expect(k.zone).toBe('PN_K1');
    expect(k.zoneCapacity).toBe(1);
    expect(k.successors).toEqual(['PN_K1_Mouth']);
    expect(get(after, 'PN_K1_Mouth').zone).toBe('PN_M1');
    expect(get(after, 'PN_K1_Mouth').successors).toEqual(['PN_J1_Out']);
    const st = specEnds(k.segments)!.start.position;
    expect(st[2]).toBeCloseTo(3, 9); // right of +X = +Z, depth 3 m
    expect(findUnzonedMerges(runtime(after).all())).toEqual([]);
  });

  it('twin stub: two stubs, both mouths in the same M', () => {
    const r = placeJunction(host10(), { kind: 'stub', twin: true }, { pathId: 'A', s: 5, side: 'left' });
    const after = apply(host10(), r.edit);
    expect(get(after, 'PN_K1_Mouth').zone).toBe('PN_M1');
    expect(get(after, 'PN_K2_Mouth').zone).toBe('PN_M1');
    expect(runtime(after).get('PN_J1_Out')!.predecessors.length).toBe(3);
  });

  it('diverge: front links to rest and branch, no zone', () => {
    const r = placeJunction(host10(), { kind: 'diverge' }, { pathId: 'A', s: 4, side: 'left' });
    const after = apply(host10(), r.edit);
    expect(get(after, 'A_F1').successors).toEqual(['A', 'PN_C1']);
    expect(r.zones).toEqual([]);
  });

  it('preM sizing with envelope 1.75 x 0.86 m: no short entry, smallest valid step', () => {
    const env = { front: 0.875, rear: 0.875, width: 0.86 };
    const r = placeJunction(host10(), { kind: 'merge' }, { pathId: 'A', s: 5, side: 'left' }, { env });
    expect(r.ok).toBe(true);
    expect(r.mergeSizing).toBe('sized');
    const after = apply(host10(), r.edit);
    expect(findShortMergeEntries(runtime(after).all(), env)).toEqual([]);
    if (r.preM! > 1.0) {
      const smaller = Math.round(r.preM! * 10 - 1) / 10;
      expect(smaller).toBeGreaterThanOrEqual(1.0);
    }
  });

  it('host-too-short (R1 #4): 2 m host, edge position, overlap with an existing zone', () => {
    const short: NetworkInput = { paths: [line('S', [0, 0, 0], [2, 0, 0])] };
    for (const [net, s, id] of [[short, 1, 'S'], [host10(), 1, 'A'], [host10(), 9.7, 'A']] as const) {
      const r = placeJunction(net, { kind: 'stub' }, { pathId: id, s, side: 'left' });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('host-too-short');
      expect(r.edit.add).toEqual([]);
    }
    const once = apply(host10(), placeJunction(host10(), { kind: 'stub' }, { pathId: 'A', s: 5 }).edit);
    const r = placeJunction(once, { kind: 'merge' }, { pathId: 'PN_J1_Out', s: 0.3 });
    expect(r.reason).toBe('host-too-short');
  });
});

describe('address contract (SOL-R2 #2)', () => {
  const vehicles: VehicleStart[] = [
    { agvNode: 'V1', pathId: 'A', startPositionMm: 1000 },
    { agvNode: 'V2', pathId: 'A', startPositionMm: 4000 },
    { agvNode: 'V3', pathId: 'A', startPositionMm: 7000 },
  ];
  it('split: every fragment gets explicit PathId + rebased StartPosition; heal maps back exactly', () => {
    const net: NetworkInput = { ...host10(), vehicles };
    const r = placeJunction(net, { kind: 'merge' }, { pathId: 'A', s: 5 });
    const map = Object.fromEntries(r.edit.agvRewrites.map((x) => [x.agvNode, [x.pathId, x.startPositionMm]]));
    expect(map.V1).toEqual(['A_F1', 1000]);
    expect(map.V2[0]).toBe('PN_J1_In');
    expect(map.V2[1]).toBeCloseTo(4000 - 3200, 6);
    expect(map.V3).toEqual(['A', expect.closeTo(7000 - 5600, 6)]);
    const after = apply(net, r.edit);
    const back = removeBlock(after, r.blockId!);
    expect(back.ok, back.detail).toBe(true);
    const healed = apply(after, back.edit);
    expect(healed.vehicles!.map((v) => [v.pathId, Math.round(v.startPositionMm)])).toEqual([['A', 1000], ['A', 4000], ['A', 7000]]);
    expect(fingerprint(healed)).toBe(fingerprint(net));
  });

  it('vehicle on a stub that would be removed refuses with an empty edit', () => {
    const once = apply(host10(), placeJunction(host10(), { kind: 'stub' }, { pathId: 'A', s: 5 }).edit);
    const net = { ...once, vehicles: [{ agvNode: 'V', pathId: 'PN_K1', startPositionMm: 500 }] };
    const r = removeBlock(net, 'PN_Block_1');
    expect(r.reason).toBe('vehicle-on-removed-path');
    expect(r.edit.remove).toEqual([]);
  });
});

describe('removal and import (P7, Thomas 2026-10-19)', () => {
  it('removePaths drops references in every predecessor', () => {
    const net: NetworkInput = { paths: [line('A', [0, 0, 0], [1, 0, 0], { successors: ['C'] }), line('B', [0, 1, 0], [1, 0, 0], { successors: ['C'] }), line('C', [1, 0, 0], [2, 0, 0])] };
    const after = apply(net, removePaths(net, ['C']).edit);
    expect(get(after, 'A').successors).toEqual([]);
    expect(get(after, 'B').successors).toEqual([]);
  });

  it('an imported path cannot be removed; split and heal of an imported host are allowed', () => {
    const net: NetworkInput = { paths: [line('A', [0, 0, 0], [10, 0, 0], { imported: true })] };
    const r = removePaths(net, ['A']);
    expect(r.reason).toBe('imported-path');
    expect(r.edit.remove).toEqual([]);
    const j = placeJunction(net, { kind: 'stub' }, { pathId: 'A', s: 5 });
    expect(j.ok).toBe(true);
    const after = apply(net, j.edit);
    const h = removeBlock(after, j.blockId!);
    expect(h.ok).toBe(true);
    expect(fingerprint(apply(after, h.edit))).toBe(fingerprint(net));
  });

  it('plan-628 8.6: composition-owned blocks and paths are never written; author blocks next to them are', () => {
    const base: NetworkInput = { paths: [line('Z', [-2, 0, 0], [0, 0, 0])] };
    const placed = apply(base, placeBlock(base, { kind: 'straight', lengthM: 6 }, { pathId: 'Z', end: 'end' }).edit);
    // The block and its path are generated (Generated.owner, as the snapshot reads it); Z is the author's.
    const net: NetworkInput = {
      ...placed,
      paths: placed.paths.map((p) => (p.block === 'PN_Block_1' ? { ...p, owner: 'palletYard' } : p)),
      blocks: placed.blocks!.map((b) => ({ ...b, owner: 'palletYard' })),
    };
    const refused = [
      removeBlock(net, 'PN_Block_1'),
      removePaths(net, ['PN_S1']),
      moveBlock(net, 'PN_Block_1', { dx: 1, dz: 0, dHeadingDeg: 0, pivot: [0, 0] }),
      setBlockParams(net, 'PN_Block_1', { lengthM: 3 }),
      placeJunction(net, { kind: 'stub' }, { pathId: 'PN_S1', s: 3 }),
      // attaching at a generated END would write the generated path's successors
      placeBlock(net, { kind: 'straight', lengthM: 2 }, { pathId: 'PN_S1', end: 'end' }),
    ];
    for (const r of refused) {
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('composition-owned');
      expect(r.detail).toContain('palletYard');
      expect(r.edit.set).toEqual([]);
    }
    // The author's own path stays fully editable next to the generated block.
    const head = placeBlock(net, { kind: 'straight', lengthM: 2 }, { pathId: 'Z', end: 'start' });
    expect(head.ok, head.detail).toBe(true);
    expect(head.edit.set.some((s) => s.id === 'PN_S1')).toBe(false);
    expect(removePaths(net, ['Z']).ok).toBe(true);
  });

  it('removeBlock of a host with two stubs: junctions healed first, then the host paths go, no orphans', () => {
    const base: NetworkInput = { paths: [line('Z', [-2, 0, 0], [0, 0, 0])] };
    let net = apply(base, placeBlock(base, { kind: 'straight', lengthM: 12 }, { pathId: 'Z', end: 'end' }).edit);
    net = apply(net, placeJunction(net, { kind: 'stub' }, { pathId: 'PN_S1', s: 3 }).edit);
    net = apply(net, placeJunction(net, { kind: 'stub', side: 'right' }, { pathId: 'PN_S1', s: 4 }).edit);
    expect(net.blocks!.length).toBe(3);
    const r = removeBlock(net, 'PN_Block_1');
    expect(r.ok, r.detail).toBe(true);
    const after = apply(net, r.edit);
    expect(after.paths.map((p) => p.id)).toEqual(['Z']);
    expect(get(after, 'Z').successors).toEqual([]);
    expect(after.blocks).toEqual([]);
  });
});

describe('moveBlock / relocate (§2.4a, §9.1b)', () => {
  it('host with a stub moves as a unit; port edges released and re-formed; undo-able diff', () => {
    const base: NetworkInput = { paths: [line('Z', [-2, 0, 0], [0, 0, 0])] };
    let net = apply(base, placeBlock(base, { kind: 'straight', lengthM: 10 }, { pathId: 'Z', end: 'end' }).edit);
    net = apply(net, placeJunction(net, { kind: 'stub' }, { pathId: 'PN_S1', s: 5 }).edit);
    const away = moveBlock(net, 'PN_Block_1', { dx: 0, dz: 5, dHeadingDeg: 90, pivot: [0, 0] });
    expect(away.ok, away.detail).toBe(true);
    expect(away.unlinked).toEqual([['Z', 'PN_S2']]);
    const moved = apply(net, away.edit);
    expect(get(moved, 'Z').successors).toEqual([]);
    expect(moved.blocks!.find((b) => b.id === 'PN_Block_2')!.extras.pose[2]).toBeCloseTo(90, 9);
    // internal edges survive, lengths unchanged
    expect(get(moved, 'PN_K1_Mouth').successors).toEqual(['PN_J1_Out']);
    const back = moveBlock(moved, 'PN_Block_1', { dx: 0, dz: -5, dHeadingDeg: -90, pivot: [0, 5] });
    const restored = apply(moved, back.edit);
    expect(back.linked).toEqual([['Z', 'PN_S2']]);
    for (const p of net.paths) expect(specListLength(get(restored, p.id).segments)).toBeCloseTo(specListLength(p.segments), 9);
  });

  it('junction blocks are not moved freely; non-identity transform refuses', () => {
    const net = apply(host10(), placeJunction(host10(), { kind: 'stub' }, { pathId: 'A', s: 5 }).edit);
    expect(moveBlock(net, 'PN_Block_1', { dx: 1, dz: 0, dHeadingDeg: 0, pivot: [0, 0] }).reason).toBe('wrong-kind');
    const b: NetworkInput = { paths: [line('Z', [0, 0, 0], [1, 0, 0])] };
    const one = apply(b, placeBlock(b, { kind: 'straight' }, { pathId: 'Z', end: 'end' }).edit);
    one.blocks![0].transformIdentity = false;
    expect(moveBlock(one, 'PN_Block_1', { dx: 1, dz: 0, dHeadingDeg: 0, pivot: [0, 0] }).reason).toBe('transform-not-identity');
  });

  it('relocateJunction: same ids (field writes only), host healed and split anew, length unchanged', () => {
    const net = apply(host10(), placeJunction(host10(), { kind: 'merge' }, { pathId: 'A', s: 5 }).edit);
    const r = relocateJunction(net, 'PN_Block_1', 7);
    expect(r.ok, r.detail).toBe(true);
    expect(r.edit.add).toEqual([]);
    expect(r.edit.remove).toEqual([]);
    const after = apply(net, r.edit);
    expect(specListLength(get(after, 'A_F1').segments)).toBeCloseTo(7 - 1.8, 9);
    const lane = ['A_F1', 'PN_J1_In', 'PN_J1_Out', 'A'].map((id) => specListLength(get(after, id).segments)).reduce((a, b) => a + b);
    expect(lane).toBeCloseTo(10, 9);
  });

  it('edited is derived; moving keeps single edits; reset restores the template; params only when unedited', () => {
    const b: NetworkInput = { paths: [line('Z', [0, 0, 0], [1, 0, 0])] };
    let net = apply(b, placeBlock(b, { kind: 'straight' }, { pathId: 'Z', end: 'end' }).edit);
    expect(isBlockEdited(net, 'PN_Block_1')).toBe(false);
    // junction on it does not make it "edited"
    expect(setBlockParams(net, 'PN_Block_1', { lengthM: 3 }).ok).toBe(true);
    // a handle drag moves the end
    const p = get(net, 'PN_S1');
    p.segments = [{ kind: 'line', from: [1, 0, 0], to: [3, 0, 0.5] }];
    expect(isBlockEdited(net, 'PN_Block_1')).toBe(true);
    expect(setBlockParams(net, 'PN_Block_1', { lengthM: 3 }).reason).toBe('block-edited');
    net = apply(net, moveBlock(net, 'PN_Block_1', { dx: 2, dz: 0, dHeadingDeg: 0, pivot: [0, 0] }).edit);
    expect(get(net, 'PN_S1').segments).toEqual([{ kind: 'line', from: [3, 0, 0], to: [5, 0, 0.5] }]);
    expect(isBlockEdited(net, 'PN_Block_1')).toBe(true);
    net = apply(net, resetBlockToTemplate(net, 'PN_Block_1').edit);
    expect(isBlockEdited(net, 'PN_Block_1')).toBe(false);
  });

  it('a host with a junction reads unedited (in-line geometry through the junction)', () => {
    const b: NetworkInput = { paths: [line('Z', [0, 0, 0], [1, 0, 0])] };
    let net = apply(b, placeBlock(b, { kind: 'straight', lengthM: 10 }, { pathId: 'Z', end: 'end' }).edit);
    net = apply(net, placeJunction(net, { kind: 'stub' }, { pathId: 'PN_S1', s: 5 }).edit);
    expect(isBlockEdited(net, 'PN_Block_1')).toBe(false);
    expect(isBlockEdited(net, 'PN_Block_2')).toBe(false);
  });
});
