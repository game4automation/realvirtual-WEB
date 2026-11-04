// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { ConnectPanel, InterfaceCard, SignalListView } from '../src/core/hmi/ConnectPanel';
import { SewUdpImportDialog } from '../src/core/hmi/connect-sew-udp-import';
import { _resetConnectStore, connectToServer, fetchInterfaces, getConnectSnapshot, importSewUdpSymbolTable, type ConnectInterface } from '../src/core/hmi/connect-store';
import { LeftPanelManager } from '../src/core/hmi/left-panel-manager';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import type { RVViewer } from '../src/core/rv-viewer';

vi.mock('../src/core/hmi/connect-store', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/hmi/connect-store')>();
  return { ...actual, importSewUdpSymbolTable: vi.fn(actual.importSewUdpSymbolTable) };
});

const UDP: ConnectInterface = { id: 'udp-custom', type: 'Udp', enabled: true, allowWebToPlc: true, signals: [] };
const CSV = 'Name;Type;Direction\nSpeed;REAL;PLC_IN\nEnable;BOOL;PLC_IN\nRunning;BOOL;PLC_OUT\nCount;INT;PLC_OUT';
const viewer = { signalStore: null, registry: null, signalBindingManager: undefined } as unknown as RVViewer;
const onClose = vi.fn();

function wrap(children: React.ReactNode) {
  return <ThemeProvider theme={rvDarkTheme}><RVViewerProvider value={viewer}>{children}</RVViewerProvider></ThemeProvider>;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubGateway(iface: ConnectInterface | null = UDP, failure?: { status: number; error: string }) {
  let interfaces = iface ? [iface] : [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === 'PUT' || init?.method === 'POST') {
      if (failure) return json({ error: failure.error }, failure.status);
      const body = { signals: [], ...JSON.parse(String(init.body)) } as ConnectInterface;
      interfaces = [body];
      return json(init.method === 'POST' ? body : { ok: true });
    }
    if (path === '/config/interfaces') return json(interfaces);
    if (path === '/health') return json({ status: 'ok' });
    if (path === '/config/mirrors' || path === '/config/mappings') return json([]);
    return json({}, 404);
  }));
}

async function dialog(iface: ConnectInterface | null = UDP, failure?: { status: number; error: string }) {
  stubGateway(iface, failure);
  await fetchInterfaces();
  return render(wrap(<SewUdpImportDialog open interfaces={iface ? [iface] : []} targetInterfaceId={iface?.id ?? null} onClose={onClose} />));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function pick(csv = CSV) {
  const file = new File([csv], 'sew-symbols.csv', { type: 'text/csv' });
  vi.stubGlobal('showOpenFilePicker', vi.fn(async () => [{ getFile: async () => file }]));
  fireEvent.click(screen.getByRole('button', { name: /Choose file/ }));
  await waitFor(() => expect(screen.getByText('sew-symbols.csv')).toBeTruthy());
  await waitFor(() => expect((screen.getByRole('button', { name: /Choose file/ }) as HTMLButtonElement).disabled).toBe(false));
}

function importButton() { return screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement; }

beforeEach(() => {
  localStorage.clear();
  _resetConnectStore();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  _resetConnectStore();
});

describe('UDP card import entry', () => {
  it.each(['Udp', 'MQTT', 'S7', 'OpcUa'] as const)('offers the SEW entry only for UDP: %s', type => {
    const onImport = vi.fn();
    render(wrap(<InterfaceCard iface={{ ...UDP, type }} expanded={false} overLimitSignals={[]} onToggle={() => {}}
      onSetEnabled={() => {}} onBrowse={() => {}} onImport={onImport} onEdit={() => {}} onDelete={() => {}} />));
    fireEvent.click(screen.getByRole('button', { name: "Actions for interface 'udp-custom'" }));
    const sewEntry = screen.queryByRole('menuitem', { name: 'Import SEW symbol table…' });
    if (type === 'Udp') {
      expect(sewEntry).toBeTruthy();
      fireEvent.click(sewEntry!);
      expect(onImport).toHaveBeenCalledOnce();
    } else expect(sewEntry).toBeNull();
    if (type === 'MQTT' || type === 'S7') expect(screen.getByRole('menuitem', { name: 'Import tag table…' })).toBeTruthy();
  });

  it('mentions SEW import in the empty UDP signal list', () => {
    render(wrap(<SignalListView iface={UDP} overLimitSignals={[]} />));
    expect(screen.getByText(/No signals yet.*import a SEW symbol table/)).toBeTruthy();
  });
});

describe('SEW UDP import dialog', () => {
  it.each([
    ['picker', false], ['picker', true],
    ['getFile', false], ['getFile', true],
    ['text', false], ['text', true],
  ] as const)('ignores stale %s completion (reject: %s) after cancel and reopening for another interface', async (stage, reject) => {
    const view = await dialog();
    const pendingPicker = deferred<Array<{ getFile: () => Promise<File> }>>();
    const pendingFile = deferred<File>();
    const pendingText = deferred<string>();
    const file = new File([], 'stale-a.csv', { type: 'text/csv' });
    const readText = vi.fn(() => stage === 'text' ? pendingText.promise : Promise.resolve('Name;Type;Direction\nStale;BOOL;PLC_IN'));
    Object.defineProperty(file, 'text', { value: readText });
    const getFile = vi.fn(() => stage === 'getFile' ? pendingFile.promise : Promise.resolve(file));
    vi.stubGlobal('showOpenFilePicker', vi.fn(() => stage === 'picker' ? pendingPicker.promise : Promise.resolve([{ getFile }])));
    fireEvent.click(screen.getByRole('button', { name: /Choose file/ }));
    if (stage === 'getFile') await waitFor(() => expect(getFile).toHaveBeenCalledOnce());
    if (stage === 'text') await waitFor(() => expect(readText).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledOnce();
    view.rerender(wrap(<SewUdpImportDialog open={false} interfaces={[UDP]} targetInterfaceId={UDP.id} onClose={onClose} />));
    const other = { ...UDP, id: 'udp-other' };
    view.rerender(wrap(<SewUdpImportDialog open interfaces={[UDP, other]} targetInterfaceId={other.id} onClose={onClose} />));
    expect(screen.getByRole('dialog').textContent).toContain(other.id);
    expect(importButton().disabled).toBe(true);
    await pick();

    await act(async () => {
      if (reject) {
        const pending = stage === 'picker' ? pendingPicker : stage === 'getFile' ? pendingFile : pendingText;
        pending.reject(new Error('Stale A failed'));
      } else if (stage === 'picker') pendingPicker.resolve([{ getFile }]);
      else if (stage === 'getFile') pendingFile.resolve(file);
      else pendingText.resolve('Name;Type;Direction\nStale;BOOL;PLC_IN');
    });

    expect(screen.queryByText('stale-a.csv')).toBeNull();
    expect(screen.getByText('sew-symbols.csv')).toBeTruthy();
    expect(screen.getByText('4 signals (2 sent, 2 received) · 0 skipped')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(importButton().disabled).toBe(false);
    expect(importSewUdpSymbolTable).not.toHaveBeenCalled();
    if (stage === 'picker') expect(getFile).not.toHaveBeenCalled();
    if (stage !== 'text') expect(readText).not.toHaveBeenCalled();
  });

  it('submits only once when Import is clicked twice while the request is pending', async () => {
    await dialog();
    await pick();
    const pending = deferred<void>();
    vi.mocked(importSewUdpSymbolTable).mockImplementationOnce(() => pending.promise);
    const button = importButton();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(importSewUdpSymbolTable).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Importing…');
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(); });
    expect(onClose).toHaveBeenCalledOnce();
    expect(importSewUdpSymbolTable).toHaveBeenCalledOnce();
  });

  it('previews direction counts and imports the expected per-direction byte addresses', async () => {
    await dialog();
    expect(importButton().disabled).toBe(true);
    await pick();
    expect(screen.getByText('4 signals (2 sent, 2 received) · 0 skipped')).toBeTruthy();
    fireEvent.click(importButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(importSewUdpSymbolTable).toHaveBeenCalledWith({
      targetInterfaceId: 'udp-custom', allowWebToPlc: true,
      signals: [
        { name: 'Speed', type: 'PLCInputFloat', protocolAddress: '0:REAL', dataType: 'REAL', record: false },
        { name: 'Enable', type: 'PLCInputBool', protocolAddress: '4:BOOL', dataType: 'BOOL', record: false },
        { name: 'Running', type: 'PLCOutputBool', protocolAddress: '0:BOOL', dataType: 'BOOL', record: false },
        { name: 'Count', type: 'PLCOutputInt', protocolAddress: '1:INT', dataType: 'INT', record: false },
      ],
    });
  });

  it('blocks replacement until the existing signal count is confirmed, and resets on another file', async () => {
    await dialog({ ...UDP, signals: [
      { name: 'Old1', type: 'PLCInputBool', protocolAddress: '0:BOOL', record: false },
      { name: 'Old2', type: 'PLCOutputBool', protocolAddress: '0:BOOL', record: false },
    ] });
    await pick();
    const confirmation = screen.getByRole('checkbox', { name: /replaces 2 existing signals/ });
    expect(importButton().disabled).toBe(true);
    fireEvent.click(importButton());
    expect(importSewUdpSymbolTable).not.toHaveBeenCalled();
    fireEvent.click(confirmation);
    expect(importButton().disabled).toBe(false);
    await pick();
    expect(importButton().disabled).toBe(true);
    fireEvent.click(confirmation);
    fireEvent.click(importButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('lists skipped parser and builder rows once with line and reason, and disables Import for zero signals', async () => {
    await dialog();
    await pick('Name;Type;Direction\nText;TEXT;PLC_OUT\n;BOOL;PLC_IN\nBad;UNKNOWN;PLC_IN\nshort');
    expect(screen.getByText('0 signals (0 sent, 0 received) · 4 skipped')).toBeTruthy();
    for (const line of [2, 3, 4, 5]) expect(screen.getByText(`Line ${line}`)).toBeTruthy();
    expect(screen.getByText(/no fixed size in a UDP telegram/)).toBeTruthy();
    expect(screen.getAllByText('missing name — bytes reserved')).toHaveLength(1);
    expect(screen.getByText(/Unknown data type/)).toBeTruthy();
    expect(screen.getByText(/Row has 1 column/)).toBeTruthy();
    expect(importButton().disabled).toBe(true);
  });

  it('rejects a non-SEW CSV and clears the previous valid preview', async () => {
    await dialog();
    await pick();
    await pick('Name;Type;Address\nStart;BOOL;%I0.0');
    expect(screen.getByRole('alert').textContent).toBe('not a SEW symbol table (Name;Type;Direction)');
    expect(importButton().disabled).toBe(true);
    expect(screen.queryByText(/4 signals/)).toBeNull();
  });

  it('shows the gateway 409 text in the dialog and leaves it open', async () => {
    await dialog(UDP, { status: 409, error: 'Signal names must be unique: Speed already exists on another interface' });
    await pick();
    fireEvent.click(importButton());
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Signal names must be unique: Speed already exists on another interface'));
    expect(onClose).not.toHaveBeenCalled();
    expect(importButton().disabled).toBe(false);
  });

  it.each([
    ['PLC_IN', 'Send-only table — nothing is received.'],
    ['PLC_OUT', 'Receive-only table — nothing is sent.'],
  ])('shows the single-direction hint for %s and the closed write gate', async (direction, hint) => {
    await dialog({ ...UDP, allowWebToPlc: false });
    await pick(`Name;Type;Direction\nOnly;BOOL;${direction}`);
    expect(screen.getByText(hint)).toBeTruthy();
    expect(screen.getByText('Writing to the partner is off — the send telegram stays zero.')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Allow writing to the partner' })).toBeNull();
  });

  it.each([true, false])('creates a new interface with write permission %s and shows the disabled note after import', async allowWrites => {
    await dialog(null);
    const checkbox = screen.getByRole('checkbox', { name: 'Allow writing to the partner' }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    if (!allowWrites) fireEvent.click(checkbox);
    await pick();
    fireEvent.click(importButton());
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('The interface starts disabled.'));
    expect(importSewUdpSymbolTable).toHaveBeenCalledWith(expect.objectContaining({ targetInterfaceId: null, allowWebToPlc: allowWrites }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('reads the CSV using the ordinary browser file input when FS Access is unavailable', async () => {
    await dialog();
    vi.stubGlobal('showOpenFilePicker', undefined);
    fireEvent.change(screen.getByLabelText('SEW symbol table CSV'), { target: { files: [new File([CSV], 'fallback.csv')] } });
    await waitFor(() => expect(screen.getByText('4 signals (2 sent, 2 received) · 0 skipped')).toBeTruthy());
    expect(importButton().disabled).toBe(false);
  });
});

describe('SEW UDP Add flow', () => {
  it.each([true, false])('opens import from Add SEW MOVI-C (UDP) and preserves write permission %s', async allowWrites => {
    stubGateway(null);
    await connectToServer();
    const lpm = new LeftPanelManager();
    lpm.open('connect', 360);
    const panelViewer = {
      ...viewer, leftPanelManager: lpm, loadTrust: { trusted: true }, lastLoadResult: null,
      getPlugin: () => undefined,
    } as unknown as RVViewer;
    render(wrap(<RVViewerProvider value={panelViewer}><ConnectPanel /></RVViewerProvider>));
    fireEvent.click(screen.getByRole('button', { name: 'Add Interface' }));
    fireEvent.click(screen.getByText('SEW MOVI-C (UDP)'));
    const checkbox = screen.getByRole('checkbox', { name: 'Allow realvirtual WEB to write inputs to the PLC' }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    if (!allowWrites) fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Choose file/ })).toBeTruthy());
    const created = getConnectSnapshot().interfaces[0];
    expect(created).toMatchObject({ type: 'Udp', enabled: false, allowWebToPlc: allowWrites, signals: [] });
    expect(screen.getByRole('dialog').textContent).toContain(created.id);
    expect(screen.queryByRole('checkbox', { name: 'Allow writing to the partner' })).toBeNull();
    await pick();
    fireEvent.click(importButton());
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('The interface starts disabled.'));
    expect(importSewUdpSymbolTable).toHaveBeenCalledOnce();
    expect(importSewUdpSymbolTable).toHaveBeenCalledWith(expect.objectContaining({ targetInterfaceId: created.id, allowWebToPlc: allowWrites }));
    expect(getConnectSnapshot().interfaces[0]).toMatchObject({ allowWebToPlc: allowWrites, enabled: false, signals: expect.any(Array) });
    expect(getConnectSnapshot().interfaces[0].signals).toHaveLength(4);
  });
});
