// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2025 F12 / §9 `rv-address-table-import` — the address table as an address source.
 *
 * Separators, header, column mapping, container per row or for the whole import, the rejections
 * (missing / unknown / ambiguous container, address rule, protocol check, data type, direction) and
 * that the import is exactly ONE batch of `signal.upsert`.
 */

import { describe, expect, it } from 'vitest';
import {
  addressImportOps,
  detectDelimiter,
  parseAddressTable,
  planAddressTableImport,
  rowsToValidate,
  splitLine,
  type AddressImportOptions,
} from '../src/core/import/rv-address-table-import';
import type { ConnectInterface, ConnectSignalSchema, SignalValidationResult } from '../src/core/hmi/connect-store';

const MQTT_SCHEMA: ConnectSignalSchema = {
  supportsDiscovery: true, supportsManualAdd: true, addressValidatable: true, directionFromAddress: false,
  addressLabel: 'Topic', addressHint: '', addressExamples: [], dataTypes: ['Bool', 'Int', 'Float', 'String'],
  addressRule: { signals: 'required', topicModes: { Single: 'container-topic', Json: 'none', ProcessImage: 'required' } },
};
const S7_SCHEMA: ConnectSignalSchema = {
  supportsDiscovery: true, supportsManualAdd: true, addressValidatable: true, directionFromAddress: true,
  addressLabel: 'Address', addressHint: '', addressExamples: [], dataTypes: ['Bool', 'Int', 'Real'],
  addressRule: { signals: 'required' },
};
const sig = (name: string, protocolAddress = '') => ({ name, protocolAddress, type: 'PLCOutputBool', record: false });

const MQTT: ConnectInterface = {
  id: 'mqtt-1', type: 'MQTT', enabled: true,
  signals: [sig('Flat.Done', 'plant/flat/done')],
  topics: [
    { topic: 'plant/pi', mode: 'ProcessImage', signals: [sig('Cell.Lamp')] },
    { topic: 'plant/pi2', mode: 'ProcessImage', signals: [sig('Cell.Twice')] },
    { topic: 'plant/pi3', mode: 'ProcessImage', signals: [sig('Cell.Twice')] },
    { topic: 'plant/json', mode: 'Json', signals: [] },
  ],
} as ConnectInterface;

const opts = (over: Partial<AddressImportOptions> = {}): AddressImportOptions =>
  ({ container: { kind: 'per-row' }, existing: 'fillEmpty', defaultDirection: null, ...over });

describe('parseAddressTable', () => {
  it('detects ; , and tab, and skips empty and # lines', () => {
    expect(detectDelimiter('a;b\n')).toBe(';');
    expect(detectDelimiter('# x\na,b\n')).toBe(',');
    expect(detectDelimiter('a\tb;c\n')).toBe('\t');
    const t = parseAddressTable('# comment\n\nA;%I0.0\r\nB;%I0.1;Bool\n');
    expect(t.header).toBeNull();
    expect(t.rows.map(r => [r.line, r.cells])).toEqual([[3, ['A', '%I0.0']], [4, ['B', '%I0.1', 'Bool']]]);
    expect(t.columns).toEqual({ name: 0, address: 1, dataType: 2, topic: null });
  });

  it('reads a header in any column order', () => {
    const t = parseAddressTable('Address\tTopic\tName\nplant/x\tplant/pi\tCell.Lamp\n');
    expect(t.header).toEqual(['Address', 'Topic', 'Name']);
    expect(t.columns).toEqual({ name: 2, address: 0, dataType: null, topic: 1 });
  });

  it('keeps TIA quotes literal but understands real CSV quoting', () => {
    expect(splitLine('"DB1".Start;DB1.DBX0.0', ';')).toEqual(['"DB1".Start', 'DB1.DBX0.0']);
    expect(splitLine('"a;b";"say ""hi""";x', ';')).toEqual(['a;b', 'say "hi"', 'x']);
  });
});

describe('planAddressTableImport — containers', () => {
  it('per row: topic column picks the container; unknown, missing and ambiguous containers are rejected', () => {
    const table = parseAddressTable([
      'name;address;dataType;topic',
      'Cell.Lamp;%Q0.1;Bool;plant/pi',
      'Cell.Nope;%Q0.2;Bool;plant/unknown',
      'Cell.Lamp;%Q0.3;Bool;',
      'Cell.Twice;%Q0.4;Bool;',
      'New.One;plant/new/one;Bool;',
    ].join('\n'));
    const plan = planAddressTableImport({
      table, iface: MQTT, schema: MQTT_SCHEMA, options: opts({ defaultDirection: 'output' }),
    });
    expect(plan.rows.map(r => [r.line, r.status])).toEqual([
      [2, 'update'], [3, 'rejected'], [4, 'rejected'], [5, 'rejected'], [6, 'create'],
    ]);
    expect(plan.rows[1].reason).toMatch(/Unknown container/);
    expect(plan.rows[2].reason).toMatch(/Missing container: 'Cell.Lamp' lives in topic 'plant\/pi'/);
    expect(plan.rows[3].reason).toMatch(/Ambiguous container/);
    expect(plan.rows[4].type).toBe('PLCOutputBool');
    expect(plan.rows[4].topic).toBeUndefined();
  });

  it('one container for the whole import; address rules of the place are enforced', () => {
    const table = parseAddressTable('Cell.Lamp;%Q0.1\nCell.Bad;not-an-offset\nCell.Empty;\n');
    const plan = planAddressTableImport({
      table, iface: MQTT, schema: MQTT_SCHEMA,
      options: opts({ container: { kind: 'topic', topic: 'plant/pi' }, defaultDirection: 'output' }),
    });
    expect(plan.rows.map(r => r.status)).toEqual(['update', 'rejected', 'rejected']);
    expect(plan.rows[1].reason).toMatch(/process-image address/);
    expect(plan.rows[2].reason).toMatch(/Address missing/);

    const json = planAddressTableImport({
      table: parseAddressTable('Speed;something\nSpeed2;\n'), iface: MQTT, schema: MQTT_SCHEMA,
      options: opts({ container: { kind: 'topic', topic: 'plant/json' }, defaultDirection: 'output' }),
    });
    expect(json.rows.map(r => r.status)).toEqual(['rejected', 'create']);
    expect(json.rows[0].reason).toMatch(/keys its JSON object by the signal name/);
  });
});

describe('planAddressTableImport — values', () => {
  const S7: ConnectInterface = {
    id: 's7', type: 'S7', enabled: true,
    signals: [sig('Has', '%Q1.0'), sig('Empty', '')],
  } as ConnectInterface;

  it('FillEmpty keeps a different address, Overwrite replaces it; equal rows are unchanged', () => {
    const table = parseAddressTable('Has;%Q2.0\nEmpty;%Q3.0\n');
    const keep = planAddressTableImport({ table, iface: S7, schema: S7_SCHEMA, options: opts({ container: { kind: 'flat' } }) });
    expect(keep.rows.map(r => r.status)).toEqual(['kept', 'update']);
    const over = planAddressTableImport({ table, iface: S7, schema: S7_SCHEMA, options: opts({ container: { kind: 'flat' }, existing: 'overwrite' }) });
    expect(over.rows.map(r => r.status)).toEqual(['update', 'update']);
    const same = planAddressTableImport({ table: parseAddressTable('Has;%Q1.0\n'), iface: S7, schema: S7_SCHEMA, options: opts({ container: { kind: 'flat' } }) });
    expect(same.rows[0].status).toBe('unchanged');
  });

  it('rejects a protocol-invalid address, a data type outside the schema and an unknown direction', () => {
    const table = parseAddressTable('A;%XYZ\nB;%Q0.0;Word\nC;%M0.0\nD;%I0.0\n');
    const validation = new Map<number, SignalValidationResult | null>([
      [1, { checked: true, valid: false, error: 'bad area' }],
      [3, { checked: true, valid: true, effectiveType: null }],
      [4, { checked: true, valid: true, effectiveType: 'PLCInputBool', normalizedAddress: '%I0.0' }],
    ]);
    const plan = planAddressTableImport({
      table, iface: S7, schema: S7_SCHEMA, options: opts({ container: { kind: 'flat' } }), validation,
    });
    expect(plan.rows.map(r => r.status)).toEqual(['rejected', 'rejected', 'rejected', 'create']);
    expect(plan.rows[0].reason).toBe('Invalid address: bad area');
    expect(plan.rows[1].reason).toMatch(/Data type 'Word' is not allowed/);
    expect(plan.rows[2].reason).toMatch(/Direction unknown/);
    expect(plan.rows[3].type).toBe('PLCInputBool');
  });

  it('takes the wire type from the model signal of the same name; refuses names configured elsewhere; first duplicate wins', () => {
    const table = parseAddressTable('Model.Speed;%QD4;Real\nOther.Iface;%Q5.0\nModel.Speed;%QD8\n');
    const plan = planAddressTableImport({
      table, iface: S7, schema: S7_SCHEMA, options: opts({ container: { kind: 'flat' } }),
      model: [{ name: 'Model.Speed', localName: 'Model.Speed', type: 'PLCOutputFloat' }],
      otherInterfaces: [{ id: 'x', type: 'S7', enabled: true, signals: [sig('Other.Iface', '%Q9.0')] } as ConnectInterface],
    });
    expect(plan.rows.map(r => [r.status, r.type])).toEqual([['create', 'PLCOutputFloat'], ['rejected', undefined], ['rejected', undefined]]);
    expect(plan.rows[2].reason).toMatch(/Duplicate row/);
  });

  it('builds exactly one batch of upserts for the accepted rows', () => {
    const table = parseAddressTable('Empty;%Q3.0\nNew;%Q4.0;Bool\nBroken;\n');
    const plan = planAddressTableImport({
      table, iface: S7, schema: S7_SCHEMA, options: opts({ container: { kind: 'flat' }, defaultDirection: 'output' }),
    });
    expect(addressImportOps(plan)).toEqual([
      { op: 'signal.upsert', interfaceId: 's7', name: 'Empty', protocolAddress: '%Q3.0', addressMode: 'fillEmpty' },
      { op: 'signal.upsert', interfaceId: 's7', name: 'New', protocolAddress: '%Q4.0', addressMode: 'fillEmpty', dataType: 'Bool', type: 'PLCOutputBool', record: false },
    ]);
  });

  it('asks the gateway to check only flat-list addresses of a validatable type', () => {
    const table = parseAddressTable('name;address;topic\nA;%Q0.0;\nB;x;plant/pi\nC;;\n');
    expect(rowsToValidate(table, S7, S7_SCHEMA, opts()).map(r => r.line)).toEqual([2]);
    expect(rowsToValidate(table, S7, { ...S7_SCHEMA, addressValidatable: false }, opts())).toEqual([]);
  });

  it('does not check rows that cannot write (unchanged, or kept under fill-empty)', () => {
    // Has = %Q1.0 already, Empty has no address: row 1 unchanged, row 2 kept, rows 3 and 4 write.
    const table = parseAddressTable('Has;%Q1.0\nHas;%Q9.0\nEmpty;%Q3.0\nNew;%Q4.0\n');
    const flat = { container: { kind: 'flat' } } as const;
    expect(rowsToValidate(table, S7, S7_SCHEMA, opts(flat)).map(r => r.address)).toEqual(['%Q3.0', '%Q4.0']);
    expect(rowsToValidate(table, S7, S7_SCHEMA, opts({ ...flat, existing: 'overwrite' })).map(r => r.address))
      .toEqual(['%Q9.0', '%Q3.0', '%Q4.0']);
  });
});

describe('plan-2025 P7 review fix 6 — separators outside quotes, explicit choice', () => {
  it('a semicolon inside a quoted OPC UA NodeId does not make it a semicolon table', () => {
    const text = 'Motor,"ns=2;s=Motor",Bool\nPump,"ns=2;s=Pump",Bool\n';
    expect(detectDelimiter(text)).toBe(',');
    const t = parseAddressTable(text);
    expect(t.delimiter).toBe(',');
    expect(t.rows.map(r => r.cells)).toEqual([['Motor', 'ns=2;s=Motor', 'Bool'], ['Pump', 'ns=2;s=Pump', 'Bool']]);
  });

  it('BOM and CRLF: the separator is still found and no cell carries them', () => {
    const text = '\uFEFFName,Address\r\nMotor,"ns=2;s=Motor"\r\nLamp,"ns=2;s=""quoted"""\r\n';
    expect(detectDelimiter(text)).toBe(',');
    const t = parseAddressTable(text);
    expect(t.header).toEqual(['Name', 'Address']);
    expect(t.rows.map(r => r.cells)).toEqual([['Motor', 'ns=2;s=Motor'], ['Lamp', 'ns=2;s="quoted"']]);
  });

  it('a TIA symbol with its own quotes keeps the separator outside them', () => {
    expect(detectDelimiter('"DB1".Start,%I0.0\n')).toBe(',');
    expect(detectDelimiter('"DB1".Start;%I0.0\n')).toBe(';');
  });

  it('an explicit separator overrides the detection', () => {
    const text = 'A;B,C;D\n';
    expect(parseAddressTable(text).delimiter).toBe(';');
    expect(parseAddressTable(text, ',').rows[0].cells).toEqual(['A;B', 'C;D']);
    expect(parseAddressTable(text, 'auto').rows[0].cells).toEqual(['A', 'B,C', 'D']);
    expect(parseAddressTable('A\tB\n', '\t').rows[0].cells).toEqual(['A', 'B']);
  });
});
