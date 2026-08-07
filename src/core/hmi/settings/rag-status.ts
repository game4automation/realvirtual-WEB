// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { ConnectSnapshot } from '../connect-store';

/** Derived presentation level for the CONNECT RAG/LLM status row (plan-284). */
export type RagLevel =
  | 'offline'      // CONNECT not connected / gateway unreachable
  | 'unsupported'  // old gateway without /diagnose/status
  | 'disabled'     // gateway has the diagnosis feature turned off
  | 'loading'      // connected, first poll still pending
  | 'error'        // reranker faulted/missing, API key missing, or index faulted
  | 'busy'         // index loading/indexing or reranker loading
  | 'idle'         // index never initialized
  | 'empty'        // index loaded but no documents
  | 'ready'        // index ready
  | 'unknown';     // unexpected/unmapped server value

export interface RagStateResult {
  level: RagLevel;
  label: string;
  color: string;
}

const GREEN = '#66bb6a';
const AMBER = '#ffa726';
const RED = '#ef5350';
const GREY = 'rgba(255,255,255,0.5)';

const LEVEL_COLOR: Record<RagLevel, string> = {
  offline: GREY,
  unsupported: GREY,
  disabled: GREY,
  loading: GREY,
  idle: GREY,
  empty: GREY,
  unknown: GREY,
  busy: AMBER,
  error: RED,
  ready: GREEN,
};

function mk(level: RagLevel, label: string): RagStateResult {
  return { level, label, color: LEVEL_COLOR[level] };
}

/** True when CONNECT reports at least one usable chat backend. */
export function hasReadyChatProvider(snapshot: ConnectSnapshot): boolean {
  const rag = snapshot.rag;
  return !!(rag && rag.supported && rag.chatProviders?.some(
    (provider) => provider.status.toLowerCase() === 'ready',
  ));
}

/**
 * Map a {@link ConnectSnapshot} to the RAG/LLM status shown in the settings tab (plan-284).
 *
 * Failure precedence (SOL RC2): a faulted/missing reranker, a missing API key or a faulted index
 * take priority over "ready" — a ready index with no usable LLM is not "ready" to the user. The
 * connection check uses the real snapshot fields `state` + `gatewayUnreachable` (SOL RC4), and an
 * exhaustive tail returns `unknown` instead of silently falling through.
 */
export function ragState(snapshot: ConnectSnapshot): RagStateResult {
  const connected = snapshot.state === 'connected' && !snapshot.gatewayUnreachable;
  if (!connected) return mk('offline', 'CONNECT not connected');

  const rag = snapshot.rag;
  if (rag === undefined) return mk('loading', 'Checking…');
  if (rag.supported === false) return mk('unsupported', 'Status unsupported');
  if (!rag.enabled) return mk('disabled', 'Disabled');

  if (rag.rerankState === 'faulted' || rag.rerankState === 'missing')
    return mk('error', `Reranker ${rag.rerankState}`);
  if (rag.apiKeyConfigured === false && !hasReadyChatProvider(snapshot))
    return mk('error', 'API key missing');
  if (rag.indexState === 'faulted') return mk('error', 'Index faulted');

  if (rag.indexState === 'loading' || rag.indexState === 'indexing' || rag.rerankState === 'loading')
    return mk('busy', rag.indexState === 'indexing' ? 'Indexing…' : 'Loading…');

  if (rag.indexState === 'uninitialized') return mk('idle', 'Not initialized');
  if (rag.indexState === 'empty') return mk('empty', 'No documents');
  if (rag.indexState === 'ready') return mk('ready', 'Ready');

  return mk('unknown', 'Unknown');
}
