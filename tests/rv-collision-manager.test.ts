// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-394 §9.4 — tick behaviour, latching, ignore-types, reset and lifecycle.
 *
 * The "same tick" test is the guard for the binding NFR: a collision must be
 * reported in the very tick it happens. It fails the moment any amortisation
 * pushes the report past a tick boundary.
 *
 * Semantics since the card rework (user decisions 2026-08-07): pairs LATCH —
 * they stay reported after the geometry separates. They leave the set only
 * through `ignoreType` (suppresses that role pair for the current run),
 * `reset()` (PLC `ResetCollisions` edge), or `clear()` (model change, which
 * also wipes the ignore set). There is no `armed` state and no modal.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Object3D } from 'three';
import { RVCollisionManager, typeKey } from '../src/core/engine/rv-collision-manager';
import { FakeHighlightHost, twoBodyScene, boxMesh } from './collision-fixture';
import {
  __resetCollisionAlertStore,
  getCollisionAlertSnapshot,
} from '../src/core/hmi/collision-alert-store';

const DT = 1 / 60;

function setup(gap = 5) {
  const s = twoBodyScene(gap);
  const highlight = new FakeHighlightHost();
  const manager = new RVCollisionManager();
  manager.setHighlightHost(highlight);
  manager.register(s.robot, 'Robot');
  manager.register(s.machine, 'Machine');
  return { ...s, manager, highlight };
}

/** Push the machine into the robot and refresh the world matrices. */
function collide(s: ReturnType<typeof setup>): void {
  s.machine.position.x = 0.5;
  s.scene.updateMatrixWorld(true);
}

function separate(s: ReturnType<typeof setup>): void {
  s.machine.position.x = 20;
  s.scene.updateMatrixWorld(true);
}

beforeEach(() => __resetCollisionAlertStore());
afterEach(() => vi.restoreAllMocks());

describe('RVCollisionManager', () => {
  it('reports nothing while the bodies are apart', () => {
    const s = setup();
    expect(s.manager.update(DT)).toBe(false);
    expect(s.manager.activePairs).toHaveLength(0);
    expect(getCollisionAlertSnapshot().pairs).toHaveLength(0);
    expect(s.highlight.current).toBeNull();
  });

  it('reports a new collision within the very same tick (NFR same-tick)', () => {
    const s = setup();
    s.manager.update(DT);                       // tick N-1: clean
    collide(s);
    const changed = s.manager.update(DT);       // tick N: exactly one tick
    expect(changed).toBe(true);
    expect(getCollisionAlertSnapshot().pairs).toHaveLength(1);
    expect(s.highlight.current).toEqual(expect.arrayContaining([s.robot, s.machine]));
  });

  it('publishes once and keeps the outline while the pair is latched', () => {
    const s = setup();
    collide(s);
    s.manager.update(DT);
    const v1 = getCollisionAlertSnapshot().version;
    s.manager.update(DT);
    s.manager.update(DT);
    // No further publish — the pair is already known.
    expect(getCollisionAlertSnapshot().version).toBe(v1);
    expect(getCollisionAlertSnapshot().pairs).toHaveLength(1);
    expect(s.highlight.current).not.toBeNull();
  });

  it('keeps a latched pair — card and outline — after the overlap ends', () => {
    const s = setup();
    collide(s);
    s.manager.update(DT);
    separate(s);
    s.manager.update(DT);
    expect(s.manager.activePairs).toHaveLength(1);
    expect(getCollisionAlertSnapshot().pairs).toHaveLength(1);
    expect(s.highlight.current).not.toBeNull();
  });

  it('carries key, roles and a since timestamp in the published view', () => {
    const s = setup();
    collide(s);
    s.manager.update(DT);
    const [p] = getCollisionAlertSnapshot().pairs;
    expect(p.aRole).not.toBe(p.bRole);
    expect(p.aKey.length).toBeGreaterThan(0);
    expect(p.bKey.length).toBeGreaterThan(0);
    expect(p.since).toBeGreaterThan(0);
  });

  it('re-detects after reset while the overlap persists', () => {
    const s = setup();
    collide(s);
    s.manager.update(DT);
    expect(s.manager.activePairs).toHaveLength(1);

    s.manager.reset();
    expect(s.manager.activePairs).toHaveLength(0);
    expect(getCollisionAlertSnapshot().pairs).toHaveLength(0);
    expect(s.highlight.current).toBeNull();

    // Still overlapping — the very next tick reports again.
    expect(s.manager.update(DT)).toBe(true);
    expect(getCollisionAlertSnapshot().pairs).toHaveLength(1);
  });

  it('acknowledge (card OK) drops one pair; still-intersecting pairs return next tick', () => {
    const s = setup();
    collide(s);
    s.manager.update(DT);
    const [p] = s.manager.activePairs;

    s.manager.acknowledge(p.aKey, p.bKey);
    expect(s.manager.activePairs).toHaveLength(0);
    expect(getCollisionAlertSnapshot().pairs).toHaveLength(0);
    expect(s.highlight.current).toBeNull();

    // Geometry still intersects — OK re-arms, the next tick reports again.
    expect(s.manager.update(DT)).toBe(true);
    expect(s.manager.activePairs).toHaveLength(1);

    // Separated + acknowledged → gone for good until the next real contact.
    separate(s);
    s.manager.update(DT);
    const [p2] = s.manager.activePairs;
    s.manager.acknowledge(p2.aKey, p2.bKey);
    expect(s.manager.update(DT)).toBe(false);
    expect(s.manager.activePairs).toHaveLength(0);

    // Unknown keys are a no-op.
    s.manager.acknowledge('nope', 'nada');
    expect(s.manager.activePairs).toHaveLength(0);
  });

  it('ignoreType drops matching latched pairs and suppresses re-detection', () => {
    const s = setup();
    collide(s);
    s.manager.update(DT);
    expect(s.manager.activePairs).toHaveLength(1);

    s.manager.ignoreType('Robot', 'Machine');
    expect(s.manager.activePairs).toHaveLength(0);
    expect(getCollisionAlertSnapshot().pairs).toHaveLength(0);
    expect(s.highlight.current).toBeNull();
    expect(s.manager.ignoredTypes.has(typeKey('Machine', 'Robot'))).toBe(true);

    // Still overlapping — but the type is ignored, so nothing comes back.
    expect(s.manager.update(DT)).toBe(false);
    expect(s.manager.activePairs).toHaveLength(0);

    // The ignore survives a rebuild (role re-registration marks dirty).
    s.manager.invalidate();
    expect(s.manager.update(DT)).toBe(false);
  });

  it('ignoreType survives reset() but not clear() (current-run scope)', () => {
    const s = setup();
    collide(s);
    s.manager.update(DT);
    s.manager.ignoreType('Robot', 'Machine');

    s.manager.reset();
    expect(s.manager.update(DT)).toBe(false);      // ignore still in force

    s.manager.clear();                             // model change
    expect(s.manager.ignoredTypes.size).toBe(0);
  });

  it('grows the list when a second pair starts intersecting (F8)', () => {
    const s = setup();
    const tool = new Object3D();
    tool.name = 'Tool';
    tool.position.set(0, 10, 0);
    tool.add(boxMesh({ name: 'ToolMesh' }));
    const part = new Object3D();
    part.name = 'Part';
    part.position.set(20, 10, 0);
    part.add(boxMesh({ name: 'PartMesh' }));
    s.scene.add(tool, part);
    s.manager.register(tool, 'Tool');
    s.manager.register(part, 'Workpiece');
    s.scene.updateMatrixWorld(true);

    collide(s);
    s.manager.update(DT);
    expect(getCollisionAlertSnapshot().pairs).toHaveLength(1);
    const openVersion = getCollisionAlertSnapshot().version;

    part.position.x = 0.5;
    s.scene.updateMatrixWorld(true);
    s.manager.update(DT);
    expect(getCollisionAlertSnapshot().pairs).toHaveLength(2);
    expect(getCollisionAlertSnapshot().version).toBeGreaterThan(openVersion);
  });

  it('never pairs a body with itself or with an equal role', () => {
    const s = setup();
    s.manager.register(s.machine, 'Robot');   // both Robot now
    collide(s);
    expect(s.manager.update(DT)).toBe(false);
    expect(getCollisionAlertSnapshot().pairs).toHaveLength(0);
  });

  it('re-applies the outline on demand (mode change, F15)', () => {
    const s = setup();
    collide(s);
    s.manager.update(DT);
    const before = s.highlight.calls.length;
    s.manager.reapplyHighlight();
    expect(s.highlight.calls.length).toBe(before + 1);
    expect(s.highlight.current).toEqual(expect.arrayContaining([s.robot, s.machine]));
  });

  it('clears registry, outline and published cards on model change (F12)', () => {
    const s = setup();
    collide(s);
    s.manager.update(DT);
    expect(getCollisionAlertSnapshot().pairs).toHaveLength(1);

    s.manager.clear();
    expect(s.manager.bodies).toHaveLength(0);
    expect(s.manager.pairs).toHaveLength(0);
    expect(s.manager.activePairs).toHaveLength(0);
    expect(getCollisionAlertSnapshot().pairs).toHaveLength(0);
    expect(s.highlight.current).toBeNull();
    // The cleared registry must not resurrect on the next tick.
    expect(s.manager.update(DT)).toBe(false);
  });
});
