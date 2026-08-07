// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Polling and persisted view-state helpers for the agents UI. */

import { lsLoad, lsSave } from '../../core/hmi/ls-store-utils';
import type { AgentProvider, AgentRunRecord } from './agent-provider';
import { isTerminalAgentRunStatus } from './agent-provider';

export const AGENT_VIEW_STORAGE_KEY = 'rv.agents.view.v1';
export const AGENT_POLL_INTERVAL_MS = 1500;

export interface AgentViewState {
  managerOpen: boolean;
  runOpen: boolean;
  selectedRunId: string | null;
}

const DEFAULT_VIEW_STATE: AgentViewState = {
  managerOpen: false,
  runOpen: false,
  selectedRunId: null,
};

export function loadAgentViewState(): AgentViewState {
  return lsLoad(AGENT_VIEW_STORAGE_KEY, DEFAULT_VIEW_STATE, {
    validate: (merged) => ({
      managerOpen: merged.managerOpen === true,
      runOpen: merged.runOpen === true,
      selectedRunId: typeof merged.selectedRunId === 'string' ? merged.selectedRunId : null,
    }),
  });
}

export function saveAgentViewState(state: AgentViewState): void {
  lsSave(AGENT_VIEW_STORAGE_KEY, state);
}

export interface PollAgentRunOptions {
  intervalMs?: number;
  signal?: AbortSignal;
  onUpdate?: (run: AgentRunRecord) => void;
  /** Injectable delay for deterministic tests. */
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

/** Polls immediately and stops on every terminal server status, including recovery states. */
export async function pollAgentRun(
  provider: AgentProvider,
  runId: string,
  options: PollAgentRunOptions = {},
): Promise<AgentRunRecord> {
  const intervalMs = options.intervalMs ?? AGENT_POLL_INTERVAL_MS;
  const delay = options.delay ?? abortableDelay;

  while (true) {
    if (options.signal?.aborted) throw abortReason(options.signal);
    const run = await provider.getRun(runId, { signal: options.signal });
    if (!run) throw new Error(`Agent run not found: ${runId}`);
    options.onUpdate?.(run);
    if (isTerminalAgentRunStatus(run.status)) return run;
    await delay(intervalMs, options.signal);
  }
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('Agent polling aborted', 'AbortError');
}
