// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-394 §9.7 — SignalStore mirroring and the acknowledge edge (F10).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import {
  RVCollisionManager,
  SIGNAL_COLLISION_ACTIVE,
  SIGNAL_COLLISION_COUNT,
  SIGNAL_RESET_COLLISIONS,
} from '../src/core/engine/rv-collision-manager';
import { FakeHighlightHost, twoBodyScene } from './collision-fixture';
import { __resetCollisionAlertStore, getCollisionAlertSnapshot } from '../src/core/hmi/collision-alert-store';

const DT = 1 / 60;

function setupCollidingScene() {
  const s = twoBodyScene(0.5);          // already overlapping
  const store = new SignalStore();
  const manager = new RVCollisionManager();
  manager.setHighlightHost(new FakeHighlightHost());
  manager.attachSignals(store);
  manager.register(s.robot, 'Robot');
  manager.register(s.machine, 'Machine');
  return { ...s, store, manager };
}

beforeEach(() => __resetCollisionAlertStore());

describe('collision signals', () => {
  it('registers the three signals with sane initial values', () => {
    const store = new SignalStore();
    const manager = new RVCollisionManager();
    manager.attachSignals(store);
    expect(store.get(SIGNAL_COLLISION_ACTIVE)).toBe(false);
    expect(store.get(SIGNAL_COLLISION_COUNT)).toBe(0);
    expect(store.get(SIGNAL_RESET_COLLISIONS)).toBe(false);
  });

  it('mirrors state into signals and resets on a rising ResetCollisions edge', () => {
    const { manager, store } = setupCollidingScene();
    manager.update(DT);
    expect(store.get(SIGNAL_COLLISION_ACTIVE)).toBe(true);
    expect(store.get(SIGNAL_COLLISION_COUNT)).toBe(1);

    store.set(SIGNAL_RESET_COLLISIONS, true);
    expect(store.get(SIGNAL_COLLISION_ACTIVE)).toBe(false);
    expect(store.get(SIGNAL_COLLISION_COUNT)).toBe(0);
    expect(getCollisionAlertSnapshot().pairs).toHaveLength(0);
  });

  it('ignores a falling edge and a repeated true (edge, not level)', () => {
    const { manager, store } = setupCollidingScene();
    manager.update(DT);
    store.set(SIGNAL_RESET_COLLISIONS, true);
    manager.update(DT);                                  // reports again
    expect(store.get(SIGNAL_COLLISION_ACTIVE)).toBe(true);

    store.set(SIGNAL_RESET_COLLISIONS, true);            // no edge — same value
    expect(store.get(SIGNAL_COLLISION_ACTIVE)).toBe(true);

    store.set(SIGNAL_RESET_COLLISIONS, false);           // falling — no reset
    expect(store.get(SIGNAL_COLLISION_ACTIVE)).toBe(true);

    store.set(SIGNAL_RESET_COLLISIONS, true);            // rising — reset
    expect(store.get(SIGNAL_COLLISION_ACTIVE)).toBe(false);
  });

  it('writes only on change (no per-tick signal traffic)', () => {
    const { manager, store } = setupCollidingScene();
    const seen: (boolean | number)[] = [];
    store.subscribe(SIGNAL_COLLISION_COUNT, (v) => seen.push(v));
    manager.update(DT);
    manager.update(DT);
    manager.update(DT);
    expect(seen).toEqual([1]);
  });

  it('detaches cleanly so a model switch cannot write to a dead store', () => {
    const { manager, store } = setupCollidingScene();
    manager.update(DT);
    expect(store.get(SIGNAL_COLLISION_ACTIVE)).toBe(true);

    manager.attachSignals(null);
    manager.reset();
    // Old store keeps its last value; nothing threw, nothing was written.
    expect(store.get(SIGNAL_COLLISION_ACTIVE)).toBe(true);

    // A rising edge on the DETACHED store must no longer reach the manager:
    // the still-overlapping pair stays reported instead of being reset away.
    manager.update(DT);
    expect(manager.activePairs).toHaveLength(1);
    store.set(SIGNAL_RESET_COLLISIONS, true);
    expect(manager.activePairs).toHaveLength(1);
  });
});
