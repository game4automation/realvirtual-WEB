// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import mainSource from '../src/main.ts?raw';
import connectStoreSource from '../src/core/hmi/connect-store.ts?raw';
import {
  HistorianTrendPlugin,
  historianStatusAllowsPlugin,
} from '../src/plugins/historian-trend-plugin';
import {
  _resetConnectStore,
  fetchInterfaces,
  setServerUrl,
  updateInterface,
  type ConnectInterface,
} from '../src/core/hmi/connect-store';

const iface: ConnectInterface = {
  id: 's7-main',
  type: 'S7',
  enabled: true,
  signals: [{ protocolAddress: 'DB1.DBD0', name: 'Speed', type: 'PLCOutputFloat', record: false }],
};

describe('historian trend plugin', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetConnectStore();
    setServerUrl('http://connect.test:5100');
  });

  afterEach(() => vi.restoreAllMocks());

  it('registers a button-group slot', () => {
    const plugin = new HistorianTrendPlugin();
    expect(plugin.id).toBe('historian-trend');
    expect(plugin.slots).toHaveLength(1);
    expect(plugin.slots[0].slot).toBe('button-group');
  });

  it('is registered in the main viewer plugin chain', () => {
    expect(mainSource).toContain("import { HistorianTrendPlugin } from './plugins/historian-trend-plugin'");
    expect(mainSource).toContain(".use(new HistorianTrendPlugin(), 'core')");
  });

  it('gates visibility on enabled and connected historian status', () => {
    const base = {
      bucket: 'line_raw', lastWriteUtc: null, droppedPoints: 0, authError: false, disabledReason: null,
    };
    expect(historianStatusAllowsPlugin({ ...base, enabled: true, connected: true })).toBe(true);
    expect(historianStatusAllowsPlugin({ ...base, enabled: true, connected: false })).toBe(false);
    expect(historianStatusAllowsPlugin({ ...base, enabled: false, connected: true })).toBe(false);
    expect(historianStatusAllowsPlugin(null)).toBe(false);
  });

  it('record toggle updateInterface sends X-API-Key when configured', async () => {
    localStorage.setItem('rv-interface-settings', JSON.stringify({ wsAuthToken: 'configured-key' }));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (init?.method === 'PUT') {
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify([iface]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    await fetchInterfaces();
    await updateInterface(iface.id, { signals: [{ ...iface.signals[0], record: true }] });

    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(putCall).toBeDefined();
    expect(new Headers(putCall?.[1]?.headers).get('X-API-Key')).toBe('configured-key');
    expect(String(putCall?.[1]?.body)).toContain('"record":true');
  });

  it('keeps flat and ProcessImage record patches on separate interface fields', () => {
    // The two hand-written call sites in ConnectPanel collapsed into ONE helper,
    // `_signalContainerPatch` in connect-store: a patch without a topic goes to
    // the flat `signals` field, a patch for an MQTT topic rewrites `topics` and
    // touches that topic's own `signals` list. The separation is what matters —
    // CONNECT replaces the whole field, so a patch that mixed them would delete
    // the other container's signals. Pinned where the branch now lives.
    expect(connectStoreSource).toContain('if (topic === undefined) return { signals: edit([...(iface.signals ?? [])]) };');
    expect(connectStoreSource).toContain('topics: topics.map(t => (t.topic === topic ? { ...t, signals: edit([...(t.signals ?? [])]) } : t)),');
  });
});
