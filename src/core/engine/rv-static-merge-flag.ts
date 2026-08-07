// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Kill-switch for the STATIC mesh-batching passes (Phase 10c uber batch +
 * Phase 10d-tex textured batches — BatchedMesh arenas with per-instance
 * visibility, see rv-batched-render.ts).
 *
 * Default ON. Disabling ('0') renders every static mesh individually on the
 * next reload — the fallback for render problems. Group/auto-filter hide and
 * isolate work in both modes (per-instance `setVisibleAt` when batched,
 * plain `.visible` cascade when not).
 *
 * The kinematic (per-Drive) merge is NOT gated — its chunks live under the
 * Drive nodes and follow group visibility naturally.
 *
 * Read at model-load time only; changing the flag requires a reload.
 */

/** localStorage key for the kill-switch in the Visual settings tab. */
export const STATIC_MERGE_LS_KEY = 'rv-webviewer-static-merge';

/** True unless the user disabled static batching (default true). */
export function isStaticMeshMergingEnabled(): boolean {
  try {
    return typeof localStorage === 'undefined' || localStorage.getItem(STATIC_MERGE_LS_KEY) !== '0';
  } catch {
    return true;
  }
}
