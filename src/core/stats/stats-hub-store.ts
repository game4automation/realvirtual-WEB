// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Browser preferences for the statistics hub. Opening is session-only. */
import { createStore } from '../hmi/create-store';
import { lsLoad, lsSave } from '../hmi/ls-store-utils';
import { STATS_HUB_KEY } from '../hmi/rv-storage-keys';

export interface StatsHubState { open: boolean; activeSection: string | null }
interface Preferences {
  activeSection: string | null;
  groupBy: Record<string, boolean>;
  settings: Record<string, boolean>;
}

function booleanMap(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'boolean'));
}

function load(): Preferences {
  return lsLoad<Preferences>(STATS_HUB_KEY, { activeSection: null, groupBy: {}, settings: {} }, {
    validate: (value) => ({
      activeSection: typeof value.activeSection === 'string' ? value.activeSection : null,
      groupBy: booleanMap(value.groupBy),
      settings: booleanMap(value.settings),
    }),
  });
}

let preferences = load();
const store = createStore<StatsHubState>({ open: false, activeSection: preferences.activeSection });
export const subscribeStatsHub = store.subscribe;
export const getStatsHubSnapshot = store.getSnapshot;

function save(): void { lsSave(STATS_HUB_KEY, preferences); }

export function setStatsHubSection(activeSection: string | null): void {
  preferences = { ...preferences, activeSection };
  save();
  store.set({ activeSection });
}

export function openStatsHub(sectionId?: string): void {
  if (sectionId !== undefined) setStatsHubSection(sectionId);
  store.set({ open: true });
}
export function closeStatsHub(): void { store.set({ open: false }); }
export function toggleStatsHub(): void { store.set({ open: !store.getSnapshot().open }); }
export function isStatsHubOpen(): boolean { return store.getSnapshot().open; }

export function getStatsHubGroupBy(id: string): boolean { return preferences.groupBy[id] === true; }
export function setStatsHubGroupBy(id: string, value: boolean): void {
  preferences = { ...preferences, groupBy: { ...preferences.groupBy, [id]: value } };
  save();
  store.set({});
}
export function loadStatsHubSetting(id: string): boolean | undefined {
  const value = preferences.settings[id];
  return typeof value === 'boolean' ? value : undefined;
}
export function saveStatsHubSetting(id: string, value: boolean): void {
  preferences = { ...preferences, settings: { ...preferences.settings, [id]: value } };
  save();
}

/** Reload preferences without restoring the open state (also useful for test isolation). */
export function resetStatsHubStore(): void {
  preferences = load();
  store.set({ open: false, activeSection: preferences.activeSection });
}
