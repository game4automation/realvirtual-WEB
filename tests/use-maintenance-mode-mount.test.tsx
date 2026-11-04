// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-522 Phase 5 regression: a component that mounts AFTER the guide started
 * (the MessagePanel swaps to the MaintenancePanel on the very
 * `maintenance-mode-changed` event that starts it) must start from the
 * plugin's current state — before the fix it sat in IDLE and the dialog never
 * appeared.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import { useMaintenanceMode } from '../src/hooks/use-maintenance-mode';
import type { RVViewer } from '../src/core/rv-viewer';

afterEach(cleanup);

function Probe() {
  const s = useMaintenanceMode();
  return <div data-testid="mode">{s.mode}</div>;
}

function viewerWith(plugin: unknown): RVViewer {
  return {
    getPlugin: (id: string) => (id === 'maintenance' ? plugin : undefined),
    on: () => () => {},
  } as unknown as RVViewer;
}

describe('useMaintenanceMode — mount during a running guide', () => {
  it('starts from the plugin state, not IDLE', () => {
    const plugin = { getState: () => ({ mode: 'dialog', procedure: null, currentStep: 0, stepResults: [], isCameraAnimating: false, isLive: false, renderModeLocked: false }) };
    render(<RVViewerProvider value={viewerWith(plugin)}><Probe /></RVViewerProvider>);
    expect(screen.getByTestId('mode').textContent).toBe('dialog');
  });

  it('falls back to IDLE without a maintenance plugin', () => {
    render(<RVViewerProvider value={viewerWith(undefined)}><Probe /></RVViewerProvider>);
    expect(screen.getByTestId('mode').textContent).toBe('idle');
  });
});
