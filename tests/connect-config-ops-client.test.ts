// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2025 F10 / §9 `connect-config-ops-client` — every browser write through `POST /config/ops`.
 *
 * Against an in-memory CONNECT (`_connect-ops-fake-gateway.ts`): the batch carries the revision of
 * the list the user saw (`X-Config-Revision` / `-Instance`), names only the fields it changes (no lost
 * update against the write-gate switch), a revision conflict reloads and says so, an older CONNECT
 * (no `/config/ops`) gets the route it got before, and the bridges are written as id / pair ops.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetConnectStore,
  applyAutoMap,
  applySignalBinding,
  ConnectConfigConflictError,
  CONNECT_CONFIG_CONFLICT_MESSAGE,
  fetchInterfaces,
  getConnectConfigRevisions,
  getConnectOpsSupport,
  getConnectSnapshot,
  importS7TagTable,
  mapDiscoveredSignal,
  putMappings,
  putMirrors,
  reloadConnectBridges,
  removeSignals,
  setServerUrl,
  setSignalRecord,
  updateInterface,
  getConnectBridges,
  type ConnectInterface,
} from '../src/core/hmi/connect-store';
import { installFakeGateway, type FakeGateway } from './_connect-ops-fake-gateway';

const S7: ConnectInterface = {
  id: 's7-1', type: 'S7', enabled: true, allowWebToPlc: false,
  signals: [
    { name: 'Lamp', protocolAddress: '%Q0.1', type: 'PLCOutputBool', record: true, comment: 'green' },
    { name: 'Opc', protocolAddress: 'ns=2;s=x', type: 'PLCOutputFloat', record: false, subscribeValue: false, pollValue: true, pollCycleMs: 250 },
  ],
} as ConnectInterface;

let gw: FakeGateway;

async function connect(init: Parameters<typeof installFakeGateway>[0] = {}): Promise<void> {
  gw = installFakeGateway({ interfaces: [S7], ...init });
  await fetchInterfaces();
  await reloadConnectBridges();
}

beforeEach(() => {
  _resetConnectStore();
  setServerUrl('http://gw.test:5100');
});
afterEach(() => {
  vi.restoreAllMocks();
  _resetConnectStore();
});

describe('revision from the GET headers', () => {
  it('the shown list carries the gateway revision; a write sends it as expectedRevision', async () => {
    await connect({ revision: 41 });
    expect(getConnectConfigRevisions().interfaces).toEqual({ revision: 41, instance: 'inst-a' });

    await applySignalBinding({ interfaceId: 's7-1', name: 'Lamp', protocolAddress: '%Q0.2' });
    const [call] = gw.opsCalls();
    expect(call.expectedRevision).toBe(41);
    expect(call.expectedInstance).toBe('inst-a');
    // A PATCH of what the inspector knows — record, comment and type stay as the gateway has them.
    expect(call.ops).toEqual([{ op: 'signal.upsert', interfaceId: 's7-1', name: 'Lamp', protocolAddress: '%Q0.2', addressMode: 'overwrite' }]);
    expect(gw.interfaces[0].signals[0]).toMatchObject({ protocolAddress: '%Q0.2', record: true, comment: 'green' });
    // Re-read after the commit: the store shows the gateway's state and its new revision.
    expect(getConnectSnapshot().interfaces[0].signals[0].protocolAddress).toBe('%Q0.2');
    expect(getConnectConfigRevisions().interfaces?.revision).toBe(42);
    expect(getConnectOpsSupport()).toBe(true);
  });
});

describe('no lost update against allow-web-to-plc', () => {
  it('the Enabled switch sends only `enabled` — a write-gate change made elsewhere survives', async () => {
    await connect();
    // Another client opens the write gate after this tab loaded (this tab still shows false).
    gw.interfaces[0].allowWebToPlc = true;
    await updateInterface('s7-1', { enabled: false, allowWebToPlc: false });
    const ops = gw.opsCalls().at(-1)!.ops;
    // allowWebToPlc equals the SHOWN value, so it is not part of the patch at all.
    expect(ops).toEqual([{ op: 'interface.patch', interfaceId: 's7-1', patch: { enabled: false } }]);
    expect(gw.interfaces[0]).toMatchObject({ enabled: false, allowWebToPlc: true });
  });
});

describe('revision conflict', () => {
  it('409 reloads the configuration and tells the user; nothing is written', async () => {
    await connect();
    gw.bump();
    gw.interfaces[0].signals[0].comment = 'changed elsewhere';
    const err = await applySignalBinding({ interfaceId: 's7-1', name: 'Lamp', protocolAddress: '%Q7.7' }).catch(e => e);
    expect(err).toBeInstanceOf(ConnectConfigConflictError);
    expect((err as Error).message).toBe(CONNECT_CONFIG_CONFLICT_MESSAGE);
    expect(gw.interfaces[0].signals[0].protocolAddress).toBe('%Q0.1');
    // Reloaded: the store now shows the other writer's change and the current revision.
    expect(getConnectSnapshot().interfaces[0].signals[0].comment).toBe('changed elsewhere');
    expect(getConnectConfigRevisions().interfaces?.revision).toBe(gw.revision);
  });

  it('a rejected batch says what the gateway refused', async () => {
    await connect();
    gw.failOps.push({ status: 400, body: { code: 'ops-rejected', errors: ["ops[0] signal.upsert: signal-name-collision: 'Lamp'"], results: [] } });
    await expect(applySignalBinding({ interfaceId: 's7-1', name: 'Lamp', protocolAddress: '%Q0.3' }))
      .rejects.toThrow(/nothing was saved: .*signal-name-collision/);
  });
});

describe('older CONNECT without /config/ops', () => {
  it('falls back to the PUT it used before, and probes only once', async () => {
    await connect({ ops: false });
    await applySignalBinding({ interfaceId: 's7-1', name: 'Lamp', protocolAddress: '%Q0.5' });
    await setSignalRecord('s7-1', 'Lamp', false);
    const opsPosts = gw.calls.filter(c => c.path === '/config/ops');
    const puts = gw.calls.filter(c => c.method === 'PUT' && c.path === '/config/interfaces/s7-1');
    expect(opsPosts).toHaveLength(1);
    expect(puts).toHaveLength(2);
    expect(getConnectOpsSupport()).toBe(false);
    expect(gw.interfaces[0].signals[0]).toMatchObject({ protocolAddress: '%Q0.5', record: false });
  });

  it('a gateway target change forgets the probe', async () => {
    await connect({ ops: false });
    await setSignalRecord('s7-1', 'Lamp', false);
    expect(getConnectOpsSupport()).toBe(false);
    setServerUrl('http://other.test:5100');
    expect(getConnectOpsSupport()).toBeNull();
    expect(getConnectConfigRevisions().interfaces).toBeNull();
  });
});

describe('signal writes', () => {
  it('record switch and bulk delete are single batches that touch nothing else', async () => {
    await connect();
    await setSignalRecord('s7-1', 'Opc', true);
    expect(gw.opsCalls().at(-1)!.ops).toEqual([{ op: 'signal.upsert', interfaceId: 's7-1', name: 'Opc', record: true }]);
    expect(gw.interfaces[0].signals[1]).toMatchObject({ record: true, subscribeValue: false, pollValue: true, pollCycleMs: 250 });

    await removeSignals('s7-1', [{ name: 'Lamp' }, { name: 'Opc' }]);
    expect(gw.opsCalls().at(-1)!.ops.map(o => [o.op, o.name])).toEqual([['signal.remove', 'Lamp'], ['signal.remove', 'Opc']]);
    expect(gw.interfaces[0].signals).toEqual([]);
  });

  it('a tag-table import replaces the container in one op', async () => {
    await connect();
    await importS7TagTable('s7-1', [{ name: 'T1', address: '%I0.0', dataType: 'Bool', area: 'I', comment: '' } as never]);
    const ops = gw.opsCalls().at(-1)!.ops;
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: 'container.replace', interfaceId: 's7-1' });
    expect(gw.interfaces[0].signals.map(s => s.name)).toEqual(['T1']);
  });
});

describe('auto-map apply (legacy adopt) is ONE fillEmpty batch', () => {
  it('writes only the missing addresses, in one commit', async () => {
    await connect({ interfaces: [{ ...S7, signals: [{ name: 'Set', protocolAddress: '%Q5.0', type: 'PLCOutputBool', record: false }] } as ConnectInterface] });
    const report = await applyAutoMap('s7-1', [
      { name: 'Lamp', localName: 'Lamp', type: 'PLCOutputBool', comment: '%Q0.1 · Lamp' },
      { name: 'Set', localName: 'Set', type: 'PLCOutputBool', comment: '%Q9.9 · other' },
    ]);
    const calls = gw.opsCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].ops).toEqual([expect.objectContaining({ op: 'signal.upsert', name: 'Lamp', protocolAddress: '%Q0.1', addressMode: 'fillEmpty', comment: 'Lamp' })]);
    expect(gw.interfaces[0].signals.find(s => s.name === 'Set')!.protocolAddress).toBe('%Q5.0');
    expect(report.hints[0]).toBe('Applied: 1 signal(s) added or updated, nothing removed.');
  });
});

describe('bridges as id / pair ops', () => {
  it('a mirror edit is mirror.upsert/remove by id, based on the bridges revision', async () => {
    await connect({
      mirrors: [
        { id: 'mr-00000001', enabled: true, sourceInterfaceId: 's7-1', targetInterfaceId: 'mq', signalPattern: '*' },
        { id: 'mr-00000002', enabled: true, sourceInterfaceId: 's7-1', targetInterfaceId: 'shm', signalPattern: '*' },
      ],
    });
    const current = getConnectBridges().mirrors!;
    await putMirrors([{ ...current[0], enabled: false }, { enabled: true, sourceInterfaceId: 'a', targetInterfaceId: 'b', signalPattern: 'X*' }]);
    const call = gw.opsCalls().at(-1)!;
    expect(call.expectedRevision).toBe(10);
    expect(call.ops).toEqual([
      { op: 'mirror.remove', id: 'mr-00000002' },
      { op: 'mirror.upsert', mirror: { ...current[0], enabled: false } },
      { op: 'mirror.upsert', mirror: { id: '', enabled: true, sourceInterfaceId: 'a', targetInterfaceId: 'b', signalPattern: 'X*' } },
    ]);
    expect(gw.mirrors.map(m => m.id)).toEqual(['mr-00000001', 'mr-00000002']);
    expect(getConnectBridges().mirrors?.map(m => m.enabled)).toEqual([false, true]);
  });

  it('a mapping edit is keyed by (source, dest)', async () => {
    await connect({ mappings: [{ enabled: true, sourceSignal: 'A', destSignal: 'B' }] });
    await putMappings([{ enabled: true, sourceSignal: 'A', destSignal: 'C' }]);
    expect(gw.opsCalls().at(-1)!.ops).toEqual([
      { op: 'mapping.remove', sourceSignal: 'A', destSignal: 'B' },
      { op: 'mapping.upsert', mapping: { enabled: true, sourceSignal: 'A', destSignal: 'C' } },
    ]);
    expect(getConnectBridges().mappings).toEqual([{ enabled: true, sourceSignal: 'A', destSignal: 'C' }]);
  });

  it('plan-2227: a mapping carries its conversion options; an option change upserts the same pair', async () => {
    const bit = { enabled: true, sourceSignal: 'RobotReady', destSignal: 'Rob_Status', coercion: 'Strict' as const, mode: 'BitToWord' as const, bit: 3, width: 'Byte' as const };
    await connect({ mappings: [bit, { enabled: true, sourceSignal: 'A', destSignal: 'B' }] });
    await putMappings([{ ...bit, bit: 4, invert: true }, { enabled: true, sourceSignal: 'A', destSignal: 'B' }]);
    expect(gw.opsCalls().at(-1)!.ops).toEqual([
      { op: 'mapping.upsert', mapping: { ...bit, bit: 4, invert: true } },
    ]);
    expect(getConnectBridges().mappings?.[0]).toEqual({ ...bit, bit: 4, invert: true });
  });
});

describe('discovery contract (plan-2025 F8)', () => {
  it('reads protocolAddress / symbolKey; the legacy fields are only the fallback', () => {
    expect(mapDiscoveredSignal({ name: 'ns=2;s=A', browsePath: 'Objects/A', displayName: 'A', symbolKey: 'A', protocolAddress: 'ns=2;s=A', direction: 'output' }))
      .toMatchObject({ protocolAddress: 'ns=2;s=A', symbolKey: 'A', contract: 'current', browsePath: 'Objects/A' });
    expect(mapDiscoveredSignal({ name: 'MAIN.x', browsePath: 'MAIN.x', direction: 'inputFloat' }))
      .toMatchObject({ protocolAddress: 'MAIN.x', symbolKey: '', contract: 'legacy', direction: 'unknown' });
  });
});
