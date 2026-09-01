// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-447 §9.2 — snappoints at the path ends (F2).
 *
 * Path ends speak the ordinary snap vocabulary (`typeId` / `flow` / axis code),
 * so the registry, the marker renderer and the snap tools need no special case.
 * The ONE property that is special: path snaps are DATA-BOUND — their position
 * comes from the segment data, so they are RE-REGISTERED after every geometry
 * edit. This suite pins both halves.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D } from 'three';
import { RVPathComponent, getPathEndpoints, parsePathExtras } from '../../src/core/engine/rv-path';
import type { PathSegmentSpec } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { SnapPointRegistry } from '../../src/core/engine/rv-snap-point-registry';
import {
  PathSnapSource,
  pathSnapId,
  PATH_END_SNAP_TYPE_ID,
} from '../../src/plugins/snap-point/path-snap-source';
import {
  cloneSegmentSpecs,
  movePathHandle,
  writeSegmentSpecs,
} from '../../src/core/engine/rv-path-edit';

const L1: PathSegmentSpec = { kind: 'line', from: [0, 0, 0], to: [0, 0, 5] };
const L2: PathSegmentSpec = { kind: 'line', from: [0, 0, 5], to: [10, 0, 5] };

function pathNode(name: string, fields: Record<string, unknown>): Object3D {
  const node = new Object3D();
  node.name = name;
  node.userData.realvirtual = { Path: fields };
  return node;
}

let registry: SnapPointRegistry;
let source: PathSnapSource;

beforeEach(() => {
  getDefaultPathNetwork().clear();
  getDefaultZoneRegistry().clear();
  registry = new SnapPointRegistry();
  source = new PathSnapSource(registry);
});

afterEach(() => {
  source.dispose();
});

describe('getPathEndpoints — geometric basis of the path snaps', () => {
  it('open path: start faces AGAINST travel, end faces ALONG travel', () => {
    const path = parsePathExtras({ segments: [L1, L2] }, 'P')!;
    const ends = getPathEndpoints(path)!;
    expect(ends.start.position.toArray()).toEqual([0, 0, 0]);
    expect(ends.end.position.toArray()).toEqual([10, 0, 5]);
    // Travel starts along +Z → outward at the start is −Z.
    expect(ends.start.outward.z).toBeCloseTo(-1, 10);
    expect(ends.start.tangent.z).toBeCloseTo(1, 10);
    // Travel ends along +X → outward at the end is +X.
    expect(ends.end.outward.x).toBeCloseTo(1, 10);
    expect(ends.start.flow).toBe('in');
    expect(ends.end.flow).toBe('out');
  });

  it('a closed loop has no free ends', () => {
    const loop = parsePathExtras({ segments: [L1, L2], closed: true }, 'Loop')!;
    expect(getPathEndpoints(loop)).toBeNull();
  });

  it('an empty segment chain has no ends', () => {
    const empty = parsePathExtras({ segments: [] }, 'Empty')!;
    expect(getPathEndpoints(empty)).toBeNull();
  });
});

describe('PathSnapSource — registration in the ordinary snap registry', () => {
  it('registers exactly two snaps per open path with correct flow and axis code', () => {
    const comp = new RVPathComponent(pathNode('Route', { segments: cloneSegmentSpecs([L1, L2]) }));
    comp.init({} as never);
    source.syncAll();

    expect(source.size).toBe(2);
    const start = registry.getById(pathSnapId('Route', 'start'))!;
    const end = registry.getById(pathSnapId('Route', 'end'))!;
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    expect(start.typeId).toBe(PATH_END_SNAP_TYPE_ID);
    expect(start.flow).toBe('in');
    expect(end.flow).toBe('out');
    // Outward at the start is −Z (dominant axis Z), sign letter from the flow.
    expect(start.dir.code).toBe('ZN');
    expect(end.dir.code).toBe('XP');
    expect(start.object3D.position.toArray()).toEqual([0, 0, 0]);
    expect(end.object3D.position.toArray()).toEqual([10, 0, 5]);
  });

  it('start and end are flow-compatible with a foreign path end (in ↔ out)', () => {
    const a = new RVPathComponent(pathNode('A', { segments: cloneSegmentSpecs([L1]) }));
    const b = new RVPathComponent(pathNode('B', { segments: cloneSegmentSpecs([L2]) }));
    a.init({} as never);
    b.init({} as never);
    source.syncAll();

    const aEnd = registry.getById(pathSnapId('A', 'end'))!;
    const compatible = registry.getCompatible(PATH_END_SNAP_TYPE_ID, undefined, aEnd);
    // A's END (out) mates with B's START (in) — never with B's END (out ↔ out).
    expect(compatible.map((s) => s.id)).toEqual([pathSnapId('B', 'start')]);
  });

  it('a closed loop contributes no snappoints', () => {
    const comp = new RVPathComponent(
      pathNode('Loop', { segments: cloneSegmentSpecs([L1, L2]), closed: true }),
    );
    comp.init({} as never);
    source.syncAll();
    expect(source.size).toBe(0);
    expect(registry.size).toBe(0);
  });

  it('syncAll drops the snaps of paths that left the network', () => {
    const comp = new RVPathComponent(pathNode('Route', { segments: cloneSegmentSpecs([L1]) }));
    comp.init({} as never);
    source.syncAll();
    expect(registry.size).toBe(2);

    comp.dispose();
    source.syncAll();
    expect(registry.size).toBe(0);
    expect(source.snapIdsFor('Route')).toEqual([]);
  });
});

describe('data-bound: re-registration after a geometry edit', () => {
  it('an endpoint move RE-REGISTERS the end snap at the new position', () => {
    const node = pathNode('Route', { segments: cloneSegmentSpecs([L1, L2]) });
    const comp = new RVPathComponent(node);
    comp.init({} as never);
    source.syncAll();

    const idBefore = registry.getById(pathSnapId('Route', 'end'))!;
    expect(idBefore.object3D.position.toArray()).toEqual([10, 0, 5]);

    // Drag the free chain end (slot 2) to a new spot and commit.
    const edited = movePathHandle([L1, L2], 'v2', [14, 0, 5]);
    writeSegmentSpecs(node as unknown as { userData: Record<string, unknown> }, edited);
    comp.reapplyConfig(); // fires onPathChanged → the source re-registers

    const after = registry.getById(pathSnapId('Route', 'end'))!;
    expect(after).toBeDefined();
    expect(after.object3D.position.toArray()).toEqual([14, 0, 5]);
    // Still exactly two snaps — no duplicate from the re-registration.
    expect(registry.size).toBe(2);
    expect(source.size).toBe(2);
  });

  it('the start snap follows a start-endpoint drag and keeps its flow/axis semantics', () => {
    const node = pathNode('Route', { segments: cloneSegmentSpecs([L1, L2]) });
    const comp = new RVPathComponent(node);
    comp.init({} as never);
    source.syncAll();

    const edited = movePathHandle([L1, L2], 'v0', [0, 0, -3]);
    writeSegmentSpecs(node as unknown as { userData: Record<string, unknown> }, edited);
    comp.reapplyConfig();

    const start = registry.getById(pathSnapId('Route', 'start'))!;
    expect(start.object3D.position.toArray()).toEqual([0, 0, -3]);
    expect(start.flow).toBe('in');
    expect(start.dir.code).toBe('ZN');
  });

  it('turning a path into a loop removes its snaps live', () => {
    const node = pathNode('Route', { segments: cloneSegmentSpecs([L1, L2]) });
    const comp = new RVPathComponent(node);
    comp.init({} as never);
    source.syncAll();
    expect(registry.size).toBe(2);

    (node.userData.realvirtual as Record<string, Record<string, unknown>>).Path.closed = true;
    comp.reapplyConfig();
    expect(registry.size).toBe(0);
  });

  it('dispose() unsubscribes — a later edit no longer touches the registry', () => {
    const node = pathNode('Route', { segments: cloneSegmentSpecs([L1]) });
    const comp = new RVPathComponent(node);
    comp.init({} as never);
    source.syncAll();
    expect(registry.size).toBe(2);

    source.dispose();
    expect(registry.size).toBe(0);

    writeSegmentSpecs(
      node as unknown as { userData: Record<string, unknown> },
      movePathHandle([L1], 'v1', [0, 0, 9]),
    );
    comp.reapplyConfig();
    expect(registry.size).toBe(0);
  });
});
