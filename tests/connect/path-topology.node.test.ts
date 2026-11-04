// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * path-topology.node.test.ts — plan-633 Phase 4 §9.4 (pure part).
 *
 * Pins the plan-628 P5 contract of `pairPathEnds` (ALL directed END → START
 * neighbourhoods, never START/START or END/END, order-independent), the
 * shared tolerance at its exact bounds, `diffSuccessors` (missing / extra /
 * reversed / unknown, opt-out), the write seam `applySuccessorLink` and the
 * check service's scheduling rules (coalescing, superseded and failed loads,
 * cleanup on model change) against a fake host.
 *
 * Every assertion on a looked-up value first asserts that it exists (#211).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { parsePathExtras, RVPathComponent, type RVPath } from '../../src/core/engine/rv-path';
import { RVPathNetwork, getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { setComponentInstance } from '../../src/core/engine/rv-component-registry';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import {
  analysePathEnds,
  applySuccessorLink,
  diffSuccessors,
  pairPathEnds,
  planSuccessorChange,
} from '../../src/core/connect/path-topology';
import { PATH_LINK_TOLERANCE } from '../../src/core/connect/path-link-tolerance';
import {
  PathTopologyCheck,
  PATH_END_NEAR_MISS,
  PATH_SUCCESSOR_MISMATCH,
  type PathTopologyCheckHost,
} from '../../src/core/connect/path-topology-check';
import { clearAllProblems, getProblems } from '../../src/core/hmi/problems-store';
import type { EditTarget } from '../../src/core/hmi/rv-edit-target';

type V3 = [number, number, number];
const DEG = Math.PI / 180;

function line(id: string, from: V3, to: V3, extra: Record<string, unknown> = {}): RVPath {
  const p = parsePathExtras({ type: 'Path', id, segments: [{ kind: 'line', from, to }], ...extra }, id);
  expect(p, `path ${id} parses`).not.toBeNull();
  return p!;
}

const pairsOf = (paths: readonly RVPath[]): string[] => pairPathEnds(paths).map((l) => `${l.from}>${l.to}`);

describe('pairPathEnds — the plan-628 P5 contract', () => {
  it('1 → 2: END(A) at START(B) gives exactly A>B', () => {
    const a = line('A', [0, 0, 0], [1, 0, 0]);
    const b = line('B', [1, 0, 0], [2, 0, 0]);
    expect(pairsOf([a, b])).toEqual(['A>B']);
  });

  it('2 → 1: the direction follows the geometry, not the ids or the input order', () => {
    const a = line('A', [1, 0, 0], [2, 0, 0]);
    const b = line('B', [0, 0, 0], [1, 0, 0]);
    expect(pairsOf([a, b])).toEqual(['B>A']);
    expect(pairsOf([b, a])).toEqual(['B>A']);
  });

  it('several coincident ends: every END→START pair, never END/END or START/START', () => {
    const p: V3 = [0, 0, 0];
    const a = line('A', [-1, 0, 0], p);
    const b = line('B', [-3, 0, 0], p);
    const c = line('C', p, [1, 0, 0]);
    const d = line('D', p, [2, 0, 0]);
    expect(pairsOf([a, b, c, d])).toEqual(['A>C', 'A>D', 'B>C', 'B>D']);
  });

  it('swapped / shuffled input gives the same result', () => {
    const p: V3 = [0, 0, 0];
    const paths = [
      line('A', [-1, 0, 0], p), line('B', [-3, 0, 0], p),
      line('C', p, [1, 0, 0]), line('D', p, [2, 0, 0]),
      line('E', [2, 0, 0], [3, 0, 0]),
    ];
    const ref = pairPathEnds(paths);
    expect(ref.length).toBe(5);
    for (const order of [[4, 3, 2, 1, 0], [2, 0, 4, 1, 3], [3, 1, 0, 4, 2]]) {
      expect(pairPathEnds(order.map((i) => paths[i]))).toEqual(ref);
    }
  });

  it('a branch (A → B, A → C) is complete — not exclusive; a later end links on (B → D)', () => {
    // Both branches leave A's end along +X (within 2°) and bend later.
    const a = line('A', [0, 0, 0], [1, 0, 0]);
    const b = parsePathExtras({
      type: 'Path', id: 'B', segments: [
        { kind: 'line', from: [1, 0, 0], to: [2, 0, 0] },
        { kind: 'line', from: [2, 0, 0], to: [3, 0, 1] },
        { kind: 'line', from: [3, 0, 1], to: [4, 0, 1] },
      ],
    }, 'B')!;
    const c = parsePathExtras({
      type: 'Path', id: 'C', segments: [
        { kind: 'line', from: [1, 0, 0], to: [2, 0, 0] },
        { kind: 'line', from: [2, 0, 0], to: [3, 0, -1] },
        { kind: 'line', from: [3, 0, -1], to: [4, 0, -1] },
      ],
    }, 'C')!;
    expect(b, 'B parses').not.toBeNull();
    expect(c, 'C parses').not.toBeNull();
    const d1 = line('D', [4, 0, 1], [5, 0, 1]);
    expect(pairsOf([a, b, c, d1])).toEqual(['A>B', 'A>C', 'B>D']);
  });

  it('a path never links onto itself; a closed path has no free ends', () => {
    const loop = line('L', [0, 0, 0], [0, 0, 0.004]); // end 4 mm from its own start
    const closed = line('K', [0, 0, 0], [1, 0, 0], { closed: true });
    const next = line('N', [1, 0, 0], [2, 0, 0]);
    expect(pairsOf([loop])).toEqual([]);
    expect(pairsOf([closed, next])).toEqual([]);
  });
});

describe('PATH_LINK_TOLERANCE at its exact bounds (5 mm / 2°)', () => {
  it('is 5 mm and 2°', () => {
    expect(PATH_LINK_TOLERANCE.distM).toBe(0.005);
    expect(PATH_LINK_TOLERANCE.tangentDeg).toBe(2);
  });

  const gapCase = (gapM: number): ReturnType<typeof analysePathEnds> => analysePathEnds([
    line('A', [0, 0, 0], [1, 0, 0]),
    // lateral offset: the gap is exactly `gapM`, the tangents stay parallel
    line('B', [1, 0, gapM], [2, 0, gapM]),
  ]);

  it('exactly 5 mm links, 4.999 mm links, 5.001 mm does not (near miss instead)', () => {
    expect(gapCase(0.005).links.map((l) => l.to)).toEqual(['B']);
    expect(gapCase(0.004999).links.length).toBe(1);
    const over = gapCase(0.005001);
    expect(over.links.length).toBe(0);
    expect(over.nearMisses.map((n) => `${n.from}>${n.to}`)).toEqual(['A>B']);
  });

  it('4 mm links, 6 mm and 29 mm are near misses, 31 mm is nothing', () => {
    expect(gapCase(0.004).links.length).toBe(1);
    expect(gapCase(0.004).nearMisses.length).toBe(0);
    expect(gapCase(0.006).nearMisses.length).toBe(1);
    const n29 = gapCase(0.029).nearMisses[0];
    expect(n29).toBeDefined();
    expect(n29.distance).toBeCloseTo(0.029, 9);
    expect(gapCase(0.031).nearMisses.length).toBe(0);
    expect(gapCase(0.031).links.length).toBe(0);
  });

  const angleCase = (deg: number): number => pairPathEnds([
    line('A', [0, 0, 0], [1, 0, 0]),
    line('B', [1, 0, 0], [1 + Math.cos(deg * DEG), 0, Math.sin(deg * DEG)]),
  ]).length;

  it('tangent angle: exactly 2° links, 1.99° links, 2.01° does not', () => {
    expect(angleCase(2)).toBe(1);
    expect(angleCase(1.99)).toBe(1);
    expect(angleCase(2.01)).toBe(0);
  });

  it('the angle is measured between the TRAVEL tangents, not the opposed outward vectors', () => {
    // Collinear continuation: tangents parallel (0°), outward vectors opposed (180°).
    const link = pairPathEnds([line('A', [0, 0, 0], [1, 0, 0]), line('B', [1, 0, 0], [2, 0, 0])])[0];
    expect(link).toBeDefined();
    expect(link.angleDeg).toBeCloseTo(0, 9);
  });
});

describe('diffSuccessors — missing / extra / reversed / unknown, opt-out', () => {
  it('consistent declaration → no findings', () => {
    const paths = [
      line('A', [0, 0, 0], [1, 0, 0], { successors: ['B'] }),
      line('B', [1, 0, 0], [2, 0, 0]),
    ];
    expect(diffSuccessors(paths, pairPathEnds(paths))).toEqual([]);
  });

  it('missing, extra, reversed and unknown are reported per declaring path', () => {
    const paths = [
      line('A', [0, 0, 0], [1, 0, 0]),                                 // A>B geometric, undeclared → missing
      line('B', [1, 0, 0], [2, 0, 0], { successors: ['X', 'A'] }),     // B>A runs the other way; X unknown
      line('C', [5, 0, 0], [6, 0, 0], { successors: ['A'] }),          // no geometry at all → extra
    ];
    const diff = diffSuccessors(paths, pairPathEnds(paths));
    const byId = new Map(diff.map((d) => [d.pathId, d]));
    const b = byId.get('B');
    const c = byId.get('C');
    expect(b).toBeDefined();
    expect(c).toBeDefined();
    expect(b!.reversed).toEqual(['A']);
    expect(b!.unknown).toEqual(['X']);
    expect(c!.extra).toEqual(['A']);
    // The wrong-way link is reported ONCE (as reversed on B), not again as missing on A.
    expect(byId.has('A')).toBe(false);
  });

  it('a genuinely missing link is reported on the source path', () => {
    const paths = [line('A', [0, 0, 0], [1, 0, 0]), line('B', [1, 0, 0], [2, 0, 0])];
    const diff = diffSuccessors(paths, pairPathEnds(paths));
    expect(diff.length).toBe(1);
    expect(diff[0]).toBeDefined();
    expect(diff[0].pathId).toBe('A');
    expect(diff[0].missing).toEqual(['B']);
  });

  it('connectCheck: false opts a crossing out in both directions', () => {
    const paths = [
      line('A', [0, 0, 0], [1, 0, 0]),
      line('X', [1, 0, 0], [2, 0, 0], { connectCheck: false, successors: ['Nope'] }),
      line('C', [5, 0, 0], [6, 0, 0], { successors: ['X'] }),
    ];
    expect(paths[1].connectCheck).toBe(false);
    expect(paths[0].connectCheck).toBe(true);
    expect(diffSuccessors(paths, pairPathEnds(paths))).toEqual([]);
  });

  it('the parser accepts only an explicit false as opt-out', () => {
    expect(line('P', [0, 0, 0], [1, 0, 0], { connectCheck: 'no' }).connectCheck).toBe(true);
    expect(line('P', [0, 0, 0], [1, 0, 0], { connectCheck: 0 }).connectCheck).toBe(true);
    expect(line('P', [0, 0, 0], [1, 0, 0], { connectCheck: false }).connectCheck).toBe(false);
  });
});

describe('write seam — planSuccessorChange / applySuccessorLink', () => {
  beforeEach(() => {
    getDefaultPathNetwork().clear();
    getDefaultZoneRegistry().clear();
  });

  function addPath(id: string, from: V3, to: V3, successors: string[] = []): { node: Object3D; comp: RVPathComponent } {
    const node = new Object3D();
    node.name = id;
    node.userData.realvirtual = { Path: { id, segments: [{ kind: 'line', from, to }], successors } };
    const comp = new RVPathComponent(node);
    comp.init({} as never);
    setComponentInstance(node, comp);
    return { node, comp };
  }

  it('planSuccessorChange is idempotent and keeps the order', () => {
    const p = line('A', [0, 0, 0], [1, 0, 0], { successors: ['B'] });
    expect(planSuccessorChange(p, 'B', 'add')).toBeNull();
    expect(planSuccessorChange(p, 'C', 'add')).toEqual({ prev: ['B'], next: ['B', 'C'] });
    expect(planSuccessorChange(p, 'C', 'remove')).toBeNull();
    expect(planSuccessorChange(p, 'B', 'remove')).toEqual({ prev: ['B'], next: [] });
  });

  it('writes the extras, re-registers a FRESH path, never mutates the old readonly array', async () => {
    const a = addPath('A', [0, 0, 0], [1, 0, 0]);
    addPath('B', [1, 0, 0], [2, 0, 0]);
    const net = getDefaultPathNetwork();
    const oldA = net.get('A');
    expect(oldA).not.toBeNull();
    const changed: string[] = [];
    const off = net.onPathChanged((id) => changed.push(id));
    await applySuccessorLink({ pathId: 'A', node: a.node, nodePath: null, prev: [], next: ['B'] });
    off();
    const newA = net.get('A');
    expect(newA).not.toBeNull();
    expect(newA).not.toBe(oldA);
    expect(oldA!.successorIds).toEqual([]);
    expect(newA!.successorIds).toEqual(['B']);
    expect(changed).toContain('A');
    net.resolveGraph();
    expect(newA!.successors.map((s) => s.id)).toEqual(['B']);
    const payload = (a.node.userData.realvirtual as { Path: { successors: unknown } }).Path;
    expect(payload.successors).toEqual(['B']);
  });

  it('a failing op reverts the runtime write and propagates the error', async () => {
    const a = addPath('A', [0, 0, 0], [1, 0, 0]);
    addPath('B', [1, 0, 0], [2, 0, 0]);
    const seen: unknown[] = [];
    const target: EditTarget = {
      available: true,
      setField: () => { throw new Error('sync path must not be used'); },
      setFieldAsync: async (...args) => { seen.push(args); throw new Error('commit refused'); },
      unsetField: () => {},
      withTransaction: async (_l, fn) => { await fn(); },
    };
    await expect(applySuccessorLink(
      { pathId: 'A', node: a.node, nodePath: 'Root/A', prev: [], next: ['B'] }, target,
    )).rejects.toThrow('commit refused');
    expect(seen.length).toBe(1);
    expect(seen[0]).toEqual(['Root/A', 'Path', 'successors', ['B'], []]);
    const now = getDefaultPathNetwork().get('A');
    expect(now).not.toBeNull();
    expect(now!.successorIds).toEqual([]);
  });
});

// ─── Check service (fake host; the real viewer lifecycle is in path-topology.test.ts) ───

class FakeHost implements PathTopologyCheckHost {
  private listeners = new Map<string, Set<(d: unknown) => void>>();
  private readyWaiters: (() => void)[] = [];
  loading = false;
  readonly sceneLoadGate = { failedLoads: 0 };
  on(event: string, cb: (d: unknown) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) { set = new Set(); this.listeners.set(event, set); }
    set.add(cb);
    return () => { set!.delete(cb); };
  }
  emit(event: string, data?: unknown): void {
    for (const cb of [...(this.listeners.get(event) ?? [])]) cb(data);
  }
  whenSceneReady(): Promise<void> {
    if (!this.loading) return Promise.resolve();
    return new Promise((r) => this.readyWaiters.push(r));
  }
  finishLoad(failed = false): void {
    if (failed) this.sceneLoadGate.failedLoads++;
    this.loading = false;
    const w = this.readyWaiters;
    this.readyWaiters = [];
    for (const r of w) r();
  }
  nodePathOfPath(id: string): string { return `Root/${id}`; }
}

describe('PathTopologyCheck — scheduling and reporting', () => {
  let net: RVPathNetwork;
  let host: FakeHost;
  let check: PathTopologyCheck;
  let uninstall: () => void;

  beforeEach(() => {
    clearAllProblems();
    net = new RVPathNetwork();
    host = new FakeHost();
    check = new PathTopologyCheck(host, net);
    uninstall = check.install();
    return () => uninstall();
  });

  const codes = (): string[] => getProblems().map((p) => `${p.severity}:${p.code}:${p.id}`).sort();

  it('waits for scene-ready; all triggers of one load collapse into ONE run', async () => {
    host.loading = true;
    net.register(line('A', [0, 0, 0], [1, 0, 0]));          // missing A>B
    host.emit('model-loaded');
    // The stored addNode(Path) arrives AFTER model-loaded (R2-2) — still seen.
    net.register(line('B', [1, 0, 0], [2, 0, 0]));
    host.emit('scene-loaded');
    host.emit('placements-materialized', { aborted: false });
    await Promise.resolve();
    expect(check.runs).toBe(0);
    host.finishLoad();
    await check.whenIdle();
    expect(check.runs).toBe(1);
    expect(codes()).toEqual([`warning:${PATH_SUCCESSOR_MISMATCH}:${PATH_SUCCESSOR_MISMATCH}:A`]);
    const entry = getProblems()[0];
    expect(entry).toBeDefined();
    expect(entry.nodePath).toBe('Root/A');
    expect(entry.detail).toContain('missing: B');
  });

  it('a superseded load (model-cleared while waiting) reports nothing', async () => {
    host.loading = true;
    net.register(line('A', [0, 0, 0], [1, 0, 0]));
    net.register(line('B', [1, 0, 0], [2, 0, 0]));
    const first = check.schedule();
    host.emit('model-cleared');
    host.finishLoad();
    await first;
    expect(check.runs).toBe(0);
    expect(check.skipped).toBe(1);
    expect(getProblems()).toEqual([]);
  });

  it('a failed load reports nothing', async () => {
    host.loading = true;
    net.register(line('A', [0, 0, 0], [1, 0, 0]));
    net.register(line('B', [1, 0, 0], [2, 0, 0]));
    host.emit('model-loaded');
    host.finishLoad(true);
    await check.whenIdle();
    expect(check.runs).toBe(0);
    expect(check.skipped).toBe(1);
    expect(getProblems()).toEqual([]);
  });

  it('an aborted placements-materialized does not trigger', async () => {
    net.register(line('A', [0, 0, 0], [1, 0, 0]));
    host.emit('placements-materialized', { aborted: true });
    await check.whenIdle();
    expect(check.runs).toBe(0);
  });

  it('near miss (info) and opt-out; model-cleared drops both codes', async () => {
    net.register(line('A', [0, 0, 0], [1, 0, 0]));
    net.register(line('B', [1, 0, 0.029], [2, 0, 0.029]));                       // 29 mm → near miss
    net.register(line('X', [1, 0, 0], [2, 0, 0], { connectCheck: false }));      // crossing, opted out
    host.emit('model-loaded');
    await check.whenIdle();
    expect(codes()).toEqual([`info:${PATH_END_NEAR_MISS}:${PATH_END_NEAR_MISS}:A>B`]);
    const near = getProblems()[0];
    expect(near).toBeDefined();
    expect(near.title).toContain('29.0 mm');
    host.emit('model-cleared');
    expect(getProblems()).toEqual([]);
    expect(check.lastResult).toBeNull();
  });

  it('a live path edit re-runs the check and clears a fixed finding', async () => {
    net.register(line('A', [0, 0, 0], [1, 0, 0]));
    net.register(line('B', [1, 0, 0], [2, 0, 0]));
    host.emit('model-loaded');
    await check.whenIdle();
    expect(codes().length).toBe(1);
    net.register(line('A', [0, 0, 0], [1, 0, 0], { successors: ['B'] }));
    net.notifyPathChanged('A');
    await check.whenIdle();
    expect(check.runs).toBe(2);
    expect(getProblems()).toEqual([]);
  });

  it('uninstall stops the triggers and clears the codes', async () => {
    net.register(line('A', [0, 0, 0], [1, 0, 0]));
    net.register(line('B', [1, 0, 0], [2, 0, 0]));
    host.emit('model-loaded');
    await check.whenIdle();
    expect(getProblems().length).toBe(1);
    uninstall();
    expect(getProblems()).toEqual([]);
    host.emit('model-loaded');
    await check.whenIdle();
    expect(check.runs).toBe(1);
  });
});
