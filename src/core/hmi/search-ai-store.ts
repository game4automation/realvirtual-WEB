// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * search-ai-store — state for the AI documentation search behind the global
 * search bar's "Ask AI" button (plan-283).
 *
 * `runAiSearch(query)` sends the search term as a free-text `{ label }`
 * request to the provider registered in the search-diagnose-registry (the
 * private SearchAiPlugin registers CONNECT's RemoteDiagnoseProvider there).
 * The store never blocks the synchronous node search — it only tracks the
 * async AI answer for the <SearchAiDialog/>.
 *
 * - Generation guard + AbortController: a new run aborts the in-flight
 *   request; an overtaken response is discarded, never rendered (F9).
 * - Error mapping: the RemoteDiagnoseProvider rejects with
 *   "Diagnose backend returned {status}" — the HTTP status is parsed
 *   defensively from the message (429 rate limit / 503 no API key); its
 *   TimeoutError becomes a retry hint.
 * - Empty answers (no cause, no remedy, no sources — or CONNECT's literal
 *   "not found in the documentation" remedy) become status 'empty', not an
 *   error (F8).
 * - `startedAt` feeds the dialog's live elapsed-seconds counter — a RAG +
 *   LLM answer takes 25–35 s, a static spinner reads as "hung".
 */

import type { DiagnoseRequest, DiagnoseResult } from '../../plugins/diagnose/diagnose-provider';
import { getSearchDiagnoseProvider } from '../../plugins/diagnose/search-diagnose-registry';
import { createGenerationGuard } from '../../plugins/diagnose/debounce';
import type { SearchAiContext } from './search-ai-context';
import {
  pushSearchAiHistory,
  type SearchAiHistoryEntry,
} from './search-ai-history-store';

export type SearchAiStatus = 'idle' | 'loading' | 'done' | 'empty' | 'error';

export interface SearchAiState {
  status: SearchAiStatus;
  /** The query the current status refers to. */
  query: string;
  /** Parsed answer (status 'done'; also kept for 'empty'). */
  result?: DiagnoseResult;
  /** Human-readable error message (status 'error'). */
  error?: string;
  /** `Date.now()` when the current request started (status 'loading'). */
  startedAt?: number;
  /** Always-on machine status plus optional selection context sent with the request. */
  context?: SearchAiContext;
}

const IDLE: SearchAiState = { status: 'idle', query: '' };

let _state: SearchAiState = IDLE;
const _listeners = new Set<() => void>();

const _guard = createGenerationGuard();
let _controller: AbortController | null = null;

function _setState(next: SearchAiState): void {
  _state = next;
  for (const fn of _listeners) fn();
}

/** useSyncExternalStore plumbing. */
export function subscribeSearchAi(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

export function getSearchAiSnapshot(): SearchAiState {
  return _state;
}

/** CONNECT's literal "nothing found" remedy (DiagnosisService fallback). */
const NOT_FOUND_REMEDY = 'Nicht in der Dokumentation gefunden.';

/** True when ONE answer has nothing to say (F8). Exported for the dialog's tab preselection. */
export function isEmptyAnswer(result: DiagnoseResult): boolean {
  const cause = result.cause.trim();
  const remedy = result.remedy.trim();
  if (remedy === NOT_FOUND_REMEDY) return true;
  return cause === '' && remedy === '' && result.sources.length === 0;
}

/**
 * True when the backend had nothing to say AT ALL. A "not found" primary with a
 * substantive comparison answer (both mode: cloud found nothing, Claude did) must
 * still render as a normal result — the comparison would be lost otherwise.
 */
function _isEmptyResult(result: DiagnoseResult): boolean {
  if (!isEmptyAnswer(result)) return false;
  const comparison = result.comparison;
  return !comparison || isEmptyAnswer(comparison);
}

/**
 * Map a provider rejection to a user-readable message. The HTTP status is
 * parsed defensively out of the RemoteDiagnoseProvider's
 * "Diagnose backend returned {status}" message — unknown shapes fall back
 * to a generic message.
 */
function _mapError(err: unknown): string {
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return 'The AI took too long to answer — try again';
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/timed out/i.test(msg)) return 'The AI took too long to answer — try again';
  const statusMatch = /\breturned\s+(\d{3})\b/.exec(msg);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;
  switch (status) {
    case 429: return 'Rate limit — try again in a minute';
    case 503: return 'No LLM API key configured in CONNECT';
    default:  return msg || 'AI search failed';
  }
}

/**
 * Run an AI documentation search for `query`. No-op (stays idle) when no
 * provider is registered or the query is blank. A running search is aborted
 * first — only the newest answer is ever applied.
 * The provider owns the effective timeout because CONNECT exposes it through
 * `/diagnose/status`; callers pass only cancellation signals.
 */
export function runAiSearch(query: string, context?: SearchAiContext | null): void {
  const provider = getSearchDiagnoseProvider();
  const q = query.trim();
  if (!provider || !q) return;

  _controller?.abort();
  const controller = new AbortController();
  _controller = controller;
  const generation = _guard.next();

  const ctx = context ?? undefined;
  _setState({ status: 'loading', query: q, startedAt: Date.now(), context: ctx });

  // The free-text query stays the label. machineContext is normally always present
  // (plan-295); nodePath/docHints remain selection-dependent. Context-less callers
  // remain supported.
  const request: DiagnoseRequest = { label: q };
  if (ctx?.nodePath) request.nodePath = ctx.nodePath;
  if (ctx?.docHints?.length) request.docHints = ctx.docHints;
  if (ctx?.machineContext) request.machineContext = ctx.machineContext;

  provider
    .diagnose(request, { signal: controller.signal })
    .then((result) => {
      if (!_guard.isCurrent(generation)) return;
      if (_isEmptyResult(result)) {
        _setState({ status: 'empty', query: q, result, context: ctx });
        return;
      }
      _setState({ status: 'done', query: q, result, context: ctx });
      pushSearchAiHistory({ query: q, result, context: ctx, at: Date.now() });
    })
    .catch((err: unknown) => {
      if (controller.signal.aborted) return;       // cancelled — no ghost error
      if (!_guard.isCurrent(generation)) return;
      _setState({ status: 'error', query: q, error: _mapError(err), context: ctx });
    });
}

/** Restore a successful session-history answer without issuing a request. */
export function restoreFromHistory(entry: SearchAiHistoryEntry): void {
  _guard.invalidate();
  _controller?.abort();
  _controller = null;
  _setState({
    status: 'done',
    query: entry.query,
    result: entry.result,
    context: entry.context,
  });
}

/** Abort a running search and reset the section to idle (Escape / ✕). */
export function abortAiSearch(): void {
  _guard.invalidate();
  _controller?.abort();
  _controller = null;
  if (_state.status !== 'idle') _setState(IDLE);
}

/** Reset to idle (alias of {@link abortAiSearch} — also cancels in-flight). */
export function resetAiSearch(): void {
  abortAiSearch();
}
