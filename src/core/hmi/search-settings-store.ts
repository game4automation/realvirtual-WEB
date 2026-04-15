// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Persists search/filter settings to localStorage. Supports self-registering filter subscribers. */

import { getAppConfig, isSettingsLocked } from '../rv-app-config';

const STORAGE_KEY = 'rv-search-settings';

/** A filter subscriber that registers itself (Drives, Sensors, etc.). */
export interface FilterSubscriber {
  id: string;             // e.g. 'Drive', 'Sensor', 'TransportSurface'
  label: string;          // e.g. 'Drives', 'Sensors', 'Conveyors'
  componentType: string;  // NodeRegistry type key
}

export interface SearchSettings {
  highlightEnabled: boolean;   // 3D highlight on/off (default: true)
  nodesEnabled: boolean;       // Show untyped nodes (default: true). When false, only typed results appear.
  disabledTypes: string[];     // Subscriber IDs that are DISABLED (default: [])
}

const DEFAULTS: SearchSettings = {
  highlightEnabled: true,
  nodesEnabled: true,
  disabledTypes: [],
};

// ─── Self-Registration ──────────────────────────────────────────

const subscribers: FilterSubscriber[] = [];

export function registerFilterSubscriber(sub: FilterSubscriber): void {
  if (!subscribers.find(s => s.id === sub.id)) {
    subscribers.push(sub);
  }
}

export function getFilterSubscribers(): readonly FilterSubscriber[] {
  return subscribers;
}

// ─── Type Filtering ─────────────────────────────────────────────

/** Check if a node's types pass the active filter settings. */
export function isTypeEnabled(settings: SearchSettings, types: string[]): boolean {
  if (types.length === 0) return settings.nodesEnabled;
  return types.some(t => !settings.disabledTypes.includes(t));
}

// ─── Persistence ────────────────────────────────────────────────

export function loadSearchSettings(): SearchSettings {
  // Layer 1+2: DEFAULTS + localStorage
  const fromStorage = loadFromLocalStorage();

  // Layer 3: Config override (from singleton)
  const override = getAppConfig().search;
  if (!override) return fromStorage;
  return {
    highlightEnabled: override.highlightEnabled ?? fromStorage.highlightEnabled,
    nodesEnabled: override.nodesEnabled ?? fromStorage.nodesEnabled,
    disabledTypes: override.disabledTypes ?? fromStorage.disabledTypes,
  };
}

function loadFromLocalStorage(): SearchSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS, disabledTypes: [] };
    const parsed = JSON.parse(raw) as Partial<SearchSettings>;
    return {
      highlightEnabled: parsed.highlightEnabled ?? DEFAULTS.highlightEnabled,
      nodesEnabled: parsed.nodesEnabled ?? DEFAULTS.nodesEnabled,
      disabledTypes: Array.isArray(parsed.disabledTypes) ? parsed.disabledTypes : [],
    };
  } catch {
    return { ...DEFAULTS, disabledTypes: [] };
  }
}

export function saveSearchSettings(settings: SearchSettings): void {
  if (isSettingsLocked()) return; // Lock guard
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* quota exceeded — silently ignore */ }
}
