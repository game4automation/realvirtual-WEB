// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-589 test 9.7 — the PLC binding write path against a mocked CONNECT gateway.
 *
 * The thing under test is that a write lands in the signal's OWN container. CONNECT has no signal
 * CRUD endpoint: every change is a full `PUT /config/interfaces/{id}`, so a write that targets the
 * wrong array does not fail — it silently moves or duplicates the signal. These tests therefore
 * assert the PUT BODY, not just that the call succeeded.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  addressRuleFor,
  collectInterfaceSlots,
  isProcessImageAddress,
} from '../src/core/import/rv-iface-signal-slots';
import {
  addSignal,
  applySignalBinding,
  fetchInterfaces,
  findSignalInContainer,
  getConnectSnapshot,
  removeSignal,
  setServerUrl,
  updateSignal,
  _resetConnectStore,
  type ConnectInterface,
  type ConnectSignalSchema,
} from '../src/core/hmi/connect-store';

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
}));

interface Gateway {
  interfaces: ConnectInterface[];
  puts: Array<{ id: string; body: ConnectInterface }>;
  putStatus?: number;
  putError?: unknown;
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
    return json({});
  });
}

const sig = (name: string, protocolAddress = '', type = 'PLCOutputBool') =>
  ({ name, protocolAddress, type, record: false });

/** An MQTT interface whose two topics carry the SAME signal name — the case the slot type exists for. */
function mqttGateway(): Gateway {
  return {
    interfaces: [{
      id: 'mqtt-1', type: 'MQTT', enabled: true, allowWebToPlc: false,
      brokerUrl: 'mqtt://localhost:1883',
      signals: [sig('Legacy.Start', 'plant/legacy/start')],
      topics: [
        { topic: 'plant/a', mode: 'Single', signals: [sig('Cell.Start')] },
        { topic: 'plant/b', mode: 'Json', signals: [sig('Cell.Start')] },
        { topic: 'plant/pi', mode: 'ProcessImage', signals: [sig('Cell.Lamp', '%Q0.1')] },
      ],
    }],
    puts: [],
  };
}

describe('plan-589 — PLC binding writes into the signal\'s own container', () => {
  beforeEach(() => {
    _resetConnectStore();
    vi.restoreAllMocks();
    setServerUrl('http://gw.test:5100');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    _resetConnectStore();
  });

  it('writes a flat signal into iface.signals and leaves every topic untouched', async () => {
    const gw = mqttGateway();
    mockGateway(gw);
    await fetchInterfaces();

    const outcome = await applySignalBinding({
      interfaceId: 'mqtt-1', name: 'Legacy.Start', protocolAddress: 'plant/legacy/start2',
    });

    expect(outcome).toBe('updated');
    expect(gw.puts).toHaveLength(1);
    const body = gw.puts[0].body;
    expect(body.signals?.map((s) => [s.name, s.protocolAddress]))
      .toEqual([['Legacy.Start', 'plant/legacy/start2']]);
    // The topics array must travel back WHOLE — CONNECT replaces the field, so a patch that
    // forgot it would delete all three topics.
    expect(body.topics?.map((t) => t.topic)).toEqual(['plant/a', 'plant/b', 'plant/pi']);
    expect(body.topics?.[0].signals?.[0].protocolAddress).toBe('');
  });

  it('writes a topic signal into THAT topic only, with the same name present in another topic', async () => {
    const gw = mqttGateway();
    mockGateway(gw);
    await fetchInterfaces();

    const outcome = await applySignalBinding({
      interfaceId: 'mqtt-1', topic: 'plant/b', name: 'Cell.Start', dataType: 'Bool',
    });

    expect(outcome).toBe('updated');
    const body = gw.puts[0].body;
    const byTopic = new Map(body.topics!.map((t) => [t.topic, t.signals ?? []]));
    expect(byTopic.get('plant/b')![0].dataType).toBe('Bool');
    // The same NAME in the other topic is a different place and must be unchanged.
    expect(byTopic.get('plant/a')![0].dataType).toBeUndefined();
    expect(body.signals?.[0].name).toBe('Legacy.Start');
  });

  it('adds a missing entry into the addressed topic with the model\'s wire type', async () => {
    const gw = mqttGateway();
    mockGateway(gw);
    await fetchInterfaces();

    const outcome = await applySignalBinding({
      interfaceId: 'mqtt-1', topic: 'plant/pi', name: 'Cell.Speed',
      type: 'PLCOutputFloat', dataType: 'Real', protocolAddress: '%IW13',
    });

    expect(outcome).toBe('added');
    const pi = gw.puts[0].body.topics!.find((t) => t.topic === 'plant/pi')!;
    expect(pi.signals?.map((s) => s.name)).toEqual(['Cell.Lamp', 'Cell.Speed']);
    expect(pi.signals?.[1]).toMatchObject({ type: 'PLCOutputFloat', dataType: 'Real', protocolAddress: '%IW13' });
  });

  it('refuses to create an entry without a wire type instead of writing a typeless signal', async () => {
    const gw = mqttGateway();
    mockGateway(gw);
    await fetchInterfaces();

    await expect(applySignalBinding({ interfaceId: 'mqtt-1', name: 'Nowhere.Near' }))
      .rejects.toThrow(/wire type is required/);
    expect(gw.puts).toHaveLength(0);
  });

  it('removes the binding from its own container and reports "absent" when there is nothing to remove', async () => {
    const gw = mqttGateway();
    mockGateway(gw);
    await fetchInterfaces();

    expect(await applySignalBinding({ interfaceId: 'mqtt-1', topic: 'plant/a', name: 'Cell.Start', remove: true }))
      .toBe('removed');
    const body = gw.puts[0].body;
    expect(body.topics!.find((t) => t.topic === 'plant/a')!.signals).toEqual([]);
    // Same name, other topic — still there.
    expect(body.topics!.find((t) => t.topic === 'plant/b')!.signals).toHaveLength(1);

    await fetchInterfaces();
    expect(await applySignalBinding({ interfaceId: 'mqtt-1', topic: 'plant/a', name: 'Cell.Start', remove: true }))
      .toBe('absent');
    expect(gw.puts).toHaveLength(1);   // nothing written for a no-op removal
  });

  it('surfaces a 409 name collision as a readable error and writes nothing', async () => {
    const gw = mqttGateway();
    gw.putStatus = 409;
    gw.putError = { error: "Signal name 'Cell.Start' already exists on interface 's7-1'" };
    mockGateway(gw);
    await fetchInterfaces();

    await expect(applySignalBinding({
      interfaceId: 'mqtt-1', topic: 'plant/pi', name: 'Cell.Start',
      type: 'PLCOutputBool', protocolAddress: '%I0.0',
    })).rejects.toThrow(/already exists/);
    // The store's own view must not have drifted from the gateway's.
    const iface = getConnectSnapshot().interfaces[0];
    expect(findSignalInContainer(iface, 'Cell.Start', 'plant/pi')).toBeNull();
  });

  it('rejects a topic that does not exist rather than creating one', async () => {
    const gw = mqttGateway();
    mockGateway(gw);
    await fetchInterfaces();

    await expect(addSignal('mqtt-1', sig('X'), 'plant/nope')).rejects.toThrow(/has no topic/);
    await expect(updateSignal('mqtt-1', 'X', sig('X'), 'plant/nope')).rejects.toThrow(/has no topic/);
    await expect(removeSignal('mqtt-1', 'X', 'plant/nope')).rejects.toThrow(/has no topic/);
    expect(gw.puts).toHaveLength(0);
  });

  it('keeps the existing callers\' meaning: no topic = the flat container', async () => {
    const gw = mqttGateway();
    mockGateway(gw);
    await fetchInterfaces();

    await addSignal('mqtt-1', sig('Flat.New', 'plant/new'));
    expect(gw.puts[0].body.signals?.map((s) => s.name)).toEqual(['Legacy.Start', 'Flat.New']);
    expect(gw.puts[0].body.topics?.[0].signals).toHaveLength(1);
  });

  it('patches an existing entry instead of replacing it — record and comment survive', async () => {
    const gw: Gateway = {
      interfaces: [{
        id: 's7-1', type: 'S7', enabled: true, allowWebToPlc: false, ipAddress: '127.0.0.1',
        signals: [{
          name: 'DB_FG01.Start', protocolAddress: 'DB10.DBX4.1', type: 'PLCOutputBool',
          dataType: 'Bool', comment: 'Conveyor start', record: true,
        }],
      }],
      puts: [],
    };
    mockGateway(gw);
    await fetchInterfaces();

    await applySignalBinding({ interfaceId: 's7-1', name: 'DB_FG01.Start', protocolAddress: 'DB10.DBX4.2' });

    expect(gw.puts[0].body.signals?.[0]).toEqual({
      name: 'DB_FG01.Start', protocolAddress: 'DB10.DBX4.2', type: 'PLCOutputBool',
      dataType: 'Bool', comment: 'Conveyor start', record: true,
    });
  });
});

describe('plan-589 — interface signal slots and the address rule', () => {
  const schema = (): ConnectSignalSchema => ({
    supportsDiscovery: true, supportsManualAdd: true, addressValidatable: true,
    directionFromAddress: false, addressLabel: 'Topic', addressHint: '', addressExamples: [],
    dataTypes: [],
    addressRule: {
      signals: 'required',
      topicModes: { Single: 'container-topic', Json: 'none', ProcessImage: 'required' },
    },
  });

  it('lists every place, flat container first, keeping same-named signals apart', () => {
    const slots = collectInterfaceSlots(mqttGateway().interfaces[0]);
    expect(slots.map((s) => [s.name, s.topic, s.mode])).toEqual([
      ['Legacy.Start', undefined, undefined],
      ['Cell.Start', 'plant/a', 'Single'],
      ['Cell.Start', 'plant/b', 'Json'],
      ['Cell.Lamp', 'plant/pi', 'ProcessImage'],
    ]);
  });

  it('resolves the rule per container and per topic mode', () => {
    const s = schema();
    expect(addressRuleFor({}, s)).toBe('required');
    expect(addressRuleFor({ topic: 'plant/a', mode: 'Single' }, s)).toBe('container-topic');
    expect(addressRuleFor({ topic: 'plant/b', mode: 'Json' }, s)).toBe('none');
    expect(addressRuleFor({ topic: 'plant/pi', mode: 'ProcessImage' }, s)).toBe('required');
  });

  it('answers null — never a requirement — when the gateway states no rule (plan-589 §5.4)', () => {
    expect(addressRuleFor({}, undefined)).toBeNull();
    expect(addressRuleFor({}, null)).toBeNull();
    // A schema that exists but says nothing about addresses is the OLD gateway case.
    const { addressRule: _dropped, ...legacy } = schema();
    expect(addressRuleFor({}, legacy as ConnectSignalSchema)).toBeNull();
    expect(addressRuleFor({ topic: 'plant/a', mode: 'Single' }, legacy as ConnectSignalSchema)).toBeNull();
  });

  it('answers null for a topic mode this gateway has no rule for — "never said", not "none"', () => {
    const s = schema();
    s.addressRule!.topicModes = { Single: 'container-topic' };
    expect(addressRuleFor({ topic: 'plant/b', mode: 'Json' }, s)).toBeNull();
    // A topic whose mode is unknown to us cannot be judged either.
    expect(addressRuleFor({ topic: 'plant/b' }, s)).toBeNull();
  });

  it('checks the process-image address syntax the gateway uses', () => {
    for (const ok of ['%IW13', '%I3.1', '%QX2.7', '96.0', '96', '%MD20', 'iw13']) {
      expect(isProcessImageAddress(ok), ok).toBe(true);
    }
    for (const bad of ['', 'plant/line1', '%IW', '%I3.8', 'DB10.DBX4.1', '%ZW1']) {
      expect(isProcessImageAddress(bad), bad).toBe(false);
    }
  });
});
