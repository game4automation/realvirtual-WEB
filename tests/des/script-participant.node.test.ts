// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { SnapshotRegistry } from '../../src/plugins/des/rv-snapshot-registry';
import { scriptParticipants } from '../../src/plugins/des/rv-des-script-participant';

it('stages without mutation and applies in sorted DES id order', () => {
  const registry = new SnapshotRegistry(), calls: string[] = [];
  const sources = ['z', 'a'].map(desId => ({ desId, path: desId, adapter: {
    captureScriptState: () => ({ rng: 1, timers: { next: 1, items: [] }, persist: { n: 2 }, legacy: null }),
    restoreScriptState: () => { calls.push(desId); },
  } }));
  const scripts = scriptParticipants(registry, sources);
  for (const part of registry.order()) {
    const json = { rng: 1, timers: { next: 1, items: [] }, persist: { n: 4 } };
    expect(part.validate(json)).toEqual([]);
    part.commit(part.prepare(json));
  }
  expect(calls).toEqual([]);
  scripts.apply();
  expect(calls).toEqual(['a', 'z']);
  expect(() => scripts.dispatcher('missing')).toThrow('unknown script');
});
it('rejects malformed state before invoking the VM', () => {
  const registry = new SnapshotRegistry(), restore = vi.fn();
  scriptParticipants(registry, [{ desId: 's', path: 's', adapter: {
    captureScriptState: () => ({ rng: 1, timers: { next: 1, items: [] } }), restoreScriptState: restore,
  } }]);
  const part = registry.order()[0];
  expect(() => part.prepare({ rng: 1.5 })).toThrow();
  expect(() => part.prepare({ rng: 1, timers: { next: 1, items: [] }, persist: { $map: [] } })).toThrow();
  expect(restore).not.toHaveBeenCalled();
});
it('requires a stable script DES id', () => {
  expect(() => scriptParticipants(new SnapshotRegistry(), [{ path: 'no-id', adapter: {
    captureScriptState: () => ({ rng: 1, timers: { next: 1, items: [] } }), restoreScriptState: () => {},
  } }])).toThrow('des-snapshot-unaddressable');
});
