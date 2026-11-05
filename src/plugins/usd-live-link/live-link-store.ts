// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { readLocalStorage, writeLocalStorage } from '../../core/rv-safe-storage';

/**
 * live-link-store — state of the USD live link for the HMI (plan-637 §2.7).
 *
 * One store per plugin instance, read by the tool button and the status pill
 * through `useSyncExternalStore`. Port, token and rate are per device in
 * localStorage (`USD_LIVE_LINK_SETTINGS_KEY`); whether sync is ON is NOT
 * persisted — a reload never connects by itself (F7).
 */

import { USD_LIVE_LINK_SEEN_LIVE_KEY, USD_LIVE_LINK_SETTINGS_KEY } from '../../core/hmi/rv-storage-keys';

import type { LiveLinkSettings, LiveLinkState } from './live-link-types';
export type { LiveLinkMountTimings, LiveLinkSettings, LiveLinkState, LiveLinkStatus } from './live-link-types';

export const LIVE_LINK_MIN_HZ = 10;
export const LIVE_LINK_MAX_HZ = 60;
export const LIVE_LINK_DEFAULT_HZ = 30;

/**
 * Default TCP port of the Kit extension (`extension.toml`). Lives here, not in
 * `livesync-protocol.ts`: the store is in the entry chunk, the protocol only in
 * the lazily loaded session chunk.
 */
export const LIVESYNC_DEFAULT_PORT = 8775;

/**
 * The default before 2026-10-21. It collided with other local services
 * (DeskAgent listens on 127.0.0.1:8765), so it moved to {@link LIVESYNC_DEFAULT_PORT}.
 */
export const LIVESYNC_LEGACY_DEFAULT_PORT = 8765;

/** Shown instead of connecting when no access token is stored. */
export const LIVE_LINK_TOKEN_MISSING = 'Enter the access token shown in the realvirtual Live Sync panel of Isaac Sim.';

/** Status line while retrying a link that cannot reach the extension at all. */
export const LIVE_LINK_NOT_REACHABLE_RETRYING = 'Isaac Sim not reachable — retrying… Start it with run_isaac_sim_nvidia_only.bat';

/** True once this device reached `live` (the install steps then start collapsed). */
export function hasSeenLive(): boolean {
  try {
    return readLocalStorage(USD_LIVE_LINK_SEEN_LIVE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Remember that this device reached `live`. */
export function markSeenLive(): void {
  try {
    writeLocalStorage(USD_LIVE_LINK_SEEN_LIVE_KEY, '1');
  } catch {
    // Private mode: the install steps stay open by default.
  }
}

const DEFAULT_SETTINGS: LiveLinkSettings = { port: LIVESYNC_DEFAULT_PORT, token: '', rateHz: LIVE_LINK_DEFAULT_HZ };

/** Clamp a rate into the supported range. */
export function clampRateHz(hz: number): number {
  if (!Number.isFinite(hz)) return LIVE_LINK_DEFAULT_HZ;
  return Math.min(LIVE_LINK_MAX_HZ, Math.max(LIVE_LINK_MIN_HZ, Math.round(hz)));
}

/**
 * The port to use for a stored record.
 *
 * Every settings write stores the whole record, so a token commit also stored
 * the default port of that time — a record without `portChosen` cannot tell
 * "the user picked 8765" from "8765 was the default". Rule: without the flag,
 * the old default {@link LIVESYNC_LEGACY_DEFAULT_PORT} counts as not chosen and
 * moves to the new default (the Kit extension moved with it); any other value
 * could only have been typed by the user and stays. With the flag the stored
 * port always stays.
 */
export function migrateStoredPort(port: unknown, portChosen: unknown): number {
  if (typeof port !== 'number' || !Number.isFinite(port) || port <= 0 || port >= 65536) return LIVESYNC_DEFAULT_PORT;
  const p = Math.round(port);
  if (portChosen === true) return p;
  return p === LIVESYNC_LEGACY_DEFAULT_PORT ? LIVESYNC_DEFAULT_PORT : p;
}

/** Read the stored settings (defaults for anything missing or unreadable). */
export function loadLiveLinkSettings(): LiveLinkSettings {
  try {
    const raw = readLocalStorage(USD_LIVE_LINK_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const o = JSON.parse(raw) as Partial<LiveLinkSettings> | null;
    if (!o || typeof o !== 'object') return { ...DEFAULT_SETTINGS };
    const s: LiveLinkSettings = {
      port: migrateStoredPort(o.port, o.portChosen),
      token: typeof o.token === 'string' ? o.token : '',
      rateHz: clampRateHz(typeof o.rateHz === 'number' ? o.rateHz : LIVE_LINK_DEFAULT_HZ),
    };
    if (o.portChosen === true) s.portChosen = true;
    if (typeof o.remountDebounceMs === 'number') s.remountDebounceMs = o.remountDebounceMs;
    return s;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Persist the settings when storage is available. */
export function saveLiveLinkSettings(s: LiveLinkSettings): void {
  try {
    writeLocalStorage(USD_LIVE_LINK_SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // Private mode: the settings live for this session only.
  }
}

/** Observable state + settings. */
export class LiveLinkStore {
  private _state: LiveLinkState;
  private _settings: LiveLinkSettings;
  private readonly listeners = new Set<() => void>();

  constructor(settings: LiveLinkSettings = loadLiveLinkSettings()) {
    this._settings = settings;
    this._state = { status: 'off', session: 0, port: settings.port, rateHz: settings.rateHz, sentHz: 0 };
  }

  readonly subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  };

  readonly getSnapshot = (): LiveLinkState => this._state;

  get state(): LiveLinkState { return this._state; }
  get settings(): LiveLinkSettings { return this._settings; }

  /** Merge into the state; notifies only on a real change. */
  set(patch: Partial<LiveLinkState>): void {
    let changed = false;
    for (const k of Object.keys(patch) as Array<keyof LiveLinkState>) {
      if (this._state[k] !== patch[k]) { changed = true; break; }
    }
    if (!changed) return;
    this._state = { ...this._state, ...patch };
    if (patch.status === 'live') markSeenLive();
    this.emit();
  }

  /** Change and persist settings. A `port` in the patch marks the port as chosen by the user. */
  updateSettings(patch: Partial<LiveLinkSettings>): void {
    const next: LiveLinkSettings = { ...this._settings, ...patch };
    if (patch.port !== undefined) next.portChosen = true;
    next.rateHz = clampRateHz(next.rateHz);
    this._settings = next;
    saveLiveLinkSettings(next);
    this._state = { ...this._state, port: next.port, rateHz: next.rateHz };
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) {
      try { l(); } catch (e) { console.error('[usd-live-link] listener error:', e); }
    }
  }
}
