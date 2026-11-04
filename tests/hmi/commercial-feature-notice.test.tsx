// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2211 G5 / S9 — the core "Experiments" buttons (DES toolbar + side tools): without an
 * experiment window opener they show `CommercialFeatureNotice` with the demo and editions
 * links (Escape closes it); with a registered opener the click goes to the opener and no
 * notice appears.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import type { ReactNode } from 'react';
import { rvDarkTheme } from '../../src/core/hmi/theme';
import type { RVViewer } from '../../src/core/rv-viewer';
import {
  CommercialFeatureNotice, COMMERCIAL_DEMO_URL, COMMERCIAL_EDITIONS_URL,
} from '../../src/core/hmi/CommercialFeatureNotice';
import {
  DesExperimentsSideButton, DesExperimentsToolbarButton, DesExperimentWindowHost,
} from '../../src/plugins/sim-controller/DesExperimentsButton';
import { registerDesExperimentWindowProvider, type DesExperimentWindowProvider } from '../../src/core/hmi/des-experiment-window';

const viewer = { simulationKernel: { desControl: () => ({}) }, on: () => () => {} } as unknown as RVViewer;
const wrap = (node: ReactNode) => render(<ThemeProvider theme={rvDarkTheme}>{node}</ThemeProvider>);
afterEach(() => cleanup());

function expectNotice(): void {
  const notice = screen.getByTestId('commercial-feature-notice');
  expect(notice.textContent).toContain('Experiment Manager — available in realvirtual Commercial');
  const demo = screen.getByTestId('commercial-feature-demo') as HTMLAnchorElement;
  const editions = screen.getByTestId('commercial-feature-editions') as HTMLAnchorElement;
  expect(demo.href).toBe(COMMERCIAL_DEMO_URL);
  expect(editions.href).toBe(COMMERCIAL_EDITIONS_URL);
  for (const link of [demo, editions]) {
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener');
  }
}

describe('Experiments button without the experiment manager', () => {
  it.each([
    ['toolbar', 'des-runs-open', () => <DesExperimentsToolbarButton viewer={viewer} />],
    ['side tools', 'des-side-experiments', () => <DesExperimentsSideButton viewer={viewer} />],
  ] as const)('%s: opens the commercial notice, Escape closes it', async (_name, testId, Button) => {
    wrap(<Button />);
    expect(screen.queryByTestId('commercial-feature-notice')).toBeNull();
    fireEvent.click(screen.getByTestId(testId));
    expectNotice();
    fireEvent.keyDown(screen.getByTestId('commercial-feature-notice'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('commercial-feature-notice')).toBeNull());
  });

  it('the Close button closes the notice; the window host renders nothing', async () => {
    wrap(<><DesExperimentsToolbarButton viewer={viewer} /><DesExperimentWindowHost viewer={viewer} /></>);
    fireEvent.click(screen.getByTestId('des-runs-open'));
    fireEvent.click(screen.getByTestId('commercial-feature-close'));
    await waitFor(() => expect(screen.queryByTestId('commercial-feature-notice')).toBeNull());
  });

  it('takes custom links', () => {
    wrap(<CommercialFeatureNotice open onClose={() => {}} feature="X" summary="Y" demoUrl="https://example.com/d" editionsUrl="https://example.com/e" />);
    expect((screen.getByTestId('commercial-feature-demo') as HTMLAnchorElement).href).toBe('https://example.com/d');
    expect((screen.getByTestId('commercial-feature-editions') as HTMLAnchorElement).href).toBe('https://example.com/e');
  });
});

describe('Experiments button with a registered opener', () => {
  it('opens the provider (toolbar + side tools), shows its state and host, no notice', () => {
    let state = { open: false };
    const listeners = new Set<() => void>();
    const provider: DesExperimentWindowProvider = {
      toggle: vi.fn(() => { state = { open: !state.open }; for (const fn of listeners) fn(); }),
      subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; },
      getState: () => state,
      Host: () => <div data-testid="experiment-window">{state.open ? 'open' : 'closed'}</div>,
    };
    const off = registerDesExperimentWindowProvider(provider);
    try {
      wrap(<><DesExperimentsToolbarButton viewer={viewer} /><DesExperimentsSideButton viewer={viewer} />
        <DesExperimentWindowHost viewer={viewer} /></>);
      fireEvent.click(screen.getByTestId('des-runs-open'));
      expect(provider.toggle).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByTestId('des-side-experiments'));
      expect(provider.toggle).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId('commercial-feature-notice')).toBeNull();
      expect(screen.getByTestId('experiment-window')).toBeTruthy();
    } finally { off(); }
  });

  it('a provider that unregisters brings the notice back', () => {
    const closed = { open: false };
    const provider: DesExperimentWindowProvider = { toggle: vi.fn(), subscribe: () => () => {}, getState: () => closed };
    const off = registerDesExperimentWindowProvider(provider);
    wrap(<DesExperimentsToolbarButton viewer={viewer} />);
    act(() => off());
    fireEvent.click(screen.getByTestId('des-runs-open'));
    expect(provider.toggle).not.toHaveBeenCalled();
    expectNotice();
  });
});
