// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import type { RVViewer } from '../../src/core/rv-viewer';
import type { SimDesControl } from '../../src/core/material-flow/simulation-kernel';
import { computeDesRunState } from '../../src/core/material-flow/rv-des-run-state';
import { rvDarkTheme } from '../../src/core/hmi/theme';
import { RVViewerProvider } from '../../src/hooks/use-viewer';
import { DESControllerToolbar } from '../../src/plugins/sim-controller/DESControllerToolbar';
import { isDesStatsWindowOpen, setDesStatsWindowOpen } from '../../src/plugins/sim-controller/des-stats-window-store';

function fixture() {
  const stats = { currentTime: 10, processed: 10, pending: 1, nextEventTime: 20 };
  // One mutable control feeds BOTH components through the real shared snapshot store.
  const control = {
    subMode: 'animated' as const, multiplier: 1, simTime: 10,
    endTime: 86400, lifecycleGeneration: 1,
    runComplete: null as SimDesControl['runComplete'],
    eventStats: () => stats,
    setSubMode: () => {}, setMultiplier: () => {}, step: () => false,
  } satisfies SimDesControl;
  const viewer = {
    simulationKernel: {
      mode: 'des', isSwitching: false,
      hasDesRunner: () => true, desControl: () => control,
    },
    isSimulationPaused: false, simulationPauseReasons: [],
    registry: null, signalStore: null,
    on: () => () => {}, emit: () => {}, getPlugin: () => undefined,
  } as unknown as RVViewer;
  const mount = () => render(
    <ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={viewer}>
        <DESControllerToolbar viewer={viewer} />
      </RVViewerProvider>
    </ThemeProvider>,
  );
  const finish = (time = 86399.2, reason: NonNullable<SimDesControl['runComplete']>['reason'] = 'duration-reached') => {
    control.runComplete = { reason, simTime: time };
    stats.currentTime = time;
  };
  return { control, stats, viewer, mount, finish };
}

// Advance the production 200 ms interval; no mocked hook or store test seam.
async function poll() {
  await act(async () => { vi.advanceTimersByTime(200); });
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setDesStatsWindowOpen(false);
});

describe('DES run completion UI (chip only, no bottom notice)', () => {
  it('uses the canonical end time, explains itself in the tooltip, and opens statistics', async () => {
    const f = fixture();
    f.mount();
    expect(screen.queryByTestId('des-run-state')).toBeNull();
    f.finish();
    await poll();

    const status = computeDesRunState(f.control, {
      simulationPaused: f.viewer.isSimulationPaused,
      pauseReasons: f.viewer.simulationPauseReasons,
    });
    expect(status.runState).toBe('finished');
    expect(status.finishedAt).toBe(86399.2);
    const chip = screen.getByTestId('des-run-state');
    expect(chip.textContent).toBe('Run finished · 24:00:00');
    expect(chip.getAttribute('aria-label')).toBe(
      'End time 24:00:00 reached, not blocked. Press Play to continue; Reset starts again.',
    );
    // The former one-time bottom notice is gone for good.
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(chip);
    expect(isDesStatsWindowOpen()).toBe(true);
    await poll();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('withdraws on reset, restore and continue (longer end), then shows the new end', async () => {
    const f = fixture();
    f.mount();
    f.finish();
    await poll();
    f.control.runComplete = null;
    f.control.lifecycleGeneration++;
    f.stats.currentTime = 100;
    await poll();
    expect(screen.queryByTestId('des-run-state')).toBeNull();
    f.finish();
    await poll();
    expect(screen.getByTestId('des-run-state')).toBeTruthy();

    // Play-continue: end doubles, completion is withdrawn, then finishes at the new end.
    f.control.endTime = 172800;
    f.control.runComplete = null;
    await poll();
    expect(screen.queryByTestId('des-run-state')).toBeNull();
    f.finish(172799.5);
    await poll();
    expect(screen.getByTestId('des-run-state').textContent).toBe('Run finished · 48:00:00');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('distinguishes stalled and queue-drained completions', async () => {
    const f = fixture();
    f.mount();
    f.finish(49330.4, 'queue-empty-before-end');
    await poll();
    const chip = screen.getByTestId('des-run-state');
    expect(chip.textContent).toBe('No more events · 13:42:10');
    expect(chip.getAttribute('aria-label')).toBe(
      'No more events at 13:42:10, before the end time. Reset to run again.',
    );
    f.control.runComplete = null;
    f.control.endTime = Infinity;
    await poll();
    f.finish(49331.6, 'queue-drained');
    await poll();
    expect(screen.getByTestId('des-run-state').textContent).toBe('Run finished · 13:42:12');
    expect(screen.getByTestId('des-run-state').getAttribute('aria-label')).toBe(
      'No more events at 13:42:12, the run is complete. Reset to run again.',
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the chip when mounted or remounted already finished', async () => {
    const f = fixture();
    f.finish();
    const mounted = f.mount();
    await poll();
    expect(screen.getByTestId('des-run-state').textContent).toBe('Run finished · 24:00:00');
    mounted.unmount();
    f.mount();
    await poll();
    expect(screen.getByTestId('des-run-state')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
