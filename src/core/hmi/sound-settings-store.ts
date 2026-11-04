// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { getLocalStorage, writeLocalStorage } from '../rv-safe-storage';

/**
 * sound-settings-store.ts — the viewer preference "drive sounds" (plan-2019 §2.7).
 *
 * Two values, persisted per browser: on/off (default OFF) and the master
 * volume (0..1, default 0.8). Written only by the commands `view.sound` and
 * `view.soundVolume`; the Sound segment in the view cluster and the
 * SoundSystem plugin read it. `createStore`-based (useSyncExternalStore).
 */

import { createStore, type Store } from './create-store';

export const SOUND_ENABLED_KEY = 'rv-sound-enabled';
export const SOUND_VOLUME_KEY = 'rv-sound-volume';
export const DEFAULT_SOUND_VOLUME = 0.8;

export interface SoundSettings {
  /** Drive sounds on. */
  readonly enabled: boolean;
  /** Master volume 0..1. */
  readonly volume: number;
}

const DEFAULTS: SoundSettings = { enabled: false, volume: DEFAULT_SOUND_VOLUME };

/** Clamp a volume to 0..1 (non-finite → default). */
export function clampSoundVolume(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : DEFAULT_SOUND_VOLUME;
}

function load(): SoundSettings {
  try {
    if (getLocalStorage() === null) return DEFAULTS;
    const on = getLocalStorage()!.getItem(SOUND_ENABLED_KEY);
    const vol = getLocalStorage()!.getItem(SOUND_VOLUME_KEY);
    return {
      enabled: on === 'true',
      volume: vol === null ? DEFAULT_SOUND_VOLUME : clampSoundVolume(Number(vol)),
    };
  } catch {
    return DEFAULTS;
  }
}

/** The shared store (loaded once from localStorage). */
export const soundSettingsStore: Store<SoundSettings> = createStore<SoundSettings>(load());

/** Current settings snapshot. */
export function getSoundSettings(): SoundSettings {
  return soundSettingsStore.getSnapshot();
}

function persist(): void {
  try {
    if (getLocalStorage() === null) return;
    const s = soundSettingsStore.getSnapshot();
    writeLocalStorage(SOUND_ENABLED_KEY, s.enabled ? 'true' : 'false');
    writeLocalStorage(SOUND_VOLUME_KEY, String(s.volume));
  } catch { /* quota / privacy mode — the setting stays session-local */ }
}

/** Switch drive sounds on or off (persisted). */
export function setSoundEnabled(on: boolean): void {
  if (soundSettingsStore.getSnapshot().enabled === on) return;
  soundSettingsStore.set({ enabled: on });
  persist();
}

/** Set the master volume 0..1 (persisted). */
export function setSoundVolume(v: number): void {
  const volume = clampSoundVolume(v);
  if (soundSettingsStore.getSnapshot().volume === volume) return;
  soundSettingsStore.set({ volume });
  persist();
}

/** TEST ONLY: reload from localStorage (or defaults). */
export function __reloadSoundSettingsForTest(): void {
  soundSettingsStore.set(() => load());
}
