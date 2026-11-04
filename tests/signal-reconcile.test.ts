// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-589 test 9.5 — the read-only reconcile report.
 *
 * The categories are a CONTRACT, not a presentation detail: `mapped` must mean "the gateway
 * really couples these two", `no-address` must only appear where the gateway said it needs one,
 * and a quoting variant must never be sold as a coupling. Each test below pins one of those.
 */

import { describe, it, expect } from 'vitest';
import {
  reconcileSignals,
  signalTypeCompat,
  creatablePlcOnly,
  UNSUPPORTED_TYPE_HINT,
} from '../src/core/import/rv-signal-reconcile';
import type { ConnectInterface, ConnectSignalSchema } from '../src/core/hmi/connect-store';
import type { ModelPlcSignal } from '../src/core/import/rv-plc-automap';

/** An interface literal without retyping the 30 optional protocol blocks. */
function ifaceOf(partial: Partial<ConnectInterface> & { id: string; type: string }): ConnectInterface {
  return { enabled: true, signals: [], ...partial } as unknown as ConnectInterface;
}

function sig(name: string, type: string, extra: Record<string, unknown> = {}) {
  return { name, type, protocolAddress: '', record: false, ...extra };
}

function modelSig(name: string, type: string, extra: Partial<ModelPlcSignal> = {}): ModelPlcSignal {
  return { name, localName: name, type, ...extra };
}

const REQUIRED: ConnectSignalSchema = { addressRule: { signals: 'required' } } as ConnectSignalSchema;

describe('reconcileSignals', () => {
  // The plan's own example (§9.5) — must work verbatim.
  it('flags a signal without address as no-address only when the schema requires one', () => {
    const iface = { id: 's7', type: 'S7', signals: [{ name: 'DB_FG01.Start', protocolAddress: '', type: 'PLCOutputBool' }] } as any;
    const model = [{ name: 'DB_FG01.Start', localName: 'DB_FG01.Start', type: 'PLCOutputBool' }] as any;
    expect(reconcileSignals(model, iface, { addressRule: { signals: 'required' } } as any).entries[0].category).toBe('no-address');
    expect(reconcileSignals(model, iface, undefined).entries[0].category).toBe('mapped');
  });

  it('reports all six categories from one interface', () => {
    const iface = ifaceOf({
      id: 's7', type: 'S7',
      signals: [
        sig('Cell.Start', 'PLCOutputBool', { protocolAddress: 'DB10.DBX4.1' }),   // mapped
        sig('"DB".Member', 'PLCOutputBool', { protocolAddress: 'DB10.DBX4.2' }),  // name-variant
        sig('Cell.Speed', 'PLCOutputFloat', { protocolAddress: 'DB10.DBD8', dataType: 'Real' }), // type-mismatch
        sig('Cell.Lamp', 'PLCOutputBool'),                                        // no-address
        sig('Cell.Ghost', 'PLCInputBool', { protocolAddress: 'DB10.DBX6.0' }),     // plc-only
      ],
    });
    const model: ModelPlcSignal[] = [
      modelSig('Cell.Start', 'PLCOutputBool'),
      modelSig('DB.Member', 'PLCOutputBool'),
      modelSig('Cell.Speed', 'PLCOutputInt', { originDataType: 'DINT' }),
      modelSig('Cell.Lamp', 'PLCOutputBool'),
      modelSig('Cell.Orphan', 'PLCInputBool'),
    ];

    const report = reconcileSignals(model, iface, REQUIRED);

    expect(report.interfaceId).toBe('s7');
    expect(report.interfaceType).toBe('S7');
    expect(report.counts).toEqual({
      mapped: 1, 'name-variant': 1, 'type-mismatch': 1, 'no-address': 1, 'plc-only': 1, 'missing-in-plc': 1,
    });
    const byCategory = (c: string) => report.entries.filter((e) => e.category === c).map((e) => e.name);
    expect(byCategory('mapped')).toEqual(['Cell.Start']);
    expect(byCategory('name-variant')).toEqual(['"DB".Member']);
    expect(byCategory('missing-in-plc')).toEqual(['Cell.Orphan']);
    expect(byCategory('plc-only')).toEqual(['Cell.Ghost']);
  });

  it('never calls a quoting variant mapped and offers the other spelling as a suggestion', () => {
    const iface = ifaceOf({
      id: 'plcsim', type: 'PlcSimAdvanced',
      signals: [sig('"FG01".bEnable', 'PLCInputBool', { protocolAddress: '"FG01".bEnable' })],
    });
    const report = reconcileSignals([modelSig('FG01.bEnable', 'PLCInputBool')], iface, REQUIRED);
    expect(report.counts.mapped).toBe(0);
    expect(report.counts['name-variant']).toBe(1);
    expect(report.counts['missing-in-plc']).toBe(0);
    expect(report.entries[0].suggestion).toBe('FG01.bEnable');
  });

  it('raises no address warning at all when the gateway states no rule', () => {
    const iface = ifaceOf({ id: 'old', type: 'S7', signals: [sig('Cell.Start', 'PLCOutputBool')] });
    const model = [modelSig('Cell.Start', 'PLCOutputBool')];
    expect(reconcileSignals(model, iface, undefined).counts['no-address']).toBe(0);
    expect(reconcileSignals(model, iface, null).counts.mapped).toBe(1);
    // A stated permissive rule is also not a requirement.
    const nameFallback = { addressRule: { signals: 'name-fallback' } } as ConnectSignalSchema;
    expect(reconcileSignals(model, iface, nameFallback).counts.mapped).toBe(1);
  });

  it('treats an OPC-UA signal with an empty NodeId as no-address', () => {
    const iface = ifaceOf({ id: 'ua', type: 'OpcUa', signals: [sig('Cell.Start', 'PLCOutputBool', { protocolAddress: '   ' })] });
    const report = reconcileSignals([modelSig('Cell.Start', 'PLCOutputBool')], iface, REQUIRED);
    expect(report.entries[0].category).toBe('no-address');
  });

  it('reconciles ONE mqtt interface across the legacy container and three topic modes', () => {
    const iface = ifaceOf({
      id: 'mqtt', type: 'MQTT',
      // Legacy single: the topic lives in `protocolAddress`, so the rule is `required`.
      signals: [
        sig('Legacy.Bound', 'PLCOutputBool', { protocolAddress: 'plant/legacy/bound' }),
        sig('Legacy.Unbound', 'PLCOutputBool'),
      ],
      topics: [
        { topic: 'plant/single', mode: 'Single', signals: [sig('Single.Value', 'PLCOutputInt')] },
        { topic: 'plant/json', mode: 'Json', signals: [sig('Json.Value', 'PLCOutputInt')] },
        { topic: 'plant/pi', mode: 'ProcessImage', signals: [
          sig('Pi.Bound', 'PLCOutputBool', { protocolAddress: '%I3.1' }),
          sig('Pi.Unbound', 'PLCOutputBool'),
        ] },
      ],
    });
    const schema = {
      addressRule: {
        signals: 'required',
        topicModes: { Single: 'container-topic', Json: 'none', ProcessImage: 'required' },
      },
    } as ConnectSignalSchema;
    const model = [
      modelSig('Legacy.Bound', 'PLCOutputBool'), modelSig('Legacy.Unbound', 'PLCOutputBool'),
      modelSig('Single.Value', 'PLCOutputInt'), modelSig('Json.Value', 'PLCOutputInt'),
      modelSig('Pi.Bound', 'PLCOutputBool'), modelSig('Pi.Unbound', 'PLCOutputBool'),
    ];

    const report = reconcileSignals(model, iface, schema);

    const category = (name: string) => report.entries.find((e) => e.name === name)?.category;
    expect(category('Legacy.Bound')).toBe('mapped');
    expect(category('Legacy.Unbound')).toBe('no-address');
    // The container carries the address of a Single topic, and a Json topic has none at all.
    expect(category('Single.Value')).toBe('mapped');
    expect(category('Json.Value')).toBe('mapped');
    expect(category('Pi.Bound')).toBe('mapped');
    expect(category('Pi.Unbound')).toBe('no-address');
    // The slot of a topic signal names its container and mode — the report never flattens them.
    const pi = report.entries.find((e) => e.name === 'Pi.Unbound');
    expect(pi?.slot?.topic).toBe('plant/pi');
    expect(pi?.slot?.mode).toBe('ProcessImage');
    expect(report.counts['no-address']).toBe(2);
  });

  it('keeps two places of the same name in two topics apart', () => {
    const iface = ifaceOf({
      id: 'mqtt', type: 'MQTT',
      topics: [
        { topic: 'a', mode: 'Json', signals: [sig('Shared', 'PLCOutputBool')] },
        { topic: 'b', mode: 'Json', signals: [sig('Shared', 'PLCOutputBool')] },
      ],
    });
    const report = reconcileSignals([modelSig('Shared', 'PLCOutputBool')], iface, REQUIRED);
    expect(report.counts.mapped).toBe(2);
    expect(report.counts['missing-in-plc']).toBe(0);
    expect(report.entries.map((e) => e.slot?.topic)).toEqual(['a', 'b']);
  });

  it('marks a CONNECT string signal as an unsupported type and never offers to create it', () => {
    const iface = ifaceOf({
      id: 's7', type: 'S7',
      signals: [
        sig('Plant.Text', 'PLCOutputText', { protocolAddress: 'DB10.STRING0', dataType: 'String' }),
        sig('Plant.Count', 'PLCOutputInt', { protocolAddress: 'DB10.DBW2', dataType: 'Int' }),
      ],
    });
    const report = reconcileSignals([], iface, REQUIRED);
    expect(report.counts['plc-only']).toBe(2);
    const text = report.entries.find((e) => e.name === 'Plant.Text');
    expect(text?.suggestion).toBe(UNSUPPORTED_TYPE_HINT);
    expect(creatablePlcOnly(report).map((e) => e.name)).toEqual(['Plant.Count']);
  });

  it('never writes: the interface and the model arrays come back untouched', () => {
    const signals = [sig('Cell.Start', 'PLCOutputBool')];
    const iface = ifaceOf({ id: 's7', type: 'S7', signals });
    const model = [modelSig('Cell.Start', 'PLCOutputBool'), modelSig('Cell.Other', 'PLCInputBool')];
    const before = JSON.stringify({ iface, model });
    reconcileSignals(model, iface, REQUIRED);
    expect(JSON.stringify({ iface, model })).toBe(before);
  });
});

describe('signalTypeCompat', () => {
  it('answers unknown when a type is missing on either side', () => {
    expect(signalTypeCompat({ type: '' }, { type: 'PLCOutputBool' })).toBe('unknown');
    expect(signalTypeCompat({ type: 'PLCOutputBool' }, { type: '' })).toBe('unknown');
    // Direction and kind agree, but no data type is stated — not a mismatch.
    expect(signalTypeCompat({ type: 'PLCOutputInt' }, { type: 'PLCOutputInt' })).toBe('unknown');
    expect(signalTypeCompat({ type: 'PLCOutputInt', originDataType: 'DINT' }, { type: 'PLCOutputInt' })).toBe('unknown');
    // A data type name this table does not know is also "not stated".
    expect(signalTypeCompat(
      { type: 'PLCOutputInt', originDataType: 'DINT' }, { type: 'PLCOutputInt', dataType: 'TON' },
    )).toBe('unknown');
  });

  it('accepts the Siemens integer and float families as one kind each', () => {
    for (const [a, b] of [['DINT', 'Int'], ['UDINT', 'DInt'], ['INT', 'Word'], ['SINT', 'Byte']]) {
      expect(signalTypeCompat(
        { type: 'PLCOutputInt', originDataType: a }, { type: 'PLCOutputInt', dataType: b },
      )).toBe('ok');
    }
    for (const [a, b] of [['REAL', 'Real'], ['LREAL', 'Float'], ['REAL', 'LReal']]) {
      expect(signalTypeCompat(
        { type: 'PLCInputFloat', originDataType: a }, { type: 'PLCInputFloat', dataType: b },
      )).toBe('ok');
    }
    expect(signalTypeCompat(
      { type: 'PLCOutputBool', originDataType: 'BOOL' }, { type: 'PLCOutputBool', dataType: 'Bool' },
    )).toBe('ok');
  });

  it('reports a direction change, a value-kind change and a data-type family change as mismatch', () => {
    expect(signalTypeCompat({ type: 'PLCOutputBool' }, { type: 'PLCInputBool' })).toBe('mismatch');
    expect(signalTypeCompat({ type: 'PLCOutputInt' }, { type: 'PLCOutputFloat' })).toBe('mismatch');
    expect(signalTypeCompat(
      { type: 'PLCOutputInt', originDataType: 'DINT' }, { type: 'PLCOutputInt', dataType: 'Real' },
    )).toBe('mismatch');
  });
});

describe('reconcile performance', () => {
  /** 20 000 model signals, half Bool / half Int, with origin data types. */
  function bigModel(): ModelPlcSignal[] {
    const model: ModelPlcSignal[] = [];
    for (let i = 0; i < 20_000; i++) {
      model.push(modelSig(
        `DB_FG01.Signal_${i}`,
        i % 2 ? 'PLCOutputBool' : 'PLCInputInt',
        { originDataType: i % 2 ? 'BOOL' : 'DINT' },
      ));
    }
    return model;
  }

  /**
   * `count` places taken from the model starting at `from`; every 10th is a name the model does
   * not carry, so the run really walks the plc-only branch instead of one fast path.
   */
  function ifaceOver(id: string, model: readonly ModelPlcSignal[], from: number, count: number): ConnectInterface {
    const signals = [];
    for (let i = 0; i < count; i++) {
      const m = model[(from + i) % model.length];
      signals.push(sig(
        i % 10 === 0 ? `Ghost_${id}_${i}` : m.name,
        m.type,
        { protocolAddress: `DB1.DBX${i}.0`, dataType: i % 2 ? 'Bool' : 'Int' },
      ));
    }
    return ifaceOf({ id, type: 'S7', signals });
  }

  it('reconciles 20 000 model signals against 5 interfaces in under 50 ms (median of 5, warm-up discarded)', () => {
    const model = bigModel();
    // The §1 case: the model's 20 000 signals spread over five interfaces.
    const interfaces = [0, 1, 2, 3, 4].map((n) => ifaceOver(`iface${n}`, model, n * 4_000, 4_000));

    /** One full §1 pass; returns the row count so the work cannot be optimised away. */
    const pass = (): number => {
      let rows = 0;
      for (const iface of interfaces) rows += reconcileSignals(model, iface, REQUIRED).entries.length;
      return rows;
    };

    // Warm-up, not measured: a first cold pass measures JIT warm-up, not the reconcile cost.
    // Same reasoning (and the same shape) as tests/drop-registry-benchmark.test.ts.
    const rows = pass();
    // 20 000 places + the model signals each interface does not carry.
    expect(rows).toBeGreaterThan(20_000);

    const samples: number[] = [];
    for (let run = 0; run < 5; run++) {
      const t0 = performance.now();
      expect(pass()).toBe(rows);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const median = samples[2];

    console.info(
      `[plan-589] reconcile 20 000 signals x 5 interfaces: ${median.toFixed(1)} ms `
      + `(median of 5; samples ${samples.map((s) => s.toFixed(1)).join(', ')})`,
    );
    expect(median).toBeLessThan(50);
  });

  it('stays linear when every one of the 5 interfaces carries all 20 000 signals (median of 5, warm-up discarded)', () => {
    const model = bigModel();
    const interfaces = [0, 1, 2, 3, 4].map((n) => ifaceOver(`all${n}`, model, 0, 20_000));

    const pass = (): number => {
      let n = 0;
      for (const iface of interfaces) n += reconcileSignals(model, iface, REQUIRED).entries.length;
      return n;
    };
    // Warm-up, not measured: a single cold pass measures JIT warm-up and allocation of the first
    // 100 000 rows, which is what made this bound flaky. Median of 5 warm passes instead.
    const rows = pass();

    const samples: number[] = [];
    for (let run = 0; run < 5; run++) {
      const t0 = performance.now();
      expect(pass()).toBe(rows);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const median = samples[2];

    // 100 000 rows - five times the section 1 case. The bound is deliberately loose (the cost here
    // is allocating the rows themselves); what it catches is a nested scan, which would need minutes.
    expect(rows).toBeGreaterThan(100_000);
    console.info(`[plan-589] reconcile 100 000 rows: ${median.toFixed(1)} ms `
      + `(median of 5; samples ${samples.map((x) => x.toFixed(1)).join(', ')})`);
    expect(median).toBeLessThan(400);
  });
});
