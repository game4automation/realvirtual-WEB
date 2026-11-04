// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetConnectStore,
  fetchInterfaces,
  getConnectSnapshot,
  importSewUdpSymbolTable,
  type ConnectInterface,
} from '../src/core/hmi/connect-store';
import { buildUdpSignalsFromSewRows, parseSewSymbolTable } from '../src/core/import/sew-symbol-table';

const SIGNALS = buildUdpSignalsFromSewRows(parseSewSymbolTable([
  'Name;Type;Direction',
  'Speed;REAL;PLC_IN',
  'Running;BOOL;PLC_OUT',
].join('\n'))).signals;

function existingUdp(id = 'udp-custom'): ConnectInterface {
  return {
    id,
    type: 'Udp',
    enabled: true,
    allowWebToPlc: false,
    updateCycleMs: 75,
    udp: {
      localPort: 12345,
      localBindAddress: '127.0.0.2',
      remoteHost: '192.168.1.23',
      remotePort: 12346,
      littleEndian: false,
      symbolTable: 'custom.csv',
      splitChar: ',',
    },
    description: 'Custom station',
    signals: [{ name: 'Old', protocolAddress: '22:BOOL', type: 'PLCOutputBool', record: true }],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Stateful gateway stub: GET returns the last successfully written configuration. */
function stubGateway(initial: ConnectInterface[], failure?: { status: number; body: unknown }) {
  let interfaces = structuredClone(initial);
  const calls: { path: string; method: string; body: ConnectInterface | undefined }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = new URL(url.toString()).pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) as ConnectInterface : undefined;
    calls.push({ path, method, body });
    if (path === '/config/interfaces' && method === 'GET') return jsonResponse(interfaces);
    if (path.startsWith('/config/interfaces') && (method === 'PUT' || method === 'POST')) {
      if (failure) return jsonResponse(failure.body, failure.status);
      if (method === 'POST') interfaces.push(body!);
      else interfaces = interfaces.map(i => i.id === body!.id ? body! : i);
      return jsonResponse(method === 'POST' ? body : { ok: true });
    }
    return jsonResponse({}, 404);
  }));
  return calls;
}

beforeEach(() => {
  _resetConnectStore();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  _resetConnectStore();
});

describe('connect-store.importSewUdpSymbolTable', () => {
  it('PUT replaces all signals and preserves every other interface field', async () => {
    const existing = existingUdp();
    const calls = stubGateway([existing]);
    await fetchInterfaces();
    const before = structuredClone(getConnectSnapshot().interfaces[0]);

    await importSewUdpSymbolTable({ signals: SIGNALS, targetInterfaceId: existing.id, allowWebToPlc: true });

    expect(calls.filter(c => c.method === 'PUT')).toEqual([{
      path: '/config/interfaces/udp-custom', method: 'PUT', body: { ...before, signals: SIGNALS },
    }]);
    expect(getConnectSnapshot().interfaces[0]).toEqual({ ...before, signals: SIGNALS });
    expect(calls.some(c => c.method === 'POST')).toBe(false);
    expect(existing.signals[0].name).toBe('Old');
  });

  it('re-imports changed addresses idempotently without retaining removed signals', async () => {
    const calls = stubGateway([existingUdp()]);
    await fetchInterfaces();
    await importSewUdpSymbolTable({ signals: SIGNALS, targetInterfaceId: 'udp-custom', allowWebToPlc: false });
    const changed = [{ ...SIGNALS[0], protocolAddress: '5:REAL' }];
    const params = { signals: changed, targetInterfaceId: 'udp-custom', allowWebToPlc: true };
    await importSewUdpSymbolTable(params);
    await importSewUdpSymbolTable(params);

    const puts = calls.filter(c => c.method === 'PUT');
    expect(puts).toHaveLength(3);
    expect(puts[1].body).toEqual(puts[2].body);
    expect(getConnectSnapshot().interfaces[0].signals).toEqual(changed);
    expect(getConnectSnapshot().interfaces[0].udp).toEqual(existingUdp().udp);
    expect(getConnectSnapshot().interfaces).toHaveLength(1);
  });

  it.each([true, false])('POST creates a disabled sew-udp-N with defaults and allowWebToPlc=%s', async allowWebToPlc => {
    const calls = stubGateway([existingUdp('sew-udp-1'), existingUdp('sew-udp-2')]);
    await fetchInterfaces();
    await importSewUdpSymbolTable({ signals: SIGNALS, targetInterfaceId: null, allowWebToPlc });

    const expected = {
      id: 'sew-udp-3',
      type: 'Udp',
      enabled: false,
      udp: {
        localPort: 11001, localBindAddress: '0.0.0.0', remoteHost: '127.0.0.1', remotePort: 11000,
        littleEndian: true, symbolTable: '', splitChar: ';',
      },
      updateCycleMs: 20,
      allowWebToPlc,
      signals: SIGNALS,
    };
    expect(calls.filter(c => c.method === 'POST')).toEqual([{
      path: '/config/interfaces', method: 'POST', body: expected,
    }]);
    expect(getConnectSnapshot().interfaces.find(i => i.id === 'sew-udp-3')).toEqual(expected);
    // A second creation must use the newly added interface in the local snapshot.
    await importSewUdpSymbolTable({ signals: SIGNALS, targetInterfaceId: null, allowWebToPlc });
    expect(calls.filter(c => c.method === 'POST')[1].body!.id).toBe('sew-udp-4');
  });

  it.each(['udp-custom', null])('throws the gateway 409 collision text for target %s', async targetInterfaceId => {
    const calls = stubGateway([existingUdp()], {
      status: 409,
      body: { error: 'Signal names must be unique', collisions: [{ signal: 'Speed', existingInterfaceId: 'other-plc' }] },
    });
    await fetchInterfaces();
    await expect(importSewUdpSymbolTable({ signals: SIGNALS, targetInterfaceId, allowWebToPlc: true }))
      .rejects.toThrow("Signal names must be unique: 'Speed' (already bound to interface 'other-plc')");
    expect(calls.filter(c => c.method !== 'GET')).toHaveLength(1);
    expect(getConnectSnapshot().interfaces[0].signals[0].name).toBe('Old');
  });

  it.each([
    { error: 'Gateway signal limit exceeded: maximum 100 signals' },
    { error: 'SIGNAL_LIMIT_REACHED', limit: 100, inUse: 100 },
    { message: 'The gateway cannot admit these signals' },
  ])('preserves gateway error text without changing the stored interface: %j', async body => {
    stubGateway([existingUdp()], { status: 400, body });
    await fetchInterfaces();
    await expect(importSewUdpSymbolTable({ signals: SIGNALS, targetInterfaceId: 'udp-custom', allowWebToPlc: true }))
      .rejects.toThrow(body.error ?? body.message!);
    expect(getConnectSnapshot().interfaces[0].signals[0].name).toBe('Old');
  });

  it('preserves a plain-text gateway error', async () => {
    stubGateway([existingUdp()]);
    await fetchInterfaces();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Gateway signal limit reached', { status: 400 })));
    await expect(importSewUdpSymbolTable({ signals: SIGNALS, targetInterfaceId: 'udp-custom', allowWebToPlc: true }))
      .rejects.toThrow('Gateway signal limit reached');
  });

  it('refuses a missing or non-UDP target without creating an interface', async () => {
    const calls = stubGateway([{ ...existingUdp('mqtt'), type: 'MQTT' }]);
    await fetchInterfaces();
    await expect(importSewUdpSymbolTable({ signals: SIGNALS, targetInterfaceId: 'missing', allowWebToPlc: true }))
      .rejects.toThrow('Unknown interface "missing"');
    await expect(importSewUdpSymbolTable({ signals: SIGNALS, targetInterfaceId: 'mqtt', allowWebToPlc: true }))
      .rejects.toThrow('Interface "mqtt" is not Udp');
    expect(calls.every(c => c.method === 'GET')).toBe(true);
  });
});
