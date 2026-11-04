// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** @deprecated Use the central statistics hub store for window state. */
import { closeStatsHub, getStatsHubSnapshot, openStatsHub, subscribeStatsHub } from '../../core/stats/stats-hub-store';

/** @deprecated Use getStatsHubSnapshot. */
export function isDesStatsWindowOpen(): boolean {
  const state = getStatsHubSnapshot();
  return state.open && state.activeSection === 'des.utilization';
}

/** @deprecated Use openStatsHub / closeStatsHub. */
export function setDesStatsWindowOpen(next: boolean): void {
  if (next) openStatsHub('des.utilization');
  else if (isDesStatsWindowOpen()) closeStatsHub();
}

/** @deprecated Use the statistics hub store. */
export function toggleDesStatsWindow(): void {
  setDesStatsWindowOpen(!isDesStatsWindowOpen());
}

/** @deprecated Use subscribeStatsHub. */
export const subscribeDesStatsWindow = subscribeStatsHub;

let hiddenKinds: ReadonlySet<string> = new Set();
const hiddenKindListeners = new Set<() => void>();

export function getDesStatsHiddenKinds(): ReadonlySet<string> {
  return hiddenKinds;
}

export function setDesStatsHiddenKinds(kinds: readonly string[]): void {
  if (!Array.isArray(kinds) || Array.from(kinds).some(kind => typeof kind !== 'string')) {
    throw new TypeError('hiddenKinds must be an array of strings');
  }
  const next = new Set(kinds);
  if (next.size === hiddenKinds.size && [...next].every(kind => hiddenKinds.has(kind))) return;
  hiddenKinds = next;
  for (const listener of hiddenKindListeners) listener();
}

export function toggleDesStatsHiddenKind(kind: string): void {
  if (typeof kind !== 'string') throw new TypeError('kind must be a string');
  const next = new Set(hiddenKinds);
  if (next.has(kind)) next.delete(kind);
  else next.add(kind);
  setDesStatsHiddenKinds([...next]);
}

export const desStatsHiddenKindsStore = {
  subscribe(listener: () => void): () => void {
    hiddenKindListeners.add(listener);
    return () => hiddenKindListeners.delete(listener);
  },
  getSnapshot: getDesStatsHiddenKinds,
};
