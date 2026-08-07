// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for the browser-side Siemens tag-table importer (s7-tag-table.ts).
 * Covers CSV header autodetect, delimiter autodetect, address/type validation,
 * overlap warnings (non-blocking) and wire-type derivation.
 */

import { describe, it, expect } from 'vitest';
import { parseTagTable, parseSdf, deriveWireType } from '../src/core/import/s7-tag-table';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build a File from text content (csv). */
function csvFile(content: string, name = 'tags.csv'): File {
  return new File([content], name, { type: 'text/csv' });
}

/** Build a `.sdf` File from text content (TIA symbol-table export). */
function sdfFile(content: string, name = 'PLCTags.sdf'): File {
  return new File([content], name, { type: 'text/plain' });
}

describe('parseTagTable — CSV', () => {
  it('csvWithHeader: skips the header row and parses tags', async () => {
    const csv = [
      'Name,Type,Adress,Comment',
      'Motor_Start,Bool,%I0.0,start button',
      'ActualTemp,Word,%IW13,temperature',
    ].join('\n');
    const result = await parseTagTable(csvFile(csv));
    expect(result.tags).toHaveLength(2);
    expect(result.tags[0].name).toBe('Motor_Start');
    expect(result.tags[0].area).toBe('I');
    expect(result.tags[0].address).toBe('%I0.0');
    expect(result.tags[1].name).toBe('ActualTemp');
    expect(result.tags[1].dataType).toBe('Word');
    expect(result.warnings).toHaveLength(0);
  });

  it('csvNoHeader: treats the first row as data when col 3 is an address', async () => {
    const csv = [
      'Motor_Start,Bool,%I0.0,start',
      'ActualTemp,Word,%IW13,temp',
    ].join('\n');
    const result = await parseTagTable(csvFile(csv));
    expect(result.tags).toHaveLength(2);
    expect(result.tags[0].name).toBe('Motor_Start');
  });

  it('semicolonDelimited: autodetects the ";" delimiter (German TIA export)', async () => {
    const csv = [
      'Name;Type;Adress;Comment',
      'Valve_Open;Bool;%Q0.1;open valve',
      'Pressure;Real;%MD20;line pressure',
    ].join('\n');
    const result = await parseTagTable(csvFile(csv));
    expect(result.tags).toHaveLength(2);
    expect(result.tags[0].name).toBe('Valve_Open');
    expect(result.tags[0].area).toBe('Q');
    expect(result.tags[1].name).toBe('Pressure');
    expect(result.tags[1].dataType).toBe('Real');
  });

  it('tabDelimited: autodetects the Tab delimiter', async () => {
    const csv = [
      'Name\tType\tAdress\tComment',
      'Sensor_1\tBool\t%I2.3\tbarrier',
      'Counter\tDInt\t%MD40\tparts',
    ].join('\n');
    const result = await parseTagTable(csvFile(csv));
    expect(result.tags).toHaveLength(2);
    expect(result.tags[0].name).toBe('Sensor_1');
    expect(result.tags[1].name).toBe('Counter');
    expect(result.tags[1].dataType).toBe('DInt');
  });

  it('bareAddress: accepts byte.bit addresses without an area letter (raw process image)', async () => {
    const csv = [
      'Name,Type,Adress,Comment',
      '3146,Bool,96.0,bare bit',
      '3145,Bool,96.1,bare bit',
    ].join('\n');
    const result = await parseTagTable(csvFile(csv));
    expect(result.tags).toHaveLength(2);
    expect(result.tags[0].address).toBe('96.0');
    expect(result.tags[0].area).toBe('');
    expect(result.tags[1].address).toBe('96.1');
    expect(result.warnings).toHaveLength(0);
  });

  it('bareAddressByte: accepts a bare byte address without area letter or bit', async () => {
    const csv = [
      'Name,Type,Adress,Comment',
      'Counter,Word,96,bare byte word',
    ].join('\n');
    const result = await parseTagTable(csvFile(csv));
    expect(result.tags).toHaveLength(1);
    expect(result.tags[0].address).toBe('96');
  });

  it('bareAddressNoHeader: first row with a bare address is imported as data (no header)', async () => {
    const csv = [
      '3146,Bool,96.0,bare bit',
      '3145,Bool,96.1,bare bit',
    ].join('\n');
    const result = await parseTagTable(csvFile(csv));
    expect(result.tags).toHaveLength(2);
    expect(result.tags[0].name).toBe('3146');
    expect(result.tags[1].name).toBe('3145');
  });

  it('invalidAddress: produces a warning and drops the tag', async () => {
    const csv = [
      'Name,Type,Adress,Comment',
      'Good,Bool,%I0.0,ok',
      'Bad,Bool,%IZ9,invalid area',
    ].join('\n');
    const result = await parseTagTable(csvFile(csv));
    expect(result.tags).toHaveLength(1);
    expect(result.tags[0].name).toBe('Good');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some(w => w.includes('Bad'))).toBe(true);
  });

  it('dataTypeConflict: size letter conflicts with data type → tag rejected', async () => {
    const csv = [
      'Name,Type,Adress,Comment',
      'Conflict,Bool,%IW13,word addr for bool',
    ].join('\n');
    const result = await parseTagTable(csvFile(csv));
    expect(result.tags).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('overlap: overlapping ranges produce a warning that does NOT block (tags kept)', async () => {
    const csv = [
      'Name,Type,Adress,Comment',
      'A,Word,%IW13,bytes 13-14',
      'B,Bool,%I14.2,byte 14 bit 2 (overlaps A)',
    ].join('\n');
    const result = await parseTagTable(csvFile(csv));
    // Both tags are kept — overlap is non-blocking.
    expect(result.tags).toHaveLength(2);
    expect(result.warnings).toHaveLength(0);
    expect(result.overlaps.length).toBeGreaterThan(0);
  });

  it('overlap: cross-area overlap (%I vs %M) is still reported', async () => {
    const csv = [
      'Name,Type,Adress,Comment',
      'A,Bool,%I3.1,input bit',
      'B,Bool,%M3.1,memory bit (same offset, cross-area)',
    ].join('\n');
    const result = await parseTagTable(csvFile(csv));
    expect(result.tags).toHaveLength(2);
    expect(result.overlaps.length).toBeGreaterThan(0);
  });

  it('flat table without overlaps produces no overlap warnings', async () => {
    const csv = [
      'Name,Type,Adress,Comment',
      'A,Bool,%I0.0,',
      'B,Bool,%I0.1,',
      'C,Word,%IW2,',
      'D,Word,%IW4,',
    ].join('\n');
    const result = await parseTagTable(csvFile(csv));
    expect(result.tags).toHaveLength(4);
    expect(result.overlaps).toHaveLength(0);
  });
});

describe('parseSdf — TIA symbol-table export', () => {
  // Real lines from Assets/Mauser_Projekt_CL30/Excel_Metadaten/PLCTags.sdf:
  // fully double-quoted, comma-separated, NO header, columns
  //   [0]=Name [1]=Address [2]=DataType [3..5]=HMI flags [6]=Comment [7] [8].
  const MAUSER_SDF = [
    '"MC01_1","%QD120","DWord","True","True","False","","","True"',
    '"IO_Check","%MD11000","DWord","True","True","False","","","True"',
    '"ATL_CHECK_TOBI","%M10000.0","Bool","True","True","False","","","True"',
    '"IO_CheckInput","%MW11004","Int","True","True","False","","","True"',
  ].join('\n');

  it('maps SDF columns (0=name, 1=address, 2=type, 6=comment) and keeps % + area', () => {
    const result = parseSdf(MAUSER_SDF);
    expect(result.tags).toHaveLength(4);
    expect(result.warnings).toHaveLength(0);

    expect(result.tags[0].name).toBe('MC01_1');
    expect(result.tags[0].address).toBe('%QD120');
    expect(result.tags[0].dataType).toBe('DWord');
    expect(result.tags[0].area).toBe('Q');

    expect(result.tags[2].name).toBe('ATL_CHECK_TOBI');
    expect(result.tags[2].address).toBe('%M10000.0');
    expect(result.tags[2].dataType).toBe('Bool');
    expect(result.tags[2].area).toBe('M');

    expect(result.tags[3].address).toBe('%MW11004');
    expect(result.tags[3].dataType).toBe('Int');
  });

  it('reads the comment from column 6 (not column 3)', () => {
    const sdf = '"Motor_On","%Q0.0","Bool","True","True","False","runs the motor","",""';
    const result = parseSdf(sdf);
    expect(result.tags).toHaveLength(1);
    expect(result.tags[0].comment).toBe('runs the motor');
  });

  it('does NOT skip the first data row (SDF has no header)', () => {
    const result = parseSdf(MAUSER_SDF);
    expect(result.tags[0].name).toBe('MC01_1'); // first line is data, kept
  });

  it('derives wire types from the area (%Q/%M → PLCOutput, %I → PLCInput)', () => {
    const sdf = [
      '"Out1","%QD120","DWord","","","","","",""',
      '"Flag1","%M10000.0","Bool","","","","","",""',
      '"In1","%I0.0","Bool","","","","","",""',
    ].join('\n');
    const result = parseSdf(sdf);
    expect(deriveWireType(result.tags[0].dataType, result.tags[0].area)).toBe('PLCOutputInt');
    expect(deriveWireType(result.tags[1].dataType, result.tags[1].area)).toBe('PLCOutputBool');
    expect(deriveWireType(result.tags[2].dataType, result.tags[2].area)).toBe('PLCInputBool');
  });

  it('parseTagTable dispatches a .sdf filename to the SDF parser', async () => {
    const result = await parseTagTable(sdfFile(MAUSER_SDF));
    expect(result.tags).toHaveLength(4);
    expect(result.tags[0].name).toBe('MC01_1');
    expect(result.tags[0].address).toBe('%QD120');
  });
});

describe('deriveWireType', () => {
  // Direction follows the Siemens area: I/E = PLC input (viewer writes),
  // Q/A/M/unknown = PLC output (viewer reads, the default in doubt).

  it('value kind without area defaults to PLC output', () => {
    expect(deriveWireType('Bool')).toBe('PLCOutputBool');
    expect(deriveWireType('Word')).toBe('PLCOutputInt');
    expect(deriveWireType('Byte')).toBe('PLCOutputInt');
    expect(deriveWireType('Int')).toBe('PLCOutputInt');
    expect(deriveWireType('DWord')).toBe('PLCOutputInt');
    expect(deriveWireType('DInt')).toBe('PLCOutputInt');
    expect(deriveWireType('Real')).toBe('PLCOutputFloat');
    expect(deriveWireType('LReal')).toBe('PLCOutputFloat');
  });

  it('area I/E → PLCInput*', () => {
    // %I0.0 (Bool) → PLCInputBool
    expect(deriveWireType('Bool', 'I')).toBe('PLCInputBool');
    // %IW4 (Int) → PLCInputInt
    expect(deriveWireType('Int', 'I')).toBe('PLCInputInt');
    // German TIA "E" (Eingang) is the same as "I".
    expect(deriveWireType('Bool', 'E')).toBe('PLCInputBool');
    expect(deriveWireType('Real', 'E')).toBe('PLCInputFloat');
  });

  it('area Q/A → PLCOutput*', () => {
    // %Q0.1 (Bool) → PLCOutputBool
    expect(deriveWireType('Bool', 'Q')).toBe('PLCOutputBool');
    // German TIA "A" (Ausgang) is the same as "Q".
    expect(deriveWireType('Bool', 'A')).toBe('PLCOutputBool');
  });

  it('area M (Merker) → PLCOutput* (default in doubt)', () => {
    // %MD20 (Real) → PLCOutputFloat
    expect(deriveWireType('Real', 'M')).toBe('PLCOutputFloat');
    expect(deriveWireType('Bool', 'M')).toBe('PLCOutputBool');
  });

  it('bare address (empty area) → PLCOutput* (default)', () => {
    // bare 96.0 → PLCOutput*
    expect(deriveWireType('Bool', '')).toBe('PLCOutputBool');
    expect(deriveWireType('Word', '')).toBe('PLCOutputInt');
  });

  it('case-insensitive area letter', () => {
    expect(deriveWireType('Bool', 'i')).toBe('PLCInputBool');
    expect(deriveWireType('Bool', 'q')).toBe('PLCOutputBool');
  });
});
