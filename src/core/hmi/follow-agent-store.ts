// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { readLocalStorage, writeLocalStorage } from '../rv-safe-storage';

/**
 * follow-agent-store — Settings > AI Bridge > "Follow agent" (plan-520).
 *
 * One boolean per device: when ON (the default), the camera flies to the node an
 * AI agent is editing over MCP, as long as the user has not used the viewport
 * for a few seconds (see `rv-mcp-follow-policy.ts`). OFF = the pre-plan-520
 * feedback (offscreen-only framing, throttled).
 *
 * Same shape as `ai-consent-store.ts`: a listener set + `useSyncExternalStore`,
 * storage access wrapped in try/catch, and a session value that carries the
 * choice when storage refuses the write (private mode, disabled storage).
 */

import { useSyncExternalStore } from 'react';
import { MCP_FOLLOW_AGENT_KEY } from './rv-storage-keys';

/** Value chosen in THIS session when storage refused the write; null = read storage. */
let sessionValue: boolean | null = null;

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function readStored(): boolean | null {
  try {
    const raw = readLocalStorage(MCP_FOLLOW_AGENT_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return null;
  } catch {
    return null;
  }
}

/** True when the camera should follow the agent's edits (default true). */
export function getFollowAgent(): boolean {
  if (sessionValue !== null) return sessionValue;
  return readStored() ?? true;
}

/** Switch "Follow agent" on or off for this device. */
export function setFollowAgent(value: boolean): void {
  sessionValue = writeLocalStorage(MCP_FOLLOW_AGENT_KEY, value ? '1' : '0') ? null : value;
  notify();
}

/** React hook: the current "Follow agent" setting. */
export function useFollowAgent(): boolean {
  return useSyncExternalStore(subscribe, getFollowAgent, getFollowAgent);
}

/** Test hook: forget the session value (storage is left alone). */
export function _resetFollowAgentForTest(): void {
  sessionValue = null;
  notify();
}
