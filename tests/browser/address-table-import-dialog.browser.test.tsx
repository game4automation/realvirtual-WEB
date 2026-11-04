// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2025 P7 review fixes 3 + 4 — `AddressTableImportDialog` in Chromium against the in-memory
 * CONNECT: a preview is valid only for the input version it was computed for (any edit voids it at
 * once, Apply stays locked through the debounce until the matching check is done), and a conflict on
 * Apply forces a new preview on the reloaded configuration before anything can be written again.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.setConfig({ hookTimeout: 60_000, testTimeout: 30_000 });
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from 'vitest/browser';
import { ThemeProvider } from '@mui/material/styles';
import type { RVViewer } from '../../src/core/rv-viewer';
import { rvDarkTheme } from '../../src/core/hmi/theme';
import { RVViewerProvider } from '../../src/hooks/use-viewer';
import { AddressTableImportDialog } from '../../src/core/hmi/ConnectAddressSourceDialogs';
import {
  _resetConnectStore, fetchInterfaces, getConnectSnapshot, setServerUrl, type ConnectInterface,
} from '../../src/core/hmi/connect-store';
import { installFakeGateway, type FakeGateway } from '../_connect-ops-fake-gateway';

const S7 = {
  id: 's7-1', type: 'S7', enabled: true,
  signals: [
    { name: 'A', protocolAddress: '', type: 'PLCOutputBool', record: false },
    { name: 'B', protocolAddress: '%Q9.9', type: 'PLCOutputBool', record: false },
  ],
} as unknown as ConnectInterface;

const viewer = {
  registry: { getAll: () => [], getNode: () => null },
  selectionManager: { getSnapshot: () => ({ primaryPath: null, selectedPaths: [] }) },
} as unknown as RVViewer;

const wrap = (ui: ReactNode) => render(
  <ThemeProvider theme={rvDarkTheme}><RVViewerProvider value={viewer}>{ui}</RVViewerProvider></ThemeProvider>,
);

let gw: FakeGateway;
beforeEach(async () => {
  _resetConnectStore();
  setServerUrl('http://gw.test:5100');
  gw = installFakeGateway({ interfaces: [S7], revision: 20 });
  await fetchInterfaces();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); _resetConnectStore(); });

const applyButton = () => screen.getByTestId('address-table-apply') as HTMLButtonElement;
const setText = (value: string) => fireEvent.change(screen.getByTestId('address-table-text'), { target: { value } });
const settle = () => waitFor(() => expect(applyButton().disabled).toBe(false), { timeout: 5000 });

function openDialog(): void {
  const iface = getConnectSnapshot().interfaces.find(i => i.id === 's7-1')!;
  wrap(<AddressTableImportDialog open onClose={() => {}} iface={iface} />);
}

describe('AddressTableImportDialog — input versioning', () => {
  it('an edit voids the preview at once; Apply is locked during the debounce', async () => {
    openDialog();
    setText('A;%Q1.0\n');
    await settle();
    expect(applyButton().textContent).toBe('Import 1 row');

    // Edit the text: the old preview is void BEFORE the 300 ms debounce runs the new check.
    setText('A;%Q1.0\nB;%Q2.0\n');
    expect(applyButton().disabled).toBe(true);
    fireEvent.click(applyButton()); // a click in the gap writes nothing
    expect(gw.opsCalls()).toHaveLength(0);
    expect(screen.queryAllByTestId('address-table-row')).toHaveLength(0); // the old rows are gone too

    await settle();
    // Fill-empty: B has an address → kept; one write.
    expect(applyButton().textContent).toBe('Import 1 row');
  });

  it('switching "Existing addresses" voids the preview until the matching check is done', async () => {
    openDialog();
    setText('A;%Q1.0\nB;%Q2.0\n');
    await settle();
    expect(applyButton().textContent).toBe('Import 1 row');

    await userEvent.click(screen.getByRole('combobox', { name: 'Existing addresses' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Overwrite' }));
    expect(applyButton().disabled).toBe(true);
    await settle();
    expect(applyButton().textContent).toBe('Import 2 rows');

    await act(async () => { fireEvent.click(applyButton()); });
    await waitFor(() => expect(gw.opsCalls()).toHaveLength(1));
    // The batch is the one of the CURRENT mode: overwrite.
    expect(gw.opsCalls()[0].ops.every(o => o.addressMode === 'overwrite')).toBe(true);
    expect(gw.opsCalls()[0].expectedRevision).toBe(20);
  });

  it('a conflict on Apply recomputes the preview; only the new one can be written', async () => {
    openDialog();
    setText('A;%Q1.0\n');
    await settle();
    gw.bump(); // someone else wrote
    await act(async () => { fireEvent.click(applyButton()); });
    await waitFor(() => expect(screen.getByText(/changed elsewhere/)).toBeTruthy());
    expect(gw.opsCalls()).toHaveLength(1);
    expect(gw.opsCalls()[0].expectedRevision).toBe(20);

    // A new preview on the reloaded configuration (revision 21) — then Apply sends that revision.
    await settle();
    await act(async () => { fireEvent.click(applyButton()); });
    await waitFor(() => expect(gw.opsCalls()).toHaveLength(2));
    expect(gw.opsCalls()[1].expectedRevision).toBe(21);
    expect(gw.interfaces[0].signals[0].protocolAddress).toBe('%Q1.0');
  });

  it('offers an explicit separator choice', async () => {
    openDialog();
    setText('A;B,%Q1.0\n');
    await settle();
    expect(screen.getByText(/separator ';'/)).toBeTruthy();
    await userEvent.click(screen.getByRole('combobox', { name: 'Separator' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Comma ,' }));
    await waitFor(() => expect(screen.getByText(/separator ','/)).toBeTruthy());
  });
});
