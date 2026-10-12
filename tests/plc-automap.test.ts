// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** plan-545 Phase 1 — the pure PLC auto-map core. */

import { describe, it, expect } from 'vitest';
import {
  buildInterfaceSignals,
  collectModelPlcSignals,
  matchPlcSignals,
  mergeDataBlockFilter,
  normaliseTagName,
  parseCommentAddress,
  readMetadataAddress,
  type ModelPlcSignal,
} from '../src/core/import/rv-plc-automap';
import type { ConnectInterfaceSignal } from '../src/core/hmi/connect-store';

// plan-589: `localName` is the persisted asset-local symbol. For every signal
// in this file it equals the runtime name — they are all authored, and an
// authored name stays raw.
const sig = (name: string, type: string, comment?: string): ModelPlcSignal => ({ name, localName: name, type, comment });

describe('parseCommentAddress', () => {
  it('splits address and text at the middle dot', () => {
    expect(parseCommentAddress('%I0.2 · Betriebsart')).toEqual({ address: '%I0.2', text: 'Betriebsart' });
    expect(parseCommentAddress('%Q108.0 · Kamera')?.address).toBe('%Q108.0');
    expect(parseCommentAddress('%QW8 · x')?.address).toBe('%QW8');
    expect(parseCommentAddress('DB1.DBX0.0 · y')?.address).toBe('DB1.DBX0.0');
    expect(parseCommentAddress('%MD20 · z')?.address).toBe('%MD20');
  });

  it('accepts | and - only before a valid address', () => {
    expect(parseCommentAddress('%I1.0 | Start')?.address).toBe('%I1.0');
    expect(parseCommentAddress('%Q2.1 - Lamp')?.address).toBe('%Q2.1');
    expect(parseCommentAddress('Ventil - links')).toBeNull();
  });

  it('accepts a comment that is only the address', () => {
    expect(parseCommentAddress('%Q108.0')).toEqual({ address: '%Q108.0', text: '' });
    expect(parseCommentAddress('  %I0.2  ')).toEqual({ address: '%I0.2', text: '' });
    expect(parseCommentAddress('%Z9')).toBeNull();
    expect(parseCommentAddress('%I0')).toBeNull();
  });

  it('rejects comments without an address', () => {
    expect(parseCommentAddress('Betriebsart')).toBeNull();
    expect(parseCommentAddress('%Z9 · x')).toBeNull();
    expect(parseCommentAddress('%I0.2 Betriebsart')).toBeNull();
    expect(parseCommentAddress('%I0 · bit address without bit')).toBeNull();
    expect(parseCommentAddress(undefined)).toBeNull();
  });
});

describe('normaliseTagName', () => {
  it('strips quotes per segment and preserves case', () => {
    expect(normaliseTagName('"FG01_P_Camera".bEnable')).toBe('FG01_P_Camera.bEnable');
    expect(normaliseTagName('"DB"."M"')).toBe('DB.M');
    expect(normaliseTagName('BT4_AutoStart')).toBe('BT4_AutoStart');
    expect(normaliseTagName('Motor.Run')).toBe('Motor.Run');
    expect(normaliseTagName('motor.run')).not.toBe('Motor.Run');
  });
});

describe('matchPlcSignals — S7', () => {
  const model = [
    sig('Start', 'PLCInputBool', '%I0.0 · Start button'),
    sig('Lamp', 'PLCOutputBool', '%Q0.1 · Lamp'),
    sig('Speed', 'PLCOutputInt', '%QW8 · Speed'),
  ];

  it('empty interface → all mappable', () => {
    const r = matchPlcSignals(model, { signals: [], allowWebToPlc: true }, 'S7');
    expect(r.counts.total).toBe(3);
    expect(r.counts.mappable).toBe(3);
    expect(r.counts.mapped).toBe(0);
    expect(r.counts.toApply).toBe(3);
    expect(r.hints).toEqual([]);
  });

  it('same address → mapped, different → address-mismatch', () => {
    const existing: ConnectInterfaceSignal[] = [
      { name: 'Start', protocolAddress: '%I0.0', type: 'PLCInputBool', record: false },
      { name: 'Lamp', protocolAddress: '%Q9.9', type: 'PLCOutputBool', record: false },
    ];
    const r = matchPlcSignals(model, { signals: existing, allowWebToPlc: true }, 'S7');
    expect(r.categories.mapped.map((e) => e.name)).toEqual(['Start']);
    expect(r.categories['address-mismatch'].map((e) => e.name)).toEqual(['Lamp']);
    expect(r.categories['address-mismatch'][0].existingAddress).toBe('%Q9.9');
    expect(r.categories.mappable.map((e) => e.name)).toEqual(['Speed']);
  });

  it('%I on a PLCOutput → direction-conflict', () => {
    const r = matchPlcSignals([sig('Bad', 'PLCOutputBool', '%I3.0 · wrong')], { signals: [] }, 'S7');
    expect(r.categories['direction-conflict'].map((e) => e.name)).toEqual(['Bad']);
    expect(r.counts.mappable).toBe(0);
  });

  it('two signals on one address → address-duplicate', () => {
    const r = matchPlcSignals([
      sig('A', 'PLCOutputBool', '%Q1.0 · a'),
      sig('B', 'PLCOutputBool', '%A1.0 · b'), // German mnemonic, same address
    ], { signals: [] }, 'S7');
    expect(r.categories['address-duplicate'].map((e) => e.name).sort()).toEqual(['A', 'B']);
  });

  it('no address → no-address; foreign interface signal → plc-only', () => {
    const r = matchPlcSignals([sig('Plain', 'PLCOutputBool', 'just text')], {
      signals: [{ name: 'Foreign', protocolAddress: '%M0.0', type: 'PLCOutputBool', record: false }],
    }, 'S7');
    expect(r.categories['no-address'].map((e) => e.name)).toEqual(['Plain']);
    expect(r.categories['plc-only'].map((e) => e.name)).toEqual(['Foreign']);
  });

  it('bare-address comment (tag without comment text) → mappable', () => {
    const r = matchPlcSignals([sig('Cam', 'PLCOutputBool', '%Q108.0')], { signals: [] }, 'S7');
    expect(r.categories.mappable.map((e) => e.name)).toEqual(['Cam']);
    expect(r.categories['no-address']).toEqual([]);
  });

  it('PLCInput signals with allowWebToPlc off → hint', () => {
    const r = matchPlcSignals(model, { signals: [], allowWebToPlc: false }, 'S7');
    expect(r.hints.some((h) => h.includes('Allow web to PLC'))).toBe(true);
  });
});

describe('matchPlcSignals — PLCSIM Advanced', () => {
  it('quoted struct member matches; missing tag → missing-in-plc', () => {
    const r = matchPlcSignals([
      sig('FG01_P_Camera.bEnable', 'PLCOutputBool', '%Q108.0 · Kamera'),
      sig('BT4_AutoStart', 'PLCInputBool', '%I0.2 · Auto'),
      sig('Gone', 'PLCOutputBool'),
    ], {
      signals: [],
      allowWebToPlc: true,
      discovered: [
        { tag: '"FG01_P_Camera".bEnable', direction: 'output', dataType: 'Bool' },
        { tag: 'BT4_AutoStart', direction: 'input', dataType: 'Bool' },
        { tag: 'Unused', direction: 'output', dataType: 'Int' },
      ],
    }, 'PlcSimAdvanced');
    expect(r.categories.mappable.map((e) => [e.name, e.protocolAddress])).toEqual([
      ['FG01_P_Camera.bEnable', '"FG01_P_Camera".bEnable'],
      ['BT4_AutoStart', 'BT4_AutoStart'],
    ]);
    expect(r.categories['missing-in-plc'].map((e) => e.name)).toEqual(['Gone']);
    expect(r.categories['plc-only'].map((e) => e.name)).toEqual(['Unused']);
    expect(r.dataBlockFilter).toEqual([]);
  });

  it('two tags normalising equal → ambiguous', () => {
    const r = matchPlcSignals([sig('A.b', 'PLCOutputBool')], {
      signals: [],
      discovered: [{ tag: '"A".b' }, { tag: 'A.b' }],
    }, 'PlcSimAdvanced');
    expect(r.categories.ambiguous.map((e) => e.name)).toEqual(['A.b']);
    expect(r.categories['plc-only']).toEqual([]);
  });

  it('DB member missing from the IO browse → dataBlockFilter hint, builder side merges the filter', () => {
    const r = matchPlcSignals([
      sig('Recipe.Step', 'PLCOutputInt'),
      sig('FG01_P_Camera.bMissing', 'PLCOutputBool'),
    ], {
      signals: [],
      discovered: [{ tag: '"FG01_P_Camera".bEnable', direction: 'output' }],
    }, 'PlcSimAdvanced');
    expect(r.dataBlockFilter).toEqual(['Recipe']);
    expect(r.hints.some((h) => h.startsWith('dataBlockFilter: ["Recipe"]'))).toBe(true);
    expect(mergeDataBlockFilter('', r.dataBlockFilter)).toBe('Recipe');
    expect(mergeDataBlockFilter('"Other", Recipe', ['Recipe', 'New'])).toBe('Other,Recipe,New');
  });

  it('a DB already in the filter is not suggested again', () => {
    const r = matchPlcSignals([sig('Recipe.Step', 'PLCOutputInt')], {
      signals: [], dataBlockFilter: 'Recipe',
      discovered: [{ tag: 'X', direction: 'output' }],
    }, 'PlcSimAdvanced');
    expect(r.dataBlockFilter).toEqual([]);
  });
});

describe('buildInterfaceSignals', () => {
  const model = [
    sig('Start', 'PLCInputBool', '%I0.0 · Start button'),
    sig('Speed', 'PLCOutputFloat', '%QD12 · Speed'),
    sig('Count', 'PLCOutputInt', '%QW8 · Count'),
  ];
  const foreign: ConnectInterfaceSignal = { name: 'Foreign', protocolAddress: '%M0.0', type: 'PLCOutputBool', record: true };

  it('merges, never removes plc-only, types follow the model kind', () => {
    const existing = [foreign];
    const r = matchPlcSignals(model, { signals: existing, allowWebToPlc: true }, 'S7');
    const out = buildInterfaceSignals(r, existing);
    expect(out.map((s) => s.name)).toEqual(['Foreign', 'Start', 'Speed', 'Count']);
    expect(out[0]).toEqual(foreign);
    expect(out[1]).toEqual({ name: 'Start', protocolAddress: '%I0.0', type: 'PLCInputBool', dataType: 'Bool', comment: 'Start button', record: false });
    expect(out[2]).toMatchObject({ type: 'PLCOutputFloat', dataType: 'Real' });
    expect(out[3]).toMatchObject({ type: 'PLCOutputInt', dataType: 'Int' });
  });

  // plan-589 F9: the legacy seed became an explicit, MERGE-ONLY action. A CONNECT interface's own
  // address is the commissioned truth; a GLB comment may seed a missing one and nothing else.
  it('never overwrites an existing CONNECT address (merge-only)', () => {
    const existing: ConnectInterfaceSignal[] = [{ name: 'Start', protocolAddress: '%I9.9', type: 'PLCInputBool', record: true }];
    const r = matchPlcSignals(model, { signals: existing }, 'S7');
    expect(r.categories['address-mismatch'].map((e) => e.name)).toEqual(['Start']);
    // The mismatch is REPORTED, not applied — and it is not counted as work either.
    expect(r.counts.toApply).toBe(2);
    const out = buildInterfaceSignals(r, existing);
    expect(out[0]).toEqual(existing[0]);
    expect(out).toHaveLength(3);
  });

  it('seeds an address from the Unity Metadata when the comment carries none', () => {
    const fromMeta: ModelPlcSignal = {
      name: 'Valve', localName: 'Valve', type: 'PLCOutputBool', metadataAddress: '%Q3.1',
    };
    const r = matchPlcSignals([fromMeta], { signals: [] }, 'S7');
    expect(r.categories.mappable.map((e) => e.protocolAddress)).toEqual(['%Q3.1']);
    expect(buildInterfaceSignals(r, [])[0]).toMatchObject({ name: 'Valve', protocolAddress: '%Q3.1' });
  });

  it('prefers the comment address over the Metadata one', () => {
    const both: ModelPlcSignal = {
      name: 'Valve', localName: 'Valve', type: 'PLCOutputBool',
      comment: '%Q4.2 · Valve', metadataAddress: '%Q3.1',
    };
    expect(matchPlcSignals([both], { signals: [] }, 'S7').categories.mappable[0].protocolAddress).toBe('%Q4.2');
  });

  it('ignores a Metadata value that is not an address of this protocol', () => {
    const modbus: ModelPlcSignal = {
      name: 'Valve', localName: 'Valve', type: 'PLCOutputBool', metadataAddress: 'HR40001',
    };
    const r = matchPlcSignals([modbus], { signals: [] }, 'S7');
    expect(r.counts.mappable).toBe(0);
    expect(r.categories['no-address'].map((e) => e.name)).toEqual(['Valve']);
  });

  it('is idempotent', () => {
    const r1 = matchPlcSignals(model, { signals: [foreign] }, 'S7');
    const once = buildInterfaceSignals(r1, [foreign]);
    const r2 = matchPlcSignals(model, { signals: once }, 'S7');
    expect(r2.counts.mapped).toBe(3);
    expect(r2.counts.toApply).toBe(0);
    expect(buildInterfaceSignals(r2, once)).toEqual(once);
  });

  it('PLCSIM keeps the PLC spelling as protocolAddress and the model name as name', () => {
    const r = matchPlcSignals([sig('FG01_P_Camera.bEnable', 'PLCOutputBool')], {
      signals: [], discovered: [{ tag: '"FG01_P_Camera".bEnable', direction: 'output', dataType: 'Bool' }],
    }, 'PlcSimAdvanced');
    const out = buildInterfaceSignals(r, []);
    expect(out).toEqual([{ name: 'FG01_P_Camera.bEnable', protocolAddress: '"FG01_P_Camera".bEnable', type: 'PLCOutputBool', dataType: 'Bool', record: false }]);
  });

  it('skips conflicts on apply', () => {
    const r = matchPlcSignals([sig('Bad', 'PLCOutputBool', '%I3.0 · wrong')], { signals: [] }, 'S7');
    expect(buildInterfaceSignals(r, [])).toEqual([]);
  });
});

describe('collectModelPlcSignals', () => {
  it('reads the GLB comment from rv_extras, not the SignalStore meta', () => {
    const nodes: Record<string, { name: string; userData: Record<string, unknown> }> = {
      'Root/Start': { name: 'Start', userData: { realvirtual: { PLCInputBool: { Name: 'Start', Comment: '%I0.0 · Start' } } } },
      'Root/Lamp': { name: 'Lamp', userData: { realvirtual: { PLCOutputBool: {} } } },
    };
    const viewer = {
      registry: {
        getAll: <T,>(type: string) => (type === 'PLCInputBool'
          ? [{ path: 'Root/Start', instance: { signalName: 'Start' } as T }]
          : type === 'PLCOutputBool' ? [{ path: 'Root/Lamp', instance: { signalName: 'Lamp' } as T }] : []),
        getNode: (p: string) => nodes[p] ?? null,
      },
    };
    expect(collectModelPlcSignals(viewer)).toEqual([
      // plan-589: `localName` is the persisted asset-local symbol — identical to
      // the runtime name here, because both signals are authored.
      { name: 'Lamp', localName: 'Lamp', type: 'PLCOutputBool', path: 'Root/Lamp' },
      { name: 'Start', localName: 'Start', type: 'PLCInputBool', path: 'Root/Start', comment: '%I0.0 · Start' },
    ]);
    expect(collectModelPlcSignals({ registry: null })).toEqual([]);
  });

  /**
   * plan-589 F9 / test 9.10. SYNTHETIC fixture: no GLB in this repository carries PLC
   * `Metadata`, so the two shapes below are built from the documented Unity format (a list of
   * `{Key, Value}` pairs, or a plain object) rather than taken from a real export. If a real
   * export ever lands here, replace these literals with it — the assertions stay the same.
   */
  it('reads the Unity Metadata address in BOTH shapes', () => {
    const nodes: Record<string, { name: string; userData: Record<string, unknown> }> = {
      'Root/AsList': { name: 'AsList', userData: { realvirtual: { PLCInputBool: {
        Name: 'AsList',
        Metadata: [{ Key: 'TagName', Value: '"DB_FG01".Start' }, { Key: 'Address', Value: '%I0.4' }],
      } } } },
      'Root/AsObject': { name: 'AsObject', userData: { realvirtual: { PLCOutputBool: {
        Name: 'AsObject', Metadata: { ModbusAddress: 'HR40001', Address: ' %Q7.2 ' },
      } } } },
    };
    const viewer = {
      registry: {
        getAll: <T,>(type: string) => (type === 'PLCInputBool'
          ? [{ path: 'Root/AsList', instance: { signalName: 'AsList' } as T }]
          : type === 'PLCOutputBool' ? [{ path: 'Root/AsObject', instance: { signalName: 'AsObject' } as T }] : []),
        getNode: (pth: string) => nodes[pth] ?? null,
      },
    };
    const signals = collectModelPlcSignals(viewer);
    // `Address` wins over `TagName` / `ModbusAddress` (the key order of the list), and the value
    // is trimmed.
    expect(signals.find((x) => x.name === 'AsList')?.metadataAddress).toBe('%I0.4');
    expect(signals.find((x) => x.name === 'AsObject')?.metadataAddress).toBe('%Q7.2');
  });

  it('answers null for metadata that carries no address', () => {
    expect(readMetadataAddress(undefined)).toBeNull();
    expect(readMetadataAddress([])).toBeNull();
    expect(readMetadataAddress({ Weight: '12' })).toBeNull();
    expect(readMetadataAddress([{ Key: 'Address', Value: '   ' }])).toBeNull();
    // A camelCasing serialiser on the way out must not hide the pair.
    expect(readMetadataAddress([{ key: 'address', value: 'DB1.DBX0.0' }])).toBe('DB1.DBX0.0');
  });
});
