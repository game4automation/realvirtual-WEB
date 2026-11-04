// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Private-feature seam for handling the AI activity-bar entry. */

import { useSyncExternalStore } from 'react';

export type AiEntryAction = 'open' | 'toggle';
export type AiEntryHandler = (action?: AiEntryAction) => Promise<boolean>;

let handler: AiEntryHandler | null = null;
let open = false;
const openListeners = new Set<() => void>();

/** Install or remove the handler owned by the private AI prompt plugin. */
export function setAiEntryHandler(fn: AiEntryHandler | null): void {
  handler = fn;
}

/** Read the current handler without coupling the open core to the private panel. */
export function getAiEntryHandler(): AiEntryHandler | null {
  return handler;
}

/** Mirror the private prompt panel's open state into the public activity bar. */
export function setAiEntryOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of openListeners) listener();
}

export function getAiEntryOpen(): boolean {
  return open;
}

export function subscribeAiEntryOpen(listener: () => void): () => void {
  openListeners.add(listener);
  return () => { openListeners.delete(listener); };
}

/** Reactively reports whether the private AI prompt window is open. */
export function useAiEntryOpen(): boolean {
  return useSyncExternalStore(subscribeAiEntryOpen, getAiEntryOpen, () => false);
}
