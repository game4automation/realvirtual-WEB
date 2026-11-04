// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Priority coordinator that prevents startup dialogs from stacking. */

import { useLayoutEffect, useSyncExternalStore } from 'react';

export type StartupModalId = 'welcome' | 'projects' | 'demo-welcome' | 'opener' | 'autoquality' | 'news';

const PRIORITY: Readonly<Record<StartupModalId, number>> = {
  welcome: 1,
  // The Projects dashboard is the application's entry point when nothing else
  // was asked for (plan-372 §2.12), so it outranks every incidental dialog but
  // still yields to the welcome screen.
  projects: 2,
  // The public-demo welcome window (plan-646 F14, private plugin `demo-welcome`, only in the
  // `/demo` build). After the welcome screen and the Projects dashboard, before every
  // incidental dialog: it waits while one of those two is up and reappears once it closes.
  'demo-welcome': 3,
  opener: 4,
  autoquality: 5,
  news: 6,
};

type Listener = () => void;

const listeners = new Set<Listener>();
let openSnapshot: Readonly<Record<StartupModalId, boolean>> = {
  welcome: false,
  projects: false,
  'demo-welcome': false,
  opener: false,
  autoquality: false,
  news: false,
};

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Readonly<Record<StartupModalId, boolean>> {
  return openSnapshot;
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Registers whether a startup modal is actually visible. */
export function setStartupModalOpen(id: StartupModalId, open: boolean): void {
  if (openSnapshot[id] === open) return;
  openSnapshot = { ...openSnapshot, [id]: open };
  notify();
}

/** Returns true when no currently visible modal has a higher priority. */
export function mayShowStartupModal(id: StartupModalId): boolean {
  const ownPriority = PRIORITY[id];
  return (Object.keys(PRIORITY) as StartupModalId[])
    .every((candidate) => !openSnapshot[candidate] || PRIORITY[candidate] >= ownPriority);
}

/** React hook that updates whenever a higher-priority startup modal opens or closes. */
export function useMayShowStartupModal(id: StartupModalId): boolean {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return mayShowStartupModal(id);
}

/**
 * Registers a modal during the layout phase so arbitration settles before the
 * browser paints two dialogs in the same frame.
 */
export function useStartupModalRegistration(id: StartupModalId, open: boolean): void {
  useLayoutEffect(() => {
    setStartupModalOpen(id, open);
    return () => setStartupModalOpen(id, false);
  }, [id, open]);
}

/** @internal Reset all registrations for isolated tests. */
export function _resetStartupModalCoordinatorForTests(): void {
  openSnapshot = {
    welcome: false,
    projects: false,
    'demo-welcome': false,
    opener: false,
    autoquality: false,
    news: false,
  };
  notify();
}
