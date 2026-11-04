// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-628 §9.9o / §9.9p / §9.9q (pure part) — the core behind the length /
 * radius handle (8.11d), "Replace with …" (8.11e) and copy / paste (8.11f):
 *
 *  - `setBlockParams(…, { chain })`: the block keeps its start pose, the
 *    downstream chain slides rigidly onto the new end; predecessor edge,
 *    block → chain edge and the edges inside the chain stay; 0 non-tangential
 *    edges; an edited block is refused (E25 / P2a);
 *  - `replaceBlock`: same start pose and ids; with `chain` the chain follows
 *    the new end, without it a non-fitting successor edge is released (never a
 *    kink); junctions refused;
 *  - `copyBlocks` / `pasteBlocks`: new P4 ids, inner edges kept, docking by
 *    auto-link at a free end (`clipAnchor` + `pasteMotion`), junctions not copied;
 *  - the handle / replace / paste geometry of the UI model.
 */

import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import {
  clipAnchor,
  copyBlocks,
  nonTangentialWrites,
  pasteBlocks,
  placeBlock,
  placeJunction,
  replaceBlock,
  setBlockParams,
  type NetworkEdit,
  type NetworkInput,
  type PathGraphEntry,
} from '../../src/core/engine/rv-path-network-ops';
import { headingOf, specEnds, type PathBlockSpec } from '../../src/core/engine/rv-path-blocks';
import { isPathLink } from '../../src/core/connect/path-link-tolerance';
import {
  PARAM_DRAG_MIN_LENGTH_M,
  paramDragPreview,
  paramFromPointer,
  paramHandle,
  pasteMotion,
  replaceArgs,
  replaceOptions,
  type FreePort,
} from '../../src/plugins/path-network/path-network-ui-model';

/** Simulated commit: the snapshot after applying `edit` (as path-network-ops.node.test). */
function apply(net: NetworkInput, edit: NetworkEdit): NetworkInput {
  const paths = new Map(net.paths.map((p) => [p.id, JSON.parse(JSON.stringify(p)) as PathGraphEntry]));
  const blocks = new Map((net.blocks ?? []).map((b) => [b.id, JSON.parse(JSON.stringify(b))]));
  for (const b of edit.addBlocks) blocks.set(b.id, JSON.parse(JSON.stringify(b)));
  for (const p of edit.add) paths.set(p.id, JSON.parse(JSON.stringify(p)));
  for (const s of edit.set) {
    const p = paths.get(s.id)! as unknown as Record<string, unknown>;
    expect(JSON.stringify(p[s.field] ?? null)).toBe(JSON.stringify(s.prev));
    if (s.value === null) delete p[s.field];
    else p[s.field] = s.value;
  }
  for (const b of edit.setBlocks) blocks.get(b.id).extras = b.value;
  for (const id of edit.remove) paths.delete(id);
  for (const id of edit.removeBlocks) blocks.delete(id);
  return { ...net, paths: [...paths.values()], blocks: [...blocks.values()] };
}

function step(net: NetworkInput, r: { ok: boolean; reason?: string; detail?: string; edit: NetworkEdit }): NetworkInput {
  expect(r.ok, `${r.reason}: ${r.detail}`).toBe(true);
  return apply(net, r.edit);
}

const get = (net: NetworkInput, id: string): PathGraphEntry => net.paths.find((p) => p.id === id)!;
const v3 = (t: readonly number[]): Vector3 => new Vector3(t[0], t[1], t[2]);

/** Every edge of the network is coincident + tangential (the 633 / 8.10 rule). */
function allEdgesTangential(net: NetworkInput): boolean {
  for (const p of net.paths) {
    for (const s of p.successors) {
      const a = specEnds(p.segments)!;
      const b = specEnds(get(net, s).segments)!;
      if (!isPathLink(v3(a.end.position), v3(a.end.tangent), v3(b.start.position), v3(b.start.tangent))) return false;
    }
  }
  return true;
}

/** S0 (1 m) → S1 (2 m) → C1 (90° right) → S2 (2 m): a predecessor, the block under test, a chain of two. */
function chain(): NetworkInput {
  let net: NetworkInput = { paths: [], blocks: [] };
  net = step(net, placeBlock(net, { kind: 'straight', lengthM: 1 }, { x: -1, z: 0, headingDeg: 0 }));
  net = step(net, placeBlock(net, { kind: 'straight', lengthM: 2 }, { pathId: 'PN_S1', end: 'end' }));
  net = step(net, placeBlock(net, { kind: 'curve', degrees: 90, side: 'right' }, { pathId: 'PN_S2', end: 'end' }));
  net = step(net, placeBlock(net, { kind: 'straight', lengthM: 2 }, { pathId: 'PN_C1', end: 'end' }));
  expect(get(net, 'PN_S1').successors).toEqual(['PN_S2']);
  expect(get(net, 'PN_S2').successors).toEqual(['PN_C1']);
  expect(get(net, 'PN_C1').successors).toEqual(['PN_S3']);
  return net;
}

describe('plan-628 9.9o setBlockParams with the chain following (8.11d)', () => {
  it('length 2 → 3.25 m: start stays, chain slides +1.25 m, every edge stays and is tangential', () => {
    const net = chain();
    const c1Before = specEnds(get(net, 'PN_C1').segments)!;
    const r = setBlockParams(net, 'PN_Block_2', { lengthM: 3.25 }, { chain: true });
    const after = step(net, r);
    expect(r.unlinked).toEqual([]);
    expect(get(after, 'PN_S1').successors).toEqual(['PN_S2']); // predecessor edge untouched
    expect(get(after, 'PN_S2').successors).toEqual(['PN_C1']);
    expect(get(after, 'PN_C1').successors).toEqual(['PN_S3']);
    const c1 = specEnds(get(after, 'PN_C1').segments)!;
    expect(c1.start.position[0]).toBeCloseTo(c1Before.start.position[0] + 1.25, 6);
    expect(c1.start.position[2]).toBeCloseTo(c1Before.start.position[2], 6);
    expect(headingOf(c1.start.tangent)).toBeCloseTo(headingOf(c1Before.start.tangent), 6);
    expect(after.blocks!.find((b) => b.id === 'PN_Block_2')!.extras.pose).toEqual([0, 0, 0]);
    expect(after.blocks!.find((b) => b.id === 'PN_Block_3')!.extras.pose[0]).toBeCloseTo(3.25, 6);
    expect(allEdgesTangential(after)).toBe(true);
  });

  it('curve radius → 2 m: the straight after it follows the new end tangentially', () => {
    const net = chain();
    const after = step(net, setBlockParams(net, 'PN_Block_3', { radiusM: 2 }, { chain: true }));
    const c = specEnds(get(after, 'PN_C1').segments)!;
    const s = specEnds(get(after, 'PN_S3').segments)!;
    expect(get(after, 'PN_C1').successors).toEqual(['PN_S3']);
    expect(s.start.position[0]).toBeCloseTo(c.end.position[0], 6);
    expect(s.start.position[2]).toBeCloseTo(c.end.position[2], 6);
    expect(get(after, 'PN_S2').successors).toEqual(['PN_C1']);
    expect(allEdgesTangential(after)).toBe(true);
  });

  it('without chain the chain stays and the edge to it is released — never a kink', () => {
    const net = chain();
    const r = setBlockParams(net, 'PN_Block_2', { lengthM: 3 });
    const after = step(net, r);
    expect(get(after, 'PN_S2').successors).toEqual([]);
    expect(r.unlinked).toEqual([['PN_S2', 'PN_C1']]);
    expect(nonTangentialWrites(net, { paths: new Map(after.paths.map((p) => [p.id, p])) })).toEqual([]);
  });

  it('an edited block is refused (E25 / P2a: reset first)', () => {
    const net = chain();
    const edited: NetworkInput = {
      ...net,
      paths: net.paths.map((p) => (p.id === 'PN_S2' ? { ...p, segments: [{ kind: 'line', from: [0, 0, 0], to: [1.9, 0, 0] }] } : p)),
    };
    const r = setBlockParams(edited, 'PN_Block_2', { lengthM: 3 }, { chain: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('block-edited');
  });

  it('a loop is moved once and stays closed where it can', () => {
    // A square loop of 4 × (straight 1 m + curve 90° left R 0.5) — chain from block 1 is everything else.
    let net: NetworkInput = { paths: [], blocks: [] };
    net = step(net, placeBlock(net, { kind: 'straight', lengthM: 1 }, { x: 0, z: 0, headingDeg: 0 }));
    let last = 'PN_S1';
    for (let i = 0; i < 4; i++) {
      net = step(net, placeBlock(net, { kind: 'curve', degrees: 90, side: 'left', radiusM: 0.5 }, { pathId: last, end: 'end' }));
      last = `PN_C${i + 1}`;
      if (i < 3) {
        net = step(net, placeBlock(net, { kind: 'straight', lengthM: 1 }, { pathId: last, end: 'end' }));
        last = `PN_S${i + 2}`;
      }
    }
    expect(get(net, 'PN_C4').successors).toEqual(['PN_S1']); // closed
    const r = setBlockParams(net, 'PN_Block_1', { lengthM: 2 }, { chain: true });
    const after = step(net, r);
    // The loop cannot close any more (only one side grew): the closing edge is released, nothing kinks.
    expect(get(after, 'PN_C4').successors).toEqual([]);
    expect(allEdgesTangential(after)).toBe(true);
  });
});

describe('plan-628 9.9p replaceBlock (8.11e)', () => {
  it('curve → straight with chain: same start pose + ids, chain moved onto the new end, edges kept', () => {
    const net = chain();
    const r = replaceBlock(net, 'PN_Block_3', { kind: 'straight', lengthM: 2 }, { chain: true });
    const after = step(net, r);
    const b3 = after.blocks!.find((b) => b.id === 'PN_Block_3')!;
    expect(b3.extras.kind).toBe('straight');
    expect(b3.extras.pose).toEqual(net.blocks!.find((b) => b.id === 'PN_Block_3')!.extras.pose);
    expect(get(after, 'PN_C1').block).toBe('PN_Block_3'); // path id kept (E69)
    expect(get(after, 'PN_S2').successors).toEqual(['PN_C1']); // predecessor kept
    expect(get(after, 'PN_C1').successors).toEqual(['PN_S3']); // successor follows
    const s3 = specEnds(get(after, 'PN_S3').segments)!;
    expect(s3.start.position[0]).toBeCloseTo(4, 6);
    expect(headingOf(s3.start.tangent)).toBeCloseTo(0, 6);
    expect(allEdgesTangential(after)).toBe(true);
  });

  it('without chain a successor that no longer fits is released (open end, no kink)', () => {
    const net = chain();
    const r = replaceBlock(net, 'PN_Block_3', { kind: 'curve', degrees: 90, side: 'left' });
    const after = step(net, r);
    expect(get(after, 'PN_C1').successors).toEqual([]);
    expect(get(after, 'PN_S2').successors).toEqual(['PN_C1']);
    expect(allEdgesTangential(after)).toBe(true);
  });

  it('a junction cannot be replaced', () => {
    let net = chain();
    net = step(net, placeJunction(net, { kind: 'diverge' }, { pathId: 'PN_S3', s: 1 }));
    const j = net.blocks!.find((b) => b.extras.kind === 'diverge')!;
    const r = replaceBlock(net, j.id, { kind: 'straight' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('wrong-kind');
  });
});

describe('plan-628 9.9q copyBlocks / pasteBlocks (8.11f)', () => {
  it('copy the chain S1→C1→S3, paste free: new ids, inner edges kept, originals untouched', () => {
    const net = chain();
    const clip = copyBlocks(net, ['PN_Block_2', 'PN_Block_3', 'PN_Block_4']);
    expect(clip.blocks.map((b) => b.id)).toEqual(['PN_Block_2', 'PN_Block_3', 'PN_Block_4']);
    const r = pasteBlocks(net, clip, { dx: 0, dz: 5, dHeadingDeg: 0, pivot: [0, 0] });
    const after = step(net, r);
    expect(r.blockIds).toEqual(['PN_Block_5', 'PN_Block_6', 'PN_Block_7']);
    expect(r.createdPaths).toEqual(['PN_S4', 'PN_C2', 'PN_S5']);
    expect(get(after, 'PN_S4').successors).toEqual(['PN_C2']);
    expect(get(after, 'PN_C2').successors).toEqual(['PN_S5']);
    expect(specEnds(get(after, 'PN_S4').segments)!.start.position[2]).toBeCloseTo(5, 6);
    expect(after.paths.length).toBe(net.paths.length + 3);
    expect(get(after, 'PN_S1').successors).toEqual(['PN_S2']);
    expect(allEdgesTangential(after)).toBe(true);
  });

  it('docked at a free end: the copy\'s first free start takes the end pose and the edge is written', () => {
    const net = chain();
    const clip = copyBlocks(net, ['PN_Block_2', 'PN_Block_3']);
    const anchor = clipAnchor(clip)!;
    expect(anchor.position[0]).toBeCloseTo(0, 6);
    const end = specEnds(get(net, 'PN_S3').segments)!.end;
    const target: FreePort = { pathId: 'PN_S3', end: 'end', position: end.position, headingDeg: headingOf(end.tangent) };
    const m = pasteMotion(anchor, target, [0, 0, 0]);
    const r = pasteBlocks(net, clip, m);
    const after = step(net, r);
    expect(get(after, 'PN_S3').successors).toEqual(['PN_S4']); // docked tangentially
    expect(get(after, 'PN_S4').successors).toEqual(['PN_C2']);
    expect(allEdgesTangential(after)).toBe(true);
  });

  it('junction blocks are not copied; a host is copied as its template line', () => {
    let net = chain();
    net = step(net, placeJunction(net, { kind: 'diverge' }, { pathId: 'PN_S3', s: 1 }));
    const j = net.blocks!.find((b) => b.extras.kind === 'diverge')!;
    const clip = copyBlocks(net, ['PN_Block_4', j.id]);
    expect(clip.blocks.map((b) => b.id)).toEqual(['PN_Block_4']);
    expect(clip.blocks[0].paths).toHaveLength(1);
    const after = step(net, pasteBlocks(net, clip, { dx: 0, dz: 6, dHeadingDeg: 0, pivot: [0, 0] }));
    const pasted = after.paths.filter((p) => p.block === 'PN_Block_6');
    expect(pasted).toHaveLength(1);
    expect(pasted[0].id).toMatch(/^PN_S\d+$/);
  });

  it('pasting twice at the same spot never joins an occupied end (no accidental merge / diverge)', () => {
    const net = chain();
    const clip = copyBlocks(net, ['PN_Block_2', 'PN_Block_3']);
    const end = specEnds(get(net, 'PN_S3').segments)!.end;
    const target: FreePort = { pathId: 'PN_S3', end: 'end', position: end.position, headingDeg: headingOf(end.tangent) };
    const m = pasteMotion(clipAnchor(clip)!, target, [0, 0, 0]);
    const once = step(net, pasteBlocks(net, clip, m));
    expect(get(once, 'PN_S3').successors).toEqual(['PN_S4']);
    const twice = step(once, pasteBlocks(once, clip, m));
    expect(get(twice, 'PN_S3').successors).toEqual(['PN_S4']); // the occupied end is not joined again
    const second = twice.paths.filter((p) => !once.paths.some((q) => q.id === p.id));
    expect(second).toHaveLength(2);
    // Neither copy links into the other (their coinciding ends are all occupied or inner).
    for (const p of second) expect(p.successors.every((s) => second.some((q) => q.id === s))).toBe(true);
    for (const p of once.paths) expect(get(twice, p.id).successors).toEqual(p.successors);
  });

  it('an empty clip is refused', () => {
    const r = pasteBlocks(chain(), { blocks: [] }, { dx: 0, dz: 0, dHeadingDeg: 0, pivot: [0, 0] });
    expect(r.ok).toBe(false);
  });
});

describe('plan-628 8.11d/e/f UI geometry', () => {
  it('straight handle sits at the end and drags on the 0.25 m raster (Shift free, minimum)', () => {
    const h = paramHandle({ kind: 'straight', params: { lengthM: 2 }, pose: [1, 1, 90] })!;
    expect(h.field).toBe('lengthM');
    expect(h.position[0]).toBeCloseTo(1, 6);
    expect(h.position[2]).toBeCloseTo(3, 6);
    expect(paramFromPointer(h, [1.3, 0, 4.13], false)).toBe(3.25);
    expect(paramFromPointer(h, [1, 0, 4.13], true)).toBeCloseTo(3.13, 6);
    expect(paramFromPointer(h, [1, 0, 0], false)).toBe(PARAM_DRAG_MIN_LENGTH_M);
  });

  it('curve handle sits at the arc midpoint; dragging along its ray scales the radius', () => {
    const block = { kind: 'curve' as const, params: { radiusM: 1, degrees: 90, side: 'right' as const }, pose: [0, 0, 0] as [number, number, number] };
    const h = paramHandle(block)!;
    expect(h.field).toBe('radiusM');
    const mid = [Math.sin(Math.PI / 4), 0, 1 - Math.cos(Math.PI / 4)]; // right turn = +Z
    expect(h.position[0]).toBeCloseTo(mid[0], 6);
    expect(h.position[2]).toBeCloseTo(mid[2], 6);
    expect(paramFromPointer(h, [mid[0] * 2, 0, mid[2] * 2], false)).toBe(2);
    const pv = paramDragPreview(block, 'radiusM', 2)!;
    const e = specEnds(pv.specs)!.end;
    expect(e.position[0]).toBeCloseTo(2, 6);
    expect(e.position[2]).toBeCloseTo(2, 6);
    expect(pv.chain.dx).toBeCloseTo(1, 6);
    expect(pv.chain.dHeadingDeg).toBeCloseTo(0, 6);
  });

  it('replace options leave out the identical choice and keep a curve\'s radius when the side flips', () => {
    expect(replaceOptions({ kind: 'straight', params: { lengthM: 3 } }).map((o) => o.id)).toEqual(['curve-l', 'curve-r']);
    const fromCurve = replaceOptions({ kind: 'curve', params: { radiusM: 1.5, degrees: 45, side: 'left' } });
    expect(fromCurve.map((o) => o.id)).toEqual(['straight', 'curve-r']);
    expect(fromCurve[1].spec).toEqual({ kind: 'curve', radiusM: 1.5, degrees: 45, side: 'right' } satisfies PathBlockSpec);
    expect(replaceOptions({ kind: 'diverge', params: {} })).toEqual([]);
    expect(replaceArgs('PN_Block_3', fromCurve[0].spec)).toEqual({ blockId: 'PN_Block_3', block: 'straight', chain: true, lengthM: 2 });
  });

  it('paste without a target keeps the heading and puts the anchor at the cursor', () => {
    const m = pasteMotion({ position: [1, 0, 2], headingDeg: 30 }, null, [4, 0, 6]);
    expect(m).toEqual({ pivot: [1, 2], dHeadingDeg: 0, dx: 3, dz: 4 });
  });
});
