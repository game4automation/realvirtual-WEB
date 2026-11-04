// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { readLocalStorage } from '../rv-safe-storage';

/**
 * rv-dev-load-flags.ts — developer kill-switches for model-load features
 * (Settings → Dev Tools, or the DevTools console). Read at load time only;
 * changing a flag requires a reload. localStorage-backed, no UI writes the
 * pick flag.
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
      _metadataEnabled = readLocalStorage(DISABLE_METADATA_LS_KEY) !== '1';
    } catch {
      _metadataEnabled = true;
    }
  }
  return _metadataEnabled;
}

/**
 * localStorage key: '0' picks baked chunks WITHOUT the plan-756 cluster tree —
 * the structure-free mode of `PickBackend` (plan-757 Phase 3 commit B): a
 * linear scan over the chunk's segment table (one box test per segment, the
 * same watertight triangle test inside), owner, occlusion and hidden-node rules
 * unchanged. Linear per chunk, so a rollback and a diagnosis switch, never
 * the normal mode. Read once per model load (when the backend is built);
 * set it in the DevTools console and reload.
 */
export const PICK_STRUCTURE_LS_KEY = 'rv-webviewer-pick-structure';

/** True unless the user switched the pick structure off (default true). */
export function isPickStructureEnabled(): boolean {
  try {
    return readLocalStorage(PICK_STRUCTURE_LS_KEY) !== '0';
  } catch {
    return true;
  }
}

/**
 * localStorage key: '0' keeps JSON inspector fields on the plain text field —
 * the Monaco JSON editor (plan-555, `WebOperatorPanel.Config`) is never
 * loaded. A rollback and diagnosis switch; read when the field mounts, set it
 * in the DevTools console and reload.
 */
export const JSON_EDITOR_LS_KEY = 'rv-webviewer-json-editor';

/** True unless the user switched the Monaco JSON field editor off (default true). */
export function isJsonEditorEnabled(): boolean {
  try {
    return readLocalStorage(JSON_EDITOR_LS_KEY) !== '0';
  } catch {
    return true;
  }
}
