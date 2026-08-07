// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it } from 'vitest';
import type { DiagnoseResult } from '../src/plugins/diagnose/diagnose-provider';
import { registerSearchDiagnoseProvider } from '../src/plugins/diagnose/search-diagnose-registry';
import {
  clearSearchAiHistory,
  getSearchAiHistorySnapshot,
  pushSearchAiHistory,
} from '../src/core/hmi/search-ai-history-store';
import {
  getSearchAiSnapshot,
  resetAiSearch,
  restoreFromHistory,
  runAiSearch,
} from '../src/core/hmi/search-ai-store';

const RESULT: DiagnoseResult = { cause: 'Found', remedy: 'Repair', sources: [] };
let unregister: (() => void) | undefined;

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  resetAiSearch();
  clearSearchAiHistory();
  unregister?.();
  unregister = undefined;
});

describe('search AI answer history', () => {
  it('starts empty', () => {
    expect(getSearchAiHistorySnapshot()).toEqual([]);
  });

  it('keeps a newest-first ring buffer of three entries', () => {
    for (let i = 1; i <= 4; i++) {
      pushSearchAiHistory({ query: `Query ${i}`, result: RESULT, at: i });
    }

    expect(getSearchAiHistorySnapshot().map((entry) => entry.query)).toEqual([
      'Query 4', 'Query 3', 'Query 2',
    ]);
  });

  it('pushes only substantive done answers, not empty or error states', async () => {
    let next: DiagnoseResult | Error = RESULT;
    unregister = registerSearchDiagnoseProvider({
      diagnose: async () => {
        if (next instanceof Error) throw next;
        return next;
      },
    });

    runAiSearch('successful');
    await flush();
    expect(getSearchAiSnapshot().status).toBe('done');
    expect(getSearchAiHistorySnapshot().map((entry) => entry.query)).toEqual(['successful']);

    next = { cause: '', remedy: '', sources: [] };
    runAiSearch('empty');
    await flush();
    expect(getSearchAiSnapshot().status).toBe('empty');
    expect(getSearchAiHistorySnapshot().map((entry) => entry.query)).toEqual(['successful']);

    next = new Error('offline');
    runAiSearch('failed');
    await flush();
    expect(getSearchAiSnapshot().status).toBe('error');
    expect(getSearchAiHistorySnapshot().map((entry) => entry.query)).toEqual(['successful']);
  });

  it('restores a done state without issuing a network request', () => {
    const entry = {
      query: 'Previous question',
      result: RESULT,
      context: { nodePath: 'Cell/Motor', machineContext: 'Node: Cell/Motor' },
      at: 17,
    };

    restoreFromHistory(entry);

    expect(getSearchAiSnapshot()).toEqual({
      status: 'done',
      query: 'Previous question',
      result: RESULT,
      context: entry.context,
    });
    expect(getSearchAiHistorySnapshot()).toEqual([]);
  });
});
