// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Multi-selection and bulk delete in the CONNECT signal list — the WIRING.
 *
 * signal-selection.test.ts covers the pure selection algebra. This file covers what that cannot
 * see: that a click on a row actually reaches the selection state, that Shift and Ctrl arrive as
 * the intended intent, and that the row menu deletes through ONE updateInterface write. The first
 * cut of this feature had green logic tests and a dead click path, so the wiring is asserted here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import type { RVViewer } from '../src/core/rv-viewer';
import type { ConnectInterface, ConnectInterfaceSignal } from '../src/core/hmi/connect-store';

const updateInterfaceMock = vi.fn(async () => {});

// The row's edit affordances (and with them selection) are gated on the gateway-advertised
// schema. The store has no gateway in a test, so the schema is supplied here.
vi.mock('../src/core/hmi/connect-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/hmi/connect-store')>();
  return {
    ...actual,
    getSignalSchema: () => ({ supportsManualAdd: true, dataTypes: ['Bool', 'Float'] }),
    updateInterface: (...args: unknown[]) => updateInterfaceMock(...(args as [])),
  };
});

const { _resetConnectStore } = await import('../src/core/hmi/connect-store');
const { SignalListView } = await import('../src/core/hmi/ConnectPanel');
const { rvDarkTheme } = await import('../src/core/hmi/theme');
const { RVViewerProvider } = await import('../src/hooks/use-viewer');

const viewerStub = {
  signalStore: null,
  registry: null,
  signalBindingManager: undefined,
} as unknown as RVViewer;

function signal(name: string, protocolAddress: string): ConnectInterfaceSignal {
  return { name, protocolAddress, type: 'PLCOutputBool', record: false };
}

/** Four flat MQTT signals under rv/demo/out — the shape of the reference case. */
function fixture(): ConnectInterface {
  return {
    id: 'mqtt-sel',
    type: 'MQTT',
    enabled: true,
    signals: [
      signal('Alpha', 'rv/demo/out/Alpha'),
      signal('Bravo', 'rv/demo/out/Bravo'),
      signal('Charlie', 'rv/demo/out/Charlie'),
      signal('Delta', 'rv/demo/out/Delta'),
    ],
  } as ConnectInterface;
}

function renderList(iface: ConnectInterface) {
  return render(
    <ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={viewerStub}>
        <div style={{ height: 400, display: 'flex', flexDirection: 'column' }}>
          <SignalListView iface={iface} overLimitSignals={[]} />
        </div>
      </RVViewerProvider>
    </ThemeProvider>,
  );
}

/**
 * The row element for a signal name. Anchored on `aria-selected`, which every selectable row
 * carries — `data-rv-depth` exists only on MQTT tree leaves, so it would miss topic-nested rows.
 */
function rowOf(name: string): HTMLElement {
  let node: HTMLElement | null = screen.getByText(name);
  while (node && !node.hasAttribute('aria-selected')) node = node.parentElement;
  if (!node) throw new Error(`no row for '${name}'`);
  return node;
}

const isSelected = (name: string) => rowOf(name).getAttribute('aria-selected') === 'true';

beforeEach(() => {
  cleanup();
  localStorage.clear();
  _resetConnectStore();
  updateInterfaceMock.mockClear();
});

describe('CONNECT signal list — multi-selection wiring', () => {
  it('selects a row on a plain click', () => {
    renderList(fixture());
    expect(isSelected('Alpha')).toBe(false);
    fireEvent.click(rowOf('Alpha'));
    expect(isSelected('Alpha')).toBe(true);
  });

  it('replaces the selection on the next plain click', () => {
    renderList(fixture());
    fireEvent.click(rowOf('Alpha'));
    fireEvent.click(rowOf('Charlie'));
    expect(isSelected('Alpha')).toBe(false);
    expect(isSelected('Charlie')).toBe(true);
  });

  it('adds to the selection with Ctrl+click', () => {
    renderList(fixture());
    fireEvent.click(rowOf('Alpha'));
    fireEvent.click(rowOf('Charlie'), { ctrlKey: true });
    expect(isSelected('Alpha')).toBe(true);
    expect(isSelected('Charlie')).toBe(true);
    expect(isSelected('Bravo')).toBe(false);
  });

  it('spans a range with Shift+click, including the rows in between', () => {
    renderList(fixture());
    fireEvent.click(rowOf('Alpha'));
    fireEvent.click(rowOf('Charlie'), { shiftKey: true });
    expect(isSelected('Alpha')).toBe(true);
    expect(isSelected('Bravo')).toBe(true);
    expect(isSelected('Charlie')).toBe(true);
    expect(isSelected('Delta')).toBe(false);
  });

  it('keeps the anchor so a second Shift+click narrows the same range', () => {
    renderList(fixture());
    fireEvent.click(rowOf('Alpha'));
    fireEvent.click(rowOf('Delta'), { shiftKey: true });
    expect(isSelected('Delta')).toBe(true);
    fireEvent.click(rowOf('Bravo'), { shiftKey: true });
    expect(isSelected('Alpha')).toBe(true);
    expect(isSelected('Bravo')).toBe(true);
    expect(isSelected('Charlie')).toBe(false);
    expect(isSelected('Delta')).toBe(false);
  });

  it('opens the row menu on right-click and names the selected count', () => {
    renderList(fixture());
    fireEvent.click(rowOf('Alpha'));
    fireEvent.click(rowOf('Bravo'), { ctrlKey: true });
    fireEvent.contextMenu(rowOf('Bravo'));
    expect(screen.getByText('Delete 2 signals…')).toBeTruthy();
  });

  it('reduces the selection when the menu opens outside it, so the count cannot mislead', () => {
    renderList(fixture());
    fireEvent.click(rowOf('Alpha'));
    fireEvent.contextMenu(rowOf('Delta'));
    expect(isSelected('Alpha')).toBe(false);
    expect(isSelected('Delta')).toBe(true);
    expect(screen.getByText('Delete signal…')).toBeTruthy();
  });

  it('selects and deletes inside a ProcessImage topic, patching topics[] in the same write', async () => {
    const iface = {
      ...fixture(),
      topics: [{
        topic: 'Data_Q_1',
        mode: 'ProcessImage',
        signals: [signal('Motor', '%Q0.0'), signal('Valve', '%Q0.1'), signal('Lamp', '%Q0.2')],
      }],
    } as unknown as ConnectInterface;
    renderList(iface);

    // The group renders collapsed-by-default in some states; make sure the rows are there.
    if (!screen.queryByText('Motor')) fireEvent.click(screen.getByText('Data_Q_1'));

    fireEvent.click(rowOf('Motor'));
    fireEvent.click(rowOf('Valve'), { ctrlKey: true });
    expect(isSelected('Motor')).toBe(true);
    expect(isSelected('Valve')).toBe(true);

    fireEvent.contextMenu(rowOf('Valve'));
    fireEvent.click(screen.getByText('Delete 2 signals…'));
    fireEvent.click(await screen.findByRole('button', { name: /Delete 2 signals/ }));

    expect(updateInterfaceMock).toHaveBeenCalledTimes(1);
    const [, patch] = updateInterfaceMock.mock.calls[0] as unknown as [string, {
      signals?: ConnectInterfaceSignal[];
      topics?: { topic: string; signals: ConnectInterfaceSignal[] }[];
    }];
    // Flat signals untouched — nothing flat was selected.
    expect(patch.signals).toBeUndefined();
    expect(patch.topics?.[0].signals.map(s => s.name)).toEqual(['Lamp']);
  });

  it('deletes every selected signal in ONE updateInterface write', async () => {
    renderList(fixture());
    fireEvent.click(rowOf('Alpha'));
    fireEvent.click(rowOf('Charlie'), { shiftKey: true });   // Alpha, Bravo, Charlie
    fireEvent.contextMenu(rowOf('Bravo'));
    fireEvent.click(screen.getByText('Delete 3 signals…'));

    // Confirm through the shared dialog rather than a window.confirm.
    fireEvent.click(await screen.findByRole('button', { name: /Delete 3 signals/ }));

    expect(updateInterfaceMock).toHaveBeenCalledTimes(1);
    const [id, patch] = updateInterfaceMock.mock.calls[0] as unknown as [string, { signals: ConnectInterfaceSignal[] }];
    expect(id).toBe('mqtt-sel');
    expect(patch.signals.map(s => s.name)).toEqual(['Delta']);
  });
});
