// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-559 Phase 1 rest — `RouteTable` / `reverseApproach` against a REAL Agv
 * stub manoeuvre (plan-595), observed through `AgvHandle.locate`.
 *
 * The prediction comes from `pathNetworkRouteGraph(net)` over the plan-595 stub
 * world (ring with stubs `S_i` → `Mouth_i` → merge piece `Turn_i`). A forklift
 * gets `approach: 'reverse'` to stub S2 and is sampled every fixed step through
 * `handle.locate()`; an odometer integrates the arc length between samples
 * (straight pieces, so the integration is exact up to float rounding).
 *
 * Asserted against the real run:
 *  - the turn piece (where the plan direction flips +1 → −1, at its END — the
 *    flip lies between two fixed steps, both samples within 1e-4 m of the END);
 *  - the sequence of (path, direction) pieces: forward to the turn END,
 *    reverse over turn + chain into the stub START, out forward again;
 *  - forward samples: `distanceM(loc, reverseApproach(S2))` = odometer way to
 *    the dock call (stub START);
 *  - reversing samples (dir = −1, on the turn piece, the mouth and the stub):
 *    `distanceM(loc, forwardApproach('L2'))` = odometer way to the END of L2
 *    (reverse to the stub START, out forward over the chain and the turn) —
 *    with and without the `stubId` hint.
 *
 * Continuous kernel only: in DES the manager clock jumps between events and
 * `handle.locate` reports the vehicle's last EVENT time, so per-frame sampling
 * cannot integrate the way there.
 *
 * Sim time only (fixed host steps); every loop is bounded.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultAgvFleet, type AgvLocation } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultPathDockRegistry } from '../../src/core/engine/rv-path-dock';
import { setReverseGateOpen } from '../../src/core/engine/rv-movement-authority';
import {
  RouteTable, reverseApproach, forwardApproach, pathNetworkRouteGraph, type RouteGraph,
} from '../../src/core/fleet/core/route-table';
import { clearShared } from '../helpers/agv-harness';
import { stubLayout, makeStubWorld, forkCfg, FORK, FORK_MESH, delay, type Mode } from '../helpers/agv-stub-world';

beforeEach(() => { clearShared(); setReverseGateOpen(true); });
afterEach(() => setReverseGateOpen(true));

/** Distance tolerance (m): the odometer integrates exact arc lengths, only float rounding remains. */
const TOL = 1e-6;
/** Turn-point tolerance (m): one fixed step of the final deceleration / first reverse acceleration. */
const TURN_TOL = 1e-4;

interface Sample { pathId: string; s: number; dir: 1 | -1; odo: number; afterService: boolean }

interface Run {
  samples: Sample[];
  /** Compressed (path, dir) sequence. */
  seq: string[];
  /** Odometer at the dock call (stub START), at the END of L2 after the service. */
  odoDock: number; odoL2End: number;
  dock: { pathId: string; s: number; dir: number } | null;
  turn: { pathId: string; s: number; nextPathId: string; sAfter: number } | null;
  /** Samples whose `t` is not the host clock of that step. */
  clockMismatch: number;
  unhandledSteps: number;
  graph: RouteGraph;
}

/** Odometer increment between two locate samples (adjacent pieces, straight lines). */
function stepWay(g: RouteGraph, a: Sample, b: AgvLocation): number | null {
  const La = g.length(a.pathId);
  if (a.pathId === b.pathId) {
    if (a.dir === b.dir) return Math.abs(b.s - a.s);
    // direction flip on the same piece: +1 → −1 at the END, −1 → +1 at the START
    return a.dir === 1 ? (La - a.s) + (La - b.s) : a.s + b.s;
  }
  if (a.dir === 1 && b.dir === 1 && g.successors(a.pathId).includes(b.pathId)) return (La - a.s) + b.s;
  if (a.dir === -1 && b.dir === -1 && g.successors(b.pathId).includes(a.pathId)) return a.s + (g.length(b.pathId) - b.s);
  return null;
}

function run(mode: Mode): Run {
  stubLayout();
  const w = makeStubWorld(mode, [{ name: 'F', cfg: forkCfg('L0', 3500), mesh: FORK_MESH, body: FORK }], 300);
  const graph = pathNetworkRouteGraph(getDefaultPathNetwork());
  const fleet = getDefaultAgvFleet();
  const h = fleet.get('F')!;
  const r: Run = { samples: [], seq: [], odoDock: -1, odoL2End: -1, dock: null, turn: null, unhandledSteps: 0, clockMismatch: 0, graph };
  let served = false;
  let odo = 0;
  const loc: AgvLocation = { pathId: '', s: 0, dir: 1, t: 0 };
  const seam: AgvLocation = { pathId: '', s: 0, dir: 1, t: 0 };
  const sample = (): boolean => {
    if (!h.locate!(loc)) return false;
    if (Math.abs(loc.t - w.now()) > 1e-9) r.clockMismatch++;
    return true;
  };
  getDefaultPathDockRegistry().register('S2', {
    onVehicleArrive: (_id, release) => {
      if (h.locate!(seam)) r.dock = { pathId: seam.pathId, s: seam.s, dir: seam.dir };
      delay(2, () => { served = true; release(); });
    },
  });
  h.assign({ destination: 'S2', approach: 'reverse', serviceState: 'Handling', onServiceEnd: () => h.clear() });
  for (let i = 0; i < 300 * 60 && !w.done() && r.odoL2End < 0; i++) {
    w.step();
    if (!sample()) continue;
    const prev = r.samples[r.samples.length - 1];
    if (prev) {
      const d = stepWay(graph, prev, loc);
      if (d === null) { r.unhandledSteps++; continue; }
      odo += d;
      // the last forward sample before the flip is the standstill at the turn point
      if (prev.dir === 1 && loc.dir === -1 && r.turn === null) r.turn = { pathId: prev.pathId, s: prev.s, nextPathId: loc.pathId, sAfter: loc.s };
      // the END of L2 after the service: crossed into L2's successor
      if (served && prev.pathId === 'L2' && loc.pathId !== 'L2') r.odoL2End = odo - loc.s;
    }
    const key = `${loc.pathId}${loc.dir === 1 ? '+' : '-'}`;
    if (r.seq[r.seq.length - 1] !== key) r.seq.push(key);
    r.samples.push({ pathId: loc.pathId, s: loc.s, dir: loc.dir, odo, afterService: served });
  }
  w.dispose();
  // the dock call happens at the stub START: the first reversing sample there
  const atDock = r.samples.find((x) => x.pathId === 'S2' && x.dir === -1 && Math.abs(x.s) < 1e-9);
  if (atDock) r.odoDock = atDock.odo;
  return r;
}

/** Forward shortest piece sequence (successor edges) from `from` to `to` — BFS, ties by id. */
function forwardPieces(g: RouteGraph, from: string, to: string): string[] {
  const parent = new Map<string, string | null>([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const p = queue.shift()!;
    if (p === to) break;
    for (const q of [...g.successors(p)].sort()) if (!parent.has(q)) { parent.set(q, p); queue.push(q); }
  }
  const out: string[] = [];
  for (let q: string | null | undefined = to; q; q = parent.get(q)) out.unshift(q);
  return out;
}

/** The stub chain of `stubId` with the same rule as `reverseApproach`: stub … up to (excluding) the turn. */
function chainOf(g: RouteGraph, stubId: string, turnId: string): string[] {
  const out: string[] = [];
  for (let q = stubId; q !== turnId && out.length < 64; q = g.successors(q)[0]) out.push(q);
  return out;
}

describe('plan-559 Phase 1 — RouteTable.reverseApproach against a real Agv stub run', () => {
  // Continuous kernel only: in DES the manager clock jumps between events and `handle.locate`
  // reports the vehicle's last EVENT time, so a per-frame odometer cannot integrate the way.
  for (const mode of ['continuous'] as Mode[]) {
    it(`${mode}: turn piece, piece sequence, directions and remaining distances match the prediction`, () => {
      const r = run(mode);
      const g = r.graph;
      const table = new RouteTable(g);
      const station = reverseApproach(g, 'S2');
      expect(station).not.toBeNull();
      const turnId = station!.viaPathId;
      const chain = chainOf(g, 'S2', turnId);
      expect(turnId).toBe('Turn2');
      expect(chain).toEqual(['S2', 'Mouth2']);

      // the real run reached the dock and the END of L2 afterwards
      expect(r.unhandledSteps).toBe(0);
      expect(r.dock).not.toBeNull();
      expect(r.dock!.pathId).toBe('S2');
      expect(Math.abs(r.dock!.s)).toBeLessThan(1e-9);
      expect(r.dock!.dir).toBe(-1);
      expect(r.odoDock).toBeGreaterThan(0);
      expect(r.odoL2End).toBeGreaterThan(r.odoDock);

      // turn piece: the direction flips at its END
      expect(r.turn).not.toBeNull();
      expect(r.turn!.pathId).toBe(turnId);
      expect(r.turn!.nextPathId).toBe(turnId);
      // the flip lies between two fixed steps: the last forward and the first reverse sample
      // both sit within TURN_TOL of the turn END (no sample lands exactly on it)
      expect(r.turn!.s).toBeLessThanOrEqual(g.length(turnId));
      expect(r.turn!.sAfter).toBeLessThanOrEqual(g.length(turnId));
      expect(g.length(turnId) - r.turn!.s).toBeLessThan(TURN_TOL);
      expect(g.length(turnId) - r.turn!.sAfter).toBeLessThan(TURN_TOL);
      expect(r.clockMismatch).toBe(0);

      // piece sequence with directions
      const fwd = forwardPieces(g, 'L0', turnId).map((p) => `${p}+`);
      const rev = [turnId, ...[...chain].reverse()].map((p) => `${p}-`);
      const out = [...chain, turnId, 'L2'].map((p) => `${p}+`);
      expect(r.seq.slice(0, fwd.length + rev.length + out.length)).toEqual([...fwd, ...rev, ...out]);

      // remaining distance, forward approach: distanceM to the stub service position
      const approach = r.samples.filter((x) => x.dir === 1 && !x.afterService && x.odo < r.odoDock - 1e-9);
      expect(approach.length).toBeGreaterThan(50);
      let maxErrApproach = 0;
      for (const x of approach) {
        const pred = table.distanceM({ pathId: x.pathId, s: x.s, dir: 1 }, station!);
        expect(Number.isFinite(pred)).toBe(true);
        maxErrApproach = Math.max(maxErrApproach, Math.abs(pred - (r.odoDock - x.odo)));
      }
      expect(maxErrApproach).toBeLessThan(TOL);
      // whole-route check from the start position (L0, s = 3.5 m)
      const first = approach[0];
      expect(first.pathId).toBe('L0');

      // remaining distance, reversing (dir = −1) on turn, mouth and stub: to the END of L2
      const L2 = forwardApproach('L2');
      const reversing = r.samples.filter((x) => x.dir === -1 && !x.afterService);
      const onPieces = new Set(reversing.map((x) => x.pathId));
      expect([...onPieces].sort()).toEqual([...rev.map((k) => k.slice(0, -1))].sort());
      const maxErr: Record<string, number> = {};
      const maxErrHint: Record<string, number> = {};
      for (const x of reversing) {
        const actual = r.odoL2End - x.odo;
        const pred = table.distanceM({ pathId: x.pathId, s: x.s, dir: -1 }, L2);
        const predHint = table.distanceM({ pathId: x.pathId, s: x.s, dir: -1, stubId: 'S2' }, L2);
        expect(Number.isFinite(pred)).toBe(true);
        expect(Number.isFinite(predHint)).toBe(true);
        maxErr[x.pathId] = Math.max(maxErr[x.pathId] ?? 0, Math.abs(pred - actual));
        maxErrHint[x.pathId] = Math.max(maxErrHint[x.pathId] ?? 0, Math.abs(predHint - actual));
      }
      console.log(`[559-reverse ${mode}] turn=${r.turn!.pathId}@${r.turn!.s.toFixed(6)} seq=${r.seq.join(' ')}`
        + ` odoDock=${r.odoDock.toFixed(6)} odoL2End=${r.odoL2End.toFixed(6)}`
        + ` predFromStart=${table.distanceM({ pathId: first.pathId, s: first.s, dir: 1 }, station!).toFixed(6)}`
        + ` (start L0@${first.s.toFixed(6)}, odo ${first.odo.toFixed(6)})`
        + ` maxErrApproach=${maxErrApproach.toExponential(2)} maxErrRev=${JSON.stringify(maxErr)}`
        + ` maxErrRevHint=${JSON.stringify(maxErrHint)} samples=${r.samples.length} reversing=${reversing.length}`
        + ` turnGap=${(g.length(turnId) - r.turn!.s).toExponential(2)}/${(g.length(turnId) - r.turn!.sAfter).toExponential(2)}`);
      for (const p of onPieces) {
        expect(maxErr[p], `dir=-1 on ${p}`).toBeDefined();
        expect(maxErr[p], `dir=-1 on ${p}`).toBeLessThan(TOL);
        expect(maxErrHint[p], `dir=-1 + stubId on ${p}`).toBeLessThan(TOL);
      }
    }, 120000);
  }
});
