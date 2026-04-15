// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Physics settings store.
 * Settings are persisted to localStorage so they survive page reloads.
 */

import { getAppConfig, isSettingsLocked } from '../rv-app-config';

const STORAGE_KEY = 'rv-physics-settings';

export interface PhysicsSettings {
  enabled: boolean;
  gravity: number;
  friction: number;
  substeps: number;
  debugWireframes: boolean;
}

const DEFAULTS: PhysicsSettings = {
  enabled: false,
  gravity: 9.81,
  friction: 1.5,
  substeps: 1,
  debugWireframes: false,
};

export function loadPhysicsSettings(): PhysicsSettings {
  // Layer 1+2: DEFAULTS + localStorage
  const fromStorage = loadFromLocalStorage();

  // Layer 3: Config override (from singleton)
  const override = getAppConfig().physics;
  if (!override) return fromStorage;
  return {
    enabled: override.enabled ?? fromStorage.enabled,
    gravity: override.gravity ?? fromStorage.gravity,
    friction: override.friction ?? fromStorage.friction,
    substeps: override.substeps ?? fromStorage.substeps,
    debugWireframes: override.debugWireframes ?? fromStorage.debugWireframes,
  };
}

function loadFromLocalStorage(): PhysicsSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<PhysicsSettings>;
    return {
      enabled: parsed.enabled ?? DEFAULTS.enabled,
      gravity: parsed.gravity ?? DEFAULTS.gravity,
      friction: parsed.friction ?? DEFAULTS.friction,
      substeps: parsed.substeps ?? DEFAULTS.substeps,
      debugWireframes: parsed.debugWireframes ?? DEFAULTS.debugWireframes,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePhysicsSettings(settings: PhysicsSettings): void {
  if (isSettingsLocked()) return; // Lock guard
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* quota exceeded — silently ignore */ }
}
