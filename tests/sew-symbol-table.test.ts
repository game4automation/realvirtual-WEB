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
