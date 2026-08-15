// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-352 §9.2 — the derived MQTT topic tree in the CONNECT signal list.
 *
 * Single-topic MQTT signals live in the interface's FLAT `signals[]` array and used to render as a
 * headerless block glued under the last ProcessImage group. They now render as a tree derived from
 * their topic addresses, while configured topic entries (ProcessImage AND Single) and every other
 * protocol keep their previous single-level rendering.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import type { RVViewer } from '../src/core/rv-viewer';
import type { ConnectInterface, ConnectInterfaceSignal } from '../src/core/hmi/connect-store';
import { connectToServer, _resetConnectStore } from '../src/core/hmi/connect-store';
import { SignalListView } from '../src/core/hmi/ConnectPanel';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import { findSignalRowLabel, getSignalRowLabel, querySignalRowLabel } from './helpers/signal-row-label';

const viewerStub = {
  signalStore: null,
  registry: null,
  signalBindingManager: undefined,
} as unknown as RVViewer;

function signal(name: string, protocolAddress: string, type = 'PLCOutputBool'): ConnectInterfaceSignal {
  return { name, protocolAddress, type, record: false };
}

/** MQTT interface whose single topics form rv > demo > in|out. */
function mqttFlatFixture(id = 'mqtt-tree'): ConnectInterface {
  return {
    id,
    type: 'MQTT',
    enabled: true,
    signals: [
      signal('OpenDoor', 'rv/demo/out/OpenDoor'),
      signal('Machining', 'rv/demo/out/Machining'),
      signal('OnSwitch', 'rv/demo/in/OnSwitch'),
    ],
  };
}

function signalListTree(current: ConnectInterface, key = current.id) {
  return (
    <ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={viewerStub}>
        <div style={{ height: 400, display: 'flex', flexDirection: 'column' }}>
          <SignalListView key={key} iface={current} overLimitSignals={[]} />
        </div>
      </RVViewerProvider>
    </ThemeProvider>
  );
}

function renderSignalList(current: ConnectInterface) {
  return render(signalListTree(current));
}

/** Row element carrying the depth marker for a rendered label. */
function rowOf(label: string): HTMLElement {
  // Signal leaves print their name twice (row label + chip) since plan-422 F4,
  // so a bare getByText is ambiguous for them; topic NODES have only the one
  // label and no `title`, so they still come from getByText.
  const el = querySignalRowLabel(label) ?? screen.getByText(label);
  let node: HTMLElement | null = el;
  while (node && !node.hasAttribute('data-rv-depth')) node = node.parentElement;
  if (!node) throw new Error(`No depth-carrying row for '${label}'`);
  return node;
}

function depthOf(label: string): number {
  return Number(rowOf(label).getAttribute('data-rv-depth'));
}

function seedCollapsed(ifaceId: string, keys: string[]): void {
  localStorage.setItem(`rv-connect-collapsed:${ifaceId}`, JSON.stringify(keys));
}

function storedCollapsed(ifaceId: string): string[] {
  const raw = localStorage.getItem(`rv-connect-collapsed:${ifaceId}`);
  return raw ? JSON.parse(raw) as string[] : [];
}

async function openFilter(): Promise<HTMLInputElement> {
  fireEvent.click(screen.getByRole('button', { name: /Filter signals/ }));
  return screen.findByPlaceholderText('Filter signals...') as Promise<HTMLInputElement>;
}

beforeEach(() => {
  localStorage.clear();
  _resetConnectStore();
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  _resetConnectStore();
});

describe('SignalListView MQTT topic tree', () => {
  it('rendersTreeNodes_withDepthIndentation', async () => {
    renderSignalList(mqttFlatFixture());

    // Every topic level is its own row — no single-child compression.
    expect(await screen.findByText('rv')).toBeTruthy();
    expect(screen.getByText('demo')).toBeTruthy();
    expect(screen.getByText('in')).toBeTruthy();
    expect(screen.getByText('out')).toBeTruthy();

    // Nodes AND leaves are indented by their level (F1/F5 of the review: leaves carry depth too).
    expect(depthOf('rv')).toBe(0);
    expect(depthOf('demo')).toBe(1);
    expect(depthOf('out')).toBe(2);
    expect(depthOf('OpenDoor')).toBe(3);

    // Subtree counters.
    expect(within(rowOf('rv')).getByText('3')).toBeTruthy();
    expect(within(rowOf('out')).getByText('2')).toBeTruthy();
    expect(within(rowOf('in')).getByText('1')).toBeTruthy();
  });

  it('collapses a single level without touching its siblings', async () => {
    renderSignalList(mqttFlatFixture());
    await findSignalRowLabel('OpenDoor');

    fireEvent.click(rowOf('out'));

    await waitFor(() => {
      expect(querySignalRowLabel('OpenDoor')).toBeNull();
      expect(querySignalRowLabel('Machining')).toBeNull();
    });
    // The sibling branch stays open, and so do the levels above.
    expect(getSignalRowLabel('OnSwitch')).toBeTruthy();
    expect(screen.getByText('out')).toBeTruthy();
  });

  it('mqttTopicConfigSingle_staysSingleLevelGroup', async () => {
    const iface: ConnectInterface = {
      id: 'mqtt-single',
      type: 'MQTT',
      enabled: true,
      signals: [],
      topics: [{
        topic: 'rv/cmd/start',
        mode: 'Single',
        signals: [signal('Start', 'rv/cmd/start', 'PLCInputBool')],
      }],
    };
    renderSignalList(iface);

    // The whole topic string is ONE group row — the tree never applies to topic entries (F5).
    expect(await findSignalRowLabel('Start')).toBeTruthy();
    expect(screen.getAllByText('rv/cmd/start').length).toBeGreaterThan(0);
    expect(screen.queryByText('cmd')).toBeNull();
    // Topic groups carry no tree depth — nothing was split into levels.
    expect(document.querySelectorAll('[data-rv-depth]')).toHaveLength(0);
  });

  it('processImageTopic_staysSingleLevelGroup', async () => {
    const iface: ConnectInterface = {
      id: 'mqtt-pi',
      type: 'MQTT',
      enabled: true,
      signals: [],
      topics: [{
        topic: 'Data_Q_1',
        mode: 'ProcessImage',
        signals: [signal('Q1', '%Q0.0'), signal('Q2', '%Q0.1')],
      }],
    };
    renderSignalList(iface);

    // Unchanged single-level group row: label + total, no tree depth.
    // Data_Q_1 is the ProcessImage TOPIC group row, not a signal row.
    const group = (await screen.findByText('Data_Q_1')).parentElement!;
    expect(within(group).getByText('2')).toBeTruthy();
    expect(getSignalRowLabel('Q1')).toBeTruthy();
    expect(document.querySelectorAll('[data-rv-depth]')).toHaveLength(0);
  });

  it('s7Interface_rendersFlatUnchanged', async () => {
    const iface: ConnectInterface = {
      id: 's7-1',
      type: 'S7',
      enabled: true,
      signals: [signal('Merker', 'M0.1'), signal('Out', '%Q0.1')],
    };
    renderSignalList(iface);

    expect(await findSignalRowLabel('Merker')).toBeTruthy();
    expect(getSignalRowLabel('Out')).toBeTruthy();
    // No tree node exists, so no row carries a depth marker.
    expect(document.querySelectorAll('[data-rv-depth]')).toHaveLength(0);
  });

  it('filter_opensAllAncestorsOfMatchingLeaf', async () => {
    // Everything collapsed: without ancestor auto-open a hit deep in the tree stays invisible.
    seedCollapsed('mqtt-tree', ['tree:rv', 'tree:rv/demo', 'tree:rv/demo/out', 'tree:rv/demo/in']);
    renderSignalList(mqttFlatFixture());

    await screen.findByText('rv');
    expect(querySignalRowLabel('OpenDoor')).toBeNull();

    const input = await openFilter();
    fireEvent.change(input, { target: { value: 'OpenDoor' } });

    expect(await findSignalRowLabel('OpenDoor')).toBeTruthy();
    expect(screen.getByText('demo')).toBeTruthy();
    expect(screen.getByText('out')).toBeTruthy();
  });

  it('filter_prunesEmptyBranches', async () => {
    renderSignalList(mqttFlatFixture());
    await findSignalRowLabel('OpenDoor');

    const input = await openFilter();
    fireEvent.change(input, { target: { value: 'OnSwitch' } });

    expect(await findSignalRowLabel('OnSwitch')).toBeTruthy();
    await waitFor(() => {
      // The whole out/ branch disappears — no empty node is left behind.
      expect(screen.queryByText('out')).toBeNull();
      expect(querySignalRowLabel('OpenDoor')).toBeNull();
    });
    expect(screen.getByText('in')).toBeTruthy();
  });

  it('collapseState_survivesRemount_ignoresLegacyKeys', async () => {
    // A legacy (untyped) key must NOT collapse the tree node of the same name.
    seedCollapsed('mqtt-tree', ['rv']);
    const first = renderSignalList(mqttFlatFixture());
    expect(await findSignalRowLabel('OpenDoor')).toBeTruthy();

    fireEvent.click(rowOf('demo'));
    await waitFor(() => expect(querySignalRowLabel('OpenDoor')).toBeNull());
    // Persisted with its type prefix, next to the untouched legacy topic key.
    expect(storedCollapsed('mqtt-tree')).toContain('tree:rv/demo');
    expect(storedCollapsed('mqtt-tree')).toContain('rv');

    first.unmount();
    renderSignalList(mqttFlatFixture());

    expect(await screen.findByText('demo')).toBeTruthy();
    expect(querySignalRowLabel('OpenDoor')).toBeNull();  // collapse survived the remount
    expect(screen.getByText('rv')).toBeTruthy();        // the legacy key did not collapse `rv`
  });

  it('editAction_availableForTreeLeaf', async () => {
    // The tree leaves ARE the flat signals, so the manual edit/delete actions stay available.
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const json = (body: unknown) => Promise.resolve(new Response(
        JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      if (urlStr.includes('/health')) return json({ status: 'ok' });
      if (urlStr.includes('/interface-types')) {
        return json({
          types: [{
            type: 'MQTT', label: 'MQTT', description: '', defaults: {},
            signals: {
              supportsDiscovery: true, supportsManualAdd: true, addressValidatable: true,
              directionFromAddress: false, addressLabel: 'Topic', addressHint: '',
              addressExamples: [], dataTypes: ['Bool', 'Int', 'Float', 'String'],
            },
          }],
        });
      }
      return json([]);
    });
    await connectToServer();

    renderSignalList(mqttFlatFixture());
    await findSignalRowLabel('OpenDoor');

    expect(screen.getByRole('button', { name: "Edit signal 'OpenDoor'" })).toBeTruthy();
    expect(screen.getByRole('button', { name: "Delete signal 'OpenDoor'" })).toBeTruthy();
  });
});
