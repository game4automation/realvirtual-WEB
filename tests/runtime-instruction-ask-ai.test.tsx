// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { EventEmitter } from '../src/core/rv-events';
import type { RVViewer } from '../src/core/rv-viewer';
import type { ViewerEvents } from '../src/core/rv-viewer-events';
import { InstructionRuntimeStore } from '../src/core/engine/rv-instruction-runtime-store';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { InstructionPanel } from '../src/plugins/custom-runtime-instruction-plugin';
import { registerSearchDiagnoseProvider } from '../src/plugins/diagnose/search-diagnose-registry';

let unregister: (() => void) | undefined;

afterEach(() => {
  cleanup();
  unregister?.();
  unregister = undefined;
});

function makeViewer(path = 'Line/Drive') {
  const instructionStore = new InstructionRuntimeStore();
  instructionStore.setActive(path, {
    path,
    type: 'warning',
    dismissible: false,
    isolate: false,
    dismissed: false,
    steps: [{
      instruction: 'Inspect motor cooling',
      targetPath: null,
      targetPaths: [],
      url: null,
    }],
    since: 1,
    at: Date.now(),
  });
  const events = new EventEmitter<ViewerEvents>();
  const node = {
    userData: {
      realvirtual: { Drive: { TargetSpeed: 250 } },
      _rvPdfLinks: [{ source: { url: '/docs/motor.pdf#page=7' } }],
    },
    parent: null,
  };
  const viewer = {
    instructionStore,
    registry: {
      getNode: (nodePath: string) => nodePath === 'Line/Drive' ? node : null,
      getComponentTypes: () => ['Drive'],
    },
    signalStore: null,
    emit: (event: string, payload: unknown) => events.emit(event, payload),
    isSelectionIsolateActive: false,
    exitIsolate: () => {},
  } as unknown as RVViewer;
  return { viewer, events };
}

function renderPanel(viewer: RVViewer) {
  return render(
    <ThemeProvider theme={rvDarkTheme}>
      <InstructionPanel viewer={viewer} />
    </ThemeProvider>,
  );
}

describe('InstructionPanel Ask AI', () => {
  it('renders the action only while a search diagnosis provider is registered', async () => {
    const { viewer } = makeViewer();
    renderPanel(viewer);
    expect(screen.queryByRole('button', { name: /ask ai/i })).toBeNull();

    unregister = registerSearchDiagnoseProvider({
      diagnose: async () => ({ cause: '', remedy: '', sources: [] }),
    });
    expect(await screen.findByRole('button', { name: /ask ai/i })).toBeTruthy();
  });

  it('emits diagnose-request with instruction label, owner node and AI context', () => {
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
      label: 'Inspect motor cooling',
      source: 'runtime-instruction',
      docHints: ['docs/motor.pdf'],
    });
    expect(received[0].machineContext).toContain('Drive: TargetSpeed=250');
  });

  it('omits node context for a defensive instruction entry without a path', () => {
    const { viewer, events } = makeViewer('');
    const received: Array<Record<string, unknown>> = [];
    events.on('diagnose-request', (event) => received.push(event));
    unregister = registerSearchDiagnoseProvider({
      diagnose: async () => ({ cause: '', remedy: '', sources: [] }),
    });
    renderPanel(viewer);

    fireEvent.click(screen.getByRole('button', { name: /ask ai/i }));

    expect(received[0]).toEqual({
      label: 'Inspect motor cooling',
      source: 'runtime-instruction',
    });
  });
});
