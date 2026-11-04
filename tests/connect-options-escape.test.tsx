// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2044 F3: Escape and the "CONNECT Settings" window.
 *
 * Phase 0 (live, 2026-10-30): the tutorial take left the license dialog OPEN through the whole
 * registration and pressed Escape once — that Escape closed the dialog (MUI stops it at the
 * modal, the topmost layer) and the settings window stayed. Correct by the stack rule, and the
 * second Escape closes the window. The defect the reproduction did find is in the stack itself:
 * `FloatingPanel` re-registered its Escape entry on every new `onClose` identity, and the CONNECT
 * panel passes an inline arrow and re-renders on every store update (measured: 24 re-registrations
 * in 13 s). Each one moved "CONNECT Settings" back to the TOP of the stack, above any panel opened
 * after it — Escape then closed the settings window instead of the newer panel, or, the other way
 * round, a frequently re-rendering older panel took the Escape meant for CONNECT Settings.
 */

import { memo, useCallback, useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { FloatingPanel } from '../src/core/hmi/FloatingPanel';
import { ConnectOptionsWindow } from '../src/core/hmi/ConnectOptionsWindow';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { connectToServer, _resetConnectStore } from '../src/core/hmi/connect-store';
import {
  _setLicenseSnapshotForTests,
  clearLicenseStatus,
} from '../src/core/hmi/license-store';

vi.mock('../src/core/hmi/panel-anchor-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/hmi/panel-anchor-store')>(),
  getRecentAnchorPoint: () => null,
}));

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function pressEscape(): void {
  // Where a real key press lands: the focused element (inside the MUI dialog while it is open).
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape', code: 'Escape' });
}

function settingsOpen(): boolean {
  return screen.queryByText('CONNECT Settings') !== null;
}

function dialogOpen(): boolean {
  return document.querySelector('[role="dialog"]') !== null;
}

/**
 * The CONNECT panel's shape: it owns `optionsOpen`, passes an inline `onClose`, and re-renders on
 * every store update — modelled by `tick`, which the test bumps.
 */
function SettingsHost({ tick, withSecond }: { tick: number; withSecond: boolean }) {
  const [optionsOpen, setOptionsOpen] = useState(true);
  return (
    <ThemeProvider theme={rvDarkTheme}>
      <span data-testid="tick">{tick}</span>
      <ConnectOptionsWindow
        open={optionsOpen}
        onClose={() => setOptionsOpen(false)}
        onProfileSwitched={() => { /* no bridge list here */ }}
      />
      <SecondPanel show={withSecond} />
    </ThemeProvider>
  );
}

/**
 * A panel opened AFTER the settings window that does NOT re-render with it (memoised, stable
 * `onClose`) — so only the settings window gets new `onClose` identities.
 */
const SecondPanel = memo(function SecondPanel({ show }: { show: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (show) setOpen(true); }, [show]);
  const close = useCallback(() => setOpen(false), []);
  return (
    <FloatingPanel
      open={open}
      onClose={close}
      title="Second Panel"
      panelId="plan-2044-second"
      defaultWidth={200}
      defaultHeight={150}
      minWidth={200}
    >
      <div>second</div>
    </FloatingPanel>
  );
});

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  _resetConnectStore();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === '/health') return json({ status: 'ok' });
    if (url.pathname === '/config/interfaces' || url.pathname === '/profiles') return json([]);
    return json({});
  }));
  await connectToServer();
  _setLicenseSnapshotForTests({
    supported: true,
    status: {
      state: 'Unlicensed', gatewayAllowed: false, maxSignals: 0, admittedSignals: 0,
      effectiveNow: '2026-10-30T22:00:00Z', overLimitSignals: [],
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearLicenseStatus();
  _resetConnectStore();
});

describe('Escape and CONNECT Settings (plan-2044 F3)', () => {
  it('license dialog open: Escape closes only the dialog, the next Escape closes the window', async () => {
    render(<SettingsHost tick={0} withSecond={false} />);
    expect(settingsOpen()).toBe(true);

    fireEvent.click(await screen.findByRole('button', { name: 'Activate license...' }));
    await waitFor(() => expect(dialogOpen()).toBe(true));

    pressEscape();
    await waitFor(() => expect(dialogOpen()).toBe(false));
    expect(settingsOpen()).toBe(true);

    pressEscape();
    await waitFor(() => expect(settingsOpen()).toBe(false));
  });

  it('license dialog opened and closed with its button: Escape closes the window', async () => {
    render(<SettingsHost tick={0} withSecond={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Activate license...' }));
    await waitFor(() => expect(dialogOpen()).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(dialogOpen()).toBe(false));

    pressEscape();

    await waitFor(() => expect(settingsOpen()).toBe(false));
  });

  it('re-renders of the settings parent do not lift it above a panel opened later', async () => {
    const { rerender } = render(<SettingsHost tick={0} withSecond={false} />);
    rerender(<SettingsHost tick={0} withSecond />);
    await screen.findByText('Second Panel');

    // The CONNECT panel re-renders on every store update; each render passes a new onClose.
    for (let tick = 1; tick <= 5; tick++) {
      rerender(<SettingsHost tick={tick} withSecond />);
      await act(async () => { await Promise.resolve(); });
    }

    pressEscape();
    await waitFor(() => expect(screen.queryByText('Second Panel')).toBeNull());
    expect(settingsOpen()).toBe(true);

    pressEscape();
    await waitFor(() => expect(settingsOpen()).toBe(false));
  });
});
