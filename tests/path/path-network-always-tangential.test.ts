// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-628 §9.9k (8.10, E52 — Thomas 2026-10-25: "path network is always
 * tangential"). No authoring action produces a connected kink; after every
 * action the network has 0 `path-kink` (and 0 `path-link-gap`):
 *
 *  1. snap / attach (command place at a port, picker `placeAtSnap`) links only
 *     tangentially; a block set down 5° off a free end stays unlinked;
 *  2. a move drop re-snaps tangentially or stays free — an edge that would end
 *     non-tangential / non-coincident is released in the same edit (single and
 *     chain move);
 *  3. R / Shift+R turns the block WITH its downstream chain about its start;
 *     the predecessor edge is released (open end, pinned), never a kink; a
 *     block without predecessor turns its whole chain; one undo step;
 *  4. no op writes a non-tangential edge: `linkEnds` refuses `not-tangential`,
 *     the op runner's guard (`nonTangentialWrites`) finds every written kink,
 *     and loaded kinks stay untouched (inherited, `path-kink` is their guard);
 *  5. deleting a junction whose host no longer continues seamlessly leaves
 *     open ends instead of a kink / gap edge.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Vector3 } from 'three';
import {
  chainMoveSet, linkEnds, moveBlock, nonTangentialWrites, placeBlock, placeJunction, removeBlock,
  NOT_TANGENTIAL_TEXT,
  type NetworkEdit, type NetworkInput, type PathGraphEntry,
} from '../../src/core/engine/rv-path-network-ops';
import { validatePathNetwork } from '../../src/core/engine/rv-path-network-validate';
import { applyRigidXZ, specEnds } from '../../src/core/engine/rv-path-blocks';
import { isPathLink } from '../../src/core/connect/path-link-tolerance';
import { foldEdit, snapshotNetwork } from '../../src/plugins/path-network/path-network-scene';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import type { RVViewer } from '../../src/core/rv-viewer';
import { setActiveEditTarget } from '../../src/core/hmi/rv-edit-target';
import { commandRegistry } from '../../src/core/hmi/rv-command-registry';
import { ensurePathNetworkCommandsRegistered } from '../../src/plugins/path-network/path-network-commands';
import { PathNetworkInteraction } from '../../src/plugins/path-network/path-network-interaction';
import { makeRig, type Rig } from './path-network-rig';

// ─── helpers ─────────────────────────────────────────────────────────────

function step(net: NetworkInput, r: { ok: boolean; reason?: string; detail?: string; edit: NetworkEdit }): NetworkInput {
  expect(r.ok, `${r.reason} ${r.detail ?? ''}`).toBe(true);
  return foldEdit(net, r.edit);
}

const codes = (net: NetworkInput, code: string): number => validatePathNetwork(net).issues.filter((i) => i.code === code).length;
const v3 = (t: readonly number[]): Vector3 => new Vector3(t[0], t[1], t[2]);
const succ = (net: NetworkInput, id: string): string[] => net.paths.find((p) => p.id === id)!.successors;
const blockOf = (net: NetworkInput, pathId: string): string => net.paths.find((p) => p.id === pathId)!.block;
/** Signed heading difference a − b in degrees, wrapped to (−180, 180]. */
const dh = (a: number, b: number): number => { const d = ((a - b) % 360 + 540) % 360 - 180; return d === -180 ? 180 : d; };
const startHeading = (net: NetworkInput, id: string): number => {
  const t = specEnds(net.paths.find((p) => p.id === id)!.segments)!.start.tangent;
  return Math.atan2(t[2], t[0]) * 180 / Math.PI;
};

/** 0 `path-kink`, 0 `path-link-gap`, and every edge continues under the shared tolerance. */
function expectTangential(net: NetworkInput, what: string): void {
  expect(codes(net, 'path-kink'), `${what}: path-kink`).toBe(0);
  expect(codes(net, 'path-link-gap'), `${what}: path-link-gap`).toBe(0);
  const byId = new Map(net.paths.map((p) => [p.id, p]));
  for (const p of net.paths) {
    for (const s of p.successors) {
      const a = specEnds(p.segments)!;
      const b = specEnds(byId.get(s)!.segments)!;
      expect(isPathLink(v3(a.end.position), v3(a.end.tangent), v3(b.start.position), v3(b.start.tangent)), `${what}: ${p.id} -> ${s}`).toBe(true);
    }
  }
}

/** Straight 2 m → Curve R → Straight 2 m (PN_S1 → PN_C1 → PN_S2), all by port attach. */
function chainSCS(): NetworkInput {
  let net: NetworkInput = { paths: [], blocks: [] };
  net = step(net, placeBlock(net, { kind: 'straight', lengthM: 2 }, { x: 0, z: 0, headingDeg: 0 }));
  expectTangential(net, 'place S1');
  net = step(net, placeBlock(net, { kind: 'curve', side: 'right' }, { pathId: 'PN_S1', end: 'end' }));
  expectTangential(net, 'attach C1');
  net = step(net, placeBlock(net, { kind: 'straight', lengthM: 2 }, { pathId: 'PN_C1', end: 'end' }));
  expectTangential(net, 'attach S2');
  return net;
}

/** Replace a path's segments in a snapshot (loaded / foreign geometry). */
function withSegments(net: NetworkInput, id: string, f: (p: PathGraphEntry) => PathGraphEntry['segments']): NetworkInput {
  return { ...net, paths: net.paths.map((p) => (p.id === id ? { ...p, segments: f(p) } : p)) };
}

// ─── pure ────────────────────────────────────────────────────────────────

describe('plan-628 9.9k always tangential (pure)', () => {
  it('(1) snap / attach links tangentially; a block 5° off a free end stays unlinked', () => {
    let net = chainSCS();
    expect(succ(net, 'PN_S1')).toEqual(['PN_C1']);
    expect(succ(net, 'PN_C1')).toEqual(['PN_S2']);
    // Attach at a START port (the new block ends there).
    net = step(net, placeBlock(net, { kind: 'curve', side: 'left' }, { pathId: 'PN_S1', end: 'start' }));
    expectTangential(net, 'attach at start');
    expect(net.paths.find((p) => p.successors.includes('PN_S1'))).toBeTruthy();
    // A free block exactly at the S2 end, but 5° off: never linked (open ends, no kink).
    const e = specEnds(net.paths.find((p) => p.id === 'PN_S2')!.segments)!.end;
    const h = Math.atan2(e.tangent[2], e.tangent[0]) * 180 / Math.PI;
    const r = placeBlock(net, { kind: 'straight', lengthM: 2 }, { x: e.position[0], z: e.position[2], headingDeg: h + 5 });
    net = step(net, r);
    expect(r.linked).toEqual([]);
    expect(succ(net, 'PN_S2')).toEqual([]);
    expectTangential(net, '5° free place');
  });

  it('(2) move drop: single and chain moves release every edge that would kink — never written', () => {
    const net = chainSCS();
    const c1 = blockOf(net, 'PN_C1');
    const pivot = specEnds(net.paths.find((p) => p.id === 'PN_C1')!.segments)!.start.position;
    // Turn the chain by 10° about its start: the start still meets S1's end, the tangent does not.
    const chain = step(net, moveBlock(net, c1, { dx: 0, dz: 0, dHeadingDeg: 10, pivot: [pivot[0], pivot[2]] }, { chain: true }));
    expect(succ(chain, 'PN_S1')).toEqual([]); // released, not kinked
    expect(succ(chain, 'PN_C1')).toEqual(['PN_S2']); // inside the chain stays
    expectTangential(chain, 'chain move 10°');
    const single = step(net, moveBlock(net, c1, { dx: 0, dz: 0, dHeadingDeg: 10, pivot: [pivot[0], pivot[2]] }));
    expect(succ(single, 'PN_S1')).toEqual([]);
    expect(succ(single, 'PN_C1')).toEqual([]);
    expectTangential(single, 'single move 10°');
    // A loaded chain edge with a kink inside the moved set: the move writes it anew → released.
    const kinked = withSegments(net, 'PN_S2', (p) => applyRigidXZ(p.segments, {
      dx: 0, dz: 0, dHeadingDeg: 8, pivot: [specEnds(p.segments)!.start.position[0], specEnds(p.segments)!.start.position[2]],
    }));
    expect(codes(kinked, 'path-kink')).toBe(1); // foreign data: the guard reports it
    const moved = step(kinked, moveBlock(kinked, c1, { dx: 0.5, dz: 0.5, dHeadingDeg: 0, pivot: [pivot[0], pivot[2]] }, { chain: true }));
    expect(succ(moved, 'PN_C1')).toEqual([]);
    expectTangential(moved, 'move of a kinked chain');
  });

  it('(3) chain rotation about the block start: predecessor released, chain kept; no predecessor → whole chain', () => {
    const net = chainSCS();
    const c1 = blockOf(net, 'PN_C1');
    const pose = (net.blocks ?? []).find((b) => b.id === c1)!.extras.pose;
    const r = step(net, moveBlock(net, c1, { dx: 0, dz: 0, dHeadingDeg: 90, pivot: [pose[0], pose[1]] }, { chain: true }));
    expect(succ(r, 'PN_S1')).toEqual([]);
    expect(succ(r, 'PN_C1')).toEqual(['PN_S2']);
    expect(specEnds(r.paths.find((p) => p.id === 'PN_C1')!.segments)!.start.position[0]).toBeCloseTo(2, 9); // turned about its start
    expectTangential(r, 'rotate C1 + chain');
    const s1 = blockOf(net, 'PN_S1');
    expect(chainMoveSet(net, s1).blockIds).toHaveLength(3);
    const head = step(net, moveBlock(net, s1, { dx: 0, dz: 0, dHeadingDeg: -90, pivot: [0, 0] }, { chain: true }));
    expect(succ(head, 'PN_S1')).toEqual(['PN_C1']);
    expect(succ(head, 'PN_C1')).toEqual(['PN_S2']);
    expect(dh(startHeading(head, 'PN_S2'), startHeading(net, 'PN_S2'))).toBeCloseTo(-90, 6); // dHeading = Δ atan2(z, x)
    expectTangential(head, 'rotate head + chain');
  });

  it('(4) no op writes a non-tangential edge: linkEnds refuses not-tangential; the guard finds written kinks, inherits loaded ones', () => {
    let net: NetworkInput = { paths: [], blocks: [] };
    net = step(net, placeBlock(net, { kind: 'straight', lengthM: 2 }, { x: 0, z: 0, headingDeg: 0 }));
    net = step(net, placeBlock(net, { kind: 'straight', lengthM: 2 }, { x: 2, z: 0, headingDeg: 5 })); // meets, 5° off
    expect(succ(net, 'PN_S1')).toEqual([]);
    const kink = linkEnds(net, { pathId: 'PN_S1', end: 'end' }, { pathId: 'PN_S2', end: 'start' });
    expect(kink.ok).toBe(false);
    expect(kink.reason).toBe('not-tangential');
    expect(kink.detail).toContain(NOT_TANGENTIAL_TEXT);
    const far = step(net, placeBlock(net, { kind: 'straight', lengthM: 2 }, { x: 10, z: 0, headingDeg: 0 }));
    expect(linkEnds(far, { pathId: 'PN_S2', end: 'end' }, { pathId: 'PN_S3', end: 'start' }).reason).toBe('invalid-link');
    // The runner's guard: a working copy that writes S1 → S2 is caught …
    const w = new Map(net.paths.map((p) => [p.id, p.id === 'PN_S1' ? { ...p, successors: ['PN_S2'] } : p]));
    expect(nonTangentialWrites(net, { paths: w })).toEqual([['PN_S1', 'PN_S2']]);
    // … but the same kink already present in loaded data and not touched is inherited.
    const loaded: NetworkInput = { ...net, paths: net.paths.map((p) => (p.id === 'PN_S1' ? { ...p, successors: ['PN_S2'] } : p)) };
    expect(codes(loaded, 'path-kink')).toBe(1);
    expect(nonTangentialWrites(loaded, { paths: new Map(loaded.paths.map((p) => [p.id, p])) })).toEqual([]);
    // A junction on the loaded S2 redirects the kinked predecessor edge unchanged: allowed, kink count unchanged.
    const j = placeJunction(loaded, { kind: 'diverge' }, { pathId: 'PN_S2', s: 1, side: 'left' });
    expect(j.ok, j.detail).toBe(true);
    expect(codes(foldEdit(loaded, j.edit), 'path-kink')).toBe(1);
  });

  it('(5) junction delete: seamless host heals into one tangential path; a broken host keeps open ends, no kink', () => {
    let net: NetworkInput = { paths: [], blocks: [] };
    net = step(net, placeBlock(net, { kind: 'straight', lengthM: 6 }, { x: 0, z: 0, headingDeg: 0 }));
    net = step(net, placeJunction(net, { kind: 'diverge' }, { pathId: 'PN_S1', s: 3, side: 'left' }));
    expectTangential(net, 'diverge placed');
    const jb = (net.blocks ?? []).find((b) => b.extras.kind === 'diverge')!.id;
    const healed = step(net, removeBlock(net, jb));
    expect(healed.paths).toHaveLength(1);
    expectTangential(healed, 'healed');
    // The front piece was turned by 4° (foreign edit): the host no longer continues seamlessly.
    const front = (net.blocks ?? []).find((b) => b.id === jb)!.extras.frontPathId!;
    const broken = withSegments(net, front, (p) => applyRigidXZ(p.segments, { dx: 0, dz: 0, dHeadingDeg: 4, pivot: [0, 0] }));
    const r = removeBlock(broken, jb);
    const after = step(broken, r);
    expect(after.paths).toHaveLength(2); // front and rest stay separate
    expect(succ(after, front)).toEqual([]); // open end instead of a kink edge
    expectTangential(after, 'not healable → open ends');
  });
});

// ─── UI (R / Shift+R on a connected block, placeAtSnap) ─────────────────

let rig: Rig;
let ui: PathNetworkInteraction;
let canvas: HTMLCanvasElement;
const pinned: string[][] = [];
const viewerOf = (r: Rig): RVViewer => r.stub as unknown as RVViewer;
const live = (): NetworkInput => snapshotNetwork(rig.stub as never).input;
const undoLen = (): number => rig.doc.historyHead().undoLen;
const wait = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

async function exec(id: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await commandRegistry.execute<Record<string, unknown>>(id, args, { origin: 'mcp', viewer: viewerOf(rig) });
  if (!r.ok) throw new Error(r.reason);
  return r.value as Record<string, unknown>;
}

function key(k: string, extra: KeyboardEventInit = {}): void {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
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
  (rig.stub as unknown as { getPlugin(id: string): unknown }).getPlugin = (id: string) => (id === 'snap-point'
    ? { setPinnedPathSnaps: (ids: readonly string[]) => { pinned.push([...ids]); }, listPathPlacementPorts: () => [] }
    : undefined);
  ensurePathNetworkCommandsRegistered(commandRegistry);
  ui = new PathNetworkInteraction(viewerOf(rig), rig.plugin);
  rig.scene.updateMatrixWorld(true);
  ui.tick();
  await exec('layout.path.place', { block: 'straight', lengthM: 2, x: 0, z: 0, headingDeg: 0 });
});

afterEach(() => {
  ui.dispose();
  rig.plugin.dispose();
  canvas.remove();
  setActiveEditTarget(null);
  getDefaultPathNetwork().clear();
});

describe('plan-628 9.9k always tangential (UI)', () => {
  it('(1) picker placeAtSnap chains tangentially (Curve R, then Straight)', async () => {
    expect((await ui.placeAtSnap('curve-90-r', 'path-snap:PN_S1:end')).ok).toBe(true);
    expectTangential(live(), 'picker curve R');
    expect((await ui.placeAtSnap('straight-2', 'path-snap:PN_C1:end')).ok).toBe(true);
    expectTangential(live(), 'picker straight');
    expect(live().paths.find((p) => p.id === 'PN_C1')!.successors).toEqual(['PN_S2']);
  });

  it('(3) R on a connected block turns it with its chain about its start, predecessor released + pinned; one undo step; Shift+R on the head turns the whole chain', async () => {
    await exec('layout.path.place', { block: 'curve', side: 'right', atPath: 'PN_S1', atEnd: 'end' });
    await exec('layout.path.place', { block: 'straight', lengthM: 2, atPath: 'PN_C1', atEnd: 'end' });
    const before = live();
    const c1 = blockOf(before, 'PN_C1');
    ui.selectBlock(c1);
    const u0 = undoLen();
    key('r');
    await wait();
    let n = live();
    expect(undoLen()).toBe(u0 + 1);
    expect(succ(n, 'PN_S1')).toEqual([]); // predecessor edge released
    expect(succ(n, 'PN_C1')).toEqual(['PN_S2']); // chain kept
    expect(dh(startHeading(n, 'PN_S2'), startHeading(before, 'PN_S2'))).toBeCloseTo(90, 6); // R = +90°
    expect(new Set(pinned[pinned.length - 1])).toEqual(new Set(['PN_S1', 'PN_C1']));
    expectTangential(n, 'R on C1');
    await rig.doc.undo();
    n = live();
    expect(succ(n, 'PN_S1')).toEqual(['PN_C1']);
    expectTangential(n, 'undo');

    const s1 = blockOf(n, 'PN_S1');
    ui.selectBlock(s1);
    key('R', { shiftKey: true });
    await wait();
    n = live();
    expect(succ(n, 'PN_S1')).toEqual(['PN_C1']);
    expect(succ(n, 'PN_C1')).toEqual(['PN_S2']);
    expect(dh(startHeading(n, 'PN_S2'), startHeading(before, 'PN_S2'))).toBeCloseTo(-90, 6); // Shift+R = −90°
    expectTangential(n, 'Shift+R on the head');
  });
});
