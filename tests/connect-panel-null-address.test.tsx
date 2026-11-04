// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2022 Phase 0 §9.2 — regression for a field report ("grey panels, only 3D visible").
 *
 * `GET /config/interfaces` delivered a signal with `"protocolAddress": null`. `SignalRowItem`
 * called `.length` on it, the row threw, and with no boundary at the root the whole HMI was
 * unmounted. Now the store normalises the payload AND the panel guards its own accesses, so the
 * row renders and the HMI root stays mounted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import type { RVViewer } from '../src/core/rv-viewer';
import type { ConnectInterface } from '../src/core/hmi/connect-store';
import {
  _resetConnectStore,
  fetchInterfaces,
  getConnectSnapshot,
  normalizeConnectInterface,
} from '../src/core/hmi/connect-store';
import { SignalListView } from '../src/core/hmi/ConnectPanel';
import { RootErrorBoundary } from '../src/core/hmi/RootErrorBoundary';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import { findSignalRowLabel } from './helpers/signal-row-label';

const viewerStub = {
  signalStore: null,
  registry: null,
  signalBindingManager: undefined,
} as unknown as RVViewer;

/** The wire payload as the gateway sent it — nulls where the type promises strings. */
function nullPayload(type: 'S7' | 'MQTT'): ConnectInterface {
  return {
    id: `${type.toLowerCase()}-null`,
    type,
    enabled: true,
    signals: [
      { name: 'NullAddress', protocolAddress: null, type: 'PLCOutputBool', dataType: null, comment: null, record: false },
      { name: 'Normal', protocolAddress: 'DB1.DBX0.0', type: 'PLCInputBool', record: false },
      // A slash address next to the null one: activates the derived MQTT topic tree.
      { name: 'MotorState', protocolAddress: 'plant/motor/state', type: 'PLCInputBool', record: false },
    ],
  } as unknown as ConnectInterface;
}

function stubInterfaces(payload: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })));
}

function renderInRoot(iface: ConnectInterface): HTMLElement {
  const root = document.createElement('div');
  root.id = 'react-root';
  document.body.appendChild(root);
  render(
    <RootErrorBoundary>
      <ThemeProvider theme={rvDarkTheme}>
        <RVViewerProvider value={viewerStub}>
          <div style={{ height: 400, display: 'flex', flexDirection: 'column' }}>
            <SignalListView iface={iface} overLimitSignals={[]} />
          </div>
        </RVViewerProvider>
      </ThemeProvider>
    </RootErrorBoundary>,
    { container: root },
  );
  return root;
}

let consoleError: { mock: { calls: unknown[][] }; mockRestore: () => void };

beforeEach(() => {
  localStorage.clear();
  _resetConnectStore();
  vi.unstubAllGlobals();
  consoleError = vi.spyOn(console, 'error') as unknown as typeof consoleError;
});

afterEach(() => {
  cleanup();
  document.getElementById('react-root')?.remove();
  vi.unstubAllGlobals();
  _resetConnectStore();
  localStorage.clear();
  consoleError.mockRestore();
});

describe('CONNECT signal rows with null strings', () => {
  it('fetchInterfaces normalises null signal strings to empty strings', async () => {
    stubInterfaces([nullPayload('S7')]);
    await fetchInterfaces();

    const [iface] = getConnectSnapshot().interfaces;
    const sig = iface.signals[0];
    expect(sig.protocolAddress).toBe('');
    expect(sig.dataType).toBe('');
    expect(sig.comment).toBe('');
    expect(sig.name).toBe('NullAddress');
    // Untouched fields keep their values; absent optional fields stay absent.
    expect(iface.signals[1].protocolAddress).toBe('DB1.DBX0.0');
    expect('dataType' in iface.signals[1]).toBe(false);
  });

  it('normalises topic signals and a null signal list too', () => {
    const out = normalizeConnectInterface({
      id: 'mqtt-pi', type: 'MQTT', enabled: true, signals: null,
      topics: [{ topic: 'pi', mode: 'ProcessImage', signals: [{ name: 'T', protocolAddress: null, type: null, record: false }] }],
    } as unknown as ConnectInterface);
    expect(out.signals).toEqual([]);
    expect(out.topics?.[0].signals?.[0]).toMatchObject({ name: 'T', protocolAddress: '', type: '' });
  });

  it('a fetched null address renders its row and keeps the HMI root mounted', async () => {
    stubInterfaces([nullPayload('S7')]);
    await fetchInterfaces();
    const root = renderInRoot(getConnectSnapshot().interfaces[0]);

    expect(await findSignalRowLabel('NullAddress')).toBeTruthy();
    expect(await findSignalRowLabel('Normal')).toBeTruthy();
    expect(screen.queryByTestId('root-error-card')).toBeNull();
    expect(root.childElementCount).toBeGreaterThan(0);
    expect(consoleError.mock.calls.some(c => c[0] === '[RootErrorBoundary]')).toBe(false);
  });

  it('the panel survives an UN-normalised null address on its own (S7 flat list and MQTT tree)', async () => {
    for (const type of ['S7', 'MQTT'] as const) {
      const root = renderInRoot(nullPayload(type));
      expect(await findSignalRowLabel('NullAddress')).toBeTruthy();
      if (type === 'MQTT') {
        // The slash address switched the tree on: its top node renders next to the null-address row.
        expect(await screen.findByText('plant')).toBeTruthy();
        expect(root.querySelector('[data-rv-depth="0"]')).not.toBeNull();
      }
      expect(screen.queryByTestId('root-error-card')).toBeNull();
      expect(root.childElementCount).toBeGreaterThan(0);
      cleanup();
      root.remove();
    }
  });

  it('a null topic entry is dropped and both interfaces reach the store', async () => {
    stubInterfaces([
      nullPayload('S7'),
      {
        id: 'mqtt-topics', type: 'MQTT', enabled: true, signals: [],
        topics: [null, { topic: 'a', mode: 'ProcessImage', signals: [{ name: 'T', protocolAddress: null, type: 'PLCInputBool', record: false }] }],
      },
    ]);
    await fetchInterfaces();

    const { interfaces } = getConnectSnapshot();
    expect(interfaces).toHaveLength(2);
    const mqtt = interfaces[1];
    expect(mqtt.topics).toHaveLength(1);
    expect(mqtt.topics?.[0].topic).toBe('a');
    expect(mqtt.topics?.[0].signals?.[0].protocolAddress).toBe('');
  });

  it('the text filter does not throw on a null address', async () => {
    renderInRoot(nullPayload('S7'));
    await findSignalRowLabel('NullAddress');
    fireEvent.click(screen.getByRole('button', { name: /Filter signals/ }));
    const input = await screen.findByPlaceholderText('Filter signals...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'normal' } });
    expect(await findSignalRowLabel('Normal')).toBeTruthy();
    expect(screen.queryByTestId('root-error-card')).toBeNull();
  });
});
