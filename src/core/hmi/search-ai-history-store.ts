// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { DiagnoseResult } from '../../plugins/diagnose/diagnose-provider';
import type { SearchAiContext } from './search-ai-context';

export interface SearchAiHistoryEntry {
  query: string;
  result: DiagnoseResult;
  context?: SearchAiContext;
  at: number;
}

const MAX_HISTORY_ENTRIES = 3;
const EMPTY_HISTORY: readonly SearchAiHistoryEntry[] = [];

let _entries: readonly SearchAiHistoryEntry[] = EMPTY_HISTORY;
const _listeners = new Set<() => void>();

function emit(): void {
  for (const listener of _listeners) listener();
}

/** useSyncExternalStore subscription. */
export function subscribeSearchAiHistory(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

/** Stable newest-first history snapshot. */
export function getSearchAiHistorySnapshot(): readonly SearchAiHistoryEntry[] {
  return _entries;
}

/** Adds one successful answer and keeps only the newest three. */
export function pushSearchAiHistory(entry: SearchAiHistoryEntry): void {
  _entries = [entry, ..._entries].slice(0, MAX_HISTORY_ENTRIES);
  emit();
}

/** Session-only reset used when a host explicitly clears state and by tests. */
export function clearSearchAiHistory(): void {
  if (_entries.length === 0) return;
  _entries = EMPTY_HISTORY;
  emit();
}
