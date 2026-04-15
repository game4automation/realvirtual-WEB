// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Multiuser settings persisted in localStorage.
 *
 * Controls whether the multiuser feature is enabled (TopBar button visible),
 * the default server URL, display name, role, and optional join code.
 */

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
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveMultiuserSettings(settings: MultiuserSettings): void {
  localStorage.setItem(LS_KEY, JSON.stringify(settings));
}
