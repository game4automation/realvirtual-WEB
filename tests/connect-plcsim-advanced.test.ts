// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-491 lane web — the `PlcSimAdvanced` interface type in the CONNECT panel.
 *
 * Three claims: the TypeScript defaults mirror the gateway's `PlcSimAdvancedSettings`
 * POCO field for field in camelCase; picking the type in the Add flow produces a payload
 * carrying ONLY the nested `plcSimAdvanced` block (no S7 `ipAddress`/`rack`/`slot` — the
 * native API needs no coupler); and the interface card summarises the instance name.
 */

import { describe, expect, it } from 'vitest';
import {
  CONNECT_INTERFACE_TYPES,
  PLCSIMADVANCED_SETTINGS_DEFAULTS,
  nextInterfaceId,
  type ConnectInterface,
  type PlcSimAdvancedSettings,
} from '../src/core/hmi/connect-store';
import { interfaceEndpointLabel } from '../src/core/hmi/ConnectPanel';

const def = CONNECT_INTERFACE_TYPES.find(({ type }) => type === 'PlcSimAdvanced');

describe('PLCSIM Advanced interface defaults', () => {
  it('matches the CONNECT PlcSimAdvancedSettings POCO defaults', () => {
    expect(PLCSIMADVANCED_SETTINGS_DEFAULTS).toEqual({
      instanceName: 'PLCSimInstance',
      remoteAddress: '',
      apiPathOverride: '',
      hmiTagsOnly: false,
      dataBlockFilter: '',
      regExImportSignals: [],
      regExSkipSignals: [],
      regExSymbolIsInput: [],
      ensureRunning: false,
    });
  });

  it('is registered in the Add-Interface catalog with its own label and nested defaults', () => {
    expect(def).toBeDefined();
    expect(def!.label).toBe('Siemens PLCSIM Advanced (native API)');
    expect(def!.defaults).toEqual({ plcSimAdvanced: PLCSIMADVANCED_SETTINGS_DEFAULTS });
    expect(nextInterfaceId('PlcSimAdvanced')).toBe('plcsim-advanced-1');
  });

  it('copies the regex lists so the catalog defaults cannot be mutated by an edit', () => {
    const block = def!.defaults.plcSimAdvanced as PlcSimAdvancedSettings;
    block.regExImportSignals.push('^Motor.*');
    expect(PLCSIMADVANCED_SETTINGS_DEFAULTS.regExImportSignals).toEqual([]);
    block.regExImportSignals.length = 0;
  });
});

describe('PLCSIM Advanced add flow', () => {
  // Mirrors the payload `AddInterfaceDialog` posts when the type is picked.
  const payload = {
    id: nextInterfaceId('PlcSimAdvanced'),
    type: 'PlcSimAdvanced' as const,
    enabled: false,
    ...(JSON.parse(JSON.stringify(def!.defaults)) as Record<string, unknown>),
  } as Omit<ConnectInterface, 'signals'>;

  it('creates the nested plcSimAdvanced block with the backend defaults', () => {
    expect(payload.plcSimAdvanced).toEqual(PLCSIMADVANCED_SETTINGS_DEFAULTS);
  });

  it('carries no S7 coupler fields — the native API needs neither rack nor slot', () => {
    expect(payload.ipAddress).toBeUndefined();
    expect(payload.rack).toBeUndefined();
    expect(payload.slot).toBeUndefined();
  });
});

describe('PLCSIM Advanced camelCase round-trip', () => {
  it('survives a JSON round-trip through the gateway naming policy', () => {
    const wire = {
      id: 'plcsim-advanced-1',
      type: 'PlcSimAdvanced',
      enabled: true,
      signals: [],
      plcSimAdvanced: {
        instanceName: 'Line7',
        remoteAddress: '192.168.0.20:50000',
        apiPathOverride: 'C:\\Siemens\\Api\\Runtime.dll',
        hmiTagsOnly: true,
        dataBlockFilter: 'Data_block_1, Recipe',
        regExImportSignals: ['^Motor.*'],
        regExSkipSignals: ['.*_internal$'],
        regExSymbolIsInput: ['.*_Cmd$'],
        ensureRunning: true,
      },
    };

    const parsed = JSON.parse(JSON.stringify(wire)) as ConnectInterface;

    expect(parsed.plcSimAdvanced).toEqual(wire.plcSimAdvanced);
    expect(parsed.plcSimAdvanced!.instanceName).toBe('Line7');
    expect(parsed.plcSimAdvanced!.hmiTagsOnly).toBe(true);
    expect(parsed.plcSimAdvanced!.ensureRunning).toBe(true);
    expect(parsed.plcSimAdvanced!.regExSymbolIsInput).toEqual(['.*_Cmd$']);
    // Re-serialising must not rename a field — the gateway reads camelCase only.
    expect(Object.keys(JSON.parse(JSON.stringify(parsed)).plcSimAdvanced)).toEqual(
      Object.keys(PLCSIMADVANCED_SETTINGS_DEFAULTS),
    );
  });
});

describe('PLCSIM Advanced card summary', () => {
  it('shows the instance name as the endpoint summary', () => {
    const iface = {
      id: 'plcsim-advanced-1',
      type: 'PlcSimAdvanced',
      enabled: true,
      signals: [],
      plcSimAdvanced: { ...PLCSIMADVANCED_SETTINGS_DEFAULTS, instanceName: 'Line7' },
    } as unknown as ConnectInterface;

    expect(interfaceEndpointLabel(iface)).toBe('Line7');
  });

  it('degrades to an empty summary when the block is missing (legacy config)', () => {
    const iface = {
      id: 'plcsim-advanced-2', type: 'PlcSimAdvanced', enabled: false, signals: [],
    } as unknown as ConnectInterface;

    expect(interfaceEndpointLabel(iface)).toBe('');
  });
});
