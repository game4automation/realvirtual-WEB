// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { writeLocalStorage } from '../rv-safe-storage';

/**
 * Multiuser settings persisted in localStorage.
 *
 * Controls whether the multiuser feature is enabled (TopBar button visible),
 * the default server URL, display name, role, and optional join code.
 */

import { useSyncExternalStore } from 'react';
import { lsLoad } from './ls-store-utils';

const LS_KEY = 'rv-multiuser-settings';

export interface MultiuserSettings {
  /** Master toggle — when false the TopBar button and panel are hidden. */
  enabled: boolean;
  /** Connection mode: 'local' for direct WS to Unity, 'relay' for relay server. */
  connectionMode: 'local' | 'relay';
  /** Default server URL (ws://...) for local mode. */
  serverUrl: string;
  /** Relay server URL for relay mode. */
  relayUrl: string;
  /** Display name shown to other users. */
  displayName: string;
  /** Role: observer (watch only) or operator (full control). */
  role: 'observer' | 'operator';
  /** Optional room/session join code for relay servers hosting multiple sessions. */
  joinCode: string;
}

const DEFAULTS: MultiuserSettings = {
  enabled: true,
  connectionMode: 'local',
  serverUrl: '',
  relayUrl: 'wss://download.realvirtual.io/relay',
  displayName: 'Browser',
  role: 'observer',
  joinCode: '',
};

export function loadMultiuserSettings(): MultiuserSettings {
  return lsLoad<MultiuserSettings>(LS_KEY, DEFAULTS);
}

// ── Reactivity ──────────────────────────────────────────────────────────
// A tiny pub/sub so UI that depends on these settings (notably the activity-bar
// Multiuser button's visibility, driven by `enabled`) updates live when the
// Settings → Multiuser tab toggles them — no prop drilling needed.

const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function saveMultiuserSettings(settings: MultiuserSettings): void {
  // Intentionally no isSettingsLocked() guard — the prior implementation did
  // not enforce one, and multiuser settings are user-identity (display name,
  // role) rather than visual/runtime settings. Keep behavior unchanged.
  try {
    writeLocalStorage(LS_KEY, JSON.stringify(settings));
  } catch {
    /* quota exceeded — silently ignore */
  }
  for (const l of listeners) l();
}

/** Reactive read of the multiuser "enabled" master toggle. Re-renders the
 *  caller whenever `saveMultiuserSettings` runs (e.g. the Settings toggle). */
export function useMultiuserEnabled(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => loadMultiuserSettings().enabled,
  );
}
