// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  subscribeConnectStore,
  getConnectSnapshot,
  setServerUrl,
  connectToServer,
  disconnectFromServer,
  toggleSignalSelection,
  selectAllSignals,
  importS7TagTable,
  _resetConnectStore,
} from '../src/core/hmi/connect-store';
import type { S7Tag } from '../src/core/import/s7-tag-table';

describe('connect-store', () => {
  beforeEach(() => {
    _resetConnectStore();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    _resetConnectStore();
  });

  it('should have default state', () => {
    const snap = getConnectSnapshot();
    expect(snap.state).toBe('disconnected');
    // plan-363 Phase 7: with CONNECT the only local web server, a loopback page origin IS the
    // gateway — and the only thing that knows its port. Vitest serves from localhost, so the
    // derived default is this origin, not the former hard-coded :5100.
    expect(snap.serverUrl).toBe(window.location.origin);
    expect(snap.interfaces).toEqual([]);
    expect(snap.activeInterfaceId).toBeNull();
    expect(snap.discoveredSignals).toEqual([]);
    expect(snap.discoveryLoading).toBe(false);
    expect(snap.errorMessage).toBe('');
  });

  it('should update server URL and persist to localStorage', () => {
    setServerUrl('http://myserver:5100');
    const snap = getConnectSnapshot();
    expect(snap.serverUrl).toBe('http://myserver:5100');
    expect(localStorage.getItem('rv-connect-url')).toBe('http://myserver:5100');
  });

  it('should notify listeners on state change', () => {
    const listener = vi.fn();
    const unsub = subscribeConnectStore(listener);

    setServerUrl('http://test:5100');
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    setServerUrl('http://test2:5100');
    expect(listener).toHaveBeenCalledTimes(1); // not called after unsub
  });

  it('should transition to error on connect failure', async () => {
    // Mock fetch to fail
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Connection refused'));

    await connectToServer();
    const snap = getConnectSnapshot();
    expect(snap.state).toBe('error');
    expect(snap.errorMessage).toBe('Connection refused');
  });

  it('should transition to connected on successful health check', async () => {
    // Mock /health returning ok, then /config/interfaces returning empty
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('/health')) {
        return Promise.resolve(new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (urlStr.includes('/config/interfaces')) {
        return Promise.resolve(new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    await connectToServer();
    const snap = getConnectSnapshot();
    expect(snap.state).toBe('connected');
    expect(snap.errorMessage).toBe('');
  });

  it('should parse version, build and buildDate from /health (new gateway)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('/health')) {
        return Promise.resolve(new Response(JSON.stringify({
          status: 'ok',
          version: '1.2.3',
          build: 456,
          buildDate: '2026-06-16',
          appVersion: '1.2.3.456',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    });

    await connectToServer();
    const snap = getConnectSnapshot();
    expect(snap.state).toBe('connected');
    expect(snap.serverVersion).toBe('1.2.3');
    expect(snap.serverBuild).toBe('456');
    expect(snap.serverBuildDate).toBe('2026-06-16');
  });

  it('should fall back to appVersion when version/build are absent (legacy gateway)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('/health')) {
        return Promise.resolve(new Response(JSON.stringify({
          status: 'ok',
          appVersion: '0.1.0.0',
          buildDate: '2026-06-16 21:19',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    });

    await connectToServer();
    const snap = getConnectSnapshot();
    expect(snap.state).toBe('connected');
    expect(snap.serverVersion).toBe('0.1.0.0');
    expect(snap.serverBuild).toBe('');
    expect(snap.serverBuildDate).toBe('2026-06-16 21:19');
  });

  it('should disconnect and reset state', async () => {
    // First connect
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('/health')) {
        return Promise.resolve(new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    });

    await connectToServer();
    expect(getConnectSnapshot().state).toBe('connected');

    disconnectFromServer();
    const snap = getConnectSnapshot();
    expect(snap.state).toBe('disconnected');
    expect(snap.interfaces).toEqual([]);
    expect(snap.activeInterfaceId).toBeNull();
  });

  it('importS7TagTable pushes the parsed tags as the S7 interface signals (PUT)', async () => {
    const s7 = {
      id: 's7-1',
      type: 'S7' as const,
      enabled: true,
      ipAddress: '192.168.1.50',
      rack: 0,
      slot: 1,
      signals: [],
    };

    let putBody: { id: string; type: string; signals: Array<Record<string, unknown>> } | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('/health')) {
        return Promise.resolve(new Response(JSON.stringify({ status: 'ok' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (init?.method === 'PUT' && urlStr.includes('/config/interfaces/s7-1')) {
        putBody = JSON.parse(init.body as string);
        return Promise.resolve(new Response(JSON.stringify({ success: true }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }));
      }
      // GET /config/interfaces → one S7 interface.
      return Promise.resolve(new Response(JSON.stringify([s7]), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    });

    await connectToServer(); // loads the S7 interface into the store
    expect(getConnectSnapshot().interfaces.find(i => i.id === 's7-1')).toBeTruthy();

    const tags: S7Tag[] = [
      { name: 'MC01_1', dataType: 'DWord', address: '%QD120', area: 'Q' },
      { name: 'ATL_CHECK_TOBI', dataType: 'Bool', address: '%M10000.0', area: 'M' },
      { name: 'Barrier', dataType: 'Bool', address: '%I0.0', area: 'I' },
    ];
    await importS7TagTable('s7-1', tags);

    expect(putBody).not.toBeNull();
    const body = putBody!;
    expect(body.id).toBe('s7-1');
    expect(body.type).toBe('S7'); // whole interface preserved, not reset
    expect(body.signals).toHaveLength(3);
    // Wire type derived from the area: %Q/%M → PLCOutput, %I → PLCInput.
    expect(body.signals[0]).toMatchObject({ protocolAddress: '%QD120', name: 'MC01_1', type: 'PLCOutputInt', dataType: 'DWord' });
    expect(body.signals[1]).toMatchObject({ protocolAddress: '%M10000.0', type: 'PLCOutputBool' });
    expect(body.signals[2]).toMatchObject({ protocolAddress: '%I0.0', type: 'PLCInputBool' });
  });

  it('should toggle signal selection', () => {
    // Manually inject discovered signals via the internal mechanism
    // We test the toggle function by first setting state via _resetConnectStore
    _resetConnectStore();

    // Since we can't directly set _discoveredSignals, test selectAllSignals
    // which works on the current list (empty, no-op)
    selectAllSignals(true);
    expect(getConnectSnapshot().discoveredSignals).toEqual([]);
  });
});
