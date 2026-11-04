// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Optional action rows contributed to the global search result list. */

import { useSyncExternalStore } from 'react';

export interface SearchAction {
  id: string;
  label(query: string): string;
  available(): boolean;
  run(query: string): void;
  onSearchFocus?(): void;
}

const actions: SearchAction[] = [];
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version++;
  for (const listener of listeners) listener();
}

/** Register one search action. Returns an idempotent unregister function. */
export function registerSearchAction(action: SearchAction): () => void {
  actions.push(action);
  notify();
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    const index = actions.indexOf(action);
    if (index < 0) return;
    actions.splice(index, 1);
    notify();
  };
}

/** Notify consumers after an action's dynamic availability changed. */
export function notifySearchActionsChanged(): void {
  notify();
}

export function subscribeSearchActions(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getSearchActionsSnapshot(): number {
  return version;
}

/** All currently registered and available actions, in registration order. */
export function useSearchActions(): readonly SearchAction[] {
  useSyncExternalStore(subscribeSearchActions, getSearchActionsSnapshot, getSearchActionsSnapshot);
  return actions.filter((action) => action.available());
}

/** All registered actions, including unavailable actions that can refresh on focus. */
export function useRegisteredSearchActions(): readonly SearchAction[] {
  useSyncExternalStore(subscribeSearchActions, getSearchActionsSnapshot, getSearchActionsSnapshot);
  return actions;
}
