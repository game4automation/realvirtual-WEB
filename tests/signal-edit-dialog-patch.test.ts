// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2025 F10 / §9 `signal-edit-dialog-patch` — the signal dialog writes a patch that keeps what it
 * does not edit: `record` and the OPC UA acquisition fields (`subscribeValue`, `pollValue`,
 * `pollCycleMs`) survive a save (the spike found them reset on every edit), and a changed name goes
 * through `/config/signals/rename` instead of replacing the entry. A partial rename shows the notice
 * and turns Save into Retry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { SignalEditDialog, opcUaFieldsOf } from '../src/core/hmi/SignalEditDialog';
import { rvDarkTheme } from '../src/core/hmi/theme';
import {
  _resetConnectStore,
  fetchInterfaces,
  setServerUrl,
  signalUpsertOp,
  type ConnectInterface,
  type ConnectInterfaceSignal,
} from '../src/core/hmi/connect-store';
import { installFakeGateway, type FakeGateway } from './_connect-ops-fake-gateway';

const OPC_SIGNAL: ConnectInterfaceSignal = {
  name: 'Line.Speed', protocolAddress: 'ns=2;s=Line.Speed', type: 'PLCOutputFloat', dataType: 'Float',
  comment: 'old', record: true, subscribeValue: false, pollValue: true, pollCycleMs: 250,
};
const IFACE: ConnectInterface = { id: 'opc-1', type: 'OpcUa', enabled: true, signals: [OPC_SIGNAL] } as ConnectInterface;

let gw: FakeGateway;
beforeEach(async () => {
  _resetConnectStore();
  setServerUrl('http://gw.test:5100');
  gw = installFakeGateway({ interfaces: [IFACE] });
  await fetchInterfaces();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); _resetConnectStore(); });

function renderDialog(onClose = () => {}) {
  render(createElement(ThemeProvider, { theme: rvDarkTheme },
    createElement(SignalEditDialog, { open: true, onClose, iface: IFACE, schema: null, editSignal: OPC_SIGNAL })));
}

describe('signalUpsertOp / opcUaFieldsOf', () => {
  it('sends every edited field explicitly and the OPC UA fields only when present', () => {
    expect(signalUpsertOp('opc-1', { name: 'A', protocolAddress: 'ns=2;i=1', type: 'PLCOutputBool', record: false }))
      .toEqual({ op: 'signal.upsert', interfaceId: 'opc-1', name: 'A', type: 'PLCOutputBool', protocolAddress: 'ns=2;i=1', addressMode: 'overwrite', dataType: '', comment: '', record: false });
    expect(opcUaFieldsOf(OPC_SIGNAL)).toEqual({ subscribeValue: false, pollValue: true, pollCycleMs: 250 });
    expect(opcUaFieldsOf({ name: 'x', protocolAddress: '', type: 'PLCOutputBool', record: false })).toEqual({});
  });
});

describe('SignalEditDialog save', () => {
  it('keeps record and the OPC UA acquisition fields', async () => {
    const onClose = vi.fn();
    renderDialog(onClose);
    fireEvent.change(screen.getByLabelText('Comment (optional)'), { target: { value: 'new comment' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const op = gw.opsCalls().at(-1)!.ops[0];
    expect(op).toMatchObject({ op: 'signal.upsert', name: 'Line.Speed', comment: 'new comment', record: true, subscribeValue: false, pollValue: true, pollCycleMs: 250 });
    expect(gw.interfaces[0].signals[0]).toMatchObject({ comment: 'new comment', record: true, subscribeValue: false, pollValue: true, pollCycleMs: 250 });
    expect(gw.calls.some(c => c.method === 'PUT')).toBe(false);
  });

  it('a changed name goes through /config/signals/rename, never as a replaced entry', async () => {
    const onClose = vi.fn();
    renderDialog(onClose);
    fireEvent.change(screen.getByTestId('rv-signal-name-input'), { target: { value: 'Line.Velocity' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(gw.calls.filter(c => c.path === '/config/signals/rename')).toHaveLength(2);
    expect(gw.interfaces[0].signals).toHaveLength(1);
    expect(gw.interfaces[0].signals[0]).toMatchObject({ name: 'Line.Velocity', pollCycleMs: 250, record: true });
  });

  it('a rename whose second step fails shows the notice and offers Retry', async () => {
    gw.failOps.push({ status: 400, body: { code: 'ops-rejected', errors: ['ops[0] signal.upsert: datatype-not-allowed'], results: [] } });
    const onClose = vi.fn();
    renderDialog(onClose);
    fireEvent.change(screen.getByTestId('rv-signal-name-input'), { target: { value: 'Line.Velocity' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    expect((await screen.findByTestId('signal-edit-rename-partial')).textContent)
      .toMatch(/Renamed to 'Line\.Velocity' — other changes not saved/);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(gw.calls.filter(c => c.path === '/config/signals/rename')).toHaveLength(2);
  });
});
