// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-628 §9.9h (8.8, E35) — dragging a block takes the downstream chain along.
 *
 * Pure part (`chainMoveSet`, `moveBlock({ chain })`, `dropSnap`):
 *  - chain of 3 blocks, move the middle one → the downstream block follows
 *    rigidly, the edge inside the chain stays, 0 `path-link-gap`;
 *  - without `chain` (Shift) → P6: the block alone, its port edges released;
 *  - the chain stops at a junction block; a loop moves every block once;
 *  - `dropSnap` re-snaps a moving free end tangent-true onto a free port.
 *
 * UI part (real document + path visualizer + the planner UI controller): the
 * move handle drags the chain in ONE `layout.path.move`; Shift drags the block
 * alone (freed ends pinned for the snap markers); a drop within 0.35 m of a
 * free end re-snaps exactly and re-forms the edge.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Vector3 } from 'three';
import {
  chainMoveSet, moveBlock, placeBlock, placeJunction,
  type NetworkEdit, type NetworkInput,
} from '../../src/core/engine/rv-path-network-ops';
import { validatePathNetwork } from '../../src/core/engine/rv-path-network-validate';
import { headingOf, specEnds } from '../../src/core/engine/rv-path-blocks';
import { foldEdit, snapshotNetwork } from '../../src/plugins/path-network/path-network-scene';
import { dropSnap, dropTargets, movingFreeEnds } from '../../src/plugins/path-network/path-network-ui-model';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import type { RVViewer } from '../../src/core/rv-viewer';
import { setActiveEditTarget } from '../../src/core/hmi/rv-edit-target';
import { commandRegistry } from '../../src/core/hmi/rv-command-registry';
import { ensurePathNetworkCommandsRegistered } from '../../src/plugins/path-network/path-network-commands';
import { PathNetworkInteraction } from '../../src/plugins/path-network/path-network-interaction';
import { makeRig, type Rig } from './path-network-rig';

// ─── pure ────────────────────────────────────────────────────────────────

function step(net: NetworkInput, r: { ok: boolean; reason?: string; edit: NetworkEdit; blockId?: string }): NetworkInput {
  expect(r.ok, r.reason).toBe(true);
  return foldEdit(net, r.edit);
}

/** Three straights S1 → S2 → S3 (2 m each) along +X from the origin. */
function chain3(): NetworkInput {
  let net: NetworkInput = { paths: [], blocks: [] };
  net = step(net, placeBlock(net, { kind: 'straight', lengthM: 2 }, { x: 0, z: 0, headingDeg: 0 }));
  net = step(net, placeBlock(net, { kind: 'straight', lengthM: 2 }, { pathId: 'PN_S1', end: 'end' }));
  net = step(net, placeBlock(net, { kind: 'straight', lengthM: 2 }, { pathId: 'PN_S2', end: 'end' }));
  return net;
}

const succ = (net: NetworkInput, id: string): string[] => net.paths.find((p) => p.id === id)!.successors;
const blockOf = (net: NetworkInput, pathId: string): string => net.paths.find((p) => p.id === pathId)!.block;
const gaps = (net: NetworkInput): number => validatePathNetwork(net).issues.filter((i) => i.code === 'path-link-gap').length;
const kinks = (net: NetworkInput): number => validatePathNetwork(net).issues.filter((i) => i.code === 'path-kink').length;

describe('plan-628 9.9h chain move (pure)', () => {
  it('moving the middle block takes the downstream block along; the chain edge stays, 0 path-link-gap', () => {
    const net = chain3();
    const mid = blockOf(net, 'PN_S2');
    expect(chainMoveSet(net, mid).pathIds.sort()).toEqual(['PN_S2', 'PN_S3']);
    const s3Before = specEnds(net.paths.find((p) => p.id === 'PN_S3')!.segments)!;
    const r = moveBlock(net, mid, { dx: 0, dz: 3, dHeadingDeg: 0, pivot: [2, 0] }, { chain: true });
    const after = step(net, r);
    const s3After = specEnds(after.paths.find((p) => p.id === 'PN_S3')!.segments)!;
    expect(s3After.start.position[2] - s3Before.start.position[2]).toBeCloseTo(3, 9); // rigid follow
    expect(succ(after, 'PN_S2')).toEqual(['PN_S3']); // edge inside the chain kept
    expect(succ(after, 'PN_S1')).toEqual([]); // the upstream port edge is released (P6 at the chain head)
    expect(gaps(after)).toBe(0);
    expect(kinks(after)).toBe(0);
  });

  it('without chain (Shift) the block moves alone — both port edges released (P6)', () => {
    const net = chain3();
    const mid = blockOf(net, 'PN_S2');
    const after = step(net, moveBlock(net, mid, { dx: 0, dz: 3, dHeadingDeg: 0, pivot: [2, 0] }));
    expect(succ(after, 'PN_S1')).toEqual([]);
    expect(succ(after, 'PN_S2')).toEqual([]);
    const s3 = specEnds(after.paths.find((p) => p.id === 'PN_S3')!.segments)!;
    expect(s3.start.position[2]).toBeCloseTo(0, 9); // S3 stayed
    expect(gaps(after)).toBe(0);
  });

  it('the chain stops at a junction block (a merge branch is not taken along)', () => {
    // Host H (10 m) with a merge; a straight X ends at the START of the merge branch.
    let net: NetworkInput = { paths: [], blocks: [] };
    net = step(net, placeBlock(net, { kind: 'straight', lengthM: 10 }, { x: 0, z: 0, headingDeg: 0 }));
    net = step(net, placeJunction(net, { kind: 'merge' }, { pathId: 'PN_S1', s: 5, side: 'left' }));
    const merge = (net.blocks ?? []).find((b) => b.extras.kind === 'merge')!;
    const branch = net.paths.find((p) => p.block === merge.id && !p.id.endsWith('_In') && !p.id.endsWith('_Out'))!;
    const bs = specEnds(branch.segments)!.start;
    net = step(net, placeBlock(net, { kind: 'straight', lengthM: 2 }, { pathId: branch.id, end: 'start' }));
    const x = net.paths.find((p) => p.successors.includes(branch.id))!;
    expect(specEnds(x.segments)!.end.position[0]).toBeCloseTo(bs.position[0], 6);
    const set = chainMoveSet(net, x.block);
    expect(set.blockIds).toEqual([x.block]); // stops at the merge: neither the junction nor its host moves
    const after = step(net, moveBlock(net, x.block, { dx: 0, dz: -2, dHeadingDeg: 0, pivot: [0, 0] }, { chain: true }));
    expect(succ(after, x.id)).toEqual([]);
    expect(specEnds(after.paths.find((p) => p.id === branch.id)!.segments)!.start.position).toEqual(bs.position);
  });

  it('a host block takes its hosted junction along; the walk continues from the host', () => {
    let net: NetworkInput = { paths: [], blocks: [] };
    net = step(net, placeBlock(net, { kind: 'straight', lengthM: 2 }, { x: -2, z: 0, headingDeg: 0 }));
    net = step(net, placeBlock(net, { kind: 'straight', lengthM: 10 }, { pathId: 'PN_S1', end: 'end' }));
    net = step(net, placeJunction(net, { kind: 'diverge' }, { pathId: 'PN_S2', s: 5, side: 'left' }));
    net = step(net, placeBlock(net, { kind: 'straight', lengthM: 2 }, { pathId: 'PN_S2', end: 'end' }));
    const tail = net.paths.find((p) => p.id.startsWith('PN_S') && !['PN_S1', 'PN_S2'].includes(p.id) && p.block !== blockOf(net, 'PN_S2'))!;
    const set = chainMoveSet(net, blockOf(net, 'PN_S1'));
    const diverge = (net.blocks ?? []).find((b) => b.extras.kind === 'diverge')!;
    expect(set.blockIds).toContain(diverge.id);
    expect(set.blockIds).toContain(tail.block);
    expect(set.blockIds).toHaveLength(4);
    const after = step(net, moveBlock(net, blockOf(net, 'PN_S1'), { dx: 1, dz: 1, dHeadingDeg: 0, pivot: [-2, 0] }, { chain: true }));
    expect(gaps(after)).toBe(0);
    expect(kinks(after)).toBe(0);
  });

  it('a loop is moved once — every block, nothing twice', () => {
    // Four 90° curves (radius 1) closing a circle.
    let net: NetworkInput = { paths: [], blocks: [] };
    net = step(net, placeBlock(net, { kind: 'curve', degrees: 90, radiusM: 1, side: 'left' }, { x: 0, z: 0, headingDeg: 0 }));
    for (let i = 1; i < 4; i++) {
      const last = net.paths[net.paths.length - 1].id;
      net = step(net, placeBlock(net, { kind: 'curve', degrees: 90, radiusM: 1, side: 'left' }, { pathId: last, end: 'end' }));
    }
    const first = net.paths[0];
    expect(net.paths.some((p) => p.successors.includes(first.id))).toBe(true); // closed by auto-link
    const set = chainMoveSet(net, first.block);
    expect(new Set(set.blockIds).size).toBe(4);
    expect(set.blockIds).toHaveLength(4);
    const before = net.paths.map((p) => specEnds(p.segments)!.start.position);
    const after = step(net, moveBlock(net, first.block, { dx: 5, dz: 0, dHeadingDeg: 0, pivot: [0, 0] }, { chain: true }));
    after.paths.forEach((p, i) => {
      expect(specEnds(p.segments)!.start.position[0] - before[i][0]).toBeCloseTo(5, 9); // exactly once
    });
    expect(after.paths.every((p) => p.successors.length === 1)).toBe(true); // ring intact
  });

  it('dropSnap: a moving start within 0.35 m of a free end lands exactly on it, tangent-true', () => {
    const net = chain3();
    const moving = new Set(chainMoveSet(net, blockOf(net, 'PN_S2')).pathIds);
    const ends = movingFreeEnds(net, moving);
    expect(ends.map((e) => `${e.pathId}:${e.end}`).sort()).toEqual(['PN_S2:start', 'PN_S3:end']);
    const targets = dropTargets(net, moving);
    expect(targets.map((t) => `${t.pathId}:${t.end}`).sort()).toEqual(['PN_S1:end', 'PN_S1:start']);
    const snap = dropSnap(ends, targets, { dx: 0.2, dz: 0.15, dHeadingDeg: 7, pivot: [2, 0] })!;
    expect(snap.target.pathId).toBe('PN_S1');
    const after = step(net, moveBlock(net, blockOf(net, 'PN_S2'), snap.motion, { chain: true }));
    expect(succ(after, 'PN_S1')).toEqual(['PN_S2']); // re-linked
    expect(succ(after, 'PN_S2')).toEqual(['PN_S3']);
    expect(gaps(after)).toBe(0);
    expect(kinks(after)).toBe(0);
    expect(dropSnap(ends, targets, { dx: 0, dz: 1, dHeadingDeg: 0, pivot: [2, 0] })).toBeNull(); // out of reach
  });
});

// ─── UI ──────────────────────────────────────────────────────────────────

let rig: Rig;
let ui: PathNetworkInteraction;
let canvas: HTMLCanvasElement;
const pinned: string[][] = [];

const viewerOf = (r: Rig): RVViewer => r.stub as unknown as RVViewer;

async function exec(id: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await commandRegistry.execute<Record<string, unknown>>(id, args, { origin: 'mcp', viewer: viewerOf(rig) });
  if (!r.ok) throw new Error(r.reason);
  return r.value as Record<string, unknown>;
}

const net = (): NetworkInput => snapshotNetwork(rig.stub as never).input;

function screenOf(x: number, z: number): { clientX: number; clientY: number } {
  const v = new Vector3(x, 0, z).project(rig.stub.camera);
  const r = canvas.getBoundingClientRect();
  return { clientX: r.left + ((v.x + 1) / 2) * r.width, clientY: r.top + ((1 - v.y) / 2) * r.height };
}

function pointer(type: string, x: number, z: number, extra: PointerEventInit = {}): PointerEvent {
  return new PointerEvent(type, { ...screenOf(x, z), button: 0, bubbles: true, ...extra });
}

const undoLen = (): number => rig.doc.historyHead().undoLen;
const wait = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

async function drag(from: [number, number], to: [number, number], shiftKey = false): Promise<void> {
  rig.scene.updateMatrixWorld(true); // the render loop's job: the gizmo handle sits at the block pose
  expect(ui.handlePointerDown(pointer('pointerdown', from[0], from[1], { shiftKey }))).toBe(true);
  canvas.dispatchEvent(pointer('pointermove', (from[0] + to[0]) / 2, (from[1] + to[1]) / 2, { shiftKey }));
  canvas.dispatchEvent(pointer('pointermove', to[0], to[1], { shiftKey }));
  window.dispatchEvent(pointer('pointerup', to[0], to[1], { shiftKey }));
  await wait();
}

beforeEach(async () => {
  getDefaultPathNetwork().clear();
  getDefaultZoneRegistry().clear();
  getDefaultAgvFleet().clear();
  canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:600px';
  canvas.width = 800;
  canvas.height = 600;
  document.body.appendChild(canvas);
  rig = makeRig(canvas);
  rig.plugin.setPlannerMode(true);
  pinned.length = 0;
  // The snap plugin's pin seam, observed (8.8: freed ends keep their marker).
  (rig.stub as unknown as { getPlugin(id: string): unknown }).getPlugin = (id: string) => (id === 'snap-point'
    ? { setPinnedPathSnaps: (ids: readonly string[]) => { pinned.push([...ids]); }, listPathPlacementPorts: () => [] }
    : undefined);
  ensurePathNetworkCommandsRegistered(commandRegistry);
  ui = new PathNetworkInteraction(viewerOf(rig), rig.plugin);
  rig.scene.updateMatrixWorld(true);
  ui.tick();
  await exec('layout.path.place', { block: 'straight', lengthM: 2, x: 0, z: 0, headingDeg: 0 });
  await exec('layout.path.place', { block: 'straight', lengthM: 2, atPath: 'PN_S1', atEnd: 'end' });
  await exec('layout.path.place', { block: 'straight', lengthM: 2, atPath: 'PN_S2', atEnd: 'end' });
});

afterEach(() => {
  ui.dispose();
  rig.plugin.dispose();
  canvas.remove();
  setActiveEditTarget(null);
  getDefaultPathNetwork().clear();
});

describe('plan-628 9.9h chain move (UI)', () => {
  it('move handle: the downstream block follows in ONE layout.path.move, the chain edge stays', async () => {
    const mid = net().paths.find((p) => p.id === 'PN_S2')!.block;
    ui.selectBlock(mid);
    rig.scene.updateMatrixWorld(true);
    const before = undoLen();
    await drag([2, 0], [2, 3]);
    expect(undoLen()).toBe(before + 1);
    const n = net();
    expect(specEnds(n.paths.find((p) => p.id === 'PN_S3')!.segments)!.start.position[2]).toBeCloseTo(3, 2);
    expect(n.paths.find((p) => p.id === 'PN_S2')!.successors).toEqual(['PN_S3']);
    expect(gaps(n)).toBe(0);
    // one undo restores the whole chain
    await rig.doc.undo();
    expect(net().paths.find((p) => p.id === 'PN_S1')!.successors).toEqual(['PN_S2']);
    expect(specEnds(net().paths.find((p) => p.id === 'PN_S3')!.segments)!.start.position[2]).toBeCloseTo(0, 6);
  });

  it('Shift drag: the block alone (P6), freed ends pinned for their snap markers; drop near re-snaps', async () => {
    const mid = net().paths.find((p) => p.id === 'PN_S2')!.block;
    ui.selectBlock(mid);
    rig.scene.updateMatrixWorld(true);
    await drag([2, 0], [2, 2], true);
    let n = net();
    expect(n.paths.find((p) => p.id === 'PN_S1')!.successors).toEqual([]);
    expect(n.paths.find((p) => p.id === 'PN_S2')!.successors).toEqual([]);
    expect(specEnds(n.paths.find((p) => p.id === 'PN_S3')!.segments)!.start.position[2]).toBeCloseTo(0, 6); // S3 stayed
    const lastPins = pinned[pinned.length - 1];
    expect(new Set(lastPins)).toEqual(new Set(['PN_S1', 'PN_S2', 'PN_S3']));
    // Drag back to 0.2 m off the free end: the drop re-snaps tangent-true and re-forms the edges.
    await drag([2, 2], [2.15, 0.2], true);
    n = net();
    const e2 = specEnds(n.paths.find((p) => p.id === 'PN_S2')!.segments)!;
    expect(e2.start.position[0]).toBeCloseTo(2, 3);
    expect(e2.start.position[2]).toBeCloseTo(0, 3);
    expect(headingOf(e2.start.tangent)).toBeCloseTo(0, 2);
    expect(n.paths.find((p) => p.id === 'PN_S1')!.successors).toEqual(['PN_S2']);
    expect(n.paths.find((p) => p.id === 'PN_S2')!.successors).toEqual(['PN_S3']);
    expect(gaps(n)).toBe(0);
    expect(kinks(n)).toBe(0);
  });
});
