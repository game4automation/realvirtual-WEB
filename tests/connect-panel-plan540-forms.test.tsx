// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-540 Phase 12 — CONNECT edit forms for the ten new interface types and the Phase 11 fields
 * of the existing ones.
 *
 * Every assertion goes through the real Save path of `EditInterfaceDialog`: the PUT body that
 * reaches `/config/interfaces/{id}` is what the gateway stores, so the nested settings key and its
 * camelCase field names are pinned here against `ProtocolSettings.cs`. Credentials follow the
 * existing Keba/Festo convention: `GET /config` redacts them to null, an untouched password field
 * stays null in the PUT body and the gateway restores the stored value
 * (`ProjectSecrets.PreserveOmittedCredentials`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import {
  _resetConnectStore,
  CONNECT_INTERFACE_TYPES,
  fetchInterfaceTypes,
  getAvailableInterfaceTypes,
  type ConnectInterface,
  type ConnectInterfaceType,
} from '../src/core/hmi/connect-store';
import { EditInterfaceDialog, interfaceEndpointLabel } from '../src/core/hmi/ConnectPanel';
import { rvDarkTheme } from '../src/core/hmi/theme';

/** The ten plan-540 types and the nested settings key each one is stored under (InterfaceConfig.cs). */
const NEW_TYPES: Array<[ConnectInterfaceType, string]> = [
  ['Kuka', 'kuka'],
  ['KukaRsi', 'kukaRsi'],
  ['UniversalRobots', 'universalRobots'],
  ['IgusRebel', 'igusRebel'],
  ['Mitsubishi', 'mitsubishi'],
  ['Udp', 'udp'],
  ['WebSocketRealtime', 'webSocketRealtime'],
  ['WinmodY200', 'winmodY200'],
  ['RoboDk', 'roboDk'],
  ['WandelbotsNova', 'wandelbotsNova'],
];

let puts: Array<{ url: string; body: Record<string, unknown> }> = [];

function stubGateway(catalogTypes: string[] = []): void {
  puts = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'PUT') puts.push({ url: u, body: JSON.parse(String(init.body)) });
    if (u.endsWith('/interface-types')) {
      return new Response(JSON.stringify({
        types: catalogTypes.map(type => ({ type, label: type, description: '', defaults: {} })),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.endsWith('/config/interfaces')) {
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
}

function renderDialog(iface: ConnectInterface) {
  return render(
    <ThemeProvider theme={rvDarkTheme}>
      <EditInterfaceDialog iface={iface} open onClose={() => {}} />
    </ThemeProvider>,
  );
}

function iface(type: ConnectInterfaceType, extra: Record<string, unknown> = {}): ConnectInterface {
  return { id: `${type.toLowerCase()}-1`, type, enabled: true, signals: [], ...extra } as ConnectInterface;
}

function change(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Clicks the checkbox that sits next to a Typography label (the panel's checkbox rows). */
function toggle(text: string): void {
  const row = screen.getByText(text).parentElement!;
  fireEvent.click(row.querySelector('input[type="checkbox"]')!);
}

/** Clicks Save and returns the nested settings block of the PUT body. */
async function save(key: string): Promise<Record<string, unknown>> {
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(puts).toHaveLength(1));
  return puts[0].body[key] as Record<string, unknown>;
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

describe('plan-540 type registry', () => {
  it('the fallback registry carries every new type with its settings defaults', () => {
    for (const [type, key] of NEW_TYPES) {
      const def = CONNECT_INTERFACE_TYPES.find(d => d.type === type);
      expect(def, type).toBeTruthy();
      expect(def!.label.length, type).toBeGreaterThan(0);
      expect(Object.keys(def!.defaults), type).toEqual([key]);
    }
    const registered = CONNECT_INTERFACE_TYPES.map(d => d.type);
    expect(NEW_TYPES.map(([t]) => t).filter(t => !registered.includes(t))).toEqual([]);
  });

  it('offers WINMOD Y200 only when the gateway catalog reports it', async () => {
    // No catalog (older gateway): the static list, without the Windows-only WINMOD entry.
    const fallback = getAvailableInterfaceTypes().map(d => d.type);
    expect(fallback).not.toContain('WinmodY200');
    for (const [type] of NEW_TYPES.filter(([t]) => t !== 'WinmodY200')) expect(fallback).toContain(type);

    // A Linux gateway catalog without the type: not offered.
    stubGateway(['Kuka', 'Udp']);
    await fetchInterfaceTypes();
    expect(getAvailableInterfaceTypes().map(d => d.type)).toEqual(['Kuka', 'Udp']);

    // A Windows gateway that reports it: offered.
    _resetConnectStore();
    stubGateway(['Kuka', 'WinmodY200']);
    await fetchInterfaceTypes();
    expect(getAvailableInterfaceTypes().map(d => d.type)).toContain('WinmodY200');
  });
});

describe('card summary of the new types', () => {
  it('shows host:port or the memory / server name', () => {
    expect(interfaceEndpointLabel(iface('Kuka', { kuka: { host: '10.0.0.2', port: 54600 } }))).toBe('10.0.0.2:54600');
    expect(interfaceEndpointLabel(iface('KukaRsi', { kukaRsi: { listenIp: '0.0.0.0', rsiPort: 49152 } }))).toBe('0.0.0.0:49152');
    expect(interfaceEndpointLabel(iface('UniversalRobots', { universalRobots: { host: '192.168.0.4', rtdePort: 30004 } }))).toBe('192.168.0.4:30004');
    expect(interfaceEndpointLabel(iface('IgusRebel', { igusRebel: { host: '1.2.3.4', port: 3921 } }))).toBe('1.2.3.4:3921');
    expect(interfaceEndpointLabel(iface('Mitsubishi', { mitsubishi: { host: '192.168.3.39', port: 5001 } }))).toBe('192.168.3.39:5001');
    expect(interfaceEndpointLabel(iface('Udp', { udp: { remoteHost: '127.0.0.1', remotePort: 11000 } }))).toBe('127.0.0.1:11000');
    expect(interfaceEndpointLabel(iface('WebSocketRealtime', { webSocketRealtime: { isServer: true, bindAddress: '127.0.0.1', address: 'x', port: 8080 } })))
      .toBe('127.0.0.1:8080 (server)');
    expect(interfaceEndpointLabel(iface('WebSocketRealtime', { webSocketRealtime: { isServer: false, bindAddress: 'x', address: 'peer', port: 9000 } })))
      .toBe('peer:9000');
    expect(interfaceEndpointLabel(iface('WinmodY200', { winmodY200: { sharedMemoryName: 'Y200' } }))).toBe('Y200');
    expect(interfaceEndpointLabel(iface('RoboDk', { roboDk: { host: 'localhost', port: 20500 } }))).toBe('localhost:20500');
    expect(interfaceEndpointLabel(iface('WandelbotsNova', { wandelbotsNova: { server: 'http://nova', cell: 'cell' } }))).toBe('http://nova (cell)');
  });
});

describe('edit forms of the new types — render and save', () => {
  it('Kuka', async () => {
    renderDialog(iface('Kuka'));
    change('Host (OC_Assistant_OfficeLite)', '10.0.0.5');
    change('Digital signals ($IN/$OUT)', '64');
    const kuka = await save('kuka');
    expect(kuka).toEqual({ host: '10.0.0.5', port: 54600, connectTimeoutMs: 5000, maxDigitalSignals: 64, axisCount: 6 });
  });

  it('KukaRsi', async () => {
    renderDialog(iface('KukaRsi'));
    change('RSI Port', '49153');
    change('Analog channels', '2');
    toggle('Echo IPOC in every answer');
    const rsi = await save('kukaRsi');
    expect(rsi).toMatchObject({ listenIp: '0.0.0.0', rsiPort: 49153, analogChannels: 2, echoIpoc: false, axisPosTag: 'AIPos' });
  });

  it('UniversalRobots — frequency accepts a decimal comma', async () => {
    renderDialog(iface('UniversalRobots'));
    change('Host (URSim or UR controller)', '192.168.56.101');
    change('Frequency (Hz)', '12,5');
    const ur = await save('universalRobots');
    expect(ur).toMatchObject({ host: '192.168.56.101', rtdePort: 30004, secondaryPort: 30001, outputFrequency: 12.5 });
  });

  it('IgusRebel', async () => {
    renderDialog(iface('IgusRebel'));
    change('Speed override (%)', '50');
    change('Cartesian velocity (mm/s)', '250.5');
    toggle('Activate the robot on connect (SetActive)');
    const igus = await save('igusRebel');
    expect(igus).toMatchObject({ port: 3921, speed: 50, cartVelocityMmPerSec: 250.5, activateOnConnect: false });
  });

  it('Mitsubishi — CSV path and import switches', async () => {
    renderDialog(iface('Mitsubishi'));
    change('Connection timeout (ms)', '3000');
    change('GX Works3 device comment CSV (path on the CONNECT machine)', 'C:\\plc\\comments.csv');
    fireEvent.click(screen.getByRole('button', { name: 'CSV import options' }));
    toggle('Special devices (SM/SD)');
    const mc = await save('mitsubishi');
    expect(mc).toMatchObject({
      host: '192.168.3.39', port: 5001, connectionTimeoutMs: 3000, csvFile: 'C:\\plc\\comments.csv',
      importSpecialDevices: true, importTimers: true,
    });
  });

  it('Udp', async () => {
    renderDialog(iface('Udp'));
    change('Remote host', '192.168.0.10');
    change('Local port', '12001');
    toggle('Little-endian INT and REAL (off = big-endian, Siemens)');
    const udp = await save('udp');
    expect(udp).toEqual({
      localPort: 12001, localBindAddress: '0.0.0.0', remoteHost: '192.168.0.10', remotePort: 11000,
      littleEndian: false, symbolTable: '', splitChar: ';',
    });
  });

  it('WebSocketRealtime — a redacted API key stays null, a typed one is sent', async () => {
    renderDialog(iface('WebSocketRealtime', {
      webSocketRealtime: { isServer: true, bindAddress: '0.0.0.0', port: 8090, apiKey: null, allowedOrigins: ['https://a.example'] },
    }));
    change('Allowed browser origins (comma-sep.)', 'https://a.example, https://b.example');
    const ws = await save('webSocketRealtime');
    expect(ws).toMatchObject({ isServer: true, bindAddress: '0.0.0.0', port: 8090, apiKey: null,
      allowedOrigins: ['https://a.example', 'https://b.example'], inputPatterns: ['Unity'] });

    cleanup(); puts = [];
    renderDialog(iface('WebSocketRealtime', { webSocketRealtime: { isServer: true, apiKey: null } }));
    change('API key', 'k-123');
    expect((await save('webSocketRealtime')).apiKey).toBe('k-123');
  });

  it('WinmodY200 — keep-alive watchdog', async () => {
    renderDialog(iface('WinmodY200'));
    change('Keep-alive (s, 0 = off)', '5');
    change('WINMOD signal list (path on the CONNECT machine)', 'C:\\winmod\\signals.txt');
    const y200 = await save('winmodY200');
    expect(y200).toEqual({
      sharedMemoryName: 'Y200', mutexName: '', mutexTimeoutMs: 1000, signalList: 'C:\\winmod\\signals.txt', keepAliveSeconds: 5,
    });
  });

  it('RoboDk', async () => {
    renderDialog(iface('RoboDk'));
    change('Program name', 'MainProg');
    change('Simulation speed', '2.5');
    toggle('Loop the program');
    const rdk = await save('roboDk');
    expect(rdk).toMatchObject({ host: 'localhost', port: 20500, programName: 'MainProg', simulationSpeed: 2.5,
      loopProgram: true, forceSimulateRunMode: true });
  });

  it('WandelbotsNova — redacted password and token stay null, edited ones are sent', async () => {
    renderDialog(iface('WandelbotsNova', {
      wandelbotsNova: { server: 'https://nova.local', cell: 'cell', motionGroup: '0@ur10e', username: 'op', password: null, token: null },
    }));
    change('Program timeout (s)', '600');
    const nova = await save('wandelbotsNova');
    expect(nova).toMatchObject({ server: 'https://nova.local', motionGroup: '0@ur10e', username: 'op',
      password: null, token: null, programTimeoutSeconds: 600 });

    cleanup(); puts = [];
    renderDialog(iface('WandelbotsNova', { wandelbotsNova: { password: null, token: null } }));
    change('Password', 'secret');
    change('Access token (wins over username / password)', 'tok');
    const edited = await save('wandelbotsNova');
    expect(edited).toMatchObject({ password: 'secret', token: 'tok' });
  });

  it('every new type renders its own block in the edit dialog', () => {
    const anchor: Record<string, string> = {
      Kuka: 'Digital signals ($IN/$OUT)', KukaRsi: 'RSI Port', UniversalRobots: 'RTDE Port',
      IgusRebel: 'Alive timeout (ms)', Mitsubishi: 'Max gap', Udp: 'Remote port', WebSocketRealtime: 'Path',
      WinmodY200: 'Mutex Name', RoboDk: 'Parameter poll (ms)', WandelbotsNova: 'Server URL',
    };
    for (const [type] of NEW_TYPES) {
      renderDialog(iface(type));
      expect(screen.getByLabelText(anchor[type]), type).toBeTruthy();
      cleanup();
    }
  });
});

describe('Phase 11 fields of existing types', () => {
  it('S7 — timeout and symbol table go into the nested s7 block', async () => {
    renderDialog(iface('S7', { ipAddress: '192.168.0.1', rack: 0, slot: 1 }));
    change('Connection timeout (ms)', '4000');
    change('TIA symbol table .sdf (path on the CONNECT machine)', 'C:\\tia\\plc.sdf');
    const s7 = await save('s7');
    expect(s7).toEqual({ connectionTimeoutMs: 4000, symbolTable: 'C:\\tia\\plc.sdf' });
    expect(puts[0].body.ipAddress).toBe('192.168.0.1');
  });

  it('Festo — certificate validation (TLS only) and timeout; redacted password stays null', async () => {
    renderDialog(iface('Festo', { festo: { host: 'plc', port: 41100, useTls: true, username: 'admin', password: null } }));
    toggle('Validate certificate (off accepts a self-signed PLCnext certificate)');
    change('Connection timeout (s)', '2,5');
    const festo = await save('festo');
    expect(festo).toMatchObject({ validateCertificate: false, connectionTimeoutSeconds: 2.5, password: null });
  });

  it('ctrlX tunnel — publish interval, empty = untouched bridge setting', async () => {
    renderDialog(iface('CtrlX', { ctrlX: { address: 'core', useSsl: false } }));
    change('Bridge publish interval (ms, empty = bridge setting)', '50');
    expect((await save('ctrlX')).publishIntervalMs).toBe(50);

    cleanup(); puts = [];
    renderDialog(iface('CtrlX', { ctrlX: { address: 'core', useSsl: false, publishIntervalMs: 50 } }));
    change('Bridge publish interval (ms, empty = bridge setting)', '');
    expect((await save('ctrlX')).publishIntervalMs).toBeNull();
  });

  it('Keba — topics and connection timeout', async () => {
    renderDialog(iface('Keba', { keba: { host: 'keba' } }));
    change('Input topic', 'rv_in');
    change('Connection timeout (s)', '7');
    const keba = await save('keba');
    expect(keba).toMatchObject({ inputTopicName: 'rv_in', outputTopicName: 'realvirtual_outputs', connectionTimeoutSeconds: 7 });
  });

  it('Modbus client — connection timeout; the server form has none', async () => {
    renderDialog(iface('Modbus', { modbus: { host: 'dev', port: 502 } }));
    change('Connection timeout (ms)', '1500');
    expect((await save('modbus')).connectionTimeoutMs).toBe(1500);

    cleanup();
    renderDialog(iface('ModbusServer'));
    expect(screen.queryByLabelText('Connection timeout (ms)')).toBeNull();
  });

  it('PLCSIM Advanced — remote address', async () => {
    renderDialog(iface('PlcSimAdvanced'));
    change('Remote address (host[:port], empty = this PC)', '192.168.0.20:50000');
    expect((await save('plcSimAdvanced')).remoteAddress).toBe('192.168.0.20:50000');
  });

  it('Denso — the hint names P positions', () => {
    renderDialog(iface('Denso'));
    expect(screen.getByText(/P<n> \(position as \.x\/\.y\/\.z\/\.rx\/\.ry\/\.rz\)/)).toBeTruthy();
  });
});
