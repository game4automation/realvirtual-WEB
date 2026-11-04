// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-457 §9.3 — the SEW symbol-table parser.
 *
 * The table is `Name;Typ;Richtung` with no address column. What must hold: the
 * mapping is the Unity `SEWSimInterface.ImportSignalsFromCSV()` mapping, a bad
 * row is an error for THAT row only, and the two derived Json topics carry
 * explicit PLCInput / PLCOutput types (a Json signal has no address to derive a
 * direction from).
 */

import { describe, expect, it } from 'vitest';
import {
  buildJsonTopicsFromRows,
  buildUdpSignalsFromSewRows,
  detectFormat,
  parseSewSymbolTable,
} from '../src/core/import/sew-symbol-table';

const SEMICOLON = [
  'Name;Type;Direction',
  'Speed;INT;PLC_OUT',
  'Temperature;REAL;PLC_OUT',
  'Enable;BOOL;PLC_IN',
  'Message;STRING;PLC_IN',
].join('\n');

describe('parseSewSymbolTable', () => {
  it('parses semicolon file with header skip', () => {
    const { rows, errors } = parseSewSymbolTable(SEMICOLON);
    expect(errors).toEqual([]);
    expect(rows.map(r => r.name)).toEqual(['Speed', 'Temperature', 'Enable', 'Message']);
    // The header line is consumed, never parsed as a signal called "Name".
    expect(rows.some(r => r.name === 'Name')).toBe(false);
    expect(rows[0]).toMatchObject({ type: 'INT', direction: 'PLC_OUT', line: 2 });
  });

  it('autodetects comma and tab', () => {
    const comma = parseSewSymbolTable('Name,Type,Direction\nSpeed,INT,PLC_OUT');
    expect(comma.rows).toHaveLength(1);
    expect(comma.rows[0].name).toBe('Speed');

    const tab = parseSewSymbolTable('Name\tType\tDirection\nSpeed\tINT\tPLC_OUT');
    expect(tab.rows).toHaveLength(1);
    expect(tab.rows[0].name).toBe('Speed');
  });

  it('maps STRING/WSTRING to TEXT', () => {
    const { rows, errors } = parseSewSymbolTable(
      'Name;Type;Direction\nA;STRING;PLC_IN\nB;WSTRING;PLC_IN\nC;TEXT;PLC_IN',
    );
    expect(errors).toEqual([]);
    expect(rows.map(r => r.type)).toEqual(['TEXT', 'TEXT', 'TEXT']);
  });

  it('reports unknown type and direction per line and continues', () => {
    const { rows, errors } = parseSewSymbolTable([
      'Name;Type;Direction',
      'Good;INT;PLC_OUT',
      'BadType;LREAL;PLC_OUT',
      'BadDir;INT;PLC_SIDEWAYS',
      'AlsoGood;BOOL;PLC_IN',
    ].join('\n'));

    // The import ran to the end — the two good rows survived the two bad ones.
    expect(rows.map(r => r.name)).toEqual(['Good', 'AlsoGood']);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ line: 3 });
    expect(errors[0].reason).toContain('LREAL');
    expect(errors[1]).toMatchObject({ line: 4 });
    expect(errors[1].reason).toContain('PLC_SIDEWAYS');
  });

  it('skips rows with fewer than 3 columns', () => {
    const { rows, errors } = parseSewSymbolTable(
      'Name;Type;Direction\nSpeed;INT\nEnable;BOOL;PLC_IN',
    );
    expect(rows.map(r => r.name)).toEqual(['Enable']);
    expect(errors).toHaveLength(1);
    expect(errors[0].line).toBe(2);
  });
});

describe('buildJsonTopicsFromRows', () => {
  it('splits PLC_OUT into receive topic and PLC_IN into publish topic with explicit types', () => {
    const { rows } = parseSewSymbolTable(SEMICOLON);
    const topics = buildJsonTopicsFromRows(rows);

    expect(topics).toHaveLength(2);
    const [receive, publish] = topics;

    expect(receive.topic).toBe('SEW/SimOUT');
    expect(receive.mode).toBe('Json');
    expect(receive.encoding).toBe('Auto');
    expect(receive.retained).toBe(false);
    // A receive-only topic has no cyclic publish loop.
    expect(receive.publishIntervalMs).toBeUndefined();
    expect(receive.signals.map(s => [s.name, s.type])).toEqual([
      ['Speed', 'PLCOutputInt'],
      ['Temperature', 'PLCOutputFloat'],
    ]);
    // Json signals carry no address — the key IS the name.
    expect(receive.signals.every(s => s.protocolAddress === '')).toBe(true);

    expect(publish.topic).toBe('SEW/SimIN');
    expect(publish.encoding).toBe('WString');
    expect(publish.publishIntervalMs).toBe(100);
    expect(publish.signals.map(s => [s.name, s.type])).toEqual([
      ['Enable', 'PLCInputBool'],
      ['Message', 'PLCInputText'],
    ]);
  });

  it('honors explicit topic names, encodings and interval', () => {
    const { rows } = parseSewSymbolTable(SEMICOLON);
    const [receive, publish] = buildJsonTopicsFromRows(rows, {
      receiveTopic: 'plant/out',
      publishTopic: 'plant/in',
      receiveEncoding: 'WString',
      publishEncoding: 'Utf8',
      publishIntervalMs: 50,
    });
    expect(receive.topic).toBe('plant/out');
    expect(receive.encoding).toBe('WString');
    expect(publish.topic).toBe('plant/in');
    expect(publish.encoding).toBe('Utf8');
    expect(publish.publishIntervalMs).toBe(50);
  });

  it('omits a side that has no signals', () => {
    const { rows } = parseSewSymbolTable('Name;Type;Direction\nSpeed;INT;PLC_OUT');
    const topics = buildJsonTopicsFromRows(rows);
    expect(topics).toHaveLength(1);
    expect(topics[0].topic).toBe('SEW/SimOUT');
  });
});

describe('detectFormat', () => {
  it('returns sew for a direction column without an address column', () => {
    expect(detectFormat(SEMICOLON)).toBe('sew');
    expect(detectFormat('Name,Type,Direction\nSpeed,INT,PLC_OUT')).toBe('sew');
  });

  it('returns s7 for a Siemens tag table', () => {
    expect(detectFormat('Name;Type;Address\nMotor_Start;Bool;%I0.0\nTemp;Word;%IW13')).toBe('s7');
    // A table with BOTH a direction column and addresses is a tag table.
    expect(detectFormat('Name;Type;Address;Dir\nMotor;Bool;%I0.0;PLC_IN')).toBe('s7');
    // No direction column at all → s7.
    expect(detectFormat('Name;Type\nSpeed;INT')).toBe('s7');
  });
});

// Mirrored from the CONNECT repo: tests/Connect.Tests/Protocols/Udp/TestData/udp-symbols.csv
// (plan-2228 Phase 1, including the two appended reserved-name rows).
const UDP_SYMBOLS = `Name;Type;Direction
SpeedSetpoint;REAL;PLC_IN
CurrentSpeed;REAL;PLC_OUT
StartButton;BOOL;PLC_IN
RunningStatus;bool;PLC_OUT

ErrorCode;INT;PLC_OUT
Message;STRING;PLC_OUT
TargetPosition;INT;plc_in
Sideways;BOOL;PLC_BOTH
Short;BOOL
;INT;PLC_IN
SpeedSetpoint;BOOL;PLC_OUT
`;

describe('buildUdpSignalsFromSewRows (plan-2228)', () => {
  it('(a) matches the C# fixture addresses and reports reserved and unsupported rows', () => {
    const parsed = parseSewSymbolTable(UDP_SYMBOLS);
    const before = structuredClone(parsed);
    const { signals, skipped } = buildUdpSignalsFromSewRows(parsed);
    expect(signals.map(s => [s.name, s.protocolAddress, s.type])).toEqual([
      ['SpeedSetpoint', '0:REAL', 'PLCInputFloat'],
      ['CurrentSpeed', '0:REAL', 'PLCOutputFloat'],
      ['StartButton', '4:BOOL', 'PLCInputBool'],
      ['RunningStatus', '4:BOOL', 'PLCOutputBool'],
      ['ErrorCode', '5:INT', 'PLCOutputInt'],
      ['TargetPosition', '5:INT', 'PLCInputInt'],
    ]);
    expect(signals.every(s => s.record === false)).toBe(true);
    expect(signals.map(s => s.dataType)).toEqual(['REAL', 'REAL', 'BOOL', 'BOOL', 'INT', 'INT']);
    expect(skipped).toEqual([
      { line: 8, name: 'Message', reason: 'no fixed size in a UDP telegram' },
      { line: 12, name: '', reason: 'missing name — bytes reserved' },
      { line: 13, name: 'SpeedSetpoint', reason: 'duplicate name — bytes reserved' },
    ]);
    expect(parsed.errors.map(e => e.line)).toEqual([10, 11, 12]);
    expect(parsed).toEqual(before);
  });

  it('(b) TEXT aliases and invalid rows consume no bytes or names', () => {
    const { signals, skipped } = buildUdpSignalsFromSewRows(parseSewSymbolTable([
      'Name;Type;Direction',
      'A;TEXT;PLC_IN',
      'B;STRING;PLC_OUT',
      'C;WSTRING;PLC_IN',
      'Bad;LREAL;PLC_IN',
      'WrongDirection;INT;PLC_BOTH',
      'Short;BOOL',
      'A;int;plc_in',
      'B;real;plc_out',
    ].join('\n')));
    expect(signals.map(s => [s.name, s.protocolAddress])).toEqual([['A', '0:INT'], ['B', '0:REAL']]);
    expect(skipped.map(s => s.line)).toEqual([2, 3, 4]);
    expect(skipped.every(s => s.reason.includes('no fixed size'))).toBe(true);
  });

  it('(c) reserves empty fixed-size names in file order only with valid directions', () => {
    const parsed = parseSewSymbolTable([
      'Name;Type;Direction',
      ';BOOL;PLC_IN',
      'Send;REAL;PLC_IN',
      ';INT;PLC_OUT',
      ';TEXT;PLC_IN',
      ';STRING;PLC_IN',
      ';WSTRING;PLC_OUT',
      ';UNKNOWN;PLC_IN',
      ';INT;PLC_BOTH',
      'Receive;BOOL;PLC_OUT',
      ';REAL;PLC_IN',
      'SendNext;INT;PLC_IN',
    ].join('\n'));
    expect(parsed.reservedRows).toEqual([
      { line: 2, name: '', type: 'BOOL', direction: 'PLC_IN' },
      { line: 4, name: '', type: 'INT', direction: 'PLC_OUT' },
      { line: 11, name: '', type: 'REAL', direction: 'PLC_IN' },
    ]);
    expect(parsed.errors.map(e => e.line)).toEqual([2, 4, 5, 6, 7, 8, 9, 11]);
    const { signals, skipped } = buildUdpSignalsFromSewRows(parsed);
    expect(signals.map(s => [s.name, s.protocolAddress])).toEqual([
      ['Send', '1:REAL'], ['Receive', '4:BOOL'], ['SendNext', '9:INT'],
    ]);
    expect(skipped.map(s => s.line)).toEqual([2, 4, 11]);
  });

  it('(d) reserves duplicates across directions using C# Ordinal case sensitivity', () => {
    const { signals, skipped } = buildUdpSignalsFromSewRows(parseSewSymbolTable([
      'Name;Type;Direction',
      'A;INT;PLC_OUT',
      'A;REAL;PLC_OUT',
      'B;BOOL;PLC_OUT',
      'A;INT;PLC_IN',
      'a;BOOL;PLC_IN',
      'C;REAL;PLC_IN',
    ].join('\n')));
    expect(signals.map(s => [s.name, s.protocolAddress])).toEqual([
      ['A', '0:INT'], ['B', '8:BOOL'], ['a', '4:BOOL'], ['C', '5:REAL'],
    ]);
    expect(skipped).toEqual([
      { line: 3, name: 'A', reason: 'duplicate name — bytes reserved' },
      { line: 5, name: 'A', reason: 'duplicate name — bytes reserved' },
    ]);
  });

  it('(e) accepts end 65507, filters larger fields, and still reserves their bytes and names', () => {
    const parsed = parseSewSymbolTable([
      'Name;Type;Direction',
      ...Array.from({ length: 16376 }, (_, i) => `Padding${i};INT;PLC_IN`),
      'LastThree;BOOL;PLC_IN',
      'LastTwo;BOOL;PLC_IN',
      'LastByte;BOOL;PLC_IN',
      'Overflow;INT;PLC_IN',
      'AfterOverflow;BOOL;PLC_IN',
      'Overflow;INT;PLC_OUT',
      'Receive;REAL;PLC_OUT',
    ].join('\n'));
    const { signals, skipped } = buildUdpSignalsFromSewRows(parsed);
    expect(signals).toHaveLength(16380);
    expect(signals.slice(-4).map(s => [s.name, s.protocolAddress])).toEqual([
      ['LastThree', '65504:BOOL'], ['LastTwo', '65505:BOOL'], ['LastByte', '65506:BOOL'],
      ['Receive', '4:REAL'],
    ]);
    expect(skipped).toEqual([
      { line: 16381, name: 'Overflow', reason: 'beyond the largest UDP datagram (65507 bytes)' },
      { line: 16382, name: 'AfterOverflow', reason: 'beyond the largest UDP datagram (65507 bytes)' },
      { line: 16383, name: 'Overflow', reason: 'duplicate name — bytes reserved' },
    ]);
  });

  it('(f) keeps MQTT rows and errors unchanged, including missing-name error precedence', () => {
    const parsed = parseSewSymbolTable([
      'Name;Type;Direction',
      'Message;STRING;PLC_IN',
      ';INT;PLC_IN',
      ';TEXT;PLC_OUT',
      ';UNKNOWN;PLC_BOTH',
      'Bad;LREAL;PLC_IN',
      'Wrong;INT;SIDEWAYS',
      'Short;BOOL',
      'Enable;BOOL;PLC_OUT',
    ].join('\n'));
    expect(parsed.rows).toEqual([
      { line: 2, name: 'Message', type: 'TEXT', direction: 'PLC_IN' },
      { line: 9, name: 'Enable', type: 'BOOL', direction: 'PLC_OUT' },
    ]);
    expect(parsed.errors).toEqual([
      { line: 3, reason: 'Missing signal name' },
      { line: 4, reason: 'Missing signal name' },
      { line: 5, reason: 'Missing signal name' },
      { line: 6, reason: 'Unknown data type "LREAL"' },
      { line: 7, reason: 'Unknown direction "SIDEWAYS" (expected PLC_IN or PLC_OUT)' },
      { line: 8, reason: 'Row has 2 column(s), expected at least 3 (Name;Type;Direction)' },
    ]);
    const topics = buildJsonTopicsFromRows(parsed.rows);
    expect(topics[0].signals[0]).toMatchObject({ name: 'Enable', type: 'PLCOutputBool', protocolAddress: '' });
    expect(topics[1].signals[0]).toMatchObject({ name: 'Message', type: 'PLCInputText', protocolAddress: '' });
  });
});
