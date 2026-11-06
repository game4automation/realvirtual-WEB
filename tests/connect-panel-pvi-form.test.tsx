// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-552 Phase 7 — CONNECT edit form for the B&R PVI interface, and the text-signal binding.
 *
 * The form assertions go through the real Save path of `EditInterfaceDialog`: the PUT body that
 * reaches `/config/interfaces/{id}` is what the gateway stores, so the nested `pvi` key and its
 * camelCase field names are pinned here against `PviSettings` (ProtocolSettings.cs). The password
 * follows the Keba/Festo convention: `GET /config` redacts it to null, an untouched field stays
 * null in the PUT body and the gateway keeps the stored value (`PreserveOmittedCredentials`).
 *
 * The binding assertions pin that a text data type (`Text`, `String`, `STRING`, `WSTRING`) binds as
 * a `PLC…Text` signal, while Bool / Int / Float keep their previous wire types.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import {
  _resetConnectStore,
  bindSelectedSignals,
  CONNECT_INTERFACE_TYPES,
  discoveredSignalWireType,
  fetchInterfaceTypes,
  getAvailableInterfaceTypes,
  isTextDataType,
  nextInterfaceId,
  PVI_SETTINGS_DEFAULTS,
  selectAllSignals,
  startDiscovery,
  type ConnectInterface,
} from '../src/core/hmi/connect-store';
import { EditInterfaceDialog, interfaceEndpointLabel } from '../src/core/hmi/ConnectPanel';
import { seedSignalDataType } from '../src/core/hmi/SignalEditDialog';
import { rvDarkTheme } from '../src/core/hmi/theme';

let puts: Array<{ url: string; body: Record<string, unknown> }> = [];
let bindBodies: Array<Array<Record<string, unknown>>> = [];
let discovered: Array<Record<string, unknown>> = [];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function stubGateway(catalogTypes: string[] = []): void {
  puts = [];
  bindBodies = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'PUT') puts.push({ url: u, body: JSON.parse(String(init.body)) });
    if (u.endsWith('/interface-types')) {
      return json({ types: catalogTypes.map(type => ({ type, label: type, description: '', defaults: {} })) });
    }
    if (u.includes('/discover/pvi-1/start')) return json({ signals: discovered });
    if (u.includes('/discover/pvi-1/bind')) {
      bindBodies.push(JSON.parse(String(init!.body)));
      return json({ success: true });
    }
    if (u.endsWith('/config/interfaces')) return json([]);
    return json({});
  }));
}

function renderDialog(iface: ConnectInterface) {
  return render(
    <ThemeProvider theme={rvDarkTheme}>
      <EditInterfaceDialog iface={iface} open onClose={() => {}} />
    </ThemeProvider>,
  );
}

function pviIface(pvi?: Record<string, unknown>): ConnectInterface {
  return { id: 'pvi-1', type: 'Pvi', enabled: true, signals: [], ...(pvi ? { pvi } : {}) } as ConnectInterface;
}

function change(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Opens the Connection select and picks an option by its visible text. */
function pickConnection(optionText: string): void {
  fireEvent.mouseDown(screen.getByRole('combobox'));
  fireEvent.click(within(screen.getByRole('listbox')).getByText(optionText));
}

async function savePvi(): Promise<Record<string, unknown>> {
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(puts).toHaveLength(1));
  return puts[0].body.pvi as Record<string, unknown>;
}

beforeEach(() => {
  _resetConnectStore();
  stubGateway();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  _resetConnectStore();
});

describe('plan-552 Pvi type registry', () => {
  it('carries the Pvi type with the catalog label, its defaults and the id prefix', () => {
    const def = CONNECT_INTERFACE_TYPES.find(d => d.type === 'Pvi');
    expect(def).toBeTruthy();
    expect(def!.label).toBe('B&R PVI (ANSL/INA2000)');
    expect(def!.gatewayOnly).toBe(true);
    expect(def!.defaults).toEqual({ pvi: PVI_SETTINGS_DEFAULTS });
    expect(nextInterfaceId('Pvi')).toBe('pvi-1');
  });

  it('defaults mirror PviSettings', () => {
    expect(PVI_SETTINGS_DEFAULTS).toEqual({
      connectionType: 'Ansl', host: '127.0.0.1', port: null, communicationTimeoutMs: 1500,
      userName: null, password: null, sourceStation: 1, destinationStation: 2, localPort: 0,
      refreshTimeMs: 100, cpuStatePollSeconds: 2, licensePollSeconds: 60, apiPathOverride: null,
      maxBrowseVariables: 5000,
    });
  });

  it('offers Pvi only when the gateway catalog reports it (gatewayOnly)', async () => {
    expect(getAvailableInterfaceTypes().map(d => d.type)).not.toContain('Pvi');

    stubGateway(['S7', 'Udp']);
    await fetchInterfaceTypes();
    expect(getAvailableInterfaceTypes().map(d => d.type)).not.toContain('Pvi');

    _resetConnectStore();
    stubGateway(['S7', 'Pvi']);
    await fetchInterfaceTypes();
    expect(getAvailableInterfaceTypes().map(d => d.type)).toContain('Pvi');
  });
});

describe('Pvi card summary', () => {
  it('shows the line and the host, with the port when one is set', () => {
    expect(interfaceEndpointLabel(pviIface({ connectionType: 'Ansl', host: '127.0.0.1', port: null }))).toBe('ANSL 127.0.0.1');
    expect(interfaceEndpointLabel(pviIface({ connectionType: 'Ansl', host: '10.0.0.7', port: 11170 }))).toBe('ANSL 10.0.0.7:11170');
    expect(interfaceEndpointLabel(pviIface({ connectionType: 'Ina2000', host: 'cpu1', port: null }))).toBe('INA2000 cpu1');
    expect(interfaceEndpointLabel(pviIface())).toBe('');
  });
});

describe('Pvi edit form', () => {
  it('renders the block with ANSL defaults and hides the station fields', () => {
    renderDialog(pviIface());
    expect(screen.getByRole('combobox').textContent).toBe('ANSL (TCP)');
    expect((screen.getByLabelText('Host') as HTMLInputElement).value).toBe('127.0.0.1');
    expect((screen.getByLabelText('Port (empty = PVI default)') as HTMLInputElement).value).toBe('');
    expect(screen.getByLabelText('Timeout (ms)')).toBeTruthy();
    expect(screen.getByLabelText('User')).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(screen.getByLabelText('Refresh (ms)')).toBeTruthy();
    expect(screen.getByLabelText('CPU poll (s)')).toBeTruthy();
    expect(screen.queryByLabelText('Source station')).toBeNull();
    expect(screen.queryByLabelText('Destination station')).toBeNull();
    expect(screen.getByRole('button', { name: 'Advanced' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('saves every field under pvi', async () => {
    renderDialog(pviIface());
    pickConnection('INA2000 (TCP/IP)');
    change('Host', '192.168.0.50');
    change('Port (empty = PVI default)', '11160');
    change('Timeout (ms)', '3000');
    change('User', 'operator');
    change('Password', 'pw-1');
    change('Refresh (ms)', '50');
    change('CPU poll (s)', '5');
    change('Source station', '3');
    change('Destination station', '7');
    change('Local port (0 = default)', '11159');
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    change('PVI path override', 'D:\\PVI\\PviServices\\VS2012');
    change('Licence poll (s)', '120');
    change('Max browse variables', '800');

    const pvi = await savePvi();
    expect(pvi).toEqual({
      connectionType: 'Ina2000', host: '192.168.0.50', port: 11160, communicationTimeoutMs: 3000,
      userName: 'operator', password: 'pw-1', sourceStation: 3, destinationStation: 7, localPort: 11159,
      refreshTimeMs: 50, cpuStatePollSeconds: 5, licensePollSeconds: 120,
      apiPathOverride: 'D:\\PVI\\PviServices\\VS2012', maxBrowseVariables: 800,
    });
    expect(puts[0].url).toContain('/config/interfaces/pvi-1');
  });

  it('keeps a redacted password null so the gateway keeps the stored one', async () => {
    renderDialog(pviIface({ ...PVI_SETTINGS_DEFAULTS, userName: 'op', password: null }));
    change('Refresh (ms)', '200');
    const pvi = await savePvi();
    expect(pvi.password).toBeNull();
    expect(pvi.userName).toBe('op');
    expect(pvi.refreshTimeMs).toBe(200);
  });

  it('an emptied port saves null (PVI default)', async () => {
    renderDialog(pviIface({ ...PVI_SETTINGS_DEFAULTS, port: 11169 }));
    change('Port (empty = PVI default)', '');
    expect((await savePvi()).port).toBeNull();
  });

  it('switching ANSL ⇔ INA2000 shows and hides the station fields and saves the connection type', async () => {
    renderDialog(pviIface());
    pickConnection('INA2000 (TCP/IP)');
    expect(screen.getByLabelText('Source station')).toBeTruthy();
    expect(screen.getByLabelText('Destination station')).toBeTruthy();
    expect(screen.getByLabelText('Local port (0 = default)')).toBeTruthy();

    pickConnection('ANSL (TCP)');
    expect(screen.queryByLabelText('Source station')).toBeNull();
    expect(screen.queryByLabelText('Destination station')).toBeNull();
    expect((await savePvi()).connectionType).toBe('Ansl');
  });

  it('loads a stored configuration into the fields', () => {
    renderDialog(pviIface({
      connectionType: 'Ina2000', host: 'plc-7', port: 11160, communicationTimeoutMs: 2500,
      userName: 'svc', password: null, sourceStation: 4, destinationStation: 9, localPort: 0,
      refreshTimeMs: 250, cpuStatePollSeconds: 3, licensePollSeconds: 30,
      apiPathOverride: 'C:\\pvi', maxBrowseVariables: 1000,
    }));
    const value = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).value;
    expect(screen.getByRole('combobox').textContent).toBe('INA2000 (TCP/IP)');
    expect(value('Host')).toBe('plc-7');
    expect(value('Port (empty = PVI default)')).toBe('11160');
    expect(value('Timeout (ms)')).toBe('2500');
    expect(value('User')).toBe('svc');
    expect(value('Password')).toBe('');
    expect(value('Refresh (ms)')).toBe('250');
    expect(value('CPU poll (s)')).toBe('3');
    expect(value('Source station')).toBe('4');
    expect(value('Destination station')).toBe('9');
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(value('PVI path override')).toBe('C:\\pvi');
    expect(value('Licence poll (s)')).toBe('30');
    expect(value('Max browse variables')).toBe('1000');
  });

  it('fills a partial stored block with the defaults', async () => {
    renderDialog(pviIface({ host: 'only-host' }));
    expect(await savePvi()).toEqual({ ...PVI_SETTINGS_DEFAULTS, host: 'only-host' });
  });
});

describe('text signal binding (plan-552 Phase 7)', () => {
  it('recognises the text data types, case-insensitive, with a declared length', () => {
    for (const dt of ['Text', 'TEXT', 'String', 'STRING', 'string', 'WString', 'WSTRING', 'STRING[80]', ' String(20) ']) {
      expect(isTextDataType(dt), dt).toBe(true);
    }
    for (const dt of ['Bool', 'Int', 'Float', 'Real', 'DInt', '', 'Strings', 'StringArray']) {
      expect(isTextDataType(dt), dt).toBe(false);
    }
    expect(isTextDataType(null)).toBe(false);
    expect(isTextDataType(undefined)).toBe(false);
  });

  it('maps text data types to PLC…Text and keeps Bool / Int / Float and the Float fallback', () => {
    expect(discoveredSignalWireType('output', 'Text')).toBe('PLCOutputText');
    expect(discoveredSignalWireType('output', 'String')).toBe('PLCOutputText');
    expect(discoveredSignalWireType('input', 'STRING')).toBe('PLCInputText');
    expect(discoveredSignalWireType('output', 'WSTRING')).toBe('PLCOutputText');
    expect(discoveredSignalWireType('output', 'Bool')).toBe('PLCOutputBool');
    expect(discoveredSignalWireType('input', 'Int')).toBe('PLCInputInt');
    expect(discoveredSignalWireType('output', 'Float')).toBe('PLCOutputFloat');
    expect(discoveredSignalWireType('unknown', 'Double')).toBe('PLCOutputFloat');
    expect(discoveredSignalWireType('output', '')).toBe('PLCOutputFloat');
    // OPC UA built-in names (a CODESYS browse reports `Boolean`).
    expect(discoveredSignalWireType('unknown', 'Boolean')).toBe('PLCOutputBool');
    expect(discoveredSignalWireType('input', 'Int16')).toBe('PLCInputInt');
    expect(discoveredSignalWireType('output', 'SByte')).toBe('PLCOutputInt');
    // A same-named model signal is binding: direction AND kind.
    expect(discoveredSignalWireType('unknown', 'Boolean', 'PLCInputBool')).toBe('PLCInputBool');
    expect(discoveredSignalWireType('output', 'Double', 'PLCInputFloat')).toBe('PLCInputFloat');
  });

  it('binds discovered Text / String / STRING signals as PLCOutputText through the bind route', async () => {
    discovered = [
      { name: 'gName', displayName: 'gName', dataType: 'Text', direction: 'output', browsePath: 'gName' },
      { name: 'Prog1:msg', displayName: 'Prog1:msg', dataType: 'String', direction: 'output', browsePath: 'Prog1:msg' },
      { name: 'gCmd', displayName: 'gCmd', dataType: 'STRING', direction: 'input', browsePath: 'gCmd' },
      { name: 'gCounter', displayName: 'gCounter', dataType: 'Int', direction: 'output', browsePath: 'gCounter' },
      { name: 'gOn', displayName: 'gOn', dataType: 'Bool', direction: 'output', browsePath: 'gOn' },
      { name: 'stData.Speed', displayName: 'stData.Speed', dataType: 'Float', direction: 'output', browsePath: 'stData.Speed' },
    ];
    await startDiscovery('pvi-1');
    selectAllSignals(true);
    await bindSelectedSignals('pvi-1');

    expect(bindBodies).toHaveLength(1);
    const byAddress = Object.fromEntries(bindBodies[0].map(b => [b.protocolAddress, b]));
    expect(byAddress['gName']).toMatchObject({ type: 'PLCOutputText', dataType: 'Text' });
    expect(byAddress['Prog1:msg']).toMatchObject({ type: 'PLCOutputText', dataType: 'String', signalName: 'Prog1_msg' });
    expect(byAddress['gCmd']).toMatchObject({ type: 'PLCInputText', dataType: 'STRING' });
    expect(byAddress['gCounter']).toMatchObject({ type: 'PLCOutputInt' });
    expect(byAddress['gOn']).toMatchObject({ type: 'PLCOutputBool' });
    expect(byAddress['stData.Speed']).toMatchObject({ type: 'PLCOutputFloat' });
  });

  it('the signal dialog seeds a Text signal with a text data type, never Int or the first entry', () => {
    const textSignal = { name: 's', protocolAddress: 'gName', type: 'PLCOutputText', dataType: '' };
    const schema = (dataTypes: string[]) => ({
      supportsDiscovery: true, supportsManualAdd: true, addressValidatable: true, directionFromAddress: false,
      addressLabel: 'Variable', addressHint: '', addressExamples: [], dataTypes,
    });
    // Pvi catalog: `String` is matched by name.
    expect(seedSignalDataType(textSignal as never, schema(['Bool', 'Int', 'Float', 'String']) as never)).toBe('String');
    // A schema that calls it `Text` (the CONNECT kind name) is matched by value kind, not by the first entry.
    expect(seedSignalDataType(textSignal as never, schema(['Bool', 'Int', 'Float', 'Text']) as never)).toBe('Text');
    expect(seedSignalDataType(textSignal as never, schema(['Bool', 'Int', 'WSTRING']) as never)).toBe('WSTRING');
    // Numeric kinds unchanged.
    const floatSignal = { ...textSignal, type: 'PLCOutputFloat' };
    expect(seedSignalDataType(floatSignal as never, schema(['Bool', 'Int', 'Real']) as never)).toBe('Real');
  });
});
