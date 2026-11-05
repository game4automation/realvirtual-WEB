// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { ErrorStore } from '../src/core/engine/rv-error-store';
import { WebErrorPanel } from '../src/plugins/web-error-plugin';
import { MessagePanel } from '../src/core/hmi/MessagePanel';
import type { RVViewer } from '../src/core/rv-viewer';
import { __resetCollisionAlertStore, publishCollisionAlert, type CollisionPairView } from '../src/core/hmi/collision-alert-store';
import { __resetDropAlertStore, publishDropAlert, type DropAlertView } from '../src/core/hmi/drop-alert-store';

vi.mock('../src/hooks/use-slot', () => ({ useSlot: () => [
  { pluginId: 'web-error', component: WebErrorPanel },
  { pluginId: 'ordinary-message', component: () => <div>Ordinary message</div> },
  { pluginId: 'collision-alert', component: () => <div>Collision card</div> },
  { pluginId: 'drop-alert', component: () => <div>Drop card</div> },
] }));
vi.mock('../src/hooks/use-mobile-layout', () => ({ useMobileLayout: () => false }));
vi.mock('../src/hooks/use-viewport-insets', () => ({ useViewportInsets: () => ({ top: 0 }) }));
vi.mock('../src/hooks/use-maintenance-mode', () => ({ useMaintenanceMode: () => ({ mode: 'idle' }) }));
afterEach(() => { cleanup(); __resetCollisionAlertStore(); __resetDropAlertStore(); });

describe('alarms in working modes', () => {
  it('shows active alarms with ordinary messages hidden, and removes the panel on recovery', () => {
    const errorStore = new ErrorStore();
    const viewer = { errorStore } as RVViewer;
    const { container } = render(<ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={viewer}><MessagePanel alarmsOnly /></RVViewerProvider>
    </ThemeProvider>);
    expect(container.querySelector('[data-ui-panel]')).toBeNull();
    act(() => errorStore.setActive('Line/Ribbon', true, 'Ribbon: web is slack'));
    expect(screen.getByText('Ribbon: web is slack')).toBeTruthy();
    expect(screen.queryByText('Ordinary message')).toBeNull();
    act(() => errorStore.remove('Line/Ribbon'));
    expect(screen.queryByText('Ribbon: web is slack')).toBeNull();
    expect(container.querySelector('[data-ui-panel]')).toBeNull();
  });

  it('shows collision and unsupported-part cards in every mode, without ordinary messages', () => {
    const viewer = { errorStore: new ErrorStore() } as RVViewer;
    const { container } = render(<ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={viewer}><MessagePanel alarmsOnly /></RVViewerProvider>
    </ThemeProvider>);
    expect(container.querySelector('[data-ui-panel]')).toBeNull();

    act(() => publishCollisionAlert([{ aPath: 'Belt', bPath: 'Gripper' } as unknown as CollisionPairView]));
    expect(screen.getByText('Collision card')).toBeTruthy();
    expect(screen.queryByText('Ordinary message')).toBeNull();
    act(() => publishCollisionAlert([]));
    expect(container.querySelector('[data-ui-panel]')).toBeNull();

    act(() => publishDropAlert([{ muKey: 'Box' } as unknown as DropAlertView]));
    expect(screen.getByText('Drop card')).toBeTruthy();
    expect(screen.queryByText('Ordinary message')).toBeNull();
    act(() => publishDropAlert([]));
    expect(container.querySelector('[data-ui-panel]')).toBeNull();
  });
});
