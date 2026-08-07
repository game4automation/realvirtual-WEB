// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * des-run-settings-store.ts — user preferences for DES simulation runs
 * (plan-260): seed mode, checkpoint autosave frequency, retention.
 *
 * Persisted in localStorage (user-local, NOT scene state — plan-260 §5.4:
 * the seed itself is a scene field via `des-manager-node.ts`; only the
 * per-user run preferences live here). `createStore`-based (project standard
 * Pub/Sub, `useSyncExternalStore`-compatible) — no zustand.
 */

import { createStore, type Store } from './create-store';

/** Seed assignment mode: `fixed` reproduces the same run on every reset;
 *  `auto` rolls a fresh seed before each new run (replication series, F12). */
export type SeedMode = 'fixed' | 'auto';

export interface DesRunSettings {
  /** Seed mode for new runs (F12). */
  readonly seedMode: SeedMode;
  /** Checkpoint autosave interval in SIM seconds; `0` = off (F15). */
  readonly autoSaveInterval: number;
  /** Checkpoint ring buffer per run — keep the newest N autosaves (F17). */
  readonly checkpointMax: number;
  /** Max archived runs kept per experiment (retention policy). */
  readonly retentionMax: number;
  /** Active project id (comparison scope, F5/F11); null = not chosen yet. */
  readonly activeProjectId: string | null;
}

const STORAGE_KEY = 'rv.des-run-settings';

const DEFAULTS: DesRunSettings = {
  seedMode: 'fixed',
  autoSaveInterval: 0,   // conservative default: autosave off (plan-260 §5.2)
  checkpointMax: 10,
  retentionMax: 50,
  activeProjectId: null,
};

function load(): DesRunSettings {
  try {
    if (typeof localStorage === 'undefined') return DEFAULTS;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<DesRunSettings> | null;
    if (!parsed || typeof parsed !== 'object') return DEFAULTS;
    return {
      seedMode: parsed.seedMode === 'auto' ? 'auto' : 'fixed',
      autoSaveInterval: numberOr(parsed.autoSaveInterval, DEFAULTS.autoSaveInterval),
      checkpointMax: Math.max(1, numberOr(parsed.checkpointMax, DEFAULTS.checkpointMax)),
      retentionMax: Math.max(1, numberOr(parsed.retentionMax, DEFAULTS.retentionMax)),
      activeProjectId: typeof parsed.activeProjectId === 'string' ? parsed.activeProjectId : null,
    };
  } catch {
    return DEFAULTS;
  }
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** The shared settings store (loaded once from localStorage). */
export const desRunSettingsStore: Store<DesRunSettings> = createStore<DesRunSettings>(load());

/** Current settings snapshot. */
export function getDesRunSettings(): DesRunSettings {
  return desRunSettingsStore.getSnapshot();
}

/** Patch + persist the run settings. */
export function updateDesRunSettings(patch: Partial<DesRunSettings>): void {
  desRunSettingsStore.set((prev) => ({ ...prev, ...patch }));
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(desRunSettingsStore.getSnapshot()));
    }
  } catch { /* quota / privacy mode — settings stay session-local */ }
}

/** Roll a fresh random seed (auto mode). Positive 31-bit int (GLB-field safe). */
export function rollSeed(): number {
  return (Math.floor(Math.random() * 0x7ffffffe) + 1) | 0;
}

/** TEST ONLY: reset to defaults (does not touch localStorage). */
export function __resetDesRunSettingsForTest(): void {
  desRunSettingsStore.set(() => DEFAULTS);
}
