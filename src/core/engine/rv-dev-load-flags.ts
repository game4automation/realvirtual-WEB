// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-dev-load-flags.ts — developer kill-switches for model-load features
 * (Settings → Dev Tools). Read at load time only; changing a flag requires a
 * reload. Pattern mirrors rv-static-merge-flag.ts.
 */

/** localStorage key: '1' strips Runtime* interaction extras at load. */
export const DISABLE_METADATA_LS_KEY = 'rv-webviewer-disable-metadata';

/**
 * True unless the user disabled runtime-interaction loading (default true).
 * When false, the loader DELETES the `RuntimeMetadata`, `RuntimeInteractable`
 * and `RuntimeUIWindow` rv_extras from every node before any consumer reads
 * them — no component instances, no AABBs, no hover/select promotion, no
 * tooltip/inspector/hierarchy entries — exactly as if the GLB carried none.
 * Perf-diagnosis switch for metadata-heavy models.
 */
let _metadataEnabled: boolean | null = null;

export function isMetadataLoadingEnabled(): boolean {
  // Cached after the first read (called per candidate node in the loader's
  // traverse; the flag needs a reload to change anyway).
  if (_metadataEnabled === null) {
    try {
      _metadataEnabled = typeof localStorage === 'undefined' || localStorage.getItem(DISABLE_METADATA_LS_KEY) !== '1';
    } catch {
      _metadataEnabled = true;
    }
  }
  return _metadataEnabled;
}
