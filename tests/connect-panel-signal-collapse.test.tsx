// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import type { RVViewer } from '../src/core/rv-viewer';
import type { ConnectInterface, ConnectInterfaceSignal } from '../src/core/hmi/connect-store';
import { computeFilterAutoOpen, SignalListView } from '../src/core/hmi/ConnectPanel';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { RVViewerProvider } from '../src/hooks/use-viewer';

const viewerStub = {
  signalStore: null,
  registry: null,
  signalBindingManager: undefined,
} as unknown as RVViewer;

function signal(name: string, protocolAddress: string): ConnectInterfaceSignal {
  return {
    name,
    protocolAddress,
    type: 'PLCInputBool',
    record: false,
  };
}

function interfaceFixture(
  id: string,
  topics: ReadonlyArray<readonly [string, string]>,
): ConnectInterface {
  return {
    id,
    type: 'MQTT',
    enabled: true,
    signals: [],
    topics: topics.map(([topic, signalName], index) => ({
      topic,
      mode: 'ProcessImage',
      signals: [signal(signalName, `%I${index}.0`)],
    })),
  };
}

const iface = interfaceFixture('iface-collapse', [
  ['A', 'A_Signal'],
  ['B', 'B_Signal'],
]);

function seedFilter(ifaceId: string, text = ''): void {
  localStorage.setItem(`rv-connect-filter:${ifaceId}`, JSON.stringify({
    text,
    active: 'all',
    types: [],
    connected: 'all',
    binding: 'all',
    recorded: 'all',
  }));
}

function seedCollapsed(ifaceId: string, topics: string[]): void {
  localStorage.setItem(`rv-connect-collapsed:${ifaceId}`, JSON.stringify(topics));
}

function storedCollapsed(ifaceId: string): Set<string> {
  const raw = localStorage.getItem(`rv-connect-collapsed:${ifaceId}`);
  return new Set(raw ? JSON.parse(raw) as string[] : []);
}

function signalListTree(current: ConnectInterface, key = current.id) {
  return (
    <ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={viewerStub}>
        <div style={{ height: 400, display: 'flex', flexDirection: 'column' }}>
          <SignalListView
            key={key}
            iface={current}
            overLimitSignals={[]}
          />
        </div>
      </RVViewerProvider>
    </ThemeProvider>
  );
}

function renderSignalList(current: ConnectInterface = iface) {
  return render(signalListTree(current));
}

function topicRow(topic: string): HTMLElement {
  const label = screen.getByText(topic);
  const row = label.parentElement;
  if (!row) throw new Error(`Topic row '${topic}' has no parent`);
  return row;
}

function expectTopicIcon(topic: string, testId: 'ExpandLessIcon' | 'ExpandMoreIcon'): void {
  expect(within(topicRow(topic)).getByTestId(testId)).toBeTruthy();
}

async function openFilter(): Promise<HTMLInputElement> {
  fireEvent.click(screen.getByRole('button', { name: /Filter signals/ }));
  return screen.findByPlaceholderText('Filter signals...') as Promise<HTMLInputElement>;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('SignalListView topic collapse while filtering', () => {
  it('T1 collapses a filter-auto-open topic and shows the closed chevron', async () => {
    seedFilter(iface.id, 'A_Signal');
    renderSignalList();

    expect(await screen.findByText('A_Signal')).toBeTruthy();
    expectTopicIcon('A', 'ExpandLessIcon');

    fireEvent.click(topicRow('A'));

    await waitFor(() => {
      expect(screen.queryByText('A_Signal')).toBeNull();
      expectTopicIcon('A', 'ExpandMoreIcon');
    });
    expect(storedCollapsed(iface.id)).toEqual(new Set(['A']));
  });

  it('T2 re-expands during filtering and keeps the manual expansion after reset', async () => {
    seedFilter(iface.id, 'A_Signal');
    renderSignalList();

    await screen.findByText('A_Signal');
    fireEvent.click(topicRow('A'));
    await waitFor(() => expect(screen.queryByText('A_Signal')).toBeNull());

    fireEvent.click(topicRow('A'));
    expect(await screen.findByText('A_Signal')).toBeTruthy();
    expectTopicIcon('A', 'ExpandLessIcon');

    await openFilter();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));

    expect(await screen.findByText('A_Signal')).toBeTruthy();
    expectTopicIcon('A', 'ExpandLessIcon');
    expect(storedCollapsed(iface.id)).toEqual(new Set());
  });

  it('T3 restores the persisted state when the filter resets', async () => {
    seedCollapsed(iface.id, ['B']);
    renderSignalList();

    // Explicit pre-filter assertion: the persisted initial user state is A open, B closed.
    expect(await screen.findByText('A_Signal')).toBeTruthy();
    expect(screen.queryByText('B_Signal')).toBeNull();
    expectTopicIcon('A', 'ExpandLessIcon');
    expectTopicIcon('B', 'ExpandMoreIcon');

    const input = await openFilter();
    fireEvent.change(input, { target: { value: 'Signal' } });

    expect(await screen.findByText('B_Signal')).toBeTruthy();
    expectTopicIcon('B', 'ExpandLessIcon');
    expect(storedCollapsed(iface.id)).toEqual(new Set(['B']));

    fireEvent.click(topicRow('A'));
    await waitFor(() => expect(screen.queryByText('A_Signal')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));

    await waitFor(() => {
      expect(screen.queryByText('A_Signal')).toBeNull();
      expect(screen.queryByText('B_Signal')).toBeNull();
      expectTopicIcon('A', 'ExpandMoreIcon');
      expectTopicIcon('B', 'ExpandMoreIcon');
    });
    expect(storedCollapsed(iface.id)).toEqual(new Set(['B', 'A']));
  });

  it('T4 re-opens matching topics after a deliberate criteria change', async () => {
    seedFilter(iface.id, 'A_Signal');
    renderSignalList();

    await screen.findByText('A_Signal');
    fireEvent.click(topicRow('A'));
    await waitFor(() => expect(screen.queryByText('A_Signal')).toBeNull());

    const input = await openFilter();
    fireEvent.change(input, { target: { value: 'Signal' } });

    expect(await screen.findByText('A_Signal')).toBeTruthy();
    expect(await screen.findByText('B_Signal')).toBeTruthy();
    expectTopicIcon('A', 'ExpandLessIcon');
  });

  it('T5 isolates filter and collapse seeds across an interface switch', async () => {
    const ifaceA = interfaceFixture('iface-A', [['A1', 'A1_Signal']]);
    const ifaceB = interfaceFixture('iface-B', [['B1', 'B1_Signal']]);
    seedFilter(ifaceA.id, 'A1_Signal');
    seedCollapsed(ifaceA.id, ['A1']);
    seedFilter(ifaceB.id);
    seedCollapsed(ifaceB.id, ['B1']);

    const view = render(signalListTree(ifaceA));
    expect(await screen.findByText('A1_Signal')).toBeTruthy();
    expectTopicIcon('A1', 'ExpandLessIcon');
    expect(storedCollapsed(ifaceA.id)).toEqual(new Set(['A1']));

    view.rerender(signalListTree(ifaceB));

    await screen.findByText('B1');
    expect(screen.queryByText('A1')).toBeNull();
    expect(screen.queryByText('B1_Signal')).toBeNull();
    expectTopicIcon('B1', 'ExpandMoreIcon');
    expect(storedCollapsed(ifaceA.id)).toEqual(new Set(['A1']));
    expect(storedCollapsed(ifaceB.id)).toEqual(new Set(['B1']));
  });

  it('T6 preserves only manual collapse changes across a reload simulation', async () => {
    seedCollapsed(iface.id, ['B']);
    const firstMount = renderSignalList();

    const input = await openFilter();
    fireEvent.change(input, { target: { value: 'Signal' } });
    expect(await screen.findByText('B_Signal')).toBeTruthy();
    expect(storedCollapsed(iface.id)).toEqual(new Set(['B']));

    fireEvent.click(topicRow('A'));
    await waitFor(() => expect(screen.queryByText('A_Signal')).toBeNull());
    fireEvent.click(topicRow('B'));
    await waitFor(() => expect(screen.queryByText('B_Signal')).toBeNull());
    fireEvent.click(topicRow('B'));
    expect(await screen.findByText('B_Signal')).toBeTruthy();
    expect(storedCollapsed(iface.id)).toEqual(new Set(['A']));

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(screen.queryByText('A_Signal')).toBeNull());
    expect(await screen.findByText('B_Signal')).toBeTruthy();

    firstMount.unmount();
    renderSignalList();

    await screen.findByText('B_Signal');
    expect(screen.queryByText('A_Signal')).toBeNull();
    expectTopicIcon('A', 'ExpandMoreIcon');
    expectTopicIcon('B', 'ExpandLessIcon');
    expect(storedCollapsed(iface.id)).toEqual(new Set(['A']));
  });

  it('T7 keeps manually removed topics closed across identical filter ticks', () => {
    const prevMatches = new Set(['A', 'B']);
    const currentMatches = new Set(['A', 'B']);
    const afterManualCollapse = new Set(['B']);

    const firstTick = computeFilterAutoOpen(
      afterManualCollapse,
      prevMatches,
      currentMatches,
      false,
    );
    const secondTick = computeFilterAutoOpen(firstTick, currentMatches, currentMatches, false);

    expect(firstTick).toBe(afterManualCollapse);
    expect(secondTick).toBe(firstTick);
    expect(secondTick).toEqual(new Set(['B']));
  });

  it('T8 opens only newly matching topics and prunes stale matches on a filter tick', () => {
    const existing = new Set(['Z']);
    const prevMatches = new Set(['Y', 'Z']);
    const currentMatches = new Set(['X', 'Y']);

    const next = computeFilterAutoOpen(existing, prevMatches, currentMatches, false);

    expect(next).toEqual(new Set(['X']));
    expect(next.has('Y')).toBe(false);
    expect(next.has('Z')).toBe(false);
  });
});
