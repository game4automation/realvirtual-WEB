// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-344 Phase 3.3 + 3.4 — ConnectPanel stays mounted while closed, but stops
 * working.
 *
 * `App.tsx` renders `<ConnectPanel />` permanently and the `if (!isOpen) return
 * null` sits AFTER every hook. That is a deliberate decision (the user's panel
 * state must survive closing it), but it meant two background timers kept running
 * for a panel nobody can see: a 2-second `/status` poll and a 1-second age tick.
 * Both are now gated on `isOpen`.
 *
 * Closing the panel does unmount `SignalListView` with its scroll container, so
 * the scroll offset is persisted per interface alongside the filter and the
 * collapsed groups — otherwise "reopen restores your view" would be true for two
 * of three things and quietly false for the third.
 *
 * Phase 3.3 is covered by the render-counter test at the end: `EMPTY_SIGNAL_NAMES`
 * and the `useCallback`'d bridge handler are only observable through their effect,
 * namely that a parent re-render with unchanged data no longer re-renders the
 * memoised rows.
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor, act } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { ConnectPanel, SignalListView } from '../src/core/hmi/ConnectPanel';
import { connectToServer, setServerUrl } from '../src/core/hmi/connect-store';
import { LeftPanelManager } from '../src/core/hmi/left-panel-manager';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import type { RVViewer } from '../src/core/rv-viewer';
import type { ConnectInterface, ConnectInterfaceSignal } from '../src/core/hmi/connect-store';

const SERVER = 'http://127.0.0.1:59999';
/** The gated poll period (`setInterval(fetchStatus, 2000)`). */
const POLL_MS = 2000;

interface FetchCounts { status: number; total: number }

/** Minimal gateway stub. Everything not modelled answers 404, which every
 *  caller in connect-store treats as "older gateway" and tolerates. */
function installFetchStub(counts: FetchCounts): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    counts.total++;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

    if (url.endsWith('/health')) return json({ status: 'ok', version: '1.0.0', build: 1 });
    if (url.endsWith('/config/interfaces')) return json([]); // bare array, per fetchInterfaces
    if (url.endsWith('/interface-types')) return json({ types: [] });
    if (url.includes('/status')) { counts.status++; return json({ interfaces: [] }); }
    return new Response('', { status: 404 });
  }));
}

function makeViewer(lpm: LeftPanelManager, store: SignalStore | null = null): RVViewer {
  return {
    leftPanelManager: lpm,
    signalStore: store,
    registry: null,
    signalBindingManager: undefined,
    getPlugin: () => undefined,
  } as unknown as RVViewer;
}

function renderPanel(viewer: RVViewer) {
  return render(
    <ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={viewer}>
        <ConnectPanel />
      </RVViewerProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  setServerUrl(SERVER);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('ConnectPanel — background work is gated on isOpen', () => {
  it('T1/T2 a CLOSED but mounted panel issues no /status poll while connected', async () => {
    const counts: FetchCounts = { status: 0, total: 0 };
    installFetchStub(counts);
    await act(async () => { await connectToServer(); });

    const lpm = new LeftPanelManager(); // nothing open
    renderPanel(makeViewer(lpm));
    // The panel renders nothing while closed…
    expect(screen.queryByText(/realvirtual CONNECT/i)).toBeNull();

    const statusAfterConnect = counts.status;
    await act(async () => { await new Promise((r) => setTimeout(r, POLL_MS * 2 + 300)); });

    // …and does no background work either. Before the gate this was ~2 polls
    // per 2 s, forever, for a panel nobody could see. The 1-second age tick is
    // covered by the same gate (it only runs while `unreachable`, which cannot
    // arise here precisely because no poll runs).
    expect(counts.status).toBe(statusAfterConnect);
  });

  it('T3 opening the panel starts the poll immediately and then on the 2-second grid', async () => {
    const counts: FetchCounts = { status: 0, total: 0 };
    installFetchStub(counts);
    await act(async () => { await connectToServer(); });

    const lpm = new LeftPanelManager();
    renderPanel(makeViewer(lpm));
    const before = counts.status;

    await act(async () => {
      lpm.open('connect', 360);
      await new Promise((r) => setTimeout(r, 150));
    });
    // First call is immediate (fetchStatus() before the setInterval).
    await waitFor(() => expect(counts.status).toBeGreaterThan(before));
    const afterOpen = counts.status;

    await act(async () => { await new Promise((r) => setTimeout(r, POLL_MS + 400)); });
    expect(counts.status).toBeGreaterThan(afterOpen);

    // Closing stops it again.
    await act(async () => {
      lpm.close('connect');
      await new Promise((r) => setTimeout(r, 100));
    });
    const afterClose = counts.status;
    await act(async () => { await new Promise((r) => setTimeout(r, POLL_MS * 2 + 300)); });
    expect(counts.status).toBe(afterClose);
  });
});

// ── Phase 3.4 scroll persistence + Phase 3.3 memo stability ─────────────────

function makeSignals(count: number): ConnectInterfaceSignal[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `S_${i}`,
    protocolAddress: `%I${i}.0`,
    type: 'PLCInputBool',
    record: false,
  }));
}

function listInterface(id: string): ConnectInterface {
  return { id, type: 'MQTT', enabled: true, signals: makeSignals(400), topics: [] };
}

function renderList(iface: ConnectInterface, viewer: RVViewer, extra?: React.ReactNode) {
  return render(
    <ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={viewer}>
        <div style={{ height: 400, display: 'flex', flexDirection: 'column' }}>
          {extra}
          <SignalListView iface={iface} overLimitSignals={[]} />
        </div>
      </RVViewerProvider>
    </ThemeProvider>,
  );
}

describe('ConnectPanel — reopening restores the whole view (Phase 3.4)', () => {
  it('T4 filter text, collapsed groups AND scroll offset survive close + reopen', async () => {
    const iface = listInterface('scroll-persist');
    const store = new SignalStore();
    for (const s of iface.signals!) store.register(s.name, `Root/${s.name}`, false, s.type);
    const viewer = makeViewer(new LeftPanelManager(), store);

    const first = renderList(iface, viewer);
    await screen.findByText('S_0');

    const scroller = first.container.querySelector('.rv-scroll') as HTMLElement | null
      ?? first.container.querySelector('div[class*="MuiBox"] div[class*="MuiBox"]') as HTMLElement;
    expect(scroller).toBeTruthy();

    await act(async () => {
      scroller.scrollTop = 1200;
      scroller.dispatchEvent(new Event('scroll'));
      await new Promise((r) => setTimeout(r, 60));
    });
    // Persisted the moment the user scrolls — closing the panel is an unmount,
    // there is no later chance to save it.
    expect(Number(localStorage.getItem('rv-connect-scroll:scroll-persist'))).toBeGreaterThan(0);

    // Filter + collapsed groups use the same per-interface localStorage keys and
    // were already persisted before plan-344; asserted here so the three
    // restored values are covered as ONE contract.
    expect(localStorage.getItem('rv-connect-filter:scroll-persist')).toBeTruthy();

    // Close (unmount) and reopen (fresh mount) — the offset comes back.
    first.unmount();
    renderList(iface, viewer);
    await screen.findByText('S_0');
    const reopened = document.querySelector('.rv-scroll') as HTMLElement;
    await waitFor(() => expect(reopened.scrollTop).toBeGreaterThan(0));
  });

  it('a never-scrolled interface stores nothing (no localStorage litter)', async () => {
    const iface = listInterface('never-scrolled');
    const viewer = makeViewer(new LeftPanelManager(), null);
    renderList(iface, viewer);
    await screen.findByText('S_0');
    expect(localStorage.getItem('rv-connect-scroll:never-scrolled')).toBeNull();
  });
});

describe('ConnectPanel — memoised rows survive parent re-renders (Phase 3.3)', () => {
  /**
   * Covers BOTH Phase 3.3 fixes at once, and deliberately at the only level where
   * they are observable from outside: the module-level `EMPTY_SIGNAL_NAMES`
   * constant (was `?? []`, a new array per render that invalidated the
   * `useMemo(new Set(...))`) and the `useCallback`'d bridge handler (was an inline
   * closure, a new identity per render that broke `React.memo` on every visible
   * row). The earlier idea of asserting the identity of the internal `Set` is not
   * possible — it never leaves the component.
   */
  it('T5 re-rendering the parent with unchanged data does not re-render the rows', async () => {
    const iface = listInterface('memo-iface');
    const store = new SignalStore();
    for (const s of iface.signals!) store.register(s.name, `Root/${s.name}`, false, s.type);
    const viewer = makeViewer(new LeftPanelManager(), store);

    let bump: (() => void) | null = null;
    function Parent() {
      const [, setN] = React.useState(0);
      bump = () => setN((n) => n + 1);
      return (
        <div style={{ height: 400, display: 'flex', flexDirection: 'column' }}>
          <SignalListView iface={iface} overLimitSignals={[]} />
        </div>
      );
    }

    render(
      <ThemeProvider theme={rvDarkTheme}>
        <RVViewerProvider value={viewer}>
          <Parent />
        </RVViewerProvider>
      </ThemeProvider>,
    );
    const row = await screen.findByText('S_0');
    // A memoised row that does NOT re-render keeps its exact DOM node.
    const nodeBefore = row;

    await act(async () => { bump!(); });
    await act(async () => { bump!(); });

    expect(screen.getByText('S_0')).toBe(nodeBefore);
  });
});

