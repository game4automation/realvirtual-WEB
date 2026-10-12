// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-562 §9.10 — "connected, but no PLC outputs received".
 *
 * The other silence of the customer case: the gateway was green, every signal
 * carried a value (the DEFAULT value of a tag that was never found) and the
 * viewer kept simulating. The verdict rests on CONNECT's read health, and the
 * window is measured in SIM time — a paused simulation produces no viewer writes
 * and expects no PLC traffic, so a wall-clock window would accuse the PLC of
 * being silent while it is the viewer that stopped.
 *
 * Rule B ("data stopped") deliberately only applies to workers whose `progress`
 * rises periodically. On a pure on-change path (TwinCAT OnChange, OPC UA without
 * a single polled signal) a standing value is normal operation, and accusing it
 * would be the false alarm restrisk R3 names.
 *
 * The last case is the way out of the notice: with the CONNECT panel CLOSED,
 * "Open log" must both open the panel and show the log — the log dialog renders
 * only inside an open panel, so a flag alone would do nothing visible.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import type { RVViewer } from '../src/core/rv-viewer';
import {
  ConnectNoDataWatch,
  NO_DATA_WINDOW_S,
  connectNoDataWatch,
  type NoDataInterfaceInput,
} from '../src/core/hmi/connect-no-data-watch';
import { ConnectNoDataNotice } from '../src/core/hmi/ConnectNoDataNotice';
import { ConnectPanel } from '../src/core/hmi/ConnectPanel';
import { LeftPanelManager } from '../src/core/hmi/left-panel-manager';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import {
  connectToServer,
  fetchStatus,
  setServerUrl,
  _resetConnectStore,
} from '../src/core/hmi/connect-store';
import { _resetStore as _resetUiContextStore } from '../src/core/hmi/ui-context-store';

/** A healthy, polling worker — every case below varies one field of it. */
function healthy(over: Partial<NoDataInterfaceInput> = {}): NoDataInterfaceInput {
  return {
    id: 'PLCSIM_1',
    status: 'Connected',
    boundReadTags: 42,
    tagsWithValidValue: 42,
    progress: 1,
    workerGeneration: 1,
    progressIsPeriodic: true,
    signalIssues: 0,
    ...over,
  };
}

describe('ConnectNoDataWatch — rule A, no valid data (plan-562 §9.10)', () => {
  it('reports "no readable tags bound" after the window with nothing bound', () => {
    const watch = new ConnectNoDataWatch();
    const iface = healthy({ boundReadTags: 0, tagsWithValidValue: 0, progress: 0, signalIssues: 12 });
    expect(watch.update({ simTime: 0, connected: true, interfaces: [iface] })).toEqual([]);
    // One tick short of the window is still silence the PLC is allowed.
    expect(watch.update({ simTime: NO_DATA_WINDOW_S - 1, connected: true, interfaces: [iface] })).toEqual([]);
    expect(watch.update({ simTime: NO_DATA_WINDOW_S, connected: true, interfaces: [iface] })).toEqual([
      { interfaceId: 'PLCSIM_1', reason: 'no-readable-tags', workerGeneration: 1, signalIssues: 12 },
    ]);
  });

  it('reports "no valid values received" when tags are bound but never decoded', () => {
    const watch = new ConnectNoDataWatch();
    const iface = healthy({ tagsWithValidValue: 0, progress: 0 });
    watch.update({ simTime: 0, connected: true, interfaces: [iface] });
    const hits = watch.update({ simTime: NO_DATA_WINDOW_S, connected: true, interfaces: [iface] });
    expect(hits.map((h) => h.reason)).toEqual(['no-valid-values']);
  });

  it('stays silent when at least one tag delivered a valid value', () => {
    const watch = new ConnectNoDataWatch();
    const iface = healthy({ tagsWithValidValue: 1 });
    watch.update({ simTime: 0, connected: true, interfaces: [iface] });
    expect(watch.update({ simTime: NO_DATA_WINDOW_S * 3, connected: true, interfaces: [iface] })).toEqual([]);
  });
});

describe('ConnectNoDataWatch — rule B, data stopped (plan-562 §9.10)', () => {
  it('reports "data stopped" after progress stalls on a periodic path', () => {
    const watch = new ConnectNoDataWatch();
    watch.update({ simTime: 0, connected: true, interfaces: [healthy({ progress: 1 })] });
    watch.update({ simTime: 1, connected: true, interfaces: [healthy({ progress: 2 })] });
    // Still fresh.
    expect(watch.update({ simTime: 5, connected: true, interfaces: [healthy({ progress: 2 })] })).toEqual([]);
    const hits = watch.update({
      simTime: 1 + NO_DATA_WINDOW_S, connected: true, interfaces: [healthy({ progress: 2 })],
    });
    expect(hits.map((h) => h.reason)).toEqual(['data-stopped']);
  });

  it('never reports "data stopped" on an on-change path (restrisk R3)', () => {
    const watch = new ConnectNoDataWatch();
    const onChange = (progress: number) => healthy({ progress, progressIsPeriodic: false });
    watch.update({ simTime: 0, connected: true, interfaces: [onChange(1)] });
    watch.update({ simTime: 1, connected: true, interfaces: [onChange(2)] });
    expect(watch.update({
      simTime: 1 + NO_DATA_WINDOW_S * 5, connected: true, interfaces: [onChange(2)],
    })).toEqual([]);
  });

  it('clears itself again as soon as progress resumes', () => {
    const watch = new ConnectNoDataWatch();
    watch.update({ simTime: 0, connected: true, interfaces: [healthy({ progress: 1 })] });
    watch.update({ simTime: 1, connected: true, interfaces: [healthy({ progress: 2 })] });
    expect(watch.update({
      simTime: 1 + NO_DATA_WINDOW_S, connected: true, interfaces: [healthy({ progress: 2 })],
    })).toHaveLength(1);
    expect(watch.update({
      simTime: 2 + NO_DATA_WINDOW_S, connected: true, interfaces: [healthy({ progress: 3 })],
    })).toEqual([]);
  });
});

describe('ConnectNoDataWatch — windows and lifetimes (plan-562 §9.10)', () => {
  const silent = (over: Partial<NoDataInterfaceInput> = {}) =>
    healthy({ boundReadTags: 0, tagsWithValidValue: 0, progress: 0, ...over });

  it('a worker restart during the same gateway session opens a new window', () => {
    const watch = new ConnectNoDataWatch();
    watch.update({ simTime: 0, connected: true, interfaces: [silent()] });
    expect(watch.update({ simTime: NO_DATA_WINDOW_S, connected: true, interfaces: [silent()] }))
      .toHaveLength(1);
    // workerGeneration +1 = a fresh worker, which deserves a fresh window.
    expect(watch.update({
      simTime: NO_DATA_WINDOW_S, connected: true, interfaces: [silent({ workerGeneration: 2 })],
    })).toEqual([]);
    expect(watch.update({
      simTime: NO_DATA_WINDOW_S * 2, connected: true, interfaces: [silent({ workerGeneration: 2 })],
    })).toHaveLength(1);
  });

  it('an interface that connects late gets its own window', () => {
    const watch = new ConnectNoDataWatch();
    watch.update({ simTime: 0, connected: true, interfaces: [silent()] });
    const late = silent({ id: 'PLCSIM_2' });
    // At t = 10 the first one is judged, the second has only just arrived.
    const hits = watch.update({ simTime: NO_DATA_WINDOW_S, connected: true, interfaces: [silent(), late] });
    expect(hits.map((h) => h.interfaceId)).toEqual(['PLCSIM_1']);
    const later = watch.update({
      simTime: NO_DATA_WINDOW_S * 2, connected: true, interfaces: [silent(), late],
    });
    expect(later.map((h) => h.interfaceId)).toEqual(['PLCSIM_1', 'PLCSIM_2']);
  });

  it('a paused simulation never elapses the window', () => {
    const watch = new ConnectNoDataWatch();
    // Sim time stands still while wall-clock time passes.
    for (let i = 0; i < 20; i++) {
      expect(watch.update({ simTime: 3, connected: true, interfaces: [silent()] })).toEqual([]);
    }
  });

  it('a sim reset starts the window over', () => {
    const watch = new ConnectNoDataWatch();
    watch.update({ simTime: 0, connected: true, interfaces: [silent()] });
    watch.update({ simTime: NO_DATA_WINDOW_S - 1, connected: true, interfaces: [silent()] });
    // simTime jumps back = reset.
    expect(watch.update({ simTime: 0, connected: true, interfaces: [silent()] })).toEqual([]);
    expect(watch.update({ simTime: NO_DATA_WINDOW_S - 1, connected: true, interfaces: [silent()] }))
      .toEqual([]);
    expect(watch.update({ simTime: NO_DATA_WINDOW_S, connected: true, interfaces: [silent()] }))
      .toHaveLength(1);
  });

  it('a disconnect drops the notice and every window with it', () => {
    const watch = new ConnectNoDataWatch();
    watch.update({ simTime: 0, connected: true, interfaces: [silent()] });
    expect(watch.update({ simTime: NO_DATA_WINDOW_S, connected: true, interfaces: [silent()] }))
      .toHaveLength(1);
    expect(watch.update({ simTime: NO_DATA_WINDOW_S, connected: false, interfaces: [silent()] }))
      .toEqual([]);
    // The reconnect observes from scratch.
    expect(watch.update({ simTime: NO_DATA_WINDOW_S, connected: true, interfaces: [silent()] }))
      .toEqual([]);
  });

  it('a worker that is not Connected is never judged', () => {
    const watch = new ConnectNoDataWatch();
    const connecting = silent({ status: 'Connecting' });
    watch.update({ simTime: 0, connected: true, interfaces: [connecting] });
    expect(watch.update({ simTime: NO_DATA_WINDOW_S * 3, connected: true, interfaces: [connecting] }))
      .toEqual([]);
  });

  it('a dismissal silences this interface and worker generation only', () => {
    const watch = new ConnectNoDataWatch();
    watch.update({ simTime: 0, connected: true, interfaces: [silent()] });
    expect(watch.update({ simTime: NO_DATA_WINDOW_S, connected: true, interfaces: [silent()] }))
      .toHaveLength(1);
    watch.dismiss('PLCSIM_1', 1);
    expect(watch.update({ simTime: NO_DATA_WINDOW_S * 2, connected: true, interfaces: [silent()] }))
      .toEqual([]);
    // The next worker generation asks again.
    watch.update({ simTime: NO_DATA_WINDOW_S * 2, connected: true, interfaces: [silent({ workerGeneration: 2 })] });
    expect(watch.update({
      simTime: NO_DATA_WINDOW_S * 4, connected: true, interfaces: [silent({ workerGeneration: 2 })],
    })).toHaveLength(1);
  });
});

// ── The notice and the way out of it ──────────────────────────────────

const SERVER = 'http://no-data.test:5100';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

interface NoticeGateway {
  readHealth: Record<string, unknown> | null;
}

function installGateway(gw: NoticeGateway): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.endsWith('/health')) return json({ status: 'ok', version: '6.3.47', build: 1 });
    if (url.endsWith('/interface-types')) return json({ types: [] });
    if (url.endsWith('/config/interfaces')) {
      return json([{ id: 'PLCSIM_1', type: 'PlcSimAdvanced', enabled: true, signals: [] }]);
    }
    if (new URL(url).pathname === '/status') {
      return json({ interfaces: [{
        id: 'PLCSIM_1', status: 'Connected', error: null,
        signalIssues: [{ signal: 'A', kind: 'AddressParseError', message: 'bad' }],
        configRevision: 'rev-abc', writesBlockedByGate: null, blockedSignals: null,
        readHealth: gw.readHealth,
      }] });
    }
    if (url.includes('/logs')) return json({ entries: [] });
    return new Response('', { status: 404 });
  }));
}

function makeViewer(lpm: LeftPanelManager, simTime: number): RVViewer {
  return {
    leftPanelManager: lpm,
    signalStore: null,
    loadTrust: { trusted: true },
    lastLoadResult: null,
    registry: null,
    modes: { activeMode: 'hmi' },
    selectionManager: undefined,
    simTime,
    signalBindingManager: undefined,
    getPlugin: () => undefined,
  } as unknown as RVViewer;
}

beforeEach(() => {
  localStorage.clear();
  _resetConnectStore();
  _resetUiContextStore();
  connectNoDataWatch.reset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  _resetConnectStore();
  connectNoDataWatch.reset();
  localStorage.clear();
});

describe('ConnectNoDataNotice (plan-562 §9.10)', () => {
  it('never appears for a worker that reports no read health', async () => {
    installGateway({ readHealth: null });
    setServerUrl(SERVER);
    await act(async () => { await connectToServer(); });
    await act(async () => { await fetchStatus(); });

    const viewer = makeViewer(new LeftPanelManager(), NO_DATA_WINDOW_S * 5);
    render(
      React.createElement(ThemeProvider, { theme: rvDarkTheme },
        React.createElement(ConnectNoDataNotice, { viewer })),
    );
    expect(screen.queryByTestId('connect-no-data-notice')).toBeNull();
  });

  it('with the panel closed: notice, then Open log opens the panel AND the log', async () => {
    installGateway({
      readHealth: {
        boundReadTags: 0, tagsWithValidValue: 0, progress: 0,
        workerGeneration: 1, progressIsPeriodic: true,
      },
    });
    setServerUrl(SERVER);
    await act(async () => { await connectToServer(); });
    await act(async () => { await fetchStatus(); });

    const lpm = new LeftPanelManager(); // nothing open
    const tree = (viewer: RVViewer) =>
      React.createElement(ThemeProvider, { theme: rvDarkTheme },
        React.createElement(RVViewerProvider, { value: viewer },
          React.createElement(ConnectNoDataNotice, { viewer }),
          React.createElement(ConnectPanel, null)));

    // The observation window opens at the first tick, so t = 0 is silent…
    const { rerender } = render(tree(makeViewer(lpm, 0)));
    expect(screen.queryByTestId('connect-no-data-notice')).toBeNull();

    // …and the verdict falls once the window has elapsed in SIM time.
    const later = makeViewer(lpm, NO_DATA_WINDOW_S);
    await act(async () => { rerender(tree(later)); });

    // Panel closed, notice up, reason and signal-issue count named.
    expect(screen.queryByText(/realvirtual CONNECT/)).toBeNull();
    expect(screen.getByText('Connected, but no PLC outputs received.')).toBeTruthy();
    expect(screen.getByText('PLCSIM_1 · no readable tags bound · 1 signal issue')).toBeTruthy();

    await act(async () => { screen.getByRole('button', { name: 'Open log' }).click(); });

    // Both halves: the panel is open and the log is visible inside it.
    expect(lpm.getSnapshot().activePanel).toBe('connect');
    await waitFor(() => expect(screen.getByText(/realvirtual CONNECT/)).toBeTruthy());
    // The log window itself, which only renders INSIDE an open panel.
    await waitFor(() => expect(screen.getByText('No log entries.')).toBeTruthy());
  });
});
