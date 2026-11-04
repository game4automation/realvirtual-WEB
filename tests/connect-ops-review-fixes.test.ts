// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2025 P7 review fixes (Codex post-implementation review) against the in-memory CONNECT
 * (`_connect-ops-fake-gateway.ts`):
 *
 *  1. an answer that breaks off after 200 is an UNKNOWN outcome — reload, clear error, never the old
 *     whole-interface PUT; a confirmed write core is never taken back by a broken answer;
 *  3. fill / import plans carry the revision, instance and gateway they were computed on; Apply sends
 *     exactly that, a 409 / reload / gateway change makes the plan stale (a new preview is required);
 *  5. the Multi-Tab import is ONE ops batch on the held revision (same replacing topic semantics),
 *     the PUT only for an older CONNECT;
 *  8. CONNECT's size limits are checked before the per-row check and before sending — nothing is split.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetConnectStore,
  applyAddressTableImport,
  applyFillAddresses,
  applySignalBinding,
  ConnectConfigConflictError,
  ConnectConfigLimitError,
  ConnectConfigOutcomeUnknownError,
  ConnectConfigPlanStaleError,
  fetchInterfaces,
  getConnectSnapshot,
  getConnectConfigPlanBase,
  getConnectOpsSupport,
  importMultiTabTagTable,
  isConnectConfigPlanCurrent,
  planAddressTableImportFor,
  planFillAddressesFromController,
  removeSignals,
  setServerUrl,
  type ConnectInterface,
} from '../src/core/hmi/connect-store';
import { CONNECT_IMPORT_MAX_RAW_ROWS, CONNECT_OPS_MAX_OPS } from '../src/core/hmi/connect-ops-limits';
import { addressImportOps, parseAddressTable } from '../src/core/import/rv-address-table-import';
import { planFillAddresses } from '../src/core/import/rv-fill-addresses';
import type { ParsedTopic } from '../src/core/import/s7-tag-table';
import { installFakeGateway, type FakeGateway } from './_connect-ops-fake-gateway';

const S7: ConnectInterface = {
  id: 's7-1', type: 'S7', enabled: true, allowWebToPlc: false,
  signals: [
    { name: 'Lamp', protocolAddress: '%Q0.1', type: 'PLCOutputBool', record: true, comment: 'green' },
    { name: 'Empty', protocolAddress: '', type: 'PLCOutputBool', record: false },
  ],
} as ConnectInterface;

const MQTT: ConnectInterface = {
  id: 'mqtt-1', type: 'MQTT', enabled: false, brokerUrl: 'mqtt://old', keepAliveS: 30,
  signals: [],
  topics: [
    { topic: 'Data_Q_1', mode: 'ProcessImage', signals: [{ name: 'Old1', protocolAddress: '%Q0.0', type: 'PLCOutputBool', record: false }] },
    { topic: 'Data_Q_9', mode: 'ProcessImage', signals: [{ name: 'Gone', protocolAddress: '%Q9.0', type: 'PLCOutputBool', record: false }] },
  ],
} as unknown as ConnectInterface;

const TOPICS: ParsedTopic[] = [
  { topic: 'Data_Q_1', sheetName: 'Data_Q_1', signals: [{ name: 'M_Run', wireType: 'PLCOutputBool', address: '%Q1.0', dataType: 'Bool', area: 'Q' }], warnings: [] },
  { topic: 'Data_Q_2', sheetName: 'Data_Q_2', signals: [{ name: 'Cmd', wireType: 'PLCOutputInt', address: '%QW2800', dataType: 'Word', area: 'Q' }], warnings: [] },
];

let gw: FakeGateway;
async function connect(init: Parameters<typeof installFakeGateway>[0] = {}): Promise<void> {
  gw = installFakeGateway({ interfaces: [S7], ...init });
  await fetchInterfaces();
}
const puts = () => gw.calls.filter(c => c.method === 'PUT');
const interfaceGets = () => gw.calls.filter(c => c.method === 'GET' && c.path === '/config/interfaces').length;

beforeEach(() => {
  _resetConnectStore();
  setServerUrl('http://gw.test:5100');
});
afterEach(() => {
  vi.restoreAllMocks();
  _resetConnectStore();
});

describe('fix 1 — unknown commit outcome', () => {
  it('a body that breaks off after 200 → "result unknown", reloaded, NO legacy PUT', async () => {
    await connect({ revision: 7 });
    gw.breakOpsBody = 1;
    const getsBefore = interfaceGets();
    const err = await applySignalBinding({ interfaceId: 's7-1', name: 'Lamp', protocolAddress: '%Q0.2' }).catch(e => e);
    expect(err).toBeInstanceOf(ConnectConfigOutcomeUnknownError);
    expect(String(err.message)).toMatch(/^Result unknown/);
    // The batch WAS committed by the gateway — and nothing tried to write it a second time.
    expect(gw.interfaces[0].signals[0].protocolAddress).toBe('%Q0.2');
    expect(gw.revision).toBe(8);
    expect(puts()).toHaveLength(0);
    expect(gw.opsCalls()).toHaveLength(1);
    expect(interfaceGets()).toBeGreaterThan(getsBefore); // reloaded so the user sees what is stored
    // The ops answer carried CONNECT's revision headers: the write core is confirmed, not denied.
    expect(getConnectOpsSupport()).toBe(true);
  });

  it('a confirmed write core is never taken back by a broken answer', async () => {
    await connect();
    await applySignalBinding({ interfaceId: 's7-1', name: 'Lamp', protocolAddress: '%Q0.2' });
    expect(getConnectOpsSupport()).toBe(true);
    // A later answer that is not the ops contract (a proxy page in between) on the confirmed gateway.
    const fake = vi.mocked(globalThis.fetch).getMockImplementation()!;
    let armed = true;
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
      if (armed && String(url).endsWith('/config/ops')) {
        armed = false;
        return new Response('<html>proxy</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
      }
      return fake(url, init);
    });
    await expect(applySignalBinding({ interfaceId: 's7-1', name: 'Lamp', protocolAddress: '%Q0.3' }))
      .rejects.toBeInstanceOf(ConnectConfigOutcomeUnknownError);
    expect(getConnectOpsSupport()).toBe(true);
    expect(puts()).toHaveLength(0);
    // The next write still goes through the write core.
    await applySignalBinding({ interfaceId: 's7-1', name: 'Lamp', protocolAddress: '%Q0.4' });
    expect(gw.interfaces[0].signals[0].protocolAddress).toBe('%Q0.4');
    expect(puts()).toHaveLength(0);
  });

  it('an older CONNECT (404, never confirmed) still gets its old route', async () => {
    await connect({ ops: false });
    await applySignalBinding({ interfaceId: 's7-1', name: 'Lamp', protocolAddress: '%Q0.2' });
    expect(getConnectOpsSupport()).toBe(false);
    expect(puts()).toHaveLength(1);
  });

  it('a 404 on a gateway whose write core was confirmed is an error, not a fallback', async () => {
    await connect();
    await applySignalBinding({ interfaceId: 's7-1', name: 'Lamp', protocolAddress: '%Q0.2' });
    gw.failOps.push({ status: 404, body: {} });
    await expect(applySignalBinding({ interfaceId: 's7-1', name: 'Lamp', protocolAddress: '%Q0.3' })).rejects.toThrow(/HTTP 404/);
    expect(getConnectOpsSupport()).toBe(true);
    expect(puts()).toHaveLength(0);
  });
});

describe('fix 3 — plans hold revision, instance and gateway', () => {
  const table = () => parseAddressTable('Empty;%Q2.0\n');
  const options = { container: { kind: 'flat' as const }, existing: 'fillEmpty' as const, defaultDirection: null };

  it('Apply sends the plan\'s revision, not the one shown at Apply time', async () => {
    await connect({ revision: 20 });
    const plan = await planAddressTableImportFor('s7-1', table(), options);
    expect(plan.base?.revision).toEqual({ revision: 20, instance: 'inst-a' });
    expect(plan.base?.baseUrl).toBe('http://gw.test:5100');
    await applyAddressTableImport(plan);
    expect(gw.opsCalls()[0].expectedRevision).toBe(20);
    expect(gw.opsCalls()[0].expectedInstance).toBe('inst-a');
  });

  it('a write elsewhere → 409; the SAME plan is then stale and needs a new preview', async () => {
    await connect({ revision: 20 });
    const plan = await planAddressTableImportFor('s7-1', table(), options);
    gw.bump(); // another client wrote; this tab has not seen it
    await expect(applyAddressTableImport(plan)).rejects.toBeInstanceOf(ConnectConfigConflictError);
    // The conflict reloaded the list: the preview no longer describes it.
    expect(isConnectConfigPlanCurrent(plan.base)).toBe(false);
    const callsBefore = gw.opsCalls().length;
    await expect(applyAddressTableImport(plan)).rejects.toBeInstanceOf(ConnectConfigPlanStaleError);
    expect(gw.opsCalls()).toHaveLength(callsBefore); // nothing sent
    // A new preview on the reloaded configuration is accepted.
    const fresh = await planAddressTableImportFor('s7-1', table(), options);
    await applyAddressTableImport(fresh);
    expect(gw.interfaces[0].signals[1].protocolAddress).toBe('%Q2.0');
  });

  it('a reload that moved the revision, or another gateway, makes a fill plan stale before sending', async () => {
    await connect({ revision: 3 });
    const fillPlan = {
      ...planFillAddresses({
        iface: S7,
        model: [{ name: 'Empty', localName: 'Empty', type: 'PLCOutputBool', path: 'R/Empty' }],
        discovered: [{ symbolKey: 'Empty', protocolAddress: '%Q5.0', direction: 'output', dataType: 'Bool', contract: 'current' } as never],
      }),
      base: getConnectConfigPlanBase(),
    };
    expect(isConnectConfigPlanCurrent(fillPlan.base)).toBe(true);
    gw.bump();
    await fetchInterfaces(); // the tab reloads and now shows revision 4
    await expect(applyFillAddresses(fillPlan)).rejects.toBeInstanceOf(ConnectConfigPlanStaleError);
    expect(gw.opsCalls()).toHaveLength(0);

    const again = { ...fillPlan, base: getConnectConfigPlanBase() };
    setServerUrl('http://other.test:5100'); // a different gateway
    expect(isConnectConfigPlanCurrent(again.base)).toBe(false);
    await expect(applyFillAddresses(again)).rejects.toBeInstanceOf(ConnectConfigPlanStaleError);
  });
});

describe('fix 5 — Multi-Tab import as ONE ops batch', () => {
  it('replaces the topics atomically on the held revision; other interface fields stay', async () => {
    await connect({ interfaces: [S7, MQTT], revision: 30 });
    await importMultiTabTagTable(TOPICS, { interfaceId: 'mqtt-1', brokerUrl: 'mqtt://new' });
    expect(puts()).toHaveLength(0);
    const [batch] = gw.opsCalls();
    expect(batch.expectedRevision).toBe(30);
    expect(batch.ops.map(o => o.op)).toEqual(['interface.patch', 'container.replace', 'container.replace']);
    expect(batch.ops[0].patch).toEqual({ brokerUrl: 'mqtt://new', topics: [] });
    const iface = gw.interfaces.find(i => i.id === 'mqtt-1')! as unknown as Record<string, unknown> & ConnectInterface;
    // Exactly the imported topics, in import order — Data_Q_9 is gone, nothing accumulates.
    expect(iface.topics!.map(t => t.topic)).toEqual(['Data_Q_1', 'Data_Q_2']);
    expect(iface.topics![0].signals!.map(s => s.name)).toEqual(['M_Run']);
    expect(iface.brokerUrl).toBe('mqtt://new');
    expect(iface.enabled).toBe(false);   // not reset
    expect(iface.keepAliveS).toBe(30);   // not reset
  });

  it('a re-import with the same topics in order needs no topic clearing', async () => {
    await connect({ interfaces: [S7, MQTT] });
    await importMultiTabTagTable(TOPICS, { interfaceId: 'mqtt-1', brokerUrl: 'mqtt://old' });
    await fetchInterfaces();
    await importMultiTabTagTable(TOPICS, { interfaceId: 'mqtt-1', brokerUrl: 'mqtt://old' });
    const second = gw.opsCalls()[1];
    expect(second.ops.map(o => o.op)).toEqual(['container.replace', 'container.replace']);
  });

  it('a concurrent change elsewhere → 409, nothing overwritten', async () => {
    await connect({ interfaces: [S7, MQTT] });
    gw.bump();
    await expect(importMultiTabTagTable(TOPICS, { interfaceId: 'mqtt-1', brokerUrl: 'mqtt://new' }))
      .rejects.toBeInstanceOf(ConnectConfigConflictError);
    expect(gw.interfaces.find(i => i.id === 'mqtt-1')!.topics!.map(t => t.topic)).toEqual(['Data_Q_1', 'Data_Q_9']);
    expect(puts()).toHaveLength(0);
  });

  it('an interface the list does not have yet is added in the same batch', async () => {
    await connect();
    await importMultiTabTagTable(TOPICS, { interfaceId: 'mqtt-new', brokerUrl: 'mqtt://x' });
    expect(gw.opsCalls()[0].ops[0]).toMatchObject({ op: 'interface.add', interface: { id: 'mqtt-new', type: 'MQTT', brokerUrl: 'mqtt://x', topics: [] } });
    expect(gw.interfaces.find(i => i.id === 'mqtt-new')!.topics!.map(t => t.topic)).toEqual(['Data_Q_1', 'Data_Q_2']);
  });

  it('an older CONNECT still gets the whole-interface PUT', async () => {
    await connect({ interfaces: [S7, MQTT], ops: false });
    await importMultiTabTagTable(TOPICS, { interfaceId: 'mqtt-1', brokerUrl: 'mqtt://new' });
    expect(puts()).toHaveLength(1);
    expect((puts()[0].body as ConnectInterface).topics!.map(t => t.topic)).toEqual(['Data_Q_1', 'Data_Q_2']);
  });
});

describe('fix 8 — size limits before checking and sending', () => {
  it('a batch over MaxOps is refused with a clear message, nothing is sent, nothing is split', async () => {
    await connect();
    const names = Array.from({ length: CONNECT_OPS_MAX_OPS + 1 }, (_, i) => ({ name: `S${i}` }));
    const err = await removeSignals('s7-1', names).catch(e => e);
    expect(err).toBeInstanceOf(ConnectConfigLimitError);
    expect(String(err.message)).toMatch(/at most 10000 changes in one batch/);
    expect(gw.opsCalls()).toHaveLength(0);
    expect(puts()).toHaveLength(0);
  });

  it('10001 raw rows with only 2 writing rows are allowed (raw rows are no batch measure)', async () => {
    await connect();
    const rows = Array.from({ length: CONNECT_OPS_MAX_OPS + 1 }, (_, i) =>
      i < 2 ? `New${i};%Q${50 + i}.0` : `Lamp;%Q0.1`); // 9999 duplicates of an unchanged signal
    const plan = await planAddressTableImportFor('s7-1', parseAddressTable(rows.join('\n')), {
      container: { kind: 'flat' }, existing: 'fillEmpty', defaultDirection: 'output',
    });
    expect(plan.limitError).toBeNull();
    expect(addressImportOps(plan)).toHaveLength(2);
    // Unchanged rows (same address as the signal already has) were not sent to the gateway's parser.
    expect(gw.calls.filter(c => c.path === '/signals/validate').length).toBeLessThanOrEqual(2);
  });

  it('a batch of more than MaxOps WRITING rows is refused by the batch limit before sending', async () => {
    await connect();
    const rows = Array.from({ length: CONNECT_OPS_MAX_OPS + 1 }, (_, i) => `N${i};%Q${i}.0`);
    const plan = await planAddressTableImportFor('s7-1', parseAddressTable(rows.join('\n')), {
      container: { kind: 'flat' }, existing: 'fillEmpty', defaultDirection: 'output',
    });
    expect(plan.limitError).toMatch(/at most 10000 changes in one batch/);
    await expect(applyAddressTableImport(plan)).rejects.toBeInstanceOf(ConnectConfigLimitError);
    expect(gw.opsCalls()).toHaveLength(0);
  });

  it('rows over the input-protection limit are refused BEFORE the per-row check', async () => {
    await connect();
    const text = Array.from({ length: CONNECT_IMPORT_MAX_RAW_ROWS + 1 }, (_, i) => `S${i};%Q${i}.0`).join('\n');
    const err = await planAddressTableImportFor('s7-1', parseAddressTable(text), {
      container: { kind: 'flat' }, existing: 'fillEmpty', defaultDirection: 'output',
    }).catch(e => e);
    expect(err).toBeInstanceOf(ConnectConfigLimitError);
    expect(String(err.message)).toMatch(/input protection/);
    expect(gw.calls.filter(c => c.path === '/signals/validate')).toHaveLength(0);
  });
});

describe('recheck — discovery is bound to the gateway it started on', () => {
  it('a gateway switch during a running discovery: no store write, no plan on a foreign base', async () => {
    await connect({ revision: 3 });
    const fake = vi.mocked(globalThis.fetch).getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
      if (String(url).includes('/discover/')) {
        await gate;
        return new Response(JSON.stringify({ signals: [
          { symbolKey: 'Empty', protocolAddress: '%Q9.0', direction: 'output', dataType: 'Bool' },
        ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return fake(url, init);
    });
    const pending = planFillAddressesFromController('s7-1', [
      { name: 'Empty', localName: 'Empty', type: 'PLCOutputBool', path: 'R/Empty' },
    ]).catch(e => e);
    await Promise.resolve();
    setServerUrl('http://other.test:5100'); // the tab moves to another gateway mid-browse
    release();
    const result = await pending;
    expect(result).toBeInstanceOf(ConnectConfigPlanStaleError);
    expect(getConnectSnapshot().discoveredSignals).toEqual([]);
  });
});
