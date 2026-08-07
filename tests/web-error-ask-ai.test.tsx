// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it } from 'vitest';
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
  const viewer = {
    errorStore,
    selectionManager: { getSnapshot: () => ({ primaryPath: null }) },
    registry: {
      getNode: (path: string) => path === 'Line/Drive' ? node : null,
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
