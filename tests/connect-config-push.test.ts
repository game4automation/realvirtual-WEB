// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2024 P1 F2: a `config` push from CONNECT makes this tab reload interfaces and the bridge
 * cache (mirrors + mappings) without a page reload - once per revision, one refresh at a time,
 * with the old answer never overwriting the new one.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  connectToServer,
  getConnectSnapshot,
  getConnectBridges,
  getConnectConfigAppliedRevision,
  getConnectConfigRefreshCount,
  handleConnectConfigPush,
  _setConfigRetryDelaysForTest,
  _resetConnectStore,
} from '../src/core/hmi/connect-store';
import { installConfigGateway, type FakeConfigGateway } from './helpers/connect-config-gateway';

let gw: FakeConfigGateway;

const settled = () => vi.waitFor(() => {
  expect(getConnectConfigRefreshCount()).toBeGreaterThan(0);
});

beforeEach(async () => {
  _resetConnectStore();
  vi.restoreAllMocks();
  _setConfigRetryDelaysForTest([5, 5, 5]);
  gw = installConfigGateway();
  await connectToServer();
  expect(getConnectSnapshot().state).toBe('connected');
});
afterEach(() => {
  _setConfigRetryDelaysForTest(null);
  _resetConnectStore();
});

describe('config push -> refreshConfig', () => {
  it('reloads once on a push and refreshes interfaces, mappings and mirrors', async () => {
    gw.interfaces = [{ id: 'i1', type: 'S7', enabled: true, signals: [] }, { id: 'i2', type: 'Mqtt', enabled: true, signals: [] }];
    gw.mappings = [{ enabled: true, sourceSignal: 'A', destSignal: 'B' }];
    gw.mirrors = [{ id: 'm1', enabled: true }];
    const before = gw.calls['/config/interfaces'];

    expect(handleConnectConfigPush({ instance: 'g1', revision: 1 })).toBe(true);
    await settled();

    expect(gw.calls['/config/interfaces']).toBe(before + 1);
    expect(getConnectSnapshot().interfaces.map((i) => i.id)).toEqual(['i1', 'i2']);
    expect(getConnectBridges().mappings).toHaveLength(1);
    expect(getConnectBridges().mirrors).toHaveLength(1);
    expect(getConnectConfigAppliedRevision()).toBe(1);
  });

  it('ignores the same revision of a known instance', async () => {
    handleConnectConfigPush({ instance: 'g1', revision: 3 });
    await settled();
    const calls = gw.calls['/config/interfaces'];

    expect(handleConnectConfigPush({ instance: 'g1', revision: 3 })).toBe(false);
    expect(handleConnectConfigPush({ instance: 'g1', revision: 2 })).toBe(false);
    await new Promise((r) => setTimeout(r, 30));

    expect(gw.calls['/config/interfaces']).toBe(calls);
  });

  it('a new instance reloads even with a lower revision', async () => {
    handleConnectConfigPush({ instance: 'g1', revision: 9 });
    await settled();
    const count = getConnectConfigRefreshCount();

    expect(handleConnectConfigPush({ instance: 'g2', revision: 1 })).toBe(true);
    await vi.waitFor(() => expect(getConnectConfigRefreshCount()).toBe(count + 1));
    expect(getConnectConfigAppliedRevision()).toBe(1);
  });

  it('overlapping pushes are serialised into one follow-up; the old answer never overwrites the new', async () => {
    const release = gw.hold('/config/interfaces');
    gw.interfaces = [{ id: 'old', type: 'S7', enabled: true, signals: [] }];
    const start = gw.calls['/config/interfaces'];
    handleConnectConfigPush({ instance: 'g1', revision: 1 });
    await vi.waitFor(() => expect(gw.calls['/config/interfaces']).toBe(start + 1));

    // two more pushes while the first load is still in flight
    handleConnectConfigPush({ instance: 'g1', revision: 2 });
    handleConnectConfigPush({ instance: 'g1', revision: 3 });
    expect(gw.calls['/config/interfaces']).toBe(start + 1); // still serialised: no second request

    gw.interfaces = [{ id: 'new', type: 'S7', enabled: true, signals: [] }];
    release();
    await vi.waitFor(() => expect(getConnectConfigAppliedRevision()).toBe(3));

    expect(gw.calls['/config/interfaces']).toBe(start + 2); // exactly one follow-up for two pushes
    expect(getConnectSnapshot().interfaces.map((i) => i.id)).toEqual(['new']);
  });

  it('an HTTP error retries, keeps the revision open and applies after success', async () => {
    gw.fail('/config/interfaces', 500, 2);
    gw.interfaces = [{ id: 'after', type: 'S7', enabled: true, signals: [] }];

    handleConnectConfigPush({ instance: 'g1', revision: 4 });
    await vi.waitFor(() => expect(gw.calls['/config/interfaces']).toBeGreaterThanOrEqual(2));
    expect(getConnectConfigAppliedRevision()).toBe(-1);

    await vi.waitFor(() => expect(getConnectConfigAppliedRevision()).toBe(4));
    expect(getConnectSnapshot().interfaces.map((i) => i.id)).toEqual(['after']);
  });

  it('ignores unknown or malformed frames', () => {
    expect(handleConnectConfigPush({})).toBe(false);
    expect(handleConnectConfigPush({ instance: 5, revision: 1 })).toBe(false);
    expect(handleConnectConfigPush({ instance: 'g', revision: Number.NaN })).toBe(false);
  });
});
