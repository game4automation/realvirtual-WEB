// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { AskAiHistoryTooltip } from '../src/core/hmi/BottomBar';
import {
  clearSearchAiHistory,
  getSearchAiHistorySnapshot,
  pushSearchAiHistory,
} from '../src/core/hmi/search-ai-history-store';
import { getSearchAiSnapshot, resetAiSearch } from '../src/core/hmi/search-ai-store';
import { rvDarkTheme } from '../src/core/hmi/theme';

afterEach(() => {
  cleanup();
  resetAiSearch();
  clearSearchAiHistory();
});

function renderTooltip(onOpenDialog = vi.fn()) {
  render(
    <ThemeProvider theme={rvDarkTheme}>
      <AskAiHistoryTooltip
        historyEntries={getSearchAiHistorySnapshot()}
        onOpenDialog={onOpenDialog}
      >
        <button type="button">Ask AI</button>
      </AskAiHistoryTooltip>
    </ThemeProvider>,
  );
  return onOpenDialog;
}

describe('BottomBar Ask AI history hover', () => {
  it('shows the newest three queries on hover and restores a clicked answer', async () => {
    for (let i = 1; i <= 4; i++) {
      pushSearchAiHistory({
        query: `Query ${i} ${'detail '.repeat(8)}`,
        result: { cause: `Stored answer ${i}`, remedy: '', sources: [] },
        at: i,
      });
    }
    const onOpenDialog = renderTooltip();

    fireEvent.mouseOver(screen.getByText('Ask AI'));

    expect(await screen.findByText('Recent answers')).toBeTruthy();
    const rows = screen.getAllByRole('button', { name: /Restore AI answer:/ });
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
      expect.stringContaining('Query 4'),
      expect.stringContaining('Query 3'),
      expect.stringContaining('Query 2'),
    ]);
    expect(screen.queryByText(/Query 1/)).toBeNull();
    expect(rows[0].textContent?.length).toBeLessThanOrEqual(40);

    fireEvent.click(rows[1]);

    expect(getSearchAiSnapshot()).toMatchObject({
      status: 'done',
      query: expect.stringContaining('Query 3'),
      result: { cause: 'Stored answer 3' },
    });
    expect(onOpenDialog).toHaveBeenCalledOnce();
  });

  it('keeps the simple text tooltip when history is empty', async () => {
    renderTooltip();

    fireEvent.mouseOver(screen.getByText('Ask AI'));

    expect(await screen.findByText('Ask the machine documentation (AI)')).toBeTruthy();
    expect(screen.queryByText('Recent answers')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Recent AI answers' })).toBeNull();
  });
});
