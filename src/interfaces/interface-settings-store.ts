// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Interface settings store.
 * Settings are persisted to localStorage so they survive page reloads.
 */

import { getAppConfig } from '../core/rv-app-config';
import { lsLoad, lsSave } from '../core/hmi/ls-store-utils';

const STORAGE_KEY = 'rv-interface-settings';

/** Available interface protocol types. */
export type InterfaceType =
  | 'none'
  | 'websocket-realtime'
  | 'ctrlx'
  | 'twincat-hmi'
  | 'mqtt'
  | 'keba';

/** Persisted interface settings. */
export interface InterfaceSettings {
  /** Which interface is active (only one at a time). */
  activeType: InterfaceType;
  /** Auto-connect when model is loaded. */
  autoConnect: boolean;
  /** Delay between reconnect attempts in ms. */
  reconnectIntervalMs: number;

  // ── WebSocket-based (WS Realtime / ctrlX / TwinCAT HMI / KEBA) ──
  wsAddress: string;
  wsPort: number;
  wsUseSSL: boolean;
  wsPath: string;
  wsAuthToken: string;

  // ── MQTT ──
  mqttBrokerUrl: string;
  mqttUsername: string;
  mqttPassword: string;
  mqttTopicPrefix: string;

  // ── Signal table import (last-used, for pre-selection on next import) ──
  /** Display name of the last imported signal table file. */
  lastSignalTableName?: string;
  /** Last tab filter pattern used for multi-tab (xlsx) imports. */
  lastSheetPattern?: string;
  /** Last MQTT topic prefix used for multi-tab (xlsx) imports. */
  lastTopicPrefix?: string;
}

export const INTERFACE_DEFAULTS: InterfaceSettings = {
  activeType: 'none',
  autoConnect: false,
  reconnectIntervalMs: 3000,

  wsAddress: 'localhost',
  wsPort: 7000,
  wsUseSSL: false,
  wsPath: '/',
  wsAuthToken: '',

  mqttBrokerUrl: 'ws://localhost:8080/mqtt',
  mqttUsername: '',
  mqttPassword: '',
  mqttTopicPrefix: 'rv/',

  lastSignalTableName: '',
  lastSheetPattern: '',
  lastTopicPrefix: '',
};

/** Load settings from localStorage (merged with defaults for forward-compat). */
export function loadInterfaceSettings(): InterfaceSettings {
  return lsLoad<InterfaceSettings>(STORAGE_KEY, INTERFACE_DEFAULTS, {
    configOverride: getAppConfig().interface,
  });
}

/** Save settings to localStorage. */
export function saveInterfaceSettings(settings: InterfaceSettings): void {
  lsSave(STORAGE_KEY, settings);
}
