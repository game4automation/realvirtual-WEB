// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrderPool } from '../../src/core/fleet/core/orders';
import { ZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { RVPath } from '../../src/core/engine/rv-path';
import { fleetSnapshotProvider, zoneSnapshotParticipant } from '../../src/plugins/fleet-snapshot-participants';
import { captureDetached } from '../../src/plugins/des/rv-snapshot-capture';
import { restoreTransaction } from '../../src/plugins/des/rv-snapshot-restore';
import { snapshotFrame } from '../helpers/snapshot-frame';

function fixture() {
  const f = snapshotFrame();
  const orders = new OrderPool(), zones = new ZoneRegistry();
  const paths = new Map([['path', new RVPath('path', [])]]);
  orders.add({ source: 'pick', destination: 'drop' }, 0);
  zones.declare('zone', paths.get('path')!, 1); zones.claim('zone', 'vehicle');
  const world = { orders, zones, paths, stationKnown: (id: string) => ['pick', 'drop'].includes(id) };
  const ordersProvider = fleetSnapshotProvider(world);
  const provider: typeof ordersProvider = ctx => [...ordersProvider(ctx), zoneSnapshotParticipant(world)];
  for (const p of provider({ restoring: false })) f.registry.register(p);
  f.raw.parts = captureDetached(f.registry).parts;
  return { ...f, orders, zones, paths, provider };
}

describe('fleet snapshot participants', () => {
  afterEach(() => vi.restoreAllMocks());
  it('declares complete owners and restores detached state with current path identities', () => {
    const f = fixture();
    expect(fleetSnapshotProvider({ orders: f.orders, zones: f.zones, paths: f.paths, stationKnown: () => true })({ restoring: false }).map(p => p.key)).toEqual(['fleet.orders']);
    expect(f.provider({ restoring: false }).map(p => p.key)).toEqual(['fleet.orders', 'fleet.zones']);
    const saved = captureDetached(f.registry).parts;
    f.orders.reset();
    f.paths.set('path', new RVPath('path', []));
    expect(restoreTransaction(f.raw, f.ctx)).toEqual({ ok: true });
    expect(captureDetached(f.registry).parts).toEqual(saved);
    expect(f.orders.exportState().open).toHaveLength(1);
  });

  it.each(['orders', 'zones'] as const)('rejects an undeclared runtime property on %s', owner => {
    const f = fixture();
    Object.defineProperty(f[owner], 'runtimeExtra', { value: 1 });
    expect(() => captureDetached(f.registry)).toThrow(`des-state-not-declared: fleet.${owner}.runtimeExtra`);
  });

  it.each(['orders', 'zones'] as const)('preflights invalid %s before either swap', key => {
    const f = fixture();
    const before = captureDetached(f.registry);
    const ordersSwap = vi.spyOn(OrderPool.prototype, 'swapState'), zonesSwap = vi.spyOn(ZoneRegistry.prototype, 'swapState');
    Object.assign(f.raw.parts.find(p => p.key === `fleet.${key}`)!.state as object, { unknown: 1 });
    expect(restoreTransaction(f.raw, f.ctx)).toMatchObject({ ok: false, stage: 'preflight', status: 'unchanged' });
    expect(ordersSwap).not.toHaveBeenCalled(); expect(zonesSwap).not.toHaveBeenCalled();
    expect(captureDetached(f.registry)).toEqual(before);
  });

  it('leaves both owners untouched when a later prepare throws', () => {
    const f = fixture(), before = captureDetached(f.registry);
    const swaps = [vi.spyOn(OrderPool.prototype, 'swapState'), vi.spyOn(ZoneRegistry.prototype, 'swapState')];
    f.registry.register({ key: 'failure', version: 1, capture: () => null, validate: () => [],
      prepare: () => { throw new Error('prepare failure'); }, commit: () => {} });
    f.raw.parts.push({ key: 'failure', version: 1, state: null });
    expect(restoreTransaction(f.raw, f.ctx)).toMatchObject({ ok: false, stage: 'prepare', status: 'unchanged' });
    for (const swap of swaps) expect(swap).not.toHaveBeenCalled();
    f.registry.unregister('failure');
    expect(captureDetached(f.registry)).toEqual(before);
  });

  describe('order payloads are checked by the contract on the live original (not cloned away)', () => {
    class Payload { value = 1; }
    const withPayload = (payload: unknown) => {
      const f = fixture();
      Object.defineProperty(f.orders.openOf('pick')!, 'payload', { value: payload, enumerable: true, configurable: true });
      return f;
    };
    it('a plain payload is captured detached from the live object', () => {
      const payload = { nested: [1] }, f = withPayload(payload);
      const parts = captureDetached(f.registry).parts;
      payload.nested.push(2);
      expect(JSON.stringify(parts.find(p => p.key === 'fleet.orders')!.state)).toContain('"nested":[1]');
      expect(JSON.stringify(parts.find(p => p.key === 'fleet.orders')!.state)).not.toContain('[1,2]');
    });
    it.each([
      ['a class instance', () => new Payload()],
      ['a getter that mutates live state', () => Object.defineProperty({}, 'x', { enumerable: true, get() { throw new Error('getter ran'); } })],
      ['a function', () => ({ fn: () => 1 })],
      ['a hidden (non-enumerable) field', () => Object.defineProperty({ a: 1 }, 'hidden', { value: 2, enumerable: false })],
    ])('refuses %s at capture', (_name, make) => {
      const f = withPayload(make());
      expect(() => captureDetached(f.registry)).toThrow(/fleet.orders/);
    });
    it('refuses a payload object shared by two orders (alias)', () => {
      const f = fixture(), shared = { v: 1 };
      f.orders.add({ source: 'pick', destination: 'drop' }, 1);
      for (const o of f.orders.exportState().open) Object.defineProperty(f.orders.openOf(o.source)!, 'payload', { value: shared, enumerable: true, configurable: true });
      const second = f.orders.pending(1).find(o => o.id !== f.orders.openOf('pick')!.id);
      if (second) Object.defineProperty(second, 'payload', { value: shared, enumerable: true, configurable: true });
      expect(() => captureDetached(f.registry)).toThrow(/alias|shared|fleet.orders/i);
    });
  });
});
