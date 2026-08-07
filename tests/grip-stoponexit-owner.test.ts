// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * grip-stoponexit-owner.test.ts — plan-259 §9.9 (review-blocker test, O1b).
 *
 * The `heldBy` owner tag: grip and StopOnExit never free each other's MUs.
 *  - RVGrip.place()/reset() releases a GRIP-held MU without touching a
 *    connection-held one;
 *  - the connection hold controller never steals a grip-held MU and only
 *    frees what it holds itself;
 *  - `isGripped` (derived) is true for BOTH owners (transport/sink skip).
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Vector3, Scene } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVGrip } from '../src/core/engine/rv-grip';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { ConnectionHoldController } from '../src/core/engine/rv-connection-hold';
import type { RVGripTarget } from '../src/core/engine/rv-grip-target';

function createMU(name: string, x = 0): RVMovingUnit {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, 0, 0);
  return new RVMovingUnit(node, 'src', new Vector3(0.05, 0.05, 0.05));
}

function makeGrip(scene: Scene, mus: RVMovingUnit[]): RVGrip {
  const grip = new RVGrip(new Object3D());
  scene.add(grip.node);
  (grip as unknown as { allMUs: () => RVMovingUnit[] }).allMUs = () => mus;
  (grip as unknown as { allGripTargets: () => RVGripTarget[] }).allGripTargets = () => [];
  return grip;
}

describe('grip ↔ StopOnExit owner tag (plan-259 O1b)', () => {
  it('grip pick sets heldBy=grip; isGripped derives from the owner tag', () => {
    const scene = new Scene();
    const mu = createMU('A');
    scene.add(mu.node);
    const grip = makeGrip(scene, [mu]);
    grip.pick();
    expect(mu.heldBy).toBe('grip');
    expect(mu.isGripped).toBe(true);
  });

  it('the connection hold never steals a grip-held MU', () => {
    const scene = new Scene();
    const mu = createMU('A');
    scene.add(mu.node);
    const grip = makeGrip(scene, [mu]);
    grip.pick();

    const manager = new RVTransportManager();
    manager.mus.push(mu);
    const holds = new ConnectionHoldController();
    // MU simultaneously in grip AND in a StopOnExit sensor AABB — the hold
    // must refuse (mode 'none'), the grip stays the owner.
    expect(holds.hold(mu.id, manager)).toBe('none');
    expect(mu.heldBy).toBe('grip');
    expect(holds.heldCount).toBe(0);
  });

  it('connection release does not free a grip-held MU; grip release does not free a connection-held MU', () => {
    const scene = new Scene();
    const gripMu = createMU('GripMU', 0);
    const connMu = createMU('ConnMU', 5);
    scene.add(gripMu.node, connMu.node);
    const grip = makeGrip(scene, [gripMu]);
    grip.pick();
    expect(gripMu.heldBy).toBe('grip');

    const manager = new RVTransportManager();
    manager.mus.push(gripMu, connMu);
    const holds = new ConnectionHoldController();
    expect(holds.hold(connMu.id, manager)).toBe('held');
    expect(connMu.heldBy).toBe('connection');

    // Connection subsystem releases everything IT holds — the grip MU stays.
    holds.releaseAll();
    expect(connMu.heldBy).toBeNull();
    expect(gripMu.heldBy).toBe('grip');

    // Re-hold; now the GRIP resets — the connection MU stays held.
    holds.hold(connMu.id, manager);
    grip.reset();
    expect(gripMu.heldBy).toBeNull();
    expect(connMu.heldBy).toBe('connection');
  });

  it('grip place() releases only its own MU (unfix owner guard)', () => {
    const scene = new Scene();
    const mu = createMU('A');
    scene.add(mu.node);
    const grip = makeGrip(scene, [mu]);
    grip.pick();
    grip.place(); // no grip target → release at standard parent
    expect(mu.heldBy).toBeNull();

    // A connection-held MU that (incorrectly) ends up in grippedMUs is not
    // freed by onMUDisposed's owner-guarded release.
    const connMu = createMU('B');
    connMu.heldBy = 'connection';
    grip.grippedMUs.push(connMu);
    grip.onMUDisposed(connMu);
    expect(connMu.heldBy).toBe('connection');
  });
});
