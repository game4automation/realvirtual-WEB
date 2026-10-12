// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** plan-545 Phase 2 — checkAutoMap / applyAutoMap against a mocked CONNECT gateway. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  applyAutoMap,
  checkAutoMap,
  fetchInterfaces,
  getConnectSnapshot,
  setServerUrl,
  _resetConnectStore,
  type ConnectInterface,
} from '../src/core/hmi/connect-store';
import type { ModelPlcSignal } from '../src/core/import/rv-plc-automap';

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
}));

interface Gateway {
  interfaces: ConnectInterface[];
  puts: Array<{ id: string; body: ConnectInterface }>;
  discoverCalls: number;
  putStatus?: number;
  putError?: unknown;
  discovered?: Array<{ name: string; displayName?: string; dataType?: string; direction?: string; browsePath?: string }>;
}

function mockGateway(gw: Gateway): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    const u = typeof url === 'string' ? url : url.toString();
    const method = init?.method ?? 'GET';
    if (method === 'PUT' && u.includes('/config/interfaces/')) {
      const id = decodeURIComponent(u.split('/config/interfaces/')[1]);
      const body = JSON.parse(init!.body as string) as ConnectInterface;
      gw.puts.push({ id, body });
      if (gw.putStatus && gw.putStatus >= 400) return json(gw.putError ?? { error: 'failed' }, gw.putStatus);
      gw.interfaces = gw.interfaces.map((i) => (i.id === id ? body : i));
      return json({ success: true });
    }
    if (u.includes('/config/interfaces')) return json(gw.interfaces);
    if (method === 'POST' && u.includes('/discover/')) {
      gw.discoverCalls++;
      return json({ signals: gw.discovered ?? [] });
    }
    return json({});
  });
}

const MODEL: ModelPlcSignal[] = [
  // plan-589: authored signals — the persisted `localName` equals the runtime name.
  { name: 'Start', localName: 'Start', type: 'PLCInputBool', comment: '%I0.0 · Start' },
  { name: 'Lamp', localName: 'Lamp', type: 'PLCOutputBool', comment: '%Q0.1 · Lamp' },
];

describe('PLC auto-map store actions', () => {
  beforeEach(() => {
    _resetConnectStore();
    vi.restoreAllMocks();
    setServerUrl('http://gw.test:5100');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    _resetConnectStore();
  });

  it('applyAutoMap sends ONE PUT with the merged signals and re-checks to mapped', async () => {
    const gw: Gateway = {
      interfaces: [{
        id: 's7-1', type: 'S7', enabled: false, ipAddress: '127.0.0.1', allowWebToPlc: false,
        signals: [{ name: 'Foreign', protocolAddress: '%M0.0', type: 'PLCOutputBool', record: false }],
      }],
      puts: [], discoverCalls: 0,
    };
    mockGateway(gw);
    await fetchInterfaces();

    const check = await checkAutoMap('s7-1', MODEL);
    expect(check.counts.mappable).toBe(2);
    expect(getConnectSnapshot().autoMapReport?.interfaceId).toBe('s7-1');

    const after = await applyAutoMap('s7-1', MODEL);
    expect(gw.puts).toHaveLength(1);
    const body = gw.puts[0].body;
    expect(body.allowWebToPlc).toBe(false); // never touched
    expect(body.signals.map((s) => s.name)).toEqual(['Foreign', 'Start', 'Lamp']);
    expect(body.signals[1]).toMatchObject({ protocolAddress: '%I0.0', type: 'PLCInputBool', dataType: 'Bool' });
    expect(after.counts.mapped).toBe(2);
    expect(after.counts['plc-only']).toBe(1);
    expect(getConnectSnapshot().autoMapBusy).toBe(false);

    // A second apply has nothing to write.
    await applyAutoMap('s7-1', MODEL);
    expect(gw.puts).toHaveLength(1);
  });

  it('checkAutoMap on PLCSIM runs the discovery and matches the quoted tag', async () => {
    const gw: Gateway = {
      interfaces: [{ id: 'sim-1', type: 'PlcSimAdvanced', enabled: true, allowWebToPlc: true,
        plcSimAdvanced: { instanceName: 'X', apiPathOverride: '', hmiTagsOnly: false, dataBlockFilter: '',
          regExImportSignals: [], regExSkipSignals: [], regExSymbolIsInput: [], ensureRunning: false },
        signals: [] }],
      puts: [], discoverCalls: 0,
      discovered: [
        { name: '"FG01_P_Camera".bEnable', browsePath: '"FG01_P_Camera".bEnable', direction: 'output', dataType: 'Bool' },
        { name: 'Recipe_Dummy', browsePath: 'Recipe_Dummy', direction: 'output', dataType: 'Int' },
      ],
    };
    mockGateway(gw);
    await fetchInterfaces();
    const model: ModelPlcSignal[] = [
      { name: 'FG01_P_Camera.bEnable', localName: 'FG01_P_Camera.bEnable', type: 'PLCOutputBool' },
      { name: 'Recipe.Step', localName: 'Recipe.Step', type: 'PLCOutputInt' },
    ];

    const r = await checkAutoMap('sim-1', model);
    expect(gw.discoverCalls).toBe(1);
    expect(r.categories.mappable[0]).toMatchObject({ name: 'FG01_P_Camera.bEnable', protocolAddress: '"FG01_P_Camera".bEnable' });
    expect(r.dataBlockFilter).toEqual(['Recipe']);

    // Apply: filter PUT first (merge), browse again, then the signals PUT.
    await applyAutoMap('sim-1', model);
    expect(gw.puts[0].body.plcSimAdvanced?.dataBlockFilter).toBe('Recipe');
    expect(gw.puts[gw.puts.length - 1].body.signals).toEqual([
      { name: 'FG01_P_Camera.bEnable', protocolAddress: '"FG01_P_Camera".bEnable', type: 'PLCOutputBool', dataType: 'Bool', record: false },
    ]);
    expect(gw.discoverCalls).toBeGreaterThanOrEqual(3);
  });

  it('a 409 on PUT becomes a report hint and leaves the store consistent', async () => {
    const gw: Gateway = {
      interfaces: [{ id: 's7-1', type: 'S7', enabled: false, signals: [] }],
      puts: [], discoverCalls: 0,
      putStatus: 409,
      putError: { error: 'Signal name collision', collisions: [{ signal: 'Start', existingInterfaceId: 'mqtt-1' }] },
    };
    mockGateway(gw);
    await fetchInterfaces();

    const r = await applyAutoMap('s7-1', MODEL);
    expect(gw.puts).toHaveLength(1);
    expect(r.hints[0]).toContain('Apply failed');
    expect(r.hints[0]).toContain("'Start' (already bound to interface 'mqtt-1')");
    expect(getConnectSnapshot().interfaces[0].signals).toEqual([]);
    expect(getConnectSnapshot().autoMapReport).toBe(r);
    expect(getConnectSnapshot().autoMapBusy).toBe(false);
  });

  it('refuses interface types other than S7 / PlcSimAdvanced', async () => {
    const gw: Gateway = { interfaces: [{ id: 'm', type: 'MQTT', enabled: true, signals: [] }], puts: [], discoverCalls: 0 };
    mockGateway(gw);
    await fetchInterfaces();
    await expect(checkAutoMap('m', MODEL)).rejects.toThrow(/S7 and PlcSimAdvanced/);
    expect(getConnectSnapshot().autoMapBusy).toBe(false);
  });
});
