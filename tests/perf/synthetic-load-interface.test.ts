// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-465 §9.6 — the in-browser signal-load generator.
 *
 * Its whole reason to exist is to isolate the SignalStore's own cost from the
 * transport chain, which only holds if it really travels the PRODUCTION
 * buffer/flush path (`bufferIncoming` → `onFixedUpdatePre` → `setMany`). So the
 * tests drive it as a real interface — connect, tick, read the store — rather
 * than poking its internals.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  SyntheticLoadInterface, SYNTHETIC_LOAD_PREFIX,
} from '../../src/interfaces/synthetic-load-interface';
import { INTERFACE_DEFAULTS } from '../../src/interfaces/interface-settings-store';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import type { RVViewer } from '../../src/core/rv-viewer';
import type { LoadResult } from '../../src/core/engine/rv-scene-loader';

const STEP = 1 / 60;
let active: SyntheticLoadInterface | null = null;

afterEach(() => { active?.dispose(); active = null; });

async function connectLoad(store: SignalStore, cfg: Parameters<SyntheticLoadInterface['configure']>[0]) {
  const iface = new SyntheticLoadInterface();
  active = iface;
  iface.configure(cfg);
  // `bufferIncoming` emits a viewer event on the first payload, so the fake
  // viewer needs an event sink as well as the store.
  const viewer = { signalStore: store, emit: () => {}, on: () => () => {} };
  iface.onModelLoaded(null as unknown as LoadResult, viewer as unknown as RVViewer);
  await iface.connect({ ...INTERFACE_DEFAULTS, autoConnect: false });
  return iface;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('SyntheticLoadInterface', () => {
  it('registers exactly the filler signals it advertises', async () => {
    const store = new SignalStore();
    const iface = await connectLoad(store, { plcs: 2, signalsPerPlc: 10, cycleMs: 1000 });

    expect(iface.signalNames).toHaveLength(20);
    expect(iface.signalNames[0]).toBe(`${SYNTHETIC_LOAD_PREFIX}PLC0/S0`);
    expect(store.get(`${SYNTHETIC_LOAD_PREFIX}PLC1/S9`)).toBe(0);
    expect(store.stats().signals).toBe(20);
  });

  it('commits changeRatio x N signals per cycle through the real flush path', async () => {
    const store = new SignalStore();
    const iface = await connectLoad(store, {
      plcs: 1, signalsPerPlc: 100, cycleMs: 20, changeRatio: 0.2,
    });

    await sleep(120);              // ~6 cycles
    // Nothing may have reached the store yet — the interface buffers and only
    // commits in onFixedUpdatePre, in step with drive physics.
    const beforeFlush = store.stats().version;
    iface.onFixedUpdatePre(STEP);
    expect(store.stats().version).toBeGreaterThan(beforeFlush);

    const stats = iface.stats();
    expect(stats.cycles).toBeGreaterThanOrEqual(4);
    expect(stats.produced).toBeGreaterThanOrEqual(stats.cycles * 20);
    expect(stats.flushes).toBe(1);
    // The buffer is a Map, so repeated writes to one signal within a flush
    // window collapse — "produced" and "committed" are different numbers by
    // design and the report has to show both.
    expect(stats.committed).toBeLessThanOrEqual(stats.produced);
    expect(stats.committed).toBeGreaterThan(0);
  });

  it('measures a flush duration and reports it', async () => {
    const store = new SignalStore();
    const iface = await connectLoad(store, {
      plcs: 2, signalsPerPlc: 200, cycleMs: 10, changeRatio: 1,
    });

    await sleep(120);
    iface.onFixedUpdatePre(STEP);
    const stats = iface.stats();
    expect(stats.flushes).toBe(1);
    expect(stats.flushMsMax).toBeGreaterThanOrEqual(0);
    // A flush of a few hundred signals is a sub-millisecond operation; anything
    // near a fixed step would already be a finding.
    expect(stats.flushMsMax).toBeLessThan(1000 / 60);
  });

  it('does nothing at all on a tick with an empty buffer', async () => {
    const store = new SignalStore();
    const iface = await connectLoad(store, { plcs: 1, signalsPerPlc: 10, cycleMs: 100_000 });

    const before = store.stats().version;
    iface.onFixedUpdatePre(STEP);
    iface.onFixedUpdatePre(STEP);
    expect(store.stats().version).toBe(before);
    expect(iface.stats().flushes).toBe(0);
  });

  it('drives configured line signals like a PLC, one belt stopped at a time', async () => {
    const store = new SignalStore();
    const lineSignals = ['LINE/PLC0/Conv0/Run', 'LINE/PLC0/Conv1/Run', 'LINE/PLC0/Conv2/Run'];
    for (const name of lineSignals) store.register(name, `__t__/${name}`, true, 'BOOL');

    const iface = await connectLoad(store, {
      plcs: 1, signalsPerPlc: 5, cycleMs: 10, changeRatio: 0.2,
      lineSignals, stopSeconds: 0.05, stopPeriodSeconds: 0.2,
    });

    // Watch across several stop periods: at every observation at most one belt
    // may be stopped. A generator that stopped them all would drain a real line
    // and destroy the steady state the whole measurement is defined over.
    let sawAStop = false;
    for (let i = 0; i < 60; i++) {
      await sleep(10);
      iface.onFixedUpdatePre(STEP);
      const stopped = lineSignals.filter((n) => store.getBool(n) === false);
      expect(stopped.length).toBeLessThanOrEqual(1);
      if (stopped.length === 1) sawAStop = true;
    }
    expect(sawAStop).toBe(true);
  });

  it('stops producing on dispose', async () => {
    const store = new SignalStore();
    const iface = await connectLoad(store, { plcs: 1, signalsPerPlc: 10, cycleMs: 10 });
    await sleep(50);
    const cyclesAtDispose = iface.stats().cycles;
    expect(cyclesAtDispose).toBeGreaterThan(0);

    iface.dispose();
    active = null;
    await sleep(60);
    expect(iface.stats().cycles).toBe(cyclesAtDispose);
  });
});
