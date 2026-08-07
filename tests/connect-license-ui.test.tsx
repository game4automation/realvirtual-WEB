// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import connectPanelSource from '../src/core/hmi/ConnectPanel.tsx?raw';
import connectStoreSource from '../src/core/hmi/connect-store.ts?raw';
import connectionsSectionSource from '../src/core/hmi/rv-connections-section.tsx?raw';
import {
  ConnectDownloadLinks,
  ConnectOpener,
  SignalBudgetIndicator,
  SignalLimitNotice,
  interfaceDotColor,
  interfaceStatusShort,
  signalBudgetGate,
  signalBudgetPresentation,
} from '../src/core/hmi/ConnectPanel';
import { isConnectDataStale, statusAge } from '../src/core/hmi/connect-staleness';
import connectPluginSource from '../src/plugins/connect-plugin.tsx?raw';
import {
  CONNECT_BETA_DOWNLOAD_URL,
  CONNECT_STABLE_DOWNLOAD_URL,
  __resetConnectDownloadsForTest,
  __setConnectDownloadsForTest,
} from '../src/core/hmi/connect-downloads';
import { humanizeConnectError, humanizeConnectWorkerStatus } from '../src/core/hmi/connect-store';
import type { LicenseStatus } from '../src/core/hmi/license-store';
import { ISA_AMBER } from '../src/core/hmi/isa-colors';
import { rvDarkTheme } from '../src/core/hmi/theme';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  __resetConnectDownloadsForTest();
});

function themed(node: React.ReactNode) {
  return <ThemeProvider theme={rvDarkTheme}>{node}</ThemeProvider>;
}

function licenseStatus(patch: Partial<LicenseStatus> = {}): LicenseStatus {
  return {
    state: 'LicensedCommunity',
    gatewayAllowed: true,
    maxSignals: 20,
    admittedSignals: 17,
    effectiveNow: '2026-07-19T12:00:00Z',
    licenseType: 'community',
    licenseId: null,
    error: null,
    overLimitSignals: [],
    registration: null,
    ...patch,
  };
}

describe('CONNECT license gate UI integration', () => {
  it('shows a finite signal budget and marks 80 percent or more as warning', () => {
    const status = licenseStatus();
    expect(signalBudgetPresentation(status)).toMatchObject({
      label: 'Signals 17 / 20',
      warning: true,
    });
    render(themed(<SignalBudgetIndicator status={status} />));
    expect(screen.getByText('Signals 17 / 20')).toBeTruthy();
  });

  it('hides the unlimited sentinel without rendering a grace chip', () => {
    const status = licenseStatus({
      maxSignals: 2_147_483_647,
    });
    expect(signalBudgetPresentation(status)).toBeNull();
    render(themed(<SignalBudgetIndicator status={status} />));
    expect(screen.queryByText(/Signals/)).toBeNull();
    expect(screen.queryByText(/Grace until/)).toBeNull();
  });

  it('maps backend codes and worker statuses to actionable operator copy', () => {
    expect(humanizeConnectError('LICENSE_REQUIRED')).toBe(
      'This gateway needs a license before it serves signals - open License in the CONNECT panel.',
    );
    expect(humanizeConnectError('SIGNAL_LIMIT_REACHED', {
      limit: 20,
      admittedSignals: 20,
    })).toBe('Signal limit reached (20 of 20 in use) - upgrade or remove signals.');
    expect(humanizeConnectWorkerStatus('SignalLimitExceeded')).toBe('Signal limit');
  });

  it('names the real numbers when a rejected bind reports how many signals it asked for', () => {
    // The reproducing case: 27 selected against an empty 20-signal budget. Admission is
    // all-or-nothing, so nothing was bound — the copy has to say how far over the request was.
    expect(humanizeConnectError('SIGNAL_LIMIT_REACHED', {
      limit: 20,
      admittedSignals: 0,
      requestedSignals: 27,
    })).toBe('Signal limit reached: 27 new signals selected, only 20 of 20 free'
      + ' - upgrade the license or select fewer.');
    // `rejected` carries the same count and stands in when requestedSignals is absent.
    expect(humanizeConnectError('SIGNAL_LIMIT_REACHED', {
      limit: 20,
      admittedSignals: 18,
      rejected: ['A', 'B', 'C'],
    })).toBe('Signal limit reached: 3 new signals selected, only 2 of 20 free'
      + ' - upgrade the license or select fewer.');
  });

  it('gates a discovery bind against the free budget before it is sent', () => {
    const status = licenseStatus({ maxSignals: 20, admittedSignals: 0 });
    const selected = Array.from({ length: 27 }, (_, i) => `Sig${i}`);
    expect(signalBudgetGate(status, selected, new Set())).toEqual({
      newSignals: 27, free: 20, overBudget: true, limit: 20,
    });

    // Already-configured names are already admitted — re-selecting them must not consume a slot,
    // otherwise re-adding a bound signal would disable the button for no reason.
    const configured = new Set(selected.slice(0, 10));
    expect(signalBudgetGate(status, selected, configured)).toMatchObject({
      newSignals: 17, overBudget: false,
    });

    // Exactly filling the budget still fits; one more does not.
    expect(signalBudgetGate(status, selected.slice(0, 20), new Set()).overBudget).toBe(false);
    expect(signalBudgetGate(status, selected.slice(0, 21), new Set()).overBudget).toBe(true);
  });

  it('gates nothing when the budget is unknown or unlimited', () => {
    const selected = ['A', 'B', 'C'];
    // No license status yet (gateway not reached) — never block on a guess.
    expect(signalBudgetGate(null, selected, new Set()))
      .toEqual({ newSignals: 3, free: null, overBudget: false, limit: null });
    // The unlimited sentinel must not leak into the UI as a number.
    expect(signalBudgetGate(licenseStatus({ maxSignals: 2_147_483_647, admittedSignals: 5 }),
      selected, new Set())).toEqual({ newSignals: 3, free: null, overBudget: false, limit: null });
  });

  it('shows SignalLimitExceeded as a short informational notice without dumping signal names', () => {
    expect(interfaceStatusShort('SignalLimitExceeded', true)).toBe('Signal limit');
    expect(interfaceDotColor('SignalLimitExceeded', true)).toBe(ISA_AMBER);
    render(themed(<SignalLimitNotice signals={['Cell.Start', 'Cell.Stop']} limit={20} />));
    expect(screen.getByText(
      'Only the first 20 signals are served - 2 more are configured. Activate a license to serve all signals.',
    )).toBeTruthy();
    expect(screen.queryByText(/Cell\.Start/)).toBeNull();
  });

  it('provides downloads and explains both disconnected setup paths without a red alarm', () => {
    render(themed(<ConnectDownloadLinks />));
    expect(screen.getByRole('link', { name: 'Download realvirtual CONNECT' }).getAttribute('href'))
      .toBe(CONNECT_STABLE_DOWNLOAD_URL);
    expect(CONNECT_BETA_DOWNLOAD_URL).toBeNull();
    expect(screen.queryByRole('link', { name: 'beta' })).toBeNull();
    expect(connectStoreSource).toContain(
      'No gateway answered at ${serverUrl}. Start realvirtual CONNECT on that machine, then connect again.',
    );
    expect(connectPanelSource).toContain("snap.errorMessage.startsWith('No gateway answered at ')");
  });

  it('shows the stable version in the download button and no beta link when no beta build exists', () => {
    __setConnectDownloadsForTest({
      stable: { url: CONNECT_STABLE_DOWNLOAD_URL, version: '0.2.0', build: 24, buildDate: '2026-07-22' },
      beta: null,
      loaded: true,
    });
    render(themed(<ConnectDownloadLinks />));
    expect(screen.getByRole('link', { name: 'Download realvirtual CONNECT 0.2.0' }).getAttribute('href'))
      .toBe(CONNECT_STABLE_DOWNLOAD_URL);
    expect(screen.queryByRole('link', { name: /beta/ })).toBeNull();
  });

  it('reveals a versioned beta download only when a beta manifest resolves', () => {
    __setConnectDownloadsForTest({
      stable: { url: CONNECT_STABLE_DOWNLOAD_URL, version: '0.2.0', build: 24, buildDate: '2026-07-22' },
      beta: { url: 'https://web.realvirtual.io/download/realvirtual-Connect-beta.exe', version: '0.3.0', build: 31, buildDate: '2026-07-23' },
      loaded: true,
    });
    render(themed(<ConnectOpener failedUrl={null} />));
    expect(screen.getByRole('link', { name: 'Download realvirtual CONNECT 0.2.0' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'beta 0.3.0' }).getAttribute('href'))
      .toBe('https://web.realvirtual.io/download/realvirtual-Connect-beta.exe');
  });

  it('renders the acquisition opener as an offer, not a fault', () => {
    render(themed(<ConnectOpener failedUrl="http://localhost:5100" />));
    // Value proposition + the one primary CTA (Download), Connect stays secondary.
    expect(screen.getByText('Live PLC data in this viewer')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Download realvirtual CONNECT' }).getAttribute('href'))
      .toBe(CONNECT_STABLE_DOWNLOAD_URL);
    expect(screen.getByText('Already installed? Start CONNECT on that machine, then press Connect.')).toBeTruthy();
    // Capability rows fill the formerly empty space (Thomas: signals, VIBN, real PLCs).
    expect(screen.getByText('Live signals')).toBeTruthy();
    expect(screen.getByText('Virtual commissioning')).toBeTruthy();
    expect(screen.getByText('Real controllers')).toBeTruthy();
    // Technical cause stays a quiet mono line, without the http:// noise.
    expect(screen.getByText('no gateway at localhost:5100')).toBeTruthy();
    // Free tier is stated once, as a fact - never a plea ("for free" x2 was the old copy).
    expect(screen.getByText(/The free tier includes 20 PLC signals\./)).toBeTruthy();
    // Never-linked shows the neutral opener path, not the amber/red error path.
    expect(connectPanelSource).toContain("label: 'Not connected'");
    expect(connectPanelSource).toContain('snap.errorMessage && !gatewaySetupNeeded');
  });

  it('omits the failed-url line before any connect attempt', () => {
    render(themed(<ConnectOpener failedUrl={null} />));
    expect(screen.getByText('Live PLC data in this viewer')).toBeTruthy();
    expect(screen.queryByText(/no gateway at/)).toBeNull();
  });

  it('flags stale data only for errors or an unreachable gateway', () => {
    expect(isConnectDataStale({ state: 'error', gatewayUnreachable: false, lastStatusUpdate: 0 }, true)).toBe(true);
    expect(isConnectDataStale({ state: 'connected', gatewayUnreachable: true, lastStatusUpdate: 0 }, true)).toBe(true);
    expect(isConnectDataStale({ state: 'disconnected', gatewayUnreachable: false, lastStatusUpdate: 0 }, true)).toBe(false);
    expect(isConnectDataStale({ state: 'connecting', gatewayUnreachable: false, lastStatusUpdate: 0 }, true)).toBe(false);
  });

  it('uses the shared status age format after one minute', () => {
    expect(statusAge(Date.parse('2026-07-19T12:00:00Z'), Date.parse('2026-07-19T12:00:34Z'))).toBe('34s');
    expect(statusAge(Date.parse('2026-07-19T12:00:00Z'), Date.parse('2026-07-19T12:10:00Z'))).toBe('10m 0s');
  });

  it('surfaces lost live data only as the amber dot on the CONNECT icon (no global banner)', () => {
    expect(connectPluginSource).toContain('isConnectDataStale');
    expect(connectPluginSource).toContain("bgcolor: isStale ? ISA_AMBER : '#66bb6a'");
    expect(connectPluginSource).toContain("'CONNECT - live data lost'");
  });

  it('keeps connection states tokenized, labeled, accessible, and at the 11px type floor', () => {
    expect(connectionsSectionSource).not.toMatch(/#66bb6a|#ef5350|#4fc3f7/i);
    expect(connectionsSectionSource).toContain("' · Unresolved'");
    expect(connectionsSectionSource).toContain('aria-label="Remove connection"');
    expect(connectionsSectionSource).toContain('role="button"');
    expect(connectionsSectionSource).toContain('tabIndex={0}');
    expect(connectionsSectionSource).toContain('aria-expanded={open}');
    expect(connectionsSectionSource).toContain("event.key !== 'Enter' && event.key !== ' '");
    expect(connectionsSectionSource).not.toMatch(/fontSize:\s*(?:8(?:\.5)?|9|10)\b/);
  });
});
