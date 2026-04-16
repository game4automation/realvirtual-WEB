// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Central list of all localStorage keys used by the WebViewer. */

export const ALL_RV_STORAGE_KEYS = [
  'rv-visual-settings',
  'rv-physics-settings',
  'rv-search-settings',
  'rv-interface-settings',
  'rv-webviewer-last-model',
  'rv-webviewer-renderer',
  'rv-debug',
  'rv-extras-overlay',
  // Hierarchy & Inspector keys
  'rv-extras-editor-width',
  'rv-extras-editor-open',
  'rv-extras-editor-selected',
  'rv-hierarchy-expanded',
  'rv-hierarchy-type-filter',
  'rv-hierarchy-signal-sort',
  'rv-inspector-collapsed',
  'rv-inspector-consumed-only',
  'rv-group-visibility',
  'rv-maintenance-progress',
  'rv-ai-bridge',
  'rv-multiuser-settings',
  'rv-left-panel-active',
  'rv-layout-library-urls',
  'rv-layout-autosave',
  'rv-layout-grid-enabled',
  'rv-layout-grid-size',
] as const;

/**
 * Prefixes for dynamic localStorage keys (keyed by GLB name).
 * Used by `clearAllRVStorage()` to scan and remove these entries.
 */
export const RV_DYNAMIC_PREFIXES = [
  'rv-extras-overlay:',
  'rv-extras-originals:',
  'rv-annotations-',
  'rv-panel-',
  'rv-order-',
  'rv-camera-start:',
] as const;

/**
 * Clear all known realvirtual localStorage keys, including dynamic ones.
 * This handles both the static keys in ALL_RV_STORAGE_KEYS and
 * dynamic keys that match RV_DYNAMIC_PREFIXES.
 */
export function clearAllRVStorage(): void {
  // Clear static keys
  for (const key of ALL_RV_STORAGE_KEYS) {
    localStorage.removeItem(key);
  }
  // Clear dynamic prefix-based keys
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && RV_DYNAMIC_PREFIXES.some(prefix => key.startsWith(prefix))) {
      keysToRemove.push(key);
    }
  }
  for (const key of keysToRemove) {
    localStorage.removeItem(key);
  }
}
