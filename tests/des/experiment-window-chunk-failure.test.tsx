// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2211 NF2 / R2-9 (G5): the core "Experiments" button with a registered window opener
 * whose window chunk fails to load. The failure is reported on the button, stays retryable,
 * and DES keeps running (FastForward and Reset) — the opener is only ever asked on click.
 */
import { expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import type { ComponentType } from 'react';
import { rvDarkTheme } from '../../src/core/hmi/theme';
import type { RVViewer } from '../../src/core/rv-viewer';
import { createLazyWindowLoader } from '../../src/core/hmi/lazy-window-loader';
import { DesExperimentsToolbarButton, DesExperimentWindowHost } from '../../src/plugins/sim-controller/DesExperimentsButton';
import { registerDesExperimentWindowProvider, type DesExperimentWindowProvider, type DesExperimentWindowState } from '../../src/core/hmi/des-experiment-window';
import { lineFixture } from './runner-fixture';

/** An opener shaped like the commercial one: lazy window chunk, error state on failure. */
function chunkOpener(load: () => Promise<ComponentType>): DesExperimentWindowProvider {
  const open = createLazyWindowLoader(load);
  const listeners = new Set<() => void>();
  let state: DesExperimentWindowState = { open: false };
  let Window: ComponentType | null = null;
  const set = (next: DesExperimentWindowState) => { state = next; for (const fn of [...listeners]) fn(); };
  return {
    toggle() {
      if (Window) { set({ open: !state.open }); return; }
      open().then(w => { Window = w; set({ open: true }); })
        .catch(() => set({ open: false, error: 'Experiment Matrix could not be loaded. Click to retry.' }));
    },
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    getState: () => state,
    Host: () => (Window && state.open ? <Window /> : null),
  };
}

it('a rejected window import is reported on the button, retryable, and leaves DES usable', async () => {
  const load = vi.fn<() => Promise<ComponentType>>()
    .mockRejectedValueOnce(new Error('chunk unavailable'))
    .mockResolvedValue(() => <div data-testid="experiment-window">matrix</div>);
  const off = registerDesExperimentWindowProvider(chunkOpener(load));
  const { runner, manager } = lineFixture({ experiments: false });
  const viewer = { simulationKernel: { desControl: () => runner }, on: () => () => {} } as unknown as RVViewer;
  try {
    render(<ThemeProvider theme={rvDarkTheme}>
      <DesExperimentsToolbarButton viewer={viewer} /><DesExperimentWindowHost viewer={viewer} />
    </ThemeProvider>);
    // DES starts and runs without the window ever being requested.
    manager.duration = 10;
    expect(await runner.runFastForward()).toBe(true);
    expect(load).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('des-runs-open'));
    expect((await screen.findByRole('alert')).textContent).toContain('could not be loaded');
    expect(screen.queryByTestId('experiment-window')).toBeNull();
    expect(screen.queryByTestId('commercial-feature-notice')).toBeNull();

    // DES is untouched by the failed chunk.
    runner.reset(); manager.duration = 20;
    expect(await runner.runFastForward()).toBe(true);

    // Retry: the loader does not cache the failure.
    fireEvent.click(screen.getByTestId('des-runs-open'));
    expect(await screen.findByTestId('experiment-window')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(load).toHaveBeenCalledTimes(2);
  } finally { off(); cleanup(); runner.dispose(); }
});
