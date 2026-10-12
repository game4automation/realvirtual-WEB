// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-498 Phase 3 (CONNECT recipe step 12) — the WebUI form block of the
 * `FMI` interface type: FMI interfaces are provisioned by realvirtual WEB from
 * the model's `Fmu` components, so "Add Interface" shows the catalog row as
 * "managed by the model" (not clickable) and the signal list of an FMI
 * interface is read-only (no manual add / edit / delete) — while a normal
 * type with manual signals keeps its "Add signal" button.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import type { RVViewer } from '../src/core/rv-viewer';
import {
  _resetConnectStore,
  fetchInterfaceTypes,
  getAvailableInterfaceTypes,
  isModelManagedInterfaceType,
  MODEL_MANAGED_INTERFACE_HINT,
  type ConnectInterface,
} from '../src/core/hmi/connect-store';
import { AddInterfaceDialog, SignalListView } from '../src/core/hmi/ConnectPanel';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { RVViewerProvider } from '../src/hooks/use-viewer';

const viewerStub = { signalStore: null, registry: null, signalBindingManager: undefined } as unknown as RVViewer;

const manualSchema = {
  supportsDiscovery: true, supportsManualAdd: true, addressValidatable: false, directionFromAddress: false,
  addressLabel: 'valueReference', addressHint: '', addressExamples: ['7'], dataTypes: ['Real', 'Integer', 'Boolean'],
};

/** The gateway's `GET /interface-types` with the FMI row (as CONNECT 1dd65c3 advertises it). */
function stubCatalog(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).endsWith('/interface-types')) {
      return new Response(JSON.stringify({ types: [
        { type: 'S7', label: 'Siemens S7', description: 'S7 TCP/IP', defaults: {}, signals: { ...manualSchema, addressLabel: 'Address' } },
        { type: 'FMI', label: 'FMU (FMI 2.0 Co-Simulation)', description: 'Run a trusted FMU inside the gateway', defaults: { updateCycleMs: 10 }, signals: manualSchema },
      ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function signalList(iface: ConnectInterface) {
  return (
    <ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={viewerStub}>
        <div style={{ height: 400, display: 'flex', flexDirection: 'column' }}>
          <SignalListView iface={iface} overLimitSignals={[]} />
        </div>
      </RVViewerProvider>
    </ThemeProvider>
  );
}

beforeEach(async () => {
  _resetConnectStore();
  stubCatalog();
  await fetchInterfaceTypes();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  _resetConnectStore();
});

describe('FMI form block — model-managed', () => {
  it('FMI is model-managed; other types are not', () => {
    expect(isModelManagedInterfaceType('FMI')).toBe(true);
    expect(isModelManagedInterfaceType('S7')).toBe(false);
    expect(getAvailableInterfaceTypes().map((t) => t.type)).toEqual(['S7', 'FMI']);
  });

  it('"Add Interface" lists FMI as managed by the model and a click creates nothing', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const before = fetchMock.mock.calls.length;
    render(
      <ThemeProvider theme={rvDarkTheme}>
        <AddInterfaceDialog open onClose={() => {}} />
      </ThemeProvider>,
    );
    const row = screen.getByTestId('add-interface-row-FMI');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.textContent).toContain(MODEL_MANAGED_INTERFACE_HINT);
    fireEvent.click(row);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock.mock.calls.length).toBe(before); // no POST /config/interfaces

    const s7 = screen.getByTestId('add-interface-row-S7');
    expect(s7.getAttribute('aria-disabled')).toBeNull();
    expect(s7.textContent).not.toContain(MODEL_MANAGED_INTERFACE_HINT);
  });

  it('the signals of an FMI interface are read-only (no "Add signal"); an S7 interface keeps it', () => {
    const fmi: ConnectInterface = {
      id: 'fmu-0a1b2c3d4e5f', type: 'FMI', enabled: true,
      signals: [
        { name: 'Hydraulics.u', protocolAddress: '1', type: 'PLCInputFloat', record: false },
        { name: 'Hydraulics.y', protocolAddress: '2', type: 'PLCOutputFloat', record: false },
      ],
    } as ConnectInterface;
    render(signalList(fmi));
    expect(screen.queryByLabelText('Add signal')).toBeNull();
    cleanup();

    const s7: ConnectInterface = { id: 's7-1', type: 'S7', enabled: true, signals: [] } as ConnectInterface;
    render(signalList(s7));
    expect(screen.getAllByLabelText('Add signal').length).toBeGreaterThan(0);
  });
});
