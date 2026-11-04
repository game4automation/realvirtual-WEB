// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2227 Phase 2 (R2, §2.4) — the model's SignalConnectors are checked
 * against the CONNECT 1:1 mappings (`bridge_list.mappings`) while CONNECT is
 * connected: a mapping that writes the same signal is a fan-in, an enabled
 * mapping can close a cycle, a disabled one and a disconnected gateway count
 * for nothing. The feed is the one `connect-store` installs; here a fake.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeConnectorWorld } from './helpers/signal-connector-rig';
import {
  SIGNAL_CONNECTOR_PROBLEM_CODES,
  setSignalConnectorGatewayFeed,
  type GatewayMappingFeed,
} from '../src/core/engine/rv-signal-connector';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';
import { resetSlotAuthority } from '../src/core/engine/rv-slot-authority';

type Mapping = { enabled: boolean; sourceSignal: string; destSignal: string };

function fakeFeed(initial: Mapping[] | null) {
  let mappings = initial;
  const listeners = new Set<() => void>();
  const feed: GatewayMappingFeed = {
    get: () => mappings,
    subscribe: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
  };
  return {
    feed,
    set(next: Mapping[] | null) { mappings = next; for (const l of [...listeners]) l(); },
    listeners,
  };
}

const flush = () => new Promise<void>((r) => queueMicrotask(r));
const codes = () => getProblems().map((p) => p.code);

beforeEach(() => { resetSlotAuthority(); resetProblemsForTests(); });
afterEach(() => { setSignalConnectorGatewayFeed(null); resetSlotAuthority(); resetProblemsForTests(); });

describe('SignalConnector vs. CONNECT mappings (R2)', () => {
  it('a mapping onto the connector target is a fan-in; removing it releases the connector', async () => {
    const f = fakeFeed([{ enabled: true, sourceSignal: 'GW_Ready', destSignal: 'Rob_Ready' }]);
    setSignalConnectorGatewayFeed(f.feed);
    const w = makeConnectorWorld();
    const src = w.signal('RobotReady', 'PLCOutputBool');
    const dst = w.signal('Rob_Ready', 'PLCInputBool');
    const c = w.connector('Coupler', { Mode: 'Copy', SourceBool: src, TargetBool: dst });
    expect(c.isActive).toBe(false);
    const fan = getProblems().find((p) => p.code === SIGNAL_CONNECTOR_PROBLEM_CODES.fanIn);
    expect(fan?.detail).toContain('CONNECT mapping GW_Ready → Rob_Ready');

    f.set([]);
    await flush();
    expect(c.isActive).toBe(true);
    expect(codes()).not.toContain(SIGNAL_CONNECTOR_PROBLEM_CODES.fanIn);
    w.store.setByPath(src, true);
    expect(w.store.getByPath(dst)).toBe(true);
    w.dispose();
  });

  it('disabled mappings, a disconnected gateway (null) and mappings on other signals do not count', async () => {
    const f = fakeFeed([
      { enabled: false, sourceSignal: 'GW_Ready', destSignal: 'Rob_Ready' },
      { enabled: true, sourceSignal: 'A', destSignal: 'B' },
    ]);
    setSignalConnectorGatewayFeed(f.feed);
    const w = makeConnectorWorld();
    const c = w.connector('Coupler', { Mode: 'Copy', SourceBool: w.signal('RobotReady', 'PLCOutputBool'), TargetBool: w.signal('Rob_Ready', 'PLCInputBool') });
    expect(c.isActive).toBe(true);
    f.set(null);
    await flush();
    expect(c.isActive).toBe(true);
    // Connecting later with a conflicting mapping re-checks.
    f.set([{ enabled: true, sourceSignal: 'X', destSignal: 'Rob_Ready' }]);
    await flush();
    expect(c.isActive).toBe(false);
    expect(codes()).toContain(SIGNAL_CONNECTOR_PROBLEM_CODES.fanIn);
    w.dispose();
  });

  it('a mapping closing the loop target → source is a cycle', () => {
    const f = fakeFeed([{ enabled: true, sourceSignal: 'Rob_Ready', destSignal: 'RobotReady' }]);
    setSignalConnectorGatewayFeed(f.feed);
    const w = makeConnectorWorld();
    const c = w.connector('Coupler', { Mode: 'Copy', SourceBool: w.signal('RobotReady', 'PLCOutputBool'), TargetBool: w.signal('Rob_Ready', 'PLCInputBool') });
    expect(c.isActive).toBe(false);
    expect(codes()).toContain(SIGNAL_CONNECTOR_PROBLEM_CODES.cycle);
    w.dispose();
  });

  it('installing the feed after load re-checks; the last connector unsubscribes', async () => {
    const w = makeConnectorWorld();
    const c = w.connector('Coupler', { Mode: 'Copy', SourceBool: w.signal('RobotReady', 'PLCOutputBool'), TargetBool: w.signal('Rob_Ready', 'PLCInputBool') });
    expect(c.isActive).toBe(true);
    const f = fakeFeed([{ enabled: true, sourceSignal: 'GW', destSignal: 'Rob_Ready' }]);
    setSignalConnectorGatewayFeed(f.feed);
    await flush();
    expect(c.isActive).toBe(false);
    expect(f.listeners.size).toBe(1);
    w.dispose();
    expect(f.listeners.size).toBe(0);
  });
});
