// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-2059 3a — regressions for the Codex adversarial review (thread 01a196d1-6e14-7fe2-9c06-d683f8f2bc8e):
// (1) the MU a back-pressured Source holds is run state; (2) a malformed tween is refused
// before anything is torn down (status unchanged, not corrupt).
import { describe, expect, it } from 'vitest';
import { resetDESMUCounter } from '../../src/plugins/des/rv-des-mu';
import { assertContinuation } from '../helpers/des-continuation-harness';
import { lineFixture } from './runner-fixture';
import { continuationWorld } from './continuation-world-fixture';
import { componentState } from './snapshot-test-utils';

/** Station slower than the source: the source holds a generated MU back (ZPA). */
function backpressuredWorld() {
  resetDESMUCounter();
  const f = lineFixture({ interArrivalTime: 1, stationProcessTime: 7 });
  return { f, world: continuationWorld(f.runner) };
}

describe('plan-2059 3a review fixes', () => {
  it('a back-pressured Source stores its held MU as a ref', () => {
    const { f, world } = backpressuredWorld();
    world.step(10);
    const pending = (componentState(f.runner.fullSnapshot(), 'Source') as unknown as {
      sourcePending: { muRef: { id: number; gen: number } } | null }).sourcePending;
    expect(pending, 'the source holds an MU back at t=10').not.toBeNull();
    world.dispose?.();
  });

  for (const mode of ['A', 'B', 'B-immediate'] as const) {
    it(`${mode}: continuation with a held-back Source MU is bit-exact`, async () => {
      await assertContinuation({ buildWorld: () => backpressuredWorld().world, mode, T: 10, TPrime: 25, T2: 60 });
    });
  }

  it('a position tween without `from` is refused unchanged, before any teardown', () => {
    const { f, world } = backpressuredWorld();
    world.step(10);
    const saved = f.runner.fullSnapshot();
    const before = JSON.stringify(f.runner.fullSnapshot());
    const bad = JSON.parse(JSON.stringify(saved)) as typeof saved;
    const muId = (bad.parts.find(p => p.key === 'des.mus')!.state as { records: Array<{ id: number }> }).records[0].id;
    bad.parts.find(p => p.key === 'des.tweens')!.state = [{ kind: 'position', t0: 0, t1: 20, muId, to: [1, 0, 0] }];
    let error: unknown;
    try { f.runner.restoreFull(bad); } catch (e) { error = e; }
    expect(error).toMatchObject({ status: 'unchanged' });
    expect(String(error)).toMatch(/des-snapshot-contract/);
    expect(JSON.stringify(f.runner.fullSnapshot()), 'live world untouched').toBe(before);
    world.dispose?.();
  });
});
