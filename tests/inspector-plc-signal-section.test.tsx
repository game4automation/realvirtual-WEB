// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-589 test 9.12 — the inspector's "Signal" and "PLC binding" sections.
 *
 * Three claims, and each of them is a promise the plan makes to the user:
 *
 *  - the NAME is no inline text field — the model, the bindings and every CONNECT entry couple by
 *    it. Since plan-590 the name row opens the rename dialog (a view of `editor.signalRename`)
 *    instead of being read-only (plan-589 F5 lifted);
 *  - without CONNECT the binding section is DISABLED with the reason said once, not a row of dead
 *    buttons: addresses live in the gateway and nowhere else;
 *  - with CONNECT there is one row per signal PLACE (interface, and for MQTT each topic), and
 *    "no address" reads as a warning only where the gateway REQUIRES one.
 *
 * The design rule (inspector building blocks + shared-sx only, plan-510) is enforced by
 * `tests/hmi-design-lint.node.test.ts` over the file, not re-asserted here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import type { ReactNode } from 'react';
import type { RVViewer } from '../src/core/rv-viewer';
import {
  connectToServer,
  fetchInterfaces,
  fetchInterfaceTypes,
  setServerUrl,
  _resetConnectStore,
  type ConnectInterface,
} from '../src/core/hmi/connect-store';
import {
  collectBindingPlaces,
  describeBindingPlace,
  describeSignalType,
  PLC_BINDING_NEEDS_CONNECT,
  PLCSignalSections,
  SIGNAL_RENAME_HINT,
} from '../src/core/hmi/rv-plc-signal-inspector';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import { SIGNAL_RENAME_COMMAND } from '../src/core/hmi/problems-store';
import { rvDarkTheme } from '../src/core/hmi/theme';

const wrap = (children: ReactNode) => <ThemeProvider theme={rvDarkTheme}>{children}</ThemeProvider>;

/** A viewer whose SignalStore reports the node's RUNTIME name — the key CONNECT couples by. */
function viewerWithSignal(path: string, runtimeName: string | null): RVViewer {
  return {
    signalStore: {
      exactNameForPath: (p: string) => (p === path && runtimeName ? runtimeName : undefined),
      nameForPath: () => undefined,
      getSignalMeta: () => undefined,
    },
    registry: null,
  } as unknown as RVViewer;
}

const sig = (name: string, protocolAddress = '', type = 'PLCOutputBool') =>
  ({ name, protocolAddress, type, record: false });

const S7: ConnectInterface = {
  id: 's7-cell1', type: 'S7', enabled: true, ipAddress: '127.0.0.1',
  signals: [sig('DB_FG01.Start', 'DB10.DBX4.1')],
};

const MQTT: ConnectInterface = {
  id: 'mqtt-pi', type: 'MQTT', enabled: true, brokerUrl: 'mqtt://localhost:1883',
  signals: [],
  topics: [
    { topic: 'plant/io', mode: 'Single', signals: [sig('DB_FG01.Start')] },
    { topic: 'plant/pi', mode: 'ProcessImage', signals: [sig('DB_FG01.Start')] },
  ],
};

const TYPES = {
  types: [
    {
      type: 'S7', label: 'Siemens S7', description: '', defaults: {},
      signals: {
        supportsDiscovery: true, supportsManualAdd: true, addressValidatable: true,
        directionFromAddress: true, addressLabel: 'Address', addressHint: '', addressExamples: [],
        dataTypes: ['Bool'], addressRule: { signals: 'required' },
      },
    },
    {
      type: 'MQTT', label: 'MQTT Broker', description: '', defaults: {},
      signals: {
        supportsDiscovery: true, supportsManualAdd: true, addressValidatable: true,
        directionFromAddress: false, addressLabel: 'Topic', addressHint: '', addressExamples: [],
        dataTypes: ['Bool'],
        addressRule: {
          signals: 'required',
          topicModes: { Single: 'container-topic', Json: 'none', ProcessImage: 'required' },
        },
      },
    },
  ],
};

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), {
  status: 200, headers: { 'Content-Type': 'application/json' },
}));

let puts: Array<{ id: string; body: ConnectInterface }> = [];

async function connectGateway(interfaces: ConnectInterface[]): Promise<void> {
  puts = [];
  setServerUrl('http://gw.test:5100');
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('/health')) return json({ status: 'ok', version: '6.3.47', build: 1 });
    if (u.includes('/interface-types')) return json(TYPES);
    if ((init?.method ?? 'GET') === 'PUT' && u.includes('/config/interfaces/')) {
      puts.push({
        id: decodeURIComponent(u.split('/config/interfaces/')[1]),
        body: JSON.parse(init!.body as string) as ConnectInterface,
      });
      return json({ success: true });
    }
    if (u.includes('/config/interfaces')) return json(interfaces);
    return json({});
  });
  // The section is gated on a real CONNECT CONNECTION, not merely on a filled interface list —
  // that is what makes the disabled state honest. So the test connects for real.
  await connectToServer();
  await fetchInterfaces();
  await fetchInterfaceTypes();
}

const PATH = 'Cell/Signals/Start';
const DATA = { Name: 'DB_FG01.Start', Comment: 'Conveyor start', OriginDataType: 'BOOL' };

beforeEach(() => {
  _resetConnectStore();
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  _resetConnectStore();
  vi.restoreAllMocks();
});

describe('plan-589 — inspector "Signal" section', () => {
  it('shows the runtime name as no inline editor; without the rename command the rename is disabled', () => {
    render(wrap(
      <PLCSignalSections
        viewer={viewerWithSignal(PATH, 'DB_FG01.Start')}
        nodePath={PATH} componentType="PLCOutputBool_1" data={DATA}
      />,
    ));

    const name = screen.getByTestId('rv-signal-name');
    expect(name.textContent).toBe('DB_FG01.Start');
    // Not a text field: no input to type into — the rename goes through the dialog.
    expect(name.getAttribute('aria-readonly')).toBe('true');
    expect(name.querySelector('input')).toBeNull();
    // No command registered here → the rename button is disabled and the reason is the command's.
    const open = screen.getByTestId('rv-signal-rename-open') as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    expect(name.getAttribute('role')).toBeNull();
  });

  it('plan-590: the name row opens the rename dialog when editor.signalRename is enabled', async () => {
    const calls: unknown[] = [];
    const off = commandRegistry.register({
      id: SIGNAL_RENAME_COMMAND, label: 'Rename signal', readOnly: false, scope: 'none', available: true,
      unavailableReason: 'n/a', argsSchema: {}, impl: () => Promise.resolve(null),
      eagerImpl: {
        enabled: () => true,
        run: (_ctx, args) => {
          calls.push(args);
          return {
            dryRun: true,
            preview: {
              oldName: 'DB_FG01.Start', newName: 'DB_FG01.Run', nodePath: PATH, signalType: 'PLCOutputBool',
              ok: true, blockers: [], warnings: [], wireChanges: [], requiresWireConfirmation: false,
              counts: {}, steps: [{ kind: 'signal-name', label: 'Start', write: true }], owners: [PATH],
              scope: 'the open document', connect: {
                state: 'not-connected', changedInterfaces: [], changedMappings: 0, inactiveProfiles: [], liveInGateway: false,
              },
            },
          };
        },
      },
    });
    try {
      const viewer = { ...viewerWithSignal(PATH, 'DB_FG01.Start'), selectionManager: { getSnapshot: () => ({ selectedPaths: [] }) } } as unknown as RVViewer;
      render(wrap(
        <PLCSignalSections viewer={viewer} nodePath={PATH} componentType="PLCOutputBool" data={DATA} />,
      ));
      const name = screen.getByTestId('rv-signal-name');
      expect(name.getAttribute('role')).toBe('button');
      expect(name.getAttribute('title')).toBe(SIGNAL_RENAME_HINT);
      fireEvent.click(name);
      const input = await screen.findByTestId('rv-signal-rename-input') as HTMLInputElement;
      expect(input.value).toBe('DB_FG01.Start');
      fireEvent.change(input, { target: { value: 'DB_FG01.Run' } });
      await waitFor(() => expect(screen.getByTestId('rv-signal-rename-group-signal-name')).toBeTruthy());
      expect(calls[calls.length - 1]).toEqual({ path: PATH, newName: 'DB_FG01.Run', dryRun: true });
    } finally {
      off();
    }
  });

  it('shows the RUNTIME name when it differs from the persisted asset-local symbol', () => {
    render(wrap(
      <PLCSignalSections
        viewer={viewerWithSignal(PATH, 'Cell2.DB_FG01.Start')}
        nodePath={PATH} componentType="PLCOutputBool" data={DATA}
      />,
    ));
    // A generated signal inside a placement is scoped; CONNECT couples by that name, so the
    // inspector must show it rather than the asset-local one.
    expect(screen.getByTestId('rv-signal-name').textContent).toBe('Cell2.DB_FG01.Start');
  });

  it('falls back to the persisted symbol when the store has not registered the node', () => {
    render(wrap(
      <PLCSignalSections
        viewer={viewerWithSignal(PATH, null)}
        nodePath={PATH} componentType="PLCOutputBool" data={DATA}
      />,
    ));
    expect(screen.getByTestId('rv-signal-name').textContent).toBe('DB_FG01.Start');
  });

  it('edits Comment and OriginDataType through the inspector field path, never the Name', async () => {
    const edits: Array<[string, unknown]> = [];
    render(wrap(
      <PLCSignalSections
        viewer={viewerWithSignal(PATH, 'DB_FG01.Start')}
        nodePath={PATH} componentType="PLCOutputBool" data={DATA}
        onFieldEdit={(field, value) => edits.push([field, value])}
      />,
    ));

    const inputs = screen.getAllByRole('textbox') as HTMLInputElement[];
    const dataType = inputs.find((i) => i.value === 'BOOL')!;
    const comment = inputs.find((i) => i.value === 'Conveyor start')!;
    fireEvent.change(dataType, { target: { value: 'INT' } });
    fireEvent.blur(dataType);
    fireEvent.change(comment, { target: { value: 'Belt start' } });
    fireEvent.blur(comment);

    expect(edits).toEqual([['OriginDataType', 'INT'], ['Comment', 'Belt start']]);
    // No field write may ever carry the name.
    expect(edits.some(([field]) => field === 'Name')).toBe(false);
  });

  it('names the type and direction in words', () => {
    expect(describeSignalType('PLCOutputBool_1')).toBe('PLC Output · Bool');
    expect(describeSignalType('PLCInputFloat')).toBe('PLC Input · Float');
    expect(describeSignalType('Drive')).toBe('Drive');
  });
});

describe('plan-589 — inspector "PLC binding" section', () => {
  it('is DISABLED with one reason when CONNECT is not connected', () => {
    render(wrap(
      <PLCSignalSections
        viewer={viewerWithSignal(PATH, 'DB_FG01.Start')}
        nodePath={PATH} componentType="PLCOutputBool" data={DATA}
      />,
    ));

    expect(screen.getByTestId('rv-plc-binding-hint').textContent).toBe(PLC_BINDING_NEEDS_CONNECT);
    // Not a single dead control.
    expect(screen.queryByLabelText(/^(Bind|Edit) 'DB_FG01.Start'/)).toBeNull();
    expect(screen.queryByLabelText(/^Remove 'DB_FG01.Start'/)).toBeNull();
  });

  it('renders one row per PLACE — the interface list and each MQTT topic', async () => {
    await connectGateway([S7, MQTT]);
    render(wrap(
      <PLCSignalSections
        viewer={viewerWithSignal(PATH, 'DB_FG01.Start')}
        nodePath={PATH} componentType="PLCOutputBool" data={DATA}
      />,
    ));

    await waitFor(() => expect(screen.queryByTestId('rv-plc-binding-hint')).toBeNull());
    const rows = Array.from(document.querySelectorAll('[data-rv-binding]'))
      .map((el) => el.getAttribute('data-rv-binding'));
    expect(rows).toEqual(['s7-cell1', 'mqtt-pi', 'mqtt-pi#plant/io', 'mqtt-pi#plant/pi']);
  });

  it('removes the binding from the addressed container only', async () => {
    await connectGateway([MQTT]);
    render(wrap(
      <PLCSignalSections
        viewer={viewerWithSignal(PATH, 'DB_FG01.Start')}
        nodePath={PATH} componentType="PLCOutputBool" data={DATA}
      />,
    ));

    const remove = await screen.findByLabelText("Remove 'DB_FG01.Start' from mqtt-pi · plant/io");
    fireEvent.click(remove);

    await waitFor(() => expect(puts).toHaveLength(1));
    const topics = puts[0].body.topics!;
    expect(topics.find((t) => t.topic === 'plant/io')!.signals).toEqual([]);
    expect(topics.find((t) => t.topic === 'plant/pi')!.signals).toHaveLength(1);
  });
});

describe('plan-589 — binding places and their status text', () => {
  const place = (over: Record<string, unknown>) => ({
    key: 'k', label: 'l', iface: S7, signal: null, rule: null, ...over,
  } as Parameters<typeof describeBindingPlace>[0]);

  it('reads "not bound" without an entry', () => {
    expect(describeBindingPlace(place({})).text).toBe('not bound');
  });

  it('warns about a missing address ONLY where the gateway requires one', () => {
    const noAddress = { signal: sig('X', ''), rule: 'required' as const };
    expect(describeBindingPlace(place(noAddress))).toMatchObject({ text: 'bound · no address', warn: true });
    // Permissive rules — and an UNSTATED rule (older gateway) — are not warnings (plan-589 §5.4).
    for (const rule of ['container-topic', 'none', 'name-fallback', null] as const) {
      expect(describeBindingPlace(place({ signal: sig('X', ''), rule })))
        .toMatchObject({ text: 'bound', warn: false });
    }
  });

  it('shows the address and data type when there is one', () => {
    expect(describeBindingPlace(place({
      signal: { ...sig('X', 'DB10.DBX4.1'), dataType: 'Bool' }, rule: 'required' as const,
    })).text).toBe('DB10.DBX4.1 · Bool');
  });

  it('leaves model-managed interfaces (FMI) out — their signals ARE the model', () => {
    const fmi: ConnectInterface = { id: 'fmu-1', type: 'FMI', enabled: true, signals: [sig('X')] };
    expect(collectBindingPlaces([fmi, S7], 'X').map((p) => p.key)).toEqual(['s7-cell1']);
  });
});
