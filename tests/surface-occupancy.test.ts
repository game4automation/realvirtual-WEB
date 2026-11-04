// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for the behavior-facing surface-occupancy helper (`isSurfaceOccupied`).
 *
 * "Occupied" for a conveyor / turntable means a good (MU) is physically on a transport surface
 * under its belt node — driven from the transport manager's live surface + MU sets.
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { isSurfaceOccupied, isSurfaceOccupiedByOwner } from '../src/behaviors/_shared/surface-occupancy';

/** A surface attached to `node` with a 2×0.2×2 box. */
function surface(node: Object3D) {
  return { node, aabb: AABB.fromHalfSize(node, new Vector3(1, 0.1, 1)) };
}

/** A small good (MU) at a world position. */
function good(x: number, y: number, z: number, markedForRemoval = false) {
  const n = new Object3D();
  n.position.set(x, y, z);
  n.updateMatrixWorld(true);
  return { aabb: AABB.fromHalfSize(n, new Vector3(0.2, 0.2, 0.2)), markedForRemoval };
}

describe('isSurfaceOccupied', () => {
  it('returns false when the host has no transport manager', () => {
    const belt = new Object3D();
    expect(isSurfaceOccupied({}, belt)).toBe(false);
    expect(isSurfaceOccupied({ transportManager: null }, belt)).toBe(false);
  });

  it('returns true only while a live good overlaps a surface under the belt node', () => {
    const belt = new Object3D(); belt.name = 'Transport-X';
    belt.updateMatrixWorld(true);
    const mus: ReturnType<typeof good>[] = [];
    const host = { transportManager: { surfaces: [surface(belt)], mus } };

    expect(isSurfaceOccupied(host, belt)).toBe(false); // empty belt

    mus.push(good(0, 0.2, 0));                          // good on the belt
    expect(isSurfaceOccupied(host, belt)).toBe(true);

    mus.length = 0;
    mus.push(good(5, 0.2, 0));                          // good off the belt
    expect(isSurfaceOccupied(host, belt)).toBe(false);
  });

  it('ignores goods marked for removal', () => {
    const belt = new Object3D(); belt.updateMatrixWorld(true);
    const host = { transportManager: { surfaces: [surface(belt)], mus: [good(0, 0.2, 0, true)] } };
    expect(isSurfaceOccupied(host, belt)).toBe(false);
  });

  it('matches a surface on a descendant of the belt node', () => {
    const belt = new Object3D(); belt.name = 'Transport-X';
    const child = new Object3D(); belt.add(child);
    belt.updateMatrixWorld(true);
    const host = { transportManager: { surfaces: [surface(child)], mus: [good(0, 0.2, 0)] } };
    expect(isSurfaceOccupied(host, belt)).toBe(true);
  });
});

describe('isSurfaceOccupiedByOwner', () => {
  it('does not let an upstream pallet grazing the next belt block its own arrival', () => {
    const upstreamNode = new Object3D(); upstreamNode.name = 'Transport-Z';
    const downstreamRoot = new Object3D();
    const downstreamNode = new Object3D(); downstreamNode.name = 'Transport-Z';
    downstreamRoot.add(downstreamNode);
    const upstream = surface(upstreamNode), downstream = surface(downstreamNode);
    upstream.aabb.min.z = 6.730; upstream.aabb.max.z = 9.617;
    downstream.aabb.min.z = 9.730; downstream.aabb.max.z = 11.617;
    const mu = { ...good(0, 0.6, 9.138), currentSurface: upstream as typeof upstream | null };
    mu.aabb.min.z = 8.538; mu.aabb.max.z = 9.738; // 8 mm into the downstream footprint
    const host = { transportManager: { surfaces: [upstream, downstream], mus: [mu] } };

    expect(isSurfaceOccupied(host, downstreamRoot)).toBe(true); // clearance semantics stay geometric
    expect(isSurfaceOccupiedByOwner(host, upstreamNode)).toBe(true);
    expect(isSurfaceOccupiedByOwner(host, downstreamRoot)).toBe(false);

    mu.currentSurface = downstream;
    expect(isSurfaceOccupiedByOwner(host, upstreamNode)).toBe(false);
    expect(isSurfaceOccupiedByOwner(host, downstreamRoot)).toBe(true);
    mu.markedForRemoval = true;
    expect(isSurfaceOccupiedByOwner(host, downstreamRoot)).toBe(false);
    mu.markedForRemoval = false;
    mu.currentSurface = null;
    expect(isSurfaceOccupiedByOwner(host, downstreamRoot)).toBe(false);
  });

  it('requires a current surface registered under the queried node', () => {
    const node = new Object3D(), owned = surface(node);
    const mu = { ...good(0, 0.2, 0), currentSurface: owned };
    const host = { transportManager: { surfaces: [owned], mus: [mu] } };
    expect(isSurfaceOccupiedByOwner({}, node)).toBe(false);
    expect(isSurfaceOccupiedByOwner({ transportManager: null }, node)).toBe(false);
    expect(isSurfaceOccupiedByOwner(host, node)).toBe(true);
    host.transportManager.surfaces = [surface(node)]; // same node, different surface instance
    expect(isSurfaceOccupiedByOwner(host, node)).toBe(false);
    host.transportManager.surfaces.push(owned); // invalidate the cached surface list on growth
    expect(isSurfaceOccupiedByOwner(host, node)).toBe(true);
  });
});
