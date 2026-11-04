// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2024 Phase 3 (plan-589 residual) — `ConnectAutoMapSection` and `MappedBadge` in Chromium.
 *
 * The badge colour rule (neutral without a report, green when nothing needs attention, amber when
 * something does) and the strip: badge numbers, Check, the Create button with its creatable count,
 * and the category lists.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.setConfig({ hookTimeout: 60_000, testTimeout: 30_000 });
import type { ReactNode } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { userEvent } from 'vitest/browser';
import { ThemeProvider } from '@mui/material/styles';
import type { RVViewer } from '../../src/core/rv-viewer';
import { rvDarkTheme } from '../../src/core/hmi/theme';
import { RVViewerProvider } from '../../src/hooks/use-viewer';
import { MappedBadge } from '../../src/core/hmi/MappedBadge';
import { ConnectAutoMapSection } from '../../src/core/hmi/ConnectAutoMapSection';
import { ISA_AMBER, ISA_GREEN } from '../../src/core/hmi/isa-colors';
import {
  _resetConnectStore, fetchInterfaces, fetchInterfaceTypes, getConnectSnapshot, reconcileInterfaces, setServerUrl,
  type ConnectInterface, type ConnectSignalSchema,
} from '../../src/core/hmi/connect-store';
import { collectModelPlcSignals, type ModelPlcSignal } from '../../src/core/import/rv-plc-automap';

const IFACE = {
  id: 's7-cell1', type: 'S7', enabled: true,
  signals: [
    { name: 'Cell.Start', type: 'PLCOutputBool', protocolAddress: 'DB10.DBX4.1', record: false },
    { name: 'Cell.Ghost', type: 'PLCInputBool', protocolAddress: 'DB10.DBX4.2', record: false },
  ],
} as unknown as ConnectInterface;
const MODEL: ModelPlcSignal[] = [
  { name: 'Cell.Start', localName: 'Cell.Start', type: 'PLCOutputBool', path: 'Root/Start' },
  { name: 'Cell.Orphan', localName: 'Cell.Orphan', type: 'PLCInputBool', path: 'Root/Orphan' },
];

/** The viewer members the strip touches: a registry answering `collectModelPlcSignals`. */
const viewer = {
  registry: {
    getAll<T>(type: string): { path: string; instance: T }[] {
      return MODEL.filter((m) => m.type === type)
        .map((m) => ({ path: m.path as string, instance: { signalName: m.name } as unknown as T }));
    },
    getNode(path: string) {
      const sig = MODEL.find((m) => m.path === path);
      return sig
        ? { name: path.slice(path.lastIndexOf('/') + 1), userData: { realvirtual: { [sig.type]: { Name: sig.localName } } } }
        : null;
    },
  },
  selectionManager: { getSnapshot: () => ({ primaryPath: null, selectedPaths: [] }) },
} as unknown as RVViewer;

const wrap = (ui: ReactNode) => render(
  <ThemeProvider theme={rvDarkTheme}><RVViewerProvider value={viewer}>{ui}</RVViewerProvider></ThemeProvider>,
);

function borderOf(el: HTMLElement): string { return getComputedStyle(el).borderTopColor; }
/** A CSS colour as the browser computes it, so hex and rgb() spellings compare equal. */
function colourOf(css: string): string {
  const probe = document.createElement('i');
  probe.style.color = css;
  document.body.appendChild(probe);
  const out = getComputedStyle(probe).color;
  probe.remove();
  return out;
}

describe('MappedBadge', () => {
  afterEach(cleanup);

  it('is neutral without a report, green without problems, amber with problems', () => {
    wrap(<>
      <MappedBadge data-testid="none" mapped={0} total={0} problems={0} hasReport={false} />
      <MappedBadge data-testid="ok" mapped={3} total={3} problems={0} />
      <MappedBadge data-testid="warn" mapped={2} total={3} problems={1} />
    </>);
    expect(screen.getByTestId('none').textContent).toBe('0 / 0');
    expect(screen.getByTestId('ok').textContent).toBe('3 / 3');
    expect(borderOf(screen.getByTestId('ok'))).toBe(colourOf(ISA_GREEN));
    expect(borderOf(screen.getByTestId('warn'))).toBe(colourOf(ISA_AMBER));
    expect(borderOf(screen.getByTestId('none'))).not.toBe(colourOf(ISA_GREEN));
    expect(borderOf(screen.getByTestId('none'))).not.toBe(colourOf(ISA_AMBER));
  });
});

/** Signal schema rows as `/interface-types` reports them: discovery on S7 / TwinCAT, not on FANUC. */
const schemaOf = (supportsDiscovery: boolean): ConnectSignalSchema => ({
  supportsDiscovery, supportsManualAdd: true, addressValidatable: false, directionFromAddress: false,
  addressLabel: 'Address', addressHint: '', addressExamples: [], dataTypes: [],
});
const TYPES = [
  { type: 'S7', label: 'S7', description: '', defaults: {}, signals: schemaOf(true) },
  { type: 'TwinCat', label: 'TwinCAT', description: '', defaults: {}, signals: schemaOf(true) },
  { type: 'Fanuc', label: 'FANUC', description: '', defaults: {}, signals: schemaOf(false) },
];

describe('ConnectAutoMapSection', () => {
  beforeEach(async () => {
    _resetConnectStore();
    setServerUrl('http://gw.test:5100');
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = typeof url === 'string' ? url : url.toString();
      const body = u.includes('/config/interfaces') ? [IFACE] : u.includes('/interface-types') ? { types: TYPES } : {};
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    });
    await fetchInterfaces();
    await fetchInterfaceTypes();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    _resetConnectStore();
  });

  it('shows a neutral badge before any report, then the numbers after Check', async () => {
    wrap(<ConnectAutoMapSection iface={IFACE} />);
    expect(screen.getByTestId('reconcile-badge').textContent).toBe('0 / 0');

    await act(async () => { await userEvent.click(screen.getByRole('button', { name: 'Check' })); });
    expect(getConnectSnapshot().reconcileReports?.['s7-cell1']).toBeTruthy();
    // Rows: Start (mapped), Ghost (plc-only), Orphan (missing-in-plc).
    expect(screen.getByTestId('reconcile-badge').textContent).toBe('1 / 3');
    expect(borderOf(screen.getByTestId('reconcile-badge'))).toBe(colourOf(ISA_AMBER));
  });

  it('offers Create model signals with the creatable count and lists the categories', async () => {
    reconcileInterfaces(collectModelPlcSignals(viewer), ['s7-cell1']);
    wrap(<ConnectAutoMapSection iface={IFACE} />);
    expect(await screen.findByRole('button', { name: /Create model signals \(1\)/ })).toBeTruthy();
    expect(screen.getByText('Mapped')).toBeTruthy();
    expect(screen.getByText('Interface only (not in the model)')).toBeTruthy();
    expect(screen.getByText('Missing on the interface')).toBeTruthy();

    await act(async () => { await userEvent.click(screen.getByText('Interface only (not in the model)')); });
    expect(await screen.findByText(/Cell\.Ghost/)).toBeTruthy();
  });

  // plan-2025 §9: Fill (capability) and the legacy seed (S7 / PLCSIM migration) are separate, per type.
  it.each([
    ['S7', true, true],
    ['TwinCat', true, false],
    ['Fanuc', false, false],
  ])('%s: Fill offered = %s, Adopt legacy = %s; Import always', (type, fill, legacy) => {
    const iface = { ...IFACE, id: `x-${type}`, type } as unknown as ConnectInterface;
    const { container } = wrap(<ConnectAutoMapSection iface={iface} />);
    expect(!!container.querySelector('[data-testid="connect-fill-addresses"]')).toBe(fill);
    expect(!!container.querySelector('[data-testid="connect-legacy-adopt"]')).toBe(legacy);
    expect(container.querySelector('[data-testid="connect-import-address-table"]')).not.toBeNull();
    // The legacy action lives on its own line, never in the address-sources line.
    const sources = container.querySelector('[data-testid="connect-address-sources"]')!;
    expect(sources.textContent).not.toMatch(/Adopt legacy addresses/);
  });

  it('renders nothing for a model-managed (FMI) interface', () => {
    const fmu = { ...IFACE, id: 'fmu', type: 'FMI' } as unknown as ConnectInterface;
    const { container } = wrap(<ConnectAutoMapSection iface={fmu} />);
    expect(container.querySelector('[data-testid="connect-automap"]')).toBeNull();
  });
});
