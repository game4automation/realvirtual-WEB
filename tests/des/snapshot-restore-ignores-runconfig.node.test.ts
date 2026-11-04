// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-2059 (Thomas, 2026-11-01): a restore compares model + release version only;
// run end / warm-up (runConfig) may differ between save and restore.
import { afterEach, describe, expect, it } from 'vitest';
import { resetDESMUCounter } from '../../src/plugins/des/rv-des-mu';
import { compareFullSnapshots } from '../helpers/des-continuation-harness';
import { writeComponentField } from '../../src/core/params/rv-param-field';
import { modelEditEpoch } from '../../src/core/engine/rv-model-edit-epoch';
import { lineFixture } from './runner-fixture';

const worlds: Array<{ runner: { dispose(): void } }> = [];
afterEach(() => { worlds.splice(0).forEach(w => w.runner.dispose()); });

function world(endTime: number, opts: Parameters<typeof lineFixture>[0] = {}) {
  resetDESMUCounter();
  const f = lineFixture({ statResetTime: 20, ...opts });
  f.manager.duration = endTime;
  worlds.push(f);
  return f;
}

describe('restore ignores runConfig, still compares model', () => {
  it('modelHash does not move with the run end; runConfigHash does', () => {
    const a = world(100), b = world(200);
    const fa = a.runner.fingerprintNow(), fb = b.runner.fingerprintNow();
    if (!fa.ok || !fb.ok) throw new Error('fingerprint not ok');
    expect(fb.fingerprint.modelHash).toBe(fa.fingerprint.modelHash);
    expect(fb.fingerprint.runConfigHash).not.toBe(fa.fingerprint.runConfigHash);
  });

  it('Mode A: same runner, run end extended after the save, restore continues bit-exact', () => {
    const f = world(100);
    f.runUntil(30);
    const saved = JSON.parse(JSON.stringify(f.snapshot()));
    f.runUntil(80);
    f.manager.duration = 200;
    f.restore(saved);
    f.runUntil(120);
    const ref = world(200); ref.runUntil(30); ref.runUntil(120);
    compareFullSnapshots(ref.snapshot(), f.snapshot());
  });

  it('Mode B: fresh runner with another run end restores and continues bit-exact', () => {
    const f = world(100);
    f.runUntil(30);
    const saved = JSON.parse(JSON.stringify(f.snapshot()));
    const g = world(200);
    g.restore(saved);
    g.runUntil(120);
    const ref = world(200); ref.runUntil(30); ref.runUntil(120);
    compareFullSnapshots(ref.snapshot(), g.snapshot());
  });

  it('a changed model is still rejected', () => {
    const f = world(100);
    f.runUntil(30);
    const saved = JSON.parse(JSON.stringify(f.snapshot()));
    const g = world(100, { stationProcessTime: 6 });
    expect(() => g.restore(saved)).toThrow(/fingerprint|Modell|model/i);
  });

  it('another release version is still rejected', () => {
    const f = world(100);
    f.runUntil(30);
    const saved = JSON.parse(JSON.stringify(f.snapshot()));
    const g = world(100);
    // A snapshot of another release hashes the same model with another runtimeVersion = other modelHash.
    saved.fingerprint.modelHash = 'hash-of-another-runtime-version';
    expect(() => g.restore(saved)).toThrow(/fingerprint|Modell|model/i);
  });

  // Codex review P1: the authored DESManager node ('Simulation') carries EndTime / StatisticsResetTime /
  // MasterSeed in the scene extras; those must not count as model either.
  const manager = (endTime: number, warmup: number, seed: number) =>
    ({ desManager: { EndTime: endTime, StatisticsResetTime: warmup, MasterSeed: seed } });

  it('authored DESManager run fields do not move modelHash', () => {
    const a = world(100, manager(100, 20, 7)), b = world(100, manager(900, 50, 9));
    const fa = a.runner.fingerprintNow(), fb = b.runner.fingerprintNow();
    if (!fa.ok || !fb.ok) throw new Error('fingerprint not ok');
    expect(fb.fingerprint.modelHash).toBe(fa.fingerprint.modelHash);
  });

  it('editing the DESManager run fields after the save is no model edit; restore continues bit-exact (Mode A)', () => {
    const f = world(100, manager(100, 20, 7));
    f.runUntil(30);
    const saved = JSON.parse(JSON.stringify(f.snapshot()));
    f.runUntil(80);
    const epoch = modelEditEpoch();
    for (const [field, value] of [['EndTime', 500], ['StatisticsResetTime', 40], ['MasterSeed', 9]] as const)
      writeComponentField(f.simulation!, 'DESManager', field, value);
    expect(modelEditEpoch()).toBe(epoch);
    f.manager.duration = 500;
    f.restore(saved);
    f.runUntil(120);
    const ref = world(100, manager(100, 20, 7)); ref.runUntil(30); ref.manager.duration = 500; ref.runUntil(120);
    compareFullSnapshots(ref.snapshot(), f.snapshot());
  });

  it('fresh runner whose scene authors other run fields restores (Mode B)', () => {
    const f = world(100, manager(100, 20, 7));
    f.runUntil(30);
    const saved = JSON.parse(JSON.stringify(f.snapshot()));
    const g = world(100, manager(500, 20, 7));
    g.restore(saved);
    g.runUntil(120);
    const ref = world(100, manager(500, 20, 7)); ref.runUntil(30); ref.runUntil(120);
    compareFullSnapshots(ref.snapshot(), g.snapshot());
  });

  it('any other DESManager or model field still counts', () => {
    const a = world(100, { desManager: { ...manager(100, 20, 7).desManager, Other: 1 } }), b = world(100, { desManager: { ...manager(100, 20, 7).desManager, Other: 2 } });
    const fa = a.runner.fingerprintNow(), fb = b.runner.fingerprintNow();
    if (!fa.ok || !fb.ok) throw new Error('fingerprint not ok');
    expect(fb.fingerprint.modelHash).not.toBe(fa.fingerprint.modelHash);
  });
});
