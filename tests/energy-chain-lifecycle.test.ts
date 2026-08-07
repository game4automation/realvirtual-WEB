// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Test 9.6 of plan-362 — the rigging moment, tested through BEHAVIOUR.
 *
 * The first plan draft had an idempotent `ensureRigged()` called from init,
 * onSceneReady and the tick, "first successful call wins". That is provably
 * wrong: on the loader paths the Kinematic re-parenting pass runs BETWEEN
 * `init()` and `onSceneReady()`, so a rig built in `init()` freezes the
 * PRE-reparent hierarchy — and being idempotent, never repairs itself.
 *
 * So the assertions below are not "which method was called" but "which
 * hierarchy did the bind frame end up in".
 */

import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import {
  constructComponentOnNode,
  processExtras,
} from '../src/core/engine/rv-scene-loader';
import { RVEnergyChain } from '../src/core/engine/rv-energy-chain';
import { chainHarness, transformRef } from './energy-chain-fixture';

describe('EnergyChain rigging lifecycle', () => {
  it('rigs immediately on the constructComponentOnNode path (no onSceneReady exists)', () => {
    const h = chainHarness();
    const data = { Follower: transformRef('Root/Slide') };
    h.chain.userData.realvirtual = { EnergyChain: data };
    const chain = constructComponentOnNode(h.deps, h.chain, 'EnergyChain', data) as RVEnergyChain;
    expect(chain.isRigged).toBe(true);
  });

  it('defers past a re-parenting that happens between init and onSceneReady', () => {
    const h = chainHarness();
    const chain = new RVEnergyChain(h.chain);
    chain.Follower = transformRef('Root/Slide');

    const ctx = {
      registry: h.registry, signalStore: h.signalStore, scene: h.scene,
      transportManager: h.transportManager, root: h.root,
      energyChainManager: h.energyChainManager,
      expectSceneReady: true,
    };

    chain.init(ctx as never);
    // The loader is NOT done yet — nothing may be frozen at this point.
    expect(chain.isRigged).toBe(false);

    // Kinematic re-parenting, exactly as rv-scene-loader Phase 8b does it:
    // the chain moves under a new (rotated + translated) parent.
    const axis = new Object3D();
    axis.name = 'AxisLeft';
    axis.position.set(1.5, 0.25, -0.75);
    axis.rotation.set(0, Math.PI / 3, 0);
    h.root.add(axis);
    axis.add(h.chain);
    h.scene.updateMatrixWorld(true);
    h.registry.registerNode('Root/AxisLeft', axis);

    chain.onSceneReady(ctx as never);
    expect(chain.isRigged).toBe(true);
    expect(chain.diagnosis).toBe('ok');
    // The bind frame is the POST-reparent one: the measured geometry is
    // unchanged (it is chain-local), which is only true if the world matrices
    // of the source meshes were composed against the NEW chain-root matrix.
    expect(chain.calibration!.bendRadiusMm).toBeCloseTo(55, 1);
    expect(chain.calibration!.chainLengthMm).toBeCloseTo(815, 0);
    expect(h.chain.parent).toBe(axis);
  });

  it('rigs through the real processExtras path (planner drop)', () => {
    const h = chainHarness();
    h.chain.userData.realvirtual = {
      EnergyChain: { Follower: transformRef('Root/Slide') },
    };
    processExtras(
      h.root, h.registry, h.signalStore, h.transportManager, h.scene,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, h.energyChainManager,
    );
    const chain = h.chain.userData._rvEnergyChain as RVEnergyChain;
    expect(chain).toBeDefined();
    expect(chain.isRigged).toBe(true);
    expect(chain.diagnosis).toBe('ok');
    expect(h.energyChainManager.size).toBe(1);
  });

  it('rebuilds the rig when the STRUCTURE changes', () => {
    const h = chainHarness();
    const data = { Follower: transformRef('Root/Slide') };
    h.chain.userData.realvirtual = { EnergyChain: data };
    const chain = constructComponentOnNode(h.deps, h.chain, 'EnergyChain', data) as RVEnergyChain;
    const before = chain.skeleton;

    // Re-parent the chain root itself — a genuine structural change.
    const holder = new Object3D();
    holder.name = 'Holder';
    h.root.add(holder);
    holder.add(h.chain);
    h.scene.updateMatrixWorld(true);

    chain.reapplyConfig();
    expect(chain.isRigged).toBe(true);
    expect(chain.skeleton).not.toBe(before);
  });

  it('recalibrate() discards manual numeric overrides and re-measures', () => {
    const h = chainHarness();
    const data = { Follower: transformRef('Root/Slide'), BendRadius: 80 };
    h.chain.userData.realvirtual = { EnergyChain: data };
    const chain = constructComponentOnNode(h.deps, h.chain, 'EnergyChain', data) as RVEnergyChain;
    expect(chain.BendRadius).toBe(80);
    expect(chain.getLiveState().BendRadius).toBeCloseTo(80, 1);

    chain.recalibrate();
    expect(chain.BendRadius).toBe(0);
    expect(chain.getLiveState().BendRadius).toBeCloseTo(55, 1);
  });

  it('is disposed exactly once by the manager, restoring the scene', () => {
    const h = chainHarness();
    const data = { Follower: transformRef('Root/Slide') };
    h.chain.userData.realvirtual = { EnergyChain: data };
    const chain = constructComponentOnNode(h.deps, h.chain, 'EnergyChain', data) as RVEnergyChain;
    expect(h.energyChainManager.size).toBe(1);

    h.energyChainManager.clear();
    expect(h.energyChainManager.size).toBe(0);
    expect(chain.isRigged).toBe(false);
    expect(h.chain.getObjectByName('28')!.visible).toBe(true);
    expect(h.chain.userData._rvEnergyChain).toBeUndefined();
  });
});

describe('EnergyChain live reference correction (test 9.12)', () => {
  /**
   * The MCP correction path of 2.9: `web_editor_set_field` → `doc.setField` →
   * `_setField()` only RE-APPLIES THE SCHEMA and never calls
   * `resolveComponentRefs()`. Without the component's own `reapplyConfig()`
   * hook a `Follower` written that way would stay a raw wire object forever and
   * the chosen correction path would be silently useless.
   */
  function writeFieldLikeMcp(chain: RVEnergyChain, field: string, value: unknown): void {
    (chain as unknown as Record<string, unknown>)[field] = value;
    chain.reapplyConfig();
  }

  it('resolves a Follower written after load, without a reload', () => {
    const h = chainHarness();
    const chain = constructComponentOnNode(h.deps, h.chain, 'EnergyChain', {}) as RVEnergyChain;
    expect(chain.diagnosis).toBe('degraded-assignment');

    writeFieldLikeMcp(chain, 'Follower', transformRef('Root/Slide'));
    expect(chain.diagnosis).toBe('ok');
    expect(chain.Follower).toBe(h.follower);

    h.moveFollower(-200);
    expect(chain.updatePose(0.016)).toBe(true);
  });

  it('falls back to auto assignment when the reference is cleared', () => {
    const h = chainHarness();
    const data = { Follower: transformRef('Root/Slide') };
    h.chain.userData.realvirtual = { EnergyChain: data };
    const chain = constructComponentOnNode(h.deps, h.chain, 'EnergyChain', data) as RVEnergyChain;
    expect(chain.diagnosis).toBe('ok');

    writeFieldLikeMcp(chain, 'Follower', null);
    expect(chain.diagnosis).toBe('degraded-assignment');
    h.moveFollower(-200);
    expect(chain.updatePose(0.016)).toBe(false);
  });

  it('restores a resolved reference when undo puts the old value back', () => {
    const h = chainHarness();
    const chain = constructComponentOnNode(h.deps, h.chain, 'EnergyChain', {}) as RVEnergyChain;
    writeFieldLikeMcp(chain, 'Follower', transformRef('Root/Slide'));
    writeFieldLikeMcp(chain, 'Follower', null);
    // …undo…
    writeFieldLikeMcp(chain, 'Follower', transformRef('Root/Slide'));
    expect(chain.Follower).toBe(h.follower);
    expect(chain.diagnosis).toBe('ok');
  });

  it('rebuilds the rig when an authored NUMBER changes', () => {
    // The skin weights map every vertex to a fixed arc length on the path that
    // was current when they were baked. Patching R / L / Bones in place would
    // leave them pointing at a path that no longer exists — a silent distortion.
    const h = chainHarness();
    const data = { Follower: transformRef('Root/Slide') };
    h.chain.userData.realvirtual = { EnergyChain: data };
    const chain = constructComponentOnNode(h.deps, h.chain, 'EnergyChain', data) as RVEnergyChain;
    const before = chain.skeleton;

    writeFieldLikeMcp(chain, 'BendRadius', 70);
    expect(chain.skeleton).not.toBe(before);
    expect(chain.getLiveState().BendRadius).toBeCloseTo(70, 1);

    const afterRadius = chain.skeleton;
    writeFieldLikeMcp(chain, 'Bones', 40);
    expect(chain.skeleton).not.toBe(afterRadius);
    expect(chain.skeleton!.bones.length).toBe(40);
  });

  it('keeps the SAME skeleton when only a reference changes', () => {
    const h = chainHarness();
    const chain = constructComponentOnNode(h.deps, h.chain, 'EnergyChain', {}) as RVEnergyChain;
    const before = chain.skeleton;
    writeFieldLikeMcp(chain, 'Follower', transformRef('Root/Slide'));
    // The structure did not change, so re-rigging would be pure waste.
    expect(chain.skeleton).toBe(before);
  });
});
