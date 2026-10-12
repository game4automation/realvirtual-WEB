// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-589 test 9.7 (browser half) — the signal dialog on a SLOT.
 *
 * Until plan-589 the dialog demanded an address for every interface type, which made three
 * legitimate configurations unreachable: an MQTT `Single` topic (the topic IS the address), an MQTT
 * `Json` topic (the signal NAME is the JSON key) and the name-fallback protocols (PLCSIM, SHM, ABB,
 * WebSocket Realtime, WINMOD, PVI). It also validated an MQTT ProcessImage address with the TOPIC
 * parser, which rejects the byte offsets that mode actually uses.
 *
 * The claims here are therefore about Save being enabled or not, and they are made through the REAL
 * `SignalListView` — the component that owns the dialog state in the CONNECT panel — on an interface
 * whose two topics carry the SAME signal name, because that is the case a name-keyed dialog gets
 * wrong without noticing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.setConfig({ hookTimeout: 60_000, testTimeout: 30_000 });
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import type { ReactNode } from 'react';
import type { RVViewer } from '../../src/core/rv-viewer';
import {
  fetchInterfaces,
  fetchInterfaceTypes,
  setServerUrl,
  _resetConnectStore,
  type ConnectInterface,
} from '../../src/core/hmi/connect-store';
import { SignalListView } from '../../src/core/hmi/ConnectPanel';
import { rvDarkTheme } from '../../src/core/hmi/theme';
import { RVViewerProvider } from '../../src/hooks/use-viewer';

const viewerStub = {
  signalStore: null,
  registry: null,
  signalBindingManager: undefined,
} as unknown as RVViewer;

function wrap(children: ReactNode) {
  return (
    <ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={viewerStub}>{children}</RVViewerProvider>
    </ThemeProvider>
  );
}

const sig = (name: string, protocolAddress = '', type = 'PLCOutputBool') =>
  ({ name, protocolAddress, type, record: false });

/** One MQTT interface, four places, and `Cell.Start` in TWO topics at once. */
const MQTT_IFACE: ConnectInterface = {
  id: 'mqtt-1', type: 'MQTT', enabled: true, brokerUrl: 'mqtt://localhost:1883',
  signals: [sig('Legacy.Start', 'plant/legacy/start')],
  topics: [
    { topic: 'plant/single', mode: 'Single', signals: [sig('Cell.Start')] },
    { topic: 'plant/json', mode: 'Json', signals: [sig('Cell.Start')] },
    { topic: 'plant/pi', mode: 'ProcessImage', signals: [sig('Cell.Lamp', '%Q0.1')] },
  ],
};

const SHM_IFACE: ConnectInterface = {
  id: 'shm-1', type: 'SHM', enabled: true, signals: [sig('Speed', '', 'PLCOutputFloat')],
};

const S7_IFACE: ConnectInterface = {
  id: 's7-1', type: 'S7', enabled: true, ipAddress: '127.0.0.1',
  signals: [sig('DB_FG01.Start', 'DB10.DBX4.1')],
};

/** The gateway's own catalog, with the plan-589 address rules exactly as CONNECT serves them. */
const TYPES = {
  types: [
    {
      type: 'MQTT', label: 'MQTT Broker', description: '', defaults: {},
      signals: {
        supportsDiscovery: true, supportsManualAdd: true, addressValidatable: true,
        directionFromAddress: false, addressLabel: 'Topic', addressHint: 'MQTT topic',
        addressExamples: ['factory/line1/speed'], dataTypes: ['Bool', 'Int', 'Float', 'String'],
        addressRule: {
          signals: 'required',
          topicModes: { Single: 'container-topic', Json: 'none', ProcessImage: 'required' },
        },
      },
    },
    {
      type: 'SHM', label: 'Shared Memory (SIMIT)', description: '', defaults: {},
      signals: {
        supportsDiscovery: false, supportsManualAdd: true, addressValidatable: false,
        directionFromAddress: false, addressLabel: 'Signal name', addressHint: 'SHM name',
        addressExamples: [], dataTypes: ['Bool', 'Real'],
        addressRule: { signals: 'name-fallback' },
      },
    },
    {
      type: 'S7', label: 'Siemens S7', description: '', defaults: {},
      signals: {
        supportsDiscovery: true, supportsManualAdd: true, addressValidatable: true,
        directionFromAddress: true, addressLabel: 'Address', addressHint: 'DB address',
        addressExamples: ['DB10.DBX0.0'], dataTypes: ['Bool', 'Real'],
        addressRule: { signals: 'required' },
      },
    },
  ],
};

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
}));

let puts: Array<{ id: string; body: ConnectInterface }> = [];
let validateCalls: Array<Record<string, unknown>> = [];

function mockGateway(interfaces: ConnectInterface[]): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    const u = typeof url === 'string' ? url : url.toString();
    const method = init?.method ?? 'GET';
    if (u.includes('/interface-types')) return json(TYPES);
    if (method === 'PUT' && u.includes('/config/interfaces/')) {
      puts.push({
        id: decodeURIComponent(u.split('/config/interfaces/')[1]),
        body: JSON.parse(init!.body as string) as ConnectInterface,
      });
      return json({ success: true });
    }
    if (u.includes('/config/interfaces')) return json(interfaces);
    if (method === 'POST' && u.includes('/signals/validate')) {
      const body = JSON.parse(init!.body as string) as Record<string, unknown>;
      validateCalls.push(body);
      // Stand-in for the gateway's parsers: a topic must look like a topic, an S7 address must
      // start with DB or %.
      const addr = String(body['protocolAddress'] ?? '');
      const valid = body['interfaceType'] === 'S7' ? /^(DB|%|M)/i.test(addr) : addr.length > 0;
      return json({ checked: true, valid, error: valid ? null : `Invalid address '${addr}'`, normalizedAddress: valid ? addr : null });
    }
    return json({});
  });
}

async function mount(iface: ConnectInterface): Promise<void> {
  puts = [];
  validateCalls = [];
  setServerUrl('http://gw.test:5100');
  mockGateway([iface]);
  await fetchInterfaces();
  await fetchInterfaceTypes();
  // The list is virtualized: without a real height it mounts only the first rows, and the
  // ProcessImage topic (row 6) would never exist.
  render(wrap(
    <div style={{ height: 800, width: 360, display: 'flex', flexDirection: 'column' }}>
      <SignalListView iface={iface} overLimitSignals={[]} />
    </div>,
  ));
}

/**
 * Open the edit dialog of ONE place.
 *
 * Rows render topics first (in config order), then the flat list, and `Cell.Start` exists in two
 * topics — so the place is addressed by OCCURRENCE, not by name. Picking the name alone is exactly
 * the mistake this file exists to catch.
 */
async function openEditDialog(name: string, occurrence = 0): Promise<HTMLElement> {
  const buttons = await screen.findAllByLabelText(`Edit signal '${name}'`);
  fireEvent.click(buttons[occurrence]);
  return await screen.findByRole('dialog');
}

function saveButton(dialog: HTMLElement): HTMLButtonElement {
  return within(dialog).getByRole('button', { name: /^(Save|Add)$/ }) as HTMLButtonElement;
}

function addressField(dialog: HTMLElement): HTMLInputElement {
  return within(dialog).getByTestId('rv-signal-address-input') as HTMLInputElement;
}

beforeEach(() => {
  localStorage.clear();
  _resetConnectStore();
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  _resetConnectStore();
  vi.restoreAllMocks();
});

describe('plan-589 — the signal dialog demands an address only where the gateway does', () => {
  it('allows an EMPTY address on a Single topic (the container topic is the address)', async () => {
    await mount(MQTT_IFACE);
    const dialog = await openEditDialog('Cell.Start', 0);

    expect(addressField(dialog).value).toBe('');
    expect(saveButton(dialog).disabled).toBe(false);
    // The row says WHY it may stay empty, rather than leaving the user guessing.
    expect(dialog.textContent).toContain("the topic 'plant/single' is the address");
  });

  it('allows an EMPTY address on a Json topic (the signal name is the JSON key)', async () => {
    await mount(MQTT_IFACE);
    const dialog = await openEditDialog('Cell.Start', 1);

    expect(saveButton(dialog).disabled).toBe(false);
    expect(dialog.textContent).toContain('keys its JSON object by the signal name');
  });

  it('allows an EMPTY address on a name-fallback interface (SHM)', async () => {
    await mount(SHM_IFACE);
    const dialog = await openEditDialog('Speed');

    expect(saveButton(dialog).disabled).toBe(false);
    expect(dialog.textContent).toContain('Leave empty to use the signal name as the address');
  });

  it('DEMANDS an address where the rule is required (S7) — Save stays disabled until one is typed', async () => {
    await mount(S7_IFACE);
    const dialog = await openEditDialog('DB_FG01.Start');
    const address = addressField(dialog);

    expect(saveButton(dialog).disabled).toBe(false);
    fireEvent.change(address, { target: { value: '' } });
    await waitFor(() => expect(saveButton(dialog).disabled).toBe(true));
    fireEvent.change(address, { target: { value: 'DB10.DBX4.2' } });
    await waitFor(() => expect(saveButton(dialog).disabled).toBe(false));
  });

  it('DEMANDS an address on a ProcessImage topic and checks it LOCALLY, not as a topic', async () => {
    await mount(MQTT_IFACE);
    const dialog = await openEditDialog('Cell.Lamp');
    const address = addressField(dialog);

    // Valid Siemens process-image address.
    fireEvent.change(address, { target: { value: '%IW13' } });
    await waitFor(() => expect(saveButton(dialog).disabled).toBe(false));

    // Invalid one — and the complaint is about a process-image address, not about a topic.
    fireEvent.change(address, { target: { value: 'plant/not/an/offset' } });
    await waitFor(() => expect(saveButton(dialog).disabled).toBe(true));
    expect(dialog.textContent).toContain('Invalid process-image address');

    // Empty is refused too: ProcessImage is `required`.
    fireEvent.change(address, { target: { value: '' } });
    await waitFor(() => expect(saveButton(dialog).disabled).toBe(true));

    // The gateway's topic validator was never asked about a byte offset.
    expect(validateCalls.filter((c) => String(c['protocolAddress']).includes('%IW13'))).toHaveLength(0);
  });

  it('saves a topic signal back into ITS topic, with the same name present in another one', async () => {
    await mount(MQTT_IFACE);
    const dialog = await openEditDialog('Cell.Start', 1);

    fireEvent.click(saveButton(dialog));
    await waitFor(() => expect(puts).toHaveLength(1));

    const topics = puts[0].body.topics!;
    expect(topics.map((t) => t.topic)).toEqual(['plant/single', 'plant/json', 'plant/pi']);
    // Both same-named entries still exist, each in its own container.
    expect(topics.find((t) => t.topic === 'plant/single')!.signals).toHaveLength(1);
    expect(topics.find((t) => t.topic === 'plant/json')!.signals).toHaveLength(1);
    expect(puts[0].body.signals?.map((s) => s.name)).toEqual(['Legacy.Start']);
  });

  it('keeps the legacy flat MQTT signal address-required (the topic lives in the address there)', async () => {
    await mount(MQTT_IFACE);
    const dialog = await openEditDialog('Legacy.Start');
    const address = addressField(dialog);

    fireEvent.change(address, { target: { value: '' } });
    await waitFor(() => expect(saveButton(dialog).disabled).toBe(true));
  });
});
