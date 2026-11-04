// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2025 F11 / §9 `rv-fill-addresses` — "Fill addresses from controller", pure part.
 *
 * Binding rules under test (plan-589): exact name = symbolKey couples, the controller's
 * `protocolAddress` is what is written (an OPC UA NodeId, never the display path), a quoting/case
 * variant is only a suggestion, FillEmpty never overwrites, and the whole fill is ONE batch of
 * `signal.upsert{fillEmpty}`. Offered by capability: FANUC (no discovery) is not, FMI never.
 */

import { describe, expect, it } from 'vitest';
import {
  fillAddressOps,
  planFillAddresses,
  supportsFillAddresses,
} from '../src/core/import/rv-fill-addresses';
import { legacyAdoptOps, matchPlcSignals, type ModelPlcSignal } from '../src/core/import/rv-plc-automap';
import type { ConnectInterface, ConnectSignalSchema, DiscoveredSignal } from '../src/core/hmi/connect-store';

const model = (name: string, type = 'PLCOutputBool'): ModelPlcSignal => ({ name, localName: name, type });
const disc = (symbolKey: string, protocolAddress: string, direction: DiscoveredSignal['direction'] = 'output', dataType = ''): DiscoveredSignal => ({
  symbolKey, protocolAddress, displayName: symbolKey, dataType, direction, browsePath: symbolKey, contract: 'current',
});
const schema = (over: Partial<ConnectSignalSchema> = {}): ConnectSignalSchema => ({
  supportsDiscovery: true, supportsManualAdd: true, addressValidatable: false, directionFromAddress: false,
  addressLabel: 'Symbol', addressHint: '', addressExamples: [], dataTypes: [], ...over,
});
const iface = (over: Partial<ConnectInterface>): ConnectInterface =>
  ({ id: 'if1', type: 'TwinCat', enabled: true, signals: [], ...over } as ConnectInterface);

describe('planFillAddresses — TwinCAT', () => {
  it('couples exact names only, fills empty addresses, creates missing signals', () => {
    const plan = planFillAddresses({
      iface: iface({ signals: [{ name: 'MAIN.bStart', protocolAddress: '', type: 'PLCOutputBool', record: true }] }),
      model: [model('MAIN.bStart'), model('MAIN.rSpeed', 'PLCOutputFloat'), model('MAIN.bMissing')],
      discovered: [disc('MAIN.bStart', 'MAIN.bStart'), disc('MAIN.rSpeed', 'MAIN.rSpeed', 'output', 'LREAL'), disc('MAIN.bOther', 'MAIN.bOther')],
      schema: schema(),
    });
    expect(plan.rows.map(r => [r.name, r.status])).toEqual([
      ['MAIN.bStart', 'fill'], ['MAIN.rSpeed', 'create'], ['MAIN.bMissing', 'not-found'],
    ]);
    expect(plan.controllerOnly).toBe(1);
    const ops = fillAddressOps(plan);
    expect(ops).toEqual([
      { op: 'signal.upsert', interfaceId: 'if1', name: 'MAIN.bStart', protocolAddress: 'MAIN.bStart', addressMode: 'fillEmpty' },
      {
        op: 'signal.upsert', interfaceId: 'if1', name: 'MAIN.rSpeed', protocolAddress: 'MAIN.rSpeed', addressMode: 'fillEmpty',
        type: 'PLCOutputFloat', record: false, dataType: 'LREAL',
      },
    ]);
  });

  it('keeps a different existing address (FillEmpty) and reports an equal one as already set', () => {
    const plan = planFillAddresses({
      iface: iface({ signals: [
        { name: 'A', protocolAddress: 'GVL.A_old', type: 'PLCOutputBool', record: false },
        { name: 'B', protocolAddress: 'GVL.B', type: 'PLCOutputBool', record: false },
      ] }),
      model: [model('A'), model('B')],
      discovered: [disc('A', 'GVL.A'), disc('B', 'GVL.B')],
    });
    expect(plan.rows.map(r => r.status)).toEqual(['kept', 'already']);
    expect(plan.rows[0].existingAddress).toBe('GVL.A_old');
    expect(fillAddressOps(plan)).toEqual([]);
  });

  it('a quoting or case variant is only a suggestion — never written', () => {
    const plan = planFillAddresses({
      iface: iface({}),
      model: [model('DB1.Start'), model('main.speed', 'PLCOutputFloat')],
      discovered: [disc('"DB1".Start', '"DB1".Start'), disc('MAIN.Speed', 'MAIN.Speed')],
    });
    expect(plan.rows.map(r => [r.status, r.suggestion])).toEqual([
      ['name-variant', '"DB1".Start'], ['name-variant', 'MAIN.Speed'],
    ]);
    expect(fillAddressOps(plan)).toEqual([]);
  });

  it('refuses direction conflicts, duplicate symbols, names bound elsewhere and symbols without address', () => {
    const plan = planFillAddresses({
      iface: iface({}),
      model: [model('In', 'PLCInputBool'), model('Dup'), model('Other'), model('NoAddr')],
      discovered: [disc('In', 'GVL.In', 'output'), disc('Dup', 'X1'), disc('Dup', 'X2'), disc('Other', 'GVL.Other'), disc('NoAddr', '')],
      otherInterfaces: [iface({ id: 'if2', signals: [{ name: 'Other', protocolAddress: 'x', type: 'PLCOutputBool', record: false }] })],
    });
    expect(plan.rows.map(r => r.status)).toEqual(['direction-conflict', 'ambiguous', 'bound-elsewhere', 'no-address']);
    expect(fillAddressOps(plan)).toEqual([]);
  });

  it('writes into the topic container that holds the name, and refuses a name in two containers', () => {
    const plan = planFillAddresses({
      iface: iface({
        type: 'MQTT',
        signals: [{ name: 'Both', protocolAddress: '', type: 'PLCOutputBool', record: false }],
        topics: [
          { topic: 'plant/a', mode: 'ProcessImage', signals: [{ name: 'InTopic', protocolAddress: '', type: 'PLCOutputBool', record: false }] },
          { topic: 'plant/b', mode: 'ProcessImage', signals: [{ name: 'Both', protocolAddress: '', type: 'PLCOutputBool', record: false }] },
        ],
      }),
      model: [model('InTopic'), model('Both')],
      discovered: [disc('InTopic', '%I0.0'), disc('Both', '%I0.1')],
    });
    expect(plan.rows.map(r => [r.name, r.status, r.topic])).toEqual([
      ['InTopic', 'fill', 'plant/a'], ['Both', 'ambiguous', undefined],
    ]);
    expect(fillAddressOps(plan)[0]).toMatchObject({ topic: 'plant/a', name: 'InTopic' });
  });
});

describe('planFillAddresses — OPC UA', () => {
  it('writes the NodeId (protocolAddress), not the browse path, and only an allowed data type', () => {
    const plan = planFillAddresses({
      iface: iface({ type: 'OpcUa' }),
      model: [model('Line.Conveyor.Run'), model('Line.Conveyor.Speed', 'PLCOutputFloat')],
      discovered: [
        { ...disc('Line.Conveyor.Run', 'ns=2;s=Line.Conveyor.Run', 'output', 'Boolean'), browsePath: 'Objects/Line/Conveyor/Run' },
        { ...disc('Line.Conveyor.Speed', 'ns=2;i=4711', 'output', 'Double'), browsePath: 'Objects/Line/Conveyor/Speed' },
      ],
      schema: schema({ dataTypes: ['Bool', 'Float', 'Int'] }),
    });
    const ops = fillAddressOps(plan);
    expect(ops.map(o => o.protocolAddress)).toEqual(['ns=2;s=Line.Conveyor.Run', 'ns=2;i=4711']);
    // 'Boolean' / 'Double' are not in this schema's list → not sent (the gateway would refuse them).
    expect(ops.every(o => o.dataType === undefined)).toBe(true);
  });
});

describe('supportsFillAddresses', () => {
  it('follows supportsDiscovery and never offers FMI', () => {
    expect(supportsFillAddresses(schema({ supportsDiscovery: true }), false)).toBe(true);
    expect(supportsFillAddresses(schema({ supportsDiscovery: false }), false)).toBe(false); // FANUC
    expect(supportsFillAddresses(null, false)).toBe(false);
    expect(supportsFillAddresses(schema(), true)).toBe(false);
  });
});

describe('legacy adopt stays as it was (S7 / PLCSIM), now as fillEmpty ops', () => {
  it('S7: comment addresses, merge-only, address never in the comment', () => {
    const models: ModelPlcSignal[] = [
      { name: 'Lamp', localName: 'Lamp', type: 'PLCOutputBool', comment: '%Q0.1 · Lamp green' },
      { name: 'Set', localName: 'Set', type: 'PLCOutputBool', comment: '%Q0.2 · Already set' },
      { name: 'Empty', localName: 'Empty', type: 'PLCOutputBool', comment: '%Q0.3' },
    ];
    const existing = [
      { name: 'Set', protocolAddress: '%Q9.9', type: 'PLCOutputBool', record: true },
      { name: 'Empty', protocolAddress: '', type: 'PLCOutputBool', record: true },
    ];
    const report = matchPlcSignals(models, { signals: existing }, 'S7');
    expect(legacyAdoptOps('s7', report, existing)).toEqual([
      {
        op: 'signal.upsert', interfaceId: 's7', name: 'Lamp', type: 'PLCOutputBool', protocolAddress: '%Q0.1',
        addressMode: 'fillEmpty', dataType: 'Bool', comment: 'Lamp green', record: false,
      },
      {
        op: 'signal.upsert', interfaceId: 's7', name: 'Empty', type: 'PLCOutputBool', protocolAddress: '%Q0.3',
        addressMode: 'fillEmpty', dataType: 'Bool',
      },
    ]);
  });

  it('PLCSIM: the PLC spelling of the tag is the address', () => {
    const report = matchPlcSignals(
      [{ name: 'FG01.bEnable', localName: 'FG01.bEnable', type: 'PLCOutputBool' }],
      { signals: [], discovered: [{ tag: '"FG01".bEnable', direction: 'output', dataType: 'Bool' }] },
      'PlcSimAdvanced',
    );
    expect(legacyAdoptOps('sim', report, [])).toEqual([{
      op: 'signal.upsert', interfaceId: 'sim', name: 'FG01.bEnable', type: 'PLCOutputBool',
      protocolAddress: '"FG01".bEnable', addressMode: 'fillEmpty', dataType: 'Bool', record: false,
    }]);
  });
});

describe('plan-2025 P7 review fix 7 — direction of the configured CONNECT signal', () => {
  it('an existing CONNECT signal of the other direction is a non-writable conflict, even with an empty address', () => {
    const plan = planFillAddresses({
      iface: iface({
        signals: [
          { name: 'MAIN.bStart', protocolAddress: '', type: 'PLCInputBool', record: false },
          { name: 'MAIN.bOk', protocolAddress: '', type: 'PLCOutputBool', record: false },
        ],
      }),
      model: [model('MAIN.bStart', 'PLCOutputBool'), model('MAIN.bOk', 'PLCOutputBool')],
      discovered: [disc('MAIN.bStart', 'MAIN.bStart', 'unknown'), disc('MAIN.bOk', 'MAIN.bOk', 'unknown')],
      schema: schema(),
    });
    expect(plan.rows.map(r => [r.name, r.status])).toEqual([['MAIN.bStart', 'direction-conflict'], ['MAIN.bOk', 'fill']]);
    expect(plan.rows[0].reason).toMatch(/configured as PLCInputBool, the model signal is PLCOutputBool/);
    expect(fillAddressOps(plan).map(o => o.name)).toEqual(['MAIN.bOk']);
  });

  it('also inside an MQTT topic', () => {
    const plan = planFillAddresses({
      iface: iface({
        type: 'MQTT', signals: [],
        topics: [{ topic: 't', mode: 'ProcessImage', signals: [{ name: 'X', protocolAddress: '', type: 'PLCOutputInt', record: false }] }],
      } as Partial<ConnectInterface>),
      model: [model('X', 'PLCInputInt')],
      discovered: [disc('X', '%IW2', 'unknown')],
      schema: schema(),
    });
    expect(plan.rows[0]).toMatchObject({ status: 'direction-conflict', topic: 't' });
    expect(fillAddressOps(plan)).toEqual([]);
  });
});
