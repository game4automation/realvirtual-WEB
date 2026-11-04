// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { RngStreamHandle } from '../../src/core/rv-rng-streams';
import type { RngStreamsDoc } from '../../src/plugins/des/rv-des-rng-state';
import { assertContinuation } from '../helpers/des-continuation-harness';
import { robotDemoWorld } from './continuation-world-fixture';
import { partState } from './snapshot-test-utils';

describe('Stochastic downtime continuation', () => {
  for (const version of [1, 2] as const) {
    for (const mode of ['A', 'B', 'B-immediate'] as const) {
      it.each([0.25, 7, 30])(`v${version} ${mode} cut %s`, async T => {
        await assertContinuation({ buildWorld: () => robotDemoWorld(true, version),
          mode, T, TPrime: 550, T2: 600 });
      });
    }
  }
  it('captures advanced v2 streams and a repair purpose first drawn after the cut', () => {
    const world = robotDemoWorld(true, 2);
    try {
      world.step(0.25);
      const cut = partState<RngStreamsDoc>(world.runner.fullSnapshot(), 'des.rng');
      expect(cut.streams.length).toBeGreaterThan(0);
      expect(cut.streams.some(e => JSON.stringify(e.state) !== JSON.stringify(
        new RngStreamHandle(cut.masterSeed, e.id, e.purpose).getState()))).toBe(true);
      const late = cut.streams.find(e => e.id.includes('LateFailure') && e.purpose === 'downtime:mtbf');
      expect(late).toBeDefined();
      expect(cut.streams.some(e => e.id === late!.id && e.purpose === 'downtime:mttr')).toBe(false);
      world.step(600);
      const after = partState<RngStreamsDoc>(world.runner.fullSnapshot(), 'des.rng');
      expect(after.streams.some(e => e.id === late!.id && e.purpose === 'downtime:mttr')).toBe(true);
    } finally { world.dispose?.(); }
  });
});
