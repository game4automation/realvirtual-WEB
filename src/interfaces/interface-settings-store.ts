// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Interface settings store.
 * Settings are persisted to localStorage so they survive page reloads.
 */

import { getAppConfig, isSettingsLocked } from '../core/rv-app-config';

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
};

/** Load settings from localStorage (merged with defaults for forward-compat). */
export function loadInterfaceSettings(): InterfaceSettings {
  // Layer 1+2: DEFAULTS + localStorage
  const fromStorage = loadFromLocalStorage();

  // Layer 3: Config override (from singleton)
  const override = getAppConfig().interface;
  if (!override) return fromStorage;
  return {
    activeType: override.activeType ?? fromStorage.activeType,
    autoConnect: override.autoConnect ?? fromStorage.autoConnect,
    reconnectIntervalMs: override.reconnectIntervalMs ?? fromStorage.reconnectIntervalMs,
    wsAddress: override.wsAddress ?? fromStorage.wsAddress,
    wsPort: override.wsPort ?? fromStorage.wsPort,
    wsUseSSL: override.wsUseSSL ?? fromStorage.wsUseSSL,
    wsPath: override.wsPath ?? fromStorage.wsPath,
    wsAuthToken: override.wsAuthToken ?? fromStorage.wsAuthToken,
    mqttBrokerUrl: override.mqttBrokerUrl ?? fromStorage.mqttBrokerUrl,
    mqttUsername: override.mqttUsername ?? fromStorage.mqttUsername,
    mqttPassword: override.mqttPassword ?? fromStorage.mqttPassword,
    mqttTopicPrefix: override.mqttTopicPrefix ?? fromStorage.mqttTopicPrefix,
  };
}

function loadFromLocalStorage(): InterfaceSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...INTERFACE_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<InterfaceSettings>;
    return {
      activeType: parsed.activeType ?? INTERFACE_DEFAULTS.activeType,
      autoConnect: parsed.autoConnect ?? INTERFACE_DEFAULTS.autoConnect,
      reconnectIntervalMs: parsed.reconnectIntervalMs ?? INTERFACE_DEFAULTS.reconnectIntervalMs,
      wsAddress: parsed.wsAddress ?? INTERFACE_DEFAULTS.wsAddress,
      wsPort: parsed.wsPort ?? INTERFACE_DEFAULTS.wsPort,
      wsUseSSL: parsed.wsUseSSL ?? INTERFACE_DEFAULTS.wsUseSSL,
      wsPath: parsed.wsPath ?? INTERFACE_DEFAULTS.wsPath,
      wsAuthToken: parsed.wsAuthToken ?? INTERFACE_DEFAULTS.wsAuthToken,
      mqttBrokerUrl: parsed.mqttBrokerUrl ?? INTERFACE_DEFAULTS.mqttBrokerUrl,
      mqttUsername: parsed.mqttUsername ?? INTERFACE_DEFAULTS.mqttUsername,
      mqttPassword: parsed.mqttPassword ?? INTERFACE_DEFAULTS.mqttPassword,
      mqttTopicPrefix: parsed.mqttTopicPrefix ?? INTERFACE_DEFAULTS.mqttTopicPrefix,
    };
  } catch {
    return { ...INTERFACE_DEFAULTS };
  }
}

/** Save settings to localStorage. */
export function saveInterfaceSettings(settings: InterfaceSettings): void {
  if (isSettingsLocked()) return; // Lock guard
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* quota exceeded — silently ignore */ }
}
