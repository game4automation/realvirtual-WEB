// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { readLocalStorage, removeLocalStorage, writeLocalStorage } from '../rv-safe-storage';

/**
 * Environment presets — named combinations of background brightness, floor
 * brightness, floor color, and floor checker contrast. Surfaced in the
 * Environment settings tab and applied at model-load time when a project's
 * plugin module exports `defaultEnvironmentPreset`.
 */

import type { RVViewer } from '../rv-viewer';
import { loadVisualSettings, saveVisualSettings } from './visual-settings-store';

export interface EnvironmentPreset {
  /** Scene background brightness multiplier (0..2). */
  background: number;
  /** Floor brightness multiplier (0..2). */
  floor: number;
  /** Floor checker contrast multiplier (0..2). */
  contrast: number;
  /** Floor base color as #rrggbb. Defaults to '#ffffff' (white) when omitted
   *  so existing presets keep the gray-checker look. */
  floorColor?: string;
}

export const ENVIRONMENT_PRESETS = {
  Bright:   { background: 1.0, floor: 1.0, contrast: 0.5, floorColor: '#ffffff' },
  Dark:     { background: 0.1, floor: 0.1, contrast: 0.5, floorColor: '#ffffff' },
  White:    { background: 1.5, floor: 1.5, contrast: 0.0, floorColor: '#ffffff' },
  Concrete: { background: 1.0, floor: 0.6, contrast: 0.0, floorColor: '#ffffff' },
  // Outdoor: bright sky, muted olive-green floor, faint checker.
  Outdoor:  { background: 1.0, floor: 1.0, contrast: 0.1, floorColor: '#7E8E6B' },
} as const satisfies Record<string, EnvironmentPreset>;

export type EnvironmentPresetName = keyof typeof ENVIRONMENT_PRESETS;

/** Tolerance for matching slider values back to a named preset. */
const PRESET_EPSILON = 0.001;

/** Default floor color used when a preset omits `floorColor`. */
const DEFAULT_FLOOR_COLOR = '#ffffff';

/**
 * Find which preset (if any) matches the given live values. Returns 'Custom'
 * when no preset matches within {@link PRESET_EPSILON}.
 */
export function matchEnvironmentPreset(
  bg: number,
  floor: number,
  contrast: number,
  floorColor: string = DEFAULT_FLOOR_COLOR,
): EnvironmentPresetName | 'Custom' {
  const colorLower = floorColor.toLowerCase();
  for (const [name, p] of Object.entries(ENVIRONMENT_PRESETS) as [EnvironmentPresetName, EnvironmentPreset][]) {
    const presetColor = (p.floorColor ?? DEFAULT_FLOOR_COLOR).toLowerCase();
    if (Math.abs(p.background - bg) < PRESET_EPSILON
      && Math.abs(p.floor - floor) < PRESET_EPSILON
      && Math.abs(p.contrast - contrast) < PRESET_EPSILON
      && presetColor === colorLower) {
      return name;
    }
  }
  return 'Custom';
}

const ENV_USER_KEY = 'rv-env-user-modified';

/**
 * Returns true if the user has **manually** changed environment settings via
 * the EnvironmentTab UI (as opposed to values written by a model preset).
 */
export function hasUserEnvironmentOverride(): boolean {
  return readLocalStorage(ENV_USER_KEY) === 'true';
}

/** Mark that the user has manually customized environment settings. */
export function markEnvironmentUserModified(): void {
  writeLocalStorage(ENV_USER_KEY, 'true');
}

/** Clear the manual-modification flag (called when a model preset is applied). */
export function clearEnvironmentUserModified(): void {
  removeLocalStorage(ENV_USER_KEY);
}

/**
 * Apply a preset to the viewer and persist the resulting values so the
 * Environment settings tab reflects the new state on next open.
 */
export function applyEnvironmentPreset(viewer: RVViewer, name: EnvironmentPresetName): void {
  const preset = ENVIRONMENT_PRESETS[name];
  if (!preset) return;
  const floorColor = preset.floorColor ?? DEFAULT_FLOOR_COLOR;
  viewer.backgroundBrightness = preset.background;
  // Set color BEFORE brightness so the combine recomputes once with both inputs.
  viewer.groundColor = floorColor;
  viewer.groundBrightness = preset.floor;
  viewer.checkerContrast = preset.contrast;
  const settings = loadVisualSettings();
  settings.backgroundBrightness = preset.background;
  settings.groundBrightness = preset.floor;
  settings.groundColor = floorColor;
  settings.checkerContrast = preset.contrast;
  saveVisualSettings(settings);
  // Clear user-modified flag since this was a programmatic/UI-preset application
  clearEnvironmentUserModified();
}
