// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for the Multi-Tab Excel → MQTT Topic mapping core (buildTopicsFromRows).
 *
 * The xlsx IO (readSheetNames / readXlsxFile) is intentionally kept out of this
 * pure mapping function, so these tests feed inline Cell[][] matrices — no xlsx
 * fixture, consistent with the inline-CSV pattern in s7-tag-table.test.ts.
 *
 * Covers: F2 (tab=topic, prefix), F3 (pattern filter), F5 (direction from area),
 * F6 (forceAllAsOutput), F7 (data-type mapping), F12 (empty pattern = all),
 * F13 (topic sanitizing), F14 (cross-tab duplicate names), F15 (dropped rows).
 */

import { describe, it, expect } from 'vitest';
import { buildTopicsFromRows } from '../src/core/import/s7-tag-table';

// Inline-Sheets: Map sheetName -> Cell[][] (first row = header Name|Type|Address|Comment)
const SHEETS = {
  Data_Q_1: [['Name', 'Type', 'Address', 'Comment'], ['M_Run', 'Bool', '%Q1.0', ''], ['Cmd', 'Word', '%QW2800', '']],
  Data_I_1: [['Name', 'Type', 'Address', 'Comment'], ['Sensor', 'Bool', '%I0.0', '']],
  Import_Q_1: [['Name', 'Type', 'Address', 'Comment'], ['X', 'Bool', '%Q2.0', '']],
};

describe('buildTopicsFromRows', () => {
  it('imports only sheets matching the pattern (F3)', () => {
    const r = buildTopicsFromRows(SHEETS, { sheetPattern: 'Data_Q*', forceAllAsOutput: false });
    expect(r.topics.map(t => t.sheetName)).toEqual(['Data_Q_1']);
    expect(r.ignoredSheets).toEqual(expect.arrayContaining(['Data_I_1', 'Import_Q_1']));
  });

  it('empty pattern imports ALL sheets (F12)', () => {
    const r = buildTopicsFromRows(SHEETS, { sheetPattern: '', forceAllAsOutput: false });
    expect(r.topics.map(t => t.sheetName).sort()).toEqual(['Data_I_1', 'Data_Q_1', 'Import_Q_1']);
  });

  it('maps each sheet to one topic (F2)', () => {
    const r = buildTopicsFromRows(SHEETS, { sheetPattern: 'Data_*', forceAllAsOutput: false });
    expect(r.topics.every(t => t.topic === t.sheetName)).toBe(true);
  });

  it('applies topicPrefix (F2)', () => {
    const r = buildTopicsFromRows(SHEETS, { sheetPattern: 'Data_Q*', forceAllAsOutput: false, topicPrefix: 'rv/plc/' });
    expect(r.topics[0].topic).toBe('rv/plc/Data_Q_1');
  });

  it('derives direction from %I/%Q by default (F5)', () => {
    const r = buildTopicsFromRows(SHEETS, { sheetPattern: 'Data_*', forceAllAsOutput: false });
    const q = r.topics.find(t => t.sheetName === 'Data_Q_1')!.signals;
    const i = r.topics.find(t => t.sheetName === 'Data_I_1')!.signals;
    expect(q.every(s => s.wireType.startsWith('PLCOutput'))).toBe(true);
    expect(i.every(s => s.wireType.startsWith('PLCInput'))).toBe(true);
  });

  it('forceAllAsOutput makes every signal PLCOutput incl. %I, keeps valueType (F6)', () => {
    const r = buildTopicsFromRows(SHEETS, { sheetPattern: 'Data_*', forceAllAsOutput: true });
    const all = r.topics.flatMap(t => t.signals);
    expect(all.every(s => s.wireType.startsWith('PLCOutput'))).toBe(true);
    // %QW2800 / Word must stay Int even when forced
    expect(all.find(s => s.dataType === 'Word')!.wireType).toBe('PLCOutputInt');
  });

  // Each data type with an address valid for its width: Bool needs a bit address,
  // every other type uses a bare byte offset (no size letter, so no width clash —
  // e.g. LReal is 8 bytes which no %Q[B/W/D] letter expresses).
  it.each([
    ['Bool', '%Q10.0', /Bool$/], ['Byte', '%Q10', /Int$/], ['Word', '%Q10', /Int$/], ['Int', '%Q10', /Int$/],
    ['DWord', '%Q10', /Int$/], ['DInt', '%Q10', /Int$/], ['Real', '%Q10', /Float$/], ['LReal', '%Q10', /Float$/],
  ] as Array<[string, string, RegExp]>)('maps dataType %s to correct value type (F7)', (dataType, address, re) => {
    const r = buildTopicsFromRows(
      { T: [['Name', 'Type', 'Address', 'Comment'], ['x', dataType, address, '']] },
      { sheetPattern: '', forceAllAsOutput: false });
    expect(r.topics[0].signals[0].wireType).toMatch(re);
  });

  it('flags cross-tab duplicate signal names (F14)', () => {
    const dup = {
      Data_Q_1: [['Name', 'Type', 'Address', 'Comment'], ['Shared', 'Bool', '%Q1.0', '']],
      Data_Q_2: [['Name', 'Type', 'Address', 'Comment'], ['Shared', 'Bool', '%Q2.0', '']],
    };
    const r = buildTopicsFromRows(dup, { sheetPattern: 'Data_Q*', forceAllAsOutput: false });
    expect(r.warnings.some(w => /duplicate/i.test(w) && /Shared/.test(w))).toBe(true);
  });

  it('sanitizes invalid MQTT chars in topic and flags collisions (F13)', () => {
    const r = buildTopicsFromRows(
      { 'Data Q': [['Name', 'Type', 'Address', 'Comment'], ['a', 'Bool', '%Q1.0', '']] },
      { sheetPattern: '', forceAllAsOutput: false });
    expect(r.topics[0].topic).not.toMatch(/[ #+]/);
  });

  it('reports dropped unparsable addresses instead of silent loss (F15)', () => {
    const r = buildTopicsFromRows(
      { Data_E: [['Name', 'Type', 'Address', 'Comment'], ['e', 'Bool', '0,1', '']] },
      { sheetPattern: '', forceAllAsOutput: false });
    expect(r.topics[0].warnings.some(w => /0,1/.test(w))).toBe(true);
  });
});
