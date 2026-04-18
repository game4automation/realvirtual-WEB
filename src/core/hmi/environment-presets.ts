// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Environment presets — named combinations of background brightness, floor
 * brightness, and floor checker contrast. Surfaced in the Environment settings
 * tab and applied at model-load time when a project's plugin module exports
 * `defaultEnvironmentPreset`.
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
}

export const ENVIRONMENT_PRESETS = {
  Bright:   { background: 1.0, floor: 1.0, contrast: 0.5 },
  Dark:     { background: 0.1, floor: 0.1, contrast: 0.5 },
  White:    { background: 1.5, floor: 1.5, contrast: 0.0 },
  Concrete: { background: 1.0, floor: 0.6, contrast: 0.0 },
} as const satisfies Record<string, EnvironmentPreset>;

export type EnvironmentPresetName = keyof typeof ENVIRONMENT_PRESETS;

/** Tolerance for matching slider values back to a named preset. */
const PRESET_EPSILON = 0.001;

/**
 * Find which preset (if any) matches the given live values. Returns 'Custom'
 * when no preset matches within {@link PRESET_EPSILON}.
 */
export function matchEnvironmentPreset(bg: number, floor: number, contrast: number): EnvironmentPresetName | 'Custom' {
  for (const [name, p] of Object.entries(ENVIRONMENT_PRESETS) as [EnvironmentPresetName, EnvironmentPreset][]) {
    if (Math.abs(p.background - bg) < PRESET_EPSILON
      && Math.abs(p.floor - floor) < PRESET_EPSILON
      && Math.abs(p.contrast - contrast) < PRESET_EPSILON) {
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
  try {
    return localStorage.getItem(ENV_USER_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Mark that the user has manually customized environment settings. */
export function markEnvironmentUserModified(): void {
  try { localStorage.setItem(ENV_USER_KEY, 'true'); } catch { /* ignore */ }
}

/** Clear the manual-modification flag (called when a model preset is applied). */
export function clearEnvironmentUserModified(): void {
  try { localStorage.removeItem(ENV_USER_KEY); } catch { /* ignore */ }
}

/**
 * Apply a preset to the viewer and persist the resulting values so the
 * Environment settings tab reflects the new state on next open.
 */
export function applyEnvironmentPreset(viewer: RVViewer, name: EnvironmentPresetName): void {
  const preset = ENVIRONMENT_PRESETS[name];
  if (!preset) return;
  viewer.backgroundBrightness = preset.background;
  viewer.groundBrightness = preset.floor;
  viewer.checkerContrast = preset.contrast;
  const settings = loadVisualSettings();
  settings.backgroundBrightness = preset.background;
  settings.groundBrightness = preset.floor;
  settings.checkerContrast = preset.contrast;
  saveVisualSettings(settings);
  // Clear user-modified flag since this was a programmatic/UI-preset application
  clearEnvironmentUserModified();
}
