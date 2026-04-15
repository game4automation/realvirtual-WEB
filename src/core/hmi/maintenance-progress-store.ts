// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * maintenance-progress-store.ts — Persist maintenance step progress in localStorage.
 *
 * Keyed by procedure name so that progress survives page reloads.
 * Same pattern as visual-settings-store.ts.
 */

import type { StepResult } from '../types/plugin-types';

const STORAGE_KEY = 'rv-maintenance-progress';

/** Stored progress for a single procedure. */
export interface MaintenanceProgress {
  /** Procedure name (acts as key). */
  procedureName: string;
  /** Step results array (null = not yet completed). */
  stepResults: StepResult[];
  /** Current step index. */
  currentStep: number;
  /** ISO timestamp of last update. */
  lastUpdated: string;
}

/** All persisted progress, keyed by procedure name. */
type ProgressMap = Record<string, MaintenanceProgress>;

/** Load all persisted progress from localStorage. */
function loadAll(): ProgressMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as ProgressMap;
  } catch {
    return {};
  }
}

/** Save all progress to localStorage. */
function saveAll(map: ProgressMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Silently ignore storage errors (quota, private mode, etc.)
  }
}

/** Load persisted progress for a specific procedure. Returns null if none found. */
export function loadMaintenanceProgress(procedureName: string): MaintenanceProgress | null {
  const map = loadAll();
  return map[procedureName] ?? null;
}

/** Save progress for a specific procedure. */
export function saveMaintenanceProgress(
  procedureName: string,
  stepResults: StepResult[],
  currentStep: number,
): void {
  const map = loadAll();
  map[procedureName] = {
    procedureName,
    stepResults: [...stepResults],
    currentStep,
    lastUpdated: new Date().toISOString(),
  };
  saveAll(map);
}

/** Clear persisted progress for a specific procedure. */
export function clearMaintenanceProgress(procedureName: string): void {
  const map = loadAll();
  delete map[procedureName];
  saveAll(map);
}

/** Clear all maintenance progress. */
export function clearAllMaintenanceProgress(): void {
  localStorage.removeItem(STORAGE_KEY);
}
