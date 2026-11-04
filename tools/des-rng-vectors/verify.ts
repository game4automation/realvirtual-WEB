// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SFC32, SFC32Legacy, SFC32v2 } from '../realvirtual-WebViewer~/src/core/rv-rng-distribution';
import { seedKey64 } from '../realvirtual-WebViewer~/src/core/rv-rng-streams';
import { legacySequences } from '../realvirtual-WebViewer~/tests/des/rng-v2-legacy-harness';
import { DESRunner } from '../realvirtual-WebViewer~/src/plugins/des/des-runner';
import { registerAction } from '../realvirtual-WebViewer~/src/plugins/des/rv-des-named-actions';

const fixture = (name: string) => JSON.parse(readFileSync(`tests/des/fixtures/rng-v2/${name}.json`, 'utf8'));
for (const v of fixture('sfc32-practrand-vectors').vectors) {
  const rng = SFC32v2.fromSeed64(BigInt(v.seed));
  assert.deepEqual(rng.getState(), v.state);
  assert.deepEqual(Array.from({ length: 32 }, () => rng.next()), v.outputs);
  const state = rng.getState();
  const tail = Array.from({ length: 32 }, () => rng.next());
  rng.setState(state);
  assert.deepEqual(Array.from({ length: 32 }, () => rng.next()), tail);
}
for (const v of fixture('seedkey-vectors').vectors) assert.equal(seedKey64(v.masterSeed, v.id, v.purpose), BigInt(v.expected));
for (const seed of [NaN, Infinity, -Infinity]) assert.throws(() => seedKey64(seed, '', ''));
const keys = new Set<bigint>();
for (let i = 0; i < 10_000; i++) for (const p of ['default', 'downtime:mtbf', 'downtime:mttr', 'takt']) keys.add(seedKey64(42, `Line/Station${i}`, p));
assert.equal(keys.size, 40_000);
assert.equal(SFC32, SFC32Legacy);
const { provenance, ...legacy } = fixture('legacy-sequences');
assert.deepEqual(legacySequences(), legacy);
console.log('PASS: PractRand reference/state, Python seed keys, 40,000 collision sample, legacy alias and consumer sequences');

const action = registerAction('RngV2.DirectVersionProbe', () => {});
const runner = new DESRunner({ masterSeed: 12345 });
const manager = runner.getManager();
const state = () => ({ seed: manager.masterSeed, version: manager.rngVersion, time: manager.currentTime, queue: manager.getEventQueueSnapshot(), rng: manager.rng.getState() });
try {
  assert.equal(runner.rngVersion, 1);
  for (const phase of ['fresh', 'queued', 'advanced']) {
    if (phase === 'queued') manager.scheduleEventByIndex(5, action, -1);
    if (phase === 'advanced') manager.processStep();
    const before = state();
    for (const v of [2, 99, 0, -1, 1.5, NaN, Infinity]) {
      assert.throws(() => runner.setRngVersion(v), v === 2 ? /^Error: rng-v2-not-wired:/ : /^Error: rng-version-unknown:/);
      assert.deepEqual(state(), before);
    }
    runner.setRngVersion(1);
    assert.deepEqual(state(), before);
  }
} finally { runner.dispose(); }
console.log('PASS: version validation without mutation');
// The batch-host half of this check (DesBatchRunner, plan-2211: commercial) moved to
// realvirtual-WebViewer-Private~/tools/des-rng-vectors/verify-batch.ts.
