// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-465 §9.2 — the line gives everything back.
 *
 * A soak runner that builds and tears down a line is only useful if teardown is
 * complete: any residue would be indistinguishable from the leak the soak is
 * looking for. So the tests here compare a full BASELINE before and after, over
 * repeated cycles, and — the part that is easy to get wrong — they check that a
 * foreign signal that happened to live in the same store survives untouched
 * (SOL R2#6 / #8).
 */

import { describe, it, expect } from 'vitest';
import { Scene } from 'three';
import {
  buildSyntheticLine, SYNTHETIC_LINE_PREFIX,
  type SyntheticLineConfig, type SyntheticLineHost,
} from '../../src/core/engine/perf/rv-synthetic-line';
import { RVTransportManager } from '../../src/core/engine/rv-transport-manager';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import type { RVDrive } from '../../src/core/engine/rv-drive';

const STEP = 1 / 60;

type Host = SyntheticLineHost & { drives: RVDrive[]; scene: Scene };

function makeHost(): Host {
  const scene = new Scene();
  const transportManager = new RVTransportManager();
  transportManager.scene = scene;
  return { scene, transportManager, signalStore: new SignalStore(), drives: [], fixedTimeStep: STEP };
}

function run(host: Host, seconds: number): void {
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i++) {
    for (const drive of host.drives) drive.update(STEP);
    host.transportManager.update(STEP);
  }
}

/** Everything the line could possibly have added, in one comparable snapshot. */
function baseline(host: Host) {
  const tm = host.transportManager;
  return {
    surfaces: tm.surfaces.length,
    sensors: tm.sensors.length,
    sources: tm.sources.length,
    sinks: tm.sinks.length,
    mus: tm.mus.length,
    drives: host.drives.length,
    maxLiveMUs: tm.maxLiveMUs,
    sceneChildren: host.scene.children.length,
    store: host.signalStore.stats(),
  };
}

const SMALL: Partial<SyntheticLineConfig> = {
  lanes: 2, plcs: 2, segments: 4, segmentLengthM: 5,
  sensorsPerSegment: 1, targetMUs: 40, speedMmS: 1000,
  muLengthMm: 200, muGapMm: 100, signalBinding: 'browser',
};

describe('synthetic line teardown', () => {
  it('returns to the exact baseline over three build/run/dispose cycles', () => {
    const host = makeHost();
    const before = baseline(host);

    for (let cycle = 0; cycle < 3; cycle++) {
      const handle = buildSyntheticLine(host, SMALL);
      run(host, 30);
      expect(host.transportManager.mus.length).toBeGreaterThan(0);   // it really ran
      handle.dispose();

      const after = baseline(host);
      // `version` legitimately advances (signals were registered and removed),
      // so it is the one field excluded from the identity comparison.
      expect({ ...after, store: { ...after.store, version: 0 } })
        .toEqual({ ...before, store: { ...before.store, version: 0 } });
    }
  });

  it('is idempotent — a second dispose changes nothing', () => {
    const host = makeHost();
    const handle = buildSyntheticLine(host, SMALL);
    run(host, 5);
    handle.dispose();
    const after = baseline(host);
    handle.dispose();
    expect(baseline(host)).toEqual(after);
  });

  it('leaves foreign signals, their listeners, aliases and force pins untouched', () => {
    const host = makeHost();
    const store = host.signalStore;

    store.register('FOO/Bar', 'Machine/Foo/Bar', false, 'BOOL');
    store.registerPathAlias('FOO/Bar', 'Legacy/Foo/Bar');
    store.register('FOO/Speed', 'Machine/Foo/Speed', 0, 'REAL');
    let heard = 0;
    const unsub = store.subscribe('FOO/Bar', () => { heard++; });
    store.forceSignal('FOO/Speed', 123);
    store.buildIndex();
    const foreign = store.stats();

    const handle = buildSyntheticLine(host, SMALL);
    expect(store.stats().signals).toBeGreaterThan(foreign.signals);
    run(host, 5);
    handle.dispose();

    const after = store.stats();
    expect({ ...after, version: 0 }).toEqual({ ...foreign, version: 0 });
    // Not just the counts — the foreign signals must still WORK.
    expect(store.nameForPath('Legacy/Foo/Bar')).toBe('FOO/Bar');
    expect(store.isForced('FOO/Speed')).toBe(true);
    expect(store.getFloat('FOO/Speed')).toBe(123);
    store.set('FOO/Bar', true);
    expect(heard).toBe(1);
    expect(store.getBool('FOO/Bar')).toBe(true);

    // …and nothing of the line's own may have survived.
    for (const name of handle.plan.signals) {
      expect(store.get(name)).toBeUndefined();
    }
    expect(store.nameForPath(`__perf__/${SYNTHETIC_LINE_PREFIX}PLC0/Conv0/Run`)).toBeUndefined();
    unsub();
  });

  it('leaves nothing behind when disposed during warmup, before steady state', () => {
    const host = makeHost();
    const before = baseline(host);
    const handle = buildSyntheticLine(host, SMALL);
    run(host, 2);                                    // still filling
    expect(host.transportManager.mus.length).toBeLessThan(handle.plan.config.targetMUs);
    handle.dispose();
    const after = baseline(host);
    expect({ ...after, store: { ...after.store, version: 0 } })
      .toEqual({ ...before, store: { ...before.store, version: 0 } });
  });

  it('survives an external model teardown happening first', () => {
    // A model change clears the transport manager out from under the line
    // (`RVViewer` → `transportManager.reset()`), and the plugin's `dispose()`
    // then runs against an already-emptied manager. It must not throw and must
    // still release its own drives, signals and scene node.
    const host = makeHost();
    const handle = buildSyntheticLine(host, SMALL);
    run(host, 5);

    host.transportManager.reset(true);
    expect(() => handle.dispose()).not.toThrow();

    expect(host.drives).toHaveLength(0);
    expect(host.scene.children).toHaveLength(0);
    expect(host.signalStore.stats().signals).toBe(0);
    expect(host.transportManager.mus).toHaveLength(0);
  });

  it('releases the instance pools it allocated', () => {
    const host = makeHost();
    const handle = buildSyntheticLine(host, SMALL);
    run(host, 10);
    const sources = [...host.transportManager.sources];
    expect(sources.some((s) => s.pool !== null)).toBe(true);
    handle.dispose();
    for (const source of sources) expect(source.pool).toBeNull();
  });

  it('restores the maxLiveMUs it overrode', () => {
    const host = makeHost();
    host.transportManager.maxLiveMUs = 1234;
    const handle = buildSyntheticLine(host, SMALL);
    expect(host.transportManager.maxLiveMUs).toBe(handle.plan.maxLiveMUs);
    handle.dispose();
    expect(host.transportManager.maxLiveMUs).toBe(1234);
  });
});
