// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-343 Phase 3 — the update surface in the CONNECT settings window.
 *
 * T25: an older gateway that does not send `updateSupported` shows no update surface at all.
 * T26: the ConnectPanel stays completely free of update polling — its "no background work while
 *      closed" contract (plan-344) is not softened by this feature.
 *
 * Plus the layout rules of section 3.2 that are worth pinning down: a beta is offered but never
 * emphasised, a running beta keeps the way back to stable visible, and a structurally impossible
 * update is silent except for the two causes the operator can actually remove.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, act } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { ConnectUpdateSection, buildUpdateRows } from '../src/core/hmi/ConnectUpdateSection';
import {
  connectUpdateStore,
  __resetConnectUpdateStore,
  __setConnectUpdateTimings,
  type ConnectUpdateSnapshot,
  type UpdateChannelOffer,
} from '../src/core/hmi/connect-update-store';
import { ConnectPanel } from '../src/core/hmi/ConnectPanel';
import { connectToServer, setServerUrl } from '../src/core/hmi/connect-store';
import { LeftPanelManager } from '../src/core/hmi/left-panel-manager';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import type { RVViewer } from '../src/core/rv-viewer';

const SERVER = 'http://update-ui.test:5100';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function offer(partial: Partial<UpdateChannelOffer> & { semver: string; channel: string }): UpdateChannelOffer {
  return {
    candidate: {
      channel: partial.channel,
      semver: partial.semver,
      build: 31,
      sha256: 'a'.repeat(64),
      url: `https://web.realvirtual.io/download/versions/connect-${partial.semver}.exe`,
    },
    buildDate: '2026-07-31',
    sizeBytes: 25_000_000,
    isNewer: partial.isNewer ?? false,
    isDowngrade: partial.isDowngrade ?? false,
    isCurrent: partial.isCurrent ?? false,
    isChannelSwitch: partial.isChannelSwitch ?? false,
  };
}

function renderSection() {
  return render(
    <ThemeProvider theme={rvDarkTheme}>
      <ConnectUpdateSection />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  __resetConnectUpdateStore();
  __setConnectUpdateTimings({ idlePollMs: 20, activePollMs: 10 });
  setServerUrl(SERVER);
});

afterEach(() => {
  cleanup();
  __resetConnectUpdateStore();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

// ── T25 ─────────────────────────────────────────────────────────────────────

describe('T25 — an older gateway shows no update surface', () => {
  it('renders nothing and never asks for /update/status when /health omits updateSupported', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      calls.push(url);
      // An older gateway: /health answers, but knows nothing of updates.
      if (url.endsWith('/health')) return json({ status: 'ok', version: '0.1.0', build: 9 });
      return new Response('', { status: 404 });
    }));

    const { container } = renderSection();
    await waitFor(() => expect(connectUpdateStore.getSnapshot().gateway).toBe('unsupported'));
    await act(async () => { await new Promise((r) => setTimeout(r, 60)); });

    expect(container.textContent).toBe('');
    // The status endpoint is never even probed on a gateway that cannot have it.
    expect(calls.filter((u) => u.includes('/update/'))).toEqual([]);
  });
});

// ── T26 ─────────────────────────────────────────────────────────────────────

describe('T26 — the ConnectPanel stays free of update polling', () => {
  it('issues no /update request at all, open or closed', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      calls.push(url);
      if (url.endsWith('/health')) return json({ status: 'ok', version: '0.2.0', build: 25, updateSupported: true });
      if (url.endsWith('/config/interfaces')) return json([]);
      if (url.endsWith('/interface-types')) return json({ types: [] });
      if (url.includes('/status')) return json({ interfaces: [] });
      return new Response('', { status: 404 });
    }));

    await act(async () => { await connectToServer(); });

    const lpm = new LeftPanelManager();
    const viewer = {
      leftPanelManager: lpm,
      signalStore: null,
      registry: null,
      signalBindingManager: undefined,
      getPlugin: () => undefined,
    } as unknown as RVViewer;

    render(
      <ThemeProvider theme={rvDarkTheme}>
        <RVViewerProvider value={viewer}>
          <ConnectPanel />
        </RVViewerProvider>
      </ThemeProvider>,
    );

    // Closed…
    await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
    expect(calls.filter((u) => u.includes('/update/'))).toEqual([]);

    // …and open. The update surface lives in the settings window, not here.
    await act(async () => {
      lpm.open('connect', 360);
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(calls.filter((u) => u.includes('/update/'))).toEqual([]);
    // The panel is doing its own work, so this is not a silently dead stub.
    expect(calls.some((u) => u.includes('/status'))).toBe(true);
  });
});

// ── Layout rules of section 3.2 ─────────────────────────────────────────────

describe('the offer rows follow section 3.2', () => {
  function snapshotWith(partial: Partial<ConnectUpdateSnapshot>): ConnectUpdateSnapshot {
    return {
      ...connectUpdateStore.getSnapshot(),
      gateway: 'supported',
      supported: true,
      current: { semver: '0.2.0', channel: 'stable', build: 25 },
      ...partial,
    };
  }

  it('offers a newer stable as the only emphasised row, and a beta without emphasis', () => {
    const rows = buildUpdateRows(snapshotWith({
      channels: {
        stable: offer({ channel: 'stable', semver: '0.3.0', isNewer: true }),
        beta: offer({ channel: 'beta', semver: '0.4.0-beta2', isNewer: true, isChannelSwitch: true }),
      },
    }));

    expect(rows.map((r) => [r.label, r.action, r.emphasis])).toEqual([
      ['Stable 0.3.0 available', 'Download', true],
      ['Beta 0.4.0-beta2', 'Download', false],
    ]);
  });

  it('shows the way back to stable while a beta is running, never as a proposal', () => {
    const rows = buildUpdateRows(snapshotWith({
      current: { semver: '0.4.0-beta2', channel: 'beta', build: 40 },
      channels: {
        stable: offer({ channel: 'stable', semver: '0.3.0', isDowngrade: true, isChannelSwitch: true }),
        beta: offer({ channel: 'beta', semver: '0.4.0-beta2', isCurrent: true }),
      },
    }));

    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('Back to Stable 0.3.0');
    expect(rows[0].action).toBe('Download');
    expect(rows[0].emphasis).toBe(false);
  });

  it('offers nothing when the running build is the newest in its channel', () => {
    const rows = buildUpdateRows(snapshotWith({
      channels: { stable: offer({ channel: 'stable', semver: '0.2.0', isCurrent: true }) },
    }));
    expect(rows).toEqual([]);
  });
});

describe('a failed attempt keeps both its reason and the still-standing offer', () => {
  it('shows the failure sentence next to the Update row when the gateway re-offers the build', async () => {
    // The gateway flips a FINISHED job back to `available` so a failed attempt cannot permanently
    // hide a build that is still on offer — the reason then travels in `jobReason`, not in `state`.
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.endsWith('/health')) {
        return json({ status: 'ok', updateSupported: true, release: { semver: '0.2.0', channel: 'stable', build: 25 } });
      }
      if (url.endsWith('/update/status')) {
        return json({
          updateSupported: true,
          reason: null,
          current: { semver: '0.2.0', channel: 'stable', build: 25 },
          selectedChannel: 'stable',
          state: 'available',
          jobReason: 'health-timeout',
          progress: null,
          pinWillChange: false,
          pinPath: null,
          channels: { stable: offer({ channel: 'stable', semver: '0.3.0', isNewer: true }) },
        });
      }
      return new Response('', { status: 404 });
    }));

    renderSection();

    // Both, not one or the other: what went wrong, and the offer to try again.
    await screen.findByText(/did not start/i);
    await screen.findByText('Stable 0.3.0 available');
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy();
  });
});

describe('a structurally impossible update is silent except where the operator can act', () => {
  it('prints one sentence for no-api-key and nothing for not-supported', async () => {
    // no-api-key: the operator can fix this, so it is explained.
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.endsWith('/health')) return json({ status: 'ok', updateSupported: false, release: { semver: '0.2.0', channel: 'stable', build: 25 } });
      if (url.endsWith('/update/status')) {
        return json({
          updateSupported: false, reason: 'no-api-key',
          current: { semver: '0.2.0', channel: 'stable', build: 25 },
          selectedChannel: 'stable', state: 'idle', jobReason: null, progress: null,
          pinWillChange: false, pinPath: null, channels: {},
        });
      }
      return new Response('', { status: 404 });
    }));

    renderSection();
    await screen.findByText(/API key must be set/i);
    cleanup();

    // not-supported: nothing the operator can do, so the surface stays empty.
    __resetConnectUpdateStore();
    __setConnectUpdateTimings({ idlePollMs: 20, activePollMs: 10 });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.endsWith('/health')) return json({ status: 'ok', updateSupported: false, release: { semver: '0.2.0', channel: 'stable', build: 25 } });
      if (url.endsWith('/update/status')) {
        return json({
          updateSupported: false, reason: 'not-supported',
          current: { semver: '0.2.0', channel: 'stable', build: 25 },
          selectedChannel: 'stable', state: 'idle', jobReason: null, progress: null,
          pinWillChange: false, pinPath: null, channels: {},
        });
      }
      return new Response('', { status: 404 });
    }));

    const { container } = renderSection();
    await waitFor(() => expect(connectUpdateStore.getSnapshot().reason).toBe('not-supported'));
    await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
    expect(container.textContent).toBe('');
  });
});
