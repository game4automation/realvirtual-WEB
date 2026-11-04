// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-661 Phase 1 / test 9.1 — MU physics-owner register.
 *
 * Owner changes only from the current owner (or a claim out of 'transport'),
 * a conflict is refused + reported + counted, `physicsOwned` is a compat view,
 * the snapshot reset returns to 'transport', and the hold model (`heldBy`,
 * grip/release) is independent of the physics owner.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Scene, Vector3 } from 'three';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import {
  getMuOwnerStats, isPhysicsOwned, resetMuOwner, resetMuOwnerStats, setMuOwner,
} from '../src/core/engine/rv-mu-owner';
import { clearProblemsOfCode, getProblems } from '../src/core/hmi/problems-store';
import { detachMU, holdMU } from '../src/core/engine/rv-mu-hold';
import { muNode, preplacedMU } from './_mu-preplaced-fixture';

function makeMU(name = 'MU_1'): RVMovingUnit {
  const node = new Object3D();
  node.name = name;
  new Scene().add(node);
  return new RVMovingUnit(node, 'test-source', new Vector3(0.1, 0.1, 0.1));
}

function conflicts(): number {
  return getProblems().filter((p) => p.code === 'mu-owner-conflict').length;
}

describe('MU owner register (plan-661 9.1)', () => {
  beforeEach(() => {
    resetMuOwnerStats();
    clearProblemsOfCode('mu-owner-conflict');
  });

  it('starts with the transport', () => {
    const mu = makeMU();
    expect(mu.owner).toBe('transport');
    expect(mu.physicsOwned).toBe(false);
    expect(isPhysicsOwned(mu)).toBe(false);
  });

  it('allows a claim out of transport and a hand-back by the current owner', () => {
    const mu = makeMU();
    expect(setMuOwner(mu, 'box2d', 'transport')).toBe(true);
    expect(mu.owner).toBe('box2d');
    expect(setMuOwner(mu, 'transport', 'box2d')).toBe(true);
    expect(mu.owner).toBe('transport');
    expect(setMuOwner(mu, 'rapier', 'transport')).toBe(true);
    expect(setMuOwner(mu, 'box2d', 'rapier')).toBe(true); // Rapier → Box2D handover by its owner
    expect(mu.owner).toBe('box2d');
    expect(getMuOwnerStats().changes).toBe(4);
    expect(getMuOwnerStats().conflicts).toBe(0);
  });

  it('refuses a change by a non-owner, reports and counts the conflict', () => {
    const mu = makeMU('MU_conflict');
    setMuOwner(mu, 'box2d', 'transport');
    expect(setMuOwner(mu, 'rapier', 'rapier')).toBe(false);
    expect(setMuOwner(mu, 'transport', 'rapier')).toBe(false);
    expect(mu.owner).toBe('box2d');
    expect(getMuOwnerStats().conflicts).toBe(2);
    expect(conflicts()).toBe(1); // one entry per MU, re-reports replace
    const p = getProblems().find((e) => e.code === 'mu-owner-conflict')!;
    expect(p.id).toBe('mu-owner-conflict:MU_conflict');
  });

  it('same-owner write is a no-op, not a change', () => {
    const mu = makeMU();
    expect(setMuOwner(mu, 'transport', 'box2d')).toBe(true);
    expect(getMuOwnerStats().changes).toBe(0);
    expect(conflicts()).toBe(0);
  });

  it('physicsOwned is a compatibility view of owner', () => {
    const mu = makeMU();
    setMuOwner(mu, 'rapier', 'transport');
    expect(mu.physicsOwned).toBe(true);
    setMuOwner(mu, 'box2d', 'rapier');
    expect(mu.physicsOwned).toBe(true);
    resetMuOwner(mu);
    expect(mu.physicsOwned).toBe(false);
    // Legacy write path maps true → rapier, false → transport.
    mu.physicsOwned = true;
    expect(mu.owner).toBe('rapier');
    mu.physicsOwned = false;
    expect(mu.owner).toBe('transport');
  });

  it('snapshot restore (simulation reset) puts a physics-owned MU back to transport', () => {
    const tm = new RVTransportManager();
    const root = new Scene();
    const node = muNode('Pre_1', [0.1, 0.1, 0.1]);
    root.add(node);
    const mu = preplacedMU(node);
    tm.registerPreplaced(mu, root);
    tm.activatePreplaced();
    setMuOwner(mu, 'box2d', 'transport');
    mu.physicsBodyId = 'b2:1';
    tm.restorePreplaced(true);
    expect(mu.owner).toBe('transport');
    expect(mu.physicsBodyId).toBeNull();
  });

  it('dispose fan-out reaches the Rapier slot and every registered hook', () => {
    const tm = new RVTransportManager();
    const mu = makeMU();
    const seen: string[] = [];
    tm.physicsMUHook = { onMUDisposed: () => seen.push('rapier') };
    const remove = tm.addPhysicsMUHook({ onMUDisposed: () => seen.push('box2d') });
    tm.notifyPhysicsMUDisposed(mu);
    remove();
    tm.notifyPhysicsMUDisposed(mu);
    expect(seen).toEqual(['rapier', 'box2d', 'rapier']);
  });

  describe('grip / release regression', () => {
    it('holding leaves the physics owner untouched; heldBy unchanged by owner changes', () => {
      const mu = makeMU();
      const gripper = new Object3D();
      mu.node.parent!.add(gripper);
      holdMU(mu, gripper, 'grip');
      expect(mu.heldBy).toBe('grip');
      expect(mu.owner).toBe('transport');
      detachMU(mu, 'grip', mu.node.parent!.parent ?? null);
      expect(mu.heldBy).toBeNull();
      expect(mu.owner).toBe('transport');

      setMuOwner(mu, 'box2d', 'transport');
      resetMuOwner(mu);
      expect(mu.heldBy).toBeNull();
      expect(getMuOwnerStats().conflicts).toBe(0);
    });
  });
});
