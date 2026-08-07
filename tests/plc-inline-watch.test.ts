// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plc-inline-watch.test.ts — inline live-watch geometry + hover lookup
 * (plan-242 follow-up: signal observation IN the code).
 *
 * Pins the PURE logic behind the CODESYS-style online view of the PLC editor
 * (@rv-private/plugins/plc/plc-inline-watch — no Monaco, no React):
 *  - scanFbDeclarations: FB instances in VAR blocks (VAR_EXTERNAL skipped),
 *  - formatWatchValue: BOOL / INT / REAL / TIME formatting contract,
 *  - computeInlineWatchSpecs: declaration line → ghost text mapping
 *    (externals, FB outputs, multi-declaration lines, missing values),
 *  - inlineWatchSpecsEqual: change detection that gates decoration updates,
 *  - lookupWatchIdentifier: hover info incl. @signal pragma binding and the
 *    FULL signal info from the combined signal catalog (direction, PLC type,
 *    model/CONNECT source, address, tag comment) — catalog passed as a plain
 *    array, matching the panel's cached-provider contract.
 */

import { describe, it, expect } from 'vitest';
import {
  GHOST_ARROW,
  computeInlineWatchSpecs,
  formatWatchValue,
  inlineWatchSpecsEqual,
  lookupWatchIdentifier,
  scanFbDeclarations,
  type InlineWatchSpec,
} from '@rv-private/plugins/plc/plc-inline-watch';
import type { PlcCatalogSignal } from '@rv-private/plugins/plc/plc-signal-catalog';

const CODE = `PROGRAM Main
VAR_EXTERNAL
  SensorInFeed : BOOL;
  Speed : REAL;
  Target : INT;
  MotorOn : BOOL; (* @signal: MC02.07/Motor On *)
END_VAR
VAR
  tDelay : TON;
  count : INT;
END_VAR
  tDelay(IN := SensorInFeed, PT := T#2s);
END_PROGRAM
`;

function watchOf(entries: Record<string, boolean | number>): Map<string, boolean | number> {
  return new Map(Object.entries(entries));
}

// ─── FB declaration scan (VAR blocks) ───────────────────────────────────────

describe('scanFbDeclarations', () => {
  it('finds standard-FB instances in VAR blocks with their line numbers', () => {
    const decls = scanFbDeclarations(CODE);
    expect(decls).toEqual([{ name: 'tDelay', fbType: 'TON', line: 9 }]);
  });

  it('ignores VAR_EXTERNAL declarations and non-FB VAR declarations', () => {
    const decls = scanFbDeclarations(CODE);
    expect(decls.some((d) => d.name === 'SensorInFeed')).toBe(false);
    expect(decls.some((d) => d.name === 'count')).toBe(false);
  });

  it('handles single-line blocks and case-insensitive FB types', () => {
    const decls = scanFbDeclarations('PROGRAM P\nVAR edge : r_trig; END_VAR\nEND_PROGRAM');
    expect(decls).toEqual([{ name: 'edge', fbType: 'R_TRIG', line: 2 }]);
  });
});

// ─── Value formatting ───────────────────────────────────────────────────────

describe('formatWatchValue', () => {
  it('formats BOOL as TRUE / FALSE', () => {
    expect(formatWatchValue(true, 'BOOL')).toBe('TRUE');
    expect(formatWatchValue(false, 'BOOL')).toBe('FALSE');
  });

  it('formats INT / DINT as integers', () => {
    expect(formatWatchValue(42, 'INT')).toBe('42');
    expect(formatWatchValue(42.9, 'DINT')).toBe('42');
  });

  it('formats REAL with at most 3 decimals, trailing zeros trimmed', () => {
    expect(formatWatchValue(1.23456, 'REAL')).toBe('1.235');
    expect(formatWatchValue(2, 'REAL')).toBe('2');
    expect(formatWatchValue(0.5, 'REAL')).toBe('0.5');
  });

  it('formats TIME (ms) as seconds with one decimal', () => {
    expect(formatWatchValue(1400, 'TIME')).toBe('1.4s');
    expect(formatWatchValue(2000, 'TIME')).toBe('2s');
    expect(formatWatchValue(0, 'TIME')).toBe('0s');
  });
});

// ─── Line → ghost-text mapping ──────────────────────────────────────────────

describe('computeInlineWatchSpecs', () => {
  it('maps VAR_EXTERNAL declaration lines to their formatted live value', () => {
    const specs = computeInlineWatchSpecs(CODE, watchOf({
      SensorInFeed: true, Speed: 1.23456, Target: 42, MotorOn: false,
    }));
    expect(specs).toEqual([
      { lineNumber: 3, text: `${GHOST_ARROW}TRUE` },
      { lineNumber: 4, text: `${GHOST_ARROW}1.235` },
      { lineNumber: 5, text: `${GHOST_ARROW}42` },
      { lineNumber: 6, text: `${GHOST_ARROW}FALSE` },
    ]);
  });

  it('maps FB instance lines to their outputs (signature order, TIME as seconds)', () => {
    const specs = computeInlineWatchSpecs(CODE, watchOf({
      'tDelay.Q': true, 'tDelay.ET': 1400,
    }));
    expect(specs).toEqual([
      { lineNumber: 9, text: `${GHOST_ARROW}Q=TRUE ET=1.4s` },
    ]);
  });

  it('skips identifiers absent from the snapshot and yields nothing for an empty watch', () => {
    expect(computeInlineWatchSpecs(CODE, watchOf({ SensorInFeed: true }))).toEqual([
      { lineNumber: 3, text: `${GHOST_ARROW}TRUE` },
    ]);
    expect(computeInlineWatchSpecs(CODE, new Map())).toEqual([]);
  });

  it('labels values when a line carries several declarations', () => {
    const code = 'PROGRAM P\nVAR_EXTERNAL A : BOOL; B : BOOL; END_VAR\nEND_PROGRAM';
    const specs = computeInlineWatchSpecs(code, watchOf({ A: true, B: false }));
    expect(specs).toEqual([
      { lineNumber: 2, text: `${GHOST_ARROW}A=TRUE  B=FALSE` },
    ]);
  });
});

describe('inlineWatchSpecsEqual (change detection)', () => {
  const a: InlineWatchSpec[] = [{ lineNumber: 3, text: ' x' }, { lineNumber: 9, text: ' y' }];

  it('is true for identical renderings (and for the same reference)', () => {
    expect(inlineWatchSpecsEqual(a, [{ lineNumber: 3, text: ' x' }, { lineNumber: 9, text: ' y' }])).toBe(true);
    expect(inlineWatchSpecsEqual(a, a)).toBe(true);
  });

  it('is false when a value text, a line or the count changed', () => {
    expect(inlineWatchSpecsEqual(a, [{ lineNumber: 3, text: ' x' }, { lineNumber: 9, text: ' z' }])).toBe(false);
    expect(inlineWatchSpecsEqual(a, [{ lineNumber: 4, text: ' x' }, { lineNumber: 9, text: ' y' }])).toBe(false);
    expect(inlineWatchSpecsEqual(a, [{ lineNumber: 3, text: ' x' }])).toBe(false);
  });
});

// ─── Hover lookup ───────────────────────────────────────────────────────────

describe('lookupWatchIdentifier', () => {
  it('resolves a declared external to type + formatted value', () => {
    const info = lookupWatchIdentifier(CODE, watchOf({ Speed: 1.23456 }), 'Speed');
    expect(info).toEqual({
      identifier: 'Speed', kind: 'external', stType: 'REAL', valueText: '1.235',
    });
  });

  it('matches case-insensitively (IEC identifiers) and keeps the declared casing', () => {
    const info = lookupWatchIdentifier(CODE, watchOf({ SensorInFeed: true }), 'sensorinfeed');
    expect(info?.identifier).toBe('SensorInFeed');
    expect(info?.valueText).toBe('TRUE');
  });

  it('includes the real store name for @signal-pragma externals', () => {
    const info = lookupWatchIdentifier(CODE, watchOf({ MotorOn: false }), 'MotorOn');
    expect(info?.signalName).toBe('MC02.07/Motor On');
    expect(info?.valueText).toBe('FALSE');
  });

  it('omits valueText before the first scan but still reports the declaration', () => {
    const info = lookupWatchIdentifier(CODE, new Map(), 'Target');
    expect(info).toEqual({ identifier: 'Target', kind: 'external', stType: 'INT' });
  });

  it('resolves an FB instance to its type and output values', () => {
    const info = lookupWatchIdentifier(CODE, watchOf({ 'tDelay.Q': true, 'tDelay.ET': 500 }), 'tDelay');
    expect(info).toEqual({
      identifier: 'tDelay', kind: 'fb', stType: 'TON', valueText: 'Q=TRUE ET=0.5s',
    });
  });

  it('returns null for anything that is not a declared external / FB instance', () => {
    expect(lookupWatchIdentifier(CODE, new Map(), 'count')).toBeNull();
    expect(lookupWatchIdentifier(CODE, new Map(), 'nonexistent')).toBeNull();
  });
});

// ─── Hover — full signal info from the catalog ──────────────────────────────

const CATALOG: PlcCatalogSignal[] = [
  {
    name: 'MC02.07/Motor On',
    plcType: 'PLCOutputBool',
    address: '%Q0.3',
    comment: 'Main motor contactor',
    source: 'connect',
  },
  { name: 'SensorInFeed', plcType: 'PLCInputBool', source: 'model' },
];

describe('lookupWatchIdentifier — catalog enrichment (full signal info)', () => {
  it('adds direction, PLC type, CONNECT source, address and comment for pragma-bound externals', () => {
    const info = lookupWatchIdentifier(CODE, watchOf({ MotorOn: false }), 'MotorOn', CATALOG);
    expect(info).toEqual({
      identifier: 'MotorOn',
      kind: 'external',
      stType: 'BOOL',
      signalName: 'MC02.07/Motor On',
      direction: 'output',
      plcType: 'PLCOutputBool',
      source: 'connect',
      address: '%Q0.3',
      comment: 'Main motor contactor',
      valueText: 'FALSE',
    });
  });

  it('matches plain identifiers against the catalog and keeps static info without a watch value', () => {
    // Empty watch = stopped PLC — the static signal info still resolves.
    const info = lookupWatchIdentifier(CODE, new Map(), 'SensorInFeed', CATALOG);
    expect(info).toEqual({
      identifier: 'SensorInFeed',
      kind: 'external',
      stType: 'BOOL',
      direction: 'input',
      plcType: 'PLCInputBool',
      source: 'model',
    });
  });

  it('leaves the hover unchanged when the signal is not in the catalog', () => {
    const info = lookupWatchIdentifier(CODE, watchOf({ Target: 42 }), 'Target', CATALOG);
    expect(info).toEqual({ identifier: 'Target', kind: 'external', stType: 'INT', valueText: '42' });
  });

  it('does not enrich FB instances', () => {
    const info = lookupWatchIdentifier(CODE, watchOf({ 'tDelay.Q': true }), 'tDelay', CATALOG);
    expect(info).toEqual({ identifier: 'tDelay', kind: 'fb', stType: 'TON', valueText: 'Q=TRUE' });
  });
});
