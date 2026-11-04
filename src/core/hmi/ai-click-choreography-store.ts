// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Per-device AI click animations, enabled by default (plan-2210). */

import { readLocalStorage, writeLocalStorage } from '../rv-safe-storage';

import { useSyncExternalStore } from 'react';
import { MCP_AI_CLICKS_KEY } from './rv-storage-keys';

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
    const raw = readLocalStorage(MCP_AI_CLICKS_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return null;
  } catch {
    return null;
  }
}

/** True when AI clicks should animate (default true). */
export function getAiClicks(): boolean {
  if (sessionValue !== null) return sessionValue;
  return readStored() ?? true;
}

/** Switch "Show AI clicks" on or off for this device. */
export function setAiClicks(value: boolean): void {
  sessionValue = writeLocalStorage(MCP_AI_CLICKS_KEY, value ? '1' : '0') ? null : value;
  notify();
}

/** React hook: the current "Show AI clicks" setting. */
export function useAiClicks(): boolean {
  return useSyncExternalStore(subscribe, getAiClicks, getAiClicks);
}

/** Test hook: forget the session value (storage is left alone). */
export function _resetAiClicksForTest(): void {
  sessionValue = null;
  notify();
}
