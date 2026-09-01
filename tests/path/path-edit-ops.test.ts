// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-447 §9.1 — planner geometry ops on `rv_extras.Path.segments`.
 *
 * A drag commit is an ORDINARY `setField` op on the generic `'json'` field
 * `segments` (no new op kind, no schema change — plan-447 §2.3), so this suite
 * exercises exactly that shape: write the new spec list into the node, run
 * `RVPathComponent.reapplyConfig()`, and check that
 *
 *  - length / segment count re-derive live,
 *  - the network's per-pathId change event fires,
 *  - "undo" (re-applying the `prev` value) restores the geometry EXACTLY,
 *  - a chain-vertex drag updates BOTH adjacent line segments coordinated,
 *  - arc center / radius handles recompute the analytic arc length.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { RVPathComponent } from '../../src/core/engine/rv-path';
import type { PathSegmentSpec } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { getDefaultSpacingController } from '../../src/core/engine/rv-spacing-controller';
import {
  arcLength,
  cloneSegmentSpecs,
  derivePathHandles,
  findPathHandle,
  movePathHandle,
  readSegmentSpecs,
  snapDragTarget,
  specListLength,
  writeSegmentSpecs,
} from '../../src/core/engine/rv-path-edit';

const L1: PathSegmentSpec = { kind: 'line', from: [0, 0, 0], to: [0, 0, 5] };
const L2: PathSegmentSpec = { kind: 'line', from: [0, 0, 5], to: [10, 0, 5] };
const ARC: PathSegmentSpec = {
  kind: 'arc',
  center: [0, 0, 0],
  radius: 2,
  startAngle: 0,
  degrees: 90,
  plane: 'XZ',
};

function pathNode(name: string, segments: PathSegmentSpec[]): Object3D {
  const node = new Object3D();
  node.name = name;
  node.userData.realvirtual = { Path: { segments: cloneSegmentSpecs(segments) } };
  return node;
}

/** The runtime half of a `setField(segments)` commit. */
function commitSegments(comp: RVPathComponent, specs: readonly PathSegmentSpec[]): void {
  writeSegmentSpecs(comp.node as unknown as { userData: Record<string, unknown> }, specs);
  comp.reapplyConfig();
}

beforeEach(() => {
  getDefaultPathNetwork().clear();
  getDefaultZoneRegistry().clear();
  getDefaultSpacingController().clear();
});

describe('path handles — derivation from the segment spec list', () => {
  it('a two-line chain yields three vertex handles, the outer two flagged as endpoints', () => {
    const handles = derivePathHandles([L1, L2]);
    const vertices = handles.filter((h) => h.kind === 'vertex');
    expect(vertices.map((h) => h.id)).toEqual(['v0', 'v1', 'v2']);
    expect(vertices[0].endpoint).toBe(true);
    expect(vertices[1].endpoint).toBe(false);
    expect(vertices[2].endpoint).toBe(true);
    expect(vertices[0].position).toEqual([0, 0, 0]);
    expect(vertices[1].position).toEqual([0, 0, 5]);
    expect(vertices[2].position).toEqual([10, 0, 5]);
  });

  it('an arc contributes a center and a radius handle, not a draggable endpoint', () => {
    const handles = derivePathHandles([ARC]);
    expect(handles.map((h) => h.id).sort()).toEqual(['c0', 'r0']);
    const center = findPathHandle([ARC], 'c0')!;
    expect(center.position).toEqual([0, 0, 0]);
    // Radius handle sits on the arc midpoint (45° on a 90° XZ arc of R=2).
    const radius = findPathHandle([ARC], 'r0')!;
    expect(radius.position[0]).toBeCloseTo(2 * Math.cos(Math.PI / 4), 10);
    expect(radius.position[2]).toBeCloseTo(2 * Math.sin(Math.PI / 4), 10);
  });

  it('a line→arc chain still exposes the line-side vertices', () => {
    const ids = derivePathHandles([L1, ARC]).map((h) => h.id);
    expect(ids).toContain('v0'); // line start
    expect(ids).toContain('v1'); // line end / arc start slot (line neighbour wins)
    expect(ids).toContain('c1');
    expect(ids).toContain('r1');
    // Slot 2 has an arc on its left and nothing on its right — no vertex handle.
    expect(ids).not.toContain('v2');
  });
});

describe('movePathHandle — coordinated, non-destructive spec mutation', () => {
  it('a chain-vertex drag updates BOTH adjacent line segments', () => {
    const moved = movePathHandle([L1, L2], 'v1', [0, 0, 8]);
    expect((moved[0] as { to: number[] }).to).toEqual([0, 0, 8]);
    expect((moved[1] as { from: number[] }).from).toEqual([0, 0, 8]);
    // The chain never tears: prev.to === next.from.
    expect((moved[0] as { to: number[] }).to).toEqual((moved[1] as { from: number[] }).from);
  });

  it('the input spec list is never mutated (the pre-drag list is the undo value)', () => {
    const before = cloneSegmentSpecs([L1, L2]);
    movePathHandle(before, 'v1', [3, 0, 3]);
    expect(before).toEqual(cloneSegmentSpecs([L1, L2]));
  });

  it('an endpoint drag only touches its one neighbour and changes the length', () => {
    const moved = movePathHandle([L1, L2], 'v0', [0, 0, -5]);
    expect((moved[0] as { from: number[] }).from).toEqual([0, 0, -5]);
    expect((moved[1] as { from: number[] }).from).toEqual([0, 0, 5]);
    expect(specListLength(moved)).toBeCloseTo(10 + 10, 10);
  });

  it('an unknown handle id is a no-op copy', () => {
    expect(movePathHandle([L1, L2], 'v9', [1, 2, 3])).toEqual(cloneSegmentSpecs([L1, L2]));
    expect(movePathHandle([L1, L2], 'zz', [1, 2, 3])).toEqual(cloneSegmentSpecs([L1, L2]));
  });

  it('arc-center drag translates the arc and keeps the length', () => {
    const before = arcLength(ARC as never);
    const moved = movePathHandle([ARC], 'c0', [4, 0, 4]);
    expect((moved[0] as { center: number[] }).center).toEqual([4, 0, 4]);
    expect(specListLength(moved)).toBeCloseTo(before, 10);
  });

  it('arc-radius drag recomputes the analytic length (R·|sweep|)', () => {
    // Drag the radius handle to 5 m from the center along +X.
    const moved = movePathHandle([ARC], 'r0', [5, 0, 0]);
    expect((moved[0] as { radius: number }).radius).toBeCloseTo(5, 10);
    expect(specListLength(moved)).toBeCloseTo((5 * 90 * Math.PI) / 180, 10);
  });

  it('arc-radius ignores the out-of-plane component (never NaN, never negative)', () => {
    const moved = movePathHandle([ARC], 'r0', [3, 99, 4]); // Y is out of the XZ plane
    expect((moved[0] as { radius: number }).radius).toBeCloseTo(5, 10);
    const degenerate = movePathHandle([ARC], 'r0', [0, 0, 0]);
    expect((degenerate[0] as { radius: number }).radius).toBe(0);
    expect(Number.isNaN(specListLength(degenerate))).toBe(false);
  });
});

describe('setField(segments) commit — live re-derivation + change event', () => {
  it('a vertex drag commit updates length and segment count live', () => {
    const comp = new RVPathComponent(pathNode('Route', [L1, L2]));
    comp.init({} as never);
    expect(comp.path!.length).toBeCloseTo(15, 10);

    const before = readSegmentSpecs(comp.node as unknown as { userData: Record<string, unknown> });
    commitSegments(comp, movePathHandle(before, 'v1', [0, 0, 8]));

    expect(comp.path!.segments.length).toBe(2);
    // L1 = (0,0,0)→(0,0,8) = 8 m; L2 = (0,0,8)→(10,0,5) = √(100+9) m.
    expect(comp.path!.length).toBeCloseTo(8 + Math.hypot(10, 3), 10);
    expect(getDefaultPathNetwork().get('Route')).toBe(comp.path);
  });

  it('the network change event fires with the pathId', () => {
    const comp = new RVPathComponent(pathNode('Route', [L1, L2]));
    comp.init({} as never);
    const seen: string[] = [];
    const un = getDefaultPathNetwork().onPathChanged((id) => seen.push(id));
    try {
      commitSegments(comp, movePathHandle([L1, L2], 'v1', [0, 0, 9]));
    } finally {
      un();
    }
    expect(seen).toEqual(['Route']);
  });

  it('an id rename announces BOTH the old and the new id', () => {
    const node = pathNode('Old', [L1]);
    const comp = new RVPathComponent(node);
    comp.init({} as never);
    const seen: string[] = [];
    const un = getDefaultPathNetwork().onPathChanged((id) => seen.push(id));
    try {
      (node.userData.realvirtual as Record<string, Record<string, unknown>>).Path.id = 'New';
      comp.reapplyConfig();
    } finally {
      un();
    }
    expect(seen).toEqual(['Old', 'New']);
  });

  it('undo (re-applying the prev value) restores the geometry EXACTLY', () => {
    const comp = new RVPathComponent(pathNode('Route', [L1, L2]));
    comp.init({} as never);
    const before = readSegmentSpecs(comp.node as unknown as { userData: Record<string, unknown> });
    const lengthBefore = comp.path!.length;

    commitSegments(comp, movePathHandle(before, 'v1', [7, 0, 7]));
    expect(comp.path!.length).not.toBeCloseTo(lengthBefore, 6);

    commitSegments(comp, before); // ← the op log's undo writes `prev` back
    expect(comp.path!.length).toBeCloseTo(lengthBefore, 12);
    expect(
      readSegmentSpecs(comp.node as unknown as { userData: Record<string, unknown> }),
    ).toEqual(before);
  });

  it('save roundtrip: the committed specs survive a re-parse from the node payload (F5)', () => {
    const comp = new RVPathComponent(pathNode('Route', [L1, L2]));
    comp.init({} as never);
    const edited = movePathHandle([L1, L2], 'v2', [10, 0, 12]);
    commitSegments(comp, edited);
    const lengthLive = comp.path!.length;

    // A save/load roundtrip is exactly "re-parse the node's rv_extras".
    const reloaded = new RVPathComponent(pathNode('Route2', edited));
    reloaded.init({} as never);
    expect(reloaded.path!.length).toBeCloseTo(lengthLive, 12);
  });
});

describe('snapDragTarget (F4 rastung)', () => {
  const candidates = [
    { id: 'A:end', position: [0, 0, 5] as [number, number, number] },
    { id: 'B:start', position: [10, 0, 0] as [number, number, number] },
  ];

  it('rasts onto the nearest candidate inside the radius', () => {
    const r = snapDragTarget([0.1, 0, 5.05], candidates, 0.35);
    expect(r.snappedTo?.id).toBe('A:end');
    expect(r.position).toEqual([0, 0, 5]);
  });

  it('leaves the target untouched outside the radius', () => {
    const r = snapDragTarget([3, 0, 3], candidates, 0.35);
    expect(r.snappedTo).toBeNull();
    expect(r.position).toEqual([3, 0, 3]);
    expect(r.distance).toBe(Number.POSITIVE_INFINITY);
  });

  it('ties break deterministically on the candidate id (no flicker)', () => {
    const tie = [
      { id: 'zzz', position: [0, 0, 0] as [number, number, number] },
      { id: 'aaa', position: [0, 0, 0] as [number, number, number] },
    ];
    expect(snapDragTarget([0, 0, 0], tie, 1).snappedTo?.id).toBe('aaa');
    expect(snapDragTarget([0, 0, 0], [...tie].reverse(), 1).snappedTo?.id).toBe('aaa');
  });
});
