// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-562 §9.8 — the write-gate overlay, the visible half of the customer case.
 *
 * PLCSIM Advanced was attached through CONNECT, the connection stood, and not a
 * single viewer input reached the PLC: `AllowWebToPlc` defaults to `false` and
 * CONNECT logged the dropped writes exactly once. Pinned here is the cure —
 * the overlay appears with the lost input named, "Allow writes" calls the
 * dedicated gate endpoint with the revision of the snapshot on screen, a 409
 * keeps the card and says why, "Read only, don't ask again" silences it and
 * leaves the chip as the way back, and an interface whose gate is already open
 * never produces a card at all.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import type { RVViewer } from '../src/core/rv-viewer';
import { ConnectWriteGateNotice } from '../src/core/hmi/ConnectWriteGateNotice';
import { InterfaceCard } from '../src/core/hmi/ConnectPanel';
import { LeftPanelManager } from '../src/core/hmi/left-panel-manager';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import {
  connectToServer,
  fetchStatus,
  getConnectSnapshot,
  setServerUrl,
  _resetConnectStore,
  type ConnectInterface,
} from '../src/core/hmi/connect-store';
import {
  isWriteGateReadOnly,
  _resetWriteGateStore,
} from '../src/core/hmi/connect-write-gate-store';
import { _resetStore as _resetUiContextStore } from '../src/core/hmi/ui-context-store';

const SERVER = 'http://write-gate-notice.test:5100';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

let calls: Array<{ url: string; method: string; body: string }> = [];

interface GatewayOptions {
  /** `allowWebToPlc` of the configured interface. */
  allowWebToPlc?: boolean;
  blocked?: number;
  blockedSignals?: string[];
  configRevision?: string | null;
  gate?: () => Response;
  /** Second interface, so the "+N more interfaces" line has something to count. */
  second?: boolean;
}

function installGateway(opts: GatewayOptions): void {
  // Stateful, like the real gateway: a successful gate call actually opens it,
  // so the overlay disappears because the CONFIG changed, not because the
  // component decided to hide itself.
  let allow = opts.allowWebToPlc === true;
  const iface = (id: string): ConnectInterface => ({
    id,
    type: 'PlcSimAdvanced',
    enabled: true,
    allowWebToPlc: allow,
    plcSimAdvanced: { instanceName: 'Laserwelding' },
    signals: [
      { name: 'BT2_OpMode', protocolAddress: '%I0.0', type: 'PLCInputBool', record: false },
      { name: 'BT2_Start', protocolAddress: '%I0.1', type: 'PLCInputBool', record: false },
      { name: 'BT2_Done', protocolAddress: '%Q0.0', type: 'PLCOutputBool', record: false },
    ],
  } as unknown as ConnectInterface);

  const statusRow = (id: string): Record<string, unknown> => ({
    id,
    status: 'Connected',
    error: null,
    signalIssues: null,
    configRevision: opts.configRevision === undefined ? 'rev-abc' : opts.configRevision,
    writesBlockedByGate: opts.blocked ?? null,
    blockedSignals: opts.blockedSignals ?? null,
    readHealth: null,
  });

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push({
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      body: typeof init?.body === 'string' ? init.body : '',
    });
    if (url.endsWith('/health')) return json({ status: 'ok', version: '6.3.47', build: 1 });
    if (url.endsWith('/interface-types')) return json({ types: [] });
    if (url.endsWith('/allow-web-to-plc')) {
      const response = opts.gate ? opts.gate() : json({ ok: true });
      if (response.ok) allow = true;
      return response;
    }
    if (url.endsWith('/config/interfaces')) {
      return json(opts.second ? [iface('PLCSIM_1'), iface('PLCSIM_2')] : [iface('PLCSIM_1')]);
    }
    if (new URL(url).pathname === '/status') {
      return json({ interfaces: opts.second ? [statusRow('PLCSIM_1'), statusRow('PLCSIM_2')] : [statusRow('PLCSIM_1')] });
    }
    return new Response('', { status: 404 });
  }));
}

function makeViewer(): RVViewer {
  return {
    leftPanelManager: new LeftPanelManager(),
    signalStore: null,
    loadTrust: { trusted: true },
    lastLoadResult: null,
    registry: null,
    modes: { activeMode: 'hmi' },
    selectionManager: undefined,
    simTime: 0,
    getPlugin: () => undefined,
  } as unknown as RVViewer;
}

async function renderNotice(opts: GatewayOptions): Promise<RVViewer> {
  installGateway(opts);
  setServerUrl(SERVER);
  await act(async () => { await connectToServer(); });
  await act(async () => { await fetchStatus(); });
  const viewer = makeViewer();
  render(
    <ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={viewer}>
        <ConnectWriteGateNotice viewer={viewer} />
      </RVViewerProvider>
    </ThemeProvider>,
  );
  return viewer;
}

function gateCalls(): Array<{ url: string; method: string; body: string }> {
  return calls.filter((c) => c.url.endsWith('/allow-web-to-plc'));
}

async function clickButton(name: string): Promise<void> {
  const button = screen.getByRole('button', { name });
  await act(async () => { button.click(); });
}

beforeEach(() => {
  calls = [];
  localStorage.clear();
  _resetConnectStore();
  _resetWriteGateStore();
  _resetUiContextStore();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  _resetConnectStore();
  _resetWriteGateStore();
  localStorage.clear();
});

describe('ConnectWriteGateNotice (plan-562 §9.8)', () => {
  it('shows once per interface when writes are blocked and calls the gate endpoint on Allow writes', async () => {
    await renderNotice({ blocked: 4, blockedSignals: ['BT2_OpMode', 'BT2_Start', 'BT2_Reset'] });

    expect(screen.getByText('PLCSIM_1 does not accept values from the viewer.')).toBeTruthy();
    expect(screen.getByText('BT2_OpMode and 2 more inputs were not sent to the PLC.')).toBeTruthy();
    // The effect line names target and amount BEFORE the one click happens.
    expect(screen.getByText(/Allowing writes sends the current input values \(2 signals\)/)).toBeTruthy();

    await clickButton('Allow writes');

    const call = gateCalls()[0];
    expect(call?.method).toBe('PUT');
    expect(call?.url).toBe(`${SERVER}/config/interfaces/PLCSIM_1/allow-web-to-plc`);
    expect(JSON.parse(call?.body ?? '{}')).toEqual({ allow: true, revision: 'rev-abc' });
    // The replace-the-whole-interface route is never used (plan review R2 #5).
    expect(calls.filter((c) => c.method === 'PUT' && !c.url.endsWith('/allow-web-to-plc'))).toEqual([]);

    // The gateway now reports the gate open, so the card is gone.
    await waitFor(() => expect(screen.queryByTestId('connect-write-gate-notice')).toBeNull());
  });

  it('keeps the notice and shows the error on 409', async () => {
    await renderNotice({
      blocked: 2,
      blockedSignals: ['BT2_OpMode'],
      gate: () => json({ code: 'revision-mismatch' }, 409),
    });
    await clickButton('Allow writes');

    await waitFor(() => expect(screen.getByTestId('connect-write-gate-outcome').textContent)
      .toBe('The interface changed - review it first'));
    expect(screen.getByTestId('connect-write-gate-notice')).toBeTruthy();
  });

  it('offers the Edit route instead of a dead end when the gateway lacks the endpoint', async () => {
    const viewer = await renderNotice({
      blocked: 1,
      blockedSignals: ['BT2_OpMode'],
      gate: () => new Response('<!doctype html>', { status: 404 }),
    });
    await clickButton('Allow writes');

    await waitFor(() => expect(screen.getByTestId('connect-write-gate-outcome').textContent)
      .toBe('Update CONNECT to allow writes from here'));
    await clickButton('Open interface settings');
    expect(viewer.leftPanelManager.getSnapshot().activePanel).toBe('connect');
    expect(getConnectSnapshot().editInterfaceId).toBe('PLCSIM_1');
  });

  it("stays hidden after \"Read only, don't ask again\" and shows the Writes blocked chip", async () => {
    await renderNotice({ blocked: 5, blockedSignals: ['BT2_OpMode'] });
    await clickButton("Read only, don't ask again");

    expect(screen.queryByTestId('connect-write-gate-notice')).toBeNull();
    expect(isWriteGateReadOnly(SERVER, 'PLCSIM_1')).toBe(true);
    // No request went out: the decision is the viewer's, not the gateway's.
    expect(gateCalls()).toEqual([]);

    // The chip on the interface card is the remaining way back.
    const iface = getConnectSnapshot().interfaces[0];
    render(
      <ThemeProvider theme={rvDarkTheme}>
        <InterfaceCard
          iface={iface}
          status="Connected"
          overLimitSignals={[]}
          expanded={false}
          writesBlocked
          onToggle={() => {}}
          onSetEnabled={() => {}}
          onBrowse={() => {}}
          onImport={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
        />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('writes-blocked-badge')).toBeTruthy();
  });

  it('the chip forgets the decision and opens the Edit dialog', async () => {
    await renderNotice({ blocked: 1, blockedSignals: ['BT2_OpMode'] });
    await clickButton("Read only, don't ask again");
    cleanup();

    const iface = getConnectSnapshot().interfaces[0];
    const onEdit = vi.fn();
    render(
      <ThemeProvider theme={rvDarkTheme}>
        <InterfaceCard
          iface={iface}
          status="Connected"
          overLimitSignals={[]}
          expanded={false}
          writesBlocked
          onToggle={() => {}}
          onSetEnabled={() => {}}
          onBrowse={() => {}}
          onImport={() => {}}
          onEdit={onEdit}
          onDelete={() => {}}
        />
      </ThemeProvider>,
    );
    await act(async () => { screen.getByTestId('writes-blocked-badge').click(); });
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(isWriteGateReadOnly(SERVER, 'PLCSIM_1')).toBe(false);
  });

  it('does not show when allowWebToPlc is already true', async () => {
    await renderNotice({ allowWebToPlc: true, blocked: 7, blockedSignals: ['BT2_OpMode'] });
    expect(screen.queryByTestId('connect-write-gate-notice')).toBeNull();
  });

  it('does not show while the gateway reports no blocked write at all', async () => {
    await renderNotice({ blocked: undefined });
    expect(screen.queryByTestId('connect-write-gate-notice')).toBeNull();
  });

  it('shows at most one card and counts the rest', async () => {
    await renderNotice({ blocked: 2, blockedSignals: ['BT2_OpMode'], second: true });
    expect(screen.getAllByTestId('connect-write-gate-notice')).toHaveLength(1);
    expect(screen.getByText('+1 more interface')).toBeTruthy();
  });

  it('is non-modal, keyboard reachable, and Escape closes it for the session only', async () => {
    await renderNotice({ blocked: 2, blockedSignals: ['BT2_OpMode'] });
    const card = screen.getByRole('status');
    expect(card).toBeTruthy();
    // No focus theft out of the canvas: nothing inside the card is focused.
    expect(card.contains(document.activeElement)).toBe(false);
    expect(screen.getByRole('button', { name: 'Allow writes' }).tabIndex).toBeGreaterThanOrEqual(0);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(screen.queryByTestId('connect-write-gate-notice')).toBeNull();
    // Closing is not answering: nothing was persisted.
    expect(isWriteGateReadOnly(SERVER, 'PLCSIM_1')).toBe(false);
  });
});
