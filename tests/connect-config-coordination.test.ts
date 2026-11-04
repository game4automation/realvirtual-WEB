// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2024 P1 review follow-ups: the writers of the interface and bridge caches are coordinated.
 *
 * - holds: the newest snapshot is the hold; one equal to the cache drops the hold and its notice;
 *   a switch of the bridges to `unsupported` (404) is a change and is held too
 * - target: a gateway URL change invalidates a refresh still in flight
 * - order: an explicit loader and the push refresh never write an answer older than the cache
 * - reset: aborts the running request, clears the retry timer and never blocks the next refresh
 * - quiet: an unchanged configuration publishes nothing, a repeated hold no new notice
 * - contract: `fetchInterfaces()` still swallows (and logs) its error and leaves the store unchanged
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  applyHeldConnectConfig,
  connectToServer,
  disconnectFromServer,
  fetchInterfaces,
  getConnectBridges,
  getConnectConfigAppliedRevision,
  getConnectConfigNotice,
  getConnectConfigRefreshCount,
  getConnectSnapshot,
  handleConnectConfigPush,
  holdConnectConfigEditing,
  reloadConnectBridges,
  setServerUrl,
  subscribeConnectBridges,
  subscribeConnectConfigNotice,
  subscribeConnectStore,
  _setConfigRetryDelaysForTest,
  _resetConnectStore,
} from '../src/core/hmi/connect-store';
import { installConfigGateway, type FakeConfigGateway } from './helpers/connect-config-gateway';

let gw: FakeConfigGateway;
const S7 = (id: string) => ({ id, type: 'S7', enabled: true, signals: [] });
const ids = () => getConnectSnapshot().interfaces.map((i) => i.id);

beforeEach(async () => {
  _resetConnectStore();
  vi.restoreAllMocks();
  _setConfigRetryDelaysForTest([5, 5, 5]);
  gw = installConfigGateway();
  gw.interfaces = [S7('A')];
  gw.mappings = [{ enabled: true, sourceSignal: 'X', destSignal: 'Y' }];
  await connectToServer();
  await reloadConnectBridges();
  expect(getConnectSnapshot().state).toBe('connected');
});
afterEach(() => {
  applyHeldConnectConfig();
  _setConfigRetryDelaysForTest(null);
  _resetConnectStore();
});

describe('holds (findings 1, 2, 8)', () => {
  it('A -> push B (held) -> push A: the hold and its notice are dropped, closing keeps A', async () => {
    const release = holdConnectConfigEditing();
    gw.interfaces = [S7('B')];
    handleConnectConfigPush({ instance: 'g', revision: 1 });
    await vi.waitFor(() => expect(getConnectConfigNotice().pending).toBe(true));
    expect(ids()).toEqual(['A']);

    gw.interfaces = [S7('A')];
    handleConnectConfigPush({ instance: 'g', revision: 2 });
    await vi.waitFor(() => expect(getConnectConfigAppliedRevision()).toBe(2));
    expect(getConnectConfigNotice().pending).toBe(false);

    release();
    expect(ids()).toEqual(['A']); // B never appears
  });

  it('the newest snapshot is the hold: A -> B -> C, closing shows C', async () => {
    const release = holdConnectConfigEditing();
    gw.interfaces = [S7('B')];
    handleConnectConfigPush({ instance: 'g', revision: 1 });
    await vi.waitFor(() => expect(getConnectConfigAppliedRevision()).toBe(1));
    gw.interfaces = [S7('C')];
    handleConnectConfigPush({ instance: 'g', revision: 2 });
    await vi.waitFor(() => expect(getConnectConfigAppliedRevision()).toBe(2));
    expect(ids()).toEqual(['A']);
    release();
    expect(ids()).toEqual(['C']);
  });

  it('bridges switching to unsupported (404) during an edit are detected and held, cache clearing included', async () => {
    expect(getConnectBridges().supported).toBe(true);
    const release = holdConnectConfigEditing();
    gw.fail('/config/mirrors', 404, 1);
    handleConnectConfigPush({ instance: 'g', revision: 1 });
    await vi.waitFor(() => expect(getConnectConfigAppliedRevision()).toBe(1));

    expect(getConnectConfigNotice().pending).toBe(true);
    expect(getConnectBridges().supported).toBe(true); // not cleared under the user's hands
    expect(getConnectBridges().mappings).toHaveLength(1);

    release();
    expect(getConnectBridges().supported).toBe(false);
    expect(getConnectBridges().mappings).toBeNull();
  });

  it('a repeated hold with the same change publishes the notice once', async () => {
    const release = holdConnectConfigEditing();
    let notices = 0;
    const off = subscribeConnectConfigNotice(() => { notices++; });
    gw.interfaces = [S7('B')];
    handleConnectConfigPush({ instance: 'g', revision: 1 });
    await vi.waitFor(() => expect(getConnectConfigAppliedRevision()).toBe(1));
    const first = getConnectConfigNotice();
    handleConnectConfigPush({ instance: 'g', revision: 2 });
    await vi.waitFor(() => expect(getConnectConfigAppliedRevision()).toBe(2));
    expect(notices).toBe(1);
    expect(getConnectConfigNotice()).toBe(first);
    off();
    release();
  });

  it('an unchanged configuration writes neither the store nor the bridge cache', async () => {
    let storeWrites = 0;
    let bridgeWrites = 0;
    const offStore = subscribeConnectStore(() => { storeWrites++; });
    const offBridges = subscribeConnectBridges(() => { bridgeWrites++; });
    const before = getConnectSnapshot().interfaces;
    handleConnectConfigPush({ instance: 'g', revision: 1 });
    await vi.waitFor(() => expect(getConnectConfigAppliedRevision()).toBe(1));
    expect(storeWrites).toBe(0);
    expect(bridgeWrites).toBe(0);
    expect(getConnectSnapshot().interfaces).toBe(before);
    offStore();
    offBridges();
  });
});

describe('gateway target (finding 3)', () => {
  it('a delayed answer of the old gateway writes nothing after setServerUrl', async () => {
    const releaseOld = gw.holdNext('/config/interfaces');
    const start = gw.calls['/config/interfaces'];
    handleConnectConfigPush({ instance: 'g', revision: 1 });
    await vi.waitFor(() => expect(gw.calls['/config/interfaces']).toBe(start + 1)); // old round in flight

    setServerUrl('http://other-gateway:5100');
    expect(getConnectSnapshot().state).toBe('connected');
    gw.interfaces = [S7('NEW')];
    expect(handleConnectConfigPush({ instance: 'h', revision: 1 })).toBe(true);
    await vi.waitFor(() => expect(ids()).toEqual(['NEW']));

    releaseOld([S7('OLD-GATEWAY')]); // the old gateway answers late, despite the abort
    await new Promise((r) => setTimeout(r, 30));
    expect(ids()).toEqual(['NEW']);
    expect(getConnectConfigAppliedRevision()).toBe(1);
  });
});

describe('explicit loaders and the push refresh share one write order (finding 4)', () => {
  it('fetchInterfaces started earlier cannot overwrite a newer push refresh', async () => {
    const releaseOld = gw.holdNext('/config/interfaces');
    const explicit = fetchInterfaces();
    gw.interfaces = [S7('NEW')];
    handleConnectConfigPush({ instance: 'g', revision: 1 });
    await vi.waitFor(() => expect(ids()).toEqual(['NEW']));

    releaseOld([S7('OLD')]);
    await explicit;
    expect(ids()).toEqual(['NEW']);
  });

  it('a push refresh started earlier cannot overwrite a newer reloadConnectBridges; the revision still settles', async () => {
    const releaseOld = gw.holdNext('/config/mappings');
    handleConnectConfigPush({ instance: 'g', revision: 1 });
    await vi.waitFor(() => expect(gw.calls['/config/mappings']).toBeGreaterThanOrEqual(2));

    gw.mappings = [{ enabled: true, sourceSignal: 'N1', destSignal: 'N2' }];
    await reloadConnectBridges();
    expect(getConnectBridges().mappings?.[0].sourceSignal).toBe('N1');

    releaseOld([{ enabled: true, sourceSignal: 'OLD', destSignal: 'OLD' }]);
    await vi.waitFor(() => expect(getConnectConfigAppliedRevision()).toBe(1));
    expect(getConnectBridges().mappings?.[0].sourceSignal).toBe('N1');
  });

  it('an explicit load during an open edit drops the held part it overtakes', async () => {
    const release = holdConnectConfigEditing();
    gw.interfaces = [S7('B')];
    handleConnectConfigPush({ instance: 'g', revision: 1 });
    await vi.waitFor(() => expect(getConnectConfigNotice().pending).toBe(true));

    gw.interfaces = [S7('C')];
    await fetchInterfaces(); // the dialog asked for the fresh list itself
    expect(ids()).toEqual(['C']);
    expect(getConnectConfigNotice().pending).toBe(false);

    release();
    expect(ids()).toEqual(['C']); // the overtaken hold B never lands
  });
});

describe('reset ends running work (finding 5)', () => {
  it('a hanging request is aborted on disconnect and does not block the refresh after reconnect', async () => {
    gw.holdNext('/config/interfaces', { abortable: true }); // never answered
    const from = gw.signals.length;
    handleConnectConfigPush({ instance: 'g', revision: 1 });
    await vi.waitFor(() => expect(gw.signals.length).toBeGreaterThan(from));
    const hanging = gw.signals[from]!;

    disconnectFromServer();
    expect(hanging.aborted).toBe(true);

    await connectToServer();
    gw.interfaces = [S7('AFTER')];
    expect(handleConnectConfigPush({ instance: 'g', revision: 1 })).toBe(true);
    await vi.waitFor(() => expect(getConnectConfigAppliedRevision()).toBe(1));
    expect(ids()).toEqual(['AFTER']);
  });

  it('a pending retry timer is cleared by the reset and fires no request afterwards', async () => {
    _setConfigRetryDelaysForTest([200]);
    gw.fail('/config/interfaces', 500, 1);
    handleConnectConfigPush({ instance: 'g', revision: 1 });
    await vi.waitFor(() => expect(gw.calls['/config/interfaces']).toBeGreaterThanOrEqual(2));

    disconnectFromServer();
    const callsAfterReset = gw.calls['/config/interfaces'];
    await connectToServer(); // one /config/interfaces of its own
    const callsAfterConnect = gw.calls['/config/interfaces'];
    expect(callsAfterConnect).toBe(callsAfterReset + 1);

    await new Promise((r) => setTimeout(r, 300)); // past the old retry delay
    expect(gw.calls['/config/interfaces']).toBe(callsAfterConnect);
    expect(getConnectConfigRefreshCount()).toBe(0);
  });
});

describe('fetchInterfaces error contract (F2a, unchanged)', () => {
  it('swallows and logs the error, leaving the store unchanged', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = getConnectSnapshot().interfaces;
    gw.fail('/config/interfaces', 500, 1);
    await expect(fetchInterfaces()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    expect(getConnectSnapshot().interfaces).toBe(before);
  });
});
