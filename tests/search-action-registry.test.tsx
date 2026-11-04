// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Global search action rows and keyboard routing (plan-2041 §9.7). */

import { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { BottomBar } from '../src/core/hmi/BottomBar';
import { LeftPanelManager } from '../src/core/hmi/left-panel-manager';
import {
  notifySearchActionsChanged,
  registerSearchAction,
  subscribeSearchActions,
} from '../src/core/hmi/search-action-registry';
import { registerSearchDiagnoseProvider } from '../src/plugins/diagnose/search-diagnose-registry';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { RVViewerProvider } from '../src/hooks/use-viewer';

const filter = vi.hoisted(() => ({ setFilter: vi.fn(), filteredNodes: [] as Array<Record<string, unknown>> }));

vi.mock('../src/hooks/use-node-filter', () => ({
  useNodeFilter: () => ({ filter: '', filteredNodes: filter.filteredNodes, tooMany: false, setFilter: filter.setFilter }),
}));

vi.mock('../src/hooks/use-mobile-layout', () => ({ useMobileLayout: () => false }));
vi.mock('../src/hooks/use-viewport-insets', () => ({ useViewportInsets: () => ({ left: 0, right: 0, top: 0 }) }));
vi.mock('../src/core/hmi/SearchAiDialog', () => ({ SearchAiDialog: () => null }));

function viewerDouble() {
  return {
    leftPanelManager: new LeftPanelManager(),
    fitToNodes: vi.fn(),
    focusByPath: vi.fn(),
    selectionManager: { select: vi.fn() },
    highlighter: { clear: vi.fn(), highlight: vi.fn() },
    registry: { getNode: vi.fn(() => null) },
    getPlugin: vi.fn(() => null),
    on: vi.fn(() => () => undefined),
    off: vi.fn(),
  };
}

function renderWithViewer(node: ReactNode, viewer = viewerDouble()) {
  return {
    viewer,
    ...render(
      <ThemeProvider theme={rvDarkTheme}>
        <RVViewerProvider value={viewer as never}>{node}</RVViewerProvider>
      </ThemeProvider>,
    ),
  };
}

afterEach(() => {
  cleanup();
  filter.filteredNodes = [];
  vi.clearAllMocks();
});

describe('search-action-registry', () => {
  it('registers and unregisters a list entry with notifications', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSearchActions(listener);
    const unregister = registerSearchAction({
      id: 'test', label: (query) => query, available: () => true, run: vi.fn(),
    });
    expect(listener).toHaveBeenCalledTimes(1);
    unregister();
    expect(listener).toHaveBeenCalledTimes(2);
    unregister();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('shows a live action with zero node results and routes Enter without focusing a node', async () => {
    let available = false;
    const run = vi.fn();
    const unregisterAction = registerSearchAction({
      id: 'ai-agent',
      label: (query) => `Ask AI agent: "${query}"`,
      available: () => available,
      run,
    });
    const unregisterDiagnose = registerSearchDiagnoseProvider({
      diagnose: async () => ({ cause: '', remedy: '', sources: [] }),
    });
    const { viewer } = renderWithViewer(<BottomBar />);

    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const input = screen.getByPlaceholderText('Search drives, sensors, objects...');
    fireEvent.change(input, { target: { value: 'motor' } });
    expect(screen.queryByText('Ask AI agent: "motor"')).not.toBeInTheDocument();

    available = true;
    act(() => notifySearchActionsChanged());
    expect(await screen.findByText('Ask AI agent: "motor"')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask the machine documentation (AI)' })).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(run).toHaveBeenCalledWith('motor');
    expect(viewer.fitToNodes).not.toHaveBeenCalled();
    expect(viewer.focusByPath).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'drive' } });
    available = false;
    act(() => notifySearchActionsChanged());
    await waitFor(() => expect(screen.queryByText('Ask AI agent: "drive"')).not.toBeInTheDocument());

    unregisterDiagnose();
    unregisterAction();
  });

  it('refreshes unavailable actions when the search input receives focus', async () => {
    let available = false;
    const onSearchFocus = vi.fn(() => {
      available = true;
      notifySearchActionsChanged();
    });
    const unregister = registerSearchAction({
      id: 'cold-ai', label: (query) => `Cold AI: ${query}`, available: () => available,
      run: vi.fn(), onSearchFocus,
    });
    renderWithViewer(<BottomBar />);
    const input = screen.getByPlaceholderText('Search drives, sensors, objects...');
    fireEvent.change(input, { target: { value: 'motor' } });
    expect(screen.queryByText('Cold AI: motor')).not.toBeInTheDocument();

    fireEvent.focus(input);

    expect(onSearchFocus).toHaveBeenCalledOnce();
    expect(await screen.findByText('Cold AI: motor')).toBeInTheDocument();
    unregister();
  });

  it('keeps a keyboard-selected node stable when action availability changes', async () => {
    filter.filteredNodes = [{
      path: 'Cell/Motor', node: {}, types: ['Drive'], matchedBy: 'Drive', displayText: 'Motor',
    }];
    let available = false;
    const unregister = registerSearchAction({
      id: 'ai-agent', label: (query) => `Ask AI: ${query}`, available: () => available, run: vi.fn(),
    });
    const { viewer } = renderWithViewer(<BottomBar />);
    const input = screen.getByPlaceholderText('Search drives, sensors, objects...');
    fireEvent.change(input, { target: { value: 'motor' } });
    expect(await screen.findByText('Motor')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'ArrowDown' });

    available = true;
    act(() => notifySearchActionsChanged());
    expect(await screen.findByText('Ask AI: motor')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(viewer.selectionManager.select).toHaveBeenCalledWith('Cell/Motor');
    expect(viewer.focusByPath).toHaveBeenCalledWith('Cell/Motor');
    unregister();
  });
});
