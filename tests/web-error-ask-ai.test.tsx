// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import { EventEmitter } from '../src/core/rv-events';
import type { ViewerEvents } from '../src/core/rv-viewer-events';
import type { RVViewer } from '../src/core/rv-viewer';
import { ErrorStore } from '../src/core/engine/rv-error-store';
import { WebErrorPanel } from '../src/plugins/web-error-plugin';
import { registerSearchDiagnoseProvider } from '../src/plugins/diagnose/search-diagnose-registry';

let unregister: (() => void) | undefined;

afterEach(() => {
  cleanup();
  unregister?.();
  unregister = undefined;
});

function makeViewer() {
  const errorStore = new ErrorStore();
  errorStore.setActive('Line/Drive', true, 'Motor overload');
  const events = new EventEmitter<ViewerEvents>();
  const node = {
    userData: {
      realvirtual: { Drive: { TargetSpeed: 250 } },
      _rvPdfLinks: [{ source: { url: '/docs/motor.pdf#page=7' } }],
    },
    parent: null,
  };
  const ribbonNode = { ...node };
  const viewer = {
    errorStore,
    highlighter: { flash: vi.fn() },
    fitToNodes: vi.fn(),
    selectionManager: { getSnapshot: () => ({ primaryPath: null }) },
    registry: {
      getNode: (path: string) => path === 'Line/Drive' ? node : path === 'Line/Ribbon' ? ribbonNode : null,
      getComponentTypes: () => ['Drive'],
    },
    signalStore: null,
    emit: (event: string, payload: unknown) => events.emit(event, payload),
    highlightByPath: () => {},
    clearHighlight: () => {},
    focusByPath: () => {},
    filterDrives: () => {},
    outlineManager: {
      getStyle: () => ({}), setStyle: () => {}, setOutlined: () => {}, clear: () => {},
    },
  } as unknown as RVViewer;
  return { viewer, events };
}

function renderPanel(viewer: RVViewer) {
  return render(
    <ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={viewer}>
        <WebErrorPanel viewer={viewer} />
      </RVViewerProvider>
    </ThemeProvider>,
  );
}

describe('WebErrorPanel Ask AI', () => {
  it('renders the action only while a search diagnosis provider is registered', async () => {
    const { viewer } = makeViewer();
    renderPanel(viewer);
    expect(screen.queryByRole('button', { name: /ask ai/i })).toBeNull();

    unregister = registerSearchDiagnoseProvider({
      diagnose: async () => ({ cause: '', remedy: '', sources: [] }),
    });
    expect(await screen.findByRole('button', { name: /ask ai/i })).toBeTruthy();
  });

  it('emits the typed diagnose-request contract with node context', () => {
    const { viewer, events } = makeViewer();
    const received: ViewerEvents['diagnose-request'][] = [];
    events.on('diagnose-request', (event) => received.push(event));
    unregister = registerSearchDiagnoseProvider({
      diagnose: async () => ({ cause: '', remedy: '', sources: [] }),
    });
    renderPanel(viewer);

    fireEvent.click(screen.getByRole('button', { name: /ask ai/i }));

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      nodePath: 'Line/Drive',
      label: 'Motor overload',
      source: 'web-error',
      docHints: ['docs/motor.pdf'],
    });
    expect(received[0].machineContext).toContain('Drive: TargetSpeed=250');
  });
});

describe('alarm card focus', () => {
  it('shows separate cards and focuses from the body and the focus icon with multiple alarms', () => {
    const { viewer } = makeViewer();
    viewer.errorStore.setActive('Line/Ribbon', true, 'Fabric torn');
    renderPanel(viewer);
    const first = screen.getByText('Motor overload').closest('.MuiPaper-root')!;
    const second = screen.getByText('Fabric torn').closest('.MuiPaper-root')!;
    expect(second.getBoundingClientRect().top).toBeGreaterThanOrEqual(first.getBoundingClientRect().bottom);
    fireEvent.click(screen.getByText('Motor overload'));
    expect(viewer.fitToNodes).toHaveBeenCalledWith([viewer.registry!.getNode('Line/Drive')]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Focus related object' })[1]);
    expect(viewer.fitToNodes).toHaveBeenNthCalledWith(2, [viewer.registry!.getNode('Line/Ribbon')]);
    expect(viewer.fitToNodes).toHaveBeenCalledTimes(2);
    expect(viewer.highlighter.flash).toHaveBeenCalledTimes(2);
    // Clicking a card does not collapse the list over the next target.
    expect(second.getBoundingClientRect().top).toBeGreaterThanOrEqual(first.getBoundingClientRect().bottom);
  });
});
