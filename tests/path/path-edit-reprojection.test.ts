// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-447 §9.3 — traveler re-projection after a live geometry edit (F6).
 *
 * `RVPath` is READONLY and `reapplyConfig()` REPLACES it. A `PathTraveler`
 * captured the old object directly (rv-path-traveler.ts `path: RVPath | null`),
 * so without a re-fetch + REASSIGNMENT a parked/docked vehicle keeps an orphaned
 * reference: `network.get(pathId)` never matches it again, the dock lookup
 * (`Agv.ts` `dockAt(t.path!.id)`) still resolves by id but the geometry it
 * drives on is the pre-edit one — and a shrunk path leaves `s` beyond the end.
 *
 * This suite pins the contract: NEW object identity, valid pose, clamped `s`,
 * the dock case (atEnd, waiting for `release()`), and DES segment occupancy.
 *
 * It also carries the plan's Phase-0 (F7) circuit check as a HEADLESS
 * SURROGATE — see the last describe block for why.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Quaternion, Vector3 } from 'three';
import { RVPathComponent } from '../../src/core/engine/rv-path';
import type { PathSegmentSpec } from '../../src/core/engine/rv-path';
import {
  getDefaultPathNetwork,
  reprojectTravelersOnPath,
} from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { getDefaultSpacingController } from '../../src/core/engine/rv-spacing-controller';
import { PathTraveler } from '../../src/core/engine/rv-path-traveler';
import { getDefaultPathDockRegistry } from '../../src/core/engine/rv-path-dock';
import {
  cloneSegmentSpecs,
  movePathHandle,
  writeSegmentSpecs,
} from '../../src/core/engine/rv-path-edit';

const L10: PathSegmentSpec = { kind: 'line', from: [0, 0, 0], to: [0, 0, 10] };

function pathNode(name: string, fields: Record<string, unknown>): Object3D {
  const node = new Object3D();
  node.name = name;
  node.userData.realvirtual = { Path: fields };
  return node;
}

function makePath(id: string, segments: PathSegmentSpec[], extra: Record<string, unknown> = {}) {
  const node = pathNode(id, { segments: cloneSegmentSpecs(segments), ...extra });
  const comp = new RVPathComponent(node);
  comp.init({} as never);
  return { node, comp };
}

/** Commit a new segment list the way a planner drag does. */
function commit(comp: RVPathComponent, specs: readonly PathSegmentSpec[]): void {
  writeSegmentSpecs(comp.node as unknown as { userData: Record<string, unknown> }, specs);
  comp.reapplyConfig();
}

beforeEach(() => {
  getDefaultPathNetwork().clear();
  getDefaultZoneRegistry().clear();
  getDefaultSpacingController().clear();
  getDefaultPathDockRegistry().clear();
});

describe('re-projection — identity, pose, clamping', () => {
  it('a traveler at s = 0.5·L gets a NEW path reference and a valid pose', () => {
    const { comp } = makePath('P', [L10]);
    const network = getDefaultPathNetwork();
    const spacing = getDefaultSpacingController();
    const oldPath = comp.path!;

    const t = new PathTraveler('agv1', oldPath, network);
    t.s = 5;
    spacing.add(t);

    // Extend the path 10 → 20 m (endpoint drag).
    commit(comp, movePathHandle([L10], 'v1', [0, 0, 20]));

    const fresh = network.get('P')!;
    expect(fresh).not.toBe(oldPath); // the object WAS replaced
    expect(t.path).toBe(fresh); // … and the traveler follows it
    expect(t.path).not.toBe(oldPath);
    expect(t.s).toBeCloseTo(5, 12);

    const pos = new Vector3();
    const quat = new Quaternion();
    t.getPose(pos, quat);
    expect(Number.isFinite(pos.x + pos.y + pos.z)).toBe(true);
    expect(pos.z).toBeCloseTo(5, 10);
    expect(Number.isNaN(quat.x + quat.y + quat.z + quat.w)).toBe(false);
  });

  it('s beyond the SHRUNK length is clamped to the new end (no jump past the path)', () => {
    const { comp } = makePath('P', [L10]);
    const network = getDefaultPathNetwork();
    const spacing = getDefaultSpacingController();

    const t = new PathTraveler('agv1', comp.path!, network);
    t.s = 9;
    spacing.add(t);

    commit(comp, movePathHandle([L10], 'v1', [0, 0, 4])); // 10 m → 4 m

    expect(t.path).toBe(network.get('P'));
    expect(t.path!.length).toBeCloseTo(4, 10);
    expect(t.s).toBeCloseTo(4, 10);
    const pos = new Vector3();
    t.getPosition(pos);
    expect(pos.z).toBeCloseTo(4, 10);
  });

  it('a closed path wraps s instead of clamping it', () => {
    const { comp } = makePath('Loop', [L10], { closed: true });
    const network = getDefaultPathNetwork();
    const spacing = getDefaultSpacingController();

    const t = new PathTraveler('agv1', comp.path!, network);
    t.s = 9;
    spacing.add(t);

    commit(comp, movePathHandle([L10], 'v1', [0, 0, 4])); // L = 4
    expect(t.s).toBeCloseTo(1, 10); // 9 mod 4
  });

  it('travelers on OTHER paths are untouched', () => {
    const a = makePath('A', [L10]);
    const b = makePath('B', [L10]);
    const network = getDefaultPathNetwork();
    const spacing = getDefaultSpacingController();

    const ta = new PathTraveler('agvA', a.comp.path!, network);
    ta.s = 3;
    const tb = new PathTraveler('agvB', b.comp.path!, network);
    tb.s = 3;
    spacing.add(ta);
    spacing.add(tb);
    const bBefore = b.comp.path!;

    commit(a.comp, movePathHandle([L10], 'v1', [0, 0, 30]));

    expect(ta.path).toBe(network.get('A'));
    expect(tb.path).toBe(bBefore); // unchanged object, unchanged position
    expect(tb.s).toBe(3);
  });

  it('reprojectTravelersOnPath returns 0 for an unknown path id', () => {
    expect(reprojectTravelersOnPath('nope')).toBe(0);
  });

  it('a non-finite s is healed to 0 instead of propagating NaN', () => {
    const { comp } = makePath('P', [L10]);
    const spacing = getDefaultSpacingController();
    const t = new PathTraveler('agv1', comp.path!, getDefaultPathNetwork());
    t.s = Number.NaN;
    spacing.add(t);

    commit(comp, movePathHandle([L10], 'v1', [0, 0, 12]));
    expect(t.s).toBe(0);
  });
});

describe('dock case — a parked vehicle survives the edit (Agv.ts dockAt)', () => {
  it('atEnd stays at the (new) end, the dock still resolves, release drives on', () => {
    const p = makePath('Station', [L10], { successors: ['Next'] });
    const next = makePath('Next', [{ kind: 'line', from: [0, 0, 10], to: [0, 0, 20] }]);
    const network = getDefaultPathNetwork();
    const spacing = getDefaultSpacingController();

    let released: (() => void) | null = null;
    getDefaultPathDockRegistry().register('Station', {
      onVehicleArrive: (_agvId, release) => {
        released = release;
      },
    });

    const t = new PathTraveler('agv1', p.comp.path!, network);
    t.s = p.comp.path!.length;
    t.v = 0;
    t.atEnd = true; // parked at the segment end, waiting for release()
    spacing.add(t);
    const oldPath = t.path!;

    // The station segment is re-shaped WHILE the vehicle is docked.
    commit(p.comp, movePathHandle([L10], 'v1', [0, 0, 14]));

    const fresh = network.get('Station')!;
    expect(fresh).not.toBe(oldPath);
    expect(t.path).toBe(fresh); // identity check — the vehicle is not frozen
    expect(t.s).toBeCloseTo(fresh.length, 10); // still parked at the END
    expect(t.atEnd).toBe(true);
    // The dock lookup Agv.ts performs (`dockAt(t.path!.id)`) still resolves.
    expect(getDefaultPathDockRegistry().dockAt(t.path!.id)).not.toBeNull();

    // "release()" → the vehicle drives on and hands off to the successor.
    network.resolveGraph();
    t.v = 1000; // mm/s
    t.advance(1); // 1 m
    expect(t.path!.id).toBe('Next');
    expect(t.atEnd).toBe(false);
    expect(t.s).toBeCloseTo(1, 6);
    expect(next.comp.path).toBe(network.get('Next'));
    expect(released).toBeNull(); // the dock never re-fired during the edit
  });
});

describe('DES segment occupancy stays consistent across the edit', () => {
  it('occupantsOf keeps counting the vehicles on the edited segment', () => {
    const { comp } = makePath('P', [L10]);
    const network = getDefaultPathNetwork();
    const spacing = getDefaultSpacingController();

    const a = new PathTraveler('a', comp.path!, network);
    a.s = 2;
    const b = new PathTraveler('b', comp.path!, network);
    b.s = 6;
    spacing.add(a);
    spacing.add(b);
    expect(spacing.occupantsOf('P')).toBe(2);

    commit(comp, movePathHandle([L10], 'v1', [0, 0, 5])); // shrink under both

    expect(spacing.occupantsOf('P')).toBe(2);
    expect(spacing.occupantsOf('P', 'a')).toBe(1);
    // Both are inside the new length — no vehicle "fell off" the segment.
    expect(a.s).toBeLessThanOrEqual(a.path!.length + 1e-9);
    expect(b.s).toBeCloseTo(5, 10);
    // Headway bookkeeping still sees the pair in the right order.
    spacing.refresh();
    expect(spacing.leaderOf('a')).toBe('b');
  });

  it('forEachOnPath is the fleet iteration seam and marks the controller dirty', () => {
    const { comp } = makePath('P', [L10]);
    const spacing = getDefaultSpacingController();
    const t = new PathTraveler('a', comp.path!, getDefaultPathNetwork());
    spacing.add(t);
    const visited: string[] = [];
    expect(spacing.forEachOnPath('P', (x) => visited.push(x.id))).toBe(1);
    expect(visited).toEqual(['a']);
    expect(spacing.forEachOnPath('other', () => undefined)).toBe(0);
  });
});

/**
 * plan-447 Phase 0 (F7) — "fahren die AGVs im Course-Demomodell im Kreis?"
 *
 * BEFUND (documented, see the implementation summary): the Course demo model is
 * NOT present in this repository — neither under `public/models/`, nor in the
 * private sibling's project folders, nor referenced anywhere in `src/`. The
 * live measurement described in the plan (`web_transport_status` +
 * `web_screenshot_burst` against a running viewer) is therefore not reproducible
 * headless in this worktree.
 *
 * What IS verifiable headless is the MECHANISM the question is about: does a
 * ring of path segments close, i.e. does a traveler that walks A→B→C→D→A come
 * back to its start and keep circulating? That is exactly the failure mode
 * ("Pfadschluss") the plan names first, and it is pinned here so a regression in
 * the hand-off/carry logic cannot hide behind a missing model.
 */
describe('Phase 0 (F7) — ring closure, headless surrogate for the Course model', () => {
  it('a four-segment ring closes: the traveler returns to its start and laps', () => {
    const network = getDefaultPathNetwork();
    // 10×10 m square, each edge a own path, successors ring back to A.
    makePath('A', [{ kind: 'line', from: [0, 0, 0], to: [10, 0, 0] }], { successors: ['B'] });
    makePath('B', [{ kind: 'line', from: [10, 0, 0], to: [10, 0, 10] }], { successors: ['C'] });
    makePath('C', [{ kind: 'line', from: [10, 0, 10], to: [0, 0, 10] }], { successors: ['D'] });
    makePath('D', [{ kind: 'line', from: [0, 0, 10], to: [0, 0, 0] }], { successors: ['A'] });
    network.resolveGraph();

    const t = new PathTraveler('agv1', network.get('A')!, network);
    t.v = 1000; // 1 m/s
    const seen: string[] = [];
    t.hooks.onArrive = (nodeId) => seen.push(nodeId);

    // 2 laps of 40 m plus 1 m, at 1 m/s in 0.1 s steps.
    for (let i = 0; i < 810; i++) t.advance(0.1);

    expect(t.atEnd).toBe(false); // never stranded at a dead end
    expect(t.path).not.toBeNull();
    // Two full laps ⇒ every segment of the ring was completed twice.
    for (const id of ['A', 'B', 'C', 'D']) {
      expect(seen.filter((s) => s === id).length).toBe(2);
    }
    // Back on the ring's first segment, 1 m past its start.
    expect(t.path!.id).toBe('A');
    expect(t.s).toBeCloseTo(1, 6);
    const pos = new Vector3();
    t.getPosition(pos);
    expect(pos.x).toBeCloseTo(1, 6);
    expect(pos.z).toBeCloseTo(0, 6);
  });

  it('a ring with a MISSING successor is a dead end — the failure mode the plan asks about', () => {
    const network = getDefaultPathNetwork();
    makePath('A', [{ kind: 'line', from: [0, 0, 0], to: [10, 0, 0] }], { successors: ['B'] });
    makePath('B', [{ kind: 'line', from: [10, 0, 0], to: [10, 0, 10] }], { successors: [] });
    network.resolveGraph();

    const t = new PathTraveler('agv1', network.get('A')!, network);
    t.v = 1000;
    for (let i = 0; i < 400; i++) t.advance(0.1);

    expect(t.path!.id).toBe('B');
    expect(t.atEnd).toBe(true); // stranded — the circle does NOT close
    expect(t.v).toBe(0);
  });

  it('a ring survives a live geometry edit of one of its segments', () => {
    const network = getDefaultPathNetwork();
    const a = makePath('A', [{ kind: 'line', from: [0, 0, 0], to: [10, 0, 0] }], {
      successors: ['B'],
    });
    makePath('B', [{ kind: 'line', from: [10, 0, 0], to: [0, 0, 0] }], { successors: ['A'] });
    network.resolveGraph();
    const spacing = getDefaultSpacingController();

    const t = new PathTraveler('agv1', network.get('A')!, network);
    t.s = 4;
    t.v = 1000;
    spacing.add(t);

    // Someone drags A's end while the vehicle is driving on it.
    commit(a.comp, movePathHandle([{ kind: 'line', from: [0, 0, 0], to: [10, 0, 0] }], 'v1', [
      6, 0, 0,
    ]));
    network.resolveGraph();

    expect(t.path).toBe(network.get('A'));
    expect(t.s).toBeCloseTo(4, 10);
    for (let i = 0; i < 200; i++) t.advance(0.1);
    expect(t.atEnd).toBe(false); // still circulating after the edit
  });
});
