// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import type { RVViewer } from '../src/core/rv-viewer';
import { SearchAiDialog } from '../src/core/hmi/SearchAiDialog';
import { resetAiSearch, runAiSearch } from '../src/core/hmi/search-ai-store';
import { registerSearchDiagnoseProvider } from '../src/plugins/diagnose/search-diagnose-registry';
import { PartLink } from '../src/core/hmi/PartLink';
import {
  clearSearchAiHistory,
  pushSearchAiHistory,
} from '../src/core/hmi/search-ai-history-store';
import { resetDocNodeIndexCache } from '../src/core/engine/rv-doc-node-map';

let unregister: (() => void) | undefined;

afterEach(() => {
  cleanup();
  resetAiSearch();
  clearSearchAiHistory();
  resetDocNodeIndexCache();
  unregister?.();
  unregister = undefined;
  vi.unstubAllGlobals();
});

function viewer(): RVViewer {
  return { registry: null } as unknown as RVViewer;
}

async function renderAnswer(
  result: Parameters<typeof registerSearchDiagnoseProvider>[0],
  v: RVViewer = viewer(),
) {
  unregister = registerSearchDiagnoseProvider(result);
  runAiSearch('Why did the motor stop?');
  await new Promise((resolve) => setTimeout(resolve, 0));
  render(
    <ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={v}>
        <SearchAiDialog open onClose={() => {}} />
      </RVViewerProvider>
    </ThemeProvider>,
  );
}

describe('SearchAiDialog comparison tabs', () => {
  it('shows history only when answers exist and restores a selected answer', async () => {
    const v = viewer();
    render(
      <ThemeProvider theme={rvDarkTheme}>
        <RVViewerProvider value={v}>
          <SearchAiDialog open onClose={() => {}} />
        </RVViewerProvider>
      </ThemeProvider>,
    );
    expect(screen.queryByRole('button', { name: 'AI answer history' })).toBeNull();

    pushSearchAiHistory({
      query: 'Why did the conveyor stop unexpectedly?',
      result: { cause: 'Stored answer', remedy: '', sources: [] },
      at: 1,
    });
    const historyButton = await screen.findByRole('button', { name: 'AI answer history' });
    fireEvent.click(historyButton);
    fireEvent.click(await screen.findByText('Why did the conveyor stop unexpectedly?'));
    expect(await screen.findByText('Stored answer')).toBeTruthy();
  });

  it('PartLink selects the exact path and frames its registry node', () => {
    const node = {};
    const select = vi.fn();
    const fitToNodes = vi.fn();
    const v = {
      registry: { getNode: vi.fn(() => node) },
      selectionManager: { select },
      fitToNodes,
    } as unknown as RVViewer;
    render(
      <ThemeProvider theme={rvDarkTheme}>
        <RVViewerProvider value={v}>
          <PartLink path="Cell/Motor" label="Motor" variant="chip" />
        </RVViewerProvider>
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByText('Motor'));
    expect(select).toHaveBeenCalledWith('Cell/Motor');
    expect(fitToNodes).toHaveBeenCalledWith([node]);
  });

  it('renders affected parts through the canonical PartLink', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const linkedNode = { userData: { _rvPdfLinks: [{ source: { url: 'docs/manual.pdf' } }] } };
    const select = vi.fn();
    const fitToNodes = vi.fn();
    const v = {
      scene: { traverse: (callback: (node: unknown) => void) => callback(linkedNode) },
      registry: {
        getPathForNode: () => 'Cell/Motor',
        getNode: () => linkedNode,
        forEachNode: () => {},
      },
      selectionManager: { select },
      fitToNodes,
    } as unknown as RVViewer;
    unregister = registerSearchDiagnoseProvider({
      diagnose: async () => ({
        cause: 'Check the motor',
        remedy: '',
        sources: [{ title: 'manual.pdf', url: 'docs/manual.pdf' }],
      }),
    });
    runAiSearch('motor');
    await new Promise((resolve) => setTimeout(resolve, 0));
    render(
      <ThemeProvider theme={rvDarkTheme}>
        <RVViewerProvider value={v}>
          <SearchAiDialog open onClose={() => {}} />
        </RVViewerProvider>
      </ThemeProvider>,
    );

    fireEvent.click(await screen.findByText('Motor'));
    expect(select).toHaveBeenCalledWith('Cell/Motor');
    expect(fitToNodes).toHaveBeenCalledWith([linkedNode]);
  });

  it('switches between provider-labelled answers with durations', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    await renderAnswer({
      diagnose: async () => ({
        cause: 'Cloud answer', remedy: '', sources: [], provider: 'cloud', durationMs: 1200,
        comparison: {
          cause: 'CLI answer', remedy: '', sources: [], provider: 'claude-cli', durationMs: 4300,
        },
      }),
    });

    await waitFor(() => expect(screen.getByText('Cloud answer')).toBeTruthy());
    expect(screen.getByRole('tab', { name: /Cloud RAG · 1.2 s/i })).toBeTruthy();
    const comparisonTab = screen.getByRole('tab', { name: /Claude CLI · 4.3 s/i });
    fireEvent.click(comparisonTab);
    await waitFor(() => expect(screen.getByText('CLI answer')).toBeTruthy());
  });

  it('shows the sanitized comparison error in its tab and content', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    await renderAnswer({
      diagnose: async () => ({
        cause: 'Primary answer', remedy: '', sources: [], provider: 'cloud',
        comparisonError: 'timeout',
      }),
    });

    const errorTab = await screen.findByRole('tab', { name: /Comparison · timeout/i });
    fireEvent.click(errorTab);
    expect(await screen.findByText(/Comparison provider unavailable: timeout/i)).toBeTruthy();
  });

  it('empty cloud answer with substantive comparison still shows tabs, comparison preselected', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    await renderAnswer({
      diagnose: async () => ({
        cause: '', remedy: 'Nicht in der Dokumentation gefunden.', sources: [],
        provider: 'cloud', durationMs: 900,
        comparison: {
          cause: 'CLI found it', remedy: '', sources: [], provider: 'claude-cli', durationMs: 4100,
        },
      }),
    });

    // Not the empty state — the comparison answer renders, its tab preselected.
    await waitFor(() => expect(screen.getByText('CLI found it')).toBeTruthy());
    expect(screen.queryByText(/No matching answer found/i)).toBeNull();
    expect(screen.getByRole('tab', { name: /Claude CLI · 4.1 s/i }).getAttribute('aria-selected')).toBe('true');
  });

  it('renders **bold** answer spans as <strong>, leaves unpaired markers literal', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    await renderAnswer({
      diagnose: async () => ({
        cause: 'Check the **motor protection** switch',
        remedy: 'Unpaired ** stays literal',
        sources: [],
      }),
    });

    const bold = await screen.findByText('motor protection');
    expect(bold.tagName).toBe('STRONG');
    expect(screen.getByText(/Unpaired \*\* stays literal/)).toBeTruthy();
  });

  it('linkifies a bold exact part match with the inline PartLink pattern', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const node = {};
    const select = vi.fn();
    const fitToNodes = vi.fn();
    const v = {
      registry: {
        forEachNode: (callback: (path: string, node: unknown) => void) => callback('Cell/STD-004591:1', node),
        getNode: () => node,
        getPathForNode: () => 'Cell/STD-004591:1',
      },
      selectionManager: { select },
      fitToNodes,
    } as unknown as RVViewer;
    await renderAnswer({
      diagnose: async () => ({
        cause: 'Check **STD-004591:1** first',
        remedy: '',
        sources: [],
      }),
    }, v);

    const part = await screen.findByText('STD-004591:1');
    expect(part.closest('strong')).toBeTruthy();
    expect(part.closest('button')?.querySelector('[data-testid="MyLocationIcon"]')).toBeTruthy();
    fireEvent.click(part);
    expect(select).toHaveBeenCalledWith('Cell/STD-004591:1');
    expect(fitToNodes).toHaveBeenCalledWith([node]);
  });
});
