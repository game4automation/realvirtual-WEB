// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-457 §9.3b (store half) — `importSewSymbolTable` and `updateMqttTopic`.
 *
 * Two things must reach the gateway intact, because CONNECT has no defaults of
 * its own for them: every Json topic carries its `encoding`, and the publish
 * topic carries its `publishIntervalMs`. The second test is the round-trip: a
 * mode/encoding/interval edit made in the topic editor comes back out of
 * `PUT /config/interfaces/{id}` unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  importSewSymbolTable,
  updateMqttTopic,
  fetchInterfaces,
  getConnectSnapshot,
  _resetConnectStore,
  type ConnectInterface,
} from '../src/core/hmi/connect-store';
import { parseSewSymbolTable } from '../src/core/import/sew-symbol-table';

const ROWS = parseSewSymbolTable([
  'Name;Type;Direction',
  'Speed;INT;PLC_OUT',
  'Temperature;REAL;PLC_OUT',
  'Enable;BOOL;PLC_IN',
].join('\n')).rows;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface FetchCall { url: string; method: string; body: unknown; }

/** Fetch stub recording POST/PUT/GET, modelled on connect-import.test.ts. */
function stubFetch(existingInterfaces: ConnectInterface[]): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url: urlStr, method, body });

    if (method === 'POST' && urlStr.endsWith('/config/interfaces')) {
      return jsonResponse({ id: 'mqtt-new', signals: [], ...(body as object) });
    }
    if (method === 'PUT') return jsonResponse({ ok: true });
    if (method === 'GET' && urlStr.endsWith('/config/interfaces')) {
      return jsonResponse(existingInterfaces);
    }
    return jsonResponse({});
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

describe('connect-store.importSewSymbolTable', () => {
  it('builds two Json topics with encoding/publishIntervalMs and posts them', async () => {
    const calls = stubFetch([]);

    await importSewSymbolTable({
      rows: ROWS,
      brokerUrl: 'mqtt://broker:1883',
      targetInterfaceId: null,
    });

    const post = calls.find(c => c.method === 'POST');
    expect(post).toBeDefined();
    const body = post!.body as ConnectInterface;
    expect(body.type).toBe('MQTT');
    expect(body.topics).toHaveLength(2);

    const receive = body.topics!.find(t => t.topic === 'SEW/SimOUT')!;
    expect(receive.mode).toBe('Json');
    expect(receive.encoding).toBe('Auto');
    expect(receive.retained).toBe(false);
    expect(receive.signals!.map(s => s.type)).toEqual(['PLCOutputInt', 'PLCOutputFloat']);

    const publish = body.topics!.find(t => t.topic === 'SEW/SimIN')!;
    expect(publish.mode).toBe('Json');
    expect(publish.encoding).toBe('WString');
    expect(publish.publishIntervalMs).toBe(100);
    expect(publish.signals!.map(s => s.type)).toEqual(['PLCInputBool']);
  });

  it('replaces same-named topics on an existing interface without duplicating', async () => {
    const existing: ConnectInterface = {
      id: 'mqtt-sew',
      type: 'MQTT',
      enabled: true,
      brokerUrl: 'mqtt://broker:1883',
      topics: [
        { topic: 'SEW/SimOUT', mode: 'Json', encoding: 'Utf8', signals: [] },
        { topic: 'rv/other', mode: 'Single', signals: [] },
      ],
      signals: [],
    };
    stubFetch([existing]);
    await fetchInterfaces();
    expect(getConnectSnapshot().interfaces).toHaveLength(1);

    const calls = stubFetch([existing]);
    await importSewSymbolTable({
      rows: ROWS,
      brokerUrl: 'mqtt://broker:1883',
      targetInterfaceId: 'mqtt-sew',
      publishIntervalMs: 50,
    });

    const put = calls.find(c => c.method === 'PUT');
    expect(put).toBeDefined();
    const body = put!.body as Partial<ConnectInterface>;
    // SimOUT replaced in place, SimIN appended, the unrelated topic untouched.
    expect(body.topics!.map(t => t.topic)).toEqual(['SEW/SimOUT', 'rv/other', 'SEW/SimIN']);
    expect(body.topics!.find(t => t.topic === 'SEW/SimOUT')!.encoding).toBe('Auto');
    expect(body.topics!.find(t => t.topic === 'SEW/SimIN')!.publishIntervalMs).toBe(50);
    expect(calls.some(c => c.method === 'POST')).toBe(false);
  });
});

describe('connect-store.updateMqttTopic', () => {
  it('round-trips topic mode/encoding/interval edits through the CONNECT config API', async () => {
    const existing: ConnectInterface = {
      id: 'mqtt-sew',
      type: 'MQTT',
      enabled: true,
      brokerUrl: 'mqtt://broker:1883',
      topics: [
        { topic: 'SEW/SimIN', mode: 'Single', signals: [{ protocolAddress: '', name: 'Enable', type: 'PLCInputBool', record: false }] },
        { topic: 'rv/other', mode: 'ProcessImage', signals: [] },
      ],
      signals: [],
    };
    stubFetch([existing]);
    await fetchInterfaces();

    const calls = stubFetch([existing]);
    await updateMqttTopic('mqtt-sew', 'SEW/SimIN', {
      mode: 'Json',
      encoding: 'WString',
      publishIntervalMs: 250,
    });

    const put = calls.find(c => c.method === 'PUT');
    expect(put!.url).toContain('/config/interfaces/mqtt-sew');
    const body = put!.body as Partial<ConnectInterface>;
    const edited = body.topics!.find(t => t.topic === 'SEW/SimIN')!;
    expect(edited.mode).toBe('Json');
    expect(edited.encoding).toBe('WString');
    expect(edited.publishIntervalMs).toBe(250);
    // The signals of the topic are untouched by a transport-settings edit.
    expect(edited.signals).toHaveLength(1);
    // Other topics are carried over verbatim.
    expect(body.topics!.find(t => t.topic === 'rv/other')!.mode).toBe('ProcessImage');
  });
});
