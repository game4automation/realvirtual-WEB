// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-363 Phase 8 — the visible line in the ConnectPanel.
 *
 * The pure comparison is covered by `connect-update-available.test.ts`; what is pinned here is that
 * it actually reaches the operator: the row appears with both versions, it offers the way into the
 * plan-343 flow, it stays away when the installation is current — and it costs no request of its
 * own beyond the `/health` the panel performs anyway (plan-343 T26).
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, act } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { ConnectUpdateNotice } from '../src/core/hmi/ConnectUpdateNotice';
import { connectToServer, setServerUrl, _resetConnectStore } from '../src/core/hmi/connect-store';
import {
  __setConnectDownloadsForTest,
  __resetConnectDownloadsForTest,
} from '../src/core/hmi/connect-downloads';
import { rvDarkTheme } from '../src/core/hmi/theme';

const SERVER = 'http://update-notice.test:5100';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Connects the store to a gateway reporting `version` and the given update verdict. */
async function connectGateway(
  version: string,
  update: { updateSupported?: boolean; updateReason?: string | null } = {},
): Promise<string[]> {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
    const url = String(typeof request === 'string' ? request : request instanceof URL ? request.href : request.url);
    calls.push(url);
    if (url.endsWith('/health')) {
      return json({ status: 'ok', version, build: 31, updateSupported: true, updateReason: null, ...update });
    }
    if (url.endsWith('/config/interfaces')) return json([]);
    if (url.endsWith('/interface-types')) return json({ types: [] });
    return new Response('', { status: 404 });
  }));
  setServerUrl(SERVER);
  await act(async () => { await connectToServer(); });
  return calls;
}

/** Publishes a stable channel offer, as the release-manifest probe would. */
function offerStable(version: string | null): void {
  __setConnectDownloadsForTest({
    stable: {
      url: 'https://web.realvirtual.io/download/realvirtual-Connect.exe',
      version,
      build: 40,
      buildDate: '2026-08-01',
    },
    beta: null,
    loaded: true,
  });
}

function renderNotice(onOpenSettings = vi.fn()) {
  render(
    <ThemeProvider theme={rvDarkTheme}>
      <ConnectUpdateNotice onOpenSettings={onOpenSettings} />
    </ThemeProvider>,
  );
  return onOpenSettings;
}

beforeEach(() => {
  localStorage.clear();
  _resetConnectStore();
  __resetConnectDownloadsForTest();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  _resetConnectStore();
  __resetConnectDownloadsForTest();
});

describe('ConnectUpdateNotice', () => {
  it('names both versions and offers the way into the update flow', async () => {
    await connectGateway('6.3.9');
    offerStable('6.3.10');
    const onOpenSettings = renderNotice();

    // The announcement itself is the control — one target, no sentence-plus-link.
    const button = screen.getByRole('button', { name: 'Update available - 6.3.9 → 6.3.10' });
    await act(async () => { button.click(); });
    // Display only: the line opens the settings window, where plan-343 asks for a confirmation.
    // It never starts an update itself.
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('shows nothing at all on a current installation', async () => {
    await connectGateway('6.3.10');
    offerStable('6.3.10');
    renderNotice();

    expect(screen.queryByText(/Update available/)).toBeNull();
  });

  it('shows nothing while the release manifest is unreachable', async () => {
    await connectGateway('6.3.9');
    offerStable(null);
    renderNotice();

    expect(screen.queryByText(/Update available/)).toBeNull();
  });

  it('states the reason instead of the update route when the gateway cannot update itself', async () => {
    await connectGateway('6.3.9', { updateSupported: false, updateReason: 'not-supported' });
    offerStable('6.3.10');
    renderNotice();

    expect(screen.getByText('Update available - 6.3.9 → 6.3.10')).toBeTruthy();
    expect(screen.getByText('This installation does not offer updates.')).toBeTruthy();
    // No route to act on, so the row stays a plain line rather than a button leading nowhere.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('costs no request of its own — /health is the only source it reads', async () => {
    const calls = await connectGateway('6.3.9');
    offerStable('6.3.10');
    renderNotice();

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(calls.filter((url) => url.includes('/update/'))).toEqual([]);
  });
});
