// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-352 §9.3 / F9 — a pure DIRECTION change must not rewrite a signal's value kind.
 *
 * The regression this guards: `SignalConfig.DataType` is initialized to `""` server-side, so the
 * dialog's old `editSignal?.dataType ?? schema.dataTypes[0]` seed never fired its fallback for the
 * real legacy case and silently fell through to the schema's FIRST data type — `Bool` for MQTT.
 * Switching `PLCOutputFloat` to "Write to PLC" therefore saved `PLCInputBool`.
 *
 * Covered here: the seeding rule itself (empty / whitespace / missing dataType derived from the
 * wire type, `Text` → `String`), the rendered wire type after an actual direction toggle, and the
 * discovery bind that now persists the data type in the first place.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { SignalEditDialog, seedSignalDataType } from '../src/core/hmi/SignalEditDialog';
import { rvDarkTheme } from '../src/core/hmi/theme';
import {
  connectToServer,
  bindSelectedSignals,
  selectAllSignals,
  startDiscovery,
  _resetConnectStore,
  type ConnectInterface,
  type ConnectInterfaceSignal,
  type ConnectSignalSchema,
} from '../src/core/hmi/connect-store';

/** MQTT schema as the gateway reports it — note Bool FIRST and `String` (not `Text`). */
const MQTT_SCHEMA: ConnectSignalSchema = {
  supportsDiscovery: true,
  supportsManualAdd: true,
  addressValidatable: true,
  directionFromAddress: false,
  addressLabel: 'Topic',
  addressHint: 'MQTT topic',
  addressExamples: ['rv/demo/out/OpenDoor'],
  dataTypes: ['Bool', 'Int', 'Float', 'String'],
};

/** S7 schema — its float type is called `Real`, so the derived `Float` needs a kind match. */
const S7_SCHEMA: ConnectSignalSchema = {
  ...MQTT_SCHEMA,
  directionFromAddress: true,
  addressLabel: 'Address',
  dataTypes: ['Bool', 'Byte', 'Word', 'Int', 'DWord', 'DInt', 'Real', 'LReal'],
};

const signal = (over: Partial<ConnectInterfaceSignal>): ConnectInterfaceSignal => ({
  name: 'CycleTime',
  protocolAddress: 'rv/demo/in/CycleTime',
  type: 'PLCOutputFloat',
  record: false,
  ...over,
});

const mqttIface: ConnectInterface = {
  id: 'mqtt-1',
  type: 'MQTT',
  enabled: true,
  signals: [],
};

/** Render the edit dialog for `editSignal` and return the currently shown wire type. */
function renderDialog(editSignal: ConnectInterfaceSignal, schema = MQTT_SCHEMA) {
  render(createElement(
    ThemeProvider,
    { theme: rvDarkTheme },
    createElement(SignalEditDialog, {
      open: true,
      onClose: () => {},
      iface: mqttIface,
      schema,
      editSignal,
    }),
  ));
}

function shownWireType(): string {
  return screen.getByText(/^wire type: /).textContent!.replace('wire type: ', '');
}

beforeEach(() => {
  _resetConnectStore();
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  _resetConnectStore();
});

describe('signal edit — data type survives a direction change (F9)', () => {
  it('directionChange_preservesFloatType', () => {
    // BLOCKER regression: PLCOutputFloat → PLCInputFloat, never PLCInputBool.
    renderDialog(signal({ type: 'PLCOutputFloat', dataType: 'Float' }));
    expect(shownWireType()).toBe('PLCOutputFloat');

    fireEvent.click(screen.getByText('Write to PLC'));
    expect(shownWireType()).toBe('PLCInputFloat');
  });

  it('directionChange_preservesIntType', () => {
    renderDialog(signal({ name: 'Counter', type: 'PLCOutputInt', dataType: 'Int' }));
    fireEvent.click(screen.getByText('Write to PLC'));
    expect(shownWireType()).toBe('PLCInputInt');
  });

  it('emptyStringDataType_derivedFromWireType', () => {
    // BLOCKER regression: the REAL legacy case is `""`, not `undefined` — `??` never fires for it.
    expect(seedSignalDataType(signal({ type: 'PLCOutputFloat', dataType: '' }), MQTT_SCHEMA)).toBe('Float');

    renderDialog(signal({ type: 'PLCOutputFloat', dataType: '' }));
    fireEvent.click(screen.getByText('Write to PLC'));
    expect(shownWireType()).toBe('PLCInputFloat');
  });

  it('whitespaceDataType_derivedFromWireType', () => {
    expect(seedSignalDataType(signal({ type: 'PLCOutputFloat', dataType: '  ' }), MQTT_SCHEMA)).toBe('Float');
    expect(seedSignalDataType(signal({ type: 'PLCOutputInt', dataType: '\t' }), MQTT_SCHEMA)).toBe('Int');
  });

  it('textWireType_mapsToStringDataType', () => {
    // The wire kind is `Text`, the schema data type is `String` — a plain suffix hand-over would
    // seed an invalid value and the select would fall back to blank.
    const seeded = seedSignalDataType(signal({ type: 'PLCOutputText', dataType: '' }), MQTT_SCHEMA);
    expect(seeded).toBe('String');
    expect(MQTT_SCHEMA.dataTypes).toContain(seeded);
  });

  it('falls back to the schema default only when nothing can be derived', () => {
    expect(seedSignalDataType(signal({ type: 'Whatever', dataType: '' }), MQTT_SCHEMA)).toBe('Bool');
    expect(seedSignalDataType(null, MQTT_SCHEMA)).toBe('Bool');
    // An explicit data type always wins, even one the schema does not list.
    expect(seedSignalDataType(signal({ type: 'PLCOutputFloat', dataType: 'Custom' }), MQTT_SCHEMA)).toBe('Custom');
  });

  it('matches the derived type to the schema vocabulary (S7 Float → Real)', () => {
    // Exact/case-insensitive match first, then by value kind — never the schema's first entry.
    expect(seedSignalDataType(signal({ type: 'PLCOutputFloat', dataType: '' }), S7_SCHEMA)).toBe('Real');
    expect(seedSignalDataType(signal({ type: 'PLCOutputBool', dataType: '' }), S7_SCHEMA)).toBe('Bool');
    // No schema at all (older gateway) → the derived type as-is.
    expect(seedSignalDataType(signal({ type: 'PLCOutputFloat', dataType: '' }), null)).toBe('Float');
  });
});

describe('discovery bind persists the data type (F9, client side)', () => {
  it('discoveryBind_persistsDataType', async () => {
    const bindBodies: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const json = (body: unknown, status = 200) => Promise.resolve(new Response(
        JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

      if (urlStr.includes('/health')) return json({ status: 'ok' });
      if (urlStr.includes('/interface-types')) {
        return json({ types: [{ type: 'MQTT', label: 'MQTT', description: '', defaults: {}, signals: MQTT_SCHEMA }] });
      }
      if (urlStr.includes('/discover/mqtt-1/start')) {
        return json({
          signals: [
            { name: 'rv/demo/in/CycleTime', displayName: 'CycleTime', dataType: 'Float', direction: 'unknown', browsePath: 'rv/demo/in/CycleTime' },
          ],
        });
      }
      if (urlStr.includes('/discover/mqtt-1/bind')) {
        bindBodies.push(JSON.parse(init!.body as string));
        return json({ success: true, bound: 1 });
      }
      return json([{ ...mqttIface }]);
    });

    await connectToServer();
    await startDiscovery('mqtt-1');
    selectAllSignals(true);
    await bindSelectedSignals('mqtt-1');

    expect(bindBodies).toHaveLength(1);
    expect((bindBodies[0] as Array<Record<string, unknown>>)[0]).toMatchObject({
      protocolAddress: 'rv/demo/in/CycleTime',
      signalName: 'CycleTime',
      type: 'PLCOutputFloat',
      dataType: 'Float',
    });
  });
});
