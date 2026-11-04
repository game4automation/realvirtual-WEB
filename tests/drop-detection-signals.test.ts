// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * drop-detection-signals.test.ts — plan-2022 F9: the three PLC signals and the
 * `ResetDrops` EDGE (not level).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import {
  RVDropManager,
  SIGNAL_DROP_ACTIVE,
  SIGNAL_DROP_COUNT,
  SIGNAL_RESET_DROPS,
  type DropMU,
} from '../src/core/engine/rv-drop-manager';
import type { DropDetectionConfig } from '../src/core/engine/rv-drop-detection';
import { __resetDropAlertStore, getDropAlertSnapshot } from '../src/core/hmi/drop-alert-store';

const DT = 1 / 60;

const CONFIG: DropDetectionConfig = {
  Enabled: true,
  GraceTime: 0.1,
  SupportProbeDistance: 50,
  SupportMode: 'StateOnly',
  SupportRecheckInterval: 0.5,
  DeleteUnsupported: false,
  DeleteDelay: 1,
};

function part(name: string): RVMovingUnit {
  const node = new Object3D();
  node.name = name;
  node.position.set(0, 1, 0);
  node.updateMatrixWorld(true);
  const mu = new RVMovingUnit(node, 'Source_A', new Vector3(0.05, 0.05, 0.05));
  mu.wasCarried = true; // E7: only a part that was carried can lose its support
  mu.updateAABB();
  return mu;
}

function makeWorld() {
  const store = new SignalStore();
  const mgr = new RVDropManager();
  mgr.setTransportHost({ surfaceVerticalReach: 0.1, gripTargets: [] });
  mgr.attachSignals(store);
  mgr.register(new Object3D(), CONFIG, { dropActive: null, dropCount: null, resetDrops: null });
  const run = (seconds: number, mus: DropMU[]) => {
    const ticks = Math.round(seconds / DT);
    for (let i = 0; i < ticks; i++) {
      mgr.beginTick();
      for (const mu of mus) mgr.evaluate(mu, DT);
      mgr.endTick(DT);
    }
  };
  return { store, mgr, run };
}

beforeEach(() => __resetDropAlertStore());

describe('drop detection signals (plan-2022 F9)', () => {
  it('registers the three signals with sane initial values', () => {
    const { store } = makeWorld();
    expect(store.get(SIGNAL_DROP_ACTIVE)).toBe(false);
    expect(store.get(SIGNAL_DROP_COUNT)).toBe(0);
    expect(store.get(SIGNAL_RESET_DROPS)).toBe(false);
  });

  it('mirrors the latched report count into the signals', () => {
    const { store, run } = makeWorld();
    const a = part('Box_A');
    const b = part('Box_B');
    run(0.2, [a]);
    expect(store.get(SIGNAL_DROP_ACTIVE)).toBe(true);
    expect(store.get(SIGNAL_DROP_COUNT)).toBe(1);
    run(0.2, [a, b]);
    expect(store.get(SIGNAL_DROP_COUNT)).toBe(2);
  });

  it('a rising ResetDrops edge clears the reports and the signals', () => {
    const { store, run } = makeWorld();
    run(0.2, [part('Box_A')]);
    expect(store.get(SIGNAL_DROP_ACTIVE)).toBe(true);
    store.set(SIGNAL_RESET_DROPS, true);
    expect(store.get(SIGNAL_DROP_ACTIVE)).toBe(false);
    expect(store.get(SIGNAL_DROP_COUNT)).toBe(0);
    expect(getDropAlertSnapshot().drops).toHaveLength(0);
  });

  it('acts on the EDGE, not the level', () => {
    const { store, mgr, run } = makeWorld();
    const mu = part('Box_A');
    run(0.2, [mu]);
    store.set(SIGNAL_RESET_DROPS, true);        // rising — cleared
    run(0.2, [mu]);                             // still free → reported again
    expect(store.get(SIGNAL_DROP_ACTIVE)).toBe(true);

    store.set(SIGNAL_RESET_DROPS, true);        // same value — no edge
    expect(store.get(SIGNAL_DROP_ACTIVE)).toBe(true);
    store.set(SIGNAL_RESET_DROPS, false);       // falling — no reset
    expect(store.get(SIGNAL_DROP_ACTIVE)).toBe(true);
    store.set(SIGNAL_RESET_DROPS, true);        // rising — reset
    expect(store.get(SIGNAL_DROP_ACTIVE)).toBe(false);
    expect(mgr.activeDrops).toEqual([]);
  });

  it('a model change detaches the store, so no listener survives on it', () => {
    const { store, mgr, run } = makeWorld();
    run(0.2, [part('Box_A')]);
    mgr.clear();
    expect(store.get(SIGNAL_DROP_ACTIVE)).toBe(false);
    // The dead store must not be able to drive the manager any more.
    store.set(SIGNAL_RESET_DROPS, true);
    expect(mgr.activeDrops).toEqual([]);
    // The authored component is gone; detection itself stays on (E5 defaults).
    expect(mgr.hasComponent).toBe(false);
    expect(mgr.isArmed).toBe(true);
  });
});
