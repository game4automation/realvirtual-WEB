// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { expect, it } from 'vitest';
import { assertContinuation } from '../helpers/des-continuation-harness';
import { freezeWorld } from './continuation-freeze-world';

// plan-2059 Phase 7 finding (B5, not reproduced at the time): one MU on an 8 s transit is
// frozen by Downtime several times. Short MTBF/MTTR pairs freeze the same MU 2-4 times,
// and every cut below falls into a frozen or a resumed segment of one of those cycles.
const downtimes = [{ MTBF: 1.5, MTTR: 1 }, { MTBF: 2, MTTR: 1.5 }, { MTBF: 1.2, MTTR: 0.9 }];
const cuts = [2.2, 3.1, 4.4, 5.5, 6.3, 7.7, 9.4, 11.1];
for (const type of ['Conveyor', 'ChainTransfer'] as const) {
  for (const downtime of downtimes) {
    for (const mode of ['A', 'B', 'B-immediate'] as const) {
      it.each(cuts)(`${mode}: ${type} MTBF ${downtime.MTBF} MTTR ${downtime.MTTR} refreezes the same MU - continuation at %s`, async T => {
        await assertContinuation({ buildWorld: () => freezeWorld(type, downtime), mode, T, TPrime: 20, T2: 40 });
      });
    }
  }
  it(`${type}: the same MU is frozen more than once in the repro world`, async () => {
    const w = freezeWorld(type, downtimes[0]);
    try {
      const subject = w.runner.liveInstances.find(i => i.def.type === type)!;
      let freezes = 0, was = false;
      for (let t = 0.1; t <= 12; t += 0.1) {
        await w.step(t);
        const failed = subject.adapter.isFailure;
        if (failed && !was) freezes++;
        was = failed;
      }
      expect(freezes).toBeGreaterThanOrEqual(3);
    } finally { w.dispose?.(); }
  });
}
