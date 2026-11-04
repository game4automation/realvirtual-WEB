// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2024 P1 F2a: the real loaders against a mocked HTTP layer. A 500 is transient (retry, the
 * last valid cache stays, the revision stays open); only a 404 of the bridge endpoint means
 * `unsupported`; a later success sets the revision.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  connectToServer,
  getConnectBridges,
  getConnectSnapshot,
  getConnectConfigAppliedRevision,
  fetchBridgesResult,
  fetchInterfacesResult,
  handleConnectConfigPush,
  reloadConnectBridges,
  _setConfigRetryDelaysForTest,
  _resetConnectStore,
} from '../src/core/hmi/connect-store';
import { installConfigGateway, type FakeConfigGateway } from './helpers/connect-config-gateway';

let gw: FakeConfigGateway;

beforeEach(async () => {
  _resetConnectStore();
  vi.restoreAllMocks();
  _setConfigRetryDelaysForTest([5, 5, 5]);
  gw = installConfigGateway();
  gw.mappings = [{ enabled: true, sourceSignal: 'A', destSignal: 'B' }];
  await connectToServer();
  await reloadConnectBridges();
});
afterEach(() => {
  _setConfigRetryDelaysForTest(null);
  _resetConnectStore();
});

describe('loader result variants', () => {
  it('classify 500 as transient-error and 404 as unsupported', async () => {
    gw.fail('/config/interfaces', 500, 1);
    expect((await fetchInterfacesResult()).kind).toBe('transient-error');
    expect((await fetchInterfacesResult()).kind).toBe('ok');

    gw.fail('/config/mirrors', 404, 1);
    expect((await fetchBridgesResult()).kind).toBe('unsupported');
    gw.fail('/config/mappings', 503, 1);
    expect((await fetchBridgesResult()).kind).toBe('transient-error');
  });
});

describe('refresh after errors', () => {
  it('500 keeps the cache and the revision open; the retry then succeeds', async () => {
    expect(getConnectBridges().mappings).toHaveLength(1);
    gw.fail('/config/mappings', 500, 2);
    gw.mappings = [{ enabled: true, sourceSignal: 'A', destSignal: 'B' }, { enabled: true, sourceSignal: 'C', destSignal: 'D' }];

    handleConnectConfigPush({ instance: 'g', revision: 7 });
    await vi.waitFor(() => expect(gw.calls['/config/mappings']).toBeGreaterThanOrEqual(2));

    // the failed rounds changed nothing: old cache, revision still open, bridges still supported
    expect(getConnectConfigAppliedRevision()).toBe(-1);
    expect(getConnectBridges().supported).toBe(true);

    await vi.waitFor(() => expect(getConnectConfigAppliedRevision()).toBe(7));
    expect(getConnectBridges().mappings).toHaveLength(2);
  });

  it('404 of the bridge endpoint ends as unsupported, then a gateway that serves it again recovers', async () => {
    gw.fail('/config/mirrors', 404, 1);
    handleConnectConfigPush({ instance: 'g', revision: 1 });
    await vi.waitFor(() => expect(getConnectConfigAppliedRevision()).toBe(1));
    expect(getConnectBridges().supported).toBe(false);
    expect(getConnectSnapshot().interfaces.length).toBeGreaterThan(0); // interfaces still applied

    handleConnectConfigPush({ instance: 'g', revision: 2 });
    await vi.waitFor(() => expect(getConnectConfigAppliedRevision()).toBe(2));
    expect(getConnectBridges().supported).toBe(true);
  });

  it('existing callers keep their behaviour: reloadConnectBridges still treats an error as unsupported', async () => {
    gw.fail('/config/mirrors', 500, 1);
    await reloadConnectBridges();
    expect(getConnectBridges().supported).toBe(false);
  });
});
