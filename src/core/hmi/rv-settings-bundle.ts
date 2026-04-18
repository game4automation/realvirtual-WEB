// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-settings-bundle.ts — Centralized settings export/import/auto-load.
 *
 * Collects all WebViewer localStorage stores into a single versioned JSON
 * bundle for export, import, and per-model sidecar auto-loading.
 *
 * Pattern: follows rv-extras-overlay-store.ts for download/import.
 */

import { loadVisualSettings, saveVisualSettings } from './visual-settings-store';
import type { VisualSettings } from './visual-settings-store';
import { loadPhysicsSettings, savePhysicsSettings } from './physics-settings-store';
import type { PhysicsSettings } from './physics-settings-store';
import { loadInterfaceSettings, saveInterfaceSettings } from '../../interfaces/interface-settings-store';
import type { InterfaceSettings } from '../../interfaces/interface-settings-store';
import { loadSearchSettings, saveSearchSettings } from './search-settings-store';
import type { SearchSettings } from './search-settings-store';
import { loadMultiuserSettings, saveMultiuserSettings } from './multiuser-settings-store';
import type { MultiuserSettings } from './multiuser-settings-store';
import {
  loadGroupVisibilitySettings,
  saveGroupVisibilitySettings,
} from './group-visibility-store';
import type { GroupVisibilitySettings } from './group-visibility-store';
import type { ModelCameraStart } from './camera-startpos-types';
import { isValidPreset } from './camera-startpos-store';

const CAMERA_START_LS_PREFIX = 'rv-camera-start:';

// ─── Types ────────────────────────────────────────────────────────────

export interface RVSettingsBundle {
  $schema: 'rv-settings-bundle/1.0';
  exportedAt: string;
  modelUrl?: string;
  settings: {
    visual?: Partial<VisualSettings>;
    physics?: Partial<PhysicsSettings>;
    interface?: Partial<InterfaceSettings>;
    search?: Partial<SearchSettings>;
    multiuser?: Partial<MultiuserSettings>;
    groupVisibility?: Partial<GroupVisibilitySettings>;
    panelLayouts?: Record<string, { x: number; y: number; w: number; h: number }>;
    /** Per-model camera start positions, keyed by model basename (without .glb). */
    cameraStart?: Record<string, ModelCameraStart>;
  };
}

const MAX_FILE_SIZE = 1_048_576; // 1 MB

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Extract a human-readable model basename from a URL.
 * Returns 'rv-settings' for null/empty inputs.
 */
export function getModelBasename(url: string | null): string {
  if (!url) return 'rv-settings';
  // Strip query string
  const noQuery = url.split('?')[0];
  // Get last path segment
  const lastSlash = noQuery.lastIndexOf('/');
  const filename = lastSlash >= 0 ? noQuery.substring(lastSlash + 1) : noQuery;
  // Strip .glb extension (case-insensitive)
  return filename.replace(/\.glb$/i, '') || 'rv-settings';
}

// ─── Collect ──────────────────────────────────────────────────────────

/**
 * Collect all settings stores into a single bundle.
 */
export function collectSettingsBundle(modelUrl: string | null): RVSettingsBundle {
  // Collect panel layout positions from localStorage
  const panelLayouts: Record<string, { x: number; y: number; w: number; h: number }> = {};
  // Collect per-model camera start presets from localStorage (rv-camera-start:<modelKey>)
  const cameraStart: Record<string, ModelCameraStart> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (key.startsWith('rv-panel-')) {
      try {
        const val = JSON.parse(localStorage.getItem(key)!);
        if (val && typeof val === 'object' && typeof val.x === 'number') {
          panelLayouts[key.substring('rv-panel-'.length)] = val;
        }
      } catch { /* skip invalid */ }
    } else if (key.startsWith(CAMERA_START_LS_PREFIX)) {
      try {
        const val = JSON.parse(localStorage.getItem(key)!);
        if (isValidPreset(val)) {
          cameraStart[key.substring(CAMERA_START_LS_PREFIX.length)] = val;
        }
      } catch { /* skip invalid */ }
    }
  }

  const bundle: RVSettingsBundle = {
    $schema: 'rv-settings-bundle/1.0',
    exportedAt: new Date().toISOString(),
    modelUrl: modelUrl ?? undefined,
    settings: {
      visual: loadVisualSettings(),
      physics: loadPhysicsSettings(),
      interface: loadInterfaceSettings(),
      search: loadSearchSettings(),
      multiuser: loadMultiuserSettings(),
      groupVisibility: loadGroupVisibilitySettings(),
      panelLayouts: Object.keys(panelLayouts).length > 0 ? panelLayouts : undefined,
      cameraStart: Object.keys(cameraStart).length > 0 ? cameraStart : undefined,
    },
  };

  return bundle;
}

// ─── Download ─────────────────────────────────────────────────────────

/**
 * Trigger a browser download of the settings bundle.
 */
export function downloadSettingsBundle(bundle: RVSettingsBundle, filename: string): void {
  const json = JSON.stringify(bundle, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Import ───────────────────────────────────────────────────────────

/**
 * Read and validate a settings bundle from a File.
 * Validates schema FIRST, before returning the parsed bundle.
 * Rejects files > 1 MB.
 */
export async function importSettingsFile(file: File): Promise<RVSettingsBundle> {
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`File too large (${(file.size / 1024).toFixed(0)} KB). Maximum is 1 MB.`);
  }

  const text = await file.text();
  const parsed = JSON.parse(text);

  // Validate schema before returning
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid settings file: not a JSON object.');
  }
  if (parsed.$schema !== 'rv-settings-bundle/1.0') {
    throw new Error(`Invalid or unsupported schema: "${parsed.$schema ?? 'missing'}". Expected "rv-settings-bundle/1.0".`);
  }

  return parsed as RVSettingsBundle;
}

// ─── Apply ────────────────────────────────────────────────────────────

/**
 * Apply a validated settings bundle to all stores.
 * Only writes sections that are present in the bundle.
 */
export function applySettingsBundle(bundle: RVSettingsBundle): void {
  const s = bundle.settings;

  if (s.visual) {
    // Merge with current defaults, then save
    const current = loadVisualSettings();
    saveVisualSettings({ ...current, ...s.visual });
  }

  if (s.physics) {
    const current = loadPhysicsSettings();
    savePhysicsSettings({ ...current, ...s.physics });
  }

  if (s.interface) {
    const current = loadInterfaceSettings();
    saveInterfaceSettings({ ...current, ...s.interface });
  }

  if (s.search) {
    const current = loadSearchSettings();
    saveSearchSettings({ ...current, ...s.search });
  }

  if (s.multiuser) {
    const current = loadMultiuserSettings();
    saveMultiuserSettings({ ...current, ...s.multiuser });
  }

  if (s.groupVisibility) {
    const current = loadGroupVisibilitySettings();
    saveGroupVisibilitySettings({ ...current, ...s.groupVisibility });
  }

  if (s.panelLayouts) {
    for (const [key, val] of Object.entries(s.panelLayouts)) {
      try {
        localStorage.setItem(`rv-panel-${key}`, JSON.stringify(val));
      } catch { /* quota exceeded — skip */ }
    }
  }

  if (s.cameraStart) {
    for (const [modelKey, preset] of Object.entries(s.cameraStart)) {
      if (!isValidPreset(preset)) continue;
      try {
        localStorage.setItem(`${CAMERA_START_LS_PREFIX}${modelKey}`, JSON.stringify(preset));
      } catch { /* quota exceeded — skip */ }
    }
  }
}

// ─── Sidecar Auto-Load ───────────────────────────────────────────────

/**
 * Fetch and apply a `{model}.settings.json` sidecar file.
 * Silent on any error (404, network, parse). Only applies on first visit
 * (no 'rv-visual-settings' key in localStorage).
 */
export async function loadModelSettingsConfig(modelUrl: string): Promise<void> {
  try {
    // Guard: only auto-load if no visual settings exist (first visit)
    if (localStorage.getItem('rv-visual-settings')) return;

    const settingsUrl = modelUrl.replace(/\.glb$/i, '.settings.json');
    const resp = await fetch(settingsUrl);
    if (!resp.ok) return;

    const data = await resp.json();
    if (!data || typeof data !== 'object' || data.$schema !== 'rv-settings-bundle/1.0') return;

    applySettingsBundle(data as RVSettingsBundle);
  } catch {
    // Silent on any error — never abort model loading
  }
}
