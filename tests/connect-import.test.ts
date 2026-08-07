// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for connect-store.importTagTable() — the Update-vs-New push logic.
 * A new target calls addInterface (POST); an existing target calls
 * updateInterface (PUT) and replaces the same-named topic without duplicating.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  importTagTable,
  fetchInterfaces,
  _resetConnectStore,
  getConnectSnapshot,
  type ConnectInterface,
} from '../src/core/hmi/connect-store';
import type { S7Tag } from '../src/core/import/s7-tag-table';

// ── Helpers ────────────────────────────────────────────────────────────────

const TAGS: S7Tag[] = [
  { name: 'Motor_Start', dataType: 'Bool', address: '%I0.0', area: 'I' },
  { name: 'ActualTemp', dataType: 'Word', address: '%IW13', area: 'I' },
  { name: 'Pressure', dataType: 'Real', address: '%MD20', area: 'M' },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface FetchCall { url: string; method: string; body: unknown; }

/** Install a fetch stub that records POST/PUT/GET calls and returns canned data. */
function stubFetch(existingInterfaces: ConnectInterface[]): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url: urlStr, method, body });

    if (method === 'POST' && urlStr.endsWith('/config/interfaces')) {
      // Echo back the created interface with an id.
      return jsonResponse({ id: 'mqtt-new', signals: [], ...(body as object) });
    }
    if (method === 'PUT') {
      return jsonResponse({ ok: true });
    }
    if (method === 'GET' && urlStr.endsWith('/config/interfaces')) {
      return jsonResponse(existingInterfaces);
    }
    return jsonResponse({});
  }));
  return calls;
}

describe('connect-store.importTagTable', () => {
  beforeEach(() => {
    _resetConnectStore();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    _resetConnectStore();
  });

  it('newInterface: calls addInterface (POST) with a ProcessImage topic', async () => {
    const calls = stubFetch([]);

    await importTagTable({
      tags: TAGS,
      brokerUrl: 'mqtt://broker:1883',
      topic: 'rv/plc/pi',
      targetInterfaceId: null,
    });

    const post = calls.find(c => c.method === 'POST');
    expect(post).toBeDefined();
    const body = post!.body as ConnectInterface;
    expect(body.type).toBe('MQTT');
    expect(body.brokerUrl).toBe('mqtt://broker:1883');
    expect(body.topics).toHaveLength(1);
    expect(body.topics![0].topic).toBe('rv/plc/pi');
    expect(body.topics![0].mode).toBe('ProcessImage');
    expect(body.topics![0].signals).toHaveLength(3);
    // Wire types derived direction-aware from the Siemens area: I/E → PLCInput
    // (viewer writes), Q/A/M/unknown → PLCOutput (viewer reads, default in doubt).
    const sigByName = Object.fromEntries(body.topics![0].signals!.map(s => [s.name, s.type]));
    expect(sigByName['Motor_Start']).toBe('PLCInputBool');   // %I0.0 — input area
    expect(sigByName['ActualTemp']).toBe('PLCInputInt');     // %IW13 — input area
    expect(sigByName['Pressure']).toBe('PLCOutputFloat');    // %MD20 — Merker → default output

    // No PUT was issued.
    expect(calls.some(c => c.method === 'PUT')).toBe(false);
  });

  it('existingInterface: calls updateInterface (PUT) and replaces the same-named topic', async () => {
    const existing: ConnectInterface = {
      id: 'mqtt-line1',
      type: 'MQTT',
      enabled: true,
      brokerUrl: 'mqtt://broker:1883',
      topics: [
        { topic: 'rv/plc/pi', mode: 'ProcessImage', signals: [{ protocolAddress: '%I0.0', name: 'Old', type: 'PLCInputBool', record: false }] },
        { topic: 'rv/other', mode: 'Single', signals: [] },
      ],
      signals: [],
    };

    // Seed the store with the existing interface.
    stubFetch([existing]);
    await fetchInterfaces();
    expect(getConnectSnapshot().interfaces).toHaveLength(1);

    const calls = stubFetch([existing]);

    await importTagTable({
      tags: TAGS,
      brokerUrl: 'mqtt://broker:1883',
      topic: 'rv/plc/pi',
      targetInterfaceId: 'mqtt-line1',
    });

    const put = calls.find(c => c.method === 'PUT');
    expect(put).toBeDefined();
    expect(put!.url).toContain('/config/interfaces/mqtt-line1');
    const body = put!.body as Partial<ConnectInterface>;
    // Same-named topic replaced, other topic preserved → still 2 topics (no duplicate).
    expect(body.topics).toHaveLength(2);
    const piTopic = body.topics!.find(t => t.topic === 'rv/plc/pi');
    expect(piTopic).toBeDefined();
    expect(piTopic!.signals).toHaveLength(3);
    // The old single-signal topic content was replaced (not appended).
    expect(piTopic!.signals!.some(s => s.name === 'Old')).toBe(false);
    // The unrelated topic survived.
    expect(body.topics!.some(t => t.topic === 'rv/other')).toBe(true);

    // No POST was issued.
    expect(calls.some(c => c.method === 'POST')).toBe(false);
  });
});
