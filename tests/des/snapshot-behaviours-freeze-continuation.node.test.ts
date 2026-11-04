// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { assertContinuation } from '../helpers/des-continuation-harness';
import { freezeWorld } from './continuation-freeze-world';
import type { ConveyorLocal } from '../../src/behaviors/Conveyor';
import type { ChainTransferLocal } from '../../src/behaviors/ChainTransfer';
import { mfActionName } from '../../src/plugins/des/des-hook-adapter';

const cuts = [10, 17.25];
for (const type of ['Conveyor', 'ChainTransfer'] as const) {
  it(`${type}: cuts prove frozen Arrival and resumed active transit`, async () => {
    const w = freezeWorld(type);
    try {
      const subject = w.runner.liveInstances.find(i => i.def.type === type)!;
      const local = subject.self.local as unknown as ConveyorLocal | ChainTransferLocal;
      await w.step(0.25);
      const [[muId, oldHandle]] = [...local.transitMUs];
      await w.step(cuts[0]);
      const frozen = subject.adapter.toSnapshot();
      expect(frozen.isFailure).toBe(true);
      expect(frozen).toMatchObject({ frozen: [expect.objectContaining({ action: mfActionName(type, 'Arrival'), muRef: expect.objectContaining({ id: expect.any(Number) }) })] });
      expect(local.transitMUs.size).toBeGreaterThan(0);
      await w.step(cuts[1]);
      expect(subject.adapter.isFailure).toBe(false);
      expect(subject.adapter.toSnapshot()).not.toHaveProperty('frozen');
      expect(local.transitMUs.size).toBeGreaterThan(0);
      const resumed = w.runner.fullSnapshot().eventQueue.find(e => e.componentId === subject.desId
        && e.action === mfActionName(type, 'Arrival') && e.muId === muId)!;
      expect(resumed).toBeDefined();
      expect(resumed.id).not.toBe(oldHandle);
      expect(local.transitMUs.get(muId)).toBe(oldHandle);
    } finally { w.dispose?.(); }
  });
  it.each(cuts)(`${type}: snapshot at cut %s restores immediately`, async T => {
    const w = freezeWorld(type);
    try {
      await w.step(T);
      const saved = w.runner.fullSnapshot();
      const part = saved.parts.find(p => p.key === `#Transfer@${type}`)!;
      const state = (part.state as { behaviourState: { transit?: unknown[]; transitMUs?: unknown[] } }).behaviourState;
      const transit = (type === 'Conveyor' ? state.transit : state.transitMUs)!;
      expect(transit).toHaveLength(1);
      expect(Object.keys(transit[0] as object)).toEqual(['muRef']);
      w.runner.restoreFull(JSON.parse(JSON.stringify(saved)));
      expect(w.runner.fullSnapshot()).toEqual(saved);
      const local = w.runner.liveInstances.find(i => i.def.type === type)!.self.local;
      expect([...(local as unknown as ConveyorLocal | ChainTransferLocal).transitMUs.values()]).toEqual([-1]);
    } finally { w.dispose?.(); }
  });
  for (const mode of ['A', 'B', 'B-immediate'] as const) {
    it.each(cuts)(`${mode}: ${type} freeze/resume continuation at %s`, async T => {
      await assertContinuation({ buildWorld: () => freezeWorld(type), mode, T, TPrime: 35, T2: 60 });
    });
  }
}
