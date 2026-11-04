// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { robotDemoWorld } from './continuation-world-fixture';
import type { DESRunner } from '../../src/plugins/des/des-runner';

import { OrderPool } from '../../src/core/fleet/core/orders';
import { ZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { fleetSnapshotProvider } from '../../src/plugins/fleet-snapshot-participants';
import { registerAction } from '../../src/plugins/des/rv-des-named-actions';
import { assertPersistableQueue } from '../../src/plugins/des/rv-des-action-schema';

// The harness types the runner narrowly; the world is built on the real DESRunner.
const newRunner = () => ({ runner: robotDemoWorld().runner as unknown as DESRunner });

function fixture() {
  const { runner } = newRunner();
  const orders = new OrderPool(), zones = new ZoneRegistry();
  orders.add({ source: 'pick' }, 0); zones.define('zone', 1); zones.claim('zone', 'vehicle');
  const off = runner.registerSnapshotProvider('plant:fleet', fleetSnapshotProvider({
    orders, zones, paths: { get: () => undefined }, stationKnown: id => id === 'pick',
  }));
  return { runner, orders, zones, off };
}

describe('runner snapshot providers', () => {
  afterEach(() => vi.restoreAllMocks());
  it('captures and restores fleet parts; duplicate ids throw and unregister removes parts', () => {
    const f = fixture(), raw = f.runner.fullSnapshot();
    expect(raw.parts.filter(p => p.key.startsWith('fleet.')).map(p => p.key)).toEqual(['fleet.orders']);
    expect(() => f.runner.registerSnapshotProvider('plant:fleet', () => [])).toThrow('duplicate snapshot provider');
    f.orders.reset(); f.zones.release('zone', 'vehicle');
    const swap = vi.spyOn(OrderPool.prototype, 'swapState');
    f.runner.restoreFull(raw);
    expect(swap).toHaveBeenCalledTimes(1);
    expect(f.runner.fullSnapshot()).toEqual(raw);
    f.off(); f.off();
    expect(f.runner.fullSnapshot().parts.some(p => p.key.startsWith('fleet.'))).toBe(false);
  });

  it.each(['capture', 'restore'] as const)('routes provider construction failures through the contract path on %s', mode => {
    const f = fixture(), raw = f.runner.fullSnapshot();
    const before = JSON.stringify(f.runner.getManager().snapshot());
    f.runner.registerSnapshotProvider('throws', () => { throw new Error('provider failure'); });
    expect(() => mode === 'capture' ? f.runner.fullSnapshot() : f.runner.restoreFull(raw)).toThrow('des-snapshot-contract');
    expect(JSON.stringify(f.runner.getManager().snapshot())).toBe(before);
  });

  it('rejects a throwing capture without touching runner or fleet state', () => {
    const f = fixture(), before = f.runner.fullSnapshot();
    const off = f.runner.registerSnapshotProvider('throws', () => [{ key: 'throws', version: 1,
      capture: () => { throw new Error('capture failure'); }, validate: () => [], prepare: () => null, commit: () => {} }]);
    expect(() => f.runner.fullSnapshot()).toThrow('des-snapshot-contract');
    off(); expect(f.runner.fullSnapshot()).toEqual(before);
  });

  it('rejects fleet parts without a provider at preflight before any mutation', () => {
    const source = fixture(), raw = source.runner.fullSnapshot();
    const { runner } = newRunner();
    const before = runner.fullSnapshot();
    expect(() => runner.restoreFull(raw)).toThrow(/unknown participant 'fleet.orders'/);
    expect(runner.fullSnapshot()).toEqual(before);
  });

  it('accepts provider participant keys as queue action owners', () => {
    registerAction('Fleet.Snapshot.Test', () => {}, { owner: 'fleet.orders', payload: 'none' });
    const f = fixture();
    // Observe the real frame to verify the shared owner set used by capture and preflight.
    const frame = (f.runner as unknown as { _snapshotParticipants(): {
      queueContext: Parameters<typeof assertPersistableQueue>[1] } })._snapshotParticipants();
    expect(frame.queueContext.desOwners).toBe(frame.queueContext.participants);
    expect(assertPersistableQueue([{ id: 1, time: 1, action: 'Fleet.Snapshot.Test', componentId: null,
      muId: -1, priority: 0 }], frame.queueContext)).toEqual([]);
    f.off();
    const without = (f.runner as unknown as { _snapshotParticipants(): {
      queueContext: Parameters<typeof assertPersistableQueue>[1] } })._snapshotParticipants();
    expect(assertPersistableQueue([{ id: 1, time: 1, action: 'Fleet.Snapshot.Test', componentId: null,
      muId: -1, priority: 0 }], without.queueContext)).not.toEqual([]);
  });
});
