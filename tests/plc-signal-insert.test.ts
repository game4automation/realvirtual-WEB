// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plc-signal-insert.test.ts — PLC editor signal browser (plan-242 follow-up).
 *
 * Contract of the pure ST edit helpers (st-code-edit.ts) and the
 * `(* @signal: … *)` pragma pipeline:
 *  - insertSignalDeclaration: insert into an existing VAR_EXTERNAL block /
 *    create the block after the PROGRAM line / duplicate → unchanged
 *  - deriveStType: bool→BOOL, int/word→INT, float/real→REAL
 *  - non-identifier signal names: SHORT alias + @signal pragma with smart
 *    escalation (last segment → first+last → fully qualified → `_2` suffix),
 *    `.` / `/` separators, pragma-based duplicate detection, alias stability
 *    of existing declarations, reserved-word handling
 *  - computeDeclarationEdit: the line-start edit (Monaco additionalTextEdits
 *    contract) applies to the same result as insertSignalDeclaration
 *  - pragma roundtrip: compileSt → externals[].signalName; RVPlcRunner binds
 *    SignalStore reads/writes against signalName (watch keeps identifiers)
 *
 * Runs only in the private build (imports `@rv-private/plugins/plc/st-code-edit`).
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  computeDeclarationEdit,
  deriveStType,
  insertSignalDeclaration,
  isInsideVarExternal,
  isValidStIdentifier,
  sanitizeStIdentifier,
  type InsertSignalResult,
} from '@rv-private/plugins/plc/st-code-edit';
import { compileSt } from '@rv-private/plc/st-compiler';
import { RVPlcRunner } from '@rv-private/plc/rv-plc-runner';
import { SignalStore } from '../src/core/engine/rv-signal-store';

// ─── Helpers ────────────────────────────────────────────────────────────────

const WITH_BLOCK = [
  'PROGRAM Main',
  'VAR_EXTERNAL',
  '  SensorInFeed : BOOL;',
  'END_VAR',
  'END_PROGRAM',
].join('\n');

const NO_BLOCK = 'PROGRAM Main\nEND_PROGRAM';

/** Narrows to the "changed" variant (fails the test otherwise). */
function changed(r: InsertSignalResult): Extract<InsertSignalResult, { code: string }> {
  if (!('code' in r)) throw new Error('expected an insertion, got unchanged');
  return r;
}

function compileOk(source: string) {
  const r = compileSt(source);
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(r.program).toBeDefined();
  return r.program!;
}

// ─── ST type derivation ─────────────────────────────────────────────────────

describe('signal insert — deriveStType', () => {
  it('maps PLC types and raw data types to ST declaration types', () => {
    expect(deriveStType('PLCInputBool')).toBe('BOOL');
    expect(deriveStType('PLCOutputBool')).toBe('BOOL');
    expect(deriveStType('PLCOutputInt')).toBe('INT');
    expect(deriveStType('PLCInputFloat')).toBe('REAL');
    expect(deriveStType('Real')).toBe('REAL');
    expect(deriveStType('Word')).toBe('INT');
    expect(deriveStType('DInt')).toBe('INT');
  });

  it('defaults to BOOL for unknown or missing hints', () => {
    expect(deriveStType(undefined)).toBe('BOOL');
    expect(deriveStType('')).toBe('BOOL');
    expect(deriveStType('String')).toBe('BOOL');
  });
});

// ─── Identifier validation / sanitization ───────────────────────────────────

describe('signal insert — identifiers', () => {
  it('accepts plain identifiers and rejects non-conforming names', () => {
    expect(isValidStIdentifier('SensorInFeed')).toBe(true);
    expect(isValidStIdentifier('_private2')).toBe(true);
    expect(isValidStIdentifier('MC02.07/Sensor X')).toBe(false);
    expect(isValidStIdentifier('3rdAxis')).toBe(false);
    expect(isValidStIdentifier('with-dash')).toBe(false);
  });

  it('rejects reserved words (keywords, types, FB types) case-insensitively', () => {
    expect(isValidStIdentifier('IF')).toBe(false);
    expect(isValidStIdentifier('bool')).toBe(false);
    expect(isValidStIdentifier('Ton')).toBe(false);
  });

  it('sanitizes to a valid identifier', () => {
    expect(sanitizeStIdentifier('MC02.07/Sensor X')).toBe('MC02_07_Sensor_X');
    expect(sanitizeStIdentifier('3rdAxis')).toBe('_3rdAxis');
    expect(sanitizeStIdentifier('if')).toBe('if_');
    expect(isValidStIdentifier(sanitizeStIdentifier('MC02.07/Sensor X'))).toBe(true);
  });
});

// ─── Declaration insertion ──────────────────────────────────────────────────

describe('signal insert — insertSignalDeclaration', () => {
  it('inserts into an existing VAR_EXTERNAL block before END_VAR', () => {
    const r = changed(insertSignalDeclaration(WITH_BLOCK, { name: 'ConveyorStart', stType: 'BOOL' }));
    expect(r.identifier).toBe('ConveyorStart');
    expect(r.insertedLine).toBe(4);
    expect(r.code.split('\n')[3]).toBe('  ConveyorStart : BOOL;');
    const program = compileOk(r.code);
    expect(program.externals.map((e) => e.name)).toEqual(['SensorInFeed', 'ConveyorStart']);
  });

  it('uses the derived type in the declaration (INT / REAL)', () => {
    const ri = changed(insertSignalDeclaration(WITH_BLOCK, { name: 'PartCount', stType: deriveStType('PLCOutputInt') }));
    expect(ri.code).toContain('  PartCount : INT;');
    const rf = changed(insertSignalDeclaration(WITH_BLOCK, { name: 'Speed', stType: deriveStType('PLCInputFloat') }));
    expect(rf.code).toContain('  Speed : REAL;');
  });

  it('creates a VAR_EXTERNAL block after the PROGRAM line when none exists', () => {
    const r = changed(insertSignalDeclaration(NO_BLOCK, { name: 'MotorOn', stType: 'BOOL' }));
    expect(r.insertedLine).toBe(3);
    expect(r.code.split('\n')).toEqual([
      'PROGRAM Main',
      'VAR_EXTERNAL',
      '  MotorOn : BOOL;',
      'END_VAR',
      'END_PROGRAM',
    ]);
    compileOk(r.code);
  });

  it('returns unchanged for an already declared signal', () => {
    const r = insertSignalDeclaration(WITH_BLOCK, { name: 'SensorInFeed', stType: 'BOOL' });
    expect(r).toEqual({ unchanged: true, identifier: 'SensorInFeed' });
  });

  it('keeps CRLF line endings intact', () => {
    const crlf = WITH_BLOCK.replace(/\n/g, '\r\n');
    const r = changed(insertSignalDeclaration(crlf, { name: 'MotorOn', stType: 'BOOL' }));
    expect(/[^\r]\n/.test(r.code)).toBe(false);
    expect(r.code).toContain('  MotorOn : BOOL;\r\n');
  });

  it('creates a fresh block for single-line VAR_EXTERNAL blocks and dedupes against them', () => {
    const oneLine = 'PROGRAM Main\nVAR_EXTERNAL A : BOOL; END_VAR\nEND_PROGRAM';
    expect(insertSignalDeclaration(oneLine, { name: 'A', stType: 'BOOL' }))
      .toEqual({ unchanged: true, identifier: 'A' });
    const r = changed(insertSignalDeclaration(oneLine, { name: 'B', stType: 'BOOL' }));
    const program = compileOk(r.code); // two VAR_EXTERNAL blocks are legal
    expect(program.externals.map((e) => e.name).sort()).toEqual(['A', 'B']);
  });
});

// ─── Sanitized identifiers + @signal pragma ─────────────────────────────────

describe('signal insert — non-identifier names (@signal pragma)', () => {
  it('inserts a short alias (last segment) with the @signal pragma', () => {
    const r = changed(insertSignalDeclaration(WITH_BLOCK, { name: 'MC02.07/Sensor X', stType: 'BOOL' }));
    expect(r.identifier).toBe('Sensor_X');
    expect(r.code).toContain('  Sensor_X : BOOL; (* @signal: MC02.07/Sensor X *)');
    compileOk(r.code);
  });

  it('dedupes by the pragma signal name on re-insert', () => {
    const first = changed(insertSignalDeclaration(WITH_BLOCK, { name: 'MC02.07/Sensor X', stType: 'BOOL' }));
    const again = insertSignalDeclaration(first.code, { name: 'MC02.07/Sensor X', stType: 'BOOL' });
    expect(again).toEqual({ unchanged: true, identifier: 'Sensor_X' });
  });

  it('handles reserved-word signal names via sanitize + pragma', () => {
    const r = changed(insertSignalDeclaration(WITH_BLOCK, { name: 'if', stType: 'BOOL' }));
    expect(r.identifier).toBe('if_');
    expect(r.code).toContain('  if_ : BOOL; (* @signal: if *)');
    compileOk(r.code);
  });
});

// ─── Short aliases with smart escalation ────────────────────────────────────

// Two identical conveyor components — their signals differ ONLY in the first
// name segment (the middle parts are identical), the driving scenario for
// the escalation order.
const CONV1 = 'RollConveyor-2m.Flow.PartCount';
const CONV2 = 'RollConveyor-3m.Flow.PartCount';

describe('signal insert — short aliases with escalation', () => {
  it('uses the LAST segment as alias when it is free', () => {
    const r = changed(insertSignalDeclaration(WITH_BLOCK, { name: CONV1, stType: 'INT' }));
    expect(r.identifier).toBe('PartCount');
    expect(r.code).toContain(`  PartCount : INT; (* @signal: ${CONV1} *)`);
    compileOk(r.code);
  });

  it('escalates to FIRST + LAST segment for the second identical component', () => {
    const first = changed(insertSignalDeclaration(WITH_BLOCK, { name: CONV1, stType: 'INT' }));
    const second = changed(insertSignalDeclaration(first.code, { name: CONV2, stType: 'INT' }));
    expect(second.identifier).toBe('RollConveyor_3m_PartCount');
    expect(second.code).toContain(`  RollConveyor_3m_PartCount : INT; (* @signal: ${CONV2} *)`);
    // Alias stability: the first conveyor keeps its short alias untouched.
    expect(second.code).toContain(`  PartCount : INT; (* @signal: ${CONV1} *)`);
    const program = compileOk(second.code);
    expect(program.externals.map((e) => e.name))
      .toEqual(expect.arrayContaining(['PartCount', 'RollConveyor_3m_PartCount']));
  });

  it('escalates to the fully qualified alias when first+last also collides', () => {
    const code = WITH_BLOCK.replace(
      '  SensorInFeed : BOOL;',
      '  SensorInFeed : BOOL;\n  PartCount : INT;\n  RollConveyor_3m_PartCount : INT;',
    );
    const r = changed(insertSignalDeclaration(code, { name: CONV2, stType: 'INT' }));
    expect(r.identifier).toBe('RollConveyor_3m_Flow_PartCount');
    expect(r.code).toContain(`  RollConveyor_3m_Flow_PartCount : INT; (* @signal: ${CONV2} *)`);
    compileOk(r.code);
  });

  it('suffixes the fully qualified alias only when EVERY candidate collides', () => {
    const code = WITH_BLOCK.replace(
      '  SensorInFeed : BOOL;',
      [
        '  SensorInFeed : BOOL;',
        '  PartCount : INT;',
        '  RollConveyor_2m_PartCount : INT;',
        '  RollConveyor_2m_Flow_PartCount : INT;',
      ].join('\n'),
    );
    const r = changed(insertSignalDeclaration(code, { name: CONV1, stType: 'INT' }));
    expect(r.identifier).toBe('RollConveyor_2m_Flow_PartCount_2');
    expect(r.code).toContain(`  RollConveyor_2m_Flow_PartCount_2 : INT; (* @signal: ${CONV1} *)`);
    compileOk(r.code);
  });

  it('treats pragma-bound store names as taken when picking an alias', () => {
    // A handwritten alias already binds the plain store signal 'PartCount' —
    // an alias 'PartCount' for a DIFFERENT signal would shadow it misleadingly.
    const code = WITH_BLOCK.replace(
      '  SensorInFeed : BOOL;',
      '  SensorInFeed : BOOL;\n  Ignore : INT; (* @signal: PartCount *)',
    );
    const r = changed(insertSignalDeclaration(code, { name: CONV1, stType: 'INT' }));
    expect(r.identifier).toBe('RollConveyor_2m_PartCount');
    compileOk(r.code);
  });

  it('splits on `.` AND `/` separators (mixed paths)', () => {
    const a = changed(insertSignalDeclaration(WITH_BLOCK, { name: 'Line1/Flow.Count', stType: 'INT' }));
    expect(a.identifier).toBe('Count');
    expect(a.code).toContain('  Count : INT; (* @signal: Line1/Flow.Count *)');
    const b = changed(insertSignalDeclaration(a.code, { name: 'Line2/Flow.Count', stType: 'INT' }));
    expect(b.identifier).toBe('Line2_Count');
    compileOk(b.code);
  });

  it('re-inserting an aliased signal is a pragma duplicate — no new declaration', () => {
    const first = changed(insertSignalDeclaration(WITH_BLOCK, { name: CONV1, stType: 'INT' }));
    const again = insertSignalDeclaration(first.code, { name: CONV1, stType: 'INT' });
    expect(again).toEqual({ unchanged: true, identifier: 'PartCount' });
    // The Monaco completion path (computeDeclarationEdit) reports the same.
    expect(computeDeclarationEdit(first.code, { name: CONV1, stType: 'INT' }))
      .toEqual({ unchanged: true, identifier: 'PartCount' });
  });

  it('respects identifiers reserved by the same batch operation', () => {
    const edit = computeDeclarationEdit(WITH_BLOCK, { name: CONV1, stType: 'INT' }, ['PartCount']);
    if (edit.unchanged) throw new Error('expected an edit');
    expect(edit.identifier).toBe('RollConveyor_2m_PartCount');
  });
});

// ─── computeDeclarationEdit (Monaco additionalTextEdits contract) ───────────

describe('signal insert — computeDeclarationEdit', () => {
  it('yields a line-start edit that reproduces insertSignalDeclaration', () => {
    for (const [code, name] of [
      [WITH_BLOCK, 'ConveyorStart'],
      [NO_BLOCK, 'MotorOn'],
      [WITH_BLOCK, 'MC02.07/Sensor X'],
    ] as const) {
      const edit = computeDeclarationEdit(code, { name, stType: 'BOOL' });
      if (edit.unchanged) throw new Error('expected an edit');
      const lines = code.split('\n');
      lines.splice(edit.lineNumber - 1, 0, ...edit.text.split('\n').slice(0, -1));
      expect(lines.join('\n')).toBe(changed(insertSignalDeclaration(code, { name, stType: 'BOOL' })).code);
    }
  });

  it('returns unchanged with the existing identifier for declared signals', () => {
    const edit = computeDeclarationEdit(WITH_BLOCK, { name: 'SensorInFeed', stType: 'BOOL' });
    expect(edit).toEqual({ unchanged: true, identifier: 'SensorInFeed' });
  });
});

describe('signal insert — isInsideVarExternal', () => {
  it('covers the block lines inclusively', () => {
    expect(isInsideVarExternal(WITH_BLOCK, 1)).toBe(false); // PROGRAM
    expect(isInsideVarExternal(WITH_BLOCK, 2)).toBe(true);  // VAR_EXTERNAL
    expect(isInsideVarExternal(WITH_BLOCK, 3)).toBe(true);  // declaration
    expect(isInsideVarExternal(WITH_BLOCK, 4)).toBe(true);  // END_VAR
    expect(isInsideVarExternal(WITH_BLOCK, 5)).toBe(false); // END_PROGRAM
  });
});

// ─── Pragma roundtrip: compiler + runner binding ────────────────────────────

const PRAGMA_PROGRAM = [
  'PROGRAM Main',
  'VAR_EXTERNAL',
  '  SensorX : BOOL; (* @signal: MC02.07/Sensor X *)',
  '  MotorOn : BOOL; (* @signal: MC02.07/Motor On *)',
  'END_VAR',
  '  MotorOn := SensorX;',
  'END_PROGRAM',
].join('\n');

describe('signal insert — @signal pragma roundtrip', () => {
  const runners: RVPlcRunner[] = [];
  afterEach(() => {
    for (const r of runners) r.dispose();
    runners.length = 0;
  });

  it('compileSt decorates externals[].signalName from the pragma', () => {
    const program = compileOk(PRAGMA_PROGRAM);
    expect(program.externals).toEqual([
      { name: 'SensorX', type: 'BOOL', written: false, signalName: 'MC02.07/Sensor X' },
      { name: 'MotorOn', type: 'BOOL', written: true, signalName: 'MC02.07/Motor On' },
    ]);
  });

  it('runner binds reads/writes against the pragma signal name; watch keeps identifiers', async () => {
    const store = new SignalStore();
    store.register('MC02.07/Sensor X', 'Cell/SensorX', false);
    store.register('MC02.07/Motor On', 'Cell/MotorOn', false);
    const runner = new RVPlcRunner(store, { scanDeadlineMs: 50 });
    runners.push(runner);

    const diagnostics = await runner.deploy(PRAGMA_PROGRAM);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(diagnostics.filter((d) => d.message.includes('signal not found'))).toEqual([]);

    store.set('MC02.07/Sensor X', true);
    runner.step();
    expect(store.getBool('MC02.07/Motor On')).toBe(true);
    expect(runner.watch().get('MotorOn')).toBe(true);
    expect(runner.watch().get('SensorX')).toBe(true);

    store.set('MC02.07/Sensor X', false);
    runner.step();
    expect(store.getBool('MC02.07/Motor On')).toBe(false);
  });

  it('auto-registers missing WRITTEN pragma outputs under the signal name', async () => {
    const store = new SignalStore();
    const runner = new RVPlcRunner(store, { scanDeadlineMs: 50 });
    runners.push(runner);

    const code = [
      'PROGRAM Main',
      'VAR_EXTERNAL',
      '  Lamp : BOOL; (* @signal: MC02.07/Lamp *)',
      'END_VAR',
      '  Lamp := TRUE;',
      'END_PROGRAM',
    ].join('\n');
    const diagnostics = await runner.deploy(code);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(store.get('MC02.07/Lamp')).toBe(false); // registered at deploy
    expect(store.getPath('MC02.07/Lamp')).toBe('PLC/MC02.07/Lamp');

    runner.step();
    expect(store.getBool('MC02.07/Lamp')).toBe(true);
  });

  it('warns with identifier AND signal name for missing pragma inputs', async () => {
    const store = new SignalStore();
    const runner = new RVPlcRunner(store, { scanDeadlineMs: 50 });
    runners.push(runner);

    const code = [
      'PROGRAM Main',
      'VAR_EXTERNAL',
      '  SensorX : BOOL; (* @signal: Missing/Signal *)',
      '  MotorOn : BOOL;',
      'END_VAR',
      '  MotorOn := SensorX;',
      'END_PROGRAM',
    ].join('\n');
    const diagnostics = await runner.deploy(code);
    const warning = diagnostics.find((d) => d.message.includes('signal not found'));
    expect(warning).toBeDefined();
    expect(warning!.message).toContain("'SensorX' (signal 'Missing/Signal')");
  });
});
