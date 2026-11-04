// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { ChainTransferFlow, type ChainTransferLocal } from '../../src/behaviors/ChainTransfer';
import { assertContinuation, ContinuationMismatch } from '../helpers/des-continuation-harness';
import { chainTransferWorld } from './continuation-chain-transfer-world';

const cuts = [0.25, 3, 10, 30];

it('cuts cover live transit and parked MUs, before and after warm-up/checkpoint', async () => {
  const world = chainTransferWorld();
  try {
    const local = world.runner.liveInstances.find(i => i.def.type === 'ChainTransfer')!.self.local as unknown as ChainTransferLocal;
    let transit = false, parked = false;
    for (const T of cuts) {
      await world.step(T);
      expect(local.transitMUs.size + local.blockedMUs.length).toBeGreaterThan(0);
      if (T === 0.25) expect(local.transitMUs.size).toBeGreaterThan(0);
      if (T === 10) expect(local.blockedMUs.length).toBeGreaterThan(0);
      transit ||= local.transitMUs.size > 0;
      parked ||= local.blockedMUs.length > 0;
    }
    expect(transit).toBe(true);
    expect(parked).toBe(true);
  } finally { world.dispose?.(); }
});

for (const mode of ['A', 'B', 'B-immediate'] as const) {
  it.each(cuts)(`${mode}: ChainTransfer continuation at %s`, async T => {
    await assertContinuation({ buildWorld: chainTransferWorld, mode, T, TPrime: 60, T2: 120 });
  });
}

it('detects hidden adapter state and omitted local state on ChainTransfer', async () => {
  const world = chainTransferWorld();
  try {
    const transfer = world.runner.liveInstances.find(i => i.def.type === 'ChainTransfer')!;
    Object.defineProperty(transfer.adapter, 'hiddenCounter', { value: 42 });
    expect(() => world.runner.fullSnapshot()).toThrow(/des-state-not-declared.*Transfer.*hiddenCounter/);
  } finally { world.dispose?.(); }

  const hooks = ChainTransferFlow.des!;
  const original = hooks.onAccept!;
  hooks.onAccept = (self, mu) => {
    const count = Reflect.get(self.local, 'hiddenCounter') ?? 0;
    Reflect.set(self.local, 'hiddenCounter', count + 1);
    return original(self, mu);
  };
  const buildWorld = () => {
    const w = chainTransferWorld();
    const transfer = w.runner.liveInstances.find(i => i.def.type === 'ChainTransfer')!;
    return { ...w, kpis: () => ({ ...w.kpis(), [transfer.desId!]: {
      hiddenCounter: Reflect.get(transfer.self.local, 'hiddenCounter') ?? 0,
    } }) };
  };
  try {
    for (const mode of ['A', 'B', 'B-immediate'] as const) {
      // At 10 s several accepts have happened; a fresh world's initial accept
      // cannot accidentally reproduce the omitted counter at the cut.
      const error = await assertContinuation({ buildWorld, mode, T: 10, TPrime: 60, T2: 120 })
        .then(() => undefined, error => error);
      expect(error).toBeInstanceOf(ContinuationMismatch);
      expect(error).toMatchObject({ code: 'des-state-not-declared', participant: '#Transfer@ChainTransfer',
        path: '$.kpis["hiddenCounter"]' });
    }
  } finally { hooks.onAccept = original; }
});


