// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * diagnose-provider.ts — Seam between the diagnosis UI and a diagnosis backend
 * (plan-253).
 *
 * Mirrors the demo seam `demo/robot-alarm/alarm-assistant-provider.ts`
 * (`AlarmAssistantProvider.analyze()`): the UI never talks to a backend
 * directly — it asks a {@link DiagnoseProvider}. The real implementation
 * (`RemoteDiagnoseProvider`, private tier) calls the CONNECT `/diagnose`
 * endpoint (RAG + Requesty); the demo keeps its `FakeAlarmAssistantProvider`.
 *
 * Deliberately NOT built here: backend proxy, API keys, embeddings, streaming.
 */

/**
 * One diagnosis request — derived from a `diagnose-request` viewer event
 * (node-bound error diagnosis) OR a free-text documentation search from the
 * hierarchy search field (plan-283, no node context → `nodePath` omitted).
 */
export interface DiagnoseRequest {
  /**
   * Scene node path of the WebDiagnostics marker that raised the error.
   * Omitted for free-text search queries without node context — the backend
   * builds its query from `label` in that case (plan-283).
   */
  nodePath?: string;
  /** Error code from the bound SignalInt (omitted for bool-only triggers). */
  errorCode?: number;
  /** Backend metadata filter (machine / component / error-code range). */
  docFilter?: string;
  /** Stable error ID — key for the comment store. Defaults to the node path. */
  errorId?: string;
  /** Human-readable label of the marker (for display + backend context). */
  label?: string;
  /**
   * plan-284 F2: exact documentation paths linked to the selected/queried node
   * (from AASLink / `_rvPdfLinks`). The backend gives chunks from these files a
   * retrieval score boost — a soft hint, never a hard filter. Capped server-side.
   */
  docHints?: string[];
  /**
   * plan-284 F4: pre-formatted, size-limited snapshot of the node's live machine
   * state (component type + whitelisted rv_extras + current signal values + active
   * alarms). Injected into the chat prompt as a delimited DATA block; the backend
   * re-caps it and can disable it entirely (F7).
   */
  machineContext?: string;
}

/** One documentation source cited by the backend. */
export interface DiagnoseSource {
  title: string;
  /** PDF/document URL (opened via the embedded PDF viewer). */
  url?: string;
  /** 1-based page inside the document. */
  page?: number;
  /** Short excerpt shown inline. */
  snippet?: string;
}

/**
 * Structured diagnosis answer. The backend JSON is NOT TypeScript-guarded —
 * always parse defensively (see {@link parseDiagnoseResult}).
 */
export interface DiagnoseResult {
  cause: string;
  remedy: string;
  /** Cited documentation sources. Access with `?? []` on raw payloads. */
  sources: DiagnoseSource[];
  /** Answering model id (informational). */
  model?: string;
  /** plan-291 F8: Names of the read-only tools used by the backend. */
  toolTrace?: string[];
  /** Stable backend identifier (`cloud` or `claude-cli`). */
  provider?: string;
  /** Backend duration in milliseconds. */
  durationMs?: number;
  /** Optional second answer returned by CONNECT's `both` mode. */
  comparison?: DiagnoseResult;
  /** Sanitized short code when only the comparison provider failed. */
  comparisonError?: string;
}

/** Options for one provider call. */
export interface DiagnoseOptions {
  /** External abort (plugin request-registry / model-cleared cleanup). */
  signal?: AbortSignal;
}

/** The contract every diagnosis provider implements. */
export interface DiagnoseProvider {
  diagnose(request: DiagnoseRequest, options?: DiagnoseOptions): Promise<DiagnoseResult>;
}

/**
 * Defensively coerce an untrusted backend payload into a {@link DiagnoseResult}.
 * Never throws — missing/malformed fields fall back to empty values.
 */
export function parseDiagnoseResult(raw: unknown): DiagnoseResult {
  return parseDiagnoseResultLevel(raw, true);
}

function parseDiagnoseResultLevel(raw: unknown, allowComparison: boolean): DiagnoseResult {
  const obj = (raw && typeof raw === 'object' && !Array.isArray(raw))
    ? raw as Record<string, unknown>
    : {};
  const rawSources = Array.isArray(obj.sources) ? obj.sources : [];
  const sources: DiagnoseSource[] = [];
  for (const s of rawSources) {
    if (!s || typeof s !== 'object') continue;
    const src = s as Record<string, unknown>;
    sources.push({
      title: typeof src.title === 'string' ? src.title : '',
      url: typeof src.url === 'string' ? src.url : undefined,
      page: typeof src.page === 'number' && Number.isFinite(src.page) ? src.page : undefined,
      snippet: typeof src.snippet === 'string' ? src.snippet : undefined,
    });
  }
  const result: DiagnoseResult = {
    cause: typeof obj.cause === 'string' ? obj.cause : '',
    remedy: typeof obj.remedy === 'string' ? obj.remedy : '',
    sources,
    model: typeof obj.model === 'string' ? obj.model : undefined,
  };
  if (Array.isArray(obj.toolTrace)) {
    result.toolTrace = obj.toolTrace.filter((tool): tool is string => typeof tool === 'string');
  }
  if (typeof obj.provider === 'string') result.provider = obj.provider;
  if (typeof obj.durationMs === 'number' && Number.isFinite(obj.durationMs)) {
    result.durationMs = obj.durationMs;
  }
  if (allowComparison && obj.comparison && typeof obj.comparison === 'object' && !Array.isArray(obj.comparison)) {
    result.comparison = parseDiagnoseResultLevel(obj.comparison, false);
  }
  if (typeof obj.comparisonError === 'string') result.comparisonError = obj.comparisonError;
  return result;
}
