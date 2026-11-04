// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2024 P1 F3: an open edit survives a config push. The pushed configuration is held (not
 * written under the user's hands), the panel says "Configuration changed outside" with a Reload
 * button, the typed value stays, and closing the edit or pressing Reload applies the new config.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState, useSyncExternalStore } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { ConnectPanel, EditInterfaceDialog } from '../../src/core/hmi/ConnectPanel';
import { SignalEditDialog } from '../../src/core/hmi/SignalEditDialog';
import {
  connectToServer,
  getConnectSnapshot,
  subscribeConnectStore,
  handleConnectConfigPush,
  _setConfigRetryDelaysForTest,
  _resetConnectStore,
  type ConnectInterface,
} from '../../src/core/hmi/connect-store';
import { LeftPanelManager } from '../../src/core/hmi/left-panel-manager';
import { rvDarkTheme } from '../../src/core/hmi/theme';
import { RVViewerProvider } from '../../src/hooks/use-viewer';
import type { RVViewer } from '../../src/core/rv-viewer';
import { installConfigGateway, type FakeConfigGateway } from '../helpers/connect-config-gateway';

vi.setConfig({ testTimeout: 30_000 });

let gw: FakeConfigGateway;
const iface = (ip: string): ConnectInterface =>
  ({ id: 's7-1', type: 'S7', enabled: true, ipAddress: ip, signals: [] }) as unknown as ConnectInterface;

/**
 * Mirrors how the interface card hosts the signal dialog: the dialog lives only while its interface
 * is in the store, so an external delete that reached the store would unmount it with the input.
 */
function SignalDialogHost() {
  const snap = useSyncExternalStore(subscribeConnectStore, getConnectSnapshot);
  const [open, setOpen] = useState(true);
  const host = snap.interfaces.find((i) => i.id === 's7-1');
  if (!host || !open) return <div data-testid="signal-dialog-host-closed" />;
  return <SignalEditDialog open onClose={() => setOpen(false)} iface={host} schema={null} editSignal={null} />;
}

function makeViewer(lpm: LeftPanelManager): RVViewer {
  return {
    leftPanelManager: lpm, signalStore: null, loadTrust: { trusted: true }, lastLoadResult: null,
    registry: null, signalBindingManager: undefined, getPlugin: () => undefined,
  } as unknown as RVViewer;
}

beforeEach(async () => {
  localStorage.clear();
  _resetConnectStore();
  vi.restoreAllMocks();
  _setConfigRetryDelaysForTest([5, 5, 5]);
  gw = installConfigGateway();
  gw.interfaces = [iface('192.168.1.50')];
  await act(async () => { await connectToServer(); });
});

afterEach(() => {
  cleanup();
  _setConfigRetryDelaysForTest(null);
  _resetConnectStore();
  vi.restoreAllMocks();
});

describe('ConnectPanel - configuration changed outside', () => {
  it('keeps the open edit, shows the notice, and applies on Reload', async () => {
    const lpm = new LeftPanelManager();
    render(
      <ThemeProvider theme={rvDarkTheme}>
        <RVViewerProvider value={makeViewer(lpm)}>
          <ConnectPanel />
          <EditInterfaceDialog iface={iface('192.168.1.50')} open onClose={() => {}} />
        </RVViewerProvider>
      </ThemeProvider>,
    );
    await act(async () => { lpm.open('connect', 360); });

    // the user is typing
    const ip = await screen.findByLabelText('IP Address');
    fireEvent.change(ip, { target: { value: '10.9.9.9' } });
    expect(screen.queryByTestId('connect-config-changed-notice')).toBeNull();

    // somebody else changes the configuration
    gw.interfaces = [iface('192.168.1.77'), { id: 'extra', type: 'S7', enabled: true, signals: [] } as unknown as ConnectInterface];
    await act(async () => { handleConnectConfigPush({ instance: 'g', revision: 1 }); });

    await waitFor(() => expect(screen.getByTestId('connect-config-changed-notice')).toBeTruthy());
    expect(screen.getByText('Configuration changed outside')).toBeTruthy();
    expect((screen.getByLabelText('IP Address') as HTMLInputElement).value).toBe('10.9.9.9'); // edit preserved
    expect(getConnectSnapshot().interfaces).toHaveLength(1); // held, not written

    await act(async () => { fireEvent.click(screen.getByTestId('connect-config-reload')); });

    expect(screen.queryByTestId('connect-config-changed-notice')).toBeNull();
    expect(getConnectSnapshot().interfaces).toHaveLength(2);
  });

  it('an external delete of the interface keeps the signal dialog and its input (notice instead)', async () => {
    render(
      <ThemeProvider theme={rvDarkTheme}>
        <SignalDialogHost />
      </ThemeProvider>,
    );
    const name = await screen.findByLabelText('Signal name');
    fireEvent.change(name, { target: { value: 'MyTypedSignal' } });

    // the interface is deleted elsewhere
    gw.interfaces = [];
    await act(async () => { handleConnectConfigPush({ instance: 'g', revision: 1 }); });

    await waitFor(() => expect(screen.getByTestId('signal-edit-config-changed')).toBeTruthy());
    expect((screen.getByLabelText('Signal name') as HTMLInputElement).value).toBe('MyTypedSignal');
    expect(getConnectSnapshot().interfaces).toHaveLength(1); // held, the dialog's interface stays

    // closing the dialog applies the held configuration
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /cancel/i })); });
    await waitFor(() => expect(getConnectSnapshot().interfaces).toHaveLength(0));
  });

  it('without an open edit the push applies at once and shows no notice', async () => {
    const lpm = new LeftPanelManager();
    render(
      <ThemeProvider theme={rvDarkTheme}>
        <RVViewerProvider value={makeViewer(lpm)}>
          <ConnectPanel />
        </RVViewerProvider>
      </ThemeProvider>,
    );
    await act(async () => { lpm.open('connect', 360); });

    gw.interfaces = [iface('192.168.1.50'), { id: 'extra', type: 'S7', enabled: true, signals: [] } as unknown as ConnectInterface];
    await act(async () => { handleConnectConfigPush({ instance: 'g', revision: 1 }); });

    await waitFor(() => expect(getConnectSnapshot().interfaces).toHaveLength(2));
    expect(screen.queryByTestId('connect-config-changed-notice')).toBeNull();
  });
});
